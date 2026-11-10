package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-A13（W06 父 run 续接）：A13-T01～T08（docs/32 §12）。
// 覆盖等待态、不自动建 run、承接一次、预算不重复、子任务在跑 409、崩溃恢复、
// 子消息隔离、跨租户 404。

func a13Setup(t *testing.T) (agentConversation, uuid.UUID, string) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID),
		uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
	return conv, parent, providerID
}

func a13CreateGroup(t *testing.T, conv agentConversation, parent uuid.UUID, task string) delegationGroupView {
	t.Helper()
	var group delegationGroupView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(),
		"delegations": []map[string]any{
			{"task": task, "request_id": uuid.NewString(), "allowed_tools": []string{"works__list"}},
		},
	}, &group)
	return group
}

// a13EndParent 模拟父 run 进入等待（派发后结束当前活动 run），并写组等待态。
func a13EndParent(t *testing.T, convID, parent uuid.UUID) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_run SET status='awaiting_confirmation', stage='awaiting_confirmation' WHERE id=$1`, parent); err != nil {
		t.Fatal(err)
	}
	env.srv.markDelegationParentEnded(context.Background(), convID, parent)
}

func a13GetGroup(t *testing.T, groupID string) delegationGroupView {
	t.Helper()
	var view delegationGroupView
	env.mustJSON(t, "GET", "/api/v1/agent/delegation-groups/"+groupID, map[string]any{}, &view)
	return view
}

func a13WaitRun(t *testing.T, runID uuid.UUID) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var status string
		if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM agent_run WHERE id=$1`, runID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "completed" || status == "failed" || status == "stopped" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("run %s 未在 30s 内结束", runID)
}

func a13LatestRun(t *testing.T, convID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM agent_run
		WHERE conversation_id=$1 ORDER BY started_at DESC, id DESC LIMIT 1`, convID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func a13CountRuns(t *testing.T, convID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_run WHERE conversation_id=$1`, convID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A13-T01：父 run 结束、子任务未终态 → 组 waiting_user + parent_ended_at。
func TestA13T01GroupWaitsForUser(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T01 子任务")
	a13EndParent(t, conv.ID, parent)

	view := a13GetGroup(t, group.ID)
	if view.State != "waiting_user" || view.ParentEndedAt == "" {
		t.Fatalf("组应为 waiting_user 且有 parent_ended_at：%+v", view)
	}
	var eventCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_event
		WHERE conversation_id=$1 AND type='delegation.group_waiting_user'`, conv.ID).Scan(&eventCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 {
		t.Fatalf("group_waiting_user 事件应为 1，got %d", eventCount)
	}
}

// A13-T02：子任务完成不自动建 run（等待两个调度轮也不产生新 run / 不调用模型）。
func TestA13T02NoAutomaticRun(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T02 子任务")
	a13EndParent(t, conv.ID, parent)
	before := a13CountRuns(t, conv.ID)
	env.llm.ResetRequests()
	env.srv.sweepDelegationGroups(context.Background())
	env.srv.sweepDelegationGroups(context.Background())
	if after := a13CountRuns(t, conv.ID); after != before {
		t.Fatalf("sweep 不应创建 run：before=%d after=%d", before, after)
	}
	if calls := len(env.llm.Requests()); calls != 0 {
		t.Fatalf("sweep 不应调用模型：%d", calls)
	}
	if got := a13GetGroup(t, group.ID); got.State != "waiting_user" {
		t.Fatalf("sweep 后组应保持 waiting_user：%s", got.State)
	}
}

// A13-T03：用户消息承接一次，注入 system_note 摘要；第二条消息不再注入。
func TestA13T03AdoptionConsumesResultsOnce(t *testing.T) {
	conv, parent, providerID := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T03 汇总子任务")
	a13EndParent(t, conv.ID, parent)
	// 子任务先落终态与结果（等价于派发完成）。
	child := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID),
		uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "completed", "message")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_delegation
		SET child_run_id=$1, state='succeeded', result_summary='T03 子结果摘要', updated_at=now() WHERE id=$2`,
		child, group.Delegations[0].ID); err != nil {
		t.Fatal(err)
	}
	env.srv.touchDelegationGroupOnChildDone(context.Background(), uuid.MustParse(group.Delegations[0].ID))

	path := "/api/v1/agent/conversations/" + conv.ID.String() + "/messages"
	if status, body := env.do(http.MethodPost, path, map[string]any{
		"text": "汇总一下子任务结果", "request_id": uuid.NewString()}); status != http.StatusOK {
		t.Fatalf("承接消息失败：%d %s", status, body)
	}
	first := a13LatestRun(t, conv.ID)
	a13WaitRun(t, first)

	var notes int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_message
		WHERE conversation_id=$1 AND run_id=$2 AND role='system_note' AND content LIKE '%子任务结果摘要%'`,
		conv.ID, first).Scan(&notes); err != nil {
		t.Fatal(err)
	}
	if notes != 1 {
		t.Fatalf("承接 run 应注入 1 条 system_note，got %d", notes)
	}
	view := a13GetGroup(t, group.ID)
	if view.ResultsConsumedAt == "" || view.ConsumedByRunID != first.String() || view.AdoptionCount != 1 {
		t.Fatalf("组应记录一次性消费：%+v", view)
	}

	if status, body := env.do(http.MethodPost, path, map[string]any{
		"text": "再聊一句", "request_id": uuid.NewString()}); status != http.StatusOK {
		t.Fatalf("第二条消息失败：%d %s", status, body)
	}
	a13WaitRun(t, a13LatestRun(t, conv.ID))
	var totalNotes int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_message
		WHERE conversation_id=$1 AND role='system_note' AND content LIKE '%子任务结果摘要%'`, conv.ID).Scan(&totalNotes); err != nil {
		t.Fatal(err)
	}
	if totalNotes != 1 {
		t.Fatalf("第二条消息不得重复注入摘要，got %d", totalNotes)
	}
}

// A13-T04：预算不重复领取；已消费的组再"汇总"返回 409。
func TestA13T04BudgetNotReclaimed(t *testing.T) {
	conv, parent, providerID := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T04 预算子任务")
	a13EndParent(t, conv.ID, parent)
	child := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID),
		uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "completed", "message")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_delegation
		SET child_run_id=$1, state='succeeded', result_summary='T04 结果', updated_at=now() WHERE id=$2`,
		child, group.Delegations[0].ID); err != nil {
		t.Fatal(err)
	}
	env.srv.touchDelegationGroupOnChildDone(context.Background(), uuid.MustParse(group.Delegations[0].ID))

	if status, body := env.do(http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/messages",
		map[string]any{"text": "汇总", "request_id": uuid.NewString()}); status != http.StatusOK {
		t.Fatalf("汇总消息失败：%d %s", status, body)
	}
	a13WaitRun(t, a13LatestRun(t, conv.ID))

	var limit, used, reserved int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT b.rounds_limit, b.rounds_used, b.rounds_reserved
		FROM agent_delegation_group g JOIN agent_task_budget b ON b.budget_scope_id=g.budget_scope_id
		WHERE g.id=$1`, group.ID).Scan(&limit, &used, &reserved); err != nil {
		t.Fatal(err)
	}
	if limit != delegationTaskRoundsLimit() || used+reserved > limit {
		t.Fatalf("预算不变量被破坏：limit=%d used=%d reserved=%d", limit, used, reserved)
	}
	env.expectErr(t, "POST", "/api/v1/agent/delegation-groups/"+group.ID+"/adopt", map[string]any{},
		"delegation_results_consumed")
}

// A13-T04b：同一任务链的第二批委派复用同一预算池，不重复领取额度（docs/32 D5）。
func TestA13T04bSameTaskSharesBudgetPool(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	first := a13CreateGroup(t, conv, parent, "T04b 第一批")
	second := a13CreateGroup(t, conv, parent, "T04b 第二批")

	var scope1, scope2 uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1`, first.ID).Scan(&scope1); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1`, second.ID).Scan(&scope2); err != nil {
		t.Fatal(err)
	}
	if scope1 != scope2 {
		t.Fatalf("同一任务链应复用预算池：%s != %s", scope1, scope2)
	}
	var reserved, limit int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT rounds_reserved, rounds_limit FROM agent_task_budget WHERE budget_scope_id=$1`, scope1).
		Scan(&reserved, &limit); err != nil {
		t.Fatal(err)
	}
	if reserved != 2*delegationBudgetPerTask || reserved > limit {
		t.Fatalf("两批子任务应累计预留 %d 轮：reserved=%d limit=%d", 2*delegationBudgetPerTask, reserved, limit)
	}
}

// A13-T05：组内仍有子任务在跑时，新消息返回 409 delegation_children_running 且不建 run。
func TestA13T05ChildrenRunningBlocks(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T05 在跑子任务")
	a13EndParent(t, conv.ID, parent)
	before := a13CountRuns(t, conv.ID)
	status, body := env.do(http.MethodPost, "/api/v1/agent/conversations/"+conv.ID.String()+"/messages",
		map[string]any{"text": "现在汇总", "request_id": uuid.NewString()})
	if status != http.StatusConflict || !strings.Contains(string(body), "delegation_children_running") {
		t.Fatalf("应为 409 delegation_children_running：%d %s", status, body)
	}
	if after := a13CountRuns(t, conv.ID); after != before {
		t.Fatalf("409 不得创建 run：before=%d after=%d", before, after)
	}
	if got := a13GetGroup(t, group.ID); got.AdoptionCount != 0 {
		t.Fatalf("409 不得承接：%+v", got)
	}
}

// A13-T06：承接 run 失败且结果未消费 → sweep 释放 adopted_run_id，下次可再次承接。
func TestA13T06SweepReleasesFailedAdoption(t *testing.T) {
	conv, parent, providerID := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T06 崩溃恢复")
	a13EndParent(t, conv.ID, parent)
	failedRun := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID),
		uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "failed", "continue")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_delegation_group
		SET adopted_run_id=$1, adopted_at=now(), adoption_count=1 WHERE id=$2`, failedRun, group.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.sweepDelegationGroups(context.Background())
	view := a13GetGroup(t, group.ID)
	if view.AdoptedRunID != "" || view.AdoptionCount != 1 {
		t.Fatalf("sweep 应释放 adopted_run_id 且保留计数：%+v", view)
	}
	var events int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_event
		WHERE type='delegation.adoption_released' AND payload->>'group_id'=$1`, group.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Fatalf("adoption_released 事件应为 1，got %d", events)
	}
}

// A13-T07：子 run 消息不进会话列表；子 run 自己仍能看到任务文本。
func TestA13T07ChildMessagesIsolated(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	marker := "T07 子任务唯一标记 " + uuid.NewString()
	group := a13CreateGroup(t, conv, parent, marker)
	env.srv.dispatchDelegationGroup(context.Background(), uuid.MustParse(group.ID))

	var childRunID uuid.UUID
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var state string
		var child string
		if err := env.srv.db.QueryRow(context.Background(), `SELECT state, COALESCE(child_run_id::text,'')
			FROM agent_delegation WHERE id=$1`, group.Delegations[0].ID).Scan(&state, &child); err != nil {
			t.Fatal(err)
		}
		if child != "" {
			childRunID = uuid.MustParse(child)
		}
		if state == "succeeded" || state == "failed" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if childRunID == uuid.Nil {
		t.Fatal("子 run 未派生")
	}
	var taskMessages int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_message
		WHERE run_id=$1 AND role='user' AND content=$2`, childRunID, marker).Scan(&taskMessages); err != nil {
		t.Fatal(err)
	}
	if taskMessages != 1 {
		t.Fatalf("子 run 应有 1 条任务文本消息，got %d", taskMessages)
	}
	status, body := env.do(http.MethodGet, "/api/v1/agent/conversations/"+conv.ID.String(), nil)
	if status != http.StatusOK {
		t.Fatalf("读取会话失败：%d %s", status, body)
	}
	if strings.Contains(string(body), marker) {
		t.Fatalf("子 run 消息不应出现在会话列表：%s", body)
	}
}

// A13-T08：跨用户访问组详情统一 404。
func TestA13T08GroupTenantIsolation(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T08 租户隔离")
	other := env.registerClient(t, "a13-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "GET", "/api/v1/agent/delegation-groups/"+group.ID, nil, "not_found")
	other.expectErr(t, "POST", "/api/v1/agent/delegation-groups/"+group.ID+"/adopt", map[string]any{}, "not_found")
	other.restore(env)
}

// A13-T09：排队但从未派发、父 run 已让位的委派超时判 expired 并释放预留，
// 避免"组永远 active + 预留不归还 + 后续消息永久 409"（docs/32 §9 恢复分支）。
func TestA13T09StaleQueuedDelegationExpires(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T09 未派发")
	a13EndParent(t, conv.ID, parent)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_delegation SET created_at=now() - interval '5 minutes' WHERE group_id=$1`, group.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.sweepDelegationGroups(context.Background())

	var state, errCode string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state, COALESCE(error_code,'') FROM agent_delegation WHERE id=$1`,
		group.Delegations[0].ID).Scan(&state, &errCode); err != nil {
		t.Fatal(err)
	}
	if state != "expired" || errCode != "dispatch_failed" {
		t.Fatalf("应判 expired/dispatch_failed：state=%s code=%s", state, errCode)
	}
	var reserved int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT rounds_reserved
		FROM agent_task_budget WHERE budget_scope_id=(SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1)`,
		group.ID).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if reserved != 0 {
		t.Fatalf("过期后应释放预留：reserved=%d", reserved)
	}
	if got := a13GetGroup(t, group.ID); got.State != "completed" {
		t.Fatalf("无未终态子任务后组应为 completed：%s", got.State)
	}
}

// A13-T10：父 run 结束后由生产入口真正派发子任务（W15b 的派发此前只有测试调用）。
func TestA13T10ParentFinishDispatchesChildren(t *testing.T) {
	conv, parent, _ := a13Setup(t)
	group := a13CreateGroup(t, conv, parent, "T10 派发入口")
	a13EndParent(t, conv.ID, parent)

	env.srv.dispatchPendingDelegationsOfParent(context.Background(), parent)

	var childRunID uuid.UUID
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var child string
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT COALESCE(child_run_id::text,'') FROM agent_delegation WHERE id=$1`,
			group.Delegations[0].ID).Scan(&child); err != nil {
			t.Fatal(err)
		}
		if child != "" {
			childRunID = uuid.MustParse(child)
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if childRunID == uuid.Nil {
		t.Fatal("父 run 结束后未派发子 run")
	}
	var origin string
	var rootRun uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT execution_origin, root_run_id FROM agent_run WHERE id=$1`, childRunID).Scan(&origin, &rootRun); err != nil {
		t.Fatal(err)
	}
	if origin != "delegation" || rootRun != parent {
		t.Fatalf("子 run 归属错误：origin=%s root=%s", origin, rootRun)
	}
	a13WaitRun(t, childRunID)
}
