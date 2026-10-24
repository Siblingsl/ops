package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// 运行循环（16 文档第 6 节）。本文件实现一次运行的状态、轮次循环、限额、取消、
// 截止、无效调用熔断、模型调用与 ai_call 落库；续跑与重新生成在 agent_continue.go，
// 上下文组装在 agent_context.go，卡片提出在 agent_propose.go。

// agentRunState 是一次运行在内存中的状态（第 6.1 节）。
type agentRunState struct {
	RunID          uuid.UUID
	ConversationID uuid.UUID
	WorkspaceID    uuid.UUID
	UserID         uuid.UUID
	SessionID      uuid.UUID
	Trigger        string // message | continue | regenerate | edit
	AccountID      *uuid.UUID
	Model          agentModelRef
	ProviderName   string
	Vision         bool

	// 第 6.5 节的运行内计数。
	Rounds           int
	ReadCalls        int
	GenerateCalls    int
	ActionsProposed  int
	InvalidCalls     int
	PromptTokens     int
	CompletionTokens int
	ExternalRead     bool
	CardsThisRound   int

	Domains  []string
	Deadline time.Time
	BatchID  uuid.UUID

	// Summary 是对话的历史摘要（第 6.8 节第 3 项）。
	Summary string
	// SummaryUptoSeq 是摘要覆盖到的消息序号（第 6.8 节第 3 项）。
	SummaryUptoSeq int

	// ErrCode、ErrMsg 是运行失败时写入 agent_run 的错误（第 11.6 节）。
	ErrCode string
	ErrMsg  string
}

// agentModelPayload 是一轮模型调用的输入（不含系统规则，由 agent_context.go 组装）。
type agentModelPayload struct {
	Messages   []ai.Message
	Tools      []ai.Tool
	ToolChoice string
	Round      int
}

// agentRoundResult 是一轮模型调用的结果。
type agentRoundResult struct {
	Text     string
	Usage    ai.Usage
	Calls    []ai.ToolCall
	Finish   string
	CallID   uuid.UUID
	Fallback bool
}

// agentRunReason 是 run 结束原因的取值（第 6.1 节第 3 项、第 6.4 节）。
const (
	agentReasonRoundLimit = "round_limit"
	agentReasonDeadline   = "deadline"
)

// ---------- 工具可见性与工具定义（第 9.1 节） ----------

// agentToolVisible 判断条目对当前身份是否可见。可见性只是体验层面的过滤，真正的权限由
// 被调用的既有接口判定：猜不到名字只会得到 unknown_tool（第 9.1 节第 1 项）。
func agentToolVisible(t *AgentTool, id *identity) bool {
	if id == nil {
		return false
	}
	switch t.MinRole {
	case roleOwner:
		if id.Role != "owner" {
			return false
		}
	case roleSystemAdmin:
		if !id.SystemAdmin || id.AdminOverride {
			return false
		}
	}
	// 观察者只看到 GET 形式的 R 工具（第 9.1 节表格）。
	if id.Role == "viewer" && !(t.Kind == toolR && t.Method == "GET") {
		return false
	}
	return true
}

// agentToolsFor 返回本轮发给模型的工具定义：元工具 + 已加载领域中对当前角色可见的条目。
// agentToolSchema 把目录条目的入参定义转成 JSON Schema（第 3.1 节）。
func agentToolSchema(params []ToolParam) json.RawMessage {
	props := map[string]json.RawMessage{}
	required := []string{}
	for _, p := range params {
		if p.Schema != nil {
			props[p.Name] = p.Schema
		}
		if p.Required {
			required = append(required, p.Name)
		}
	}
	schema := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		schema["required"] = required
	}
	b, err := json.Marshal(schema)
	if err != nil {
		return js(`{"type":"object"}`)
	}
	return b
}

func agentToolsFor(st *agentRunState, id *identity) []ai.Tool {
	loaded := map[string]bool{}
	for _, d := range st.Domains {
		loaded[d] = true
	}
	out := []ai.Tool{}
	catalog := agentCatalog()
	for i := range catalog {
		t := &catalog[i]
		if t.Domain != "" && !loaded[t.Domain] {
			continue
		}
		if !agentToolVisible(t, id) {
			continue
		}
		out = append(out, ai.Tool{Type: "function", Function: ai.ToolFunction{
			Name: t.Name, Description: t.Description, Parameters: agentToolSchema(t.Params),
		}})
	}
	return out
}

// loadedTool 在“已加载领域 + 元工具”中按名称查找条目；领域未加载、角色不可见都视为未加载，
// 使模型只能得到 unknown_tool（第 6.6 节、第 3.3 节第 2 项）。
func (st *agentRunState) loadedTool(id *identity, name string) *AgentTool {
	t := agentTool(name)
	if t == nil {
		return nil
	}
	if t.Domain == "" {
		// 元工具始终可用，仍受角色可见性约束。
		if agentToolVisible(t, id) {
			return t
		}
		return nil
	}
	for _, d := range st.Domains {
		if d == t.Domain && agentToolVisible(t, id) {
			return t
		}
	}
	return nil
}

// ---------- 模型解析与调用（第 7.4、6.1 节） ----------

// agentResolveModel 解析对话所选模型：校验已通过工具调用自检、取供应商地址与密钥、
// 读取“看图”能力，并解析备用模型（第 7.4 节第 1、3、5 项）。
func (s *Server) agentResolveModel(ctx context.Context, st *agentRunState) (*route, error) {
	if request, ok := desktopRequestOf(ctx); ok {
		mapped, err := s.resolveDesktopRouteTier(ctx, "agent_chat", "", request)
		if err != nil {
			return nil, err
		}
		if mapped.ProviderID == st.Model.ProviderID && mapped.Model == st.Model.Model {
			st.Vision, st.ProviderName = mapped.VisionOK, mapped.ProviderName
			return mapped, nil
		}
		if mapped.Fallback != nil && mapped.Fallback.ProviderID == st.Model.ProviderID && mapped.Fallback.Model == st.Model.Model {
			chosen := *mapped.Fallback
			chosen.Fallback = mapped
			st.Vision, st.ProviderName = chosen.VisionOK, chosen.ProviderName
			return &chosen, nil
		}
		return nil, apiErr(422, "agent_model_unsupported", "所选模型不属于当前客户端 AI 的智能体路由，请重新选择")
	}
	models, _, _, err := s.agentModels(ctx)
	if err != nil {
		return nil, err
	}
	found := false
	for _, m := range models {
		if m.ProviderID == st.Model.ProviderID && m.Model == st.Model.Model {
			found = true
			st.Vision = m.Vision
			break
		}
	}
	if !found {
		return nil, apiErr(422, "agent_model_unsupported", "所选模型未通过工具调用自检或已不可用，请重新选择")
	}
	var enc []byte
	rt := &route{ProviderID: st.Model.ProviderID, Model: st.Model.Model}
	if err := s.db.QueryRow(ctx, `SELECT name, base_url, api_key_enc FROM model_provider
		WHERE id=$1 AND workspace_id=$2 AND execution_location='server' AND status='active'`, st.Model.ProviderID, st.WorkspaceID).
		Scan(&rt.ProviderName, &rt.BaseURL, &enc); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apiErr(422, "agent_model_unsupported", "所选模型的供应商已删除，请重新选择")
		}
		return nil, err
	}
	if rt.APIKey, err = s.box.Decrypt(enc); err != nil {
		return nil, err
	}
	st.ProviderName = rt.ProviderName

	// 备用模型取指向当前所选模型的路由行（第 7.4 节第 5 项），且备用模型也必须 tools_ok=true。
	var fbProvider *uuid.UUID
	var fbModel string
	_ = s.db.QueryRow(ctx, `SELECT r.fallback_provider_id, coalesce(r.fallback_model,'') FROM model_route r
		JOIN model_provider p ON p.id=r.provider_id
		WHERE r.workspace_id=$1 AND p.id=$2 AND r.model=$3 AND p.execution_location='server' AND p.status='active'
		ORDER BY (r.task_type='agent_chat') DESC LIMIT 1`, st.WorkspaceID, st.Model.ProviderID, st.Model.Model).
		Scan(&fbProvider, &fbModel)
	if fbProvider != nil && strings.TrimSpace(fbModel) != "" {
		fb := route{ProviderID: *fbProvider, Model: strings.TrimSpace(fbModel)}
		var fenc []byte
		if err := s.db.QueryRow(ctx, `SELECT name, base_url, api_key_enc FROM model_provider
			WHERE id=$1 AND workspace_id=$2 AND execution_location='server' AND status='active'`, *fbProvider, st.WorkspaceID).
			Scan(&fb.ProviderName, &fb.BaseURL, &fenc); err == nil {
			if fb.APIKey, err = s.box.Decrypt(fenc); err == nil {
				for _, m := range models {
					if m.ProviderID == fb.ProviderID && m.Model == fb.Model {
						rt.Fallback = &fb
						break
					}
				}
			}
		}
	}
	return rt, nil
}

// agentCallModel 调用一次模型并写 ai_call（第 6.1 节第 2.2、2.5 项）。
func (s *Server) agentCallModel(ctx context.Context, st *agentRunState, rt *route, p agentModelPayload,
	send func(string, any)) (agentRoundResult, error) {
	out := agentRoundResult{}
	if err := s.checkLimit(ctx); err != nil {
		return out, err
	}
	attempts := []*route{rt}
	if rt.Fallback != nil {
		attempts = append(attempts, rt.Fallback)
		if v, _ := ctx.Value(ctxPreferFallback).(bool); v {
			attempts = attempts[1:]
		}
	}
	var lastErr, err error
	streamed := false
	for i, cur := range attempts {
		var got atomic.Bool
		out.Text, out.Usage, out.Calls, out.Finish, lastErr = s.streamAgentRound(ctx, st, cur, p, &got, send)
		status, errText := "ok", ""
		if lastErr != nil {
			status, errText = "failed", lastErr.Error()
			if ctx.Err() != nil {
				status = "cancelled"
			}
		}
		if got.Load() {
			streamed = true
		}
		out.CallID, err = s.writeAgentAICall(ctx, st, cur, p, status, errText, out.Usage, i > 0)
		if err != nil {
			return out, err
		}
		out.Fallback = i > 0
		if lastErr == nil {
			return out, nil
		}
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		if i+1 < len(attempts) && !streamed && retryable(lastErr) {
			slog.Warn("智能体主模型不可用，切换备用模型", "run_id", st.RunID.String(), "err", lastErr)
			continue
		}
		var unavailable *APIError
		if errors.As(lastErr, &unavailable) && unavailable.Code == "ai_provider_unavailable" {
			return out, unavailable
		}
		return out, apiErr(502, "ai_upstream_error", "模型服务调用失败："+truncate(lastErr.Error(), 300)+"。可以重试或在模型配置中设置备用模型。")
	}
	return out, lastErr
}

// streamAgentRound 是一次模型调用，带第 15 秒首字超时与熔断（D-054、D-069）。
func (s *Server) streamAgentRound(ctx context.Context, st *agentRunState, rt *route, p agentModelPayload,
	got *atomic.Bool, send func(string, any)) (string, ai.Usage, []ai.ToolCall, string, error) {
	attempt, err := s.beginProviderCall(rt.ProviderID)
	if err != nil {
		return "", ai.Usage{}, nil, "", err
	}
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	var desktopTimeout *desktopModelTimeout
	if rt.Desktop != nil {
		desktopTimeout = newDesktopModelTimeout(s.desktopFirstContentBudget(), desktopModelIdleTimeout, cancel)
		defer desktopTimeout.Stop()
	} else {
		timer := time.AfterFunc(s.firstTokenTimeout, func() {
			if !got.Load() {
				cancel()
			}
		})
		defer timer.Stop()
	}
	limit := agentMaxOutputTokens
	callRoute := rt
	if rt.Desktop != nil && !st.Deadline.IsZero() {
		copyRoute := *rt
		copyExecution := *rt.Desktop
		copyExecution.Deadline = st.Deadline
		copyRoute.Desktop = &copyExecution
		callRoute = &copyRoute
	}
	modelCtx, client := s.aiClientForRoute(actx, callRoute)
	text, usage, calls, finish, err := ai.Stream(modelCtx, client, ai.Request{
		BaseURL: rt.BaseURL, APIKey: rt.APIKey, Model: rt.Model,
		Messages:   p.Messages,
		Tools:      p.Tools,
		ToolChoice: p.ToolChoice,
		Round:      p.Round,
		MaxTokens:  &limit,
		OnActivity: func() {
			if rt.Desktop != nil {
				got.Store(true)
				desktopTimeout.Activity()
			}
		},
	}, func(d string) {
		got.Store(true)
		if send != nil {
			send("delta", map[string]string{"text": d})
		}
	})
	var timeoutErr error
	if desktopTimeout != nil {
		timeoutErr = desktopTimeout.Error()
	}
	if timeoutErr != nil {
		err = timeoutErr
	} else if err != nil && ctx.Err() == nil && actx.Err() != nil && !got.Load() {
		err = errFirstToken
	}
	s.finishProviderCall(rt.ProviderID, attempt, ctx, err)
	return text, usage, calls, finish, err
}

// writeAgentAICall 写一条 ai_call（第 6.1 节第 2.5 项）。
func (s *Server) writeAgentAICall(ctx context.Context, st *agentRunState, rt *route, p agentModelPayload,
	status, errText string, usage ai.Usage, fallbackUsed bool) (uuid.UUID, error) {
	names := make([]string, 0, len(p.Tools))
	for _, t := range p.Tools {
		names = append(names, t.Function.Name)
	}
	refs := map[string]any{"agent": map[string]any{
		"run_id": st.RunID.String(), "round": p.Round, "tools": names,
	}}
	if fallbackUsed {
		refs["fallback_used"] = true
		refs["fallback_model"] = rt.ProviderName + " / " + rt.Model
	}
	raw, _ := json.Marshal(refs)
	var id uuid.UUID
	err := s.db.QueryRow(context.WithoutCancel(ctx), `INSERT INTO ai_call
		(workspace_id, account_id, work_id, task_type, provider, model, template_version, context_refs,
		 prompt_tokens, completion_tokens, status, error)
		VALUES ($1,$2,$3,'agent_chat',$4,$5,1,$6,$7,$8,$9,$10) RETURNING id`,
		st.WorkspaceID, st.AccountID, nil, rt.ProviderName, rt.Model, raw,
		usage.PromptTokens, usage.CompletionTokens, status, truncate(errText, 500)).Scan(&id)
	return id, err
}

// ---------- 轮次循环（第 6.1 节） ----------

// errAgentToolInvalid 是连续无效工具调用达到上限时的终止错误（第 6.5 节）。
var errAgentToolInvalid = errors.New("连续无效工具调用达到上限")

// agentRun 执行一次运行。send 为 nil 表示客户端已断开，运行继续到结束（第 6.8 节第 1 项）。
// 返回值是运行终态与 reason，供调用方判断是否触发续跑。
func (s *Server) agentRun(ctx context.Context, st *agentRunState, rt *route, send func(string, any)) (status, reason string) {
	id := ident(ctx)
	status, reason = "completed", ""
	defer func() { s.finishAgentRun(ctx, st, status, reason, send) }()
	if send != nil {
		send("run", map[string]any{"run_id": st.RunID, "status": "running"})
	}
	st.Deadline = time.Now().Add(agentRunSeconds * time.Second)

	for st.Rounds < agentMaxRounds {
		// 第 6.1 节第 2.1 项：取消标记、截止时间；第 9.3 节第 2 项：维护模式。
		if ctx.Err() != nil {
			status = "stopped"
			return
		}
		if !time.Now().Before(st.Deadline) {
			status, reason = "completed", agentReasonDeadline
			return
		}
		if on, err := s.systemBool(ctx, "maintenance_mode", false); err == nil && on && !id.SystemAdmin {
			status = "stopped"
			return
		}
		release, err := s.waitAIWorker(ctx, func() {
			if send != nil {
				send("stage", map[string]string{"stage": "queued"})
			}
		})
		if err != nil {
			if ctx.Err() != nil {
				status = "stopped"
			} else {
				status = "failed"
				s.agentRunError(st, err)
			}
			return
		}
		res, rerr := s.agentRound(ctx, st, rt, id, send)
		release()
		if rerr != nil {
			if ctx.Err() != nil {
				status = "stopped"
			} else if errors.Is(rerr, errAgentToolInvalid) {
				status = "failed"
				st.ErrCode = "agent_tool_invalid"
				st.ErrMsg = "连续多次调用了不存在的工具或参数不正确，本次运行已停止"
			} else {
				status = "failed"
				s.agentRunError(st, rerr)
			}
			return
		}
		if len(res.Calls) == 0 {
			// 第 6.1 节第 2.7 项：没有工具调用，运行完成。
			return
		}
		if st.CardsThisRound > 0 {
			// 第 5.2 节第 8 项、第 6.1 节第 2.9 项：说明轮后进入 awaiting_confirmation。
			st.Rounds++
			note, nerr := s.agentExplanationRound(ctx, st, rt, send)
			if nerr != nil {
				if ctx.Err() != nil {
					status = "stopped"
				} else {
					status = "failed"
					s.agentRunError(st, nerr)
				}
				return
			}
			if strings.TrimSpace(note) != "" {
				_, _ = s.agentSaveAssistantText(ctx, st, note)
			}
			status = "awaiting_confirmation"
			return
		}
	}
	// 第 6.1 节第 3 项：轮次用尽。
	status, reason = "completed", agentReasonRoundLimit
	return status, reason
}

// agentRunError 把错误翻译成 agent_run 上的错误码与提示。
func (s *Server) agentRunError(st *agentRunState, err error) {
	var ae *APIError
	if errors.As(err, &ae) {
		st.ErrCode = ae.Code
		st.ErrMsg = ae.Message
		return
	}
	st.ErrCode = "internal"
	st.ErrMsg = truncate(err.Error(), 300)
}

// agentRound 执行一轮：组装上下文、调用模型、保存助手消息、逐个处理工具调用。
func (s *Server) agentRound(ctx context.Context, st *agentRunState, rt *route, id *identity,
	send func(string, any)) (agentRoundResult, error) {
	st.Rounds++
	if send != nil {
		send("stage", map[string]string{"stage": "thinking"})
	}
	// DEV-SK3 / 8.2 节：每轮复核当前活动技能区；失效返回 skill_context_changed 停止运行。
	if st.AccountID != nil {
		if acc, accErr := s.account(ctx, *st.AccountID); accErr == nil {
			if err := s.agentSkillVerifyActive(ctx, st, acc); err != nil {
				return agentRoundResult{}, err
			}
		}
	}
	msgs, err := s.agentBuildMessages(ctx, st, id)
	if err != nil {
		return agentRoundResult{}, err
	}
	tools := agentToolsFor(st, id)
	res, err := s.agentCallModel(ctx, st, rt, agentModelPayload{
		Messages: msgs, Tools: tools, ToolChoice: "auto", Round: st.Rounds,
	}, send)
	if err != nil {
		return agentRoundResult{}, err
	}
	st.PromptTokens += res.Usage.PromptTokens
	st.CompletionTokens += res.Usage.CompletionTokens
	if _, err := s.agentSaveAssistantCall(ctx, st, res); err != nil {
		return agentRoundResult{}, err
	}
	st.CardsThisRound = 0
	for _, c := range res.Calls {
		if err := s.agentHandleToolCall(ctx, st, id, c, send); err != nil {
			return agentRoundResult{}, err
		}
	}
	return res, nil
}

// agentExplanationRound 是第 5.2 节第 8 项的说明轮：不带工具定义，也不发送 tool_choice。
// 本次把它计入轮次（消耗模型输出），已在 90 文档登记。
func (s *Server) agentExplanationRound(ctx context.Context, st *agentRunState, rt *route,
	send func(string, any)) (string, error) {
	msgs, err := s.agentBuildMessages(ctx, st, ident(ctx))
	if err != nil {
		return "", err
	}
	res, err := s.agentCallModel(ctx, st, rt, agentModelPayload{Messages: msgs, Round: st.Rounds}, send)
	if err != nil {
		return "", err
	}
	st.PromptTokens += res.Usage.PromptTokens
	st.CompletionTokens += res.Usage.CompletionTokens
	return res.Text, nil
}

// ---------- 消息写入 ----------

// agentInsertMessage 写入一条消息并推进对话的 seq 与 last_message_at（第 10 节）。
func (s *Server) agentInsertMessage(ctx context.Context, st *agentRunState, role, content string,
	toolCalls any, toolCallID, toolName string, attachments []uuid.UUID, callID *uuid.UUID) (*agentMessageView, error) {
	if attachments == nil {
		attachments = []uuid.UUID{}
	}
	var seq int
	if err := s.db.QueryRow(ctx, `UPDATE agent_conversation
		SET next_seq = next_seq + 1, last_message_at = now(), updated_at = now()
		WHERE id=$1 RETURNING next_seq`, st.ConversationID).Scan(&seq); err != nil {
		return nil, err
	}
	view := agentMessageView{Seq: seq, Role: role, Content: content, AICallID: callID, RunID: &st.RunID}
	if err := s.db.QueryRow(ctx, `INSERT INTO agent_message
		(conversation_id, seq, run_id, role, content, tool_calls, tool_call_id, tool_name, attachment_ids, ai_call_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
		st.ConversationID, seq, st.RunID, role, content, toolCalls, toolCallID, toolName, attachments, callID).
		Scan(&view.ID, &view.CreatedAt); err != nil {
		return nil, err
	}
	view.Attachments = []agentAttachmentView{}
	return &view, nil
}

// agentSaveAssistantCall 保存助手消息（文字 + tool_calls，第 6.1 节第 2.6 项）。
func (s *Server) agentSaveAssistantCall(ctx context.Context, st *agentRunState, res agentRoundResult) (*agentMessageView, error) {
	var toolCalls any
	if len(res.Calls) > 0 {
		arr := make([]map[string]any, 0, len(res.Calls))
		for _, c := range res.Calls {
			arr = append(arr, map[string]any{
				"id": c.ID, "name": c.Function.Name, "arguments": c.Function.Arguments,
			})
		}
		toolCalls = arr
	}
	return s.agentInsertMessage(ctx, st, "assistant", res.Text, toolCalls, "", "", nil, &res.CallID)
}

// agentSaveAssistantText 保存一条纯文字助手消息（说明轮或系统提示）。
func (s *Server) agentSaveAssistantText(ctx context.Context, st *agentRunState, text string) (*agentMessageView, error) {
	return s.agentInsertMessage(ctx, st, "assistant", text, nil, "", "", nil, nil)
}

// agentToolRecord 是一个工具调用的结果：交给模型的投影与落库的完整脱敏原文。
type agentToolRecord struct {
	Model   []byte
	Raw     []byte
	Summary string
}

// agentSaveToolResult 写一条 role=tool 消息，保证每个 tool_call_id 都有对应结果（第 6.1 节第 2.8 项）。
func (s *Server) agentSaveToolResult(ctx context.Context, st *agentRunState, call ai.ToolCall, rec agentToolRecord) error {
	_, err := s.agentInsertMessage(ctx, st, "tool", string(rec.Raw), nil, call.ID, call.Function.Name, nil, nil)
	return err
}

// agentToolOutcome 落库工具结果并向客户端发送 tool 事件。
func (s *Server) agentToolOutcome(ctx context.Context, st *agentRunState, call ai.ToolCall, rec agentToolRecord,
	ok bool, send func(string, any)) error {
	if err := s.agentSaveToolResult(ctx, st, call, rec); err != nil {
		return err
	}
	if send != nil {
		status := "done"
		if !ok {
			status = "error"
		}
		send("tool", map[string]any{
			"tool_call_id": call.ID, "name": call.Function.Name, "status": status,
			"summary": truncate(rec.Summary, 120),
		})
	}
	return nil
}

// agentToolError 返回一种工具级错误，并计入连续无效调用（第 6.6 节）。
func (s *Server) agentToolError(ctx context.Context, st *agentRunState, call ai.ToolCall, code, msg string,
	send func(string, any)) error {
	st.InvalidCalls++
	payload, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": msg}})
	if err := s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: msg}, false, send); err != nil {
		return err
	}
	if st.InvalidCalls >= agentMaxInvalidCalls {
		return errAgentToolInvalid
	}
	return nil
}

// ---------- 工具调用处理（第 6.1 节第 2.8 项、第 6.6 节） ----------

// agentHandleToolCall 按返回顺序处理一个工具调用。
func (s *Server) agentHandleToolCall(ctx context.Context, st *agentRunState, id *identity,
	call ai.ToolCall, send func(string, any)) error {
	name := call.Function.Name
	raw := strings.TrimSpace(call.Function.Arguments)
	if raw == "" {
		raw = "{}"
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return s.agentToolError(ctx, st, call, "invalid_arguments", "工具参数不是合法 JSON："+err.Error(), send)
	}
	t := st.loadedTool(id, name)
	if t == nil {
		return s.agentToolError(ctx, st, call, "unknown_tool", "还不知道这个工具；先用 load_tool_domain 加载对应领域", send)
	}
	clean := map[string]any{}
	for _, p := range t.Params {
		v, ok := args[p.Name]
		if !ok || v == nil {
			if p.Required {
				return s.agentToolError(ctx, st, call, "invalid_arguments", "缺少参数 "+p.Name, send)
			}
			continue
		}
		got, err := agentValidateParam(p, v)
		if err != nil {
			return s.agentToolError(ctx, st, call, "invalid_arguments", err.Error(), send)
		}
		clean[p.Name] = got
	}
	st.InvalidCalls = 0

	// 本地元工具不经分发器（第 3.3 节第 3 项）。
	if t.Path == "" {
		return s.agentMetaTool(ctx, st, t, call, clean, send)
	}

	switch t.Kind {
	case toolR, toolG:
		limit, label := agentMaxReads, "读取"
		if t.Kind == toolG {
			limit, label = agentMaxGenerates, "生成"
		}
		used := st.ReadCalls
		if t.Kind == toolG {
			used = st.GenerateCalls
		}
		if used >= limit {
			// 第 6.5 节：限额已满返回 agent_limit_reached，不计入连续无效。
			return s.agentToolLimit(ctx, st, call, "本次运行的"+label+"次数已达上限，请先用已读到的内容回答或减少调用", send)
		}
		if t.Kind == toolR {
			st.ReadCalls++
		} else {
			st.GenerateCalls++
		}
		if agentToolExternal(t.Name) {
			// 第 6.3 节第 3 项：读过外部来源，本运行提出的卡片带来源提示。
			st.ExternalRead = true
		}
		return s.agentToolDispatch(ctx, st, t, call, clean, send)
	case toolW, toolH, toolX:
		return s.agentPropose(ctx, st, id, t, call, clean, send)
	}
	return s.agentToolError(ctx, st, call, "unknown_tool", "该工具当前不可用", send)
}

// agentToolLimit 返回限额类工具错误（不计入连续无效，第 6.6 节）。
func (s *Server) agentToolLimit(ctx context.Context, st *agentRunState, call ai.ToolCall, msg string,
	send func(string, any)) error {
	return s.agentToolLimitWithCode(ctx, st, call, "agent_limit_reached", msg, send)
}

// agentToolLimitWithCode 返回带自定义错误码的限额类工具错误（不计入连续无效）。
func (s *Server) agentToolLimitWithCode(ctx context.Context, st *agentRunState, call ai.ToolCall, code, msg string,
	send func(string, any)) error {
	payload, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": msg}})
	return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: msg}, false, send)
}

// agentToolDispatch 经分发器执行一次 R / G 工具调用。
func (s *Server) agentToolDispatch(ctx context.Context, st *agentRunState, t *AgentTool, call ai.ToolCall,
	args map[string]any, send func(string, any)) error {
	secrets := s.agentSecretValues(ctx, st.WorkspaceID)
	started := time.Now()
	res, err := s.dispatchAgentTool(ctx, agentDispatchRequest{
		Principal: agentPrincipal{SessionID: st.SessionID, WorkspaceID: st.WorkspaceID,
			ConversationID: st.ConversationID, RunID: st.RunID},
		Tool:    t,
		Args:    args,
		Timeout: t.ExecTimeout,
	})
	if err != nil {
		payload, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]any{"code": "timeout", "message": "工具调用超时或失败：" + truncate(err.Error(), 200)}})
		return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: "调用失败"}, false, send)
	}
	summary := agentToolSummary(res.Model)
	rec := agentToolRecord{Model: res.Model, Summary: summary}
	if res.Status >= 400 {
		rec.Model = agentErrorEnvelope(res.Status, res.Raw)
		rec.Raw = agentRawResultForStorage(res.Status, res.Raw, secrets)
		rec.Summary = summary
		return s.agentToolOutcome(ctx, st, call, rec, false, send)
	}
	rec.Raw = agentRawResultForStorage(res.Status, res.Raw, secrets)
	// 第 4.4 节第 6 项：G 类结果回写来源 ai_call_id，执行阶段据此为段落注入 applied。
	// 标签必须在消息落库之后回写：先落库再打标，否则 UPDATE 匹配不到行。
	tagErr := s.agentToolOutcome(ctx, st, call, rec, true, send)
	s.agentTagSourceCall(ctx, st, t.Name, call.ID, started, res.Done)
	return tagErr
}

// agentTagSourceCall 把来源 AI 调用写回该工具结果消息（第 4.4 节第 6 项）。
func (s *Server) agentTagSourceCall(ctx context.Context, st *agentRunState, toolName, callID string, from time.Time, done json.RawMessage) {
	if agentToolSourceKind(toolName) != agentSrcG {
		return
	}
	source := uuid.Nil
	if agentSkillDefSourceTools[toolName] && len(done) > 0 {
		var d struct {
			AICallID string `json:"ai_call_id"`
		}
		if json.Unmarshal(done, &d) == nil {
			if id, err := uuid.Parse(d.AICallID); err == nil {
				source = id
			}
		}
	}
	if source == uuid.Nil {
		source = s.agentLinkAICall(ctx, st.WorkspaceID, from, time.Now().Add(time.Second))
	}
	if source == uuid.Nil {
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE agent_message SET ai_call_id=$1
		WHERE conversation_id=$2 AND tool_call_id=$3`, source, st.ConversationID, callID)
}

// agentToolSummary 取工具结果的一行摘要，用于 tool 事件与折叠行。
func agentToolSummary(model []byte) string {
	var v any
	if err := json.Unmarshal(model, &v); err != nil {
		return truncate(strings.TrimSpace(string(model)), 120)
	}
	return truncate(firstLine(strings.TrimSpace(string(model))), 120)
}

// ---------- 运行收尾（第 6.1 节第 4 项） ----------

// finishAgentRun 更新 agent_run 的终态、写回 loaded_domains，并在有客户端时发送 done。
func (s *Server) finishAgentRun(ctx context.Context, st *agentRunState, status, reason string, send func(string, any)) {
	finished := time.Now()
	_ = s.db.QueryRow(context.WithoutCancel(ctx), `UPDATE agent_run SET status=$2, stage=$3, reason=$4,
		rounds=$5, read_calls=$6, generate_calls=$7, actions_proposed=$8, prompt_tokens=$9,
		completion_tokens=$10, external_read=$11, error_code=$12, error_message=$13, finished_at=$14
		WHERE id=$1 RETURNING finished_at`, st.RunID, status, status, reason,
		st.Rounds, st.ReadCalls, st.GenerateCalls, st.ActionsProposed, st.PromptTokens, st.CompletionTokens,
		st.ExternalRead, st.ErrCode, st.ErrMsg, finished).Scan(&finished)
	if len(st.Domains) > 0 {
		_, _ = s.db.Exec(context.WithoutCancel(ctx), `UPDATE agent_conversation SET loaded_domains=$2, updated_at=now() WHERE id=$1`,
			st.ConversationID, st.Domains)
	}
	s.unregisterAgentRun(st.RunID)
	agentReleaseSkillState(st.RunID)
	s.maybeSummarize(ctx, st)
	if send != nil {
		stage := "waiting_confirmation"
		if status != "awaiting_confirmation" {
			stage = status
		}
		send("done", map[string]any{
			"status": status, "reason": reason, "stage": stage,
			"usage":           map[string]int{"prompt_tokens": st.PromptTokens, "completion_tokens": st.CompletionTokens},
			"pending_actions": s.agentCountPending(ctx, st.ConversationID),
		})
	}
}

// agentCountPending 返回对话中未结束卡片数量（第 11.4 节 done.pending_actions）。
func (s *Server) agentCountPending(ctx context.Context, convID uuid.UUID) int {
	var n int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM agent_action
		WHERE conversation_id=$1 AND status IN ('pending','executing','needs_input')`, convID).Scan(&n)
	return n
}

// agentExternalTools 是读取外部来源的条目（第 6.3 节第 3 项、第 5.8 节第 6 项）。
// 附录 A 没有逐条标注 external，这里按文档列举的“热点、对标参考、收件箱、素材、附件”集中登记；
// 修改本集合需要与来源校验（第 4 节）一起核对。
var agentExternalTools = map[string]bool{
	"materials__list": true, "materials__get": true, "materials__usage": true,
	"materials__duplicates": true, "materials__extract": true, "materials__tag_suggest": true,
	"materials__retrieve": true,
	"inbox__list":         true,
	"hot__get":            true, "hot__items": true, "hot__trends": true,
	"references__list":    true,
	"topics__hot_suggest": true,
	"global_search":       true,
}

// agentToolExternal 判断条目是否读取外部来源。
func agentToolExternal(name string) bool { return agentExternalTools[name] }

// ---------- 取消与重启恢复（第 6.7 节第 4 项、第 6.8 节第 2 项） ----------

// registerAgentRun / unregisterAgentRun 维护运行取消句柄。
func (s *Server) registerAgentRun(id uuid.UUID, cancel context.CancelFunc) {
	s.agentRunMu.Lock()
	s.agentRunCancels[id] = cancel
	s.agentRunMu.Unlock()
}

func (s *Server) unregisterAgentRun(id uuid.UUID) {
	s.agentRunMu.Lock()
	delete(s.agentRunCancels, id)
	s.agentRunMu.Unlock()
}

// agentCancelRun 设置取消标记（第 6.7 节第 4 项）：模型流立即中断，进行中的 R / G 调用
// 受自身超时约束（读取 15 秒、生成 90 秒）后其结果照常落库以保证 tool_call 一一对应，
// 但循环在校验点停止，已创建的卡片保留为 pending。
func (s *Server) agentCancelRun(id uuid.UUID) bool {
	s.agentRunMu.Lock()
	cancel, ok := s.agentRunCancels[id]
	s.agentRunMu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

// recoverAgentRuns 在服务启动时把 queued/running 的运行改为 interrupted（第 6.8 节第 2 项）。
func (s *Server) recoverAgentRuns(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, `UPDATE agent_run SET status='failed', error_code='interrupted',
		error_message='服务重启，本次运行已中断', finished_at=now()
		WHERE status IN ('queued','running')`); err != nil {
		return err
	}
	// 第 5.1 节第 4 条：重启时 executing 的卡片改为 failed(result_unknown)。
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='failed',
		error=jsonb_build_object('code','result_unknown','message','服务重启时正在执行，结果未知，请到对应页面核对')
		WHERE status='executing'`)
	return err
}

// RecoverAgentRunsOnBoot 供服务启动流程调用（第 6.8 节第 2 项）。
func (s *Server) RecoverAgentRunsOnBoot(ctx context.Context) error { return s.recoverAgentRuns(ctx) }
