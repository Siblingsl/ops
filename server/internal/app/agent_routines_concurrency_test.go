package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/config"
	"ops/internal/db"
)

const routineSchedulerWorkerArg = "__agent_routine_scheduler_worker"
const routineClaimCrashWorkerArg = "__agent_routine_claim_crash_worker"

func TestAW10RoutineSchedulerTickIsUniqueAcrossProcesses(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	var account Account
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts", map[string]any{
		"platform": "xhs", "name": "多进程例行任务竞态-" + uuid.NewString(), "content_format": "image_note",
	}, &account)
	var me struct {
		UserID    string `json:"user_id"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "多进程调度竞态", "prompt": "#text 生成一段简短的例行摘要",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("创建并发验收例行任务失败：%+v", created.Routine)
	}
	routineID := created.Routine.ID
	notificationLink := "/agent?panel=task&item=" + routineID.String()
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM notification WHERE link=$1`, notificationLink)
		rows, err := env.srv.db.Query(cleanupCtx, `SELECT conversation_id FROM agent_run WHERE routine_occurrence_id IN (
			SELECT id FROM agent_routine_occurrence WHERE routine_id=$1)`, routineID)
		var conversations []uuid.UUID
		if err == nil {
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					conversations = append(conversations, id)
				}
			}
			rows.Close()
		}
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_routine WHERE id=$1`, routineID)
		if len(conversations) > 0 {
			_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_conversation WHERE id=ANY($1)`, conversations)
		}
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM platform_account WHERE id=$1`, account.ID)
	})
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=now()-interval '1 minute' WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	readyCount := 0
	startTogether := make(chan struct{})
	barrier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		readyCount++
		if readyCount == 2 {
			close(startTogether)
		}
		mu.Unlock()
		select {
		case <-startTogether:
			w.WriteHeader(http.StatusNoContent)
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
			http.Error(w, "two scheduler processes did not arrive", http.StatusGatewayTimeout)
		}
	}))
	defer barrier.Close()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	journeyStart := time.Now()
	type worker struct {
		command *exec.Cmd
		cancel  context.CancelFunc
		stdout  bytes.Buffer
		stderr  bytes.Buffer
		done    bool
	}
	workers := make([]*worker, 2)
	defer func() {
		for _, worker := range workers {
			if worker == nil {
				continue
			}
			worker.cancel()
			if !worker.done && worker.command.Process != nil {
				_ = worker.command.Process.Kill()
				_ = worker.command.Wait()
			}
		}
	}()
	for i := range workers {
		ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
		command := exec.CommandContext(ctx, executable, routineSchedulerWorkerArg, routineID.String(), barrier.URL, env.dbURL, env.mock.URL)
		workers[i] = &worker{command: command, cancel: cancel}
		command.Stdout, command.Stderr = &workers[i].stdout, &workers[i].stderr
		if err := command.Start(); err != nil {
			cancel()
			t.Fatalf("启动第 %d 个独立调度进程失败：%v", i+1, err)
		}
	}
	for i, worker := range workers {
		err := worker.command.Wait()
		worker.done = true
		if err != nil {
			t.Fatalf("调度进程 %d 失败：%v\nstdout: %s\nstderr: %s", i+1, err, worker.stdout.String(), worker.stderr.String())
		}
	}
	mu.Lock()
	ready := readyCount
	mu.Unlock()
	if ready != 2 {
		t.Fatalf("两个进程必须同时到达调度屏障：ready=%d", ready)
	}

	var occurrences, distinctDue int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),count(DISTINCT due_at) FROM agent_routine_occurrence
		WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&occurrences, &distinctDue); err != nil {
		t.Fatal(err)
	}
	if occurrences != 1 || distinctDue != 1 {
		t.Fatalf("并发调度只能创建一条同 due occurrence：occurrences=%d distinct_due=%d", occurrences, distinctDue)
	}
	var runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id IN (
		SELECT id FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled')`, routineID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("同一计划时刻只能启动一个 run，got %d", runs)
	}
	var routineStatus, occurrenceStatus, runStatus string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT r.status,o.status,run.status FROM agent_routine r
		JOIN agent_routine_occurrence o ON o.routine_id=r.id AND o.kind='scheduled'
		JOIN agent_run run ON run.routine_occurrence_id=o.id WHERE r.id=$1`, routineID).
		Scan(&routineStatus, &occurrenceStatus, &runStatus); err != nil {
		t.Fatal(err)
	}
	if routineStatus != "enabled" || occurrenceStatus != "completed" || runStatus != "completed" {
		t.Fatalf("唯一调度应保留任务并完成唯一运行：routine=%s occurrence=%s run=%s", routineStatus, occurrenceStatus, runStatus)
	}
	t.Logf("DEV-QA26_METRIC_ROUTINE_MULTI_PROCESS %s", fmt.Sprintf(`{"workers":%d,"ready":%d,"occurrences":%d,"runs":%d,"journey_ms":%.2f,"routine":"%s","occurrence":"%s","run":"%s"}`, len(workers), ready, occurrences, runs, float64(time.Since(journeyStart).Microseconds())/1000, routineStatus, occurrenceStatus, runStatus))
}

func runAgentRoutineSchedulerWorker(routineID, barrierURL, databaseURL, mockURL string) error {
	id, err := uuid.Parse(routineID)
	if err != nil {
		return fmt.Errorf("invalid routine id: %w", err)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	dataDir, err := os.MkdirTemp("", "ops-routine-worker-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dataDir)
	cfg := &config.Config{Dev: true, DatabaseURL: databaseURL, DataDir: dataDir, MasterKey: bytes.Repeat([]byte{7}, 32),
		WechatBase: mockURL, MockListen: strings.TrimPrefix(mockURL, "http://"),
		SystemAdminUser: "skyeder", SystemAdminPassword: testAdminPassword, AIWorkers: 3}
	srv, err := New(cfg, pool)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Post(barrierURL, "text/plain", nil)
	if err != nil {
		return fmt.Errorf("waiting at shared scheduler barrier: %w", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("scheduler barrier returned %s", response.Status)
	}
	srv.runAgentRoutines(ctx)
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		var occurrenceStatus string
		err := pool.QueryRow(ctx, `SELECT status FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, id).Scan(&occurrenceStatus)
		if err == nil && (occurrenceStatus == "completed" || occurrenceStatus == "failed" || occurrenceStatus == "stopped" || occurrenceStatus == "interrupted") {
			return nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("scheduled occurrence did not reach a terminal state")
}

func TestAW10RoutineRunsOnRunJobsMinuteTicker(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	routineID := createRoutineSchedulerAuditFixture(t, "真实分钟 ticker")
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=now()+interval '1 day' WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}
	marker := "qa26-runjobs-start:" + uuid.NewString()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO job_marker(key,created_at) VALUES($1,now()-interval '61 days')`, marker); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	startedAt := time.Now()
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("RunJobs did not stop after context cancellation")
		}
	})

	markerDeadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(markerDeadline) {
		var exists bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM job_marker WHERE key=$1)`, marker).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	var markerExists bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM job_marker WHERE key=$1)`, marker).Scan(&markerExists); err != nil {
		t.Fatal(err)
	}
	if markerExists {
		t.Fatal("RunJobs startup pass did not reach its completion marker")
	}

	armedAt := time.Now()
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=now() WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}
	var earlyOccurrences int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&earlyOccurrences); err != nil {
		t.Fatal(err)
	}
	if earlyOccurrences != 0 {
		t.Fatalf("startup pass must not dispatch a task armed afterward: occurrences=%d", earlyOccurrences)
	}

	deadline := time.Now().Add(80 * time.Second)
	var occurrenceStatus, runStatus string
	for time.Now().Before(deadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT o.status,COALESCE(run.status,'') FROM agent_routine_occurrence o
			LEFT JOIN agent_run run ON run.routine_occurrence_id=o.id WHERE o.routine_id=$1 AND o.kind='scheduled'`, routineID).
			Scan(&occurrenceStatus, &runStatus)
		if err == nil && occurrenceStatus == "completed" && runStatus == "completed" {
			break
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if occurrenceStatus != "completed" || runStatus != "completed" {
		t.Fatalf("actual RunJobs minute ticker did not complete the due task: occurrence=%s run=%s", occurrenceStatus, runStatus)
	}
	if elapsed := time.Since(armedAt); elapsed < 50*time.Second {
		t.Fatalf("routine ran too soon to prove the minute ticker: elapsed=%s", elapsed.Round(time.Millisecond))
	}
	var occurrences, distinctDues int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),count(DISTINCT due_at) FROM agent_routine_occurrence
		WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&occurrences, &distinctDues); err != nil {
		t.Fatal(err)
	}
	var runCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id IN
		(SELECT id FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled')`, routineID).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if occurrences != 1 || distinctDues != 1 || runCount != 1 {
		t.Fatalf("minute tick must create exactly one occurrence and run: occurrences=%d distinct_due=%d runs=%d", occurrences, distinctDues, runCount)
	}
	t.Logf("DEV-QA26_METRIC_ROUTINE_MINUTE_TICK %s", fmt.Sprintf(`{"elapsed_ms":%.2f,"startup_ms":%.2f,"occurrences":%d,"runs":%d,"status":"%s"}`,
		float64(time.Since(armedAt).Microseconds())/1000, float64(armedAt.Sub(startedAt).Microseconds())/1000, occurrences, runCount, runStatus))
}

func TestAW10RoutineRunJobsStartupRecoversDueAfterOfflineWindow(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	routineID := createRoutineSchedulerAuditFixture(t, "服务离线后启动轮恢复")
	var expectedDue time.Time
	if err := env.srv.db.QueryRow(t.Context(), `UPDATE agent_routine SET next_due_at=now()-interval '29 minutes' WHERE id=$1 RETURNING next_due_at`, routineID).Scan(&expectedDue); err != nil {
		t.Fatal(err)
	}
	var beforeOccurrences int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&beforeOccurrences); err != nil {
		t.Fatal(err)
	}
	if beforeOccurrences != 0 {
		t.Fatalf("服务离线期间不应已有调度 occurrence：%d", beforeOccurrences)
	}
	startupMarker := "qa26-runjobs-offline-start:" + uuid.NewString()
	if env.srv.now().In(env.srv.loc).Hour() >= 3 {
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cleanupCancel()
			_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM job_marker WHERE key=$1`, startupMarker)
		})
		if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO job_marker(key,created_at) VALUES($1,now()-interval '61 days')`, startupMarker); err != nil {
			t.Fatal(err)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	startedAt := time.Now()
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()
	stopJobs := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("RunJobs 未在取消后退出")
		}
	}
	t.Cleanup(stopJobs)

	deadline := time.Now().Add(25 * time.Second)
	var occurrenceID uuid.UUID
	var occurrenceStatus, runStatus string
	for time.Now().Before(deadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT o.id,o.status,COALESCE(run.status,'')
			FROM agent_routine_occurrence o LEFT JOIN agent_run run ON run.routine_occurrence_id=o.id
			WHERE o.routine_id=$1 AND o.kind='scheduled'`, routineID).
			Scan(&occurrenceID, &occurrenceStatus, &runStatus)
		if err == nil && (occurrenceStatus == "completed" || occurrenceStatus == "failed" || occurrenceStatus == "interrupted" || occurrenceStatus == "missed") {
			break
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if occurrenceStatus != "completed" || runStatus != "completed" {
		t.Fatalf("重启后的启动轮应在 30 分钟窗口内恢复并完成任务：occurrence=%s run=%s", occurrenceStatus, runStatus)
	}
	if env.srv.now().In(env.srv.loc).Hour() >= 3 {
		markerDeadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(markerDeadline) {
			var exists bool
			if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM job_marker WHERE key=$1)`, startupMarker).Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if !exists {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		var markerExists bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM job_marker WHERE key=$1)`, startupMarker).Scan(&markerExists); err != nil {
			t.Fatal(err)
		}
		if markerExists {
			t.Fatal("RunJobs 启动轮未到达完成标记")
		}
	}
	stopJobs()

	var actualDue time.Time
	if err := env.srv.db.QueryRow(t.Context(), `SELECT due_at FROM agent_routine_occurrence WHERE id=$1`, occurrenceID).Scan(&actualDue); err != nil {
		t.Fatal(err)
	}
	if !actualDue.Equal(expectedDue) {
		t.Fatalf("恢复必须保留原 due：want=%s got=%s", expectedDue, actualDue)
	}
	env.srv.runAgentRoutines(t.Context())
	var occurrences, distinctDues, runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),count(DISTINCT due_at) FROM agent_routine_occurrence
		WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&occurrences, &distinctDues); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id=$1`, occurrenceID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if occurrences != 1 || distinctDues != 1 || runs != 1 {
		t.Fatalf("重启及重复 scheduler 扫描只能创建一个 occurrence/run：occurrences=%d dues=%d runs=%d", occurrences, distinctDues, runs)
	}
	t.Logf("DEV-QA26_METRIC_ROUTINE_OFFLINE_STARTUP %s", fmt.Sprintf(`{"offline_late_minutes":29,"occurrences":%d,"distinct_dues":%d,"runs":%d,"recovery_ms":%.2f,"status":"%s"}`,
		occurrences, distinctDues, runs, float64(time.Since(startedAt).Microseconds())/1000, runStatus))
}

func TestAW10RoutineClaimRollsBackAfterProcessKill(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	routineID := createRoutineSchedulerAuditFixture(t, "领取事务进程崩溃")
	triggerCleanup := func() {
		_, _ = env.srv.db.Exec(context.Background(), `DROP TRIGGER IF EXISTS qa26_pause_routine_claim ON agent_routine_occurrence`)
		_, _ = env.srv.db.Exec(context.Background(), `DROP FUNCTION IF EXISTS qa26_pause_routine_claim()`)
	}
	triggerCleanup()
	functionSQL := fmt.Sprintf(`CREATE FUNCTION qa26_pause_routine_claim() RETURNS trigger LANGUAGE plpgsql AS $body$
		BEGIN
			IF NEW.routine_id = '%s'::uuid AND NEW.kind = 'scheduled' THEN PERFORM pg_sleep(2); END IF;
			RETURN NEW;
		END
	$body$`, routineID.String())
	if _, err := env.srv.db.Exec(t.Context(), functionSQL); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `CREATE TRIGGER qa26_pause_routine_claim BEFORE INSERT ON agent_routine_occurrence
		FOR EACH ROW EXECUTE FUNCTION qa26_pause_routine_claim()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(triggerCleanup)
	var expectedDue time.Time
	if err := env.srv.db.QueryRow(t.Context(), `UPDATE agent_routine SET next_due_at=now()-interval '1 minute' WHERE id=$1 RETURNING next_due_at`, routineID).Scan(&expectedDue); err != nil {
		t.Fatal(err)
	}

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	appName := "qa26-routine-crash-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	workerURL, err := url.Parse(env.dbURL)
	if err != nil {
		t.Fatal(err)
	}
	query := workerURL.Query()
	query.Set("application_name", appName)
	workerURL.RawQuery = query.Encode()
	t.Setenv("OPS_QA26_ROUTINE_CRASH_DATA_DIR", t.TempDir())
	command := exec.Command(executable, routineClaimCrashWorkerArg, routineID.String(), workerURL.String(), env.mock.URL)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	startedAt := time.Now()
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waitDone := make(chan error, 1)
	go func() { waitDone <- command.Wait() }()
	finished := false
	t.Cleanup(func() {
		if !finished && command.Process != nil {
			_ = command.Process.Kill()
			<-waitDone
		}
	})

	deadline := time.Now().Add(20 * time.Second)
	claimHeld := false
	for time.Now().Before(deadline) {
		var active bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE application_name=$1 AND state='active' AND query ILIKE 'INSERT INTO agent_routine_occurrence%')`, appName).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active {
			claimHeld = true
			break
		}
		select {
		case workerErr := <-waitDone:
			finished = true
			t.Fatalf("worker exited before entering the guarded claim transaction: %v\nstdout: %s\nstderr: %s", workerErr, stdout.String(), stderr.String())
		default:
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !claimHeld {
		_ = command.Process.Kill()
		waitErr := <-waitDone
		finished = true
		t.Fatalf("worker never entered the blocked claim INSERT (wait=%v)\nstdout: %s\nstderr: %s", waitErr, stdout.String(), stderr.String())
	}
	var committed int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&committed); err != nil {
		t.Fatal(err)
	}
	if committed != 0 {
		t.Fatalf("occurrence must remain uncommitted while claim transaction is blocked, got %d", committed)
	}
	killAt := time.Now()
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	workerExitErr := <-waitDone
	if workerExitErr == nil {
		t.Fatal("killed scheduler worker unexpectedly exited successfully")
	}
	finished = true
	t.Logf("DEV-QA26 process kill elapsed_ms=%.2f wait=%v", float64(time.Since(killAt).Microseconds())/1000, workerExitErr)

	activityDeadline := time.Now().Add(8 * time.Second)
	processGone := false
	for time.Now().Before(activityDeadline) {
		var active bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1)`, appName).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if !active {
			processGone = true
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !processGone {
		var sessions string
		if err := env.srv.db.QueryRow(t.Context(), `SELECT COALESCE(string_agg(format('pid=%s state=%s wait=%s/%s query=%s',pid,state,COALESCE(wait_event_type,''),COALESCE(wait_event,''),left(query,180)), E'\n'),'<none>')
			FROM pg_stat_activity WHERE application_name=$1`, appName).Scan(&sessions); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("killed worker still has an active PostgreSQL session after %.2fms: %s", float64(time.Since(killAt).Microseconds())/1000, sessions)
	}
	triggerCleanup()

	var rolledBack int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&rolledBack); err != nil {
		t.Fatal(err)
	}
	if rolledBack != 0 {
		t.Fatalf("process death must roll back the uncommitted claim, got %d occurrences", rolledBack)
	}
	env.srv.runAgentRoutines(t.Context())
	var occurrenceStatus, runStatus string
	completionDeadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(completionDeadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT o.status,COALESCE(run.status,'') FROM agent_routine_occurrence o
			LEFT JOIN agent_run run ON run.routine_occurrence_id=o.id WHERE o.routine_id=$1 AND o.kind='scheduled'`, routineID).
			Scan(&occurrenceStatus, &runStatus)
		if err == nil && occurrenceStatus == "completed" && runStatus == "completed" {
			break
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if occurrenceStatus != "completed" || runStatus != "completed" {
		t.Fatalf("next scheduler tick must retry the same due after rollback: occurrence=%s run=%s", occurrenceStatus, runStatus)
	}
	var occurrences, distinctDue, runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),count(DISTINCT due_at),count(DISTINCT run_id)
		FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&occurrences, &distinctDue, &runs); err != nil {
		t.Fatal(err)
	}
	if occurrences != 1 || distinctDue != 1 || runs != 1 {
		t.Fatalf("post-crash recovery must produce one occurrence/run for one due: occurrences=%d due=%d runs=%d", occurrences, distinctDue, runs)
	}
	var recoveredDue time.Time
	if err := env.srv.db.QueryRow(t.Context(), `SELECT due_at FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&recoveredDue); err != nil {
		t.Fatal(err)
	}
	if !recoveredDue.Equal(expectedDue) {
		t.Fatalf("post-crash recovery must preserve the original due: want=%s got=%s", expectedDue, recoveredDue)
	}
	t.Logf("DEV-QA26_METRIC_ROUTINE_PROCESS_CRASH %s", fmt.Sprintf(`{"claim_held":%t,"rolled_back":%d,"occurrences":%d,"distinct_due":%d,"runs":%d,"journey_ms":%.2f}`,
		claimHeld, rolledBack, occurrences, distinctDue, runs, float64(time.Since(startedAt).Microseconds())/1000))
}

func createRoutineSchedulerAuditFixture(t *testing.T, name string) uuid.UUID {
	t.Helper()
	providerID := env.ensureToolModel(t)
	var account Account
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts", map[string]any{
		"platform": "xhs", "name": name + "-" + uuid.NewString(), "content_format": "image_note",
	}, &account)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": name, "prompt": "#text 生成一段简短、只读的例行摘要",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("创建例行调度验收任务失败：%+v", created.Routine)
	}
	routineID := created.Routine.ID
	notificationLink := "/agent?panel=task&item=" + routineID.String()
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM notification WHERE link=$1`, notificationLink)
		rows, err := env.srv.db.Query(cleanupCtx, `SELECT conversation_id FROM agent_run WHERE routine_occurrence_id IN
			(SELECT id FROM agent_routine_occurrence WHERE routine_id=$1)`, routineID)
		var conversations []uuid.UUID
		if err == nil {
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					conversations = append(conversations, id)
				}
			}
			rows.Close()
		}
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_routine WHERE id=$1`, routineID)
		if len(conversations) > 0 {
			_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_conversation WHERE id=ANY($1)`, conversations)
		}
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM platform_account WHERE id=$1`, account.ID)
	})
	return routineID
}

func runAgentRoutineClaimCrashWorker(routineID, databaseURL, mockURL string) error {
	id, err := uuid.Parse(routineID)
	if err != nil {
		return fmt.Errorf("invalid routine id: %w", err)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	dataDir := os.Getenv("OPS_QA26_ROUTINE_CRASH_DATA_DIR")
	if dataDir == "" {
		return errors.New("missing parent-owned crash worker data directory")
	}
	cfg := &config.Config{Dev: true, DatabaseURL: databaseURL, DataDir: dataDir, MasterKey: bytes.Repeat([]byte{7}, 32),
		WechatBase: mockURL, MockListen: strings.TrimPrefix(mockURL, "http://"),
		SystemAdminUser: "skyeder", SystemAdminPassword: testAdminPassword, AIWorkers: 3}
	srv, err := New(cfg, pool)
	if err != nil {
		return err
	}
	if routineID != id.String() {
		return errors.New("routine id was not canonical")
	}
	srv.runAgentRoutines(ctx)
	return nil
}
