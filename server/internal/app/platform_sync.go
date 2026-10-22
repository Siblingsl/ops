package app

import (
	"context"
	"crypto/sha256"
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
)

// 平台采集任务与幂等入站（20 文档 §10、§11.2、§11.3）。
// 调度由服务端负责：客户端只能领取，不能自建任务，也不能扩大目标集。

const (
	platformRunStatusQueued   = "queued"
	platformRunStatusLeased   = "leased"
	platformRunStatusRunning  = "running"
	platformRunStatusSuccess  = "succeeded"
	platformRunStatusPartial  = "partial"
	platformRunStatusFailed   = "failed"
	platformRunStatusCanceled = "canceled"
	platformRunStatusExpired  = "expired"

	platformLeaseTTL          = 60 * time.Second
	platformRunMaxDuration    = 5 * time.Minute
	platformRunMaxRows        = 100
	platformRunMaxBytes       = 2 << 20
	platformBatchMaxRows      = 25
	platformRunMaxAttempts    = 2
	platformQueueMaxAge       = 30 * time.Minute
	platformPresenceTTL       = 90 * time.Second
	platformFailurePauseLimit = 5
	platformDailyWindowStart  = 9
	platformDailyWindowEnd    = 21
	platformNodeEarliestHour  = 18
	platformRunTargetsPerRun  = 20
)

// platformStopReason 把客户端上报的停止原因收敛到 `platform_sync_run.stop_reason`
// 允许的枚举内（20 文档 §11.3、迁移 00049）。
//
// 为什么必须收敛：客户端会把适配器的"覆盖不完整原因"直接当 stop_reason 发上来——
// 小红书翻页重复是 `page_repeated`，公众号页预算用尽是 `page_budget`，采集异常是
// `collect_failed`。这些值不在 CHECK 里，直接写库抛 23514，而这一步与观测写入在**同一
// 个事务**：整个终批回滚，观测全丢、run 卡在 running 直到租约过期，客户端只看到 500
// （2026-10-22 16:30 实测，验收号 10 篇采集因此全部丢弃）。
//
// 认识的照原样存；不认识的不阻断入库，存空值，原值另存 counters.stop_reason_raw。
func platformStopReason(value *string) *string {
	if value == nil {
		return nil
	}
	switch *value {
	case "budget", "login_required", "challenge_required", "schema_changed", "network",
		"identity_mismatch", "canceled":
		return value
	default:
		return nil
	}
}

// platformRun 是领取与回执使用的最小任务视图，不包含任何凭据。
type platformRun struct {
	ID                             uuid.UUID
	ConnectionID                   uuid.UUID
	WorkspaceID                    uuid.UUID
	AccountID                      uuid.UUID
	Platform                       string
	Trigger                        string
	TaskKind                       string
	Status                         string
	QueryScope                     json.RawMessage
	AuthorizationRevision          int64
	WorkspaceAuthorizationRevision int64
	AdapterVersion                 string
	MappingVersion                 int
	BrowserVersion                 string
	LeaseGeneration                int64
	LeaseExpiresAt                 *time.Time
	DeadlineAt                     *time.Time
	BindingSnapshot                json.RawMessage
	Attempt                        int
	CancelRequestedAt              *time.Time
}

// schedulePlatformRuns 是 §10.1.1 的调度入口，由 RunJobs 每 10 分钟调用一次。
// 只处理同时满足条件[1]的连接；任何不满足的状态都不派新采集任务。
func (s *Server) schedulePlatformRuns(ctx context.Context) {
	if !s.platformCollectionGloballyEnabled(ctx) {
		return
	}
	now := s.now()
	// 先处理租约过期与排队超时：两者都是终态，重派另建新 run。
	s.expirePlatformRuns(ctx, now)

	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.workspace_id, c.account_id, c.platform, c.auto_collect, c.next_due_at,
		       c.failure_count, c.authorization_revision, p.enabled
		FROM platform_connection c
		JOIN workspace w ON w.id = c.workspace_id
		JOIN platform_collection_policy p ON p.workspace_id = c.workspace_id
		WHERE c.state = 'active'
		  AND c.availability = 'ready'
		  AND c.auto_collect
		  AND c.last_seen_at IS NOT NULL
		  AND c.last_seen_at > $1
		  AND (c.cooldown_until IS NULL OR c.cooldown_until <= $2)
		  AND (c.next_due_at IS NULL OR c.next_due_at <= $2)
		  AND c.failure_count < $3
		  AND p.enabled`, now.Add(-platformPresenceTTL), now, platformFailurePauseLimit)
	if err != nil {
		slog.Error("平台采集调度：读取候选连接失败", "err", err)
		return
	}
	type candidate struct {
		ID                    uuid.UUID
		WorkspaceID           uuid.UUID
		AccountID             uuid.UUID
		Platform              string
		AutoCollect           bool
		NextDueAt             *time.Time
		FailureCount          int
		AuthorizationRevision int64
		WorkspaceEnabled      bool
	}
	var list []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.AccountID, &c.Platform, &c.AutoCollect,
			&c.NextDueAt, &c.FailureCount, &c.AuthorizationRevision, &c.WorkspaceEnabled); err != nil {
			slog.Error("平台采集调度：读取候选连接失败", "err", err)
			rows.Close()
			return
		}
		list = append(list, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("平台采集调度：读取候选连接失败", "err", err)
		return
	}
	for _, c := range list {
		if err := s.scheduleConnection(ctx, c.ID, c.WorkspaceID, c.AccountID, c.Platform, now); err != nil {
			slog.Error("平台采集调度：创建任务失败", "connection_id", c.ID, "err", err)
		}
	}
}

// scheduleConnection 为一个连接生成日常 run；同一连接已有未结束 run 时不新建，
// 目标由已冻结的绑定快照决定，客户端不能扩大。
func (s *Server) scheduleConnection(ctx context.Context, connectionID, workspaceID, accountID uuid.UUID, platform string, now time.Time) error {
	// 日常窗口之外不派任务；节点目标由现有节点计划决定，本轮只生成 daily 任务。
	if !platformWithinDailyWindow(now, s.loc) {
		return nil
	}
	var policyRev int64
	if err := s.db.QueryRow(ctx, `SELECT authorization_revision FROM platform_collection_policy
		WHERE workspace_id=$1`, workspaceID).Scan(&policyRev); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_sync_run
			WHERE connection_id=$1 AND status IN ('queued','leased','running'))`, connectionID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		var connRev int64
		var adapter, browser string
		var mapping int
		if err := tx.QueryRow(ctx, `SELECT authorization_revision,
			coalesce(capabilities->>'adapterVersion', ''),
			coalesce((capabilities->>'mappingVersion')::int, 1),
			coalesce(capabilities->>'browserVersion', '')
			FROM platform_connection WHERE id=$1 FOR UPDATE`, connectionID).Scan(&connRev, &adapter, &mapping, &browser); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		snapshot, err := s.platformTargetsSnapshot(ctx, tx, accountID, platform, now)
		if err != nil {
			return err
		}
		if len(snapshot) == 0 {
			// 没有已精确绑定的作品：只探测能力，不猜目标。
			_, err := tx.Exec(ctx, `INSERT INTO platform_sync_run
				(connection_id, workspace_id, account_id, trigger, task_kind, status,
				 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version, browser_version)
				VALUES ($1,$2,$3,'daily','probe','queued',$4,$5,$6,$7,$8)`,
				connectionID, workspaceID, accountID, connRev, policyRev, adapter, mapping, browser)
			return err
		}
		body, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, trigger, task_kind, status,
			 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
			 browser_version, binding_snapshot, deadline_at)
			VALUES ($1,$2,$3,'daily','collect','queued',$4,$5,$6,$7,$8,$9,$10)`,
			connectionID, workspaceID, accountID, connRev, policyRev, adapter, mapping, browser, body,
			now.Add(24*time.Hour))
		return err
	})
}

// platformTargetsSnapshot 冻结本次 run 的目标：只含已精确绑定（非 legacy_title）的已发布作品，
// 并带每篇的绑定与发布修订，提交时逐项比较。
func (s *Server) platformTargetsSnapshot(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, platform string, now time.Time) ([]map[string]any, error) {
	column := "wechat_msgid"
	if platform == "xhs" {
		column = "xhs_note_id"
	}
	rows, err := tx.Query(ctx, `SELECT id, `+column+`, metric_binding_revision, coalesce(publish_revision,1)
		FROM work
		WHERE account_id=$1 AND deleted_at IS NULL AND published_at IS NOT NULL
		  AND `+column+` IS NOT NULL
		  AND platform_binding_source IN ('user_link','user_confirm','official_exact')
		ORDER BY published_at DESC NULLS LAST
		LIMIT $2`, accountID, platformRunTargetsPerRun)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var workID uuid.UUID
		var externalID string
		var bindingRev, publishRev int
		if err := rows.Scan(&workID, &externalID, &bindingRev, &publishRev); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"work_id": workID, "external_id": externalID,
			"binding_revision": bindingRev, "publish_revision": publishRev,
		})
	}
	return out, rows.Err()
}

func platformWithinDailyWindow(now time.Time, loc *time.Location) bool {
	h := now.In(loc).Hour()
	return h >= platformDailyWindowStart && h < platformDailyWindowEnd
}

// expirePlatformRuns 把排队超时与租约过期的 run 置为终态；租约过期且仍有条件时按 §10.1.1
// 新建一条 attempt+1 的 run，冷却 5 分钟后才可领取。
func (s *Server) expirePlatformRuns(ctx context.Context, now time.Time) {
	queueCutoff := now.Add(-platformQueueMaxAge)
	if _, err := s.db.Exec(ctx, `UPDATE platform_sync_run SET status='expired', finished_at=now()
		WHERE status='queued' AND created_at < $1`, queueCutoff); err != nil {
		slog.Error("平台采集调度：排队超时清理失败", "err", err)
	}
	rows, err := s.db.Query(ctx, `SELECT id, connection_id, workspace_id, account_id, attempt, trigger, task_kind,
		query_scope, authorization_revision, workspace_authorization_revision, adapter_version,
		mapping_version, browser_version, binding_snapshot, deadline_at
		FROM platform_sync_run
		WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < $1`, now)
	if err != nil {
		slog.Error("平台采集调度：读取过期租约失败", "err", err)
		return
	}
	type expired struct {
		ID           uuid.UUID
		ConnectionID uuid.UUID
		WorkspaceID  uuid.UUID
		AccountID    uuid.UUID
		Attempt      int
		Trigger      string
		TaskKind     string
		QueryScope   []byte
		AuthRev      int64
		WorkspaceRev int64
		Adapter      string
		Mapping      int
		Browser      string
		Snapshot     []byte
		DeadlineAt   *time.Time
	}
	var list []expired
	for rows.Next() {
		var e expired
		if err := rows.Scan(&e.ID, &e.ConnectionID, &e.WorkspaceID, &e.AccountID, &e.Attempt, &e.Trigger,
			&e.TaskKind, &e.QueryScope, &e.AuthRev, &e.WorkspaceRev, &e.Adapter, &e.Mapping, &e.Browser,
			&e.Snapshot, &e.DeadlineAt); err != nil {
			slog.Error("平台采集调度：读取过期租约失败", "err", err)
			rows.Close()
			return
		}
		list = append(list, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		slog.Error("平台采集调度：读取过期租约失败", "err", err)
		return
	}
	for _, e := range list {
		if err := s.reassignExpiredRun(ctx, e.ID, e.ConnectionID, e.WorkspaceID, e.AccountID, e.Attempt,
			e.Trigger, e.TaskKind, e.QueryScope, e.AuthRev, e.WorkspaceRev, e.Adapter, e.Mapping, e.Browser,
			e.Snapshot, e.DeadlineAt, now); err != nil {
			slog.Error("平台采集调度：过期任务重派失败", "run_id", e.ID, "err", err)
		}
	}
}

// reassignExpiredRun 在同一个事务里先标 expired 再决定是否重派；只新建 run，不改旧 run 的状态，
// 因此部分唯一索引（只看 queued/leased/running）不会冲突。
func (s *Server) reassignExpiredRun(ctx context.Context, runID, connectionID, workspaceID, accountID uuid.UUID,
	attempt int, trigger, taskKind string, queryScope []byte, authRev, workspaceRev int64,
	adapter string, mapping int, browser string, snapshot []byte, deadlineAt *time.Time, now time.Time) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='expired', finished_at=now()
			WHERE id=$1 AND status IN ('leased','running')`, runID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		if attempt >= platformRunMaxAttempts {
			// 达到重派上限：连接记一次失败，等下个窗口或用户处理，不无限重领。
			_, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=failure_count+1,
				updated_at=now() WHERE id=$1`, connectionID)
			return err
		}
		var available bool
		if err := tx.QueryRow(ctx, `SELECT c.state='active' AND c.availability='ready' AND c.auto_collect
			AND p.enabled
			FROM platform_connection c JOIN platform_collection_policy p ON p.workspace_id=c.workspace_id
			WHERE c.id=$1`, connectionID).Scan(&available); err != nil {
			return err
		}
		if !available {
			return nil
		}
		_, err = tx.Exec(ctx, `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, trigger, task_kind, status, query_scope,
			 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
			 browser_version, binding_snapshot, deadline_at, attempt)
			VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			connectionID, workspaceID, accountID, trigger, taskKind, queryScope, authRev, workspaceRev,
			adapter, mapping, browser, snapshot, deadlineAt, attempt+1)
		if err != nil {
			return err
		}
		// 普通网络失败：冷却 5 分钟后才可领取。
		_, err = tx.Exec(ctx, `UPDATE platform_connection SET cooldown_until=now() + interval '5 minutes',
			updated_at=now() WHERE id=$1`, connectionID)
		return err
	})
}

// claimPlatformRun 是 POST /desktop/platform/runs/claim：每台设备一次只返回一条 run。
// 选择顺序为 manual 优先，其次 created_at 最早。
func (s *Server) claimPlatformRun(ctx context.Context, deviceID uuid.UUID) (*platformRun, error) {
	// claim 是最后一道闸门：即使排队时开关是开的，领取时也要重新确认（§17.3）。
	if !s.platformCollectionGloballyEnabled(ctx) {
		return nil, apiErr(403, "platform_collection_disabled", "服务端已关闭平台数据采集")
	}
	id := ident(ctx)
	var run platformRun
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var runID uuid.UUID
		err := tx.QueryRow(ctx, `
			SELECT r.id FROM platform_sync_run r
			JOIN platform_connection c ON c.id = r.connection_id
			WHERE r.status='queued'
			  AND r.workspace_id=$1
			  AND c.user_id=$2
			  AND c.device_id=$3
			  AND c.state='active'
			  -- 适配器版本熔断期间不领取：该版本已按 §12 判定为不可信，
			  -- 继续派发只会写入更多错数。
			  AND NOT EXISTS (
			    SELECT 1 FROM platform_adapter_breaker b
			    WHERE b.platform = c.platform
			      AND b.adapter_version = coalesce(c.capabilities->>'adapterVersion', '')
			      AND b.state = 'open')
			ORDER BY CASE WHEN r.trigger='manual' THEN 0 ELSE 1 END, r.created_at
			LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, id.WorkspaceID, id.UserID, deviceID).Scan(&runID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		// 领取时重新核对策略与连接授权；策略关闭后旧 run 不能继续。
		var policyOK bool
		if err := tx.QueryRow(ctx, `SELECT p.enabled FROM platform_collection_policy p
			JOIN platform_sync_run r ON r.workspace_id=p.workspace_id
			WHERE r.id=$1 AND p.authorization_revision <= r.workspace_authorization_revision`, runID).Scan(&policyOK); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		if !policyOK {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='canceled', finished_at=now()
				WHERE id=$1`, runID)
			return err
		}
		now := s.now()
		var leaseUntil = now.Add(platformLeaseTTL)
		if err := tx.QueryRow(ctx, `UPDATE platform_sync_run SET status='leased', lease_generation=lease_generation+1,
			lease_expires_at=$2, started_at=coalesce(started_at,now())
			WHERE id=$1
			RETURNING id, connection_id, workspace_id, account_id, trigger, task_kind, status, query_scope,
			  authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
			  browser_version, lease_generation, lease_expires_at, deadline_at, binding_snapshot, attempt,
			  cancel_requested_at`, runID, leaseUntil).Scan(
			&run.ID, &run.ConnectionID, &run.WorkspaceID, &run.AccountID, &run.Trigger, &run.TaskKind, &run.Status,
			&run.QueryScope, &run.AuthorizationRevision, &run.WorkspaceAuthorizationRevision, &run.AdapterVersion,
			&run.MappingVersion, &run.BrowserVersion, &run.LeaseGeneration, &run.LeaseExpiresAt, &run.DeadlineAt,
			&run.BindingSnapshot, &run.Attempt, &run.CancelRequestedAt); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `SELECT platform FROM platform_connection WHERE id=$1`, run.ConnectionID).Scan(&run.Platform)
	})
	if err != nil || run.ID == uuid.Nil {
		return nil, err
	}
	return &run, nil
}

// heartbeatPlatformRun 续租并返回取消状态；任何策略或授权变化都立即让客户端停止。
func (s *Server) heartbeatPlatformRun(ctx context.Context, runID uuid.UUID, deviceID uuid.UUID) (bool, *time.Time, error) {
	id := ident(ctx)
	now := s.now()
	var canceled bool
	var leaseUntil *time.Time
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var status string
		var cancelRequested *time.Time
		var deadline *time.Time
		if err := tx.QueryRow(ctx, `SELECT r.status, r.cancel_requested_at, r.deadline_at
			FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
			WHERE r.id=$1 AND r.workspace_id=$2 AND c.user_id=$3 AND c.device_id=$4
			FOR UPDATE OF r`, runID, id.WorkspaceID, id.UserID, deviceID).Scan(&status, &cancelRequested, &deadline); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}
		if status != platformRunStatusLeased && status != platformRunStatusRunning {
			return apiErr(409, "platform_lease_stale", "任务已结束或已由新执行替代")
		}
		if cancelRequested != nil {
			canceled = true
			return nil
		}
		// 硬截止：超过 run 最长时长直接终止，不无限续租。
		if deadline != nil && !deadline.After(now) {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='expired', finished_at=now() WHERE id=$1`, runID)
			return err
		}
		until := now.Add(platformLeaseTTL)
		leaseUntil = &until
		_, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='running', lease_expires_at=$2 WHERE id=$1`, runID, until)
		return err
	})
	return canceled, leaseUntil, err
}

// platformPresence 是 POST /desktop/platform/presence：只刷新本人连接的 last_seen_at。
// presence 与 run 租约是两件事：presence 过期不延长租约，run 结束也不清除 presence。
func (s *Server) platformPresence(ctx context.Context, deviceID uuid.UUID) error {
	id := ident(ctx)
	now := s.now()
	tag, err := s.db.Exec(ctx, `UPDATE platform_connection SET last_seen_at=$3, updated_at=now()
		WHERE user_id=$1 AND device_id=$2 AND state='active'`, id.UserID, deviceID, now)
	if err != nil {
		return err
	}
	// 没有连接时也算一次有效心跳（设备在线），由调用方决定是否需要。
	_ = tag
	return nil
}

// requestPlatformSync 是 POST /accounts/{accountId}/platform-sync：仅建 manual 待办，
// 且只有连接的当前保管人可以发起，不能远程驱动别人的浏览器。
func (s *Server) requestPlatformSync(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	if err := s.desktopRequirePlatformCollectionAccess(r.Context(), uuid.Nil); err != nil {
		return err
	}
	c, err := s.platformConnectionForAccount(r.Context(), id.WorkspaceID, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(409, "platform_consent_required", "该账号尚未建立平台连接")
		}
		return err
	}
	if c.UserID != id.UserID {
		return apiErr(403, "platform_not_holder", "只有连接的保管人可以在本机发起采集")
	}
	if c.Availability != "ready" {
		return apiErr(409, "platform_consent_required", "连接当前不可用，请先重新登录或验证身份")
	}
	now := s.now()
	if c.LastSeenAt == nil || now.Sub(*c.LastSeenAt) > platformPresenceTTL {
		return apiErr(409, "platform_presence_stale", "保存该连接的设备当前不在线")
	}
	var runID uuid.UUID
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var active bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM platform_sync_run
			WHERE connection_id=$1 AND status IN ('queued','leased','running'))`, c.ID).Scan(&active); err != nil {
			return err
		}
		if active {
			return apiErr(409, "platform_result_conflict", "该连接已有未结束的采集任务")
		}
		var policyRev int64
		if err := tx.QueryRow(r.Context(), `SELECT authorization_revision FROM platform_collection_policy
			WHERE workspace_id=$1`, id.WorkspaceID).Scan(&policyRev); err != nil {
			return err
		}
		binding := []byte("[]")
		targets, err := s.platformTargetsSnapshot(r.Context(), tx, accountID, c.Platform, now)
		if err == nil && len(targets) > 0 {
			binding, _ = json.Marshal(targets)
		}
		return tx.QueryRow(r.Context(), `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, requested_by, trigger, task_kind, status,
			 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
			 browser_version, binding_snapshot, deadline_at)
			VALUES ($1,$2,$3,$4,'manual','collect','queued',$5,$6,
			  coalesce((SELECT capabilities->>'adapterVersion' FROM platform_connection WHERE id=$1),''),
			  coalesce((SELECT (capabilities->>'mappingVersion')::int FROM platform_connection WHERE id=$1),1),
			  coalesce((SELECT capabilities->>'browserVersion' FROM platform_connection WHERE id=$1),''),
			  $7,$8)
			RETURNING id`,
			c.ID, id.WorkspaceID, accountID, id.UserID, c.AuthorizationRevision, policyRev, binding,
			now.Add(24*time.Hour)).Scan(&runID)
	})
	if err != nil {
		return err
	}
	s.audit(r.Context(), "platform_sync_requested", "platform_sync_run", runID.String(), "ok",
		map[string]any{"account_id": accountID, "connection_id": c.ID})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"run_id": runID, "trigger": "manual", "status": platformRunStatusQueued})
}

// platformResultBatch 是客户端提交的结构化批次（20 文档 §11.3）。
type platformResultBatch struct {
	ProtocolVersion       int                 `json:"protocol_version"`
	LeaseGeneration       int64               `json:"lease_generation"`
	AuthorizationRevision int64               `json:"authorization_revision"`
	BatchSeq              int                 `json:"batch_seq"`
	FinalBatch            bool                `json:"final_batch"`
	RunStatus             string              `json:"run_status"`
	StopReason            *string             `json:"stop_reason"`
	ErrorCode             *string             `json:"error_code"`
	Coverage              map[string]any      `json:"coverage"`
	Observations          []platformResultRow `json:"observations"`
}

type platformResultRow struct {
	RowNo              int                        `json:"row_no"`
	Scope              string                     `json:"scope"`
	ExternalAccountKey string                     `json:"external_account_key"`
	ExternalID         *string                    `json:"external_id"`
	BindingRevision    *int                       `json:"binding_revision"`
	PublishRevision    *int                       `json:"publish_revision"`
	Source             string                     `json:"source"`
	TemporalKind       string                     `json:"temporal_kind"`
	ObservedAt         time.Time                  `json:"observed_at"`
	AsOfAt             *time.Time                 `json:"as_of_at"`
	WindowStart        *time.Time                 `json:"window_start"`
	WindowEnd          *time.Time                 `json:"window_end"`
	AdapterVersion     string                     `json:"adapter_version"`
	MappingVersion     int                        `json:"mapping_version"`
	Values             map[string]json.RawMessage `json:"values"`
	FieldPaths         map[string]string          `json:"field_paths"`
	// PlatformPublishedAt 是平台侧显示的作品发布时间（可选）。
	//
	// 为什么需要它：`metric_day_offset`（D1/D3/D7/D14 节点天数）完全依赖
	// `work.published_at`。实测发现绑定作品时若没有真实发布时间，7 篇会被写成
	// **同一个** `published_at`（绑定时刻），于是所有节点天数都算成 0，
	// 按天对比的指标全部失真。
	//
	// 客户端从平台列表里能读到这个时间（公众号的 `sentAt`），随观测一起上报，
	// 服务端只在 `published_at` 为空或与平台值不一致时才回填，不覆盖用户手填的值。
	PlatformPublishedAt *time.Time `json:"platform_published_at"`
}

// platformReceipt 是批次回执：逐行给出接收/待确认/拒绝/重复与原因。
type platformReceipt struct {
	BatchSeq  int              `json:"batch_seq"`
	ReceiptID uuid.UUID        `json:"receipt_id"`
	Accepted  int              `json:"accepted"`
	Pending   int              `json:"pending"`
	Rejected  int              `json:"rejected"`
	Duplicate int              `json:"duplicate"`
	RunStatus string           `json:"run_status"`
	Rows      []map[string]any `json:"rows"`
	// auto_adopt 开启时，投影失败的行数与此处第一条原因。
	// 观测本身已入库（accepted 计数仍包含它），但没进正式指标——
	// 不回传原因的话，用户只看到"采集成功"，以为数据已生效。
	AdoptErrors int    `json:"adopt_errors,omitempty"`
	AdoptReason string `json:"adopt_reason,omitempty"`
}

func batchBodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// submitPlatformResults 处理 POST /desktop/platform/runs/{id}/results：
// 批次幂等键为 (run_id, lease_generation, batch_seq)，相同键相同内容返回原回执，不同内容 409。
func (s *Server) submitPlatformResults(ctx context.Context, runID, deviceID uuid.UUID, rawBody []byte, batch platformResultBatch) (platformReceipt, error) {
	id := ident(ctx)
	hash := batchBodyHash(rawBody)
	var receipt platformReceipt
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var status, connectionID, workspaceID, accountID, platform string
		var connID uuid.UUID
		var runAcct uuid.UUID
		var runWorkspace uuid.UUID
		var leaseGen int64
		var authRev int64
		var attempt int
		var receiptsRaw []byte
		// autoAdopt 决定本次批次里的观测是否**立即投影为正式指标**（§9.2、D-129）。
		// 默认为 false：只写观测，等用户逐条确认。
		// 取连接的实时值而不是 run 创建时的快照——用户在采集过程中关掉开关应立即生效。
		var autoAdopt bool
		if err := tx.QueryRow(ctx, `SELECT r.status, r.connection_id, r.workspace_id, r.account_id,
			  r.lease_generation, r.authorization_revision, r.attempt, r.batch_receipts, c.platform,
			  c.auto_adopt
			FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
			WHERE r.id=$1 AND r.workspace_id=$2 AND c.user_id=$3 AND c.device_id=$4
			FOR UPDATE OF r`, runID, id.WorkspaceID, id.UserID, deviceID).Scan(
			&status, &connID, &runWorkspace, &runAcct, &leaseGen, &authRev, &attempt, &receiptsRaw, &platform,
			&autoAdopt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}
		_ = connectionID
		_ = workspaceID
		_ = accountID
		// 幂等：同一 (generation, batch_seq) 已提交过就返回原回执，内容不同则冲突。
		existing := []map[string]any{}
		_ = json.Unmarshal(receiptsRaw, &existing)
		for _, r := range existing {
			if int(r["batch_seq"].(float64)) == batch.BatchSeq {
				if stored, _ := r["body_hash"].(string); stored == hash {
					receipt = platformReceipt{BatchSeq: batch.BatchSeq, RunStatus: r["run_status"].(string)}
					if v, ok := r["receipt_id"].(string); ok {
						if rid, e := uuid.Parse(v); e == nil {
							receipt.ReceiptID = rid
						}
					}
					for _, k := range []string{"accepted", "pending", "rejected", "duplicate"} {
						if v, ok := r[k].(float64); ok {
							switch k {
							case "accepted":
								receipt.Accepted = int(v)
							case "pending":
								receipt.Pending = int(v)
							case "rejected":
								receipt.Rejected = int(v)
							case "duplicate":
								receipt.Duplicate = int(v)
							}
						}
					}
					return nil
				}
				return apiErr(409, "platform_result_conflict", "同一批次已提交过不同内容")
			}
		}
		if batch.LeaseGeneration != leaseGen {
			return apiErr(409, "platform_lease_stale", "该任务已由新的执行替代")
		}
		if batch.AuthorizationRevision != authRev {
			return apiErr(409, "platform_authorization_changed", "连接授权已变化，请重新领取任务")
		}
		if status != platformRunStatusLeased && status != platformRunStatusRunning {
			return apiErr(409, "platform_lease_stale", "任务已结束")
		}
		if len(batch.Observations) > platformBatchMaxRows {
			return validation("单批观测条数超过上限")
		}
		// 连接必须仍然有效：撤销或暂停后不再接受任何新结果。
		var connActive bool
		if err := tx.QueryRow(ctx, `SELECT state='active' FROM platform_connection WHERE id=$1`, connID).Scan(&connActive); err != nil {
			return err
		}
		if !connActive {
			return apiErr(403, "platform_authorization_changed", "连接已撤销或暂停")
		}

		receipt = platformReceipt{BatchSeq: batch.BatchSeq, ReceiptID: uuid.New(), Rows: []map[string]any{}}
		// 记录第一条自动采用失败的原因，随回执回给客户端便于定位（不写观测内容）。
		// 失败条数单独计数：回执里的数量要能对上"有几条没入库"，不能恒为 1。
		var adoptFirstError error
		adoptFailures := 0
		for index, row := range batch.Observations {
			if row.RowNo != index {
				return validation("观测 row_no 必须与数组位置一致")
			}
			scope := row.Scope
			matchState := observationMatchNotApplicable
			if scope == observationScopeWork {
				state, targetErr := s.checkRunTarget(ctx, tx, runID, row)
				if targetErr != nil {
					return targetErr
				}
				matchState = state
				// 回填真实发布时间：`metric_day_offset` 靠它算节点天数。
				// 只在作品当前没有可信发布时间时才写，绝不覆盖用户手填的值。
				if row.PlatformPublishedAt != nil && row.ExternalID != nil {
					if err := backfillPublishedAt(ctx, tx, runAcct, platform, *row.ExternalID, *row.PlatformPublishedAt); err != nil {
						return err
					}
				}
			}
			in := platformObservationInput{
				RunID: &runID, BatchSeq: &batch.BatchSeq, RowNo: &row.RowNo,
				WorkspaceID: runWorkspace, AccountID: runAcct, ExternalAccountKey: row.ExternalAccountKey,
				ExternalID: row.ExternalID, Scope: scope, Source: row.Source, TemporalKind: row.TemporalKind,
				ObservedAt: row.ObservedAt, AsOfAt: row.AsOfAt, WindowStart: row.WindowStart, WindowEnd: row.WindowEnd,
				Values: row.Values, FieldPaths: row.FieldPaths, AdapterVersion: row.AdapterVersion,
				MappingVersion: row.MappingVersion,
				// 不在这里指定 QualityState：由 insertPlatformObservation 按 §9.2 默认置
				// `needs_confirmation`。采集入站的观测是"待用户确认"的，不是已生效的读数。
				// 早期这里写死 `valid`，导致前端"确认这一条"按钮永远不显示。
				MatchState: matchState,
			}
			obsID, dup, err := insertPlatformObservation(ctx, tx, in)
			if err != nil {
				return err
			}
			if dup {
				receipt.Duplicate++
				receipt.Rows = append(receipt.Rows, map[string]any{"row_no": row.RowNo, "state": "duplicate", "observation_id": obsID})
				continue
			}
			// auto_adopt 开启时立即投影为正式指标；关闭时只写观测，等用户逐条确认。
			//
			// 复用 confirmObservationTx 而**不是**另写一套：那是同一份校验
			// （质量状态、绑定、单位、精度、修订、superseded 替代），
			// 两侧共用才不会出现"手动确认能过、自动投影放过"的口径漂移。
			//
			// 必须用 savepoint 隔离：`confirmObservationTx` 里的校验失败可能伴随
			// **数据库错误**（唯一约束冲突等），届时整个事务进入 aborted 状态，
			// 后续语句全部失败——一条投影失败会让整批观测连同回执一起丢掉。
			// savepoint 只回滚这一条的投影副作用，观测行保持。
			rowState := "accepted"
			if autoAdopt {
				if adoptErr := s.adoptInSavepoint(ctx, tx, obsID, runWorkspace); adoptErr != nil {
					rowState = "adopted_failed"
					// 诊断：只记错误码与首行消息，不记观测内容。
					slog.Warn("平台采集：自动采用失败", "observation_id", obsID, "err", adoptErr)
					adoptFailures++
					adoptFirstError = adoptErr
				} else {
					rowState = "adopted"
				}
			}
			receipt.Accepted++
			receipt.Rows = append(receipt.Rows, map[string]any{
				"row_no": row.RowNo, "state": rowState, "observation_id": obsID,
			})
		}
		// 自动采用若有失败，把第一条原因放进回执：客户端能展示"采到了但没入库"，
		// 否则用户只看到 accepted，以为一切正常。条数按实际失败数累加，不是恒为 1。
		if adoptFailures > 0 {
			receipt.AdoptErrors = adoptFailures
			reason := adoptFirstError.Error()
			if adoptFailures > 1 {
				reason = fmt.Sprintf("%s（共 %d 条失败，其余见服务端日志）", reason, adoptFailures)
			}
			receipt.AdoptReason = reason
		}

		nextStatus := status
		if batch.FinalBatch {
			switch batch.RunStatus {
			case platformRunStatusSuccess:
				nextStatus = platformRunStatusSuccess
			case platformRunStatusPartial:
				nextStatus = platformRunStatusPartial
			case platformRunStatusFailed:
				nextStatus = platformRunStatusFailed
			case platformRunStatusCanceled:
				nextStatus = platformRunStatusCanceled
			default:
				return validation("run_status 只能是 succeeded/partial/failed/canceled")
			}
			// stop_reason 必须先过枚举校验：适配器的"覆盖不完整原因"（page_repeated、
			// page_budget、collect_failed…）不在 CHECK 允许值内，直接写库会让整个终批
			// 事务回滚（观测全丢、run 卡住）。原始值转存 counters，供排查时对照。
			rawStopReason := ""
			if batch.StopReason != nil {
				rawStopReason = *batch.StopReason
			}
			stopReason := platformStopReason(batch.StopReason)
			if rawStopReason != "" && stopReason == nil {
				slog.Warn("平台采集：客户端上报的停止原因不在登记枚举内，按空值存库",
					"run_id", runID, "stop_reason", rawStopReason)
			}
			// coverage 是客户端对"读了多少、还剩多少、为什么停"的自述（20 文档 §11.3
			// 要求 partial 必须给出覆盖范围）。此前这个字段被解析后**完全丢弃**：服务端
			// 不落库、界面拿不到，于是 page_repeated / page_budget 这类真实原因只存在
			// 于客户端日志里，用户只看到"partial"而不知道为什么不完整（2026-10-22 实测：
			// 验收号 run 状态 partial，但库里查不到任何覆盖信息）。
			// 因此这里原样写进 counters.coverage，与 stop_reason_raw 同等对待。
			coverageJSON := ""
			if len(batch.Coverage) > 0 {
				if raw, err := json.Marshal(batch.Coverage); err == nil {
					coverageJSON = string(raw)
				}
			}
			if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status=$2, stop_reason=$3, error_code=$4,
				counters=CASE WHEN $5::text='' THEN counters
					ELSE counters || jsonb_build_object('stop_reason_raw',$5::text) END
					|| CASE WHEN $6::text='' THEN '{}'::jsonb
					ELSE jsonb_build_object('coverage',$6::jsonb) END,
				finished_at=now() WHERE id=$1`,
				runID, nextStatus, stopReason, batch.ErrorCode, rawStopReason, coverageJSON); err != nil {
				return err
			}
			// run 终态按 §10.1.1 更新连接：成功清零，失败顺延冷却并累计失败次数。
			if nextStatus == platformRunStatusSuccess || nextStatus == platformRunStatusPartial {
				if _, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=0, cooldown_until=NULL,
					next_due_at=now() + interval '1 day', updated_at=now() WHERE id=$1`, connID); err != nil {
					return err
				}
			} else {
				if _, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=failure_count+1,
					cooldown_until=now() + interval '5 minutes', updated_at=now() WHERE id=$1`, connID); err != nil {
					return err
				}
			}
			if err := s.applyRunFailureAction(ctx, tx, connID, batch.ErrorCode); err != nil {
				return err
			}
		} else {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='running', lease_expires_at=now() + $2
				WHERE id=$1`, runID, platformLeaseTTL)
			if err != nil {
				return err
			}
		}
		receipt.RunStatus = nextStatus

		entry := map[string]any{
			"batch_seq":  batch.BatchSeq,
			"receipt_id": receipt.ReceiptID.String(),
			"body_hash":  hash,
			"accepted":   receipt.Accepted,
			"pending":    receipt.Pending,
			"rejected":   receipt.Rejected,
			"duplicate":  receipt.Duplicate,
			"run_status": receipt.RunStatus,
		}
		existing = append(existing, entry)
		updated, err := json.Marshal(existing)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE platform_sync_run SET batch_receipts=$2 WHERE id=$1`, runID, updated)
		return err
	})
	return receipt, err
}

// checkRunTarget 确认作品观测指向本次 run 冻结的目标，且绑定/发布修订未被改动。
func (s *Server) checkRunTarget(ctx context.Context, tx pgx.Tx, runID uuid.UUID, row platformResultRow) (string, error) {
	if row.ExternalID == nil {
		return "", validation("作品观测缺少外部编号")
	}
	var snapshot []byte
	if err := tx.QueryRow(ctx, `SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, runID).Scan(&snapshot); err != nil {
		return "", err
	}
	var targets []struct {
		ExternalID      string `json:"external_id"`
		BindingRevision int    `json:"binding_revision"`
		PublishRevision int    `json:"publish_revision"`
	}
	if err := json.Unmarshal(snapshot, &targets); err != nil {
		return "", err
	}
	for _, t := range targets {
		if t.ExternalID != *row.ExternalID {
			continue
		}
		if row.BindingRevision == nil || row.PublishRevision == nil ||
			*row.BindingRevision != t.BindingRevision || *row.PublishRevision != t.PublishRevision {
			return "", apiErr(409, "platform_authorization_changed", "该作品的绑定或发布信息已变化")
		}
		return observationMatchBound, nil
	}
	// 不在冻结目标内：不能把未绑定作品塞进 collect。
	return "", apiErr(409, "platform_result_conflict", "观测对应的作品不在本次任务目标内")
}

// applyRunFailureAction 按错误码执行动作（§12）。分两级：
//   - 连接级：登录失效/验证/身份不符 → 只改该连接的可用性；账号受限/需重新授权 → 暂停该连接。
//   - 版本级：`platform_schema_changed` 表示页面或响应结构变了，是**适配器版本**的问题，
//     不是单条连接的问题。此时对 `(platform, adapter_version)` 全局熔断，避免所有同版本
//     客户端继续按旧映射写入错数（§12、§8.5）。
//
// adoptInSavepoint 在 savepoint 内执行自动采用，失败只回滚这一条的投影副作用。
//
// 为什么必须有 savepoint：`confirmObservationTx` 内部可能遇到**数据库错误**
// （唯一约束冲突、类型不匹配等），PostgreSQL 会让整个事务进入 aborted 状态，
// 之后任何语句（包括写回执、更新 run）都会失败。没有 savepoint 时，
// 单条投影失败会导致**整批观测连同回执一起丢失**——观测本身是有效原始记录，
// 不该因为派生失败而消失。
func (s *Server) adoptInSavepoint(ctx context.Context, tx pgx.Tx, observationID, workspaceID uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SAVEPOINT platform_adopt`); err != nil {
		return err
	}
	if err := s.confirmObservationTx(ctx, tx, observationID, workspaceID); err != nil {
		// 回滚到 savepoint 之后事务可继续使用；回滚本身失败则只能上报。
		if _, rbErr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT platform_adopt`); rbErr != nil {
			return fmt.Errorf("%w（回滚失败：%v）", err, rbErr)
		}
		if _, relErr := tx.Exec(ctx, `RELEASE SAVEPOINT platform_adopt`); relErr != nil {
			return relErr
		}
		return err
	}
	_, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_adopt`)
	return err
}

// backfillPublishedAt 用平台上报的发布时间回填 work.published_at。
//
// 为什么需要（实测缺陷）：绑定作品时若没有真实发布时间，多篇作品会被写成
// **同一个** `published_at`（绑定时刻），于是 `metric_day_offset` 对它们
// 全部算成 0——D1/D3/D7/D14 节点塌成一个点，按天对比的指标全部失真。
//
// 只在以下两种情况下写，**绝不覆盖用户手填的真实发布日期**：
//  1. `published_at IS NULL`：从没填过，直接补；
//  2. 现有值与本次上报时间不同，且**不早于平台发布时间**：
//     说明现有值是"绑定/首次采集时刻"而不是真实发布时间。
//
// 用户手动填的发布日期一定早于或等于首次采集时刻（否则作品还没发），
// 且通常与平台值一致；因此这条规则不会误改手填值。
func backfillPublishedAt(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, platform, externalID string, publishedAt time.Time) error {
	// 平台时间只保留到秒，且必须落在合理区间（防止平台返回 0 或未来时间）。
	if publishedAt.IsZero() || publishedAt.After(time.Now().Add(24*time.Hour)) {
		return nil
	}
	column := "wechat_msgid"
	if platform == "xhs" {
		column = "xhs_note_id"
	}
	normalized := publishedAt.UTC().Truncate(time.Second)
	_, err := tx.Exec(ctx, `UPDATE work SET published_at=$3
		WHERE account_id=$1 AND `+column+`=$2 AND deleted_at IS NULL
		  AND (published_at IS NULL OR published_at > $3)`,
		accountID, externalID, normalized)
	return err
}

func (s *Server) applyRunFailureAction(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID, errorCode *string) error {
	if errorCode == nil {
		return nil
	}
	switch strings.TrimSpace(*errorCode) {
	case "platform_login_required", "platform_challenge_required", "platform_identity_mismatch":
		availability := failureAvailability(*errorCode)
		if _, err := tx.Exec(ctx, `UPDATE platform_connection SET availability=$2, updated_at=now() WHERE id=$1`,
			connectionID, availability); err != nil {
			return err
		}
		// §6.4：会话失效时通知保管人一次，说明"需要谁扫码"。
		// 用 dedupeKey 保证同一次失效只通知一次——否则每轮采集失败都会再发一遍，
		// 用户会被同一件事反复打扰，最后当成噪音忽略掉真正需要处理的那条。
		if err := s.notifyPlatformReauth(ctx, tx, connectionID, availability); err != nil {
			return err
		}
		return nil
	case "platform_account_restricted", "platform_consent_required":
		_, err := tx.Exec(ctx, `UPDATE platform_connection SET state='paused', auto_collect=false,
			auto_adopt=false, authorization_revision=authorization_revision+1, updated_at=now() WHERE id=$1`, connectionID)
		return err
	case "platform_schema_changed":
		// 版本级熔断：先停该连接，再按平台+适配器版本全局打开熔断。
		// 恢复必须发布新 mapping_version 并重新实测，不能靠时间自动恢复。
		if _, err := tx.Exec(ctx, `UPDATE platform_connection SET auto_collect=false, availability='degraded',
			updated_at=now() WHERE id=$1`, connectionID); err != nil {
			return err
		}
		return s.openAdapterBreaker(ctx, tx, connectionID, *errorCode)
	default:
		return nil
	}
}

// openAdapterBreaker 对连接所属的 (platform, adapter_version) 打开熔断。
// 同一版本重复触发时只累加受影响连接数，不重复建行（部分唯一索引兜底）。
func (s *Server) openAdapterBreaker(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID, errorCode string) error {
	var platform, adapterVersion string
	var mappingVersion *int
	// 适配器版本以连接能力快照为准；快照缺失时不猜版本，直接返回让上层记录。
	if err := tx.QueryRow(ctx, `SELECT platform,
			coalesce(capabilities->>'adapterVersion', ''),
			NULLIF(capabilities->>'mappingVersion', '')::int
		FROM platform_connection WHERE id=$1`, connectionID).Scan(&platform, &adapterVersion, &mappingVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if strings.TrimSpace(adapterVersion) == "" {
		// 没有版本信息就无法按版本熔断，只保留上面的连接级停用。
		return nil
	}
	var affected int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM platform_connection
		WHERE platform=$1 AND capabilities->>'adapterVersion'=$2 AND state='active'`,
		platform, adapterVersion).Scan(&affected); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO platform_adapter_breaker
		(platform, adapter_version, error_code, mapping_version, state, affected_connections)
		VALUES ($1,$2,$3,$4,'open',$5)
		ON CONFLICT (platform, adapter_version) WHERE state='open'
		DO UPDATE SET affected_connections = EXCLUDED.affected_connections, updated_at = now()`,
		platform, adapterVersion, errorCode, mappingVersion, affected)
	if err != nil {
		return err
	}
	slog.Warn("平台采集：适配器版本熔断已打开", "platform", platform,
		"adapter_version", adapterVersion, "error_code", errorCode, "affected_connections", affected)
	return nil
}

// adapterBreakerOpen 判断某平台的某适配器版本是否处于熔断状态。
// 领取任务前必须检查：熔断期间不再派发该版本的任务，避免继续写入错数。
func (s *Server) adapterBreakerOpen(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, platform, adapterVersion string) (bool, error) {
	if strings.TrimSpace(platform) == "" || strings.TrimSpace(adapterVersion) == "" {
		return false, nil
	}
	var open bool
	err := q.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM platform_adapter_breaker
		WHERE platform=$1 AND adapter_version=$2 AND state='open')`, platform, adapterVersion).Scan(&open)
	if err != nil {
		return false, err
	}
	return open, nil
}

// resolveAdapterBreaker 恢复一次版本熔断（§12：恢复必须发布新 mapping_version 并重新实测）。
//
// 只翻转状态不够，必须同时满足两个条件，否则等于让同一个坏适配器继续写数：
//  1. `newMappingVersion` 必须**大于**熔断时记录的值（证明映射真的改过）；
//  2. 操作人必须是超管（`requireSystemAdmin` 由路由层保证）。
//
// 恢复后不会自动重开自动采集：那些连接是被本次熔断停掉的，需要用户重新确认。
func (s *Server) resolveAdapterBreaker(ctx context.Context, breakerID uuid.UUID, newMappingVersion int, note string) (map[string]any, error) {
	var out map[string]any
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var platform, adapterVersion, state string
		var openedMapping *int
		if err := tx.QueryRow(ctx, `SELECT platform, adapter_version, state, mapping_version
			FROM platform_adapter_breaker WHERE id=$1 FOR UPDATE`, breakerID).
			Scan(&platform, &adapterVersion, &state, &openedMapping); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}
		if state != "open" {
			return apiErr(409, "platform_breaker_not_open", "该熔断已恢复，无需重复操作")
		}
		// 发布新映射才允许恢复：新版本必须严格大于熔断时记录的版本。
		if openedMapping != nil && newMappingVersion <= *openedMapping {
			return apiErr(422, "validation_failed",
				"恢复熔断必须发布更高的 mapping_version 并重新实测")
		}
		tag, err := tx.Exec(ctx, `UPDATE platform_adapter_breaker
			SET state='resolved', resolved_at=now(), updated_at=now(),
			    note = COALESCE(NULLIF($2,''), note)
			WHERE id=$1 AND state='open'`, breakerID, note)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apiErr(409, "platform_breaker_not_open", "该熔断已恢复，无需重复操作")
		}
		out = map[string]any{
			"id": breakerID, "platform": platform, "adapter_version": adapterVersion,
			"state": "resolved", "mapping_version": newMappingVersion,
		}
		return s.auditTx(ctx, tx, "platform_adapter_breaker_resolved", "platform_adapter_breaker",
			breakerID.String(), "ok", map[string]any{
				"platform": platform, "adapter_version": adapterVersion,
				"previous_mapping_version": openedMapping, "mapping_version": newMappingVersion,
			})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// listAdapterBreakers 列出熔断记录（超管诊断用），按开启时间倒序。
func (s *Server) listAdapterBreakers(ctx context.Context, onlyOpen bool) ([]map[string]any, error) {
	query := `SELECT id, platform, adapter_version, error_code, mapping_version, state,
		opened_at, resolved_at, affected_connections, note
		FROM platform_adapter_breaker`
	if onlyOpen {
		query += ` WHERE state='open'`
	}
	query += ` ORDER BY opened_at DESC LIMIT 100`
	rows, err := s.db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var platform, adapterVersion, errorCode, state string
		var mappingVersion *int
		var openedAt time.Time
		var resolvedAt *time.Time
		var affected int
		var note *string
		if err := rows.Scan(&id, &platform, &adapterVersion, &errorCode, &mappingVersion, &state,
			&openedAt, &resolvedAt, &affected, &note); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id": id, "platform": platform, "adapter_version": adapterVersion,
			"error_code": errorCode, "mapping_version": mappingVersion, "state": state,
			"opened_at": openedAt, "resolved_at": resolvedAt,
			"affected_connections": affected, "note": note,
		})
	}
	return out, rows.Err()
}

// notifyPlatformReauth 在平台会话失效时通知连接保管人（§6.4）。
//
// 三件事必须说清，否则用户不知道该怎么办：
//   - 哪个平台/账号（链接指向账号页）；
//   - 需要**谁**扫码（保管人本人）；
//   - 不去后台反复拉二维码，需要用户主动重新连接。
//
// dedupeKey 只依赖"连接 + 失效类型"，不依赖时间：同一次失效期间多次采集失败只发一条；
// 用户重新扫码后 availability 回到 ready，下次再失效时 key 相同但语义是新的一轮——
// 因此 key 里带上最后一次成功验证的时刻，保证"每次新失效都能再提醒一次"。
func (s *Server) notifyPlatformReauth(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID, availability string) error {
	var platform, accountName, accountID, holderID string
	var workspaceID uuid.UUID
	var lastVerified *time.Time
	if err := tx.QueryRow(ctx, `SELECT c.platform, coalesce(a.name, ''), c.account_id::text,
			c.user_id::text, c.workspace_id, c.last_verified_at
		FROM platform_connection c LEFT JOIN platform_account a ON a.id = c.account_id
		WHERE c.id=$1`, connectionID).Scan(&platform, &accountName, &accountID, &holderID, &workspaceID, &lastVerified); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	platformLabel := "平台"
	switch platform {
	case "xhs":
		platformLabel = "小红书"
	case "wechat_mp":
		platformLabel = "公众号"
	}
	var title, body string
	switch availability {
	case "login_required":
		title = platformLabel + "登录已失效，需要你重新扫码"
		body = fmt.Sprintf("「%s」的登录状态已失效，自动采集已暂停。请在客户端「在本机连接平台账号」里重新扫码，只有该连接的保管人本人可以完成。", accountName)
	case "challenge_required":
		title = platformLabel + "要求安全验证"
		body = fmt.Sprintf("「%s」需要先完成平台的安全验证才能继续采集。已暂停自动采集，不会自动重试或绕过。", accountName)
	default:
		title = platformLabel + "账号身份与连接不一致"
		body = fmt.Sprintf("「%s」读到的平台身份与已保存的连接不一致，自动采集已暂停。请确认登录的是正确账号后重新连接。", accountName)
	}
	// 同一次失效只发一条：key 绑定连接、失效类型与"最后一次成功验证"时刻。
	verified := "never"
	if lastVerified != nil {
		verified = lastVerified.UTC().Format(time.RFC3339)
	}
	dedupeKey := fmt.Sprintf("platform_reauth:%s:%s:%s", connectionID, availability, verified)
	link := "/a/" + accountID + "/settings/accounts"
	holder, err := uuid.Parse(holderID)
	if err != nil {
		return nil
	}
	s.notify(ctx, workspaceID, holder, "platform_reauth", title, body, link, dedupeKey)
	return nil
}

func failureAvailability(code string) string {
	switch code {
	case "platform_login_required":
		return "login_required"
	case "platform_challenge_required":
		return "challenge_required"
	case "platform_identity_mismatch":
		return "identity_mismatch"
	default:
		return "degraded"
	}
}

// getPlatformRunReceipt 是 GET /desktop/platform/runs/{id}/receipts/{seq}：网络失败后查询回执，
// 不延长租约。
func (s *Server) getPlatformRunReceipt(ctx context.Context, runID uuid.UUID, deviceID uuid.UUID, seq int) (map[string]any, error) {
	id := ident(ctx)
	var receiptsRaw []byte
	if err := s.db.QueryRow(ctx, `SELECT r.batch_receipts FROM platform_sync_run r
		JOIN platform_connection c ON c.id=r.connection_id
		WHERE r.id=$1 AND r.workspace_id=$2 AND c.user_id=$3 AND c.device_id=$4`,
		runID, id.WorkspaceID, id.UserID, deviceID).Scan(&receiptsRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	var list []map[string]any
	_ = json.Unmarshal(receiptsRaw, &list)
	for _, entry := range list {
		if v, ok := entry["batch_seq"].(float64); ok && int(v) == seq {
			out := map[string]any{}
			for k, v := range entry {
				if k != "body_hash" {
					out[k] = v
				}
			}
			return out, nil
		}
	}
	return nil, errNotFound
}

// cancelWorkspacePlatformRuns 在工作区策略关闭或连接撤销时取消所有未结束任务。
func (s *Server) cancelWorkspacePlatformRuns(ctx context.Context, workspaceID uuid.UUID) error {
	_, err := s.db.Exec(ctx, `UPDATE platform_sync_run SET status='canceled', cancel_requested_at=now(),
		finished_at=now()
		WHERE workspace_id=$1 AND status IN ('queued','leased','running')`, workspaceID)
	return err
}
