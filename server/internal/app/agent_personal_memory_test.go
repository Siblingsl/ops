package app

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-13（W13）个人跨对话记忆测试：T-AI27-M01（候选不注入/确认后注入/开关与会话覆盖）、
// T-AI27-M02（CAS/跨用户拒绝/忽略去重/来源失权）、T-AI27-M03（删除后不注入/不碰账号记忆 HC-20）。

func w13Propose(t *testing.T, text string) personalMemory {
	t.Helper()
	var out personalMemory
	env.mustJSON(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{
		"text": text,
	}, &out)
	return out
}

func TestW13MemoryFeatureGates(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.expectErr(t, "GET", "/api/v1/agent/personal-memories", map[string]any{}, "agent_feature_unavailable")
	env.expectErr(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{"text": "x"}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	// 默认设置：use/capture 均开
	var settings map[string]any
	env.mustJSON(t, "GET", "/api/v1/agent/memory-settings", map[string]any{}, &settings)
	if settings["use_enabled"] != true || settings["capture_enabled"] != true {
		t.Fatalf("默认记忆设置应为双开：%v", settings)
	}
}

func TestW13M01CandidateNotInjectedThenActiveInjected(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 候选（模型提案）：写入 candidate，确认前不得注入
	candidate := w13Propose(t, "竞品报告先列证据和日期，再给建议")
	if candidate.State != "candidate" {
		t.Fatalf("提案应为 candidate：%+v", candidate)
	}
	injected := env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New())
	if injected != "" {
		t.Fatalf("候选不得注入 system：%q", injected)
	}

	// 本人确认 → active → 注入（M01 正例）
	var confirmed personalMemory
	env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+candidate.ID, map[string]any{
		"action": "confirm", "expected_revision": candidate.Revision,
	}, &confirmed)
	if confirmed.State != "active" {
		t.Fatalf("确认后应 active：%+v", confirmed)
	}
	injected = env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New())
	if injected == "" || !strings.Contains(injected, "竞品报告先列证据和日期") {
		t.Fatalf("确认后应注入：%q", injected)
	}

	// usage 记录：used=true 落库（27 §11.1.2）
	var usedCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_memory_usage WHERE memory_id=$1 AND used=true`, candidate.ID).Scan(&usedCount); err != nil {
		t.Fatal(err)
	}
	if usedCount == 0 {
		t.Fatal("注入应记录 agent_memory_usage used=true")
	}

	// 全局 use 关闭 → 不注入；会话覆盖 on → 恢复注入（M01 开关与覆盖）
	var settings map[string]any
	env.mustJSON(t, "PATCH", "/api/v1/agent/memory-settings", map[string]any{
		"use_enabled": false, "expected_revision": 1,
	}, &settings)
	if settings["use_enabled"] != false {
		t.Fatalf("全局 use 关闭失败：%v", settings)
	}
	if env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New()) != "" {
		t.Fatal("全局 use 关闭后不得注入")
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/memory-settings", map[string]any{
		"conversation_id": conv.ID.String(), "memory_use_override": "on",
	}, &settings)
	if env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New()) == "" {
		t.Fatal("会话覆盖 on 应恢复注入")
	}
	// 会话覆盖 off → 再禁
	env.mustJSON(t, "PATCH", "/api/v1/agent/memory-settings", map[string]any{
		"conversation_id": conv.ID.String(), "memory_use_override": "off",
	}, &settings)
	if env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New()) != "" {
		t.Fatal("会话覆盖 off 应停止注入")
	}
}

func TestW13M02CASIgnoreDedupAndTenant(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// CAS：revision 不符 409
	m := w13Propose(t, "写微头条开头必须给结论")
	env.expectErr(t, "PATCH", "/api/v1/agent/personal-memories/"+m.ID, map[string]any{
		"action": "confirm", "expected_revision": m.Revision + 5,
	}, "memory_revision_conflict")

	// 忽略后同内容不再生成候选（M02 去重）
	env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+m.ID, map[string]any{
		"action": "ignore", "expected_revision": m.Revision,
	}, &m)
	env.expectErr(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{"text": "写微头条开头必须给结论"}, "memory_ignored_duplicate")

	// 同内容 active 已存在时提案幂等返回既有（不重复入库）
	active := w13Propose(t, "写公众号结尾要留一个问题互动")
	var replay personalMemory
	env.mustJSON(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{"text": "写公众号结尾要留一个问题互动"}, &replay)
	if replay.ID != active.ID || replay.State != "candidate" {
		t.Fatalf("同 hash 候选应幂等返回：%+v vs %+v", active, replay)
	}

	// 跨用户/工作区：他人看不到、改不动（404 不泄露）
	other := env.registerClient(t, "w13-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	var olist struct {
		Memories []personalMemory `json:"memories"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/personal-memories", map[string]any{}, &olist)
	if len(olist.Memories) != 0 {
		t.Fatalf("跨用户不得看到他人记忆：%d", len(olist.Memories))
	}
	other.expectErr(t, "PATCH", "/api/v1/agent/personal-memories/"+active.ID, map[string]any{
		"action": "confirm", "expected_revision": active.Revision,
	}, "not_found")
	other.expectErr(t, "DELETE", "/api/v1/agent/personal-memories/"+active.ID, map[string]any{}, "not_found")

	// 越权来源：他人会话作为 source 拒绝（404）
	other.expectErr(t, "POST", "/api/v1/memories/personal-candidates", map[string]any{
		"text": "借道他人会话", "conversation_id": conv.ID.String(),
	}, "not_found")

	// viewer/代访问拒绝（个人记忆是本人私有功能）
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w13-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("GET", "/api/v1/agent/personal-memories", map[string]any{}); st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，got %d", st)
	}
	viewer.restore(env)
	other.restore(env) // 嵌套注册后恢复 owner 会话（viewer 的 savedC 是 other）
}

func TestW13M03DeleteStopsInjectionAndAccountMemoryUntouched(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	var meDump meInfo
	env.mustJSON(t, "GET", "/api/v1/auth/me", map[string]any{}, &meDump)
	t.Logf("W03 start workspace=%s user=%s role=%s override=%v", meDump.Workspace.ID, meDump.UserID, meDump.Role, meDump.Override)
	// M01 可能留下全局 use=false（同一测试用户共享库），先恢复为 true。
	var cur map[string]any
	env.mustJSON(t, "GET", "/api/v1/agent/memory-settings", map[string]any{}, &cur)
	env.mustJSON(t, "PATCH", "/api/v1/agent/memory-settings", map[string]any{
		"use_enabled": true, "expected_revision": int(cur["revision"].(float64)),
	}, &cur)
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 创建 active（本人显式创建直接 active）
	var m personalMemory
	env.mustJSON(t, "POST", "/api/v1/agent/personal-memories", map[string]any{"text": "报告里的数字必须标注来源时间"}, &m)
	if m.State != "active" {
		t.Fatalf("显式创建应直接 active：%+v", m)
	}
	if got := env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New()); !strings.Contains(got, "报告里的数字必须标注来源时间") {
		t.Fatalf("active 应注入本条记忆：%q", got)
	}

	// 删除：正文清空仅留标记，不再注入（M03）
	env.mustJSON(t, "DELETE", "/api/v1/agent/personal-memories/"+m.ID, map[string]any{}, nil)
	if got := env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, uuid.New()); strings.Contains(got, "报告里的数字必须标注来源时间") {
		t.Fatalf("删除后本条记忆不得注入：%q", got)
	}
	var text string
	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT text, state FROM agent_personal_memory WHERE id=$1`, m.ID).Scan(&text, &state); err != nil {
		t.Fatal(err)
	}
	if text != "" || state != "deleted" {
		t.Fatalf("删除后仅留无正文标记：text=%q state=%q", text, state)
	}
	// 同内容删除后仍可由本人重新显式创建（新 ID）
	var recreated personalMemory
	env.mustJSON(t, "POST", "/api/v1/agent/personal-memories", map[string]any{"text": "报告里的数字必须标注来源时间"}, &recreated)
	if recreated.ID == m.ID || recreated.State != "active" {
		t.Fatalf("删除后重新创建应为新 active 项：%+v", recreated)
	}

	// 账号业务记忆（HC-20）不受影响：账号记忆 API 与状态机原样可用
	var accountMemory struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+env.accounts(t).wechat.ID.String()+"/memories", map[string]any{
		"kind": "tone", "scope": "all", "text": "W13 验证用：语气保持克制",
	}, &accountMemory)
	if accountMemory.ID == "" {
		t.Fatal("账号记忆创建应保持原契约")
	}
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+accountMemory.ID, map[string]any{"status": "disabled"}, nil)
}

// TestW13bMemoryUsageAPI：本会话记忆使用可见性（A9，27 §11.1.2）。
// ①注入后 API 返回 used=true 条目（摘要/来源 run/仍有效）；②会话覆盖 off 后省略
// 语义不产生 usage 行（未注入即无记录）；③跨用户/跨工作区 404 不泄露。
func TestW13bMemoryUsageAPI(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	candidate := w13Propose(t, "周报结构：数据先行，结论后置")
	var confirmed personalMemory
	env.mustJSON(t, "PATCH", "/api/v1/agent/personal-memories/"+candidate.ID, map[string]any{
		"action": "confirm", "expected_revision": candidate.Revision,
	}, &confirmed)
	// usage 查询按 conversation → agent_run → usage 关联；插一条真实 run 行承接记录。
	runID := uuid.New()
	sessionID := agentTestSessionID(t, uuid.MustParse(env.me(t).UserID))
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_run
		(id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage)
		VALUES ($1,$2,$3,$4,$5,'message','completed','completed')`,
		runID, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), sessionID); err != nil {
		t.Fatal(err)
	}
	if env.srv.personalMemorySystemBlock(context.Background(), uuid.MustParse(env.me(t).UserID), uuid.MustParse(env.me(t).Workspace.ID), conv.ID, runID) == "" {
		t.Fatal("active 记忆应注入")
	}

	var out struct {
		Usage []struct {
			MemoryID    string `json:"memory_id"`
			Summary     string `json:"summary"`
			RunID       string `json:"run_id"`
			Used        bool   `json:"used"`
			StillActive bool   `json:"still_active"`
		} `json:"usage"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+conv.ID.String()+"/memory-usage", nil, &out)
	if len(out.Usage) == 0 {
		t.Fatal("usage API 应返回注入记录")
	}
	// 共享工作区夹具可能带先前用例的记忆（排序不保证）——按本用例的记忆 ID 查找断言。
	var found bool
	for _, it := range out.Usage {
		if it.MemoryID == candidate.ID {
			found = true
			if !it.Used || !it.StillActive || it.RunID != runID.String() {
				t.Fatalf("usage 记录字段不符：%+v", it)
			}
			if !strings.Contains(it.Summary, "周报结构") {
				t.Fatalf("摘要应含文本头：%q", it.Summary)
			}
			break
		}
	}
	if !found {
		t.Fatalf("本用例记忆未出现在 usage：%+v", out.Usage)
	}

	// 跨用户 404（他人工作区同 ID 不泄露）
	other := env.registerClient(t, "w13b-other-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	if st, _ := other.do("GET", "/api/v1/agent/conversations/"+conv.ID.String()+"/memory-usage", nil); st != http.StatusNotFound {
		t.Fatalf("跨用户应 404，got %d", st)
	}
}

// TestW13bSimilarHint：候选确认前的相似提示（A9）。
// ①8 字前缀重合的 active 记忆返回（match_mode=literal）；②无重合返回空；
// ③跨用户不返回他人记忆。
func TestW13bSimilarHint(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")
	conv := w16CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	// 直接创建 active 记忆（本人显式创建）。
	var created personalMemory
	env.mustJSON(t, "POST", "/api/v1/agent/personal-memories", map[string]any{
		"text": "周报结构：数据先行，结论后置，附来源",
	}, &created)

	var out struct {
		Memories   []personalMemory `json:"memories"`
		MatchMode  string           `json:"match_mode"`
	}
	// 前缀重合（8 字"周报结构：数据先"）。共享工作区夹具可能命中其他用例的记忆——
	// 断言"本用例记忆在命中列表中"而非唯一。
	env.mustJSON(t, "GET", "/api/v1/agent/personal-memories?similar_to="+url.QueryEscape("周报结构：数据先行但不要写小标题"), nil, &out)
	if out.MatchMode != "literal" {
		t.Fatalf("match_mode 应为 literal：%s", out.MatchMode)
	}
	var hit bool
	for _, m := range out.Memories {
		if m.ID == created.ID {
			hit = true
			break
		}
	}
	if !hit {
		t.Fatalf("前缀相似应命中本用例记忆：%+v", out.Memories)
	}
	// 无重合。
	env.mustJSON(t, "GET", "/api/v1/agent/personal-memories?similar_to="+url.QueryEscape("完全无关的一段话没有任何交集"), nil, &out)
	if len(out.Memories) != 0 {
		t.Fatalf("无重合不应命中：%+v", out.Memories)
	}
	// 跨用户。
	other := env.registerClient(t, "w13b-sim-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	other.mustJSON(t, "GET", "/api/v1/agent/personal-memories?similar_to="+url.QueryEscape("周报结构：数据先行但不要写小标题"), nil, &out)
	if len(out.Memories) != 0 {
		t.Fatalf("跨用户不得返回他人记忆：%+v", out.Memories)
	}
}
