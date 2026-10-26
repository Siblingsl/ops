package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestPlatformV2StopReasonOutsideEnumStillSettles v2 终批带安全原因词时也必须落库。
//
// 缺陷背景（2026-10-26 实测）：v2 客户端终批上报的 `stop_reason` 取自
// `platformSafeReasons`（network_unavailable、access_denied、
// profile_capability_unverified、page_budget…），这些词**一个都不在**
// `platform_sync_run_stop_reason_check` 允许的七个值里。`finishPlatformV2RunTx`
// 原样写库，于是抛 23514，整个终批事务回滚：批次回执、覆盖范围、观测全丢，
// run 卡在 running 直到 60 秒租约过期，再由 `expirePlatformRuns` 判成 expired。
//
// 现场吻合：操作 0ef0f5fc 的两条 run（4c2efc25、900c33da）都是 expired、
// counters={}、stop_reason 与 error_code 全空、budget_result_rows=0。
//
// 期望行为与 v1 一致：认识的枚举照原样存；不认识的不阻断入库，`stop_reason`
// 存 NULL，原始值留在 `counters.stop_reason_raw` 里供排查。
func TestPlatformV2StopReasonOutsideEnumStillSettles(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-v2-stop")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}

	createPath := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", createPath,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("create account sync: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "account_sync", "fixture-1")

	// profile 阶段上报 partial：客户端实际发的是 profile_capability_unverified。
	body := platformV2ControlBatch(run, 0, "unknown", nil, "partial")
	body["stop_reason"] = "profile_capability_unverified"
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/desktop/platform/runs/" + run.ID.String() + "/results"
	status, response = f.signedPlatform(t, "platform.run.result", http.MethodPost, path, raw)
	if status != http.StatusOK {
		t.Fatalf("v2 终批应被接受，实际 %d %s", status, response)
	}

	// run 必须走到终态，不能卡在 running 等租约过期。
	var runStatus string
	var stopReason, rawReason *string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, stop_reason, counters->>'stop_reason_raw' FROM platform_sync_run WHERE id=$1`, run.ID).
		Scan(&runStatus, &stopReason, &rawReason); err != nil {
		t.Fatal(err)
	}
	if runStatus != platformRunStatusPartial {
		t.Fatalf("run 应为 %s，实际 %s", platformRunStatusPartial, runStatus)
	}
	if stopReason != nil {
		t.Fatalf("未登记的停止原因不应写进 stop_reason，实际 %q", *stopReason)
	}
	if rawReason == nil || *rawReason != "profile_capability_unverified" {
		t.Fatalf("原始停止原因应留在 counters.stop_reason_raw，实际 %v", rawReason)
	}

	// profile 阶段的 partial 必须推进到 catalog，而不是把操作卡死。
	var opStatus, opStage string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status,stage FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1`,
		f.Account.ID).Scan(&opStatus, &opStage); err != nil {
		t.Fatal(err)
	}
	if opStage != "catalog" {
		t.Fatalf("profile 完成后操作应推进到 catalog，实际 status=%s stage=%s", opStatus, opStage)
	}
}

// TestPlatformV2ResultErrorCodesCoverDesignCatalog 固定错误目录必须覆盖设计文档里的正式码。
//
// 缺陷背景：白名单原来只有 12 个码，缺了 platform_browser_launch_failed、
// platform_profile_busy、platform_capability_denied 等设计文档 §12 明列的码。
// 桌面端上报这些码时整批被判 422，失败原因永远落不了库。
func TestPlatformV2ResultErrorCodesCoverDesignCatalog(t *testing.T) {
	for _, code := range []string{
		"platform_login_required", "platform_challenge_required", "platform_identity_mismatch",
		"platform_account_restricted", "platform_consent_required", "platform_schema_changed",
		"platform_network_unavailable", "platform_rate_limited", "platform_budget_exhausted",
		"platform_browser_unsupported", "platform_timeout", "platform_result_conflict",
		// 这五个就是漏收的正式码。
		"platform_browser_launch_failed", "platform_profile_busy", "platform_capability_denied",
		"platform_not_holder", "platform_proxy_intercepted",
	} {
		if !validPlatformResultError(code) {
			t.Fatalf("设计文档 §12 的正式错误码 %q 应被接受", code)
		}
	}
	for _, code := range []string{"", "collect_failed", "page_repeated", "not_a_platform_code"} {
		if validPlatformResultError(code) {
			t.Fatalf("目录外的 %q 不应被接受", code)
		}
	}
}
