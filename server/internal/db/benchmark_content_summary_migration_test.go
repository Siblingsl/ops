package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestBenchmarkContentSummaryMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 124); err != nil {
		t.Fatal(err)
	}

	var dataType, nullable, defaultValue string
	if err := database.QueryRow(`SELECT data_type, is_nullable, COALESCE(column_default,'')
		FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note' AND column_name='content_summary'`).
		Scan(&dataType, &nullable, &defaultValue); err != nil {
		t.Fatal(err)
	}
	if dataType != "text" || nullable != "NO" || !strings.Contains(defaultValue, "''") {
		t.Fatalf("content_summary schema mismatch: type=%s nullable=%s default=%q", dataType, nullable, defaultValue)
	}

	var lengthCheck int
	if err := database.QueryRow(`SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
		WHERE t.relname='benchmark_note' AND c.conname LIKE '%content_summary%'
		AND pg_get_constraintdef(c.oid) LIKE '%char_length(content_summary)%'
		AND pg_get_constraintdef(c.oid) LIKE '%4000%'`).Scan(&lengthCheck); err != nil {
		t.Fatal(err)
	}
	if lengthCheck != 1 {
		t.Fatalf("content_summary length check missing: %d", lengthCheck)
	}

	if err := goose.DownTo(database, "migrations", 123); err != nil {
		t.Fatalf("I2 content_summary rollback must remove only the new column: %v", err)
	}
	var contentColumns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note' AND column_name='content_summary'`).Scan(&contentColumns); err != nil {
		t.Fatal(err)
	}
	if contentColumns != 0 {
		t.Fatalf("content_summary rollback left column behind: %d", contentColumns)
	}
	var decomposeColumns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note'
		AND column_name IN ('decompose_state','decompose_revision','decompose_draft','decompose_ai_call_id','decompose_error','decompose_confirmed_at')`).Scan(&decomposeColumns); err != nil {
		t.Fatal(err)
	}
	if decomposeColumns != 6 {
		t.Fatalf("content_summary rollback must keep I2 decompose columns: %d/6", decomposeColumns)
	}
}
