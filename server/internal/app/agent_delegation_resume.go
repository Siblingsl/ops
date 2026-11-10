package app

// DEV-A13（W06 父 run 续接，docs/32 v1.0）：组等待态、任务级预算账本、承接事务、重启 sweep。
// 设计约束（27 §11.3.3）：不得因"子任务完成"自动新建付费 run；只有用户触发的 run 与
// goal 恢复可以承接同一委派组与剩余预算；承接只消费一次子结果；单活动 run 约束不放松
// （Phase A：组内仍有子任务在跑时返回 409 delegation_children_running）。

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// delegationTaskRoundsLimit 是任务级轮次池上限：按 27 §11.3.3 的"每子最多 4 轮"×
// 累计委派上限 4 + 父汇总 2 轮推导，且不低于单次 run 的 agentMaxRounds。
// 直接取 agentMaxRounds(12) 无法覆盖 4 个子任务的预留（16+2），属规格内部不一致，此处按
// 推导值取 18 并在 docs/32 勘误与 docs/08 实施记录中注明。
func delegationTaskRoundsLimit() int {
	derived := delegationMaxTotal*delegationBudgetPerTask + delegationBudgetParentRounds
	if derived < agentMaxRounds {
		return agentMaxRounds
	}
	return derived
}

type delegationBudgetView struct {
	BudgetScopeID    string `json:"budget_scope_id"`
	RoundsLimit      int    `json:"rounds_limit"`
	RoundsReserved   int    `json:"rounds_reserved"`
	RoundsUsed       int    `json:"rounds_used"`
	RoundsRemaining  int    `json:"rounds_remaining"`
	SecondsLimit     int    `json:"seconds_limit"`
	SecondsReserved  int    `json:"seconds_reserved"`
	SecondsUsed      int    `json:"seconds_used"`
	SecondsRemaining int    `json:"seconds_remaining"`
	TokensLimit      *int   `json:"tokens_limit,omitempty"`
	TokensUsed       int    `json:"tokens_used"`
	Revision         int64  `json:"revision"`
}

// createDelegationTaskBudgetTx 在创组事务内创建任务池并预留本批子任务的轮数/时长。
// 额度只在这里定一次；承接 run 只读剩余、不重复领取（docs/32 D5）。
func createDelegationTaskBudgetTx(ctx context.Context, tx pgx.Tx, conversationID, rootRunID uuid.UUID,
	childCount int, tokensLimit *int) (uuid.UUID, error) {
	scopeID := uuid.New()
	roundsReserved := childCount * delegationBudgetPerTask
	secondsReserved := childCount * delegationBudgetPerTaskSeconds
	if _, err := tx.Exec(ctx, `INSERT INTO agent_task_budget
		(budget_scope_id, conversation_id, root_run_id, rounds_limit, rounds_reserved,
		 seconds_limit, seconds_reserved, tokens_limit)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		scopeID, conversationID, rootRunID, delegationTaskRoundsLimit(), roundsReserved,
		delegationTaskSecondsLimit, secondsReserved, tokensLimit); err != nil {
		return uuid.Nil, err
	}
	return scopeID, nil
}

// reserveTaskBudgetTx 预留额度；行锁内校验 used+reserved+n ≤ limit，超限返回 429。
func reserveTaskBudgetTx(ctx context.Context, tx pgx.Tx, scopeID uuid.UUID, rounds, seconds int) error {
	var usedR, reservedR, limitR, usedS, reservedS, limitS int
	if err := tx.QueryRow(ctx, `SELECT rounds_used, rounds_reserved, rounds_limit,
		seconds_used, seconds_reserved, seconds_limit
		FROM agent_task_budget WHERE budget_scope_id=$1 FOR UPDATE`, scopeID).
		Scan(&usedR, &reservedR, &limitR, &usedS, &reservedS, &limitS); err != nil {
		return err
	}
	if usedR+reservedR+rounds > limitR || usedS+reservedS+seconds > limitS {
		return apiErr(429, "delegation_budget_exceeded", "任务预算不足以承接剩余子任务，请先提高预算")
	}
	_, err := tx.Exec(ctx, `UPDATE agent_task_budget
		SET rounds_reserved=rounds_reserved+$2, seconds_reserved=seconds_reserved+$3,
		    revision=revision+1, updated_at=now()
		WHERE budget_scope_id=$1`, scopeID, rounds, seconds)
	return err
}

// settleTaskBudgetTx 结算：先释放预留，再把实际用量计入 used，且不超过剩余额度。
// 顺序与上限保证 rounds_used+rounds_reserved ≤ rounds_limit 的不变量始终成立。
func settleTaskBudgetTx(ctx context.Context, tx pgx.Tx, scopeID uuid.UUID,
	roundsUsed, secondsUsed, tokensUsed, releaseRounds, releaseSeconds int) error {
	var usedR, reservedR, limitR, usedS, reservedS, limitS, tokensUsedDB int
	var tokensLimit *int
	if err := tx.QueryRow(ctx, `SELECT rounds_used, rounds_reserved, rounds_limit,
		seconds_used, seconds_reserved, seconds_limit, tokens_used, tokens_limit
		FROM agent_task_budget WHERE budget_scope_id=$1 FOR UPDATE`, scopeID).
		Scan(&usedR, &reservedR, &limitR, &usedS, &reservedS, &limitS, &tokensUsedDB, &tokensLimit); err != nil {
		return err
	}
	newReservedR := reservedR - releaseRounds
	if newReservedR < 0 {
		newReservedR = 0
	}
	newReservedS := reservedS - releaseSeconds
	if newReservedS < 0 {
		newReservedS = 0
	}
	capacityR := limitR - usedR - newReservedR
	if capacityR < 0 {
		capacityR = 0
	}
	useR := roundsUsed
	if useR > capacityR {
		useR = capacityR
	}
	if useR < 0 {
		useR = 0
	}
	capacityS := limitS - usedS - newReservedS
	if capacityS < 0 {
		capacityS = 0
	}
	useS := secondsUsed
	if useS > capacityS {
		useS = capacityS
	}
	if useS < 0 {
		useS = 0
	}
	newTokens := tokensUsedDB + tokensUsed
	if tokensLimit != nil && newTokens > *tokensLimit {
		newTokens = *tokensLimit
	}
	_, err := tx.Exec(ctx, `UPDATE agent_task_budget
		SET rounds_used=rounds_used+$2, rounds_reserved=$3,
		    seconds_used=seconds_used+$4, seconds_reserved=$5,
		    tokens_used=$6, revision=revision+1, updated_at=now()
		WHERE budget_scope_id=$1`, scopeID, useR, newReservedR, useS, newReservedS, newTokens)
	return err
}

// markDelegationParentEndedTx 记录"父 run 已结束"并写等待态：
// 组仍有未终态子任务且组为 active → waiting_user；否则只写 parent_ended_at。
// 事件 delegation.group_waiting_user 只在状态真正迁移时追加。
func (s *Server) markDelegationParentEndedTx(ctx context.Context, tx pgx.Tx, conversationID, parentRunID uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT g.id, g.state,
		(SELECT count(*) FROM agent_delegation d WHERE d.group_id=g.id
		 AND d.state IN ('queued','running','cancelling')) AS unfinished
		FROM agent_delegation_group g
		WHERE g.conversation_id=$1 AND g.current_parent_run_id=$2
		  AND g.state IN ('active','waiting_user','completed') FOR UPDATE`, conversationID, parentRunID)
	if err != nil {
		return err
	}
	type groupWait struct {
		id         uuid.UUID
		state      string
		unfinished int
	}
	items := []groupWait{}
	for rows.Next() {
		var item groupWait
		if err := rows.Scan(&item.id, &item.state, &item.unfinished); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		next := item.state
		if item.state == "active" && item.unfinished > 0 {
			next = "waiting_user"
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_delegation_group SET
			parent_ended_at=COALESCE(parent_ended_at, now()),
			parent_end_run_id=COALESCE(parent_end_run_id, $2),
			state=$3, revision=revision+1, updated_at=now()
			WHERE id=$1`, item.id, parentRunID, next); err != nil {
			return err
		}
		if next != item.state {
			if _, err := appendAgentEventTx(ctx, tx, conversationID, &parentRunID, "delegation.group_waiting_user",
				map[string]any{"group_id": item.id, "unfinished_count": item.unfinished}, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

type delegationAdoption struct {
	GroupID         uuid.UUID
	RootRunID       uuid.UUID
	ParentRunID     uuid.UUID
	BudgetScopeID   uuid.UUID
	ResultsConsumed bool
	Summary         string
	ChildCount      int
}

// delegationAdoptionTrigger 限定可承接的触发来源（docs/32 D1）：
// 用户触发的 message/continue/edit/answer 与 goal 恢复；routine/compact 一律不承接。
func delegationAdoptionTrigger(trigger string) bool {
	switch trigger {
	case "message", "continue", "edit", "answer", "goal":
		return true
	}
	return false
}

// adoptionCandidateTx 在创建 run 的同一事务内认领待承接组。
// 组必须已有 parent_ended_at（父 run 已结束），且没有被别的 run 承接；
// Phase A 下组内仍有 queued/running/cancelling 子任务时返回 409。
func (s *Server) adoptionCandidateTx(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, trigger string) (*delegationAdoption, error) {
	if !agentWorkbenchFeatures()["subagents"] || !delegationAdoptionTrigger(trigger) {
		return nil, nil
	}
	var item delegationAdoption
	var consumed *time.Time
	err := tx.QueryRow(ctx, `SELECT id, root_run_id, current_parent_run_id, budget_scope_id, results_consumed_at
		FROM agent_delegation_group
		WHERE conversation_id=$1 AND state IN ('active','waiting_user','completed')
		  AND adopted_run_id IS NULL AND parent_ended_at IS NOT NULL
		ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`, conversationID).
		Scan(&item.GroupID, &item.RootRunID, &item.ParentRunID, &item.BudgetScopeID, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var unfinished int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_delegation
		WHERE group_id=$1 AND state IN ('queued','running','cancelling')`, item.GroupID).Scan(&unfinished); err != nil {
		return nil, err
	}
	if unfinished > 0 {
		return nil, apiErr(409, "delegation_children_running",
			fmt.Sprintf("还有 %d 个子任务在运行，请等待完成后再继续", unfinished))
	}
	item.ResultsConsumed = consumed != nil
	rows, err := tx.Query(ctx, `SELECT state, task, result_summary,
		COALESCE(result_artifact_id::text,''), error_code
		FROM agent_delegation WHERE group_id=$1 ORDER BY created_at LIMIT 4`, item.GroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []delegationSummaryEntry{}
	for rows.Next() {
		var entry delegationSummaryEntry
		if err := rows.Scan(&entry.State, &entry.Task, &entry.Summary, &entry.ArtifactID, &entry.ErrorCode); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	item.ChildCount = len(entries)
	item.Summary = buildDelegationSummary(entries)
	return &item, nil
}

type delegationSummaryEntry struct {
	State      string
	Task       string
	Summary    string
	ArtifactID string
	ErrorCode  string
}

// buildDelegationSummary 生成注入承接 run 的结构化摘要（≤6000 字符）。
// 子结果一律标注为"未经父级复核"，不得提升为系统指令或业务写入依据。
func buildDelegationSummary(entries []delegationSummaryEntry) string {
	var b strings.Builder
	b.WriteString("上一轮子任务结果摘要（系统生成；子结果未经父级复核，不得直接作为业务写入依据）：\n")
	for i, entry := range entries {
		fmt.Fprintf(&b, "%d. [%s] %s\n", i+1, entry.State, truncate(strings.TrimSpace(entry.Task), 200))
		if summary := strings.TrimSpace(entry.Summary); summary != "" {
			fmt.Fprintf(&b, "   结果：%s\n", summary)
		}
		if entry.ArtifactID != "" {
			fmt.Fprintf(&b, "   产物：%s\n", entry.ArtifactID)
		}
		if entry.ErrorCode != "" {
			fmt.Fprintf(&b, "   错误码：%s\n", entry.ErrorCode)
		}
	}
	if len(entries) == 0 {
		b.WriteString("（没有可用的子任务结果）\n")
	}
	return truncate(b.String(), 6000)
}

// applyAdoptionTx 把新 run 认领到组上：写归属列、组承接标记、父汇总预留、注入摘要、一次性消费。
func (s *Server) applyAdoptionTx(ctx context.Context, tx pgx.Tx, st *agentRunState, adopted *delegationAdoption) error {
	if _, err := tx.Exec(ctx, `UPDATE agent_run SET root_run_id=$2, parent_run_id=$3, delegation_group_id=$4
		WHERE id=$1`, st.RunID, adopted.RootRunID, adopted.ParentRunID, adopted.GroupID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_delegation_group SET
		adopted_run_id=$2, adopted_at=now(), adoption_count=adoption_count+1,
		current_parent_run_id=$2, revision=revision+1, updated_at=now()
		WHERE id=$1`, adopted.GroupID, st.RunID); err != nil {
		return err
	}
	st.DelegationGroupID = &adopted.GroupID
	payload := map[string]any{
		"group_id": adopted.GroupID, "run_id": st.RunID,
		"child_count": adopted.ChildCount, "already_consumed": adopted.ResultsConsumed,
	}
	if adopted.ResultsConsumed {
		// 已消费：仍允许普通对话，但不再注入子结果（幂等分支，docs/32 §8.3）。
		_, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "delegation.group_adopted", payload, nil)
		return err
	}
	if err := reserveTaskBudgetTx(ctx, tx, adopted.BudgetScopeID,
		delegationBudgetParentRounds, delegationBudgetParentSeconds); err != nil {
		return err
	}
	if _, err := s.agentInsertMessageTx(ctx, tx, st, "system_note", adopted.Summary, nil, "", "", nil, nil); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_delegation_group
		SET results_consumed_at=now(), consumed_by_run_id=$2, revision=revision+1, updated_at=now()
		WHERE id=$1`, adopted.GroupID, st.RunID); err != nil {
		return err
	}
	st.DelegationAdopted = true
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "delegation.group_adopted", payload, nil); err != nil {
		return err
	}
	return nil
}

// adoptDelegationGroupDryRun 仅做承接前置校验（用于在 agentCheckRunLimitsWith 之前返回
// 更具体的 409 delegation_children_running，而不是笼统的 agent_run_busy）。
func (s *Server) checkDelegationAdoptionReady(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, trigger string) error {
	if !agentWorkbenchFeatures()["subagents"] || !delegationAdoptionTrigger(trigger) {
		return nil
	}
	var groupID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM agent_delegation_group
		WHERE conversation_id=$1 AND state IN ('active','waiting_user','completed')
		  AND adopted_run_id IS NULL AND parent_ended_at IS NOT NULL
		ORDER BY updated_at DESC LIMIT 1`, conversationID).Scan(&groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var unfinished int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_delegation
		WHERE group_id=$1 AND state IN ('queued','running','cancelling')`, groupID).Scan(&unfinished); err != nil {
		return err
	}
	if unfinished > 0 {
		return apiErr(409, "delegation_children_running",
			fmt.Sprintf("还有 %d 个子任务在运行，请等待完成后再继续", unfinished))
	}
	return nil
}

// reconcileDelegationTerminal 对账"子 run 已终态但委派行仍在 running/cancelling"的情况
// （进程重启、watcher 丢失、派发后异常）。状态迁移本身是幂等闸门：只有非终态行会结算预算。
func (s *Server) reconcileDelegationTerminal(ctx context.Context, delegationID uuid.UUID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var groupID uuid.UUID
	var childRunID *uuid.UUID
	var state string
	if err := tx.QueryRow(ctx, `SELECT group_id, child_run_id, state FROM agent_delegation
		WHERE id=$1 FOR UPDATE`, delegationID).Scan(&groupID, &childRunID, &state); err != nil {
		return err
	}
	if state != "running" && state != "cancelling" && state != "queued" {
		return nil
	}
	if childRunID == nil {
		return nil
	}
	var runStatus string
	var rounds, promptTokens, completionTokens, seconds int
	if err := tx.QueryRow(ctx, `SELECT status, rounds, prompt_tokens, completion_tokens,
		GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::int)
		FROM agent_run WHERE id=$1`, *childRunID).
		Scan(&runStatus, &rounds, &promptTokens, &completionTokens, &seconds); err != nil {
		return err
	}
	if runStatus != "completed" && runStatus != "failed" && runStatus != "stopped" {
		return nil
	}
	nextState := "succeeded"
	errorCode := ""
	if runStatus != "completed" {
		nextState = "failed"
		errorCode = "child_run_" + runStatus
	}
	summary := ""
	if nextState == "succeeded" {
		_ = tx.QueryRow(ctx, `SELECT content FROM agent_message
			WHERE run_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1`, *childRunID).Scan(&summary)
		summary = truncate(strings.TrimSpace(summary), 500)
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_delegation SET state=$2,
		result_summary=CASE WHEN $3<>'' THEN $3 ELSE result_summary END,
		error_code=$4, updated_at=now() WHERE id=$1`,
		delegationID, nextState, summary, errorCode); err != nil {
		return err
	}
	var scopeID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1`, groupID).Scan(&scopeID); err != nil {
		return err
	}
	if err := settleTaskBudgetTx(ctx, tx, scopeID, rounds, seconds, promptTokens+completionTokens,
		delegationBudgetPerTask, delegationBudgetPerTaskSeconds); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, conversationIDOfGroupTx(ctx, tx, groupID), nil, "delegation.state_changed",
		map[string]any{"delegation_id": delegationID, "state": nextState}, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.touchDelegationGroupOnChildDone(ctx, delegationID)
	return nil
}

// conversationIDOfGroupTx 读取组所属会话（事件必须有会话）。
func conversationIDOfGroupTx(ctx context.Context, tx pgx.Tx, groupID uuid.UUID) uuid.UUID {
	var conversationID uuid.UUID
	_ = tx.QueryRow(ctx, `SELECT conversation_id FROM agent_delegation_group WHERE id=$1`, groupID).Scan(&conversationID)
	return conversationID
}

// settleDelegationGroupCancelTx 整组取消时结算未终态子任务：按已发生实际用量计入 used，
// 释放各自的 4 轮/180 秒预留（docs/32 §7.2 末条）。
func settleDelegationGroupCancelTx(ctx context.Context, tx pgx.Tx, groupID uuid.UUID) error {
	var scopeID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1`, groupID).Scan(&scopeID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, child_run_id FROM agent_delegation
		WHERE group_id=$1 AND state IN ('queued','running','waiting_user','cancelling') FOR UPDATE`, groupID)
	if err != nil {
		return err
	}
	type pending struct {
		id         uuid.UUID
		childRunID *uuid.UUID
	}
	items := []pending{}
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.childRunID); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	rows.Close()
	for _, item := range items {
		rounds, seconds, tokens := 0, 0, 0
		if item.childRunID != nil {
			_ = tx.QueryRow(ctx, `SELECT rounds, GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::int),
				prompt_tokens+completion_tokens FROM agent_run WHERE id=$1`, *item.childRunID).
				Scan(&rounds, &seconds, &tokens)
		}
		if err := settleTaskBudgetTx(ctx, tx, scopeID, rounds, seconds, tokens,
			delegationBudgetPerTask, delegationBudgetPerTaskSeconds); err != nil {
			return err
		}
	}
	return nil
}

// sweepDelegationGroups 幂等恢复：对账子 run 终态、补齐组 completed、释放失败承接。
// 不创建任何 run，不重放工具（27 §11.3.3 / T-AI27-S08）。
func (s *Server) sweepDelegationGroups(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT d.id FROM agent_delegation d
		JOIN agent_run r ON r.id=d.child_run_id
		WHERE d.state IN ('running','cancelling','queued')
		  AND r.status IN ('completed','failed','stopped') LIMIT 200`)
	if err != nil {
		return
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		// 逐条独立：单条失败只记录，下轮 sweep 重试（docs/32 §9 第 5 条）。
		_ = s.reconcileDelegationTerminal(ctx, id)
	}
	s.expireStaleQueuedDelegations(ctx)
	// 组内全部子任务终态：active → completed（waiting_user 表示"父已结束、结果待承接"，保持不变，
	// 承接后再由 applyAdoptionTx 消费）。
	if _, err := s.db.Exec(ctx, `UPDATE agent_delegation_group g SET state='completed', updated_at=now()
		WHERE g.state='active' AND NOT EXISTS (
			SELECT 1 FROM agent_delegation d WHERE d.group_id=g.id
			  AND d.state NOT IN ('succeeded','failed','cancelled','expired'))`); err != nil {
		return
	}
	// 承接 run 失败/停止且子结果未消费：释放 adopted_run_id，允许下次承接。
	rows, err = s.db.Query(ctx, `SELECT g.id, g.conversation_id FROM agent_delegation_group g
		JOIN agent_run r ON r.id=g.adopted_run_id
		WHERE g.adopted_run_id IS NOT NULL AND g.results_consumed_at IS NULL
		  AND r.status IN ('failed','stopped') LIMIT 100`)
	if err != nil {
		return
	}
	type releaseItem struct {
		groupID        uuid.UUID
		conversationID uuid.UUID
	}
	releases := []releaseItem{}
	for rows.Next() {
		var item releaseItem
		if err := rows.Scan(&item.groupID, &item.conversationID); err != nil {
			rows.Close()
			return
		}
		releases = append(releases, item)
	}
	rows.Close()
	for _, item := range releases {
		if _, err := s.db.Exec(ctx, `UPDATE agent_delegation_group
			SET adopted_run_id=NULL, adopted_at=NULL, revision=revision+1, updated_at=now()
			WHERE id=$1 AND adopted_run_id IS NOT NULL AND results_consumed_at IS NULL`, item.groupID); err != nil {
			continue
		}
		_, _ = s.appendAgentEvent(ctx, item.conversationID, nil, "delegation.adoption_released",
			map[string]any{"group_id": item.groupID})
	}
}

// dispatchPendingDelegationsOfParent 是委派派发的生产入口：父 run 交出活动位后，
// 把它创建但从未派发的子任务真正跑起来（W15b 的 dispatchDelegationGroup 原先只有测试调用）。
// 只在父 run 终态后调用，避免与父 run 的单活动位冲突、也避免把父 run 状态改成 awaiting_confirmation。
func (s *Server) dispatchPendingDelegationsOfParent(ctx context.Context, parentRunID uuid.UUID) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT g.id FROM agent_delegation_group g
		JOIN agent_delegation d ON d.group_id=g.id
		WHERE g.current_parent_run_id=$1 AND d.state='queued' AND d.child_run_id IS NULL
		LIMIT 20`, parentRunID)
	if err != nil {
		return
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return
		}
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		s.dispatchDelegationGroup(ctx, id)
	}
}

// expireStaleQueuedDelegations 收口"排队但从未创建子 run"的委派（派发失败、进程中断）。
// 不做的话：组永远停在 active、quota_reserved 永不归还，后续用户消息会被
// 409 delegation_children_running 永久挡住（docs/32 §9 幂等恢复的缺失分支）。
// 只在父 run 已交出活动位后判定，避免误杀"父 run 仍在跑、子任务尚未派发"的正常排队。
func (s *Server) expireStaleQueuedDelegations(ctx context.Context) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT d.id, d.group_id, g.budget_scope_id, g.conversation_id
		FROM agent_delegation d JOIN agent_delegation_group g ON g.id=d.group_id
		JOIN agent_run pr ON pr.id=g.current_parent_run_id
		WHERE d.state='queued' AND d.child_run_id IS NULL
		  AND pr.status NOT IN ('queued','running')
		  AND d.created_at < now() - interval '90 seconds'
		LIMIT 100 FOR UPDATE OF d SKIP LOCKED`)
	if err != nil {
		return
	}
	type staleItem struct {
		delegationID   uuid.UUID
		groupID        uuid.UUID
		scopeID        uuid.UUID
		conversationID uuid.UUID
	}
	items := []staleItem{}
	for rows.Next() {
		var item staleItem
		if err := rows.Scan(&item.delegationID, &item.groupID, &item.scopeID, &item.conversationID); err != nil {
			rows.Close()
			return
		}
		items = append(items, item)
	}
	rows.Close()
	if len(items) == 0 {
		return
	}
	for _, item := range items {
		tag, err := tx.Exec(ctx, `UPDATE agent_delegation
			SET state='expired', error_code='dispatch_failed', updated_at=now()
			WHERE id=$1 AND state='queued' AND child_run_id IS NULL`, item.delegationID)
		if err != nil || tag.RowsAffected() == 0 {
			continue
		}
		if err := settleTaskBudgetTx(ctx, tx, item.scopeID, 0, 0, 0,
			delegationBudgetPerTask, delegationBudgetPerTaskSeconds); err != nil {
			continue
		}
		if _, err := appendAgentEventTx(ctx, tx, item.conversationID, nil, "delegation.state_changed",
			map[string]any{"delegation_id": item.delegationID, "state": "expired"}, nil); err != nil {
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	// 过期后组可能已无未终态子任务：交给下一轮 sweep 的 active → completed 收口。
	for _, item := range items {
		s.touchDelegationGroupOnChildDone(ctx, item.delegationID)
	}
}

// GET /agent/delegation-groups/{id}：组详情 + 子任务 + 预算（本人/本工作区）。
func (s *Server) getDelegationGroup(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_delegation_group
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3)`, groupID, id.UserID, id.WorkspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	var view delegationGroupView
	if err := s.loadDelegationGroup(r.Context(), groupID, &view); err != nil {
		return errNotFound
	}
	return ok(w, view)
}

// POST /agent/delegation-groups/{id}/adopt：显式"汇总子任务结果"（docs/32 Q3，已批准）。
// 创建 trigger=continue 的普通 run；run 创建事务内完成承接与摘要注入，仍受单活动 run 约束。
func (s *Server) adoptDelegationGroup(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(ctx, "subagents"); err != nil {
		return err
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var conversationID uuid.UUID
	var consumed *time.Time
	var adoptedRunID *uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT conversation_id, results_consumed_at, adopted_run_id
		FROM agent_delegation_group WHERE id=$1 AND user_id=$2 AND workspace_id=$3`,
		groupID, id.UserID, id.WorkspaceID).Scan(&conversationID, &consumed, &adoptedRunID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if consumed != nil {
		return apiErr(409, "delegation_results_consumed", "这组子任务结果已被汇总过，不重复计费")
	}
	if adoptedRunID != nil {
		return apiErr(409, "delegation_children_running", "已有运行在承接这组子任务，请刷新后重试")
	}
	conv, err := s.agentConversationFor(ctx, conversationID)
	if err != nil {
		return err
	}
	prepared, err := s.agentPrepareRun(ctx, conv, conv, "continue", nil,
		func(pgx.Tx, *agentConversation) (*uuid.UUID, bool, error) { return nil, false, nil })
	if err != nil {
		return err
	}
	if prepared.Replayed || prepared.State == nil {
		return ok(w, map[string]any{"status": "replayed", "run_id": prepared.State.RunID})
	}
	st := prepared.State
	if err := s.startAgentRunBackground(ctx, st); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"run_id": st.RunID, "conversation_id": conversationID, "group_id": groupID,
		"adopted": st.DelegationAdopted,
	})
}

// maxRounds 返回本次运行的轮次上限：子 run 取 4 轮，其余沿用 agentMaxRounds。
func (st *agentRunState) maxRounds() int {
	if st.RoundsLimit > 0 {
		return st.RoundsLimit
	}
	return agentMaxRounds
}

// finishDelegationTx 在 run 终态事务内处理委派账：
// - 非子 run：记录父 run 已结束（必要时转 waiting_user）；
// - 承接 run：结算父汇总预留（2 轮/120 秒），实际用量不超过剩余额度。
// 子 run 的预算结算由 reconcileDelegationTerminal 完成（状态迁移即幂等闸门）。
func (s *Server) finishDelegationTx(ctx context.Context, tx pgx.Tx, st *agentRunState) error {
	if st.ExecutionOrigin == "delegation" {
		return nil
	}
	if err := s.markDelegationParentEndedTx(ctx, tx, st.ConversationID, st.RunID); err != nil {
		return err
	}
	if st.DelegationGroupID == nil || !st.DelegationAdopted {
		return nil
	}
	var scopeID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT budget_scope_id FROM agent_delegation_group WHERE id=$1`,
		*st.DelegationGroupID).Scan(&scopeID); err != nil {
		return err
	}
	seconds := 0
	if !st.StartedAt.IsZero() {
		seconds = int(time.Since(st.StartedAt).Seconds())
	}
	return settleTaskBudgetTx(ctx, tx, scopeID, st.Rounds, seconds,
		st.PromptTokens+st.CompletionTokens, delegationBudgetParentRounds, delegationBudgetParentSeconds)
}
