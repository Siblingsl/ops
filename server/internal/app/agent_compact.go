package app

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

type agentCompactPreview struct {
	SummaryUptoSeq  int  `json:"summary_upto_seq"`
	ThroughSeq      int  `json:"through_seq"`
	InputChars      int  `json:"input_chars"`
	SummaryChars    int  `json:"summary_chars"`
	EstimatedTokens int  `json:"estimated_tokens"`
	CanCompact      bool `json:"can_compact"`
}

func (s *Server) getAgentCompactPreview(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("event_resume"); err != nil {
		return err
	}
	conversationID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	if _, err := s.agentConversationFor(r.Context(), conversationID); err != nil {
		return err
	}
	preview, err := s.agentCompactPreview(r.Context(), s.db, conversationID)
	if err != nil {
		return err
	}
	return ok(w, preview)
}

func (s *Server) agentCompactPreview(ctx context.Context, reader agentRequestReader, conversationID uuid.UUID) (*agentCompactPreview, error) {
	var upto int
	var summary string
	if err := reader.QueryRow(ctx, `SELECT summary_upto_seq,summary FROM agent_conversation WHERE id=$1`, conversationID).
		Scan(&upto, &summary); err != nil {
		return nil, err
	}
	boundary, err := s.agentWindowBoundary(ctx, conversationID, upto)
	if err != nil {
		return nil, err
	}
	preview := &agentCompactPreview{SummaryUptoSeq: upto, ThroughSeq: boundary, SummaryChars: runeLen(summary), CanCompact: boundary > upto}
	if !preview.CanCompact {
		return preview, nil
	}
	body, err := s.agentOutsideText(ctx, conversationID, upto, boundary)
	if err != nil {
		return nil, err
	}
	preview.InputChars = runeLen(body) + runeLen(summary)
	preview.EstimatedTokens = (preview.InputChars + 3) / 4
	return preview, nil
}

func (s *Server) postAgentCompact(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("event_resume"); err != nil {
		return err
	}
	conversationID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	var req struct {
		RequestID       string `json:"request_id"`
		ProtocolVersion int    `json:"protocol_version"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if req.ProtocolVersion != 2 || err != nil || requestID == uuid.Nil {
		return validation("上下文整理需要协议版本2和有效 request_id")
	}
	ctx := r.Context()
	id := ident(ctx)
	payload := map[string]any{"protocol_version": 2}
	modelConv, err := s.agentConversationFor(ctx, conversationID)
	if err != nil {
		return err
	}
	model, err := s.agentRunModel(ctx, modelConv)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	conversation, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, conversationID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conversation); err != nil {
		return err
	}
	if err := agentCheckRunLimitsWith(ctx, tx, conversationID, id.UserID); err != nil {
		return err
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input','executing'))
		OR EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at>now())
		OR EXISTS(SELECT 1 FROM agent_input WHERE conversation_id=$1 AND status IN ('pending','needs_review'))`, conversationID).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return apiErr(409, "agent_run_busy", "请先处理本对话待办后再整理上下文")
	}
	preview, err := s.agentCompactPreview(ctx, tx, conversationID)
	if err != nil {
		return err
	}
	if !preview.CanCompact {
		return apiErr(409, "agent_compact_not_needed", "当前没有超出模型窗口的旧对话需要整理")
	}
	if err := s.checkLimit(ctx); err != nil {
		return err
	}
	requestOperation := "conversation.compact:" + conversationID.String()
	replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, requestOperation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		var seq int64
		if err := tx.QueryRow(ctx, `SELECT coalesce(min(event_seq),0) FROM agent_event WHERE conversation_id=$1 AND run_id=$2 AND type='run.started'`, conversationID, *replayID).Scan(&seq); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		writeAgentRunAccepted(w, conversationID, *replayID, nil, seq-1)
		return nil
	}
	st, err := s.agentStartRunTx(ctx, tx, "compact", conversation, model, requestID, payload, nil)
	if err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, requestOperation, requestID, st.RunID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := s.startAgentRunBackground(ctx, st); err != nil {
		return err
	}
	writeAgentRunAccepted(w, conversationID, st.RunID, nil, st.StartEventSeq-1)
	return nil
}

func (s *Server) agentCompactOnce(ctx context.Context, st *agentRunState, rt *route, send func(string, any)) error {
	var old string
	var upto int
	if err := s.db.QueryRow(ctx, `SELECT summary,summary_upto_seq FROM agent_conversation WHERE id=$1`, st.ConversationID).Scan(&old, &upto); err != nil {
		return err
	}
	boundary, err := s.agentWindowBoundary(ctx, st.ConversationID, upto)
	if err != nil {
		return err
	}
	if boundary <= upto {
		return apiErr(409, "agent_compact_not_needed", "当前没有超出模型窗口的旧对话需要整理")
	}
	body, err := s.agentOutsideText(ctx, st.ConversationID, upto, boundary)
	if err != nil {
		return err
	}
	if send != nil {
		send("stage", map[string]string{"stage": "compacting"})
	}
	st.Rounds = 1
	result, err := s.agentCallModel(ctx, st, rt, agentModelPayload{Messages: []ai.Message{
		{Role: "system", Content: agentSummaryRules},
		{Role: "user", Content: "已有摘要（更早的历史）：\n" + old + "\n\n需要压缩的历史：\n" + body},
	}}, nil)
	if err != nil {
		return err
	}
	st.PromptTokens += result.Usage.PromptTokens
	st.CompletionTokens += result.Usage.CompletionTokens
	summary := truncate(strings.TrimSpace(result.Text), agentSummaryLimit)
	if summary == "" {
		return apiErr(502, "ai_upstream_error", "模型没有返回摘要")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_conversation SET summary=$3,summary_upto_seq=$4,updated_at=now()
		WHERE id=$1 AND summary_upto_seq=$2`, st.ConversationID, upto, summary, boundary)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return apiErr(409, "agent_revision_conflict", "摘要覆盖范围已变化，请刷新后重试")
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "context.updated", map[string]any{
		"summary_upto_seq": boundary, "summary_chars": runeLen(summary), "manual": true,
	}, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	st.Summary, st.SummaryUptoSeq = summary, boundary
	return nil
}
