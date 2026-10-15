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
	Text          string         `json:"text"`
	AttachmentIDs []string       `json:"attachment_ids"`
	AccountID     string         `json:"account_id"`
	Model         *agentModelRef `json:"model"`
}

// agentDecodeBody 解码 JSON 对象请求体；数组与非对象返回 400（第 11.2 节末段）。
func agentDecodeBody(r *http.Request, v any) error {
	br := bufio.NewReader(r.Body)
	// 第 11.2 节末段、第 11.3 节第 1 项：只允许单个 JSON 对象，数组返回 400 validation_failed。
	if b, err := br.Peek(1); err == nil && b[0] == '[' {
		return apiErr(400, "validation_failed", "请求体必须是单个 JSON 对象，不能是数组")
	}
	dec := json.NewDecoder(br)
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
	attIDs, err := s.agentCheckMessageAttachments(ctx, conv.ID, req.AttachmentIDs)
	if err != nil {
		return err
	}
	// 第 6.4 节第 5 项：先写入未报告的卡片结果，再写入用户消息。
	if err := s.agentReportCardResults(ctx, conv.ID); err != nil {
		return err
	}
	if err := s.agentApplyConversationOverride(ctx, conv, req); err != nil {
		return err
	}
	if _, err := s.agentInsertRow(ctx, conv.ID, nil, "user", text, nil, "", "", attIDs); err != nil {
		return err
	}
	// 第 8.2 节第 4 项：消息引用的附件标记为已引用并绑定对话。
	if err := s.agentMarkAttachmentsReferenced(ctx, conv.ID, attIDs); err != nil {
		return err
	}
	s.agentAutoTitle(ctx, conv, text)
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=0, updated_at=now() WHERE id=$1`,
		conv.ID); err != nil {
		return err
	}
	return s.agentStreamRun(w, r, conv, "message")
}

// agentApplyConversationOverride 应用请求中的账号与模型覆盖并保存到对话（第 11.2 节）。
func (s *Server) agentApplyConversationOverride(ctx context.Context, conv *agentConversation,
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
	if accountID == conv.AccountID && providerID == conv.ModelProviderID && model == conv.Model {
		return nil
	}
	_, err := s.db.Exec(ctx, `UPDATE agent_conversation
		SET account_id=$2, model_provider_id=$3, model=$4, updated_at=now() WHERE id=$1`,
		conv.ID, accountID, providerID, model)
	if err != nil {
		return err
	}
	conv.AccountID, conv.ModelProviderID, conv.Model = accountID, providerID, model
	return nil
}

// agentCheckMessageAttachments 校验附件条数、归属与未引用状态（第 6.5 节末两行）。
func (s *Server) agentCheckMessageAttachments(ctx context.Context, convID uuid.UUID,
	ids []string) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > agentAttachmentsPerMessage {
		return nil, apiErr(422, "agent_attachment_invalid", "每条消息最多 6 个附件")
	}
	out := []uuid.UUID{}
	for _, raw := range ids {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, apiErr(422, "agent_attachment_invalid", "附件不存在或已被删除")
		}
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_attachment
			WHERE id=$1 AND user_id=$2 AND referenced=false AND (conversation_id IS NULL OR conversation_id=$3)`,
			id, ident(ctx).UserID, convID).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, apiErr(422, "agent_attachment_invalid", "附件不存在、已被使用或不属于本人")
		}
		out = append(out, id)
	}
	return out, nil
}

// agentInsertRow 写入一条消息；runID 可为空（用户消息、action_result）。
func (s *Server) agentInsertRow(ctx context.Context, convID uuid.UUID, runID *uuid.UUID, role, content string,
	toolCalls any, toolCallID, toolName string, attachments []uuid.UUID) (*agentMessageView, error) {
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	var seq int
	if err := s.db.QueryRow(ctx, `UPDATE agent_conversation
		SET next_seq = next_seq + 1, last_message_at = now(), updated_at = now()
		WHERE id=$1 RETURNING next_seq`, convID).Scan(&seq); err != nil {
		return nil, err
	}
	view := agentMessageView{Seq: seq, Role: role, Content: content, RunID: runID}
	if err := s.db.QueryRow(ctx, `INSERT INTO agent_message
		(conversation_id, seq, run_id, role, content, tool_calls, tool_call_id, tool_name, attachment_ids)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
		convID, seq, runID, role, content, toolCalls, toolCallID, toolName, attachments).
		Scan(&view.ID, &view.CreatedAt); err != nil {
		return nil, err
	}
	view.Attachments = []agentAttachmentView{}
	return &view, nil
}

// ---------- 未报告卡片结果（第 6.4 节第 4 项、第 6.3 节第 4 条） ----------

// agentReportCardResults 把“已结束但未报告”的卡片结果合并为一条 action_result 消息，
// 写入后一次性设置 reported_at。
func (s *Server) agentReportCardResults(ctx context.Context, convID uuid.UUID) error {
	rows, err := s.db.Query(ctx, `UPDATE agent_action
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
	ids := []uuid.UUID{}
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
		ids = append(ids, it.ID)
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
	_, err = s.agentInsertRow(ctx, convID, nil, "action_result", content, nil, "", "", nil)
	return err
}

// ---------- 运行流编排（第 11.4 节运行流） ----------

// agentCheckRunLimits 校验并发上限：每对话 1 个运行（409），每用户 2 个运行（429）。
func (s *Server) agentCheckRunLimits(ctx context.Context, conv *agentConversation) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_run
		WHERE conversation_id=$1 AND status IN ('queued','running')`, conv.ID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apiErr(409, "agent_run_busy", "这个对话正在运行中，请等待本次运行结束")
	}
	var m int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_run
		WHERE workspace_id=$1 AND user_id=$2 AND status IN ('queued','running')`,
		ident(ctx).WorkspaceID, ident(ctx).UserID).Scan(&m); err != nil {
		return err
	}
	if m >= agentMaxRunsPerUser {
		return apiErr(429, "agent_limit_reached", "同时运行的任务太多，请等待其中一次结束")
	}
	return nil
}

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

// agentStreamRun 走完整 SSE 流程执行一次运行。客户端断开后服务端继续运行到结束（第 6.8 节第 1 项）。
func (s *Server) agentStreamRun(w http.ResponseWriter, r *http.Request, conv *agentConversation,
	trigger string) error {
	ctx := r.Context()
	if err := s.agentCheckRunLimits(ctx, conv); err != nil {
		return err
	}
	model, err := s.agentRunModel(ctx, conv)
	if err != nil {
		return err
	}
	st, err := s.agentStartRun(ctx, trigger, conv, model)
	if err != nil {
		return err
	}
	// 第 6.2 节第 4 项、第 8.3 节第 1 项：把触发本次运行的最后一条用户消息关联到本次运行；
	// 图片附件据此只在触发它的运行中以多模态发送，之后的运行替换为文字占位。
	if trigger != "continue" {
		if _, err := s.db.Exec(ctx, `UPDATE agent_message SET run_id=$1 WHERE conversation_id=$2 AND seq=(
			SELECT max(seq) FROM agent_message WHERE conversation_id=$2 AND role='user')`,
			st.RunID, conv.ID); err != nil {
			return err
		}
	}
	rt, err := s.agentResolveModel(ctx, st)
	if err != nil {
		s.finishAgentRun(ctx, st, "failed", "", nil)
		return err
	}
	sse := newSSE(w)
	// 第 6.8 节第 1 项：运行与客户端连接解耦，浏览器断开后服务端继续运行到结束；
	// 取消只来自用户点击停止（agentCancelRun）。
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	s.registerAgentRun(st.RunID, cancel)
	send := func(event string, data any) {
		select {
		case <-ctx.Done():
			// 客户端已断开：不再向连接写入。
		case <-runCtx.Done():
			// 已取消。
		default:
			sse.send(event, data)
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		// agentRun 内部按第 6.1 节第 4 项收尾（finishAgentRun 在 defer 中调用）。
		s.agentRun(runCtx, st, rt, send)
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
	if err := s.agentCheckRunLimits(ctx, conv); err != nil {
		return err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT auto_continue_count FROM agent_conversation WHERE id=$1`,
		conv.ID).Scan(&count); err != nil {
		return err
	}
	if count >= agentMaxContinuations {
		return apiErr(429, "agent_limit_reached", "连续自动续跑次数已达上限，请发送消息继续")
	}
	if err := s.agentReportCardResults(ctx, conv.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation
		SET auto_continue_count = auto_continue_count + 1, updated_at=now() WHERE id=$1`, conv.ID); err != nil {
		return err
	}
	return s.agentStreamRun(w, r, conv, "continue")
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
func (s *Server) agentLastUserMessage(ctx context.Context, convID uuid.UUID) (*agentLastUserMessage, error) {
	var m agentLastUserMessage
	err := s.db.QueryRow(ctx, `SELECT id, seq, content, attachment_ids, created_at
		FROM agent_message WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, convID).
		Scan(&m.ID, &m.Seq, &m.Content, &m.AttachmentIDs, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// agentCheckRewriteAllowed 校验重新生成 / 编辑的前提（第 6.7 节第 3 项）：
// 没有运行中的 run，且该用户消息之后没有 succeeded / executing / needs_input 的卡片。
func (s *Server) agentCheckRewriteAllowed(ctx context.Context, conv *agentConversation,
	m *agentLastUserMessage) error {
	if err := s.agentCheckRunLimits(ctx, conv); err != nil {
		return err
	}
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_action
		WHERE conversation_id=$1 AND created_at >= $2 AND status IN ('succeeded','executing','needs_input')`,
		conv.ID, m.CreatedAt).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apiErr(409, "agent_action_state_invalid", "已有操作执行过，不能重写这段对话，请发送新消息")
	}
	return nil
}

// agentRewriteTail 删除指定序号之后的全部消息，并把该时间点之后的未结束卡片改为 superseded
// （第 6.7 节第 1 项）。替代卡片不在这里设置 reported_at，由下一次运行的 action_result 合并报告。
func (s *Server) agentRewriteTail(ctx context.Context, convID uuid.UUID, seq int, since time.Time) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM agent_message WHERE conversation_id=$1 AND seq > $2`,
		convID, seq); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='superseded'
		WHERE conversation_id=$1 AND created_at >= $2 AND status IN ('pending','executing','needs_input')`,
		convID, since)
	return err
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
	last, err := s.agentLastUserMessage(ctx, conv.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(409, "agent_action_state_invalid", "这个对话还没有可重新生成的运行")
		}
		return err
	}
	if err := s.agentCheckRewriteAllowed(ctx, conv, last); err != nil {
		return err
	}
	if err := s.agentRewriteTail(ctx, conv.ID, last.Seq, last.CreatedAt); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=0, updated_at=now() WHERE id=$1`,
		conv.ID); err != nil {
		return err
	}
	return s.agentStreamRun(w, r, conv, "regenerate")
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
	messageID, err := uuid.Parse(chi.URLParam(r, "messageId"))
	if err != nil {
		return errNotFound
	}
	last, err := s.agentLastUserMessage(ctx, conv.ID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if last.ID != messageID {
		return apiErr(409, "agent_action_state_invalid", "只能编辑最后一条用户消息")
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
	attIDs, err := s.agentCheckMessageAttachments(ctx, conv.ID, req.AttachmentIDs)
	if err != nil {
		return err
	}
	if err := s.agentCheckRewriteAllowed(ctx, conv, last); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_message SET content=$2, attachment_ids=$3 WHERE id=$1`,
		messageID, text, attIDs); err != nil {
		return err
	}
	// 第 8.2 节第 4 项：编辑后引用的附件标记为已引用并绑定对话。
	if err := s.agentMarkAttachmentsReferenced(ctx, conv.ID, attIDs); err != nil {
		return err
	}
	if err := s.agentRewriteTail(ctx, conv.ID, last.Seq, last.CreatedAt); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation SET auto_continue_count=0, updated_at=now() WHERE id=$1`,
		conv.ID); err != nil {
		return err
	}
	return s.agentStreamRun(w, r, conv, "edit")
}

// ---------- 停止运行（第 6.7 节第 4 项） ----------

func (s *Server) postAgentRunCancel(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	runID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	var owner uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT user_id FROM agent_run WHERE id=$1`, runID).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if owner != ident(ctx).UserID {
		return errNotFound
	}
	if s.agentCancelRun(runID) {
		return ok(w, map[string]any{"ok": true})
	}
	return apiErr(409, "agent_run_busy", "这次运行已经结束，无需停止")
}

// ---------- 标题（第 6.8 节第 4 项） ----------

// agentAutoTitle 取第一条用户消息的前 30 个字符作为自动标题；用户改名后不再变化。
func (s *Server) agentAutoTitle(ctx context.Context, conv *agentConversation, text string) {
	if conv.TitleSource != "auto" {
		return
	}
	title := strings.Join(strings.Fields(strings.ReplaceAll(text, "\n", " ")), " ")
	title = truncate(title, agentTitleChars)
	if title == "" {
		title = "新对话"
	}
	if _, err := s.db.Exec(ctx, `UPDATE agent_conversation SET title=$2, updated_at=now() WHERE id=$1 AND title_source='auto'`,
		conv.ID, title); err != nil {
		slog.Warn("自动设置对话标题失败", "conversation_id", conv.ID.String(), "err", err)
	}
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
	text, _, _, _, err := ai.Stream(ctx, s.aiHTTP, ai.Request{
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
