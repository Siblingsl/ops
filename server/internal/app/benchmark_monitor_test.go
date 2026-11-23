package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// i1Target 经 drAccount 建账号后直插竞对目标（workspace 从账号行取，避免选错残留库）。
func i1Target(t *testing.T, name string) uuid.UUID {
	t.Helper()
	a := drAccount(t, "xhs", "I1-"+name)
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO benchmark_target (workspace_id, account_id, platform, name, url, normalized_url)
		 SELECT workspace_id, id, 'xhs', $2, 'https://creator.xiaohongshu.com/profile/i1', 'https://creator.xiaohongshu.com/profile/i1'
		 FROM platform_account WHERE id=$1 RETURNING id`, a.ID, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestI1MonitorToggleIntervalBounds(t *testing.T) {
	// I1-A2：间隔边界——5h 拒绝、169h 拒绝、6h/168h 接受；关闭时清 next_observe_at。
	id := i1Target(t, "I1 边界目标")
	env.mustJSONStatus(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 5}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 169}, nil, http.StatusUnprocessableEntity)
	var next *time.Time
	var enabled bool
	env.mustJSON(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 6}, nil)
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT monitor_enabled, next_observe_at FROM benchmark_target WHERE id=$1`, id).
		Scan(&enabled, &next); err != nil {
		t.Fatal(err)
	}
	if !enabled || next == nil {
		t.Fatalf("enable should set next_observe_at")
	}
	env.mustJSON(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 168}, nil)
	env.mustJSON(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": false}, nil)
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT monitor_enabled, next_observe_at FROM benchmark_target WHERE id=$1`, id).
		Scan(&enabled, &next); err != nil {
		t.Fatal(err)
	}
	if enabled || next != nil {
		t.Fatalf("disable should clear next_observe_at")
	}
	// 跨工作区 404。
	g := env.registerClient(t, "i1_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 24}, nil, http.StatusNotFound)
	_ = g
}

func TestI1MonitorJobDedupesTenMinutes(t *testing.T) {
	// I1-A2：同一目标 10 分钟窗口只一条任务；next_observe_at 推进一个间隔。
	id := i1Target(t, "I1 调度目标")
	env.mustJSON(t, "PATCH", "/api/v1/benchmark/targets/"+id.String()+"/monitor",
		map[string]any{"enabled": true, "interval_hours": 24}, nil)

	env.srv.benchmarkMonitorJob(context.Background())
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM benchmark_observe_task WHERE target_id=$1`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("first job should create 1 task, got %d", count)
	}
	var next *time.Time
	var hours int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT next_observe_at, monitor_interval_hours FROM benchmark_target WHERE id=$1`, id).
		Scan(&next, &hours); err != nil {
		t.Fatal(err)
	}
	if hours != 24 {
		t.Fatalf("interval_hours in db = %d, want 24", hours)
	}
	if next == nil || time.Until(*next) < 20*time.Hour {
		t.Fatalf("next_observe_at should advance ~24h, got %v (hours=%d)", next, hours)
	}
	// 立即重跑：next_observe_at 未到期 → 不新建。
	env.srv.benchmarkMonitorJob(context.Background())
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM benchmark_observe_task WHERE target_id=$1`, id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("dedupe failed: %d tasks", count)
	}
}

func TestI1ObservationSeqAndTrendAgeDays(t *testing.T) {
	// I1-A3：同一 note 多次观测 seq 递增、interval_days 计算；无 published_at 时
	// age_days=null（不补 0）。
	id := i1Target(t, "I1 趋势目标")
	// 直接落两条观测（首条 null interval、第二条 1 天）。
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM benchmark_target WHERE id=$1`, id).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	var noteID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO benchmark_note (workspace_id, target_id, title, structure, structure_hash, platform, external_id, first_seen_at, last_seen_at, captured_at)
		 VALUES ($1,$2,'I1 趋势作品','{}'::jsonb,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','xhs','i1-note-1', now()-interval '2 days', now(), now())
		 RETURNING id`, ws, id).Scan(&noteID); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO benchmark_metric_observation (workspace_id, target_id, note_id, observed_at, seq, interval_days, values, quality_state, source, payload_hash)
		 VALUES ($1,$2,$3,$4,1,NULL,'{"likes":10}'::jsonb,'ok','desktop','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`, ws, id, noteID,
		now.Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO benchmark_metric_observation (workspace_id, target_id, note_id, observed_at, seq, interval_days, values, quality_state, source, payload_hash)
		 VALUES ($1,$2,$3,$4,2,1.0,'{"likes":25}'::jsonb,'ok','desktop','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`, ws, id, noteID, now); err != nil {
		t.Fatal(err)
	}

	var trend struct {
		Points []struct {
			Seq          int      `json:"seq"`
			IntervalDays *float64 `json:"interval_days"`
			PublishedAt  *string  `json:"published_at"`
			AgeDays      *float64 `json:"age_days"`
			Values       map[string]any `json:"values"`
			QualityState string   `json:"quality_state"`
		} `json:"points"`
	}
	env.mustJSON(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/trend?note_id="+noteID.String(), nil, &trend)
	if len(trend.Points) != 2 {
		t.Fatalf("points = %d, want 2", len(trend.Points))
	}
	if trend.Points[0].Seq != 1 || trend.Points[1].Seq != 2 {
		t.Fatalf("seq order broken: %d/%d", trend.Points[0].Seq, trend.Points[1].Seq)
	}
	if trend.Points[0].IntervalDays != nil {
		t.Fatalf("first observation interval_days must be null")
	}
	if trend.Points[1].IntervalDays == nil || *trend.Points[1].IntervalDays != 1.0 {
		t.Fatalf("second interval_days = %v, want 1.0", trend.Points[1].IntervalDays)
	}
	// 无 published_at：age_days 必须为 null，values 不补 0。
	if trend.Points[0].PublishedAt != nil || trend.Points[0].AgeDays != nil {
		t.Fatalf("no published_at must yield null age_days")
	}
	if trend.Points[0].Values["likes"].(float64) != 10 {
		t.Fatalf("values must keep real observation, got %v", trend.Points[0].Values)
	}
}

func TestI1FailedObservationNotZero(t *testing.T) {
	// I1-A4：failed 观测 values 为空对象，不把失败点当 0；quality_state=failed。
	id := i1Target(t, "I1 失败目标")
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM benchmark_target WHERE id=$1`, id).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	var noteID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO benchmark_note (workspace_id, target_id, title, structure, structure_hash, external_id, first_seen_at, last_seen_at, captured_at)
		 VALUES ($1,$2,'失败观测作品','{}'::jsonb,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','i1-fail-1', now(), now(), now()) RETURNING id`, ws, id).Scan(&noteID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO benchmark_metric_observation (workspace_id, target_id, note_id, seq, values, quality_state, source, payload_hash)
		 VALUES ($1,$2,$3,1,'{}'::jsonb,'failed','desktop','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`, ws, id, noteID); err != nil {
		t.Fatal(err)
	}
	var trend struct {
		Points []struct {
			Seq          int            `json:"seq"`
			Values       map[string]any `json:"values"`
			QualityState string         `json:"quality_state"`
		} `json:"points"`
	}
	env.mustJSON(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/trend", nil, &trend)
	if len(trend.Points) != 1 {
		t.Fatalf("points = %d", len(trend.Points))
	}
	if trend.Points[0].QualityState != "failed" {
		t.Fatalf("quality_state = %s", trend.Points[0].QualityState)
	}
	if _, has := trend.Points[0].Values["likes"]; has {
		t.Fatalf("failed observation must not carry values (would read as 0)")
	}
}

func TestI1CoverageCounts(t *testing.T) {
	// I1-A3/A1-A4：coverage {expected, observed, failed, missing}。
	id := i1Target(t, "I1 覆盖目标")
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM benchmark_target WHERE id=$1`, id).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	var noteID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO benchmark_note (workspace_id, target_id, title, structure, structure_hash, external_id, first_seen_at, last_seen_at, captured_at)
		 VALUES ($1,$2,'覆盖作品','{}'::jsonb,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','i1-cov-1', now(), now(), now()) RETURNING id`, ws, id).Scan(&noteID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO benchmark_metric_observation (workspace_id, target_id, note_id, seq, values, quality_state, source, payload_hash)
		 VALUES ($1,$2,$3,1,'{}'::jsonb,'ok','desktop','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), ($1,$2,$3,2,'{}'::jsonb,'failed','desktop','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`, ws, id, noteID); err != nil {
		t.Fatal(err)
	}
	var coverage struct {
		Expected int `json:"expected"`
		Observed int `json:"observed"`
		Failed   int `json:"failed"`
		Missing  int `json:"missing"`
	}
	env.mustJSON(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/coverage", nil, &coverage)
	if coverage.Observed != 2 || coverage.Failed != 1 {
		t.Fatalf("coverage = %+v", coverage)
	}
	if coverage.Missing < 0 {
		t.Fatalf("missing must not be negative")
	}
}

func TestI1ObservationRequiresWorkspaceAndNoteOwnership(t *testing.T) {
	// I1-A5：只读公开页、跨工作区 404；竞对数据不跨工作区可见。
	id := i1Target(t, "I1 越权目标")
	g := env.registerClient(t, "i1_obs_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/observations", nil, nil, http.StatusNotFound)
	env.mustJSONStatus(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/trend", nil, nil, http.StatusNotFound)
	env.mustJSONStatus(t, "GET", "/api/v1/benchmark/targets/"+id.String()+"/coverage", nil, nil, http.StatusNotFound)
	_ = g
}
