package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// drAccount creates a fresh account so node/dedupe counts are not affected by other tests.
func drAccount(t *testing.T, platform, name string) Account {
	t.Helper()
	_ = env.accounts(t)
	format := "long_article"
	if platform == "xhs" {
		format = "image_note"
	}
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": name, "content_format": format}, &a)
	return a
}

// drWork creates a work and moves it straight to the given status; published_at may be nil.
func drWork(t *testing.T, a Account, title, status string, publishedAt *time.Time) Work {
	t.Helper()
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title}, &wk)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status=$2, published_at=$3 WHERE id=$1`, wk.ID, status, publishedAt); err != nil {
		t.Fatal(err)
	}
	return wk
}

type metricResp struct {
	Metric
	Merged bool `json:"merged"`
}

func metricCount(t *testing.T, workID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, workID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// DEV-DR01（14 文档 4.1）：来源与发布天数节点、同来源同节点去重合并、未提供字段保持 NULL、
// 发布时间回填后重算节点、同一节点冲突时给出可读错误。
func TestDR01MetricNodes(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "数据质量验收号")
	pub := time.Date(2026, 10, 1, 20, 0, 0, 0, env.srv.loc)
	wk := drWork(t, a, "数据节点验收作品", "published", &pub)
	path := "/api/v1/works/" + wk.ID.String() + "/metrics"

	var m1 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.Add(14 * time.Hour), "reads": 100}, &m1)
	if m1.Source != "manual" || m1.DayOffset == nil || *m1.DayOffset != 1 || m1.Merged {
		t.Fatalf("first write should be manual day 1: %+v", m1)
	}
	if m1.Likes != nil || m1.Wows != nil {
		t.Fatalf("fields not entered must stay NULL: %+v", m1)
	}
	var m2 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.Add(20 * time.Hour), "likes": 5}, &m2)
	if !m2.Merged || m2.ID != m1.ID || m2.Reads == nil || *m2.Reads != 100 || m2.Likes == nil || *m2.Likes != 5 {
		t.Fatalf("same source + same node should merge into one row: %+v", m2)
	}
	if n := metricCount(t, wk.ID); n != 1 {
		t.Fatalf("want 1 row after merge, got %d", n)
	}
	var m3 metricResp
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": pub.AddDate(0, 0, 3), "reads": 300}, &m3)
	if m3.DayOffset == nil || *m3.DayOffset != 3 || m3.Merged {
		t.Fatalf("day 3 should be a new node: %+v", m3)
	}
	env.expectErr(t, "PATCH", "/api/v1/metrics/"+m3.ID.String(), map[string]any{"captured_at": pub.Add(14 * time.Hour), "reads": 300}, "validation_failed")

	// 粘贴回填与手动录入分开保存，同节点互不覆盖。
	var imp struct {
		Imported int `json:"imported"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]any{"source": "paste",
		"rows": []map[string]any{{"title": wk.Title, "work_id": wk.ID.String(), "reads": 999}}}, &imp)
	var pasteSrc string
	if err := env.srv.db.QueryRow(ctx, `SELECT source FROM metric_snapshot WHERE work_id=$1 AND reads=999`, wk.ID).Scan(&pasteSrc); err != nil || pasteSrc != "paste" {
		t.Fatalf("paste import source: %q %v", pasteSrc, err)
	}

	// 发布时间未知时节点为空；人工标记已发布后按发布日重算。
	packed := drWork(t, a, "先录数据后标记发布", "packed", nil)
	var early metricResp
	env.mustJSON(t, "POST", "/api/v1/works/"+packed.ID.String()+"/metrics", map[string]any{"captured_at": pub.AddDate(0, 0, 7), "reads": 70}, &early)
	if early.DayOffset != nil {
		t.Fatalf("no published_at yet, day_offset should be NULL: %+v", early)
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+packed.ID.String()+"/published", map[string]any{"published_at": pub}, nil)
	var off *int
	if err := env.srv.db.QueryRow(ctx, `SELECT day_offset FROM metric_snapshot WHERE id=$1`, early.ID).Scan(&off); err != nil || off == nil || *off != 7 {
		t.Fatalf("day_offset should be recomputed to 7 after marking published: %v %v", off, err)
	}

	// 日历日口径：同一天晚些时候仍是第 0 天，跨过零点为第 1 天。
	var d0, d1 int
	if err := env.srv.db.QueryRow(ctx, `SELECT metric_day_offset('2026-10-01 23:30+08', '2026-10-01 20:00+08'), metric_day_offset('2026-10-02 00:10+08', '2026-10-01 20:00+08')`).Scan(&d0, &d1); err != nil || d0 != 0 || d1 != 1 {
		t.Fatalf("calendar day offset: %d %d %v", d0, d1, err)
	}
}
