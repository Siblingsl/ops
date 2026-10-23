package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type platformFixtureInput struct {
	AccountID string `json:"accountId"`
}

type platformFixtureResponse struct {
	AccountID          string `json:"accountId"`
	DeviceID           string `json:"deviceId"`
	ConnectionID       string `json:"connectionId"`
	ConnectionRevision int64  `json:"connectionRevision"`
	ExternalAccountKey string `json:"externalAccountKey"`
	MirrorID           string `json:"mirrorId"`
}

func platformFixtureHandler(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeFixtureJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
		remoteIP := net.ParseIP(remoteHost)
		if err != nil || remoteIP == nil || !remoteIP.IsLoopback() {
			writeFixtureJSON(w, http.StatusForbidden, map[string]string{"error": "loopback only"})
			return
		}

		var input platformFixtureInput
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			writeFixtureJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid fixture request"})
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			writeFixtureJSON(w, http.StatusBadRequest, map[string]string{"error": "fixture request must be one JSON object"})
			return
		}
		accountID, err := uuid.Parse(input.AccountID)
		if err != nil {
			writeFixtureJSON(w, http.StatusBadRequest, map[string]string{"error": "accountId must be a UUID"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		tx, err := pool.Begin(ctx)
		if err != nil {
			writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "fixture transaction unavailable"})
			return
		}
		defer tx.Rollback(ctx)

		var workspaceID uuid.UUID
		var platform, accountStatus string
		if err := tx.QueryRow(ctx, `SELECT workspace_id, platform, status FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID, &platform, &accountStatus); err != nil {
			writeFixtureJSON(w, http.StatusNotFound, map[string]string{"error": "platform account not found"})
			return
		}
		if platform != "xhs" || accountStatus != "active" {
			writeFixtureJSON(w, http.StatusBadRequest, map[string]string{"error": "fixture requires an active XHS account"})
			return
		}

		var ownerID, deviceID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND role='owner' AND status='active' LIMIT 1`, workspaceID).Scan(&ownerID); err != nil {
			writeFixtureJSON(w, http.StatusConflict, map[string]string{"error": "active workspace owner not found"})
			return
		}
		for _, setting := range []struct{ key, value string }{
			{key: "platform_collection.kill_switch", value: "false"},
			{key: "platform_account_sync.xhs.enabled", value: "true"},
			{key: "platform_metrics_refresh.xhs.enabled", value: "true"},
		} {
			if _, err := tx.Exec(ctx, `INSERT INTO system_setting (key, value, updated_at) VALUES ($1, $2::jsonb, now())
				ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
				WHERE system_setting.value IS DISTINCT FROM EXCLUDED.value`, setting.key, setting.value); err != nil {
				writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not enable isolated platform test gates"})
				return
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO platform_collection_policy (workspace_id, enabled) VALUES ($1, true)
			ON CONFLICT (workspace_id) DO UPDATE SET enabled=true,
			authorization_revision=platform_collection_policy.authorization_revision+1, updated_at=now()
			WHERE platform_collection_policy.enabled IS DISTINCT FROM true`, workspaceID); err != nil {
			writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not enable workspace collection policy"})
			return
		}

		if err := tx.QueryRow(ctx, `SELECT id FROM desktop_device WHERE user_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC NULLS LAST, created_at DESC LIMIT 1`, ownerID).Scan(&deviceID); err != nil {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not enable platform test policy"})
				return
			}
			writeFixtureJSON(w, http.StatusConflict, map[string]string{"error": "real Electron device has not been registered"})
			return
		}

		externalAccountKey := "xhs_user_id:e2e_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		capabilities := `{"workList":"supported","perNoteMetrics":"supported","noteContent":"supported"}`
		var connectionID uuid.UUID
		var connectionRevision int64
		if err := tx.QueryRow(ctx, `INSERT INTO platform_connection
			(workspace_id, account_id, platform, user_id, device_id, external_account_key, state, availability,
			authorization_revision, capabilities, last_verified_at, last_seen_at, auto_collect,
			platform_consent_version, consented_at)
			VALUES ($1,$2,'xhs',$3,$4,$5,'active','ready',1,$6::jsonb,now(),now(),true,1,now())
			RETURNING id, authorization_revision`, workspaceID, accountID, ownerID, deviceID, externalAccountKey, capabilities).
			Scan(&connectionID, &connectionRevision); err != nil {
			writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not seed platform connection"})
			return
		}

		externalWorkID := strings.ReplaceAll(uuid.NewString(), "-", "")[:24]
		var mirrorID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO platform_work_mirror
			(workspace_id,account_id,platform,external_account_key,external_id,remote_content_type,remote_status,
			title,body_text,body_structure,summary,topics,tags,cover_ref,media_refs,published_at,content_state,
			field_coverage,content_observed_at)
			VALUES ($1,$2,'xhs',$3,$4,'image_note','published','本地 E2E 作品','仅用于隔离测试的正文',
			'[]'::jsonb,'隔离测试摘要','[]'::jsonb,'[]'::jsonb,'https://example.test/e2e-cover.jpg','[]'::jsonb,
			now()-interval '1 day','complete','{"title":"complete","body":"complete"}'::jsonb,now())
			RETURNING id`, workspaceID, accountID, externalAccountKey, externalWorkID).Scan(&mirrorID); err != nil {
			writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not seed platform work"})
			return
		}
		if err := tx.Commit(ctx); err != nil {
			writeFixtureJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not commit platform fixture"})
			return
		}
		writeFixtureJSON(w, http.StatusCreated, platformFixtureResponse{
			AccountID: accountID.String(), DeviceID: deviceID.String(), ConnectionID: connectionID.String(),
			ConnectionRevision: connectionRevision, ExternalAccountKey: externalAccountKey, MirrorID: mirrorID.String(),
		})
	})
}

func writeFixtureJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		fmt.Fprintln(w, `{"error":"fixture response failed"}`)
	}
}
