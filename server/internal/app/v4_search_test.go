package app

import (
	"context"
	"github.com/google/uuid"
	"ops/internal/crawl"
	"testing"
)

func TestV434NativeSearchEvidence(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	s := env.srv
	a, _ := v4Account(t, "联网来源配置")
	var ws, pid uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws)
	_ = s.db.QueryRow(ctx, `SELECT id FROM model_provider WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, ws).Scan(&pid)
	env.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"provider_id": pid, "model": "mock-fast", "query": "运营实践"}, nil)
	var result struct {
		Sources []CrawlSource `json:"sources"`
	}
	env.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &result)
	var src CrawlSource
	for _, x := range result.Sources {
		if x.Kind == "search" {
			src = x
		}
	}
	if src.Key == "" || src.Enabled {
		t.Fatal("search source must start disabled")
	}
	if _, e := s.collectSource(ctx, src); e != crawl.ErrLimited {
		t.Fatalf("disabled source requested: %v", e)
	}
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{src.Key}}, nil)
	items, e := s.collectSource(ctx, src)
	if e != nil || len(items) != 1 || items[0].URL != "https://example.com/search-ops" {
		t.Fatalf("evidence links %v %v", items, e)
	}
	var n int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE workspace_id=$1 AND task_type='hot_search'`, ws).Scan(&n)
	if n != 1 {
		t.Fatal("search usage not recorded")
	}
	if _, e = s.collectSource(ctx, src); e != crawl.ErrLimited {
		t.Fatalf("search spacing %v", e)
	}
}
