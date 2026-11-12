package app

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-CU P4-3（docs/36 §P4-3 步骤 1~3）：动作枚举与 payload 白名单键校验。
func TestComputerActionValidation(t *testing.T) {
	// 六语义全部合法（observe 无 ref 也放行——观察整窗）
	for _, kind := range []string{"observe", "focus", "scroll", "select", "invoke", "type"} {
		if err := validateComputerAction(kind, map[string]any{}); err != nil {
			t.Fatalf("%s 应合法：%v", kind, err)
		}
	}
	// 枚举外 → computer_invalid_args
	for _, bad := range []string{"click", "set_value", "type_text", "request_handoff", "", "execute_all", "OBSERVE"} {
		if err := validateComputerAction(bad, map[string]any{}); err == nil || apiErrorCode(err) != "computer_invalid_args" {
			t.Fatalf("%q 应被拒为 computer_invalid_args，得到 %v", bad, err)
		}
	}
	// 多余键 → 422（键存在即拒绝，不看值；规格只定义白名单键，不定义空值语义）
	if err := validateComputerAction("invoke", map[string]any{"ref": "@sabc123:e1", "script": "Get-Process"}); err == nil {
		t.Fatal("invoke 带 script 键应被拒")
	}
	if err := validateComputerAction("type", map[string]any{"ref": "@sabc123:e1", "text": "x", "value": "y"}); err == nil {
		t.Fatal("type 带 value 键应被拒（value 不是白名单键）")
	}
	// 白名单键的空值放行（"" ref / "" text 是「未指定」，由 handler 层决定语义）
	if err := validateComputerAction("type", map[string]any{"text": ""}); err != nil {
		t.Fatalf("白名单键的空值应放行：%v", err)
	}
	// ref 形状：合法 / 裸 @e1 / 缺 :e / 越界序号 / 非法字符
	for _, ok := range []string{"@sabc123:e1", "@sX9_-:e9999999999", "@s000107:e1"} {
		if err := validateComputerAction("invoke", map[string]any{"ref": ok}); err != nil {
			t.Fatalf("ref %s 应合法：%v", ok, err)
		}
	}
	for _, bad := range []string{"e1", "@se1", "@sabc:e", "@sabc:e0", "@sabc:e1x", "@ab:e1", "@s$:e1", "@sabc:e12345678901"} {
		if err := validateComputerAction("invoke", map[string]any{"ref": bad}); err == nil || apiErrorCode(err) != "computer_invalid_args" {
			t.Fatalf("ref %q 应被拒：%v", bad, err)
		}
	}
	// text 长度与控制符
	long := make([]byte, 32769)
	for i := range long {
		long[i] = 'a'
	}
	if err := validateComputerAction("type", map[string]any{"text": string(long)}); err == nil {
		t.Fatal("text 超 32768 应被拒")
	}
	if err := validateComputerAction("type", map[string]any{"text": "ok\nline"}); err != nil {
		t.Fatalf("换行应允许：%v", err)
	}
	for _, bad := range []string{"a\x00b", "a\x01b", "a\x1bb", "a\x7fb"} {
		if err := validateComputerAction("type", map[string]any{"text": bad}); err == nil {
			t.Fatalf("text %q 含控制字符应被拒", bad)
		}
	}
	// 不做脚本检测：含 Get-Process 等字样仍按普通文本放行（payload 永不拼进 PS）
	if err := validateComputerAction("type", map[string]any{"text": "Get-Process; rm -rf"}); err != nil {
		t.Fatalf("脚本特征字样不应由本层拦截：%v", err)
	}
}

// P4-3 步骤 4 的目录约束：6 个固定条目 Path 统一、动作 Fixed 注入、模型不能自填。
func TestComputerActionToolCatalogFixed(t *testing.T) {
	fixed := map[string]string{
		"computer_view_target": "observe", "computer_focus_target": "focus",
		"computer_scroll_target": "scroll", "computer_select_target": "select",
		"computer_click_target": "invoke", "computer_type_target": "type",
	}
	for _, tool := range agentCatalog() {
		action, ok := fixed[tool.Name]
		if !ok {
			continue
		}
		if tool.Path != "/tools/computer/commands" || tool.Method != "POST" {
			t.Errorf("%s 的通道应是 POST /tools/computer/commands，实际 %s %s", tool.Name, tool.Method, tool.Path)
		}
		if tool.Domain != "computer" {
			t.Errorf("%s 域应是 computer", tool.Name)
		}
		if got, _ := tool.Fixed["action"].(string); got != action {
			t.Errorf("%s 的 Fixed.action 应是 %s，实际 %v", tool.Name, action, tool.Fixed["action"])
		}
		// 模型不能自填动作：Params 里不得有 action_kind / action
		for _, p := range tool.Params {
			if p.Name == "action_kind" || p.Name == "action" {
				t.Errorf("%s 的参数不得含动作字段（Fixed 注入）", tool.Name)
			}
		}
	}
	// write 类（click/type）必须是 W（走 D-117 卡片）；read 类必须是 R
	for _, tool := range agentCatalog() {
		switch tool.Name {
		case "computer_click_target", "computer_type_target":
			if tool.Kind != toolW {
				t.Errorf("%s 应是写类工具（卡片确认）", tool.Name)
			}
		case "computer_view_target", "computer_focus_target", "computer_scroll_target", "computer_select_target":
			if tool.Kind != toolR {
				t.Errorf("%s 应是读类工具", tool.Name)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// DEV-CU P4-9：工具目录接线（模型侧）——白名单键 / 服务端自管字段不可见 / viewer 只读。
// ---------------------------------------------------------------------------

// ① InputSchema 只含白名单键；定义不含 run_id/grant_id/target_handle（服务端自管）。
func TestComputerToolInputSchemaWhitelist(t *testing.T) {
	allowed := map[string][]string{
		"computer_view_target":   {"ref"},
		"computer_focus_target":  {"ref"},
		"computer_scroll_target": {"ref"},
		"computer_select_target": {"ref"},
		"computer_click_target":  {"ref"},
		"computer_type_target":   {"ref", "text"},
	}
	serverManaged := []string{"run_id", "grant_id", "target_handle", "request_id", "card_id", "approval_hash", "action_kind", "action"}
	for _, tool := range agentCatalog() {
		params, ok := allowed[tool.Name]
		if !ok {
			continue
		}
		seen := map[string]bool{}
		for _, p := range tool.Params {
			seen[p.Name] = true
			for _, bad := range serverManaged {
				if p.Name == bad {
					t.Errorf("工具 %s 的参数含服务端自管字段 %s（模型不可传）", tool.Name, bad)
				}
			}
		}
		for _, want := range params {
			if !seen[want] {
				t.Errorf("工具 %s 缺白名单参数 %s", tool.Name, want)
			}
		}
		if len(seen) != len(params) {
			t.Errorf("工具 %s 参数集应恰为白名单：%v", tool.Name, seen)
		}
		// Description 必须含重试纪律（全部）；写类另含逐张确认文案
		desc := tool.Description
		if !strings.Contains(desc, "不要自动重试") {
			t.Errorf("工具 %s 的 Description 缺「失败后不要自动重试」", tool.Name)
		}
		if tool.Kind == toolW && !strings.Contains(desc, "逐张确认") {
			t.Errorf("写类工具 %s 的 Description 缺「用户逐张确认后执行」", tool.Name)
		}
	}
}

// ② viewer 角色下 computer 写类工具不可见（HC31 扩充）。
func TestHC31ComputerViewerToolDefinitionsAreReadOnly(t *testing.T) {
	domains := []string{"computer"}
	viewer := &identity{Role: "viewer", UserID: uuid.New(), WorkspaceID: uuid.New()}
	tools := agentToolsFor(&agentRunState{Domains: domains}, viewer)
	for _, definition := range tools {
		tool := agentTool(definition.Function.Name)
		if tool == nil {
			t.Fatalf("未知工具定义：%s", definition.Function.Name)
		}
		if strings.HasPrefix(tool.Name, "computer_") {
			if tool.Kind != toolR || (tool.Method != "" && tool.Method != "GET") {
				t.Errorf("viewer 不应看到 computer 写类/POST 工具：%s (%s %s)", tool.Name, tool.Kind, tool.Method)
			}
		}
	}
}
