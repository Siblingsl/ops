package app

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// A30：模型请求用户选标签——浏览器侧镜像 A12 决策 A。
// 没有租约时只产生"待选择"意图（不签发任何授权），有租约时报现状（前端不再弹窗），
// 非会话内工具调用拒绝（避免工作台直接调用绕过选标签）。

func TestA30RequestBrowserTab(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace")
	// 组合跑时前序 registerClient 可能污染 env 会话——强制重登 owner。
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("A30 恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	dispatch := func(conversationID uuid.UUID) map[string]any {
		t.Helper()
		res := env.agentDispatch(t, "browser_request_tab", nil, func(req *agentDispatchRequest) {
			req.Principal.ConversationID = conversationID
		})
		if res.Status != http.StatusOK {
			t.Fatalf("请求选标签返回 %d：%s", res.Status, res.Raw)
		}
		var out map[string]any
		if err := json.Unmarshal(res.Raw, &out); err != nil {
			t.Fatalf("响应不是 JSON：%v (%s)", err, res.Raw)
		}
		return out
	}

	// 无活动租约：只产生待选择意图，不签发任何授权。
	if got := dispatch(conv.ID); got["state"] != "awaiting_selection" {
		t.Fatalf("无租约时应等待用户选择：%+v", got)
	}
	if _, hasGrant := dispatch(conv.ID)["grant"]; hasGrant {
		t.Fatal("待选择响应不应携带租约")
	}

	// 建 binding + run + grant（同 wa7Setup 流程，但使用同一会话）。
	var pairing browserPairingView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	runID := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var grant browserGrantView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)

	// 已有活动租约：直接回现状，前端不再弹窗。
	got := dispatch(conv.ID)
	if got["state"] != "active" {
		t.Fatalf("有租约时应返回 active：%+v", got)
	}
	view, ok := got["grant"].(map[string]any)
	if !ok || view["id"] != grant.ID || view["tab_handle"] != "tab-1" {
		t.Fatalf("应返回当前租约：%+v", got["grant"])
	}

	// 无会话归属（非会话内工具调用）拒绝。
	res := env.agentDispatch(t, "browser_request_tab", nil, func(req *agentDispatchRequest) {
		req.Principal.ConversationID = uuid.Nil
	})
	if res.Status == http.StatusOK {
		t.Fatalf("无会话归属不应成功：%s", res.Raw)
	}
}
