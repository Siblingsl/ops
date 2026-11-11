package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// D-175 / BE-01：个人记忆去重作用域 = user + workspace（27 §11.1.1）。
// 修复前：唯一索引与三处去重查询缺 workspace_id → 跨工作区串扰/拒绝（常红复现）。
// 修复后：本文件转为回归——同内容在不同工作区各自独立。

const be01MemoryText = "BE-01 复现：竞品报告先列证据和日期，再给建议"
const be01IgnoredText = "BE-01 复现：忽略去重跨工作区用例专用文本"

type be01WorkspaceRef struct {
	ID uuid.UUID `json:"id"`
}

func be01CreateAndSwitchWorkspace(t *testing.T, name string) uuid.UUID {
	t.Helper()
	var created be01WorkspaceRef
	env.mustJSON(t, "POST", "/api/v1/workspaces", map[string]any{"name": name, "switch": true}, &created)
	if created.ID == uuid.Nil {
		t.Fatal("创建并切换工作区失败")
	}
	return created.ID
}

func be01ListAll(t *testing.T) []map[string]any {
	t.Helper()
	var out struct {
		Memories []map[string]any `json:"memories"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/personal-memories", map[string]any{}, &out)
	return out.Memories
}

func TestBE01PersonalMemoryDedupAcrossWorkspaces(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	var me map[string]any
	env.mustJSON(t, "GET", "/api/v1/auth/me", map[string]any{}, &me)
	firstWorkspaceID := uuid.MustParse(me["workspace"].(map[string]any)["id"].(string))

	var confirmedA personalMemory
	env.mustJSON(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01MemoryText}, &confirmedA)
	env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+confirmedA.ID, map[string]any{
		"action": "confirm", "expected_revision": confirmedA.Revision,
	}, &confirmedA)
	if confirmedA.State != "active" {
		t.Fatalf("工作区 A 确认后应为 active：%+v", confirmedA)
	}

	_ = be01CreateAndSwitchWorkspace(t, "BE-01-B")
	t.Cleanup(func() {
		env.mustJSON(t, "POST", "/api/v1/workspaces/"+firstWorkspaceID.String()+"/switch", map[string]any{}, &me)
	})

	var createdB personalMemory
	st, body := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01MemoryText})
	if st != http.StatusOK {
		t.Fatalf("工作区 B 应能独立创建同内容候选，got %d：%s", st, body)
	}
	if err := json.Unmarshal(body, &createdB); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if createdB.ID == "" || createdB.ID == confirmedA.ID {
		t.Fatalf("B 必须新建独立行，got id=%s (A=%s)", createdB.ID, confirmedA.ID)
	}
	if createdB.State != "candidate" {
		t.Fatalf("B 新建应为 candidate：%+v", createdB)
	}
	foundB, foundA := false, false
	for _, item := range be01ListAll(t) {
		if item["id"] == createdB.ID {
			foundB = true
		}
		if item["id"] == confirmedA.ID {
			foundA = true
		}
	}
	if !foundB {
		t.Fatal("B 列表应可见本工作区新建候选")
	}
	if foundA {
		t.Fatal("B 列表不应出现 A 工作区的记忆（跨工作区隔离）")
	}
}

func TestBE01PersonalMemoryIgnoredDedupAcrossWorkspaces(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	var me map[string]any
	env.mustJSON(t, "GET", "/api/v1/auth/me", map[string]any{}, &me)
	firstWorkspaceID := uuid.MustParse(me["workspace"].(map[string]any)["id"].(string))

	// A：忽略一条；若上次运行残留 ignored，幂等跳过 ignore。
	var proposedA personalMemory
	if stA, bodyA := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01IgnoredText}); stA == http.StatusConflict && strings.Contains(string(bodyA), "memory_ignored_duplicate") {
		t.Log("A-propose 命中本工作区既有 ignored 行，跳过 ignore 步骤")
	} else if stA == http.StatusOK {
		if err := json.Unmarshal(bodyA, &proposedA); err != nil {
			t.Fatalf("decode: %v (%s)", err, bodyA)
		}
		env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+proposedA.ID, map[string]any{
			"action": "ignore", "expected_revision": proposedA.Revision,
		}, &proposedA)
	} else {
		t.Fatalf("A-propose 意外状态码 %d：%s", stA, bodyA)
	}

	_ = be01CreateAndSwitchWorkspace(t, "BE-01-B-ignored")
	t.Cleanup(func() {
		env.mustJSON(t, "POST", "/api/v1/workspaces/"+firstWorkspaceID.String()+"/switch", map[string]any{}, &me)
	})

	st, body := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01IgnoredText})
	if st == http.StatusConflict && strings.Contains(string(body), "memory_ignored_duplicate") {
		t.Fatalf("A 忽略不得阻断 B：got 409 memory_ignored_duplicate：%s", body)
	}
	if st != http.StatusOK {
		t.Fatalf("工作区 B propose 同内容应为 200，got %d：%s", st, body)
	}
	var createdB personalMemory
	if err := json.Unmarshal(body, &createdB); err != nil {
		t.Fatalf("decode: %v (%s)", err, body)
	}
	if createdB.State != "candidate" {
		t.Fatalf("B 应为 candidate：%+v", createdB)
	}
}
