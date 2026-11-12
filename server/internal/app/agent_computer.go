package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-17（W17）：Windows 通用应用控制前台租约（27 文档 §11.5）。
// 授权由本机选窗产生（不透明 target_handle），服务端只管租约生命周期与硬禁区校验。
// 硬禁区（§11.5.2）：UAC/密码/MFA/终端/宏/任意 Shell——永远拒绝，即使被网页诱导或普通授权。
// 授权不转全桌面；每次选目标；单租约互斥（每设备一个前台操作者）。
// 本批实现租约 CRUD + 硬禁区 + 隔离；UIA/视觉执行 worker 属第二批。

type computerGrantView struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	RunID          string `json:"run_id,omitempty"`
	TargetHandle   string `json:"target_handle"`
	TargetSummary  string `json:"target_summary"`
	Scope          string `json:"scope"`
	Generation     int64  `json:"generation"`
	State          string `json:"state"`
	// P1-4：pending → active 与 revoking → revoked 需设备确认；after_event_seq 供确认后从该游标续传。
	DeviceAckPending bool   `json:"device_ack_pending"`
	AfterEventSeq    int64  `json:"after_event_seq"`
	CreatedAt        string `json:"created_at"`
	ExpiresAt        string `json:"expires_at,omitempty"`
}

const computerGrantColumnsPlain = `id::text, conversation_id::text, COALESCE(run_id::text,''),
	target_handle, target_summary, scope, generation, state, device_ack_pending,
	COALESCE(after_event_seq,0),
	to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	COALESCE(to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z\"'),'')`

const computerGrantColumns = `g.id::text, g.conversation_id::text, COALESCE(g.run_id::text,''),
	g.target_handle, g.target_summary, g.scope, g.generation, g.state, g.device_ack_pending,
	COALESCE(g.after_event_seq,0),
	to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	COALESCE(to_char(g.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'')`

// 硬禁区：这些进程名/窗口标题模式永远拒绝（27 §11.5.2）。
var computerHardForbiddenPatterns = []string{
	"winlogon", "csrss", "wininit", "lsass", "smss", // 系统关键进程
	"taskmgr", "cmd", "powershell", "pwsh", // 终端/运行框
	"regedit", "secpol", "gpedit", // 注册表/策略编辑器
	"credential", "vault", // 凭据管理
	"凭据管理", "密码管理", // 中文窗口标题
	"命令提示符", "powershell", "注册表", "安全中心", // 中文窗口标题
	"uac", "consent", // UAC 提升
}

func computerIsHardForbidden(targetSummary string) bool {
	lower := strings.ToLower(targetSummary)
	for _, pattern := range computerHardForbiddenPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

func (s *Server) computerGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "computer_policy_denied", "代访问期间不能使用电脑控制")
	}
	if id.Role == "viewer" {
		return apiErr(403, "computer_policy_denied", "观察者角色未开放电脑控制")
	}
	return nil
}

// POST /agent/conversations/{id}/computer-grants：创建前台租约（本机选窗后提交）。
// 每设备一个前台操作者（P0）：同用户已有 active 租约时 409。
func (s *Server) createComputerGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		RunID         string `json:"run_id"`
		TargetHandle  string `json:"target_handle"`
		TargetSummary string `json:"target_summary"`
		Scope         string `json:"scope"`
		RequestID     string `json:"request_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.TargetHandle == "" || body.TargetSummary == "" {
		return apiErr(422, "validation_failed", "target_handle 与 target_summary 必填")
	}
	if body.Scope != "observe" && body.Scope != "act" {
		return apiErr(422, "validation_failed", "scope 只能是 observe 或 act")
	}
	requestID, err := uuid.Parse(body.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	// 硬禁区校验（C07）。
	if computerIsHardForbidden(body.TargetSummary) {
		return apiErr(403, "computer_hard_forbidden", "目标命中硬禁区，永远拒绝")
	}
	// 会话归属。
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_conversation
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`,
		conversationID, id.WorkspaceID, id.UserID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	// 同 request_id 幂等（优先于 busy 检查：同编号返回原租约）。
	var existingID uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT id FROM agent_computer_grant
		WHERE conversation_id=$1 AND request_id=$2`, conversationID, requestID).Scan(&existingID)
	if err == nil {
		var existing computerGrantView
		if err := s.db.QueryRow(r.Context(), "SELECT "+computerGrantColumns+
			" FROM agent_computer_grant g WHERE g.id=$1", existingID).
			Scan(&existing.ID, &existing.ConversationID, &existing.RunID, &existing.TargetHandle,
				&existing.TargetSummary, &existing.Scope, &existing.Generation, &existing.State,
				&existing.DeviceAckPending, &existing.AfterEventSeq,
				&existing.CreatedAt, &existing.ExpiresAt); err != nil {
			return err
		}
		writeJSON(w, http.StatusAccepted, grantAcceptedBody(existing))
		return nil
	}
	if err != pgx.ErrNoRows {
		return err
	}
	var runID *uuid.UUID
	if strings.TrimSpace(body.RunID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(body.RunID))
		if err != nil {
			return apiErr(400, "bad_request", "run_id 必须是 UUID")
		}
		runID = &parsed
	}
	grantID := uuid.New()
	expires := s.now().Add(30 * time.Second)
	var view computerGrantView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// P4-12（S05 并发窗口补齐）：互斥检查移入事务内（对齐 browser 侧 :350-360），
		// 消除「检查在事务外、INSERT 在事务内」的并发窗口。409 码与文案不变。
		// S05 前台互斥（27 §11.5.2）：浏览器 AI 操作（活动 browser grant）与电脑控制共用前台——
		// 有活动浏览器租约时电脑控制拒绝（反之亦然，browser-grants API 同理）。
		var activeBrowserGrant bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_browser_grant
			WHERE user_id=$1 AND workspace_id=$2 AND state='active' AND expires_at > now())`,
			id.UserID, id.WorkspaceID).Scan(&activeBrowserGrant); err != nil {
			return err
		}
		if activeBrowserGrant {
			return apiErr(409, "computer_foreground_busy", "浏览器协作正在操作前台；请先停止浏览器任务再使用电脑控制")
		}
		// 单租约互斥（C04）。行级锁：activity grant 上 FOR UPDATE 防止两事务同时通过检查。
		var activeID uuid.UUID
		if err := tx.QueryRow(r.Context(), `SELECT id FROM agent_computer_grant
			WHERE user_id=$1 AND state='active' AND (expires_at IS NULL OR expires_at > now())
			FOR UPDATE`,
			id.UserID).Scan(&activeID); err != nil {
			if err != pgx.ErrNoRows {
				return err
			}
		} else {
			return apiErr(409, "computer_foreground_busy", "已有活动前台租约，请先撤销")
		}
		// P1-4：先落 pending，本机确认真实窗口与前台后再由 device-ack 转 active（D-188 / 27 §11.5.5）。
		// after_event_seq 取会话当前最大事件序号，供设备确认后从该游标续传。
		row := tx.QueryRow(r.Context(), "INSERT INTO agent_computer_grant"+
			" (id, workspace_id, user_id, conversation_id, run_id, target_handle, target_summary, scope, state, device_ack_pending, after_event_seq, request_id, expires_at)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',true,"+
			"(SELECT COALESCE(MAX(e.event_seq),0) FROM agent_event e WHERE e.conversation_id=$4),$9,$10) RETURNING "+computerGrantColumnsPlain,
			grantID, id.WorkspaceID, id.UserID, conversationID, runID,
			body.TargetHandle, body.TargetSummary, body.Scope, requestID, expires)
		var scanErr error
		view, scanErr = scanComputerGrant(row)
		return scanErr
	}); err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, grantAcceptedBody(view))
	return nil
}

// DELETE /agent/computer-grants/{id}：撤销（generation 递增使旧授权失效）。
func (s *Server) revokeComputerGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	grantID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	// P1-4：撤销先进入 revoking 并置 device_ack_pending，设备确认后才转 revoked；
	// 不把 202 当成已停止（27 §11.5.5）。
	var newGeneration int64
	var newState string
	err = s.db.QueryRow(r.Context(), `UPDATE agent_computer_grant
		SET state='revoking', device_ack_pending=true, revoked_at=NULL, generation=generation+1
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state IN ('pending','active')
		RETURNING generation, state`,
		grantID, id.UserID, id.WorkspaceID).Scan(&newGeneration, &newState)
	if err == pgx.ErrNoRows {
		return errNotFound
	}
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"id": grantID.String(), "state": newState,
		"device_ack_pending": true, "generation": newGeneration,
	})
	return nil
}

// GET /agent/computer-grants?conversation_id=：本人当前租约查询。
func (s *Server) listComputerGrants(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), "SELECT "+computerGrantColumns+
		" FROM agent_computer_grant g WHERE g.conversation_id=$1 AND g.user_id=$2 AND g.workspace_id=$3"+
		" AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at > now())"+
		" ORDER BY g.created_at DESC LIMIT 10",
		conversationID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	grants := []computerGrantView{}
	for rows.Next() {
		v, err := scanComputerGrant(rows)
		if err != nil {
			return err
		}
		grants = append(grants, v)
	}
	return ok(w, map[string]any{"grants": grants})
}

// POST /agent/computer-grants/{id}/handoff：用户接管（前台租约撤销；本机先停控）。
func (s *Server) handoffComputerGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	grantID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	// P1-4：接管同样先进 revoking，等本机确认停止后才转 revoked。
	var newGeneration int64
	var newState string
	err = s.db.QueryRow(r.Context(), `UPDATE agent_computer_grant
		SET state='revoking', device_ack_pending=true, revoked_at=NULL, generation=generation+1
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state IN ('pending','active')
		RETURNING generation, state`,
		grantID, id.UserID, id.WorkspaceID).Scan(&newGeneration, &newState)
	if err == pgx.ErrNoRows {
		return errNotFound
	}
	if err != nil {
		return err
	}
	// W10：接管通知（27 §11.5.1：任务栏与控制条标"AI 正在操作"，接管即撤前台租约）。
	s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_computer", "已接管：电脑控制已停止",
		"前台租约已撤销；如需继续请重新选择应用", "/agent?panel=task", "computer:handoff:"+grantID.String())
	writeJSON(w, http.StatusAccepted, map[string]any{
		"id": grantID.String(), "state": newState,
		"device_ack_pending": true, "generation": newGeneration,
	})
	return nil
}

// POST /tools/computer/target-requests：模型请求用户在本机选择前台目标（27 §11.5.1）。
// 选窗器完全在本机运行，服务端只收到"待选择"意图；30 秒租约由用户选定后即时创建，
// 因此不做 run 级预授权——那会在模型真正操作前就过期（A12 决策 A）。
func (s *Server) requestComputerTarget(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	principal := agentPrincipalOf(r.Context())
	if principal == nil || principal.ConversationID == uuid.Nil {
		return apiErr(422, "validation_failed", "该接口只能由会话内的工具调用发起")
	}
	var active computerGrantView
	err := s.db.QueryRow(r.Context(), "SELECT "+computerGrantColumns+
		" FROM agent_computer_grant g WHERE g.conversation_id=$1 AND g.user_id=$2 AND g.workspace_id=$3"+
		" AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at > now())"+
		" ORDER BY g.created_at DESC LIMIT 1",
		principal.ConversationID, id.UserID, id.WorkspaceID).
		Scan(&active.ID, &active.ConversationID, &active.RunID, &active.TargetHandle,
			&active.TargetSummary, &active.Scope, &active.Generation, &active.State,
			&active.DeviceAckPending, &active.AfterEventSeq,
			&active.CreatedAt, &active.ExpiresAt)
	if err == nil {
		return ok(w, map[string]any{
			"state": "active", "grant": active,
			"message": "已有活动前台租约：" + active.TargetSummary + "；直接继续即可",
		})
	}
	if err != pgx.ErrNoRows {
		return err
	}
	return ok(w, map[string]any{
		"state": "awaiting_selection",
		"message": "已请用户在本机选择要操作的应用窗口；选定后租约立即生效，" +
			"请在用户确认后重新观察目标，不要凭猜测操作",
	})
}

func scanComputerGrant(row pgx.Row) (computerGrantView, error) {
	var v computerGrantView
	err := row.Scan(&v.ID, &v.ConversationID, &v.RunID, &v.TargetHandle,
		&v.TargetSummary, &v.Scope, &v.Generation, &v.State,
		&v.DeviceAckPending, &v.AfterEventSeq, &v.CreatedAt, &v.ExpiresAt)
	return v, err
}

// grantAcceptedBody 是 202 回执的固定形状（27 §11.5.5 / docs/06 §13.2）。
// run_id 为 docs/27:1101 明列的字段（未绑定 run 时为空串），其余五项对齐 docs/36 §5 P1-4 步骤 2。
func grantAcceptedBody(v computerGrantView) map[string]any {
	return map[string]any{
		"grant_id": v.ID, "run_id": v.RunID, "generation": v.Generation, "state": v.State,
		"expires_at": v.ExpiresAt, "after_event_seq": v.AfterEventSeq,
	}
}

// POST /agent/computer/grants/{id}/device-ack：本机确认真实窗口与前台后，pending → active；
// 撤销/接管确认停止后，revoking → revoked。迟到或 generation 变化一律 409，不静默成功。
func (s *Server) ackComputerGrantDevice(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.computerGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "computer_use"); err != nil {
		return err
	}
	grantID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		Generation    int64  `json:"generation"`
		TargetSummary string `json:"target_summary"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	var state, summary string
	var generation int64
	var ackPending bool
	err = s.db.QueryRow(r.Context(), `SELECT state, generation, device_ack_pending, target_summary
		FROM agent_computer_grant WHERE id=$1 AND user_id=$2 AND workspace_id=$3`,
		grantID, id.UserID, id.WorkspaceID).Scan(&state, &generation, &ackPending, &summary)
	if err == pgx.ErrNoRows {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if !ackPending {
		return apiErr(409, "computer_approval_conflict", "该租约不处于待设备确认状态")
	}
	// generation 必须精确匹配（202 回执里就有）：不接受 0 作为「未提供」的退让，
	// 否则撤销后旧 generation 的迟到确认会被误当成本次确认。
	if body.Generation != generation {
		return apiErr(409, "computer_approval_conflict", "generation 已变化，旧授权失效")
	}
	if body.TargetSummary != "" && body.TargetSummary != summary {
		return apiErr(409, "computer_target_changed", "窗口身份摘要与批准时不一致")
	}
	next := "active"
	if state == "revoking" {
		next = "revoked"
	}
	if next == "active" {
		// pending 不占前台；转 active 时必须再校验一次单租约互斥，避免两个 pending 同时转正。
		var busy bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_computer_grant
			WHERE user_id=$1 AND workspace_id=$2 AND state='active' AND id<>$3
			  AND (expires_at IS NULL OR expires_at > now()))`,
			id.UserID, id.WorkspaceID, grantID).Scan(&busy); err != nil {
			return err
		}
		if busy {
			return apiErr(409, "computer_foreground_busy", "已有活动前台租约，请先撤销")
		}
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_computer_grant
		SET state=$4, device_ack_pending=false,
		    revoked_at=CASE WHEN $7 THEN now() ELSE revoked_at END
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state=$5 AND generation=$6`,
		grantID, id.UserID, id.WorkspaceID, next, state, generation, next == "revoked")
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apiErr(409, "computer_approval_conflict", "状态或 generation 已变化，请重新观察")
	}
	return ok(w, map[string]any{"id": grantID.String(), "state": next, "generation": generation})
}
