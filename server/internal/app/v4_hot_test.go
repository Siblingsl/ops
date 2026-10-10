package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"ops/internal/crawl"
	"strings"
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

func TestE2E18AccountHotMatching(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	_, err := env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL,paused_until=NULL WHERE key='baidu'`)
	if err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{"baidu"}}, nil)
	src, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	account, path := v4Account(t, "热点匹配账号")
	options, _ := positioningOptions(t, path)
	env.mustJSON(t, "POST", path+"/strategy", options[0], nil)
	before := topicCount(t, account.ID.String())
	var result struct {
		Items   []HotMatch `json:"items"`
		Enabled bool       `json:"enabled"`
	}
	env.mustJSON(t, "POST", path+"/hot/refresh", nil, &result)
	if !result.Enabled || len(result.Items) != 4 {
		b, _ := json.Marshal(result)
		t.Fatalf("matches: %s", b)
	}
	if topicCount(t, account.ID.String()) != before {
		t.Fatal("matching writes topic pool")
	}
	var callsBefore, callsAfter int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='hot_relevance'`, account.ID).Scan(&callsBefore)
	env.mustJSON(t, "GET", path+"/hot", nil, nil)
	env.mustJSON(t, "GET", path+"/hot", nil, nil)
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='hot_relevance'`, account.ID).Scan(&callsAfter)
	if callsBefore != 1 || callsAfter != callsBefore {
		t.Fatalf("repeat generation: %d %d", callsBefore, callsAfter)
	}
	var safe, risky HotMatch
	for _, m := range result.Items {
		if highRisk(m.Risk) {
			risky = m
		} else {
			safe = m
		}
	}
	if risky.ID.String() == "00000000-0000-0000-0000-000000000000" {
		t.Fatal("disaster not labeled")
	}
	env.expectErr(t, "POST", "/api/v1/hot-matches/"+risky.ID.String()+"/convert", map[string]any{}, "state_invalid")
	env.mustJSON(t, "POST", "/api/v1/hot-matches/"+safe.ID.String()+"/convert", map[string]any{"title": "人工确认热点选题", "angle": "结合我的真实经历"}, nil)
	env.expectErr(t, "POST", "/api/v1/hot-matches/"+safe.ID.String()+"/convert", map[string]any{}, "state_invalid")
	if topicCount(t, account.ID.String()) != before+1 {
		t.Fatal("single conversion did not add exactly one topic")
	}
	env.expectErr(t, "POST", path+"/hot/refresh", nil, "state_invalid")
	other := env.registerClient(t, "v416-hot-other", testPassword)
	defer other.restore(env)
	other.expectErr(t, "POST", "/api/v1/hot-matches/"+risky.ID.String()+"/dismiss", nil, "not_found")
	other.expectErr(t, "GET", path+"/hot", nil, "not_found")
}

func TestV417HotSuggestUsesRealInputs(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	_, _ = env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL,paused_until=NULL WHERE key='baidu'`)
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{"baidu"}}, nil)
	src, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	account, path := v4Account(t, "真实热点建议")
	opts, _ := positioningOptions(t, path)
	env.mustJSON(t, "POST", path+"/strategy", opts[0], nil)
	env.mustJSON(t, "POST", path+"/hot/refresh", nil, nil)
	before := topicCount(t, account.ID.String())
	var out struct {
		Suggestions []topicSuggestion `json:"suggestions"`
	}
	env.mustJSON(t, "POST", path+"/topics/hot-suggest", map[string]string{"direction": "运营"}, &out)
	if len(out.Suggestions) < 5 || out.Suggestions[0].HotItemID == nil || out.Suggestions[0].SourceURL == "" {
		t.Fatalf("missing real basis %+v", out)
	}
	if topicCount(t, account.ID.String()) != before {
		t.Fatal("suggestions auto-adopted")
	}
	env.mustJSON(t, "POST", path+"/topics", map[string]any{"title": out.Suggestions[0].Title, "source": "hot", "hot_item_id": out.Suggestions[0].HotItemID}, nil)
	env.expectErr(t, "POST", path+"/topics", map[string]any{"title": "虚构引用", "source": "hot", "hot_item_id": "00000000-0000-0000-0000-000000000001"}, "not_found")
	env.srv.cfg.CrawlMode = "off"
	out.Suggestions = nil
	env.mustJSON(t, "POST", path+"/topics/hot-suggest", map[string]string{"context": "用户粘贴资讯"}, &out)
	for _, s := range out.Suggestions {
		if s.HotItemID != nil || s.SourceURL != "" {
			t.Fatal("off injected real hotspots")
		}
	}
}

func loginCrawlAdmin(t *testing.T) {
	t.Helper()
	oldClient, oldCSRF := env.client, env.csrf
	jar, _ := cookiejar.New(nil)
	env.client = &http.Client{Jar: jar, Timeout: time.Minute}
	env.csrf = ""
	t.Cleanup(func() { env.client = oldClient; env.csrf = oldCSRF })
	env.mustJSON(t, "POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword}, nil)
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	env.csrf = me.CSRF
}
func TestV415CrawlSettings(t *testing.T) {
	enableTestCrawl(t)
	env.expectErr(t, "GET", "/api/v1/admin/crawl", nil, "forbidden")
	loginCrawlAdmin(t)
	c := env.srv.loadCrawl(context.Background())
	c.Limits.IntervalMin = 5
	env.expectErr(t, "PUT", "/api/v1/admin/crawl", c, "validation_failed")
	c.Limits.IntervalMin = 60
	c.Limits.DailyRequests = 2001
	env.expectErr(t, "PUT", "/api/v1/admin/crawl", c, "validation_failed")
	c.Limits.DailyRequests = 300
	env.srv.cfg.CrawlMode = "off"
	env.expectErr(t, "PUT", "/api/v1/admin/crawl", c, "state_invalid")
	env.srv.cfg.CrawlMode = "allow"
	env.mustJSON(t, "PUT", "/api/v1/admin/crawl", c, nil)
	env.expectErr(t, "PUT", "/api/v1/admin/crawl/sources/xhs_page", map[string]any{"enabled": true, "interval_min": 60, "max_items": 50}, "state_invalid")
	env.mustJSON(t, "PUT", "/api/v1/admin/crawl/sources/baidu", map[string]any{"enabled": true, "interval_min": 60, "max_items": 50}, nil)
	env.mustJSON(t, "POST", "/api/v1/admin/crawl/sources/baidu/test", nil, nil)
	env.expectErr(t, "POST", "/api/v1/admin/crawl/sources/baidu/test", nil, "state_invalid")
	env.mustJSON(t, "GET", "/api/v1/admin/crawl/runs", nil, nil)
}
func TestV415WorkspaceRSSIsolation(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{}, "rss": []map[string]string{{"name": "行业RSS", "url": "https://example.com/feed"}}}, nil)
	var view struct {
		Sources  []CrawlSource `json:"sources"`
		Selected []string      `json:"selected"`
	}
	env.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &view)
	if len(view.Selected) != 1 {
		t.Fatalf("RSS not selected %+v", view)
	}
	key := view.Selected[0]
	t.Cleanup(func() { _, _ = env.srv.db.Exec(ctx, `DELETE FROM crawl_source WHERE key=$1`, key) })
	other := env.registerClient(t, "v415-rss-other", testPassword)
	defer other.restore(env)
	var second struct {
		Sources []CrawlSource `json:"sources"`
	}
	other.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &second)
	for _, src := range second.Sources {
		if src.Key == key {
			t.Fatal("private RSS leaked")
		}
	}
	other.expectErr(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{key}}, "validation_failed")
	other.expectErr(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{}, "rss": []map[string]string{{"key": key, "name": "overwrite", "url": "https://example.com/feed"}}}, "not_found")
}
func TestE2E20SourceCircuitBreaker(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	calls := 0
	hs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte("User-agent: *\nAllow: /"))
			return
		}
		w.WriteHeader(429)
	}))
	defer hs.Close()
	old := env.srv.cfg.MockListen
	env.srv.cfg.MockListen = strings.TrimPrefix(hs.URL, "http://")
	t.Cleanup(func() { env.srv.cfg.MockListen = old })
	_, err := env.srv.db.Exec(ctx, `UPDATE crawl_source SET enabled=true,last_attempt_at=NULL WHERE key='toutiao'`)
	if err != nil {
		t.Fatal(err)
	}
	src, err := scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='toutiao'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, src); err == nil {
		t.Fatal("429 accepted")
	}
	src, err = scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='toutiao'`))
	if err != nil || src.PausedUntil == nil || src.PausedUntil.Before(env.srv.now().Add(23*time.Hour)) {
		t.Fatalf("pause %+v %v", src, err)
	}
	before := calls
	if _, err = env.srv.collectSource(ctx, src); err != crawl.ErrLimited || calls != before {
		t.Fatal("paused source fetched")
	}
	var n int
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE kind='crawl' AND title LIKE '%toutiao%'`).Scan(&n); err != nil || n == 0 {
		t.Fatalf("missing admin notice %d %v", n, err)
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
		go func() { results <- st.Reserve(ctx, crawl.Source{}, now, 5) }()
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
