package app

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

func agentActionExecuteOperation(id uuid.UUID) string { return "action.execute:" + id.String() }

// claimAgentActionExecution 只在短事务中记录受理事实并抢占单卡，不包围业务调用。
func (s *Server) claimAgentActionExecution(ctx context.Context, act *agentActionRow, requestID uuid.UUID,
	payload agentExecuteRequest) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, act.ConversationID); err != nil {
		return false, err
	}
	id := ident(ctx)
	operation := agentActionExecuteOperation(act.ID)
	if requestID != uuid.Nil {
		resource, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
		if err != nil {
			return false, err
		}
		if resource != nil {
			if *resource != act.ID {
				return false, apiErr(409, "agent_request_conflict", "请求编号对应的卡片不一致")
			}
			return true, tx.Commit(ctx)
		}
	}
	changed, err := mutateAgentActionsTx(ctx, tx, `UPDATE agent_action a SET status='executing',decided_by=$2,executed_at=now()
		WHERE id=$1 AND revision=$3 AND status IN ('pending','needs_input') AND expires_at>now()
		AND NOT EXISTS (SELECT 1 FROM agent_run r WHERE r.conversation_id=a.conversation_id AND r.status IN ('queued','running'))
		AND NOT EXISTS (SELECT 1 FROM agent_action x WHERE x.conversation_id=a.conversation_id AND x.status='executing')`,
		act.ID, id.UserID, act.Revision)
	if err != nil {
		return false, err
	}
	if len(changed) == 0 {
		return false, apiErr(409, "agent_action_state_invalid", "卡片或对话状态已变化，请刷新后核对")
	}
	if requestID != uuid.Nil {
		if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, act.ID); err != nil {
			return false, err
		}
	}
	return false, tx.Commit(ctx)
}

func (s *Server) replayAgentActionExecution(w http.ResponseWriter, r *http.Request, act *agentActionRow) error {
	view, err := s.agentActionByID(r.Context(), act.ID)
	if err != nil {
		return err
	}
	if view.Status == "executing" {
		return apiErr(409, "agent_action_state_invalid", "请求已受理，执行结果尚未确定，请先刷新核对卡片状态")
	}
	// 只重新读取脱敏卡片；不重新分发，也不携带原调用的Secrets。
	return s.agentEmitDone(r.Context(), newSSE(w), act, view.ResultSummary, nil, true)
}
