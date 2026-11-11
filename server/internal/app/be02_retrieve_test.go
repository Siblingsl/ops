package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；retrieve.go 批次）：
// 过期向量清理 / 后台向量化候选查询失败必须可观测。

func TestBE02MarkEmbeddingStaleFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("retrieve_embedding_stale_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.markEmbeddingStale(ctx, "material", uuid.New())
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "过期向量缓存清理失败" && record["error_code"] == "retrieve_embedding_stale_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("markEmbeddingStale 清理失败必须 Warn 可观测")
	}
}

func TestBE02ReindexEmbeddingsQueryFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("retrieve_reindex_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.reindexEmbeddings(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "后台向量化工作区查询失败" && record["error_code"] == "retrieve_reindex_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("reindexEmbeddings 候选查询失败必须 Warn 可观测")
	}
}
