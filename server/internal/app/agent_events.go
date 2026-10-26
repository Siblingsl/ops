package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const agentDeltaRetention = 7 * 24 * time.Hour

type agentEventEnvelope struct {
	EventSeq       int64           `json:"event_seq"`
	ConversationID uuid.UUID       `json:"conversation_id"`
	RunID          *uuid.UUID      `json:"run_id,omitempty"`
	Type           string          `json:"type"`
	CreatedAt      time.Time       `json:"created_at"`
	Data           json.RawMessage `json:"data"`
}

func appendAgentEventTx(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, runID *uuid.UUID,
	eventType string, payload any, expiresAt *time.Time) (int64, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	var seq int64
	if err := tx.QueryRow(ctx, `UPDATE agent_conversation SET next_event_seq=next_event_seq+1
		WHERE id=$1 RETURNING next_event_seq`, conversationID).Scan(&seq); err != nil {
		return 0, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_event (conversation_id,event_seq,run_id,type,payload,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)`, conversationID, seq, runID, eventType, encoded, expiresAt)
	return seq, err
}

func (s *Server) appendAgentEvent(ctx context.Context, conversationID uuid.UUID, runID *uuid.UUID,
	eventType string, payload any) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var expiry *time.Time
	if eventType == "message.delta" {
		until := time.Now().Add(agentDeltaRetention)
		expiry = &until
	}
	seq, err := appendAgentEventTx(ctx, tx, conversationID, runID, eventType, payload, expiry)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return seq, nil
}

func (s *Server) persistAgentDelta(ctx context.Context, st *agentRunState, text string) error {
	if text == "" {
		return nil
	}
	st.PartialOutput += text
	st.PartialChunkIndex++
	eventType := "message.delta"
	payload := map[string]any{"message_key": st.MessageKey, "chunk_index": st.PartialChunkIndex, "text": text}
	if st.DeltaEventCount >= 10000 {
		eventType = ""
		if time.Since(st.LastSnapshotAt) >= time.Second {
			eventType = "message.snapshot"
			payload = map[string]any{"message_key": st.MessageKey, "chunk_index": st.PartialChunkIndex,
				"text": st.PartialOutput}
			st.LastSnapshotAt = time.Now()
		}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE agent_run SET partial_message_key=$2,partial_output=$3,
		partial_chunk_index=$4,partial_updated_at=now() WHERE id=$1`, st.RunID, st.MessageKey,
		st.PartialOutput, st.PartialChunkIndex); err != nil {
		return err
	}
	if eventType != "" {
		var expiry *time.Time
		if eventType == "message.delta" {
			until := time.Now().Add(agentDeltaRetention)
			expiry = &until
		}
		if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, eventType, payload, expiry); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if eventType == "message.delta" {
		st.DeltaEventCount++
	}
	return nil
}

func (s *Server) persistAgentStreamEvent(ctx context.Context, st *agentRunState, oldName string, data any) {
	var eventType string
	var payload map[string]any
	switch oldName {
	case "stage":
		var stage struct {
			Name string `json:"stage"`
		}
		if raw, err := json.Marshal(data); err == nil {
			_ = json.Unmarshal(raw, &stage)
		}
		eventType = "run.stage"
		payload = map[string]any{"stage": stage.Name}
	case "tool":
		var in struct {
			CallID  string `json:"tool_call_id"`
			Name    string `json:"name"`
			Status  string `json:"status"`
			Summary string `json:"summary"`
		}
		if raw, err := json.Marshal(data); err == nil {
			_ = json.Unmarshal(raw, &in)
		}
		eventType = "tool.ended"
		payload = map[string]any{"tool_call_id": in.CallID, "name": in.Name, "status": in.Status,
			"summary": truncate(in.Summary, 120)}
	case "action":
		var in struct {
			ID     uuid.UUID `json:"id"`
			Status string    `json:"status"`
		}
		if raw, err := json.Marshal(data); err == nil {
			_ = json.Unmarshal(raw, &in)
		}
		eventType = "action.updated"
		payload = map[string]any{"action_id": in.ID, "status": in.Status}
	default:
		return
	}
	tx, err := s.db.Begin(ctx)
	if err == nil {
		defer tx.Rollback(ctx)
		if eventType == "run.stage" {
			status := "running"
			if payload["stage"] == "queued" {
				status = "queued"
			}
			_, err = tx.Exec(ctx, `UPDATE agent_run SET status=$2,stage=$3 WHERE id=$1
				AND status IN ('queued','running')`, st.RunID, status, payload["stage"])
		}
		if err == nil {
			_, err = appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, eventType, payload, nil)
		}
		if err == nil {
			err = tx.Commit(ctx)
		}
	}
	if err != nil {
		// Event-log trouble must not turn a completed business read into a failed result;
		// final saved-message and run state remain recoverable from the conversation snapshot.
		slog.WarnContext(ctx, "智能体事件写入失败", "run_id", st.RunID.String(), "event", eventType, "err", err)
	}
}

func (s *Server) existingAgentRunRequest(ctx context.Context, conversationID uuid.UUID, trigger string,
	request *agentRunProtocolRequest) (uuid.UUID, int64, bool, error) {
	if request == nil {
		return uuid.Nil, 0, false, nil
	}
	wantHash, err := agentRequestPayloadHash(request.Payload)
	if err != nil {
		return uuid.Nil, 0, false, err
	}
	var runID uuid.UUID
	var gotHash string
	var startSeq int64
	err = s.db.QueryRow(ctx, `SELECT r.id,r.request_hash,
		coalesce((SELECT min(e.event_seq) FROM agent_event e WHERE e.conversation_id=r.conversation_id
			AND e.run_id=r.id AND e.type='run.started'),0)
		FROM agent_run r WHERE r.conversation_id=$1 AND r.trigger=$2 AND r.request_id=$3`,
		conversationID, trigger, request.RequestID).Scan(&runID, &gotHash, &startSeq)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, 0, false, nil
	}
	if err != nil {
		return uuid.Nil, 0, false, err
	}
	if strings.TrimSpace(gotHash) != wantHash {
		return uuid.Nil, 0, false, apiErr(409, "agent_request_conflict", "请求编号已用于不同内容，请刷新后重新操作")
	}
	if startSeq > 0 {
		startSeq--
	}
	return runID, startSeq, true, nil
}

func (s *Server) agentMessageIDForRequest(ctx context.Context, conversationID uuid.UUID, requestID uuid.UUID) (*uuid.UUID, error) {
	var messageID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT resource_id FROM agent_request WHERE workspace_id=$1 AND user_id=$2
		AND operation=$3 AND request_id=$4`, ident(ctx).WorkspaceID, ident(ctx).UserID,
		"conversation.message:"+conversationID.String(), requestID).Scan(&messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &messageID, nil
}

func writeAgentRunAccepted(w http.ResponseWriter, conversationID, runID uuid.UUID, messageID *uuid.UUID,
	lastEventSeq int64) {
	response := map[string]any{
		"run_id": runID, "events_url": fmt.Sprintf("/api/v1/agent/conversations/%s/events?after_event_seq=%d", conversationID, lastEventSeq),
		"last_event_seq": lastEventSeq,
	}
	if messageID != nil {
		response["message_id"] = messageID
	}
	writeJSON(w, http.StatusAccepted, response)
}

func (s *Server) pruneAgentDeltaEvents(ctx context.Context, conversationID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var floor int64
	if err := tx.QueryRow(ctx, `SELECT coalesce(max(event_seq),0) FROM agent_event
		WHERE conversation_id=$1 AND type='message.delta' AND expires_at<=now()`, conversationID).Scan(&floor); err != nil {
		return err
	}
	if floor == 0 {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agent_event WHERE conversation_id=$1 AND type='message.delta' AND expires_at<=now()`, conversationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET event_retention_floor=greatest(event_retention_floor,$2)
		WHERE id=$1`, conversationID, floor); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func parseAgentEventCursor(query, lastEventID string) (int64, error) {
	query = strings.TrimSpace(query)
	lastEventID = strings.TrimSpace(lastEventID)
	if query != "" && lastEventID != "" && query != lastEventID {
		return 0, apiErr(422, "validation_failed", "事件游标冲突，请使用同一个已确认游标重新连接")
	}
	raw := query
	if raw == "" {
		raw = lastEventID
	}
	if raw == "" {
		return 0, nil
	}
	seq, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || seq < 0 {
		return 0, validation("事件游标无效")
	}
	return seq, nil
}

func (s *Server) getAgentConversationEvents(w http.ResponseWriter, r *http.Request) error {
	conversationID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	if _, err := s.agentConversationFor(r.Context(), conversationID); err != nil {
		return err
	}
	if err := requireAgentFeature("event_resume"); err != nil {
		return err
	}
	after, err := parseAgentEventCursor(r.URL.Query().Get("after_event_seq"), r.Header.Get("Last-Event-ID"))
	if err != nil {
		return err
	}
	if err := s.pruneAgentDeltaEvents(r.Context(), conversationID); err != nil {
		return err
	}
	var maximum, floor int64
	if err := s.db.QueryRow(r.Context(), `SELECT next_event_seq,event_retention_floor FROM agent_conversation
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, conversationID,
		ident(r.Context()).WorkspaceID, ident(r.Context()).UserID).Scan(&maximum, &floor); err != nil {
		return errNotFound
	}
	if after < floor {
		return apiErr(410, "agent_event_cursor_expired", "事件游标已过期，请先重新加载对话快照")
	}
	if after > maximum {
		return apiErr(422, "validation_failed", "事件游标不能超过已保存的最新事件")
	}
	sse := newSSE(w)
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		if err := s.db.QueryRow(r.Context(), `SELECT event_retention_floor FROM agent_conversation WHERE id=$1`,
			conversationID).Scan(&floor); err != nil {
			return err
		}
		if after < floor {
			// 响应头已发送，关闭流；重连会通过入口的410要求客户端重新读取快照。
			return nil
		}
		rows, err := s.db.Query(r.Context(), `SELECT event_seq,run_id,type,payload,created_at
			FROM agent_event WHERE conversation_id=$1 AND event_seq>$2 ORDER BY event_seq LIMIT 500`, conversationID, after)
		if err != nil {
			return err
		}
		for rows.Next() {
			var event agentEventEnvelope
			var raw []byte
			event.ConversationID = conversationID
			if err := rows.Scan(&event.EventSeq, &event.RunID, &event.Type, &raw, &event.CreatedAt); err != nil {
				rows.Close()
				return err
			}
			event.Data = json.RawMessage(raw)
			sse.sendID(event.EventSeq, event.Type, event)
			after = event.EventSeq
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		select {
		case <-r.Context().Done():
			return nil
		case <-poll.C:
		case <-heartbeat.C:
			fmt.Fprint(w, ": heartbeat\n\n")
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
	}
}
