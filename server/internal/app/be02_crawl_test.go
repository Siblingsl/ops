package app

import (
	"context"
	"testing"
	"time"

	"ops/internal/crawl"
)

// BE-02（docs/33 §11.5；crawl.go 批次）：爬取收尾/清理/配置解析不得静默。
// 控制流保持：Finish 无 error 返回、批采不因单源失败中断、清理失败不阻断主循环；
// 失败路径必须经 observeFailure 可观测。

func TestBE02ScanCrawlSourceCorruptConfigSurfacesError(t *testing.T) {
	ctx := context.Background()
	key := "be02-crawl-bad-config"
	_, err := env.srv.db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name,config) VALUES($1,'rss',$1,$2::jsonb)
		ON CONFLICT (key) DO UPDATE SET config=excluded.config`, key, `{"url":1}`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM crawl_source WHERE key=$1`, key)
	})
	_, err = scanCrawlSource(env.srv.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key=$1`, key))
	if err == nil {
		t.Fatal("非 string 的 config.url 必须上抛，不得空 Config 伪装成功")
	}
}

func TestBE02CrawlFinishWriteFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := crawlStore{s: env.srv}
	store.Finish(ctx, crawl.Source{Key: "baidu", Kind: "rss"}, time.Now(), crawl.Limits{FailLimit: 3, PauseHours: 6}, crawl.Outcome{})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "爬取来源收尾状态落库失败" && record["error_code"] == "crawl_source_finish_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("Finish 落库失败必须 Error 级可观测（error_code=crawl_source_finish_failed）")
	}
}

func TestBE02PurgeHotFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.purgeHot(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "热点保留清理失败" {
			if code, _ := record["error_code"].(string); code != "" {
				found = true
				break
			}
		}
	}
	if !found {
		t.Fatal("purgeHot 清理失败必须 Warn 级可观测")
	}
}

func TestBE02LoadCrawlBadSettingKeepsDefaultAndObserves(t *testing.T) {
	sink := opt15Capture(t)
	ctx := context.Background()
	var old []byte
	if err := env.srv.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='crawl.retention_days'`).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.retention_days'`, []byte(`{"nope":true}`)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.retention_days'`, old)
	})
	cfg := env.srv.loadCrawl(ctx)
	if cfg.RetentionDays != 14 {
		t.Fatalf("坏 retention 配置应保留默认 14，实际 %d", cfg.RetentionDays)
	}
	found := false
	for _, record := range sink.records(t) {
		if record["error_code"] == "crawl_setting_unmarshal_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("坏爬取配置解析必须 Warn 可观测")
	}
}
