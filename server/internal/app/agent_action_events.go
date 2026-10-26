package app

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// appendAgentActionEventTx 只保存卡片的脱敏状态，不复制结果或一次性值。
func appendAgentActionEventTx(ctx context.Context, tx pgx.Tx, actionID uuid.UUID, changed bool) error {
	var conversationID, runID uuid.UUID
	var status, errorCode string
	var revision int64
	delta := 0
	if changed {
		delta = 1
	}
	if err := tx.QueryRow(ctx, `UPDATE agent_action SET revision=revision+$2 WHERE id=$1
		RETURNING conversation_id,run_id,status,revision,coalesce(error->>'code','')`, actionID, delta).
		Scan(&conversationID, &runID, &status, &revision, &errorCode); err != nil {
		return err
	}
	payload := map[string]any{"action_id": actionID, "status": status, "revision": revision}
	if errorCode != "" {
		payload["error_code"] = errorCode
	}
	_, err := appendAgentEventTx(ctx, tx, conversationID, &runID, "action.updated", payload, nil)
	return err
}

// agentMutateActions 对已鉴权的同一会话元数据串行提交状态和事件。
// query为内部固定SQL，不能包含RETURNING；这里不包围任何业务工具调用。
func (s *Server) agentMutateActions(ctx context.Context, conversationID uuid.UUID, query string, args ...any) ([]uuid.UUID, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, conversationID); err != nil {
		return nil, err
	}
	ids, err := mutateAgentActionsTx(ctx, tx, query, args...)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ids, nil
}

func mutateAgentActionsTx(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, query+` RETURNING id`, args...)
	if err != nil {
		return nil, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, id := range ids {
		if err := appendAgentActionEventTx(ctx, tx, id, true); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

func (s *Server) purgeExpiredAgentActions(ctx context.Context) (int, error) {
	total := 0
	for {
		rows, err := s.db.Query(ctx, `SELECT DISTINCT conversation_id FROM agent_action
			WHERE status IN ('pending','needs_input') AND expires_at<=now() ORDER BY conversation_id LIMIT 100`)
		if err != nil {
			return total, err
		}
		conversations := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return total, err
			}
			conversations = append(conversations, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return total, err
		}
		rows.Close()
		if len(conversations) == 0 {
			return total, nil
		}
		for _, id := range conversations {
			changed, err := s.agentMutateActions(ctx, id, `UPDATE agent_action SET status='expired'
				WHERE conversation_id=$1 AND status IN ('pending','needs_input') AND expires_at<=now()`, id)
			if err != nil {
				return total, err
			}
			total += len(changed)
		}
	}
}
