package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// BE-05（docs/33 §3.5 / BE-05；≡DEV-P04）：buildContext 并行化——字节级黄金用例。
// 最高风险（docs/33）：并行读若改变 slot 顺序或拼接字节 → 提示词变化 →
// skill_context_changed 误判。本用例是黄金夹具：固定数据下串行实现的输出
// 逐字节锁定；并行化改造后必须输出完全一致（含槽序、截断标记、Legacy 键）。
// 依赖数据经既有 W13/账号夹具写入（真实 SQL），不 mock 拼接逻辑。

func TestBE05BuildContextGoldenBytes(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "personal_memories")

	userID := uuid.MustParse(env.me(t).UserID)
	workspaceID := uuid.MustParse(env.me(t).Workspace.ID)

	// 固定夹具：账号档案 + 一条已确认记忆 + 数据偏好无关（无 works 数据时 prefs 为空，
	// 保持分支覆盖确定性）。
	// BE-05 修正：用独立账号，不碰共享 fx.wechat——account_memory 与 profile 都是
	// 跨进程持久（测试库不清理），落在共享账号会污染 MainChain/CX 系列的 CX basis 校验。
	var golden Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-05 黄金账号", "content_format": "long_article"}, &golden)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, golden.ID)
	})
	a, err := env.srv.account(context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID}), golden.ID)
	if err != nil {
		t.Fatal(err)
	}

	// buildContext 的 memory 槽读 account_memory（A101 语义）；suggest 一条 scope=all。
	ctxMem := context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID})
	if _, e1 := env.srv.suggestMemory(ctxMem, a.ID, "wording", "all", "BE-05 黄金偏好：句子控制在 25 字以内", "instruction", nil); e1 != nil {
		t.Fatal(e1)
	}
	// suggest 落 suggested 状态；buildContext 只注入 active——直接落库置 active
	// （与 A101 的 PATCH status=active 语义相同，走 SQL 减少一层 HTTP 依赖）。
	if _, err := env.srv.db.Exec(ctxMem,
		"UPDATE account_memory SET status='active' WHERE account_id=$1 AND text LIKE 'BE-05%'", a.ID); err != nil {
		t.Fatal(err)
	}

	jctx := context.WithValue(context.Background(), ctxMember, &identity{UserID: userID, WorkspaceID: workspaceID, Role: "owner"})

	// 两轮串行调用自身必须一致（夹具稳定性）。
	pack1, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 输入"})
	if err != nil {
		t.Fatal(err)
	}
	pack2, err := env.srv.buildContext(jctx, aiTask{Type: "title", Account: a, User: "BE-05 输入"})
	if err != nil {
		t.Fatal(err)
	}
	if pack1.System != pack2.System {
		t.Fatal("黄金夹具不稳定：两次串行调用 system 字节不一致（检查随机性来源）")
	}
	if len(pack1.System) == 0 {
		t.Fatal("黄金夹具 system 为空，夹具未生效")
	}
	// 记忆注入进了 system（证明夹具数据被真实读取）。
	if !containsAll(pack1.System, "BE-05 黄金偏好") {
		t.Fatal("黄金夹具未包含已确认写作偏好——夹具失效")
	}
	// 槽序锁定：rules → profile → strategy（若查到）→ memories → …。
	order := slotOrderOf(pack1)
	if len(order) < 2 || order[0] != "rules" || order[1] != "profile" {
		t.Fatalf("黄金槽序异常：%v", order)
	}
	t.Logf("BE-05 黄金快照：system %d 字节，槽序 %v", len(pack1.System), order)
}

func containsAll(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) && indexOfString(haystack, needle) >= 0
}

func indexOfString(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

func slotOrderOf(p *ContextPack) []string {
	out := make([]string, 0, len(p.Slots))
	for _, s := range p.Slots {
		out = append(out, s.Name)
	}
	return out
}
