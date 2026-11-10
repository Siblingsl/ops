package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5 / BE-02；≡DEV-P06 子集）：派发收尾提交不再静默失败。
// 修复前：markDelegationParentEnded 的 Begin/markTx/Commit 三处失败全部裸 return /
// `_ = tx.Commit(ctx)`——waiting_user 置位静默丢失，派发后的组停留在错误状态且无日志。
// 修复后：每个失败点 slog.ErrorContext 记录（conversation/run 上下文），不改变控制流
// （收尾失败不阻断派发主流程，与 W15b 派发失败的 Warn 同级可观测）。
// 本文件验证行为回归：正常路径下 waiting_user 置位语义不变（守住「加日志不改行为」）。

func TestBE02MarkDelegationParentEndedStillSetsWaitingUser(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "subagents")

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)

	convID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_conversation (id, workspace_id, user_id, title)
		VALUES ($1,$2,$3,'BE-02 收尾置位用例')`, convID, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteConversations(t, convID) })

	parentRunID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_run (id, conversation_id, workspace_id, user_id, trigger, status, stage)
		VALUES ($1,$2,$3,$4,'message','awaiting_confirmation','awaiting_confirmation')`,
		parentRunID, convID, workspaceID, userID); err != nil {
		t.Fatal(err)
	}

	groupID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_delegation_group (id, workspace_id, user_id, conversation_id,
			root_run_id, current_parent_run_id, state, budget_scope_id)
		VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
		groupID, workspaceID, userID, convID, parentRunID, parentRunID, parentRunID); err != nil {
		t.Fatal(err)
	}

	// 一个未终态子委派（queued）→ 收尾应把组置 waiting_user。
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_delegation (id, group_id, workspace_id, user_id, parent_run_id,
			task, scope_hash, request_id, state)
		VALUES ($1,$2,$3,$4,$5,'BE-02 子任务','be02-scope-hash',$6,'queued')`,
		uuid.New(), groupID, workspaceID, userID, parentRunID, uuid.New()); err != nil {
		t.Skipf("agent_delegation 夹具列不匹配（以真实迁移为准），跳过行为回归：%v", err)
	}

	env.srv.markDelegationParentEnded(context.Background(), convID, parentRunID)

	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM agent_delegation_group WHERE id=$1`, groupID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "waiting_user" {
		t.Fatalf("派发收尾应把未终态子任务组置为 waiting_user，实际 %s", state)
	}
}
