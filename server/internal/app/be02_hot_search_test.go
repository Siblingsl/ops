package app

import (
	"context"
	"testing"
	"time"

	"ops/internal/ai"
	"ops/internal/crawl"
)

// BE-02（docs/33 §11.5；hot_search.go 批次）：
// 搜索用量 / crawl_run 落库失败必须可观测。

func TestBE02HotSearchTelemetryFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	now := time.Now()
	env.srv.recordHotSearchTelemetry(ctx, CrawlSource{Key: "be02-hot-search"}, "mock", []byte(`{"native_search":true}`),
		ai.Usage{}, now, now, crawl.Outcome{}, 0, "failed", "canceled")
	foundCall, foundRun := false, false
	for _, record := range sink.records(t) {
		switch record["error_code"] {
		case "hot_search_ai_call_failed":
			foundCall = true
		case "hot_search_run_log_failed":
			foundRun = true
		}
	}
	if !foundCall || !foundRun {
		t.Fatalf("recordHotSearchTelemetry 两处落库失败必须 Error 可观测（call=%v run=%v）", foundCall, foundRun)
	}
}
