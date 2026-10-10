package app

import (
	"context"
	"ops/internal/crawl"
	"testing"
	"time"
)

func TestV435SummaryBoundaries(t *testing.T) {
	enableTestCrawl(t)
	s := env.srv
	ctx := context.Background()
	_, _ = s.db.Exec(ctx, `DELETE FROM crawl_summary_state`)
	_, _ = s.db.Exec(ctx, `DELETE FROM crawl_summary_url`)
	_, _ = s.db.Exec(ctx, `UPDATE crawl_source SET enabled=true WHERE key='baidu'`)
	src, e := scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.collectSource(ctx, src); e != nil {
		t.Fatal(e)
	}
	a, path := v4Account(t, "热点摘要")
	opts, _ := positioningOptions(t, path)
	f := opts[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{"baidu"}}, nil)
	env.mustJSON(t, "POST", path+"/hot/refresh", nil, nil)
	var before, after int
	_ = s.db.QueryRow(ctx, `SELECT coalesce(sum(requests),0) FROM crawl_budget`).Scan(&before)
	s.collectSummaries(ctx)
	_ = s.db.QueryRow(ctx, `SELECT coalesce(sum(requests),0) FROM crawl_budget`).Scan(&after)
	if before != after {
		t.Fatal("conservative summary requested")
	}
	_, _ = s.db.Exec(ctx, `UPDATE system_setting SET value='"standard"' WHERE key='crawl.level'`)
	_, _ = s.db.Exec(ctx, `UPDATE system_setting SET value='true' WHERE key='crawl.summary_fetch'`)
	t.Cleanup(func() {
		_, _ = s.db.Exec(ctx, `UPDATE system_setting SET value='false' WHERE key='crawl.summary_fetch'`)
	})
	s.collectSummaries(ctx)
	var title, summary string
	e = s.db.QueryRow(ctx, `SELECT page_title,summary FROM hot_item h JOIN account_hot_match m ON m.hot_item_id=h.id WHERE m.account_id=$1 AND h.summary_at IS NOT NULL LIMIT 1`, a.ID).Scan(&title, &summary)
	if e != nil || title != "运营复盘参考" || summary != "公开文章摘要" {
		t.Fatalf("title/meta only %q %q %v", title, summary, e)
	}
	now := time.Date(2026, 10, 11, 9, 0, 0, 0, s.loc)
	st := crawlStore{s}
	results := make(chan error, 40)
	for i := 0; i < 40; i++ {
		go func() { results <- st.Reserve(ctx, crawl.Source{Kind: "summary"}, now, 2000) }()
	}
	n := 0
	for i := 0; i < 40; i++ {
		err := <-results
		if err == nil {
			n++
		} else if err != crawl.ErrLimited {
			t.Fatal(err)
		}
	}
	if n != 20 {
		t.Fatalf("summary daily cap %d", n)
	}
}
