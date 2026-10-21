package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS21 定向测试：适配器版本级熔断（20 文档 §12、§8.5）。
//
// 规范要求：`platform_schema_changed` 表示页面/响应结构变化，是**适配器版本**的问题，
// 默认对该 `adapter_version + platform` 全局熔断，不只停单连接；熔断期间不派发该版本任务。

// newBreakerFixture 建一个使用**真实能力快照键名（驼峰）**的连接。
// 既有 fixture 用的是下划线键名，与客户端实际提交的形状不一致，
// 会掩盖"服务端读错键导致 adapter_version 恒为空"的缺陷，因此这里单独覆盖。
func newBreakerFixture(t *testing.T, platform, adapterVersion string) *platformRunFixture {
	t.Helper()
	prefix := "xhs_user_id:"
	if platform == "wechat_mp" {
		prefix = "wechat_biz:"
	}
	f := newPlatformRunFixture(t, platform, prefix+"fixture_breaker_"+uuid.New().String()[:8])
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection
		SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"adapterVersion":"`+adapterVersion+`","mappingVersion":1,"detectedAt":"2026-10-21T00:00:00Z"}`)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`DELETE FROM platform_adapter_breaker WHERE adapter_version=$1`, adapterVersion)
	})
	return f
}

// breakerOpen 读熔断状态。
func breakerOpen(t *testing.T, platform, adapterVersion string) bool {
	t.Helper()
	var open bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT EXISTS(
		SELECT 1 FROM platform_adapter_breaker
		WHERE platform=$1 AND adapter_version=$2 AND state='open')`,
		platform, adapterVersion).Scan(&open); err != nil {
		t.Fatal(err)
	}
	return open
}

func TestPlatformAdapterBreakerOnSchemaChanged(t *testing.T) {
	version := "breaker-" + uuid.New().String()[:8]
	f := newBreakerFixture(t, "xhs", version)

	if breakerOpen(t, "xhs", version) {
		t.Fatal("尚未失败就不应处于熔断状态")
	}

	code := "platform_schema_changed"
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, f.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}

	if !breakerOpen(t, "xhs", version) {
		t.Fatal("platform_schema_changed 必须触发版本级熔断")
	}

	var errCode string
	var affected int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT error_code, affected_connections
		FROM platform_adapter_breaker WHERE platform='xhs' AND adapter_version=$1 AND state='open'`,
		version).Scan(&errCode, &affected); err != nil {
		t.Fatal(err)
	}
	if errCode != "platform_schema_changed" {
		t.Fatalf("熔断记录应保留触发错误码，实际 %q", errCode)
	}
	if affected < 1 {
		t.Fatalf("受影响连接数应至少为 1，实际 %d", affected)
	}

	// 触发熔断的连接必须停掉自动采集，避免继续写入错数。
	var autoCollect bool
	var availability string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT auto_collect, availability
		FROM platform_connection WHERE id=$1`, f.Connection).Scan(&autoCollect, &availability); err != nil {
		t.Fatal(err)
	}
	if autoCollect {
		t.Fatal("熔断后该连接不应继续自动采集")
	}
	if availability != "degraded" {
		t.Fatalf("熔断后连接可用性应为 degraded，实际 %q", availability)
	}
}

func TestPlatformAdapterBreakerIsolatesVersionsAndPlatforms(t *testing.T) {
	badVersion := "breaker-bad-" + uuid.New().String()[:8]
	goodVersion := "breaker-good-" + uuid.New().String()[:8]
	bad := newBreakerFixture(t, "xhs", badVersion)
	newBreakerFixture(t, "xhs", goodVersion)
	newBreakerFixture(t, "wechat_mp", badVersion)

	code := "platform_schema_changed"
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.applyRunFailureAction(context.Background(), tx, bad.Connection, &code)
	}); err != nil {
		t.Fatal(err)
	}

	if !breakerOpen(t, "xhs", badVersion) {
		t.Fatal("触发的版本应熔断")
	}
	// 同平台不同版本：不受影响，不能误伤仍在正常工作的适配器版本。
	if breakerOpen(t, "xhs", goodVersion) {
		t.Fatal("其它适配器版本不应被熔断")
	}
	// 不同平台同名版本：不受影响。
	if breakerOpen(t, "wechat_mp", badVersion) {
		t.Fatal("其它平台不应被熔断")
	}
}

func TestPlatformAdapterBreakerBlocksClaim(t *testing.T) {
	version := "breaker-claim-" + uuid.New().String()[:8]
	f := newBreakerFixture(t, "xhs", version)
	f.bindWork(t, "熔断领取测试", "6f0000000000000000000099")

	// 直接插入一条 queued 任务（不走调度，避免依赖日常窗口等时间条件）。
	// query_scope / binding_snapshot 都是 jsonb NOT NULL，browser_version 是 text NOT NULL。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, status, query_scope,
		 authorization_revision, workspace_authorization_revision, adapter_version, mapping_version,
		 browser_version, binding_snapshot, deadline_at)
		VALUES ($1,$2,$3,'manual','collect','queued','{}'::jsonb,1,1,$4,1,'','[]'::jsonb, now() + interval '1 hour')`,
		f.Connection, f.Workspace, f.Account.ID, version); err != nil {
		t.Fatal(err)
	}

	// 打开熔断后，领取必须拿不到任务。
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_adapter_breaker
		(platform, adapter_version, error_code, state, affected_connections)
		VALUES ('xhs',$1,'platform_schema_changed','open',1)`, version); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := f.claimWith(t); ok {
		t.Fatal("熔断期间不能领取任务，否则会继续写入错数")
	}
}

