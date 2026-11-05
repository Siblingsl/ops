package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
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
