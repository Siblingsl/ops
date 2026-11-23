package app

// REF41 P5：发布通道体检与掉线重试。体检是只读动作：连接在线、登录有效、
// 页面锚点存在、适配器版本；不点发布、不改平台设置。体检结果只写本表与
// publish_channel_state.detail.last_health，不更新 calibrated（体检成功不等
// 于发布成功）。未登录不消耗任务 attempt，20 分钟内自动补跑。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"ops/internal/wechat"
)

const (
	publishHealthLease    = 60 * time.Second
	publishHealthExpire   = 30 * time.Minute
	publishHealthRecheck  = time.Minute
	publishRetryAfter     = 20 * time.Minute
	publishHealthAttempts = 2
)

// PublishHealthCheck 是一次账号×平台体检的投影。
type PublishHealthCheck struct {
	ID           uuid.UUID      `json:"id"`
	WorkspaceID  uuid.UUID      `json:"workspace_id"`
	AccountID    uuid.UUID      `json:"account_id"`
	Platform     string         `json:"platform"`
	Purpose      string         `json:"purpose"`
	State        string         `json:"state"`
	Attempt      int            `json:"attempt"`
	RequestedAt  time.Time      `json:"requested_at"`
	StartedAt    *time.Time     `json:"started_at,omitempty"`
	FinishedAt   *time.Time     `json:"finished_at,omitempty"`
	Result       map[string]any `json:"result"`
	ErrorCode    string         `json:"error_code"`
	ErrorMessage string         `json:"error_message"`
}

const publishHealthCols = `h.id, h.workspace_id, h.account_id, h.platform, h.purpose, h.state,
	h.attempt, h.requested_at, h.started_at, h.finished_at, h.result, h.error_code, h.error_message`

func scanPublishHealth(row pgx.Row) (*PublishHealthCheck, error) {
	var h PublishHealthCheck
	var raw []byte
	if err := row.Scan(&h.ID, &h.WorkspaceID, &h.AccountID, &h.Platform, &h.Purpose, &h.State,
		&h.Attempt, &h.RequestedAt, &h.StartedAt, &h.FinishedAt, &raw, &h.ErrorCode, &h.ErrorMessage); err != nil {
		return nil, err
	}
	h.Result = map[string]any{}
	_ = json.Unmarshal(raw, &h.Result)
	return &h, nil
}

func scanPublishHealthRows(rows pgx.Rows) ([]PublishHealthCheck, error) {
	defer rows.Close()
	items := []PublishHealthCheck{}
	for rows.Next() {
		h, err := scanPublishHealth(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *h)
	}
	return items, rows.Err()
}

func (s *Server) loadPublishHealthInWorkspace(ctx context.Context, ws, id uuid.UUID) (*PublishHealthCheck, error) {
	row := s.db.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h
		WHERE h.id=$1 AND h.workspace_id=$2`, id, ws)
	return scanPublishHealth(row)
}

// requestPublishHealthCheck 为账号×平台集合创建 queued 体检；同账号同平台
// purpose 1 分钟内已有 open 体检时复用，不重复堆积。
func (s *Server) requestPublishHealthCheck(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Platforms []string `json:"platforms"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	platforms, err := normalizePublishPlatforms(in.Platforms)
	if err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	user := ident(r.Context()).UserID
	out := []PublishHealthCheck{}
	for _, platform := range platforms {
		if account.Platform == "wechat_mp" && platform == "wechat_mp" {
			check, err := s.runWechatAPIHealthCheck(r.Context(), ws, account.ID, "health", user)
			if err != nil {
				return err
			}
			out = append(out, *check)
			continue
		}
		check, err := s.openPublishHealthCheck(r.Context(), ws, account.ID, platform, "health", user)
		if err != nil {
			return err
		}
		out = append(out, *check)
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"checks": out})
}

func (s *Server) openPublishHealthCheck(ctx context.Context, ws, accountID uuid.UUID, platform, purpose string, user uuid.UUID) (*PublishHealthCheck, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// 1 分钟内同账号同平台同 purpose 的 open 体检直接复用（P5-A3 复用语义）。
	row := tx.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h
		WHERE h.account_id=$1 AND h.platform=$2 AND h.purpose=$3
		  AND h.state IN ('queued','leased','running')
		  AND h.requested_at > now() - interval '1 minute'
		ORDER BY h.requested_at DESC LIMIT 1 FOR UPDATE`, accountID, platform, purpose)
	existing, err := scanPublishHealth(row)
	if err == nil {
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	id := uuid.New()
	var requestedBy any
	if user != uuid.Nil {
		requestedBy = user
	}
	if _, err := tx.Exec(ctx, `INSERT INTO publish_health_check
		(id, workspace_id, account_id, platform, purpose, state, requested_by, requested_at)
		VALUES ($1,$2,$3,$4,$5,'queued',$6,now())`, id, ws, accountID, platform, purpose, requestedBy); err != nil {
		return nil, err
	}
	created, err := scanPublishHealth(tx.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h WHERE h.id=$1`, id))
	if err != nil {
		return nil, err
	}
	return created, tx.Commit(ctx)
}

// runWechatAPIHealthCheck 是 P5-N1 的服务端执行端：公众号 API 通道没有桌面
// 登录态可查，体检直接验证 access_token 是否能取得；结果写 channel='api'，
// 失败时如实落 failed，不伪造“在线/已登录”，也不把体检成功当成发布成功。
func (s *Server) runWechatAPIHealthCheck(ctx context.Context, ws, accountID uuid.UUID, purpose string, user uuid.UUID) (*PublishHealthCheck, error) {
	check, err := s.openPublishHealthCheck(ctx, ws, accountID, "wechat_mp", purpose, user)
	if err != nil {
		return nil, err
	}
	state := "succeeded"
	result := map[string]any{
		"online": true, "logged_in": true, "adapter_version": "wechat-mp-api-v1",
		"channel": "api", "token_valid": true,
	}
	errorCode, errorMessage := "", ""
	if _, err := s.accessToken(ctx, accountID, false); err != nil {
		state = "failed"
		result = map[string]any{
			"online": false, "logged_in": false, "adapter_version": "wechat-mp-api-v1",
			"channel": "api", "token_valid": false,
		}
		errorCode, errorMessage = wechatHealthError(err)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	locked, err := scanPublishHealth(tx.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h
		WHERE h.id=$1 FOR UPDATE`, check.ID))
	if err != nil {
		return nil, err
	}
	if _, err := s.applyPublishHealthResultTxChannel(ctx, tx, locked, state, result, errorCode, errorMessage, "api"); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.loadPublishHealthInWorkspace(ctx, ws, check.ID)
}

func wechatHealthError(err error) (string, string) {
	var api *APIError
	if errors.As(err, &api) && api.Code == "wechat_error" {
		return "wechat_credential_missing", api.Message
	}
	var we *wechat.Error
	if errors.As(err, &we) {
		return fmt.Sprintf("wechat_%d", we.Code), we.Readable()
	}
	return "wechat_token_failed", err.Error()
}

// listPublishHealth 返回账号每个平台最近一次体检（不限 purpose）。
func (s *Server) listPublishHealth(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT DISTINCT ON (h.platform) `+publishHealthCols+`
		FROM publish_health_check h
		JOIN platform_account a ON a.id=h.account_id AND a.workspace_id=$2
		WHERE h.account_id=$1
		ORDER BY h.platform, h.requested_at DESC`, account.ID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	items, err := scanPublishHealthRows(rows)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"checks": items})
}

// publishHealthClaim 由桌面领取 queued 体检；租约 60 秒，最多 2 次。
func (s *Server) publishHealthClaim(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "publish.health.claim"); err != nil {
		return err
	}
	var in struct {
		Platform string     `json:"platform"`
		CheckID  *uuid.UUID `json:"check_id,omitempty"`
	}
	_ = in
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var check *PublishHealthCheck
	if in.CheckID != nil {
		check, err = scanPublishHealth(tx.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h
			WHERE h.id=$1 AND h.state='queued' FOR UPDATE`, *in.CheckID))
	} else {
		query := `SELECT ` + publishHealthCols + ` FROM publish_health_check h
			WHERE h.state='queued' AND h.platform IN ('xhs','toutiao')`
		args := []any{}
		if in.Platform != "" {
			query += ` AND h.platform=$1`
			args = append(args, in.Platform)
		}
		query += ` ORDER BY h.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`
		check, err = scanPublishHealth(tx.QueryRow(ctx, query, args...))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"check": nil})
	}
	if err != nil {
		return err
	}
	if check.Attempt >= publishHealthAttempts {
		if _, err := tx.Exec(ctx, `UPDATE publish_health_check SET state='expired', finished_at=now(),
			error_code='health_attempts_exhausted', error_message='体检重试次数已用尽' WHERE id=$1`, check.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"check": nil})
	}
	token := uuid.NewString()
	if _, err := tx.Exec(ctx, `UPDATE publish_health_check SET state='leased', lease_token=$2,
		lease_until=$3, attempt=attempt+1, started_at=COALESCE(started_at, now()) WHERE id=$1`,
		check.ID, token, s.now().Add(publishHealthLease).UTC()); err != nil {
		return err
	}
	check.State = "leased"
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"check": check, "lease_token": token, "lease_expires_at": s.now().Add(publishHealthLease)})
}

// applyPublishHealthResultTx 是体检结果落账的唯一实现：HTTP 结果入口与测试
// 直接调用它，避免测试复刻实现导致漂移。logged_in=false 时把 queued 任务置
// not_logged_in（不消耗 attempt）；成功只写 detail.last_health，不动 calibrated。
func (s *Server) applyPublishHealthResultTx(ctx context.Context, tx pgx.Tx, check *PublishHealthCheck,
	state string, result map[string]any, errorCode, errorMessage string) (bool, error) {
	return s.applyPublishHealthResultTxChannel(ctx, tx, check, state, result, errorCode, errorMessage, "desktop")
}

// applyPublishHealthResultTxChannel 允许 API 通道把末次体检写到 channel='api'，
// 不与桌面通道的 last_health 互相覆盖。其余落账语义与统一实现一致。
func (s *Server) applyPublishHealthResultTxChannel(ctx context.Context, tx pgx.Tx, check *PublishHealthCheck,
	state string, result map[string]any, errorCode, errorMessage, channel string) (bool, error) {
	if result == nil {
		result = map[string]any{}
	}
	if _, err := tx.Exec(ctx, `UPDATE publish_health_check SET state=$2, finished_at=now(),
		result=$3, error_code=$4, error_message=$5 WHERE id=$1`,
		check.ID, state, jsonArg(result), errorCode, errorMessage); err != nil {
		return false, err
	}
	loggedIn := false
	if v, ok := result["logged_in"].(bool); ok {
		loggedIn = v
	}
	if state == "succeeded" && !loggedIn {
		// 只动 queued；filling 等执行器返回失败后再由 transition 落 not_logged_in，不增加 attempt。
		if _, err := tx.Exec(ctx, `UPDATE publish_task SET state='not_logged_in', state_version=state_version+1,
			next_retry_at=$2, updated_at=now()
			WHERE account_id=$1 AND state='queued'`, check.AccountID, s.now().Add(publishRetryAfter).UTC()); err != nil {
			return false, err
		}
	}
	if state == "succeeded" {
		detail := map[string]any{"last_health": map[string]any{
			"online":          result["online"],
			"logged_in":       loggedIn,
			"adapter_version": result["adapter_version"],
			"checked_at":      s.now().UTC().Format(time.RFC3339Nano),
		}}
		if _, err := tx.Exec(ctx, `INSERT INTO publish_channel_state (account_id, platform, channel, detail, updated_at)
			VALUES ($1,$2,$3,$4,now())
			ON CONFLICT (account_id, platform, channel)
			DO UPDATE SET detail=$4, updated_at=now()`, check.AccountID, check.Platform, channel, jsonArg(detail)); err != nil {
			return false, err
		}
	}
	return loggedIn, nil
}

func (s *Server) publishHealthHeartbeat(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "publish.health.heartbeat"); err != nil {
		return err
	}
	checkID, err := uuid.Parse(chi.URLParam(r, "checkID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_check_id", "体检 ID 不合法")
	}
	var in struct {
		LeaseToken string `json:"lease_token"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE publish_health_check SET lease_until=$3
		WHERE id=$1 AND lease_token=$2 AND state='leased'`, checkID, in.LeaseToken, s.now().Add(publishHealthLease).UTC())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apiErr(http.StatusConflict, "health_lease_invalid", "体检租约无效或已过期")
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"lease_expires_at": s.now().Add(publishHealthLease)})
}

// publishHealthResult 落体检结果；logged_in=false 时把该账号该平台所有 queued
// 任务置 not_logged_in（不增加 attempt），filling 中的任务不动、等执行器自己失败。
func (s *Server) publishHealthResult(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "publish.health.result"); err != nil {
		return err
	}
	checkID, err := uuid.Parse(chi.URLParam(r, "checkID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_check_id", "体检 ID 不合法")
	}
	var in struct {
		LeaseToken   string         `json:"lease_token"`
		Result       map[string]any `json:"result"`
		ErrorCode    string         `json:"error_code"`
		ErrorMessage string         `json:"error_message"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	check, err := scanPublishHealth(tx.QueryRow(ctx, `SELECT `+publishHealthCols+` FROM publish_health_check h
		WHERE h.id=$1 AND h.lease_token=$2 AND h.state='leased' FOR UPDATE`, checkID, in.LeaseToken))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(http.StatusConflict, "health_lease_invalid", "体检租约无效或已过期")
	}
	if err != nil {
		return err
	}
	state := "succeeded"
	if in.ErrorCode != "" {
		state = "failed"
	}
	loggedIn, err := s.applyPublishHealthResultTx(ctx, tx, check, state, in.Result, in.ErrorCode, in.ErrorMessage)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.notifyPublishLoginRequired(check, loggedIn)
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"state": state})
}

// notifyPublishLoginRequired 未登录时通知；dedupe 按 task+日期，20 分钟内不重复。
func (s *Server) notifyPublishLoginRequired(check *PublishHealthCheck, loggedIn bool) {
	if loggedIn {
		return
	}
	ctx := context.WithoutCancel(context.Background())
	tasks, err := s.db.Query(ctx, `SELECT id FROM publish_task
		WHERE account_id=$1 AND platform=$2 AND state='not_logged_in'`, check.AccountID, check.Platform)
	if err != nil {
		return
	}
	defer tasks.Close()
	day := s.now().Format("20060102")
	for tasks.Next() {
		var taskID uuid.UUID
		if err := tasks.Scan(&taskID); err != nil {
			return
		}
		title := fmt.Sprintf("%s 未登录，等待你重新扫码", publishPlatformTitle(check.Platform))
		body := "其他平台继续跑；登录后 20 分钟内自动补跑，不会消耗填写次数。"
		s.notifyWorkspace(ctx, check.WorkspaceID, []string{"owner", "admin", "member"},
			"publish_login_required", title, body,
			"/ops/publish?task="+taskID.String(), fmt.Sprintf("publish-login:%s:%s", taskID, day))
	}
}

func publishPlatformTitle(platform string) string {
	switch platform {
	case "xhs":
		return "小红书"
	case "toutiao":
		return "头条"
	case "wechat_mp":
		return "公众号"
	}
	return platform
}

// publishRetryJob 每分钟：not_logged_in 且 next_retry_at 到期且最近体检
// logged_in=true → queued；没有新体检时补创建一次。
func (s *Server) publishRetryJob(ctx context.Context) {
	now := s.now()
	rows, err := s.db.Query(ctx, `SELECT DISTINCT ON (t.account_id, t.platform)
		t.account_id, t.platform, t.id
		FROM publish_task t
		WHERE t.state='not_logged_in' AND t.next_retry_at IS NOT NULL AND t.next_retry_at<=$1
		ORDER BY t.account_id, t.platform, t.next_retry_at`, now.UTC())
	if err != nil {
		return
	}
	type retryKey struct {
		account  uuid.UUID
		platform string
		task     uuid.UUID
	}
	pending := []retryKey{}
	for rows.Next() {
		var k retryKey
		if err := rows.Scan(&k.account, &k.platform, &k.task); err != nil {
			rows.Close()
			return
		}
		pending = append(pending, k)
	}
	rows.Close()
	for _, k := range pending {
		var loggedIn bool
		var have bool
		row := s.db.QueryRow(ctx, `SELECT (result->>'logged_in')::bool FROM publish_health_check
			WHERE account_id=$1 AND platform=$2 AND state='succeeded'
			ORDER BY requested_at DESC LIMIT 1`, k.account, k.platform)
		if err := row.Scan(&loggedIn); err == nil {
			have = true
		} else if !errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if !have {
			var wsID uuid.UUID
			if err := s.db.QueryRow(ctx, `SELECT workspace_id FROM publish_task WHERE id=$1`, k.task).Scan(&wsID); err != nil {
				continue
			}
			if _, err := s.openPublishHealthCheck(ctx, wsID, k.account, k.platform, "health", uuid.Nil); err != nil {
				continue
			}
			continue
		}
		if !loggedIn {
			// 最近体检仍未登录：保持 not_logged_in，next_retry_at 顺延一个周期。
			_, _ = s.db.Exec(ctx, `UPDATE publish_task SET next_retry_at=$2
				WHERE account_id=$1 AND state='not_logged_in'`, k.account, now.Add(publishRetryAfter).UTC())
			continue
		}
		// 自动补跑不消耗 attempt（只有 claim→filling 才 +1），但已耗尽 max_attempts 的任务不再复活。
		_, _ = s.db.Exec(ctx, `UPDATE publish_task SET state='queued', state_version=state_version+1,
			next_retry_at=NULL, updated_at=now()
			WHERE account_id=$1 AND platform=$2 AND state='not_logged_in' AND attempt < max_attempts`,
			k.account, k.platform)
	}
}

// publishHealthExpireJob 过期处理：queued 超 30 分钟 expired，leased/running 超租约 expired。
func (s *Server) publishHealthExpireJob(ctx context.Context) {
	_, _ = s.db.Exec(ctx, `UPDATE publish_health_check SET state='expired', finished_at=now(),
		error_code=CASE WHEN error_code='' THEN 'health_expired' ELSE error_code END
		WHERE state='queued' AND requested_at < $1`, s.now().Add(-publishHealthExpire).UTC())
	_, _ = s.db.Exec(ctx, `UPDATE publish_health_check SET state='expired', finished_at=now(),
		error_code=CASE WHEN error_code='' THEN 'health_lease_expired' ELSE error_code END
		WHERE state IN ('leased','running') AND lease_until IS NOT NULL AND lease_until < now()`)
}

// jsonArg 把 map 编码为 jsonb 参数；空 map 也保持 object 形态。
func jsonArg(v map[string]any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return raw
}
