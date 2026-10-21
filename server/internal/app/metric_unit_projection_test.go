package app

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// DEV-PS39 定向测试：单位未知的观测不得投影进正式指标（20 文档 §8.4、§9.1）。
//
// 红线：`read_times` / `view_times` / `share_times` 这些单位未确认的字段，
// 只存观测、不写正式指标。映射表里的 `Unit + ProjectsTo` 只表示
// "若确实是该单位就投到哪"，不能反过来当成"适配器没确认单位也照投"。
//
// 实测缺陷：公众号适配器把 `share_times` 标为 `unknown`，但映射表声明
// `Unit: times, ProjectsTo: shares`，早期实现只看 precision 不看 unit，
// 于是 `metric_snapshot.shares` 被写进了 0 且 `share_unit=times` —— 口径未知的数字进了正式指标。

func TestProjectionSkipsUnknownUnit(t *testing.T) {
	mapping, ok := lookupMetricMapping("wechat_mp", "wechat-mp-1", 1)
	if !ok {
		t.Fatal("前置条件：公众号映射必须存在")
	}
	if rule, exists := mapping.Fields["share_times"]; !exists || rule.ProjectsTo != "shares" {
		t.Fatal("前置条件：share_times 应登记为投影到 shares")
	}

	base := platformObservationInput{
		WorkspaceID:        uuid.New(),
		AccountID:          uuid.New(),
		ExternalAccountKey: "wechat_biz:fixture",
		Scope:              observationScopeWork,
		Source:             "wechat_browser",
		TemporalKind:       "cumulative",
		AdapterVersion:     "wechat-mp-1",
		MappingVersion:     1,
		ExternalID:         ptrStr("2247480001_1"),
	}
	withValues := func(shareUnit string) platformObservationInput {
		in := base
		in.Values = map[string]json.RawMessage{
			// 三个字段一起给，确保只隔离 unit 这一个变量。
			"share_times":   json.RawMessage(`{"value": 5, "precision": "exact", "unit": "` + shareUnit + `"}`),
			"like_count":    json.RawMessage(`{"value": 3, "precision": "exact", "unit": "count"}`),
			"comment_count": json.RawMessage(`{"value": 2, "precision": "exact", "unit": "count"}`),
		}
		in.FieldPaths = map[string]string{
			"share_times": "fixture.share_num", "like_count": "fixture.like_num", "comment_count": "fixture.comment_num",
		}
		return in
	}

	// 单位为 unknown：绝不投影 shares。
	proj, err := projectObservation("wechat_mp", "wechat-mp-1", 1, withValues("unknown"))
	if err != nil {
		t.Fatal(err)
	}
	if proj.Shares != nil {
		t.Fatalf("share_times 单位为 unknown 时不得投影 shares，实际 %d", *proj.Shares)
	}
	// 其它 count 字段不受影响，仍应正常投影。
	if proj.Likes == nil || *proj.Likes != 3 {
		t.Fatalf("like_count 应正常投影，实际 %v", proj.Likes)
	}
	if proj.Comments == nil || *proj.Comments != 2 {
		t.Fatalf("comment_count 应正常投影，实际 %v", proj.Comments)
	}

	// 单位确认为 times：这时才投影。
	proj2, err := projectObservation("wechat_mp", "wechat-mp-1", 1, withValues("times"))
	if err != nil {
		t.Fatal(err)
	}
	if proj2.Shares == nil || *proj2.Shares != 5 {
		t.Fatalf("单位为 times 时应投影 shares=5，实际 %v", proj2.Shares)
	}
}

// TestProjectionSkipsUnknownUnitForXhs 同样适用于小红书的 view_times。
func TestProjectionSkipsUnknownUnitForXhs(t *testing.T) {
	in := platformObservationInput{
		WorkspaceID:        uuid.New(),
		AccountID:          uuid.New(),
		ExternalAccountKey: "xhs_user_id:fixture",
		Scope:              observationScopeWork,
		Source:             "xhs_browser",
		TemporalKind:       "cumulative",
		AdapterVersion:     "xhs-1",
		MappingVersion:     1,
		ExternalID:         ptrStr("6f0000000000000000000001"),
		Values: map[string]json.RawMessage{
			"view_times":  json.RawMessage(`{"value": 177, "precision": "exact", "unit": "unknown"}`),
			"like_count":  json.RawMessage(`{"value": 5, "precision": "exact", "unit": "count"}`),
		},
		FieldPaths: map[string]string{"view_times": "fixture.view_count", "like_count": "fixture.likes"},
	}
	proj, err := projectObservation("xhs", "xhs-1", 1, in)
	if err != nil {
		t.Fatal(err)
	}
	// view_times 在映射表里本就没有 ProjectsTo，这里双重保证。
	if proj.Reads != nil {
		t.Fatalf("view_times 不得投影 reads，实际 %d", *proj.Reads)
	}
	if proj.Likes == nil || *proj.Likes != 5 {
		t.Fatalf("like_count 应正常投影，实际 %v", proj.Likes)
	}
}

// TestConfirmedObservationKeepsUnknownUnitOutOfMetrics 端到端：
// 确认一条带 unknown 单位的观测后，正式指标里不应出现对应列。
func TestConfirmedObservationKeepsUnknownUnitOutOfMetrics(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_unit_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "单位未知不投影", "2247480009_1")

	obsID := seedObservation(t, f, "2247480009_1", "wechat_browser", map[string]any{
		"share_times":   map[string]any{"value": 9, "precision": "exact", "unit": "unknown"},
		"read_times":    map[string]any{"value": 100, "precision": "exact", "unit": "unknown"},
		"like_count":    map[string]any{"value": 4, "precision": "exact", "unit": "count"},
	})
	ctx := metricTestCtx(f)
	if _, err := env.srv.confirmObservation(ctx, obsID); err != nil {
		t.Fatal(err)
	}

	var shares, reads *int
	var likes *int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT shares, reads, likes
		FROM metric_snapshot WHERE work_id=$1 AND source='wechat_browser'`, wk.ID).
		Scan(&shares, &reads, &likes); err != nil {
		t.Fatal(err)
	}
	if shares != nil {
		t.Fatalf("share_times 单位 unknown，shares 必须为 NULL，实际 %d", *shares)
	}
	if reads != nil {
		t.Fatalf("read_times 单位 unknown，reads 必须为 NULL，实际 %d", *reads)
	}
	if likes == nil || *likes != 4 {
		t.Fatalf("like_count 应正常投影，实际 %v", likes)
	}
}

// ptrStr 取字符串指针，供 ExternalID 使用。
func ptrStr(s string) *string { return &s }
