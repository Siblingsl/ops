package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// TestMetricMappingShareUnitAllowedBySchema 映射表里所有投影到 shares 的字段，
// 其 Unit 必须是 `metric_snapshot.share_unit` CHECK 允许的值。
//
// 缺陷背景（2026-10-22 17:14 实测）：小红书 `share_times` 登记为
// `Unit: metricUnitCount`（"count"），但数据库 `share_unit` 的 CHECK 只接受
// `users / times / unknown`（迁移 00050）。投影时 `proj.ShareUnit = rule.Unit`
// 把 "count" 写进去，INSERT 直接抛 23514，**整个确认事务回滚**：
// 逐条确认 10 篇观测全部返回 500，一条也入不了库。
//
// 这类缺陷不会在"只跑 unit=unknown"的用例里暴露（unknown 是允许值），
// 只有真正投影带 count 的 shares 时才炸。因此这里做**结构性校验**：
// 遍历注册表，任何 shares 规则的 Unit 越界就失败，不依赖某个平台的偶然数据。
func TestMetricMappingShareUnitAllowedBySchema(t *testing.T) {
	// 与迁移 00050 的 CHECK 保持一致：share_unit IN ('users','times','unknown')。
	allowed := map[string]bool{
		metricUnitUsers:   true,
		metricUnitTimes:   true,
		metricUnitUnknown: true,
	}
	checked := 0
	for _, mapping := range metricMappings {
		for key, rule := range mapping.Fields {
			if rule.ProjectsTo != "shares" {
				continue
			}
			checked++
			if !allowed[rule.Unit] {
				t.Errorf("%s/%s 字段 %s 的 Unit=%q 不在 share_unit 允许值内（users/times/unknown），"+
					"投影时会让 metric_snapshot 插入抛 23514",
					mapping.Platform, mapping.AdapterVersion, key, rule.Unit)
			}
		}
	}
	if checked == 0 {
		t.Fatal("前置条件：注册表里应至少有一个投影到 shares 的字段")
	}
	t.Logf("已校验 %d 条 shares 规则的 Unit", checked)
}

// TestXhsShareTimesProjectsWithTimesUnit 小红书 share_times 必须投影成功且 share_unit=times。
//
// 这是上一条的端到端对应：不只校验注册表，而是真的走一遍投影 + 入库，
// 确认 shares 有值、share_unit 落在允许集合内。
//
// 修复要点：适配器必须上报 `times`（desktop/src/platforms/xhs.ts）。早期上报
// `count`，而映射表登记 count，两边"自洽"却让 share_unit 越界；后来映射表改成
// times，适配器不改则被 validateObservationMapping 以 422 拒绝——**两边必须同时为 times**。
func TestXhsShareTimesProjectsWithTimesUnit(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_share_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "分享次数投影", "6f0000000000000000000030")

	obsID := seedObservation(t, f, "6f0000000000000000000030", "xhs_browser", map[string]any{
		"share_times": map[string]any{"value": 7, "precision": "exact", "unit": "times"},
		"like_count":  map[string]any{"value": 3, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("确认应成功（缺陷复现点：share_unit 越界会让这里 500）：%v", err)
	}

	var shares *int
	var shareUnit *string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT shares, share_unit FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).
		Scan(&shares, &shareUnit); err != nil {
		t.Fatal(err)
	}
	if shares == nil || *shares != 7 {
		t.Fatalf("shares 应投影为 7，实际 %v", shares)
	}
	if shareUnit == nil || *shareUnit != metricUnitTimes {
		t.Fatalf("share_unit 应为 %q，实际 %v", metricUnitTimes, shareUnit)
	}
}

// TestXhsShareTimesRejectsCountUnit 适配器若仍上报 count，必须被明确拒绝（422），
// 而不是写进库再触发 23514。这条钉住"两边必须同为 times"的契约。
func TestXhsShareTimesRejectsCountUnit(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_leak_"+uuid.New().String()[:8])
	f.bindWork(t, "单位不外泄", "6f0000000000000000000031")

	obsID := seedObservation(t, f, "6f0000000000000000000031", "xhs_browser", map[string]any{
		"share_times": map[string]any{"value": 2, "precision": "exact", "unit": "count"},
	})
	_, err := env.srv.confirmObservation(metricTestCtx(f), obsID)
	if err == nil {
		t.Fatal("share_times 上报 count 应被拒绝，不能写进 metric_snapshot")
	}
	// 必须是校验失败（422），而不是数据库约束错误（500）：前者可诊断，后者是内部错误。
	var apiErrValue *APIError
	if !errors.As(err, &apiErrValue) || apiErrValue.Status != 422 {
		t.Fatalf("应为校验错误（422），实际 %v", err)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, f.workIDFor(t, "6f0000000000000000000031")).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("被拒绝的观测不得留下 metric_snapshot，实际 %d 行", count)
	}
}

// 编译期防呆：确认 json 包仍被使用（seedObservation 依赖 RawMessage 语义）。
var _ = json.RawMessage(nil)
