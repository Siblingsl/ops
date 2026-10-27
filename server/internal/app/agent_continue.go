package app

// 续跑、重新生成、编辑、停止、摘要与标题（16 文档第 6.4、6.7、6.8 节）。
// 本文件负责消息入口与运行流编排；轮次循环在 agent_run.go，卡片提出在 agent_propose.go，
// 上下文组装在 agent_context.go。

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// agentRunRequest 是发送消息与编辑消息的请求体（第 11.2 节）。
type agentRunRequest struct {
	Text                string                  `json:"text"`
	AttachmentIDs       []string                `json:"attachment_ids"`
	ContextRefs         []agentContextReference `json:"context_refs"`
	SkillRequests       []agentSkillRequest     `json:"skill_requests"`
	RequestID           string                  `json:"request_id"`
	ProtocolVersion     int                     `json:"protocol_version"`
	AccountID           string                  `json:"account_id"`
	Model               *agentModelRef          `json:"model"`
	Mode                *string                 `json:"mode"`
	ReasoningEffort     *string                 `json:"reasoning_effort"`
	SupersedeQuestionID string                  `json:"supersede_question_id"`
}

type agentRunProtocolRequest struct {
	RequestID uuid.UUID
	Payload   any
}

func parseAgentRunProtocolRequest(req agentRunRequest, payload any) (*agentRunProtocolRequest, error) {
	if req.ProtocolVersion == 0 || req.ProtocolVersion == 1 {
		return nil, nil
	}
	if req.ProtocolVersion != 2 {
		return nil, apiErr(422, "validation_failed", "智能体协议版本不受支持")
	}
	if err := requireAgentFeature("event_resume"); err != nil {
		return nil, err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil {
		return nil, validation("v2 请求必须提供有效的 request_id")
	}
	return &agentRunProtocolRequest{RequestID: requestID, Payload: payload}, nil
}

// agentDecodeBody 解码 JSON 对象请求体；数组与非对象返回 400（第 11.2 节末段）。
func agentDecodeBody(r *http.Request, v any) error {
	br := bufio.NewReader(r.Body)
	// 第 11.2 节末段、第 11.3 节第 1 项：只允许单个 JSON 对象，数组返回 400 validation_failed。
	if b, err := br.Peek(1); err == nil && b[0] == '[' {
		return apiErr(400, "validation_failed", "请求体必须是单个 JSON 对象，不能是数组")
	}
	dec := json.NewDecoder(br)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return requestFormatError(r.Context(), err)
	}
	return nil
}

// ---------- 发送消息并开始运行（第 11.1 节、第 6.4 节第 5 项） ----------

func (s *Server) postAgentMessages(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	convID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conv, err := s.agentConversationFor(ctx, convID)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conv); err != nil {
		return err
	}
	if err := s.agentExpireQuestions(ctx, conv.ID); err != nil {
		return err
	}
	var req agentRunRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if err := agentValidateModeRequest(ctx, req.Mode); err != nil {
		return err
	}
	if req.ReasoningEffort != nil {
		return apiErr(422, "agent_model_unsupported", "当前模型适配器未声明可选推理强度")
	}
	var requestID uuid.UUID
	if strings.TrimSpace(req.RequestID) != "" {
		requestID, err = uuid.Parse(strings.TrimSpace(req.RequestID))
		if err != nil {
			return validation("请求编号无效")
		}
	}
	text := strings.TrimSpace(req.Text)
	if runeLen(text) > agentMessageChars {
		return validation("消息最长 8000 字")
	}
	// 第 9.5 节、E-28：疑似包含密钥或密码的消息拒绝发送，内容不保存。
	if text != "" && agentContainsSecret(text, s.agentSecretValues(ctx, ident(ctx).WorkspaceID)) {
		return apiErr(422, "validation_failed", "消息中疑似包含密钥或密码，请到设置页填写，不要发给智能体")
	}
	attIDs, err := parseAgentAttachmentIDs(req.AttachmentIDs)
	if err != nil {
		return err
	}
	if _, err := parseAgentRunProtocolRequest(req, nil); err != nil {
		return err
	}
	if replay, err := s.agentMessageReplay(ctx, conv.ID, requestID, req, attIDs); err != nil {
		return err
	} else if replay != nil {
		return writeAgentPreparedReplay(w, conv.ID, replay)
	}
	contextAccountID := conv.AccountID
	if raw := strings.TrimSpace(req.AccountID); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return errNotFound
		}
		if err := s.checkAgentAccount(ctx, id); err != nil {
			return err
		}
		contextAccountID = &id
	}
	contextRefs := req.ContextRefs
	if len(contextRefs) > 0 {
		if err := requireAgentFeature("context_refs"); err != nil {
			return err
		}
		contextRefs, err = s.agentValidateContextReferences(ctx, contextRefs, contextAccountID)
		if err != nil {
			return err
		}
	}
	if len(req.SkillRequests) > 0 {
		if err := requireAgentFeature("skill_requests"); err != nil {
			return err
		}
		if err := s.agentValidateSkillRequests(ctx, contextAccountID, req.SkillRequests); err != nil {
			return err
		}
	}
	if text == "" && len(attIDs) == 0 && len(contextRefs) == 0 && len(req.SkillRequests) == 0 {
		return validation("请输入内容，或添加要处理的资料")
	}
	requestPayload := agentMessageRequestPayload{text, attIDs, contextRefs, req.SkillRequests, strings.TrimSpace(req.AccountID), req.Model, req.Mode, strings.TrimSpace(req.SupersedeQuestionID)}
	protocol, err := parseAgentRunProtocolRequest(req, requestPayload)
	if err != nil {
		return err
	}
	if protocol != nil {
		runID, after, found, err := s.existingAgentRunRequest(ctx, conv.ID, "message", protocol)
		if err != nil {
			return err
		}
		if found {
			messageID, err := s.agentMessageIDForRequest(ctx, conv.ID, protocol.RequestID)
			if err != nil {
				return err
			}
			writeAgentRunAccepted(w, conv.ID, runID, messageID, after)
			return nil
		}
	}
	selected := *conv
	if err := s.agentSelectConversationOverride(ctx, &selected, req); err != nil {
		return err
	}
	prepared, err := s.agentPrepareRun(ctx, conv, &selected, "message", protocol, func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
		if err := s.agentReportCardResultsTx(ctx, tx, c.ID); err != nil {
			return nil, false, err
		}
		var pendingQuestion uuid.UUID
		var pendingQuestionRevision int64
		var pendingQuestionExpiresAt time.Time
		questionErr := tx.QueryRow(ctx, `SELECT id,revision,expires_at FROM agent_question
			WHERE conversation_id=$1 AND status='pending' FOR UPDATE`, c.ID).
			Scan(&pendingQuestion, &pendingQuestionRevision, &pendingQuestionExpiresAt)
		if questionErr != nil && !errors.Is(questionErr, pgx.ErrNoRows) {
			return nil, false, questionErr
		}
		replacementID := uuid.Nil
		if strings.TrimSpace(req.SupersedeQuestionID) != "" {
			replacementID, err = uuid.Parse(strings.TrimSpace(req.SupersedeQuestionID))
			if err != nil || replacementID == uuid.Nil {
				return nil, false, validation("替代的问题编号无效")
			}
		}
		if questionErr == nil && !time.Now().Before(pendingQuestionExpiresAt) {
			if _, err := tx.Exec(ctx, `UPDATE agent_question SET status='expired',revision=revision+1,resolved_at=now() WHERE id=$1`, pendingQuestion); err != nil {
				return nil, false, err
			}
			if _, err := appendAgentEventTx(ctx, tx, c.ID, nil, "question.resolved", map[string]any{
				"question_id": pendingQuestion, "revision": pendingQuestionRevision + 1, "status": "expired",
			}, nil); err != nil {
				return nil, false, err
			}
			questionErr = pgx.ErrNoRows
		}
		if questionErr == nil {
			if replacementID == uuid.Nil {
				return nil, false, apiErr(409, "agent_question_pending", "请先回答待办问题；或明确使用此消息替代问题")
			}
			if replacementID != pendingQuestion {
				return nil, false, apiErr(409, "agent_revision_conflict", "待办问题已变化，请刷新后重试")
			}
			if _, err := tx.Exec(ctx, `UPDATE agent_question SET status='superseded',revision=revision+1,resolved_at=now() WHERE id=$1`, pendingQuestion); err != nil {
				return nil, false, err
			}
			if _, err := appendAgentEventTx(ctx, tx, c.ID, nil, "question.resolved", map[string]any{
				"question_id": pendingQuestion, "revision": pendingQuestionRevision + 1, "status": "superseded",
			}, nil); err != nil {
				return nil, false, err
			}
		} else if replacementID != uuid.Nil {
			return nil, false, apiErr(409, "agent_revision_conflict", "待办问题已变化或已过期，请刷新后重试")
		}
		message, replay, err := s.agentInsertUserMessageWithContextTx(ctx, tx, c.ID, text, attIDs, contextRefs,
			req.SkillRequests, requestID, requestPayload)
		if err != nil {
			return nil, false, err
		}
		if !replay {
			title := truncate(strings.Join(strings.Fields(text), " "), agentTitleChars)
			if title == "" {
				title = "新对话"
			}
			if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=0,
				title=CASE WHEN title_source='auto' THEN $2 ELSE title END,updated_at=now() WHERE id=$1`, c.ID, title); err != nil {
				return nil, false, err
			}
		}
		return &message.ID, replay, nil
	})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, conv.ID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}

// agentSelectConversationOverride 校验请求中的账号与模型覆盖，实际保存由受理事务负责（第 11.2 节）。
func (s *Server) agentSelectConversationOverride(ctx context.Context, conv *agentConversation,
	req agentRunRequest) error {
	accountID := conv.AccountID
	if aid := strings.TrimSpace(req.AccountID); aid != "" {
		parsed, err := uuid.Parse(aid)
		if err != nil {
			return errNotFound
		}
		if err := s.checkAgentAccount(ctx, parsed); err != nil {
			return err
		}
		accountID = &parsed
	}
	providerID, model := (*uuid.UUID)(nil), conv.Model
	if req.Model != nil {
		ref, err := s.resolveAgentModel(ctx, *req.Model)
		if err != nil {
			return err
		}
		providerID, model = &ref.ProviderID, ref.Model
	} else if conv.ModelProviderID != nil {
		providerID = conv.ModelProviderID
	}
	conv.AccountID, conv.ModelProviderID, conv.Model = accountID, providerID, model
	if req.Mode != nil {
		conv.Mode = *req.Mode
	}
	return nil
}

// agentInsertRow 写入一条消息；runID 可为空（用户消息、action_result）。
func (s *Server) agentInsertRow(ctx context.Context, convID uuid.UUID, runID *uuid.UUID, role, content string,
	toolCalls any, toolCallID, toolName string, attachments []uuid.UUID) (*agentMessageView, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	view, err := s.agentInsertRowTx(ctx, tx, convID, runID, role, content, toolCalls, toolCallID, toolName, attachments)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return view, nil
}

func (s *Server) agentInsertRowTx(ctx context.Context, tx pgx.Tx, convID uuid.UUID, runID *uuid.UUID,
	role, content string, toolCalls any, toolCallID, toolName string, attachments []uuid.UUID) (*agentMessageView, error) {
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	var seq int
	if err := tx.QueryRow(ctx, `UPDATE agent_conversation
		SET next_seq = next_seq + 1, last_message_at = now(), updated_at = now()
		WHERE id=$1 RETURNING next_seq`, convID).Scan(&seq); err != nil {
		return nil, err
	}
	view := agentMessageView{Seq: seq, Role: role, Content: content, RunID: runID}
	if err := tx.QueryRow(ctx, `INSERT INTO agent_message
		(conversation_id, seq, run_id, role, content, tool_calls, tool_call_id, tool_name, attachment_ids)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
		convID, seq, runID, role, content, toolCalls, toolCallID, toolName, attachments).
		Scan(&view.ID, &view.CreatedAt); err != nil {
		return nil, err
	}
	if role == "action_result" || role == "assistant" || role == "system_note" || role == "user" {
		if _, err := appendAgentEventTx(ctx, tx, convID, runID, "message.saved", map[string]any{
			"message_id": view.ID, "seq": view.Seq, "role": role, "content": content, "message_key": "",
		}, nil); err != nil {
			return nil, err
		}
	}
	view.Attachments = []agentAttachmentView{}
	return &view, nil
}

// agentInsertUserMessageWithContext 保存消息、引用和附件状态，并将会话级引用固定到对话中。
func (s *Server) agentInsertUserMessageWithContextTx(ctx context.Context, tx pgx.Tx, convID uuid.UUID, content string,
	attachments []uuid.UUID, refs []agentContextReference, skills []agentSkillRequest,
	requestID uuid.UUID, requestPayload any) (*agentMessageView, bool, error) {
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	if refs == nil {
		refs = []agentContextReference{}
	}
	if skills == nil {
		skills = []agentSkillRequest{}
	}
	refsJSON, err := json.Marshal(refs)
	if err != nil {
		return nil, false, err
	}
	skillsJSON, err := json.Marshal(skills)
	if err != nil {
		return nil, false, err
	}
	if requestID != uuid.Nil {
		resourceID, err := claimAgentRequest(ctx, tx, ident(ctx).WorkspaceID, ident(ctx).UserID,
			"conversation.message:"+convID.String(), requestID, requestPayload)
		if err != nil {
			return nil, false, err
		}
		if resourceID != nil {
			return &agentMessageView{ID: *resourceID}, true, nil
		}
	}
	var fixedRaw []byte
	if err := tx.QueryRow(ctx, `SELECT fixed_context_refs FROM agent_conversation WHERE id=$1 FOR UPDATE`, convID).Scan(&fixedRaw); err != nil {
		return nil, false, err
	}
	fixed := []agentContextReference{}
	if err := json.Unmarshal(fixedRaw, &fixed); err != nil {
		return nil, false, err
	}
	fixedByKey := map[string]int{}
	for i, ref := range fixed {
		fixedByKey[ref.Type+":"+ref.ID.String()] = i
	}
	for _, ref := range refs {
		if ref.Scope != "conversation" {
			continue
		}
		key := ref.Type + ":" + ref.ID.String()
		if i, exists := fixedByKey[key]; exists {
			fixed[i] = ref
		} else {
			fixedByKey[key] = len(fixed)
			fixed = append(fixed, ref)
		}
	}
	if len(fixed) > 12 {
		return nil, false, validation("对话固定引用最多 12 项")
	}
	fixedJSON, err := json.Marshal(fixed)
	if err != nil {
		return nil, false, err
	}
	var seq int
	if err := tx.QueryRow(ctx, `UPDATE agent_conversation
		SET next_seq=next_seq+1,last_message_at=now(),updated_at=now(),fixed_context_refs=$2
		WHERE id=$1 RETURNING next_seq`, convID, fixedJSON).Scan(&seq); err != nil {
		return nil, false, err
	}
	if len(attachments) > 0 {
		tag, err := tx.Exec(ctx, `UPDATE agent_attachment SET referenced=true,conversation_id=COALESCE(conversation_id,$2)
			WHERE id=ANY($1) AND user_id=$3 AND workspace_id=$4 AND referenced=false AND (conversation_id IS NULL OR conversation_id=$2)`,
			attachments, convID, ident(ctx).UserID, ident(ctx).WorkspaceID)
		if err != nil {
			return nil, false, err
		}
		if int(tag.RowsAffected()) != len(attachments) {
			return nil, false, apiErr(422, "agent_attachment_invalid", "附件已失效或已被发送，请重新选择")
		}
	}
	view := agentMessageView{Seq: seq, Role: "user", Content: content, Attachments: []agentAttachmentView{},
		ContextRefs: refs, SkillRequests: skills}
	if err := tx.QueryRow(ctx, `INSERT INTO agent_message
		(conversation_id,seq,role,content,attachment_ids,context_refs,skill_requests)
		VALUES ($1,$2,'user',$3,$4,$5,$6) RETURNING id,created_at`,
		convID, seq, content, attachments, refsJSON, skillsJSON).Scan(&view.ID, &view.CreatedAt); err != nil {
		return nil, false, err
	}
	if err := s.agentProjectUploadedImagesTx(ctx, tx, convID, view.ID, attachments); err != nil {
		return nil, false, err
	}
	if _, err := appendAgentEventTx(ctx, tx, convID, nil, "message.saved", map[string]any{
		"message_id": view.ID, "seq": view.Seq, "role": view.Role, "content": view.Content,
	}, nil); err != nil {
		return nil, false, err
	}
	if requestID != uuid.Nil {
		if err := completeAgentRequest(ctx, tx, ident(ctx).WorkspaceID, ident(ctx).UserID,
			"conversation.message:"+convID.String(), requestID, view.ID); err != nil {
			return nil, false, err
		}
	}
	return &view, false, nil
}

// ---------- 未报告卡片结果（第 6.4 节第 4 项、第 6.3 节第 4 条） ----------

// agentReportCardResults 把“已结束但未报告”的卡片结果合并为一条 action_result 消息，
// 写入后一次性设置 reported_at。
func (s *Server) agentReportCardResultsTx(ctx context.Context, tx pgx.Tx, convID uuid.UUID) error {
	rows, err := tx.Query(ctx, `UPDATE agent_action
		SET reported_at = now()
		WHERE id IN (SELECT id FROM agent_action
			WHERE conversation_id=$1 AND reported_at IS NULL
			AND status IN ('succeeded','failed','rejected','superseded','expired','cancelled'))
		RETURNING id, tool_name, status, target_type, target_id, result, error`, convID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		ID     uuid.UUID `json:"id"`
		Tool   string    `json:"tool_name"`
		Status string    `json:"status"`
		Target struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"target"`
		Result any `json:"result,omitempty"`
		Error  any `json:"error,omitempty"`
	}
	items := []item{}
	for rows.Next() {
		var (
			it                   item
			targetType, targetID string
			resRaw, errRaw       []byte
		)
		if err := rows.Scan(&it.ID, &it.Tool, &it.Status, &targetType, &targetID, &resRaw, &errRaw); err != nil {
			return err
		}
		it.Target.Type, it.Target.ID = targetType, targetID
		if json.Valid(resRaw) {
			_ = json.Unmarshal(resRaw, &it.Result)
		}
		if json.Valid(errRaw) {
			_ = json.Unmarshal(errRaw, &it.Error)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	body, err := json.Marshal(items)
	if err != nil {
		return err
	}
	content := agentActionResultHead + "\n" + agentDataBlock("操作结果", string(body))
	_, err = s.agentInsertRowTx(ctx, tx, convID, nil, "action_result", content, nil, "", "", nil)
	return err
}

// ---------- 运行流编排（第 11.4 节运行流） ----------

// agentRunModel 取对话已选模型；未选时取默认模型（第 7.4 节第 2、3 项）。
func (s *Server) agentRunModel(ctx context.Context, conv *agentConversation) (agentModelRef, error) {
	if conv.ModelProviderID != nil && strings.TrimSpace(conv.Model) != "" {
		return s.resolveAgentModel(ctx, agentModelRef{ProviderID: *conv.ModelProviderID, Model: conv.Model})
	}
	_, def, _, err := s.agentModels(ctx)
	if err != nil {
		return agentModelRef{}, err
	}
	if def == nil {
		return agentModelRef{}, apiErr(422, "agent_model_unsupported", "还没有可用的模型，请先到模型配置中为智能体对话选择模型")
	}
	return s.resolveAgentModel(ctx, *def)
}

// agentStreamPreparedRun 执行已受理的运行；旧 SSE 与 v2 共用同一个循环。
func (s *Server) agentStreamPreparedRun(w http.ResponseWriter, r *http.Request, conv *agentConversation,
	protocol *agentRunProtocolRequest, prepared *agentPreparedRun) error {
	ctx := r.Context()
	st, messageID := prepared.State, prepared.MessageID
	runBase := context.WithoutCancel(ctx)
	rt, err := s.agentResolveModel(runBase, st)
	if err == nil {
		err = s.agentRecordRuntimeConfig(runBase, st, rt)
	}
	if err != nil {
		s.finishAgentRun(runBase, st, "failed", "", nil)
		return err
	}
	var sse *sseWriter
	if protocol == nil {
		sse = newSSE(w)
	}
	// 第 6.8 节第 1 项：运行与客户端连接解耦，浏览器断开后服务端继续运行到结束；
	// 取消只来自用户点击停止（agentCancelRun）。
	runCtx, cancel := context.WithCancel(runBase)
	s.registerAgentRun(st.RunID, cancel)
	var pendingDelta strings.Builder
	lastDeltaFlush := time.Now()
	flushDelta := func() {
		if pendingDelta.Len() == 0 {
			return
		}
		text := pendingDelta.String()
		pendingDelta.Reset()
		if err := s.persistAgentDelta(context.WithoutCancel(runCtx), st, text); err != nil {
			slog.WarnContext(runCtx, "智能体增量事件写入失败", "run_id", st.RunID.String(), "err", err)
		}
		if sse != nil {
			select {
			case <-ctx.Done():
			case <-runCtx.Done():
			default:
				sse.send("delta", map[string]string{"text": text})
			}
		}
		lastDeltaFlush = time.Now()
	}
	send := func(event string, data any) {
		if event == "delta_flush" {
			flushDelta()
			return
		}
		if event == "delta" {
			var delta struct {
				Text string `json:"text"`
			}
			if raw, err := json.Marshal(data); err == nil {
				_ = json.Unmarshal(raw, &delta)
			}
			pendingDelta.WriteString(delta.Text)
			if pendingDelta.Len() >= 2048 || time.Since(lastDeltaFlush) >= 100*time.Millisecond {
				flushDelta()
			}
			return
		}
		flushDelta()
		if event != "run" && event != "done" {
			s.persistAgentStreamEvent(context.WithoutCancel(runCtx), st, event, data)
		}
		if sse != nil {
			select {
			case <-ctx.Done():
				// 客户端已断开：不再向连接写入。
			case <-runCtx.Done():
				// 已取消。
			default:
				sse.send(event, data)
			}
		}
	}
	start := func() {
		defer cancel()
		s.agentRun(runCtx, st, rt, send)
	}
	if protocol != nil {
		after := st.StartEventSeq
		if after > 0 {
			after--
		}
		writeAgentRunAccepted(w, conv.ID, st.RunID, messageID, after)
		go start()
		return nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		start()
	}()
	select {
	case <-done:
	case <-ctx.Done():
		<-done
	}
	return nil
}

// ---------- 续跑（第 6.4 节） ----------

func (s *Server) postAgentContinue(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	convID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conv, err := s.agentConversationFor(ctx, convID)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conv); err != nil {
		return err
	}
	var req agentRunRequest
	if err := decodeOptional(r, &req); err != nil {
		return err
	}
	protocol, err := parseAgentRunProtocolRequest(req, map[string]any{"conversation_id": conv.ID, "trigger": "continue"})
	if err != nil {
		return err
	}
	if protocol != nil {
		runID, after, found, err := s.existingAgentRunRequest(ctx, conv.ID, "continue", protocol)
		if err != nil {
			return err
		}
		if found {
			writeAgentRunAccepted(w, conv.ID, runID, nil, after)
			return nil
		}
	}
	prepared, err := s.agentPrepareRun(ctx, conv, conv, "continue", protocol, func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
		var count int
		if err := tx.QueryRow(ctx, `SELECT auto_continue_count FROM agent_conversation WHERE id=$1`, c.ID).Scan(&count); err != nil {
			return nil, false, err
		}
		if count >= agentMaxContinuations {
			return nil, false, apiErr(429, "agent_limit_reached", "连续自动续跑次数已达上限，请发送消息继续")
		}
		if err := s.agentReportCardResultsTx(ctx, tx, c.ID); err != nil {
			return nil, false, err
		}
		_, err := tx.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=auto_continue_count+1,updated_at=now() WHERE id=$1`, c.ID)
		return nil, false, err
	})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, conv.ID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}

// agentConversationCanContinue 暴露刷新后仍可恢复的续跑状态（第 6.4 节第 3 项）。
func (s *Server) agentConversationCanContinue(ctx context.Context, conv *agentConversation) bool {
	var batchID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT batch_id FROM agent_action
		WHERE conversation_id=$1 AND reported_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`, conv.ID).Scan(&batchID)
	if errors.Is(err, pgx.ErrNoRows) || err != nil {
		return false
	}
	act := &agentActionRow{ConversationID: conv.ID, BatchID: batchID}
	if !s.agentCanContinue(ctx, act) {
		return false
	}
	_, err = s.agentRunModel(ctx, conv)
	return err == nil
}

// ---------- 重新生成与编辑（第 6.7 节第 1、2、3 项） ----------

type agentLastUserMessage struct {
	ID            uuid.UUID
	Seq           int
	Content       string
	AttachmentIDs []uuid.UUID
	CreatedAt     time.Time
}

// agentLastUserMessage 取最后一条用户消息。
func agentLastUserMessageWith(ctx context.Context, reader agentRequestReader, convID uuid.UUID) (*agentLastUserMessage, error) {
	var m agentLastUserMessage
	err := reader.QueryRow(ctx, `SELECT id,seq,content,attachment_ids,created_at FROM agent_message
		WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, convID).
		Scan(&m.ID, &m.Seq, &m.Content, &m.AttachmentIDs, &m.CreatedAt)
	return &m, err
}

// agentRewriteTailTx 在同一受理事务内检查最后一条消息及已执行卡片，随后替代未执行卡片。
func agentRewriteTailTx(ctx context.Context, tx pgx.Tx, convID, messageID uuid.UUID) (*agentLastUserMessage, error) {
	last, err := agentLastUserMessageWith(ctx, tx, convID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if last.ID != messageID {
		return nil, apiErr(409, "agent_action_state_invalid", "对话已有新消息，请刷新后重新操作")
	}
	var blocked bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1
		AND created_at >= $2 AND status IN ('succeeded','executing','needs_input'))`, convID, last.CreatedAt).Scan(&blocked); err != nil {
		return nil, err
	}
	if blocked {
		return nil, apiErr(409, "agent_action_state_invalid", "已有操作执行过，不能重写这段对话，请发送新消息")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agent_message WHERE conversation_id=$1 AND seq>$2`, convID, last.Seq); err != nil {
		return nil, err
	}
	if _, err := mutateAgentActionsTx(ctx, tx, `UPDATE agent_action SET status='superseded'
		WHERE conversation_id=$1 AND created_at >= $2 AND status='pending'`, convID, last.CreatedAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=0,updated_at=now() WHERE id=$1`, convID); err != nil {
		return nil, err
	}
	return last, nil
}

func (s *Server) postAgentRegenerate(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	convID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conv, err := s.agentConversationFor(ctx, convID)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conv); err != nil {
		return err
	}
	var req agentRunRequest
	if err := decodeOptional(r, &req); err != nil {
		return err
	}
	protocol, err := parseAgentRunProtocolRequest(req, nil)
	if err != nil {
		return err
	}
	if protocol != nil {
		prepared, err := s.agentRegenerateReplay(ctx, conv.ID, protocol.RequestID)
		if err != nil {
			return err
		}
		if prepared != nil {
			return writeAgentPreparedReplay(w, conv.ID, prepared)
		}
	}
	last, err := agentLastUserMessageWith(ctx, s.db, conv.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "agent_action_state_invalid", "这个对话还没有可重新生成的运行")
	}
	if err != nil {
		return err
	}
	protocol, err = parseAgentRunProtocolRequest(req, struct {
		ConversationID uuid.UUID
		MessageID      uuid.UUID
		Seq            int
	}{conv.ID, last.ID, last.Seq})
	if err != nil {
		return err
	}
	if protocol != nil {
		runID, after, found, err := s.existingAgentRunRequest(ctx, conv.ID, "regenerate", protocol)
		if err != nil {
			return err
		}
		if found {
			writeAgentRunAccepted(w, conv.ID, runID, &last.ID, after)
			return nil
		}
	}
	prepared, err := s.agentPrepareRun(ctx, conv, conv, "regenerate", protocol, func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
		_, err := agentRewriteTailTx(ctx, tx, c.ID, last.ID)
		return &last.ID, false, err
	})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, conv.ID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}

func (s *Server) postAgentMessageEdit(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	convID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conv, err := s.agentConversationFor(ctx, convID)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conv); err != nil {
		return err
	}
	messageID, err := uuid.Parse(chi.URLParam(r, "messageId"))
	if err != nil {
		return errNotFound
	}
	var req agentRunRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		return validation("请输入内容")
	}
	if runeLen(text) > agentMessageChars {
		return validation("消息最长 8000 字")
	}
	// 第 9.5 节、E-28：疑似包含密钥或密码的消息拒绝发送，内容不保存。
	if agentContainsSecret(text, s.agentSecretValues(ctx, ident(ctx).WorkspaceID)) {
		return apiErr(422, "validation_failed", "消息中疑似包含密钥或密码，请到设置页填写，不要发给智能体")
	}
	attIDs, err := parseAgentAttachmentIDs(req.AttachmentIDs)
	if err != nil {
		return err
	}
	protocol, err := parseAgentRunProtocolRequest(req, struct {
		ConversationID uuid.UUID
		MessageID      uuid.UUID
		Text           string
		AttachmentIDs  []uuid.UUID
	}{conv.ID, messageID, text, attIDs})
	if err != nil {
		return err
	}
	if protocol != nil {
		runID, after, found, err := s.existingAgentRunRequest(ctx, conv.ID, "edit", protocol)
		if err != nil {
			return err
		}
		if found {
			writeAgentRunAccepted(w, conv.ID, runID, &messageID, after)
			return nil
		}
	}
	prepared, err := s.agentPrepareRun(ctx, conv, conv, "edit", protocol, func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
		last, err := agentRewriteTailTx(ctx, tx, c.ID, messageID)
		if err != nil {
			return nil, false, err
		}
		// 允许保留本消息原有附件；新附件必须仍未引用且属于本人、本会话。
		if len(attIDs) > 0 {
			tag, err := tx.Exec(ctx, `UPDATE agent_attachment SET referenced=true,conversation_id=$2 WHERE id=ANY($1)
				AND user_id=$3 AND workspace_id=$5 AND (conversation_id IS NULL OR conversation_id=$2)
				AND (referenced=false OR id=ANY($4))`, attIDs, c.ID, ident(ctx).UserID, last.AttachmentIDs, ident(ctx).WorkspaceID)
			if err != nil {
				return nil, false, err
			}
			if int(tag.RowsAffected()) != len(attIDs) {
				return nil, false, apiErr(422, "agent_attachment_invalid", "附件已失效或已被发送，请重新选择")
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_message SET content=$2,attachment_ids=$3 WHERE id=$1`, messageID, text, append([]uuid.UUID{}, attIDs...)); err != nil {
			return nil, false, err
		}
		newAttachments := []uuid.UUID{}
		for _, id := range attIDs {
			found := false
			for _, old := range last.AttachmentIDs {
				if old == id {
					found = true
					break
				}
			}
			if !found {
				newAttachments = append(newAttachments, id)
			}
		}
		if err := s.agentProjectUploadedImagesTx(ctx, tx, c.ID, messageID, newAttachments); err != nil {
			return nil, false, err
		}
		if _, err := appendAgentEventTx(ctx, tx, c.ID, nil, "message.saved", map[string]any{
			"message_id": messageID, "seq": last.Seq, "role": "user", "content": text, "replaced": true,
		}, nil); err != nil {
			return nil, false, err
		}
		return &messageID, false, nil
	})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, conv.ID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}

// ---------- 停止运行（第 6.7 节第 4 项） ----------

func (s *Server) postAgentRunCancel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	runID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	var conversationID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT conversation_id FROM agent_run WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, runID,
		ident(ctx).WorkspaceID, ident(ctx).UserID).Scan(&conversationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, conversationID); err != nil {
		return err
	}
	var status, stage string
	if err := tx.QueryRow(ctx, `SELECT status,stage FROM agent_run WHERE id=$1`, runID).Scan(&status, &stage); err != nil {
		return err
	}
	if status != "queued" && status != "running" {
		return apiErr(409, "agent_run_busy", "这次运行已经结束，无需停止")
	}
	if stage != "stopping" {
		if _, err := tx.Exec(ctx, `UPDATE agent_run SET stage='stopping' WHERE id=$1`, runID); err != nil {
			return err
		}
		if _, err := appendAgentEventTx(ctx, tx, conversationID, &runID, "run.stage", map[string]any{"stage": "stopping"}, nil); err != nil {
			return err
		}
	}
	// 在释放会话锁前设置内存取消标记；工具/终态发布必须先等待本事务。
	if !s.agentCancelRun(runID) {
		return apiErr(409, "agent_run_busy", "这次运行已结束或正在恢复，请刷新后核对")
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// ---------- 摘要压缩（第 6.8 节第 3 项） ----------

// agentSummaryRules 是 agent_summary 任务的系统规则（第 7.3 节）。
const agentSummaryRules = `你是对话历史压缩器。把给定的历史对话压缩为不超过 2000 字的摘要，保留：
用户的目标与约束、已确认的事实、已执行或已拒绝的操作及其结果、未完成的事项。
不要添加原文没有的信息，不要复述完整长文，不要输出解释。`

// maybeSummarize 运行结束时，窗口外历史消息总长度超过 40000 字时压缩为摘要。
// 压缩失败时保留旧摘要，窗口外消息仍按原有口径发送（第 6.8 节第 3 项）。
func (s *Server) maybeSummarize(ctx context.Context, st *agentRunState) {
	var (
		summary string
		uptoSeq int
	)
	if err := s.db.QueryRow(ctx, `SELECT summary, summary_upto_seq FROM agent_conversation WHERE id=$1`,
		st.ConversationID).Scan(&summary, &uptoSeq); err != nil {
		return
	}
	boundary, err := s.agentWindowBoundary(ctx, st.ConversationID, uptoSeq)
	if err != nil || boundary <= uptoSeq {
		return
	}
	var outside int
	if err := s.db.QueryRow(ctx, `SELECT coalesce(sum(length(content)),0) FROM agent_message
		WHERE conversation_id=$1 AND seq > $2 AND seq <= $3`, st.ConversationID, uptoSeq, boundary).Scan(&outside); err != nil {
		return
	}
	if outside <= agentWindowChars {
		return
	}
	body, err := s.agentOutsideText(ctx, st.ConversationID, uptoSeq, boundary)
	if err != nil {
		return
	}
	text, err := s.agentSummarize(ctx, st, summary, body)
	if err != nil {
		slog.Warn("对话摘要压缩失败，保留旧摘要", "conversation_id", st.ConversationID.String(), "err", err)
		return
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation SET summary=$2, summary_upto_seq=$3, updated_at=now()
		WHERE id=$1`, st.ConversationID, text, boundary); err != nil {
		slog.Warn("写入对话摘要失败", "conversation_id", st.ConversationID.String(), "err", err)
	}
}

// agentWindowBoundary 返回窗口的最后一条消息序号与窗口外总长度。窗口口径与
// agentMessageWindow 一致（按消息长度近似，不拆散助手消息与工具结果的分组代价另算）。
func (s *Server) agentWindowBoundary(ctx context.Context, convID uuid.UUID, uptoSeq int) (int, error) {
	rows, err := s.db.Query(ctx, `SELECT seq, length(content) FROM agent_message
		WHERE conversation_id=$1 AND seq > $2 ORDER BY seq DESC`, convID, uptoSeq)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	budget := agentWindowChars
	for rows.Next() {
		var seq, chars int
		if err := rows.Scan(&seq, &chars); err != nil {
			return 0, err
		}
		if chars > budget {
			return seq, nil
		}
		budget -= chars
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	return uptoSeq, nil
}

// agentOutsideText 拼装窗口外（不含已摘要部分）的历史文本，用于压缩。
func (s *Server) agentOutsideText(ctx context.Context, convID uuid.UUID, uptoSeq, boundary int) (string, error) {
	rows, err := s.db.Query(ctx, `SELECT role, content FROM agent_message
		WHERE conversation_id=$1 AND seq > $2 AND seq <= $3 ORDER BY seq ASC`, convID, uptoSeq, boundary)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	parts := []string{}
	for rows.Next() {
		var role, content string
		if err := rows.Scan(&role, &content); err != nil {
			return "", err
		}
		if strings.TrimSpace(content) == "" {
			continue
		}
		parts = append(parts, "【"+role+"】"+truncate(content, 2000))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return strings.Join(parts, "\n"), nil
}

// agentSummarize 调用一次 agent_summary 模型压缩历史。失败时返回错误，调用方保留旧摘要。
func (s *Server) agentSummarize(ctx context.Context, st *agentRunState, old, body string) (string, error) {
	conv, err := s.agentConversationFor(ctx, st.ConversationID)
	if err != nil {
		return "", err
	}
	ref, err := s.agentRunModel(ctx, conv)
	if err != nil {
		return "", err
	}
	st.Model = ref
	rt, err := s.agentResolveModel(ctx, st)
	if err != nil {
		return "", err
	}
	if err := s.checkLimit(ctx); err != nil {
		return "", err
	}
	user := "已有摘要（更早的历史）：\n" + old + "\n\n需要压缩的历史：\n" + body
	modelCtx, client := s.aiClientForRoute(ctx, rt)
	text, _, _, _, err := ai.Stream(modelCtx, client, ai.Request{
		BaseURL: rt.BaseURL, APIKey: rt.APIKey, Model: rt.Model,
		Messages: []ai.Message{
			{Role: "system", Content: agentSummaryRules},
			{Role: "user", Content: user},
		},
	}, nil)
	if err != nil {
		return "", err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", apiErr(502, "ai_upstream_error", "模型没有返回摘要")
	}
	return truncate(text, agentSummaryLimit), nil
}
