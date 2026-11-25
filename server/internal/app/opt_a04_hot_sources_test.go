package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ops/internal/ai"
	"ops/internal/crawl"
)

type optA04Transport func(*http.Request) (*http.Response, error)

func (f optA04Transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func optA04Guest(t *testing.T) (*guestClient, uuid.UUID) {
	t.Helper()
	g := env.registerClient(t, "opt-a04-"+uuid.NewString(), testPassword)
	t.Cleanup(func() { g.restore(env) })
	var me struct {
		Workspace struct {
			ID uuid.UUID `json:"id"`
		} `json:"workspace"`
	}
	g.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM crawl_source WHERE workspace_id=$1`, me.Workspace.ID)
	})
	return g, me.Workspace.ID
}

func TestOPTA04HotSourcesExposePresets(t *testing.T) {
	var view struct {
		Presets  []crawl.PresetSource `json:"presets"`
		Sources  []CrawlSource        `json:"sources"`
		Selected []string             `json:"selected"`
	}
	env.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &view)
	if len(view.Presets) != 5 {
		t.Fatalf("presets = %d", len(view.Presets))
	}
	for _, p := range view.Presets {
		if p.Kind != "rss" || p.URL == "" || p.Name == "" || p.Category == "" {
			t.Fatalf("preset %+v", p)
		}
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM crawl_source WHERE key LIKE 'preset:%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("presets must not be persisted: %d %v", n, err)
	}
}

func TestOPTA04SearchSourceEncryptsKeyAndSanitizesResponses(t *testing.T) {
	g, ws := optA04Guest(t)
	const secret = "tvly-secret-key-opt-a04"
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "tavily", "query": "运营观察", "api_key": secret}, nil)
	key := "search:" + ws.String()
	var raw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT config FROM crawl_source WHERE key=$1`, key).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Fatal("api key stored in plaintext")
	}
	var cfg map[string]string
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["engine"] != "tavily" || cfg["api_key_enc"] == "" || cfg["base_url"] != "https://api.tavily.com/search" {
		t.Fatalf("external config %+v", cfg)
	}
	var view struct {
		Sources []CrawlSource `json:"sources"`
	}
	g.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &view)
	var src CrawlSource
	for _, x := range view.Sources {
		if x.Key == key {
			src = x
		}
	}
	if src.Config["has_api_key"] != "true" {
		t.Fatalf("has_api_key = %q", src.Config["has_api_key"])
	}
	if _, ok := src.Config["api_key_enc"]; ok {
		t.Fatal("api_key_enc leaked to client")
	}
	if strings.Contains(string(mustJSONBytes(t, view)), secret) {
		t.Fatal("plaintext key leaked to response")
	}
	oldCipher := cfg["api_key_enc"]
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "tavily", "query": "改关键词", "api_key": ""}, nil)
	if err := env.srv.db.QueryRow(context.Background(), `SELECT config FROM crawl_source WHERE key=$1`, key).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["api_key_enc"] != oldCipher || cfg["query"] != "改关键词" {
		t.Fatalf("empty key must reuse cipher: %+v", cfg)
	}
	g.expectErr(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "bocha", "query": "换引擎", "api_key": ""}, "validation_failed")
	g.expectErr(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "tavily", "query": "第三方", "api_key": "k", "base_url": "https://evil.example.com/search"}, "validation_failed")
}

func TestOPTA04ExternalSearchCollectAndCircuitBreaker(t *testing.T) {
	enableTestCrawl(t)
	g, ws := optA04Guest(t)
	a, _ := v4Account(t, "OPT A04 外部搜索")
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "tavily", "query": "运营案例", "api_key": "tvly-test-key"}, nil)
	var view struct {
		Sources []CrawlSource `json:"sources"`
	}
	g.mustJSON(t, "GET", "/api/v1/hot-sources", nil, &view)
	var visible CrawlSource
	for _, x := range view.Sources {
		if x.Kind == "search" && x.WorkspaceID != nil && *x.WorkspaceID == ws {
			visible = x
		}
	}
	if visible.Key == "" {
		t.Fatal("search source missing")
	}
	g.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{visible.Key}}, nil)
	// 对外接口必须脱敏，采集必须读取库内真实配置（含密文）。
	src, err := scanCrawlSource(env.srv.db.QueryRow(context.Background(), `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, visible.Key))
	if err != nil {
		t.Fatal(err)
	}
	old := env.srv.aiHTTP
	t.Cleanup(func() { env.srv.aiHTTP = old })
	calls := 0
	env.srv.aiHTTP = &http.Client{Transport: optA04Transport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api.tavily.com/search" {
			t.Errorf("unexpected endpoint %s", r.URL)
		}
		body := `{"results":[{"title":"公开热点一","url":"https://example.com/one","content":"公开摘要一"},{"title":"内网链接","url":"http://127.0.0.1/admin","content":"不应入库"}]}`
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	items, err := env.srv.collectSource(context.Background(), src)
	if err != nil || len(items) != 1 || items[0].URL != "https://example.com/one" || items[0].Summary != "公开摘要一" {
		t.Fatalf("external collect %+v %v", items, err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
	var provider, model string
	if err = env.srv.db.QueryRow(context.Background(), `SELECT provider,model FROM ai_call WHERE task_type='hot_search' AND workspace_id=$1 ORDER BY id DESC LIMIT 1`, ws).Scan(&provider, &model); err != nil {
		t.Fatal(err)
	}
	if provider != "Tavily" || model != "tavily" {
		t.Fatalf("external telemetry provider=%q model=%q", provider, model)
	}
	key := "search:402:" + a.ID.String()
	config, _ := json.Marshal(map[string]string{"engine": "bocha", "query": "熔断", "base_url": "https://api.bochaai.com/v1/web-search"})
	if _, err = env.srv.db.Exec(context.Background(), `INSERT INTO crawl_source(key,kind,name,enabled,workspace_id,config) VALUES($1,'search','外部搜索熔断',true,$2,$3)`, key, ws, config); err != nil {
		t.Fatal(err)
	}
	broken, err := scanCrawlSource(env.srv.db.QueryRow(context.Background(), `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err != nil {
		t.Fatal(err)
	}
	env.srv.aiHTTP = &http.Client{Transport: optA04Transport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 402, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("quota-body-must-not-log")), Request: r}, nil
	})}
	_, err = env.srv.collectSource(context.Background(), broken)
	upstream, ok := err.(*ai.SearchHTTPError)
	if !ok || upstream.Status != 402 {
		t.Fatalf("upstream err %v", err)
	}
	var pause time.Time
	var msg string
	if err = env.srv.db.QueryRow(context.Background(), `SELECT src.paused_until, r.error FROM crawl_run r JOIN crawl_source src ON src.key=r.source_key WHERE src.key=$1`, key).Scan(&pause, &msg); err != nil {
		t.Fatal(err)
	}
	if pause.Before(env.srv.now().Add(23*time.Hour)) || strings.Contains(msg, "quota-body") {
		t.Fatalf("pause/log %s %q", pause, msg)
	}
	if !strings.Contains(msg, "额度耗尽") {
		t.Fatalf("error message %q", msg)
	}
}

func TestOPTA04SearxngEndpointRules(t *testing.T) {
	g, ws := optA04Guest(t)
	g.expectErr(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "searxng", "query": "科技", "base_url": "http://127.0.0.1:8080/search"}, "validation_failed")
	g.expectErr(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "searxng", "query": "科技", "base_url": ""}, "validation_failed")
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "searxng", "query": "科技", "base_url": "https://example.com"}, nil)
	var raw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT config FROM crawl_source WHERE key=$1`, "search:"+ws.String()).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var cfg map[string]string
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["engine"] != "searxng" || cfg["base_url"] != "https://example.com/search" {
		t.Fatalf("searxng config %+v", cfg)
	} // SearXNG 的密钥可选，未填写时不得伪造密文。
	if cfg["api_key_enc"] != "" {
		t.Fatalf("unexpected cipher %q", cfg["api_key_enc"])
	}
}

func TestOPTA04AdminCrawlSanitizesSearchKey(t *testing.T) {
	g, ws := optA04Guest(t)
	const secret = "bocha-admin-secret-opt-a04"
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "bocha", "query": "商业观察", "api_key": secret}, nil)
	g.restore(env)
	loginCrawlAdmin(t)
	var view struct {
		Sources []CrawlSource `json:"sources"`
	}
	env.mustJSON(t, "GET", "/api/v1/admin/crawl", nil, &view)
	found := false
	for _, src := range view.Sources {
		if src.Kind != "search" || src.WorkspaceID == nil || *src.WorkspaceID != ws {
			continue
		}
		found = true
		if src.Config["has_api_key"] != "true" {
			t.Fatalf("search source missing has_api_key: %+v", src.Config)
		}
		if _, ok := src.Config["api_key_enc"]; ok {
			t.Fatal("admin response leaked api_key_enc")
		}
	}
	if !found {
		t.Fatal("admin response missing search source")
	}
	if strings.Contains(string(mustJSONBytes(t, view)), secret) {
		t.Fatal("admin response leaked plaintext key")
	}
}

func TestOPTA04ExternalSearchRespectsCrawlOff(t *testing.T) {
	enableTestCrawl(t)
	g, ws := optA04Guest(t)
	g.mustJSON(t, "POST", "/api/v1/hot-sources/search", map[string]any{"engine": "tavily", "query": "运营案例", "api_key": "tvly-off-key"}, nil)
	key := "search:" + ws.String()
	g.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{key}}, nil)
	src, err := scanCrawlSource(env.srv.db.QueryRow(context.Background(), `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err != nil {
		t.Fatal(err)
	}
	old := env.srv.aiHTTP
	t.Cleanup(func() { env.srv.aiHTTP = old })
	calls := 0
	env.srv.aiHTTP = &http.Client{Transport: optA04Transport(func(r *http.Request) (*http.Response, error) {
		calls++
		return nil, io.EOF
	})}
	ctx := context.Background()
	oldMode := env.srv.cfg.CrawlMode
	env.srv.cfg.CrawlMode = "off"
	env.srv.crawler = nil
	if _, err = env.srv.collectSource(ctx, src); err != crawl.ErrDisabled || calls != 0 {
		t.Fatalf("crawl_mode=off must not fetch: err=%v calls=%d", err, calls)
	}
	env.srv.cfg.CrawlMode = "allow"
	env.srv.crawler = nil
	if _, err = env.srv.db.Exec(ctx, `UPDATE system_setting SET value='"off"' WHERE key='crawl.level'`); err != nil {
		t.Fatal(err)
	}
	if _, err = env.srv.collectSource(ctx, src); err != crawl.ErrDisabled || calls != 0 {
		t.Fatalf("crawl.level=off must not fetch: err=%v calls=%d", err, calls)
	}
	if _, err = env.srv.db.Exec(ctx, `UPDATE system_setting SET value='"conservative"' WHERE key='crawl.level'`); err != nil {
		t.Fatal(err)
	}
	env.srv.cfg.CrawlMode = oldMode
	var runs int
	if err = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM crawl_run WHERE source_key=$1`, key).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("off mode wrote crawl_run: %d %v", runs, err)
	}
}

func TestOPTA04SearxngRuntimeRejectsTamperedSensitiveURL(t *testing.T) {
	enableTestCrawl(t)
	_, ws := optA04Guest(t)
	key := "opt-a04-searxng:" + uuid.NewString()
	config, _ := json.Marshal(map[string]string{"engine": "searxng", "query": "科技", "base_url": "https://mp.weixin.qq.com/search"})
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO crawl_source(key,kind,name,enabled,workspace_id,config) VALUES($1,'search','被改写的 SearXNG',true,$2,$3)`, key, ws, config); err != nil {
		t.Fatal(err)
	}
	src, err := scanCrawlSource(env.srv.db.QueryRow(context.Background(), `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err != nil {
		t.Fatal(err)
	}
	old := env.srv.aiHTTP
	t.Cleanup(func() { env.srv.aiHTTP = old })
	calls := 0
	env.srv.aiHTTP = &http.Client{Transport: optA04Transport(func(r *http.Request) (*http.Response, error) {
		calls++
		return nil, io.EOF
	})}
	_, err = env.srv.collectSource(context.Background(), src)
	if err == nil || !strings.Contains(err.Error(), "不被允许") || calls != 0 {
		t.Fatalf("tampered searxng must be rejected before request: err=%v calls=%d", err, calls)
	}
	var runs int
	if err = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM crawl_run WHERE source_key=$1`, key).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("rejected source wrote crawl_run: %d %v", runs, err)
	}
}

func TestOPTA04ClassifyHotSourceIssue(t *testing.T) {
	now := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		error string
		code  string
	}{
		{"来源返回 HTTP 429", "rate_or_quota"},
		{"搜索额度已耗尽", "rate_or_quota"},
		{"触发限流", "rate_or_quota"},
		{"来源返回 HTTP 403", "blocked"},
		{"robots 不允许", "blocked"},
		{"需要验证码", "blocked"},
		{"dial tcp: i/o timeout", "unreachable"},
	} {
		issue, ok := classifyHotSourceIssue(CrawlSource{Key: "k", Name: "n", Error: tc.error}, now)
		if !ok || issue.Code != tc.code {
			t.Fatalf("%q => %+v %v", tc.error, issue, ok)
		}
		if issue.Reason == "" || issue.Error != tc.error {
			t.Fatalf("issue %+v", issue)
		}
	}
	if _, ok := classifyHotSourceIssue(CrawlSource{Key: "ok", Error: "  "}, now); ok {
		t.Fatal("healthy source flagged")
	}
	paused := now.Add(24 * time.Hour)
	issue, ok := classifyHotSourceIssue(CrawlSource{Key: "p", Name: "暂停源", PausedUntil: &paused}, now)
	if !ok || issue.PausedUntil == nil {
		t.Fatalf("paused issue %+v %v", issue, ok)
	}
	stale := now.Add(-time.Hour)
	if _, ok := classifyHotSourceIssue(CrawlSource{Key: "s", Error: "", PausedUntil: &stale}, now); ok {
		t.Fatal("expired pause flagged")
	}
}

func TestOPTA04AccountHotExposesSelectedSourceIssues(t *testing.T) {
	enableTestCrawl(t)
	g, ws := optA04Guest(t)
	_, path := v4Account(t, "OPT A04 异常来源")
	key := "opt-a04-issue:" + uuid.NewString()
	paused := env.srv.now().Add(24 * time.Hour)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO crawl_source(key,kind,name,enabled,workspace_id,config,error,paused_until) VALUES($1,'rss','本地异常源',true,$2,$3,$4,$5)`, key, ws, `{"url":"https://example.com/feed"}`, "来源返回 HTTP 429", paused); err != nil {
		t.Fatal(err)
	}
	g.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{key}}, nil)
	var out struct {
		Paused  []string         `json:"paused_sources"`
		Issues  []HotSourceIssue `json:"source_issues"`
		Enabled bool             `json:"enabled"`
	}
	g.mustJSON(t, "GET", path+"/hot?prepare=false", nil, &out)
	if len(out.Issues) != 1 || out.Issues[0].Key != key || out.Issues[0].Code != "rate_or_quota" {
		t.Fatalf("issues %+v", out.Issues)
	}
	if len(out.Paused) != 1 || out.Paused[0] != "本地异常源" {
		t.Fatalf("paused %+v", out.Paused)
	}
	if out.Issues[0].PausedUntil == nil || !strings.Contains(out.Issues[0].Reason, "额度") {
		t.Fatalf("issue detail %+v", out.Issues[0])
	}
}
