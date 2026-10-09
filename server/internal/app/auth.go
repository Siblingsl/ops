package app

import (
	"context"
	"errors"
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
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM member`).Scan(&n); err != nil {
		return err
	}
	return ok(w, map[string]any{"needs_setup": n == 0, "dev": s.cfg.Dev})
}

func (s *Server) authSetup(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Username, Password string }
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Username = strings.TrimSpace(in.Username)
	if in.Username == "" {
		return validation("请填写用户名")
	}
	if err := validPassword(in.Password); err != nil {
		return err
	}
	hash, err := secure.HashPassword(in.Password)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `LOCK TABLE member IN EXCLUSIVE MODE`); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM member`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return stateInvalid("系统已经设置过登录账号")
	}
	var wsID, memberID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO workspace (name) VALUES ('我的工作区') RETURNING id`).Scan(&wsID); err != nil {
		return err
	}
	if err := tx.QueryRow(r.Context(),
		`INSERT INTO member (workspace_id, username, password_hash) VALUES ($1,$2,$3) RETURNING id`,
		wsID, in.Username, hash).Scan(&memberID); err != nil {
		return err
	}
	for _, sw := range baseSensitiveWords {
		if _, err := tx.Exec(r.Context(),
			`INSERT INTO sensitive_word (workspace_id, word, category, source) VALUES ($1,$2,$3,'base')`,
			wsID, sw.word, sw.category); err != nil {
			return err
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	if err := s.startSession(w, r, memberID); err != nil {
		return err
	}
	s.audit(r.Context(), "setup", "member", memberID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) authLogin(w http.ResponseWriter, r *http.Request) error {
	var in struct{ Username, Password string }
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
	err := s.db.QueryRow(ctx, `SELECT id, password_hash, failed_logins, locked_until FROM member WHERE username=$1`,
		strings.TrimSpace(in.Username)).Scan(&id, &hash, &failed, &lockedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		s.audit(ctx, "login_failed", "member", "", "failed", map[string]any{"ip": clientIP(r), "reason": "unknown_user"})
		return apiErr(401, "unauthenticated", "用户名或密码不正确")
	}
	if err != nil {
		return err
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
		if _, err := s.db.Exec(ctx, `UPDATE member SET failed_logins=$2, locked_until=$3 WHERE id=$1`, id, failed, lock); err != nil {
			return err
		}
		s.audit(ctx, "login_failed", "member", id.String(), "failed", map[string]any{"ip": clientIP(r)})
		if lock != nil {
			return apiErr(429, "login_locked", "登录失败次数过多，已锁定 15 分钟。忘记密码请在服务器上执行重置命令。")
		}
		return apiErr(401, "unauthenticated", "用户名或密码不正确")
	}
	if _, err := s.db.Exec(ctx, `UPDATE member SET failed_logins=0, locked_until=NULL,
		prev_login_at=last_login_at, prev_login_ip=last_login_ip, last_login_at=now(), last_login_ip=$2 WHERE id=$1`,
		id, clientIP(r)); err != nil {
		return err
	}
	if err := s.startSession(w, r, id); err != nil {
		return err
	}
	s.audit(ctx, "login", "member", id.String(), "ok", map[string]any{"ip": clientIP(r)})
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, memberID uuid.UUID) error {
	token := secure.RandomToken()
	expires := s.now().Add(sessionTTL)
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO session (member_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`,
		memberID, secure.SHA256([]byte(token)), expires, r.UserAgent(), clientIP(r)); err != nil {
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
		c, err := r.Cookie(sessionCookie)
		if err != nil || c.Value == "" {
			writeError(w, r, errUnauthenticated)
			return
		}
		var (
			id          identity
			expires     time.Time
			reauthUntil *time.Time
			lastSeen    time.Time
		)
		err = s.db.QueryRow(r.Context(), `SELECT s.id, s.expires_at, s.reauth_until, s.last_seen_at, m.id, m.workspace_id, m.username
			FROM session s JOIN member m ON m.id = s.member_id WHERE s.token_hash=$1`,
			secure.SHA256([]byte(c.Value))).Scan(&id.SessionID, &expires, &reauthUntil, &lastSeen, &id.MemberID, &id.WorkspaceID, &id.Username)
		if err != nil || expires.Before(s.now()) {
			writeError(w, r, errUnauthenticated)
			return
		}
		id.ReauthOK = reauthUntil != nil && reauthUntil.After(s.now())
		if s.now().Sub(lastSeen) > time.Minute {
			_, _ = s.db.Exec(r.Context(), `UPDATE session SET last_seen_at=now() WHERE id=$1`, id.SessionID)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxMember, &id)))
	})
}

func (s *Server) csrfToken(sessionID uuid.UUID) string {
	return s.box.HMAC("csrf:" + sessionID.String())
}

func (s *Server) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

func (s *Server) authMe(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	var prevAt *time.Time
	var prevIP *string
	if err := s.db.QueryRow(r.Context(), `SELECT prev_login_at, prev_login_ip FROM member WHERE id=$1`, id.MemberID).
		Scan(&prevAt, &prevIP); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"username":      id.Username,
		"csrf_token":    s.csrfToken(id.SessionID),
		"reauth_ok":     id.ReauthOK,
		"prev_login_at": prevAt,
		"prev_login_ip": prevIP,
		"dev":           s.cfg.Dev,
	})
}

func (s *Server) authLogout(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE id=$1`, ident(r.Context()).SessionID); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) checkPassword(ctx context.Context, memberID uuid.UUID, password string) error {
	var hash string
	if err := s.db.QueryRow(ctx, `SELECT password_hash FROM member WHERE id=$1`, memberID).Scan(&hash); err != nil {
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
	if err := s.checkPassword(r.Context(), id.MemberID, in.Password); err != nil {
		s.audit(r.Context(), "reauth", "member", id.MemberID.String(), "failed", nil)
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE session SET reauth_until=$2 WHERE id=$1`, id.SessionID, s.now().Add(reauthWindow)); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true, "valid_seconds": int(reauthWindow.Seconds())})
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
	if err := s.checkPassword(r.Context(), id.MemberID, in.OldPassword); err != nil {
		return validation("当前密码不正确")
	}
	if err := validPassword(in.NewPassword); err != nil {
		return err
	}
	hash, err := secure.HashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE member SET password_hash=$2, updated_at=now() WHERE id=$1`, id.MemberID, hash); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM session WHERE member_id=$1 AND id<>$2`, id.MemberID, id.SessionID); err != nil {
		return err
	}
	s.audit(r.Context(), "password_change", "member", id.MemberID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// ResetPassword is used by the `ops reset-password` command (06 文档第 5.9 节).
func ResetPassword(ctx context.Context, srv *Server, password string) (string, error) {
	if err := validPassword(password); err != nil {
		return "", errors.New("密码至少需要 12 位")
	}
	hash, err := secure.HashPassword(password)
	if err != nil {
		return "", err
	}
	var id uuid.UUID
	var username string
	err = srv.db.QueryRow(ctx, `UPDATE member SET password_hash=$1, failed_logins=0, locked_until=NULL, updated_at=now()
		WHERE id=(SELECT id FROM member ORDER BY created_at LIMIT 1) RETURNING id, username`, hash).Scan(&id, &username)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errors.New("系统还没有设置登录账号，请在浏览器中完成首次设置")
	}
	if err != nil {
		return "", err
	}
	if _, err := srv.db.Exec(ctx, `DELETE FROM session WHERE member_id=$1`, id); err != nil {
		return "", err
	}
	srv.audit(ctx, "password_reset_cli", "member", id.String(), "ok", nil)
	return username, nil
}
