package app

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

type desktopDeviceInfo struct {
	ID         uuid.UUID  `json:"id"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	Version    string     `json:"version"`
	CreatedAt  time.Time  `json:"created_at"`
	LastSeenAt *time.Time `json:"last_seen_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
}

type desktopPolicy struct {
	WorkspaceID           uuid.UUID `json:"workspace_id"`
	Enabled               bool      `json:"enabled"`
	AllowMemberEndpoints  bool      `json:"allow_member_endpoints"`
	AuthorizationRevision int64     `json:"authorization_revision"`
}

// platformCollectionPolicy 是工作区级平台采集策略（20 文档 §8.2）。它与 desktop_ai_policy
// 分开存储、分开递增授权版本：关闭平台采集不影响桌面 AI，反之亦然。
type platformCollectionPolicy struct {
	WorkspaceID            uuid.UUID `json:"workspace_id"`
	Enabled                bool      `json:"enabled"`
	AllowMemberConnections bool      `json:"allow_member_connections"`
	AuthorizationRevision  int64     `json:"authorization_revision"`
	DailyRunLimit          int       `json:"daily_run_limit"`
	DailyWorkLimit         int       `json:"daily_work_limit"`
}

const (
	platformDefaultDailyRunLimit  = 3
	platformDefaultDailyWorkLimit = 60
)

func (s *Server) desktopCapabilities(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"protocol_version":       desktopProtocolVersion,
		"minimum_client_version": "1.0.0",
		"platforms":              []string{"windows-x64"},
		"limits": map[string]int{
			"chunk_bytes":        desktopChunkBytes,
			"max_request_bytes":  desktopMaxModelRequest,
			"max_response_bytes": desktopMaxModelResponse,
		},
		// 独立的平台采集能力。旧服务器没有该字段时客户端按“不支持”处理，
		// 不尝试调用任何 `/desktop/platform/*` 端点（20 文档 §11.1）。
		"platform_collection": map[string]any{
			"protocol_version": desktopPlatformProtocolVersion,
			"enabled":          s.platformCollectionGloballyEnabled(r.Context()),
			"platforms":        []string{"wechat_mp", "xhs"},
			"purpose":          desktopPlatformRegisterPurpose,
			"operations":       platformOperations,
			"limits": map[string]int{
				"challenge_per_minute": desktopPlatformChallengePerMin,
				"request_bytes":        desktopPlatformRequestBytes,
				"results_bytes":        desktopPlatformResultsBytes,
			},
		},
	})
}

// requireDesktopAccountSession validates only the user's online session. It is
// intentionally limited to listing/revoking the caller's own devices so these
// recovery actions still work after workspace membership is lost.
func (s *Server) requireDesktopAccountSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil || cookie.Value == "" {
			writeError(w, r, errUnauthenticated)
			return
		}
		id, err := s.loadDesktopAccountIdentity(r.Context(), cookie.Value)
		if err != nil {
			writeError(w, r, errUnauthenticated)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-CSRF-Token") != s.csrfToken(id.SessionID) {
			writeError(w, r, errCSRF)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxMember, id)))
	})
}

func (s *Server) loadDesktopAccountIdentity(ctx context.Context, token string) (*identity, error) {
	var id identity
	var expires time.Time
	var reauthUntil *time.Time
	var lastSeen time.Time
	var override bool
	var systemAdmin bool
	var disabledAt *time.Time
	var currentWorkspace uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT s.id, s.expires_at, s.reauth_until, s.last_seen_at,
		coalesce(s.admin_override,false), u.id, u.username, coalesce(u.is_system_admin,false),
		u.disabled_at, coalesce(s.current_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
		FROM session s JOIN app_user u ON u.id=s.user_id WHERE s.token_hash=$1`,
		secure.SHA256([]byte(token))).Scan(&id.SessionID, &expires, &reauthUntil, &lastSeen,
		&override, &id.UserID, &id.Username, &systemAdmin, &disabledAt, &currentWorkspace)
	if err != nil || !expires.After(s.now()) || disabledAt != nil {
		return nil, errUnauthenticated
	}
	id.sessionExpiresAt = expires
	id.lastSeen = lastSeen
	id.ReauthOK = reauthUntil != nil && reauthUntil.After(s.now())
	id.SystemAdmin = systemAdmin || s.isPermanentAdminUsername(id.Username)
	// Account-scoped device recovery always targets the authenticated account,
	// even if this session currently represents an admin override.
	id.AdminOverride = override && id.SystemAdmin
	id.WorkspaceID = currentWorkspace
	return &id, nil
}

func (s *Server) desktopListDevices(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	rows, err := s.db.Query(r.Context(), `SELECT id, name, platform, version, created_at, last_seen_at, revoked_at
		FROM desktop_device WHERE user_id=$1 ORDER BY created_at DESC, id`, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	devices := []desktopDeviceInfo{}
	for rows.Next() {
		var d desktopDeviceInfo
		if err := rows.Scan(&d.ID, &d.Name, &d.Platform, &d.Version, &d.CreatedAt, &d.LastSeenAt, &d.RevokedAt); err != nil {
			return err
		}
		devices = append(devices, d)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"devices":    devices,
		"csrf_token": s.csrfToken(id.SessionID),
		"reauth_ok":  id.ReauthOK,
	})
}

func (s *Server) desktopRevokeOwnDevice(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	deviceID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	if !id.ReauthOK {
		if in.Password == "" {
			return errReauth
		}
		if err := s.checkPassword(r.Context(), id.UserID, in.Password); err != nil {
			s.audit(r.Context(), "desktop_device_revoke", "desktop_device", deviceID.String(), "failed", nil)
			return err
		}
		if _, err := s.db.Exec(r.Context(), `UPDATE session SET reauth_until=$2 WHERE id=$1`, id.SessionID, s.now().Add(reauthWindow)); err != nil {
			return err
		}
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE desktop_device SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, deviceID, id.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE model_provider SET status='disabled', updated_at=now()
		WHERE execution_location='desktop' AND desktop_user_id=$1 AND desktop_device_id=$2`, id.UserID, deviceID); err != nil {
		return err
	}
	s.desktopRevokeDevice(id.UserID, deviceID)
	s.audit(r.Context(), "desktop_device_revoke", "desktop_device", deviceID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) desktopGetPolicy(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if id.AdminOverride {
		return apiErr(403, "desktop_ai_forbidden", "系统管理员代访问工作区不能使用桌面 AI")
	}
	policy, err := s.desktopPolicy(r.Context(), id.WorkspaceID)
	if err != nil {
		return err
	}
	policy.WorkspaceID = id.WorkspaceID
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"global_enabled": s.cfg.DesktopAIEnabled, "policy": policy})
}

func (s *Server) desktopPutPolicy(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if id.AdminOverride {
		return apiErr(403, "desktop_ai_forbidden", "系统管理员代访问工作区不能修改桌面 AI 策略")
	}
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	if err := s.requireReauth(r.Context()); err != nil {
		return err
	}
	var in struct {
		Enabled              bool `json:"enabled"`
		AllowMemberEndpoints bool `json:"allow_member_endpoints"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.AllowMemberEndpoints && !in.Enabled {
		return validation("关闭桌面 AI 时不能单独允许成员端点")
	}
	ws := id.WorkspaceID
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `INSERT INTO desktop_ai_policy (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, ws); err != nil {
		return err
	}
	var locked bool
	if err := tx.QueryRow(r.Context(), `SELECT true FROM desktop_ai_policy WHERE workspace_id=$1 FOR UPDATE`, ws).Scan(&locked); err != nil {
		return err
	}
	var revision int64
	if err := tx.QueryRow(r.Context(), `UPDATE desktop_ai_policy SET enabled=$2,
		allow_member_endpoints=$3, authorization_revision=authorization_revision+1,
		updated_by_user_id=$4, updated_at=now() WHERE workspace_id=$1 RETURNING authorization_revision`,
		ws, in.Enabled, in.AllowMemberEndpoints, id.UserID).Scan(&revision); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.desktopCancelWorkspace(ws)
	s.audit(r.Context(), "desktop_ai_policy_update", "desktop_ai_policy", ws.String(), "ok", map[string]any{
		"enabled": in.Enabled, "allow_member_endpoints": in.AllowMemberEndpoints,
		"authorization_revision": revision,
	})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, desktopPolicy{WorkspaceID: ws, Enabled: in.Enabled,
		AllowMemberEndpoints: in.AllowMemberEndpoints, AuthorizationRevision: revision})
}

func (s *Server) desktopPolicy(ctx context.Context, ws uuid.UUID) (desktopPolicy, error) {
	p := desktopPolicy{WorkspaceID: ws, AuthorizationRevision: 1}
	err := s.db.QueryRow(ctx, `SELECT enabled, allow_member_endpoints, authorization_revision
		FROM desktop_ai_policy WHERE workspace_id=$1`, ws).
		Scan(&p.Enabled, &p.AllowMemberEndpoints, &p.AuthorizationRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	return p, err
}

func (s *Server) platformCollectionPolicy(ctx context.Context, ws uuid.UUID) (platformCollectionPolicy, error) {
	p := platformCollectionPolicy{
		WorkspaceID: ws, AuthorizationRevision: 1,
		DailyRunLimit: platformDefaultDailyRunLimit, DailyWorkLimit: platformDefaultDailyWorkLimit,
	}
	err := s.db.QueryRow(ctx, `SELECT enabled, allow_member_connections, authorization_revision,
		daily_run_limit, daily_work_limit FROM platform_collection_policy WHERE workspace_id=$1`, ws).
		Scan(&p.Enabled, &p.AllowMemberConnections, &p.AuthorizationRevision, &p.DailyRunLimit, &p.DailyWorkLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	return p, err
}

// desktopRequirePlatformCollectionAccess 是平台采集的准入判断。全局开关来自进程配置，
// 工作区策略来自独立表；两者都必须开启，且角色须为 owner 或（owner 允许成员连接时的）editor。
func (s *Server) desktopRequirePlatformCollectionAccess(ctx context.Context, deviceID uuid.UUID) error {
	id := ident(ctx)
	if id == nil || id.AdminOverride {
		return apiErr(403, "forbidden", "当前身份不能使用平台数据采集")
	}
	// 进程配置与 DB 级 kill switch 叠加：任一关闭即停（§17.3）。
	if !s.platformCollectionGloballyEnabled(ctx) {
		return apiErr(403, "platform_collection_disabled", "服务端尚未启用平台数据采集")
	}
	policy, err := s.platformCollectionPolicy(ctx, id.WorkspaceID)
	if err != nil {
		return err
	}
	if !policy.Enabled {
		return apiErr(403, "platform_collection_disabled", "当前工作区尚未启用平台数据采集")
	}
	switch id.Role {
	case "owner":
	case "editor":
		if !policy.AllowMemberConnections {
			return apiErr(403, "forbidden", "工作区所有者未允许成员在本机连接平台账号")
		}
	default:
		return apiErr(403, "forbidden", "当前角色不能使用平台数据采集")
	}
	if deviceID != uuid.Nil {
		return s.desktopRequireOwnedDevice(ctx, deviceID)
	}
	return nil
}

func (s *Server) platformGetPolicy(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	policy, err := s.platformCollectionPolicy(r.Context(), id.WorkspaceID)
	if err != nil {
		return err
	}
	policy.WorkspaceID = id.WorkspaceID
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"global_enabled": s.platformCollectionGloballyEnabled(r.Context()),
		"gray":           s.platformGrayStatus(r.Context()),
		"policy":         policy,
	})
}

// platformPutPolicy 只接受固定键，并要求提交当前 authorization_revision 做版本比较：
// 策略曾被关闭再开启时，旧任务不能借旧版本继续（20 文档 §10.2）。
func (s *Server) platformPutPolicy(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if id.AdminOverride {
		return apiErr(403, "forbidden", "系统管理员代访问工作区不能修改平台采集策略")
	}
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	if err := s.requireReauth(r.Context()); err != nil {
		return err
	}
	var in struct {
		Enabled                bool  `json:"enabled"`
		AllowMemberConnections bool  `json:"allow_member_connections"`
		AuthorizationRevision  int64 `json:"authorization_revision"`
		DailyRunLimit          *int  `json:"daily_run_limit"`
		DailyWorkLimit         *int  `json:"daily_work_limit"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.AllowMemberConnections && !in.Enabled {
		return validation("关闭平台数据采集时不能单独允许成员连接")
	}
	runLimit, workLimit := platformDefaultDailyRunLimit, platformDefaultDailyWorkLimit
	if in.DailyRunLimit != nil {
		runLimit = *in.DailyRunLimit
	}
	if in.DailyWorkLimit != nil {
		workLimit = *in.DailyWorkLimit
	}
	if runLimit < 1 || runLimit > platformDefaultDailyRunLimit || workLimit < 1 || workLimit > platformDefaultDailyWorkLimit {
		return validation("每日预算只能下调：run 1～3 个、作品 1～60 篇")
	}
	ws := id.WorkspaceID
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `INSERT INTO platform_collection_policy (workspace_id) VALUES ($1)
		ON CONFLICT DO NOTHING`, ws); err != nil {
		return err
	}
	var current int64
	if err := tx.QueryRow(r.Context(), `SELECT authorization_revision FROM platform_collection_policy
		WHERE workspace_id=$1 FOR UPDATE`, ws).Scan(&current); err != nil {
		return err
	}
	if in.AuthorizationRevision != current {
		return apiErr(409, "platform_authorization_changed", "采集策略已被修改，请刷新后重试")
	}
	var revision int64
	if err := tx.QueryRow(r.Context(), `UPDATE platform_collection_policy SET enabled=$2,
		allow_member_connections=$3, daily_run_limit=$4, daily_work_limit=$5,
		authorization_revision=authorization_revision+1, updated_by_user_id=$6, updated_at=now()
		WHERE workspace_id=$1 RETURNING authorization_revision`,
		ws, in.Enabled, in.AllowMemberConnections, runLimit, workLimit, id.UserID).Scan(&revision); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.audit(r.Context(), "platform_collection_policy_update", "platform_collection_policy", ws.String(), "ok", map[string]any{
		"enabled": in.Enabled, "allow_member_connections": in.AllowMemberConnections,
		"daily_run_limit": runLimit, "daily_work_limit": workLimit,
		"authorization_revision": revision,
	})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, platformCollectionPolicy{WorkspaceID: ws, Enabled: in.Enabled,
		AllowMemberConnections: in.AllowMemberConnections, AuthorizationRevision: revision,
		DailyRunLimit: runLimit, DailyWorkLimit: workLimit})
}
