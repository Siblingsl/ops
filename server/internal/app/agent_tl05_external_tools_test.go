package app

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// TL-05（docs/38 §14）：能力中心外部工具只读投影。
// 覆盖：默认关闭不出现、启用连接+目录 schema 白名单、来源/权限/最近调用、未启用连接消失、
// 不泄露命令/地址/环境变量/入参/结果。
func TestTL05ExternalToolsCapabilityProjection(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,plugin_mcp")

	conn := w14Create(t)
	var enabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision,
		"protocol_version": "2025-06-18", "server_name": "tl05-server", "server_version": "1.2.3",
		"catalog_revision": "tl05-rev-1", "tools_catalog": []map[string]any{
			{"name": "search_docs", "description_hash": "aa", "input_schema": map[string]any{
				"type": "object", "properties": map[string]any{"query": map[string]any{"type": "string"}},
				"required": []string{"query"},
			}},
			{"name": "list_docs", "description_hash": "bb", "input_schema": map[string]any{
				"type": "object", "properties": map[string]any{"limit": map[string]any{"type": "number"}},
			}},
			// 动态目录会因 anyOf 超出基础子集跳过；能力中心也不能把它列为白名单工具。
			{"name": "unsupported_docs", "description_hash": "cc", "input_schema": map[string]any{
				"type": "object", "properties": map[string]any{"query": map[string]any{"anyOf": []any{}}},
			}},
		},
	}, &enabled)
	if enabled.State != "enabled" {
		t.Fatalf("连接应已启用：%+v", enabled)
	}

	var caps map[string]any
	env.mustJSON(t, "GET", "/api/v1/agent/capabilities", nil, &caps)
	external, _ := caps["external_tools"].(map[string]any)
	if external == nil || external["enabled"] != true {
		t.Fatalf("plugin_mcp 开启时 external_tools.enabled 应为 true：%v", caps)
	}
	tools, _ := external["tools"].([]any)
	var search, list map[string]any
	for _, raw := range tools {
		tool := raw.(map[string]any)
		if tool["connection_id"] != conn.ID {
			continue
		}
		switch tool["tool_name"] {
		case "search_docs":
			search = tool
		case "list_docs":
			list = tool
		case "unsupported_docs":
			t.Fatalf("超出基础 schema 子集的工具不得进入白名单：%v", tool)
		}
	}
	if search == nil || list == nil {
		t.Fatalf("缺少本连接的白名单工具：%v", tools)
	}
	if search["connection_name"] != "W14 文档检索" || search["transport"] != "stdio" ||
		search["server_name"] != "tl05-server" || search["server_version"] != "1.2.3" ||
		search["catalog_revision"] != "tl05-rev-1" {
		t.Fatalf("外部工具来源字段错误：%v", search)
	}
	if search["min_role"] != "editor" || search["kind"] != "G" || search["available"] != true {
		t.Fatalf("外部工具权限/类型/可用性错误：%v", search)
	}
	if permission, _ := search["permission"].(string); !strings.Contains(permission, "编辑及以上") || !strings.Contains(permission, "逐卡确认") {
		t.Fatalf("权限说明缺失：%v", search)
	}
	if _, ok := search["last_call"]; ok {
		t.Fatalf("尚无调用时不应有 last_call：%v", search)
	}

	requestID := uuid.NewString()
	var call struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": requestID, "tool_name": "search_docs",
		"args": map[string]any{"query": "TL05 审计查询"},
	}, &call)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls/"+call.ID+"/receipt", map[string]any{
		"state": "succeeded", "duration_ms": 42, "result": map[string]any{"title": "TL05 内部结果不应展示"},
	}, nil)

	env.mustJSON(t, "GET", "/api/v1/agent/capabilities", nil, &caps)
	external, _ = caps["external_tools"].(map[string]any)
	tools, _ = external["tools"].([]any)
	var recent map[string]any
	for _, raw := range tools {
		tool := raw.(map[string]any)
		if tool["connection_id"] == conn.ID && tool["tool_name"] == "search_docs" {
			recent, _ = tool["last_call"].(map[string]any)
		}
	}
	if recent == nil || recent["state"] != "succeeded" || recent["duration_ms"] != float64(42) || recent["at"] == "" {
		t.Fatalf("最近调用投影错误：%v", recent)
	}
	// 数据门：外部工具区只能有来源/权限/状态；命令、工作目录、环境变量键、入参和结果正文都不能出现。
	raw, _ := json.Marshal(caps)
	for _, leaked := range []string{"server.js", "W14_TOKEN", "F:\\\\code\\\\project\\\\OPS", "TL05 审计查询", "TL05 内部结果不应展示"} {
		if strings.Contains(string(raw), leaked) {
			t.Fatalf("能力中心泄露敏感字段 %q：%s", leaked, raw)
		}
	}

	// 权限门/行为门：停用连接后外部工具必须立即从能力中心消失。
	var disabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "disable", "expected_revision": enabled.Revision,
	}, &disabled)
	env.mustJSON(t, "GET", "/api/v1/agent/capabilities", nil, &caps)
	external, _ = caps["external_tools"].(map[string]any)
	tools, _ = external["tools"].([]any)
	for _, raw := range tools {
		if tool := raw.(map[string]any); tool["connection_id"] == conn.ID {
			t.Fatalf("停用连接后不应再展示本连接外部工具：%v", tool)
		}
	}
}

func TestTL05ExternalToolsDefaultOff(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui")
	var caps map[string]any
	env.mustJSON(t, "GET", "/api/v1/agent/capabilities", nil, &caps)
	external, _ := caps["external_tools"].(map[string]any)
	if external == nil || external["enabled"] != false {
		t.Fatalf("plugin_mcp 关闭时 external_tools.enabled 必须为 false：%v", caps)
	}
	tools, _ := external["tools"].([]any)
	if len(tools) != 0 {
		t.Fatalf("plugin_mcp 关闭时不得出现外部工具：%v", tools)
	}
}
