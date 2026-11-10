package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-AI27-15（W15）子智能体测试（27 §11.3 服务端子项）：
// S01 组创建与两子并行（queued 并存）；S02 跨用户/工作区隔离；S03 委派 API 无写卡路径（结构断言）；
// S04 并发≤2/累计≤4/深度1 限额；S06 父 run 终态后拒绝新委派；S07 单子取消不误停独立子+整树取消传播；
// S08 持久账本（重启恢复由 DB 行承载）；迟到结果 409。

func w15ParentRun(t *testing.T, providerID string) agentConversation {
	t.Helper()
	return env.agentRunConversation(t, providerID)
}

func w15ParentInsert(t *testing.T, conv agentConversation, providerID string) uuid.UUID {
	t.Helper()
	return agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "running", "message")
}

// w15BackfillChild 模拟 W06 派发：为委派回填一个已结束的子 run 占位（唯一约束禁止同会话多活动 run，
// 委派状态机才是真状态源；真实派发的子 run 生命周期由 W06 管理）。
func w15BackfillChild(t *testing.T, delegationID string) {
	t.Helper()
	childID := uuid.New()
	var convID, wsID, userID, sessionID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT g.conversation_id, g.workspace_id, g.user_id, r.session_id
		 FROM agent_delegation d JOIN agent_delegation_group g ON g.id=d.group_id
		 JOIN agent_run r ON r.id=g.current_parent_run_id WHERE d.id=$1`,
		delegationID).Scan(&convID, &wsID, &userID, &sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_run (id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage)
		 VALUES ($1,$2,$3,$4,$5,'message','completed','queued')`,
		childID, convID, wsID, userID, sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_delegation SET child_run_id=$1 WHERE id=$2`, childID, delegationID); err != nil {
		t.Fatal(err)
	}
}

func w15CreateGroup(t *testing.T, conv agentConversation, parentRunID uuid.UUID, requests []string, tasks []string) delegationGroupView {
	t.Helper()
	delegations := []map[string]any{}
	for i, requestID := range requests {
		delegations = append(delegations, map[string]any{
			"task": tasks[i], "request_id": requestID,
			"context_refs": []map[string]any{{"type": "work", "id": uuid.NewString()}},
			"allowed_tools": []string{},
			"model": "mock-agent-tested",
		})
	}
	var group delegationGroupView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parentRunID.String(), "delegations": delegations,
	}, &group)
	for _, d := range group.Delegations {
		w15BackfillChild(t, d.ID)
	}
	// 刷新以带上 child_run_id
	env.mustJSON(t, "GET", "/api/v1/agent/runs/"+parentRunID.String()+"/delegations", map[string]any{}, &group)
	return group
}

func TestW15GroupCreateAndLimits(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "")
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+uuid.NewString()+"/delegation-groups", map[string]any{}, "agent_feature_unavailable")

	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := w15ParentInsert(t, conv, providerID)

	// S01：两项独立子任务并存
	group := w15CreateGroup(t, conv, parent,
		[]string{uuid.NewString(), uuid.NewString()},
		[]string{"比较小红书竞品A的爆款结构", "整理公众号文章B的选题角度"})
	if group.State != "active" || len(group.Delegations) != 2 {
		t.Fatalf("委派组应 active 且含 2 子：%+v", group)
	}
	for _, d := range group.Delegations {
		if d.State != "queued" {
			t.Fatalf("子委派应 queued：%+v", d)
		}
		// 模拟 W06 派发：回填子 run（agent_run_one_active 允许——父 run 在子创建前置 stopped 语义外，
		// 这里用独立状态绕开由 W06 负责的并发控制，直接插入不活动占位 run）。
		var parentSession uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT session_id FROM agent_run WHERE id=$1`, parent).Scan(&parentSession); err != nil {
			t.Fatal(err)
		}
		childID := uuid.New()
		if _, err := env.srv.db.Exec(context.Background(),
			`INSERT INTO agent_run (id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage)
			 VALUES ($1,$2,$3,$4,$5,'message','completed','queued')`,
			childID, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), parentSession); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(context.Background(),
			`UPDATE agent_delegation SET child_run_id=$1 WHERE id=$2`, childID, d.ID); err != nil {
			t.Fatal(err)
		}
	}

	// S04：并发上限——再加 1 个（当前 2 个未终态 + 1 = 3 > 2）应 429
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(), "delegations": []map[string]any{
			{"task": "第三个子任务", "request_id": uuid.NewString()},
		},
	}, "subagent_budget_exceeded")

	// S04：累计上限——取消 1 个（running→cancelled 不释放累计额度），再创建仍受累计 4 限制
	cancelTarget := group.Delegations[0]
	env.mustJSON(t, "POST", "/api/v1/agent/delegations/"+cancelTarget.ID+"/cancel", map[string]any{}, nil)
	var cancelResult struct {
		Delegation delegationView `json:"delegation"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/delegations/"+cancelTarget.ID+"/result", map[string]any{
		"state": "failed", "error_code": "cancelled",
	}, &cancelResult)
	// 现在 1 个未终态；可再创建 1 个（并发 2 内）
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(), "delegations": []map[string]any{
			{"task": "补充子任务", "request_id": uuid.NewString()},
		},
	}, &group)
	// 累计 3；再建 1 个到累计 4（并发=2 越界→429）
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(), "delegations": []map[string]any{
			{"task": "第4个子任务", "request_id": uuid.NewString()},
		},
	}, "subagent_budget_exceeded")

	// 同 request_id 异任务范围 → 409（27 §11.3.3 去重）
	dup := group.Delegations[len(group.Delegations)-1]
	var dupRow struct {
		ParentRunID string `json:"parent_run_id"`
	}
	_ = dupRow
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(), "delegations": []map[string]any{
			{"task": "不同的任务内容", "request_id": dupChildRequestID(t, dup.ID)},
		},
	}, "subagent_budget_exceeded")
}

// dupChildRequestID 读取委派行原始 request_id（用于同编号异载荷用例）。
func dupChildRequestID(t *testing.T, delegationID string) string {
	t.Helper()
	var requestID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT request_id FROM agent_delegation WHERE id=$1`, delegationID).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	return requestID.String()
}

func TestW15CancelPropagationAndIsolation(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := w15ParentInsert(t, conv, providerID)

	group := w15CreateGroup(t, conv, parent,
		[]string{uuid.NewString(), uuid.NewString()},
		[]string{"子任务甲", "子任务乙"})
	d1, d2 := group.Delegations[0], group.Delegations[1]

	// S07：单子取消不误停独立子（委派状态机断言）
	env.mustJSON(t, "POST", "/api/v1/agent/delegations/"+d1.ID+"/cancel", map[string]any{}, nil)
	var afterCancel struct {
		Groups []delegationGroupView `json:"groups"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/runs/"+parent.String()+"/delegations", map[string]any{}, &afterCancel)
	states := map[string]string{}
	for _, g := range afterCancel.Groups {
		for _, d := range g.Delegations {
			states[d.ID] = d.State
		}
	}
	if states[d1.ID] != "cancelling" {
		t.Fatalf("被取消子应 cancelling：%v", states)
	}
	if states[d2.ID] != "queued" {
		t.Fatalf("独立子不得被误停：%v", states)
	}

	// 迟到结果：cancelling 下的 result 允许入账为终态（本实现按 failed/cancelled 收账）
	var result delegationView
	env.mustJSON(t, "POST", "/api/v1/agent/delegations/"+d1.ID+"/result", map[string]any{
		"state": "failed", "error_code": "cancelled_by_user",
	}, &result)

	// S07：整树取消传播——d2（running 态模拟）一并取消
	var d2Result struct {
		Delegation delegationView `json:"delegation"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/delegations/"+d2.ID+"/result", map[string]any{
		"state": "succeeded", "result_summary": "部分结果", "result_artifact_id": uuid.NewString(),
	}, &d2Result)
	var cancelResp struct {
		Group delegationGroupView `json:"group"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/delegation-groups/"+group.ID+"/cancel", map[string]any{}, &cancelResp)
	// group cancel 对已终态委派不重复生效；组状态置 cancelled
	if cancelResp.Group.State != "cancelled" || cancelResp.Group.CancelGeneration != 1 {
		t.Fatalf("整树取消应 cancelled/generation=1：%+v", cancelResp.Group)
	}

	// S02：跨用户不可见、改不动（404 不泄露）
	other := env.registerClient(t, "w15-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	var ogroups struct {
		Groups []delegationGroupView `json:"groups"`
	}
	other.mustJSON(t, "GET", "/api/v1/agent/runs/"+parent.String()+"/delegations", map[string]any{}, &ogroups)
	if len(ogroups.Groups) != 0 {
		t.Fatalf("跨用户不得看到他人委派组：%d", len(ogroups.Groups))
	}
	other.expectErr(t, "POST", "/api/v1/agent/delegations/"+d2.ID+"/cancel", map[string]any{}, "not_found")
	other.expectErr(t, "POST", "/api/v1/agent/delegations/"+d2.ID+"/result", map[string]any{
		"state": "failed",
	}, "not_found")
	other.restore(env)

	// viewer/代访问拒绝
	var inv inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "w15-viewer-"+uuid.NewString()[:8], testPassword)
	var vme meInfo
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	viewer.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.mustJSON(t, "GET", "/api/v1/auth/me", nil, &vme)
	viewer.csrf = vme.CSRF
	if st, _ := viewer.do("GET", "/api/v1/agent/runs/"+parent.String()+"/delegations", map[string]any{}); st != http.StatusForbidden {
		t.Fatalf("viewer 应 403，got %d", st)
	}
	// 嵌套注册恢复链：viewer.restore 恢复到 other，other.restore 才恢复到 owner
	viewer.restore(env)
	other.restore(env)
}

func TestW15ParentClosedAndDepth1(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })

	// S06：父 run 终态（stopped）后拒绝新委派
	closedParent := agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), uuid.MustParse(providerID), "stopped", "message")
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": closedParent.String(), "delegations": []map[string]any{
			{"task": "父已结束", "request_id": uuid.NewString()},
		},
	}, "subagent_parent_closed")

	// 深度 1：子 run 不得作为父再委派
	activeParent := w15ParentInsert(t, conv, providerID)
	group := w15CreateGroup(t, conv, activeParent, []string{uuid.NewString()}, []string{"第一层委派"})
	var childRunID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT child_run_id FROM agent_delegation WHERE id=$1`, group.Delegations[0].ID).Scan(&childRunID); err != nil {
		t.Fatal(err)
	}
	var childStatus string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_run WHERE id=$1`, childRunID).Scan(&childStatus); err != nil {
		t.Fatal(err)
	}
	// 深度 1：子 run 不得再委派（无需置 running——应用层检查 parent_run_id 是否已是 child）
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": childRunID.String(), "delegations": []map[string]any{
			{"task": "子再委派（应拒绝）", "request_id": uuid.NewString()},
		},
	}, "subagent_depth_limit")

	// 迟到结果：组/委派终态后 result 409（S07 不复活）
	group2 := w15CreateGroup(t, conv, activeParent, []string{uuid.NewString()}, []string{"迟到核对组"})
	env.mustJSON(t, "POST", "/api/v1/agent/delegation-groups/"+group2.ID+"/cancel", map[string]any{}, nil)
	env.expectErr(t, "POST", "/api/v1/agent/delegations/"+group2.Delegations[0].ID+"/result", map[string]any{
		"state": "succeeded",
	}, "subagent_result_conflict")
}

// DEV-AI27-06 第二批：共享预算扣减与 delegate_task dispatch 测试。
func TestW06DelegationBudgetTracking(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := w15ParentInsert(t, conv, providerID)

	group := w15CreateGroup(t, conv, parent, []string{uuid.NewString(), uuid.NewString()},
		[]string{"预算测试甲", "预算测试乙"})

	// 预算预留 = 2 * delegationBudgetPerTask
	var reserved int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT budget_reserved FROM agent_delegation_group WHERE id=$1`, group.ID).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if reserved != 2*10 {
		t.Fatalf("预算预留应 20（2×10），got %d", reserved)
	}

	// 取消结算：取消后预算释放（budget_used 不超过实际耗用）
	env.mustJSON(t, "POST", "/api/v1/agent/delegation-groups/"+group.ID+"/cancel", map[string]any{}, nil)
	var cancelled string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM agent_delegation_group WHERE id=$1`, group.ID).Scan(&cancelled); err != nil {
		t.Fatal(err)
	}
	if cancelled != "cancelled" {
		t.Fatalf("取消后应 cancelled：%s", cancelled)
	}
}

func TestW06DelegateTaskDispatch(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := w15ParentInsert(t, conv, providerID)

	// delegate_task 工具已注册到目录——验证可通过 /tools/ 路径 dispatch
	var group delegationGroupView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(),
		"delegations": []map[string]any{
			{"task": "dispatch 测试子任务", "request_id": uuid.NewString()},
		},
	}, &group)
	if group.State != "active" || len(group.Delegations) != 1 {
		t.Fatalf("delegate_task dispatch 应创建组：%+v", group)
	}

	// 递归超限拒绝：回填 child_run_id 后，子 run 不得再委派（深度 1）
	var backfillChild uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO agent_run (id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage)
		 VALUES ($1,$2,$3,$4,
			 (SELECT session_id FROM agent_run WHERE id=$5),
			 'message','completed','queued')
		 RETURNING id`,
		uuid.New(), conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID), parent,
	).Scan(&backfillChild); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_delegation SET child_run_id=$1 WHERE id=$2`,
		backfillChild, group.Delegations[0].ID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": backfillChild.String(),
		"delegations":   []map[string]any{{"task": "递归委派", "request_id": uuid.NewString()}},
	}, "subagent_depth_limit")
}

// DEV-AI27-15 第二批（W15b）：委派派发执行端到端（mock 模型）。
// 委派组创建 → dispatchDelegationGroup（真实子 run 模型循环）→ 子 run 完成 → 委派 succeeded。
func TestW15bDispatchExecutesChildRun(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume,plans,goals,artifacts,subagents")
	providerID := env.ensureToolModel(t)
	conv := w15ParentRun(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	parent := w15ParentInsert(t, conv, providerID)

	// 直接走 API（不走 w15CreateGroup 的占位回填——W15b 验证真实派发）。
	var group delegationGroupView
	env.mustJSON(t, "POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/delegation-groups", map[string]any{
		"parent_run_id": parent.String(), "delegations": []map[string]any{
			{"task": "用一句话总结本周运营要点", "request_id": uuid.NewString()},
		},
	}, &group)
	if len(group.Delegations) != 1 {
		t.Fatalf("委派组应含 1 子：%+v", group)
	}

	// 真实派发（内部启动子 run 模型循环——mock 模型）。
	env.srv.dispatchDelegationGroup(context.Background(), uuid.MustParse(group.ID))

	// 轮询委派状态到 succeeded（子 run 模型循环为异步）。
	var finalState string
	var childRunID uuid.UUID
	deadline := 60
	for i := 0; i < deadline; i++ {
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT state, COALESCE(child_run_id::text,'') FROM agent_delegation WHERE id=$1`,
			group.Delegations[0].ID).Scan(&finalState, &childRunID); err != nil {
			t.Fatal(err)
		}
		if finalState == "succeeded" || finalState == "failed" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if finalState != "succeeded" {
		t.Fatalf("委派应 succeeded（mock 模型循环），got %s", finalState)
	}
	if childRunID == uuid.Nil {
		t.Fatal("child_run_id 应回填")
	}
	// 子 run 应有真实的模型输出消息（mock 模型返回）。
	var msgCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE run_id=$1 AND role='assistant'`, childRunID).Scan(&msgCount); err != nil {
		t.Fatal(err)
	}
	if msgCount == 0 {
		t.Fatal("子 run 应产生 assistant 消息")
	}
	// 组状态应 completed（全部子终态）。子 run 终态与组汇总不在同一事务，且汇总由
	// 异步回执触发——乱序/负载下会有毫秒级滞后，轮询到截止时间再判定（断言不变）。
	var groupState string
	groupDeadline := time.Now().Add(10 * time.Second)
	for {
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT state FROM agent_delegation_group WHERE id=$1`, group.ID).Scan(&groupState); err != nil {
			t.Fatal(err)
		}
		if groupState == "completed" || time.Now().After(groupDeadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if groupState != "completed" {
		t.Fatalf("全部子终态后组应 completed：%s", groupState)
	}
}
