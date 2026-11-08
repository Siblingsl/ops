package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-09（W09）浏览器证据与批注测试（27 §10.1/§13.2/§8.4）：
// T-AI27-27（批注/选段：保存正确来源/版本/选区；不自动发送）、T-AI27-28（证据可回查）、
// T-AI27-32（来源失效与权限）；未读页面不得生成"已核实"（证据必须挂真实命令）。

func w09CreateEvidence(t *testing.T, conv agentConversation, runID uuid.UUID, commandID string, snippet string) browserEvidenceView {
	t.Helper()
	var evidence browserEvidenceView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/evidence", map[string]any{
		"conversation_id": conv.ID.String(), "command_id": commandID, "run_id": runID.String(),
		"origin": "https://example.com/article", "redacted_url": "https://example.com/article",
		"title": "测试文章", "snippet": snippet, "doc_revision": "r1", "kind": "text",
	}, &evidence)
	return evidence
}

func TestW09EvidenceLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	runID := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")

	// 建绑定+租约（证据挂真实命令的前置）
	var pairing browserPairingView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	var grant browserGrantView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/browser-grants", map[string]any{
		"binding_id": confirmed.BindingID, "run_id": runID.String(),
		"tab_handle": "tab-1", "origins": []string{"https://example.com"},
	}, &grant)

	// 创建命令（真实派发）
	var command browserCommandView
	env.mustJSON(t, "POST", "/api/v1/agent/browser/commands", map[string]any{
		"grant_id": grant.ID, "run_id": runID.String(), "request_id": uuid.NewString(),
		"action": "observe", "payload": map[string]any{"tab_id": 1},
	}, &command)

	// 正例：挂真实命令的证据创建成功
	evidence := w09CreateEvidence(t, conv, runID, command.ID, "这是文章正文片段，含结论与日期。")
	if evidence.RedactionState != "clean" || evidence.Origin != "https://example.com/article" {
		t.Fatalf("证据创建结果异常：%+v", evidence)
	}

	// 反例：伪造 command_id 拒绝（未读页面不得生成"已核实"）
	env.expectErr(t, "POST", "/api/v1/agent/browser/evidence", map[string]any{
		"conversation_id": conv.ID.String(), "command_id": uuid.NewString(),
		"origin": "https://evil.com", "title": "伪造", "kind": "text",
	}, "browser_command_unknown")

	// 敏感内容命中隔离（T-AI27-18 相关）
	quarantined := w09CreateEvidence(t, conv, runID, command.ID, "配置示例 sk-ABCDEF1234567890abcdef")
	if quarantined.RedactionState != "quarantined" {
		t.Fatalf("密钥命中应隔离：%+v", quarantined)
	}

	// 查询：本人可见、按 run 过滤
	var list struct {
		Evidence []browserEvidenceView `json:"evidence"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/evidence?conversation_id="+conv.ID.String()+"&run_id="+runID.String(), map[string]any{}, &list)
	if len(list.Evidence) < 2 {
		t.Fatalf("按 run 过滤应至少 2 条证据：%d", len(list.Evidence))
	}

	// 事件投影：browser.evidence_created
	var eventCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_event WHERE conversation_id=$1 AND type='browser.evidence_created'`,
		conv.ID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount < 2 {
		t.Fatalf("evidence_created 事件未投影：%d", eventCount)
	}

	// 跨用户不可见
	other := env.registerClient(t, "w09-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	var olist struct {
		Evidence []browserEvidenceView `json:"evidence"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/browser/evidence?conversation_id="+conv.ID.String(), map[string]any{}, &olist)
	if len(olist.Evidence) != 0 {
		t.Fatalf("跨用户不得看到他人证据：%d", len(olist.Evidence))
	}
	other.restore(env)
}

func TestW09AnnotationLifecycle(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "chrome_connect,browser_workspace,event_resume")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// 批注创建（选区+备注；不自动发送——无消息产生）
	var annotation struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/annotations", map[string]any{
		"conversation_id": conv.ID.String(),
		"origin":          "https://example.com/article",
		"doc_revision":    "r1",
		"selection_text":  "第三段的关键结论",
		"note":            "据此修改第 3 段",
	}, &annotation)
	if annotation.ID == "" {
		t.Fatal("批注应创建成功")
	}

	// 无消息产生（不自动发送）
	var msgCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conv.ID).Scan(&msgCount); err != nil {
		t.Fatal(err)
	}
	if msgCount != 0 {
		t.Fatalf("批注不得自动创建消息：%d", msgCount)
	}

	// 证据关联：批注挂 evidence（正确归属）
	evidence := w09CreateEvidence(t, conv, uuid.Nil, "", "批注依据片段")
	var linked struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/browser/annotations", map[string]any{
		"conversation_id": conv.ID.String(), "evidence_id": evidence.ID,
		"selection_text": "选区", "note": "备注",
	}, &linked)

	// 反例：挂他人证据 409（不误绑）
	other := env.registerClient(t, "w09-ann-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	env.expectErr(t, "POST", "/api/v1/agent/browser/annotations", map[string]any{
		"conversation_id": conv.ID.String(), "evidence_id": evidence.ID,
		"selection_text": "越权选区",
	}, "not_found")
	other.restore(env)

	// 查询
	var list struct {
		Annotations []map[string]any `json:"annotations"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/annotations?conversation_id="+conv.ID.String(), map[string]any{}, &list)
	if len(list.Annotations) != 2 {
		t.Fatalf("批注查询应 2 条：%d", len(list.Annotations))
	}
}
