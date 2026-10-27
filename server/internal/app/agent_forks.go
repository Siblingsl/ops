package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type agentForkMessage struct {
	ID            uuid.UUID
	Seq           int
	Role          string
	Content       string
	ToolCalls     []byte
	ToolCallID    string
	ToolName      string
	AttachmentIDs []uuid.UUID
	ContextRefs   []byte
}

type agentForkToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

func agentForkToolID(branchID uuid.UUID, id string) string {
	return branchID.String() + ":" + id
}

func agentForkSafeToolCalls(branchID uuid.UUID, raw []byte) ([]byte, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var calls []agentForkToolCall
	if err := json.Unmarshal(raw, &calls); err != nil {
		return nil, err
	}
	for i := range calls {
		calls[i].ID = agentForkToolID(branchID, calls[i].ID)
		calls[i].Arguments = "{}"
	}
	return json.Marshal(calls)
}

func agentForkActualCutoff(messages []agentForkMessage, requested int) int {
	results := map[string]int{}
	for _, message := range messages {
		if message.Role == "tool" && message.Seq <= requested {
			results[message.ToolCallID] = message.Seq
		}
	}
	for _, message := range messages {
		if message.Seq > requested || message.Role != "assistant" || len(message.ToolCalls) == 0 || string(message.ToolCalls) == "null" {
			continue
		}
		var calls []agentForkToolCall
		if json.Unmarshal(message.ToolCalls, &calls) != nil {
			return message.Seq - 1
		}
		for _, call := range calls {
			if call.ID == "" {
				return message.Seq - 1
			}
			if seq, ok := results[call.ID]; !ok || seq <= message.Seq || seq > requested {
				return message.Seq - 1
			}
		}
	}
	return requested
}

func agentForkSanitizeToolResult(content string) string {
	var value any
	if json.Unmarshal([]byte(content), &value) != nil {
		return content
	}
	var scrub func(any) any
	scrub = func(item any) any {
		switch typed := item.(type) {
		case map[string]any:
			out := make(map[string]any, len(typed))
			for key, child := range typed {
				if strings.EqualFold(key, "secret_once") {
					continue
				}
				out[key] = scrub(child)
			}
			return out
		case []any:
			out := make([]any, len(typed))
			for i := range typed {
				out[i] = scrub(typed[i])
			}
			return out
		default:
			return item
		}
	}
	clean, err := json.Marshal(scrub(value))
	if err != nil {
		return "{}"
	}
	return string(clean)
}

func (s *Server) agentForkValidatedRefs(ctx context.Context, conversation *agentConversation, raw []byte) ([]agentContextReference, error) {
	refs := []agentContextReference{}
	if err := json.Unmarshal(raw, &refs); err != nil {
		return nil, err
	}
	valid := make([]agentContextReference, 0, len(refs))
	for _, ref := range refs {
		items, err := s.agentValidateContextReferences(ctx, []agentContextReference{ref}, conversation.AccountID, conversation.ID)
		if err == nil {
			valid = append(valid, items[0])
			continue
		}
		var api *APIError
		if errors.As(err, &api) {
			continue
		}
		return nil, err
	}
	return valid, nil
}

func (s *Server) agentReferenceForkAttachmentTx(ctx context.Context, tx pgx.Tx, attachmentID,
	sourceConversationID, sourceMessageID, targetConversationID, targetMessageID uuid.UUID,
	workspaceID, userID uuid.UUID) error {
	var storagePath string
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT storage_path,referenced FROM agent_attachment WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND parse_status='ready' FOR UPDATE`,
		attachmentID, workspaceID, userID).Scan(&storagePath, &referenced); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(422, "agent_attachment_invalid", "分支附件已失效，请从来源会话重新上传")
		}
		return err
	}
	if !referenced {
		return apiErr(422, "agent_attachment_invalid", "分支附件引用已失效，请从来源会话重新上传")
	}
	var sourceRef bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_attachment_ref WHERE attachment_id=$1 AND conversation_id=$2 AND message_id=$3)`,
		attachmentID, sourceConversationID, sourceMessageID).Scan(&sourceRef); err != nil {
		return err
	}
	if !sourceRef {
		return apiErr(422, "agent_attachment_invalid", "附件不再属于来源消息")
	}
	if _, err := os.Stat(s.agentAttachmentFile(storagePath)); err != nil {
		return apiErr(422, "agent_attachment_invalid", "分支附件文件已失效，请从来源会话重新上传")
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_attachment_ref(attachment_id,conversation_id,workspace_id,user_id,message_id)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, attachmentID, targetConversationID, workspaceID, userID, targetMessageID)
	return err
}

func (s *Server) postAgentConversationFork(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	ctx := r.Context()
	sourceID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	source, err := s.agentConversationFor(ctx, sourceID)
	if err != nil {
		return err
	}
	var req struct {
		ThroughMessageID string `json:"through_message_id"`
		RequestID        string `json:"request_id"`
		Title            string `json:"title"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	throughMessageID, err := uuid.Parse(strings.TrimSpace(req.ThroughMessageID))
	if err != nil || throughMessageID == uuid.Nil {
		return validation("请选择一条已保存消息作为分支截点")
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil {
		return validation("创建分支必须提供有效的 request_id")
	}
	title := strings.TrimSpace(req.Title)
	titleSource := "user"
	if title == "" {
		titleSource = "auto"
	}
	if runeLen(title) > 60 {
		return validation("分支标题最多 60 字")
	}
	hashPayload := map[string]any{"through_message_id": throughMessageID, "title": title}
	operation := "conversation.fork:" + sourceID.String()
	identity := ident(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, identity.UserID); err != nil {
		return err
	}
	lockedSource, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, sourceID, identity.WorkspaceID, identity.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if source.Revision != lockedSource.Revision || !agentSameUUID(source.AccountID, lockedSource.AccountID) {
		return apiErr(409, "agent_revision_conflict", "来源会话已变化，请刷新后重新创建分支")
	}
	resource, err := claimAgentRequest(ctx, tx, identity.WorkspaceID, identity.UserID, operation, requestID, hashPayload)
	if err != nil {
		return err
	}
	if resource != nil {
		var branch *agentConversation
		branch, err = scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, *resource, identity.WorkspaceID, identity.UserID))
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(409, "agent_request_conflict", "原分支已删除，不能重放创建结果")
		}
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"conversation": branch, "actual_through_seq": branch.ForkUptoSeq, "replayed": true})
	}
	var requestedSeq int
	if err := tx.QueryRow(ctx, `SELECT seq FROM agent_message WHERE id=$1 AND conversation_id=$2
		AND role IN ('user','assistant','action_result','system_note')`, throughMessageID, sourceID).Scan(&requestedSeq); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(422, "agent_context_unavailable", "分支截点消息不存在或尚未保存")
		}
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id,seq,role,content,tool_calls,tool_call_id,tool_name,attachment_ids,context_refs
		FROM agent_message WHERE conversation_id=$1 AND seq<=$2 ORDER BY seq`, sourceID, requestedSeq)
	if err != nil {
		return err
	}
	messages := []agentForkMessage{}
	for rows.Next() {
		var item agentForkMessage
		if err := rows.Scan(&item.ID, &item.Seq, &item.Role, &item.Content, &item.ToolCalls, &item.ToolCallID,
			&item.ToolName, &item.AttachmentIDs, &item.ContextRefs); err != nil {
			rows.Close()
			return err
		}
		messages = append(messages, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	cutoff := agentForkActualCutoff(messages, requestedSeq)
	if title == "" {
		title = truncateRunes(strings.TrimSpace(lockedSource.Title)+"（分支）", 60)
	}
	fixedRefs := []agentContextReference{}
	var fixedRaw []byte
	if err := tx.QueryRow(ctx, `SELECT fixed_context_refs FROM agent_conversation WHERE id=$1`, sourceID).Scan(&fixedRaw); err != nil {
		return err
	}
	if err := json.Unmarshal(fixedRaw, &fixedRefs); err != nil {
		return err
	}
	validFixed := []agentContextReference{}
	for _, ref := range fixedRefs {
		ref.Scope = "conversation"
		validated, validateErr := s.agentValidateContextReferences(ctx, []agentContextReference{ref}, lockedSource.AccountID)
		if validateErr == nil {
			validFixed = append(validFixed, validated[0])
		} else {
			var api *APIError
			if !errors.As(validateErr, &api) {
				return validateErr
			}
		}
	}
	fixedJSON, err := json.Marshal(validFixed)
	if err != nil {
		return err
	}
	var branchID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO agent_conversation(workspace_id,user_id,account_id,model_provider_id,model,mode,
		reasoning_effort,title,title_source,parent_id,fork_upto_seq,fixed_context_refs)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, identity.WorkspaceID, identity.UserID,
		lockedSource.AccountID, lockedSource.ModelProviderID, lockedSource.Model, lockedSource.Mode, lockedSource.ReasoningEffort, title, titleSource, sourceID, cutoff, fixedJSON).Scan(&branchID); err != nil {
		return err
	}
	branch, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c WHERE c.id=$1`, branchID))
	if err != nil {
		return err
	}
	seq := 0
	for _, original := range messages {
		if original.Seq > cutoff {
			break
		}
		seq++
		content := original.Content
		if original.Role == "tool" {
			content = agentForkSanitizeToolResult(content)
		}
		toolCalls, err := agentForkSafeToolCalls(branchID, original.ToolCalls)
		if err != nil {
			return apiErr(422, "agent_context_unavailable", "来源工具记录不完整，无法安全创建分支")
		}
		toolCallID := original.ToolCallID
		if original.Role == "tool" && toolCallID != "" {
			toolCallID = agentForkToolID(branchID, toolCallID)
		}
		refs := []agentContextReference{}
		if original.Role == "user" {
			refs, err = s.agentForkValidatedRefs(ctx, branch, original.ContextRefs)
			if err != nil {
				return err
			}
		}
		refsJSON, _ := json.Marshal(refs)
		var newMessageID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO agent_message(conversation_id,seq,role,content,tool_calls,tool_call_id,tool_name,
			attachment_ids,context_refs,skill_requests,run_id,ai_call_id,source_message_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,NULL,NULL,$10) RETURNING id`, branchID, seq, original.Role,
			content, toolCalls, toolCallID, original.ToolName, original.AttachmentIDs, refsJSON, original.ID).Scan(&newMessageID); err != nil {
			return err
		}
		for _, attachmentID := range original.AttachmentIDs {
			if err := s.agentReferenceForkAttachmentTx(ctx, tx, attachmentID, sourceID, original.ID, branchID, newMessageID,
				identity.WorkspaceID, identity.UserID); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET next_seq=$2,last_message_at=CASE WHEN $2>1 THEN now() ELSE created_at END,
		updated_at=now() WHERE id=$1`, branchID, seq+1); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, branchID, nil, "conversation.updated", map[string]any{
		"parent_id": sourceID, "fork_upto_seq": cutoff, "actual_through_seq": cutoff,
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, identity.WorkspaceID, identity.UserID, operation, requestID, branchID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"conversation": branch, "actual_through_seq": cutoff, "replayed": false})
}
