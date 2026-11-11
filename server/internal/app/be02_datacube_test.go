package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；datacube.go 批次）：
// datacube 状态落库 / 每日同步候选与计数回写失败必须可观测；批循环控制流不变。

func TestBE02SetDatacubeStateFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	id := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	env.srv.setDatacubeState(ctx, id, "ok")
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "公众号数据权限状态落库失败" && record["error_code"] == "datacube_state_update_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("setDatacubeState 落库失败必须 Error 可观测")
	}
}

func TestBE02WechatMetricsDailyQueryFailureIsObservable(t *testing.T) {
	orig := env.srv.now
	env.srv.now = func() time.Time { return time.Date(2031, 3, 3, 11, 0, 0, 0, env.srv.loc) }
	t.Cleanup(func() { env.srv.now = orig })
	sink := opt15Capture(t)
	observeWarnLast.Delete("datacube_daily_candidates_query_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.wechatMetricsDaily(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "公众号每日数据同步候选查询失败" && record["error_code"] == "datacube_daily_candidates_query_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("wechatMetricsDaily 候选查询失败必须 Warn 可观测")
	}
}
