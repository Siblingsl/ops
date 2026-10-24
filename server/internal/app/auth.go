package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

const (
	sessionCookie   = "ops_session"
	sessionTTL      = 7 * 24 * time.Hour
	maxFailedLogins = 5
	lockDuration    = 15 * time.Minute
	reauthWindow    = 5 * time.Minute
	minPasswordLen  = 12
)

var baseSensitiveWords = []struct{ word, category string }{
	{"加微信", "导流"}, {"加V", "导流"}, {"私信领取", "导流"}, {"稳赚", "金融"}, {"保本", "金融"},
	{"躺赚", "金融"}, {"日入过万", "夸大收益"}, {"包过", "虚假承诺"}, {"根治", "医疗"}, {"特效药", "医疗"},
}

func validPassword(p string) error {
	if runeLen(p) < minPasswordLen {
		return validation("密码至少需要 12 位")
	}
	return nil
}

func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) error {
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM app_user`).Scan(&n); err != nil {
		return err
	}
	regOpen, _ := s.systemBool(r.Context(), "registration_open", true)
	maint, _ := s.systemBool(r.Context(), "maintenance_mode", false)
	return ok(w, map[string]any{
		"needs_setup": n == 0, "dev": s.cfg.Dev,
		"registration_open": regOpen, "maintenance_mode": maint,
	})
}

func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Username, Password string }
	if err := decode(r, &in); err != nil {
		return err
	}
	userID, wsID, err := s.createRegisteredUser(r.Context(), strings.TrimSpace(in.Username), in.Password, true)
	if err != nil {
		return err
	}
	if err := s.startSession(w, r, userID, wsID); err != nil {
		return err
	}
	s.audit(r.Context(), "setup", "user", userID.String(), "ok", map[string]any{"workspace_id": wsID.String()})
	return ok(w, map[string]any{"ok": true, "workspace_id": wsID})
}

func (s *Server) authRegister(w http.ResponseWriter, r *http.Request) error {
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM app_user`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		open, err := s.systemBool(r.Context(), "registration_open", true)
		if err != nil {
			return err
		}
		if !open {
			return apiErr(403, "registration_closed", "当前已关闭开放注册，请联系管理员")
		}
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Invite   string `json:"invite_code"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	userID, wsID, err := s.createRegisteredUser(r.Context(), strings.TrimSpace(in.Username), in.Password, false)
	if err != nil {
		return err
	}
	switchWS := wsID
	if code := strings.TrimSpace(in.Invite); code != "" {
		joined, err := s.consumeInvite(r.Context(), userID, code, true)
		if err != nil {
			return err
		}
		if joined != uuid.Nil {
			switchWS = joined
		}
	}
	if err := s.startSession(w, r, userID, switchWS); err != nil {
		return err
	}
	s.audit(r.Context(), "register", "user", userID.String(), "ok", map[string]any{"workspace_id": switchWS.String()})
	return ok(w, map[string]any{"ok": true, "workspace_id": switchWS})
}

// createRegisteredUser creates app_user + personal workspace + owner membership.
// setupOnly: reject if any user already exists (compat with POST /auth/setup).
func (s *Server) createRegisteredUser(ctx context.Context, username, password string, setupOnly bool) (userID, wsID uuid.UUID, err error) {
	if username == "" {
		return uuid.Nil, uuid.Nil, validation("请填写用户名")
	}
	if err := validPassword(password); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	hash, err := secure.HashPassword(password)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `LOCK TABLE app_user IN EXCLUSIVE MODE`); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if setupOnly {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM app_user`).Scan(&n); err != nil {
			return uuid.Nil, uuid.Nil, err
		}
		if n > 0 {
			return uuid.Nil, uuid.Nil, stateInvalid("系统已经设置过登录账号，请使用注册或登录")
		}
	}
	err = tx.QueryRow(ctx,
		`INSERT INTO app_user (username, password_hash, is_system_admin) VALUES ($1,$2,false) RETURNING id`,
		username, hash).Scan(&userID)
	if err != nil {
		if isUniqueViolation(err) {
			return uuid.Nil, uuid.Nil, validation("用户名已被使用")
		}
		return uuid.Nil, uuid.Nil, err
	}
	wsName := fmt.Sprintf("%s 的工作区", username)
	if err := tx.QueryRow(ctx,
		`INSERT INTO workspace (name, created_by_user_id) VALUES ($1,$2) RETURNING id`,
		wsName, userID).Scan(&wsID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ($1,$2,'owner','active')`,
		wsID, userID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	for _, sw := range baseSensitiveWords {
		if _, err := tx.Exec(ctx,
			`INSERT INTO sensitive_word (workspace_id, word, category, source) VALUES ($1,$2,$3,'base')`,
			wsID, sw.word, sw.category); err != nil {
			return uuid.Nil, uuid.Nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if s.cfg.Dev {
		_ = s.seedDevModelFor(ctx, wsID)
	}
	return userID, wsID, nil
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Invite   string `json:"invite_code"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var (
		id          uuid.UUID
		hash        string
		failed      int
		lockedUntil *time.Time
	)
	var disabledAt *time.Time
	err := s.db.QueryRow(ctx, `SELECT id, password_hash, failed_logins, locked_until, disabled_at FROM app_user WHERE username=$1`,
		strings.TrimSpace(in.Username)).Scan(&id, &hash, &failed, &lockedUntil, &disabledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		s.audit(ctx, "login_failed", "user", "", "failed", map[string]any{"ip": clientIP(r), "reason": "unknown_user"})
		return apiErr(401, "unauthenticated", "用户名或密码不正确")
	}
	if err != nil {
		return err
	}
	if disabledAt != nil {
		return apiErr(403, "account_disabled", "账号已被管理员禁用")
	}
	now := s.now()
	if lockedUntil != nil && lockedUntil.After(now) {
		return apiErr(429, "login_locked", "登录失败次数过多，请 15 分钟后再试。忘记密码请在服务器上执行重置命令。")
	}
	if !secure.VerifyPassword(in.Password, hash) {
		failed++
		var lock *time.Time
		if failed >= maxFailedLogins {
			t := now.Add(lockDuration)
			lock = &t
			failed = 0
		}
		if _, err := s.db.Exec(ctx, `UPDATE app_user SET failed_logins=$2, locked_until=$3 WHERE id=$1`, id, failed, lock); err != nil {
			return err
		}
		s.audit(ctx, "login_failed", "user", id.String(), "failed", map[string]any{"ip": clientIP(r)})
		if lock != nil {
			return apiErr(429, "login_locked", "登录失败次数过多，已锁定 15 分钟。忘记密码请在服务器上执行重置命令。")
		}
		return apiErr(401, "unauthenticated", "用户名或密码不正确")
	}
	if _, err := s.db.Exec(ctx, `UPDATE app_user SET failed_logins=0, locked_until=NULL,
		prev_login_at=last_login_at, prev_login_ip=last_login_ip, last_login_at=now(), last_login_ip=$2 WHERE id=$1`,
		id, clientIP(r)); err != nil {
		return err
	}
	wsID, err := s.pickWorkspace(ctx, id)
	if err != nil {
		return err
	}
	if code := strings.TrimSpace(in.Invite); code != "" {
		joined, err := s.consumeInvite(ctx, id, code, true)
		if err != nil {
			return err
		}
		if joined != uuid.Nil {
			wsID = joined
		}
	}
	if err := s.startSession(w, r, id, wsID); err != nil {
		return err
	}
	s.audit(ctx, "login", "user", id.String(), "ok", map[string]any{"ip": clientIP(r)})
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) pickWorkspace(ctx context.Context, userID uuid.UUID) (uuid.UUID, error) {
	var wsID uuid.UUID
	err := s.db.QueryRow(ctx, `
		SELECT workspace_id FROM workspace_member
		WHERE user_id=$1 AND status='active'
		ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at
		LIMIT 1`, userID).Scan(&wsID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, stateInvalid("你不属于任何工作区，请注册新建或使用邀请码加入")
	}
	return wsID, err
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID, workspaceID uuid.UUID) error {
	token := secure.RandomToken()
	expires := s.now().Add(sessionTTL)
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO session (user_id, current_workspace_id, token_hash, expires_at, user_agent, ip, reauth_until) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		userID, workspaceID, secure.SHA256([]byte(token)), expires, r.UserAgent(), clientIP(r), s.now().Add(reauthWindow)); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", Expires: expires,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 进程内分发器：不读 Cookie，改用 loadIdentityBySession（16 文档第 2.3 节「身份」第 3 项）。
		if p := agentPrincipalOf(r.Context()); p != nil {
			id, err := s.loadIdentityBySession(r.Context(), p.SessionID)
			if err != nil {
				writeError(w, r, errUnauthenticated)
				return
			}
			if id.WorkspaceID != p.WorkspaceID {
				writeError(w, r, stateInvalid("当前会话已切换到其他工作区，请回到原工作区继续"))
				return
			}
			// 内部请求的 ReauthOK 强制为 false（第 2.3 节「身份」第 4 项）。
			id.ReauthOK = false
			if trace, ok := r.Context().Value(requestTraceKey{}).(*requestTrace); ok {
				trace.WorkspaceID = id.WorkspaceID
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxMember, id)))
			return
		}
		c, err := r.Cookie(sessionCookie)
		if err != nil || c.Value == "" {
			writeError(w, r, errUnauthenticated)
			return
		}
		id, err := s.loadIdentity(r.Context(), c.Value)
		if err != nil {
			writeError(w, r, errUnauthenticated)
			return
		}
		if s.now().Sub(id.lastSeen) > time.Minute {
			_, _ = s.db.Exec(r.Context(), `UPDATE session SET last_seen_at=now() WHERE id=$1`, id.SessionID)
		}
		if trace, ok := r.Context().Value(requestTraceKey{}).(*requestTrace); ok {
			trace.WorkspaceID = id.WorkspaceID
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxMember, id)))
	})
}

// identitySelect 是 loadIdentity 与 loadIdentityBySession 共用的同一条查询。
const identitySelect = `
	SELECT s.id, s.expires_at, s.reauth_until, s.last_seen_at, coalesce(s.admin_override, false),
	       u.id, u.username, coalesce(u.is_system_admin, false), u.disabled_at,
	       s.current_workspace_id, wm.role
	FROM session s
	JOIN app_user u ON u.id = s.user_id
	LEFT JOIN workspace_member wm ON wm.user_id = u.id AND wm.workspace_id = s.current_workspace_id AND wm.status = 'active'
	WHERE %s=$1`

func (s *Server) loadIdentity(ctx context.Context, token string) (*identity, error) {
	return s.scanIdentity(ctx, "s.token_hash", secure.SHA256([]byte(token)), true)
}

// loadIdentityBySession 与 loadIdentity 共用同一条查询，条件改为 s.id=$1；
// 在「当前工作区成员资格丢失」时直接返回 errUnauthenticated，不执行切换工作区的写入。
func (s *Server) loadIdentityBySession(ctx context.Context, sessionID uuid.UUID) (*identity, error) {
	return s.scanIdentity(ctx, "s.id", sessionID, false)
}

func (s *Server) scanIdentity(ctx context.Context, column string, arg any, allowSwitch bool) (*identity, error) {
	var (
		id          identity
		expires     time.Time
		reauthUntil *time.Time
		lastSeen    time.Time
		override    bool
		sysAdmin    bool
		disabledAt  *time.Time
		role        *string
	)
	err := s.db.QueryRow(ctx, fmt.Sprintf(identitySelect, column), arg).Scan(
		&id.SessionID, &expires, &reauthUntil, &lastSeen, &override,
		&id.UserID, &id.Username, &sysAdmin, &disabledAt,
		&id.WorkspaceID, &role)
	if err != nil || expires.Before(s.now()) {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errUnauthenticated
		}
		if err != nil {
			return nil, errUnauthenticated
		}
		return nil, errUnauthenticated
	}
	if disabledAt != nil {
		return nil, errUnauthenticated
	}
	id.SystemAdmin = sysAdmin || s.isPermanentAdminUsername(id.Username)
	id.AdminOverride = override && id.SystemAdmin
	id.ReauthOK = reauthUntil != nil && reauthUntil.After(s.now())
	id.sessionExpiresAt = expires
	id.lastSeen = lastSeen

	if id.AdminOverride {
		// Super admin visiting a workspace without membership — act as owner.
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace WHERE id=$1)`, id.WorkspaceID).Scan(&exists); err != nil || !exists {
			return nil, errUnauthenticated
		}
		id.Role = "owner"
		return &id, nil
	}

	if role != nil {
		id.Role = *role
		return &id, nil
	}

	if !allowSwitch {
		// 智能体分发：成员资格丢失时运行必须停止，不做任何会话写入。
		return nil, errUnauthenticated
	}

	// Membership lost for current workspace — clear override and switch to another.
	if _, err := s.db.Exec(ctx, `UPDATE session SET admin_override=false WHERE id=$1`, id.SessionID); err != nil {
		return nil, err
	}
	wsID, err3 := s.pickWorkspace(ctx, id.UserID)
	if err3 != nil {
		return nil, errUnauthenticated
	}
	if _, err := s.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, id.SessionID, wsID); err != nil {
		return nil, err
	}
	var memberRole string
	if err := s.db.QueryRow(ctx, `SELECT role FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
		wsID, id.UserID).Scan(&memberRole); err != nil {
		return nil, errUnauthenticated
	}
	id.WorkspaceID = wsID
	id.Role = memberRole
	id.AdminOverride = false
	return &id, nil
}

func (s *Server) csrfToken(sessionID uuid.UUID) string {
	return s.box.HMAC("csrf:" + sessionID.String())
}

func (s *Server) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 有 agentPrincipal 时跳过 CSRF 比对：CSRF 保护的是浏览器请求（16 文档第 2.3 节「身份」第 5 项）。
		if agentPrincipalOf(r.Context()) != nil {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-CSRF-Token") != s.csrfToken(ident(r.Context()).SessionID) {
				writeError(w, r, errCSRF)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireReauth(ctx context.Context) error {
	if !ident(ctx).ReauthOK {
		return errReauth
	}
	return nil
}

func (s *Server) requireOwner(ctx context.Context) error {
	id := ident(ctx)
	if id == nil {
		return errUnauthorized
	}
	if id.AdminOverride && id.SystemAdmin {
		return nil
	}
	if id.Role != "owner" {
		return apiErr(403, "forbidden", "需要工作区所有者权限")
	}
	return nil
}

func (s *Server) requireSystemAdmin(ctx context.Context) error {
	id := ident(ctx)
	if id == nil || !id.SystemAdmin {
		return apiErr(403, "forbidden", "需要系统超级管理员权限")
	}
	return nil
}

// requireEditor blocks viewer (read-only) from mutating content. owner and editor pass.
func (s *Server) requireEditor(ctx context.Context) error {
	id := ident(ctx)
	if id == nil {
		return errUnauthorized
	}
	if id.AdminOverride && id.SystemAdmin {
		return nil
	}
	if id.Role == "viewer" {
		return apiErr(403, "forbidden", "观察者仅可浏览，不能修改内容")
	}
	if id.Role != "owner" && id.Role != "editor" {
		return apiErr(403, "forbidden", "需要编辑权限")
	}
	return nil
}

// blockMaintenance rejects authenticated non-admin traffic while maintenance_mode is on.
func (s *Server) blockMaintenance(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := ident(r.Context())
		if id != nil && id.SystemAdmin {
			next.ServeHTTP(w, r)
			return
		}
		path := r.URL.Path
		if path == "/api/v1/auth/me" || path == "/api/v1/auth/logout" {
			next.ServeHTTP(w, r)
			return
		}
		on, err := s.systemBool(r.Context(), "maintenance_mode", false)
		if err != nil {
			writeError(w, r, err)
			return
		}
		if on {
			writeError(w, r, apiErr(503, "maintenance", "系统维护中，请稍后再试"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// blockViewerWrites rejects mutating HTTP methods for viewers except allowlisted auth/workspace paths.
func (s *Server) blockViewerWrites(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		id := ident(r.Context())
		if id == nil || id.Role != "viewer" {
			next.ServeHTTP(w, r)
			return
		}
		if viewerMutateAllowed(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		writeError(w, r, apiErr(403, "forbidden", "观察者仅可浏览，不能修改内容"))
	})
}

func viewerMutateAllowed(path string) bool {
	switch path {
	case "/api/v1/auth/logout", "/api/v1/auth/reauth", "/api/v1/auth/renew", "/api/v1/auth/password",
		"/api/v1/workspaces", "/api/v1/workspaces/join", "/api/v1/workspaces/current/leave",
		"/api/v1/notifications/read-all", "/api/v1/me/preferences", "/api/v1/stars", "/api/v1/ux-events", "/api/v1/client-errors":
		return true
	}
	// POST /api/v1/workspaces/{id}/switch
	if strings.HasPrefix(path, "/api/v1/workspaces/") && strings.HasSuffix(path, "/switch") {
		return true
	}
	// 个人状态：通知已读、星标、在线状态
	if strings.HasPrefix(path, "/api/v1/notifications/") && strings.HasSuffix(path, "/read") {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/stars/") {
		return true
	}
	// 批注不改正文，viewer 可写（EX-L-01）
	if strings.HasPrefix(path, "/api/v1/works/") && (strings.HasSuffix(path, "/comments") || strings.HasSuffix(path, "/presence")) {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/comments/") {
		return true
	}
	// 智能体（D-117 / 16 文档第 9.2 节第 1 项）：观察者可管理自己的对话与附件；
	// POST /agent/actions/{id}/execute 不加入白名单，观察者也不会收到卡片。
	if path == "/api/v1/agent/conversations" || path == "/api/v1/agent/attachments" {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/agent/conversations/") || strings.HasPrefix(path, "/api/v1/agent/attachments/") {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/agent/runs/") && strings.HasSuffix(path, "/cancel") {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/agent/actions/") && strings.HasSuffix(path, "/reject") {
		return true
	}
	// DEV-SK1 / 23 文档第 10.2 节：viewer 精确豁免，仅把请求送入服务层，
	// 由 handler 再校验“仅本人 personal”；技能草拟（/skills/draft）不豁免。
	if path == "/api/v1/skills/parse" || path == "/api/v1/skills" {
		return true
	}
	if rest, ok := strings.CutPrefix(path, "/api/v1/skills/"); ok && !strings.Contains(rest, "/") {
		// PUT/DELETE /skills/{uuid}：uuid 段后无更多路径；export/impact 为 GET 不经此处。
		if _, err := uuid.Parse(rest); err == nil {
			return true
		}
	}
	if rest, ok := strings.CutPrefix(path, "/api/v1/accounts/"); ok {
		// PUT /accounts/{uuid}/skill-bindings/{audience}/{skillUuid}
		if i := strings.Index(rest, "/skill-bindings/"); i > 0 {
			tail := rest[i+len("/skill-bindings/"):]
			parts := strings.Split(tail, "/")
			if len(parts) == 2 {
				if _, err := uuid.Parse(rest[:i]); err == nil {
					if _, err := uuid.Parse(parts[1]); err == nil {
						return true
					}
				}
			}
		}
	}
	return false
}

func (s *Server) authMe(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	var prevAt *time.Time
	var prevIP *string
	if err := s.db.QueryRow(r.Context(), `SELECT prev_login_at, prev_login_ip FROM app_user WHERE id=$1`, id.UserID).
		Scan(&prevAt, &prevIP); err != nil {
		return err
	}
	var wsName string
	_ = s.db.QueryRow(r.Context(), `SELECT name FROM workspace WHERE id=$1`, id.WorkspaceID).Scan(&wsName)
	workspaces, err := s.listUserWorkspaces(r.Context(), id.UserID)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"username":           id.Username,
		"user_id":            id.UserID,
		"role":               id.Role,
		"is_system_admin":    id.SystemAdmin,
		"admin_override":     id.AdminOverride,
		"csrf_token":         s.csrfToken(id.SessionID),
		"session_expires_at": id.sessionExpiresAt,
		"reauth_ok":          id.ReauthOK,
		"prev_login_at":      prevAt,
		"prev_login_ip":      prevIP,
		"dev":                s.cfg.Dev,
		"workspace": map[string]any{
			"id":   id.WorkspaceID,
			"name": wsName,
			"role": id.Role,
		},
		"workspaces": workspaces,
	})
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE id=$1`, ident(r.Context()).SessionID); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) checkPassword(ctx context.Context, userID uuid.UUID, password string) error {
	var hash string
	if err := s.db.QueryRow(ctx, `SELECT password_hash FROM app_user WHERE id=$1`, userID).Scan(&hash); err != nil {
		return err
	}
	if !secure.VerifyPassword(password, hash) {
		return validation("密码不正确")
	}
	return nil
}

func (s *Server) authReauth(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Password string }
	if err := decode(r, &in); err != nil {
		return err
	}
	id := ident(r.Context())
	if err := s.checkPassword(r.Context(), id.UserID, in.Password); err != nil {
		s.audit(r.Context(), "reauth", "user", id.UserID.String(), "failed", nil)
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE session SET reauth_until=$2 WHERE id=$1`, id.SessionID, s.now().Add(reauthWindow)); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true, "valid_seconds": int(reauthWindow.Seconds())})
}

// authRenewSession renews the current authenticated session only after an explicit password check.
// It keeps the session token and CSRF binding stable while resetting the fixed lifetime to seven days.
func (s *Server) authRenewSession(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Password string }
	if err := decode(r, &in); err != nil {
		return err
	}
	id := ident(r.Context())
	if err := s.checkPassword(r.Context(), id.UserID, in.Password); err != nil {
		s.audit(r.Context(), "session_renewal", "user", id.UserID.String(), "failed", nil)
		return err
	}
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie.Value == "" {
		return errUnauthenticated
	}
	now := s.now()
	expires := now.Add(sessionTTL)
	result, err := s.db.Exec(r.Context(), `UPDATE session SET expires_at=$2, reauth_until=$3, last_seen_at=$4 WHERE id=$1`,
		id.SessionID, expires, now.Add(reauthWindow), now)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errUnauthenticated
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: cookie.Value, Path: "/", Expires: expires,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	s.audit(r.Context(), "session_renewal", "user", id.UserID.String(), "ok", map[string]any{"expires_at": expires})
	return ok(w, map[string]any{"ok": true, "session_expires_at": expires})
}

func (s *Server) authChangePassword(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	id := ident(r.Context())
	if err := s.checkPassword(r.Context(), id.UserID, in.OldPassword); err != nil {
		return validation("当前密码不正确")
	}
	if err := validPassword(in.NewPassword); err != nil {
		return err
	}
	hash, err := secure.HashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE app_user SET password_hash=$2, updated_at=now() WHERE id=$1`, id.UserID, hash); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE user_id=$1 AND id<>$2`, id.UserID, id.SessionID); err != nil {
		return err
	}
	s.audit(r.Context(), "password_change", "user", id.UserID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// ResetPassword resets a user's password by username (FR-M1-08 / D-036).
func ResetPassword(ctx context.Context, srv *Server, username, password string) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", errors.New("请指定用户名：ops reset-password <username>")
	}
	if err := validPassword(password); err != nil {
		return "", errors.New("密码至少需要 12 位")
	}
	hash, err := secure.HashPassword(password)
	if err != nil {
		return "", err
	}
	var id uuid.UUID
	err = srv.db.QueryRow(ctx, `UPDATE app_user SET password_hash=$1, failed_logins=0, locked_until=NULL, updated_at=now()
		WHERE username=$2 RETURNING id`, hash, username).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("用户 %s 不存在", username)
	}
	if err != nil {
		return "", err
	}
	if _, err := srv.db.Exec(ctx, `DELETE FROM session WHERE user_id=$1`, id); err != nil {
		return "", err
	}
	srv.audit(ctx, "password_reset_cli", "user", id.String(), "ok", nil)
	return username, nil
}
