package app

import (
	"context"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"net/url"
	"ops/internal/crawl"
	"strings"
	"time"
)

func (s *Server) adminGetCrawl(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	sources, err := s.crawlSources(r.Context(), nil, true)
	if err != nil {
		return err
	}
	platforms, err := s.crawlPlatforms(r.Context())
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"settings": s.loadCrawl(r.Context()), "sources": sources, "platforms": platforms})
}
func (s *Server) crawlSources(ctx context.Context, ws *uuid.UUID, all bool) ([]CrawlSource, error) {
	rows, err := s.db.Query(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE $1 OR workspace_id IS NULL OR workspace_id=$2 ORDER BY workspace_id NULLS FIRST,key`, all, ws)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []CrawlSource{}
	for rows.Next() {
		x, e := scanCrawlSource(rows)
		if e != nil {
			return nil, e
		}
		list = append(list, x)
	}
	return list, rows.Err()
}
func (s *Server) adminPutCrawl(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireSystemAdmin(ctx); err != nil {
		return err
	}
	var c crawlConfig
	if err := decode(r, &c); err != nil {
		return err
	}
	if c.Level != "off" && c.Level != "conservative" && c.Level != "standard" {
		return validation("采集强度只能为关闭、保守或标准")
	}
	if s.cfg.CrawlMode != "allow" && c.Level != "off" {
		return stateInvalid("部署方未开启热点采集")
	}
	if err := c.Limits.Validate(); err != nil {
		return validation(err.Error())
	}
	if c.RetentionDays < 1 || c.RetentionDays > 60 {
		return validation("热点保留时间为 1–60 天")
	}
	if c.SummaryFetch && c.Level != "standard" {
		return validation("原文摘要仅标准档可开启")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for key, value := range map[string]any{"crawl.level": c.Level, "crawl.limits": c.Limits, "crawl.retention_days": c.RetentionDays, "crawl.summary_fetch": c.SummaryFetch} {
		b, e := json.Marshal(value)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO system_setting(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, b); e != nil {
			return e
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "crawl_settings", "system_setting", "crawl", "ok", map[string]any{"level": c.Level})
	return ok(w, s.loadCrawl(ctx))
}
func (s *Server) adminPutCrawlSource(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireSystemAdmin(ctx); err != nil {
		return err
	}
	key := chi.URLParam(r, "key")
	source, err := scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err != nil {
		return err
	}
	var in struct {
		Enabled     bool `json:"enabled"`
		IntervalMin int  `json:"interval_min"`
		MaxItems    int  `json:"max_items"`
	}
	if err = decode(r, &in); err != nil {
		return err
	}
	if in.IntervalMin < 10 || in.MaxItems < 1 || in.MaxItems > 100 {
		return validation("最短 10 分钟，每次最多 100 条")
	}
	if in.Enabled && !s.loadCrawl(ctx).Limits.Enabled {
		return stateInvalid("请先在部署与全站设置中开启采集")
	}
	if in.Enabled && (source.Kind == "xhs_page" || source.Kind == "wechat_page") {
		return stateInvalid("robots 不允许，敏感平台保持停用")
	}
	_, err = s.db.Exec(ctx, `UPDATE crawl_source SET enabled=$2,interval_min=$3,max_items=$4 WHERE key=$1`, key, in.Enabled, in.IntervalMin, in.MaxItems)
	if err != nil {
		return err
	}
	s.audit(ctx, "crawl_source", "crawl_source", key, "ok", map[string]any{"enabled": in.Enabled})
	return s.adminGetCrawl(w, r)
}
func (s *Server) adminTestCrawlSource(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireSystemAdmin(ctx); err != nil {
		return err
	}
	source, err := scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, chi.URLParam(r, "key")))
	if err != nil {
		return err
	}
	items, err := s.collectSource(ctx, source)
	if err != nil {
		return stateInvalid(err.Error())
	}
	if len(items) > 10 {
		items = items[:10]
	}
	source, _ = scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, source.Key))
	return ok(w, map[string]any{"items": items, "robots_allow": source.RobotsAllow, "source": source})
}
func (s *Server) adminCrawlRuns(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id,source_key,started_at,finished_at,requests,http_status,items,error FROM crawl_run ORDER BY started_at DESC LIMIT 100`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type run struct {
		ID         uuid.UUID  `json:"id"`
		Source     string     `json:"source_key"`
		Started    time.Time  `json:"started_at"`
		Finished   *time.Time `json:"finished_at"`
		Requests   int        `json:"requests"`
		HTTPStatus int        `json:"http_status"`
		Items      int        `json:"items"`
		Error      string     `json:"error"`
	}
	list := []run{}
	for rows.Next() {
		var x run
		if err = rows.Scan(&x.ID, &x.Source, &x.Started, &x.Finished, &x.Requests, &x.HTTPStatus, &x.Items, &x.Error); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}
func (s *Server) workspaceHotSources(ctx context.Context) []string {
	var b []byte
	out := []string{}
	if s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='hot.sources'`, ident(ctx).WorkspaceID).Scan(&b) == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}
func (s *Server) getHotSources(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	sources, err := s.crawlSources(r.Context(), &ws, false)
	if err != nil {
		return err
	}
	visible := []CrawlSource{}
	for _, src := range sources {
		if src.Enabled || src.WorkspaceID != nil {
			visible = append(visible, src)
		}
	}
	return ok(w, map[string]any{"sources": visible, "selected": s.workspaceHotSources(r.Context()), "enabled": s.loadCrawl(r.Context()).Limits.Enabled})
}
func (s *Server) putHotSources(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	var in struct {
		Sources []string `json:"sources"`
		RSS     []struct {
			Key  string `json:"key"`
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"rss"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.RSS) > 10 || len(in.Sources) > 30 {
		return validation("最多 10 个自定义 RSS、30 个来源")
	}
	ws := ident(ctx).WorkspaceID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, rss := range in.RSS {
		u, e := url.Parse(strings.TrimSpace(rss.URL))
		if e != nil || u.Host == "" || u.User != nil || u.Scheme != "https" && u.Scheme != "http" || crawl.Sensitive(u.Hostname()) != "" {
			return validation("RSS 需为普通 HTTP(S) 地址，敏感平台链接请添加为对标参考")
		}
		if strings.TrimSpace(rss.Name) == "" {
			return validation("请填写 RSS 名称")
		}
		key := rss.Key
		if key == "" {
			key = "rss:" + uuid.NewString()
		}
		config, _ := json.Marshal(map[string]string{"url": u.String()})
		tag, e := tx.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,workspace_id,config,enabled) VALUES($1,'rss',$2,$3,$4,true)
   ON CONFLICT(key) DO UPDATE SET name=excluded.name,config=excluded.config WHERE crawl_source.workspace_id=$3 AND crawl_source.kind='rss'`, key, truncateRunes(rss.Name, 50), ws, config)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		if rss.Key == "" {
			in.Sources = append(in.Sources, key)
		}
	}
	selected := cleanList(in.Sources)
	var rssCount int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM crawl_source WHERE workspace_id=$1 AND kind='rss'`, ws).Scan(&rssCount); err != nil {
		return err
	}
	if rssCount > 10 {
		return validation("本工作区最多保存 10 个 RSS")
	}
	for _, key := range selected {
		var allowed bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM crawl_source WHERE key=$1 AND (workspace_id=$2 OR workspace_id IS NULL AND enabled))`, key, ws).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			return validation("只能选择全站已开启或本工作区的来源")
		}
	}
	b, _ := json.Marshal(selected)
	if _, err = tx.Exec(ctx, `UPDATE crawl_source SET enabled=(key=ANY($2::text[])) WHERE workspace_id=$1`, ws, selected); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO app_setting(workspace_id,key,value) VALUES($1,'hot.sources',$2) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value`, ws, b)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.getHotSources(w, r)
}
