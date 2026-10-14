package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT31DailyHousekeepingCatchesUpPreviousDay(t *testing.T) {
	a, _ := v4Account(t, "OPT31 "+uuid.NewString())
	ctx := context.Background()
	today := env.srv.today().AddDate(0, 0, -400)
	previous := today.AddDate(0, 0, -1)
	oldNow := env.srv.now
	env.srv.now = func() time.Time { return today.Add(4 * time.Hour) }
	defer func() { env.srv.now = oldNow }()

	for _, day := range []time.Time{previous, today} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO daily_recommendation (account_id,date,version,items,trigger)
			VALUES ($1,$2,1,'[{"title":"OPT31 补跑验证"}]','manual')`, a.ID, day); err != nil {
			t.Fatal(err)
		}
	}
	var before int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='daily_brief'`, a.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}

	env.srv.runDailyHousekeeping(ctx)
	var first int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='daily_brief'`, a.ID).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if first-before != 2 {
		t.Fatalf("want one model call for each date, got %d", first-before)
	}

	var briefs, markers int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_daily_brief WHERE account_id=$1 AND date IN ($2,$3)`, a.ID, previous, today).Scan(&briefs); err != nil {
		t.Fatal(err)
	}
	if briefs != 2 {
		t.Fatalf("want previous-day and current-day briefs, got %d", briefs)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM job_marker WHERE key IN ($1,$2)`,
		"daily-housekeeping:"+previous.Format("2006-01-02"), "daily-housekeeping:"+today.Format("2006-01-02")).Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if markers != 2 {
		t.Fatalf("want both housekeeping dates marked, got %d", markers)
	}

	env.srv.runDailyHousekeeping(ctx)
	var after int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='daily_brief'`, a.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != first {
		t.Fatalf("rerun should not add model calls: before=%d after=%d", before, after)
	}
}
