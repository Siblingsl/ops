package app

import (
	"context"
	"testing"
)

// BE-02（docs/33 §11.5；r4.go 批次）：
// 草稿状态批扫候选查询失败必须可观测；HTTP 旗标写失败上抛并由 Error 观测（成功路径由 opt32 守住）。

func TestBE02SyncDraftsJobQueryFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("draft_sync_job_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.syncDraftsJob(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "草稿状态批扫候选查询失败" && record["error_code"] == "draft_sync_job_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("syncDraftsJob 候选查询失败必须 Warn 可观测")
	}
}
