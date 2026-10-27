package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type queuedPlatformOperation struct {
	ID                             uuid.UUID
	WorkspaceID                    uuid.UUID
	AccountID                      uuid.UUID
	ConnectionID                   uuid.UUID
	RequestedBy                    uuid.UUID
	DeviceID                       uuid.UUID
	Platform                       string
	ExternalKey                    string
	Kind                           string
	Status                         string
	Stage                          string
	RequestedMode                  string
	FrozenScope                    []byte
	AuthorizationRevision          int64
	WorkspaceAuthorizationRevision int64
	ConsentVersion                 int
}

func (s *Server) schedulePlatformOperations(ctx context.Context, now time.Time) {
	if !s.platformCollectionGloballyEnabled(ctx) {
		return
	}
	s.recoverStalePlatformOperations(ctx, now, nil)
	rows, err := s.db.Query(ctx, `SELECT o.id,o.workspace_id,o.account_id,o.connection_id,o.requested_by,o.device_id,o.platform,c.external_account_key,
		o.kind,o.status,o.stage,o.requested_mode,o.frozen_scope,o.authorization_revision,
		o.workspace_authorization_revision,o.platform_consent_version
		FROM platform_sync_operation o JOIN platform_connection c ON c.id=o.connection_id
		WHERE o.status IN ('queued','waiting_budget','waiting_device')
		AND (o.next_allowed_at IS NULL OR o.next_allowed_at<=$1)
		ORDER BY CASE WHEN o.kind='metrics_refresh' THEN 0 ELSE 1 END,o.created_at,o.id LIMIT 100`, now)
	if err != nil {
		return
	}
	operations := []queuedPlatformOperation{}
	for rows.Next() {
		var op queuedPlatformOperation
		if err := rows.Scan(&op.ID, &op.WorkspaceID, &op.AccountID, &op.ConnectionID, &op.RequestedBy, &op.DeviceID, &op.Platform, &op.ExternalKey, &op.Kind, &op.Status, &op.Stage,
			&op.RequestedMode, &op.FrozenScope, &op.AuthorizationRevision, &op.WorkspaceAuthorizationRevision, &op.ConsentVersion); err != nil {
			rows.Close()
			return
		}
		operations = append(operations, op)
	}
	rows.Close()
	if rows.Err() != nil {
		return
	}
	for _, op := range operations {
		if !s.platformSyncFeatureEnabled(ctx, op.Kind, op.Platform) {
			s.cancelPlatformSyncOperation(ctx, op.ID, "capability_changed", now)
			continue
		}
		if err := s.schedulePlatformOperation(ctx, op, now); err != nil {
			continue
		}
	}
}

func (s *Server) recoverStalePlatformOperations(ctx context.Context, now time.Time, operationID *uuid.UUID) int64 {
	var recovered int64
	if err := s.withTx(ctx, func(tx pgx.Tx) error {
		// A previous v2 retry bug could leave an active v1 run whose query scope still
		// identifies the operation. It cannot advance the v2 checkpoint, so retire it.
		if _, err := tx.Exec(ctx, `UPDATE platform_sync_run r SET status='canceled',cancel_requested_at=$1,finished_at=$1
			WHERE r.operation_id IS NULL AND r.status IN ('queued','leased','running')
			AND EXISTS (SELECT 1 FROM platform_sync_operation o WHERE o.id::text=r.query_scope->>'operation_id'
				AND o.status='running' AND ($2::uuid IS NULL OR o.id=$2) AND NOT EXISTS (SELECT 1 FROM platform_sync_run active
					WHERE active.operation_id=o.id AND active.status IN ('queued','leased','running')))`, now, operationID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `WITH stalled AS (
			SELECT o.id,coalesce((SELECT r.status='expired' AND r.attempt>=$2 FROM platform_sync_run r
				WHERE r.operation_id=o.id AND r.operation_stage=o.stage ORDER BY r.created_at DESC,r.id DESC LIMIT 1),false) AS exhausted
			FROM platform_sync_operation o WHERE o.status='running'
			AND NOT EXISTS (SELECT 1 FROM platform_sync_run active WHERE active.operation_id=o.id AND active.status IN ('queued','leased','running'))
			AND NOT EXISTS (SELECT 1 FROM platform_sync_run orphan WHERE orphan.operation_id IS NULL
				AND orphan.query_scope->>'operation_id'=o.id::text AND orphan.status IN ('queued','leased','running'))
			AND ($3::uuid IS NULL OR o.id=$3))
			UPDATE platform_sync_operation o SET
			status=CASE WHEN stalled.exhausted THEN 'failed' ELSE 'queued' END,
			stage=CASE WHEN stalled.exhausted THEN 'complete' ELSE o.stage END,
			next_allowed_at=CASE WHEN stalled.exhausted THEN o.next_allowed_at ELSE NULL END,
			last_error_code=CASE WHEN stalled.exhausted THEN 'platform_run_expired' ELSE NULL END,pause_reason=NULL,
			revision=revision+1,finished_at=CASE WHEN stalled.exhausted THEN $1::timestamptz ELSE NULL END,updated_at=$1
			FROM stalled WHERE o.id=stalled.id AND o.status='running'`, now, platformRunMaxAttempts, operationID)
		recovered = tag.RowsAffected()
		return err
	}); err != nil {
		slog.Error("平台同步操作：恢复过期运行失败", "err", err)
		return 0
	}
	return recovered
}

func (s *Server) schedulePlatformOperationByID(ctx context.Context, operationID uuid.UUID, now time.Time) {
	var op queuedPlatformOperation
	err := s.db.QueryRow(ctx, `SELECT o.id,o.workspace_id,o.account_id,o.connection_id,o.requested_by,o.device_id,o.platform,c.external_account_key,
		o.kind,o.status,o.stage,o.requested_mode,o.frozen_scope,o.authorization_revision,
		o.workspace_authorization_revision,o.platform_consent_version
		FROM platform_sync_operation o JOIN platform_connection c ON c.id=o.connection_id WHERE o.id=$1`, operationID).Scan(
		&op.ID, &op.WorkspaceID, &op.AccountID, &op.ConnectionID, &op.RequestedBy, &op.DeviceID, &op.Platform, &op.ExternalKey,
		&op.Kind, &op.Status, &op.Stage, &op.RequestedMode, &op.FrozenScope, &op.AuthorizationRevision,
		&op.WorkspaceAuthorizationRevision, &op.ConsentVersion)
	if err != nil {
		slog.Error("平台同步操作：读取手动调度目标失败", "operation_id", operationID, "err", err)
		return
	}
	if !s.platformSyncFeatureEnabled(ctx, op.Kind, op.Platform) {
		s.cancelPlatformSyncOperation(ctx, op.ID, "capability_changed", now)
		return
	}
	if err := s.schedulePlatformOperation(ctx, op, now); err != nil {
		slog.Error("平台同步操作：手动调度失败", "operation_id", operationID, "err", err)
	}
}

func (s *Server) schedulePlatformOperation(ctx context.Context, candidate queuedPlatformOperation, now time.Time) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if err := platformSubjectLock(ctx, tx, candidate.Platform, candidate.ExternalKey); err != nil {
			return err
		}
		var connectionUser, connectionDevice uuid.UUID
		var state, availability, platform, externalKey string
		var connectionRevision int64
		var consentVersion int
		var consentedAt, lastSeen, cooldownUntil *time.Time
		var policyEnabled, accountActive bool
		var workspaceRevision int64
		if err := tx.QueryRow(ctx, `SELECT c.user_id,c.device_id,c.state,c.availability,c.platform,c.external_account_key,
			c.authorization_revision,c.platform_consent_version,c.consented_at,c.last_seen_at,c.cooldown_until,
			p.enabled,p.authorization_revision,a.status='active'
			FROM platform_connection c JOIN platform_collection_policy p ON p.workspace_id=c.workspace_id
			JOIN platform_account a ON a.id=c.account_id AND a.workspace_id=c.workspace_id
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.account_id=$3 FOR UPDATE OF c`,
			candidate.ConnectionID, candidate.WorkspaceID, candidate.AccountID).Scan(
			&connectionUser, &connectionDevice, &state, &availability, &platform, &externalKey, &connectionRevision, &consentVersion,
			&consentedAt, &lastSeen, &cooldownUntil, &policyEnabled, &workspaceRevision, &accountActive); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		var status, stage string
		var authRevision, workspaceAuthRevision int64
		var scopeRaw []byte
		var expiresAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT status,stage,authorization_revision,workspace_authorization_revision,frozen_scope,expires_at
			FROM platform_sync_operation WHERE id=$1 AND workspace_id=$2 AND account_id=$3 AND connection_id=$4 FOR UPDATE`,
			candidate.ID, candidate.WorkspaceID, candidate.AccountID, candidate.ConnectionID).Scan(
			&status, &stage, &authRevision, &workspaceAuthRevision, &scopeRaw, &expiresAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		if status != "queued" && status != "waiting_budget" && status != "waiting_device" {
			return nil
		}
		if !policyEnabled || !accountActive || state == "revoked" {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='canceled',stage='complete',pause_reason='authorization_expired',
				revision=revision+1,finished_at=$2,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		if connectionUser == uuid.Nil || connectionUser != candidate.RequestedBy || connectionDevice == uuid.Nil || connectionDevice != candidate.DeviceID ||
			platform != candidate.Platform || externalKey != candidate.ExternalKey {
			return apiErr(409, "platform_identity_mismatch", "连接主体已变化，请重新核对")
		}
		if expiresAt != nil && !expiresAt.After(now) {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='paused',pause_reason='authorization_expired',
				revision=revision+1,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		if connectionRevision != authRevision || workspaceRevision != workspaceAuthRevision || consentVersion != candidate.ConsentVersion || consentedAt == nil {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_login',pause_reason='authorization_expired',
				revision=revision+CASE WHEN status<>'waiting_login' THEN 1 ELSE 0 END,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		if availability != "ready" || state != "active" {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_login',pause_reason='authorization_expired',
				revision=revision+CASE WHEN status<>'waiting_login' THEN 1 ELSE 0 END,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		if lastSeen == nil || now.Sub(*lastSeen) > platformPresenceTTL {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_device',next_allowed_at=NULL,
				pause_reason=NULL,revision=revision+CASE WHEN status<>'waiting_device' THEN 1 ELSE 0 END,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		if cooldownUntil != nil && cooldownUntil.After(now) {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_budget',next_allowed_at=$2,pause_reason='budget',
				revision=revision+CASE WHEN status<>'waiting_budget' THEN 1 ELSE 0 END,updated_at=$3 WHERE id=$1`, candidate.ID, cooldownUntil, now)
			return err
		}
		if !platformWithinDailyWindow(now, s.loc) {
			next := platformBudgetNextWindow(now)
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_budget',next_allowed_at=$2,pause_reason='budget',
				revision=revision+CASE WHEN status<>'waiting_budget' OR next_allowed_at IS DISTINCT FROM $2 THEN 1 ELSE 0 END,updated_at=$3 WHERE id=$1`, candidate.ID, next, now)
			return err
		}
		var busy bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
			WHERE c.platform=$1 AND c.external_account_key=$2 AND r.status IN ('queued','leased','running'))`, platform, externalKey).Scan(&busy); err != nil {
			return err
		}
		if busy {
			return nil
		}
		allowed, nextAllowedAt, err := s.platformCanReserveRun(ctx, tx, candidate.WorkspaceID, platform, externalKey, now)
		if err != nil {
			return err
		}
		if !allowed {
			_, err = tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_budget',next_allowed_at=$2,pause_reason='budget',
				revision=revision+CASE WHEN status<>'waiting_budget' THEN 1 ELSE 0 END,updated_at=$3 WHERE id=$1`, candidate.ID, nextAllowedAt, now)
			return err
		}
		var capabilities []byte
		var adapter, browser string
		var mapping int
		if err := tx.QueryRow(ctx, `SELECT capabilities,coalesce(capabilities->>'adapterVersion',''),
			coalesce((capabilities->>'mappingVersion')::int,1),coalesce(capabilities->>'browserVersion','')
			FROM platform_connection WHERE id=$1`, candidate.ConnectionID).Scan(&capabilities, &adapter, &mapping, &browser); err != nil {
			return err
		}
		if candidate.Kind == "account_sync" && platformSyncCapabilityState(capabilities, platform, "catalog") != "supported" {
			_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='failed',stage='complete',last_error_code='capability_unverified',
				revision=revision+1,finished_at=$2,updated_at=$2 WHERE id=$1`, candidate.ID, now)
			return err
		}
		binding, stage, taskKind, queryScope, workAttempts, err := s.platformOperationRunSnapshot(ctx, tx, candidate, stage, scopeRaw, platform, externalKey, now)
		if err != nil {
			return err
		}
		// 冻结目标约束可访问作品；仅在 worker 实际请求详情/指标前扣作品级预算。
		_ = workAttempts
		var attempt int
		// 成功保存的页级检查点不消耗重试次数；只延续同阶段最近一次过期的次数。
		if err := tx.QueryRow(ctx, `SELECT coalesce((SELECT CASE WHEN status='expired' THEN attempt+1 ELSE 1 END
			FROM platform_sync_run WHERE operation_id=$1 AND operation_stage=$2 ORDER BY created_at DESC,id DESC LIMIT 1),1)`, candidate.ID, stage).Scan(&attempt); err != nil {
			return err
		}
		var runID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO platform_sync_run
			(connection_id,workspace_id,account_id,requested_by,trigger,task_kind,status,query_scope,
			authorization_revision,workspace_authorization_revision,adapter_version,mapping_version,browser_version,
			binding_snapshot,deadline_at,operation_id,wire_protocol_version,operation_stage,budget_query_count,budget_work_attempts,attempt)
			VALUES($1,$2,$3,$4,'manual',$5,'queued',$6,$7,$8,$9,$10,$11,$12,$13,$14,2,$15,0,$16,$17) RETURNING id`,
			candidate.ConnectionID, candidate.WorkspaceID, candidate.AccountID, connectionUser, taskKind, queryScope, connectionRevision,
			workspaceRevision, adapter, mapping, browser, binding, now.Add(platformRunMaxDuration), candidate.ID, stage, 0, attempt).Scan(&runID); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE platform_sync_operation SET status='queued',stage=$2,next_allowed_at=NULL,pause_reason=NULL,
			revision=revision+CASE WHEN stage<>$2 OR status<>'queued' THEN 1 ELSE 0 END,updated_at=$3 WHERE id=$1`, candidate.ID, stage, now)
		if err != nil {
			return err
		}
		return s.auditTx(ctx, tx, "platform_sync_operation_run_create", "platform_sync_operation", candidate.ID.String(), "ok",
			map[string]any{"run_id": runID, "kind": candidate.Kind, "stage": stage})
	})
}

func (s *Server) cancelPlatformSyncOperation(ctx context.Context, operationID uuid.UUID, reason string, now time.Time) {
	_, _ = s.db.Exec(ctx, `UPDATE platform_sync_operation SET status='canceled',stage='complete',pause_reason=$2,
		revision=revision+1,finished_at=$3,updated_at=$3 WHERE id=$1 AND status IN ('queued','running','waiting_budget','waiting_device','waiting_login','paused')`, operationID, reason, now)
	_, _ = s.db.Exec(ctx, `UPDATE platform_sync_run SET status='canceled',cancel_requested_at=$2,finished_at=$2
		WHERE operation_id=$1 AND status IN ('queued','leased','running')`, operationID, now)
}

func (s *Server) platformOperationRunSnapshot(ctx context.Context, tx pgx.Tx, op queuedPlatformOperation, currentStage string,
	scopeRaw []byte, platform, externalKey string, now time.Time) ([]byte, string, string, []byte, int, error) {
	var scope map[string]any
	if err := json.Unmarshal(scopeRaw, &scope); err != nil {
		return nil, "", "", nil, 0, err
	}
	stage := currentStage
	if op.Kind == "account_sync" && stage == "queued" {
		stage = "profile"
	}
	if op.Kind == "metrics_refresh" && stage == "queued" {
		stage = "metrics"
	}
	taskKind := "collect"
	workAttempts := 0
	binding := map[string]any{"version": 2, "local_bindings": []any{}, "platform_works": []any{}}
	var checkpointRaw []byte
	if err := tx.QueryRow(ctx, `SELECT checkpoint FROM platform_sync_operation WHERE id=$1 FOR UPDATE`, op.ID).Scan(&checkpointRaw); err != nil {
		return nil, "", "", nil, 0, err
	}
	checkpoint := map[string]any{}
	if err := json.Unmarshal(checkpointRaw, &checkpoint); err != nil {
		return nil, "", "", nil, 0, err
	}
	if op.Kind == "account_sync" {
		taskKind = "account_sync"
		binding["scope"] = scope
		switch stage {
		case "catalog":
			// 目录阶段顺带取得的 inline_metrics 也会写成观测，而观测要能被用户确认成正式指标，
			// 就必须在冻结快照里找到本地绑定（platformV2LocalBindingForExternalID 只认这个数组）。
			// 以前 catalog 阶段两个数组都是空的，于是每次账号同步采到的读数全部 match_state=unmatched，
			// 用户在作品库里看到的每条都是"尚未匹配到已绑定作品"、点确认只会 409
			// （2026-10-27 实测：39 条观测全部无法确认）。
			// 这里冻结与 v1 同一份"已精确绑定的已发布作品"，未绑定的平台作品照旧不冻结——
			// 文档 §2208 的口径不变：未绑定镜像的观测不生成正式指标。
			local, err := s.platformTargetsSnapshot(ctx, tx, op.AccountID, platform, now)
			if err != nil {
				return nil, "", "", nil, 0, err
			}
			binding["local_bindings"] = local
		case "content":
			mirrors, err := pendingPlatformMirrorTargets(ctx, tx, op, platform, externalKey, "content")
			if err != nil {
				return nil, "", "", nil, 0, err
			}
			binding["platform_works"] = mirrors
			workAttempts = len(mirrors)
		case "metrics":
			mirrors, err := pendingPlatformMirrorTargets(ctx, tx, op, platform, externalKey, "metrics")
			if err != nil {
				return nil, "", "", nil, 0, err
			}
			binding["platform_works"] = mirrors
			workAttempts = len(mirrors)
		}
	} else if scope["target_scope"] == "explicit" {
		raw, _ := json.Marshal(scope["targets"])
		var targets []platformMetricTarget
		if err := json.Unmarshal(raw, &targets); err != nil {
			return nil, "", "", nil, 0, err
		}
		local, mirrors, err := s.explicitPlatformRunTargets(ctx, tx, op, platform, externalKey, targets)
		if err != nil {
			return nil, "", "", nil, 0, err
		}
		binding["local_bindings"] = local
		binding["platform_works"] = mirrors
		workAttempts = len(targets)
	} else {
		local, mirrors, err := s.dueAndRecentPlatformRunTargets(ctx, tx, op, platform, externalKey, scope, now)
		if err != nil {
			return nil, "", "", nil, 0, err
		}
		binding["local_bindings"] = local
		binding["platform_works"] = mirrors
		workAttempts = len(local) + len(mirrors)
		if workAttempts > platformRunTargetsPerRun {
			workAttempts = platformRunTargetsPerRun
		}
	}
	queryScope, _ := json.Marshal(map[string]any{"protocol_version": 2, "operation_id": op.ID, "kind": op.Kind, "stage": stage,
		"requested_mode": op.RequestedMode, "frozen_scope": scope, "checkpoint": checkpoint})
	bindingJSON, err := json.Marshal(binding)
	return bindingJSON, stage, taskKind, queryScope, workAttempts, err
}

func pendingPlatformMirrorTargets(ctx context.Context, tx pgx.Tx, op queuedPlatformOperation, platform, externalKey, stage string) ([]map[string]any, error) {
	column := "content_state"
	if stage == "metrics" {
		column = "initial_metrics_state"
	} else if stage != "content" {
		return nil, validation("平台镜像目标阶段无效")
	}
	rows, err := tx.Query(ctx, `SELECT id,external_id,remote_content_type,content_revision FROM platform_work_mirror
		WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND external_account_key=$4 AND remote_status='published'
		AND last_sync_operation_id=$5 AND `+column+` NOT IN ('complete','unsupported','denied')
		ORDER BY published_at DESC NULLS LAST,id LIMIT $6`, op.WorkspaceID, op.AccountID, platform, externalKey, op.ID, platformRunTargetsPerRun)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := []map[string]any{}
	for rows.Next() {
		var mirrorID uuid.UUID
		var externalID, contentType string
		var revision int
		if err := rows.Scan(&mirrorID, &externalID, &contentType, &revision); err != nil {
			return nil, err
		}
		targets = append(targets, map[string]any{"platform_work_id": mirrorID, "external_id": externalID,
			"external_account_key": externalKey, "remote_content_type": contentType, "content_revision": revision})
	}
	return targets, rows.Err()
}

func (s *Server) explicitPlatformRunTargets(ctx context.Context, tx pgx.Tx, op queuedPlatformOperation, platform, externalKey string,
	targets []platformMetricTarget) ([]map[string]any, []map[string]any, error) {
	local := []map[string]any{}
	mirrors := []map[string]any{}
	for _, target := range targets {
		for _, workIDRaw := range target.WorkIDs {
			workID, err := uuid.Parse(workIDRaw)
			if err != nil {
				return nil, nil, err
			}
			var bindingRevision, publishRevision int
			var column = platformExternalIDColumn(platform)
			if column == "" {
				continue
			}
			if err := tx.QueryRow(ctx, `SELECT metric_binding_revision,coalesce(publish_revision,1) FROM work
				WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL AND `+column+`=$3 AND platform_binding_source IN ('user_link','user_confirm','official_exact')`,
				workID, op.AccountID, target.ExternalID).Scan(&bindingRevision, &publishRevision); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				return nil, nil, err
			}
			local = append(local, map[string]any{"work_id": workID, "external_id": target.ExternalID, "binding_revision": bindingRevision, "publish_revision": publishRevision})
		}
		if target.PlatformWorkID != "" {
			mirrorID, err := uuid.Parse(target.PlatformWorkID)
			if err != nil {
				return nil, nil, err
			}
			var contentType string
			var revision int
			if err := tx.QueryRow(ctx, `SELECT remote_content_type,content_revision FROM platform_work_mirror WHERE id=$1 AND workspace_id=$2
				AND account_id=$3 AND platform=$4 AND external_account_key=$5 AND external_id=$6 AND remote_status='published'`,
				mirrorID, op.WorkspaceID, op.AccountID, platform, externalKey, target.ExternalID).Scan(&contentType, &revision); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					continue
				}
				return nil, nil, err
			}
			mirrors = append(mirrors, map[string]any{"platform_work_id": mirrorID, "external_id": target.ExternalID, "external_account_key": externalKey,
				"remote_content_type": contentType, "content_revision": revision})
		}
	}
	return local, mirrors, nil
}

func (s *Server) dueAndRecentPlatformRunTargets(ctx context.Context, tx pgx.Tx, op queuedPlatformOperation, platform, externalKey string,
	scope map[string]any, now time.Time) ([]map[string]any, []map[string]any, error) {
	column := platformExternalIDColumn(platform)
	if column == "" {
		return []map[string]any{}, []map[string]any{}, nil
	}
	limit := platformRunTargetsPerRun
	upperBound := now
	if raw, ok := scope["targets_as_of"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			upperBound = parsed
		}
	}
	local := []map[string]any{}
	mirrors := []map[string]any{}
	seen := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT w.id,w.`+column+`,w.metric_binding_revision,coalesce(w.publish_revision,1)
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.status='published' AND w.published_at IS NOT NULL
		AND w.published_at<=$2 AND w.`+column+` IS NOT NULL AND w.platform_binding_source IN ('user_link','user_confirm','official_exact')
		AND NOT EXISTS(SELECT 1 FROM platform_metric_observation o WHERE o.workspace_id=$3 AND o.account_id=$1
			AND o.external_account_key=$4 AND o.external_id=w.`+column+` AND o.scope='work' AND o.source=$5
			AND o.created_at>=($2::timestamptz-interval '6 hours'))
		AND EXISTS(SELECT 1 FROM generate_series(1,14) d(day_offset) WHERE d.day_offset IN (1,3,7,14)
			AND w.published_at::date+d.day_offset<=$2::date
			AND NOT EXISTS(SELECT 1 FROM metric_node_public(w.id,d.day_offset) m WHERE m.node_exact))
		ORDER BY w.published_at ASC,w.id LIMIT $6`, op.AccountID, upperBound, op.WorkspaceID, externalKey,
		platformMetricSource(platform), limit)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var workID uuid.UUID
		var externalID string
		var bindingRevision, publishRevision int
		if err := rows.Scan(&workID, &externalID, &bindingRevision, &publishRevision); err != nil {
			rows.Close()
			return nil, nil, err
		}
		seen[externalID] = true
		local = append(local, map[string]any{"work_id": workID, "external_id": externalID, "binding_revision": bindingRevision, "publish_revision": publishRevision})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	remaining := limit - len(local)
	if remaining <= 0 {
		return local, mirrors, nil
	}
	rows, err = tx.Query(ctx, `SELECT id,external_id,remote_content_type,content_revision FROM platform_work_mirror
		WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND external_account_key=$4 AND remote_status='published'
		AND published_at >= ($5::timestamptz-interval '30 days') AND published_at<=$5
		AND NOT EXISTS(SELECT 1 FROM platform_metric_observation o WHERE o.workspace_id=$1 AND o.account_id=$2
			AND o.external_account_key=$4 AND o.external_id=platform_work_mirror.external_id AND o.scope='work' AND o.source=$7
			AND o.created_at>=($5::timestamptz-interval '6 hours'))
		ORDER BY published_at DESC NULLS LAST,id LIMIT $6`,
		op.WorkspaceID, op.AccountID, platform, externalKey, upperBound, remaining, platformMetricSource(platform))
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var mirrorID uuid.UUID
		var externalID, contentType string
		var revision int
		if err := rows.Scan(&mirrorID, &externalID, &contentType, &revision); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if seen[externalID] {
			continue
		}
		seen[externalID] = true
		mirrors = append(mirrors, map[string]any{"platform_work_id": mirrorID, "external_id": externalID,
			"external_account_key": externalKey, "remote_content_type": contentType, "content_revision": revision})
	}
	rows.Close()
	return local, mirrors, rows.Err()
}
