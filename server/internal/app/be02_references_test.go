package app

import (
	"context"
	"testing"
)

// BE-02（docs/33 §11.5；references.go 批次）：
// 对标批采清理 / 候选查询 / 元数据与状态回写失败必须可观测；批循环控制流不变。

func TestBE02CollectReferencesPurgeFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("references_body_purge_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.collectReferences(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "对标正文保留清理失败" && record["error_code"] == "references_body_purge_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("collectReferences 正文保留清理失败必须 Warn 可观测")
	}
}

func TestBE02CollectReferencesQueryFailureIsObservable(t *testing.T) {
	enableTestCrawl(t)
	sink := opt15Capture(t)
	observeWarnLast.Delete("references_candidates_query_failed")
	observeWarnLast.Delete("references_body_purge_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.collectReferences(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "对标采集候选查询失败" && record["error_code"] == "references_candidates_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("collectReferences 候选查询失败必须 Warn 可观测")
	}
}
