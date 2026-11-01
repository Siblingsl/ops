package db

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestCXReviewExperimentsMigrationConstraintsAndRollbackProtection(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 78); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 79); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name='review_experiment'`).Scan(&count); err != nil || count != 20 {
		t.Fatalf("experiment schema must expose the documented fields: columns=%d err=%v", count, err)
	}
	var metricID string
	if err := database.QueryRow(`INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,read_unit,shares,share_unit)
		VALUES($1,$2,'manual',8,50,'count',3,'count') RETURNING id`, legacy.workIDs[0], time.Now()).Scan(&metricID); err != nil {
		t.Fatalf("count units required by FR-CX-21 must be storable: %v", err)
	}
	start := time.Now().Format("2006-01-02")
	if _, err := database.Exec(`INSERT INTO review_experiment(account_id,workspace_id,hypothesis,variable,metric_key,"window",
		selection_basis,baseline_from,baseline_to,result_from,result_to)
		VALUES($1,$2,'比较标题变化','title','favorite_rate','T7','{"timezone":"Asia/Shanghai"}'::jsonb,$3,$3,$4,$4)`,
		legacy.accountIDs[0], workspaceForCXReview(database, t, legacy.accountIDs[0]), start, start); err == nil {
		t.Fatal("overlapping date windows must be rejected")
	}
	workspaceID := workspaceForCXReview(database, t, legacy.accountIDs[0])
	if _, err := database.Exec(`INSERT INTO review_experiment(account_id,workspace_id,hypothesis,variable,metric_key,"window",
		selection_basis,baseline_from,baseline_to,result_from,result_to)
		VALUES($1,$2,'比较标题变化','title','favorite_rate','T7','{"timezone":"Asia/Shanghai"}'::jsonb,$3,$3,$4,$4)`,
		legacy.accountIDs[0], workspaceID, start, time.Now().AddDate(0, 0, 1).Format("2006-01-02")); err != nil {
		t.Fatalf("valid experiment insert: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO review_experiment(account_id,workspace_id,hypothesis,variable,metric_key,"window",
		selection_basis,baseline_from,baseline_to,result_from,result_to)
		VALUES($1,$2,'再次创建','topic','follow_rate','T1','{"timezone":"Asia/Shanghai"}'::jsonb,$3,$3,$4,$4)`,
		legacy.accountIDs[0], workspaceID, start, time.Now().AddDate(0, 0, 1).Format("2006-01-02")); err == nil {
		t.Fatal("one-running-per-account constraint must reject the second experiment")
	}
	if _, err := database.Exec(`INSERT INTO review_experiment(account_id,workspace_id,hypothesis,variable,metric_key,"window",
		selection_basis,baseline_from,baseline_to,result_from,result_to)
		VALUES($1,$2,'跨工作区','topic','follow_rate','T1','{"timezone":"Asia/Shanghai"}'::jsonb,$3,$3,$4,$4)`,
		legacy.accountIDs[0], uuid.NewString(), start, time.Now().AddDate(0, 0, 1).Format("2006-01-02")); err == nil {
		t.Fatal("workspace/account mismatch must be rejected by the composite foreign key")
	}
	if err := goose.DownTo(database, "migrations", 78); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("saved experiment must block destructive rollback: %v", err)
	}
	var stillThere int
	if err := database.QueryRow(`SELECT count(*) FROM review_experiment`).Scan(&stillThere); err != nil || stillThere != 1 {
		t.Fatalf("rollback refusal must preserve the record: count=%d err=%v", stillThere, err)
	}
}

func workspaceForCXReview(database *sql.DB, t *testing.T, accountID string) string {
	t.Helper()
	var workspaceID string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	return workspaceID
}
