package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-CU P4-2（docs/36 §5 / §4.10，D-188）：电脑控制命令账本的 Go 侧数据结构。
// 结构对齐 agent_browser_commands.go 先例（browserCommandView / 列清单 / 扫描函数 /
// 常量总表）；差异点按 §4.10 契约：card_id / approval_hash / disposition /
// requires_confirmation / generation（审批版本 CAS），state 无 browser 的 rejected。
// 本包只定义视图与常量；命令创建 / CAS 领取 / 回执 / sweep 属 P4-4~P4-6，不在本文件。

// computerCommandView：命令账本行视图（§4.10 列 → JSON 字段，命名照 browser 先例）。
type computerCommandView struct {
	ID        string `json:"id"`
	GrantID   string `json:"grant_id"`
	RunID     string `json:"run_id,omitempty"`
	RequestID string `json:"request_id"`
	// D-117：写类动作绑定确认卡片；card_id / approval_hash 仅写类非空。
	CardID       string `json:"card_id,omitempty"`
	ApprovalHash string `json:"approval_hash,omitempty"`
	ActionKind   string `json:"action_kind"`
	TargetRef    string `json:"target_ref,omitempty"`
	InputHash    string `json:"input_hash"`
	State        string `json:"state"`
	// payload 只在桌面领取 / 领取派发响应中出现（执行必需）；
	// result 只在终态回执后出现（模型同步等待读取）。均 nil 时不出现在 JSON。
	Payload              json.RawMessage `json:"payload,omitempty"`
	Result               json.RawMessage `json:"result,omitempty"`
	Claimed              bool            `json:"claimed,omitempty"`
	Disposition          json.RawMessage `json:"disposition,omitempty"`
	RequiresConfirmation bool            `json:"requires_confirmation"`
	Generation           int64           `json:"generation"`
	DeadlineAt           string          `json:"deadline_at,omitempty"`
	DispatchedAt         string          `json:"dispatched_at,omitempty"`
	ErrorCode            string          `json:"error_code,omitempty"`
	CreatedAt            string          `json:"created_at"`
}

// computerCommandActions：§4.10 的 6 个固定语义（request_handoff 不建命令，
// 直接走租约撤销，不触达 worker）。
var computerCommandActions = map[string]bool{
	"observe": true, "focus": true, "scroll": true,
	"select": true, "invoke": true, "type": true,
}

// 列清单与 scanComputerCommand 必须一一对应；时间沿用 browser 先例的 UTC to_char。
// payload / result / disposition 不在列清单：browser 先例同款——领取（payload）与
// 终态回执（result/disposition）各自单独查询下发，默认视图不夹带（A30b 拍板语义）。
const computerCommandColumns = `c.id::text, c.grant_id::text, COALESCE(c.run_id::text,''), c.request_id::text,
	COALESCE(c.card_id::text,''), COALESCE(c.approval_hash,''), c.action_kind, COALESCE(c.target_ref,''),
	c.input_hash, c.state, c.requires_confirmation, c.generation,
	COALESCE(to_char(c.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
	COALESCE(to_char(c.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
	COALESCE(c.error_code,''), to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func scanComputerCommand(row pgx.Row) (computerCommandView, error) {
	var v computerCommandView
	err := row.Scan(&v.ID, &v.GrantID, &v.RunID, &v.RequestID,
		&v.CardID, &v.ApprovalHash, &v.ActionKind, &v.TargetRef,
		&v.InputHash, &v.State, &v.RequiresConfirmation, &v.Generation,
		&v.DeadlineAt, &v.DispatchedAt, &v.ErrorCode, &v.CreatedAt)
	return v, err
}

// scanComputerCommandTargets 返回与 computerCommandColumns 一一对应的 Scan 目标
// （不含 payload/result/disposition 三个 jsonb——调用方按需追加以免覆盖）。
func scanComputerCommandTargets(v *computerCommandView) []any {
	return []any{&v.ID, &v.GrantID, &v.RunID, &v.RequestID,
		&v.CardID, &v.ApprovalHash, &v.ActionKind, &v.TargetRef,
		&v.InputHash, &v.State,
		&v.RequiresConfirmation, &v.Generation,
		&v.DeadlineAt, &v.DispatchedAt, &v.ErrorCode, &v.CreatedAt}
}

// §4.10 常量总表（全部集中，便于复算；browser 先例同款）：
// 单命令 deadline 30s、sweep 宽限 2s、同步等待预算 35s、等待轮询 200ms。
const (
	computerCommandDeadline   = 30 * time.Second
	computerCommandSweepGrace = 2 * time.Second
	computerCommandWaitBudget = 35 * time.Second
	computerCommandWaitPoll   = 200 * time.Millisecond
)

// computerInputHash：sha256(action_kind + "." + canonicalJSON(payload))，
// 与 browser 的 input_hash 同构（同请求异载荷 409 的依据）。
// payload 先经 canonicalJSON 归一键序/数字形态（browser 先例在 json.Marshal 前同样
// 依赖 map 序列化稳定性；这里显式归一，跨请求同语义不同键序产出同 hash）。
func computerInputHash(action string, payload []byte) string {
	sum := sha256.Sum256(append([]byte(action+"."), payload...))
	return fmt.Sprintf("%x", sum)
}

// ---- P4-3：动作参数校验（§P4-3 步骤 1~3）----
// 服务端不解析语义、不拼 PS：只把「越界字符串」挡在账本之外。

// computerRefRe 与 worker 侧 refs.js 同口径：@<snapshot_id>:e<N>，
// snapshot_id 为 3..64 位 [A-Za-z0-9_-]，序号为不以 0 开头的 1..10 位正整数
// （worker 侧 resolveRefTarget 要求 index ≥ 1，此处正则同步排除 e0 / e01）。
var computerRefRe = regexp.MustCompile(`^@[A-Za-z0-9_-]{3,64}:e[1-9][0-9]{0,9}$`)

// computerTextRe：允许换行与常规可见字符；拒绝其余 C0/C1 控制符（\t\n\r 除外）。
// 不做脚本检测——payload 永不被拼进 PowerShell（§P4-3 步骤 3 的明确边界）。
var computerTextRe = regexp.MustCompile(`^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]*$`)

// computerActionPayloadKeys：每个 kind 的 payload 白名单键（§P4-3 步骤 1）。
// 六语义都以 ref 为目标；type 额外允许 text。动作的语义参数（如 scroll 的方向）
// 由 worker 侧 normalizeArgs 兜底，账本只锁「模型不能塞任意键」这条红线。
var computerActionPayloadKeys = map[string]map[string]bool{
	"observe": {"ref": true},
	"focus":   {"ref": true},
	"scroll":  {"ref": true},
	"select":  {"ref": true},
	"invoke":  {"ref": true},
	"type":    {"ref": true, "text": true},
}

// validateComputerAction 校验动作枚举与 payload 白名单键；违规 → 422 computer_invalid_args。
func validateComputerAction(kind string, payload map[string]any) error {
	if !computerCommandActions[kind] {
		return apiErr(422, "computer_invalid_args", "动作不在固定枚举内："+kind)
	}
	allowed := computerActionPayloadKeys[kind]
	for key := range payload {
		if !allowed[key] {
			return apiErr(422, "computer_invalid_args", "payload 含不允许的键："+key)
		}
	}
	if ref, _ := payload["ref"].(string); ref != "" {
		if !computerRefRe.MatchString(ref) {
			return apiErr(422, "computer_invalid_args", "ref 必须形如 @<snapshot_id>:e<N>")
		}
	}
	if text, _ := payload["text"].(string); text != "" {
		if len(text) > 32768 {
			return apiErr(422, "computer_invalid_args", "text 超过 32768 上限")
		}
		if !computerTextRe.MatchString(text) {
			return apiErr(422, "computer_invalid_args", "text 含不允许的控制字符")
		}
	}
	return nil
}

// createComputerCommand 是显式信封入口（POST /agent/computer/commands，桌面/渲染器直调）。
// P4-3 只做入参校验；P4-4 补齐创建语义：computerGuard → 特性开关 → UUID/枚举校验
// → 确认闸门 → 预算检查 → 事务内（租约 CAS + 硬禁区 + 幂等）→ queued INSERT → 事件。
func (s *Server) createComputerCommand(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	var body struct {
		GrantID            string         `json:"grant_id"`
		RunID              string         `json:"run_id"`
		RequestID          string         `json:"request_id"`
		ExpectedGeneration int64          `json:"expected_generation"`
		Action             string         `json:"action"`
		Payload            map[string]any `json:"payload"`
		CardID             string         `json:"card_id"`
		ApprovalHash       string         `json:"approval_hash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	grantID, err := uuid.Parse(body.GrantID)
	if err != nil {
		return apiErr(400, "bad_request", "grant_id 必须是 UUID")
	}
	runID := uuid.Nil
	if body.RunID != "" {
		if runID, err = uuid.Parse(body.RunID); err != nil {
			return apiErr(400, "bad_request", "run_id 必须是 UUID")
		}
	}
	requestID, err := uuid.Parse(body.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	if err := validateComputerAction(body.Action, body.Payload); err != nil {
		return err
	}

	// P4-4 步骤 3：确认闸门。写类（invoke/type）必须带 card_id + approval_hash，
	// 且卡片处于「已由本人确认」状态；缺失/未确认 → 409 computer_approval_conflict。
	// 不提供任何绕过参数（§6 红线 2：写类必带卡片确认）。
	requiresConfirmation := body.Action == "invoke" || body.Action == "type"
	var cardID uuid.UUID
	if requiresConfirmation {
		if body.CardID == "" || body.ApprovalHash == "" {
			return apiErr(409, "computer_approval_conflict", "写类动作必须带 card_id 与 approval_hash（D-117 逐张确认）")
		}
		if cardID, err = uuid.Parse(body.CardID); err != nil {
			return apiErr(400, "bad_request", "card_id 必须是 UUID")
		}
		if !s.computerCardConfirmed(r.Context(), id.UserID, cardID, grantID, body.ExpectedGeneration, body.Action, payloadJSONForHash(body.Payload), body.ApprovalHash) {
			return apiErr(409, "computer_approval_conflict", "卡片不存在、未确认或批准内容不符")
		}
	}

	// P4-4 步骤 5：预算检查（60 动作 / 10 分钟，run 维度；docs/27:1081 的共享总池口径
	// 由 run 内既有工具次数上限承担，这里只锁 computer 命令自身的窗口计数）。
	var recent int
	if err := s.db.QueryRow(r.Context(), `
		SELECT count(*) FROM agent_computer_command
		WHERE run_id=$1 AND created_at > now() - interval '10 minutes'`,
		runID).Scan(&recent); err != nil {
		return err
	}
	if recent >= computerCommandBudgetPerWindow {
		return apiErr(429, "computer_budget_exceeded", "10 分钟窗口内命令数已达上限（60）")
	}

	payloadJSON, _ := json.Marshal(body.Payload)
	inputHash := computerInputHash(body.Action, payloadJSON)
	deadline := s.now().Add(computerCommandDeadline)
	commandID := uuid.New()
	var conversationID uuid.UUID

	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 租约 CAS：active + 未过期 + generation 与调用方期望一致（P1-4 的审批版本）。
		var targetSummary string
		err := tx.QueryRow(r.Context(), `
			SELECT g.conversation_id, g.target_summary
			FROM agent_computer_grant g
			WHERE g.id=$1 AND g.workspace_id=$2 AND g.user_id=$3
			  AND g.state='active' AND g.expires_at > now() AND g.generation=$4`,
			grantID, id.WorkspaceID, id.UserID, body.ExpectedGeneration).
			Scan(&conversationID, &targetSummary)
		if err == pgx.ErrNoRows {
			return apiErr(409, "computer_stale_ref", "租约不存在、已过期、已撤销或 generation 不匹配")
		}
		if err != nil {
			return err
		}
		if computerIsHardForbidden(targetSummary) {
			return apiErr(403, "computer_policy_denied", "目标命中硬禁区，永远拒绝")
		}
		// 幂等：同 (grant, request) 同 hash 返回原命令；异 hash 409。
		var existingID uuid.UUID
		var existingHash string
		err = tx.QueryRow(r.Context(), `
			SELECT id, input_hash FROM agent_computer_command WHERE grant_id=$1 AND request_id=$2`,
			grantID, requestID).Scan(&existingID, &existingHash)
		switch {
		case err == nil:
			if existingHash != inputHash {
				return apiErr(409, "computer_approval_conflict", "同编号命令载荷不同")
			}
			commandID = existingID
			return nil
		case err == pgx.ErrNoRows:
			_, err = tx.Exec(r.Context(), `
				INSERT INTO agent_computer_command
				(id, grant_id, workspace_id, user_id, conversation_id, run_id, request_id, card_id, approval_hash,
				 action_kind, target_ref, payload, input_hash, state, requires_confirmation, generation, deadline_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued',$14,$15,$16)`,
				commandID, grantID, id.WorkspaceID, id.UserID, conversationID,
				nullUUID(runID), requestID, nullUUID(cardID), emptyAsNull(body.ApprovalHash),
				body.Action, payloadRef(body.Payload), payloadJSON, inputHash,
				requiresConfirmation, body.ExpectedGeneration, deadline)
			return err
		default:
			return err
		}
	}); err != nil {
		return err
	}

	// 确认凭证已消费：卡片 pending → executing，同一张卡不能再发起第二条命令。
	if requiresConfirmation && cardID != uuid.Nil {
		_, _ = s.agentMutateActions(r.Context(), conversationID, `UPDATE agent_action
			SET status='executing', executed_at=now(), revision=revision+1
			WHERE id=$1 AND status='pending'`, cardID)
	}

	// 步骤 7：best-effort 事件（失败只 Warn，不回滚命令状态）。
	s.emitComputerCommandEvent(r.Context(), conversationID, "computer.command_requested", map[string]any{
		"command_id":  commandID.String(),
		"action_kind": body.Action,
		"state":       "queued",
		"grant_id":    grantID.String(),
		"generation":  body.ExpectedGeneration,
	})
	return s.renderComputerCommand(r.Context(), w, commandID)
}

// runComputerCommand 是 run 内模型调用入口（POST /tools/computer/commands，§4.11）。
// 与 createComputerCommand 并存：模型参数平铺（ref/text），action 由工具目录 Fixed 注入；
// grant/run 全部服务端自查——模型不持租约句柄、不可指定归属。
// 步骤：principal 校验 → 特性开关 → 枚举/白名单键 → 查当前 run 的活动租约（无 → 409 先选窗）
// → **写类只提交预览（不建命令，命令表零新增）** → 读类自生成 request_id/deadline INSERT queued
// → emit → waitForComputerCommand 同步等待。
func (s *Server) runComputerCommand(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	principal := agentPrincipalOf(r.Context())
	if principal == nil || principal.RunID == uuid.Nil || principal.ConversationID == uuid.Nil {
		return apiErr(422, "computer_invalid_args", "该接口只能由会话任务内的工具调用发起")
	}
	var body struct {
		Action  string         `json:"action"`
		Payload map[string]any `json:"payload"`
		// 工具目录的电脑动作把语义参数平铺在 body（pBody("ref")/pBody("text")），
		// 不是嵌套 payload；这里归一成 payload，避免模型链路传空载荷。
		Ref  string `json:"ref"`
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.Payload == nil {
		body.Payload = map[string]any{}
	}
	if body.Ref != "" {
		body.Payload["ref"] = body.Ref
	}
	if body.Text != "" {
		body.Payload["text"] = body.Text
	}
	if err := validateComputerAction(body.Action, body.Payload); err != nil {
		return err
	}
	// 步骤 1：当前 run 的活动租约（含 scope=act 与否不限——观察类只需 observe scope）。
	var grantID uuid.UUID
	var generation int64
	var targetSummary string
	err := s.db.QueryRow(r.Context(), `
		SELECT id, generation, target_summary FROM agent_computer_grant
		WHERE conversation_id=$1 AND workspace_id=$2 AND user_id=$3 AND run_id=$4
		  AND state='active' AND (expires_at IS NULL OR expires_at > now())
		ORDER BY created_at DESC LIMIT 1`,
		principal.ConversationID, id.WorkspaceID, id.UserID, principal.RunID).
		Scan(&grantID, &generation, &targetSummary)
	if err == pgx.ErrNoRows {
		return apiErr(409, "computer_foreground_busy", "当前任务没有活动的前台租约；请先调用 computer_request_target 请用户选择窗口")
	}
	if err != nil {
		return err
	}
	if computerIsHardForbidden(targetSummary) {
		return apiErr(403, "computer_policy_denied", "目标命中硬禁区，永远拒绝")
	}
	// 步骤 2：写类只提交预览——不建命令（命令表零新增），但必须在 D-117 卡片表
	// 落一张待确认卡片：否则渲染器没有 card_id/approval_hash，确认闸门永远过不去。
	if body.Action == "invoke" || body.Action == "type" {
		payloadJSON, _ := json.Marshal(body.Payload)
		cardID, approvalHash, preview, err := s.createComputerCard(r.Context(),
			principal.ConversationID, principal.RunID, id.WorkspaceID, id.UserID,
			grantID, generation, body.Action, body.Payload, targetSummary)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{
			"state":                 "awaiting_confirmation",
			"action_kind":           body.Action,
			"grant_id":              grantID.String(),
			"generation":            generation,
			"payload":               json.RawMessage(payloadJSON),
			"requires_confirmation": true,
			"card_id":               cardID.String(),
			"approval_hash":         approvalHash,
			"preview":               preview,
			"target_summary":        targetSummary,
			"note":                  "写类动作需要用户逐张确认卡片后执行（D-117）",
		})
	}
	// 步骤 3：读类登记 queued 并同步等待。
	payloadJSON, _ := json.Marshal(body.Payload)
	inputHash := computerInputHash(body.Action, payloadJSON)
	deadline := s.now().Add(computerCommandDeadline)
	requestID := uuid.New()
	commandID := uuid.New()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO agent_computer_command
		(id, grant_id, workspace_id, user_id, conversation_id, run_id, request_id,
		 action_kind, target_ref, payload, input_hash, state, requires_confirmation, generation, deadline_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',false,$12,$13)`,
		commandID, grantID, id.WorkspaceID, id.UserID, principal.ConversationID, principal.RunID, requestID,
		body.Action, payloadRef(body.Payload), payloadJSON, inputHash, generation, deadline); err != nil {
		return err
	}
	s.emitComputerCommandEvent(r.Context(), principal.ConversationID, "computer.command_requested", map[string]any{
		"command_id":  commandID.String(),
		"action_kind": body.Action,
		"state":       "queued",
		"grant_id":    grantID.String(),
		"generation":  generation,
	})
	return s.waitForComputerCommand(r, w, commandID)
}

// waitForComputerCommand：200ms 轮询等待终态（§P4-7 步骤 4~6）。
// 超命令 deadline+2s：queued → 直接 unknown_outcome+computer_wait_timeout；dispatched → 触发一次 sweep。
// 35s 预算耗尽 → 如实返回非终态视图，不假装成功；ctx 取消 → 499 computer_wait_cancelled。
func (s *Server) waitForComputerCommand(r *http.Request, w http.ResponseWriter, commandID uuid.UUID) error {
	deadline := s.now().Add(computerCommandWaitBudget)
	for {
		if r.Context().Err() != nil {
			// run 取消/断开：命令留在账本（queued/dispatched），sweep 兜底转 unknown_outcome。
			return apiErr(499, "computer_wait_cancelled", "任务已取消，停止等待命令回执")
		}
		var state string
		var result json.RawMessage
		var errorCode string
		var cmdDeadline time.Time
		err := s.db.QueryRow(r.Context(), `
			SELECT state, COALESCE(result, 'null'::jsonb), COALESCE(error_code,''), COALESCE(deadline_at, now())
			FROM agent_computer_command WHERE id=$1`, commandID).
			Scan(&state, &result, &errorCode, &cmdDeadline)
		if err != nil {
			return err
		}
		if state == "succeeded" || state == "failed" || state == "unknown_outcome" {
			v, err := scanComputerCommand(s.db.QueryRow(r.Context(),
				"SELECT "+computerCommandColumns+" FROM agent_computer_command c WHERE c.id=$1", commandID))
			if err != nil {
				return err
			}
			if len(result) > 0 && string(result) != "null" {
				v.Result = result
			}
			return ok(w, v)
		}
		// 超命令 deadline + sweep 容差（§P4-7 步骤 5）。
		if s.now().After(cmdDeadline.Add(computerCommandSweepGrace)) {
			if state == "queued" {
				if _, err := s.db.Exec(r.Context(), `
					UPDATE agent_computer_command SET state='unknown_outcome', error_code='computer_wait_timeout'
					WHERE id=$1 AND state='queued'`, commandID); err != nil {
					return err
				}
				continue
			}
			s.sweepComputerCommands(r.Context())
		}
		if s.now().After(deadline) {
			// 35s 预算耗尽：如实返回当前非终态（queued=无人领取；dispatched=执行未回执）。
			v, err := scanComputerCommand(s.db.QueryRow(r.Context(),
				"SELECT "+computerCommandColumns+" FROM agent_computer_command c WHERE c.id=$1", commandID))
			if err != nil {
				return err
			}
			return ok(w, v)
		}
		select {
		case <-r.Context().Done():
			return apiErr(499, "computer_wait_cancelled", "任务已取消，停止等待命令回执")
		case <-time.After(computerCommandWaitPoll):
		}
	}
}

// computerCommandBudgetPerWindow：§4.10 预算（60 动作 / 10 分钟，docs/27:1081）。
const computerCommandBudgetPerWindow = 60

// computerCardConfirmed 校验卡片存在、属于本人、且仍待确认、批准内容 hash 一致。
// 卡片由 runComputerCommand 的写类预览创建（tool_name=computer_command），
// 用户点「执行」后由 createComputerCommand 原子转 executing，二次执行会因状态不符被拒。
func (s *Server) computerCardConfirmed(ctx context.Context, userID uuid.UUID, cardID uuid.UUID,
	grantID uuid.UUID, generation int64, action string, payload []byte, approvalHash string) bool {
	var fingerprint string
	var params []byte
	err := s.db.QueryRow(ctx, `
		SELECT fingerprint, params FROM agent_action
		WHERE id=$1 AND user_id=$2 AND tool_name='computer_command'
		  AND status='pending' AND expires_at > now()`,
		cardID, userID).Scan(&fingerprint, &params)
	if err != nil {
		return false
	}
	// 客户端提交的 hash、卡片指纹、按本次动作/载荷/generation 重算的 hash 三者必须一致；
	// 否则「批了 A、执行 B」能绕过确认（§6 红线 2）。
	if fingerprint != approvalHash || computerApprovalHash(action, payload, generation) != fingerprint {
		return false
	}
	var exec computerCardExecution
	if err := json.Unmarshal(params, &exec); err != nil {
		return false
	}
	return exec.GrantID == grantID.String() && exec.Generation == generation
}

// payloadJSONForHash 与建卡时的 json.Marshal(payload) 同路径，保证 hash 可复算。
func payloadJSONForHash(payload map[string]any) []byte {
	b, _ := json.Marshal(payload)
	return b
}

// computerApprovalHash 绑定「动作 + 载荷 + 审批版本」，卡片确认后换载荷或 generation 都会失配。
func computerApprovalHash(action string, payload []byte, generation int64) string {
	base := computerInputHash(action, payload)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s.%d", base, generation)))
	return fmt.Sprintf("%x", sum)
}

// computerPreviewText 截断内容预览：rune 级截断，避免中文被切坏。
func computerPreviewText(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// createComputerCard 为写类预览落一张 D-117 卡片（agent_action，kind=W）：
// params 存执行凭据（grant/generation/payload/hash），preview 存既有卡片视图字段。
// 同一目标的旧待确认卡片先过期，满足唯一开放卡片索引。
func (s *Server) createComputerCard(ctx context.Context, convID, runID, wsID, userID uuid.UUID,
	grantID uuid.UUID, generation int64, action string, payload map[string]any, targetSummary string,
) (uuid.UUID, string, map[string]any, error) {
	payloadJSON, _ := json.Marshal(payload)
	approvalHash := computerApprovalHash(action, payloadJSON, generation)
	targetRef := payloadRef(payload)
	if targetRef == "" {
		targetRef = grantID.String()
	}
	exec := computerCardExecution{
		GrantID: grantID.String(), Generation: generation, ActionKind: action,
		Payload: payload, TargetRef: targetRef, TargetSummary: targetSummary, ApprovalHash: approvalHash,
	}
	paramsJSON, _ := json.Marshal(exec)
	content := ""
	if v, ok := payload["text"].(string); ok {
		content = v
	} else if v, ok := payload["value"].(string); ok {
		content = v
	}
	preview := map[string]any{
		"title":       "电脑操作确认",
		"target_name": computerPreviewText(targetSummary, 80),
		"changes": []map[string]any{
			{"field": "target", "label": "目标元素", "before": "", "after": computerPreviewText(targetSummary, 80), "editable": false, "blank": false},
			{"field": "ref", "label": "元素引用", "before": "", "after": targetRef, "editable": false, "blank": false},
			{"field": "action", "label": "动作", "before": "", "after": action, "editable": false, "blank": false},
			{"field": "content", "label": "内容预览", "before": "", "after": computerPreviewText(content, 60), "editable": false, "blank": false},
			{"field": "approval", "label": "审批指纹", "before": "", "after": approvalHash[:12], "editable": false, "blank": false},
		},
		"notices": []string{"执行后可能改变目标应用内容；出现未知结果请人工核对，不要重复操作"},
		"ai_cost": false,
	}
	previewJSON, _ := json.Marshal(preview)

	// 唯一开放卡片按「目标 + 批准内容指纹」隔离：同目标不同载荷各自成卡，
	// 同目标同载荷的旧待确认卡先过期。
	targetKey := targetRef + "#" + approvalHash[:12]
	_, _ = s.agentMutateActions(ctx, convID, `UPDATE agent_action SET status='expired', revision=revision+1
		WHERE user_id=$1 AND tool_name='computer_command' AND target_key=$2
		  AND status IN ('pending','needs_input')`, userID, targetKey)

	var cardID uuid.UUID
	if err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			INSERT INTO agent_action
				(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind,
				 target_type, target_id, target_key, status, params, preview, fingerprint, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,'computer_command','W','computer',$7,$8,'pending',
				$9::jsonb,$10::jsonb,$11, now() + interval '10 minutes')
			RETURNING id`,
			convID, runID, uuid.New(), wsID, userID, "computer:"+uuid.NewString(),
			grantID.String(), targetKey, paramsJSON, previewJSON, approvalHash).Scan(&cardID); err != nil {
			return err
		}
		// 与其他动作卡同一条事件链，渲染器不必等整会话刷新。
		return appendAgentActionEventTx(ctx, tx, cardID, false)
	}); err != nil {
		return uuid.Nil, "", nil, err
	}
	return cardID, approvalHash, preview, nil
}

// updateComputerCardFromCommand 把命令终态回写到卡片；unknown_outcome 归 failed，
// 由 disposition/error_code 区分「可能已生效」，卡片不再可执行。
func (s *Server) updateComputerCardFromCommand(ctx context.Context, convID, commandID uuid.UUID, state string) {
	status := "failed"
	if state == "succeeded" {
		status = "succeeded"
	}
	updated, err := s.agentMutateActions(ctx, convID, `UPDATE agent_action
		SET status=$2, finished_at=now(), revision=revision+1
		WHERE id=(SELECT c.card_id FROM agent_computer_command c WHERE c.id=$1)
		  AND tool_name='computer_command' AND status IN ('pending','executing')`, commandID, status)
	if err != nil {
		s.observeFailure(ctx, slog.LevelWarn, "电脑命令回写卡片失败", observeFields{
			ErrorCode: "computer_card_update_failed", Route: "internal/agent/computer_command",
			Extras: map[string]any{"command_id": commandID.String(), "conversation_id": convID.String(), "err": err.Error()},
		})
		return
	}
	if len(updated) == 0 {
		slog.Debug("电脑命令终态无需回写卡片", "command_id", commandID.String(), "state", state)
	}
}

// nullUUID 把 Nil UUID 写成 SQL NULL（run_id / card_id 可空）。
func nullUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}

// emptyAsNull 把空串写成 SQL NULL（approval_hash 可空）。
func emptyAsNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// payloadRef 从 payload 里取 target_ref（服务端只存不解析）。
func payloadRef(payload map[string]any) string {
	ref, _ := payload["ref"].(string)
	if len(ref) > 64 {
		return ref[:64]
	}
	return ref
}

// emitComputerCommandEvent：computer 命令时间线事件 best-effort（对齐 browser 先例）。
func (s *Server) emitComputerCommandEvent(ctx context.Context, conversationID uuid.UUID, eventType string, payload map[string]any) {
	if conversationID == uuid.Nil {
		return
	}
	if _, err := s.appendAgentEvent(ctx, conversationID, nil, eventType, payload); err != nil {
		s.observeFailure(ctx, slog.LevelWarn, "电脑命令事件写入失败", observeFields{
			ErrorCode: "computer_command_event_failed", Route: "internal/agent/computer_command",
			Extras: map[string]any{"event_type": eventType, "conversation_id": conversationID.String(), "err": err.Error()},
		})
	}
}

// renderComputerCommand 输出命令视图（不夹带 payload/result——领取/终态才出现）。
func (s *Server) renderComputerCommand(ctx context.Context, w http.ResponseWriter, commandID uuid.UUID) error {
	v, err := scanComputerCommand(s.db.QueryRow(ctx,
		"SELECT "+computerCommandColumns+" FROM agent_computer_command c WHERE c.id=$1", commandID))
	if err != nil {
		return err
	}
	return ok(w, v)
}

// ownComputerCommand 校验本人归属并返回 (commandID, conversationID)。
// 跨租户 / 不存在一律 404，不透露资源存在（对齐 browser 先例）。
func (s *Server) ownComputerCommand(r *http.Request) (uuid.UUID, uuid.UUID, error) {
	id := ident(r.Context())
	commandID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return uuid.Nil, uuid.Nil, errNotFound
	}
	var conversationID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `
		SELECT g.conversation_id FROM agent_computer_command c JOIN agent_computer_grant g ON g.id=c.grant_id
		WHERE c.id=$1 AND g.workspace_id=$2 AND g.user_id=$3`,
		commandID, id.WorkspaceID, id.UserID).Scan(&conversationID); err != nil {
		if err == pgx.ErrNoRows {
			return uuid.Nil, uuid.Nil, errNotFound
		}
		return uuid.Nil, uuid.Nil, err
	}
	return commandID, conversationID, nil
}

// POST /agent/computer/commands/{id}/dispatch：queued→dispatched（桌面执行器原子领取；幂等）。
// CAS 命中（claimed=true）时随响应下发 payload；claimed=false 如实回当前状态，
// 不下发 payload、不重复执行。派发前复核租约仍 active 且 generation 未变，
// 否则命令转 cancelled 并 409（审批版本已失效，不投递）。
func (s *Server) dispatchComputerCommand(w http.ResponseWriter, r *http.Request) error {
	commandID, conversationID, err := s.ownComputerCommand(r)
	if err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	var claimed bool
	var grantGeneration int64
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 派发前复核租约：撤销 / 过期 / generation 变化 → 命令转 cancelled + 409。
		var grantState string
		err := tx.QueryRow(r.Context(), `
			SELECT g.state, g.generation, c.generation FROM agent_computer_grant g
			JOIN agent_computer_command c ON c.grant_id=g.id
			WHERE g.id=c.grant_id AND c.id=$1
			  AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at > now())
			  AND g.generation=c.generation`,
			commandID).Scan(&grantState, &grantGeneration, &grantGeneration)
		if err == pgx.ErrNoRows {
			// 租约失效或 generation 变化：命令转 cancelled（幂等，已是终态则跳过）。
			if _, err := tx.Exec(r.Context(), `
				UPDATE agent_computer_command SET state='cancelled'
				WHERE id=$1 AND state IN ('queued','dispatched')`, commandID); err != nil {
				return err
			}
			return apiErr(409, "computer_approval_conflict", "租约已撤销或审批版本已变化，命令取消")
		}
		if err != nil {
			return err
		}
		// CAS 领取：只有 queued 能转 dispatched（并发领取只有一次 RowsAffected>0）。
		tag, err := tx.Exec(r.Context(), `
			UPDATE agent_computer_command SET state='dispatched', dispatched_at=now()
			WHERE id=$1 AND state='queued' AND generation=$2`,
			commandID, grantGeneration)
		if err != nil {
			return err
		}
		claimed = tag.RowsAffected() > 0
		return nil
	}); err != nil {
		return err
	}
	v, err := scanComputerCommand(s.db.QueryRow(r.Context(),
		"SELECT "+computerCommandColumns+" FROM agent_computer_command c WHERE c.id=$1", commandID))
	if err != nil {
		return err
	}
	if claimed {
		// payload 只在 CAS 命中时下发（A30b 同款）。
		var payload json.RawMessage
		if err := s.db.QueryRow(r.Context(), `SELECT COALESCE(payload, 'null'::jsonb) FROM agent_computer_command WHERE id=$1`, commandID).Scan(&payload); err != nil {
			return err
		}
		v.Payload = payload
		v.Claimed = true
		_ = grantGeneration
		s.emitComputerCommandEvent(r.Context(), conversationID, "computer.command_started", map[string]any{
			"command_id": commandID.String(),
		})
	}
	return ok(w, v)
}

// GET /agent/computer/commands/pending：桌面执行器领取清单。
// 本人工作区内 queued 且未过期的命令（含 payload），每轮限量 10，先到先执行；
// 并发领取由 dispatch 的 CAS 兜底，重复执行不可能发生。
func (s *Server) pendingComputerCommands(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT `+computerCommandColumns+`, COALESCE(c.payload, 'null'::jsonb)
		FROM agent_computer_command c JOIN agent_computer_grant g ON g.id=c.grant_id
		WHERE g.workspace_id=$1 AND g.user_id=$2 AND c.state='queued'
		  AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at > now())
		  AND g.generation=c.generation
		  AND (c.deadline_at IS NULL OR c.deadline_at > now())
		ORDER BY c.created_at ASC LIMIT 10`, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	commands := []computerCommandView{}
	for rows.Next() {
		var v computerCommandView
		var payload []byte
		if err := rows.Scan(&v.ID, &v.GrantID, &v.RunID, &v.RequestID,
			&v.CardID, &v.ApprovalHash, &v.ActionKind, &v.TargetRef,
			&v.InputHash, &v.State, &v.RequiresConfirmation, &v.Generation,
			&v.DeadlineAt, &v.DispatchedAt, &v.ErrorCode, &v.CreatedAt, &payload); err != nil {
			return err
		}
		if len(payload) > 0 {
			v.Payload = json.RawMessage(payload)
		}
		commands = append(commands, v)
	}
	return ok(w, map[string]any{"commands": commands})
}

// ---------------------------------------------------------------------------
// DEV-CU P4-6：回执、冲突与超时扫描（§4.3 终态收敛；对齐 browser receipt 先例）。
// 红线：unknown_outcome 与 delivery_uncertain 不自动重试、不重放、不复活输入（C06/C08）。
// ---------------------------------------------------------------------------

// receiptComputerCommand（POST /agent/computer/commands/{id}/receipt）：
// 状态白名单 → disposition 双字段一致性 → 迟到回执只核对 → 终态幂等/冲突 → 写终态 + 事件。
func (s *Server) receiptComputerCommand(w http.ResponseWriter, r *http.Request) error {
	commandID, conversationID, err := s.ownComputerCommand(r)
	if err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	var body struct {
		State       string          `json:"state"`
		ErrorCode   string          `json:"error_code"`
		ReceiptHash string          `json:"receipt_hash"`
		Result      json.RawMessage `json:"result"`
		Disposition json.RawMessage `json:"disposition"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	// 步骤 1：状态白名单。
	if body.State != "succeeded" && body.State != "failed" && body.State != "unknown_outcome" {
		return apiErr(422, "computer_invalid_args", "回执状态只能是 succeeded/failed/unknown_outcome")
	}
	// 步骤 2：disposition 双字段一致性（§4.3：delivery 与 retry 必须成对且匹配表）。
	if len(body.Disposition) > 0 {
		var disp struct {
			Delivery string `json:"delivery"`
			Retry    string `json:"retry"`
		}
		if err := json.Unmarshal(body.Disposition, &disp); err != nil {
			return apiErr(422, "computer_invalid_args", "disposition 无法解析")
		}
		expectedRetry := map[string]string{
			"not_delivered": "safe", "delivery_uncertain": "unsafe", "delivered_unverified": "unsafe",
			"delivered_verified": "unsafe", "unknown": "unknown",
		}[disp.Delivery]
		if expectedRetry == "" || disp.Retry != expectedRetry {
			// 不一致 → computer_internal，不写库（§P4-6 步骤 2）。
			return apiErr(500, "computer_internal", "disposition 双字段不一致（delivery="+disp.Delivery+" retry="+disp.Retry+"）")
		}
	}
	// 步骤 3：租约撤销 / 过期 / generation 变化 → 迟到结果只核对（记录但不改变终态）。
	var revoked bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM agent_computer_command c JOIN agent_computer_grant g ON g.id=c.grant_id
			WHERE c.id=$1 AND (g.state<>'active' OR (g.expires_at IS NOT NULL AND g.expires_at <= now())
			  OR g.generation<>c.generation))`, commandID).Scan(&revoked); err != nil {
		return err
	}
	if revoked {
		return apiErr(409, "computer_foreground_busy", "租约已撤销、过期或审批版本已变化；回执按迟到结果核对，不改变最终状态")
	}
	// 步骤 4：终态同结果幂等重放；异结果 409。
	var currentState string
	if err := s.db.QueryRow(r.Context(), `SELECT state FROM agent_computer_command WHERE id=$1`, commandID).Scan(&currentState); err != nil {
		return err
	}
	if currentState == "succeeded" || currentState == "failed" || currentState == "unknown_outcome" {
		if currentState == body.State {
			return s.renderComputerCommand(r.Context(), w, commandID)
		}
		return apiErr(409, "computer_approval_conflict", "命令已有不同最终结果，迟到回执仅入账核对")
	}
	// 步骤 5：写终态（只有 queued/dispatched 可收终态）+ 事件。
	if _, err := s.db.Exec(r.Context(), `
		UPDATE agent_computer_command SET state=$2, receipt_hash=COALESCE(NULLIF($3,''), receipt_hash), error_code=NULLIF($4,''),
			result=$5, disposition=$6
		WHERE id=$1 AND state IN ('queued','dispatched')`,
		commandID, body.State, body.ReceiptHash, body.ErrorCode, nullJSON(body.Result), nullJSON(body.Disposition)); err != nil {
		return err
	}
	s.updateComputerCardFromCommand(r.Context(), conversationID, commandID, body.State)
	s.emitComputerCommandEvent(r.Context(), conversationID, "computer.command_finished", map[string]any{
		"command_id": commandID.String(), "state": body.State, "error_code": body.ErrorCode,
	})
	return s.renderComputerCommand(r.Context(), w, commandID)
}

// sweepComputerCommands：把 dispatched 超过 deadline（+2s 时钟误差）的命令转
// unknown_outcome + computer_timeout。**不重放、不新建命令**（C08）。
func (s *Server) sweepComputerCommands(ctx context.Context) {
	tag, err := s.db.Exec(ctx, `
		UPDATE agent_computer_command SET state='unknown_outcome', error_code='computer_timeout'
		WHERE state='dispatched' AND deadline_at IS NOT NULL AND deadline_at + interval '2 seconds' < now()`)
	if err != nil {
		return
	}
	if tag.RowsAffected() > 0 {
		slog.Info("电脑命令超时转 unknown_outcome", "count", tag.RowsAffected())
	}
	// 超时命令对应的确认卡不再可执行；状态收敛为 failed，避免 UI 永远停在 executing。
	_, _ = s.db.Exec(ctx, `UPDATE agent_action a
		SET status='failed', finished_at=now(), revision=revision+1
		FROM agent_computer_command c
		WHERE c.state='unknown_outcome' AND c.error_code='computer_timeout'
		  AND a.id=c.card_id AND a.tool_name='computer_command' AND a.status IN ('pending','executing')`)
}

// computerCommandModelProject 是 run 内命令响应的模型投影：
// 剥离 grant_id / card_id / approval_hash / request_id——模型不持租约句柄与审批凭据（C02）。
func computerCommandModelProject(_ int, body []byte) any {
	var v map[string]any
	if err := json.Unmarshal(body, &v); err != nil {
		return json.RawMessage(body)
	}
	for _, key := range []string{"grant_id", "card_id", "approval_hash", "request_id"} {
		delete(v, key)
	}
	return v
}

// ---------------------------------------------------------------------------
// DEV-CU P4-8：§4.11 剩余两路由——命令查询（归属校验）与能力快照。
// ---------------------------------------------------------------------------

// listComputerCommands（GET /agent/computer/commands?run_id=）：本人账本查询。
func (s *Server) listComputerCommands(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	runID, err := uuid.Parse(r.URL.Query().Get("run_id"))
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT `+computerCommandColumns+`
		FROM agent_computer_command c JOIN agent_computer_grant g ON g.id=c.grant_id
		WHERE c.run_id=$1 AND g.workspace_id=$2 AND g.user_id=$3
		ORDER BY c.created_at DESC LIMIT 200`, runID, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	commands := []computerCommandView{}
	for rows.Next() {
		v, err := scanComputerCommand(rows)
		if err != nil {
			return err
		}
		commands = append(commands, v)
	}
	return ok(w, map[string]any{"commands": commands})
}

// computerCapabilitiesView（§4.11）：available/reason/device_state/protocol_range/
// observation_modes/foreground_state；不泄漏应用清单（C09）。
type computerCapabilitiesView struct {
	Available        bool     `json:"available"`
	Reason           string   `json:"reason,omitempty"`
	DeviceState      string   `json:"device_state"`
	ProtocolRange    string   `json:"protocol_range"`
	ObservationModes []string `json:"observation_modes"`
	ForegroundState  string   `json:"foreground_state"`
}

// computerCapabilities（GET /agent/computer/capabilities）：能力快照。
// device_state 与 foreground_state 依赖桌面端 presence 心跳上报（21 文档），
// 服务端在无心跳数据时如实报 unknown，不臆造。
func (s *Server) computerCapabilities(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	caps := computerCapabilitiesView{
		DeviceState:      "unknown",
		ProtocolRange:    ContractVersion,
		ObservationModes: []string{"uia"},
		ForegroundState:  "unknown",
	}
	caps.Available = s.agentWorkbenchFeatures(r.Context())["computer_use"]
	if !caps.Available {
		caps.Reason = "computer_use disabled by runtime gate"
	}
	return ok(w, caps)
}
