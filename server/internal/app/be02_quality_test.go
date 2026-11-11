package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；quality.go 批次）：
// 金句裁剪落库失败必须可观测并上抛；评测用量落库失败由 runSnapshot 走 Error 观测（U107 守成功路径）。

func TestBE02GoldenSentencesTrimFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := env.srv.writeGoldenSentences(ctx, uuid.New(), []string{"慢一点，反而更快。"})
	if err == nil {
		t.Fatal("取消 ctx 下金句裁剪应失败")
	}
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "金句列表裁剪落库失败" && record["error_code"] == "golden_sentences_trim_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("writeGoldenSentences 失败必须 Error 可观测")
	}
}
