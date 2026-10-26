package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAW04ContextCandidatesRespectAccountScope(t *testing.T) {
	accounts := env.accounts(t)
	workspaceID := ownerWS(t)
	var ownMaterial, otherAccountMaterial, sharedMaterial uuid.UUID
	for _, fixture := range []struct {
		name      string
		accountID any
		into      *uuid.UUID
	}{
		{name: "AW04 本账号素材", accountID: accounts.wechat.ID, into: &ownMaterial},
		{name: "AW04 其他账号私有素材", accountID: accounts.xhs.ID, into: &otherAccountMaterial},
		{name: "AW04 工作区素材", into: &sharedMaterial},
	} {
		if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO material
			(workspace_id, account_id, kind, content, source) VALUES ($1,$2,'case',$3,'手工') RETURNING id`,
			workspaceID, fixture.accountID, fixture.name).Scan(fixture.into); err != nil {
			t.Fatal(err)
		}
		id := *fixture.into
		t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, id) })
	}

	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "")
	env.expectErr(t, http.MethodGet, "/api/v1/agent/context-candidates?type=material&account_id="+accounts.wechat.ID.String(), nil, "agent_feature_unavailable")

	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "context_refs")
	var result struct {
		Items []struct {
			ID        uuid.UUID  `json:"id"`
			Type      string     `json:"type"`
			Name      string     `json:"name"`
			AccountID *uuid.UUID `json:"account_id"`
			Scope     string     `json:"scope"`
		} `json:"items"`
	}
	env.mustJSON(t, http.MethodGet,
		"/api/v1/agent/context-candidates?type=material&account_id="+accounts.wechat.ID.String()+"&q=AW04&limit=20", nil, &result)
	found := map[uuid.UUID]bool{}
	for _, item := range result.Items {
		if item.Type != "material" || item.Name == "" {
			t.Fatalf("candidate must contain only safe summary fields: %+v", item)
		}
		found[item.ID] = true
	}
	if !found[ownMaterial] || !found[sharedMaterial] || found[otherAccountMaterial] {
		t.Fatalf("account-scoped candidates leaked or omitted material: %#v", found)
	}
}

func TestAW04ContextCandidatesPaginateAndBindCursorToQuery(t *testing.T) {
	workspaceID := ownerWS(t)
	for i := 0; i < 2; i++ {
		var id uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO material
			(workspace_id,kind,content,source) VALUES ($1,'case',$2,'手工') RETURNING id`,
			workspaceID, "AW04 分页素材 "+uuid.NewString()).Scan(&id); err != nil {
			t.Fatal(err)
		}
		materialID := id
		t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, materialID) })
	}
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "context_refs")
	var first struct {
		Items      []agentContextCandidate `json:"items"`
		NextCursor string                  `json:"next_cursor"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/context-candidates?type=material&q=AW04%20%E5%88%86%E9%A1%B5&limit=1", nil, &first)
	if len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("first context page must include an opaque cursor: %+v", first)
	}
	var second struct {
		Items []agentContextCandidate `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/context-candidates?type=material&q=AW04%20%E5%88%86%E9%A1%B5&limit=1&cursor="+first.NextCursor, nil, &second)
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID {
		t.Fatalf("context pages must not repeat the same candidate: first=%+v second=%+v", first.Items, second.Items)
	}
	status, body := env.do(http.MethodGet, "/api/v1/agent/context-candidates?type=material&q=other&limit=1&cursor="+first.NextCursor, nil)
	if status != http.StatusConflict || agentErrCodeOf(t, body) != "cursor_stale" {
		t.Fatalf("cursor reused with a different search must return stale conflict: %d %s", status, body)
	}
	status, body = env.do(http.MethodGet, "/api/v1/agent/context-candidates?type=material&q=AW04%20%E5%88%86%E9%A1%B5&limit=2&cursor="+first.NextCursor, nil)
	if status != http.StatusConflict || agentErrCodeOf(t, body) != "cursor_stale" {
		t.Fatalf("cursor reused with a different page size must return stale conflict: %d %s", status, body)
	}
}

func TestAW04ContextPreviewReadsSelectedMaterial(t *testing.T) {
	accounts := env.accounts(t)
	workspaceID := ownerWS(t)
	var materialID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO material
		(workspace_id, account_id, kind, content, source) VALUES ($1,$2,'case','AW04 预览应读取这段素材正文','手工') RETURNING id`,
		workspaceID, accounts.wechat.ID).Scan(&materialID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, materialID) })
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "context_refs")

	var preview struct {
		Items []struct {
			ID      uuid.UUID `json:"id"`
			Type    string    `json:"type"`
			Name    string    `json:"name"`
			Status  string    `json:"status"`
			Content string    `json:"content"`
		} `json:"items"`
		RevisionFingerprint string `json:"revision_fingerprint"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/context-preview", map[string]any{
		"account_id":     accounts.wechat.ID,
		"context_refs":   []map[string]any{{"type": "material", "id": materialID, "scope": "turn"}},
		"skill_requests": []any{}, "attachment_ids": []any{},
	}, &preview)
	if len(preview.Items) != 1 || preview.Items[0].ID != materialID || preview.Items[0].Type != "material" ||
		preview.Items[0].Status != "available" || !strings.Contains(preview.Items[0].Content, "素材正文") || preview.RevisionFingerprint == "" {
		t.Fatalf("preview did not resolve selected material: %+v", preview)
	}
}

func TestAW04ContextPreviewValidatesRealAttachment(t *testing.T) {
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "context_refs")
	status, attachment, body := agentUploadAttachment(t, "AW04 预览.md", []byte("需要在预览中显示的正文"), "")
	if status != http.StatusOK {
		t.Fatalf("upload attachment: %d %s", status, body)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM agent_attachment WHERE id=$1`, attachment.ID)
	})
	var preview struct {
		Items []struct {
			ID      uuid.UUID `json:"id"`
			Type    string    `json:"type"`
			Status  string    `json:"status"`
			Content string    `json:"content"`
		} `json:"items"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/context-preview", map[string]any{
		"context_refs": []any{}, "skill_requests": []any{}, "attachment_ids": []string{attachment.ID.String()},
	}, &preview)
	if len(preview.Items) != 1 || preview.Items[0].ID != attachment.ID || preview.Items[0].Type != "attachment" ||
		preview.Items[0].Status != "available" || !strings.Contains(preview.Items[0].Content, "预览中显示") {
		t.Fatalf("preview must use the uploaded attachment content: %+v", preview)
	}
	status, body = env.do(http.MethodPost, "/api/v1/agent/context-preview", map[string]any{
		"context_refs": []any{}, "skill_requests": []any{}, "attachment_ids": []string{uuid.NewString()},
	})
	if status != http.StatusUnprocessableEntity || agentErrCodeOf(t, body) != "agent_attachment_invalid" {
		t.Fatalf("missing attachment must be rejected: %d %s", status, body)
	}
}

func TestAW04MessageLoadsAndRevalidatesContextReference(t *testing.T) {
	env.ensureToolModel(t)
	accounts := env.accounts(t)
	workspaceID := ownerWS(t)
	var materialID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO material
		(workspace_id, account_id, kind, content, source) VALUES ($1,$2,'case','AW04 本轮必须引用的材料正文','手工') RETURNING id`,
		workspaceID, accounts.wechat.ID).Scan(&materialID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, materialID) })
	conv := env.createConversation(t, map[string]any{"account_id": accounts.wechat.ID})
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "context_refs")

	var candidates struct {
		Items []agentContextCandidate `json:"items"`
	}
	env.mustJSON(t, http.MethodGet,
		"/api/v1/agent/context-candidates?type=material&account_id="+accounts.wechat.ID.String()+"&q=AW04", nil, &candidates)
	if len(candidates.Items) == 0 || candidates.Items[0].ID != materialID {
		t.Fatalf("context candidate missing: %+v", candidates.Items)
	}
	ref := agentContextReference{Type: "material", ID: materialID, Revision: candidates.Items[0].Revision, Scope: "turn"}
	status, body := env.do(http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
		"text": "请根据我附加的材料回答", "context_refs": []agentContextReference{ref},
	})
	if status != http.StatusOK {
		t.Fatalf("send with context ref = %d %s", status, body)
	}

	var persisted []byte
	var runID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT context_refs,run_id FROM agent_message
		WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, conv.ID).Scan(&persisted, &runID); err != nil {
		t.Fatal(err)
	}
	var saved []agentContextReference
	if err := json.Unmarshal(persisted, &saved); err != nil || len(saved) != 1 || saved[0].ID != materialID || saved[0].Revision != ref.Revision {
		t.Fatalf("message context refs not persisted canonically: %s (%v)", persisted, err)
	}
	member := &identity{UserID: uuidOf(ownerUserID(t)), WorkspaceID: workspaceID, Role: "owner"}
	ctx := context.WithValue(context.Background(), ctxMember, member)
	st := &agentRunState{RunID: runID, ConversationID: conv.ID, WorkspaceID: workspaceID, UserID: member.UserID, AccountID: &accounts.wechat.ID}
	messages, err := env.srv.agentBuildMessages(ctx, st, member)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, message := range messages {
		if message.Role == "user" && strings.Contains(message.Content, "本轮必须引用的材料正文") {
			found = true
		}
	}
	if !found {
		t.Fatalf("selected context was not loaded into the model conversation: %+v", messages)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content='已更换版本',updated_at=updated_at+interval '1 second' WHERE id=$1`, materialID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.agentBuildMessages(ctx, st, member); err == nil {
		t.Fatal("changed context reference must stop the affected model call")
	} else if apiErr, ok := err.(*APIError); !ok || apiErr.Code != "agent_context_unavailable" {
		t.Fatalf("changed context error = %v, want agent_context_unavailable", err)
	}
}

func TestAW04SkillRequestsRequireEffectiveUserSkill(t *testing.T) {
	accounts := env.accounts(t)
	ids := skillAgentBind(t, accounts.wechat.ID, 1, true)
	ctx := context.WithValue(context.Background(), ctxMember, &identity{
		UserID: uuidOf(ownerUserID(t)), WorkspaceID: ownerWS(t), Role: "owner",
	})
	valid := []agentSkillRequest{{SkillID: ids[0]}}
	if err := env.srv.agentValidateSkillRequests(ctx, &accounts.wechat.ID, valid); err != nil {
		t.Fatalf("effective personal skill should be requestable by its owner: %v", err)
	}
	if err := env.srv.agentValidateSkillRequests(ctx, &accounts.wechat.ID, []agentSkillRequest{{SkillID: uuid.New()}}); err == nil {
		t.Fatal("unbound skill must not be requestable")
	} else if ae, ok := err.(*APIError); !ok || ae.Code != "agent_skill_unavailable" {
		t.Fatalf("unbound skill error = %v, want agent_skill_unavailable", err)
	}
	if err := env.srv.agentValidateSkillRequests(ctx, nil, valid); err == nil {
		t.Fatal("skill request without account context must be rejected")
	}
}

func TestAW04SkillRequestPersistsAndReachesModelAsRequest(t *testing.T) {
	env.ensureToolModel(t)
	accounts := env.accounts(t)
	ids := skillAgentBind(t, accounts.wechat.ID, 1, true)
	conv := env.createConversation(t, map[string]any{"account_id": accounts.wechat.ID})
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "skill_requests")
	env.llm.ResetRequests()
	status, body := env.do(http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
		"text": "根据我的技能偏好回答", "skill_requests": []map[string]any{{"skill_id": ids[0]}},
	})
	if status != http.StatusOK {
		t.Fatalf("send with effective skill request = %d %s", status, body)
	}
	var raw []byte
	var runID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT skill_requests,run_id FROM agent_message
		WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, conv.ID).Scan(&raw, &runID); err != nil {
		t.Fatal(err)
	}
	var saved []agentSkillRequest
	if err := json.Unmarshal(raw, &saved); err != nil || len(saved) != 1 || saved[0].SkillID != ids[0] {
		t.Fatalf("skill request was not persisted: %s (%v)", raw, err)
	}
	requests := env.llm.Requests()
	if len(requests) == 0 {
		t.Fatal("model request missing")
	}
	modelRequest := requests[len(requests)-1]
	if !strings.Contains(modelRequest, "requested_skills") || !strings.Contains(modelRequest, ids[0].String()) ||
		!strings.Contains(modelRequest, "skill_ref") || !strings.Contains(modelRequest, "本轮请求技能") {
		t.Fatalf("the model must receive requested skill context (requested=%v id=%v ref=%v len=%d): %s",
			strings.Contains(modelRequest, "requested_skills"), strings.Contains(modelRequest, ids[0].String()),
			strings.Contains(modelRequest, "skill_ref"), len(modelRequest), truncate(modelRequest, 12000))
	}
	var usage struct {
		Messages []agentMessageView `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conv.ID.String(), nil, &usage)
	var user, assistant *agentMessageView
	for i := range usage.Messages {
		if usage.Messages[i].Role == "user" {
			user = &usage.Messages[i]
		} else if usage.Messages[i].Role == "assistant" {
			assistant = &usage.Messages[i]
		}
	}
	if user == nil || len(user.SkillRequests) != 1 || user.SkillRequests[0].Name == "" || len(user.SkillUsage) != 0 {
		t.Fatalf("requested skill must not be reported as loaded without a load_skill receipt: %+v", user)
	}
	if assistant == nil || len(assistant.SkillUsage) != 1 || assistant.SkillUsage[0].ID != ids[0] || assistant.SkillUsage[0].Loaded {
		t.Fatalf("without load_skill, the assistant must report the request as not loaded: %+v", assistant)
	}
	if assistant.SkillUsage[0].Used != nil {
		t.Fatalf("model adherence is unknown and must not be reported as used or unused: %+v", assistant.SkillUsage[0])
	}
}
