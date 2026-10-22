package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS24 定向测试：适配器版本熔断的恢复流程（20 文档 §12）。
//
// 规范要求："恢复必须发布新 mapping_version 并重新实测"——
// 只翻转状态而不换映射，等于让同一个坏适配器继续写数。

// seedBreaker 直插一条 open 的熔断记录，返回 ID。
func seedBreaker(t *testing.T, platform, adapterVersion string, mappingVersion int) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_adapter_breaker
		(platform, adapter_version, error_code, mapping_version, state, affected_connections)
		VALUES ($1,$2,'platform_schema_changed',$3,'open',2) RETURNING id`,
		platform, adapterVersion, mappingVersion).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_adapter_breaker WHERE id=$1`, id)
	})
	return id
}

func breakerStateOf(t *testing.T, id uuid.UUID) string {
	t.Helper()
	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM platform_adapter_breaker WHERE id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestPlatformBreakerResolveRequiresNewerMapping(t *testing.T) {
	version := "resolve-" + uuid.New().String()[:8]
	id := seedBreaker(t, "xhs", version, 1)

	// 同版本：拒绝。只翻状态不换映射等于什么都没修。
	if _, err := env.srv.resolveAdapterBreaker(context.Background(), id, 1, ""); err == nil {
		t.Fatal("恢复必须要求更高的 mapping_version，同版本应被拒绝")
	}
	// 更低版本：同样拒绝。
	if _, err := env.srv.resolveAdapterBreaker(context.Background(), id, 0, ""); err == nil {
		t.Fatal("更低的 mapping_version 不能用于恢复")
	}
	if got := breakerStateOf(t, id); got != "open" {
		t.Fatalf("被拒绝的恢复不能改变状态，实际 %q", got)
	}

	// 更高版本：允许，并转为 resolved。
	out, err := env.srv.resolveAdapterBreaker(context.Background(), id, 2, "已发布 xhs-2 并重新实测")
	if err != nil {
		t.Fatal(err)
	}
	if out["state"] != "resolved" {
		t.Fatalf("恢复后状态应为 resolved，实际 %v", out["state"])
	}
	if got := breakerStateOf(t, id); got != "resolved" {
		t.Fatalf("库中状态应为 resolved，实际 %q", got)
	}

	// 不能重复恢复。
	if _, err := env.srv.resolveAdapterBreaker(context.Background(), id, 3, ""); err == nil {
		t.Fatal("已恢复的熔断不能重复恢复")
	}
}

func TestPlatformBreakerResolveUnblocksClaimButNotAutoCollect(t *testing.T) {
	version := "resolve-claim-" + uuid.New().String()[:8]
	f := newBreakerFixture(t, "xhs", version)
	f.bindWork(t, "恢复后领取测试", "6f0000000000000000000098")

	// 打开熔断。
	code := "platform_schema_changed"
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}
	if breakerOpen(t, "xhs", version) != true {
		t.Fatal("前置条件失败：应处于熔断状态")
	}

	var breakerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM platform_adapter_breaker
		WHERE platform='xhs' AND adapter_version=$1 AND state='open'`, version).Scan(&breakerID); err != nil {
		t.Fatal(err)
	}

	// 简历一条 queued 任务，确认熔断期间领不到。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, status, query_scope,
		 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
		 browser_version, binding_snapshot, deadline_at)
		VALUES ($1,$2,$3,'manual','collect','queued','{}'::jsonb,1,1,$4,1,'','[]'::jsonb, now() + interval '1 hour')`,
		f.Connection, f.Workspace, f.Account.ID, version); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := f.claimWith(t); ok {
		t.Fatal("熔断期间不应领到任务")
	}

	// 恢复后应能领取（证明熔断确实解除了）。
	if _, err := env.srv.resolveAdapterBreaker(context.Background(), breakerID, 2, "重新实测通过"); err != nil {
		t.Fatal(err)
	}
	if breakerOpen(t, "xhs", version) {
		t.Fatal("恢复后不应再处于熔断状态")
	}
	if _, _, ok := f.claimWith(t); ok {
		t.Fatal("解除熔断不会自动恢复 degraded 连接，必须先用新映射重新验证")
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET availability='ready',
		capabilities=jsonb_set(capabilities,'{mappingVersion}','2'::jsonb),updated_at=now() WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := f.claimWith(t); !ok {
		t.Fatal("新映射重新验证后应能领取任务")
	}

	// 但自动采集不自动重开：那是用户的选择，不能替用户做主。
	var autoCollect bool
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT auto_collect FROM platform_connection WHERE id=$1`, f.Connection).Scan(&autoCollect); err != nil {
		t.Fatal(err)
	}
	if autoCollect {
		t.Fatal("恢复熔断不能自动重开自动采集，必须由用户重新确认")
	}
}
