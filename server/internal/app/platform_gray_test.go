package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// DEV-PS10 定向测试：kill switch、灰度阈值与运营诊断（20 文档 §14、§17.3）。
// 覆盖 PS-T49（kill switch 与旧客户端）、PS-T40（功能关闭时停采保数）。

// setKillSwitch 直接写系统配置，模拟超管在系统管理页关闭采集。
func setKillSwitch(t *testing.T, killed bool) {
	t.Helper()
	if err := env.srv.putSystemBool(context.Background(), platformKillSwitchKey, killed); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = env.srv.putSystemBool(context.Background(), platformKillSwitchKey, false)
	})
}

// TestPlatformKillSwitchStopsCollection 对应 PS-T49：DB 级开关关闭后，
// 准入、调度与 claim 都停止，不需要重启进程。
func TestPlatformKillSwitchStopsCollection(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "开关样本", "6f0000000000000000000901")
	withDesktopPlatformEnabled(t, true)

	// 开启时正常可用。
	if !env.srv.platformCollectionGloballyEnabled(context.Background()) {
		t.Fatal("默认应可用")
	}

	setKillSwitch(t, true)
	if env.srv.platformCollectionGloballyEnabled(context.Background()) {
		t.Fatal("DB 开关关闭后必须视为关闭")
	}
	// 准入被拒：策略检查是平台操作的第一道闸门。
	ctx := context.WithValue(context.Background(), ctxMember,
		&identity{UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner"})
	if err := env.srv.desktopRequirePlatformCollectionAccess(ctx, f.DeviceID); err == nil {
		t.Fatal("关闭后准入必须被拒绝")
	} else if ae, ok := platformAPIError(err); !ok || ae.Code != "platform_collection_disabled" {
		t.Fatalf("应返回 platform_collection_disabled，实际 %v", err)
	}
	// 调度不建单。
	env.srv.schedulePlatformRuns(context.Background())
	var queued int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_run
		WHERE connection_id=$1 AND status='queued'`, f.Connection).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("关闭后不得建单：%d %v", queued, err)
	}
	// claim 直接拒绝（即使队列里已有旧 run）。
	if _, err := env.srv.claimPlatformRun(context.WithValue(context.Background(), ctxMember,
		&identity{UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner"}), f.DeviceID); err == nil {
		t.Fatal("关闭后 claim 必须被拒绝")
	} else if ae, ok := platformAPIError(err); !ok || ae.Code != "platform_collection_disabled" {
		t.Fatalf("应返回 platform_collection_disabled，实际 %v", err)
	}

	// 进程配置关闭时同样停止（两者任一关闭即停）。
	setKillSwitch(t, false)
	withDesktopPlatformEnabled(t, false)
	if env.srv.platformCollectionGloballyEnabled(context.Background()) {
		t.Fatal("进程配置关闭后必须视为关闭")
	}
}

// TestPlatformGrayDiagnosticsCounts 对应 §14：诊断只输出计数与比例，不含业务内容。
func TestPlatformGrayDiagnosticsCounts(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	ctx := context.Background()
	// 造两条 run：一条失败于冲突，一条成功。
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, status, authorization_revision,
		 workspace_authorization_revision, error_code, finished_at)
		VALUES ($1,$2,$3,'daily','collect','failed',1,1,'platform_result_conflict',now())`,
		f.Connection, f.Workspace, f.Account.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
		(connection_id, workspace_id, account_id, trigger, task_kind, status, authorization_revision,
		 workspace_authorization_revision, finished_at)
		VALUES ($1,$2,$3,'daily','collect','succeeded',1,1,now())`,
		f.Connection, f.Workspace, f.Account.ID); err != nil {
		t.Fatal(err)
	}
	diag, err := env.srv.platformWorkspaceDiagnostics(ctx, f.Workspace)
	if err != nil {
		t.Fatal(err)
	}
	if diag.RunsTotal != 2 || diag.RunsFailed != 1 {
		t.Fatalf("run 计数不符：%+v", diag)
	}
	if diag.Conflicts != 1 || diag.ConflictRate <= 0 {
		t.Fatalf("冲突计数不符：%+v", diag)
	}
	// 冲突率 50% 超过 5% 阈值：应判为降级。
	if !diag.Degraded || len(diag.DegradedReasons) == 0 {
		t.Fatalf("超阈值应判降级：%+v", diag)
	}
}

// TestPlatformGrayDegradeTurnsOffAutoAdopt 对应 §17.3：超阈值只关闭 auto_adopt，
// 不停自动采集，并写审计。
func TestPlatformGrayDegradeTurnsOffAutoAdopt(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	ctx := context.Background()
	withDesktopPlatformEnabled(t, true)
	// 让连接先开启两个开关（绕过 HTTP 的 auto_adopt 限制，直接落库模拟“已开启”的历史状态）。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_connection SET auto_collect=true, auto_adopt=true
		WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	// 制造高冲突率。
	for i := 0; i < 3; i++ {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, trigger, task_kind, status, authorization_revision,
			 workspace_authorization_revision, error_code, finished_at)
			VALUES ($1,$2,$3,'daily','collect','failed',1,1,'platform_result_conflict',now())`,
			f.Connection, f.Workspace, f.Account.ID); err != nil {
			t.Fatal(err)
		}
	}
	env.srv.enforcePlatformGrayThresholds(ctx)
	var autoAdopt, autoCollect bool
	if err := env.srv.db.QueryRow(ctx, `SELECT auto_adopt, auto_collect FROM platform_connection
		WHERE id=$1`, f.Connection).Scan(&autoAdopt, &autoCollect); err != nil {
		t.Fatal(err)
	}
	if autoAdopt {
		t.Fatal("超阈值应关闭 auto_adopt")
	}
	if !autoCollect {
		t.Fatal("降级只关闭自动采用，不应停自动采集")
	}
	// 审计里能看到降级记录。
	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM audit_log
		WHERE action='platform_gray_degrade' AND target_id=$1`, f.Workspace.String()).Scan(&count); err != nil || count == 0 {
		t.Fatalf("降级应写审计：%d %v", count, err)
	}
}

// TestPlatformGrayDoesNotDegradeBelowThreshold 对应 §17.3：未超阈值时不降级。
func TestPlatformGrayDoesNotDegradeBelowThreshold(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	ctx := context.Background()
	withDesktopPlatformEnabled(t, true)
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_connection SET auto_collect=true, auto_adopt=true
		WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	// 20 条成功 run：冲突率 0，登录要求率 0。
	for i := 0; i < 20; i++ {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, trigger, task_kind, status, authorization_revision,
			 workspace_authorization_revision, finished_at)
			VALUES ($1,$2,$3,'daily','collect','succeeded',1,1,now())`,
			f.Connection, f.Workspace, f.Account.ID); err != nil {
			t.Fatal(err)
		}
	}
	env.srv.enforcePlatformGrayThresholds(ctx)
	var autoAdopt bool
	if err := env.srv.db.QueryRow(ctx, `SELECT auto_adopt FROM platform_connection
		WHERE id=$1`, f.Connection).Scan(&autoAdopt); err != nil {
		t.Fatal(err)
	}
	if !autoAdopt {
		t.Fatal("未超阈值不应降级")
	}
}

// TestPlatformDiagnosticsEndpointOwnerOnly 对应 §4.3：诊断只对 owner 开放。
func TestPlatformDiagnosticsEndpointOwnerOnly(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	// owner 可以读取。
	env.mustJSON(t, "GET", "/api/v1/platform-collection/diagnostics", nil, nil)

	// editor 与 viewer 都不能读：诊断属于 owner 的运营视图。
	editor := env.registerClient(t, "ps10-editor-"+f.Account.ID.String()[:8], testPassword)
	var res struct {
		CSRF   string `json:"csrf_token"`
		UserID string `json:"user_id"`
	}
	editor.mustJSON(t, "GET", "/api/v1/auth/me", nil, &res)
	editor.csrf = res.CSRF
	editorID, err := uuid.Parse(res.UserID)
	if err != nil {
		editor.restore(env)
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO workspace_member (workspace_id,user_id,role,status)
		VALUES ($1,$2,'editor','active') ON CONFLICT DO NOTHING`, f.Workspace, editorID); err != nil {
		editor.restore(env)
		t.Fatal(err)
	}
	if st, body := editor.do("POST", "/api/v1/workspaces/"+f.Workspace.String()+"/switch", nil); st != 200 {
		editor.restore(env)
		t.Fatalf("editor switch: %d %s", st, body)
	}
	editor.expectErr(t, "GET", "/api/v1/platform-collection/diagnostics", nil, "forbidden")
	editor.restore(env)
}

// TestPlatformCapabilityReflectsKillSwitch 对应 §17.3：能力接口如实回报全局开关状态。
func TestPlatformCapabilityReflectsKillSwitch(t *testing.T) {
	withDesktopPlatformEnabled(t, true)
	var caps struct {
		PlatformCollection struct {
			Enabled bool `json:"enabled"`
		} `json:"platform_collection"`
	}
	env.mustJSON(t, "GET", "/api/v1/desktop/capabilities", nil, &caps)
	if !caps.PlatformCollection.Enabled {
		t.Fatal("开启时应回报可用")
	}
	setKillSwitch(t, true)
	env.mustJSON(t, "GET", "/api/v1/desktop/capabilities", nil, &caps)
	if caps.PlatformCollection.Enabled {
		t.Fatal("kill switch 关闭后能力接口必须回报不可用")
	}
}
