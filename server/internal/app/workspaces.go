package app

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type workspaceDTO struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
	Role string    `json:"role"`
}

func (s *Server) listUserWorkspaces(ctx context.Context, userID uuid.UUID) ([]workspaceDTO, error) {
	rows, err := s.db.Query(ctx, `
		SELECT w.id, w.name, wm.role
		FROM workspace_member wm
		JOIN workspace w ON w.id = wm.workspace_id
		WHERE wm.user_id=$1 AND wm.status='active'
		ORDER BY w.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []workspaceDTO{}
	for rows.Next() {
		var w workspaceDTO
		if err := rows.Scan(&w.ID, &w.Name, &w.Role); err != nil {
			return nil, err
		}
		list = append(list, w)
	}
	return list, rows.Err()
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) error {
	list, err := s.listUserWorkspaces(r.Context(), ident(r.Context()).UserID)
	if err != nil {
		return err
	}
	return ok(w, list)
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Name   string `json:"name"`
		Switch bool   `json:"switch"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "新工作区"
	}
	id := ident(r.Context())
	var wsID uuid.UUID
	err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		if err := tx.QueryRow(r.Context(),
			`INSERT INTO workspace (name, created_by_user_id) VALUES ($1,$2) RETURNING id`,
			name, id.UserID).Scan(&wsID); err != nil {
			return err
		}
		_, err := tx.Exec(r.Context(),
			`INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
			wsID, id.UserID)
		return err
	})
	if err != nil {
		return err
	}
	for _, sw := range baseSensitiveWords {
		_, _ = s.db.Exec(r.Context(),
			`INSERT INTO sensitive_word (workspace_id, word, category, source) VALUES ($1,$2,$3,'base') ON CONFLICT DO NOTHING`,
			wsID, sw.word, sw.category)
	}
	if s.cfg.Dev {
		_ = s.seedDevModelFor(r.Context(), wsID)
	}
	switched := false
	if in.Switch {
		if _, err := s.db.Exec(r.Context(), `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, id.SessionID, wsID); err != nil {
			return err
		}
		switched = true
		s.audit(r.Context(), "workspace_switch", "workspace", wsID.String(), "ok", map[string]any{"via": "create"})
	}
	s.audit(r.Context(), "workspace_create", "workspace", wsID.String(), "ok", nil)
	return ok(w, map[string]any{
		"id": wsID, "name": name, "role": "owner", "switched": switched,
	})
}

func (s *Server) patchWorkspace(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	wsID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if wsID != ident(r.Context()).WorkspaceID {
		return errNotFound
	}
	var in struct {
		Name *string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		return validation("请填写工作区名称")
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE workspace SET name=$2, updated_at=now() WHERE id=$1`, wsID, strings.TrimSpace(*in.Name))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) switchWorkspace(w http.ResponseWriter, r *http.Request) error {
	wsID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	var role string
	err = s.db.QueryRow(r.Context(),
		`SELECT role FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
		wsID, id.UserID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, id.SessionID, wsID); err != nil {
		return err
	}
	s.audit(r.Context(), "workspace_switch", "workspace", wsID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true, "workspace_id": wsID, "role": role})
}

type memberDTO struct {
	UserID   uuid.UUID `json:"user_id"`
	Username string    `json:"username"`
	Role     string    `json:"role"`
	Status   string    `json:"status"`
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.username, wm.role, wm.status
		FROM workspace_member wm JOIN app_user u ON u.id = wm.user_id
		WHERE wm.workspace_id=$1 ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, u.username`, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []memberDTO{}
	for rows.Next() {
		var m memberDTO
		if err := rows.Scan(&m.UserID, &m.Username, &m.Role, &m.Status); err != nil {
			return err
		}
		list = append(list, m)
	}
	return ok(w, list)
}

func (s *Server) patchMember(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	targetID, err := pathID(r, "userId")
	if err != nil {
		return err
	}
	var in struct {
		Role   *string `json:"role"`
		Status *string `json:"status"`
		Remove *bool   `json:"remove"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	self := ident(r.Context()).UserID
	if in.Remove != nil && *in.Remove {
		if targetID == self {
			return validation("不能移出自己，请使用离开工作区")
		}
		if err := s.ensureNotLastOwner(r.Context(), ws, targetID); err != nil {
			return err
		}
		tag, err := s.db.Exec(r.Context(), `DELETE FROM workspace_member WHERE workspace_id=$1 AND user_id=$2`, ws, targetID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		s.audit(r.Context(), "member_remove", "user", targetID.String(), "ok", nil)
		return ok(w, map[string]any{"ok": true})
	}
	if in.Role != nil {
		role := *in.Role
		if role != "owner" && role != "editor" && role != "viewer" {
			return validation("角色无效")
		}
		if role == "editor" || role == "viewer" {
			if err := s.ensureNotLastOwner(r.Context(), ws, targetID); err != nil {
				return err
			}
		}
		tag, err := s.db.Exec(r.Context(),
			`UPDATE workspace_member SET role=$3, updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,
			ws, targetID, role)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
	}
	if in.Status != nil {
		st := *in.Status
		if st != "active" && st != "disabled" {
			return validation("状态无效")
		}
		if st == "disabled" {
			if err := s.ensureNotLastOwner(r.Context(), ws, targetID); err != nil {
				return err
			}
		}
		tag, err := s.db.Exec(r.Context(),
			`UPDATE workspace_member SET status=$3, updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,
			ws, targetID, st)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
	}
	s.audit(r.Context(), "member_update", "user", targetID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// transferOwnership makes target the owner and demotes the current owner to editor (D-036).
func (s *Server) transferOwnership(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		UserID string `json:"user_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	targetID, err := uuid.Parse(strings.TrimSpace(in.UserID))
	if err != nil {
		return validation("请选择要转让的成员")
	}
	id := ident(r.Context())
	if targetID == id.UserID {
		return validation("不能转让给自己")
	}
	var role, status string
	err = s.db.QueryRow(r.Context(), `SELECT role, status FROM workspace_member WHERE workspace_id=$1 AND user_id=$2`,
		id.WorkspaceID, targetID).Scan(&role, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return validation("只能转让给使用中的成员")
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `UPDATE workspace_member SET role='owner', updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,
			id.WorkspaceID, targetID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `UPDATE workspace_member SET role='editor', updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,
			id.WorkspaceID, id.UserID); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.audit(r.Context(), "owner_transfer", "user", targetID.String(), "ok", map[string]any{"from": id.UserID.String()})
	return ok(w, map[string]any{"ok": true, "owner_user_id": targetID})
}

func (s *Server) leaveWorkspace(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.ensureNotLastOwner(r.Context(), id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM workspace_member WHERE workspace_id=$1 AND user_id=$2`,
		id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	next, err := s.pickWorkspace(r.Context(), id.UserID)
	if err != nil {
		// No workspace left — clear current; client should create/join.
		_, _ = s.db.Exec(r.Context(), `DELETE FROM session WHERE id=$1`, id.SessionID)
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
		s.audit(r.Context(), "workspace_leave", "workspace", id.WorkspaceID.String(), "ok", map[string]any{"orphaned": true})
		return ok(w, map[string]any{"ok": true, "needs_workspace": true})
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, id.SessionID, next); err != nil {
		return err
	}
	s.audit(r.Context(), "workspace_leave", "workspace", id.WorkspaceID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true, "workspace_id": next})
}

func (s *Server) ensureNotLastOwner(ctx context.Context, ws, userID uuid.UUID) error {
	var role string
	err := s.db.QueryRow(ctx, `SELECT role FROM workspace_member WHERE workspace_id=$1 AND user_id=$2`, ws, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if role != "owner" {
		return nil
	}
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM workspace_member WHERE workspace_id=$1 AND role='owner' AND status='active'`, ws).Scan(&n); err != nil {
		return err
	}
	if n <= 1 {
		return validation("工作区至少保留一名所有者")
	}
	return nil
}

type inviteDTO struct {
	ID        uuid.UUID  `json:"id"`
	Code      string     `json:"code"`
	Role      string     `json:"role"`
	MaxUses   int        `json:"max_uses"`
	UsedCount int        `json:"used_count"`
	ExpiresAt time.Time  `json:"expires_at"`
	RevokedAt *time.Time `json:"revoked_at"`
	CreatedAt time.Time  `json:"created_at"`
}

func (s *Server) listInvites(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id, code, role, max_uses, used_count, expires_at, revoked_at, created_at
		FROM workspace_invite WHERE workspace_id=$1 AND revoked_at IS NULL
		ORDER BY created_at DESC`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []inviteDTO{}
	for rows.Next() {
		var inv inviteDTO
		if err := rows.Scan(&inv.ID, &inv.Code, &inv.Role, &inv.MaxUses, &inv.UsedCount, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt); err != nil {
			return err
		}
		list = append(list, inv)
	}
	return ok(w, list)
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		Role     string `json:"role"`
		MaxUses  int    `json:"max_uses"`
		Days     int    `json:"days"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	role := in.Role
	if role == "" {
		role = "editor"
	}
	if role != "editor" && role != "owner" && role != "viewer" {
		return validation("邀请角色无效")
	}
	maxUses := in.MaxUses
	if maxUses <= 0 {
		maxUses = 10
	}
	days := in.Days
	if days <= 0 {
		days = 7
	}
	code, err := randomInviteCode(8)
	if err != nil {
		return err
	}
	expires := s.now().Add(time.Duration(days) * 24 * time.Hour)
	id := ident(r.Context())
	var inv inviteDTO
	err = s.db.QueryRow(r.Context(), `
		INSERT INTO workspace_invite (workspace_id, code, role, max_uses, expires_at, created_by_user_id)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, code, role, max_uses, used_count, expires_at, revoked_at, created_at`,
		id.WorkspaceID, code, role, maxUses, expires, id.UserID).
		Scan(&inv.ID, &inv.Code, &inv.Role, &inv.MaxUses, &inv.UsedCount, &inv.ExpiresAt, &inv.RevokedAt, &inv.CreatedAt)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "invite_create", "workspace_invite", inv.ID.String(), "ok", nil)
	return ok(w, inv)
}

func (s *Server) revokeInvite(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	invID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(),
		`UPDATE workspace_invite SET revoked_at=now(), updated_at=now()
		 WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`,
		invID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "invite_revoke", "workspace_invite", invID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) sendInviteEmail(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	invID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Email string `json:"email"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	to := strings.TrimSpace(strings.ToLower(in.Email))
	if to == "" || !strings.Contains(to, "@") {
		return validation("请填写有效邮箱")
	}
	id := ident(r.Context())
	var code, role string
	var expires time.Time
	err = s.db.QueryRow(r.Context(), `
		SELECT code, role, expires_at FROM workspace_invite
		WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`,
		invID, id.WorkspaceID).Scan(&code, &role, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var wsName string
	_ = s.db.QueryRow(r.Context(), `SELECT name FROM workspace WHERE id=$1`, id.WorkspaceID).Scan(&wsName)
	roleLabel := map[string]string{"owner": "所有者", "editor": "编辑者", "viewer": "观察者"}[role]
	if roleLabel == "" {
		roleLabel = role
	}
	subject := fmt.Sprintf("邀请加入工作区「%s」", wsName)
	body := fmt.Sprintf("你被邀请以「%s」身份加入工作区「%s」。\n\n邀请码：%s\n有效期至：%s\n\n打开系统 → 成员与邀请 → 输入邀请码即可加入。\n",
		roleLabel, wsName, code, expires.Local().Format("2006-01-02 15:04"))

	cfg, err := s.loadSMTP(r.Context())
	if err != nil {
		return err
	}
	status := "sent"
	errMsg := ""
	if s.cfg.Dev && !cfg.configured() {
		status = "dev_logged"
		slog.Info("invite email (dev, SMTP unset)", "to", to, "code", code, "workspace", wsName)
	} else {
		if !cfg.configured() {
			return validation("请先在设置中配置 SMTP（发件邮箱）")
		}
		if err := sendSMTP(cfg, to, subject, body); err != nil {
			status = "failed"
			errMsg = err.Error()
			_, _ = s.db.Exec(r.Context(), `
				INSERT INTO workspace_invite_email (invite_id, workspace_id, to_email, status, error)
				VALUES ($1,$2,$3,$4,$5)`, invID, id.WorkspaceID, to, status, errMsg)
			s.audit(r.Context(), "invite_email", "workspace_invite", invID.String(), "failed", map[string]any{"to": to})
			return apiErr(502, "email_failed", "邮件发送失败："+errMsg)
		}
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO workspace_invite_email (invite_id, workspace_id, to_email, status, error)
		VALUES ($1,$2,$3,$4,$5)`, invID, id.WorkspaceID, to, status, errMsg); err != nil {
		return err
	}
	s.audit(r.Context(), "invite_email", "workspace_invite", invID.String(), "ok", map[string]any{"to": to, "status": status})
	msg := "邀请邮件已发送"
	if status == "dev_logged" {
		msg = "开发模式已记录邀请（未配置 SMTP，未真实发信）"
	}
	return ok(w, map[string]any{"ok": true, "status": status, "message": msg})
}

func (s *Server) joinWorkspace(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Code   string `json:"code"`
		Switch *bool  `json:"switch"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	doSwitch := in.Switch == nil || *in.Switch
	wsID, err := s.consumeInvite(r.Context(), ident(r.Context()).UserID, strings.TrimSpace(in.Code), doSwitch)
	if err != nil {
		return err
	}
	if doSwitch && wsID != uuid.Nil {
		if _, err := s.db.Exec(r.Context(), `UPDATE session SET current_workspace_id=$2 WHERE id=$1`,
			ident(r.Context()).SessionID, wsID); err != nil {
			return err
		}
	}
	return ok(w, map[string]any{"ok": true, "workspace_id": wsID})
}

// consumeInvite adds user to workspace. Returns workspace id. alreadyMember does not increment uses.
// If switchTo is true, caller should update session (joinWorkspace does; login/register pass returned id).
func (s *Server) consumeInvite(ctx context.Context, userID uuid.UUID, code string, _ bool) (uuid.UUID, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return uuid.Nil, validation("请填写邀请码")
	}
	var (
		invID   uuid.UUID
		wsID    uuid.UUID
		role    string
		maxUses int
		used    int
		expires time.Time
		revoked *time.Time
	)
	err := s.db.QueryRow(ctx, `
		SELECT id, workspace_id, role, max_uses, used_count, expires_at, revoked_at
		FROM workspace_invite WHERE code=$1`, code).
		Scan(&invID, &wsID, &role, &maxUses, &used, &expires, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, validation("邀请码无效")
	}
	if err != nil {
		return uuid.Nil, err
	}
	if revoked != nil {
		return uuid.Nil, validation("邀请码已撤销")
	}
	if s.now().After(expires) {
		return uuid.Nil, validation("邀请码已过期")
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM workspace_member WHERE workspace_id=$1 AND user_id=$2)`,
		wsID, userID).Scan(&exists); err != nil {
		return uuid.Nil, err
	}
	if exists {
		return wsID, nil
	}
	if used >= maxUses {
		return uuid.Nil, validation("邀请码已达到使用次数上限")
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `
			UPDATE workspace_invite SET used_count = used_count + 1, updated_at=now()
			WHERE id=$1 AND revoked_at IS NULL AND used_count < max_uses AND expires_at > now()`, invID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return validation("邀请码不可用")
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')
			ON CONFLICT (workspace_id, user_id) DO NOTHING`, wsID, userID, role)
		return err
	})
	if err != nil {
		return uuid.Nil, err
	}
	s.audit(ctx, "workspace_join", "workspace", wsID.String(), "ok", map[string]any{"invite_id": invID.String()})
	return wsID, nil
}

const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func randomInviteCode(n int) (string, error) {
	b := make([]byte, n)
	max := big.NewInt(int64(len(inviteAlphabet)))
	for i := range b {
		v, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = inviteAlphabet[v.Int64()]
	}
	return string(b), nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}
