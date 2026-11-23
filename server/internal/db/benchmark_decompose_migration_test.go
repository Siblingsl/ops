package db

import (
	"testing"

	"github.com/pressly/goose/v3"
)

func TestBenchmarkDecomposeMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 123); err != nil {
		t.Fatal(err)
	}

	var columns int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note'
		AND column_name IN ('decompose_state','decompose_revision','decompose_draft',
			'decompose_ai_call_id','decompose_error','decompose_confirmed_at')`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 6 {
		t.Fatalf("I2 decompose columns incomplete: %d/6", columns)
	}

	var stateCheck, draftCheck, fk int
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
			WHERE t.relname='benchmark_note' AND c.conname LIKE '%decompose_state%'
			AND pg_get_constraintdef(c.oid) LIKE '%ai_draft%' AND pg_get_constraintdef(c.oid) LIKE '%confirmed%'),
		(SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
			WHERE t.relname='benchmark_note' AND c.conname LIKE '%decompose_draft%'
			AND pg_get_constraintdef(c.oid) LIKE '%jsonb_typeof%'),
		(SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
			WHERE t.relname='benchmark_note' AND c.conname LIKE '%decompose_ai_call_id%'
			AND c.contype='f')`).Scan(&stateCheck, &draftCheck, &fk); err != nil {
		t.Fatal(err)
	}
	if stateCheck != 1 || draftCheck != 1 || fk != 1 {
		t.Fatalf("I2 constraints missing: state=%d draft=%d fk=%d", stateCheck, draftCheck, fk)
	}

	var notNull int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note'
		AND column_name IN ('decompose_state','decompose_revision','decompose_draft','decompose_error')
		AND is_nullable='NO'`).Scan(&notNull); err != nil {
		t.Fatal(err)
	}
	if notNull != 4 {
		t.Fatalf("I2 decompose defaults/not-null incomplete: %d/4", notNull)
	}

	if err := goose.DownTo(database, "migrations", 122); err != nil {
		t.Fatalf("I2 rollback must remove only I2 columns: %v", err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note'
		AND column_name LIKE 'decompose%'`).Scan(&columns); err != nil {
		t.Fatal(err)
	}
	if columns != 0 {
		t.Fatalf("I2 rollback left columns behind: %d", columns)
	}
	var legacy int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='benchmark_note'
		AND column_name IN ('structure','structure_hash','takeaways','not_borrowable','revision','ai_call_id')`).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy != 6 {
		t.Fatalf("I2 rollback removed legacy columns: %d/6", legacy)
	}
}
