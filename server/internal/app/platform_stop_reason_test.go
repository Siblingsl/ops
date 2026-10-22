package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestPlatformStopReasonOutsideEnumStillSettles 终批带"适配器私有"的停止原因时也必须落库。
//
// 缺陷背景（2026-10-22 16:30 实测）：客户端把适配器的覆盖不完整原因直接当 `stop_reason`
// 发上来——小红书翻页重复时是 `page_repeated`，公众号页预算用尽时是 `page_budget`，
// 采集异常时是 `collect_failed`。这些值不在 `platform_sync_run.stop_reason` 的 CHECK 里，
// 于是终批那条 UPDATE 抛 23514，**整个终批事务回滚**：观测全丢、run 卡在 running 直到
// 租约过期，客户端只收到 500。验收号那 10 篇就是这样丢的。
//
// 期望行为：认识的枚举照原样存；不认识的不阻断入库，`stop_reason` 存 NULL，
// 原始值留在 `counters.stop_reason_raw` 里供排查。
func TestPlatformStopReasonOutsideEnumStillSettles(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "停止原因越界", "6f0000000000000000000020")
	bindingRev, publishRev := workRevisions(t, f.workIDFor(t, "6f0000000000000000000020"))

	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}

	body := map[string]any{
		"protocol_version":       desktopPlatformProtocolVersion,
		"lease_generation":       gen,
		"authorization_revision": connectionAuthRevision(t, f.Connection),
		"batch_seq":              0,
		"final_batch":            true,
		"run_status":             platformRunStatusPartial,
		// 这一行就是缺陷触发点：不在 CHECK 允许的七个值里。
		"stop_reason": "page_repeated",
		"coverage":    map[string]any{"pages_read": 2, "has_more": true, "incomplete_reason": "page_repeated"},
		"observations": []map[string]any{{
			"row_no": 0, "scope": "work", "external_account_key": f.externalKey(),
			"external_id": "6f0000000000000000000020", "binding_revision": bindingRev, "publish_revision": publishRev,
			"source": "xhs_browser", "temporal_kind": "cumulative",
			"observed_at":     "2026-10-22T08:30:00Z",
			"as_of_at":        "2026-10-22T08:30:00Z",
			"adapter_version": "xhs-1", "mapping_version": 1,
			"values":      map[string]any{"like_count": map[string]any{"value": 6, "precision": "exact", "unit": "count"}},
			"field_paths": map[string]any{"like_count": "fixture.like_count"},
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	status, resp := f.submit(t, runID, raw)
	if status != http.StatusOK {
		t.Fatalf("终批应被接受，实际 %d %s", status, resp)
	}

	// 观测必须留下来：这正是"事务整体回滚"时要丢的东西。
	var observations int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&observations); err != nil {
		t.Fatal(err)
	}
	if observations != 1 {
		t.Fatalf("终批应写入 1 条观测，实际 %d 条", observations)
	}

	// run 必须走到终态，不能卡在 running 等租约过期。
	var runStatus string
	var stopReason *string
	var rawReason *string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, stop_reason, counters->>'stop_reason_raw' FROM platform_sync_run WHERE id=$1`, runID).
		Scan(&runStatus, &stopReason, &rawReason); err != nil {
		t.Fatal(err)
	}
	if runStatus != platformRunStatusPartial {
		t.Fatalf("run 应为 %s，实际 %s", platformRunStatusPartial, runStatus)
	}
	if stopReason != nil {
		t.Fatalf("未登记的停止原因不应写进 stop_reason，实际 %q", *stopReason)
	}
	if rawReason == nil || *rawReason != "page_repeated" {
		t.Fatalf("原始停止原因应留在 counters.stop_reason_raw，实际 %v", rawReason)
	}
}

// TestPlatformStopReasonKnownValuePreserved 登记过的原因必须原样保留，不能被上面的过滤抹掉。
func TestPlatformStopReasonKnownValuePreserved(t *testing.T) {
	for _, want := range []string{"budget", "login_required", "challenge_required", "schema_changed",
		"network", "identity_mismatch", "canceled"} {
		value := want
		got := platformStopReason(&value)
		if got == nil || *got != want {
			t.Fatalf("登记过的原因 %q 应原样保留，实际 %v", want, got)
		}
	}
	if got := platformStopReason(nil); got != nil {
		t.Fatalf("空值应保持为空，实际 %q", *got)
	}
	unknown := "collect_failed"
	if got := platformStopReason(&unknown); got != nil {
		t.Fatalf("未登记的原因应折叠为空值，实际 %q", *got)
	}
}

var _ = uuid.Nil
