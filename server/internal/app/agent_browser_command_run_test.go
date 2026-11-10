package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A30b 片 2（拍板：账本存载荷+同步等待）：run 内模型调用端到端。
// 模型平铺参数（action 由工具目录 Fixed 注入）→ 服务端自查 run 租约 → 登记 queued 含
// payload → 轮询等待；mock 桌面执行器：pending 领取（含 payload）→ CAS dispatch
// （claimed=true 拿载荷）→ receipt（含 result）→ 等待循环返回终态。
// 反例：无租约 409；非 run 内调用拒绝；无人领取超 deadline+sweep 转 unknown_outcome。

func a30bSetup(t *testing.T) (conv agentConversation, runID, providerID string) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace")
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("A30b 恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	providerID = env.ensureToolModel(t)
	conv = env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	var pairing browserPairingView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	runID = agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message").String()
	var grant browserGrantView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID,
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)
	return conv, runID, providerID
}

// a30bRunCall 在独立 goroutine 里走 dispatchAgentTool（run 内 principal），返回响应。
// goroutine 里不调 t.Fatal/Fatalf（不允许跨 goroutine）；错误经 channel 传回主 goroutine 断言。
func a30bRunCall(t *testing.T, convID uuid.UUID, runID uuid.UUID, action string, args map[string]any) <-chan [2]any {
	t.Helper()
	sess, ws, _ := env.agentSession(t)
	tool := agentTool(action)
	if tool == nil {
		t.Fatalf("目录中没有工具 %s", action)
	}
	out := make(chan [2]any, 1)
	go func() {
		res, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
			Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws, ConversationID: convID, RunID: runID},
			Tool:      tool,
			Args:      args,
		})
		if err != nil {
			out <- [2]any{0, err.Error()}
			return
		}
		out <- [2]any{res.Status, res.Raw}
	}()
	return out
}

func a30bWaitPending(t *testing.T) browserCommandView {
	t.Helper()
	var pending struct {
		Commands []browserCommandView `json:"commands"`
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("5s 内未发现 pending 命令")
		}
		env.mustJSON(t, http.MethodGet, "/api/v1/agent/browser/commands/pending", map[string]any{}, &pending)
		if len(pending.Commands) > 0 {
			return pending.Commands[0]
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestA30bRunBrowserCommandEndToEnd(t *testing.T) {
	conv, runID, _ := a30bSetup(t)

	resCh := a30bRunCall(t, conv.ID, uuid.MustParse(runID), "browser_observe", map[string]any{"tab_id": 1})

	// mock 桌面：领取 → 校验载荷 → CAS 派发 → 回执含 result。
	cmd := a30bWaitPending(t)
	if cmd.ActionKind != "observe" {
		t.Fatalf("动作应为 observe：%+v", cmd)
	}
	if cmd.State != "queued" {
		t.Fatalf("新命令应为 queued：%+v", cmd)
	}
	if !strings.Contains(string(cmd.Payload), `"tab_id":1`) {
		t.Fatalf("pending 响应应含执行载荷 tab_id：%s", cmd.Payload)
	}
	var claimed browserCommandView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/commands/"+cmd.ID+"/dispatch", map[string]any{}, &claimed)
	if !claimed.Claimed {
		t.Fatalf("首次派发应 claimed=true：%+v", claimed)
	}
	if !strings.Contains(string(claimed.Payload), `"tab_id":1`) {
		t.Fatalf("claimed 响应应携带载荷：%s", claimed.Payload)
	}
	// 二次派发：CAS 未命中，claimed=false（不重复执行）。
	var replay browserCommandView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/commands/"+cmd.ID+"/dispatch", map[string]any{}, &replay)
	if replay.Claimed {
		t.Fatal("二次派发不应 claimed（防多桌面重复执行）")
	}
	var receipt browserCommandView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/commands/"+cmd.ID+"/receipt", map[string]any{
		"state": "succeeded", "result": map[string]any{"nodes": []int{1, 2, 3}},
	}, &receipt)

	got := <-resCh
	if got[0] != http.StatusOK {
		t.Fatalf("run 内调用应 200：%v %s", got[0], got[1])
	}
	var final browserCommandView
	if err := json.Unmarshal(got[1].([]byte), &final); err != nil {
		t.Fatalf("响应不是 JSON：%v (%s)", err, got[1])
	}
	if final.State != "succeeded" {
		t.Fatalf("同步等待应返回终态 succeeded：%+v", final)
	}
	if !strings.Contains(string(final.Result), "nodes") {
		t.Fatalf("终态应携带扩展回执 result：%s", final.Result)
	}
	if final.Payload != nil {
		t.Fatal("给模型的最终视图不应回显 payload（模型已知自己的参数）")
	}
}

func TestA30bRunBrowserCommandNoLeaseRejected(t *testing.T) {
	conv, _, providerID := a30bSetup(t)
	_ = providerID
	// 无租约：409 browser_lease_conflict，提示先 browser_request_tab。
	got := <-a30bRunCall(t, conv.ID, uuid.New(), "browser_observe", map[string]any{"tab_id": 1})
	if got[0] != http.StatusConflict {
		t.Fatalf("无租约应 409：%v %s", got[0], got[1])
	}
	if !strings.Contains(string(got[1].([]byte)), "browser_lease_conflict") {
		t.Fatalf("错误码应为 browser_lease_conflict：%s", got[1])
	}
	// 非 run 内调用（无 RunID）拒绝：模型不能绕过任务上下文直接驱动浏览器。
	sess, ws, _ := env.agentSession(t)
	tool := agentTool("browser_observe")
	res, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
		Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws, ConversationID: conv.ID, RunID: uuid.Nil},
		Tool:      tool, Args: map[string]any{"tab_id": 1},
	})
	if err != nil {
		t.Fatalf("dispatch 失败：%v", err)
	}
	if res.Status != http.StatusUnprocessableEntity {
		t.Fatalf("无 RunID 应 422：%d %s", res.Status, res.Raw)
	}
}

func TestA30bRunBrowserCommandTimeoutUnknownOutcome(t *testing.T) {
	conv, runID, _ := a30bSetup(t)

	resCh := a30bRunCall(t, conv.ID, uuid.MustParse(runID), "browser_observe", map[string]any{"tab_id": 7})

	// 桌面不领取：把命令 deadline 改到过去，等待循环应在 deadline+2s 内转 unknown_outcome。
	cmd := a30bWaitPending(t)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_browser_command SET deadline_at = now() - interval '3 seconds' WHERE id=$1`, cmd.ID); err != nil {
		t.Fatal(err)
	}
	got := <-resCh
	if got[0] != http.StatusOK {
		t.Fatalf("超时路径也应 200（如实 unknown_outcome）：%v %s", got[0], got[1])
	}
	var final browserCommandView
	if err := json.Unmarshal(got[1].([]byte), &final); err != nil {
		t.Fatalf("响应不是 JSON：%v (%s)", err, got[1])
	}
	if final.State != "unknown_outcome" {
		t.Fatalf("无人领取应转 unknown_outcome：%+v", final)
	}
	if final.ErrorCode != "browser_wait_timeout" {
		t.Fatalf("错误码应为 browser_wait_timeout：%+v", final)
	}
}
