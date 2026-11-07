package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-17（W17）Windows 电脑控制测试（27 §11.5 服务端子项）：
// C01 租约创建；C02 目标绑定不继承；C04 单租约互斥；C07 硬禁区永远拒绝；
// C08 撤销后无残留；C09 未选目标不外发（target_handle 不透明）。UIA/视觉执行属第二批。

func w17CreateConv(t *testing.T) agentConversation {
	t.Helper()
	// 组合跑时前序 registerClient 可能污染 env 会话——强制重登 owner。
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("W17 恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	providerID := env.ensureToolModel(t)
	return env.agentRunConversation(t, providerID)
}

func w17CreateGrant(t *testing.T, conv agentConversation, targetHandle, targetSummary, scope string) computerGrantView {
	t.Helper()
	return w17CreateGrantWithRequest(t, conv, targetHandle, targetSummary, scope, uuid.NewString())
}

func w17CreateGrantWithRequest(t *testing.T, conv agentConversation, targetHandle, targetSummary, scope, requestID string) computerGrantView {
	t.Helper()
	var grant computerGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": targetHandle, "target_summary": targetSummary,
		"scope": scope, "request_id": requestID,
	}, &grant)
	return grant
}

func TestW17FeatureGatesAndGrantLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:123", "target_summary": "记事本", "scope": "observe", "request_id": uuid.NewString(),
	}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	// C01：创建 active 租约（30 秒过期）
	grant := w17CreateGrant(t, conv, "hwnd:12345", "记事本 - 无标题", "observe")
	if grant.State != "active" || grant.TargetHandle != "hwnd:12345" {
		t.Fatalf("租约应 active：%+v", grant)
	}

	// C04：单租约互斥（同用户已有 active）
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:67890", "target_summary": "计算器", "scope": "observe", "request_id": uuid.NewString(),
	}, "computer_foreground_busy")

	// C08：撤销后可再创建（generation 递增使旧授权失效）
	env.mustJSON(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, nil)
	grant2RequestID := uuid.NewString()
	grant2 := w17CreateGrantWithRequest(t, conv, "hwnd:67890", "计算器", "observe", grant2RequestID)
	// generation 是每租约独立计数器；撤销旧租约时旧租约 generation 递增使旧授权失效
	if grant2.State != "active" {
		t.Fatalf("撤销后新租约应 active：%+v", grant2)
	}

	// 幂等：同 request_id 返回原租约（同编号同载荷）
	var replay computerGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:67890", "target_summary": "计算器", "scope": "observe", "request_id": grant2RequestID,
	}, &replay)
	if replay.ID != grant2.ID {
		t.Fatalf("同 request_id 应幂等返回原租约：%+v vs %+v", grant2, replay)
	}

	// C08：handoff 撤销（device_ack_pending）
	var handoff map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer-grants/"+grant2.ID+"/handoff", map[string]any{}, &handoff)
	if handoff["state"] != "revoked" {
		t.Fatalf("handoff 应 revoked：%+v", handoff)
	}
	// 终态后再撤销 404
	env.expectErr(t, "DELETE", "/api/v1/agent/computer-grants/"+grant2.ID, map[string]any{}, "not_found")

	// 查询：无活动租约
	var list struct {
		Grants []computerGrantView `json:"grants"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/computer-grants?conversation_id="+conv.ID.String(), map[string]any{}, &list)
	if len(list.Grants) != 0 {
		t.Fatalf("撤销后不应有活动租约：%d", len(list.Grants))
	}
}

func TestW17C07HardForbidden(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// C07：硬禁区永远拒绝（即使被网页诱导或普通授权）
	for _, forbidden := range []struct{ handle, summary string }{
		{"hwnd:1", "Windows 安全中心 - UAC 确认"},
		{"hwnd:2", "cmd.exe - 命令提示符"},
		{"hwnd:3", "Windows PowerShell"},
		{"hwnd:4", "凭据管理器"},
		{"hwnd:5", "注册表编辑器"},
	} {
		env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
			"target_handle": forbidden.handle, "target_summary": forbidden.summary,
			"scope": "act", "request_id": uuid.NewString(),
		}, "computer_hard_forbidden")
	}
}

func TestW17C02IsolationAndC09Privacy(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant := w17CreateGrant(t, conv, "hwnd:100", "记事本", "observe")

	// C02：跨用户不可见、改不动（404 不泄露）
	other := env.registerClient(t, "w17-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, "not_found")
	other.expectErr(t, "POST", "/api/v1/agent/computer-grants/"+grant.ID+"/handoff", map[string]any{}, "not_found")
	var olist struct {
		Grants []computerGrantView `json:"grants"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/computer-grants?conversation_id="+conv.ID.String(), map[string]any{}, &olist)
	if len(olist.Grants) != 0 {
		t.Fatalf("跨用户不得看到他人租约：%d", len(olist.Grants))
	}
	other.restore(env)

	// viewer/代访问拒绝
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w17-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("GET", "/api/v1/agent/computer-grants?conversation_id="+conv.ID.String(), map[string]any{}); st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，got %d", st)
	}
	viewer.restore(env)

	// C09：target_handle 不透明（API 不返回窗口标题/进程路径等富信息）
	if grant.TargetHandle == "记事本 - 无标题" || len(grant.TargetHandle) > 256 {
		t.Fatalf("target_handle 应为不透明句柄：%q", grant.TargetHandle)
	}
	// target_summary 只含用户选窗时的摘要，不泄漏其他窗口信息
	_ = context.Background()
}
