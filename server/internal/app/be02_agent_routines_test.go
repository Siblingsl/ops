package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；agent_routines.go 批次）：
// advance/pause 的 DB 与 nextDue 计算失败必须上抛，不得把 next_due_at 静默写成 NULL。

func be02CreateDailyRoutine(t *testing.T) agentRoutineView {
	t.Helper()
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).xhs
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	scheduleTime := env.srv.now().In(loc).Add(2 * time.Hour).Format("15:04")
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "BE-02 例行推进 " + uuid.NewString()[:8],
		"prompt": "#text 只读验收", "public_context_refs": []any{}, "account_id": account.ID.String(),
		"cadence": "daily", "time_of_day": scheduleTime, "timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.NextDueAt == nil {
		t.Fatalf("创建例行任务失败：%+v", created.Routine)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
	})
	return created.Routine
}

func TestBE02AdvanceAgentRoutineTxBadTimeOfDaySurfacesError(t *testing.T) {
	routine := be02CreateDailyRoutine(t)
	before := *routine.NextDueAt
	tx, err := env.srv.db.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())

	broken := routine
	broken.TimeOfDay = "not-a-time"
	if err := env.srv.advanceAgentRoutineTx(t.Context(), tx, broken); err == nil {
		t.Fatal("非法 time_of_day 必须上抛，不得静默把 next_due_at 写成 NULL")
	}
	_ = tx.Rollback(t.Context())

	var after time.Time
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_due_at FROM agent_routine WHERE id=$1`, routine.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) {
		t.Fatalf("失败推进后 next_due_at 不得变化：before=%s after=%s", before, after)
	}
}

func TestBE02AdvanceAgentRoutineTxUpdatesNextDue(t *testing.T) {
	routine := be02CreateDailyRoutine(t)
	before := *routine.NextDueAt
	tx, err := env.srv.db.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if err := env.srv.advanceAgentRoutineTx(t.Context(), tx, routine); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_due_at FROM agent_routine WHERE id=$1`, routine.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.After(before) {
		t.Fatalf("成功推进后 next_due_at 应晚于原值：before=%s after=%s", before, after)
	}
}

func TestBE02PauseAgentRoutineTxWriteFailureSurfacesError(t *testing.T) {
	routine := be02CreateDailyRoutine(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	// 已取消的 ctx 让 Exec 失败；pause 必须返回 error（不再 _, _ = 吞掉）。
	if err := env.srv.pauseAgentRoutineTx(ctx, tx, routine.ID, routine.Revision, apiErr(403, "forbidden", "测试")); err == nil {
		t.Fatal("取消上下文下 pause 写库失败必须上抛")
	}
}
