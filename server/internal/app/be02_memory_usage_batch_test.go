package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5 / BE-02；≡DEV-P01 子集）：记忆用量写入不再静默失败。
// 修复前：personalMemorySystemBlock 对 agent_memory_usage 的两段 for 逐条
// `_, _ = s.db.Exec(...)`——部分写入失败（连接断开/约束冲突）完全不可见，
// 上下文页「本次实际使用项」与审计缺失数据却无任何日志。
// 修复后：合并为两条多值 INSERT（每类一条），错误经 slog 记录（含 run_id 与条数），
// 不中断注入主流程（记账失败不阻断业务语义，与既有「注入失败返回空串」同级降级）。
// 本文件验证：正常写入条数与 used/omitted 划分不变（行为回归）+ 错误路径可观测。

func be01InsertActiveMemory(t *testing.T, userID, workspaceID, text string) uuid.UUID {
	t.Helper()
	hash := personalMemoryHash(text)
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO agent_personal_memory (id, workspace_id, user_id, text, state, content_hash)
		 VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
		uuid.New(), mustParse(t, workspaceID), mustParse(t, userID), text, hash).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func mustParse(t *testing.T, s string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func be01UsageCount(t *testing.T, memoryID uuid.UUID, used bool) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_memory_usage WHERE memory_id=$1 AND used=$2`,
		memoryID, used).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestBE02MemoryUsageBatchWritePreservesUsedOmittedSplit：多记忆场景下 used 与
// omitted（预算省略）的记账条数与修复前逐条写入一致——批量合并不改记账语义。
func TestBE02MemoryUsageBatchWritePreservesUsedOmittedSplit(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)

	// 两条短记忆（进 used）+ 一条超预算长记忆（进 omitted）。
	const shortA = "BE-02 用例短记忆 A：结果先给摘要"
	const shortB = "BE-02 用例短记忆 B：列表默认按更新时间排序"
	longText := "BE-02 超预算省略：" + repeatRune("很长", 1200)
	idA := be01InsertActiveMemory(t, userID.String(), workspaceID.String(), shortA)
	idB := be01InsertActiveMemory(t, userID.String(), workspaceID.String(), shortB)
	idLong := be01InsertActiveMemory(t, userID.String(), workspaceID.String(), longText)
	t.Cleanup(func() {
		for _, id := range []uuid.UUID{idA, idB, idLong} {
			_, _ = env.srv.db.Exec(context.Background(),
				`DELETE FROM agent_personal_memory WHERE id=$1`, id)
		}
	})

	runID := uuid.New()
	_ = env.srv.personalMemorySystemBlock(context.Background(), userID, workspaceID, uuid.New(), runID)

	if got := be01UsageCount(t, idA, true) + be01UsageCount(t, idB, true); got != 2 {
		t.Fatalf("两条短记忆应记账 used=true 各一条，实际 %d", got)
	}
	if got := be01UsageCount(t, idLong, false); got != 1 {
		t.Fatalf("超预算记忆应记账 used=false（omitted_reason 非空）一条，实际 %d", got)
	}
}

func repeatRune(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
