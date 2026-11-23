package app

// REF41 F3：定时任务补跑的 Go 验收。
// F3-A2 补跑窗口与上限；F3-A3 高频不补；F3-A4 业务幂等 skipped；F3-A5 唯一键抢占。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// F3-A5：同 (ws, key, scheduled_at) 并发只执行一次（唯一键抢占）。
func TestF3JobRunSlotPreemption(t *testing.T) {
	scheduled := time.Now()
	execCount := 0
	err := env.srv.runJobOnce(context.Background(), nil, "daily-brief", scheduled, false, func(c context.Context) error {
		execCount++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// 第二次同 slot：抢占直接返回，不执行。
	_ = env.srv.runJobOnce(context.Background(), nil, "daily-brief", scheduled, false, func(c context.Context) error {
		execCount++
		return nil
	})
	if execCount != 1 {
		t.Fatalf("exec count = %d, want 1（唯一键抢占）", execCount)
	}
	// 不同 scheduled_at 可各自执行。
	if err := env.srv.runJobOnce(context.Background(), nil, "daily-brief", scheduled.Add(time.Minute), false, func(c context.Context) error {
		execCount++
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if execCount != 2 {
		t.Fatalf("exec count after new slot = %d, want 2", execCount)
	}
	// 状态与耗时写入。
	var status string
	var durationMS *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, duration_ms FROM job_run WHERE job_key='daily-brief' AND scheduled_at=$1`, scheduled).
		Scan(&status, &durationMS); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("status = %q", status)
	}
	if durationMS == nil || *durationMS < 0 {
		t.Fatalf("duration_ms = %v", durationMS)
	}
}

// F3-A2：补跑窗口判定——错过 2 周期补跑；7 天外不补。
func TestF3CatchUpWindowBoundaries(t *testing.T) {
	// 构造：daily-brief 上次成功在 3 天前（> 2 周期 48h，< 7 天）→ 补跑触发。
	stale := time.Now().Add(-3 * 24 * time.Hour)
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO job_run
		(job_key, scheduled_at, started_at, finished_at, status, catch_up, duration_ms)
		VALUES ('daily-brief', $1, $1, $1, 'succeeded', false, 10)`, stale); err != nil {
		t.Fatal(err)
	}
	// 白名单逻辑模拟：behind = 72h；2*period=48h < 72h < 7d → 应补。
	period := jobCatchUpAllowlist["daily-brief"]
	behind := time.Since(stale)
	if behind <= 2*period || behind >= jobCatchUpMaxAge {
		t.Fatalf("3-day stale must be in catch-up window: behind=%v", behind)
	}
	// 7 天外：不补。
	ancient := time.Now().Add(-8 * 24 * time.Hour)
	if behind := time.Since(ancient); behind < jobCatchUpMaxAge {
		t.Fatal("8-day stale must be out of window")
	}
	// 1.5 周期：不补（未错过 2 周期）。
	fresh := time.Now().Add(-36 * time.Hour)
	if behind := time.Since(fresh); behind > 2*period {
		t.Fatal("36h stale must be inside 2-period tolerance")
	}
}

// F3-A3：高频任务不在白名单（1 分钟/10 分钟 ticker 类）。
func TestF3HighFrequencyNotCatchable(t *testing.T) {
	for _, key := range []string{"collect-hot", "collect-references", "daily-background", "run-once"} {
		if _, ok := jobCatchUpAllowlist[key]; ok {
			t.Fatalf("high-frequency job %q must not be in allowlist", key)
		}
	}
	// runJobNow API：非白名单 key 422。
	status, body := env.do("POST", "/api/v1/job-runs/run-now", map[string]any{"job_key": "collect-hot"})
	if status != 422 {
		t.Fatalf("high-frequency run-now status = %d, want 422; body=%s", status, body)
	}
	// 白名单 key 手动补跑成功。
	status, body = env.do("POST", "/api/v1/job-runs/run-now", map[string]any{"job_key": "memory-decay"})
	if status != 200 {
		t.Fatalf("allowlist run-now status = %d, want 200; body=%s", status, body)
	}
	var runs int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM job_run WHERE job_key='memory-decay' AND catch_up=true`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("memory-decay catch_up runs = %d, want 1", runs)
	}
}

// F3-A4：业务幂等命中 → skipped，不算失败。
func TestF3JobMarkerSkipSemantics(t *testing.T) {
	day := "2000-01-01"
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO job_marker (key) VALUES ($1)`, "catchup-marker:daily-brief:"+day); err != nil {
		t.Fatal(err)
	}
	_ = env.srv.runJobOnce(context.Background(), nil, "daily-brief", time.Now().Add(time.Hour), true, func(c context.Context) error {
		var done bool
		if err := env.srv.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`,
			"catchup-marker:daily-brief:"+day).Scan(&done); err == nil && done {
			return &jobSkipError{reason: "job_marker 已完成"}
		}
		return nil
	})
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM job_run WHERE job_key='daily-brief' AND scheduled_at=(SELECT max(scheduled_at) FROM job_run WHERE job_key='daily-brief')`).
		Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "skipped" {
		t.Fatalf("status = %q, want skipped", status)
	}
	// 失败语义：fn 返回普通错误 → failed + error_message。
	wantErr := errors.New("业务失败样例")
	_ = env.srv.runJobOnce(context.Background(), nil, "metric-reminder", time.Now().Add(time.Hour), false, func(c context.Context) error {
		return wantErr
	})
	var errorCode, errorMessage string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT error_code, error_message FROM job_run WHERE job_key='metric-reminder' AND status='failed' LIMIT 1`).
		Scan(&errorCode, &errorMessage); err != nil {
		t.Fatal(err)
	}
	if errorCode != "job_failed" || errorMessage != wantErr.Error() {
		t.Fatalf("error_code=%q message=%q", errorCode, errorMessage)
	}
}

// F3-A1 补充：workspace 维度槽位隔离（不同 workspace 同 key 同时刻不冲突）。
func TestF3WorkspaceSlotIsolation(t *testing.T) {
	a := drAccount(t, "xhs", "F3 槽位隔离")
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	scheduled := time.Now().Add(2 * time.Hour)
	wsCopy := ws
	if err := env.srv.runJobOnce(context.Background(), &wsCopy, "publish-patrol", scheduled, false, func(c context.Context) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// 系统级同 slot 独立（workspace NULL vs 具体值经 COALESCE 归一后不同）。
	if err := env.srv.runJobOnce(context.Background(), nil, "publish-patrol", scheduled, false, func(c context.Context) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM job_run WHERE job_key='publish-patrol' AND scheduled_at=$1`, scheduled).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("slot rows = %d, want 2（workspace 隔离）", n)
	}
}

// F3 §4 回归：补跑失败/跳过一次后不得每 10 分钟自动重试。
// 用独立 allowlist key + 当日 job_marker 让第一次补跑落 skipped，第二次不得再插行。
func TestF3CatchUpDoesNotRetryAfterFirstAttempt(t *testing.T) {
	key := "test-f3-catchup-once"
	jobCatchUpAllowlist[key] = 24 * time.Hour
	defer delete(jobCatchUpAllowlist, key)
	ctx := context.Background()
	day := env.srv.today().Format("2006-01-02")
	marker := "catchup-marker:" + key + ":" + day
	cleanup := func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM job_run WHERE job_key=$1`, key)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM job_marker WHERE key=$1`, marker)
	}
	cleanup()
	defer cleanup()
	stale := time.Now().Add(-3 * 24 * time.Hour)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO job_run
		(job_key, scheduled_at, started_at, finished_at, status, catch_up, duration_ms)
		VALUES ($1,$2,$2,$2,'succeeded',false,10)`, key, stale); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO job_marker (key) VALUES ($1)`, marker); err != nil {
		t.Fatal(err)
	}
	env.srv.jobCatchUpJob(ctx)
	var count int
	var status string
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*), max(status) FROM job_run
		WHERE job_key=$1 AND catch_up=true`, key).Scan(&count, &status); err != nil {
		t.Fatal(err)
	}
	if count != 1 || status != "skipped" {
		t.Fatalf("first catch-up count=%d status=%q, want 1/skipped", count, status)
	}
	env.srv.jobCatchUpJob(ctx)
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM job_run
		WHERE job_key=$1 AND catch_up=true`, key).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("second catch-up count=%d, want 1（失败/跳过不自动重试）", count)
	}
}

// TestF3JobRunsScopedToWorkspace 对应 F3-N5：系统任务页只显示当前 workspace 的 job_run，
// 不泄露其他 workspace 或 workspace_id=NULL 的系统级行。
func TestF3JobRunsScopedToWorkspace(t *testing.T) {
	me := env.me(t)
	workspaceID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	ctx := context.Background()

	var otherWorkspace uuid.UUID
	createdOther := false
	err := env.srv.db.QueryRow(ctx, `SELECT id FROM workspace WHERE id<>$1 LIMIT 1`, workspaceID).Scan(&otherWorkspace)
	if errors.Is(err, pgx.ErrNoRows) {
		otherWorkspace = uuid.New()
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES ($1,'F3 其他工作区',$2)`,
			otherWorkspace, userID); err != nil {
			t.Fatal(err)
		}
		createdOther = true
	} else if err != nil {
		t.Fatal(err)
	}
	if createdOther {
		t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, otherWorkspace) })
	}

	scheduled := time.Now().Truncate(time.Microsecond)
	keys := []string{"test-f3-visible", "test-f3-other", "test-f3-system"}
	for i, key := range keys {
		var ws *uuid.UUID
		switch i {
		case 0:
			ws = &workspaceID
		case 1:
			ws = &otherWorkspace
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO job_run (workspace_id,job_key,scheduled_at,status)
			VALUES ($1,$2,$3,'succeeded')`, ws, key, scheduled); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM job_run WHERE job_key = ANY($1)`,
			[]string{"test-f3-visible", "test-f3-other", "test-f3-system"})
	})

	status, body := env.do("GET", "/api/v1/job-runs", nil)
	if status != http.StatusOK {
		t.Fatalf("GET job-runs status=%d body=%s", status, body)
	}
	var out struct {
		Items []struct {
			WorkspaceID *string `json:"workspace_id"`
			JobKey      string  `json:"job_key"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	var visible, leaked int
	for _, item := range out.Items {
		if item.JobKey != "test-f3-visible" && item.JobKey != "test-f3-other" && item.JobKey != "test-f3-system" {
			continue
		}
		if item.JobKey != "test-f3-visible" {
			leaked++
		}
		if item.WorkspaceID == nil || *item.WorkspaceID != workspaceID.String() {
			t.Fatalf("visible job workspace=%v, want %s", item.WorkspaceID, workspaceID)
		}
		visible++
	}
	if visible != 1 || leaked != 0 {
		t.Fatalf("visible=%d leaked=%d items=%+v", visible, leaked, out.Items)
	}
}
