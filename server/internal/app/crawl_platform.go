package app

import (
	"context"
	"crypto/rand"
	"github.com/go-chi/chi/v5"
	"math/big"
	"net/http"
	"net/url"
	"ops/internal/crawl"
	"time"
)

type CrawlPlatform struct {
	Platform    string     `json:"platform"`
	Enabled     bool       `json:"enabled"`
	Level       string     `json:"level"`
	IntervalMin int        `json:"interval_min"`
	DailyMax    int        `json:"daily_max"`
	RepeatHours int        `json:"repeat_hours"`
	JitterMin   int        `json:"jitter_min"`
	Requests    int        `json:"today_requests"`
	Next        *time.Time `json:"next_request_at"`
	Paused      *time.Time `json:"paused_until"`
	Strikes     int        `json:"strikes_7d"`
}

func (s *Server) crawlPlatforms(ctx context.Context) ([]CrawlPlatform, error) {
	rows, e := s.db.Query(ctx, `SELECT platform,enabled,level,interval_min,daily_max,repeat_hours,jitter_min,CASE WHEN request_date=$1::date THEN today_requests ELSE 0 END,next_request_at,paused_until,strikes_7d FROM crawl_platform_state ORDER BY platform`, s.today())
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	list := []CrawlPlatform{}
	for rows.Next() {
		var x CrawlPlatform
		if e = rows.Scan(&x.Platform, &x.Enabled, &x.Level, &x.IntervalMin, &x.DailyMax, &x.RepeatHours, &x.JitterMin, &x.Requests, &x.Next, &x.Paused, &x.Strikes); e != nil {
			return nil, e
		}
		list = append(list, x)
	}
	return list, rows.Err()
}
func (s *Server) adminPutPlatform(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if e := s.requireSystemAdmin(ctx); e != nil {
		return e
	}
	var x CrawlPlatform
	if e := decode(r, &x); e != nil {
		return e
	}
	key := chi.URLParam(r, "platform")
	if key != "xhs_page" && key != "wechat_page" {
		return validation("未知平台")
	}
	if x.Level != "standard" && x.Level != "conservative" {
		return validation("平台档位为保守或标准")
	}
	if x.IntervalMin < 3 || x.DailyMax < 1 || x.DailyMax > 100 || x.RepeatHours < 12 || x.JitterMin < 0 || x.JitterMin > 5 {
		return validation("最短间隔 3 分钟、每日最多 100 次、同一链接至少 12 小时")
	}
	if x.Enabled {
		if !s.loadCrawl(ctx).Limits.Enabled {
			return stateInvalid("采集未开启")
		}
		if !s.cfg.Dev {
			return stateInvalid("robots 不允许，真实平台保持停用；使用手动粘贴")
		}
	}
	// Reopening never removes an unexpired circuit breaker.
	_, e := s.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=$2,level=$3,interval_min=$4,daily_max=$5,repeat_hours=$6,jitter_min=$7 WHERE platform=$1`, key, x.Enabled, x.Level, x.IntervalMin, x.DailyMax, x.RepeatHours, x.JitterMin)
	if e != nil {
		return e
	}
	s.audit(ctx, "crawl_platform", "crawl_platform_state", key, "ok", map[string]any{"enabled": x.Enabled})
	return s.adminGetCrawl(w, r)
}
func (s *Server) claimPlatform(ctx context.Context, src crawl.Source, now time.Time) error {
	h := now.In(s.loc).Hour()
	if h < 8 || h >= 23 {
		return crawl.ErrLimited
	}
	// The production adapters are disabled by the verified robots policies. Development uses only the local mock.
	if !s.cfg.Dev {
		return crawl.ErrRobots
	}
	var ready bool
	e := s.db.QueryRow(ctx, `SELECT enabled AND coalesce(paused_until,$2)<=$2 AND coalesce(next_request_at,$2)<=$2 AND NOT EXISTS(SELECT 1 FROM crawl_platform_read WHERE platform=$1 AND url=$3 AND last_read_at>$2::timestamptz-make_interval(hours=>repeat_hours)) FROM crawl_platform_state WHERE platform=$1`, src.Kind, now, src.URL).Scan(&ready)
	if e != nil {
		return e
	}
	if !ready {
		return crawl.ErrLimited
	}
	return nil
}
func (s *Server) reserveCrawl(ctx context.Context, src crawl.Source, now time.Time, cap int) error {
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	sensitive := src.Kind == "xhs_page" || src.Kind == "wechat_page"
	if sensitive {
		var enabled bool
		var spacing, day, jitter, repeat, n int
		var date *time.Time
		var next, paused *time.Time
		e = tx.QueryRow(ctx, `SELECT enabled,interval_min,daily_max,jitter_min,repeat_hours,today_requests,request_date,next_request_at,paused_until FROM crawl_platform_state WHERE platform=$1 FOR UPDATE`, src.Kind).Scan(&enabled, &spacing, &day, &jitter, &repeat, &n, &date, &next, &paused)
		if e != nil {
			return e
		}
		h := now.In(s.loc).Hour()
		if !enabled || h < 8 || h >= 23 || next != nil && next.After(now) || paused != nil && paused.After(now) {
			return crawl.ErrLimited
		}
		today := now.In(s.loc).Format("2006-01-02")
		if date == nil || date.Format("2006-01-02") != today {
			n = 0
		}
		if n >= min(day, 100) {
			return crawl.ErrLimited
		}
		u, _ := url.Parse(src.URL)
		if u.Path != "/robots.txt" {
			var exists bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM crawl_platform_read WHERE platform=$1 AND url=$2 AND last_read_at>$3::timestamptz-make_interval(hours=>$4))`, src.Kind, src.URL, now, max(repeat, 12)).Scan(&exists)
			if e != nil {
				return e
			}
			if exists {
				return crawl.ErrLimited
			}
			_, e = tx.Exec(ctx, `INSERT INTO crawl_platform_read VALUES($1,$2,$3) ON CONFLICT(platform,url) DO UPDATE SET last_read_at=excluded.last_read_at`, src.Kind, src.URL, now)
			if e != nil {
				return e
			}
		}
		delay, _ := rand.Int(rand.Reader, big.NewInt(int64(max(0, jitter)*60+1)))
		_, e = tx.Exec(ctx, `UPDATE crawl_platform_state SET request_date=$2::date,today_requests=$3,last_request_at=$4,next_request_at=$5 WHERE platform=$1`, src.Kind, today, n+1, now, now.Add(time.Duration(max(spacing, 3))*time.Minute+time.Duration(delay.Int64())*time.Second))
		if e != nil {
			return e
		}
	}
	summary := 0
	if src.Kind == "summary" {
		summary = 1
	}
	tag, e := tx.Exec(ctx, `INSERT INTO crawl_budget(date,requests,summary_requests) VALUES($1::date,1,$3) ON CONFLICT(date) DO UPDATE SET requests=crawl_budget.requests+1,summary_requests=crawl_budget.summary_requests+$3 WHERE crawl_budget.requests<$2 AND ($3=0 OR crawl_budget.summary_requests<20)`, now.In(s.loc).Format("2006-01-02"), cap, summary)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return crawl.ErrLimited
	}
	return tx.Commit(ctx)
}
func (s *Server) finishPlatform(ctx context.Context, src crawl.Source, now time.Time, out crawl.Outcome) {
	if out.Paused {
		_, _ = s.db.Exec(ctx, `UPDATE crawl_platform_state SET strikes_7d=CASE WHEN last_strike_at>$2::timestamptz-interval '7 days' THEN strikes_7d+1 ELSE 1 END,enabled=CASE WHEN last_strike_at>$2::timestamptz-interval '7 days' THEN false ELSE enabled END,paused_until=CASE WHEN last_strike_at>$2::timestamptz-interval '7 days' THEN $2::timestamptz+interval '7 days' ELSE $2::timestamptz+interval '24 hours' END,last_strike_at=$2 WHERE platform=$1`, src.Kind, now)
		s.notifyCrawlAdmins(ctx, src.Kind, out.Error)
	}
	_, _ = s.db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,requests,http_status,items,error) VALUES($1,$2,$2,$3,$4,$5,$6)`, src.Kind, now, out.Requests, out.Status, map[bool]int{true: 1}[out.Error == ""], out.Error)
}
