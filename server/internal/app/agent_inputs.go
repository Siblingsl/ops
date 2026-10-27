package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type agentInputView struct {
	ID                uuid.UUID               `json:"id"`
	ConversationID    uuid.UUID               `json:"conversation_id"`
	RunID             *uuid.UUID              `json:"run_id"`
	Kind              string                  `json:"kind"`
	Status            string                  `json:"status"`
	ErrorCode         string                  `json:"error_code,omitempty"`
	RequestID         uuid.UUID               `json:"-"`
	PayloadHash       string                  `json:"-"`
	Revision          int64                   `json:"revision"`
	Text              string                  `json:"text"`
	AttachmentIDs     []uuid.UUID             `json:"attachment_ids"`
	Attachments       []agentAttachmentView   `json:"attachments"`
	ContextRefs       []agentContextReference `json:"context_refs"`
	SkillRequests     []agentSkillRequest     `json:"skill_requests"`
	ConsumedMessageID *uuid.UUID              `json:"consumed_message_id"`
	CreatedAt         time.Time               `json:"created_at"`
}

type agentInputRequest struct {
	RequestID     string                  `json:"request_id"`
	Kind          string                  `json:"kind"`
	RunID         string                  `json:"run_id"`
	Text          string                  `json:"text"`
	AttachmentIDs []string                `json:"attachment_ids"`
	ContextRefs   []agentContextReference `json:"context_refs"`
	SkillRequests []agentSkillRequest     `json:"skill_requests"`
}

type agentInputPatch struct {
	ExpectedRevision int64                    `json:"expected_revision"`
	Text             *string                  `json:"text"`
	AttachmentIDs    *[]string                `json:"attachment_ids"`
	ContextRefs      *[]agentContextReference `json:"context_refs"`
	SkillRequests    *[]agentSkillRequest     `json:"skill_requests"`
}

const agentInputCols = `id,conversation_id,run_id,kind,status,error_code,request_id,payload_hash,revision,text,
	attachment_ids,context_refs,skill_requests,consumed_message_id,created_at`

func scanAgentInput(row pgx.Row) (*agentInputView, error) {
	var v agentInputView
	var refs, skills []byte
	if err := row.Scan(&v.ID, &v.ConversationID, &v.RunID, &v.Kind, &v.Status, &v.ErrorCode, &v.RequestID, &v.PayloadHash,
		&v.Revision, &v.Text, &v.AttachmentIDs, &refs, &skills, &v.ConsumedMessageID, &v.CreatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(refs, &v.ContextRefs); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(skills, &v.SkillRequests); err != nil {
		return nil, err
	}
	if v.AttachmentIDs == nil {
		v.AttachmentIDs = []uuid.UUID{}
	}
	if v.ContextRefs == nil {
		v.ContextRefs = []agentContextReference{}
	}
	if v.SkillRequests == nil {
		v.SkillRequests = []agentSkillRequest{}
	}
	return &v, nil
}

func agentLoadInputs(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID) ([]agentInputView, error) {
	rows, err := tx.Query(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE conversation_id=$1
		AND (status IN ('pending','needs_review') OR created_at > now()-interval '24 hours') ORDER BY created_at,id`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	inputs := []agentInputView{}
	for rows.Next() {
		v, err := scanAgentInput(rows)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, *v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for i := range inputs {
		inputs[i].Attachments = []agentAttachmentView{}
		if len(inputs[i].AttachmentIDs) == 0 {
			continue
		}
		attachments, err := tx.Query(ctx, `SELECT a.id,a.kind,a.name,a.mime,a.bytes,a.width,a.height
			FROM agent_attachment a WHERE a.id=ANY($1) AND a.workspace_id=$2 AND a.user_id=$3
			AND EXISTS(SELECT 1 FROM agent_input source WHERE source.id=$4 AND source.conversation_id=$5
				AND source.workspace_id=$2 AND source.user_id=$3 AND a.id=ANY(source.attachment_ids))`,
			inputs[i].AttachmentIDs, ident(ctx).WorkspaceID, ident(ctx).UserID, inputs[i].ID, conversationID)
		if err != nil {
			return nil, err
		}
		for attachments.Next() {
			var item agentAttachmentView
			if err := attachments.Scan(&item.ID, &item.Kind, &item.Name, &item.Mime, &item.Bytes, &item.Width, &item.Height); err != nil {
				attachments.Close()
				return nil, err
			}
			item.URL = "/api/v1/agent/attachments/" + item.ID.String() + "/file?conversation_id=" + conversationID.String()
			inputs[i].Attachments = append(inputs[i].Attachments, item)
		}
		if err := attachments.Err(); err != nil {
			attachments.Close()
			return nil, err
		}
		attachments.Close()
	}
	return inputs, nil
}

func (s *Server) agentValidateInput(ctx context.Context, c *agentConversation, text string, ids []string,
	refs []agentContextReference, skills []agentSkillRequest) (string, []uuid.UUID, []agentContextReference, []agentSkillRequest, error) {
	text = strings.TrimSpace(text)
	if runeLen(text) > agentMessageChars {
		return "", nil, nil, nil, validation("消息最长 8000 字")
	}
	if text != "" && agentContainsSecret(text, s.agentSecretValues(ctx, ident(ctx).WorkspaceID)) {
		return "", nil, nil, nil, validation("消息中疑似包含密钥或密码，请到设置页填写，不要发给智能体")
	}
	attachments, err := parseAgentAttachmentIDs(ids)
	if err != nil {
		return "", nil, nil, nil, err
	}
	if len(refs) > 0 {
		if err := requireAgentFeature("context_refs"); err != nil {
			return "", nil, nil, nil, err
		}
		refs, err = s.agentValidateContextReferences(ctx, refs, c.AccountID, c.ID)
		if err != nil {
			return "", nil, nil, nil, err
		}
	}
	if len(skills) > 0 {
		if err := requireAgentFeature("skill_requests"); err != nil {
			return "", nil, nil, nil, err
		}
		if err := s.agentValidateSkillRequests(ctx, c.AccountID, skills); err != nil {
			return "", nil, nil, nil, err
		}
	}
	if text == "" && len(attachments) == 0 && len(refs) == 0 && len(skills) == 0 {
		return "", nil, nil, nil, validation("请输入内容，或添加要处理的资料")
	}
	return text, attachments, refs, skills, nil
}

// reserveAgentInputAttachmentsTx 保留已上传文件，避免等待期间被孤立附件清理。
func (s *Server) reserveAgentInputAttachmentsTx(ctx context.Context, tx pgx.Tx, c *agentConversation, ids []uuid.UUID) error {
	for _, id := range ids {
		var path string
		var referenced, hasRef bool
		var ownerConversation *uuid.UUID
		err := tx.QueryRow(ctx, `SELECT a.storage_path,a.referenced,a.conversation_id,
			EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=a.id AND r.conversation_id=$4)
			OR EXISTS(SELECT 1 FROM agent_input i WHERE i.conversation_id=$4 AND i.status='pending' AND a.id=ANY(i.attachment_ids))
			FROM agent_attachment a WHERE a.id=$1 AND a.workspace_id=$2 AND a.user_id=$3 FOR UPDATE`,
			id, ident(ctx).WorkspaceID, ident(ctx).UserID, c.ID).Scan(&path, &referenced, &ownerConversation, &hasRef)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(422, "agent_attachment_invalid", "附件已失效，请重新选择")
		}
		if err != nil {
			return err
		}
		if _, err := os.Stat(s.agentAttachmentFile(path)); err != nil {
			return apiErr(422, "agent_attachment_invalid", "附件文件已失效，请重新选择")
		}
		if !hasRef && (referenced || ownerConversation != nil && *ownerConversation != c.ID) {
			return apiErr(422, "agent_attachment_invalid", "附件不属于当前对话")
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_attachment SET referenced=true,conversation_id=coalesce(conversation_id,$2) WHERE id=$1`, id, c.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) postAgentInput(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("run_control"); err != nil {
		return err
	}
	ctx := r.Context()
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	c, err := s.agentConversationFor(ctx, cid)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(c); err != nil {
		return err
	}
	var req agentInputRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil {
		return validation("输入请求必须提供有效的 request_id")
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Kind != "steer" && req.Kind != "queue" {
		return validation("输入类型无效")
	}
	var runID *uuid.UUID
	if strings.TrimSpace(req.RunID) != "" {
		id, err := uuid.Parse(strings.TrimSpace(req.RunID))
		if err != nil || id == uuid.Nil {
			return validation("运行编号无效")
		}
		runID = &id
	}
	if req.Kind == "steer" && runID == nil {
		return validation("补充当前任务必须指定运行")
	}
	hash, err := agentRequestPayloadHash(req)
	if err != nil {
		return err
	}
	// 重放先查原受理，避免资料后来失效时改变已受理请求的结果。
	var originalHash string
	var originalID uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT id,payload_hash FROM agent_input WHERE conversation_id=$1 AND request_id=$2`, c.ID, requestID).Scan(&originalID, &originalHash)
	if err == nil {
		if originalHash != hash {
			return apiErr(409, "agent_request_conflict", "请求编号已用于不同内容")
		}
		v, err := scanAgentInput(s.db.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1`, originalID))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusAccepted, v)
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	text, attachments, refs, skills, err := s.agentValidateInput(ctx, c, req.Text, req.AttachmentIDs, req.ContextRefs, req.SkillRequests)
	if err != nil {
		return err
	}
	refsJSON, _ := json.Marshal(refs)
	skillsJSON, _ := json.Marshal(skills)
	if refs == nil {
		refsJSON = []byte(`[]`)
	}
	if skills == nil {
		skillsJSON = []byte(`[]`)
	}
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, c.ID, ident(ctx).WorkspaceID, ident(ctx).UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if current.Revision != c.Revision || !agentSameUUID(current.AccountID, c.AccountID) ||
		!agentSameUUID(current.ModelProviderID, c.ModelProviderID) || current.Model != c.Model || current.Mode != c.Mode {
		return apiErr(409, "agent_revision_conflict", "对话账号或模式已变化，请刷新后重试")
	}
	c = current
	var existingHash string
	err = tx.QueryRow(ctx, `SELECT id,payload_hash FROM agent_input WHERE conversation_id=$1 AND request_id=$2`, c.ID, requestID).Scan(&originalID, &existingHash)
	if err == nil {
		if existingHash != hash {
			return apiErr(409, "agent_request_conflict", "请求编号已用于不同内容")
		}
		v, err := scanAgentInput(tx.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1`, originalID))
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusAccepted, v)
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	text, attachments, refs, skills, err = s.agentValidateInput(ctx, c, req.Text, req.AttachmentIDs, req.ContextRefs, req.SkillRequests)
	if err != nil {
		return err
	}
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	refsJSON, _ = json.Marshal(refs)
	if refs == nil {
		refsJSON = []byte(`[]`)
	}
	skillsJSON, _ = json.Marshal(skills)
	if skills == nil {
		skillsJSON = []byte(`[]`)
	}
	if runID != nil {
		var belongs bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_run WHERE id=$1 AND conversation_id=$2
			AND workspace_id=$3 AND user_id=$4)`, *runID, c.ID, ident(ctx).WorkspaceID, ident(ctx).UserID).Scan(&belongs); err != nil {
			return err
		}
		if !belongs {
			return apiErr(409, "agent_run_busy", "运行不存在或不属于当前对话")
		}
	}
	var count, chars int
	if err := tx.QueryRow(ctx, `SELECT count(*),coalesce(sum(char_length(text)),0) FROM agent_input
		WHERE conversation_id=$1 AND status IN ('pending','needs_review')`, c.ID).Scan(&count, &chars); err != nil {
		return err
	}
	if count >= 5 || chars+runeLen(text) > 24000 {
		return apiErr(409, "agent_input_limit", "待处理输入最多 5 条、合计最多 24000 字")
	}
	if req.Kind == "steer" {
		var active, executing bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_run WHERE id=$2 AND conversation_id=$1
			AND status IN ('queued','running') AND stage<>'stopping'),
			EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing')`, c.ID, runID).Scan(&active, &executing); err != nil {
			return err
		}
		if !active {
			return apiErr(409, "agent_run_busy", "该运行已结束，请作为下一条发送")
		}
		if executing {
			return apiErr(409, "agent_run_busy", "操作卡片执行期间只能排到下一条")
		}
	}
	if err := s.reserveAgentInputAttachmentsTx(ctx, tx, c, attachments); err != nil {
		return err
	}
	var inputID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO agent_input(conversation_id,workspace_id,user_id,run_id,kind,request_id,payload_hash,text,attachment_ids,context_refs,skill_requests)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, c.ID, ident(ctx).WorkspaceID, ident(ctx).UserID,
		runID, req.Kind, requestID, hash, text, attachments, refsJSON, skillsJSON).Scan(&inputID); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, c.ID, runID, "input.created", map[string]any{"input_id": inputID, "kind": req.Kind, "status": "pending", "revision": 1}, nil); err != nil {
		return err
	}
	v, err := scanAgentInput(tx.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1`, inputID))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if req.Kind == "queue" {
		if err := s.agentStartNextQueuedInput(context.WithoutCancel(ctx), c.ID); err != nil {
			return err
		}
		v, err = scanAgentInput(s.db.QueryRow(context.WithoutCancel(ctx), `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1`, inputID))
		if err != nil {
			return err
		}
	}
	writeJSON(w, http.StatusAccepted, v)
	return nil
}

func (s *Server) agentInputFor(ctx context.Context, id uuid.UUID) (*agentInputView, error) {
	v, err := scanAgentInput(s.db.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, id, ident(ctx).WorkspaceID, ident(ctx).UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return v, err
}

func (s *Server) patchAgentInput(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("run_control"); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	old, err := s.agentInputFor(ctx, id)
	if err != nil {
		return err
	}
	c, err := s.agentConversationFor(ctx, old.ConversationID)
	if err != nil {
		return err
	}
	var req agentInputPatch
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ExpectedRevision < 1 {
		return validation("请提供输入修订号")
	}
	text := old.Text
	if req.Text != nil {
		text = *req.Text
	}
	ids := make([]string, len(old.AttachmentIDs))
	for i, id := range old.AttachmentIDs {
		ids[i] = id.String()
	}
	if req.AttachmentIDs != nil {
		ids = *req.AttachmentIDs
	}
	refs, skills := old.ContextRefs, old.SkillRequests
	if req.ContextRefs != nil {
		refs = *req.ContextRefs
	}
	if req.SkillRequests != nil {
		skills = *req.SkillRequests
	}
	text, attachments, refs, skills, err := s.agentValidateInput(ctx, c, text, ids, refs, skills)
	if err != nil {
		return err
	}
	refsJSON, _ := json.Marshal(refs)
	if refs == nil {
		refsJSON = []byte(`[]`)
	}
	skillsJSON, _ := json.Marshal(skills)
	if skills == nil {
		skillsJSON = []byte(`[]`)
	}
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, c.ID, ident(ctx).WorkspaceID, ident(ctx).UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if current.Revision != c.Revision || !agentSameUUID(current.AccountID, c.AccountID) ||
		!agentSameUUID(current.ModelProviderID, c.ModelProviderID) || current.Model != c.Model || current.Mode != c.Mode {
		return apiErr(409, "agent_revision_conflict", "对话账号或模式已变化，请刷新后重试")
	}
	c = current
	text, attachments, refs, skills, err = s.agentValidateInput(ctx, c, text, ids, refs, skills)
	if err != nil {
		return err
	}
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	refsJSON, _ = json.Marshal(refs)
	if refs == nil {
		refsJSON = []byte(`[]`)
	}
	skillsJSON, _ = json.Marshal(skills)
	if skills == nil {
		skillsJSON = []byte(`[]`)
	}
	var chars int
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(char_length(text)),0) FROM agent_input
		WHERE conversation_id=$1 AND id<>$2 AND status IN ('pending','needs_review')`, c.ID, id).Scan(&chars); err != nil {
		return err
	}
	if chars+runeLen(text) > 24000 {
		return apiErr(409, "agent_input_limit", "待处理输入合计最多 24000 字")
	}
	if err := s.reserveAgentInputAttachmentsTx(ctx, tx, c, attachments); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_input SET text=$3,attachment_ids=$4,context_refs=$5,skill_requests=$6,revision=revision+1
		WHERE id=$1 AND revision=$2 AND status='pending'`, id, req.ExpectedRevision, text, attachments, refsJSON, skillsJSON)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return apiErr(409, "agent_revision_conflict", "输入已被消费、撤回或修改，请刷新")
	}
	if _, err := appendAgentEventTx(ctx, tx, c.ID, old.RunID, "input.updated", map[string]any{"input_id": id, "status": "pending", "revision": req.ExpectedRevision + 1}, nil); err != nil {
		return err
	}
	v, err := scanAgentInput(tx.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1`, id))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, v)
}

func (s *Server) deleteAgentInput(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("run_control"); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	old, err := s.agentInputFor(ctx, id)
	if err != nil {
		return err
	}
	var req struct {
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ExpectedRevision < 1 {
		return validation("请提供输入修订号")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, old.ConversationID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_input SET status='cancelled',revision=revision+1
		WHERE id=$1 AND revision=$2 AND status IN ('pending','needs_review')`, id, req.ExpectedRevision)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return apiErr(409, "agent_revision_conflict", "输入已被消费、撤回或修改，请刷新")
	}
	if _, err := appendAgentEventTx(ctx, tx, old.ConversationID, old.RunID, "input.updated", map[string]any{"input_id": id, "status": "cancelled", "revision": req.ExpectedRevision + 1}, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) resumeAgentInputs(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("run_control"); err != nil {
		return err
	}
	ctx := r.Context()
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	var req struct {
		RequestID string `json:"request_id"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil {
		return validation("恢复队列必须提供有效的 request_id")
	}
	identity := ident(ctx)
	operation := "conversation.input.resume:" + cid.String()
	payload := map[string]any{"conversation_id": cid, "resume": true}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, identity.UserID); err != nil {
		return err
	}
	var locked uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		cid, identity.WorkspaceID, identity.UserID).Scan(&locked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	resource, err := claimAgentRequest(ctx, tx, identity.WorkspaceID, identity.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if resource == nil {
		if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET input_queue_paused=false WHERE id=$1`, cid); err != nil {
			return err
		}
		if _, err := appendAgentEventTx(ctx, tx, cid, nil, "input.updated", map[string]any{
			"input_queue_paused": false,
		}, nil); err != nil {
			return err
		}
		if err := completeAgentRequest(ctx, tx, identity.WorkspaceID, identity.UserID, operation, requestID, cid); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if err := s.agentStartNextQueuedInput(context.WithoutCancel(ctx), cid); err != nil {
		return err
	}
	var paused bool
	if err := s.db.QueryRow(context.WithoutCancel(ctx), `SELECT input_queue_paused FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		cid, identity.WorkspaceID, identity.UserID).Scan(&paused); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true, "input_queue_paused": paused})
}

// agentConsumeSteers 只在模型轮次之间调用；前一轮完整工具结果已保存。
func (s *Server) agentConsumeSteers(ctx context.Context, st *agentRunState) error {
	for {
		input, err := scanAgentInput(s.db.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input
			WHERE conversation_id=$1 AND run_id=$2 AND kind='steer' AND status='pending'
			ORDER BY created_at,id LIMIT 1`, st.ConversationID, st.RunID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		c, err := s.agentConversationFor(ctx, st.ConversationID)
		if err != nil {
			return err
		}
		ids := make([]string, len(input.AttachmentIDs))
		for i, id := range input.AttachmentIDs {
			ids[i] = id.String()
		}
		text, attachments, refs, skills, validationErr := s.agentValidateInput(ctx, c, input.Text, ids, input.ContextRefs, input.SkillRequests)
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
			tx.Rollback(ctx)
			return err
		}
		var active bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_run WHERE id=$1 AND conversation_id=$2
			AND status IN ('queued','running') AND stage<>'stopping')`, st.RunID, st.ConversationID).Scan(&active); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if !active {
			tx.Rollback(ctx)
			return nil
		}
		current, err := scanAgentInput(tx.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input WHERE id=$1 FOR UPDATE`, input.ID))
		if err != nil {
			tx.Rollback(ctx)
			return err
		}
		if current.Status != "pending" || current.Revision != input.Revision {
			tx.Rollback(ctx)
			continue
		}
		if validationErr == nil && time.Since(current.CreatedAt) >= 24*time.Hour {
			validationErr = apiErr(409, "agent_input_expired", "补充已过期，请重新发送")
		}
		if validationErr == nil {
			validationErr = s.reserveAgentInputAttachmentsTx(ctx, tx, c, attachments)
		}
		if validationErr != nil {
			code := "agent_input_unavailable"
			var ae *APIError
			if errors.As(validationErr, &ae) {
				code = ae.Code
			}
			status := "needs_review"
			if code == "agent_input_expired" {
				status = "expired"
			}
			if _, err = tx.Exec(ctx, `UPDATE agent_input SET status=$2,error_code=$3,revision=revision+1 WHERE id=$1`, input.ID, status, code); err == nil {
				_, err = appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "input.updated", map[string]any{
					"input_id": input.ID, "status": status, "revision": input.Revision + 1, "error_code": code,
				}, nil)
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				tx.Rollback(ctx)
			}
			if err != nil {
				return err
			}
			return validationErr
		}
		message, _, err := s.agentInsertUserMessageWithContextTx(ctx, tx, st.ConversationID, text, attachments, refs, skills, uuid.Nil, nil, &st.RunID)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE agent_message SET source_input_id=$2 WHERE id=$1`, message.ID, input.ID)
		}
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE agent_input SET status='consumed',consumed_message_id=$2,revision=revision+1 WHERE id=$1`, input.ID, message.ID)
		}
		if err == nil {
			_, err = appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "input.consumed", map[string]any{
				"input_id": input.ID, "message_id": message.ID, "status": "consumed", "revision": input.Revision + 1,
			}, nil)
		}
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			tx.Rollback(ctx)
		}
		if err != nil {
			return err
		}
	}
}

func agentMarkRunSteersForReviewTx(ctx context.Context, tx pgx.Tx, conversationID, runID uuid.UUID) error {
	rows, err := tx.Query(ctx, `UPDATE agent_input SET status='needs_review',error_code='run_ended',revision=revision+1
		WHERE conversation_id=$1 AND run_id=$2 AND kind='steer' AND status='pending' RETURNING id,revision`, conversationID, runID)
	if err != nil {
		return err
	}
	type updated struct {
		id       uuid.UUID
		revision int64
	}
	items := []updated{}
	for rows.Next() {
		var item updated
		if err := rows.Scan(&item.id, &item.revision); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range items {
		if _, err := appendAgentEventTx(ctx, tx, conversationID, &runID, "input.updated", map[string]any{
			"input_id": item.id, "status": "needs_review", "revision": item.revision, "error_code": "run_ended",
		}, nil); err != nil {
			return err
		}
	}
	return nil
}

func agentInputBlockTx(ctx context.Context, tx pgx.Tx, input *agentInputView, code string) error {
	if input.ErrorCode == code {
		return nil
	}
	tag, err := tx.Exec(ctx, `UPDATE agent_input SET error_code=$2,revision=revision+1 WHERE id=$1 AND status='pending' AND error_code IS DISTINCT FROM $2`, input.ID, code)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	_, err = appendAgentEventTx(ctx, tx, input.ConversationID, input.RunID, "input.updated", map[string]any{
		"input_id": input.ID, "status": input.Status, "revision": input.Revision + 1, "error_code": code,
	}, nil)
	return err
}

// agentStartNextQueuedInput 在与直接发送相同的用户→会话锁序内消费一条FIFO输入。
// 模型仍由原 agentRun 循环执行；任何待审阅业务写入都只会阻塞队列，不会自动批准。
func (s *Server) agentStartNextQueuedInput(ctx context.Context, conversationID uuid.UUID) error {
	if !agentWorkbenchFeatures()["run_control"] {
		return nil
	}
	requester := ident(ctx)
	if requester == nil {
		return errUnauthenticated
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var owner uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, requester.UserID).Scan(&owner); err != nil {
		return err
	}
	conversation, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, conversationID, requester.WorkspaceID, owner))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var paused bool
	if err := tx.QueryRow(ctx, `SELECT input_queue_paused FROM agent_conversation WHERE id=$1`, conversationID).Scan(&paused); err != nil {
		return err
	}
	input, err := scanAgentInput(tx.QueryRow(ctx, `SELECT `+agentInputCols+` FROM agent_input
		WHERE conversation_id=$1 AND kind='queue' AND status IN ('pending','needs_review')
		ORDER BY created_at,id LIMIT 1 FOR UPDATE`, conversationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if input.Status == "needs_review" {
		return tx.Commit(ctx)
	}
	if paused {
		if err := agentInputBlockTx(ctx, tx, input, "queue_paused"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	role := ""
	err = tx.QueryRow(ctx, `SELECT role FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
		requester.WorkspaceID, requester.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := agentInputBlockTx(ctx, tx, input, "workspace_access_revoked"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	id := *requester
	id.UserID, id.WorkspaceID, id.Role = requester.UserID, requester.WorkspaceID, role
	id.AdminOverride, id.SystemAdmin, id.ReauthOK = false, false, false
	runCtx := context.WithValue(context.WithoutCancel(ctx), ctxMember, &id)
	conversation.Mode = agentEffectiveMode(conversation.Mode, role)
	if err := agentCheckConversationWritable(conversation); err != nil {
		if err := agentInputBlockTx(ctx, tx, input, apiErrorCode(err)); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	settings, err := s.agentSettingsOf(runCtx, requester.WorkspaceID)
	if err != nil {
		return err
	}
	if !settings.Enabled || role == "viewer" && !settings.ViewerEnabled {
		if err := agentInputBlockTx(ctx, tx, input, "agent_disabled"); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if age := s.now().Sub(input.CreatedAt); age >= 24*time.Hour {
		tag, err := tx.Exec(ctx, `UPDATE agent_input SET status='expired',error_code='agent_input_expired',revision=revision+1
			WHERE id=$1 AND revision=$2 AND status='pending'`, input.ID, input.Revision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			if _, err := appendAgentEventTx(ctx, tx, conversationID, input.RunID, "input.updated", map[string]any{
				"input_id": input.ID, "status": "expired", "revision": input.Revision + 1, "error_code": "agent_input_expired",
			}, nil); err != nil {
				return err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return s.agentStartNextQueuedInput(runCtx, conversationID)
	}
	var pendingQuestion, pendingAction bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at>now()),
		EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input','executing'))`,
		conversationID).Scan(&pendingQuestion, &pendingAction); err != nil {
		return err
	}
	block := ""
	switch {
	case pendingQuestion:
		block = "agent_question_pending"
	case pendingAction:
		block = "agent_action_pending"
	default:
		if err := agentCheckRunLimitsWith(runCtx, tx, conversationID, requester.UserID); err != nil {
			block = apiErrorCode(err)
		}
	}
	if block != "" {
		if err := agentInputBlockTx(ctx, tx, input, block); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	model, err := s.agentRunModel(runCtx, conversation)
	if err != nil {
		if err := agentInputBlockTx(ctx, tx, input, apiErrorCode(err)); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	ids := make([]string, len(input.AttachmentIDs))
	for i, id := range input.AttachmentIDs {
		ids[i] = id.String()
	}
	text, attachments, refs, skills, validationErr := s.agentValidateInput(runCtx, conversation,
		input.Text, ids, input.ContextRefs, input.SkillRequests)
	if validationErr == nil && len(attachments) > 0 {
		validationErr = s.reserveAgentInputAttachmentsTx(runCtx, tx, conversation, attachments)
	}
	if validationErr != nil {
		code := apiErrorCode(validationErr)
		tag, err := tx.Exec(ctx, `UPDATE agent_input SET status='needs_review',error_code=$3,revision=revision+1
			WHERE id=$1 AND revision=$2 AND status='pending'`, input.ID, input.Revision, code)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			if _, err := appendAgentEventTx(ctx, tx, conversationID, input.RunID, "input.updated", map[string]any{
				"input_id": input.ID, "status": "needs_review", "revision": input.Revision + 1, "error_code": code,
			}, nil); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	if err := s.agentReportCardResultsTx(runCtx, tx, conversationID); err != nil {
		return err
	}
	message, _, err := s.agentInsertUserMessageWithContextTx(runCtx, tx, conversationID, text, attachments, refs, skills, uuid.Nil, nil)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_message SET source_input_id=$2 WHERE id=$1`, message.ID, input.ID); err != nil {
		return err
	}
	payload := map[string]any{"input_id": input.ID, "revision": input.Revision, "payload_hash": input.PayloadHash}
	st, err := s.agentStartRunTx(runCtx, tx, "queue", conversation, model, input.RequestID, payload, &message.ID)
	if err != nil {
		return err
	}
	if input.RunID != nil {
		if _, err := tx.Exec(ctx, `UPDATE agent_run SET parent_run_id=$2 WHERE id=$1`, st.RunID, *input.RunID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_input SET status='consumed',error_code='',consumed_message_id=$2,revision=revision+1
		WHERE id=$1 AND revision=$3 AND status='pending'`, input.ID, message.ID, input.Revision); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, conversationID, &st.RunID, "input.consumed", map[string]any{
		"input_id": input.ID, "message_id": message.ID, "status": "consumed", "revision": input.Revision + 1,
	}, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.startAgentRunBackground(runCtx, st)
}

func apiErrorCode(err error) string {
	var api *APIError
	if errors.As(err, &api) && api.Code != "" {
		return api.Code
	}
	return "agent_input_unavailable"
}
