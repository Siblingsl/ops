package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// REF41 I6：粉丝来源优先级、桌面实时写入、缺失日回填与跨平台汇总。
func TestI6FollowerSourcesPriorityAndBackfill(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "xhs", "I6 粉丝来源验收号")
	base := "/api/v1/accounts/" + a.ID.String()
	today := env.srv.today()
	d1 := today.AddDate(0, 0, -1).Format("2006-01-02")
	d2 := today.AddDate(0, 0, -2).Format("2006-01-02")
	d3 := today.AddDate(0, 0, -3).Format("2006-01-02")

	env.mustJSON(t, "POST", base+"/followers", map[string]any{"date": d1, "cumulate": 100}, nil)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO account_metric_daily
		(account_id,date,source,cumulate,collected_at,evidence)
		VALUES($1,$2,'desktop_live',120,now(),'{"platform":"xhs","adapter_version":"xhs-1"}'::jsonb)
		ON CONFLICT (account_id,date,source) DO UPDATE SET cumulate=EXCLUDED.cumulate`,
		a.ID, d1); err != nil {
		t.Fatal(err)
	}
	var list followerList
	env.mustJSON(t, "GET", base+"/followers?days=5", nil, &list)
	if len(list.Days) == 0 || list.Days[0].Date != d1 {
		t.Fatalf("expected newest day first: %+v", list.Days)
	}
	if list.Days[0].Source != "desktop_live" || list.Days[0].Cumulate == nil || *list.Days[0].Cumulate != 120 {
		t.Fatalf("desktop_live must outrank manual on the same day: %+v", list.Days[0])
	}
	if list.Days[0].CollectedAt == nil {
		t.Fatalf("collected_at must be returned: %+v", list.Days[0])
	}

	env.mustJSON(t, "POST", base+"/followers", map[string]any{"date": d2, "cumulate": 90}, nil)
	env.mustJSON(t, "POST", base+"/followers/backfill", map[string]any{
		"platform": "xhs", "from": d3, "to": d3,
		"values": []any{map[string]any{"date": d3, "count": 80}},
	}, nil)
	var after followerList
	env.mustJSON(t, "GET", base+"/followers?days=5", nil, &after)
	byDate := map[string]FollowerDay{}
	for _, day := range after.Days {
		byDate[day.Date] = day
	}
	if byDate[d3].Source != "desktop_backfill" || byDate[d3].Cumulate == nil || *byDate[d3].Cumulate != 80 {
		t.Fatalf("backfill source/value: %+v", byDate[d3])
	}

	ae := env.expectErr(t, "POST", base+"/followers/backfill", map[string]any{
		"platform": "xhs", "from": d3, "to": d3,
		"values": []any{map[string]any{"date": d3, "count": 81}},
	}, "follower_backfill_conflict")
	var detail struct {
		Conflicts []string `json:"conflicts"`
	}
	if err := json.Unmarshal(ae.Error.Detail, &detail); err != nil || len(detail.Conflicts) != 1 || detail.Conflicts[0] != d3 {
		t.Fatalf("409 must list conflicting dates: %s (%v)", ae.Error.Detail, err)
	}
	var rows int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_metric_daily WHERE account_id=$1 AND date=$2`, a.ID, d3).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("conflicting backfill must not add a row: %d", rows)
	}

	var coverage struct {
		From    string   `json:"from"`
		To      string   `json:"to"`
		Missing []string `json:"missing"`
	}
	env.mustJSON(t, "GET", base+"/followers/coverage?from="+d3+"&to="+d1, nil, &coverage)
	if len(coverage.Missing) != 0 {
		t.Fatalf("d1..d3 all have values: %+v", coverage)
	}
	env.mustJSON(t, "GET", base+"/followers/coverage?from="+d3+"&to="+today.Format("2006-01-02"), nil, &coverage)
	if len(coverage.Missing) != 1 || coverage.Missing[0] != today.Format("2006-01-02") {
		t.Fatalf("today is not collected yet: %+v", coverage)
	}

	env.expectErr(t, "POST", base+"/followers/backfill", map[string]any{
		"platform": "wechat_mp", "from": d3, "to": d3,
		"values": []any{map[string]any{"date": d3, "count": 1}},
	}, "validation_failed")
	env.expectErr(t, "POST", base+"/followers/backfill", map[string]any{
		"platform": "xhs", "from": d3, "to": d3,
		"values": []any{
			map[string]any{"date": d3, "count": 1},
			map[string]any{"date": d3, "count": 2},
		},
	}, "validation_failed")
}

func TestI6CSVImportWritesOnlyMissingRows(t *testing.T) {
	a := drAccount(t, "xhs", "I6 CSV 导入验收号")
	base := "/api/v1/accounts/" + a.ID.String()
	today := env.srv.today()
	d1 := today.AddDate(0, 0, -1).Format("2006-01-02")
	d2 := today.AddDate(0, 0, -2).Format("2006-01-02")

	var result struct {
		Imported     int      `json:"imported"`
		SkippedDates []string `json:"skipped_dates"`
		Parsed       int      `json:"parsed"`
	}
	env.mustJSON(t, "POST", base+"/followers/import", map[string]any{
		"csv": "日期,粉丝数\n" + d1 + ",120\n" + d2 + ",110\n",
	}, &result)
	if result.Imported != 2 || result.Parsed != 2 || len(result.SkippedDates) != 0 {
		t.Fatalf("first CSV import: %+v", result)
	}

	var list followerList
	env.mustJSON(t, "GET", base+"/followers?days=5", nil, &list)
	byDate := map[string]FollowerDay{}
	for _, day := range list.Days {
		byDate[day.Date] = day
	}
	if byDate[d1].Source != "import" || byDate[d1].Cumulate == nil || *byDate[d1].Cumulate != 120 {
		t.Fatalf("import row: %+v", byDate[d1])
	}

	// 任意来源已有的日期不再写入，且不覆盖 manual 的高优先级值。
	env.mustJSON(t, "POST", base+"/followers", map[string]any{"date": d1, "cumulate": 100}, nil)
	result = struct {
		Imported     int      `json:"imported"`
		SkippedDates []string `json:"skipped_dates"`
		Parsed       int      `json:"parsed"`
	}{}
	env.mustJSON(t, "POST", base+"/followers/import", map[string]any{
		"csv": "date,count\n" + d1 + ",999\n" + d2 + ",888\n",
	}, &result)
	if result.Imported != 0 || len(result.SkippedDates) != 2 || result.SkippedDates[0] != d1 {
		t.Fatalf("second CSV import must skip existing dates: %+v", result)
	}
	env.mustJSON(t, "GET", base+"/followers?days=5", nil, &list)
	byDate = map[string]FollowerDay{}
	for _, day := range list.Days {
		byDate[day.Date] = day
	}
	if byDate[d1].Source != "manual" || byDate[d1].Cumulate == nil || *byDate[d1].Cumulate != 100 {
		t.Fatalf("manual must stay: %+v", byDate[d1])
	}
	if byDate[d2].Source != "import" || byDate[d2].Cumulate == nil || *byDate[d2].Cumulate != 110 {
		t.Fatalf("existing import must stay: %+v", byDate[d2])
	}

	for _, csvText := range []string{
		"date,count\nnot-a-date,10\n",
		"date,count\n" + d1 + ",-1\n",
		"date,count\n" + d1 + ",1\n" + d1 + ",2\n",
		"date,count\n" + d1 + ",1,extra\n",
	} {
		env.expectErr(t, "POST", base+"/followers/import", map[string]any{"csv": csvText}, "validation_failed")
	}
	env.expectErr(t, "POST", base+"/followers/import", map[string]any{"csv": "date,count\n"}, "validation_failed")
}

func TestI6DesktopLiveBatchApply(t *testing.T) {
	a := drAccount(t, "xhs", "I6 桌面实时验收号")
	day := env.srv.today().AddDate(0, 0, -1)
	collected := time.Now()
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	n, err := env.srv.writePlatformV2FollowersTx(context.Background(), tx, platformV2WriteContext{
		AccountID: a.ID, Platform: "xhs", AdapterVersion: "xhs-1", Stage: "metrics",
	}, []platformV2Follower{{
		Date: day.Format("2006-01-02"), Cumulate: intPtr(321), CollectedAt: &collected,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("desktop_live rows: %d", n)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	var list followerList
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/followers?days=5", nil, &list)
	if len(list.Days) == 0 || list.Days[0].Source != "desktop_live" || list.Days[0].Cumulate == nil || *list.Days[0].Cumulate != 321 {
		t.Fatalf("desktop_live list: %+v", list.Days)
	}
	var evidence string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT evidence::text FROM account_metric_daily
		WHERE account_id=$1 AND date=$2 AND source='desktop_live'`, a.ID, day.Format("2006-01-02")).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if evidence == "" || evidence == "{}" {
		t.Fatalf("desktop_live evidence must be recorded: %q", evidence)
	}
}

func TestI6FollowerSummaryCoverageAndNoZeroFill(t *testing.T) {
	a := drAccount(t, "xhs", "I6 汇总小红书号")
	b := drAccount(t, "toutiao", "I6 汇总头条号")
	base := "/api/v1/accounts/" + a.ID.String()
	d1 := env.srv.today().AddDate(0, 0, -1).Format("2006-01-02")
	env.mustJSON(t, "POST", "/api/v1/accounts/"+b.ID.String()+"/followers", map[string]any{
		"date": d1, "cumulate": 55,
	}, nil)
	env.mustJSON(t, "POST", base+"/followers", map[string]any{
		"date": d1, "cumulate": 15,
	}, nil)

	var summary followerSummary
	env.mustJSON(t, "GET", base+"/followers/summary?days=30", nil, &summary)
	if summary.Days != 30 || summary.TotalPlatforms != len(summary.Platforms) {
		t.Fatalf("summary shape: %+v", summary)
	}
	var sum int
	covered := 0
	for _, p := range summary.Platforms {
		if p.Latest != nil {
			sum += *p.Latest
			covered++
		}
		if len(p.Series) != summary.Days {
			t.Fatalf("%s series must cover 30 days: %d", p.Platform, len(p.Series))
		}
		var missingDays int
		for _, day := range p.Series {
			if day.Cumulate == nil {
				missingDays++
			}
		}
		if missingDays != len(p.Gaps) {
			t.Fatalf("%s gaps mismatch: series=%d gaps=%d", p.Platform, missingDays, len(p.Gaps))
		}
		if p.Latest == nil && p.Source != "" {
			t.Fatalf("%s missing latest must not have source: %+v", p.Platform, p)
		}
	}
	if summary.Total == nil || *summary.Total != sum {
		t.Fatalf("total must equal sum of covered platforms: total=%v sum=%d", summary.Total, sum)
	}
	if summary.CoveredPlatforms != covered {
		t.Fatalf("covered platforms: %d/%d", summary.CoveredPlatforms, covered)
	}
	// 无粉丝数据的平台也必须返回空源，而不是让整个汇总 500。
	for _, missing := range summary.MissingPlatforms {
		found := false
		for _, p := range summary.Platforms {
			if p.Platform == missing {
				found = true
				if p.Latest != nil || p.Source != "" || p.CollectedAt != nil {
					t.Fatalf("missing platform must stay empty: %+v", p)
				}
			}
		}
		if !found {
			t.Fatalf("missing platform %s absent from platforms: %+v", missing, summary.Platforms)
		}
	}
	if len(summary.MissingPlatforms) != summary.TotalPlatforms-summary.CoveredPlatforms {
		t.Fatalf("missing platforms: %+v", summary.MissingPlatforms)
	}
	// 两个本次新建平台都有昨天的值，不应被当成缺失平台。
	for _, p := range summary.Platforms {
		if (p.Platform == "xhs" || p.Platform == "toutiao") && p.Latest == nil {
			t.Fatalf("platform %s should be covered: %+v", p.Platform, p)
		}
	}
}

func intPtr(v int) *int { return &v }
