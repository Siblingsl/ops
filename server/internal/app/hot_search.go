package app

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"net/http"
	"net/url"
	"ops/internal/ai"
	"ops/internal/crawl"
	"strings"
	"time"
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
func (s *Server) addSearchSource(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if e := s.requireOwner(ctx); e != nil {
		return e
	}
	var in struct {
		ProviderID uuid.UUID `json:"provider_id"`
		Model      string    `json:"model"`
		Query      string    `json:"query"`
	}
	if e := decode(r, &in); e != nil {
		return e
	}
	if strings.TrimSpace(in.Query) == "" || runeLen(in.Query) > 200 {
		return validation("搜索关键词为 1–200 字")
	}
	var base string
	var models []string
	e := s.db.QueryRow(ctx, `SELECT base_url,models FROM model_provider WHERE id=$1 AND workspace_id=$2 AND status='active'`, in.ProviderID, ident(ctx).WorkspaceID).Scan(&base, &models)
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
	key := "search:" + ident(ctx).WorkspaceID.String()
	b, _ := json.Marshal(map[string]string{"provider_id": in.ProviderID.String(), "model": in.Model, "query": strings.TrimSpace(in.Query)})
	_, e = s.db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,workspace_id,config,enabled) VALUES($1,'search','联网搜索',$2,$3,false) ON CONFLICT(key) DO UPDATE SET config=excluded.config,name=excluded.name`, key, ident(ctx).WorkspaceID, b)
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
	pid, e := uuid.Parse(src.Config["provider_id"])
	if e != nil {
		return nil, e
	}
	var base, name string
	var enc []byte
	e = s.db.QueryRow(ctx, `SELECT base_url,name,api_key_enc FROM model_provider WHERE id=$1 AND workspace_id=$2 AND status='active'`, pid, *src.WorkspaceID).Scan(&base, &name, &enc)
	if e != nil {
		return nil, e
	}
	endpoint, ok := s.searchEndpoint(base)
	if !ok {
		return nil, stateInvalid("原生联网搜索接口不受支持")
	}
	key, e := s.box.Decrypt(enc)
	if e != nil {
		return nil, e
	}
	source := crawl.Source{Key: src.Key, Kind: "search", URL: endpoint}
	st := crawlStore{s}
	now := s.now()
	if e = st.Claim(ctx, source, now, lim); e != nil {
		return nil, e
	}
	if !s.loadCrawl(ctx).Limits.Enabled {
		return nil, crawl.ErrDisabled
	}
	if e = st.Reserve(ctx, source, now, lim.DailyRequests); e != nil {
		return nil, e
	}
	started := time.Now()
	results, usage, e := ai.Search(jctx, s.aiHTTP, endpoint, key, src.Config["model"], src.Config["query"])
	out := crawl.Outcome{Requests: 1, RobotsAllow: true, Status: 200}
	if e != nil {
		out.Error = e.Error()
		out.Status = 0
		var upstream *ai.SearchHTTPError
		if errors.As(e, &upstream) {
			out.Status = upstream.Status
			out.Paused = upstream.Status == 403 || upstream.Status == 429
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
			items = append(items, crawl.Item{Title: truncateRunes(r.Title, 200), URL: r.URL, Rank: len(items) + 1})
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
	refs, _ := json.Marshal(map[string]any{"source_key": src.Key, "native_search": true, "results": len(items)})
	_, _ = s.db.Exec(ctx, `INSERT INTO ai_call(workspace_id,task_type,provider,model,context_refs,prompt_tokens,completion_tokens,latency_ms,status,error) VALUES($1,'hot_search',$2,$3,$4,$5,$6,$7,$8,$9)`, src.WorkspaceID, name, src.Config["model"], refs, usage.PromptTokens, usage.CompletionTokens, int(time.Since(started).Milliseconds()), status, msg)
	_, _ = s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$3,1,$4,$5,$6)`, src.Key, now, s.now(), out.Status, len(items), msg)
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
