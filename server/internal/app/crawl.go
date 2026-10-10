package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"ops/internal/crawl"
)

type crawlConfig struct {
	Mode          string       `json:"mode"`
	Level         string       `json:"level"`
	Limits        crawl.Limits `json:"limits"`
	SummaryFetch  bool         `json:"summary_fetch"`
	RetentionDays int          `json:"retention_days"`
}

func (s *Server) loadCrawl(ctx context.Context) crawlConfig {
	c := crawlConfig{Mode: s.cfg.CrawlMode, Level: "off", Limits: crawl.Limits{IntervalMin: 60, MaxItems: 50, DailyRequests: 300, FailLimit: 3, PauseHours: 6}, RetentionDays: 14}
	for key, target := range map[string]any{"crawl.level": &c.Level, "crawl.limits": &c.Limits, "crawl.summary_fetch": &c.SummaryFetch, "crawl.retention_days": &c.RetentionDays} {
		var b []byte
		if s.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key=$1`, key).Scan(&b) == nil {
			_ = json.Unmarshal(b, target)
		}
	}
	c.Limits.Enabled = c.Mode == "allow" && c.Level != "off"
	return c
}

type crawlStore struct{ s *Server }

func (st crawlStore) Claim(ctx context.Context, source crawl.Source, now time.Time, l crawl.Limits) error {
	if source.Kind == "xhs_page" || source.Kind == "wechat_page" {
		return st.s.claimPlatform(ctx, source, now)
	}
	tag, err := st.s.db.Exec(ctx, `UPDATE crawl_source SET last_attempt_at=$2 WHERE key=$1 AND enabled AND coalesce(paused_until,$2)<=$2
  AND (last_attempt_at IS NULL OR last_attempt_at <= $2 - make_interval(mins => GREATEST(interval_min,$3)))`, source.Key, now, l.IntervalMin)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return crawl.ErrLimited
	}
	return nil
}
func (st crawlStore) Reserve(ctx context.Context, source crawl.Source, now time.Time, max int) error {
	return st.s.reserveCrawl(ctx, source, now, max)
}
func (st crawlStore) Finish(ctx context.Context, source crawl.Source, now time.Time, l crawl.Limits, out crawl.Outcome) {
	if out.Error == crawl.ErrLimited.Error() || out.Error == crawl.ErrDisabled.Error() {
		return
	}
	if source.Kind == "xhs_page" || source.Kind == "wechat_page" {
		st.s.finishPlatform(ctx, source, now, out)
		return
	}
	_, _ = st.s.db.Exec(ctx, `UPDATE crawl_source SET fail_count=CASE WHEN $3='' THEN 0 ELSE fail_count+1 END,
  last_ok_at=CASE WHEN $3='' THEN $2 ELSE last_ok_at END,error=$3,robots_checked_at=$2,robots_allow=$4,
  paused_until=CASE WHEN $5 THEN $2+interval '24 hours' WHEN $3<>'' AND fail_count+1>=$6 THEN $2+make_interval(hours=>$7) ELSE paused_until END WHERE key=$1`, source.Key, now, out.Error, out.RobotsAllow, out.Paused, l.FailLimit, l.PauseHours)
	if out.Paused {
		st.s.notifyCrawlAdmins(ctx, source.Key, out.Error)
	}
}
func (s *Server) notifyCrawlAdmins(ctx context.Context, key, msg string) {
	rows, err := s.db.Query(ctx, `SELECT u.id,m.workspace_id FROM app_user u JOIN workspace_member m ON m.user_id=u.id AND m.role='owner' AND m.status='active' WHERE u.is_system_admin AND u.disabled_at IS NULL`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var user, ws uuid.UUID
		if rows.Scan(&user, &ws) == nil {
			s.notify(ctx, ws, user, "crawl", "热点来源已暂停："+key, msg, "/settings/crawl", "crawl:"+key+":"+s.today().Format("2006-01-02"))
		}
	}
}
func (s *Server) crawlClient() *crawl.Client {
	s.crawlMu.Lock()
	defer s.crawlMu.Unlock()
	if s.crawler == nil {
		local := ""
		if s.cfg.Dev {
			local = s.cfg.MockListen
		}
		s.crawler = crawl.New(crawl.Options{Mode: func() bool { return s.loadCrawl(context.Background()).Limits.Enabled }, Now: func() time.Time { return s.now() }, Store: crawlStore{s}, LocalHost: local})
	}
	return s.crawler
}

type CrawlSource struct {
	Key           string            `json:"key"`
	Kind          string            `json:"kind"`
	Name          string            `json:"name"`
	Enabled       bool              `json:"enabled"`
	IntervalMin   int               `json:"interval_min"`
	MaxItems      int               `json:"max_items"`
	Config        map[string]string `json:"config"`
	WorkspaceID   *uuid.UUID        `json:"workspace_id"`
	FailCount     int               `json:"fail_count"`
	PausedUntil   *time.Time        `json:"paused_until"`
	LastOKAt      *time.Time        `json:"last_ok_at"`
	LastAttemptAt *time.Time        `json:"last_attempt_at"`
	RobotsAllow   *bool             `json:"robots_allow"`
	Error         string            `json:"error"`
}

const crawlSourceCols = `key,kind,name,enabled,interval_min,max_items,config,workspace_id,fail_count,paused_until,last_ok_at,last_attempt_at,robots_allow,error`

func scanCrawlSource(row interface{ Scan(...any) error }) (CrawlSource, error) {
	var x CrawlSource
	var b []byte
	err := row.Scan(&x.Key, &x.Kind, &x.Name, &x.Enabled, &x.IntervalMin, &x.MaxItems, &b, &x.WorkspaceID, &x.FailCount, &x.PausedUntil, &x.LastOKAt, &x.LastAttemptAt, &x.RobotsAllow, &x.Error)
	_ = json.Unmarshal(b, &x.Config)
	return x, err
}
func normalizeHot(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.IsPunct(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, s)
}
func (s *Server) collectSource(ctx context.Context, source CrawlSource) ([]crawl.Item, error) {
	c := s.loadCrawl(ctx)
	if !c.Limits.Enabled {
		return nil, crawl.ErrDisabled
	}
	if source.Kind == "xhs_page" || source.Kind == "wechat_page" {
		return nil, crawl.ErrRobots
	}
	lim := c.Limits
	lim.IntervalMin = max(lim.IntervalMin, source.IntervalMin)
	lim.MaxItems = min(lim.MaxItems, source.MaxItems)
	endpoint := source.Config["url"]
	if s.cfg.Dev {
		endpoint = "http://" + s.cfg.MockListen + "/mock/hot/" + source.Key
		if source.Kind == "rss" {
			endpoint = "http://" + s.cfg.MockListen + "/mock/hot/rss"
		}
	}
	started := s.now()
	items, out, err := (crawl.Adapter{Client: s.crawlClient(), Source: crawl.Source{Key: source.Key, Kind: source.Kind, URL: endpoint}}).Fetch(ctx, lim)
	if errors.Is(err, crawl.ErrLimited) || errors.Is(err, crawl.ErrDisabled) {
		return nil, err
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	_, logErr := s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$3,$4,$5,$6,$7)`, source.Key, started, s.now(), out.Requests, out.Status, len(items), msg)
	if logErr != nil {
		return nil, logErr
	}
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if err := s.storeHotItem(ctx, source, item); err != nil {
			return nil, err
		}
	}
	return items, nil
}
func (s *Server) storeHotItem(ctx context.Context, source CrawlSource, item crawl.Item) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialize clustering so concurrent collectors do not create duplicate clusters.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(471414)`); err != nil {
		return err
	}
	norm := normalizeHot(item.Title)
	var cluster uuid.UUID
	err = tx.QueryRow(ctx, `SELECT c.id FROM hot_cluster c JOIN hot_item h ON h.cluster_id=c.id JOIN crawl_source src ON src.key=h.source_key
  WHERE src.workspace_id IS NOT DISTINCT FROM $2::uuid AND similarity(h.title_norm,$1)>=0.6 ORDER BY similarity(h.title_norm,$1) DESC LIMIT 1`, norm, source.WorkspaceID).Scan(&cluster)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO hot_cluster(title,sources,best_rank,first_seen_at,last_seen_at) VALUES($1,$2,$3,$4,$4) RETURNING id`, item.Title, []string{source.Key}, item.Rank, s.now()).Scan(&cluster)
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE hot_cluster SET sources=ARRAY(SELECT DISTINCT unnest(sources||$2::text[])),best_rank=CASE WHEN best_rank=0 THEN $3 WHEN $3=0 THEN best_rank ELSE LEAST(best_rank,$3) END,last_seen_at=$4 WHERE id=$1`, cluster, []string{source.Key}, item.Rank, s.now())
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO hot_item(source_key,title,title_norm,url,rank,heat,category,summary,cluster_id,first_seen_at,last_seen_at,best_rank)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$5) ON CONFLICT(source_key,title_norm,url) DO UPDATE SET rank=excluded.rank,heat=excluded.heat,summary=excluded.summary,last_seen_at=excluded.last_seen_at,best_rank=CASE WHEN hot_item.best_rank=0 THEN excluded.rank ELSE LEAST(hot_item.best_rank,excluded.rank) END`, source.Key, item.Title, norm, item.URL, item.Rank, item.Heat, item.Category, item.Summary, cluster, s.now())
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Server) collectHot(ctx context.Context) {
	c := s.loadCrawl(ctx)
	if !c.Limits.Enabled {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE enabled AND kind NOT IN ('xhs_page','wechat_page') AND coalesce(paused_until,$1)<=$1 AND (last_attempt_at IS NULL OR last_attempt_at<=$1-make_interval(mins=>GREATEST(interval_min,$2))) ORDER BY key`, s.now(), c.Limits.IntervalMin)
	if err != nil {
		return
	}
	list := []CrawlSource{}
	for rows.Next() {
		x, e := scanCrawlSource(rows)
		if e == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, src := range list {
		_, _ = s.collectSource(ctx, src)
	}
	s.purgeHot(ctx)
	s.indexHotEmbeddings(ctx)
}

func (s *Server) purgeHot(ctx context.Context) {
	c := s.loadCrawl(ctx)
	_, _ = s.db.Exec(ctx, `DELETE FROM hot_item WHERE last_seen_at<$1`, s.now().AddDate(0, 0, -c.RetentionDays))
	_, _ = s.db.Exec(ctx, `DELETE FROM hot_cluster c WHERE NOT EXISTS(SELECT 1 FROM hot_item WHERE cluster_id=c.id)`)
	_, _ = s.db.Exec(ctx, `DELETE FROM crawl_run WHERE started_at<$1`, s.now().AddDate(0, 0, -30))
	_, _ = s.db.Exec(ctx, `DELETE FROM crawl_budget WHERE date<$1`, s.today().AddDate(0, 0, -60))
}
func (s *Server) indexHotEmbeddings(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT workspace_id FROM model_route WHERE task_type='embedding'`)
	if err != nil {
		return
	}
	wsList := []uuid.UUID{}
	for rows.Next() {
		var ws uuid.UUID
		if rows.Scan(&ws) == nil {
			wsList = append(wsList, ws)
		}
	}
	rows.Close()
	for _, ws := range wsList {
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws, Role: "owner"})
		rt, ok := s.embeddingRoute(jctx)
		if !ok {
			continue
		}
		hr, e := s.db.Query(ctx, `SELECT h.id,h.title FROM hot_item h JOIN crawl_source src ON src.key=h.source_key WHERE (src.workspace_id IS NULL OR src.workspace_id=$1) AND h.last_seen_at>$2 ORDER BY h.last_seen_at DESC LIMIT 256`, ws, s.now().Add(-24*time.Hour))
		if e != nil {
			continue
		}
		cands := []*matCandidate{}
		for hr.Next() {
			var id uuid.UUID
			var title string
			if hr.Scan(&id, &title) == nil {
				cands = append(cands, &matCandidate{id: id, content: title})
			}
		}
		hr.Close()
		if len(cands) > 0 {
			_, _ = s.ensureEmbeddings(jctx, rt, "hot", cands)
		}
	}
}

var _ crawl.Store = crawlStore{}
