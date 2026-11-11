package app

import (
	"context"
	"testing"
)

// BE-02（docs/33 §11.5；hot_summary.go 批次）：
// 摘要批采落库 / 敏感转对标失败必须可观测；批循环控制流不变。

func be02EnableHotSummary(t *testing.T) {
	t.Helper()
	enableTestCrawl(t)
	ctx := context.Background()
	var oldLevel, oldFetch []byte
	_ = env.srv.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='crawl.level'`).Scan(&oldLevel)
	_ = env.srv.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key='crawl.summary_fetch'`).Scan(&oldFetch)
	if _, err := env.srv.db.Exec(ctx, `UPDATE system_setting SET value='"standard"' WHERE key='crawl.level'`); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE system_setting SET value='true' WHERE key='crawl.summary_fetch'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.level'`, oldLevel)
		_, _ = env.srv.db.Exec(ctx, `UPDATE system_setting SET value=$1 WHERE key='crawl.summary_fetch'`, oldFetch)
	})
}

func TestBE02CollectSummariesQueryFailureIsObservable(t *testing.T) {
	be02EnableHotSummary(t)
	sink := opt15Capture(t)
	observeWarnLast.Delete("hot_summary_candidates_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.collectSummaries(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "热点摘要候选查询失败" && record["error_code"] == "hot_summary_candidates_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("collectSummaries 候选查询失败必须 Warn 可观测")
	}
}

func TestBE02QueueHotReferenceQueryFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("hot_summary_queue_ref_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.queueHotReference(ctx, mustParse(t, "00000000-0000-0000-0000-000000000001"))
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "敏感热点转对标队列查询失败" && record["error_code"] == "hot_summary_queue_ref_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("queueHotReference 查询失败必须 Warn 可观测")
	}
}
