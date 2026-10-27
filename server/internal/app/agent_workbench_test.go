package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAW01BootstrapFeatureSwitchesDefaultClosed(t *testing.T) {
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "")
	env.ensureToolModel(t)
	var body struct {
		Features map[string]bool `json:"features"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/bootstrap", nil, &body)
	want := []string{"workbench_ui", "conversation_organize", "context_refs", "skill_requests", "artifacts", "run_control", "event_resume", "plans", "goals", "routines", "document_parse"}
	if len(body.Features) != len(want) {
		t.Fatalf("bootstrap features = %#v, want all %d documented flags", body.Features, len(want))
	}
	for _, name := range want {
		if enabled, ok := body.Features[name]; !ok || enabled {
			t.Errorf("feature %q = %v, present=%v; want present and disabled by default", name, enabled, ok)
		}
	}

	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "workbench_ui, conversation_organize, unknown_feature")
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/bootstrap", nil, &body)
	if len(body.Features) != len(want) || !body.Features["workbench_ui"] || !body.Features["conversation_organize"] || body.Features["context_refs"] {
		t.Fatalf("configured feature switches were not isolated: %#v", body.Features)
	}
}

func TestAW09GoalFeatureRequiresRunAndPlanDependencies(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "goals")
	if agentWorkbenchFeatures()["goals"] {
		t.Fatal("goals must remain unavailable without event resume, run control, and plans")
	}
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control")
	if agentWorkbenchFeatures()["goals"] {
		t.Fatal("goals must remain unavailable without plans")
	}
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans")
	if !agentWorkbenchFeatures()["goals"] {
		t.Fatal("goals should become available when every required feature is enabled")
	}
}

func TestAW09GoalRunsAccumulateAndBlockAfterTwoUnproductiveRuns(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	path := agentRunPath(conversation, "goal")
	requestID := uuid.NewString()
	request := map[string]any{
		"request_id": requestID, "objective": "核对本周运营数据并形成建议",
		"criteria":         []map[string]any{{"text": "列出需要关注的内容", "requires_confirmation": false}},
		"account_id":       conversation.AccountID.String(),
		"model":            map[string]any{"provider_id": providerID, "model": "mock-writer"},
		"allow_background": false, "run_budget": 10, "seconds_budget": 1800,
	}
	var first struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, path, request, &first)
	var replay struct {
		Goal     agentGoalView `json:"goal"`
		Replayed bool          `json:"replayed"`
	}
	env.mustJSON(t, http.MethodPost, path, request, &replay)
	if first.Goal.ID == uuid.Nil || replay.Goal.ID != first.Goal.ID || !replay.Replayed {
		t.Fatalf("goal create replay = %+v / %+v", first.Goal, replay)
	}
	conflicting := map[string]any{"request_id": requestID, "objective": "改载荷", "criteria": request["criteria"],
		"account_id": conversation.AccountID.String(), "model": request["model"], "allow_background": false,
		"run_budget": 10, "seconds_budget": 1800}
	env.expectErr(t, http.MethodPost, path, conflicting, "agent_request_conflict")

	for i := 1; i <= 2; i++ {
		status, body := env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
			"text": "请按目标继续核对", "request_id": uuid.NewString(), "protocol_version": 2,
		})
		if status != http.StatusAccepted {
			t.Fatalf("goal run %d was not accepted: %d %s", i, status, body)
		}
		runID := aw06WaitRun(t, body)
		var linked bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT goal_id=$2 FROM agent_run WHERE id=$1`, runID, first.Goal.ID).Scan(&linked); err != nil || !linked {
			t.Fatalf("run %s goal association = %v, err=%v", runID, linked, err)
		}
	}
	goal, err := scanAgentGoal(env.srv.db.QueryRow(t.Context(), agentGoalSelect+` WHERE id=$1`, first.Goal.ID))
	if err != nil {
		t.Fatal(err)
	}
	if goal.UsedRuns != 2 || goal.NoProgressRuns != 2 || goal.Status != "blocked" {
		t.Fatalf("goal after two unproductive runs = runs:%d no_progress:%d status:%s", goal.UsedRuns, goal.NoProgressRuns, goal.Status)
	}
}

func TestAW09GoalsStayOwnerPrivateAndViewerCannotControl(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	var created struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, agentRunPath(conversation, "goal"), map[string]any{
		"request_id": uuid.NewString(), "objective": "本人专属运营目标",
		"criteria":   []map[string]any{{"text": "保留本人隐私"}},
		"account_id": conversation.AccountID.String(), "model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)

	var viewerInvite inviteDTO
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/current/invites", map[string]any{
		"role": "viewer", "max_uses": 1, "days": 1,
	}, &viewerInvite)
	viewer := env.registerClient(t, "aw09-viewer-"+uuid.NewString()[:8], testPassword)
	viewer.mustJSON(t, http.MethodPost, "/api/v1/workspaces/join", map[string]any{"code": viewerInvite.Code, "switch": true}, nil)
	viewer.expectErr(t, http.MethodPost, "/api/v1/agent/goals/"+created.Goal.ID.String()+"/control", map[string]any{
		"expected_revision": created.Goal.Revision, "request_id": uuid.NewString(), "action": "cancel",
	}, "forbidden")
	viewer.restore(env)

	var editorInvite inviteDTO
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/current/invites", map[string]any{
		"role": "editor", "max_uses": 1, "days": 1,
	}, &editorInvite)
	editor := env.registerClient(t, "aw09-editor-"+uuid.NewString()[:8], testPassword)
	editor.mustJSON(t, http.MethodPost, "/api/v1/workspaces/join", map[string]any{"code": editorInvite.Code, "switch": true}, nil)
	editor.expectErr(t, http.MethodPost, "/api/v1/agent/goals/"+created.Goal.ID.String()+"/control", map[string]any{
		"expected_revision": created.Goal.Revision, "request_id": uuid.NewString(), "action": "cancel",
	}, "not_found")
	editor.restore(env)
}

func TestAW09ArchivedTaskListAndPrivateCompletionNotification(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans")
	providerID := env.ensureToolModel(t)

	conversation := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	goalBody := map[string]any{
		"request_id": uuid.NewString(), "objective": "核对一项运营结果",
		"criteria":   []map[string]any{{"text": "形成可核验的结论", "requires_confirmation": true}},
		"account_id": conversation.AccountID.String(), "model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
		"run_budget": 10, "seconds_budget": 1800,
	}
	var created struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, agentRunPath(conversation, "goal"), goalBody, &created)
	if created.Goal.ID == uuid.Nil || len(created.Goal.Criteria) != 1 {
		t.Fatalf("created goal = %+v", created.Goal)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_conversation SET archived_at=now() WHERE id=$1`, conversation.ID); err != nil {
		t.Fatal(err)
	}
	var tasks struct {
		Items []agentConversationListItem `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?state=task&archived=all", nil, &tasks)
	found := false
	for _, item := range tasks.Items {
		if item.ID == conversation.ID && item.Goal != nil && item.Goal.ID == created.Goal.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("archived goal task missing without conversation_organize: %+v", tasks.Items)
	}

	criteria, _ := json.Marshal([]agentGoalCriterion{{ID: created.Goal.Criteria[0].ID, Text: "形成可核验的结论",
		RequiresConfirmation: true, Status: "needs_confirmation", EvidenceRefs: []agentPlanEvidenceRef{}}})
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_goal SET criteria=$2 WHERE id=$1`, created.Goal.ID, criteria); err != nil {
		t.Fatal(err)
	}
	confirmRequestID := uuid.New()
	var confirmed struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/goals/"+created.Goal.ID.String()+"/confirm-criterion", map[string]any{
		"expected_revision": created.Goal.Revision, "request_id": confirmRequestID,
		"criterion_id": created.Goal.Criteria[0].ID, "confirmed": true,
	}, &confirmed)
	if confirmed.Goal.Status != "completed" || confirmed.Goal.Criteria[0].Status != "confirmed" {
		t.Fatalf("manual confirmation result = %+v", confirmed.Goal)
	}
	var userID, workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT user_id,workspace_id FROM agent_goal WHERE id=$1`, created.Goal.ID).Scan(&userID, &workspaceID); err != nil {
		t.Fatal(err)
	}
	var noticeCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM notification WHERE user_id=$1 AND workspace_id=$2 AND kind='agent_goal' AND dedupe_key=$3`,
		userID, workspaceID, "agent_goal:"+confirmRequestID.String()+":completed").Scan(&noticeCount); err != nil {
		t.Fatal(err)
	}
	if noticeCount != 1 {
		t.Fatalf("private completion notice count = %d, want 1", noticeCount)
	}
}

func TestAW01ConversationPatchUsesRevisionCAS(t *testing.T) {
	env.ensureToolModel(t)
	c := env.createConversation(t, map[string]any{})
	t.Cleanup(func() { deleteConversations(t, c.ID) })
	var patched struct {
		ID       uuid.UUID `json:"id"`
		Title    string    `json:"title"`
		Revision int64     `json:"revision"`
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+c.ID.String(), map[string]any{
		"expected_revision": 1,
		"title":             "第一次修改",
	}, &patched)
	if patched.Title != "第一次修改" || patched.Revision != 2 {
		t.Fatalf("first CAS patch = %+v, want title and revision 2", patched)
	}
	status, raw := env.do(http.MethodPatch, "/api/v1/agent/conversations/"+c.ID.String(), map[string]any{
		"expected_revision": 1,
		"title":             "过期修改",
	})
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &failure); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusConflict || failure.Error.Code != "agent_revision_conflict" {
		t.Fatalf("stale CAS patch = %d %s, want 409 agent_revision_conflict", status, raw)
	}
}

func TestAW01ConversationCreateRequestIDIsIdempotent(t *testing.T) {
	env.ensureToolModel(t)
	requestID := uuid.NewString()
	input := map[string]any{"request_id": requestID, "title": "同一创建请求"}
	var first, replay struct {
		ID       uuid.UUID `json:"id"`
		Title    string    `json:"title"`
		Revision int64     `json:"revision"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", input, &first)
	t.Cleanup(func() { deleteConversations(t, first.ID) })
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", input, &replay)
	if first.ID == uuid.Nil || replay.ID != first.ID {
		t.Fatalf("idempotent create returned ids %s and %s", first.ID, replay.ID)
	}

	status, raw := env.do(http.MethodPost, "/api/v1/agent/conversations", map[string]any{
		"request_id": requestID,
		"title":      "同一请求ID的不同内容",
	})
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(raw), &failure); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusConflict || failure.Error.Code != "agent_request_conflict" {
		t.Fatalf("conflicting request id = %d %s, want 409 agent_request_conflict", status, raw)
	}
}

func TestAW04MessageRequestIDIsIdempotent(t *testing.T) {
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	requestID := uuid.New()
	operation := "conversation.message:" + conversation.ID.String()
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM agent_request WHERE request_id=$1 AND operation=$2`, requestID, operation)
	})
	env.llm.ResetRequests()
	path := "/api/v1/agent/conversations/" + conversation.ID.String() + "/messages"
	input := map[string]any{"request_id": requestID, "text": "AW04 同一请求只运行一次"}
	if status, body := env.do(http.MethodPost, path, input); status != http.StatusOK {
		t.Fatalf("first message request = %d %s", status, body)
	}
	modelCalls := len(env.llm.Requests())
	if modelCalls == 0 {
		t.Fatal("first message request did not reach the model")
	}
	status, body := env.do(http.MethodPost, path, input)
	var replay struct {
		Status    string    `json:"status"`
		MessageID uuid.UUID `json:"message_id"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &replay) != nil || replay.Status != "replayed" || replay.MessageID == uuid.Nil {
		t.Fatalf("replayed request = %d %s", status, body)
	}
	if calls := len(env.llm.Requests()); calls != modelCalls {
		t.Fatalf("replay called model again: first=%d after_replay=%d", modelCalls, calls)
	}
	var messages int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_message
		WHERE conversation_id=$1 AND role='user' AND content=$2`, conversation.ID, input["text"]).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if messages != 1 {
		t.Fatalf("replay created %d user messages, want one", messages)
	}
	conflict := map[string]any{"request_id": requestID, "text": "AW04 同一请求编号不能改载荷"}
	status, body = env.do(http.MethodPost, path, conflict)
	if status != http.StatusConflict || agentErrCodeOf(t, body) != "agent_request_conflict" {
		t.Fatalf("same request ID with a different payload = %d %s", status, body)
	}
}
