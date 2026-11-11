package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；agent_delegation.go 批次）：
// 委派创建/取消时间线事件写入失败不得静默；主状态已提交时控制流仍成功返回。

func TestBE02AppendDelegationEventFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("delegation_event_append_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.appendDelegationEvent(ctx, uuid.New(), nil, "delegation.created", map[string]any{"count": 1})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "委派事件写入失败" && record["error_code"] == "delegation_event_append_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("appendDelegationEvent 失败必须 Warn 可观测")
	}
}
