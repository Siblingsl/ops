package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestAccountMetricSourcesMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 125); err != nil {
		t.Fatal(err)
	}

	var collectedType, collectedNullable, evidenceType, evidenceNullable, evidenceDefault string
	if err := database.QueryRow(`SELECT data_type, is_nullable FROM information_schema.columns
		WHERE table_schema='public' AND table_name='account_metric_daily' AND column_name='collected_at'`).
		Scan(&collectedType, &collectedNullable); err != nil {
		t.Fatal(err)
	}
	if collectedType != "timestamp with time zone" || collectedNullable != "YES" {
		t.Fatalf("collected_at schema mismatch: type=%s nullable=%s", collectedType, collectedNullable)
	}
	if err := database.QueryRow(`SELECT data_type, is_nullable, COALESCE(column_default,'') FROM information_schema.columns
		WHERE table_schema='public' AND table_name='account_metric_daily' AND column_name='evidence'`).
		Scan(&evidenceType, &evidenceNullable, &evidenceDefault); err != nil {
		t.Fatal(err)
	}
	if evidenceType != "jsonb" || evidenceNullable != "NO" || !strings.Contains(evidenceDefault, "'{}'") {
		t.Fatalf("evidence schema mismatch: type=%s nullable=%s default=%q", evidenceType, evidenceNullable, evidenceDefault)
	}

	var sourceDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='account_metric_daily'
		AND c.conname='account_metric_daily_source_check'`).Scan(&sourceDef); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"wechat_api", "wechat_browser", "xhs_browser", "manual", "desktop_live", "desktop_backfill", "import"} {
		if !strings.Contains(sourceDef, "'"+source+"'") {
			t.Fatalf("source constraint missing %s: %s", source, sourceDef)
		}
	}

	if err := goose.DownTo(database, "migrations", 124); err != nil {
		t.Fatalf("I6 source rollback must remove only the new columns/values: %v", err)
	}
	var leftColumns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='account_metric_daily'
		AND column_name IN ('collected_at','evidence')`).Scan(&leftColumns); err != nil {
		t.Fatal(err)
	}
	if leftColumns != 0 {
		t.Fatalf("I6 rollback left columns behind: %d", leftColumns)
	}
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='account_metric_daily'
		AND c.conname='account_metric_daily_source_check'`).Scan(&sourceDef); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sourceDef, "desktop_live") || !strings.Contains(sourceDef, "xhs_browser") {
		t.Fatalf("source constraint after rollback: %s", sourceDef)
	}
}
