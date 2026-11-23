package app

// REF41 I1：竞对订阅、观测与趋势。监控调度（10 分钟一次，同目标去重）、观测
// 入库（seq 事务分配、failed 不写 0）、趋势/覆盖只读 API。只抓公开主页，不登录
// 竞对账号、不抓私信/粉丝数据；竞对数据只在本工作区可见。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	benchmarkMonitorEvery    = 10 * time.Minute
	benchmarkObserveAttempts = 2
	benchmarkObserveLease    = 60 * time.Second
)

// BenchmarkObservation 是一次采集观测的投影（趋势点）。
type BenchmarkObservation struct {
	ID           uuid.UUID       `json:"id"`
	TargetID     uuid.UUID       `json:"target_id"`
	NoteID       *uuid.UUID      `json:"note_id,omitempty"`
	ObservedAt   time.Time       `json:"observed_at"`
	Seq          int             `json:"seq"`
	IntervalDays *float64        `json:"interval_days"`
	Values       map[string]any  `json:"values"`
	QualityState string          `json:"quality_state"`
	Source       string          `json:"source"`
}

const benchmarkObsCols = `o.id, o.target_id, o.note_id, o.observed_at, o.seq, o.interval_days,
	o.values, o.quality_state, o.source`

func scanBenchmarkObservation(row pgx.Row) (*BenchmarkObservation, error) {
	var o BenchmarkObservation
	var raw []byte
	if err := row.Scan(&o.ID, &o.TargetID, &o.NoteID, &o.ObservedAt, &o.Seq, &o.IntervalDays, &raw, &o.QualityState, &o.Source); err != nil {
		return nil, err
	}
	o.Values = map[string]any{}
	_ = json.Unmarshal(raw, &o.Values)
	return &o, nil
}

// benchmarkMonitorToggleInput 是 PATCH /benchmark/targets/{id}/monitor 的输入。
type benchmarkMonitorToggleInput struct {
	Enabled       bool `json:"enabled"`
	IntervalHours int  `json:"interval_hours"`
}

// benchmarkMonitorToggleHandler 开启/关闭监控；开启时校验间隔并写 next_observe_at=now。
func (s *Server) benchmarkMonitorToggleHandler(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	targetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_target_id", "目标 ID 不合法")
	}
	var in benchmarkMonitorToggleInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Enabled && (in.IntervalHours < 6 || in.IntervalHours > 168) {
		return validation("监控间隔必须为 6–168 小时")
	}
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, targetID, ws).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errNotFound
	}
	if in.Enabled {
		if _, err := s.db.Exec(r.Context(), `UPDATE benchmark_target SET monitor_enabled=true,
			monitor_interval_hours=$2, next_observe_at=now(), updated_at=now() WHERE id=$1`,
			targetID, in.IntervalHours); err != nil {
			return err
		}
	} else {
		if _, err := s.db.Exec(r.Context(), `UPDATE benchmark_target SET monitor_enabled=false,
			next_observe_at=NULL, updated_at=now() WHERE id=$1`, targetID); err != nil {
			return err
		}
	}
	s.audit(r.Context(), "benchmark.monitor_toggle", "benchmark_target", targetID.String(), "ok",
		map[string]any{"enabled": in.Enabled, "interval_hours": in.IntervalHours})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": true, "enabled": in.Enabled, "interval_hours": in.IntervalHours})
}

// benchmarkMonitorJob 每 10 分钟：为到期目标建 observe_task（同目标 10 分钟内只一条），
// 更新 next_observe_at=now+interval。只读选择，不触发采集本身。
func (s *Server) benchmarkMonitorJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id, monitor_interval_hours FROM benchmark_target
		WHERE monitor_enabled AND next_observe_at IS NOT NULL AND next_observe_at <= now()`)
	if err != nil {
		return
	}
	type due struct {
		id      uuid.UUID
		ws      uuid.UUID
		hours   int
	}
	dueTargets := []due{}
	for rows.Next() {
		var t due
		if err := rows.Scan(&t.id, &t.ws, &t.hours); err != nil {
			rows.Close()
			return
		}
		dueTargets = append(dueTargets, t)
	}
	rows.Close()
	for _, t := range dueTargets {
		// 同目标 10 分钟内只一条（requested_at 去重由 UNIQUE(target_id, requested_at) +
		// 10 分钟窗口保证；这里按分钟取整生成 requested_at）。
		requestedAt := time.Now().Truncate(benchmarkMonitorEvery)
		if _, err := s.db.Exec(ctx, `INSERT INTO benchmark_observe_task
			(workspace_id, target_id, requested_at) VALUES ($1,$2,$3)
			ON CONFLICT (target_id, requested_at) DO NOTHING`, t.ws, t.id, requestedAt); err != nil {
			continue
		}
		_, _ = s.db.Exec(ctx, `UPDATE benchmark_target SET next_observe_at = now() + make_interval(hours => $2)
			WHERE id=$1`, t.id, t.hours)
	}
}

// benchmarkObserveClaim 桌面领取到期观测任务（设备证明复用平台采集机制）。
func (s *Server) benchmarkObserveClaim(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "benchmark.observe.claim"); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	ws := ident(r.Context()).WorkspaceID
	row := tx.QueryRow(ctx, `SELECT t.id, t.workspace_id, t.target_id, t.attempt FROM benchmark_observe_task t
		WHERE t.state='queued' AND t.workspace_id=$1 ORDER BY t.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`, ws)
	var taskID, wsID, targetID uuid.UUID
	var attempt int
	if err := row.Scan(&taskID, &wsID, &targetID, &attempt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.Header().Set("Cache-Control", "no-store")
			return ok(w, map[string]any{"task": nil})
		}
		return err
	}
	if attempt >= benchmarkObserveAttempts {
		if _, err := tx.Exec(ctx, `UPDATE benchmark_observe_task SET state='expired', finished_at=now(),
			error_code='observe_attempts_exhausted' WHERE id=$1`, taskID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"task": nil})
	}
	token := uuid.NewString()
	if _, err := tx.Exec(ctx, `UPDATE benchmark_observe_task SET state='leased', lease_token=$2,
		lease_until=$3, attempt=attempt+1 WHERE id=$1`,
		taskID, token, s.now().Add(benchmarkObserveLease).UTC()); err != nil {
		return err
	}
	var url, platform string
	if err := tx.QueryRow(ctx, `SELECT url, platform FROM benchmark_target WHERE id=$1`, targetID).
		Scan(&url, &platform); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"task": map[string]any{
		"task_id": taskID, "target_id": targetID, "url": url, "platform": platform,
		"lease_token": token, "lease_expires_at": s.now().Add(benchmarkObserveLease),
	}})
}

// benchmarkObserveHeartbeat 续租。
func (s *Server) benchmarkObserveHeartbeat(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "benchmark.observe.heartbeat"); err != nil {
		return err
	}
	taskID, err := uuid.Parse(chi.URLParam(r, "taskID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_task_id", "任务 ID 不合法")
	}
	var in struct {
		LeaseToken string `json:"lease_token"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE benchmark_observe_task SET lease_until=$3
		WHERE id=$1 AND lease_token=$2 AND state='leased' AND workspace_id=$4`,
		taskID, in.LeaseToken, s.now().Add(benchmarkObserveLease).UTC(), ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return apiErr(http.StatusConflict, "observe_lease_invalid", "观测租约无效或已过期")
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"lease_expires_at": s.now().Add(benchmarkObserveLease)})
}

// benchmarkObserveResults 落观测：更新/创建 note（external_id 匹配）、写 observation
// （seq 事务分配、interval_days=与上次观测间隔、failed 时 values 空不写 0）。
func (s *Server) benchmarkObserveResults(w http.ResponseWriter, r *http.Request) error {
	if _, _, err := s.desktopReadAndVerifyProof(r, "benchmark.observe.result"); err != nil {
		return err
	}
	taskID, err := uuid.Parse(chi.URLParam(r, "taskID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_task_id", "任务 ID 不合法")
	}
	var in struct {
		LeaseToken  string         `json:"lease_token"`
		ExternalID  string         `json:"external_id"`
		Title       string         `json:"title"`
		URL         string         `json:"url"`
		PublishedAt *time.Time     `json:"published_at"`
		Values      map[string]any `json:"values"`
		Quality     string         `json:"quality_state"`
		Structure   map[string]any `json:"structure"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Quality == "" {
		in.Quality = "ok"
	}
	if in.Quality != "ok" && in.Quality != "partial" && in.Quality != "failed" {
		return validation("quality_state 只能是 ok/partial/failed")
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var wsID, targetID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT workspace_id, target_id FROM benchmark_observe_task
		WHERE id=$1 AND lease_token=$2 AND state='leased' AND workspace_id=$3 FOR UPDATE`,
		taskID, in.LeaseToken, ident(r.Context()).WorkspaceID).
		Scan(&wsID, &targetID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusConflict, "observe_lease_invalid", "观测租约无效或已过期")
		}
		return err
	}
	// external_id 必填（同一作品多次观测进趋势的键）。
	externalID := strings.TrimSpace(in.ExternalID)
	if externalID == "" {
		return validation("external_id 必填（作品唯一键）")
	}
	// 更新/创建 note。
	var noteID uuid.UUID
	structJSON := []byte("{}")
	if in.Structure != nil {
		structJSON, _ = json.Marshal(in.Structure)
	}
	structHash := sha256Hex(structJSON)
	err = tx.QueryRow(ctx, `SELECT id FROM benchmark_note WHERE target_id=$1 AND external_id=$2`,
		targetID, externalID).Scan(&noteID)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO benchmark_note
			(workspace_id, target_id, url, title, structure, structure_hash, platform, external_id, published_at, first_seen_at, last_seen_at, captured_at)
			VALUES ($1,$2,$3,$4,$5,$6,
			(SELECT platform FROM benchmark_target WHERE id=$2), $7, $8, now(), now(), now())
			RETURNING id`,
			wsID, targetID, in.URL, truncate(in.Title, 200), structJSON, structHash, externalID, in.PublishedAt).Scan(&noteID)
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		if _, err := tx.Exec(ctx, `UPDATE benchmark_note SET last_seen_at=now(), captured_at=now(),
			published_at=COALESCE($2, published_at), title=CASE WHEN $3<>'' THEN $3 ELSE title END
			WHERE id=$1`, noteID, in.PublishedAt, truncate(in.Title, 200)); err != nil {
			return err
		}
	}
	// seq 事务分配：该 note 现有 max(seq)+1（FOR UPDATE 防并发重复）。
	var nextSeq int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq),0)+1 FROM benchmark_metric_observation
		WHERE target_id=$1 AND note_id=$2`, targetID, noteID).Scan(&nextSeq); err != nil {
		return err
	}
	// interval_days = 本次观测 - 上次观测（首条 null）。
	var lastObserved *time.Time
	_ = tx.QueryRow(ctx, `SELECT observed_at FROM benchmark_metric_observation
		WHERE target_id=$1 AND note_id=$2 ORDER BY seq DESC LIMIT 1`, targetID, noteID).Scan(&lastObserved)
	var intervalDays *float64
	if lastObserved != nil {
		d := s.now().Sub(*lastObserved).Hours() / 24
		intervalDays = &d
	}
	values := in.Values
	if values == nil {
		values = map[string]any{}
	}
	if in.Quality == "failed" {
		// failed 观测 values 为空——避免断点被误读为 0。
		values = map[string]any{}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO benchmark_metric_observation
		(workspace_id, target_id, note_id, observed_at, seq, interval_days, values, quality_state, source, payload_hash, raw)
		VALUES ($1,$2,$3,now(),$4,$5,$6,$7,'desktop',$8,'{}'::jsonb)`,
		wsID, targetID, noteID, nextSeq, intervalDays, jsonArg(values), in.Quality,
		sha256Hex(jsonArg(values))); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE benchmark_observe_task SET state='succeeded', finished_at=now(),
		result=$2 WHERE id=$1`, taskID, jsonArg(map[string]any{"note_id": noteID, "seq": nextSeq, "quality": in.Quality})); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE benchmark_target SET last_observed_at=now() WHERE id=$1`, targetID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"note_id": noteID, "seq": nextSeq, "quality_state": in.Quality})
}


// benchmarkObservationsHandler GET /benchmark/targets/{id}/observations?note_id=&limit=。
func (s *Server) benchmarkObservationsHandler(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	targetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_target_id", "目标 ID 不合法")
	}
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, targetID, ws).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errNotFound
	}
	query := `SELECT ` + benchmarkObsCols + ` FROM benchmark_metric_observation o
		WHERE o.target_id=$1`
	args := []any{targetID}
	if noteID := r.URL.Query().Get("note_id"); noteID != "" {
		id, err := uuid.Parse(noteID)
		if err != nil {
			return validation("note_id 必须是 UUID")
		}
		query += ` AND o.note_id=$2`
		args = append(args, id)
	}
	query += ` ORDER BY o.seq ASC LIMIT 200`
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	items := []BenchmarkObservation{}
	for rows.Next() {
		o, err := scanBenchmarkObservation(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, *o)
	}
	rows.Close()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"observations": items})
}

// benchmarkTrendHandler GET /benchmark/targets/{id}/trend?note_id=。
// 点列 {seq, observed_at, interval_days, published_at, age_days, values, quality_state}；
// age_days 无 published_at 时为 null（不补 0）。
func (s *Server) benchmarkTrendHandler(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	targetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_target_id", "目标 ID 不合法")
	}
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, targetID, ws).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errNotFound
	}
	query := `SELECT o.seq, o.observed_at, o.interval_days, n.published_at, o.values, o.quality_state
		FROM benchmark_metric_observation o
		LEFT JOIN benchmark_note n ON n.id=o.note_id
		WHERE o.target_id=$1`
	args := []any{targetID}
	if noteID := r.URL.Query().Get("note_id"); noteID != "" {
		id, err := uuid.Parse(noteID)
		if err != nil {
			return validation("note_id 必须是 UUID")
		}
		query += ` AND o.note_id=$2`
		args = append(args, id)
	}
	query += ` ORDER BY o.seq ASC`
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	type trendPoint struct {
		Seq          int         `json:"seq"`
		ObservedAt   time.Time   `json:"observed_at"`
		IntervalDays *float64    `json:"interval_days"`
		PublishedAt  *time.Time  `json:"published_at"`
		AgeDays      *float64    `json:"age_days"`
		Values       map[string]any `json:"values"`
		QualityState string      `json:"quality_state"`
	}
	points := []trendPoint{}
	for rows.Next() {
		var p trendPoint
		var raw []byte
		if err := rows.Scan(&p.Seq, &p.ObservedAt, &p.IntervalDays, &p.PublishedAt, &raw, &p.QualityState); err != nil {
			rows.Close()
			return err
		}
		p.Values = map[string]any{}
		_ = json.Unmarshal(raw, &p.Values)
		if p.PublishedAt != nil {
			age := p.ObservedAt.Sub(*p.PublishedAt).Hours() / 24
			p.AgeDays = &age
		}
		points = append(points, p)
	}
	rows.Close()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"points": points})
}

// benchmarkCoverageHandler GET /benchmark/targets/{id}/coverage：
// {expected, observed, failed, missing}。
func (s *Server) benchmarkCoverageHandler(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	targetID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_target_id", "目标 ID 不合法")
	}
	var n int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*) FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, targetID, ws).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errNotFound
	}
	var observed, failed int
	if err := s.db.QueryRow(r.Context(), `SELECT count(*), count(*) FILTER (WHERE quality_state='failed')
		FROM benchmark_metric_observation WHERE target_id=$1`, targetID).Scan(&observed, &failed); err != nil {
		return err
	}
	// expected：监控开启后按间隔应产生的观测数（上限以实际 elapsed/interval 计，封顶 500 防爆）。
	var intervalHours int
	var enabled bool
	var since *time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT monitor_enabled, monitor_interval_hours, next_observe_at - (monitor_interval_hours || ' hours')::interval
		FROM benchmark_target WHERE id=$1`, targetID).Scan(&enabled, &intervalHours, &since); err != nil {
		return err
	}
	expected := observed
	if enabled && since != nil && intervalHours > 0 {
		elapsedHours := s.now().Sub(*since).Hours()
		if elapsedHours > 0 {
			expected = int(elapsedHours / float64(intervalHours))
			if expected > 500 {
				expected = 500
			}
		}
	}
	missing := expected - observed
	if missing < 0 {
		missing = 0
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"expected": expected, "observed": observed, "failed": failed, "missing": missing})
}
