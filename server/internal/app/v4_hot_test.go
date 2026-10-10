package app

import (
	"context"
	"ops/internal/crawl"
	"testing"
	"time"
)

func TestV411HotSchemaConstraints(t *testing.T) {
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO crawl_source(key,kind,name,interval_min) VALUES ('bad-interval','rss','bad',5)`,
		`INSERT INTO crawl_source(key,kind,name,max_items) VALUES ('bad-items','rss','bad',101)`,
		`INSERT INTO crawl_source(key,kind,name) VALUES ('bad-kind','unknown','bad')`,
	} {
		if _, err := env.srv.db.Exec(ctx, sql); err == nil {
			t.Fatalf("invalid source accepted: %s", sql)
		}
	}
	var n int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM crawl_source WHERE enabled`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("default sources must be off: %d %v", n, err)
	}
	var allow bool
	if err := env.srv.db.QueryRow(ctx, `SELECT robots_allow FROM crawl_source WHERE key='xhs_page'`).Scan(&allow); err != nil || allow {
		t.Fatalf("sensitive robots: %v %v", allow, err)
	}
}

func enableTestCrawl(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	oldMode, oldNow := env.srv.cfg.CrawlMode, env.srv.now
	var oldLevel, oldLimits []byte
	_ = env.srv.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='crawl.level'`).Scan(&oldLevel)
	_ = env.srv.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='crawl.limits'`).Scan(&oldLimits)
	env.srv.cfg.CrawlMode = "allow"
	env.srv.crawler = nil
	_, err := env.srv.db.Exec(ctx, `UPDATE system_setting SET value='"conservative"' WHERE key='crawl.level'`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		env.srv.cfg.CrawlMode = oldMode
		env.srv.now = oldNow
		env.srv.crawler = nil
		_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.level'`, oldLevel)
		_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.limits'`, oldLimits)
		_, _ = env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=false,last_attempt_at=NULL,fail_count=0,paused_until=NULL`)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM crawl_budget`)
	})
}
func TestV414CollectDeduplicates(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return now }
	_, err := env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL WHERE key IN ('baidu','toutiao')`)
	if err != nil {
		t.Fatal(err)
	}
	source, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if err != nil {
		t.Fatal(err)
	}
	items, err := env.srv.collectSource(ctx, source)
	if err != nil || len(items) != 4 {
		t.Fatalf("collect %d %v", len(items), err)
	}
	if _, err = env.srv.collectSource(ctx, source); err != crawl.ErrLimited {
		t.Fatalf("source limit %v", err)
	}
	now = now.Add(time.Hour)
	if _, err = env.srv.collectSource(ctx, source); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM hot_item WHERE source_key='baidu'`).Scan(&n); err != nil || n != 4 {
		t.Fatalf("dedupe %d %v", n, err)
	}
	source, err = scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='toutiao'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, source); err != nil {
		t.Fatal(err)
	}
	if err = env.srv.db.QueryRow(ctx, `SELECT count(DISTINCT cluster_id) FROM hot_item WHERE title='互联网运营团队的新实践'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("cluster %d %v", n, err)
	}
	if err = env.srv.db.QueryRow(ctx, `SELECT requests FROM crawl_budget WHERE date=$1`, now.Format("2006-01-02")).Scan(&n); err != nil || n != 4 {
		t.Fatalf("request accounting %d %v", n, err)
	}
	env.srv.indexHotEmbeddings(ctx)
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM content_embedding WHERE object_type='hot'`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("hot embeddings %d %v", n, err)
	}
}

func TestCrawlBudgetConcurrentClaims(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	now := env.srv.now()
	st := crawlStore{env.srv}
	results := make(chan error, 20)
	for range 20 {
		go func() { results <- st.Reserve(ctx, now, 5) }()
	}
	accepted := 0
	for range 20 {
		if <-results == nil {
			accepted++
		}
	}
	if accepted != 5 {
		t.Fatalf("atomic budget accepted %d", accepted)
	}
}
