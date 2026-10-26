package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type agentMessageRequestPayload struct {
	Text          string
	AttachmentIDs []uuid.UUID
	ContextRefs   []agentContextReference
	SkillRequests []agentSkillRequest
	AccountID     string
	Model         *agentModelRef
}

func parseAgentAttachmentIDs(ids []string) ([]uuid.UUID, error) {
	if len(ids) > agentAttachmentsPerMessage {
		return nil, apiErr(422, "agent_attachment_invalid", "每条消息最多 6 个附件")
	}
	var out []uuid.UUID
	seen := map[uuid.UUID]bool{}
	for _, raw := range ids {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil || id == uuid.Nil || seen[id] {
			return nil, apiErr(422, "agent_attachment_invalid", "附件编号无效或重复")
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// 回执校验使用首次受理时保存的引用修订与服务端名称，不重新读取已撤权/修订的源资料。
// 仅返回本人当前工作区的既有资源；改变文字、对象、显式修订、账号或模型仍冲突。
func (s *Server) agentMessageReplay(ctx context.Context, conversationID, requestID uuid.UUID,
	req agentRunRequest, attachments []uuid.UUID) (*agentPreparedRun, error) {
	if requestID == uuid.Nil {
		return nil, nil
	}
	var messageID uuid.UUID
	var refsRaw, skillsRaw []byte
	err := s.db.QueryRow(ctx, `SELECT m.id,m.context_refs,m.skill_requests FROM agent_request q
		JOIN agent_message m ON m.id=q.resource_id AND m.conversation_id=$3
		WHERE q.workspace_id=$1 AND q.user_id=$2 AND q.operation=$4 AND q.request_id=$5 AND q.expires_at>now()`,
		ident(ctx).WorkspaceID, ident(ctx).UserID, conversationID, "conversation.message:"+conversationID.String(), requestID).
		Scan(&messageID, &refsRaw, &skillsRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var refs []agentContextReference
	var skills []agentSkillRequest
	if err := json.Unmarshal(refsRaw, &refs); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(skillsRaw, &skills); err != nil {
		return nil, err
	}
	for i, ref := range req.ContextRefs {
		if ref.Scope == "" {
			req.ContextRefs[i].Scope = "turn"
		}
		for _, saved := range refs {
			if ref.Type == saved.Type && ref.ID == saved.ID {
				req.ContextRefs[i].Name = saved.Name
				if ref.Revision == "" {
					req.ContextRefs[i].Revision = saved.Revision
				}
			}
		}
	}
	for i, skill := range req.SkillRequests {
		for _, saved := range skills {
			if skill.SkillID == saved.SkillID && agentSameUUID(skill.WorkID, saved.WorkID) {
				req.SkillRequests[i].Name = saved.Name
			}
		}
	}
	payload := agentMessageRequestPayload{strings.TrimSpace(req.Text), attachments, req.ContextRefs, req.SkillRequests, strings.TrimSpace(req.AccountID), req.Model}
	hash, err := agentRequestPayloadHash(payload)
	if err != nil {
		return nil, err
	}
	if _, err := lookupAgentRequest(ctx, s.db, ident(ctx).WorkspaceID, ident(ctx).UserID,
		"conversation.message:"+conversationID.String(), requestID, hash); err != nil {
		return nil, err
	}
	if req.ProtocolVersion != 2 {
		return &agentPreparedRun{MessageID: &messageID, Replayed: true}, nil
	}
	runID, after, found, err := s.existingAgentRunRequest(ctx, conversationID, "message", &agentRunProtocolRequest{requestID, payload})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, apiErr(409, "agent_request_conflict", "原请求缺少运行记录，请刷新后检查消息状态")
	}
	return &agentPreparedRun{State: &agentRunState{RunID: runID, StartEventSeq: after + 1}, MessageID: &messageID, Replayed: true}, nil
}

// regenerate 的请求体只有协议与幂等编号，重放不得用后来追加的用户消息重新定义原请求。
func (s *Server) agentRegenerateReplay(ctx context.Context, conversationID, requestID uuid.UUID) (*agentPreparedRun, error) {
	var runID uuid.UUID
	var seq int64
	err := s.db.QueryRow(ctx, `SELECT r.id,coalesce((SELECT min(event_seq) FROM agent_event
		WHERE conversation_id=$1 AND run_id=r.id AND type='run.started'),0)
		FROM agent_run r WHERE conversation_id=$1 AND trigger='regenerate' AND request_id=$2`, conversationID, requestID).Scan(&runID, &seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	messageID, err := agentRunMessageID(ctx, s.db, conversationID, runID)
	if err != nil {
		return nil, err
	}
	return &agentPreparedRun{State: &agentRunState{RunID: runID, StartEventSeq: seq}, MessageID: messageID, Replayed: true}, nil
}

type agentPreparedRun struct {
	State     *agentRunState
	MessageID *uuid.UUID
	Replayed  bool
}

// agentPrepareRun 串行化受理；模型调用在提交后仍由原 agentRun 循环执行。
// 所有入口统一采用用户→会话的锁序，消息、结果报告、请求回执及 queued run 同时提交。
func (s *Server) agentPrepareRun(ctx context.Context, original, selected *agentConversation, trigger string,
	protocol *agentRunProtocolRequest,
	input func(pgx.Tx, *agentConversation) (*uuid.UUID, bool, error)) (*agentPreparedRun, error) {
	model, err := s.agentRunModel(ctx, selected)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var owner uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, ident(ctx).UserID).Scan(&owner); err != nil {
		return nil, err
	}
	c, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, original.ID, ident(ctx).WorkspaceID, owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := agentCheckConversationWritable(c); err != nil {
		return nil, err
	}
	if protocol != nil {
		runID, after, found, err := existingAgentRunRequestWith(ctx, tx, c.ID, trigger, protocol)
		if err != nil {
			return nil, err
		}
		if found {
			messageID, err := agentRunMessageID(ctx, tx, c.ID, runID)
			if err != nil {
				return nil, err
			}
			return &agentPreparedRun{State: &agentRunState{RunID: runID, StartEventSeq: after + 1}, MessageID: messageID, Replayed: true}, nil
		}
	}
	if !agentSameUUID(c.AccountID, original.AccountID) || !agentSameUUID(c.ModelProviderID, original.ModelProviderID) || c.Model != original.Model {
		return nil, apiErr(409, "agent_revision_conflict", "对话账号或模型已变化，请刷新后重试")
	}
	if err := agentCheckRunLimitsWith(ctx, tx, c.ID, owner); err != nil {
		return nil, err
	}
	if !agentSameUUID(c.AccountID, selected.AccountID) {
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1
			AND status IN ('pending','needs_input','executing'))`, c.ID).Scan(&pending); err != nil {
			return nil, err
		}
		if pending {
			return nil, apiErr(409, "agent_action_state_invalid", "请先处理操作卡片，或新建对话后切换账号")
		}
	}
	c.AccountID, c.ModelProviderID, c.Model = selected.AccountID, selected.ModelProviderID, selected.Model
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET
		revision=revision+CASE WHEN account_id IS DISTINCT FROM $2 OR model_provider_id IS DISTINCT FROM $3 OR model IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
		account_id=$2,model_provider_id=$3,model=$4 WHERE id=$1`,
		c.ID, c.AccountID, c.ModelProviderID, c.Model); err != nil {
		return nil, err
	}
	messageID, replay, err := input(tx, c)
	if err != nil {
		return nil, err
	}
	if replay {
		return &agentPreparedRun{MessageID: messageID, Replayed: true}, nil
	}
	requestID, payload := uuid.Nil, any(nil)
	if protocol != nil {
		requestID, payload = protocol.RequestID, protocol.Payload
	}
	st, err := s.agentStartRunTx(ctx, tx, trigger, c, model, requestID, payload, messageID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &agentPreparedRun{State: st, MessageID: messageID}, nil
}

func agentSameUUID(a, b *uuid.UUID) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func agentCheckRunLimitsWith(ctx context.Context, reader agentRequestReader, conversationID, userID uuid.UUID) error {
	var active, executing bool
	var total int
	if err := reader.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')),
		EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing'),
		(SELECT count(*) FROM agent_run WHERE user_id=$2 AND status IN ('queued','running'))`, conversationID, userID).
		Scan(&active, &executing, &total); err != nil {
		return err
	}
	if active || executing {
		return apiErr(409, "agent_run_busy", "这个对话有运行或操作卡片正在执行，请等待结束")
	}
	if total >= agentMaxRunsPerUser {
		return apiErr(429, "agent_limit_reached", "同时运行的任务太多，请等待其中一次结束")
	}
	return nil
}

func agentRunMessageID(ctx context.Context, reader agentRequestReader, conversationID, runID uuid.UUID) (*uuid.UUID, error) {
	var id *uuid.UUID
	err := reader.QueryRow(ctx, `SELECT COALESCE(
		(SELECT NULLIF(payload->>'message_id','')::uuid FROM agent_event WHERE conversation_id=$1 AND run_id=$2 AND type='run.started' LIMIT 1),
		(SELECT id FROM agent_message WHERE conversation_id=$1 AND run_id=$2 AND role='user' ORDER BY seq DESC LIMIT 1))`,
		conversationID, runID).Scan(&id)
	return id, err
}

func writeAgentPreparedReplay(w http.ResponseWriter, conversationID uuid.UUID, prepared *agentPreparedRun) error {
	if prepared.State == nil {
		return ok(w, map[string]any{"status": "replayed", "message_id": prepared.MessageID})
	}
	after := prepared.State.StartEventSeq
	if after > 0 {
		after--
	}
	writeAgentRunAccepted(w, conversationID, prepared.State.RunID, prepared.MessageID, after)
	return nil
}
