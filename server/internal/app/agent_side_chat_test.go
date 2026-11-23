package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"ops/internal/ai"
)

// FN-12（docs/38 §12.4、docs/90 D-190）：旁问是独立只读会话。
func TestFN12SideChatTypeContextBudgetAndArchive(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,run_control,side_chat,plans,event_resume")
	providerID := env.ensureToolModel(t)
	parent := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, parent.ID)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_conversation SET title='FN12 主对话',summary='FN12 主对话摘要' WHERE id=$1`, parent.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_message(conversation_id,seq,role,content,account_id)
		VALUES($1,1,'user','FN12 主对话原始请求：分析本周选题', $2),
		       ($1,2,'assistant','FN12 主对话原始回答：先看选题库存', $2)`,
		parent.ID, parent.AccountID); err != nil {
		t.Fatal(err)
	}

	var side agentConversation
	env.mustJSONStatus(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"kind": "side", "parent_id": parent.ID.String(), "request_id": uuid.NewString(),
	}, &side, http.StatusOK)
	defer deleteConversations(t, side.ID)
	if side.Kind != "side" || side.ParentID == nil || *side.ParentID != parent.ID {
		t.Fatalf("旁问类型/父会话错误：%+v", side)
	}
	if side.Mode != "discuss" || side.SideTokenBudget != 20000 {
		t.Fatalf("旁问必须是讨论模式且有独立预算：%+v", side)
	}
	if side.AccountID == nil || parent.AccountID == nil || *side.AccountID != *parent.AccountID || side.Model != parent.Model {
		t.Fatalf("旁问应继承主对话账号/模型：side=%+v parent=%+v", side, parent)
	}
	if !strings.HasPrefix(side.Title, "旁问 · ") {
		t.Fatalf("旁问标题应带类型前缀：%q", side.Title)
	}

	var snapshot string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT side_context FROM agent_conversation WHERE id=$1`, side.ID).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"FN12 主对话", "FN12 主对话摘要", "FN12 主对话原始请求", "FN12 主对话原始回答"} {
		if !strings.Contains(snapshot, want) {
			t.Fatalf("只读快照缺少 %q：%s", want, snapshot)
		}
	}
	if strings.Contains(snapshot, "side_context") || len([]rune(snapshot)) > agentSideContextChars {
		t.Fatalf("快照不应泄露内部字段或超限：%s", snapshot)
	}

	// 只读快照不进主对话，主对话也不因旁问产生任何新消息。
	var parentMessages int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, parent.ID).Scan(&parentMessages); err != nil {
		t.Fatal(err)
	}
	if parentMessages != 2 {
		t.Fatalf("创建旁问污染了主对话，消息数=%d", parentMessages)
	}
	if st, body := env.do(http.MethodGet, "/api/v1/agent/conversations/"+side.ID.String(), nil); st != 200 ||
		strings.Contains(string(body), "side_context") || strings.Contains(string(body), "FN12 主对话原始请求") {
		t.Fatalf("旁问详情不得下发只读快照：%d %s", st, body)
	}

	// 真实发送一条旁问消息：模型请求必须包含主对话只读快照，主对话仍不被写入。
	env.llm.ResetRequests()
	env.mustJSONStatus(t, http.MethodPost, agentRunPath(side, "messages"), map[string]any{
		"text": "旁问独立讨论", "request_id": uuid.NewString(), "protocol_version": 2,
	}, nil, http.StatusAccepted)
	promptSeen := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		for _, raw := range env.llm.Requests() {
			if strings.Contains(raw, "FN12 主对话原始请求：分析本周选题") && strings.Contains(raw, "只读快照") {
				promptSeen = true
				break
			}
		}
		if promptSeen {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !promptSeen {
		t.Fatal("真实模型请求没有继承主对话只读快照")
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		var active int
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT count(*) FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')`, side.ID).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, parent.ID).Scan(&parentMessages); err != nil {
		t.Fatal(err)
	}
	if parentMessages != 2 {
		t.Fatalf("旁问消息写进了主对话，消息数=%d", parentMessages)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT revision FROM agent_conversation WHERE id=$1`, side.ID).Scan(&side.Revision); err != nil {
		t.Fatal(err)
	}

	// 旁问只读：W 工具不可用，R 工具可用；上下文快照位于摘要之后。
	owner := &identity{UserID: uuid.New(), WorkspaceID: uuid.New(), Role: "owner"}
	sideState := &agentRunState{Kind: "side", Mode: "discuss"}
	if tool := agentTool("works__generate_image"); tool == nil {
		t.Fatal("缺少写入工具 works__generate_image")
	} else if agentRunToolAllowed(sideState, tool, owner) {
		t.Fatal("旁问不应允许写入工具")
	}
	if tool := agentTool("works__list"); tool == nil {
		t.Fatal("缺少只读工具 works__list")
	} else if !agentRunToolAllowed(sideState, tool, owner) {
		t.Fatal("旁问应允许只读工具")
	}
	out := agentAppendSideContext([]ai.Message{{Role: "system", Content: "base"}}, &agentRunState{
		Kind: "side", SideContext: "主对话只读快照：FN12",
	})
	last := out[len(out)-1]
	if last.Role != "system" || !strings.Contains(last.Content, "只读快照") || !strings.Contains(last.Content, "不得写入业务数据") {
		t.Fatalf("旁问上下文注入不符合只读语义：%+v", last)
	}

	// 不能把旁问当主对话，也不能替旁问另选账号/模型。
	env.expectErr(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"kind": "side", "parent_id": side.ID.String(), "request_id": uuid.NewString(),
	}, "agent_side_parent_invalid")
	env.expectErr(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"kind": "side", "parent_id": parent.ID.String(), "account_id": parent.AccountID.String(), "request_id": uuid.NewString(),
	}, "agent_side_target_inherited")
	env.expectErr(t, http.MethodPatch, "/api/v1/agent/conversations/"+side.ID.String(), map[string]any{
		"expected_revision": side.Revision, "mode": "execute",
	}, "agent_side_read_only")

	// 独立归档：归档旁问不改变主对话。
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_conversation SET archived_at=now() WHERE id=$1`, parent.ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"kind": "side", "parent_id": parent.ID.String(), "request_id": uuid.NewString(),
	}, "agent_side_parent_archived")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_conversation SET archived_at=NULL WHERE id=$1`, parent.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+side.ID.String(), map[string]any{
		"expected_revision": side.Revision, "archived": true,
	}, nil)
	var parentArchived, sideArchived bool
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT archived_at IS NOT NULL FROM agent_conversation WHERE id=$1`, parent.ID).Scan(&parentArchived); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT archived_at IS NOT NULL FROM agent_conversation WHERE id=$1`, side.ID).Scan(&sideArchived); err != nil {
		t.Fatal(err)
	}
	if parentArchived || !sideArchived {
		t.Fatalf("独立归档失败：parentArchived=%v sideArchived=%v", parentArchived, sideArchived)
	}

	// 独立预算：旁问自身累计 token 达上限后拒绝新运行，不影响主对话。
	var budgetSide agentConversation
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"kind": "side", "parent_id": parent.ID.String(), "request_id": uuid.NewString(),
	}, &budgetSide)
	defer deleteConversations(t, budgetSide.ID)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_conversation SET side_token_budget=1000 WHERE id=$1`, budgetSide.ID); err != nil {
		t.Fatal(err)
	}
	me := env.me(t)
	ownerID := uuid.MustParse(me.UserID)
	workspaceID := uuid.MustParse(me.Workspace.ID)
	runID := agentInsertRun(t, budgetSide.ID, workspaceID, ownerID, uuid.MustParse(providerID), "completed", "message")
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_run SET prompt_tokens=1000,completion_tokens=200 WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, http.MethodPost, agentRunPath(budgetSide, "messages"), map[string]any{
		"text": "旁问预算测试", "request_id": uuid.NewString(), "protocol_version": 2,
	}, "agent_side_budget_reached")
}
