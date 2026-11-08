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
	var userID uuid.UUID
	var workspaceID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT conversation_id, current_parent_run_id, user_id, workspace_id
		FROM agent_delegation_group WHERE id=$1 AND state='active'`,
		groupID).Scan(&conversationID, &parentRunID, &userID, &workspaceID)
	if err != nil {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT d.id, d.task, d.model
		FROM agent_delegation d WHERE d.group_id=$1 AND d.state='queued' AND d.child_run_id IS NULL
		ORDER BY d.created_at`, groupID)
	if err != nil {
		return
	}
	type pendingItem struct {
		delegationID uuid.UUID
		task         string
		model        string
	}
	items := []pendingItem{}
	for rows.Next() {
		var item pendingItem
		if err := rows.Scan(&item.delegationID, &item.task, &item.model); err != nil {
			rows.Close()
			return
		}
		items = append(items, item)
	}
	rows.Close()
	slog.InfoContext(ctx, "W15b dispatch: 开始派发", "group", groupID.String(), "items", len(items))
	for _, item := range items {
		if err := s.dispatchOneDelegation(ctx, groupID, conversationID, parentRunID, userID, workspaceID, item.delegationID, item.task, item.model); err != nil {
			slog.WarnContext(ctx, "子任务派发失败", "delegation_id", item.delegationID.String(), "err", err)
		}
	}
}

// dispatchOneDelegation 派发单个委派：创建子 run 行并回填，然后后台启动模型循环。
func (s *Server) dispatchOneDelegation(ctx context.Context, groupID, conversationID, parentRunID, userID, workspaceID uuid.UUID,
	delegationID uuid.UUID, task, model string) error {
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
		(id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model)
		VALUES ($1,$2,$3,$4,$5,'message','running','running',$6)`,
		childRunID, conversationID, workspaceID, userID, sessionID, model); err != nil {
		// 父 run 占用活动位：把父置 awaiting_confirmation 后重试一次。
		if _, err2 := s.db.Exec(ctx, `UPDATE agent_run SET status='awaiting_confirmation'
			WHERE id=$1 AND status='running'`, parentRunID); err2 != nil {
			return err
		}
		if _, err2 := s.db.Exec(ctx, `INSERT INTO agent_run
			(id, conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model)
			VALUES ($1,$2,$3,$4,$5,'message','running','running',$6)`,
			childRunID, conversationID, workspaceID, userID, sessionID, model); err2 != nil {
			return err2
		}
	}
	// 回填委派行：child_run_id + state=running。
	if _, err := s.db.Exec(ctx, `UPDATE agent_delegation
		SET child_run_id=$2, state='running', updated_at=now() WHERE id=$1`, delegationID, childRunID); err != nil {
		return err
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

// watchDelegationChild 轮询子 run 终态并回写委派结果（27 §11.3.3：子完成≠父完成）。
func (s *Server) watchDelegationChild(ctx context.Context, delegationID, childRunID uuid.UUID) {
	for {
		var status string
		var stage string
		err := s.db.QueryRow(ctx, `SELECT status, stage FROM agent_run WHERE id=$1`, childRunID).Scan(&status, &stage)
		if err != nil {
			return
		}
		switch status {
		case "completed":
			// 子 run 的最终文本摘要（脱敏由消息层处理）。
			var summary string
			_ = s.db.QueryRow(ctx, `SELECT content FROM agent_message
				WHERE run_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1`, childRunID).Scan(&summary)
			truncated := summary
			if len([]rune(truncated)) > 500 {
				truncated = string([]rune(truncated)[:500]) + "…"
			}
			_, _ = s.db.Exec(ctx, `UPDATE agent_delegation
				SET state='succeeded', result_summary=$2, updated_at=now() WHERE id=$1 AND state='running'`,
				delegationID, truncated)
			s.touchDelegationGroupOnChildDone(ctx, delegationID)
			return
		case "failed", "stopped":
			_, _ = s.db.Exec(ctx, `UPDATE agent_delegation
				SET state='failed', error_code=$2, updated_at=now() WHERE id=$1 AND state='running'`,
				delegationID, "child_run_"+status)
			s.touchDelegationGroupOnChildDone(ctx, delegationID)
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
		_, _ = s.db.Exec(ctx, `UPDATE agent_delegation_group SET state='completed', updated_at=now() WHERE id=$1 AND state='active'`, groupID)
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
