package app

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/crawl"
)

func (s *Server) claimSummary(ctx context.Context, src crawl.Source, now time.Time, l crawl.Limits) error {
	c := s.loadCrawl(ctx)
	if !c.SummaryFetch || c.Level != "standard" || !c.Limits.Enabled {
		return crawl.ErrDisabled
	}
	tag, e := s.db.Exec(ctx, `INSERT INTO crawl_summary_state(source_key,last_attempt_at) SELECT key,$2 FROM crawl_source WHERE key=$1 AND enabled AND coalesce(paused_until,$2)<=$2 ON CONFLICT(source_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at WHERE crawl_summary_state.last_attempt_at<=$2::timestamptz-make_interval(mins=>GREATEST($3,(SELECT interval_min FROM crawl_source WHERE key=$1)))`, src.Key, now, max(10, l.IntervalMin))
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return crawl.ErrLimited
	}
	return nil
}
func (s *Server) collectSummaries(ctx context.Context) {
	// 配置读取不跟批采 ctx 绑定：父 ctx 已取消时仍要能判定开关，再如实观测候选查询失败。
	c := s.loadCrawl(context.WithoutCancel(ctx))
	if !c.Limits.Enabled || c.Level != "standard" || !c.SummaryFetch {
		return
	}
	// Only selected, currently enabled sources and high-relevance safe matches compete for the small global budget.
	rows, e := s.db.Query(ctx, `SELECT h.id,h.url,h.source_key,max(m.relevance) FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id JOIN crawl_source src ON src.key=h.source_key JOIN platform_account a ON a.id=m.account_id JOIN account_strategy st ON st.account_id=a.id AND st.status='active' JOIN app_setting pref ON pref.workspace_id=a.workspace_id AND pref.key='hot.sources' WHERE m.date=$1::date AND m.relevance>=75 AND m.status='new' AND cardinality(m.risk)=0 AND st.hot_enabled AND src.enabled AND pref.value ? h.source_key AND NOT EXISTS(SELECT 1 FROM unnest(st.blocked_words||st.taboo) w WHERE w<>'' AND h.title ILIKE '%'||w||'%') AND (h.summary_at IS NULL OR h.summary_at<$2) AND NOT EXISTS(SELECT 1 FROM crawl_summary_url u WHERE u.url=h.url AND u.attempt_at>$2) GROUP BY h.id ORDER BY max(m.relevance) DESC LIMIT 20`, s.today(), s.now().Add(-24*time.Hour))
	if e != nil {
		s.observeFailure(ctx, slog.LevelWarn, "热点摘要候选查询失败", observeFields{
			ErrorCode: "hot_summary_candidates_query_failed", Route: "internal/crawl/hot_summary",
			Extras: map[string]any{"err": e.Error()},
		})
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
		if err := rows.Scan(&x.id, &x.url, &x.key, &x.rel); err != nil {
			s.observeFailure(ctx, slog.LevelWarn, "热点摘要候选行解析失败", observeFields{
				ErrorCode: "hot_summary_candidate_scan_failed", Route: "internal/crawl/hot_summary",
				Extras: map[string]any{"err": err.Error()},
			})
			continue
		}
		list = append(list, x)
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
		started := time.Now()
		fetchStarted := s.now()
		_, out, e := s.crawlClient().ReadValidated(ctx, src, c.Limits, func(b []byte) error { var err error; meta, err = crawl.ParseMetadata(b); return err })
		if out.Requests == 0 && (errors.Is(e, crawl.ErrLimited) || errors.Is(e, crawl.ErrDisabled)) {
			continue
		}
		msg := ""
		if e != nil {
			msg = e.Error()
		}
		// BE-02：批采不因单条落库失败中断；attempt/run/summary 写失败必须可观测。
		if _, err := s.db.Exec(ctx, `INSERT INTO crawl_summary_url(url,attempt_at) VALUES($1,$2) ON CONFLICT(url) DO UPDATE SET attempt_at=excluded.attempt_at`, x.url, s.now()); err != nil {
			s.observeFailure(ctx, slog.LevelWarn, "热点摘要尝试记录落库失败", observeFields{
				ErrorCode: "hot_summary_attempt_write_failed", Route: "internal/crawl/hot_summary",
				Started: started, Extras: map[string]any{"source_key": x.key, "err": err.Error()},
			})
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$3,$4,$5,$6,$7)`, x.key, fetchStarted, s.now(), out.Requests, out.Status, map[bool]int{true: 1}[e == nil], msg); err != nil {
			s.observeFailure(ctx, slog.LevelError, "热点摘要运行记录落库失败", observeFields{
				Action: "hot_summary_run_log", TargetType: "crawl_source", TargetID: x.key,
				ErrorCode: "hot_summary_run_log_failed", Route: "internal/crawl/hot_summary",
				Started: started, Extras: map[string]any{"err": err.Error()},
			})
		}
		if e == nil {
			if _, err := s.db.Exec(ctx, `UPDATE hot_item SET page_title=$2,summary=$3,summary_at=$4 WHERE url=$1`, x.url, cleanExternalText(meta.Title), cleanExternalText(meta.Summary), s.now()); err != nil {
				s.observeFailure(ctx, slog.LevelError, "热点摘要正文回写失败", observeFields{
					Action: "hot_summary_item_update", TargetType: "hot_item", TargetID: x.id.String(),
					ErrorCode: "hot_summary_item_update_failed", Route: "internal/crawl/hot_summary",
					Started: started, Extras: map[string]any{"source_key": x.key, "err": err.Error()},
				})
			}
		}
	}
}
func (s *Server) queueHotReference(ctx context.Context, hot uuid.UUID) {
	rows, err := s.db.Query(ctx, `SELECT a.id,a.workspace_id,h.url FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id JOIN platform_account a ON a.id=m.account_id JOIN account_strategy st ON st.account_id=a.id AND st.status='active' JOIN crawl_source src ON src.key=h.source_key JOIN app_setting pref ON pref.workspace_id=a.workspace_id AND pref.key='hot.sources' WHERE h.id=$1 AND m.relevance>=75 AND m.status='new' AND cardinality(m.risk)=0 AND st.hot_enabled AND m.date=$2::date AND a.status<>'deleted' AND src.enabled AND (src.workspace_id IS NULL OR src.workspace_id=a.workspace_id) AND pref.value ? h.source_key AND NOT EXISTS(SELECT 1 FROM unnest(st.blocked_words||st.taboo) w WHERE w<>'' AND (h.title||' '||h.summary) ILIKE '%'||w||'%')`, hot, s.today())
	if err != nil {
		s.observeFailure(ctx, slog.LevelWarn, "敏感热点转对标队列查询失败", observeFields{
			ErrorCode: "hot_summary_queue_ref_query_failed", Route: "internal/crawl/hot_summary/queue_ref",
			Extras: map[string]any{"hot_item_id": hot.String(), "err": err.Error()},
		})
		return
	}
	type target struct {
		account, workspace uuid.UUID
		url                string
	}
	targets := []target{}
	for rows.Next() {
		var x target
		if err := rows.Scan(&x.account, &x.workspace, &x.url); err != nil {
			s.observeFailure(ctx, slog.LevelWarn, "敏感热点转对标队列行解析失败", observeFields{
				ErrorCode: "hot_summary_queue_ref_scan_failed", Route: "internal/crawl/hot_summary/queue_ref",
				Extras: map[string]any{"hot_item_id": hot.String(), "err": err.Error()},
			})
			continue
		}
		targets = append(targets, x)
	}
	rows.Close()
	for _, x := range targets {
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.workspace, Role: "owner"})
		if err := s.withTx(jctx, func(tx pgx.Tx) error { _, err := s.queueReferences(jctx, tx, x.account, []string{x.url}); return err }); err != nil {
			s.observeFailure(jctx, slog.LevelWarn, "敏感热点转入对标队列失败", observeFields{
				ErrorCode: "hot_summary_queue_ref_failed", Route: "internal/crawl/hot_summary/queue_ref",
				Extras: map[string]any{"hot_item_id": hot.String(), "account_id": x.account.String(), "err": err.Error()},
			})
		}
	}
}
