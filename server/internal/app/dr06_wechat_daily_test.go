package app

import (
	"context"
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
