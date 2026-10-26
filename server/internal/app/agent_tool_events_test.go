package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"ops/internal/ai"
)

func aw06ToolRun(t *testing.T) (context.Context, *agentRunState) {
	t.Helper()
	provider := env.ensureToolModel(t)
	c := env.agentRunConversation(t, provider)
	t.Cleanup(func() { deleteConversations(t, c.ID) })
	me := env.me(t)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	st := &agentRunState{RunID: agentInsertRun(t, c.ID, workspaceID, userID, uuid.MustParse(provider), "running", "message"),
		ConversationID: c.ID, UserID: userID, WorkspaceID: workspaceID, SessionID: agentTestSessionID(t, userID), AccountID: c.AccountID}
	return context.WithValue(t.Context(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID, SessionID: st.SessionID, Role: "owner"}), st
}

func TestAW06StopDrainsInFlightReadAndGenerateAndCancelsRest(t *testing.T) {
	for _, kind := range []string{"R", "G"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
			provider := env.ensureToolModel(t)
			c := env.agentRunConversation(t, provider)
			defer deleteConversations(t, c.ID)
			if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_conversation SET loaded_domains=ARRAY['works','writing','profile'] WHERE id=$1`, c.ID); err != nil {
				t.Fatal(err)
			}
			entered := make(chan context.Context, 1)
			release := make(chan struct{})
			var dispatched atomic.Int32
			original := env.srv.handler
			env.srv.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if p := agentPrincipalOf(r.Context()); p != nil && p.ConversationID == c.ID {
					dispatched.Add(1)
					entered <- r.Context()
					select {
					case <-release:
					case <-r.Context().Done():
					}
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"summary":"inflight-complete","titles":[{"text":"inflight-complete"}],"items":[]}`))
					return
				}
				original.ServeHTTP(w, r)
			})
			defer func() { env.srv.handler = original }()
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			instruction := fmt.Sprintf(`#tool works__list {"accountId":"%s"}`, c.AccountID)
			limit := agentReadTimeout
			if kind == "G" {
				instruction = fmt.Sprintf(`#tool works__titles {"id":"%s"}`, uuid.NewString())
				limit = agentGenerateTimeout
			}
			instruction += fmt.Sprintf("\n#tool memory__create {\"accountId\":\"%s\",\"text\":\"未派发的写卡片\"}", c.AccountID)
			status, body := env.do(http.MethodPost, agentRunPath(c, "messages"), map[string]any{"text": instruction, "request_id": uuid.NewString(), "protocol_version": 2})
			if status != http.StatusAccepted {
				t.Fatalf("受理失败：%d %s", status, body)
			}
			var toolContext context.Context
			select {
			case toolContext = <-entered:
			case <-time.After(3 * time.Second):
				t.Fatal("工具未进入分发器")
			}
			deadline, ok := toolContext.Deadline()
			if !ok || time.Until(deadline) > limit || time.Until(deadline) < limit-time.Second {
				t.Fatalf("%s工具没有自身超时：%v", kind, time.Until(deadline))
			}
			var accepted struct {
				RunID uuid.UUID `json:"run_id"`
			}
			if err := json.Unmarshal(body, &accepted); err != nil {
				t.Fatal(err)
			}
			cancelPath := "/api/v1/agent/runs/" + accepted.RunID.String() + "/cancel"
			for i := 0; i < 2; i++ {
				status, raw := env.do(http.MethodPost, cancelPath, map[string]any{})
				if status != http.StatusOK {
					t.Fatalf("停止/重复停止失败：%d %s", status, raw)
				}
			}
			if toolContext.Err() != nil {
				t.Fatalf("停止提前取消在途%s工具：%v", kind, toolContext.Err())
			}
			var pending struct {
				ActiveRun *agentActiveRun    `json:"active_run"`
				Messages  []agentMessageView `json:"messages"`
			}
			env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+c.ID.String(), nil, &pending)
			if pending.ActiveRun == nil || pending.ActiveRun.Stage != "stopping" {
				t.Fatalf("停止中状态必须可刷新恢复：%+v", pending.ActiveRun)
			}
			if len(pending.Messages) < 2 || len(pending.Messages[1].ToolCalls) != 2 || pending.Messages[1].ToolCalls[0].Status != "running" {
				t.Fatalf("在途工具快照缺失：%+v", pending.Messages)
			}
			close(release)
			aw06WaitRun(t, body)
			var runStatus string
			var result string
			var pairs, actions, stopping int
			if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, accepted.RunID).Scan(&runStatus); err != nil {
				t.Fatal(err)
			}
			if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),string_agg(content,E'\n' ORDER BY seq) FROM agent_message WHERE run_id=$1 AND role='tool'`, accepted.RunID).Scan(&pairs, &result); err != nil {
				t.Fatal(err)
			}
			if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_action WHERE conversation_id=$1`, c.ID).Scan(&actions); err != nil {
				t.Fatal(err)
			}
			if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_event WHERE run_id=$1 AND type='run.stage' AND payload->>'stage'='stopping'`, accepted.RunID).Scan(&stopping); err != nil {
				t.Fatal(err)
			}
			if runStatus != "stopped" || dispatched.Load() != 1 || pairs != 2 || actions != 0 || stopping != 1 || !strings.Contains(result, "inflight-complete") || !strings.Contains(result, `"cancelled"`) {
				t.Fatalf("停止后必须保存完整配对、仅执行在途调用：status=%s dispatched=%d pairs=%d actions=%d stopping=%d results=%s", runStatus, dispatched.Load(), pairs, actions, stopping, result)
			}
		})
	}
}

func TestAW06ToolCallIDsAreScopedToRunInSnapshot(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "shared_tool_id"}
	call.Function.Name = "get_context"
	provider := env.ensureToolModel(t)
	for _, text := range []string{"first-run-result", "second-run-result"} {
		if text == "second-run-result" {
			st.RunID = agentInsertRun(t, st.ConversationID, st.WorkspaceID, st.UserID, uuid.MustParse(provider), "running", "message")
		}
		if _, err := env.srv.agentInsertMessage(ctx, st, "assistant", "", []map[string]string{{"id": call.ID, "name": call.Function.Name}}, "", "", nil, nil); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.agentToolOutcome(ctx, st, call, agentToolRecord{Raw: []byte(`{"text":"` + text + `"}`), Summary: text}, true, nil); err != nil {
			t.Fatal(err)
		}
		env.srv.finishAgentRun(ctx, st, "completed", "", nil)
	}
	var detail struct {
		Messages []agentMessageView `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+st.ConversationID.String(), nil, &detail)
	if len(detail.Messages) != 2 {
		t.Fatalf("工具结果应折叠到两条助手消息：%+v", detail.Messages)
	}
	for i, text := range []string{"first-run-result", "second-run-result"} {
		calls := detail.Messages[i].ToolCalls
		if len(calls) != 1 || calls[0].Status != "done" || calls[0].Summary != text || !strings.Contains(calls[0].ResultPreview, text) {
			t.Fatalf("相同tool_call_id串到另一run：%+v", calls)
		}
	}
}

func TestAW06InterruptedToolSnapshotDoesNotInventCompletionOrDuration(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "unfinished_tool"}
	call.Function.Name = "get_context"
	if _, err := env.srv.agentInsertMessage(ctx, st, "assistant", "", []map[string]string{{"id": call.ID, "name": call.Function.Name}}, "", "", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.agentToolStarted(ctx, st, call, nil); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.RecoverAgentRunsOnBoot(ctx); err != nil {
		t.Fatal(err)
	}
	var detail struct {
		Messages []agentMessageView `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+st.ConversationID.String(), nil, &detail)
	if len(detail.Messages) != 1 || len(detail.Messages[0].ToolCalls) != 1 {
		t.Fatalf("未完成工具记录丢失：%+v", detail.Messages)
	}
	view := detail.Messages[0].ToolCalls[0]
	if view.Status != "interrupted" || view.DurationMS != nil || view.ResultPreview != "" {
		t.Fatalf("重启后不能把未知结果标为成功或伪造耗时：%+v", view)
	}
}

func TestAW06FailedTerminalEventNeverAnnouncesSuccess(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	constraint := "aw06_finish_" + uuid.New().String()[:8]
	if _, err := env.srv.db.Exec(ctx, "ALTER TABLE agent_event ADD CONSTRAINT "+constraint+
		" CHECK (conversation_id <> '"+st.ConversationID.String()+"'::uuid OR type <> 'run.ended') NOT VALID"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), "ALTER TABLE agent_event DROP CONSTRAINT IF EXISTS "+constraint)
	})
	events := []string{}
	env.srv.finishAgentRun(ctx, st, "completed", "", func(name string, _ any) { events = append(events, name) })
	if len(events) != 1 || events[0] != "error" {
		t.Fatalf("终态/事件失败不能向旧客户端发送done：%v", events)
	}
	var status string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM agent_run WHERE id=$1`, st.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "running" {
		t.Fatalf("失败事务不应单独留下成功状态：%s", status)
	}
	if _, err := env.srv.db.Exec(ctx, "ALTER TABLE agent_event DROP CONSTRAINT "+constraint); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.RecoverAgentRunsOnBoot(ctx); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM agent_run WHERE id=$1`, st.RunID).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("未提交终态应可在启动时恢复interrupted：%s %v", status, err)
	}
}

func TestAW06ToolEndedFailureRollsBackSavedResult(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	constraint := "aw06_tool_" + uuid.New().String()[:8]
	if _, err := env.srv.db.Exec(ctx, "ALTER TABLE agent_event ADD CONSTRAINT "+constraint+
		" CHECK (conversation_id <> '"+st.ConversationID.String()+"'::uuid OR type <> 'tool.ended') NOT VALID"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), "ALTER TABLE agent_event DROP CONSTRAINT "+constraint)
	})
	call := ai.ToolCall{ID: "atomic_result"}
	call.Function.Name = "get_context"
	call.Function.Arguments = "{}"
	err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, nil)
	if err == nil {
		t.Fatal("tool.ended失败时不能宣布工具结果保存成功")
	}
	var results int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_message WHERE run_id=$1 AND role='tool'`, st.RunID).Scan(&results); err != nil {
		t.Fatal(err)
	}
	if results != 0 {
		t.Fatalf("结束事件与工具结果必须共同回滚：results=%d", results)
	}
}

func TestAW06ToolEventsHaveSafePairedLifecycle(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	call := ai.ToolCall{ID: "safe_lifecycle"}
	call.Function.Name = "get_context"
	call.Function.Arguments = "{}"
	if err := env.srv.agentHandleToolCall(ctx, st, ident(ctx), call, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := env.srv.db.Query(ctx, `SELECT type,payload FROM agent_event WHERE run_id=$1 AND type IN ('tool.started','tool.ended') ORDER BY event_seq`, st.RunID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	types := []string{}
	for rows.Next() {
		var eventType string
		var raw []byte
		if err := rows.Scan(&eventType, &raw); err != nil {
			t.Fatal(err)
		}
		var event map[string]any
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		if event["tool_call_id"] != call.ID || event["name"] != call.Function.Name || event["duration_ms"] == nil {
			t.Fatalf("工具回执缺少必要字段：%s", raw)
		}
		for key := range event {
			if key != "tool_call_id" && key != "name" && key != "status" && key != "summary" && key != "duration_ms" && key != "error" {
				t.Fatalf("工具事件泄露非白名单字段：%s", key)
			}
		}
		types = append(types, eventType)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(types) != 2 || types[0] != "tool.started" || types[1] != "tool.ended" {
		t.Fatalf("工具生命周期不完整：%v", types)
	}
}
