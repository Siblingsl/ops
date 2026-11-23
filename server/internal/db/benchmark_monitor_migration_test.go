package db

import (
	"testing"

	"github.com/pressly/goose/v3"
)

func TestBenchmarkMonitorMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 121); err != nil {
		t.Fatal(err)
	}

	var observationTable, taskTable, noteIndex int
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='benchmark_metric_observation'),
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='benchmark_observe_task'),
		(SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='benchmark_note_external')`).
		Scan(&observationTable, &taskTable, &noteIndex); err != nil {
		t.Fatal(err)
	}
	if observationTable != 1 || taskTable != 1 || noteIndex != 1 {
		t.Fatalf("I1 schema missing: observation=%d task=%d note_external_index=%d", observationTable, taskTable, noteIndex)
	}

	var targetColumns, noteColumns int
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='benchmark_target'
			AND column_name IN ('monitor_enabled','monitor_interval_hours','last_observed_at','next_observe_at','external_key')),
		(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='benchmark_note'
			AND column_name IN ('platform','external_id','published_at','first_seen_at','last_seen_at'))`).
		Scan(&targetColumns, &noteColumns); err != nil {
		t.Fatal(err)
	}
	if targetColumns != 5 || noteColumns != 5 {
		t.Fatalf("I1 columns incomplete: target=%d/5 note=%d/5", targetColumns, noteColumns)
	}

	if err := goose.DownTo(database, "migrations", 120); err != nil {
		t.Fatalf("I1 rollback must remove only I1 schema: %v", err)
	}
	if err := database.QueryRow(`SELECT
		(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('benchmark_metric_observation','benchmark_observe_task')),
		(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='benchmark_target' AND column_name='monitor_enabled')`).
		Scan(&observationTable, &taskTable); err != nil {
		t.Fatal(err)
	}
	if observationTable != 0 || taskTable != 0 {
		t.Fatalf("I1 rollback left schema behind: observation=%d task=%d", observationTable, taskTable)
	}
}
