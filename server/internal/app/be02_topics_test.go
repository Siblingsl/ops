package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；topics.go 批次）：
// 选题采用素材预挂失败必须可观测。

func TestBE02LinkAdoptedWorkMaterialsFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("topic_adopt_material_link_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.linkAdoptedWorkMaterials(ctx, uuid.New(), []uuid.UUID{uuid.New()})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "选题采用素材预挂失败" && record["error_code"] == "topic_adopt_material_link_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("linkAdoptedWorkMaterials 失败必须 Warn 可观测")
	}
}
