package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；platform_sync_operations.go 批次）：
// 平台同步取消落库失败必须可观测；调用方控制流不变。

func TestBE02CancelPlatformSyncOperationFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.cancelPlatformSyncOperation(ctx, uuid.New(), "capability_changed", time.Now())
	foundOp, foundRun := false, false
	for _, record := range sink.records(t) {
		switch record["error_code"] {
		case "platform_sync_operation_cancel_failed":
			foundOp = true
		case "platform_sync_run_cancel_failed":
			foundRun = true
		}
	}
	if !foundOp || !foundRun {
		t.Fatalf("cancelPlatformSyncOperation 两处落库失败必须 Error 可观测（op=%v run=%v）", foundOp, foundRun)
	}
}
