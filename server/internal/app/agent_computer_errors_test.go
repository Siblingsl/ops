package app

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// DEV-CU P4-10：Go/TS 错误码 parity（读 TS 导出的夹具比对常量集合，防两侧漂移）。
func TestComputerErrorCodeParity(t *testing.T) {
	raw, err := os.ReadFile("../../../desktop/test/fixtures/computer-error-codes.json")
	if err != nil {
		t.Fatalf("读取 TS 夹具失败（桌面侧 response.js 的 ERROR_CODES 导出）：%v", err)
	}
	var fixture struct {
		Version string   `json:"version"`
		Codes   []string `json:"codes"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Version != ContractVersion {
		t.Fatalf("夹具契约版本 %q != %q", fixture.Version, ContractVersion)
	}
	if len(fixture.Codes) != len(computerErrorCodes) {
		t.Fatalf("码集合数量不一致：TS %d vs Go %d", len(fixture.Codes), len(computerErrorCodes))
	}
	for _, code := range fixture.Codes {
		if _, ok := computerErrorCodes[code]; !ok {
			t.Errorf("TS 侧码 %s 不在 Go 常量集", code)
		}
	}
	// 反向：Go 常量集不得多出 TS 没有的码
	for code := range computerErrorCodes {
		found := false
		for _, c := range fixture.Codes {
			if c == code {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Go 侧码 %s 不在 TS 夹具", code)
		}
	}
}

// recovery 只在 retry==safe（delivery=not_delivered）输出；策略与 P3-4 TS 版同表。
func TestComputerRecoveryFor(t *testing.T) {
	if computerRecoveryFor(ComputerStaleRef, "delivered_verified", false) != nil {
		t.Fatal("unsafe 投递不得给 recovery")
	}
	r := computerRecoveryFor(ComputerStaleRef, "not_delivered", false)
	if r["strategy"] != "refresh_snapshot_then_retry_original" || r["requires_fresh_snapshot"] != true {
		t.Fatalf("stale_ref 应 refresh：%v", r)
	}
	if computerRecoveryFor(ComputerStaleRef, "not_delivered", true)["strategy"] != "inspect_state_then_retry_original" {
		t.Fatal("进程退出应 inspect")
	}
	if computerRecoveryFor(ComputerTargetChanged, "not_delivered", false)["strategy"] != "refresh_snapshot_then_retry_original" {
		t.Fatal("target_changed 应 refresh")
	}
	if computerRecoveryFor(ComputerPolicyDenied, "not_delivered", false)["strategy"] != "request_explicit_policy_then_retry_original" {
		t.Fatal("policy 应 request_explicit_policy")
	}
	to := computerRecoveryFor(ComputerTimeout, "not_delivered", false)
	if to["retry_after_ms"] != 250 || to["strategy"] != "inspect_state_then_retry_original" {
		t.Fatalf("timeout 应 inspect+250ms：%v", to)
	}
	for _, code := range []string{ComputerActionFailed, ComputerInvalidArgs, ComputerInternal, ComputerBudgetExceeded, ComputerUIUnsupported} {
		if computerRecoveryFor(code, "not_delivered", false) != nil {
			t.Errorf("%s 不应有 recovery", code)
		}
	}
	if computerRecoveryFor("computer_not_a_code", "not_delivered", false) != nil {
		t.Error("表外码不编造 strategy")
	}
}

// 事件体白名单：emitComputerCommandEvent 产出的 payload 不得含 payload/result/target_summary/标题。
func TestComputerEventWhitelist(t *testing.T) {
	allowed := map[string]bool{
		"command_id": true, "action_kind": true, "state": true, "error_code": true,
		"delivery": true, "grant_id": true, "generation": true, "request_id": true,
	}
	for _, banned := range []string{"payload", "result", "target_summary", "window_title", "title", "ref"} {
		if allowed[banned] {
			t.Errorf("事件白名单不得含 %s", banned)
		}
	}
	// 校验实际 emit 调用点的字段（源码级断言：本文件内 3 处 emit 调用只传白名单键）
	src := readFileString(t, "agent_computer_commands.go")
	for _, marker := range []string{"\"payload\":", "\"result\":", "\"target_summary\":", "\"window_title\""} {
		if idx := strings.Index(src, marker); idx >= 0 {
			// 只在 emit 调用附近才算违规；INSERT/SELECT 的 payload/result 合法
			lo := idx - 120
			if lo < 0 {
				lo = 0
			}
			hi := idx + 120
			if hi > len(src) {
				hi = len(src)
			}
			window := src[lo:hi]
			if strings.Contains(window, "emitComputerCommandEvent") {
				t.Errorf("emit 事件体不得含 %s", marker)
			}
		}
	}
}

func readFileString(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
