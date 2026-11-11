package app

import (
	"context"
	"testing"
)

// BE-02（docs/33 §11.5；jobs.go 批次）：
// 调度标记 / UX 事件保留清理失败必须可观测。

func TestBE02PurgeJobRetentionFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("jobs_marker_purge_failed")
	observeWarnLast.Delete("jobs_ux_event_purge_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.purgeJobRetention(ctx)
	foundMarker, foundUX := false, false
	for _, record := range sink.records(t) {
		switch record["error_code"] {
		case "jobs_marker_purge_failed":
			foundMarker = true
		case "jobs_ux_event_purge_failed":
			foundUX = true
		}
	}
	if !foundMarker || !foundUX {
		t.Fatalf("purgeJobRetention 两处清理失败必须 Warn 可观测（marker=%v ux=%v）", foundMarker, foundUX)
	}
}
