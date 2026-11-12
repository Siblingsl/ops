package app

// DEV-CU P4-10（docs/36 §4.2 / §4.13 / §P4-10）：Go 侧错误码常量与事件白名单。
// 16 码逐字照抄 §4.2；TS 侧唯一来源是 desktop/src/computer-worker/response.js 的
// ERROR_CODES，两侧由 TestComputerErrorCodeParity 读夹具比对（防漂移）。
// 既有内联字符串（computer_foreground_busy / computer_policy_denied /
// computer_hard_forbidden / computer_stale_ref 等）不改字面，常量值与之相同。

// 上游 ErrorCode 注释见 docs/36 §4.2 表；HTTP 状态码为对应 REST 语义。
const (
	ComputerStaleRef           = "computer_stale_ref"            // STALE_REF, 409
	ComputerAmbiguousTarget    = "computer_ambiguous_target"     // AMBIGUOUS_TARGET, 409
	ComputerTargetChanged      = "computer_target_changed"       // —, 409
	ComputerApprovalConflict   = "computer_approval_conflict"    // —, 409
	ComputerForegroundBusy     = "computer_foreground_busy"      // —, 409（已有，不改）
	ComputerActionNotSupported = "computer_action_not_supported" // ACTION_NOT_SUPPORTED, 422
	ComputerUIUnsupported      = "computer_ui_unsupported"       // —, 422
	ComputerActionFailed       = "computer_action_failed"        // ACTION_FAILED, 422
	ComputerAppUnresponsive    = "computer_app_unresponsive"     // APP_UNRESPONSIVE, 503
	ComputerTimeout            = "computer_timeout"              // TIMEOUT, 504
	ComputerPolicyDenied       = "computer_policy_denied"        // POLICY_DENIED, 403（已有，不改）
	ComputerScopeDenied        = "computer_scope_denied"         // PERM_DENIED, 403
	ComputerDeviceOffline      = "computer_device_offline"       // —, 503
	ComputerBudgetExceeded     = "computer_budget_exceeded"      // —, 429
	ComputerInvalidArgs        = "computer_invalid_args"         // INVALID_ARGS, 422
	ComputerInternal           = "computer_internal"             // INTERNAL, 500
)

// computerErrorCodes 是 §4.2 的 16 码集合（常量聚合，供 parity 测试与 recovery 使用）。
var computerErrorCodes = map[string]struct{}{
	ComputerStaleRef: {}, ComputerAmbiguousTarget: {}, ComputerTargetChanged: {},
	ComputerApprovalConflict: {}, ComputerForegroundBusy: {}, ComputerActionNotSupported: {},
	ComputerUIUnsupported: {}, ComputerActionFailed: {}, ComputerAppUnresponsive: {},
	ComputerTimeout: {}, ComputerPolicyDenied: {}, ComputerScopeDenied: {},
	ComputerDeviceOffline: {}, ComputerBudgetExceeded: {}, ComputerInvalidArgs: {},
	ComputerInternal: {},
}

// computerRecoveryFor：仅 retry=="safe" 时输出 recovery（与 P3-4 TS 版 recoveryFor
// 同表：stale_ref→refresh/进程退出→inspect、ambiguous/target_changed→refresh、
// policy/scope→request_explicit_policy、unresponsive/timeout→inspect+250ms；
// 表外码不编造）。
func computerRecoveryFor(code, delivery string, processExited bool) map[string]any {
	if delivery != "not_delivered" {
		return nil // retry == safe 的唯一 delivery 是 not_delivered（§4.3 表）
	}
	strategy := ""
	requiresFresh := false
	retryAfter := 0
	switch code {
	case ComputerStaleRef:
		if processExited {
			strategy = "inspect_state_then_retry_original"
		} else {
			strategy = "refresh_snapshot_then_retry_original"
		}
		requiresFresh = true
	case ComputerAmbiguousTarget, ComputerTargetChanged:
		strategy = "refresh_snapshot_then_retry_original"
		requiresFresh = true
	case ComputerPolicyDenied, ComputerScopeDenied:
		strategy = "request_explicit_policy_then_retry_original"
	case ComputerAppUnresponsive, ComputerTimeout:
		strategy = "inspect_state_then_retry_original"
		requiresFresh = true
		retryAfter = 250
	default:
		return nil
	}
	out := map[string]any{
		"strategy":                strategy,
		"retryable":               true,
		"requires_fresh_snapshot": requiresFresh,
	}
	if retryAfter > 0 {
		out["retry_after_ms"] = retryAfter
	}
	return out
}

// computerEventAllowedFields 是 §4.13 的事件体白名单：
// command_id/action_kind/state/error_code/disposition.delivery/grant_id/generation + 脱敏摘要。
// 禁止 payload / result / target_summary / 窗口标题进事件体。
var computerEventAllowedFields = map[string]bool{
	"command_id": true, "action_kind": true, "state": true, "error_code": true,
	"delivery": true, "grant_id": true, "generation": true, "request_id": true,
}
