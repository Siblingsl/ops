package app

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAW08ConversationListScansForkMetadata(t *testing.T) {
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	status, body := env.do(http.MethodGet, "/api/v1/agent/conversations", nil)
	if status != http.StatusOK {
		t.Fatalf("conversation list should scan the fork metadata columns: %d %s", status, body)
	}
}

func TestAW08ForkNormalizesToolGroupsAndKeepsReferencedAttachment(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "conversation_organize,artifacts,context_refs,run_control,event_resume")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	attachmentStatus, attachment, attachmentBody := agentUploadAttachment(t, "分支参考.txt", []byte("仅用于分支附件引用"), conversation.ID.String())
	if attachmentStatus != http.StatusOK {
		t.Fatalf("upload fork attachment: %d %s", attachmentStatus, attachmentBody)
	}
	status, accepted := env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": "读取上下文\n#tool get_context {}", "attachment_ids": []string{attachment.ID.String()},
		"request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("source run not accepted: %d %s", status, accepted)
	}
	aw06WaitRun(t, accepted)
	var source struct {
		Messages []agentMessageView `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String(), nil, &source)
	var toolCallMessage, finalMessage *agentMessageView
	for i := range source.Messages {
		message := &source.Messages[i]
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			toolCallMessage = message
		} else if message.Role == "assistant" {
			finalMessage = message
		}
	}
	if toolCallMessage == nil || finalMessage == nil {
		t.Fatalf("source fixture must contain a complete tool group and final assistant message: %+v", source.Messages)
	}
	forkPath := "/api/v1/agent/conversations/" + conversation.ID.String() + "/fork"
	var partial struct {
		Conversation struct {
			ID uuid.UUID `json:"id"`
		} `json:"conversation"`
		Actual int `json:"actual_through_seq"`
	}
	env.mustJSON(t, http.MethodPost, forkPath, map[string]any{
		"through_message_id": toolCallMessage.ID, "request_id": uuid.NewString(),
	}, &partial)
	if partial.Conversation.ID == uuid.Nil || partial.Actual != toolCallMessage.Seq-1 {
		t.Fatalf("cut inside a tool group must move before the assistant call: %+v", partial)
	}
	var partialMessages struct {
		Messages []agentMessageView `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+partial.Conversation.ID.String(), nil, &partialMessages)
	if len(partialMessages.Messages) != 1 || partialMessages.Messages[0].Role != "user" {
		t.Fatalf("normalized branch should retain only messages before the incomplete tool group: %+v", partialMessages.Messages)
	}

	request := map[string]any{"through_message_id": finalMessage.ID, "request_id": uuid.NewString(), "title": "独立分析分支"}
	var branchReceipt struct {
		Conversation struct {
			ID       uuid.UUID `json:"id"`
			ParentID uuid.UUID `json:"parent_id"`
		} `json:"conversation"`
		Actual int  `json:"actual_through_seq"`
		Replay bool `json:"replayed"`
	}
	status, body := env.do(http.MethodPost, forkPath, request)
	if status != http.StatusOK || json.Unmarshal(body, &branchReceipt) != nil || branchReceipt.Conversation.ID == uuid.Nil || branchReceipt.Actual != finalMessage.Seq {
		t.Fatalf("complete tool group fork = %d %s", status, body)
	}
	branchID := branchReceipt.Conversation.ID
	var expectedMessages int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND seq<=$2`, conversation.ID, finalMessage.Seq).Scan(&expectedMessages); err != nil {
		t.Fatal(err)
	}
	if branchReceipt.Conversation.ParentID != conversation.ID {
		t.Fatalf("branch must retain source conversation locator: %+v", branchReceipt.Conversation)
	}
	var replay struct {
		Conversation struct {
			ID uuid.UUID `json:"id"`
		} `json:"conversation"`
		Replay bool `json:"replayed"`
	}
	env.mustJSON(t, http.MethodPost, forkPath, request, &replay)
	if !replay.Replay || replay.Conversation.ID != branchID {
		t.Fatalf("same fork request must return the original branch: %+v", replay)
	}
	changed := map[string]any{"through_message_id": toolCallMessage.ID, "request_id": request["request_id"], "title": "不同载荷"}
	env.expectErr(t, http.MethodPost, forkPath, changed, "agent_request_conflict")

	var cloned struct {
		IDs           []uuid.UUID
		RunIDs        []uuid.UUID
		AICallIDs     []uuid.UUID
		SourceIDs     []uuid.UUID
		SkillRequests []string
	}
	rows, err := env.srv.db.Query(t.Context(), `SELECT id,run_id,ai_call_id,source_message_id,skill_requests::text
		FROM agent_message WHERE conversation_id=$1 ORDER BY seq`, branchID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id uuid.UUID
		var runID, aiCallID, sourceID *uuid.UUID
		var skillsRaw string
		if err := rows.Scan(&id, &runID, &aiCallID, &sourceID, &skillsRaw); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if runID != nil || aiCallID != nil || sourceID == nil || skillsRaw != "[]" {
			rows.Close()
			t.Fatalf("fork copied execution provenance or omitted source locator: id=%s run=%v ai=%v source=%v skill_requests=%q", id, runID, aiCallID, sourceID, skillsRaw)
		}
		cloned.IDs = append(cloned.IDs, id)
		cloned.SourceIDs = append(cloned.SourceIDs, *sourceID)
		cloned.SkillRequests = append(cloned.SkillRequests, skillsRaw)
	}
	rows.Close()
	if len(cloned.IDs) != expectedMessages || len(cloned.SourceIDs) == 0 {
		t.Fatalf("branch message count/source mapping mismatch: %+v", cloned)
	}
	if status, body := env.do(http.MethodPost, agentRunPath(agentConversation{ID: branchID}, "messages"), map[string]any{
		"text": "沿用分支中的附件继续分析", "attachment_ids": []string{attachment.ID.String()},
	}); status != http.StatusOK {
		t.Fatalf("a fork may use its inherited attachment reference: %d %s", status, body)
	}
	var safeCallID string
	var safeToolCallID string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT tool_calls->0->>'arguments',tool_calls->0->>'id'
		FROM agent_message WHERE conversation_id=$1 AND role='assistant' AND tool_calls IS NOT NULL ORDER BY seq LIMIT 1`, branchID).
		Scan(&safeCallID, &safeToolCallID); err != nil {
		t.Fatal(err)
	}
	if safeCallID != "{}" || len(safeToolCallID) < 37 || safeToolCallID[:36] != branchID.String() {
		t.Fatalf("branch tool call must use a branch-local id and inert arguments: %s %s", safeToolCallID, safeCallID)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT tool_call_id FROM agent_message WHERE conversation_id=$1 AND role='tool' ORDER BY seq LIMIT 1`, branchID).
		Scan(&safeToolCallID); err != nil {
		t.Fatal(err)
	}
	if len(safeToolCallID) < 37 || safeToolCallID[:36] != branchID.String() {
		t.Fatalf("tool result id must be rewritten within the branch: %s", safeToolCallID)
	}
	other := env.registerClient(t, "aw08-fork-private-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	var me meInfo
	other.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	other.csrf = me.CSRF
	other.expectErr(t, http.MethodPost, forkPath, map[string]any{"through_message_id": finalMessage.ID, "request_id": uuid.NewString()}, "not_found")
	other.restore(env)

	if status, body := env.do(http.MethodDelete, "/api/v1/agent/conversations/"+conversation.ID.String()+"?confirm=true", nil); status != http.StatusOK {
		t.Fatalf("delete source after fork: %d %s", status, body)
	}
	filePath := "/api/v1/agent/attachments/" + attachment.ID.String() + "/file?conversation_id=" + branchID.String()
	if status, body := env.do(http.MethodGet, filePath, nil); status != http.StatusOK || len(body) == 0 {
		t.Fatalf("branch attachment must survive source deletion: %d %s", status, body)
	}
	var sourceLink *uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT source_message_id FROM agent_message WHERE conversation_id=$1 AND seq=1`, branchID).Scan(&sourceLink); err != nil || sourceLink != nil {
		t.Fatalf("deleting source must clear parent message foreign key: source=%v err=%v", sourceLink, err)
	}
	var parent *uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT parent_id FROM agent_conversation WHERE id=$1`, branchID).Scan(&parent); err != nil || parent != nil {
		t.Fatalf("deleting source must clear the parent foreign key: parent=%v err=%v", parent, err)
	}
}
