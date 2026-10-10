package app

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"net/url"
	"ops/internal/crawl"
	"time"
)

func (s *Server) claimSummary(ctx context.Context, src crawl.Source, now time.Time, l crawl.Limits) error {
	c := s.loadCrawl(ctx)
	if !c.SummaryFetch || c.Level != "standard" || !c.Limits.Enabled {
		return crawl.ErrDisabled
	}
	tag, e := s.db.Exec(ctx, `INSERT INTO crawl_summary_state(source_key,last_attempt_at) SELECT key,$2 FROM crawl_source WHERE key=$1 AND enabled AND coalesce(paused_until,$2)<=$2 ON CONFLICT(source_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at WHERE crawl_summary_state.last_attempt_at<=$2::timestamptz-make_interval(mins=>$3)`, src.Key, now, max(10, l.IntervalMin))
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return crawl.ErrLimited
	}
	return nil
}
func (s *Server) collectSummaries(ctx context.Context) {
	c := s.loadCrawl(ctx)
	if !c.Limits.Enabled || c.Level != "standard" || !c.SummaryFetch {
		return
	}
	// Only selected, currently enabled sources and high-relevance safe matches compete for the small global budget.
	rows, e := s.db.Query(ctx, `SELECT h.id,h.url,h.source_key,max(m.relevance) FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id JOIN crawl_source src ON src.key=h.source_key JOIN platform_account a ON a.id=m.account_id JOIN account_strategy st ON st.account_id=a.id AND st.status='active' JOIN app_setting pref ON pref.workspace_id=a.workspace_id AND pref.key='hot.sources' WHERE m.date=$1::date AND m.relevance>=75 AND m.status='new' AND cardinality(m.risk)=0 AND st.hot_enabled AND src.enabled AND pref.value ? h.source_key AND NOT EXISTS(SELECT 1 FROM unnest(st.blocked_words||st.taboo) w WHERE w<>'' AND h.title ILIKE '%'||w||'%') AND (h.summary_at IS NULL OR h.summary_at<$2) AND NOT EXISTS(SELECT 1 FROM crawl_summary_url u WHERE u.url=h.url AND u.attempt_at>$2) GROUP BY h.id ORDER BY max(m.relevance) DESC LIMIT 20`, s.today(), s.now().Add(-24*time.Hour))
	if e != nil {
		return
	}
	type item struct {
		id       uuid.UUID
		url, key string
		rel      int
	}
	list := []item{}
	for rows.Next() {
		var x item
		if rows.Scan(&x.id, &x.url, &x.key, &x.rel) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, x := range list {
		u, e := url.Parse(x.url)
		if e != nil {
			continue
		}
		if crawl.Sensitive(u.Hostname()) != "" {
			s.queueHotReference(ctx, x.id)
			continue
		}
		endpoint := x.url
		if s.cfg.Dev {
			endpoint = "http://" + s.cfg.MockListen + "/mock/page/summary"
		}
		src := crawl.Source{Key: x.key, Kind: "summary", URL: endpoint}
		var meta crawl.Page
		started := s.now()
		_, out, e := s.crawlClient().ReadValidated(ctx, src, c.Limits, func(b []byte) error { var err error; meta, err = crawl.ParseMetadata(b); return err })
		if errors.Is(e, crawl.ErrLimited) || errors.Is(e, crawl.ErrDisabled) {
			continue
		}
		msg := ""
		if e != nil {
			msg = e.Error()
		}
		_, _ = s.db.Exec(ctx, `INSERT INTO crawl_summary_url(url,attempt_at) VALUES($1,$2) ON CONFLICT(url) DO UPDATE SET attempt_at=excluded.attempt_at`, x.url, s.now())
		_, _ = s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$3,$4,$5,$6,$7)`, x.key, started, s.now(), out.Requests, out.Status, map[bool]int{true: 1}[e == nil], msg)
		if e == nil {
			_, _ = s.db.Exec(ctx, `UPDATE hot_item SET page_title=$2,summary=$3,summary_at=$4 WHERE url=$1`, x.url, meta.Title, meta.Summary, s.now())
		}
	}
}
func (s *Server) queueHotReference(ctx context.Context, hot uuid.UUID) {
	_, _ = s.db.Exec(ctx, `INSERT INTO reference_item(workspace_id,account_id,platform,url,status,error,queued_at) SELECT a.workspace_id,a.id,CASE WHEN h.url ILIKE '%mp.weixin.qq.com%' THEN 'wechat_mp' ELSE 'xhs' END,h.url,$2,$3,$4 FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id JOIN platform_account a ON a.id=m.account_id JOIN account_strategy st ON st.account_id=a.id AND st.status='active' WHERE h.id=$1 AND m.relevance>=75 AND cardinality(m.risk)=0 AND st.hot_enabled AND m.date=$5::date ON CONFLICT(workspace_id,url) DO NOTHING`, hot, map[bool]string{true: "queued", false: "blocked"}[s.cfg.Dev], map[bool]string{true: "", false: "robots 不允许，请手动粘贴正文"}[s.cfg.Dev], s.now(), s.today())
}
