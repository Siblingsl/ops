package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"ops/internal/ai"
	"ops/internal/crawl"
)

func (s *Server) searchEndpoint(base string) (string, bool) {
	u, e := url.Parse(base)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	if s.cfg.Dev && u.Host == s.cfg.MockListen {
		return "http://" + s.cfg.MockListen + "/v1/search", true
	}
	if u.Scheme == "https" && u.Host == "ark.cn-beijing.volces.com" && strings.HasPrefix(u.Path, "/api/v3") {
		u.Path = "/api/v3/responses"
		return u.String(), true
	}
	if u.Scheme != "https" || u.Port() != "" || !(u.Hostname() == "dashscope.aliyuncs.com" || u.Hostname() == "dashscope-intl.aliyuncs.com" || strings.HasSuffix(u.Hostname(), ".maas.aliyuncs.com")) {
		return "", false
	}
	u.Path = "/api/v1/services/aigc/text-generation/generation"
	return u.String(), true
}

func searchEngineLabel(engine string) string {
	switch engine {
	case "tavily":
		return "Tavily"
	case "bocha":
		return "博查"
	case "searxng":
		return "SearXNG"
	default:
		return "原生模型"
	}
}

func externalSearchOfficial(engine string) (string, bool) {
	switch engine {
	case "tavily":
		return "https://api.tavily.com/search", true
	case "bocha":
		return "https://api.bochaai.com/v1/web-search", true
	}
	return "", false
}

// externalSearchEndpoint 固定官方接口，拒绝任何自定义第三方地址，避免 API Key 外泄。
// 仅当 Dev 且 host 等于本地 mock 监听地址时才允许测试地址。
func (s *Server) externalSearchEndpoint(engine, base string) (string, error) {
	official, ok := externalSearchOfficial(engine)
	if !ok {
		return "", validation("该搜索方式没有官方固定接口")
	}
	trimmed := strings.TrimSpace(base)
	if trimmed == "" {
		return official, nil
	}
	u, e := url.Parse(trimmed)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", validation("搜索服务地址格式不正确")
	}
	if s.cfg.Dev && u.Host == s.cfg.MockListen {
		if u.Scheme != "http" {
			return "", validation("本地 mock 搜索地址必须使用 HTTP")
		}
		return u.String(), nil
	}
	if strings.TrimSuffix(trimmed, "/") != official {
		return "", validation("为防 API Key 外泄，" + searchEngineLabel(engine) + " 仅支持官方接口 " + official)
	}
	return official, nil
}

// searxngEndpoint 校验实例地址并补全 /search；强制 HTTPS（Dev 本地 mock 例外），
// 并通过统一采集客户端拒绝内网、保留 IP、凭据与敏感域名。
func (s *Server) searxngEndpoint(base string) (string, error) {
	trimmed := strings.TrimSpace(base)
	if trimmed == "" {
		return "", validation("SearXNG 需要填写实例地址，例如 https://searx.example.com")
	}
	u, e := url.Parse(trimmed)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", validation("SearXNG 实例地址格式不正确")
	}
	if u.Scheme != "https" && !(s.cfg.Dev && u.Scheme == "http" && u.Host == s.cfg.MockListen) {
		return "", validation("SearXNG 实例地址必须使用 HTTPS（本地开发 mock 除外）")
	}
	endpoint := strings.TrimSuffix(u.String(), "/")
	if !strings.HasSuffix(endpoint, "/search") {
		endpoint += "/search"
	}
	if _, e = s.crawlClient().ValidateLink(endpoint); e != nil {
		return "", validation("SearXNG 实例地址不可用，请填写公网 HTTPS 地址")
	}
	// ValidateLink 对敏感平台链接按“证据链”放行；搜索实例不应落在敏感平台域名上。
	if p := crawl.Sensitive(u.Hostname()); p != "" {
		return "", validation("SearXNG 实例地址不能使用敏感平台域名")
	}
	return endpoint, nil
}

// searchSourceConfig 读取工作区既有搜索源配置，用于同引擎更新时沿用旧密文。
func (s *Server) searchSourceConfig(ctx context.Context, ws uuid.UUID) map[string]string {
	cfg := map[string]string{}
	var b []byte
	if s.db.QueryRow(ctx, `SELECT config FROM crawl_source WHERE key=$1`, "search:"+ws.String()).Scan(&b) == nil && len(b) > 0 {
		_ = json.Unmarshal(b, &cfg)
	}
	return cfg
}

// searchAPIKeyCipher 加密 API Key；留空时仅在同一个引擎下沿用旧密文，绝不接受明文落库。
func (s *Server) searchAPIKeyCipher(incoming string, previous map[string]string, sameEngine, required bool) (string, error) {
	trimmed := strings.TrimSpace(incoming)
	if trimmed == "" {
		if sameEngine && previous["api_key_enc"] != "" {
			return previous["api_key_enc"], nil
		}
		if required {
			return "", validation("请填写搜索服务 API Key")
		}
		return "", nil
	}
	enc, e := s.box.Encrypt(trimmed)
	if e != nil {
		return "", e
	}
	return base64.StdEncoding.EncodeToString(enc), nil
}

// externalSearchHTTPClient 复用测试注入的 Transport；否则构造带公网拨号与跨域重定向拦截的客户端。
func (s *Server) externalSearchHTTPClient() *http.Client {
	if s.aiHTTP != nil && s.aiHTTP.Transport != nil {
		return s.aiHTTP
	}
	local := ""
	if s.cfg.Dev {
		local = s.cfg.MockListen
	}
	return &http.Client{
		Transport: &http.Transport{Proxy: nil, ResponseHeaderTimeout: 15 * time.Second, DialContext: crawl.PublicDialContext(local)},
		Timeout:   25 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 || req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {
				return errors.New("不读取跨域重定向")
			}
			return http.ErrUseLastResponse
		},
	}
}

func (s *Server) addSearchSource(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if e := s.requireOwner(ctx); e != nil {
		return e
	}
	var in struct {
		ProviderID uuid.UUID `json:"provider_id"`
		Model      string    `json:"model"`
		Query      string    `json:"query"`
		Engine     string    `json:"engine"`
		BaseURL    string    `json:"base_url"`
		APIKey     string    `json:"api_key"`
	}
	if e := decode(r, &in); e != nil {
		return e
	}
	query := strings.TrimSpace(in.Query)
	if query == "" || runeLen(query) > 200 {
		return validation("搜索关键词为 1–200 字")
	}
	engine := strings.ToLower(strings.TrimSpace(in.Engine))
	if engine == "" {
		engine = "native"
	}
	ws := ident(ctx).WorkspaceID
	key := "search:" + ws.String()
	config := map[string]string{}
	name := "联网搜索"
	switch engine {
	case "native":
		var base string
		var models []string
		e := s.db.QueryRow(ctx, `SELECT base_url,models FROM model_provider WHERE id=$1 AND workspace_id=$2 AND execution_location='server' AND status='active'`, in.ProviderID, ws).Scan(&base, &models)
		if e != nil {
			return e
		}
		if _, ok := s.searchEndpoint(base); !ok {
			return validation("此服务尚无已核验的原生联网搜索契约；目前支持百炼 DashScope 与火山方舟 Responses")
		}
		exists := false
		for _, m := range models {
			if m == in.Model {
				exists = true
			}
		}
		supported := s.cfg.Dev && strings.HasPrefix(in.Model, "mock-")
		for _, prefix := range []string{"qwen-plus", "qwen-turbo", "qwen-max", "qwen3-max"} {
			supported = supported || strings.HasPrefix(in.Model, prefix)
		}
		if u, _ := url.Parse(base); u != nil && u.Hostname() == "ark.cn-beijing.volces.com" {
			supported = strings.HasPrefix(in.Model, "doubao-") || strings.HasPrefix(in.Model, "ep-")
		}
		if !exists || !supported {
			return validation("请选择供应商已配置、支持原生文本联网搜索的模型（如 qwen-plus）")
		}
		config = map[string]string{"provider_id": in.ProviderID.String(), "model": in.Model, "query": query}
	case "tavily", "bocha":
		endpoint, e := s.externalSearchEndpoint(engine, in.BaseURL)
		if e != nil {
			return e
		}
		previous := s.searchSourceConfig(ctx, ws)
		cipher, e := s.searchAPIKeyCipher(in.APIKey, previous, previous["engine"] == engine, true)
		if e != nil {
			return e
		}
		config = map[string]string{"engine": engine, "query": query, "base_url": endpoint, "api_key_enc": cipher}
		name = "联网搜索（" + searchEngineLabel(engine) + "）"
	case "searxng":
		endpoint, e := s.searxngEndpoint(in.BaseURL)
		if e != nil {
			return e
		}
		previous := s.searchSourceConfig(ctx, ws)
		cipher, e := s.searchAPIKeyCipher(in.APIKey, previous, previous["engine"] == engine, false)
		if e != nil {
			return e
		}
		config = map[string]string{"engine": engine, "query": query, "base_url": endpoint}
		if cipher != "" {
			config["api_key_enc"] = cipher
		}
		name = "联网搜索（SearXNG）"
	default:
		return validation("搜索方式仅支持原生模型搜索、Tavily、博查或 SearXNG")
	}
	b, _ := json.Marshal(config)
	_, e := s.db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,workspace_id,config,enabled) VALUES($1,'search',$2,$3,$4,false) ON CONFLICT(key) DO UPDATE SET config=excluded.config,name=excluded.name`, key, name, ws, b)
	if e != nil {
		return e
	}
	return s.getHotSources(w, r)
}

func (s *Server) collectSearch(ctx context.Context, src CrawlSource, lim crawl.Limits) ([]crawl.Item, error) {
	if src.WorkspaceID == nil {
		return nil, validation("联网搜索来源必须属于工作区")
	}
	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: *src.WorkspaceID, Role: "owner"})
	if e := s.checkLimit(jctx); e != nil {
		return nil, e
	}
	engine := strings.ToLower(strings.TrimSpace(src.Config["engine"]))
	if engine == "" {
		engine = "native"
	}
	var endpoint, apiKey, providerName, model string
	switch engine {
	case "native":
		pid, e := uuid.Parse(src.Config["provider_id"])
		if e != nil {
			return nil, e
		}
		var base string
		var enc []byte
		e = s.db.QueryRow(ctx, `SELECT base_url,name,api_key_enc FROM model_provider WHERE id=$1 AND workspace_id=$2 AND execution_location='server' AND status='active'`, pid, *src.WorkspaceID).Scan(&base, &providerName, &enc)
		if e != nil {
			return nil, e
		}
		var ok bool
		endpoint, ok = s.searchEndpoint(base)
		if !ok {
			return nil, stateInvalid("原生联网搜索接口不受支持")
		}
		apiKey, e = s.box.Decrypt(enc)
		if e != nil {
			return nil, e
		}
		model = src.Config["model"]
	case "tavily", "bocha", "searxng":
		endpoint = strings.TrimSpace(src.Config["base_url"])
		if endpoint == "" {
			official, ok := externalSearchOfficial(engine)
			if !ok {
				return nil, stateInvalid("联网搜索来源缺少实例地址")
			}
			endpoint = official
		}
		if engine != "searxng" {
			// 运行期再校验一次，避免库内配置被改写后把 API Key 发往第三方地址。
			official, e2 := s.externalSearchEndpoint(engine, endpoint)
			if e2 != nil {
				return nil, stateInvalid("搜索来源地址不被允许，请重新保存配置")
			}
			endpoint = official
		} else {
			// 运行期同样走实例校验：拒绝内网、凭据与敏感域名，而不仅依赖保存时的检查。
			normalized, e2 := s.searxngEndpoint(endpoint)
			if e2 != nil {
				return nil, stateInvalid("SearXNG 实例地址不被允许，请重新保存配置")
			}
			endpoint = normalized
		}
		if cipher := strings.TrimSpace(src.Config["api_key_enc"]); cipher != "" {
			raw, e := base64.StdEncoding.DecodeString(cipher)
			if e != nil {
				return nil, stateInvalid("搜索密钥无法读取，请重新填写")
			}
			apiKey, e = s.box.Decrypt(raw)
			if e != nil {
				return nil, stateInvalid("搜索密钥无法解密，请重新填写")
			}
		}
		providerName = searchEngineLabel(engine)
		model = engine
	default:
		return nil, stateInvalid("联网搜索方式不受支持")
	}
	source := crawl.Source{Key: src.Key, Kind: "search", URL: endpoint}
	st := crawlStore{s}
	now := s.now()
	if e := st.Claim(ctx, source, now, lim); e != nil {
		return nil, e
	}
	if !s.loadCrawl(ctx).Limits.Enabled {
		return nil, crawl.ErrDisabled
	}
	if e := st.Reserve(ctx, source, now, lim.DailyRequests); e != nil {
		return nil, e
	}
	started := s.now()
	var results []ai.SearchResult
	var usage ai.Usage
	var e error
	if engine == "native" {
		results, usage, e = ai.Search(jctx, s.aiHTTP, endpoint, apiKey, model, src.Config["query"])
	} else {
		results, e = ai.SearchExternal(jctx, s.externalSearchHTTPClient(), ai.ExternalSearchRequest{Engine: engine, Endpoint: endpoint, APIKey: apiKey, Query: src.Config["query"], UserAgent: crawl.UserAgent})
	}
	out := crawl.Outcome{Requests: 1, RobotsAllow: true, Status: 200}
	if e != nil {
		out.Error = e.Error()
		out.Status = 0
		var upstream *ai.SearchHTTPError
		if errors.As(e, &upstream) {
			out.Status = upstream.Status
			out.Paused = upstream.Status == 402 || upstream.Status == 403 || upstream.Status == 429
		}
	}
	items := []crawl.Item{}
	seen := map[string]bool{}
	if e == nil {
		for _, r := range results {
			u, err := url.Parse(r.URL)
			if err != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" || r.Title == "" || seen[r.URL] {
				continue
			}
			if _, err = s.crawlClient().ValidateLink(r.URL); err != nil {
				continue
			}
			seen[r.URL] = true
			items = append(items, crawl.Item{Title: truncateRunes(r.Title, 200), URL: r.URL, Summary: truncateRunes(r.Summary, 500), Rank: len(items) + 1})
			if len(items) >= lim.MaxItems {
				break
			}
		}
		if len(items) == 0 {
			e = stateInvalid("没有有效公开链接的搜索结果")
			out.Error = e.Error()
		}
	}
	st.Finish(ctx, source, now, lim, out)
	status, msg := "ok", ""
	if e != nil {
		status, msg = "failed", e.Error()
	}
	refs := map[string]any{"source_key": src.Key, "results": len(items)}
	if engine == "native" {
		refs["native_search"] = true
	} else {
		refs["engine"] = engine
		refs["external_search"] = true
	}
	refsJSON, _ := json.Marshal(refs)
	s.recordHotSearchTelemetry(ctx, src, providerName, model, refsJSON, usage, started, now, out, len(items), status, msg)
	if e != nil {
		return nil, e
	}
	for _, item := range items {
		if e = s.storeHotItem(ctx, src, item); e != nil {
			return nil, e
		}
	}
	return items, nil
}

// recordHotSearchTelemetry：搜索用量与 crawl_run best-effort 落库；失败 Error 可观测（BE-02）。
func (s *Server) recordHotSearchTelemetry(ctx context.Context, src CrawlSource, provider, model string, refs []byte, usage ai.Usage, started, now time.Time, out crawl.Outcome, itemCount int, status, msg string) {
	if _, err := s.db.Exec(ctx, `INSERT INTO ai_call(workspace_id,task_type,provider,model,context_refs,prompt_tokens,completion_tokens,latency_ms,status,error) VALUES($1,'hot_search',$2,$3,$4,$5,$6,$7,$8,$9)`, src.WorkspaceID, provider, model, refs, usage.PromptTokens, usage.CompletionTokens, int(s.now().Sub(started).Milliseconds()), status, msg); err != nil {
		s.observeFailure(ctx, slog.LevelError, "热点搜索用量落库失败", observeFields{
			Action: "hot_search_ai_call", TargetType: "crawl_source", TargetID: src.Key,
			ErrorCode: "hot_search_ai_call_failed", Route: "internal/crawl/hot_search",
			Started: started, Extras: map[string]any{"err": err.Error()},
		})
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$3,1,$4,$5,$6)`, src.Key, now, s.now(), out.Status, itemCount, msg); err != nil {
		s.observeFailure(ctx, slog.LevelError, "热点搜索运行记录落库失败", observeFields{
			Action: "hot_search_run_log", TargetType: "crawl_source", TargetID: src.Key,
			ErrorCode: "hot_search_run_log_failed", Route: "internal/crawl/hot_search",
			Started: started, Extras: map[string]any{"err": err.Error()},
		})
	}
}
