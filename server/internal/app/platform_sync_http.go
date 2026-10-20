package app

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 平台采集的 HTTP 端点（20 文档 §11.2）。所有端点都先过设备证明（PS02 的 operation 白名单），
// 再在处理器内重新核对租约与权限；不信任客户端上报的工作区/用户归属。

// desktopCreatePlatformConnection 处理 POST /desktop/platform/connections：当前设备为某个
// OPS 账号建立一个待验证连接，一次只建一个。
func (s *Server) desktopCreatePlatformConnection(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "platform.connection.create")
	if err != nil {
		return err
	}
	var in struct {
		AccountID              uuid.UUID `json:"account_id"`
		ExternalAccountKey     string    `json:"external_account_key"`
		PlatformConsentVersion int       `json:"platform_consent_version"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.PlatformConsentVersion <= 0 {
		return validation("缺少数据读取同意版本")
	}
	id := ident(r.Context())
	var conn platformConnection
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var e error
		conn, e = s.createPlatformConnection(r.Context(), tx, id.WorkspaceID, in.AccountID,
			id.UserID, challenge.DeviceID, in.ExternalAccountKey, in.PlatformConsentVersion)
		if e != nil {
			return e
		}
		return s.auditTx(r.Context(), tx, "platform_connection_create", "platform_connection", conn.ID.String(), "ok",
			map[string]any{"account_id": in.AccountID, "platform": conn.Platform})
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, platformConnectionSummary(conn))
}

// desktopVerifyPlatformConnection 处理 POST /desktop/platform/connections/{id}/verify：
// 绑定真实平台身份与能力快照。身份冲突返回 409，不覆盖原身份。
func (s *Server) desktopVerifyPlatformConnection(w http.ResponseWriter, r *http.Request) error {
	connectionID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "platform.connection.verify")
	if err != nil {
		return err
	}
	var in struct {
		ExternalAccountKey string         `json:"external_account_key"`
		Capabilities       map[string]any `json:"capabilities"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	id := ident(r.Context())
	var conn platformConnection
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var e error
		conn, e = s.verifyPlatformConnection(r.Context(), tx, connectionID, id.WorkspaceID, id.UserID,
			in.ExternalAccountKey, in.Capabilities)
		if e != nil {
			return e
		}
		return s.auditTx(r.Context(), tx, "platform_connection_verify", "platform_connection", connectionID.String(), "ok",
			map[string]any{"platform": conn.Platform})
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, platformConnectionSummary(conn))
}

// desktopPlatformPresence 处理 POST /desktop/platform/presence：客户端每 30 秒一次，
// 即使没有任务也要发，否则空闲连接永远等不到新任务。
func (s *Server) desktopPlatformPresence(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "platform.presence"); err != nil {
		return err
	}
	// 设备 ID 来自已验签的挑战，不接受请求体自报。
	id := ident(r.Context())
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	if err := s.platformPresence(r.Context(), deviceID); err != nil {
		return err
	}
	_ = id
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": true, "ttl_seconds": int(platformPresenceTTL / time.Second)})
}

// desktopDeviceOfProof 读取本请求已完成验签的挑战所绑定的设备。
// 设备 ID 只来自验签后的挑战，不接受请求头或请求体自报。
func (s *Server) desktopDeviceOfProof(r *http.Request) (uuid.UUID, error) {
	deviceID, ok := desktopVerifiedDevice(r.Context())
	if !ok {
		return uuid.Nil, apiErr(403, "desktop_device_proof_invalid", "设备证明未绑定设备")
	}
	return deviceID, nil
}

// desktopClaimPlatformRun 处理 POST /desktop/platform/runs/claim。
func (s *Server) desktopClaimPlatformRun(w http.ResponseWriter, r *http.Request) error {
	body, _, err := s.desktopReadAndVerifyProof(r, "platform.run.claim")
	if err != nil {
		return err
	}
	_ = body
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	run, err := s.claimPlatformRun(r.Context(), deviceID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	if run == nil {
		return ok(w, map[string]any{"run": nil})
	}
	// 只下发固定动作与冻结目标，不下发任何脚本、URL、选择器或凭据。
	return ok(w, map[string]any{"run": map[string]any{
		"id": run.ID, "connection_id": run.ConnectionID, "account_id": run.AccountID,
		"platform": run.Platform, "trigger": run.Trigger, "task_kind": run.TaskKind,
		"lease_generation": run.LeaseGeneration, "lease_expires_at": run.LeaseExpiresAt,
		"deadline_at": run.DeadlineAt, "authorization_revision": run.AuthorizationRevision,
		"adapter_version": run.AdapterVersion, "mapping_version": run.MappingVersion,
		"query_scope": run.QueryScope, "binding_snapshot": run.BindingSnapshot,
		"budget": map[string]any{
			"max_rows": platformRunMaxRows, "max_bytes": platformRunMaxBytes,
			"max_duration_seconds": int(platformRunMaxDuration / time.Second),
		},
	}})
}

// desktopHeartbeatPlatformRun 处理 POST /desktop/platform/runs/{id}/heartbeat。
func (s *Server) desktopHeartbeatPlatformRun(w http.ResponseWriter, r *http.Request) error {
	runID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, _, err := s.desktopReadAndVerifyProof(r, "platform.run.heartbeat"); err != nil {
		return err
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	canceled, leaseUntil, err := s.heartbeatPlatformRun(r.Context(), runID, deviceID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"canceled": canceled, "lease_expires_at": leaseUntil})
}

// desktopSubmitPlatformResults 处理 POST /desktop/platform/runs/{id}/results。
// 请求体上限由 operation 白名单固定为 512 KiB，在验签前就按 413 拒绝。
func (s *Server) desktopSubmitPlatformResults(w http.ResponseWriter, r *http.Request) error {
	runID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "platform.run.result")
	if err != nil {
		return err
	}
	var batch platformResultBatch
	if err := json.Unmarshal(body, &batch); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if batch.ProtocolVersion != desktopPlatformProtocolVersion {
		return apiErr(426, "platform_protocol_unsupported", "客户端与服务的平台采集协议不兼容，请升级客户端")
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	receipt, err := s.submitPlatformResults(r.Context(), runID, deviceID, body, batch)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, receipt)
}

// desktopGetPlatformRunReceipt 处理 GET /desktop/platform/runs/{id}/receipts/{seq}。
func (s *Server) desktopGetPlatformRunReceipt(w http.ResponseWriter, r *http.Request) error {
	runID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	seq, err := pathInt(r, "seq")
	if err != nil {
		return err
	}
	if _, _, err := s.desktopReadAndVerifyProof(r, "platform.run.receipt"); err != nil {
		return err
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	receipt, err := s.getPlatformRunReceipt(r.Context(), runID, deviceID, seq)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, receipt)
}
