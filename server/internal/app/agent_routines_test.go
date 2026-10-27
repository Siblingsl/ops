package app

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestAW10RoutineFeatureRequiresCompletedRunDependencies(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "routines")
	if agentWorkbenchFeatures()["routines"] {
		t.Fatal("routines must stay unavailable without the persistent run dependencies")
	}
	t.Setenv(agentWorkbenchFeatureEnv, "routines,event_resume,run_control,plans,goals,artifacts")
	if !agentWorkbenchFeatures()["routines"] {
		t.Fatal("routines should be available once all prerequisites are enabled")
	}
}

func TestAW10RoutineToolAllowlistCannotReachBusinessWrites(t *testing.T) {
	allowed := []string{
		"works__list", "works__get", "works__read_sections", "review__dashboard", "review__top_works",
		"review__digests", "metrics__list", "metrics__unmatched", "followers__list", "reviews__list",
		"checks__latest", "checks__report",
	}
	for _, name := range allowed {
		if !agentRoutineToolAllowed(agentTool(name), nil) {
			t.Errorf("documented routine read tool %q was rejected", name)
		}
	}
	for _, name := range []string{"reviews__create", "works__create", "checks__fix_suggest", "present_plan"} {
		if agentRoutineToolAllowed(agentTool(name), nil) {
			t.Errorf("routine must not call %q", name)
		}
	}
}

func TestAW10RoutineSkillsMustUsePublicEffectiveView(t *testing.T) {
	if !agentRoutineArgsAllowed("skills__list", map[string]any{"view": "effective"}) {
		t.Fatal("public effective skills should be available")
	}
	for _, args := range []map[string]any{
		{"view": "library"},
		{"view": "effective", "scope": "personal"},
		{"view": "effective", "scope": "unknown"},
	} {
		if agentRoutineArgsAllowed("skills__list", args) {
			t.Errorf("private or non-effective skill request was allowed: %#v", args)
		}
	}
}

func TestAW10RoutinePrincipalRechecksServerModelBeforeEveryTool(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var me struct {
		UserID string `json:"user_id"`
		Workspace struct { ID string `json:"id"` } `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct { Routine agentRoutineView `json:"routine"` }
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "模型权限边界", "prompt": "仅生成只读报告",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	conv := env.agentRunConversation(t, providerID)
	var occurrenceID, runID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,lease_token,lease_until,started_at)
		VALUES($1,now(),$2,'manual','running',$3,now()+interval '5 minutes',now()) RETURNING id`,
		created.Routine.ID, uuid.New(), uuid.New()).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_run
		(conversation_id,workspace_id,user_id,trigger,status,stage,model_provider_id,model,mode,execution_origin,config_snapshot,routine_occurrence_id)
		VALUES($1,$2,$3,'routine','running','tool',$4,'mock-writer','execute','routine','{}',$5) RETURNING id`,
		conv.ID, workspaceID, userID, providerID, occurrenceID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine_occurrence SET run_id=$2 WHERE id=$1`, occurrenceID, runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=$1`, conv.ID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
		_, _ = env.srv.db.Exec(t.Context(), `UPDATE model_capability SET tools_ok=true WHERE provider_id=$1 AND model='mock-writer'`, providerID)
	})
	principal := &agentPrincipal{UserID: userID, WorkspaceID: workspaceID, ConversationID: conv.ID, RunID: runID,
		RoutineID: created.Routine.ID, RoutineOccurrenceID: occurrenceID}
	if _, err := env.srv.loadAgentRoutinePrincipal(t.Context(), principal); err != nil {
		t.Fatalf("valid running routine principal must pass: %v", err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE model_capability SET tools_ok=false WHERE provider_id=$1 AND model='mock-writer'`, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.loadAgentRoutinePrincipal(t.Context(), principal); err == nil {
		t.Fatal("revoked server-model tool capability must block the next internal tool request")
	}
}

func TestAW10ExpiredRoutineRunIsMarkedUnknownAndNeverReplayed(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var me struct {
		UserID string `json:"user_id"`
		Workspace struct { ID string `json:"id"` } `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct { Routine agentRoutineView `json:"routine"` }
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "未知结果不重跑", "prompt": "只读检查",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	conv := env.agentRunConversation(t, providerID)
	var occurrenceID, runID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,lease_token,lease_until,started_at)
		VALUES($1,now()-interval '1 minute',$2,'scheduled','running',$3,now()-interval '1 minute',now()-interval '2 minutes') RETURNING id`,
		created.Routine.ID, uuid.New(), uuid.New()).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_run
		(conversation_id,workspace_id,user_id,trigger,status,stage,model_provider_id,model,mode,execution_origin,config_snapshot,routine_occurrence_id)
		VALUES($1,$2,$3,'routine','running','tool',$4,'mock-writer','execute','routine','{}',$5) RETURNING id`,
		conv.ID, workspaceID, userID, providerID, occurrenceID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine_occurrence SET run_id=$2 WHERE id=$1`, occurrenceID, runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=$1`, conv.ID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
	})
	env.srv.recoverAgentRoutineLeases(t.Context())
	env.srv.runAgentRoutines(t.Context())
	var runStatus, runError, occurrenceStatus, occurrenceError string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT run.status,run.error_code,o.status,o.error_code
		FROM agent_routine_occurrence o JOIN agent_run run ON run.id=o.run_id WHERE o.id=$1`, occurrenceID).
		Scan(&runStatus, &runError, &occurrenceStatus, &occurrenceError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runError != "interrupted" || occurrenceStatus != "interrupted" || occurrenceError != "interrupted" {
		t.Fatalf("expired in-flight result must remain unknown: run=%s/%s occurrence=%s/%s", runStatus, runError, occurrenceStatus, occurrenceError)
	}
	var unknown, runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='interrupted'
		AND payload->>'result_unknown'='true'`, created.Routine.ID).Scan(&unknown); err != nil || unknown != 1 {
		t.Fatalf("recovery must persist one result-unknown event: count=%d err=%v", unknown, err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id=$1`, occurrenceID).Scan(&runs); err != nil || runs != 1 {
		t.Fatalf("unknown occurrence must not be retried: runs=%d err=%v", runs, err)
	}
}

func TestAW10RoutineCreateControlAndReadOnlyRun(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var me struct {
		UserID    string `json:"user_id"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "只读摘要", "prompt": "#text 本次例行报告内容",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" || created.Routine.Revision != 1 {
		t.Fatalf("例行任务创建回执不正确：%+v", created)
	}
	routineID := created.Routine.ID
	var list struct {
		ServerModels []agentModelOption `json:"server_models"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &list)
	foundServerModel := false
	for _, model := range list.ServerModels {
		if model.ProviderID.String() == providerID && model.Model == "mock-writer" && model.ExecutionLocation == "server" {
			foundServerModel = true
		}
	}
	if !foundServerModel {
		t.Fatalf("例行任务模型列表应提供已自检服务器模型，got=%+v", list.ServerModels)
	}
	t.Cleanup(func() {
		rows, err := env.srv.db.Query(t.Context(), `SELECT r.conversation_id FROM agent_run r
			JOIN agent_routine_occurrence o ON o.id=r.routine_occurrence_id WHERE o.routine_id=$1`, routineID)
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
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, routineID)
		if len(conversations) > 0 {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=ANY($1)`, conversations)
		}
	})
	control := "/api/v1/agent/routines/" + routineID.String() + "/control"
	var paused struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 1, "request_id": uuid.NewString(), "action": "pause"}, &paused)
	if paused.Routine.Status != "paused" || paused.Routine.Revision != 2 {
		t.Fatalf("暂停应CAS并停止新调度：%+v", paused.Routine)
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 2, "request_id": uuid.NewString(), "action": "enable"}, &enabled)
	if enabled.Routine.Status != "enabled" || enabled.Routine.Revision != 3 || enabled.Routine.NextDueAt == nil {
		t.Fatalf("启用应重算下一次计划时间：%+v", enabled.Routine)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=now()-interval '1 minute' WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}
	env.srv.runAgentRoutines(t.Context())
	env.srv.runAgentRoutines(t.Context())
	var scheduledID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&scheduledID); err != nil {
		t.Fatalf("调度器应创建固定时刻occurrence：%v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	var scheduledStatus string
	for time.Now().Before(deadline) {
		_ = env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_routine_occurrence WHERE id=$1`, scheduledID).Scan(&scheduledStatus)
		if scheduledStatus == "completed" || scheduledStatus == "failed" || scheduledStatus == "interrupted" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if scheduledStatus != "completed" {
		t.Fatalf("计划触发应经租约执行完成：occurrence=%s status=%s", scheduledID, scheduledStatus)
	}
	var completed struct {
		Routine      agentRoutineView `json:"routine"`
		OccurrenceID uuid.UUID        `json:"occurrence_id"`
		Status       string           `json:"status"`
	}
	runOnceRequestID := uuid.NewString()
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 3, "request_id": runOnceRequestID, "action": "run_once"}, &completed)
	if completed.Status != "accepted" || completed.OccurrenceID == uuid.Nil {
		t.Fatalf("立即运行回执不正确：%+v", completed)
	}
	var replayed struct {
		OccurrenceID uuid.UUID `json:"occurrence_id"`
		Status       string    `json:"status"`
		Replayed     bool      `json:"replayed"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 3, "request_id": runOnceRequestID, "action": "run_once"}, &replayed)
	if !replayed.Replayed || replayed.OccurrenceID != completed.OccurrenceID {
		t.Fatalf("重复立即运行必须回放同一 occurrence：first=%+v replay=%+v", completed, replayed)
	}
	deadline = time.Now().Add(8 * time.Second)
	var runStatus, occurrenceStatus string
	for time.Now().Before(deadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT r.status,o.status FROM agent_routine_occurrence o
			JOIN agent_run r ON r.id=o.run_id WHERE o.id=$1`, completed.OccurrenceID).Scan(&runStatus, &occurrenceStatus)
		if err == nil && (runStatus == "completed" || runStatus == "failed" || runStatus == "stopped") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if runStatus != "completed" || occurrenceStatus != "completed" {
		t.Fatalf("例行任务应走真实 agent_chat 主循环完成：run=%s occurrence=%s", runStatus, occurrenceStatus)
	}
	var sessionNull bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT session_id IS NULL FROM agent_run WHERE routine_occurrence_id=$1`, completed.OccurrenceID).Scan(&sessionNull); err != nil || !sessionNull {
		t.Fatalf("例行运行不得保存用户session：null=%t err=%v", sessionNull, err)
	}
	var reports int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_artifact_version WHERE source_run_id=(
		SELECT run_id FROM agent_routine_occurrence WHERE id=$1)`, completed.OccurrenceID).Scan(&reports); err != nil || reports != 1 {
		t.Fatalf("完成后必须形成一份私有报告产物：count=%d err=%v", reports, err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := sRoutineIdentityForTest(t, routineID); err == nil {
		t.Fatal("创建者降为 viewer 后，例行任务权限必须失效")
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatalf("恢复集成测试共享成员角色失败：%v", err)
	}
}

func sRoutineIdentityForTest(t *testing.T, routineID uuid.UUID) (*identity, error) {
	t.Helper()
	return env.srv.agentRoutineCurrentIdentity(t.Context(), routineID, false)
}
