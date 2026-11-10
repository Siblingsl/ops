package app

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
)

// DEV-AI27-15 第二批（W15b）：委派派发执行（27 §11.3）。
// 委派行创建后由父 run 的 delegate_task 工具结果触发本函数：
// 创建子 run（同 identity/session）→ 回填 child_run_id → 后台启动模型循环（trigger=message 语义）。
// 子 run ExecutionOrigin=delegation：模型循环内 toolG/toolR 可用，业务写入仍走原逐张卡片（红线）。
// 子 run 结果经 POST /agent/delegations/{id}/result 回执（succeeded/failed + result_artifact_id）。
// 同会话唯一活动 run 约束（agent_run_one_active）由"父 run 等待子任务时结束当前活动 run"语义避让
// （27 §11.3.3）；派发前校验父 run 状态，子 run 完成后由父续接（W06 预算池）。

// dispatchDelegationGroup 把组内全部 queued 委派逐个派发（子 run 创建+回填+后台启动）。
// 由 delegate_task 工具 dispatch 完成后调用；部分失败不回滚已派发项（逐项独立）。
func (s *Server) dispatchDelegationGroup(ctx context.Context, groupID uuid.UUID) {
	var conversationID uuid.UUID
	var parentRunID uuid.UUID
	var rootRunID uuid.UUID
	var userID uuid.UUID
	var workspaceID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT conversation_id, current_parent_run_id, root_run_id, user_id, workspace_id
		FROM agent_delegation_group WHERE id=$1 AND state IN ('active','waiting_user')`,
		groupID).Scan(&conversationID, &parentRunID, &rootRunID, &userID, &workspaceID)
	if err != nil {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT d.id, d.task, d.model, d.allowed_tools
		FROM agent_delegation d WHERE d.group_id=$1 AND d.state='queued' AND d.child_run_id IS NULL
		ORDER BY d.created_at`, groupID)
	if err != nil {
		return
	}
	type pendingItem struct {
		delegationID uuid.UUID
		task         string
		model        string
		allowedTools []string
	}
	items := []pendingItem{}
	for rows.Next() {
		var item pendingItem
		if err := rows.Scan(&item.delegationID, &item.task, &item.model, &item.allowedTools); err != nil {
			rows.Close()
			return
		}
		items = append(items, item)
	}
	rows.Close()
	slog.InfoContext(ctx, "W15b dispatch: 开始派发", "group", groupID.String(), "items", len(items))
	for _, item := range items {
		if err := s.dispatchOneDelegation(ctx, groupID, conversationID, parentRunID, rootRunID, userID, workspaceID,
			item.delegationID, item.task, item.model, item.allowedTools); err != nil {
			slog.WarnContext(ctx, "子任务派发失败", "delegation_id", item.delegationID.String(), "err", err)
		}
	}
	// DEV-A13：派发后父 run 通常已进入 awaiting_confirmation；把"仍有未终态子任务"的组
	// 置为 waiting_user，供下一次用户交互承接（不自动建 run）。
	s.markDelegationParentEnded(ctx, conversationID, parentRunID)
}

// markDelegationParentEnded 是 markDelegationParentEndedTx 的非事务包装（派发完成后调用）。
// BE-02（docs/33 §11.5）：Begin/markTx/Commit 三处失败此前全部静默（裸 return /
// `_ = tx.Commit`），waiting_user 置位丢失不可见；现改为 slog.ErrorContext 记录
// （含 conversation/run 上下文）。控制流不变：收尾失败不阻断派发主流程。
func (s *Server) markDelegationParentEnded(ctx context.Context, conversationID, parentRunID uuid.UUID) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "派发收尾开事务失败", "conversation_id", conversationID.String(), "run_id", parentRunID.String(), "err", err)
		return
	}
	defer tx.Rollback(ctx)
	if err := s.markDelegationParentEndedTx(ctx, tx, conversationID, parentRunID); err != nil {
		slog.ErrorContext(ctx, "派发收尾置位失败", "conversation_id", conversationID.String(), "run_id", parentRunID.String(), "err", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.ErrorContext(ctx, "派发收尾提交失败", "conversation_id", conversationID.String(), "run_id", parentRunID.String(), "err", err)
	}
}

// dispatchOneDelegation 派发单个委派：创建子 run 行并回填，然后后台启动模型循环。
func (s *Server) dispatchOneDelegation(ctx context.Context, groupID, conversationID, parentRunID, rootRunID, userID, workspaceID uuid.UUID,
	delegationID uuid.UUID, task, model string, allowedTools []string) error {
	// 子 run 以父 run 身份运行：构造带 identity 的 ctx（agentResolveModel 等需要）。
	var parentUsername string
	var parentRole string
	if err := s.db.QueryRow(ctx, `SELECT u.username, wm.role FROM agent_run r
		JOIN app_user u ON u.id=r.user_id
		JOIN workspace_member wm ON wm.workspace_id=r.workspace_id AND wm.user_id=r.user_id AND wm.status='active'
		WHERE r.id=$1`, parentRunID).Scan(&parentUsername, &parentRole); err != nil {
		slog.WarnContext(ctx, "W15b dispatch: 父身份查询失败", "err", err)
		return err
	}
	principalID := &identity{
		UserID:      userID,
		WorkspaceID: workspaceID,
		Username:    parentUsername,
		Role:        parentRole,
		ReauthOK:    true,
	}
	ctx = context.WithValue(ctx, ctxMember, principalID)
	// 父 run 的 session_id 与模型供子 run 复用（model 空时继承父，27 §11.3.2 模型快照）。
	var sessionID uuid.UUID
	var parentModel string
	if err := s.db.QueryRow(ctx, `SELECT session_id, COALESCE(model,'') FROM agent_run WHERE id=$1`, parentRunID).Scan(&sessionID, &parentModel); err != nil {
		slog.WarnContext(ctx, "W15b dispatch: parent session 查询失败", "err", err)
		return err
	}
	if strings.TrimSpace(model) == "" {
		model = parentModel
	}
	childRunID := uuid.New()
	// 同会话唯一活动 run：父 run 派发时通常已进入等待（awaiting_confirmation）——
	// 若父仍 running，子 run 以 completed 占位创建后立即由后台循环接管（不与父并发竞争同一约束；
	// 约束 WHERE status IN ('queued','running')，awaiting_confirmation 不受限）。
	if _, err := s.db.Exec(ctx, `INSERT INTO agent_run
		(id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model,
		 execution_origin, root_run_id, parent_run_id, delegation_group_id, delegation_id)
		VALUES ($1,$2,$3,$4,$5,'message','running','running',$6,'delegation',$7,$8,$9,$10)`,
		childRunID, conversationID, workspaceID, userID, sessionID, model,
		rootRunID, parentRunID, groupID, delegationID); err != nil {
		// 父 run 占用活动位：把父置 awaiting_confirmation 后重试一次。
		if _, err2 := s.db.Exec(ctx, `UPDATE agent_run SET status='awaiting_confirmation'
			WHERE id=$1 AND status='running'`, parentRunID); err2 != nil {
			return err
		}
		if _, err2 := s.db.Exec(ctx, `INSERT INTO agent_run
			(id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model,
			 execution_origin, root_run_id, parent_run_id, delegation_group_id, delegation_id)
			VALUES ($1,$2,$3,$4,$5,'message','running','running',$6,'delegation',$7,$8,$9,$10)`,
			childRunID, conversationID, workspaceID, userID, sessionID, model,
			rootRunID, parentRunID, groupID, delegationID); err2 != nil {
			return err2
		}
	}
	// 回填委派行：child_run_id + state=running。
	if _, err := s.db.Exec(ctx, `UPDATE agent_delegation
		SET child_run_id=$2, state='running', updated_at=now() WHERE id=$1`, delegationID, childRunID); err != nil {
		return err
	}
	// DEV-A13：子 run 的输入文本必须落库，否则模型只能看到空会话；
	// 消息归属子 run，会话列表与父上下文按 execution_origin='delegation' 过滤。
	if tx, err := s.db.Begin(ctx); err == nil {
		msgState := &agentRunState{RunID: childRunID, ConversationID: conversationID}
		_, err = s.agentInsertMessageTx(ctx, tx, msgState, "user", task, nil, "", "", nil, nil)
		if err == nil {
			err = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if err != nil {
			slog.WarnContext(ctx, "W15b dispatch: 子任务文本写入失败", "delegation_id", delegationID.String(), "err", err)
		}
	}
	// 委派状态事件。
	_, _ = s.appendAgentEvent(ctx, conversationID, &childRunID, "delegation.state_changed", map[string]any{
		"delegation_id": delegationID.String(), "state": "running",
	})
	// 组装 state 并后台启动模型循环。
	st := &agentRunState{
		RunID:           childRunID,
		ConversationID:  conversationID,
		WorkspaceID:     workspaceID,
		UserID:          userID,
		SessionID:       sessionID,
		Trigger:         "message",
		ProtocolVersion: 2,
		Mode:            "execute",
		ExecutionOrigin: "delegation",
		Model:           s.ai27ResolveModelRef(ctx, workspaceID, model),
		// 子 run 限额：每子 4 轮 / 3 分钟（27 §11.3.3），工具限委派显式允许集合。
		RoundsLimit:       delegationBudgetPerTask,
		AllowedTools:      allowedTools,
		DelegationID:      &delegationID,
		DelegationGroupID: &groupID,
		Deadline:          time.Now().Add(delegationBudgetPerTaskSeconds * time.Second),
	}
	if err := s.startAgentRunBackground(ctx, st); err != nil {
		slog.WarnContext(ctx, "W15b dispatch: 模型循环启动失败", "child", childRunID.String(), "err", err)
		// 启动失败：委派行标 failed，子 run 置 stopped。
		_, _ = s.db.Exec(ctx, `UPDATE agent_delegation SET state='failed', error_code='dispatch_failed', updated_at=now() WHERE id=$1`, delegationID)
		_, _ = s.db.Exec(ctx, `UPDATE agent_run SET status='failed' WHERE id=$1`, childRunID)
		return err
	}
	// 子 run 结束后自动回执委派结果（挂接 finishAgentRun 的钩子由 run 循环内完成；
	// 这里起一个轻量监听 goroutine 等待 run 终态）。
	go s.watchDelegationChild(context.WithoutCancel(ctx), delegationID, childRunID)
	return nil
}

// watchDelegationChild 轮询子 run 终态；终态后由 reconcileDelegationTerminal 统一对账
// （状态迁移 + 预算结算 + 组汇总），避免"watcher 与 sweep 各写一半"。
func (s *Server) watchDelegationChild(ctx context.Context, delegationID, childRunID uuid.UUID) {
	for {
		var status string
		err := s.db.QueryRow(ctx, `SELECT status FROM agent_run WHERE id=$1`, childRunID).Scan(&status)
		if err != nil {
			return
		}
		if status == "completed" || status == "failed" || status == "stopped" {
			if err := s.reconcileDelegationTerminal(ctx, delegationID); err != nil {
				slog.WarnContext(ctx, "子任务终态对账失败（等待 sweep 重试）", "delegation_id", delegationID.String(), "err", err)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// touchDelegationGroupOnChildDone 子任务终态后检查组是否全部终态（全部完成→组 completed）。
func (s *Server) touchDelegationGroupOnChildDone(ctx context.Context, delegationID uuid.UUID) {
	var groupID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT group_id FROM agent_delegation WHERE id=$1`, delegationID).Scan(&groupID); err != nil {
		return
	}
	var unfinished int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_delegation
		WHERE group_id=$1 AND state NOT IN ('succeeded','failed','cancelled','expired')`, groupID).Scan(&unfinished); err != nil {
		return
	}
	if unfinished == 0 {
		// active/waiting_user → completed；completed 只表示"全部子任务终态"，不表示"已汇总"。
		// 结果是否被承接由 results_consumed_at 单独标记（docs/32 D3）。
		_, _ = s.db.Exec(ctx, `UPDATE agent_delegation_group SET state='completed', updated_at=now()
			WHERE id=$1 AND state IN ('active','waiting_user')`, groupID)
	}
}

// ai27ResolveModelRef 按 workspace+模型名解析出 agentModelRef（tools_ok 的 server 模型）。
// 空名或找不到时返回零值（由 agentResolveModel 报 unsupported）。
func (s *Server) ai27ResolveModelRef(ctx context.Context, workspaceID uuid.UUID, modelName string) agentModelRef {
	if strings.TrimSpace(modelName) == "" {
		return agentModelRef{}
	}
	var providerID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT m.provider_id FROM model_capability m
		JOIN model_provider p ON p.id=m.provider_id
		WHERE m.workspace_id=$1 AND p.workspace_id=$1 AND p.execution_location='server'
		  AND p.status='active' AND m.tools_ok AND m.model=$2
		ORDER BY p.created_at LIMIT 1`, workspaceID, modelName).Scan(&providerID)
	if err != nil {
		return agentModelRef{}
	}
	return agentModelRef{ProviderID: providerID, Model: modelName}
}
