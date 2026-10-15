package app

// 操作卡片的执行与拒绝（16 文档第 5.3 节、第 5.9 节、第 11.3 节）。
// 写入一律由用户逐张执行：本文件只接受单个 action ID，路由下没有批量入口（HC-27）。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// agentExecuteRequest 是执行卡片的请求体（第 11.3 节）。
type agentExecuteRequest struct {
	Confirm       bool           `json:"confirm"`
	GateAck       bool           `json:"gate_ack"`
	SecondConfirm bool           `json:"second_confirm"`
	ConfirmText   string         `json:"confirm_text"`
	Resolution    string         `json:"resolution"`
	Edits         map[string]any `json:"edits"`
	Choice        *struct {
		OverwriteChoice  string `json:"overwrite_choice"`
		ConfirmOverLimit bool   `json:"confirm_over_limit"`
	} `json:"choice"`
	ClientPayload map[string]any `json:"client_payload"`
}

// agentActionRow 是执行阶段需要的卡片与归属信息。
type agentActionRow struct {
	ID             uuid.UUID
	ConversationID uuid.UUID
	WorkspaceID    uuid.UUID
	UserID         uuid.UUID
	AccountID      *uuid.UUID
	RunID          uuid.UUID
	BatchID        uuid.UUID
	ToolName       string
	Kind           string
	Gate           string
	BodyClass      bool
	Status         string
	Params         map[string]any
	Preview        agentCardPreview
	Fingerprint    string
	EditableFields []string
	BlankFields    []string
	ExpiresAt      time.Time
	Need           any
}

// agentActionQuery 读取一张卡片及其归属；他人或他工作区的卡片按 404 处理（第 9.2 节隔离）。
const agentActionQuery = `SELECT a.id, a.conversation_id, a.workspace_id, a.user_id, a.run_id, a.batch_id,
	a.tool_name, a.kind, a.gate, a.body_class, a.status, a.params, a.preview, a.fingerprint,
	a.editable_fields, a.blank_fields, a.expires_at, a.need, c.account_id
	FROM agent_action a JOIN agent_conversation c ON c.id = a.conversation_id
	WHERE a.id=$1 AND a.user_id=$2 AND c.workspace_id=$3`

// agentLoadAction 读取卡片；不存在或不属于本人本工作区时返回 404。
func (s *Server) agentLoadAction(ctx context.Context, id uuid.UUID) (*agentActionRow, error) {
	ident := ident(ctx)
	var (
		a           agentActionRow
		params      []byte
		preview     []byte
		need        []byte
		editable    []string
		blankFields []string
	)
	err := s.db.QueryRow(ctx, agentActionQuery, id, ident.UserID, ident.WorkspaceID).Scan(
		&a.ID, &a.ConversationID, &a.WorkspaceID, &a.UserID, &a.RunID, &a.BatchID, &a.ToolName,
		&a.Kind, &a.Gate, &a.BodyClass, &a.Status, &params, &preview, &a.Fingerprint,
		&editable, &blankFields, &a.ExpiresAt, &need, &a.AccountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(params, &a.Params)
	_ = json.Unmarshal(preview, &a.Preview)
	if len(need) > 0 && json.Valid(need) {
		_ = json.Unmarshal(need, &a.Need)
	}
	a.EditableFields, a.BlankFields = editable, blankFields
	if a.Params == nil {
		a.Params = map[string]any{}
	}
	return &a, nil
}

// agentExpireLazy 惰性过期：读取时把超过 24 小时的未结束卡片改为 expired（第 5.9 节第 2 项），
// 并为它们补写 action_result 记录（第 5.9 节第 4 项），供续跑时告知模型。
func (s *Server) agentExpireLazy(ctx context.Context, convID uuid.UUID) error {
	rows, err := s.db.Query(ctx, `UPDATE agent_action SET status='expired'
		WHERE conversation_id=$1 AND status IN ('pending','needs_input') AND expires_at <= now()
		RETURNING id, tool_name, target_type, target_id`, convID)
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
		Error any `json:"error,omitempty"`
	}
	items := []item{}
	for rows.Next() {
		var (
			it                   item
			targetType, targetID string
		)
		if err := rows.Scan(&it.ID, &it.Tool, &targetType, &targetID); err != nil {
			return err
		}
		it.Status = "expired"
		it.Target.Type, it.Target.ID = targetType, targetID
		it.Error = map[string]any{"code": "expired", "message": "卡片超过 24 小时未处理，已过期"}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return s.agentWriteActionResults(ctx, convID, items)
}

// agentWriteActionResults 把一批卡片终态合并为一条 action_result 消息（第 6.3 节第 4 条）。
func (s *Server) agentWriteActionResults(ctx context.Context, convID uuid.UUID, items any) error {
	body, err := json.Marshal(items)
	if err != nil || string(body) == "[]" || string(body) == "null" {
		return err
	}
	content := agentActionResultHead + "\n" + agentDataBlock("操作结果", string(body))
	_, err = s.agentInsertRow(ctx, convID, nil, "action_result", content, nil, "", "", nil)
	return err
}

// agentCheckExecuteFree 校验并发：该对话没有运行中的 run，也没有其他 executing 的卡片
// （第 5.3 节第 1 项、第 5.5 节末行）。
func (s *Server) agentCheckExecuteFree(ctx context.Context, a *agentActionRow) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_run
		WHERE conversation_id=$1 AND status IN ('queued','running')`, a.ConversationID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apiErr(409, "agent_run_busy", "这个对话正在运行中，请等运行结束再执行卡片")
	}
	var m int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_action
		WHERE conversation_id=$1 AND status='executing' AND id <> $2`, a.ConversationID, a.ID).Scan(&m); err != nil {
		return err
	}
	if m > 0 {
		return apiErr(409, "agent_run_busy", "这个对话已有一张卡片正在执行，请等它结束")
	}
	return nil
}

// agentRetryable 判断错误是否属于“执行未产生写入”的可重试错误（第 5.1 节第 2 项）。
func agentRetryable(code string) bool {
	switch code {
	case "wechat_push_running", "ai_queue_timeout", "ai_provider_unavailable",
		"database_timeout", "request_read_timeout":
		return true
	}
	return false
}

// agentNeedKind 从接口响应里识别需要人工选择的情况（第 5.3 节表格）。
func agentNeedKind(status int, body []byte, done json.RawMessage) (string, map[string]any) {
	if status == http.StatusConflict {
		var env struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &env)
		if env.Error.Code == "push_limit_reached" {
			return "over_limit", map[string]any{"kind": "over_limit"}
		}
	}
	var payload struct {
		NeedChoice string `json:"need_choice"`
		Draft      any    `json:"draft"`
	}
	_ = json.Unmarshal(done, &payload)
	switch payload.NeedChoice {
	case "draft_missing":
		return "draft_missing", map[string]any{"kind": "draft_missing"}
	case "draft_modified":
		return "draft_modified", map[string]any{"kind": "draft_modified"}
	}
	return "", nil
}

// agentConfirmTargetName 取服务端当前对象名称，用于二次确认的文本比对（第 5.3 节第 3 项）。
// `account_name` 取账号名称，`username` 取被操作用户的用户名；取不到时返回空串，
// 由调用方按“名称不符”拒绝，避免把未知对象名放行。
func (s *Server) agentConfirmTargetName(ctx context.Context, t *AgentTool, args map[string]any) (string, error) {
	if t.SecondConfirm == nil {
		return "", nil
	}
	switch t.SecondConfirm.TypeName {
	case "account_name":
		id, _ := args["accountId"].(string)
		if u, err := uuid.Parse(id); err == nil {
			var name string
			err := s.db.QueryRow(ctx, `SELECT name FROM platform_account WHERE id=$1`, u).Scan(&name)
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil
			}
			return name, err
		}
	case "username":
		// 条目形态：`/workspaces/current/members/{userId}`、`/admin/users/{id}`、
		// `POST /workspaces/current/transfer` 的请求体 `user_id`。
		id, _ := args["userId"].(string)
		if id == "" {
			id, _ = args["user_id"].(string)
		}
		if id == "" {
			id, _ = args["id"].(string)
		}
		if u, err := uuid.Parse(id); err == nil {
			var name string
			err := s.db.QueryRow(ctx, `SELECT username FROM app_user WHERE id=$1`, u).Scan(&name)
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil
			}
			return name, err
		}
	}
	return "", nil
}

// ---------- 执行一张卡片（第 5.3 节） ----------

// postAgentActionExecute 逐张执行一张卡片。请求体只接受单个卡片 ID；数组或多个 ID 返回 400。
// 整条链路只经进程内分发器走既有 chi 路由与完整中间件（第 2.3 节）。
func (s *Server) postAgentActionExecute(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	// 第 11.2 节末段：请求体必须是单个 JSON 对象，数组直接 400（与卡片是否存在无关）。
	var req agentExecuteRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	act, err := s.agentLoadAction(ctx, id)
	if err != nil {
		return err
	}
	if err := s.agentExpireLazy(ctx, act.ConversationID); err != nil {
		return err
	}
	t := agentTool(act.ToolName)
	if t == nil {
		return apiErr(409, "agent_action_state_invalid", "这张卡片对应的工具已下线，请让智能体重新提出")
	}
	// 第 1 项：归属已在 agentLoadAction 校验；这里校验并发占用。
	if err := s.agentCheckExecuteFree(ctx, act); err != nil {
		return err
	}
	// 第 2 项：状态与过期。
	if act.Status != "pending" && act.Status != "needs_input" {
		return apiErr(409, "agent_action_state_invalid", "这张卡片已经处理过了")
	}
	if !time.Now().Before(act.ExpiresAt) {
		return apiErr(409, "agent_action_state_invalid", "这张卡片已过期，请让智能体重新提出")
	}
	// 第 3 项：确认、门槛、二次确认。
	if !req.Confirm {
		return apiErr(409, "agent_gate_ack_required", "请先确认再执行")
	}
	if t.Gate != "" && !req.GateAck {
		return apiErr(409, "agent_gate_ack_required", "这张卡片需要先勾选确认"+t.Gate)
	}
	if t.SecondConfirm != nil {
		if !req.SecondConfirm {
			return apiErr(409, "agent_gate_ack_required", "这张操作不可撤销，需要二次确认")
		}
		if t.SecondConfirm.TypeName != "" {
			want, err := s.agentConfirmTargetName(ctx, t, act.Params)
			if err != nil {
				return err
			}
			if strings.TrimSpace(req.ConfirmText) != strings.TrimSpace(want) {
				return apiErr(409, "agent_gate_ack_required", "输入的名称与当前对象不一致，请重新输入")
			}
		}
	}
	// 第 4 项：edits 只能包含可修改字段；U 类清空字段必须填写。
	edits, err := s.agentCheckEdits(ctx, act, t, req.Edits)
	if err != nil {
		return err
	}
	// 第 5 项：client_payload 必须带齐（第 5.4 节）。
	if t.ClientPayload != "" {
		if v, ok := req.ClientPayload[t.ClientPayload]; !ok || agentIsBlankValue(v) {
			return apiErr(422, "validation_failed", "这张卡片需要前端提供 "+t.ClientPayload)
		}
	}
	if err := s.agentCheckChoice(act, req); err != nil {
		return err
	}
	if strings.TrimSpace(req.Resolution) != "" && act.ToolName != "checks__resolve_item" {
		return apiErr(422, "validation_failed", "resolution 只对检查项处理卡片有效")
	}

	// 第 6 项：指纹。整体替换类必须开启；有接口自身修订号校验的条目由接口判定。
	if t.Fingerprint {
		now := agentFingerprint(agentFingerprintFields(t), s.agentPreviewReadForExecute(ctx, act))
		if act.Fingerprint == "" || now == "" || now != act.Fingerprint {
			_ = s.agentFailStale(ctx, act)
			view, _ := s.agentActionByID(ctx, act.ID)
			sse := newSSE(w)
			sse.send("error", map[string]any{
				"code": "stale", "message": "对象在卡片提出后已被修改，请让智能体重新读取", "action": view,
			})
			return nil
		}
	}

	// 第 7 项：条件更新为 executing，然后组装最终请求经分发器执行。
	if _, err := s.db.Exec(ctx, `UPDATE agent_action SET status='executing', decided_by=$2, executed_at=now()
		WHERE id=$1 AND status IN ('pending','needs_input') AND expires_at > now()`,
		act.ID, ident(ctx).UserID); err != nil {
		return err
	}
	final := agentFinalArgs(act, t, edits, req.ClientPayload)
	human, err := agentHumanArgs(t, req)
	if err != nil {
		return err
	}
	sse := newSSE(w)
	res, derr := s.dispatchAgentTool(ctx, agentDispatchRequest{
		Principal: agentPrincipal{SessionID: ident(ctx).SessionID, WorkspaceID: act.WorkspaceID,
			ConversationID: act.ConversationID, RunID: act.RunID, ActionID: act.ID},
		Tool:          t,
		Args:          final,
		Human:         human,
		ClientPayload: req.ClientPayload,
		Timeout:       t.ExecTimeout,
		OnEvent: func(event string, data []byte) error {
			sse.send(event, json.RawMessage(data))
			return nil
		},
	})
	if derr != nil {
		// 第 5.1 节第 2 项：内部请求在收到响应头前超时，视为可重试。
		if err := s.agentRetryOutcome(ctx, act, "timeout", "执行超时，未产生写入，可以再次点击"); err != nil {
			return err
		}
		return s.agentEmitDone(ctx, sse, act, "执行超时，未产生写入，可以再次点击", res)
	}

	// 第 4.4 节第 6 项：命中 G 来源时为段落注入 applied（在落库前修正最终请求体）。
	s.agentInjectApplied(ctx, act, t, final)

	kind, need := agentNeedKind(res.Status, res.Raw, res.Done)
	switch {
	case res.Status >= 200 && res.Status < 300 && kind == "":
		err = s.agentSucceed(ctx, act, res)
	case kind != "":
		err = s.agentNeedInput(ctx, act, kind, need)
	case agentRetryable(agentErrorCode(res.Raw)):
		err = s.agentRetryOutcome(ctx, act, agentErrorCode(res.Raw), agentErrorMessage(res.Raw))
	default:
		err = s.agentFail(ctx, act, res)
	}
	if err != nil {
		return err
	}
	return s.agentEmitDone(ctx, sse, act, agentDoneSummary(res), res)
}

// agentCheckChoice 校验 choice 只在 needs_input 下有效且匹配 need.kind（第 11.3 节第 4 项）。
func (s *Server) agentCheckChoice(act *agentActionRow, req agentExecuteRequest) error {
	if req.Choice == nil {
		return nil
	}
	if act.Status != "needs_input" {
		return apiErr(409, "agent_action_state_invalid", "这张卡片不等待选择，不能提交 choice")
	}
	kind, _ := agentNeedKindOf(act.Need)
	switch kind {
	case "draft_missing":
		if req.Choice.OverwriteChoice != "new" {
			return apiErr(422, "validation_failed", "原草稿已不在草稿箱，只能选择新建草稿")
		}
	case "draft_modified":
		if req.Choice.OverwriteChoice != "new" && req.Choice.OverwriteChoice != "overwrite" {
			return apiErr(422, "validation_failed", "请选择覆盖已有草稿或另存为新草稿")
		}
	case "over_limit":
		if !req.Choice.ConfirmOverLimit {
			return apiErr(409, "agent_gate_ack_required", "已超过当日推送上限，需要再确认一次")
		}
	default:
		return apiErr(422, "validation_failed", "这张卡片当前没有可选项")
	}
	return nil
}

// agentNeedKindOf 从卡片的 need 里取类型。
func agentNeedKindOf(need any) (string, map[string]any) {
	obj, ok := need.(map[string]any)
	if !ok {
		return "", nil
	}
	kind, _ := obj["kind"].(string)
	return kind, obj
}

// agentCheckEdits 校验用户修改：只能包含 Editable 字段（422），U 类清空字段必须填写（409）。
// 返回规范化后的 edits（只含允许的字段）。
func (s *Server) agentCheckEdits(ctx context.Context, act *agentActionRow, t *AgentTool,
	in map[string]any) (map[string]any, error) {
	allowed := map[string]ToolParam{}
	for _, p := range t.Params {
		if editableFor(p.Source) && p.In != "path" {
			allowed[p.Name] = p
		}
	}
	out := map[string]any{}
	for k, v := range in {
		p, ok := allowed[k]
		if !ok {
			return nil, apiErr(422, "validation_failed", "字段 "+k+" 不能在这张卡片上修改")
		}
		got, err := agentValidateParam(p, v)
		if err != nil {
			return nil, apiErr(422, "validation_failed", err.Error())
		}
		out[k] = got
	}
	// 第 4.5 节：U 类字段被清空且用户没有填写时不能执行。
	missing := []string{}
	for _, f := range act.BlankFields {
		if v, ok := out[f]; !ok || agentIsBlankValue(v) {
			missing = append(missing, f)
		}
	}
	if len(missing) > 0 {
		return nil, apiErr(409, "agent_gate_ack_required",
			"这些字段只能由你本人填写："+strings.Join(missing, "、")).With(map[string]any{"fields": missing})
	}
	return out, nil
}

// agentIsBlankValue 判断用户在卡片上是否仍留空。
func agentIsBlankValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	}
	return false
}

// agentFinalArgs 组装最终请求参数：冻结参数 + 用户修改（第 5.3 节第 7 项）。
// client_payload 只在条目声明时并入；用户未改动的字段保持提出时的值。
func agentFinalArgs(act *agentActionRow, t *AgentTool, edits map[string]any, payload map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range act.Params {
		out[k] = v
	}
	for k, v := range edits {
		out[k] = v
	}
	if t.ClientPayload != "" {
		for k, v := range payload {
			out[k] = v
		}
	}
	return out
}

// agentHumanArgs 从执行请求里取出 human 字段（第 3.2 节：只来自执行请求，模型给不出）。
func agentHumanArgs(t *AgentTool, req agentExecuteRequest) (map[string]any, error) {
	out := map[string]any{}
	for _, h := range t.Human {
		switch h.Name {
		case "resolution":
			if strings.TrimSpace(req.Resolution) == "" {
				return nil, apiErr(409, "agent_gate_ack_required", "请选择这项检查的处理方式")
			}
			out[h.Name] = req.Resolution
		case "overwrite_choice", "confirm_over_limit":
			if req.Choice == nil {
				return nil, apiErr(409, "agent_gate_ack_required", "需要先在上一步做出选择")
			}
			if h.Name == "overwrite_choice" {
				out[h.Name] = req.Choice.OverwriteChoice
			} else {
				out[h.Name] = req.Choice.ConfirmOverLimit
			}
		default:
			if strings.TrimSpace(req.ConfirmText) != "" && h.Name == "confirm" {
				out[h.Name] = true
			}
		}
	}
	// 开关类 human 字段在卡片确认时统一置真（H-07 的 confirm_published 等）。
	for _, h := range t.Human {
		if _, ok := out[h.Name]; !ok {
			out[h.Name] = true
		}
	}
	return out, nil
}

// agentErrorCode / agentErrorMessage 从错误响应体里取code 与 message。
func agentErrorCode(body []byte) string {
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return ""
	}
	return env.Error.Code
}

func agentErrorMessage(body []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return ""
	}
	return env.Error.Message
}

// agentDoneSummary 取 done 事件的结果摘要。
func agentDoneSummary(res *agentDispatchResult) string {
	if res == nil {
		return ""
	}
	if msg := agentErrorMessage(res.Raw); msg != "" && res.Status >= 400 {
		return msg
	}
	var payload struct {
		Message string `json:"message"`
		Summary string `json:"summary"`
	}
	_ = json.Unmarshal(res.Model, &payload)
	if payload.Message != "" {
		return payload.Message
	}
	if payload.Summary != "" {
		return payload.Summary
	}
	return strings.TrimSpace(string(res.Model))
}

// ---------- 终态落库（第 5.3 节第 8、9 项） ----------

// agentSucceed 记录成功：result 保存脱敏后的投影（第 5.3 节第 8 项第 1 条）。
func (s *Server) agentSucceed(ctx context.Context, act *agentActionRow, res *agentDispatchResult) error {
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='succeeded',
		result=$2, error=NULL, last_error=NULL, finished_at=now()
		WHERE id=$1`, act.ID, jsonOrEmpty(res.Model))
	return err
}

// agentNeedInput 记录需要人工选择（第 5.3 节第 8 项第 2 条）。
func (s *Server) agentNeedInput(ctx context.Context, act *agentActionRow, kind string, need map[string]any) error {
	if need == nil {
		need = map[string]any{}
	}
	need["kind"] = kind
	b, _ := json.Marshal(need)
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='needs_input', need=$2, finished_at=NULL
		WHERE id=$1`, act.ID, b)
	return err
}

// agentRetryOutcome 记录可重试错误：卡片回到 pending 并保存 last_error（第 5.1 节第 2 项）。
func (s *Server) agentRetryOutcome(ctx context.Context, act *agentActionRow, code, msg string) error {
	b, _ := json.Marshal(map[string]any{"code": code, "message": msg})
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='pending', last_error=$2, finished_at=NULL
		WHERE id=$1`, act.ID, b)
	return err
}

// agentFail 记录失败（第 5.3 节第 8 项第 4 条）。
func (s *Server) agentFail(ctx context.Context, act *agentActionRow, res *agentDispatchResult) error {
	b := jsonOrEmpty(res.Raw)
	if !json.Valid(b) || agentErrorCode(b) == "" {
		b, _ = json.Marshal(agentErrorEnvelope(res.Status, res.Raw))
	}
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='failed', error=$2, finished_at=now()
		WHERE id=$1`, act.ID, b)
	return err
}

// agentFailStale 指纹不一致时把卡片改为 failed/stale（第 5.3 节第 6 项）。
func (s *Server) agentFailStale(ctx context.Context, act *agentActionRow) error {
	b, _ := json.Marshal(map[string]any{"code": "stale",
		"message": "对象在卡片提出后已被修改，请让智能体重新读取"})
	_, err := s.db.Exec(ctx, `UPDATE agent_action SET status='failed', error=$2, finished_at=now()
		WHERE id=$1`, act.ID, b)
	return err
}

// jsonOrEmpty 保证写入 jsonb 列的值始终合法。
func jsonOrEmpty(b []byte) []byte {
	if len(b) == 0 || !json.Valid(b) {
		return []byte("{}")
	}
	return b
}

// agentEmitDone 发送卡片执行流的 done 事件（第 11.4 节）：
// 批次是否全部结束、能否续跑（第 6.4 节），一次性密钥值只在本次返回。
func (s *Server) agentEmitDone(ctx context.Context, sse *sseWriter, act *agentActionRow,
	summary string, res *agentDispatchResult) error {
	view, err := s.agentActionByID(ctx, act.ID)
	if err != nil {
		return err
	}
	payload := map[string]any{
		"action": view, "result_summary": truncate(summary, 200),
		"batch_resolved": s.agentBatchResolved(ctx, act), "can_continue": s.agentCanContinue(ctx, act),
		"target": map[string]any{"type": view.Target.Type, "id": view.Target.ID,
			"account_id": act.AccountID, "work_id": nil},
	}
	if res != nil && len(res.Secrets) > 0 {
		// 第 9.5 节第 4 项：一次性值只经本次 SSE 返回，不落库、不进模型上下文。
		payload["secret_once"] = res.Secrets
	}
	sse.send("done", payload)
	return nil
}

// agentBatchResolved 判断所属批次是否全部结束（第 5.3 节第 9 项）。
func (s *Server) agentBatchResolved(ctx context.Context, act *agentActionRow) bool {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_action
		WHERE batch_id=$1 AND status IN ('pending','executing','needs_input')`, act.BatchID).Scan(&n); err != nil {
		return false
	}
	return n == 0
}

// agentCanContinue 判断能否自动续跑（第 6.4 节）：批次已结束、对话没有运行中的 run、
// 且未超过连续自动续跑上限。
func (s *Server) agentCanContinue(ctx context.Context, act *agentActionRow) bool {
	if !s.agentBatchResolved(ctx, act) {
		return false
	}
	var running, count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_run
		WHERE conversation_id=$1 AND status IN ('queued','running')`, act.ConversationID).Scan(&running); err != nil {
		return false
	}
	if running > 0 {
		return false
	}
	if err := s.db.QueryRow(ctx, `SELECT auto_continue_count FROM agent_conversation WHERE id=$1`,
		act.ConversationID).Scan(&count); err != nil {
		return false
	}
	return count < agentMaxContinuations
}

// ---------- 执行前的再校验（第 4.4 节第 6 项、第 5.3 节第 6 项） ----------

// agentAppliedTools 是 backend 接受 applied 附加字段的条目（writing_save.go）。
// 只有段落保存会把“采用 AI 改写”写进来源标记，其余条目不注入。
var agentAppliedTools = map[string]bool{"sections__update": true}

// agentPreviewReadForExecute 执行前按 Preview 规则重新读取目标（第 5.3 节第 6 项）。
func (s *Server) agentPreviewReadForExecute(ctx context.Context, act *agentActionRow) map[string]any {
	t := agentTool(act.ToolName)
	if t == nil {
		return nil
	}
	st := &agentRunState{
		SessionID: ident(ctx).SessionID, WorkspaceID: act.WorkspaceID,
		ConversationID: act.ConversationID, RunID: act.RunID,
	}
	return s.agentPreviewRead(ctx, st, t, act.Params)
}

// agentInjectApplied 命中 G 来源时为段落写入附加 applied（第 4.4 节第 6 项），
// 使段落来源标记与编辑器中“采用 AI 改写”一致。用户在卡片上改过的字段视为 U，不注入。
func (s *Server) agentInjectApplied(ctx context.Context, act *agentActionRow, t *AgentTool, final map[string]any) {
	if !agentAppliedTools[t.Name] {
		return
	}
	id := ident(ctx)
	st := &agentRunState{
		SessionID: id.SessionID, WorkspaceID: act.WorkspaceID,
		ConversationID: act.ConversationID, RunID: act.RunID,
	}
	_, _, hits, err := s.agentProvenanceBlanked(ctx, st, t, act.Params)
	if err != nil || len(hits) == 0 {
		return
	}
	for _, field := range []string{"content_md", "heading"} {
		hit, ok := hits[field]
		if !ok || hit.Kind != agentSrcG || hit.AICallID == uuid.Nil {
			continue
		}
		final["applied"] = map[string]any{"kind": "rewrite", "ai_call_id": hit.AICallID.String()}
		return
	}
}

// ---------- 拒绝一张卡片（第 5.9 节第 1 项） ----------

// postAgentActionReject 拒绝一张未结束的卡片，可附原因（≤ 200 字）。
func (s *Server) postAgentActionReject(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	act, err := s.agentLoadAction(ctx, id)
	if err != nil {
		return err
	}
	var req struct {
		Reason string `json:"reason"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	reason := strings.TrimSpace(req.Reason)
	if runeLen(reason) > 200 {
		return validation("原因最长 200 字")
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE agent_action
			SET status='rejected', reject_reason=$2, decided_by=$3, finished_at=now()
			WHERE id=$1 AND status IN ('pending','needs_input')`, id, reason, ident(ctx).UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apiErr(409, "agent_action_state_invalid", "这张卡片已经处理过了")
		}
		return nil
	})
	if err != nil {
		return err
	}
	// 第 5.9 节第 4 项：拒绝也写一条 action_result，供续跑时告知模型。
	return s.agentWriteActionResults(ctx, act.ConversationID, []map[string]any{{
		"id": act.ID, "tool_name": act.ToolName, "status": "rejected",
		"target":        map[string]any{"type": act.Preview.TargetName},
		"reject_reason": reason,
	}})
}
