package app

import (
	"context"
	"testing"
	"time"

	"ops/internal/crawl"
)

// BE-02（docs/33 §11.5；crawl_platform.go 批次）：
// finishPlatform 熔断状态 / crawl_run 落库失败必须 Error 可观测；控制流保持无返回值。

func TestBE02FinishPlatformStrikeWriteFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.finishPlatform(ctx, crawl.Source{Kind: "xhs_page"}, time.Now(), crawl.Outcome{Paused: true, Error: "验证码"})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "平台爬取熔断状态落库失败" && record["error_code"] == "crawl_platform_strike_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("Paused 熔断 UPDATE 失败必须 Error 级可观测（crawl_platform_strike_failed）")
	}
}

func TestBE02FinishPlatformRunLogFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// 非 Paused：只走 crawl_run INSERT。
	env.srv.finishPlatform(ctx, crawl.Source{Kind: "wechat_page"}, time.Now(), crawl.Outcome{Requests: 1, Status: 200})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "平台爬取运行记录落库失败" && record["error_code"] == "crawl_platform_run_log_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("crawl_run INSERT 失败必须 Error 级可观测（crawl_platform_run_log_failed）")
	}
}

func TestBE02ReserveCrawlInvalidURLSurfacesError(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	_, err := env.srv.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=true,interval_min=10,daily_max=30,jitter_min=0,
		request_date=NULL,next_request_at=NULL,paused_until=NULL,last_strike_at=NULL,strikes_7d=0 WHERE platform='xhs_page'`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=false,next_request_at=NULL,paused_until=NULL,request_date=NULL,last_strike_at=NULL,strikes_7d=0`)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM crawl_platform_read`)
	})
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, env.srv.loc)
	err = env.srv.reserveCrawl(ctx, crawl.Source{Kind: "xhs_page", URL: "://bad"}, now, 2000)
	if err == nil {
		t.Fatal("非法 URL 必须上抛，不得在 nil *url.URL 上继续")
	}
}

func TestBE02FinishPlatformBreakerStillPauses(t *testing.T) {
	// 行为回归：成功路径仍按 V418 熔断语义置 paused_until。
	enableTestCrawl(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, env.srv.loc)
	if _, err := env.srv.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=true,interval_min=10,daily_max=30,jitter_min=0,
		request_date=NULL,next_request_at=NULL,paused_until=NULL,last_strike_at=NULL,strikes_7d=0 WHERE platform='xhs_page'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE crawl_platform_state SET enabled=false,next_request_at=NULL,paused_until=NULL,request_date=NULL,last_strike_at=NULL,strikes_7d=0`)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM crawl_run WHERE source_key='xhs_page' AND started_at=$1`, now)
	})
	env.srv.finishPlatform(ctx, crawl.Source{Kind: "xhs_page"}, now, crawl.Outcome{Paused: true, Error: "验证码"})
	var enabled bool
	var pause time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT enabled,paused_until FROM crawl_platform_state WHERE platform='xhs_page'`).Scan(&enabled, &pause); err != nil || !enabled || !pause.Equal(now.Add(24*time.Hour)) {
		t.Fatalf("首次熔断应暂停 24h：enabled=%v pause=%v err=%v", enabled, pause, err)
	}
}
