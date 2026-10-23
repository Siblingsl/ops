package app

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type platformSyncOperationRecord struct {
	ID                             uuid.UUID
	WorkspaceID                    uuid.UUID
	AccountID                      uuid.UUID
	ConnectionID                   uuid.UUID
	RequestedBy                    uuid.UUID
	DeviceID                       uuid.UUID
	Platform                       string
	Kind                           string
	RequestedMode                  string
	EffectiveMode                  string
	Status                         string
	Stage                          string
	Revision                       int64
	AuthorizationRevision          int64
	WorkspaceAuthorizationRevision int64
	PlatformConsentVersion         int
	FrozenScope                    json.RawMessage
	Checkpoint                     json.RawMessage
	Counters                       json.RawMessage
	Coverage                       json.RawMessage
	ExpiresAt                      *time.Time
	NextAllowedAt                  *time.Time
	PauseReason                    *string
	LastErrorCode                  *string
	CreatedAt                      time.Time
	StartedAt                      *time.Time
	FinishedAt                     *time.Time
}

func (s *Server) listPlatformSyncOperations(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if id == nil || id.AdminOverride {
		return apiErr(http.StatusForbidden, "forbidden", "当前身份不能读取平台同步进度")
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 100 {
		return validation("limit 必须在 1～100 之间")
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, workspace_id, account_id, connection_id, requested_by, device_id,
		platform, kind, requested_mode, effective_mode, status, stage, revision, authorization_revision,
		workspace_authorization_revision, platform_consent_version, frozen_scope, checkpoint, counters, coverage,
		expires_at, next_allowed_at, pause_reason, last_error_code, created_at, started_at, finished_at
		FROM platform_sync_operation WHERE workspace_id=$1 AND account_id=$2
		AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4))
		ORDER BY created_at DESC,id DESC LIMIT $5`, id.WorkspaceID, accountID,
		cursorTime(cursor), cursorID(cursor), limit+1)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for rows.Next() {
		record, err := scanPlatformSyncOperation(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, s.platformSyncOperationSummary(r, record))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var nextCursor *string
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		at, _ := time.Parse(time.RFC3339Nano, last["created_at"].(string))
		lastID, _ := uuid.Parse(last["id"].(string))
		encoded := encodeListCursor(at, lastID)
		nextCursor = &encoded
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func (s *Server) getPlatformSyncOperation(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	operationID, err := pathID(r, "operationId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	record, err := s.loadPlatformSyncOperation(r, accountID, operationID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"operation": s.platformSyncOperationSummary(r, record)})
}

func (s *Server) loadPlatformSyncOperation(r *http.Request, accountID, operationID uuid.UUID) (platformSyncOperationRecord, error) {
	id := ident(r.Context())
	if id == nil || id.AdminOverride {
		return platformSyncOperationRecord{}, apiErr(http.StatusForbidden, "forbidden", "当前身份不能读取平台同步进度")
	}
	return scanPlatformSyncOperation(s.db.QueryRow(r.Context(), `SELECT id, workspace_id, account_id, connection_id, requested_by, device_id,
		platform, kind, requested_mode, effective_mode, status, stage, revision, authorization_revision,
		workspace_authorization_revision, platform_consent_version, frozen_scope, checkpoint, counters, coverage,
		expires_at, next_allowed_at, pause_reason, last_error_code, created_at, started_at, finished_at
		FROM platform_sync_operation WHERE id=$1 AND workspace_id=$2 AND account_id=$3`, operationID, id.WorkspaceID, accountID))
}

func scanPlatformSyncOperation(row interface{ Scan(...any) error }) (platformSyncOperationRecord, error) {
	var op platformSyncOperationRecord
	err := row.Scan(&op.ID, &op.WorkspaceID, &op.AccountID, &op.ConnectionID, &op.RequestedBy, &op.DeviceID,
		&op.Platform, &op.Kind, &op.RequestedMode, &op.EffectiveMode, &op.Status, &op.Stage, &op.Revision,
		&op.AuthorizationRevision, &op.WorkspaceAuthorizationRevision, &op.PlatformConsentVersion,
		&op.FrozenScope, &op.Checkpoint, &op.Counters, &op.Coverage,
		&op.ExpiresAt, &op.NextAllowedAt, &op.PauseReason, &op.LastErrorCode, &op.CreatedAt, &op.StartedAt, &op.FinishedAt)
	return op, err
}

func (s *Server) platformSyncOperationSummary(r *http.Request, op platformSyncOperationRecord) map[string]any {
	available := []string{}
	id := ident(r.Context())
	canManage := false
	var connectionUser, connectionDevice uuid.UUID
	_ = s.db.QueryRow(r.Context(), `SELECT user_id,device_id FROM platform_connection WHERE id=$1
		AND workspace_id=$2 AND account_id=$3`, op.ConnectionID, op.WorkspaceID, op.AccountID).Scan(&connectionUser, &connectionDevice)
	if id != nil && !id.AdminOverride {
		canManage = id.Role == "owner" || id.UserID == connectionUser
	}
	if canManage && operationActive(op.Status) {
		if op.Status != platformSyncOperationPaused {
			available = append(available, "pause")
		}
		available = append(available, "cancel")
	}
	if id != nil && !id.AdminOverride && id.UserID == connectionUser && id.UserID == op.RequestedBy && connectionDevice == op.DeviceID &&
		(op.Status == platformSyncOperationPaused || op.Status == platformSyncOperationWaitingLogin) && s.platformSyncFeatureEnabled(r.Context(), op.Kind, op.Platform) {
		available = append(available, "resume")
	}
	var counters, coverage, scope map[string]any
	_ = json.Unmarshal(op.Counters, &counters)
	_ = json.Unmarshal(op.Coverage, &coverage)
	_ = json.Unmarshal(op.FrozenScope, &scope)
	var lastError any
	if op.LastErrorCode != nil {
		lastError = map[string]any{"code": *op.LastErrorCode}
	}
	var upperBound any
	if scope != nil {
		upperBound = scope["scope_upper_bound"]
	}
	return map[string]any{
		"id": op.ID, "kind": op.Kind, "effective_mode": op.EffectiveMode, "revision": op.Revision,
		"status": op.Status, "stage": op.Stage, "account_id": op.AccountID, "connection_id": op.ConnectionID,
		"created_at": op.CreatedAt.UTC().Format(time.RFC3339Nano), "scope_upper_bound": upperBound,
		"expires_at": op.ExpiresAt, "next_allowed_at": op.NextAllowedAt,
		"pause_reason": op.PauseReason, "coverage": coverage, "counters": counters,
		"last_error": lastError, "available_actions": available, "frozen_scope": scope,
	}
}

func operationActive(status string) bool {
	switch status {
	case "queued", "running", "paused", "waiting_budget", "waiting_device", "waiting_login":
		return true
	default:
		return false
	}
}

func (s *Server) platformSyncOperationAction(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	operationID, err := pathID(r, "operationId")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if id == nil || id.AdminOverride {
		return apiErr(http.StatusForbidden, "forbidden", "当前身份不能控制平台同步")
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	var body []byte
	var proof desktopChallenge
	hasProof := !platformProofMissing(r)
	if hasProof {
		body, proof, err = s.desktopReadAndVerifyProof(r, "platform.sync.operation.resume")
		if err != nil {
			return err
		}
	} else {
		body, err = readPlatformActionBody(r)
		if err != nil {
			return err
		}
	}
	var in struct {
		Action                    string `json:"action"`
		ExpectedOperationRevision int64  `json:"expected_operation_revision"`
	}
	if err := decodeStrictPlatformJSON(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.Action != "pause" && in.Action != "resume" && in.Action != "cancel" {
		return validation("操作只能是 pause、resume 或 cancel")
	}
	if in.ExpectedOperationRevision <= 0 {
		return validation("缺少操作版本")
	}
	if in.Action == "resume" {
		if !hasProof || proof.DeviceID == uuid.Nil {
			return apiErr(http.StatusForbidden, "desktop_required", "继续同步需要保存该平台登录的本机客户端")
		}
	} else if hasProof {
		return apiErr(http.StatusForbidden, "desktop_device_proof_invalid", "pause/cancel 不接受设备证明")
	}
	var result platformSyncOperationRecord
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var op platformSyncOperationRecord
		loaded, err := scanPlatformSyncOperation(tx.QueryRow(r.Context(), `SELECT id, workspace_id, account_id, connection_id, requested_by, device_id,
			platform, kind, requested_mode, effective_mode, status, stage, revision, authorization_revision,
			workspace_authorization_revision, platform_consent_version, frozen_scope, checkpoint, counters, coverage,
			expires_at, next_allowed_at, pause_reason, last_error_code, created_at, started_at, finished_at
			FROM platform_sync_operation WHERE id=$1 AND workspace_id=$2 AND account_id=$3`,
			operationID, id.WorkspaceID, accountID))
		if err != nil {
			return err
		}
		op = loaded
		var connectionUser, connectionDevice uuid.UUID
		var connectionState, availability, externalAccountKey string
		var connectionRevision int64
		var consentVersion int
		var consentedAt, lastSeenAt *time.Time
		var capabilitiesRaw []byte
		if err := tx.QueryRow(r.Context(), `SELECT user_id,device_id,state,availability,authorization_revision,
			platform_consent_version,consented_at,last_seen_at,external_account_key,capabilities FROM platform_connection
			WHERE id=$1 AND workspace_id=$2 AND account_id=$3 FOR UPDATE`, op.ConnectionID, id.WorkspaceID, accountID).Scan(
			&connectionUser, &connectionDevice, &connectionState, &availability, &connectionRevision,
			&consentVersion, &consentedAt, &lastSeenAt, &externalAccountKey, &capabilitiesRaw); err != nil {
			return err
		}
		locked, err := scanPlatformSyncOperation(tx.QueryRow(r.Context(), `SELECT id, workspace_id, account_id, connection_id, requested_by, device_id,
			platform, kind, requested_mode, effective_mode, status, stage, revision, authorization_revision,
			workspace_authorization_revision, platform_consent_version, frozen_scope, checkpoint, counters, coverage,
			expires_at, next_allowed_at, pause_reason, last_error_code, created_at, started_at, finished_at
			FROM platform_sync_operation WHERE id=$1 AND workspace_id=$2 AND account_id=$3 FOR UPDATE`,
			operationID, id.WorkspaceID, accountID))
		if err != nil {
			return err
		}
		op = locked
		canManage := id.Role == "owner" || id.UserID == connectionUser
		if !canManage {
			return apiErr(http.StatusForbidden, "forbidden", "只有工作区所有者或连接保管人可以暂停/取消同步")
		}
		if in.Action == "cancel" && op.Status == "canceled" {
			result = op
			return nil
		}
		if op.Revision != in.ExpectedOperationRevision {
			return apiErr(http.StatusConflict, "operation_revision_conflict", "同步进度已变化，请刷新后重试")
		}
		now := s.now()
		switch in.Action {
		case "pause":
			if !operationActive(op.Status) || op.Status == platformSyncOperationPaused {
				return apiErr(http.StatusConflict, "operation_action_invalid", "当前状态不能暂停")
			}
			_, err := tx.Exec(r.Context(), `UPDATE platform_sync_operation SET status='paused',pause_reason='user',
				revision=revision+1,updated_at=$2 WHERE id=$1`, operationID, now)
			if err != nil {
				return err
			}
		case "cancel":
			if !operationActive(op.Status) {
				return apiErr(http.StatusConflict, "operation_action_invalid", "当前状态不能取消")
			}
			if _, err := tx.Exec(r.Context(), `UPDATE platform_sync_operation SET status='canceled',stage='complete',
				pause_reason=NULL,revision=revision+1,finished_at=$2,updated_at=$2 WHERE id=$1`, operationID, now); err != nil {
				return err
			}
		case "resume":
			if op.Status != platformSyncOperationPaused && op.Status != platformSyncOperationWaitingLogin {
				return apiErr(http.StatusConflict, "operation_action_invalid", "当前状态不能继续")
			}
			if id.UserID != op.RequestedBy || connectionUser != id.UserID || connectionDevice != proof.DeviceID || op.DeviceID != proof.DeviceID {
				return apiErr(http.StatusForbidden, "platform_not_holder", "只有原连接保管人的主设备可以继续同步")
			}
			if !s.platformSyncFeatureEnabled(r.Context(), op.Kind, op.Platform) {
				return apiErr(http.StatusForbidden, "platform_sync_disabled", "该平台同步能力当前已关闭")
			}
			var frozenScope map[string]any
			if err := json.Unmarshal(op.FrozenScope, &frozenScope); err != nil {
				return err
			}
			if frozenScope["external_account_key"] != externalAccountKey {
				return apiErr(http.StatusConflict, "identity_mismatch", "连接对应的平台账号已变化，请新建同步操作")
			}
			requiredCapability := "catalog"
			if op.Kind == "metrics_refresh" {
				requiredCapability = "metrics"
			}
			if platformSyncCapabilityState(capabilitiesRaw, op.Platform, requiredCapability) != "supported" {
				return apiErr(http.StatusUnprocessableEntity, "capability_unverified", "继续同步所需的平台读取能力尚未核验")
			}
			if connectionState != "active" || availability != "ready" || consentedAt == nil || consentVersion <= 0 ||
				lastSeenAt == nil || now.Sub(*lastSeenAt) > platformPresenceTTL {
				return apiErr(http.StatusConflict, "login_required", "连接授权或本机在线状态已变化，请重新核对登录")
			}
			var policyEnabled bool
			var policyRevision int64
			if err := tx.QueryRow(r.Context(), `SELECT enabled,authorization_revision FROM platform_collection_policy WHERE workspace_id=$1`, id.WorkspaceID).Scan(&policyEnabled, &policyRevision); err != nil {
				return err
			}
			if !policyEnabled {
				return apiErr(http.StatusForbidden, "collection_disabled", "当前工作区已关闭平台数据读取")
			}
			if _, err := tx.Exec(r.Context(), `UPDATE platform_sync_operation SET status='queued',pause_reason=NULL,next_allowed_at=NULL,
				authorization_revision=$2,workspace_authorization_revision=$3,platform_consent_version=$4,
				expires_at=$5,revision=revision+1,updated_at=$6 WHERE id=$1`, operationID, connectionRevision, policyRevision,
				consentVersion, now.Add(7*24*time.Hour), now); err != nil {
				return err
			}
		}
		if in.Action == "pause" || in.Action == "cancel" {
			_, err := tx.Exec(r.Context(), `UPDATE platform_sync_run SET status='canceled',cancel_requested_at=$2,
				finished_at=$2 WHERE operation_id=$1 AND status IN ('queued','leased','running')`, operationID, now)
			if err != nil {
				return err
			}
		}
		updated, err := scanPlatformSyncOperation(tx.QueryRow(r.Context(), `SELECT id, workspace_id, account_id, connection_id, requested_by, device_id,
			platform, kind, requested_mode, effective_mode, status, stage, revision, authorization_revision,
			workspace_authorization_revision, platform_consent_version, frozen_scope, checkpoint, counters, coverage,
			expires_at, next_allowed_at, pause_reason, last_error_code, created_at, started_at, finished_at
			FROM platform_sync_operation WHERE id=$1`, operationID))
		if err != nil {
			return err
		}
		result = updated
		return s.auditTx(r.Context(), tx, "platform_sync_operation_"+in.Action, "platform_sync_operation", operationID.String(), "ok",
			map[string]any{"account_id": accountID, "revision": result.Revision})
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"operation": s.platformSyncOperationSummary(r, result)})
}

func readPlatformActionBody(r *http.Request) ([]byte, error) {
	return readBoundedPlatformJSON(r, desktopPlatformRequestBytes)
}

func (s *Server) listPlatformSyncOperationItems(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	operationID, err := pathID(r, "operationId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	if _, err := s.loadPlatformSyncOperation(r, accountID, operationID); err != nil {
		return err
	}
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 100 {
		return validation("limit 必须在 1～100 之间")
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	stage := strings.TrimSpace(r.URL.Query().Get("stage"))
	if stage == "" {
		stage = "content"
	}
	if stage != "content" && stage != "metrics" {
		return validation("stage 必须是 content 或 metrics")
	}
	validState := validMirrorState(state)
	if stage == "metrics" {
		validState = state == "not_started" || state == "complete" || state == "partial" || state == "unsupported" || state == "denied" || state == "failed"
	}
	if state != "" && !validState {
		return validation("state 筛选值无效")
	}
	rows, err := s.db.Query(r.Context(), `SELECT id,external_id,remote_content_type,remote_status,title,content_state,
		content_error_code,last_seen_at,content_observed_at,source_run_id,created_at,initial_metrics_state
		FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2 AND last_sync_operation_id=$3
		AND ($4='' OR CASE WHEN $8='metrics' THEN initial_metrics_state ELSE content_state END=$4)
		AND ($5::timestamptz IS NULL OR (created_at,id)<($5,$6))
		ORDER BY created_at DESC,id DESC LIMIT $7`, ident(r.Context()).WorkspaceID, accountID, operationID,
		state, cursorTime(cursor), cursorID(cursor), limit+1, stage)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var externalID, contentType, remoteStatus, title, contentState, metricsState string
		var errorCode *string
		var lastSeen time.Time
		var observedAt *time.Time
		var sourceRunID *uuid.UUID
		var createdAt time.Time
		if err := rows.Scan(&id, &externalID, &contentType, &remoteStatus, &title, &contentState, &errorCode, &lastSeen, &observedAt, &sourceRunID, &createdAt, &metricsState); err != nil {
			rows.Close()
			return err
		}
		items = append(items, map[string]any{"platform_work_id": id, "external_id": externalID, "remote_content_type": contentType,
			"remote_status": remoteStatus, "title": title, "content_state": contentState, "initial_metrics_state": metricsState, "error_code": errorCode,
			"last_seen_at": lastSeen, "content_observed_at": observedAt, "source_run_id": sourceRunID, "created_at": createdAt.UTC().Format(time.RFC3339Nano)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	next := mirrorItemsNextCursor(items, limit)
	if len(items) > limit {
		items = items[:limit]
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func mirrorItemsNextCursor(items []map[string]any, limit int) *string {
	if len(items) <= limit {
		return nil
	}
	last := items[limit-1]
	at, _ := time.Parse(time.RFC3339Nano, last["created_at"].(string))
	id := last["platform_work_id"].(uuid.UUID)
	value := encodeListCursor(at, id)
	return &value
}

func cursorTime(cursor *listCursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.CreatedAt
}
func cursorID(cursor *listCursor) any {
	if cursor == nil {
		return nil
	}
	return cursor.ID
}

func platformProofMissing(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Challenge")) == "" && strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Signature")) == ""
}

func validMirrorState(state string) bool {
	switch state {
	case "complete", "partial", "unsupported", "denied", "not_requested", "failed", "unknown":
		return true
	}
	return false
}

func readBoundedPlatformJSON(r *http.Request, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, requestFormatError(r.Context(), err)
	}
	if int64(len(body)) > limit {
		return nil, apiErr(http.StatusRequestEntityTooLarge, "platform_request_too_large", "平台请求超过允许大小")
	}
	return body, nil
}
