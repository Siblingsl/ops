package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-17（W17）Windows 电脑控制测试（27 §11.5 服务端子项）：
// C01 租约创建；C02 目标绑定不继承；C04 单租约互斥；C07 硬禁区永远拒绝；
// C08 撤销后无残留；C09 未选目标不外发（target_handle 不透明）。UIA/视觉执行属第二批。
//
// DEV-CU P1-4（docs/36 §5，D-188）：创建/撤销/接管改为 202 受理 + 设备确认闭环，
// 本文件按新契约改写，并补 pending 不占前台、generation CAS、迟到确认、跨用户确认四组用例。

// w17Accepted 是 202 受理回执的固定形状（grant_id/generation/state/expires_at/after_event_seq）。
type w17Accepted struct {
	GrantID       string `json:"grant_id"`
	Generation    int64  `json:"generation"`
	State         string `json:"state"`
	ExpiresAt     string `json:"expires_at"`
	AfterEventSeq int64  `json:"after_event_seq"`
}

// w17AckResult 是设备确认成功后的响应形状。
type w17AckResult struct {
	ID         string `json:"id"`
	State      string `json:"state"`
	Generation int64  `json:"generation"`
}

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

func w17CreateGrantPath(conv agentConversation) string {
	return "/api/v1/agent/conversations/" + conv.ID.String() + "/computer-grants"
}

func w17AckPath(grantID string) string {
	return "/api/v1/agent/computer/grants/" + grantID + "/device-ack"
}

// w17CreatePending 只建租约、不做设备确认，断言 202 且返回 pending。
func w17CreatePending(t *testing.T, conv agentConversation, targetHandle, targetSummary, scope, requestID string) w17Accepted {
	t.Helper()
	var accepted w17Accepted
	env.mustJSONStatus(t, "POST", w17CreateGrantPath(conv), map[string]any{
		"target_handle": targetHandle, "target_summary": targetSummary,
		"scope": scope, "request_id": requestID,
	}, &accepted, http.StatusAccepted)
	if accepted.State != "pending" || accepted.GrantID == "" {
		t.Fatalf("建租约应 202 pending：%+v", accepted)
	}
	return accepted
}

// w17AckGrant 设备确认：pending → active / revoking → revoked。
func w17AckGrant(t *testing.T, grantID string, generation int64, targetSummary string) w17AckResult {
	t.Helper()
	var out w17AckResult
	body := map[string]any{"generation": generation}
	if targetSummary != "" {
		body["target_summary"] = targetSummary
	}
	env.mustJSON(t, "POST", w17AckPath(grantID), body, &out)
	if out.ID != grantID {
		t.Fatalf("设备确认返回的租约不一致：%+v vs %s", out, grantID)
	}
	return out
}

func w17ListGrants(t *testing.T, conv agentConversation) []computerGrantView {
	t.Helper()
	var list struct {
		Grants []computerGrantView `json:"grants"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/computer-grants?conversation_id="+conv.ID.String(), map[string]any{}, &list)
	return list.Grants
}

// w17CreateGrant 建租约 + 设备确认 → active，并取回完整视图（列表只返回 active）。
func w17CreateGrant(t *testing.T, conv agentConversation, targetHandle, targetSummary, scope string) computerGrantView {
	t.Helper()
	accepted := w17CreatePending(t, conv, targetHandle, targetSummary, scope, uuid.NewString())
	if ack := w17AckGrant(t, accepted.GrantID, accepted.Generation, targetSummary); ack.State != "active" {
		t.Fatalf("设备确认后应 active：%+v", ack)
	}
	for _, g := range w17ListGrants(t, conv) {
		if g.ID == accepted.GrantID {
			return g
		}
	}
	t.Fatalf("确认后应在活动租约列表中：%s", accepted.GrantID)
	return computerGrantView{}
}

func TestW17FeatureGatesAndGrantLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	env.expectErr(t, "POST", w17CreateGrantPath(conv), map[string]any{
		"target_handle": "hwnd:123", "target_summary": "记事本", "scope": "observe", "request_id": uuid.NewString(),
	}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	// C01：建租约 202 pending，本机设备确认后才 active（30 秒过期）
	accepted := w17CreatePending(t, conv, "hwnd:12345", "记事本 - 无标题", "observe", uuid.NewString())
	if accepted.AfterEventSeq < 0 {
		t.Fatalf("after_event_seq 不应为负：%+v", accepted)
	}
	grant := w17CreateGrant(t, conv, "hwnd:12345", "记事本 - 无标题", "observe")
	if grant.State != "active" || grant.TargetHandle != "hwnd:12345" {
		t.Fatalf("租约应 active：%+v", grant)
	}

	// C04：单租约互斥（同用户已有 active）
	env.expectErr(t, "POST", w17CreateGrantPath(conv), map[string]any{
		"target_handle": "hwnd:67890", "target_summary": "计算器", "scope": "observe", "request_id": uuid.NewString(),
	}, "computer_foreground_busy")

	// C08：撤销 202 受理（revoking），设备确认后才 revoked；撤销后不再占前台，可再建
	var revokeAck struct {
		ID               string `json:"id"`
		State            string `json:"state"`
		Generation       int64  `json:"generation"`
		DeviceAckPending bool   `json:"device_ack_pending"`
	}
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &revokeAck, http.StatusAccepted)
	if revokeAck.State != "revoking" || !revokeAck.DeviceAckPending {
		t.Fatalf("撤销应 202 revoking + device_ack_pending：%+v", revokeAck)
	}
	if revoke := w17AckGrant(t, grant.ID, revokeAck.Generation, ""); revoke.State != "revoked" {
		t.Fatalf("设备确认后应 revoked：%+v", revoke)
	}

	grant2RequestID := uuid.NewString()
	accepted2 := w17CreatePending(t, conv, "hwnd:67890", "计算器", "observe", grant2RequestID)
	if ack := w17AckGrant(t, accepted2.GrantID, accepted2.Generation, "计算器"); ack.State != "active" {
		t.Fatalf("撤销后新租约应 active：%+v", ack)
	}

	// 幂等：同 request_id 返回原租约（同编号同载荷），仍是 202 受理语义
	var replay w17Accepted
	env.mustJSONStatus(t, "POST", w17CreateGrantPath(conv), map[string]any{
		"target_handle": "hwnd:67890", "target_summary": "计算器", "scope": "observe", "request_id": grant2RequestID,
	}, &replay, http.StatusAccepted)
	if replay.GrantID != accepted2.GrantID {
		t.Fatalf("同 request_id 应幂等返回原租约：%+v vs %+v", accepted2, replay)
	}

	// C08：handoff 同样先进 revoking（device_ack_pending），不当成已停止
	var handoff struct {
		ID               string `json:"id"`
		State            string `json:"state"`
		Generation       int64  `json:"generation"`
		DeviceAckPending bool   `json:"device_ack_pending"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/agent/computer-grants/"+accepted2.GrantID+"/handoff", map[string]any{}, &handoff, http.StatusAccepted)
	if handoff.State != "revoking" || !handoff.DeviceAckPending {
		t.Fatalf("handoff 应 202 revoking：%+v", handoff)
	}
	if ack := w17AckGrant(t, accepted2.GrantID, handoff.Generation, ""); ack.State != "revoked" {
		t.Fatalf("handoff 设备确认后应 revoked：%+v", ack)
	}
	// 终态后再撤销 404
	env.expectErr(t, "DELETE", "/api/v1/agent/computer-grants/"+accepted2.GrantID, map[string]any{}, "not_found")

	// 查询：无活动租约
	if grants := w17ListGrants(t, conv); len(grants) != 0 {
		t.Fatalf("撤销后不应有活动租约：%d", len(grants))
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
		env.expectErr(t, "POST", w17CreateGrantPath(conv), map[string]any{
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
	other.expectErr(t, "POST", w17AckPath(grant.ID), map[string]any{"generation": grant.Generation}, "not_found")
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
	if grant.TargetHandle == "记事本" || len(grant.TargetHandle) > 256 {
		t.Fatalf("target_handle 应为不透明句柄：%q", grant.TargetHandle)
	}
	// target_summary 只含用户选窗时的摘要，不泄漏其他窗口信息
	_ = context.Background()
}

// A12（决策 A）：模型请求用户选窗——没有租约时请求，有租约时报现状，不重复打扰。
func TestA12RequestComputerTarget(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	dispatch := func(conversationID uuid.UUID) map[string]any {
		t.Helper()
		res := env.agentDispatch(t, "computer_request_target", nil, func(req *agentDispatchRequest) {
			req.Principal.ConversationID = conversationID
		})
		if res.Status != http.StatusOK {
			t.Fatalf("请求选窗返回 %d：%s", res.Status, res.Raw)
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

	// 已有活动租约：直接回现状，前端不再弹窗。
	grant := w17CreateGrant(t, conv, "w17:abc123", "记事本 - 无标题", "observe")
	got := dispatch(conv.ID)
	if got["state"] != "active" {
		t.Fatalf("有租约时应返回 active：%+v", got)
	}
	view, ok := got["grant"].(map[string]any)
	if !ok || view["id"] != grant.ID || view["target_summary"] != "记事本 - 无标题" {
		t.Fatalf("应返回当前租约：%+v", got["grant"])
	}

	// 无会话归属（非会话内工具调用）拒绝，避免工作台直接调用绕过选窗。
	res := env.agentDispatch(t, "computer_request_target", nil, func(req *agentDispatchRequest) {
		req.Principal.ConversationID = uuid.Nil
	})
	if res.Status == http.StatusOK {
		t.Fatalf("无会话归属不应成功：%s", res.Raw)
	}
}

// P1-4 / 红线 12：pending 不占前台；本机确认后才 active；迟到或错摘要的确认一律 409。
func TestW17PendingToActive(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	p1 := w17CreatePending(t, conv, "hwnd:p1", "记事本 A", "observe", uuid.NewString())
	// pending 不占前台：第二个 pending 也能建（不被 computer_foreground_busy 挡）
	p2 := w17CreatePending(t, conv, "hwnd:p2", "记事本 B", "observe", uuid.NewString())
	// 未确认的租约不得出现在活动租约查询里（避免“受理即已授权”）
	if grants := w17ListGrants(t, conv); len(grants) != 0 {
		t.Fatalf("pending 不应出现在活动租约列表：%+v", grants)
	}

	// 窗口身份摘要与批准时不一致 → 专门的 computer_target_changed（此时两者都还是 pending）
	env.expectErr(t, "POST", w17AckPath(p2.GrantID), map[string]any{
		"generation": p2.Generation, "target_summary": "记事本 B - 已改名",
	}, "computer_target_changed")

	// 设备确认 → active
	if ack := w17AckGrant(t, p1.GrantID, p1.Generation, "记事本 A"); ack.State != "active" {
		t.Fatalf("设备确认后应 active：%+v", ack)
	}
	// 两个 pending 同时转正时，第二个必须被前台互斥拦下（转正前再查一次单租约）
	env.expectErr(t, "POST", w17AckPath(p2.GrantID), map[string]any{
		"generation": p2.Generation, "target_summary": "记事本 B",
	}, "computer_foreground_busy")

	// 迟到/重复的 device-ack：状态已不是待确认 → 409，不静默成功
	env.expectErr(t, "POST", w17AckPath(p1.GrantID), map[string]any{
		"generation": p1.Generation, "target_summary": "记事本 A",
	}, "computer_approval_conflict")
}

// P1-4 步骤 6：generation 被真正消费——撤销递增后，旧 generation 的确认被拒。
func TestW17GenerationCAS(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant := w17CreateGrant(t, conv, "hwnd:cas", "记事本 CAS", "observe")

	var revoked struct {
		ID               string `json:"id"`
		State            string `json:"state"`
		Generation       int64  `json:"generation"`
		DeviceAckPending bool   `json:"device_ack_pending"`
	}
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &revoked, http.StatusAccepted)
	if revoked.State != "revoking" || revoked.Generation != grant.Generation+1 {
		t.Fatalf("撤销应 revoking 且 generation 递增：%+v（原 %d）", revoked, grant.Generation)
	}

	// 旧 generation（批准时的那一版）不再被接受
	env.expectErr(t, "POST", w17AckPath(grant.ID), map[string]any{"generation": grant.Generation},
		"computer_approval_conflict")
	// 当前 generation 才生效，且 revoking 只能转 revoked
	if ack := w17AckGrant(t, grant.ID, revoked.Generation, ""); ack.State != "revoked" {
		t.Fatalf("revoking 确认后应 revoked：%+v", ack)
	}
	// 终态幂等边界：再撤销 404、再确认 409
	env.expectErr(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, "not_found")
	env.expectErr(t, "POST", w17AckPath(grant.ID), map[string]any{"generation": revoked.Generation},
		"computer_approval_conflict")
}

// P1-4：设备确认必须同时满足登录归属、功能开关与“确实待确认”，三者缺一都不放行。
func TestW17DeviceAckAuthorization(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	pending := w17CreatePending(t, conv, "hwnd:authz", "记事本 Authz", "observe", uuid.NewString())

	// 跨用户：不泄露存在性
	other := env.registerClient(t, "w17-ack-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "POST", w17AckPath(pending.GrantID), map[string]any{"generation": pending.Generation}, "not_found")
	other.restore(env)

	// 功能开关关闭：确认同样不可用（避免关掉开关后旧 pending 仍能转正）
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.expectErr(t, "POST", w17AckPath(pending.GrantID), map[string]any{"generation": pending.Generation},
		"agent_feature_unavailable")

	// 开关恢复后同一 pending 仍可确认（关闭期间没有副作用）
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	if ack := w17AckGrant(t, pending.GrantID, pending.Generation, "记事本 Authz"); ack.State != "active" {
		t.Fatalf("恢复开关后应可确认：%+v", ack)
	}
}

// 红线 12：202 只表示受理，撤销/接管不得被当成“已停止”。
func TestW17RevokeRequiresDeviceAck(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv := w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant := w17CreateGrant(t, conv, "hwnd:rev", "记事本 Revoke", "observe")

	var revoking struct {
		ID               string `json:"id"`
		State            string `json:"state"`
		Generation       int64  `json:"generation"`
		DeviceAckPending bool   `json:"device_ack_pending"`
	}
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &revoking, http.StatusAccepted)
	if revoking.State != "revoking" || !revoking.DeviceAckPending {
		t.Fatalf("撤销应停在 revoking 等设备确认：%+v", revoking)
	}
	// 受理后立即不再算活动前台（新任务可开工），但状态仍是 revoking 而非 revoked
	if grants := w17ListGrants(t, conv); len(grants) != 0 {
		t.Fatalf("revoking 不应再算活动租约：%+v", grants)
	}
	// 设备确认前，登记状态可由重复撤销观察到：已不是 pending/active → 404
	env.expectErr(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, "not_found")
	// 确认后才落终态；且 device_ack_pending 已消费
	if ack := w17AckGrant(t, grant.ID, revoking.Generation, ""); ack.State != "revoked" {
		t.Fatalf("设备确认后应 revoked：%+v", ack)
	}
	env.expectErr(t, "POST", w17AckPath(grant.ID), map[string]any{"generation": revoking.Generation},
		"computer_approval_conflict")
}
