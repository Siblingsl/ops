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
	CreatedAt      string `json:"created_at"`
	ExpiresAt      string `json:"expires_at,omitempty"`
}

const computerGrantColumnsPlain = `id::text, conversation_id::text, COALESCE(run_id::text,''),
	target_handle, target_summary, scope, generation, state,
	to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	COALESCE(to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z\"'),'')`

const computerGrantColumns = `g.id::text, g.conversation_id::text, COALESCE(g.run_id::text,''),
	g.target_handle, g.target_summary, g.scope, g.generation, g.state,
	to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
	COALESCE(to_char(g.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'')`

// 硬禁区：这些进程名/窗口标题模式永远拒绝（27 §11.5.2）。
var computerHardForbiddenPatterns = []string{
	"winlogon", "csrss", "wininit", "lsass", "smss",      // 系统关键进程
	"taskmgr", "cmd", "powershell", "pwsh",               // 终端/运行框
	"regedit", "secpol", "gpedit",                        // 注册表/策略编辑器
	"credential", "vault",                                // 凭据管理
	"凭据管理", "密码管理",                             // 中文窗口标题
	"命令提示符", "powershell", "注册表", "安全中心",  // 中文窗口标题
	"uac", "consent",                                     // UAC 提升
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
				&existing.CreatedAt, &existing.ExpiresAt); err != nil {
			return err
		}
		return ok(w, existing)
	}
	if err != pgx.ErrNoRows {
		return err
	}
	// 单租约互斥（C04）。
	var activeID uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT id FROM agent_computer_grant
		WHERE user_id=$1 AND state='active' AND (expires_at IS NULL OR expires_at > now())`,
		id.UserID).Scan(&activeID)
	if err == nil {
		return apiErr(409, "computer_foreground_busy", "已有活动前台租约，请先撤销")
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
	expires := time.Now().Add(30 * time.Second)
	var view computerGrantView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), "INSERT INTO agent_computer_grant"+
			" (id, workspace_id, user_id, conversation_id, run_id, target_handle, target_summary, scope, state, request_id, expires_at)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10) RETURNING "+computerGrantColumnsPlain,
			grantID, id.WorkspaceID, id.UserID, conversationID, runID,
			body.TargetHandle, body.TargetSummary, body.Scope, requestID, expires)
		var scanErr error
		view, scanErr = scanComputerGrant(row)
		return scanErr
	}); err != nil {
		return err
	}
	return ok(w, view)
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
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_computer_grant
		SET state='revoked', revoked_at=now(), generation=generation+1
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state='active'`,
		grantID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"revoked": true})
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
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_computer_grant
		SET state='revoked', revoked_at=now(), generation=generation+1
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state='active'`,
		grantID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	// W10：接管通知（27 §11.5.1：任务栏与控制条标"AI 正在操作"，接管即撤前台租约）。
	s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_computer", "已接管：电脑控制已停止",
		"前台租约已撤销；如需继续请重新选择应用", "/agent?panel=task", "computer:handoff:" + grantID.String())
	return ok(w, map[string]any{"state": "revoked", "device_ack_pending": true})
}

func scanComputerGrant(row pgx.Row) (computerGrantView, error) {
	var v computerGrantView
	err := row.Scan(&v.ID, &v.ConversationID, &v.RunID, &v.TargetHandle,
		&v.TargetSummary, &v.Scope, &v.Generation, &v.State, &v.CreatedAt, &v.ExpiresAt)
	return v, err
}
