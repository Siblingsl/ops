package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	platformSyncOperationQueued        = "queued"
	platformSyncOperationRunning       = "running"
	platformSyncOperationPaused        = "paused"
	platformSyncOperationWaitingBudget = "waiting_budget"
	platformSyncOperationWaitingDevice = "waiting_device"
	platformSyncOperationWaitingLogin  = "waiting_login"
)

type platformAccountSyncRequest struct {
	Mode                       string `json:"mode"`
	ExpectedConnectionRevision int64  `json:"expected_connection_revision"`
}

type platformOperationReceipt struct {
	Key         string          `json:"key"`
	Kind        string          `json:"kind"`
	RequestedBy string          `json:"requested_by"`
	RequestHash string          `json:"request_hash"`
	HTTPStatus  int             `json:"http_status"`
	Response    json.RawMessage `json:"response"`
	CreatedAt   time.Time       `json:"created_at"`
}

type platformSyncOperationSpec struct {
	Kind                       string
	RequestedMode              string
	EffectiveMode              string
	ExpectedConnectionRevision int64
	IdempotencyKey             string
	RequestHash                string
	FrozenScope                map[string]any
	Coverage                   map[string]any
	NoTargets                  bool
	RequiredCapability         string
}

// platformSyncFeaturePlatforms publishes only server-enabled v2 paths. Each
// platform remains off until its real-account capability evidence is approved.
func (s *Server) platformSyncFeaturePlatforms(ctx context.Context, feature string) []string {
	if !s.platformCollectionGloballyEnabled(ctx) {
		return []string{}
	}
	platforms := []string{}
	for _, platform := range []string{"xhs", "wechat_mp"} {
		enabled, err := s.systemBool(ctx, "platform_"+feature+"."+platform+".enabled", false)
		if err == nil && enabled {
			platforms = append(platforms, platform)
		}
	}
	return platforms
}

func (s *Server) platformSyncFeatureEnabled(ctx context.Context, feature, platform string) bool {
	for _, enabledPlatform := range s.platformSyncFeaturePlatforms(ctx, feature) {
		if enabledPlatform == platform {
			return true
		}
	}
	return false
}

func (s *Server) requestPlatformAccountSync(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	if platformProofMissing(r) {
		return apiErr(http.StatusForbidden, "desktop_required", "请在保存该平台登录的本机客户端发起账号同步")
	}
	body, proof, err := s.desktopReadAndVerifyProof(r, "platform.account.sync.request")
	if err != nil {
		return err
	}
	var in platformAccountSyncRequest
	if err := decodeStrictPlatformJSON(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.Mode != "incremental" && in.Mode != "full_reconcile" {
		return validation("同步模式只能是 incremental 或 full_reconcile")
	}
	if in.ExpectedConnectionRevision <= 0 {
		return validation("缺少连接版本")
	}
	key, err := platformIdempotencyKey(r)
	if err != nil {
		return err
	}
	hash, err := platformRequestHash(in)
	if err != nil {
		return err
	}
	response, status, err := s.createPlatformSyncOperation(r.Context(), accountID, proof,
		platformSyncOperationSpec{
			Kind: "account_sync", RequestedMode: in.Mode,
			ExpectedConnectionRevision: in.ExpectedConnectionRevision,
			IdempotencyKey:             key, RequestHash: hash,
			FrozenScope:        map[string]any{"requested_mode": in.Mode},
			RequiredCapability: "catalog",
		},
	)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, response)
	return nil
}

func (s *Server) createPlatformSyncOperation(ctx context.Context, accountID uuid.UUID, proof desktopChallenge, spec platformSyncOperationSpec) (map[string]any, int, error) {
	id := ident(ctx)
	if id == nil || id.AdminOverride {
		return nil, 0, apiErr(403, "forbidden", "当前身份不能使用平台数据同步")
	}
	if err := s.requireAccountInWorkspace(ctx, accountID); err != nil {
		return nil, 0, err
	}
	connection, err := s.platformConnectionForAccount(ctx, id.WorkspaceID, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, apiErr(409, "platform_consent_required", "该账号尚未建立平台连接")
		}
		return nil, 0, err
	}
	feature := spec.Kind
	if !s.platformSyncFeatureEnabled(ctx, feature, connection.Platform) {
		return nil, 0, apiErr(403, "platform_"+feature+"_disabled", "该平台的同步能力尚未通过验收并启用")
	}
	if connection.UserID != id.UserID || connection.DeviceID != proof.DeviceID {
		return nil, 0, apiErr(403, "platform_not_holder", "只有连接保管人的主设备可以发起平台读取")
	}
	if connection.State != "active" || connection.Availability != "ready" || connection.ConsentedAt == nil {
		return nil, 0, apiErr(409, "login_required", "平台连接当前不可读取，请由本人重新核对登录")
	}
	now := s.now()
	if connection.LastSeenAt == nil || now.Sub(*connection.LastSeenAt) > platformPresenceTTL {
		return nil, 0, apiErr(409, "device_offline", "保存该连接的本机客户端当前离线")
	}
	if spec.ExpectedConnectionRevision != connection.AuthorizationRevision {
		return nil, 0, apiErr(409, "connection_revision_conflict", "平台连接版本已变化，请刷新后重试")
	}

	var response map[string]any
	var responseStatus int
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
			"platform-subject:"+connection.Platform+":"+connection.ExternalAccountKey); err != nil {
			return err
		}
		var accountStatus, platform, externalKey, connectionState, availability string
		var connectionUser, connectionDevice uuid.UUID
		var authorizationRevision int64
		var consentVersion int
		var consentedAt, lastSeenAt *time.Time
		var capabilitiesRaw []byte
		var policyEnabled bool
		var policyRevision int64
		err := tx.QueryRow(ctx, `SELECT a.status, c.platform, c.external_account_key, c.user_id, c.device_id,
			c.state, c.availability, c.authorization_revision, c.platform_consent_version, c.consented_at,
			c.last_seen_at, c.capabilities, p.enabled, p.authorization_revision
			FROM platform_connection c
			JOIN platform_account a ON a.id=c.account_id AND a.workspace_id=c.workspace_id
			JOIN platform_collection_policy p ON p.workspace_id=c.workspace_id
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.account_id=$3
			FOR UPDATE OF c`, connection.ID, id.WorkspaceID, accountID).Scan(
			&accountStatus, &platform, &externalKey, &connectionUser, &connectionDevice, &connectionState,
			&availability, &authorizationRevision, &consentVersion, &consentedAt, &lastSeenAt,
			&capabilitiesRaw, &policyEnabled, &policyRevision,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(409, "platform_consent_required", "平台连接或工作区策略已变化，请刷新后重试")
		}
		if err != nil {
			return err
		}
		if accountStatus != "active" {
			return apiErr(409, "account_disabled", "账号已停用，不能发起平台读取")
		}
		if !policyEnabled {
			return apiErr(403, "collection_disabled", "当前工作区已关闭平台数据读取")
		}
		if connectionUser != id.UserID || connectionDevice != proof.DeviceID {
			return apiErr(403, "platform_not_holder", "只有连接保管人的主设备可以发起平台读取")
		}
		if connectionState != "active" || availability != "ready" || consentedAt == nil || consentVersion <= 0 {
			return apiErr(409, "login_required", "平台连接当前不可读取，请由本人重新核对登录")
		}
		if authorizationRevision != spec.ExpectedConnectionRevision {
			return apiErr(409, "connection_revision_conflict", "平台连接版本已变化，请刷新后重试")
		}
		if lastSeenAt == nil || now.Sub(*lastSeenAt) > platformPresenceTTL {
			return apiErr(409, "device_offline", "保存该连接的本机客户端当前离线")
		}
		if !s.platformSyncFeatureEnabled(ctx, spec.Kind, platform) {
			return apiErr(403, "platform_"+spec.Kind+"_disabled", "该平台的同步能力尚未通过验收并启用")
		}
		capabilityState := platformSyncCapabilityState(capabilitiesRaw, platform, spec.RequiredCapability)
		if spec.RequiredCapability != "" && capabilityState != "supported" {
			return apiErr(422, "capability_unverified", "平台必要读取能力尚未核验").With(map[string]any{
				"required": spec.RequiredCapability, "state": capabilityState,
			})
		}

		rows, err := tx.Query(ctx, `SELECT id, request_receipts FROM platform_sync_operation
			WHERE workspace_id=$1 AND account_id=$2 AND requested_by=$3 AND kind=$4
			ORDER BY created_at DESC FOR UPDATE`, id.WorkspaceID, accountID, id.UserID, spec.Kind)
		if err != nil {
			return err
		}
		var existingID uuid.UUID
		for rows.Next() {
			var operationID uuid.UUID
			var raw []byte
			if err := rows.Scan(&operationID, &raw); err != nil {
				rows.Close()
				return err
			}
			var receipts []platformOperationReceipt
			if err := json.Unmarshal(raw, &receipts); err != nil {
				rows.Close()
				return err
			}
			for _, receipt := range receipts {
				if receipt.Key != spec.IdempotencyKey {
					continue
				}
				rows.Close()
				if receipt.RequestHash != spec.RequestHash {
					return apiErr(409, "idempotency_conflict", "同一 Idempotency-Key 不能用于不同请求")
				}
				if err := json.Unmarshal(receipt.Response, &response); err != nil {
					return err
				}
				responseStatus = receipt.HTTPStatus
				return nil
			}
			if existingID == uuid.Nil {
				existingID = operationID
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		activeStatus := []string{platformSyncOperationQueued, platformSyncOperationRunning, platformSyncOperationPaused,
			platformSyncOperationWaitingBudget, platformSyncOperationWaitingDevice, platformSyncOperationWaitingLogin}
		var activeID uuid.UUID
		var activeRequestedMode, activeEffectiveMode, activeStatusValue, activeStage string
		var activeRevision int64
		err = tx.QueryRow(ctx, `SELECT id, requested_mode, effective_mode, status, stage, revision
			FROM platform_sync_operation WHERE account_id=$1 AND kind=$2 AND status=ANY($3::text[])
			ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, accountID, spec.Kind, activeStatus).Scan(
			&activeID, &activeRequestedMode, &activeEffectiveMode, &activeStatusValue, &activeStage, &activeRevision,
		)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil {
			if spec.Kind == "account_sync" && spec.RequestedMode == "full_reconcile" && activeEffectiveMode != "full_reconcile" {
				return apiErr(409, "operation_in_progress", "当前账号已有范围不同的同步操作正在进行")
			}
			if spec.Kind == "metrics_refresh" {
				var currentScope []byte
				if err := tx.QueryRow(ctx, `SELECT frozen_scope FROM platform_sync_operation WHERE id=$1`, activeID).Scan(&currentScope); err != nil {
					return err
				}
				wanted, _ := json.Marshal(spec.FrozenScope)
				if string(currentScope) != string(wanted) {
					return apiErr(409, "operation_in_progress", "当前账号已有不同目标的指标刷新正在进行")
				}
			}
			var activeReceipts []byte
			if err := tx.QueryRow(ctx, `SELECT request_receipts FROM platform_sync_operation WHERE id=$1`, activeID).Scan(&activeReceipts); err != nil {
				return err
			}
			status := "existing"
			responseStatus = http.StatusOK
			response = platformOperationResponse(status, activeID, spec.Kind, activeRequestedMode,
				activeEffectiveMode, activeStatusValue, activeStage, activeRevision, nil, nil)
			return appendPlatformOperationReceipt(ctx, tx, activeID, activeReceipts, spec, id.UserID, responseStatus, response, now)
		}

		effectiveMode := spec.EffectiveMode
		if spec.Kind == "account_sync" {
			if spec.RequestedMode == "full_reconcile" {
				effectiveMode = "full_reconcile"
			} else {
				var baseline bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS(
					SELECT 1 FROM platform_sync_operation
					WHERE account_id=$1 AND kind='account_sync'
					AND coverage->'catalog'->>'state'='complete')`, accountID).Scan(&baseline); err != nil {
					return err
				}
				effectiveMode = "incremental"
				if !baseline {
					effectiveMode = "initial"
				}
			}
		}
		createdScope := map[string]any{
			"platform": platform, "requested_mode": spec.RequestedMode,
			"scope_upper_bound":        now.UTC().Format(time.RFC3339Nano),
			"external_account_key":     externalKey,
			"content_capability_state": platformSyncCapabilityState(capabilitiesRaw, platform, "content"),
		}
		for key, value := range spec.FrozenScope {
			createdScope[key] = value
		}
		stage, status := "queued", "queued"
		coverage := platformInitialCoverage(platformSyncCapabilityState(capabilitiesRaw, platform, "content"))
		counters := platformInitialCounters()
		finishedAt := any(nil)
		if spec.NoTargets {
			stage, status = "complete", "succeeded"
			coverage["metrics"] = map[string]any{"state": "complete", "target_count": 0, "reason": nil}
			finishedAt = now
		}
		scopeJSON, _ := json.Marshal(createdScope)
		coverageJSON, _ := json.Marshal(coverage)
		countersJSON, _ := json.Marshal(counters)
		var operationID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO platform_sync_operation
			(workspace_id,account_id,platform,connection_id,requested_by,device_id,kind,requested_mode,effective_mode,
			 status,stage,authorization_revision,workspace_authorization_revision,platform_consent_version,
			 frozen_scope,checkpoint,counters,coverage,expires_at,created_at,started_at,finished_at,updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'{}'::jsonb,$16,$17,$18,$19,
			 CASE WHEN $10='queued' THEN now() ELSE NULL END,$20,now()) RETURNING id`,
			id.WorkspaceID, accountID, platform, connection.ID, id.UserID, proof.DeviceID, spec.Kind,
			spec.RequestedMode, effectiveMode, status, stage, authorizationRevision, policyRevision,
			consentVersion, scopeJSON, countersJSON, coverageJSON, now.Add(7*24*time.Hour), now, finishedAt,
		).Scan(&operationID); err != nil {
			return err
		}
		responseStatus = http.StatusAccepted
		if spec.NoTargets {
			responseStatus = http.StatusOK
		}
		responseState := "queued"
		if spec.NoTargets {
			responseState = "no_targets"
		}
		response = platformOperationResponse(responseState, operationID, spec.Kind, spec.RequestedMode,
			effectiveMode, status, stage, 1, createdScope, coverage)
		if spec.NoTargets {
			response["target_count"] = 0
			response["message"] = "当前没有可刷新的作品；请先同步账号或选择单篇作品"
		}
		if err := appendPlatformOperationReceipt(ctx, tx, operationID, []byte("[]"), spec, id.UserID, responseStatus, response, now); err != nil {
			return err
		}
		return s.auditTx(ctx, tx, "platform_sync_operation_create", "platform_sync_operation", operationID.String(), "ok",
			map[string]any{"account_id": accountID, "platform": platform, "kind": spec.Kind, "mode": effectiveMode})
	})
	if err != nil {
		return nil, 0, err
	}
	return response, responseStatus, nil
}

func appendPlatformOperationReceipt(ctx context.Context, tx pgx.Tx, operationID uuid.UUID, raw []byte,
	spec platformSyncOperationSpec, userID uuid.UUID, status int, response map[string]any, now time.Time) error {
	var receipts []platformOperationReceipt
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &receipts); err != nil {
			return err
		}
	}
	if len(receipts) >= 1000 {
		return apiErr(429, "request_rate_limited", "该操作已保存最多请求回执，请稍后使用现有进度")
	}
	responseJSON, err := json.Marshal(response)
	if err != nil {
		return err
	}
	receipts = append(receipts, platformOperationReceipt{
		Key: spec.IdempotencyKey, Kind: spec.Kind, RequestedBy: userID.String(), RequestHash: spec.RequestHash,
		HTTPStatus: status, Response: responseJSON, CreatedAt: now,
	})
	encoded, err := json.Marshal(receipts)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE platform_sync_operation SET request_receipts=$2, updated_at=$3 WHERE id=$1`, operationID, encoded, now)
	return err
}

func platformOperationResponse(status string, id uuid.UUID, kind, requestedMode, effectiveMode, operationStatus, stage string,
	revision int64, scope, coverage map[string]any) map[string]any {
	operation := map[string]any{
		"id": id, "kind": kind, "requested_mode": requestedMode, "effective_mode": effectiveMode,
		"revision": revision, "status": operationStatus, "stage": stage,
	}
	if scope != nil {
		operation["frozen_scope"] = scope
	}
	if coverage != nil {
		operation["coverage"] = coverage
	}
	return map[string]any{"status": status, "operation": operation}
}

func platformSyncCapabilityState(raw []byte, platform, capability string) string {
	var values map[string]any
	if json.Unmarshal(raw, &values) != nil {
		return "unknown"
	}
	key := ""
	switch capability {
	case "catalog":
		if platform == "xhs" {
			key = "workList"
		} else if platform == "wechat_mp" {
			key = "publishedList"
		}
	case "metrics":
		if platform == "xhs" {
			key = "perNoteMetrics"
		} else if platform == "wechat_mp" {
			key = "perArticleMetrics"
		}
	case "content":
		if platform == "xhs" {
			key = "noteContent"
		} else if platform == "wechat_mp" {
			key = "articleContent"
		}
	}
	state, _ := values[key].(string)
	if state == "supported" || state == "denied" || state == "temporarily_unavailable" || state == "unsupported" {
		return state
	}
	return "unknown"
}

func platformInitialCoverage(contentState string) map[string]any {
	return map[string]any{
		"profile": map[string]any{"state": "not_started", "range": nil, "total_count": nil, "succeeded": 0, "failed": 0, "pending": 0, "reason": nil},
		"catalog": map[string]any{"state": "not_started", "range": nil, "total_count": nil, "succeeded": 0, "failed": 0, "pending": 0, "reason": nil},
		"content": map[string]any{"state": "not_started", "capability_state": contentState, "range": nil, "total_count": nil, "succeeded": 0, "failed": 0, "pending": 0, "reason": nil},
		"metrics": map[string]any{"state": "not_started", "range": nil, "total_count": nil, "succeeded": 0, "failed": 0, "pending": 0, "reason": nil},
	}
}

func platformInitialCounters() map[string]int {
	return map[string]int{
		"discovered": 0, "created": 0, "changed": 0, "unchanged": 0, "content_received": 0,
		"metrics_observed": 0, "metrics_adopted": 0, "pending_confirmation": 0, "failed": 0, "skipped": 0,
	}
}

func platformIdempotencyKey(r *http.Request) (string, error) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	id, err := uuid.Parse(key)
	if err != nil || key == "" {
		return "", validation("Idempotency-Key 必须是 UUID")
	}
	return id.String(), nil
}

func platformRequestHash(value any) (string, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:]), nil
}

func decodeStrictPlatformJSON(body []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
