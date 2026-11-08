package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-16 失权竞态注入矩阵（T-AI27-16，27 §7.7/§13.3/§13.6）：
// ①服务端撤权→新命令 409+在途回执拒绝；②租约 30s 到期→同上；③时钟：deadline+2s 误差窗后
// sweep 转 unknown_outcome；④丢包场景（dispatch 后连接断开）→回执永不达→unknown_outcome 不重放。
// 本文件覆盖 ①②④ 的服务端注入矩阵（①③ 在 TestW04 已覆盖部分；此处系统化补齐）。

func w16GrantWithCommand(t *testing.T, conv agentConversation, providerID string) (browserGrantView, browserCommandView, func()) {
	t.Helper()
	// 组合跑时前序包 registerClient 链可能污染 env 会话——强制重登 owner（同 W16 模式）。
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("W16 注入矩阵恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
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
	var cmd browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": runID.String(), "request_id": uuid.NewString(),
		"action": "observe", "payload": map[string]any{"tab_id": 1},
	}, &cmd)
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/dispatch", map[string]any{}, &cmd)
	cleanup := func() {
		env.mustJSON(t, "DELETE", "/api/v1/agent/browser/bindings/"+confirmed.BindingID, map[string]any{}, nil)
	}
	return grant, cmd, cleanup
}

func TestW16Scenario1ServerRevokedMidFlight(t *testing.T) {
	clearAgentFeatureSettings(t)
	reloginOwner(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant, cmd, _ := w16GrantWithCommand(t, conv, providerID)

	// 撤销租约（服务端撤权，模拟用户接管/停止）
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/grants/"+grant.ID, map[string]any{}, nil)

	// 在途回执被拒绝（409，不虚称已成功）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/receipt", map[string]any{
		"state": "succeeded", "receipt_hash": "aa",
	}, "browser_lease_conflict")

	// 撤销后新命令 409（复用原 run——grant 撤销校验先于 run 状态校验）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": agentRunIDOfCommand(t, cmd.ID),
		"request_id": uuid.NewString(), "action": "observe", "payload": map[string]any{"tab_id": 1},
	}, "browser_lease_conflict")
}

func TestW16Scenario2GrantExpiryMidFlight(t *testing.T) {
	clearAgentFeatureSettings(t)
	reloginOwner(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant, cmd, _ := w16GrantWithCommand(t, conv, providerID)

	// 直接把租约 expires_at 置为过去（模拟 30s 到期，免实际等待）
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_browser_grant SET expires_at = now() - interval '1 second' WHERE id=$1`, grant.ID); err != nil {
		t.Fatal(err)
	}

	// 到期后回执拒绝（租约过期→与撤销同语义）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/receipt", map[string]any{
		"state": "succeeded",
	}, "browser_lease_conflict")

	// 到期后新命令拒绝（复用原 run）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": agentRunIDOfCommand(t, cmd.ID),
		"request_id": uuid.NewString(), "action": "observe", "payload": map[string]any{"tab_id": 1},
	}, "browser_lease_conflict")
}

func TestW16Scenario3PacketLossUnknownOutcomeNoReplay(t *testing.T) {
	clearAgentFeatureSettings(t)
	reloginOwner(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant, cmd, _ := w16GrantWithCommand(t, conv, providerID)

	// 丢包：dispatch 后 deadline 已过 + 无回执 → sweep → unknown_outcome（不重放）
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_browser_command SET deadline_at = now() - interval '5 seconds' WHERE id=$1`, cmd.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.sweepAgentBrowserCommands(context.Background())

	var after browserCommandView
	env.mustJSON(t, "GET", "/api/v1/agent/browser/commands?run_id="+agentRunIDOfCommand(t, cmd.ID), map[string]any{}, &after)
	_ = after
	var list struct {
		Commands []browserCommandView `json:"commands"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/commands?run_id="+agentRunIDOfCommand(t, cmd.ID), map[string]any{}, &list)
	found := false
	for _, c := range list.Commands {
		if c.ID == cmd.ID {
			if c.State != "unknown_outcome" {
				t.Fatalf("丢包后应 unknown_outcome：%s", c.State)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("sweep 后命令应存在于账本")
	}

	// 迟到回执：租约仍有效 → 终态 409（先核对不重放）
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands/"+cmd.ID+"/receipt", map[string]any{
		"state": "succeeded",
	}, "browser_receipt_conflict")
	_ = grant
}

func TestW16Scenario4RevokedGrantCascadeCommands(t *testing.T) {
	clearAgentFeatureSettings(t)
	reloginOwner(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	grant, cmd, _ := w16GrantWithCommand(t, conv, providerID)

	// 撤销绑定（只减权清理）→ 级联撤销全部租约 → 后续命令全部 409
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/bindings/"+grant.BindingID, map[string]any{}, nil)
	env.expectErr(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": agentRunIDOfCommand(t, cmd.ID),
		"request_id": uuid.NewString(), "action": "observe", "payload": map[string]any{"tab_id": 1},
	}, "browser_lease_conflict")

	// 事件投影验证：browser.control_changed 级联在 grant 表（事件由 API 层发）——结构断言
	var grantState string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM agent_browser_grant WHERE id=$1`, grant.ID).Scan(&grantState); err != nil {
		t.Fatal(err)
	}
	if grantState != "revoked" {
		t.Fatalf("级联后租约应 revoked：%s", grantState)
	}
}

func agentRunIDOfCommand(t *testing.T, commandID string) string {
	t.Helper()
	var runID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT run_id FROM agent_browser_command WHERE id=$1`, commandID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	return runID.String()
}

// reloginOwner 强制重登 owner（组合跑时前序包 registerClient 链污染 env 会话；同 W16c 模式）。
func reloginOwner(t *testing.T) {
	t.Helper()
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
}

// S05 前台互斥（27 §11.5.2）：浏览器 AI 操作与电脑控制共用全设备前台——双向互斥。
func TestS05ForegroundMutualExclusion(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,computer_use")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	reloginOwner(t)

	// 1. 先创建活动浏览器 grant → computer grant 409
	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	browserRun := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	var browserGrant browserGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": browserRun.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &browserGrant)

	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:1", "target_summary": "记事本",
		"scope": "observe", "request_id": uuid.NewString(),
	}, "computer_foreground_busy")

	// 2. 撤销浏览器 grant → computer grant 可创建
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/grants/"+browserGrant.ID, map[string]any{}, nil)
	var computerGrant computerGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:1", "target_summary": "记事本",
		"scope": "observe", "request_id": uuid.NewString(),
	}, &computerGrant)

	// 3. 反向：有活动 computer grant → browser grant 409
	// 撤销 computer grant，重新创建 browser grant → 再创建 computer grant 409
	env.mustJSON(t, "DELETE", "/api/v1/agent/computer-grants/"+computerGrant.ID, map[string]any{}, nil)
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": browserRun.String(),
		"tab_handle": "tab-2", "origins": []string{"https://example.com"},
	}, &browserGrant)
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:2", "target_summary": "计算器",
		"scope": "observe", "request_id": uuid.NewString(),
	}, "computer_foreground_busy")

	// 4. 清理浏览器 grant → computer 可创建
	env.mustJSON(t, "DELETE", "/api/v1/agent/browser/grants/"+browserGrant.ID, map[string]any{}, nil)
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/computer-grants", map[string]any{
		"target_handle": "hwnd:3", "target_summary": "计算器",
		"scope": "observe", "request_id": uuid.NewString(),
	}, &computerGrant)
	env.mustJSON(t, "DELETE", "/api/v1/agent/computer-grants/"+computerGrant.ID, map[string]any{}, nil)
}
