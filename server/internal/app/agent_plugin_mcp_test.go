package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-14（W14）插件/MCP 测试：
// T-AI27-P02（安装与启用分离、CAS、秘密不入库）、P03（未启用拒绝=业务旁路防线、viewer/代访问拒绝）、
// P04 服务端子项（调用回执幂等与异结果冲突）。P01 的真实 stdio/HTTP 传输在 desktop mcp-host 测试覆盖。

func w14Create(t *testing.T) pluginConnection {
	t.Helper()
	var conn pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections", map[string]any{
		"name": "W14 文档检索", "transport": "stdio",
		"command": "node", "args": []string{"server.js"},
		"cwd": "F:\\code\\project\\OPS\\.tmp", "env_keys": []string{"W14_TOKEN"},
	}, &conn)
	return conn
}

func TestW14PluginFeatureGatesAndLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.expectErr(t, "GET", "/api/v1/agent/plugin-connections", map[string]any{}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "plugin_mcp")
	// 创建 = draft（安装与启用分离，P02）
	conn := w14Create(t)
	if conn.State != "draft" {
		t.Fatalf("创建应为 draft：%+v", conn)
	}
	//秘密值不入库：env_keys 只有键名；响应无任何 secret 值字段
	if len(conn.EnvKeys) != 1 || conn.EnvKeys[0] != "W14_TOKEN" {
		t.Fatalf("env_keys 应只存键名：%+v", conn.EnvKeys)
	}

	// HTTP 传输强制 https（P02 明文限制）
	env.expectErr(t, "POST", "/api/v1/agent/plugin-connections", map[string]any{
		"name": "明文", "transport": "http", "url": "http://127.0.0.1:9/v1",
	}, "validation_failed")

	// enable CAS：revision 不符 409；正确后 enabled
	env.expectErr(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision + 3,
	}, "plugin_revision_conflict")
	var enabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision,
		"protocol_version": "2025-06-18", "server_name": "w14-server", "server_version": "0.1.0",
		"catalog_revision": "abc123", "tools_catalog": []map[string]any{
			{"name": "search_docs", "description_hash": "aa", "input_schema": map[string]any{}},
		},
	}, &enabled)
	if enabled.State != "enabled" || enabled.ServerName != "w14-server" {
		t.Fatalf("enable 后状态/目录错误：%+v", enabled)
	}

	// disable → 再次 enable（状态机回路）
	var disabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "disable", "expected_revision": enabled.Revision,
	}, &disabled)
	if disabled.State != "disabled" {
		t.Fatalf("disable 后应 disabled：%+v", disabled)
	}
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": disabled.Revision,
	}, &enabled)

	// revoke 终态：revoked 后任何动作 404（不泄露）
	var revoked pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "revoke", "expected_revision": enabled.Revision,
	}, &revoked)
	if revoked.State != "revoked" {
		t.Fatalf("revoke 后应 revoked：%+v", revoked)
	}
	env.expectErr(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": revoked.Revision,
	}, "not_found")
}

func TestW14PluginCallLedgerAndGuards(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "plugin_mcp")
	conn := w14Create(t)

	// 未启用连接调用拒绝（P03 业务旁路防线）
	env.expectErr(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": uuid.NewString(), "tool_name": "search_docs", "args": map[string]any{},
	}, "plugin_not_enabled")

	// enable 后调用登记 + 回执
	var enabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision,
	}, &enabled)
	requestID := uuid.NewString()
	var call struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": requestID, "tool_name": "search_docs", "args": map[string]any{"q": "x"},
	}, &call)
	// 同 request_id 幂等返回原调用
	var replay struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": requestID, "tool_name": "search_docs", "args": map[string]any{"q": "x"},
	}, &replay)
	if replay.ID != call.ID {
		t.Fatalf("同编号调用应幂等：%+v vs %+v", call, replay)
	}
	// 回执 succeeded → 终态幂等；异结果 409
	var receipt map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls/"+call.ID+"/receipt", map[string]any{
		"state": "succeeded", "duration_ms": 42,
	}, &receipt)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls/"+call.ID+"/receipt", map[string]any{
		"state": "succeeded",
	}, &receipt)
	env.expectErr(t, "POST", "/api/v1/agent/plugin-calls/"+call.ID+"/receipt", map[string]any{
		"state": "failed",
	}, "plugin_receipt_conflict")

	// disable 后调用拒绝（停用即停止新派发，27 §11.2.4）
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "disable", "expected_revision": enabled.Revision,
	}, &enabled)
	env.expectErr(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": uuid.NewString(), "tool_name": "search_docs", "args": map[string]any{},
	}, "plugin_not_enabled")

	// viewer/代访问拒绝（个人功能，27 §14.1）
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w14-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("GET", "/api/v1/agent/plugin-connections", map[string]any{}); st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，got %d", st)
	}
	viewer.restore(env)

	// 跨用户不可见、改不动（404）
	other := env.registerClient(t, "w14-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.restore(env)
	var olist struct {
		Connections []pluginConnection `json:"connections"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/plugin-connections", map[string]any{}, &olist)
	if len(olist.Connections) != 0 {
		t.Fatalf("跨用户不得看到他人连接：%d", len(olist.Connections))
	}
	_ = context.Background()
}
