package app

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
)

// 系统智能体（D-117）契约测试。DEV-AG01 的适配层与模拟模型测试在 ai / mock 包内。

type probeResult struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	OK        bool   `json:"ok"`
	Skipped   bool   `json:"skipped"`
	LatencyMS int64  `json:"latency_ms"`
	Detail    string `json:"detail"`
}

func (e *testEnv) providers(t *testing.T) []Provider {
	t.Helper()
	var list []Provider
	e.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	return list
}

func findProvider(t *testing.T, list []Provider, id string) Provider {
	t.Helper()
	for _, p := range list {
		if p.ID.String() == id {
			return p
		}
	}
	t.Fatalf("供应商 %s 不在列表里", id)
	return Provider{}
}

func findCap(t *testing.T, caps []Capability, model string) Capability {
	t.Helper()
	for _, c := range caps {
		if c.Model == model {
			return c
		}
	}
	t.Fatalf("模型 %s 没有能力记录：%+v", model, caps)
	return Capability{}
}

func probeOK(results []probeResult, key string) (bool, bool) {
	for _, p := range results {
		if p.Key == key {
			return p.OK, true
		}
	}
	return false, false
}

// 判据 1（16 文档第 7.2、13.2 节）：自检新增 tools 与 vision 两项；结果按供应商 + 模型保存；
// 改密钥后清空；删除模型后删除对应记录。
func TestAG02CapabilitySelfTestAndClearing(t *testing.T) {
	env.reauth(t)
	var created Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "能力自检供应商", "base_url": env.mock.URL + "/v1", "api_key": "local-dev-key",
		"models": []string{"mock-writer", "mock-fast"},
	}, &created)
	id := created.ID.String()
	t.Cleanup(func() {
		env.do("DELETE", "/api/v1/model-providers/"+id, map[string]any{"confirm": true})
	})

	// 初始没有能力记录，capabilities 必须是空数组而不是 null。
	got := findProvider(t, env.providers(t), id)
	if got.Capabilities == nil {
		t.Fatal("capabilities 应为空数组，不应为 null")
	}
	if len(got.Capabilities) != 0 {
		t.Fatalf("新供应商不应有能力记录：%+v", got.Capabilities)
	}

	selftest := func(model string) []probeResult {
		t.Helper()
		var res struct {
			Model   string        `json:"model"`
			Results []probeResult `json:"results"`
		}
		env.mustJSON(t, "POST", "/api/v1/model-providers/"+id+"/selftest", map[string]any{"model": model}, &res)
		return res.Results
	}

	// 通过：模拟模型支持工具调用与看图。
	results := selftest("mock-writer")
	if ok, found := probeOK(results, "tools"); !found || !ok {
		t.Fatalf("tools 探测应存在且通过：%+v", results)
	}
	if ok, found := probeOK(results, "vision"); !found || !ok {
		t.Fatalf("vision 探测应存在且通过：%+v", results)
	}
	cap1 := findCap(t, findProvider(t, env.providers(t), id).Capabilities, "mock-writer")
	if cap1.ToolsOK == nil || !*cap1.ToolsOK || cap1.VisionOK == nil || !*cap1.VisionOK {
		t.Fatalf("能力应保存为通过：%+v", cap1)
	}
	if cap1.TestedAt == nil {
		t.Fatal("tested_at 应写入")
	}

	// 失败：模拟模型不支持工具调用与看图。
	env.llm.NoTools, env.llm.NoVision = true, true
	results = selftest("mock-writer")
	env.llm.NoTools, env.llm.NoVision = false, false
	if ok, _ := probeOK(results, "tools"); ok {
		t.Fatalf("模拟不支持工具调用时 tools 探测应失败：%+v", results)
	}
	if ok, _ := probeOK(results, "vision"); ok {
		t.Fatalf("模拟不支持看图时 vision 探测应失败：%+v", results)
	}
	cap1 = findCap(t, findProvider(t, env.providers(t), id).Capabilities, "mock-writer")
	if cap1.ToolsOK == nil || *cap1.ToolsOK || cap1.VisionOK == nil || *cap1.VisionOK {
		t.Fatalf("能力应保存为未通过：%+v", cap1)
	}

	// 改密钥：该供应商全部能力清空为未测试。
	env.reauth(t)
	env.mustJSON(t, "PATCH", "/api/v1/model-providers/"+id, map[string]any{"api_key": "local-dev-key-2"}, nil)
	if caps := findProvider(t, env.providers(t), id).Capabilities; len(caps) != 0 {
		t.Fatalf("改密钥后能力应清空：%+v", caps)
	}

	// 两个模型各自自检，删除其中一个模型后只删除对应记录。
	selftest("mock-writer")
	selftest("mock-fast")
	if caps := findProvider(t, env.providers(t), id).Capabilities; len(caps) != 2 {
		t.Fatalf("应有两个模型的能力记录：%+v", caps)
	}
	env.mustJSON(t, "PATCH", "/api/v1/model-providers/"+id, map[string]any{"models": []string{"mock-writer"}}, nil)
	caps := findProvider(t, env.providers(t), id).Capabilities
	if len(caps) != 1 || caps[0].Model != "mock-writer" {
		t.Fatalf("删除模型后应只保留 mock-writer 的记录：%+v", caps)
	}
}

// 判据 2（16 文档第 7.3 节）：agent_chat、agent_summary 出现在任务路由列表。
func TestAG02AgentTaskTypesInRoutes(t *testing.T) {
	var routes []struct {
		TaskType string `json:"task_type"`
		Label    string `json:"label"`
	}
	env.mustJSON(t, "GET", "/api/v1/model-routes", nil, &routes)
	labels := map[string]string{}
	for _, r := range routes {
		labels[r.TaskType] = r.Label
	}
	if labels["agent_chat"] != "智能体对话" {
		t.Fatalf("agent_chat 路由缺失或标签错误：%+v", labels)
	}
	if labels["agent_summary"] != "智能体摘要" {
		t.Fatalf("agent_summary 路由缺失或标签错误：%+v", labels)
	}
}

// 判据 3（16 文档第 7.3 节第 4 项）：经济 / 质量档不覆盖 agent_chat，但仍覆盖普通任务。
func TestAG02AgentChatIgnoresCostTier(t *testing.T) {
	ctx := context.Background()
	var ws, pid uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM workspace ORDER BY created_at LIMIT 1`).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM model_provider WHERE workspace_id=$1 ORDER BY created_at LIMIT 1`, ws).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	tasks := []string{"tier_economy", "agent_chat", "title"}
	type saved struct {
		task string
		pid  uuid.UUID
		mdl  string
	}
	var restore []saved
	for _, tt := range tasks {
		var mdl string
		var p uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `SELECT provider_id, model FROM model_route WHERE workspace_id=$1 AND task_type=$2`, ws, tt).Scan(&p, &mdl); err == nil {
			restore = append(restore, saved{tt, p, mdl})
		}
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM model_route WHERE workspace_id=$1 AND task_type = ANY($2)`, ws, tasks)
		for _, s := range restore {
			_, _ = env.srv.db.Exec(ctx, `INSERT INTO model_route (workspace_id, task_type, provider_id, model) VALUES ($1,$2,$3,$4)
				ON CONFLICT (workspace_id, task_type) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model`, ws, s.task, s.pid, s.mdl)
		}
	})
	set := func(task, model string) {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO model_route (workspace_id, task_type, provider_id, model) VALUES ($1,$2,$3,$4)
			ON CONFLICT (workspace_id, task_type) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model`, ws, task, pid, model); err != nil {
			t.Fatal(err)
		}
	}
	set("tier_economy", "mock-fast")
	set("agent_chat", "mock-writer")
	set("title", "mock-writer")

	jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	rt, err := env.srv.resolveRouteTier(jctx, "agent_chat", "economy")
	if err != nil {
		t.Fatalf("agent_chat 路由解析失败：%v", err)
	}
	if rt.Model != "mock-writer" {
		t.Fatalf("经济档不应覆盖 agent_chat，得到模型 %s", rt.Model)
	}
	rt2, err := env.srv.resolveRouteTier(jctx, "title", "economy")
	if err != nil {
		t.Fatalf("title 路由解析失败：%v", err)
	}
	if rt2.Model != "mock-fast" {
		t.Fatalf("经济档应覆盖普通任务，得到模型 %s", rt2.Model)
	}
}

// ---------- DEV-AG03：数据表与对话接口（16 文档第 9.2、9.3、9.7、10、11 节） ----------

type meInfo struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	IsAdmin   bool   `json:"is_system_admin"`
	Override  bool   `json:"admin_override"`
	CSRF      string `json:"csrf_token"`
	Workspace struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Role string `json:"role"`
	} `json:"workspace"`
}

func (e *testEnv) me(t *testing.T) meInfo {
	t.Helper()
	var me meInfo
	e.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	return me
}

// ag03Bootstrap 复用产品类型 agentLimits / agentConversation / agentSettings / agentMessageView，
// 只声明 bootstrap 与详情这两个响应包装，保证测试直接校验真实 JSON 形状。
type ag03Bootstrap struct {
	Enabled  bool   `json:"enabled"`
	CanUse   bool   `json:"can_use"`
	Reason   string `json:"reason"`
	Role     string `json:"role"`
	ReadOnly bool   `json:"read_only"`
	Models   []struct {
		ProviderID   string `json:"provider_id"`
		ProviderName string `json:"provider_name"`
		Model        string `json:"model"`
		Vision       bool   `json:"vision"`
		IsDefault    bool   `json:"is_default"`
	} `json:"models"`
	DefaultModel *struct {
		ProviderID string `json:"provider_id"`
		Model      string `json:"model"`
	} `json:"default_model"`
	DefaultModelUnsupported bool        `json:"default_model_unsupported"`
	AllowModelPick          bool        `json:"allow_model_pick"`
	Limits                  agentLimits `json:"limits"`
	PrivacyNoticeSeen       bool        `json:"privacy_notice_seen"`
}

type ag03ConversationList struct {
	Items      []agentConversationListItem `json:"items"`
	NextCursor *string                     `json:"next_cursor"`
}

type ag03Detail struct {
	Conversation agentConversation `json:"conversation"`
	Usage        struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	} `json:"usage"`
	Messages  []agentMessageView `json:"messages"`
	Actions   []agentActionView  `json:"actions"`
	ActiveRun json.RawMessage    `json:"active_run"`
	HasMore   bool               `json:"has_more"`
}

// ensureToolModel 让本地模拟模型的 mock-writer 通过工具调用自检，返回该供应商 ID。
func (e *testEnv) ensureToolModel(t *testing.T) string {
	t.Helper()
	var list []Provider
	e.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	for _, p := range list {
		hasWriter := false
		for _, m := range p.Models {
			if m == "mock-writer" {
				hasWriter = true
			}
		}
		if !hasWriter {
			continue
		}
		for _, c := range p.Capabilities {
			if c.Model == "mock-writer" && c.ToolsOK != nil && *c.ToolsOK {
				return p.ID.String()
			}
		}
		e.mustJSON(t, "POST", "/api/v1/model-providers/"+p.ID.String()+"/selftest", map[string]any{"model": "mock-writer"}, nil)
		return p.ID.String()
	}
	t.Fatal("找不到含 mock-writer 的模型供应商")
	return ""
}

func (e *testEnv) agentBootstrap(t *testing.T) ag03Bootstrap {
	t.Helper()
	var b ag03Bootstrap
	e.mustJSON(t, "GET", "/api/v1/agent/bootstrap", nil, &b)
	return b
}

func (e *testEnv) agentSettingsGet(t *testing.T) agentSettings {
	t.Helper()
	var st agentSettings
	e.mustJSON(t, "GET", "/api/v1/agent/settings", nil, &st)
	return st
}

func (e *testEnv) createConversation(t *testing.T, in any) agentConversation {
	t.Helper()
	var c agentConversation
	e.mustJSON(t, "POST", "/api/v1/agent/conversations", in, &c)
	return c
}

// agentSettingsReset 删除工作区设置行，恢复默认值（默认开启、观察者可用、允许选模型）。
func agentSettingsReset(t *testing.T, ws uuid.UUID) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM app_setting WHERE workspace_id=$1 AND key='agent.settings'`, ws); err != nil {
		t.Fatal(err)
	}
}

func deleteConversations(t *testing.T, ids ...uuid.UUID) {
	t.Helper()
	if len(ids) == 0 {
		return
	}
	_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM agent_conversation WHERE id = ANY($1)`, ids)
}

// 判据 4（16 文档第 11.2 节）：bootstrap 返回可用性、角色、可选模型、默认模型、限额与隐私说明状态。
func TestAG03BootstrapShape(t *testing.T) {
	pid := env.ensureToolModel(t)
	me := env.me(t)
	b := env.agentBootstrap(t)
	if !b.Enabled || !b.CanUse || b.Reason != "" {
		t.Fatalf("默认应可用：%+v", b)
	}
	if b.Role != me.Role || b.ReadOnly {
		t.Fatalf("角色字段错误：%+v", b)
	}
	if !b.AllowModelPick || b.PrivacyNoticeSeen {
		t.Fatalf("默认设置错误：%+v", b)
	}
	found := false
	for _, m := range b.Models {
		if m.ProviderID == pid && m.Model == "mock-writer" {
			found = true
			if m.ProviderName == "" {
				t.Fatalf("模型项缺少供应商名称：%+v", m)
			}
			if !m.IsDefault {
				t.Fatalf("mock-writer 应为默认模型：%+v", m)
			}
		}
	}
	if !found {
		t.Fatalf("可选模型缺少 mock-writer：%+v", b.Models)
	}
	if b.DefaultModel == nil || b.DefaultModel.ProviderID != pid || b.DefaultModel.Model != "mock-writer" {
		t.Fatalf("默认模型错误：%+v", b.DefaultModel)
	}
	if b.DefaultModelUnsupported {
		t.Fatal("默认模型应通过工具调用自检")
	}
	want := agentLimits{MaxRounds: 12, MaxReads: 30, MaxGenerates: 3, MaxCards: 5, RunSeconds: 300,
		MaxContinuations: 10, MessageChars: 8000, AttachmentsPerMessage: 6, ImageBytes: 20971520, TextBytes: 1048576}
	if b.Limits != want {
		t.Fatalf("限额错误：%+v", b.Limits)
	}
}

// 判据 5（16 文档第 11 节、第 9.3 节第 1 项）：工作区关闭智能体后 bootstrap 与 settings 仍可达，
// 其余 /agent/* 返回 403 agent_disabled。
func TestAG03WorkspaceDisabledGate(t *testing.T) {
	ws := uuid.MustParse(env.me(t).Workspace.ID)
	t.Cleanup(func() { agentSettingsReset(t, ws) })
	env.mustJSON(t, "PUT", "/api/v1/agent/settings", map[string]any{"enabled": false}, nil)

	b := env.agentBootstrap(t)
	if b.Enabled || b.CanUse || b.Reason != "disabled" {
		t.Fatalf("关闭后 bootstrap 应表达不可用：%+v", b)
	}
	if st := env.agentSettingsGet(t); st.Enabled {
		t.Fatalf("settings 应返回 enabled=false：%+v", st)
	}
	env.expectErr(t, "GET", "/api/v1/agent/conversations", nil, "agent_disabled")
	env.expectErr(t, "POST", "/api/v1/agent/conversations", map[string]any{}, "agent_disabled")
}

// 判据 6（16 文档第 9.2 节）：观察者默认可读写自己的对话（只读工具），所有者关闭后返回 403；
// 对话保留，重新开启后仍可见。
func TestAG03ViewerGate(t *testing.T) {
	env.ensureToolModel(t)
	ws := uuid.MustParse(env.me(t).Workspace.ID)
	t.Cleanup(func() { agentSettingsReset(t, ws) })

	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "ag03-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if vme.Role != "viewer" {
		t.Fatalf("want viewer, got %s", vme.Role)
	}

	var b ag03Bootstrap
	viewer.mustJSON(t, "GET", "/api/v1/agent/bootstrap", nil, &b)
	if !b.CanUse || b.Reason != "" || !b.ReadOnly || b.Role != "viewer" {
		t.Fatalf("观察者默认可用且只读：%+v", b)
	}
	var conv agentConversation
	viewer.mustJSON(t, "POST", "/api/v1/agent/conversations", map[string]any{}, &conv)
	viewer.restore(env)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	env.mustJSON(t, "PUT", "/api/v1/agent/settings", map[string]any{"viewer_enabled": false}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/agent/bootstrap", nil, &b)
	if b.CanUse || b.Reason != "viewer_disabled" {
		t.Fatalf("关闭后观察者应不可用：%+v", b)
	}
	viewer.expectErr(t, "POST", "/api/v1/agent/conversations", map[string]any{}, "agent_disabled")
	viewer.expectErr(t, "GET", "/api/v1/agent/conversations", nil, "agent_disabled")
	viewer.restore(env)

	// 重新开启后原有对话仍可见（第 9.2 节第 3 项）。
	env.mustJSON(t, "PUT", "/api/v1/agent/settings", map[string]any{"viewer_enabled": true}, nil)
	var list ag03ConversationList
	viewer.mustJSON(t, "GET", "/api/v1/agent/conversations", nil, &list)
	viewer.restore(env)
	kept := false
	for _, it := range list.Items {
		if it.ID == conv.ID {
			kept = true
		}
	}
	if !kept {
		t.Fatalf("重新开启后观察者的对话应保留：%+v", list.Items)
	}
}

// 判据 7（16 文档第 9.3 节第 1 项）：超管代访问时 /agent/* 返回 403 agent_disabled，
// bootstrap 仍可达并说明原因（用户裁决：bootstrap 与 settings 始终可达）。
func TestAG03AdminOverrideGate(t *testing.T) {
	ws := env.me(t).Workspace.ID
	st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if st != 200 {
		t.Fatalf("登录超管失败：%d %s", st, body)
	}
	defer func() {
		st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
		if st != 200 {
			t.Fatalf("恢复 owner 会话失败：%d %s", st, body)
		}
		env.csrf = env.me(t).CSRF
	}()
	env.csrf = env.me(t).CSRF
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/"+ws+"/enter", map[string]any{}, nil)
	env.csrf = env.me(t).CSRF

	b := env.agentBootstrap(t)
	if b.CanUse || b.Reason != "admin_override" {
		t.Fatalf("代访问应不可用：%+v", b)
	}
	env.mustJSON(t, "GET", "/api/v1/agent/settings", nil, nil)
	env.expectErr(t, "GET", "/api/v1/agent/conversations", nil, "agent_disabled")
	env.expectErr(t, "POST", "/api/v1/agent/conversations", map[string]any{}, "agent_disabled")
	env.mustJSON(t, "POST", "/api/v1/admin/workspaces/exit", map[string]any{}, nil)
}

// 判据 8（16 文档第 11.1 节）：对话新建、改名、置顶、搜索、删除；删除需要 confirm=true。
func TestAG03ConversationCRUD(t *testing.T) {
	env.ensureToolModel(t)
	c1 := env.createConversation(t, map[string]any{})
	if c1.Title != "新对话" || c1.TitleSource != "auto" || c1.PinnedAt != nil || c1.Model != "" || c1.ModelProviderID != nil {
		t.Fatalf("新建对话默认值错误：%+v", c1)
	}
	c2 := env.createConversation(t, map[string]any{"title": "第二篇"})
	if c2.Title != "第二篇" || c2.TitleSource != "user" {
		t.Fatalf("用户标题应记为 user：%+v", c2)
	}
	t.Cleanup(func() { deleteConversations(t, c1.ID, c2.ID) })

	var patched agentConversation
	env.mustJSON(t, "PATCH", "/api/v1/agent/conversations/"+c1.ID.String(), map[string]any{"title": "第一篇"}, &patched)
	if patched.Title != "第一篇" || patched.TitleSource != "user" {
		t.Fatalf("改名失败：%+v", patched)
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/conversations/"+c2.ID.String(), map[string]any{"pinned": true}, &patched)
	if patched.PinnedAt == nil {
		t.Fatalf("置顶失败：%+v", patched)
	}

	var list ag03ConversationList
	env.mustJSON(t, "GET", "/api/v1/agent/conversations", nil, &list)
	if len(list.Items) < 2 || list.Items[0].ID != c2.ID {
		t.Fatalf("置顶应排在最前：%+v", list.Items)
	}
	if list.Items[0].PendingActions != 0 || list.Items[0].HasActiveRun {
		t.Fatalf("空对话列表汇总应无待处理卡片或运行：%+v", list.Items[0])
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations?q="+url.QueryEscape("第一篇"), nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != c1.ID {
		t.Fatalf("按标题搜索失败：%+v", list.Items)
	}
	env.mustJSON(t, "PATCH", "/api/v1/agent/conversations/"+c2.ID.String(), map[string]any{"pinned": false}, &patched)
	if patched.PinnedAt != nil {
		t.Fatalf("取消置顶失败：%+v", patched)
	}

	var detail ag03Detail
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+c1.ID.String(), nil, &detail)
	if detail.Conversation.ID != c1.ID || len(detail.Messages) != 0 || len(detail.Actions) != 0 || detail.HasMore {
		t.Fatalf("空对话详情错误：%+v", detail)
	}
	if detail.Usage.PromptTokens != 0 || detail.Usage.CompletionTokens != 0 {
		t.Fatalf("空对话用量应为零：%+v", detail.Usage)
	}
	if string(detail.ActiveRun) != "null" {
		t.Fatalf("无运行时应返回 null：%s", detail.ActiveRun)
	}

	env.expectErr(t, "DELETE", "/api/v1/agent/conversations/"+c1.ID.String(), nil, "validation_failed")
	env.mustJSON(t, "DELETE", "/api/v1/agent/conversations/"+c1.ID.String()+"?confirm=true", nil, nil)
	env.expectErr(t, "GET", "/api/v1/agent/conversations/"+c1.ID.String(), nil, "not_found")
}

// 判据 9（16 文档第 11.1、11.2 节）：详情返回最近 50 条消息与 has_more，before_seq 取更早的 50 条；
// role=tool 不单独列出，折叠进助手消息的 tool_calls。
func TestAG03ConversationDetailWindow(t *testing.T) {
	env.ensureToolModel(t)
	ctx := context.Background()
	c := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, c.ID) })

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message (conversation_id, seq, role, content)
		SELECT $1, g, 'user', '消息 '||g FROM generate_series(1,55) g`, c.ID); err != nil {
		t.Fatal(err)
	}

	var detail ag03Detail
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+c.ID.String(), nil, &detail)
	if len(detail.Messages) != 50 || !detail.HasMore {
		t.Fatalf("应返回最近 50 条且 has_more=true：%d %v", len(detail.Messages), detail.HasMore)
	}
	if detail.Messages[0].Seq != 6 || detail.Messages[49].Seq != 55 {
		t.Fatalf("窗口序号错误：%d..%d", detail.Messages[0].Seq, detail.Messages[49].Seq)
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+c.ID.String()+"?before_seq=6", nil, &detail)
	if len(detail.Messages) != 5 || detail.HasMore || detail.Messages[0].Seq != 1 {
		t.Fatalf("before_seq 窗口错误：%d %v", len(detail.Messages), detail.HasMore)
	}
	// 按本人消息文字搜索
	var list ag03ConversationList
	env.mustJSON(t, "GET", "/api/v1/agent/conversations?q="+url.QueryEscape("消息 7"), nil, &list)
	if len(list.Items) != 1 || list.Items[0].ID != c.ID {
		t.Fatalf("按消息文字搜索失败：%+v", list.Items)
	}

	// 工具调用折叠
	tc := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, tc.ID) })
	callID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message (conversation_id, seq, role, content, tool_calls, ai_call_id)
		VALUES ($1,1,'assistant','','[{"id":"tc1","name":"works__list","arguments":"{}"}]'::jsonb,$2)`, tc.ID, callID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message (conversation_id, seq, role, content, tool_call_id, tool_name)
		VALUES ($1,2,'tool','作品列表（18 篇）','tc1','works__list')`, tc.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+tc.ID.String(), nil, &detail)
	if len(detail.Messages) != 1 || detail.Messages[0].Role != "assistant" {
		t.Fatalf("role=tool 不应单独列出：%+v", detail.Messages)
	}
	if len(detail.Messages[0].ToolCalls) != 1 {
		t.Fatalf("助手消息应带 1 个工具调用：%+v", detail.Messages[0])
	}
	call := detail.Messages[0].ToolCalls[0]
	if call.ID != "tc1" || call.Name != "works__list" || call.Summary != "作品列表（18 篇）" || call.ResultPreview != "作品列表（18 篇）" {
		t.Fatalf("工具调用折叠错误：%+v", call)
	}
	if detail.Messages[0].AICallID == nil || *detail.Messages[0].AICallID != callID {
		t.Fatalf("助手消息应返回对应 ai_call_id 以显示反馈入口：%+v", detail.Messages[0])
	}
}

// 判据 10（16 文档第 9.4 节、HC-31）：同工作区其他成员（含所有者）访问他人对话一律 404。
func TestAG03ConversationPrivacy(t *testing.T) {
	env.ensureToolModel(t)
	conv := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &inv)
	other := env.registerClient(t, "ag03-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "GET", "/api/v1/agent/conversations/"+conv.ID.String(), nil, "not_found")
	other.expectErr(t, "PATCH", "/api/v1/agent/conversations/"+conv.ID.String(), map[string]any{"title": "越权"}, "not_found")
	other.expectErr(t, "DELETE", "/api/v1/agent/conversations/"+conv.ID.String()+"?confirm=true", nil, "not_found")
	var list ag03ConversationList
	other.mustJSON(t, "GET", "/api/v1/agent/conversations", nil, &list)
	other.restore(env)
	for _, it := range list.Items {
		if it.ID == conv.ID {
			t.Fatalf("他人对话不应出现在列表里：%+v", list.Items)
		}
	}
}

// 判据 11（16 文档第 7.4 节第 1、3 项）：只有通过工具调用自检的模型可以建对话，否则 422 agent_model_unsupported。
func TestAG03ConversationModelValidation(t *testing.T) {
	pid := env.ensureToolModel(t)
	env.expectErr(t, "POST", "/api/v1/agent/conversations",
		map[string]any{"model": map[string]any{"provider_id": pid, "model": "mock-fast"}}, "agent_model_unsupported")
	env.expectErr(t, "POST", "/api/v1/agent/conversations",
		map[string]any{"model": map[string]any{"provider_id": uuid.NewString(), "model": "mock-writer"}}, "agent_model_unsupported")

	c := env.createConversation(t, map[string]any{"model": map[string]any{"provider_id": pid, "model": "mock-writer"}})
	t.Cleanup(func() { deleteConversations(t, c.ID) })
	if c.Model != "mock-writer" || c.ModelProviderID == nil || c.ModelProviderID.String() != pid {
		t.Fatalf("所选模型未保存：%+v", c)
	}
}

// 判据 12（16 文档第 9.6 节、第 11.1 节）：读取设置任何人可用，修改只允许所有者，且写审计 agent_settings_update。
func TestAG03SettingsOwnerOnlyAndAudit(t *testing.T) {
	ws := uuid.MustParse(env.me(t).Workspace.ID)
	owner := uuid.MustParse(env.me(t).UserID)
	t.Cleanup(func() { agentSettingsReset(t, ws) })

	def := env.agentSettingsGet(t)
	if !def.Enabled || !def.ViewerEnabled || !def.AllowModelPick {
		t.Fatalf("默认设置错误：%+v", def)
	}

	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &inv)
	editor := env.registerClient(t, "ag03-editor-"+uuid.NewString()[:8], testPassword)
	editor.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	var eme meInfo
	editor.mustJSON(t, "GET", "/api/v1/auth/me", nil, &eme)
	editor.csrf = eme.CSRF
	editor.mustJSON(t, "GET", "/api/v1/agent/settings", nil, &def)
	editor.expectErr(t, "PUT", "/api/v1/agent/settings", map[string]any{"enabled": false}, "forbidden")
	editor.restore(env)

	env.mustJSON(t, "PUT", "/api/v1/agent/settings", map[string]any{"allow_model_pick": false}, nil)
	if got := env.agentSettingsGet(t); got.AllowModelPick {
		t.Fatalf("设置未生效：%+v", got)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE action='agent_settings_update' AND actor_id=$1`, owner).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("修改智能体设置应写审计 agent_settings_update")
	}
}

// 判据 13（16 文档第 9.2 节第 1、2 项）：观察者白名单覆盖对话类修改路径，但不含卡片执行。
func TestAG03ViewerMutateAllowedAgentPaths(t *testing.T) {
	allowed := []string{
		"/api/v1/agent/conversations",
		"/api/v1/agent/conversations/11111111-1111-1111-1111-111111111111",
		"/api/v1/agent/conversations/11111111-1111-1111-1111-111111111111/messages",
		"/api/v1/agent/conversations/11111111-1111-1111-1111-111111111111/continue",
		"/api/v1/agent/conversations/11111111-1111-1111-1111-111111111111/regenerate",
		"/api/v1/agent/conversations/11111111-1111-1111-1111-111111111111/messages/22222222-2222-2222-2222-222222222222/edit",
		"/api/v1/agent/runs/33333333-3333-3333-3333-333333333333/cancel",
		"/api/v1/agent/actions/44444444-4444-4444-4444-444444444444/reject",
		"/api/v1/agent/attachments",
		"/api/v1/agent/attachments/55555555-5555-5555-5555-555555555555",
	}
	for _, p := range allowed {
		if !viewerMutateAllowed(p) {
			t.Fatalf("%s 应在观察者白名单内", p)
		}
	}
	denied := []string{
		"/api/v1/agent/actions/44444444-4444-4444-4444-444444444444/execute",
		"/api/v1/agent/settings",
	}
	for _, p := range denied {
		if viewerMutateAllowed(p) {
			t.Fatalf("%s 不应在观察者白名单内", p)
		}
	}
}

// 判据 14（16 文档第 9.7 节、第 13.2 节第 10 项）：过期卡片、365 天对话、离开工作区 30 天三类清理。
func TestAG03RetentionCleanup(t *testing.T) {
	ctx := context.Background()
	me := env.me(t)
	ws := uuid.MustParse(me.Workspace.ID)
	owner := uuid.MustParse(me.UserID)
	now := env.srv.now()

	stranger := env.registerClient(t, "ag03-stranger-"+uuid.NewString()[:8], testPassword)
	var sme meInfo
	stranger.mustJSON(t, "GET", "/api/v1/auth/me", nil, &sme)
	stranger.restore(env)
	strangerID := uuid.MustParse(sme.UserID)

	insertConv := func(user uuid.UUID, lastAt time.Time, title string) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO agent_conversation (workspace_id, user_id, title, last_message_at)
			VALUES ($1,$2,$3,$4) RETURNING id`, ws, user, title, lastAt).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	stale := insertConv(owner, now.AddDate(0, 0, -400), "超过 365 天")
	leftOld := insertConv(strangerID, now.AddDate(0, 0, -40), "离开工作区超过 30 天")
	leftNew := insertConv(strangerID, now.AddDate(0, 0, -10), "离开工作区不足 30 天")
	cardConv := insertConv(owner, now, "含过期卡片")
	keep := insertConv(owner, now, "正常对话")
	t.Cleanup(func() { deleteConversations(t, leftNew, cardConv, keep) })

	var runID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO agent_run (conversation_id, workspace_id, user_id, session_id, trigger, status)
		VALUES ($1,$2,$3,$4,'message','awaiting_confirmation') RETURNING id`, cardConv, ws, owner, uuid.New()).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	var actionID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind, target_type, target_id, target_key, params, expires_at)
		VALUES ($1,$2,$3,$4,$5,'tc-1','works__update','W','work',$6,'work:1','{}'::jsonb,$7) RETURNING id`,
		cardConv, runID, uuid.New(), ws, owner, uuid.NewString(), now.Add(-time.Hour)).Scan(&actionID); err != nil {
		t.Fatal(err)
	}

	stats, err := env.srv.purgeAgentData(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.ExpiredActions != 1 {
		t.Fatalf("应过期 1 张卡片：%+v", stats)
	}
	if stats.OldConversations != 1 || stats.Abandoned != 1 {
		t.Fatalf("清理计数错误：%+v", stats)
	}
	var n int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_conversation WHERE id = ANY($1)`,
		[]uuid.UUID{stale, leftOld}).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("过期对话应被删除：%d", n)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_conversation WHERE id = ANY($1)`,
		[]uuid.UUID{leftNew, cardConv, keep}).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("近期对话不应被删除：%d", n)
	}
	var status string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM agent_action WHERE id=$1`, actionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "expired" {
		t.Fatalf("卡片应为 expired，实际 %s", status)
	}
}

// 判据 15（16 文档第 11.2 节、第 9.4 节第 5 项）：隐私说明状态存于用户偏好，bootstrap 返回该值。
func TestAG03PrivacyNoticePreference(t *testing.T) {
	owner := uuid.MustParse(env.me(t).UserID)
	if env.agentBootstrap(t).PrivacyNoticeSeen {
		t.Fatal("默认应为未读过")
	}
	var prefs UserPrefs
	env.mustJSON(t, "GET", "/api/v1/me/preferences", nil, &prefs)
	if prefs.AgentPrivacyNoticeSeen {
		t.Fatal("偏好默认应为 false")
	}
	env.mustJSON(t, "PUT", "/api/v1/me/preferences", map[string]any{"agent_privacy_notice_seen": true}, &prefs)
	if !prefs.AgentPrivacyNoticeSeen {
		t.Fatal("偏好未写入")
	}
	if !env.agentBootstrap(t).PrivacyNoticeSeen {
		t.Fatal("bootstrap 应反映偏好")
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`UPDATE app_user SET preferences = preferences - 'agent_privacy_notice_seen' WHERE id=$1`, owner)
	})
}
