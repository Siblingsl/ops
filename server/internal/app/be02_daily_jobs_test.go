package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；daily_jobs.go 批次）：
// 运营台打开痕迹 / 后台日更候选查询失败必须可观测。

func TestBE02OpsOpenedFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("ops_opened_activity_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ctx = context.WithValue(ctx, ctxMember, &identity{UserID: uuid.New(), WorkspaceID: uuid.New(), Role: "editor"})
	env.srv.opsOpened(ctx, &Account{ID: uuid.New()})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "运营台打开痕迹落库失败" && record["error_code"] == "ops_opened_activity_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("opsOpened 落库失败必须 Warn 可观测")
	}
}

func TestBE02DailyBackgroundQueryFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("daily_background_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.dailyBackground(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "后台日更候选查询失败" && record["error_code"] == "daily_background_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("dailyBackground 候选查询失败必须 Warn 可观测")
	}
}
