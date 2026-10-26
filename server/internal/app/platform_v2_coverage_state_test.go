package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// 覆盖状态与能力判定这一组纯函数决定「操作能不能收成 succeeded」，此前没有任何
// 直接测试（`grep` 在 `*_test.go` 里对五个函数名全部 0 命中）。它们一旦判错，
// 表现是操作永远停在 partial 或者被提前标成 unsupported，而链路上没有任何报错。
//
// 这里的用例都只依赖纯函数或一次只读查询，不跑采集链路。

// TestPlatformSyncCapabilityStateMapsPerPlatformKey 能力字段名按平台不同，映射错了就等于没核验。
func TestPlatformSyncCapabilityStateMapsPerPlatformKey(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		platform   string
		capability string
		want       string
	}{
		{"小红书目录看 workList", `{"workList":"supported"}`, "xhs", "catalog", "supported"},
		{"公众号目录看 publishedList", `{"publishedList":"denied"}`, "wechat_mp", "catalog", "denied"},
		{"小红书指标看 perNoteMetrics", `{"perNoteMetrics":"temporarily_unavailable"}`, "xhs", "metrics", "temporarily_unavailable"},
		{"公众号指标看 perArticleMetrics", `{"perArticleMetrics":"unsupported"}`, "wechat_mp", "metrics", "unsupported"},
		{"小红书正文看 noteContent", `{"noteContent":"supported"}`, "xhs", "content", "supported"},
		{"公众号正文看 articleContent", `{"articleContent":"supported"}`, "wechat_mp", "content", "supported"},
		// 平台认不出来时不能借用另一个平台的键，否则等于凭空宣称能力。
		{"未知平台没有对应键", `{"workList":"supported"}`, "toutiao", "catalog", "unknown"},
		{"未知能力没有对应键", `{"workList":"supported"}`, "xhs", "profile", "unknown"},
		// 结构坏了要退回 unknown，不能当成可用。
		{"JSON 解析失败", `not json`, "xhs", "catalog", "unknown"},
		{"空字节", ``, "xhs", "catalog", "unknown"},
		{"字段缺失", `{"workList":"supported"}`, "xhs", "metrics", "unknown"},
		{"值不是字符串", `{"workList":true}`, "xhs", "catalog", "unknown"},
		// 只有四个约定状态算数；写别的词（含大小写不同）一律 unknown。
		{"未约定的状态值", `{"workList":"maybe"}`, "xhs", "catalog", "unknown"},
		{"大小写不同不算", `{"workList":"Supported"}`, "xhs", "catalog", "unknown"},
		{"空字符串状态", `{"workList":""}`, "xhs", "catalog", "unknown"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := platformSyncCapabilityState([]byte(tc.raw), tc.platform, tc.capability); got != tc.want {
				t.Fatalf("platformSyncCapabilityState(%s,%s,%s)=%q，期望 %q", tc.raw, tc.platform, tc.capability, got, tc.want)
			}
		})
	}
}

// TestPlatformInitialCoverageStartsNotStarted 新操作的四个阶段必须都是 not_started。
//
// 任何一段被写成别的状态，`allPlatformCoverageComplete` 就会在操作还没跑过的时候
// 误判，或者反过来永远判不成 complete。
func TestPlatformInitialCoverageStartsNotStarted(t *testing.T) {
	coverage := platformInitialCoverage("supported")
	for _, stage := range []string{"profile", "catalog", "content", "metrics"} {
		entry, ok := coverage[stage].(map[string]any)
		if !ok {
			t.Fatalf("阶段 %s 必须是对象，实际 %T", stage, coverage[stage])
		}
		if entry["state"] != "not_started" {
			t.Fatalf("阶段 %s 初始状态应为 not_started，实际 %v", stage, entry["state"])
		}
		if entry["reason"] != nil {
			t.Fatalf("阶段 %s 初始不应带原因，实际 %v", stage, entry["reason"])
		}
		for _, key := range []string{"range", "total_count"} {
			if entry[key] != nil {
				t.Fatalf("阶段 %s 的 %s 初始应为 nil，实际 %v", stage, key, entry[key])
			}
		}
		for _, key := range []string{"succeeded", "failed", "pending"} {
			if entry[key] != 0 {
				t.Fatalf("阶段 %s 的 %s 初始应为 0，实际 %v", stage, key, entry[key])
			}
		}
	}
	// 只有 content 带能力快照：它是"跳过还是执行"的判据来源。
	content := coverage["content"].(map[string]any)
	if content["capability_state"] != "supported" {
		t.Fatalf("content 阶段应带 capability_state，实际 %v", content["capability_state"])
	}
	if _, ok := coverage["metrics"].(map[string]any)["capability_state"]; ok {
		t.Fatal("metrics 阶段不应带 capability_state")
	}
	// 新操作的四段都不是 complete，否则会被当成"已经跑完"。
	if allPlatformCoverageComplete(coverage) {
		t.Fatal("初始覆盖不能算全部完成")
	}
}

// TestSetCoverageStateKeepsCounters 只改状态与原因，计数和范围必须原样保留。
//
// 现实里 coverage 是从库里读回来的 JSON，数字是 float64；这里特意用 float64
// 造数据，防止实现把它覆盖成 int 0 而让界面显示"成功 0 篇"。
func TestSetCoverageStateKeepsCounters(t *testing.T) {
	coverage := map[string]any{
		"catalog": map[string]any{
			"state":       "partial",
			"range":       "published",
			"total_count": float64(39),
			"succeeded":   float64(30),
			"failed":      float64(1),
			"pending":     float64(9),
			"reason":      "page_budget",
		},
	}
	setCoverageState(coverage, "catalog", "complete", "")
	entry := coverage["catalog"].(map[string]any)
	if entry["state"] != "complete" {
		t.Fatalf("状态应被改写为 complete，实际 %v", entry["state"])
	}
	if entry["reason"] != "" {
		t.Fatalf("原因应被改写为空串，实际 %v", entry["reason"])
	}
	if entry["total_count"] != float64(39) || entry["succeeded"] != float64(30) ||
		entry["failed"] != float64(1) || entry["pending"] != float64(9) {
		t.Fatalf("计数与总数必须原样保留，实际 %v", entry)
	}
	if entry["range"] != "published" {
		t.Fatalf("范围必须原样保留，实际 %v", entry["range"])
	}

	// 阶段不存在时新建，且必须补齐界面要用的全部字段。
	setCoverageState(coverage, "metrics", "unsupported", "metrics_capability_unverified")
	created, ok := coverage["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("缺失阶段应被创建为对象，实际 %T", coverage["metrics"])
	}
	if created["state"] != "unsupported" || created["reason"] != "metrics_capability_unverified" {
		t.Fatalf("新建阶段的状态/原因不对：%v", created)
	}
	for _, key := range []string{"succeeded", "failed", "pending"} {
		if created[key] != 0 {
			t.Fatalf("新建阶段的 %s 应为 0，实际 %v", key, created[key])
		}
	}
	for _, key := range []string{"range", "total_count"} {
		if created[key] != nil {
			t.Fatalf("新建阶段的 %s 应为 nil，实际 %v", key, created[key])
		}
	}
}

// TestAllPlatformCoverageCompleteRequiresEveryStage 四段都 complete 才算完成。
//
// 这是操作能否收成 succeeded 的唯一判据；少判一段就会把"只跑了目录"的操作
// 标成成功，多判一段就会永远 partial。
func TestAllPlatformCoverageCompleteRequiresEveryStage(t *testing.T) {
	complete := func() map[string]any {
		return map[string]any{
			"profile": map[string]any{"state": "complete"},
			"catalog": map[string]any{"state": "complete"},
			"content": map[string]any{"state": "complete"},
			"metrics": map[string]any{"state": "complete"},
		}
	}
	if !allPlatformCoverageComplete(complete()) {
		t.Fatal("四段都 complete 时应返回 true")
	}

	for _, stage := range []string{"profile", "catalog", "content", "metrics"} {
		stage := stage
		t.Run("缺"+stage, func(t *testing.T) {
			coverage := complete()
			delete(coverage, stage)
			if allPlatformCoverageComplete(coverage) {
				t.Fatalf("缺少 %s 时不能算完成", stage)
			}
		})
		t.Run(stage+"未完成", func(t *testing.T) {
			coverage := complete()
			coverage[stage] = map[string]any{"state": "partial"}
			if allPlatformCoverageComplete(coverage) {
				t.Fatalf("%s 为 partial 时不能算完成", stage)
			}
		})
		t.Run(stage+"不是对象", func(t *testing.T) {
			coverage := complete()
			coverage[stage] = "complete"
			if allPlatformCoverageComplete(coverage) {
				t.Fatalf("%s 结构不对时不能算完成", stage)
			}
		})
	}

	if allPlatformCoverageComplete(nil) {
		t.Fatal("空覆盖不能算完成")
	}
	if allPlatformCoverageComplete(map[string]any{}) {
		t.Fatal("没有阶段的覆盖不能算完成")
	}
	// 大小写不同不是同一个状态。
	coverage := complete()
	coverage["metrics"] = map[string]any{"state": "Complete"}
	if allPlatformCoverageComplete(coverage) {
		t.Fatal("状态词大小写不同不能算 complete")
	}
}

// TestPlatformSyncCapabilityStateForAccountReadsConnection 从连接快照读能力，读不到一律 unknown。
//
// 这条决定 `advancePlatformV2OperationTx` 在目录之后是继续跑指标还是直接标
// unsupported；连接被删或者字段缺失时必须退化成 unknown，不能默认可用。
func TestPlatformSyncCapabilityStateForAccountReadsConnection(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-capability")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`,
		f.Connection, []byte(`{"workList":"supported","perNoteMetrics":"unknown","noteContent":"unsupported"}`)); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	cases := []struct {
		capability string
		want       string
	}{
		{"catalog", "supported"},
		{"metrics", "unknown"},
		{"content", "unsupported"},
		{"profile", "unknown"},
	}
	for _, tc := range cases {
		if got := platformSyncCapabilityStateForAccount(ctx, tx, f.Connection, "xhs", tc.capability); got != tc.want {
			t.Fatalf("连接能力 %s=%q，期望 %q", tc.capability, got, tc.want)
		}
	}

	// 连接不存在时只能是 unknown：这条路径被删连接、被回收的连接都会走到。
	if got := platformSyncCapabilityStateForAccount(ctx, tx, uuid.New(), "xhs", "catalog"); got != "unknown" {
		t.Fatalf("连接不存在时应返回 unknown，实际 %q", got)
	}
}
