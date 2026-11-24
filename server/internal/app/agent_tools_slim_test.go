package app

import (
	"testing"

	"github.com/google/uuid"
)

// OPT-A02：默认只下发核心业务工具，且单次不超过 15 条；全量目录不受影响。
func TestOPTA02CoreToolsWithinBudget(t *testing.T) {
	st := &agentRunState{Domains: []string{"works", "writing", "materials"}}
	id := &identity{Role: "owner", UserID: uuid.New(), WorkspaceID: uuid.New()}
	tools := agentToolsFor(st, id)
	business, meta := 0, 0
	names := map[string]bool{}
	for _, tool := range tools {
		entry := agentTool(tool.Function.Name)
		if entry == nil {
			t.Fatalf("未知工具定义：%s", tool.Function.Name)
		}
		names[entry.Name] = true
		if entry.Domain == "" {
			meta++
		} else {
			business++
		}
	}
	if business > agentCoreToolBudget {
		t.Fatalf("业务工具超过预算：%d > %d", business, agentCoreToolBudget)
	}
	if meta > 11 {
		t.Fatalf("元工具未精简：%d", meta)
	}
	for _, want := range []string{"works__list", "outline__generate", "sections__draft", "materials__list"} {
		if !names[want] {
			t.Fatalf("核心工具缺失：%s（实际 %v）", want, names)
		}
	}
	for _, banned := range []string{"works__delete", "materials__merge", "browser_navigate", "computer_observe", "delegate_task"} {		if names[banned] {
			t.Fatalf("非核心或冻结工具不应默认下发：%s", banned)
		}
	}
}

// OPT-A02：冻结域既不进 schema，也不能按名执行；load_tool_domain 返回明确错误。
func TestOPTA02FrozenDomainRejected(t *testing.T) {
	st := &agentRunState{Domains: []string{"browser", "works", "subagent"}}
	id := &identity{Role: "owner", UserID: uuid.New(), WorkspaceID: uuid.New()}
	for _, tool := range agentToolsFor(st, id) {
		name := tool.Function.Name
		if len(name) >= 8 && (name[:8] == "browser_" || name[:9] == "computer_") {
			t.Fatalf("冻结能力进入工具定义：%s", name)
		}
	}
	if st.loadedTool(id, "browser_navigate") != nil {
		t.Fatal("冻结域的工具仍可按名执行")
	}
	if st.loadedTool(id, "delegate_task") != nil {
		t.Fatal("未开启子智能体时 delegate_task 仍可按名执行")
	}
	if len(agentCoreMetaToolNames) > 11 {
		t.Fatalf("元工具白名单超过 11 条：%d", len(agentCoreMetaToolNames))
	}
}

// OPT-A02：include_all 只展开指定领域，其他领域仍只给核心工具。
func TestOPTA02WideDomainExpandsOnlyThatDomain(t *testing.T) {
	st := &agentRunState{Domains: []string{"works", "materials"}, WideDomains: map[string]bool{"works": true}}
	id := &identity{Role: "owner", UserID: uuid.New(), WorkspaceID: uuid.New()}
	names := map[string]bool{}
	for _, tool := range agentToolsFor(st, id) {
		names[tool.Function.Name] = true
	}
	if !names["works__versions"] {
		t.Fatal("include_all 后 works 领域非核心工具应可见")
	}
	if names["materials__duplicates"] {
		t.Fatal("include_all 不应连带展开其他领域")
	}
	if names["browser_navigate"] {
		t.Fatal("冻结领域不应因其他领域 include_all 而出现")
	}
}

// OPT-A02：领域枚举随特性开关收窄，冻结域不出现在 load_tool_domain 的 enum 中。
func TestOPTA02LoadDomainEnumExcludesFrozen(t *testing.T) {
	names := agentLoadableDomainNames(&agentRunState{})
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	for _, frozen := range []string{"browser", "computer", "mcp", "subagent", "memory"} {
		if got[frozen] {
			t.Fatalf("冻结域仍出现在枚举：%s", frozen)
		}
	}
	for _, core := range []string{"works", "writing", "materials", "profile", "topics"} {
		if !got[core] {
			t.Fatalf("核心域缺失：%s", core)
		}
	}
}
