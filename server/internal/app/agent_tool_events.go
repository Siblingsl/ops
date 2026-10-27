package app

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

type agentToolEventError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

type agentToolEvent struct {
	CallID     string               `json:"tool_call_id"`
	Name       string               `json:"name"`
	Status     string               `json:"status"`
	Summary    string               `json:"summary"`
	DurationMS int64                `json:"duration_ms"`
	Error      *agentToolEventError `json:"error,omitempty"`
}

func (s *Server) agentToolStarted(ctx context.Context, st *agentRunState, call ai.ToolCall, send func(string, any)) error {
	secrets := s.agentSecretValues(ctx, st.WorkspaceID)
	name := truncate(agentRedactText(call.Function.Name, secrets), 100)
	event := agentToolEvent{CallID: call.ID, Name: name, Status: "running", Summary: "处理工具 " + name}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_run SET stage='tool' WHERE id=$1 AND status IN ('queued','running') AND stage<>'stopping'`, st.RunID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return context.Canceled
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "tool.started", event, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if send != nil {
		send("stage", map[string]string{"stage": "tool", "tool_name": name, "label": name})
	}
	return nil
}

func (s *Server) agentCommitToolOutcome(ctx context.Context, st *agentRunState, call ai.ToolCall,
	rec agentToolRecord, status string, send func(string, any)) error {
	// 停止只阻止后续分发；已接收的结果必须在取消后的完整工具组中可恢复。
	ctx = context.WithoutCancel(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	event, err := s.agentCommitToolOutcomeTx(ctx, tx, st, call, rec, status)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if send != nil {
		send("tool", event)
	}
	return nil
}

func (s *Server) agentCommitToolOutcomeTx(ctx context.Context, tx pgx.Tx, st *agentRunState, call ai.ToolCall,
	rec agentToolRecord, status string) (agentToolEvent, error) {
	secrets := s.agentSecretValues(ctx, st.WorkspaceID)
	rec.Raw = agentRedactJSONBytes(rec.Raw, secrets)
	event := agentToolEvent{CallID: call.ID, Name: truncate(agentRedactText(call.Function.Name, secrets), 100),
		Status: status, Summary: truncate(agentRedactText(rec.Summary, secrets), 120)}
	if !st.ToolStartedAt.IsZero() {
		event.DurationMS = max(0, time.Since(st.ToolStartedAt).Milliseconds())
	}
	if status != "done" {
		var result struct {
			Error *agentToolEventError `json:"error"`
		}
		if json.Unmarshal(rec.Raw, &result) == nil && result.Error != nil {
			result.Error.Code = truncate(result.Error.Code, 80)
			result.Error.Message = truncate(result.Error.Message, 300)
			result.Error.RequestID = truncate(result.Error.RequestID, 100)
			event.Error = result.Error
		}
	}
	if _, err := s.agentInsertMessageTx(ctx, tx, st, "tool", string(rec.Raw), nil, call.ID, call.Function.Name, nil, nil); err != nil {
		return agentToolEvent{}, err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "tool.ended", event, nil); err != nil {
		return agentToolEvent{}, err
	}
	return event, nil
}

func (s *Server) agentCancelledTool(ctx context.Context, st *agentRunState, call ai.ToolCall, send func(string, any)) error {
	return s.agentSkippedTool(ctx, st, call, "cancelled", "运行已停止，此工具未执行", send)
}

func (s *Server) agentSkippedTool(ctx context.Context, st *agentRunState, call ai.ToolCall, code, message string, send func(string, any)) error {
	payload, _ := json.Marshal(map[string]any{"ok": false, "error": agentToolEventError{Code: code, Message: message}})
	status := "error"
	if code == "cancelled" {
		status = "cancelled"
	}
	return s.agentCommitToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: message}, status, send)
}

func (s *Server) agentHandleToolGroup(ctx context.Context, st *agentRunState, id *identity, calls []ai.ToolCall,
	send func(string, any)) error {
	var firstErr error
	for _, call := range calls {
		if st.AwaitingInput {
			st.ToolStartedAt = time.Time{}
			if err := s.agentDeferredTool(ctx, st, call, send); err != nil {
				return err
			}
			continue
		}
		if ctx.Err() != nil || firstErr != nil {
			st.ToolStartedAt = time.Time{}
			code, message := "cancelled", "运行已停止，此工具未执行"
			if ctx.Err() == nil {
				code, message = "run_ended", "运行已结束，此工具未执行"
			}
			if err := s.agentSkippedTool(ctx, st, call, code, message, send); err != nil {
				return err
			}
			continue
		}
		if err := s.agentHandleToolCall(ctx, st, id, call, send); err != nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Server) agentDeferredTool(ctx context.Context, st *agentRunState, call ai.ToolCall, send func(string, any)) error {
	payload, _ := json.Marshal(map[string]any{"ok": false, "error": agentToolEventError{
		Code: "deferred", Message: "本轮已等待用户回答，此工具未执行",
	}})
	return s.agentCommitToolOutcome(ctx, st, call,
		agentToolRecord{Raw: payload, Model: payload, Summary: "等待用户回答；此工具未执行"}, "deferred", send)
}

// 详情仍在原REPEATABLE READ视图内读取；仅查询当前页声明的工具调用与对应run。
func agentLoadToolActivity(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, messages []agentMessageView) error {
	runs, calls := []uuid.UUID{}, []string{}
	for _, m := range messages {
		if m.RunID == nil || len(m.ToolCalls) == 0 {
			continue
		}
		runs = append(runs, *m.RunID)
		for _, call := range m.ToolCalls {
			calls = append(calls, call.ID)
		}
	}
	if len(calls) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (e.run_id,e.payload->>'tool_call_id') e.run_id::text,e.payload,r.status
		FROM agent_event e JOIN agent_run r ON r.id=e.run_id
		WHERE e.conversation_id=$1 AND e.run_id=ANY($2) AND e.type IN ('tool.started','tool.ended')
		AND e.payload->>'tool_call_id'=ANY($3) ORDER BY e.run_id,e.payload->>'tool_call_id',e.event_seq DESC`, conversationID, runs, calls)
	if err != nil {
		return err
	}
	defer rows.Close()
	activity := map[string]agentToolEvent{}
	for rows.Next() {
		var runID, status string
		var raw []byte
		if err := rows.Scan(&runID, &raw, &status); err != nil {
			return err
		}
		var event agentToolEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			return err
		}
		if event.Status == "running" && status != "running" && status != "queued" {
			event.Status = "interrupted"
			event.Summary = "运行已结束，工具结果未确认"
		}
		activity[runID+":"+event.CallID] = event
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range messages {
		m := &messages[i]
		if m.RunID == nil {
			continue
		}
		for j := range m.ToolCalls {
			call := &m.ToolCalls[j]
			if event, ok := activity[m.RunID.String()+":"+call.ID]; ok {
				call.Status = event.Status
				call.Summary = event.Summary
				call.DurationMS = &event.DurationMS
				if event.Status == "interrupted" {
					call.DurationMS = nil
				}
				call.Error = event.Error
			}
		}
	}
	return nil
}
