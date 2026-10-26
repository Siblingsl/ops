package app

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// 这组测试钉住「每主体每天 N 个 run」这道**当前唯一真正生效**的预算闸门
// （`platformCanReserveRun`），以及它依赖的两个时间函数。
//
// 为什么值得单独测：`reservePlatformRunQuery` 里的六道闸门至今没有接线（客户端从不发
// budget_request，见 platform_sync_budget.go 的注释），所以「今天还能不能跑」完全由
// 这里的判断决定。写错的两个方向都很贵——算宽了会把平台账号的日额度打穿，算严了
// 会让 `next_allowed_at` 一直停在错误的时间点，界面上表现为「同步永远在等额度」。

// TestPlatformBudgetDayStartIsLocalMidnight 钉住账本起算点是**北京时间当天 00:00**，
// 而不是 UTC 零点。差 8 小时会让「今天已用几次」在早上 8 点前后算错一天。
func TestPlatformBudgetDayStartIsLocalMidnight(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("本地时区加载失败：%v", err)
	}
	cases := []struct {
		name string
		at   time.Time
	}{
		{"北京时间凌晨 00:30", time.Date(2026, 10, 26, 0, 30, 0, 0, shanghai)},
		{"北京时间上午 10:00", time.Date(2026, 10, 26, 10, 0, 0, 0, shanghai)},
		{"北京时间深夜 23:59", time.Date(2026, 10, 26, 23, 59, 59, 0, shanghai)},
		// 同一时刻用 UTC 表示也必须落在北京当天，而不是 UTC 那天。
		{"UTC 16:30 等于北京次日 00:30", time.Date(2026, 10, 25, 16, 30, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		got := platformBudgetDayStart(c.at).In(shanghai)
		if got.Hour() != 0 || got.Minute() != 0 || got.Second() != 0 {
			t.Errorf("%s：起算点应为当天 00:00，实际 %s", c.name, got.Format(time.RFC3339))
		}
		if got.Format("2006-01-02") != c.at.In(shanghai).Format("2006-01-02") {
			t.Errorf("%s：起算点应落在同一自然日，实际 %s", c.name, got.Format("2006-01-02"))
		}
	}
}

// TestPlatformBudgetNextWindowIsNextNineAM 钉住额度用尽后 `next_allowed_at` 落点：
// 窗口开始前推到**今天** 09:00，窗口开始后推到**次日** 09:00。
func TestPlatformBudgetNextWindowIsNextNineAM(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("本地时区加载失败：%v", err)
	}
	cases := []struct {
		name string
		at   time.Time
		want time.Time
	}{
		{"窗口前 08:59 推今天 09:00", time.Date(2026, 10, 26, 8, 59, 0, 0, shanghai), time.Date(2026, 10, 26, 9, 0, 0, 0, shanghai)},
		{"窗口起点 09:00 推次日", time.Date(2026, 10, 26, 9, 0, 0, 0, shanghai), time.Date(2026, 10, 27, 9, 0, 0, 0, shanghai)},
		{"窗口内 14:37 推次日", time.Date(2026, 10, 26, 14, 37, 0, 0, shanghai), time.Date(2026, 10, 27, 9, 0, 0, 0, shanghai)},
		{"窗口终点 21:00 推次日", time.Date(2026, 10, 26, 21, 0, 0, 0, shanghai), time.Date(2026, 10, 27, 9, 0, 0, 0, shanghai)},
		{"跨月 10-31 22:00 推 11-01", time.Date(2026, 10, 31, 22, 0, 0, 0, shanghai), time.Date(2026, 11, 1, 9, 0, 0, 0, shanghai)},
		{"UTC 表示同样成立", time.Date(2026, 10, 26, 0, 30, 0, 0, time.UTC), time.Date(2026, 10, 26, 9, 0, 0, 0, shanghai)},
	}
	for _, c := range cases {
		got := platformBudgetNextWindow(c.at)
		if !got.Equal(c.want) {
			t.Errorf("%s：期望 %s，实际 %s", c.name, c.want.Format(time.RFC3339), got.In(shanghai).Format(time.RFC3339))
		}
	}
}

// TestPlatformBudgetGateCountsRunsPerSubject 钉住闸门的三个语义：
//  1. 额度按「平台 + 平台账号」当天已建的 run 数算，跨天清零；
//  2. 上限取 `min(硬常量 3, 工作区策略 daily_run_limit)`；
//  3. 读窗口之外一律不放行，并把 `next_allowed_at` 指到下一个 09:00。
func TestPlatformBudgetGateCountsRunsPerSubject(t *testing.T) {
	const externalKey = "xhs_user_id:fixture-budget"
	f := newPlatformRunFixture(t, "xhs", externalKey)
	ctx := context.Background()

	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("本地时区加载失败：%v", err)
	}
	// 窗口判断读 s.loc，账本起算点却硬编码北京时间；这里统一成北京时区，
	// 否则 fixture 造出来的固定偏移会让两者指向不同的「今天」。
	previousLoc := env.srv.loc
	env.srv.loc = shanghai
	t.Cleanup(func() { env.srv.loc = previousLoc })

	now := time.Date(2026, 10, 26, 10, 0, 0, 0, shanghai)
	dayStart := platformBudgetDayStart(now)
	tomorrow := time.Date(2026, 10, 27, 9, 0, 0, 0, shanghai)

	insertRun := func(createdAt time.Time) {
		t.Helper()
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
			(connection_id, workspace_id, account_id, trigger, task_kind, status,
			 authorization_revision, workspace_authorization_revision, created_at, finished_at)
			VALUES ($1,$2,$3,'daily','collect','succeeded',1,1,$4,$4)`,
			f.Connection, f.Workspace, f.Account.ID, createdAt); err != nil {
			t.Fatal(err)
		}
	}
	reserve := func(at time.Time) (bool, time.Time) {
		t.Helper()
		var allowed bool
		var next time.Time
		if err := env.srv.withTx(ctx, func(tx pgx.Tx) error {
			var err error
			allowed, next, err = env.srv.platformCanReserveRun(ctx, tx, f.Workspace, "xhs", externalKey, at)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return allowed, next
	}

	// 1. 当天还没有 run：放行。
	if allowed, next := reserve(now); !allowed {
		t.Fatalf("当天 0 个 run 时应放行，实际被挡到 %s", next.In(shanghai).Format(time.RFC3339))
	}

	// 2. 昨天的 run 不计入今天：跨天清零。
	insertRun(dayStart.Add(-time.Hour))
	if allowed, next := reserve(now); !allowed {
		t.Fatalf("昨天的 run 不应占用今天额度，实际被挡到 %s", next.In(shanghai).Format(time.RFC3339))
	}

	// 3. 今天用满 3 个（含上面那次判断前的 0 个，这里补到 3）：拒绝并指向次日 09:00。
	for i := 0; i < 3; i++ {
		insertRun(dayStart.Add(time.Duration(i+1) * time.Hour))
	}
	allowed, next := reserve(now)
	if allowed {
		t.Fatal("当天已用满 3 个 run 时不得放行")
	}
	if !next.Equal(tomorrow) {
		t.Fatalf("额度用尽后 next_allowed_at 应为次日 09:00，实际 %s", next.In(shanghai).Format(time.RFC3339))
	}

	// 4. 上限取 min(硬常量, 策略)：策略降到 1 时，只用了 1 个就该挡。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_collection_policy SET daily_run_limit=1 WHERE workspace_id=$1`,
		f.Workspace); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `DELETE FROM platform_sync_run WHERE connection_id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	insertRun(dayStart.Add(time.Hour))
	if allowed, _ := reserve(now); allowed {
		t.Fatal("策略 daily_run_limit=1 时，当天第 2 次应被挡住")
	}

	// 5. 窗口之外即使额度充足也不放行，并指向下一个 09:00。
	if _, err := env.srv.db.Exec(ctx, `DELETE FROM platform_sync_run WHERE connection_id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	beforeWindow := time.Date(2026, 10, 26, 8, 30, 0, 0, shanghai)
	allowed, next = reserve(beforeWindow)
	if allowed {
		t.Fatal("09:00 之前不得放行")
	}
	if want := time.Date(2026, 10, 26, 9, 0, 0, 0, shanghai); !next.Equal(want) {
		t.Fatalf("窗口前应指向当天 09:00，实际 %s", next.In(shanghai).Format(time.RFC3339))
	}
	afterWindow := time.Date(2026, 10, 26, 21, 30, 0, 0, shanghai)
	allowed, next = reserve(afterWindow)
	if allowed {
		t.Fatal("21:00 之后不得放行")
	}
	if !next.Equal(tomorrow) {
		t.Fatalf("窗口后应指向次日 09:00，实际 %s", next.In(shanghai).Format(time.RFC3339))
	}
}
