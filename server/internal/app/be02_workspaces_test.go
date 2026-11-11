package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；workspaces.go 批次）：
// 建区基础敏感词 / 孤儿退出会话清理 / 邀请失败流水落库失败必须可观测。

func TestBE02SeedWorkspaceBaseWordsFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("workspace_base_sensitive_seed_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.seedWorkspaceBaseWords(ctx, uuid.New())
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "工作区基础敏感词写入失败" && record["error_code"] == "workspace_base_sensitive_seed_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("seedWorkspaceBaseWords 写入失败必须 Warn 可观测")
	}
}
