package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；剩余 1 处文件续批）：关键落库/清理失败必须可观测。

func TestBE02PurgeDeletedSectionsFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("editor_section_purge_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.purgeDeletedSections(ctx)
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "软删段落保留清理失败" && record["error_code"] == "editor_section_purge_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("purgeDeletedSections 失败必须 Warn 可观测")
	}
}

func TestBE02AfterAISuccessMemoryCountFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("aicore_memory_use_count_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.afterAISuccess(ctx, aiTask{Type: "titles"}, &ContextPack{MemoryIDs: []uuid.UUID{uuid.New()}})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "账号记忆用量计数失败" && record["error_code"] == "aicore_memory_use_count_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("afterAISuccess 记忆计数失败必须 Warn 可观测")
	}
}

func TestBE02EmitBrowserCommandEventFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("browser_command_event_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	env.srv.emitBrowserCommandEvent(ctx, uuid.New(), "browser.command_started", map[string]any{"id": "x"})
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "浏览器命令事件写入失败" && record["error_code"] == "browser_command_event_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("emitBrowserCommandEvent 失败必须 Warn 可观测")
	}
}
