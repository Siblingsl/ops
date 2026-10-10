package app

import (
	"context"
	"ops/internal/crawl"
	"testing"
	"time"
)

func TestV418PlatformLimitsAndBreaker(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	s := env.srv
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, s.loc)
	_, e := s.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=true,interval_min=10,daily_max=30,jitter_min=0,request_date=NULL,next_request_at=NULL,paused_until=NULL,last_strike_at=NULL,strikes_7d=0 WHERE platform='xhs_page'`)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_, _ = s.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=false,next_request_at=NULL,paused_until=NULL,request_date=NULL,last_strike_at=NULL,strikes_7d=0`)
		_, _ = s.db.Exec(ctx, `DELETE FROM crawl_platform_read`)
	})
	accepted := 0
	var last time.Time
	for minute := 0; minute < 1440; minute++ {
		at := now.Add(time.Duration(minute) * time.Minute)
		src := crawl.Source{Kind: "xhs_page", URL: "https://xiaohongshu.com/explore/" + at.Format("1504")}
		e := s.reserveCrawl(ctx, src, at, 2000)
		if e == nil {
			h := at.In(s.loc).Hour()
			if h < 8 || h >= 23 {
				t.Fatal("night request")
			}
			if !last.IsZero() && at.Sub(last) < 10*time.Minute {
				t.Fatal("spacing")
			}
			last = at
			accepted++
		} else if e != crawl.ErrLimited {
			t.Fatal(e)
		}
	}
	if accepted != 30 {
		t.Fatalf("daily cap: %d", accepted)
	}
	src := crawl.Source{Kind: "xhs_page"}
	s.finishPlatform(ctx, src, now, crawl.Outcome{Paused: true, Error: "验证码"})
	var enabled bool
	var pause time.Time
	if e = s.db.QueryRow(ctx, `SELECT enabled,paused_until FROM crawl_platform_state WHERE platform='xhs_page'`).Scan(&enabled, &pause); e != nil || !enabled || !pause.Equal(now.Add(24*time.Hour)) {
		t.Fatalf("first breaker %v %v %v", enabled, pause, e)
	}
	s.finishPlatform(ctx, src, now.Add(25*time.Hour), crawl.Outcome{Paused: true, Error: "请先登录"})
	if e = s.db.QueryRow(ctx, `SELECT enabled,paused_until FROM crawl_platform_state WHERE platform='xhs_page'`).Scan(&enabled, &pause); e != nil || enabled || !pause.Equal(now.Add(25*time.Hour+7*24*time.Hour)) {
		t.Fatalf("second breaker %v %v %v", enabled, pause, e)
	}
}
