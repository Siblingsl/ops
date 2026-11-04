package app

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func wechatAutoState(t *testing.T, id uuid.UUID) (enabled bool, fails int, last *time.Time, note string) {
	t.Helper()
	if err := env.srv.db.QueryRow(context.Background(), `SELECT metrics_wechat_auto, metrics_wechat_fails, metrics_wechat_last_at, metrics_wechat_note
		FROM platform_account WHERE id=$1`, id).Scan(&enabled, &fails, &last, &note); err != nil {
		t.Fatal(err)
	}
	return
}

func dailySyncRuns(t *testing.T, id uuid.UUID) int {
	t.Helper()
	var n int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM audit_log WHERE action='metrics_sync_daily' AND target_id=$1`, id.String()).Scan(&n)
	return n
}

// DEV-DR06（14 文档 4.2 第 4 条）：有接口权限的公众号每天 10:00 后只读同步一次；可按账号关闭；
// 连续 3 天失败或返回无权限时自动关闭并通知；关闭后不再算"接口已覆盖"，恢复手动提醒。
func TestDR06WechatDailySync(t *testing.T) {
	ctx := context.Background()
	a := drWechatAccount(t, "每日同步验收号")
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, nil)
	var acc Account
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &acc)
	if acc.DatacubeState != "ok" || acc.WechatAuto == nil || !acc.WechatAuto.Enabled {
		t.Fatalf("daily sync should default on for a permitted account: %+v %+v", acc.DatacubeState, acc.WechatAuto)
	}
	if !datacubeCovers(&acc) {
		t.Fatal("permitted account with daily sync on covers its works")
	}
	x := drAccount(t, "xhs", "每日同步小红书号")
	var xa Account
	env.mustJSON(t, "GET", "/api/v1/accounts/"+x.ID.String(), nil, &xa)
	if xa.WechatAuto != nil {
		t.Fatal("xhs accounts have no WeChat daily sync")
	}
	env.expectErr(t, "PATCH", "/api/v1/accounts/"+x.ID.String(), map[string]any{"metrics_wechat_auto": true}, "validation_failed")

	orig := env.srv.now
	defer func() { env.srv.now = orig }()
	base := time.Date(2031, 3, 3, 0, 0, 0, 0, env.srv.loc)
	at := func(day, hour int) {
		env.srv.now = func() time.Time { return base.AddDate(0, 0, day).Add(time.Duration(hour) * time.Hour) }
	}

	at(0, 9)
	env.srv.wechatMetricsDaily(ctx)
	if dailySyncRuns(t, a.ID) != 0 {
		t.Fatal("must not run before 10:00")
	}
	at(0, 11)
	env.srv.wechatMetricsDaily(ctx)
	env.srv.wechatMetricsDaily(ctx)
	if n := dailySyncRuns(t, a.ID); n != 1 {
		t.Fatalf("exactly one run per account per day, got %d", n)
	}
	if on, fails, last, _ := wechatAutoState(t, a.ID); !on || fails != 0 || last == nil {
		t.Fatalf("successful run: on=%v fails=%d last=%v", on, fails, last)
	}

	env.mockWX.SetDatacubeError(45009)
	for d := 1; d <= 3; d++ {
		at(d, 11)
		env.srv.wechatMetricsDaily(ctx)
		on, fails, _, note := wechatAutoState(t, a.ID)
		if fails != d || on != (d < 3) {
			env.mockWX.SetDatacubeError(0)
			t.Fatalf("day %d: on=%v fails=%d", d, on, fails)
		}
		if d == 3 && !strings.Contains(note, "连续 3 天") {
			t.Fatalf("auto-off note: %q", note)
		}
	}
	env.mockWX.SetDatacubeError(0)
	var notes int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE dedupe_key LIKE $1`, "wechat-auto-off:"+a.ID.String()+":%").Scan(&notes)
	if notes == 0 {
		t.Fatal("turning the daily sync off must notify")
	}
	env.srv.now = orig
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &acc)
	if acc.WechatAuto.Enabled || datacubeCovers(&acc) {
		t.Fatal("with daily sync off, works go back to manual reminders")
	}
	at(4, 11)
	env.srv.wechatMetricsDaily(ctx)
	if n := dailySyncRuns(t, a.ID); n != 4 {
		t.Fatalf("disabled account must be skipped, runs=%d", n)
	}

	env.srv.now = orig
	var re Account
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"metrics_wechat_auto": true}, &re)
	if !re.WechatAuto.Enabled || re.WechatAuto.Fails != 0 || re.WechatAuto.Note != "" {
		t.Fatalf("re-enable resets the counter: %+v", re.WechatAuto)
	}
	env.mockWX.SetDatacubeDenied(true)
	at(5, 11)
	env.srv.wechatMetricsDaily(ctx)
	env.mockWX.SetDatacubeDenied(false)
	on, _, _, note := wechatAutoState(t, a.ID)
	if on || !strings.Contains(note, "没有数据统计接口权限") {
		t.Fatalf("no permission turns it off at once: on=%v note=%q", on, note)
	}
	env.srv.now = orig
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &acc)
	if acc.DatacubeState != "no_permission" {
		t.Fatalf("datacube state: %q", acc.DatacubeState)
	}
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"metrics_wechat_auto": false}, &acc)
	if acc.WechatAuto.Enabled {
		t.Fatal("owner can switch it off")
	}
}

func TestRunJobsDispatchesWechatDailySync(t *testing.T) {
	originalNow := env.srv.now
	fixedNow := time.Date(2026, time.November, 5, 11, 30, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return fixedNow }
	env.mockWX.SetDatacubeError(0)
	env.mockWX.SetUserDatacubeError(0)
	env.mockWX.SetArticleTotals(map[string][]map[string]any{})
	t.Cleanup(func() {
		env.srv.now = originalNow
		env.mockWX.SetDatacubeError(0)
		env.mockWX.SetUserDatacubeError(0)
		env.mockWX.SetArticleTotals(nil)
	})

	a := drWechatAccount(t, "RunJobs 每日复盘数据调度验收号")
	base := "/api/v1/accounts/" + a.ID.String()
	env.mustJSON(t, "POST", base+"/wechat-credential/test", nil, nil)
	var before Account
	env.mustJSON(t, "GET", base, nil, &before)
	if before.DatacubeState != "ok" || before.WechatAuto == nil || !before.WechatAuto.Enabled {
		t.Fatalf("test setup must enable an authorized daily sync: state=%q auto=%+v", before.DatacubeState, before.WechatAuto)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()

	deadline := time.NewTimer(10 * time.Second)
	poll := time.NewTicker(20 * time.Millisecond)
	for {
		var runs int
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM audit_log WHERE action='metrics_sync_daily' AND target_id=$1`, a.ID.String()).Scan(&runs); err != nil {
			cancel()
			t.Fatal(err)
		}
		if runs > 0 {
			break
		}
		select {
		case <-deadline.C:
			cancel()
			t.Fatal("RunJobs startup pass did not dispatch the WeChat daily metrics sync")
		case <-poll.C:
		}
	}
	deadline.Stop()
	poll.Stop()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunJobs did not stop after context cancellation")
	}

	if n := dailySyncRuns(t, a.ID); n != 1 {
		t.Fatalf("RunJobs should dispatch one daily sync, got %d audit records", n)
	}
	if enabled, fails, last, _ := wechatAutoState(t, a.ID); !enabled || fails != 0 || last == nil {
		t.Fatalf("daily sync state: enabled=%v fails=%d last=%v", enabled, fails, last)
	}
	var followers followerList
	env.mustJSON(t, "GET", base+"/followers?days=30", nil, &followers)
	if !followers.API || len(followers.Days) != 7 {
		t.Fatalf("scheduled follower sync was not persisted: api=%v days=%d", followers.API, len(followers.Days))
	}
	var stored int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM account_metric_daily WHERE account_id=$1 AND source='wechat_api'`, a.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 7 {
		t.Fatalf("want 7 persisted API follower days, got %d", stored)
	}
}

// This opt-in integration test waits for RunJobs' real 10-minute ticker.
// Keep it out of the normal package suite because it intentionally takes over ten minutes.
func TestRunJobsDispatchesWechatDailySyncOnTenMinuteTick(t *testing.T) {
	if os.Getenv("OPS_TEST_WECHAT_REAL_TICK") != "1" {
		t.Skip("set OPS_TEST_WECHAT_REAL_TICK=1 to wait for the real 10-minute scheduler tick")
	}

	originalNow := env.srv.now
	fixedNow := time.Date(2026, time.November, 5, 11, 30, 0, 0, env.srv.loc)
	env.srv.now = func() time.Time { return fixedNow }
	env.mockWX.SetDatacubeError(0)
	env.mockWX.SetUserDatacubeError(0)
	env.mockWX.SetArticleTotals(map[string][]map[string]any{})
	t.Cleanup(func() {
		env.srv.now = originalNow
		env.mockWX.SetDatacubeError(0)
		env.mockWX.SetUserDatacubeError(0)
		env.mockWX.SetArticleTotals(nil)
	})

	control := drWechatAccount(t, "RunJobs 十分钟调度控制账号")
	controlPath := "/api/v1/accounts/" + control.ID.String()
	env.mustJSON(t, "POST", controlPath+"/wechat-credential/test", nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	startedAt := time.Now()
	go func() {
		env.srv.RunJobs(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("RunJobs did not stop after context cancellation")
		}
	})

	startupDeadline := time.NewTimer(30 * time.Second)
	startupPoll := time.NewTicker(100 * time.Millisecond)
	for dailySyncRuns(t, control.ID) == 0 {
		select {
		case <-startupDeadline.C:
			startupPoll.Stop()
			t.Fatal("RunJobs startup pass did not sync the control account")
		case <-startupPoll.C:
		}
	}
	startupDeadline.Stop()
	startupPoll.Stop()

	target := drWechatAccount(t, "RunJobs 十分钟调度目标账号")
	targetPath := "/api/v1/accounts/" + target.ID.String()
	env.mustJSON(t, "POST", targetPath+"/wechat-credential/test", nil, nil)
	if runs := dailySyncRuns(t, target.ID); runs != 0 {
		t.Fatalf("target account must be created after the startup pass; startup runs=%d", runs)
	}

	deadline := time.NewTimer(12 * time.Minute)
	poll := time.NewTicker(time.Second)
	defer deadline.Stop()
	defer poll.Stop()
	for dailySyncRuns(t, target.ID) == 0 {
		select {
		case <-deadline.C:
			t.Fatal("RunJobs did not dispatch the target account on its real 10-minute tick")
		case <-poll.C:
		}
	}
	if elapsed := time.Since(startedAt); elapsed < 9*time.Minute+45*time.Second {
		t.Fatalf("target sync arrived too early to prove the 10-minute tick: elapsed=%s", elapsed.Round(time.Second))
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunJobs did not stop after context cancellation")
	}
	if runs := dailySyncRuns(t, control.ID); runs != 1 {
		t.Fatalf("control account should be synced once by startup, got %d runs", runs)
	}
	if runs := dailySyncRuns(t, target.ID); runs != 1 {
		t.Fatalf("target account should be synced once by the 10-minute tick, got %d runs", runs)
	}
	if enabled, fails, last, _ := wechatAutoState(t, target.ID); !enabled || fails != 0 || last == nil {
		t.Fatalf("scheduled target state: enabled=%v fails=%d last=%v", enabled, fails, last)
	}
	var followers followerList
	env.mustJSON(t, "GET", targetPath+"/followers?days=30", nil, &followers)
	if !followers.API || len(followers.Days) != 7 {
		t.Fatalf("scheduled target follower sync was not persisted: api=%v days=%d", followers.API, len(followers.Days))
	}
	var stored int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM account_metric_daily WHERE account_id=$1 AND source='wechat_api'`, target.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 7 {
		t.Fatalf("want 7 persisted target API follower days, got %d", stored)
	}
}
