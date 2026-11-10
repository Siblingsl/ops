package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// BE-01（docs/33 §11.2）：个人记忆去重的工作区维度复现用例。
// 事实链（docs/33 登记为【实证】）：00090 唯一索引与三处去重查询（create 幂等返回 /
// patch 409 / propose ignored 拒绝）只按 user_id+content_hash，无 workspace_id；
// 而 27 §11.1.1 的设计契约是「本人当前工作区跨会话的长期偏好」（作用域 user+workspace），
// 列表与注入查询均带 workspace_id。身份模型（D-036）允许同一 user 属于多个 workspace。
//
// 本文件只做【评估 + 复现】：用例能稳定区分「按 user 去重」与「按 workspace 去重」
// 两种行为；不改迁移、不改业务代码（红线：迁移属 L3，须单独立项拍板）。
// 若断言「按 workspace 去重」的行为失败，即为缺陷复现——评估结论据此写 docs/90。

const be01MemoryText = "BE-01 复现：竞品报告先列证据和日期，再给建议"
const be01IgnoredText = "BE-01 复现：忽略去重跨工作区用例专用文本"

type be01WorkspaceRef struct {
	ID uuid.UUID `json:"id"`
}

// be01CreateAndSwitchWorkspace 为当前用户创建第二个工作区并切换过去，返回其 ID。
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
		Items []map[string]any `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/personal-memories", map[string]any{}, &out)
	return out.Items
}

// TestBE01PersonalMemoryDedupAcrossWorkspaces：同一 user 在两个 workspace 保存同内容。
// 设计契约（27 §11.1.1）下的正确行为：两个 workspace 各有一条 active 记忆
// （作用域 user+workspace，互不可见、互不串扰）。
// 当前实现（按 user 去重）下的缺陷行为：第二次保存幂等返回第一个工作区的记忆——
// 调用方拿到「保存成功」，但在当前工作区列表里查不到该条（跨工作区串扰）。
func TestBE01PersonalMemoryDedupAcrossWorkspaces(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	// 记住初始（第一个）工作区，便于用后切回。
	var me map[string]any
	env.mustJSON(t, "GET", "/api/v1/auth/me", map[string]any{}, &me)
	firstWorkspaceID := uuid.MustParse(me["workspace"].(map[string]any)["id"].(string))

	// 工作区 A：确认一条记忆。
	var confirmedA personalMemory
	env.mustJSON(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01MemoryText}, &confirmedA)
	env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+confirmedA.ID, map[string]any{
		"action": "confirm", "expected_revision": confirmedA.Revision,
	}, &confirmedA)
	if confirmedA.State != "active" {
		t.Fatalf("工作区 A 确认后应为 active：%+v", confirmedA)
	}

	// 切到工作区 B：同一 user，保存完全相同的内容。
	_ = be01CreateAndSwitchWorkspace(t, "BE-01-B")
	t.Cleanup(func() {
		// 乱序隔离（A22）：用后切回初始工作区，避免影响其它用例的共享身份。
		env.mustJSON(t, "POST", "/api/v1/workspaces/"+firstWorkspaceID.String()+"/switch", map[string]any{}, &me)
	})

	var createdB personalMemory
	st, body := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01MemoryText})
	if st == http.StatusOK {
		if err := json.Unmarshal(body, &createdB); err != nil {
			t.Fatalf("decode: %v (%s)", err, body)
		}
	}

	// 行为判据：按 workspace 去重 → B 里新建一条 candidate（ID 与 A 不同）。
	// 按 user 去重（当前实现）→ 幂等返回 A 的行（ID 相同）→ 跨工作区串扰。
	if st == http.StatusOK && createdB.ID == confirmedA.ID {
		items := be01ListAll(t)
		found := false
		for _, item := range items {
			if item["id"] == confirmedA.ID {
				found = true
			}
		}
		t.Fatalf("BE-01 缺陷复现：工作区 B 保存同内容幂等返回了工作区 A 的记忆（id=%s, state=%v）；"+
			"且该 ID 在 B 的列表中可见性=%v（设计契约要求 B 有自己的候选，A 的行不应跨工作区返回）",
			confirmedA.ID, createdB.State, found)
	}

	// 按 workspace 去重的正确行为：B 新建 candidate 成功（200）或幂等返回 B 自己的行。
	if st == http.StatusOK && createdB.ID == confirmedA.ID {
		t.Fatalf("不可达：上方已处理幂等串扰分支")
	}
	if st != http.StatusOK && st != http.StatusConflict {
		t.Fatalf("工作区 B 保存同内容出现意外状态码 %d：%s", st, body)
	}
}

// TestBE01PersonalMemoryIgnoredDedupAcrossWorkspaces：propose 的 ignored 去重同样只按
// user_id——A 工作区忽略的内容会让 B 工作区无法生成同内容候选（若复现则为跨工作区拒绝）。
func TestBE01PersonalMemoryIgnoredDedupAcrossWorkspaces(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	var me map[string]any
	env.mustJSON(t, "GET", "/api/v1/auth/me", map[string]any{}, &me)
	firstWorkspaceID := uuid.MustParse(me["workspace"].(map[string]any)["id"].(string))

	// 工作区 A：生成候选并忽略。
	// 乱序隔离（A22）：测试库与本人账号跨 -count 运行持久——上次运行留下的 ignored 行
	// 会让本次 A-propose 返回 409 memory_ignored_duplicate（那是 user 级去重本身）。
	// 幂等容忍：拿到既有 ignored 行即可，不影响 B 侧判据。
	var proposedA personalMemory
	if stA, bodyA := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01IgnoredText}); stA == http.StatusConflict && strings.Contains(string(bodyA), "memory_ignored_duplicate") {
		// 既有 ignored 行：ID 未知也不需要——patch 步骤同样幂等跳过。
		t.Log("A-propose 命中上次运行的 ignored 行（user 级去重），跳过 ignore 步骤")
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

	// 切到工作区 B：同内容 propose。
	_ = be01CreateAndSwitchWorkspace(t, "BE-01-B-ignored")
	t.Cleanup(func() {
		env.mustJSON(t, "POST", "/api/v1/workspaces/"+firstWorkspaceID.String()+"/switch", map[string]any{}, &me)
	})

	st, body := env.do("POST", "/api/v1/memories/personal-candidates", map[string]any{"text": be01IgnoredText})
	if st == http.StatusConflict && strings.Contains(string(body), "memory_ignored_duplicate") {
		items := be01ListAll(t)
		t.Fatalf("BE-01 缺陷复现：A 工作区忽略的内容阻断了 B 工作区生成同内容候选"+
			"（409 memory_ignored_duplicate；B 列表条数=%d，应为空）——按 user 去重跨工作区拒绝", len(items))
	}
	if st != http.StatusOK {
		t.Fatalf("工作区 B propose 同内容出现意外状态码 %d：%s", st, body)
	}
}
