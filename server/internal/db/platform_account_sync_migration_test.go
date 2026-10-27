package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestPlatformAccountSyncMigrationPreservesDataAndGuardsRollback(t *testing.T) {
	ctx := context.Background()
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}

	freshDB, freshURL := newToutiaoMigrationTestDB(t)
	if err := Migrate(freshURL); err != nil {
		t.Fatalf("migrate fresh database: %v", err)
	}
	if version, err := goose.GetDBVersion(freshDB); err != nil || version != 66 {
		t.Fatalf("fresh migration version: got %d, err=%v", version, err)
	}
	assertPlatformAccountSyncMigrationColumns(t, freshDB)
	if err := goose.DownTo(freshDB, "migrations", 52); err != nil {
		t.Fatalf("empty-data rollback: %v", err)
	}
	if err := Migrate(freshURL); err != nil {
		t.Fatalf("remigrate fresh database: %v", err)
	}

	database, databaseURL := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 52); err != nil {
		t.Fatalf("migrate to v52: %v", err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := Migrate(databaseURL); err != nil {
		t.Fatalf("upgrade to platform account sync schema: %v", err)
	}
	if version, err := goose.GetDBVersion(database); err != nil || version != 66 {
		t.Fatalf("migration version: got %d, err=%v", version, err)
	}
	assertLegacyPlatformData(t, database, legacy)

	for _, table := range []string{"platform_account_snapshot", "platform_work_mirror", "platform_sync_operation"} {
		var exists bool
		if err := database.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil || !exists {
			t.Fatalf("new table %s missing: exists=%t err=%v", table, exists, err)
		}
	}
	for _, column := range []struct{ table, name string }{
		{"platform_sync_run", "operation_id"},
		{"platform_sync_run", "wire_protocol_version"},
		{"platform_sync_run", "operation_stage"},
		{"platform_sync_run", "budget_query_count"},
		{"platform_sync_run", "budget_work_attempts"},
		{"platform_sync_run", "budget_result_bytes"},
		{"platform_metric_observation", "platform_work_id"},
		{"platform_work_mirror", "content_revision"},
		{"platform_work_mirror", "content_state"},
	} {
		var exists bool
		if err := database.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2
		)`, column.table, column.name).Scan(&exists); err != nil || !exists {
			t.Fatalf("column %s.%s missing: exists=%t err=%v", column.table, column.name, exists, err)
		}
	}

	var workspaceID string
	if err := database.QueryRowContext(ctx, `SELECT workspace_id::text FROM platform_account WHERE id=$1`, legacy.accountIDs[1]).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	_, err := database.ExecContext(ctx, `INSERT INTO platform_work_mirror
		(workspace_id, account_id, platform, external_account_key, external_id, remote_content_type, remote_status, title)
		VALUES ($1,$2,'xhs','xhs_user_id:fixture-user','fixture-note-1','image_note','published','fixture')`,
		workspaceID, legacy.accountIDs[1])
	if err != nil {
		t.Fatalf("insert platform mirror: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO platform_work_mirror
		(workspace_id, account_id, platform, external_account_key, external_id, remote_content_type, remote_status, title)
		VALUES ($1,$2,'xhs','xhs_user_id:fixture-user','fixture-note-1','image_note','published','duplicate')`,
		workspaceID, legacy.accountIDs[1]); err == nil {
		t.Fatal("duplicate mirror identity was accepted")
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO platform_work_mirror
		(workspace_id, account_id, platform, external_account_key, external_id, remote_content_type, remote_status, title)
		VALUES ($1,$2,'xhs','xhs_user_id:fixture-user','fixture-note-2','image_note','published','wrong workspace')`,
		"00000000-0000-0000-0000-000000000001", legacy.accountIDs[1]); err == nil {
		t.Fatal("cross-workspace mirror was accepted")
	}
	if _, err := database.ExecContext(ctx, `UPDATE platform_sync_run SET budget_query_count=0,budget_work_attempts=0,
		budget_static_requests=0,budget_static_bytes=0,budget_result_rows=0,budget_result_bytes=0,last_data_query_at=NULL`); err != nil {
		t.Fatal(err)
	}

	err = goose.DownTo(database, "migrations", 52)
	if err == nil || !strings.Contains(err.Error(), "cannot roll back platform account sync while data exists") {
		t.Fatalf("rollback with mirror data must be rejected: %v", err)
	}
	if version, err := goose.GetDBVersion(database); err != nil || version != 53 {
		t.Fatalf("failed rollback changed migration version: got %d, err=%v", version, err)
	}
	assertLegacyPlatformData(t, database, legacy)
	assertPlatformAccountSyncMigrationColumns(t, database)
}

func assertPlatformAccountSyncMigrationColumns(t *testing.T, database *sql.DB) {
	t.Helper()
	for _, table := range []string{"platform_account_snapshot", "platform_work_mirror", "platform_sync_operation"} {
		var exists bool
		if err := database.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil || !exists {
			t.Fatalf("table %s missing after rejected rollback: exists=%t err=%v", table, exists, err)
		}
	}
}
