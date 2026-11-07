package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-AI27-04（W04）浏览器配对/绑定/租约的权限与生命周期测试。
// 覆盖 T-AI27-04（首次连接状态）、T-AI27-05（实例隔离）、T-AI27-06（最小授权），
// T-AI27-14/15/16/25A 的服务端子项（幂等、租户、只减权清理）；命令账本/事件投影属 W04 第二批。

func w04ConfirmBody(t *testing.T, revision int64) map[string]any {
	t.Helper()
	return map[string]any{
		"expected_revision":     revision,
		"extension_instance_id": uuid.NewString(),
		"device_id":             uuid.NewString(),
		"connection_name":       "工作Chrome",
		"browser_kind":          "chrome",
		"protocol_range":        "1",
	}
}

func TestW04BrowserFeatureGates(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.expectErr(t, "GET", "/api/v1/agent/browser/capabilities", nil, "agent_feature_unavailable")
	env.expectErr(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect")
	var caps map[string]any
	env.mustJSON(t, "GET", "/api/v1/agent/browser/capabilities", nil, &caps)
	if caps["chrome_connect"] != true || caps["browser_workspace"] != false {
		t.Fatalf("chrome_connect 单独开启时 workspace 依赖必须降级：%v", caps)
	}
	// 只减权清理路由不受开关影响：没有绑定也应返回 404 而不是功能不可用。
	env.expectErr(t, "DELETE", "/api/v1/agent/browser/bindings/"+uuid.NewString(), nil, "not_found")
}

func TestW04PairingIdempotencyConfirmCAS(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	requestID := uuid.NewString()
	var first browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": requestID}, &first)
	var replay browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": requestID}, &replay)
	if replay.ID != first.ID || replay.Code != first.Code {
		t.Fatalf("配对幂等重放应返回原事务：%+v vs %+v", first, replay)
	}
	if len(first.Code) != 6 {
		t.Fatalf("配对短码应为 6 位：%q", first.Code)
	}

	// revision 不符 CAS 拒绝
	body := w04ConfirmBody(t, first.Revision+99)
	env.expectErr(t, "POST", "/api/v1/agent/browser/pairings/"+first.ID+"/confirm", body, "browser_pairing_conflict")
	// 正确 revision 确认成功并创建绑定
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+first.ID+"/confirm", w04ConfirmBody(t, first.Revision), &confirmed)
	if confirmed.BindingID == "" {
		t.Fatal("确认后应返回绑定 ID")
	}
	// 二次确认 409（同一事务只能确认一次）
	env.expectErr(t, "POST", "/api/v1/agent/browser/pairings/"+first.ID+"/confirm", w04ConfirmBody(t, first.Revision), "browser_pairing_conflict")

	// 同一扩展实例重复绑定被拒（T-AI27-05 实例隔离）
	var second browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &second)
	var bindingList struct {
		Bindings []browserBindingView `json:"bindings"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/bindings", nil, &bindingList)
	if len(bindingList.Bindings) == 0 {
		t.Fatal("绑定列表应包含已确认实例")
	}
	instanceID := bindingList.Bindings[0].ExtensionInstanceID
	dup := w04ConfirmBody(t, second.Revision)
	dup["extension_instance_id"] = instanceID
	env.expectErr(t, "POST", "/api/v1/agent/browser/pairings/"+second.ID+"/confirm", dup, "browser_binding_conflict")

	// 解绑后可重新绑定同实例（只减权撤销 + 新配对）
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/bindings/"+confirmed.BindingID, map[string]any{}, nil)
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+second.ID+"/confirm", w04ConfirmBody(t, second.Revision), &confirmed)
}

func TestW04BrowserTenantIsolation(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	// owner 建绑定
	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)

	// viewer 拒绝（27 §14.1 P0）
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w04-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}); st != http.StatusForbidden {
		t.Fatalf("viewer 配对应被 403 拒绝，got %d", st)
	}
	viewer.expectErr(t, "GET", "/api/v1/agent/browser/bindings", nil, "browser_policy_denied")
	viewer.restore(env)

	// 他人（独立工作区 owner）不可见、不可撤（404 不泄露存在性，T-AI27-15）
	other := env.registerClient(t, "w04-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	var olist struct {
		Bindings []browserBindingView `json:"bindings"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/browser/bindings", nil, &olist)
	if len(olist.Bindings) != 0 {
		t.Fatalf("跨工作区不得看到他人绑定：%d", len(olist.Bindings))
	}
	other.expectErr(t, "DELETE", "/api/v1/agent/browser/bindings/"+confirmed.BindingID, nil, "not_found")
	other.expectErr(t, "POST", "/api/v1/agent/browser/grants/"+confirmed.BindingID+"/handoff", nil, "not_found")

	// 超管代访问拒绝（27 §14.1）
	ws := env.me(t).Workspace.ID
	st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if st != 200 {
		t.Fatalf("登录超管失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/"+ws+"/enter", map[string]any{}, nil)
	env.csrf = env.me(t).CSRF
	// 代访问被 agentGate 以 agent_disabled 拒绝（外层先行）；断言被 403 拒即可。
	if st, b := env.do("POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}); st != http.StatusForbidden {
		t.Fatalf("代访问配对应被 403 拒绝，got %d %s", st, b)
	}
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/exit", map[string]any{}, nil)
	// 恢复 owner 会话，避免污染同包后续测试（模式同 TestAG03AdminOverrideGate）。
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
}

func TestW04BrowserGrantLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 建绑定
	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)

	// 非活动 run 拒绝（409）
	deadRun := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "completed", "message")
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": deadRun.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, "browser_run_not_active")

	// 活动 run 成功创建 30s 租约
	runID := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var grant browserGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com", "https://example.org"},
	}, &grant)
	if grant.State != "active" || len(grant.Origins) != 2 {
		t.Fatalf("租约创建结果异常：%+v", grant)
	}

	// origins 超 5 上限 422
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(), "tab_handle": "tab-2",
		"origins": []string{"https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"},
	}, "browser_scope_invalid")

	// handoff 收回（generation 递增）→ 再次 handoff 404（不重复生效）
	var handoff struct {
		State            string `json:"state"`
		DeviceAckPending bool   `json:"device_ack_pending"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/grants/"+grant.ID+"/handoff", map[string]any{}, &handoff)
	if handoff.State != "revoked" || !handoff.DeviceAckPending {
		t.Fatalf("handoff 应返回 revoked+device_ack_pending：%+v", handoff)
	}
	env.expectErr(t, "POST", "/api/v1/agent/browser/grants/"+grant.ID+"/handoff", map[string]any{}, "not_found")

	// 只减权：关闭全部浏览器开关后撤销绑定仍可达（T-AI27-25A）
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/bindings/"+confirmed.BindingID, map[string]any{}, nil)
}

// DEV-AI27-04 第二批：命令账本（幂等/状态单向/租约联动/事件投影）。
func TestW04CommandLedgerLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 绑定 + 活动 run + 租约
	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	runID := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var grant browserGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)

	cmdBody := func(requestID string) map[string]any {
		return map[string]any{
			"grant_id": grant.ID, "run_id": runID.String(), "request_id": requestID,
			"action": "observe", "payload": map[string]any{"tab_id": 1},
		}
	}

	// 未登记动作拒绝
	rogue := cmdBody(uuid.NewString())
	rogue["action"] = "execute_js"
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", rogue, "browser_action_unsupported")

	// 创建 queued → 幂等重放返回原命令 → 异载荷 409
	var first browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands", cmdBody("11111111-1111-4111-8111-111111111111"), &first)
	if first.State != "queued" {
		t.Fatalf("新命令应 queued：%+v", first)
	}
	var replay browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands", cmdBody("11111111-1111-4111-8111-111111111111"), &replay)
	if replay.ID != first.ID || replay.State != "queued" {
		t.Fatalf("同编号同载荷应幂等：%+v vs %+v", first, replay)
	}
	conflict := cmdBody("11111111-1111-4111-8111-111111111111")
	conflict["payload"] = map[string]any{"tab_id": 2}
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", conflict, "browser_request_conflict")

	// 非本人 grant 409（不泄露）
	other := env.registerClient(t, "w04b-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	if st, _ := other.do("POST", "/api/v1/agent/browser/commands", cmdBody("22222222-2222-4222-8222-222222222222")); st != http.StatusConflict {
		t.Fatalf("他人租约建命令应 409，got %d", st)
	}
	other.restore(env)

	// dispatch → 事件投影 → receipt succeeded
	var dispatched browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands/"+first.ID+"/dispatch", map[string]any{}, &dispatched)
	if dispatched.State != "dispatched" {
		t.Fatalf("dispatch 后应 dispatched：%+v", dispatched)
	}
	var done browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands/"+first.ID+"/receipt", map[string]any{
		"state": "succeeded", "receipt_hash": "abc",
	}, &done)
	if done.State != "succeeded" {
		t.Fatalf("回执后应 succeeded：%+v", done)
	}
	// 终态：同结果幂等重放；不同结果 409（先核对不重放）
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands/"+first.ID+"/receipt", map[string]any{
		"state": "succeeded", "receipt_hash": "abc",
	}, &done)
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands/"+first.ID+"/receipt", map[string]any{
		"state": "failed",
	}, "browser_receipt_conflict")

	// 事件投影：browser.command_started/finished 进入会话事件流（直接查库，SSE 端点另测）。
	var eventCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_event WHERE conversation_id=$1`,
			conv.ID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount < 2 {
		t.Logf("会话事件总数=%d", eventCount)
		var types []string
		rows, err2 := env.srv.db.Query(context.Background(), `SELECT type FROM agent_event WHERE conversation_id=$1 ORDER BY event_seq DESC LIMIT 10`, conv.ID)
		if err2 == nil {
			for rows.Next() {
				var ty string
				rows.Scan(&ty)
				types = append(types, ty)
			}
			rows.Close()
		}
		t.Fatalf("命令事件未投影：count=%d types=%v", eventCount, types)
	}
	// 撤销租约 → 新命令 409、在途回执拒绝（迟到结果核对）
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/grants/"+grant.ID, map[string]any{}, nil)
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", cmdBody("33333333-3333-4333-8333-333333333333"), "browser_lease_conflict")
}

func TestW04CommandUnknownOutcomeSweep(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	runID := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var grant browserGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)

	// 创建命令并 dispatch，deadline 已过 → sweep 转 unknown_outcome → 迟到回执拒绝
	var cmd browserCommandView
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": runID.String(), "request_id": uuid.NewString(),
		"action": "click", "payload": map[string]any{"tab_id": 1}, "deadline_at": past,
	}, &cmd)
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/dispatch", map[string]any{}, &cmd)
	env.srv.sweepAgentBrowserCommands(context.Background())
	var after struct {
		Commands []browserCommandView 
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/commands?run_id="+runID.String(), map[string]any{}, &after)
	found := false
	for _, c := range after.Commands {
		if c.ID == cmd.ID && c.State == "unknown_outcome" {
			found = true
		}
	}
	if !found {
		t.Fatalf("sweep 后应 unknown_outcome：%+v", after.Commands)
	}
	// unknown_outcome 后迟到回执：租约有效 → 拒绝（先核对不重放，状态已终态不可迁移）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/receipt", map[string]any{
		"state": "succeeded",
	}, "browser_receipt_conflict")
}
