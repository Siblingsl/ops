package main

// REF41 I1 E2E 夹具：只存在于 ops-e2e 本地测试服务，用于给真实数据库补两条成功
// 观测和一条失败观测，让浏览器/桌面 E2E 能渲染真实趋势与覆盖提示。生产 API
//（cmd/ops）不注册该路由；观测仍由真实 GET /benchmark/targets/{id}/trend 读取。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type benchmarkSeedPoint struct {
	Seq          int            `json:"seq"`
	ObservedAt   *time.Time     `json:"observed_at"`
	IntervalDays *float64       `json:"interval_days"`
	PublishedAt  *time.Time     `json:"published_at"`
	QualityState string         `json:"quality_state"`
	Values       map[string]any `json:"values"`
}

type benchmarkSeedRequest struct {
	TargetID uuid.UUID           `json:"target_id"`
	NoteID   *uuid.UUID          `json:"note_id"`
	Points   []benchmarkSeedPoint `json:"points"`
}

func benchmarkSeedHandler(pool *pgxpool.Pool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var in benchmarkSeedRequest
		body := http.MaxBytesReader(w, r.Body, 1<<20)
		if err := json.NewDecoder(body).Decode(&in); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		if in.TargetID == uuid.Nil || len(in.Points) == 0 {
			http.Error(w, "target_id and points are required", http.StatusBadRequest)
			return
		}
		ctx := r.Context()
		var wsID uuid.UUID
		var platform, targetURL string
		if err := pool.QueryRow(ctx, `SELECT workspace_id, platform, url FROM benchmark_target WHERE id=$1`, in.TargetID).
			Scan(&wsID, &platform, &targetURL); err != nil {
			http.Error(w, "target not found", http.StatusNotFound)
			return
		}
		noteID := uuid.Nil
		if in.NoteID != nil {
			if err := pool.QueryRow(ctx, `SELECT id FROM benchmark_note WHERE id=$1 AND target_id=$2 AND workspace_id=$3`,
				*in.NoteID, in.TargetID, wsID).Scan(&noteID); err != nil {
				http.Error(w, "note not found", http.StatusNotFound)
				return
			}
		} else {
			externalID := "e2e-" + in.TargetID.String()
			err := pool.QueryRow(ctx, `SELECT id FROM benchmark_note WHERE target_id=$1 AND external_id=$2`,
				in.TargetID, externalID).Scan(&noteID)
			if errors.Is(err, pgx.ErrNoRows) {
				structJSON := []byte("{}")
				if err := pool.QueryRow(ctx, `INSERT INTO benchmark_note
					(workspace_id,target_id,url,title,structure,structure_hash,platform,external_id,first_seen_at,last_seen_at,captured_at)
					VALUES ($1,$2,$3,'I1 E2E 夹具作品',$4,$5,$6,$7,now(),now(),now()) RETURNING id`,
					wsID, in.TargetID, targetURL, structJSON, sha256Hex(structJSON), platform, externalID).Scan(&noteID); err != nil {
					http.Error(w, "create note failed: "+err.Error(), http.StatusInternalServerError)
					return
				}
			} else if err != nil {
				http.Error(w, "find note failed: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		for _, point := range in.Points {
			observedAt := time.Now()
			if point.ObservedAt != nil {
				observedAt = *point.ObservedAt
			}
			quality := point.QualityState
			if quality == "" {
				quality = "ok"
			}
			if quality != "ok" && quality != "partial" && quality != "failed" {
				http.Error(w, "quality_state invalid", http.StatusBadRequest)
				return
			}
			values := point.Values
			if values == nil || quality == "failed" {
				values = map[string]any{}
			}
			valuesJSON, _ := json.Marshal(values)
			if _, err := pool.Exec(ctx, `INSERT INTO benchmark_metric_observation
				(workspace_id,target_id,note_id,observed_at,seq,interval_days,values,quality_state,source,payload_hash)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import',$9)
				ON CONFLICT (target_id,note_id,seq) DO NOTHING`,
				wsID, in.TargetID, noteID, observedAt, point.Seq, point.IntervalDays, valuesJSON, quality, sha256Hex(valuesJSON)); err != nil {
				http.Error(w, "insert observation failed", http.StatusInternalServerError)
				return
			}
			if point.PublishedAt != nil {
				_, _ = pool.Exec(ctx, `UPDATE benchmark_note SET published_at=COALESCE($2,published_at) WHERE id=$1`, noteID, *point.PublishedAt)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"note_id": noteID})
	})
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
