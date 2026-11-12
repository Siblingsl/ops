package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// DEV-CU P4-2：视图字段与 §4.10 表列一一对应、常量取值、inputHash 与 browser 同构。
func TestComputerCommandColumnsAndConstants(t *testing.T) {
	// computerCommandColumns 的列数必须与 scanComputerCommand 的 Scan 目标数一致：
	// 19 列（id/grant/run/request/card/approval/action/target/input/state/payload/
	// result/disposition/requires_confirmation/generation/deadline/dispatched/error/created）。
	cols := 0
	for _, c := range []string{
		"c.id::text", "c.grant_id::text", "c.request_id::text", "c.action_kind", "c.input_hash",
		"c.state", "c.requires_confirmation", "c.generation", "c.error_code",
		"c.created_at AT TIME ZONE", "c.deadline_at AT TIME ZONE", "c.dispatched_at AT TIME ZONE",
		"c.card_id::text", "c.approval_hash", "c.target_ref", "c.payload::text",
		"c.result::text", "c.disposition::text", "c.run_id::text",
	} {
		if !strings.Contains(computerCommandColumns, c) {
			t.Fatalf("computerCommandColumns 缺列 %s", c)
		}
		cols++
	}
	if cols != 19 {
		t.Fatalf("列清单应覆盖 19 项，实际 %d", cols)
	}

	// 常量取 §4.10 总表
	if computerCommandDeadline != 30*time.Second {
		t.Fatalf("computerCommandDeadline = %v，应为 30s", computerCommandDeadline)
	}
	if computerCommandSweepGrace != 2*time.Second {
		t.Fatalf("computerCommandSweepGrace = %v，应为 2s", computerCommandSweepGrace)
	}
	if computerCommandWaitBudget != 35*time.Second {
		t.Fatalf("computerCommandWaitBudget = %v，应为 35s", computerCommandWaitBudget)
	}
	if computerCommandWaitPoll != 200*time.Millisecond {
		t.Fatalf("computerCommandWaitPoll = %v，应为 200ms", computerCommandWaitPoll)
	}

	// 动作枚举：§4.10 六语义；request_handoff 不进账本
	for _, action := range []string{"observe", "focus", "scroll", "select", "invoke", "type"} {
		if !computerCommandActions[action] {
			t.Fatalf("computerCommandActions 缺 %s", action)
		}
	}
	if computerCommandActions["request_handoff"] {
		t.Fatal("request_handoff 不建命令（走租约撤销）")
	}
	if computerCommandActions["bogus"] {
		t.Fatal("未知动作不得在枚举内")
	}
}

func TestComputerInputHash(t *testing.T) {
	// 同载荷同 hash；异载荷异 hash；键序无关（canonicalJSON 归一在调用方完成，
	// 这里锁「同字节同 hash、异字节异 hash」的确定性）
	payloadA, _ := json.Marshal(map[string]any{"value": "x"})
	h1 := computerInputHash("invoke", payloadA)
	h2 := computerInputHash("invoke", payloadA)
	if h1 != h2 {
		t.Fatal("同载荷 hash 必须一致")
	}
	if len(h1) != 64 {
		t.Fatalf("hash 应为 sha256 hex 64 字符，实际 %d", len(h1))
	}
	payloadB, _ := json.Marshal(map[string]any{"value": "y"})
	if computerInputHash("invoke", payloadB) == h1 {
		t.Fatal("异载荷 hash 必须不同")
	}
	// 动作名参与 hash（browser 同构：action + "." + payload）
	if computerInputHash("type", payloadA) == h1 {
		t.Fatal("动作名必须参与 hash")
	}
}

func TestComputerCommandViewJSON(t *testing.T) {
	// omitempty：card_id/approval_hash/payload/result/disposition 空时不出现在 JSON
	v := computerCommandView{
		ID: "cmd-1", GrantID: "g-1", RequestID: "r-1", ActionKind: "observe",
		InputHash: "h", State: "queued", RequiresConfirmation: false, Generation: 0,
		CreatedAt: "2026-11-13T00:00:00Z",
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"card_id", "approval_hash", "payload", "result", "disposition", "target_ref", "run_id"} {
		if strings.Contains(string(b), `"`+leak+`"`) {
			t.Fatalf("空字段 %s 不得出现在 JSON：%s", leak, b)
		}
	}
	// requires_confirmation / generation 恒出现（无 omitempty，false/0 也是语义）
	if !strings.Contains(string(b), `"requires_confirmation":false`) || !strings.Contains(string(b), `"generation":0`) {
		t.Fatalf("requires_confirmation 与 generation 必须恒出现：%s", b)
	}
}
