package app

import (
	"context"
	"testing"
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
