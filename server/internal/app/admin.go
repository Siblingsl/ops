package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

func (s *Server) permanentAdminUsername() string {
	if s.cfg == nil || strings.TrimSpace(s.cfg.SystemAdminUser) == "" {
		return "skyeder"
	}
	return strings.TrimSpace(s.cfg.SystemAdminUser)
}

func (s *Server) isPermanentAdminUsername(username string) bool {
	return strings.EqualFold(strings.TrimSpace(username), s.permanentAdminUsername())
}

// EnsurePermanentAdmin creates or updates the fixed super-admin account (D-044).
// The password only ever comes from OPS_SYSTEM_ADMIN_PASSWORD; without it an existing
// admin keeps its current password and no new admin is created.
func (s *Server) EnsurePermanentAdmin(ctx context.Context) error {
	username := s.permanentAdminUsername()
	password := ""
	if s.cfg != nil {
		password = s.cfg.SystemAdminPassword
	}
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM app_user WHERE lower(username)=lower($1)`, username).Scan(&id)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if password == "" {
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("未设置 OPS_SYSTEM_ADMIN_PASSWORD，跳过创建永久超级管理员", "username", username)
			return nil
		}
		_, err := s.db.Exec(ctx, `UPDATE app_user SET is_system_admin=true, disabled_at=NULL, updated_at=now() WHERE id=$1`, id)
		return err
	}
	if err := validPassword(password); err != nil {
		return fmt.Errorf("永久超管密码不符合规则：%w", err)
	}
	hash, herr := secure.HashPassword(password)
	if herr != nil {
		return herr
	}

	if errors.Is(err, pgx.ErrNoRows) {
		tx, err := s.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if err := tx.QueryRow(ctx,
			`INSERT INTO app_user (username, password_hash, is_system_admin) VALUES ($1,$2,true) RETURNING id`,
			username, hash).Scan(&id); err != nil {
			return err
		}
		wsName := fmt.Sprintf("%s 的工作区", username)
		var wsID uuid.UUID
		if err := tx.QueryRow(ctx,
			`INSERT INTO workspace (name, created_by_user_id) VALUES ($1,$2) RETURNING id`,
			wsName, id).Scan(&wsID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
			wsID, id); err != nil {
			return err
		}
		for _, sw := range baseSensitiveWords {
			if _, err := tx.Exec(ctx,
				`INSERT INTO sensitive_word (workspace_id, word, category, source) VALUES ($1,$2,$3,'base') ON CONFLICT DO NOTHING`,
				wsID, sw.word, sw.category); err != nil {
				return err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if s.cfg != nil && s.cfg.Dev {
			_ = s.seedDevModelFor(ctx, wsID)
		}
		slog.Info("已创建永久超级管理员账号", "username", username)
		return nil
	}
	if _, err := s.db.Exec(ctx, `
		UPDATE app_user SET password_hash=$2, is_system_admin=true, disabled_at=NULL,
		  failed_logins=0, locked_until=NULL, updated_at=now()
		WHERE id=$1`, id, hash); err != nil {
		return err
	}
	return nil
}

func (s *Server) systemBool(ctx context.Context, key string, def bool) (bool, error) {
	var raw json.RawMessage
	err := s.db.QueryRow(ctx, `SELECT value FROM system_setting WHERE key=$1`, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return def, nil
	}
	if err != nil {
		// Table may not exist yet during early migrate edge cases.
		if strings.Contains(err.Error(), "system_setting") {
			return def, nil
		}
		return def, err
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return def, nil
	}
	return v, nil
}

func (s *Server) putSystemBool(ctx context.Context, key string, v bool) error {
	b, _ := json.Marshal(v)
	_, err := s.db.Exec(ctx, `
		INSERT INTO system_setting (key, value, updated_at) VALUES ($1,$2::jsonb,now())
		ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, key, b)
	return err
}

func (s *Server) adminListUsers(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT u.id, u.username, u.is_system_admin, u.disabled_at, u.last_login_at, u.created_at,
		       (SELECT count(*) FROM workspace_member wm WHERE wm.user_id=u.id AND wm.status='active'),
		       (SELECT count(*) FROM session s WHERE s.user_id=u.id AND s.expires_at > now())
		FROM app_user u
		ORDER BY u.created_at ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		ID            uuid.UUID  `json:"id"`
		Username      string     `json:"username"`
		IsSystemAdmin bool       `json:"is_system_admin"`
		DisabledAt    *time.Time `json:"disabled_at"`
		LastLoginAt   *time.Time `json:"last_login_at"`
		CreatedAt     time.Time  `json:"created_at"`
		Workspaces    int        `json:"workspace_count"`
		Sessions      int        `json:"session_count"`
	}
	list := []row{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.ID, &x.Username, &x.IsSystemAdmin, &x.DisabledAt, &x.LastLoginAt, &x.CreatedAt, &x.Workspaces, &x.Sessions); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) adminPatchUser(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	targetID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Disabled      *bool `json:"disabled"`
		IsSystemAdmin *bool `json:"is_system_admin"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Disabled == nil && in.IsSystemAdmin == nil {
		return validation("请指定要修改的字段")
	}
	var (
		username string
		isAdmin  bool
		disabled *time.Time
	)
	err = s.db.QueryRow(r.Context(), `SELECT username, is_system_admin, disabled_at FROM app_user WHERE id=$1`, targetID).
		Scan(&username, &isAdmin, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if in.IsSystemAdmin != nil {
		if !*in.IsSystemAdmin && s.isPermanentAdminUsername(username) {
			return validation(fmt.Sprintf("账号 %s 是永久超级管理员，不能撤销", s.permanentAdminUsername()))
		}
		if !*in.IsSystemAdmin && isAdmin {
			var n int
			if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM app_user WHERE is_system_admin AND id<>$1`, targetID).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return validation("至少保留一名系统超级管理员")
			}
		}
		if _, err := s.db.Exec(r.Context(), `UPDATE app_user SET is_system_admin=$2, updated_at=now() WHERE id=$1`,
			targetID, *in.IsSystemAdmin); err != nil {
			return err
		}
		isAdmin = *in.IsSystemAdmin
	}
	if in.Disabled != nil {
		if *in.Disabled {
			if s.isPermanentAdminUsername(username) {
				return validation(fmt.Sprintf("账号 %s 是永久超级管理员，不能禁用", s.permanentAdminUsername()))
			}
			if targetID == ident(r.Context()).UserID {
				return validation("不能禁用当前登录的超级管理员账号")
			}
			if _, err := s.db.Exec(r.Context(), `UPDATE app_user SET disabled_at=now(), updated_at=now() WHERE id=$1`, targetID); err != nil {
				return err
			}
			if _, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1`, targetID); err != nil {
				return err
			}
		} else {
			if _, err := s.db.Exec(r.Context(), `UPDATE app_user SET disabled_at=NULL, updated_at=now() WHERE id=$1`, targetID); err != nil {
				return err
			}
		}
	}
	s.audit(r.Context(), "admin_user_update", "user", targetID.String(), "ok", map[string]any{
		"username": username, "disabled": in.Disabled, "is_system_admin": in.IsSystemAdmin,
	})
	_ = isAdmin
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) adminResetPassword(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	targetID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Password string `json:"password"`
	}
	_ = decode(r, &in)
	pass := strings.TrimSpace(in.Password)
	if pass == "" {
		b := make([]byte, 12)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		pass = hex.EncodeToString(b) // 24 hex chars
	}
	if err := validPassword(pass); err != nil {
		return err
	}
	var username string
	err = s.db.QueryRow(r.Context(), `SELECT username FROM app_user WHERE id=$1`, targetID).Scan(&username)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if _, err := ResetPassword(r.Context(), s, username, pass); err != nil {
		return err
	}
	s.audit(r.Context(), "admin_password_reset", "user", targetID.String(), "ok", map[string]any{"username": username})
	return ok(w, map[string]any{"ok": true, "username": username, "temporary_password": pass})
}

func (s *Server) adminRevokeSessions(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	targetID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1`, targetID)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "admin_revoke_sessions", "user", targetID.String(), "ok", map[string]any{"deleted": tag.RowsAffected()})
	return ok(w, map[string]any{"ok": true, "deleted": tag.RowsAffected()})
}

func (s *Server) adminListWorkspaces(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT w.id, w.name, w.created_at, u.username,
		       (SELECT count(*) FROM workspace_member wm WHERE wm.workspace_id=w.id AND wm.status='active'),
		       (SELECT count(*) FROM platform_account a WHERE a.workspace_id=w.id)
		FROM workspace w
		LEFT JOIN app_user u ON u.id = w.created_by_user_id
		ORDER BY w.created_at ASC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		ID           uuid.UUID `json:"id"`
		Name         string    `json:"name"`
		CreatedAt    time.Time `json:"created_at"`
		CreatedBy    *string   `json:"created_by"`
		MemberCount  int       `json:"member_count"`
		AccountCount int       `json:"account_count"`
	}
	list := []row{}
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.ID, &x.Name, &x.CreatedAt, &x.CreatedBy, &x.MemberCount, &x.AccountCount); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) adminEnterWorkspace(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	wsID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var name string
	err = s.db.QueryRow(r.Context(), `SELECT name FROM workspace WHERE id=$1`, wsID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if _, err := s.db.Exec(r.Context(),
		`UPDATE session SET current_workspace_id=$2, admin_override=true WHERE id=$1`,
		id.SessionID, wsID); err != nil {
		return err
	}
	s.audit(r.Context(), "admin_workspace_enter", "workspace", wsID.String(), "ok", map[string]any{"name": name})
	return ok(w, map[string]any{"ok": true, "workspace_id": wsID, "name": name, "admin_override": true})
}

func (s *Server) adminExitWorkspace(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	id := ident(r.Context())
	wsID, err := s.pickWorkspace(r.Context(), id.UserID)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(),
		`UPDATE session SET current_workspace_id=$2, admin_override=false WHERE id=$1`,
		id.SessionID, wsID); err != nil {
		return err
	}
	s.audit(r.Context(), "admin_workspace_exit", "workspace", wsID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true, "workspace_id": wsID, "admin_override": false})
}

func (s *Server) adminAuditLogs(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	return s.auditLogs(w, r)
}

func (s *Server) adminUsage(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	q := r.URL.Query()
	to := s.today().AddDate(0, 0, 1)
	from := to.AddDate(0, 0, -30)
	if v, err := time.ParseInLocation("2006-01-02", q.Get("from"), s.loc); err == nil {
		from = v
	}
	if v, err := time.ParseInLocation("2006-01-02", q.Get("to"), s.loc); err == nil {
		to = v.AddDate(0, 0, 1)
	}
	groups := map[string]string{
		"day":       `to_char(c.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`,
		"task":      `c.task_type`,
		"model":     `c.provider || ' / ' || c.model`,
		"workspace": `coalesce(w.name, '（无工作区）')`,
		"account":   `coalesce(a.name, '（无账号）')`,
	}
	g := q.Get("group_by")
	expr, okG := groups[g]
	if !okG {
		g, expr = "day", groups["day"]
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+expr+` AS k, count(*), coalesce(sum(c.prompt_tokens),0), coalesce(sum(c.completion_tokens),0),
		count(*) FILTER (WHERE c.status<>'ok')
		FROM ai_call c
		LEFT JOIN platform_account a ON a.id=c.account_id
		LEFT JOIN workspace w ON w.id=a.workspace_id
		WHERE c.created_at >= $1 AND c.created_at < $2 GROUP BY k ORDER BY k`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	type Row struct {
		Key              string `json:"key"`
		Calls            int    `json:"calls"`
		PromptTokens     int    `json:"prompt_tokens"`
		CompletionTokens int    `json:"completion_tokens"`
		Failed           int    `json:"failed"`
	}
	list := []Row{}
	total := Row{Key: "合计"}
	for rows.Next() {
		var x Row
		if err := rows.Scan(&x.Key, &x.Calls, &x.PromptTokens, &x.CompletionTokens, &x.Failed); err != nil {
			return err
		}
		total.Calls += x.Calls
		total.PromptTokens += x.PromptTokens
		total.CompletionTokens += x.CompletionTokens
		total.Failed += x.Failed
		list = append(list, x)
	}
	return ok(w, map[string]any{
		"group_by": g,
		"from":     from.Format("2006-01-02"),
		"to":       to.AddDate(0, 0, -1).Format("2006-01-02"),
		"rows":     list,
		"total":    total,
	})
}

func (s *Server) adminGetSystemSettings(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	reg, err := s.systemBool(r.Context(), "registration_open", true)
	if err != nil {
		return err
	}
	maint, err := s.systemBool(r.Context(), "maintenance_mode", false)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"registration_open": reg, "maintenance_mode": maint})
}

func (s *Server) adminPutSystemSettings(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	var in struct {
		RegistrationOpen *bool `json:"registration_open"`
		MaintenanceMode  *bool `json:"maintenance_mode"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.RegistrationOpen == nil && in.MaintenanceMode == nil {
		return validation("请指定要修改的开关")
	}
	if in.RegistrationOpen != nil {
		if err := s.putSystemBool(r.Context(), "registration_open", *in.RegistrationOpen); err != nil {
			return err
		}
	}
	if in.MaintenanceMode != nil {
		if err := s.putSystemBool(r.Context(), "maintenance_mode", *in.MaintenanceMode); err != nil {
			return err
		}
	}
	s.audit(r.Context(), "admin_system_settings", "system", "", "ok", map[string]any{
		"registration_open": in.RegistrationOpen, "maintenance_mode": in.MaintenanceMode,
	})
	return s.adminGetSystemSettings(w, r)
}

// SetSystemAdmin is used by CLI grant-admin / revoke-admin.
func SetSystemAdmin(ctx context.Context, s *Server, username string, admin bool) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", errors.New("请指定用户名")
	}
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM app_user WHERE username=$1`, username).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("用户 %s 不存在", username)
	}
	if err != nil {
		return "", err
	}
	if !admin {
		if s.isPermanentAdminUsername(username) {
			return "", fmt.Errorf("账号 %s 是永久超级管理员，不能撤销", s.permanentAdminUsername())
		}
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM app_user WHERE is_system_admin AND id<>$1`, id).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return "", errors.New("至少保留一名系统超级管理员")
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE app_user SET is_system_admin=$2, updated_at=now() WHERE id=$1`, id, admin); err != nil {
		return "", err
	}
	return username, nil
}
