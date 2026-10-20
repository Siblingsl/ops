package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 平台连接（20 文档 §8.1）：网页通路的授权与设备归属。
// 与 AI 的 desktop_connection 是两套实体，命名与语义都不复用。

type platformConnection struct {
	ID                     uuid.UUID  `json:"id"`
	WorkspaceID            uuid.UUID  `json:"workspace_id"`
	AccountID              uuid.UUID  `json:"account_id"`
	Platform               string     `json:"platform"`
	UserID                 uuid.UUID  `json:"user_id"`
	DeviceID               uuid.UUID  `json:"device_id"`
	ExternalAccountKey     string     `json:"external_account_key"`
	State                  string     `json:"state"`
	Availability           string     `json:"availability"`
	AuthorizationRevision  int64      `json:"authorization_revision"`
	AdoptionRevision       int64      `json:"adoption_revision"`
	AutoCollect            bool       `json:"auto_collect"`
	AutoAdopt              bool       `json:"auto_adopt"`
	LastVerifiedAt         *time.Time `json:"last_verified_at"`
	LastSeenAt             *time.Time `json:"last_seen_at"`
	NextDueAt              *time.Time `json:"next_due_at"`
	FailureCount           int        `json:"failure_count"`
	PlatformConsentVersion int        `json:"platform_consent_version"`
	ConsentedAt            *time.Time `json:"consented_at"`
	CreatedAt              time.Time  `json:"created_at"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

// platformExternalKeyKinds 是允许的身份种类前缀，与迁移中的 CHECK 保持一致。
var platformExternalKeyKinds = map[string]string{"wechat_mp": "wechat_biz:", "xhs": "xhs_user_id:"}

// normalizeExternalAccountKey 校验「身份种类:值」并确认种类与平台匹配：
// 不同身份种类的值即使文本相同也不能视为相等（§8.1）。
func normalizeExternalAccountKey(platform, key string) (string, error) {
	prefix, ok := platformExternalKeyKinds[platform]
	if !ok {
		return "", apiErr(422, "platform_not_supported", "该平台暂不支持本机登录采集")
	}
	trimmed := strings.TrimSpace(key)
	if !strings.HasPrefix(trimmed, prefix) {
		return "", validation("外部账号标识的身份种类与平台不匹配")
	}
	if len(strings.TrimPrefix(trimmed, prefix)) == 0 {
		return "", validation("外部账号标识缺少账号值")
	}
	return trimmed, nil
}

// createPlatformConnection 是 POST /desktop/platform/connections 的核心：一次只建一个账号的连接。
// 已经存在未撤销连接返回 409 并带冲突对象摘要，不能 ORDER BY ... LIMIT 1 静默选一条。
func (s *Server) createPlatformConnection(ctx context.Context, tx pgx.Tx, workspaceID, accountID, userID, deviceID uuid.UUID, externalAccountKey string, consentVersion int) (platformConnection, error) {
	var c platformConnection
	var platform string
	if err := tx.QueryRow(ctx, `SELECT platform FROM platform_account WHERE id=$1 AND workspace_id=$2`,
		accountID, workspaceID).Scan(&platform); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c, errNotFound
		}
		return c, err
	}
	key, err := normalizeExternalAccountKey(platform, externalAccountKey)
	if err != nil {
		return c, err
	}
	// paused 仍占主连接：换设备必须先转移或撤销，不能靠再建一条绕过。
	var existingID uuid.UUID
	var existingState string
	err = tx.QueryRow(ctx, `SELECT id, state FROM platform_connection
		WHERE account_id=$1 AND state<>'revoked' LIMIT 1`, accountID).Scan(&existingID, &existingState)
	if err == nil {
		return c, apiErr(409, "platform_connection_conflict", "该账号已有未撤销的平台连接").
			With(map[string]any{"connection_id": existingID, "state": existingState})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return c, err
	}
	// 同工作区同平台同一外部账号也只能有一条活动连接。
	err = tx.QueryRow(ctx, `SELECT id, state FROM platform_connection
		WHERE workspace_id=$1 AND platform=$2 AND external_account_key=$3 AND state<>'revoked' LIMIT 1`,
		workspaceID, platform, key).Scan(&existingID, &existingState)
	if err == nil {
		return c, apiErr(409, "platform_connection_conflict", "该平台账号在本工作区已有未撤销的连接").
			With(map[string]any{"connection_id": existingID, "state": existingState})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return c, err
	}

	// 新连接一律从待验证开始：只有完成身份核对并通过用户确认后才可能变成 ready。
	err = tx.QueryRow(ctx, `INSERT INTO platform_connection (
			workspace_id, account_id, platform, user_id, device_id, external_account_key,
			state, availability, platform_consent_version, consented_at)
		VALUES ($1,$2,$3,$4,$5,$6,'active','verifying',$7,now())
		RETURNING id, workspace_id, account_id, platform, user_id, device_id, external_account_key,
			state, availability, authorization_revision, adoption_revision, auto_collect, auto_adopt,
			last_verified_at, last_seen_at, next_due_at, failure_count, platform_consent_version,
			consented_at, created_at, updated_at`,
		workspaceID, accountID, platform, userID, deviceID, key, consentVersion).Scan(
		&c.ID, &c.WorkspaceID, &c.AccountID, &c.Platform, &c.UserID, &c.DeviceID, &c.ExternalAccountKey,
		&c.State, &c.Availability, &c.AuthorizationRevision, &c.AdoptionRevision, &c.AutoCollect, &c.AutoAdopt,
		&c.LastVerifiedAt, &c.LastSeenAt, &c.NextDueAt, &c.FailureCount, &c.PlatformConsentVersion,
		&c.ConsentedAt, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

// verifyPlatformConnection 绑定真实平台身份与能力快照。身份冲突返回 409，不覆盖原身份；
// 验证成功只是把可用性推进到 ready，不因此自动开启 auto_collect/auto_adopt。
func (s *Server) verifyPlatformConnection(ctx context.Context, tx pgx.Tx, connectionID, workspaceID uuid.UUID, userID uuid.UUID, externalAccountKey string, capabilities map[string]any) (platformConnection, error) {
	var c platformConnection
	var currentKey, state string
	err := tx.QueryRow(ctx, `SELECT external_account_key, state FROM platform_connection
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		connectionID, workspaceID, userID).Scan(&currentKey, &state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c, errNotFound
		}
		return c, err
	}
	if state == "revoked" {
		return c, apiErr(403, "platform_collection_disabled", "该连接已撤销")
	}
	key, err := normalizeExternalAccountKey(statePlatform(ctx, tx, connectionID), externalAccountKey)
	if err != nil {
		return c, err
	}
	if currentKey != key {
		// 平台内换了账号：不迁移旧作品与绑定，也不自动覆盖连接身份。
		return c, apiErr(409, "platform_identity_mismatch", "当前登录的平台账号与已连接账号不一致")
	}
	caps, err := json.Marshal(capabilities)
	if err != nil {
		return c, err
	}
	err = tx.QueryRow(ctx, `UPDATE platform_connection SET availability='ready', capabilities=$2,
		last_verified_at=now(), updated_at=now() WHERE id=$1
		RETURNING id, workspace_id, account_id, platform, user_id, device_id, external_account_key,
			state, availability, authorization_revision, adoption_revision, auto_collect, auto_adopt,
			last_verified_at, last_seen_at, next_due_at, failure_count, platform_consent_version,
			consented_at, created_at, updated_at`,
		connectionID, caps).Scan(
		&c.ID, &c.WorkspaceID, &c.AccountID, &c.Platform, &c.UserID, &c.DeviceID, &c.ExternalAccountKey,
		&c.State, &c.Availability, &c.AuthorizationRevision, &c.AdoptionRevision, &c.AutoCollect, &c.AutoAdopt,
		&c.LastVerifiedAt, &c.LastSeenAt, &c.NextDueAt, &c.FailureCount, &c.PlatformConsentVersion,
		&c.ConsentedAt, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

func statePlatform(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID) string {
	var platform string
	_ = tx.QueryRow(ctx, `SELECT platform FROM platform_connection WHERE id=$1`, connectionID).Scan(&platform)
	return platform
}

// revokePlatformConnection 是撤销连接的唯一权威行更新：递增授权版本，让旧任务与旧结果全部失效。
func (s *Server) revokePlatformConnection(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID, reason string) error {
	tag, err := tx.Exec(ctx, `UPDATE platform_connection SET state='revoked',
		auto_collect=false, auto_adopt=false, next_due_at=NULL,
		authorization_revision=authorization_revision+1, updated_at=now()
		WHERE id=$1 AND state<>'revoked'`, connectionID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	// 撤销后不再产生新的业务结果：未结束的任务一并取消。
	_, err = tx.Exec(ctx, `UPDATE platform_sync_run SET status='canceled', cancel_requested_at=now(),
		finished_at=now()
		WHERE connection_id=$1 AND status IN ('queued','leased','running')`, connectionID)
	return err
}

// listOwnedPlatformConnections 是账户级回收清单：不依赖工作区成员资格，
// 只按真实登录用户与其设备归属查询。
func (s *Server) listOwnedPlatformConnections(ctx context.Context, userID uuid.UUID) ([]platformConnection, error) {
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id, account_id, platform, user_id, device_id,
		external_account_key, state, availability, authorization_revision, adoption_revision,
		auto_collect, auto_adopt, last_verified_at, last_seen_at, next_due_at, failure_count,
		platform_consent_version, consented_at, created_at, updated_at
		FROM platform_connection WHERE user_id=$1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []platformConnection{}
	for rows.Next() {
		var c platformConnection
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.AccountID, &c.Platform, &c.UserID, &c.DeviceID,
			&c.ExternalAccountKey, &c.State, &c.Availability, &c.AuthorizationRevision, &c.AdoptionRevision,
			&c.AutoCollect, &c.AutoAdopt, &c.LastVerifiedAt, &c.LastSeenAt, &c.NextDueAt, &c.FailureCount,
			&c.PlatformConsentVersion, &c.ConsentedAt, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, c)
	}
	return list, rows.Err()
}

// platformConnectionForAccount 返回接口使用的连接摘要，供 §11.2 的读接口复用。
// 不存在时返回 pgx.ErrNoRows，由调用方映射为 404。
func (s *Server) platformConnectionForAccount(ctx context.Context, workspaceID, accountID uuid.UUID) (platformConnection, error) {
	var c platformConnection
	err := s.db.QueryRow(ctx, `SELECT id, workspace_id, account_id, platform, user_id, device_id,
		external_account_key, state, availability, authorization_revision, adoption_revision,
		auto_collect, auto_adopt, last_verified_at, last_seen_at, next_due_at, failure_count,
		platform_consent_version, consented_at, created_at, updated_at
		FROM platform_connection WHERE workspace_id=$1 AND account_id=$2 AND state<>'revoked'`,
		workspaceID, accountID).Scan(&c.ID, &c.WorkspaceID, &c.AccountID, &c.Platform, &c.UserID, &c.DeviceID,
		&c.ExternalAccountKey, &c.State, &c.Availability, &c.AuthorizationRevision, &c.AdoptionRevision,
		&c.AutoCollect, &c.AutoAdopt, &c.LastVerifiedAt, &c.LastSeenAt, &c.NextDueAt, &c.FailureCount,
		&c.PlatformConsentVersion, &c.ConsentedAt, &c.CreatedAt, &c.UpdatedAt)
	return c, err
}

// requireAccountInWorkspace 确认账号属于当前工作区，否则按既有 404 语义拒绝。
func (s *Server) requireAccountInWorkspace(ctx context.Context, accountID uuid.UUID) error {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_account
		WHERE id=$1 AND workspace_id=$2)`, accountID, ident(ctx).WorkspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	return nil
}

// platformConnectionSummary 是页面可读的最小摘要，不包含凭据或本机路径。
func platformConnectionSummary(c platformConnection) map[string]any {
	return map[string]any{
		"id": c.ID, "account_id": c.AccountID, "platform": c.Platform,
		"state": c.State, "availability": c.Availability,
		"external_account_key": c.ExternalAccountKey,
		"auto_collect":         c.AutoCollect, "auto_adopt": c.AutoAdopt,
		"last_verified_at": c.LastVerifiedAt, "last_seen_at": c.LastSeenAt,
		"next_due_at": c.NextDueAt, "failure_count": c.FailureCount,
		"authorization_revision": c.AuthorizationRevision, "adoption_revision": c.AdoptionRevision,
		"platform_consent_version": c.PlatformConsentVersion, "consented_at": c.ConsentedAt,
	}
}

// patchPlatformConnection 是 PATCH /accounts/{accountId}/platform-connection：
// 只接受固定键，增权项要求 owner + 重新认证，暂停允许连接保管人本人（§4.3、§11.2）。
func (s *Server) patchPlatformConnection(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if id.AdminOverride {
		return apiErr(403, "forbidden", "系统管理员代访问工作区不能修改平台连接")
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	var in struct {
		State       *string `json:"state"`
		AutoCollect *bool   `json:"auto_collect"`
		AutoAdopt   *bool   `json:"auto_adopt"`
		// 增权项用授权版本比较，自动采用用 adoption_revision，避免两类改动互相覆盖。
		AuthorizationRevision *int64 `json:"authorization_revision"`
		AdoptionRevision      *int64 `json:"adoption_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	c, err := s.platformConnectionForAccount(r.Context(), id.WorkspaceID, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	isHolder := c.UserID == id.UserID
	isOwner := id.Role == "owner"
	if !isOwner && !isHolder {
		return apiErr(403, "forbidden", "只有所有者或连接保管人可以修改该连接")
	}

	// 暂停只减权，保管人本人即可；其余（开启采集/采用）是增权，必须 owner + 重新认证。
	onlyPause := in.State != nil && *in.State == "paused" && in.AutoCollect == nil && in.AutoAdopt == nil
	if !onlyPause {
		if !isOwner {
			return apiErr(403, "forbidden", "只有工作区所有者可以开启自动采集或自动采用")
		}
		if err := s.requireReauth(r.Context()); err != nil {
			return err
		}
	}
	if in.State != nil && *in.State != "paused" {
		return validation("该接口只支持暂停，恢复请重新验证身份")
	}
	if in.AutoAdopt != nil && *in.AutoAdopt {
		// D-129：正式验收（每平台 10 篇以上逐字段对照）完成前不开启自动采用。
		return apiErr(409, "platform_consent_required", "自动采用需先完成正式验收，当前版本不支持开启")
	}
	if in.AutoCollect != nil && !*in.AutoCollect && c.AutoAdopt {
		return validation("关闭自动采集前请先关闭自动采用")
	}

	var updated platformConnection
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var current platformConnection
		if err := tx.QueryRow(r.Context(), `SELECT authorization_revision, adoption_revision
			FROM platform_connection WHERE id=$1 FOR UPDATE`, c.ID).Scan(
			&current.AuthorizationRevision, &current.AdoptionRevision); err != nil {
			return err
		}
		if in.AuthorizationRevision != nil && *in.AuthorizationRevision != current.AuthorizationRevision {
			return apiErr(409, "platform_authorization_changed", "连接授权已变化，请刷新后重试")
		}
		if in.AdoptionRevision != nil && *in.AdoptionRevision != current.AdoptionRevision {
			return apiErr(409, "platform_authorization_changed", "自动采用设置已变化，请刷新后重试")
		}
		// 只在真的改了增权字段时递增授权版本，暂停不递增（§12 的暂停语义）。
		if err := tx.QueryRow(r.Context(), `UPDATE platform_connection SET
			state=coalesce($2, state),
			auto_collect=coalesce($3, auto_collect),
			authorization_revision=authorization_revision +
			  CASE WHEN ($2 IS NOT NULL OR $3 IS DISTINCT FROM auto_collect) THEN 1 ELSE 0 END,
			next_due_at=CASE WHEN $2='paused' THEN NULL ELSE next_due_at END,
			updated_at=now()
			WHERE id=$1
			RETURNING id, workspace_id, account_id, platform, user_id, device_id, external_account_key,
			  state, availability, authorization_revision, adoption_revision, auto_collect, auto_adopt,
			  last_verified_at, last_seen_at, next_due_at, failure_count, platform_consent_version,
			  consented_at, created_at, updated_at`,
			c.ID, in.State, in.AutoCollect).Scan(
			&updated.ID, &updated.WorkspaceID, &updated.AccountID, &updated.Platform, &updated.UserID,
			&updated.DeviceID, &updated.ExternalAccountKey, &updated.State, &updated.Availability,
			&updated.AuthorizationRevision, &updated.AdoptionRevision, &updated.AutoCollect, &updated.AutoAdopt,
			&updated.LastVerifiedAt, &updated.LastSeenAt, &updated.NextDueAt, &updated.FailureCount,
			&updated.PlatformConsentVersion, &updated.ConsentedAt, &updated.CreatedAt, &updated.UpdatedAt); err != nil {
			return err
		}
		if updated.State == "paused" {
			// 暂停后取消未结束任务，不留下会继续跑的执行。
			if _, err := tx.Exec(r.Context(), `UPDATE platform_sync_run SET status='canceled',
				cancel_requested_at=now(), finished_at=now()
				WHERE connection_id=$1 AND status IN ('queued','leased','running')`, c.ID); err != nil {
				return err
			}
		}
		return s.auditTx(r.Context(), tx, "platform_connection_update", "platform_connection", c.ID.String(), "ok",
			map[string]any{"state": updated.State, "auto_collect": updated.AutoCollect,
				"auto_adopt": updated.AutoAdopt, "authorization_revision": updated.AuthorizationRevision})
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, platformConnectionSummary(updated))
}

// getPlatformConnection 是 GET /accounts/{accountId}/platform-connection 的读取端。
func (s *Server) getPlatformConnection(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	c, err := s.platformConnectionForAccount(r.Context(), id.WorkspaceID, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.Header().Set("Cache-Control", "no-store")
			return ok(w, map[string]any{"connection": nil})
		}
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"connection": platformConnectionSummary(c)})
}

// deletePlatformConnection 是工作区撤销：owner 或本人。可离线撤销，不能保证远程清盘。
func (s *Server) deletePlatformConnection(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if id.AdminOverride {
		return apiErr(403, "forbidden", "系统管理员代访问工作区不能撤销平台连接")
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	c, err := s.platformConnectionForAccount(r.Context(), id.WorkspaceID, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	// 本人可撤销自己保管的连接；owner 可撤销工作区内任何连接。
	if c.UserID != id.UserID && id.Role != "owner" {
		return apiErr(403, "forbidden", "只有所有者或连接保管人可以撤销该连接")
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if err := s.revokePlatformConnection(r.Context(), tx, c.ID, "workspace_revoke"); err != nil {
			return err
		}
		return s.auditTx(r.Context(), tx, "platform_connection_revoke", "platform_connection", c.ID.String(), "ok",
			map[string]any{"account_id": accountID, "platform": c.Platform})
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) listMinePlatformConnections(w http.ResponseWriter, r *http.Request) error {
	list, err := s.listOwnedPlatformConnections(r.Context(), ident(r.Context()).UserID)
	if err != nil {
		return err
	}
	out := make([]map[string]any, 0, len(list))
	for _, c := range list {
		out = append(out, platformConnectionSummary(c))
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"connections": out})
}

// revokeMinePlatformConnection 是本人回收：账户级、只减权，不依赖工作区成员资格。
func (s *Server) revokeMinePlatformConnection(w http.ResponseWriter, r *http.Request) error {
	connectionID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	var owner uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT user_id FROM platform_connection WHERE id=$1`,
		connectionID).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if owner != id.UserID {
		return errNotFound
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if err := s.revokePlatformConnection(r.Context(), tx, connectionID, "holder_revoke"); err != nil {
			return err
		}
		return s.auditTx(r.Context(), tx, "platform_connection_revoke", "platform_connection", connectionID.String(), "ok",
			map[string]any{"scope": "account"})
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}
