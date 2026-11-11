package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；plan.go 批次）：
// 计划槽位竞态选题回滚失败必须可观测。

func TestBE02RollbackRaceAdoptedTopicFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.rollbackRaceAdoptedTopic(ctx, uuid.New(), uuid.New())
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "计划槽位竞态选题回滚失败" && record["error_code"] == "plan_slot_topic_rollback_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("rollbackRaceAdoptedTopic 失败必须 Error 可观测")
	}
}
