package app

import (
	"testing"
)

// DEV-AI27-06（W06）：AI27 工具目录注册与开关联动可见性测试。
// 覆盖：开关关闭时工具不进目录；开关开启后可见；工具域归属正确。

func TestW06AIT27ToolCatalogRegistration(t *testing.T) {
	catalog := agentCatalog()
	toolByName := map[string]bool{}
	for _, tool := range catalog {
		toolByName[tool.Name] = true
	}

	// 浏览器工具 8 个（27 §8.1；A30 增补请求选标签）
	for _, name := range []string{
		"browser_get_context", "browser_observe", "browser_navigate",
		"browser_click", "browser_type", "browser_extract", "browser_screenshot",
		"browser_request_tab",
	} {
		if !toolByName[name] {
			t.Errorf("浏览器工具 %s 不在目录中", name)
		}
	}
	// 委派元工具 2 个（27 §11.3.3）
	for _, name := range []string{"delegate_task", "stop_delegation"} {
		if !toolByName[name] {
			t.Errorf("委派工具 %s 不在目录中", name)
		}
	}
	// 电脑控制工具 3 个（27 §11.5.3；A12 增补请求选窗）
	for _, name := range []string{"computer_observe", "computer_request_handoff", "computer_request_target"} {
		if !toolByName[name] {
			t.Errorf("电脑控制工具 %s 不在目录中", name)
		}
	}
	// 电脑控制固定动作工具 6 个（DEV-CU P4-3，docs/36 §P4-3 步骤 4/6）
	for _, name := range []string{
		"computer_view_target", "computer_focus_target", "computer_scroll_target",
		"computer_select_target", "computer_click_target", "computer_type_target",
	} {
		if !toolByName[name] {
			t.Errorf("电脑控制动作工具 %s 不在目录中", name)
		}
	}
	// MCP 连接查询 1 个（27 §11.2）
	if !toolByName["mcp__list_connections"] {
		t.Error("MCP 工具 mcp__list_connections 不在目录中")
	}
}

func TestW06AIT27ToolDomainClassification(t *testing.T) {
	catalog := agentCatalog()
	domainChecks := map[string]string{
		"browser_get_context":  "browser",
		"browser_observe":      "browser",
		"browser_navigate":     "browser",
		"browser_request_tab":  "browser",
		"delegate_task":        "subagent",
		"stop_delegation":      "subagent",
		"computer_observe":     "computer",
		"computer_request_target": "computer",
		"mcp__list_connections": "mcp",
	}
	for _, tool := range catalog {
		if expected, ok := domainChecks[tool.Name]; ok {
			if tool.Domain != expected {
				t.Errorf("工具 %s domain=%s, want %s", tool.Name, tool.Domain, expected)
			}
		}
	}
}

func TestW06AIT27ToolKindClassification(t *testing.T) {
	catalog := agentCatalog()
	// 浏览器观察类=toolR；委派提案类=toolG；电脑控制观察=toolR
	kindChecks := map[string]ToolKind{
		"browser_get_context":  toolR,
		"browser_observe":      toolR,
		"browser_navigate":     toolR,
		"browser_click":        toolR,
		"browser_type":         toolR,
		"browser_extract":      toolR,
		"browser_screenshot":   toolR,
		"browser_request_tab":  toolR,
		"delegate_task":        toolG,
		"stop_delegation":      toolR,
		"computer_observe":     toolR,
		"computer_request_handoff": toolR,
		"computer_request_target": toolR,
		"mcp__list_connections": toolR,
	}
	for _, tool := range catalog {
		if expected, ok := kindChecks[tool.Name]; ok {
			if tool.Kind != expected {
				t.Errorf("工具 %s kind=%v, want %v", tool.Name, tool.Kind, expected)
			}
		}
	}
}

func TestW06AIT27BrowserToolsInDiscussMode(t *testing.T) {
	// 27 §8.6：浏览器研究交互（B 类）在讨论/计划/goal 模式可用（有 grant 才行）。
	// 本测试验证工具目录级别的模式过滤——具体授权/租约验证在 W04/W06 第二批。
	catalog := agentCatalog()
	for _, tool := range catalog {
		if tool.Domain != "browser" {
			continue
		}
		// 浏览器观察类工具是 toolR，讨论/计划模式应该可见（模式过滤在 agentRunToolAllowed 中处理）
		if tool.Kind != toolR {
			t.Errorf("浏览器工具 %s kind=%v, want toolR（讨论/计划可用的研究交互）", tool.Name, tool.Kind)
		}
	}
}

// T-AI27-21A（27 §8.6）：goal 来源的浏览器 R 类工具可见性。
// 讨论/计划模式浏览器 toolR 可用（27 §8.6 表格行讨论/计划）；goal 同样可用（C03）；
// routine 不允许（表格行"routine 浏览工具一律不进入"——agentRoutineToolAllowed 白名单未含即拒绝）。
func TestW06GoalOriginBrowserToolsAllowed(t *testing.T) {
	catalog := agentCatalog()
	browserRTools := 0
	for _, tool := range catalog {
		if tool.Domain == "browser" && tool.Kind == toolR {
			browserRTools++
		}
	}
	if browserRTools == 0 {
		t.Fatal("浏览器 R 类工具未在目录中")
	}
	// routine 来源由 agentRoutineToolAllowed 白名单控制——浏览器工具不在白名单即自动拒绝（结构断言）。
	if agentRoutineReadTools["browser_observe"] {
		t.Fatal("例行任务白名单不应含浏览器工具（27 §8.6 routine 行）")
	}
}

// A12（决策 A）：请求选窗是打断式意图——用户要切到本机挑窗口，讨论/计划不该触发。
func TestA12ComputerRequestTargetOnlyInExecute(t *testing.T) {
	tool := agentTool("computer_request_target")
	if tool == nil {
		t.Fatal("computer_request_target 不在目录中")
	}
	id := &identity{Role: string(roleEditor)}
	for _, mode := range []string{"discuss", "plan"} {
		st := &agentRunState{Mode: mode, ExecutionOrigin: "interactive"}
		if agentRunToolAllowed(st, tool, id) {
			t.Fatalf("%s 模式不应触发请求选窗", mode)
		}
	}
	if !agentRunToolAllowed(&agentRunState{Mode: "execute", ExecutionOrigin: "interactive"}, tool, id) {
		t.Fatal("执行模式应可用请求选窗")
	}
	// 回归：排除只针对请求选窗，讨论模式的浏览器研究不受影响。
	if !agentRunToolAllowed(&agentRunState{Mode: "discuss", ExecutionOrigin: "interactive"}, agentTool("browser_observe"), id) {
		t.Fatal("讨论模式浏览器研究不应被误伤")
	}
}

// A30：请求选标签是打断式意图——用户要切到浏览器挑标签页，讨论/计划不该触发。
func TestA30BrowserRequestTabOnlyInExecute(t *testing.T) {
	tool := agentTool("browser_request_tab")
	if tool == nil {
		t.Fatal("browser_request_tab 不在目录中")
	}
	id := &identity{Role: string(roleEditor)}
	for _, mode := range []string{"discuss", "plan"} {
		st := &agentRunState{Mode: mode, ExecutionOrigin: "interactive"}
		if agentRunToolAllowed(st, tool, id) {
			t.Fatalf("%s 模式不应触发请求选标签", mode)
		}
	}
	if !agentRunToolAllowed(&agentRunState{Mode: "execute", ExecutionOrigin: "interactive"}, tool, id) {
		t.Fatal("执行模式应可用请求选标签")
	}
	// 回归：排除只针对请求选标签，讨论模式的浏览器研究不受影响。
	if !agentRunToolAllowed(&agentRunState{Mode: "discuss", ExecutionOrigin: "interactive"}, agentTool("browser_observe"), id) {
		t.Fatal("讨论模式浏览器研究不应被误伤")
	}
}
