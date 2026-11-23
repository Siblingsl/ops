package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

// REF41 A3-A1：能力缺口表字段、唯一键与状态约束；迁移可回退。
func TestAgentCapabilityGapMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 127); err != nil {
		t.Fatal(err)
	}

	var exists bool
	if err := database.QueryRow(`SELECT to_regclass('public.agent_capability_gap') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("missing table agent_capability_gap")
	}

	var cols int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='agent_capability_gap'
		AND column_name IN ('id','workspace_id','requested_by','run_id','gap_key','title','detail',
		 'request_count','status','created_at','updated_at')`).Scan(&cols); err != nil {
		t.Fatal(err)
	}
	if cols != 11 {
		t.Fatalf("agent_capability_gap columns = %d, want 11", cols)
	}

	var statusDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='agent_capability_gap'
		AND c.conname='agent_capability_gap_status_check'`).Scan(&statusDef); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"open", "planned", "declined"} {
		if !strings.Contains(statusDef, "'"+status+"'") {
			t.Fatalf("status CHECK missing %s: %s", status, statusDef)
		}
	}

	var uniqueDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='agent_capability_gap'
		AND c.conname='agent_capability_gap_workspace_id_gap_key_key'`).Scan(&uniqueDef); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(uniqueDef, "UNIQUE") || !strings.Contains(uniqueDef, "workspace_id") ||
		!strings.Contains(uniqueDef, "gap_key") {
		t.Fatalf("workspace+gap_key unique constraint missing: %s", uniqueDef)
	}

	var notNull int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='agent_capability_gap'
		AND column_name IN ('workspace_id','gap_key','title','request_count','status')
		AND is_nullable='NO'`).Scan(&notNull); err != nil {
		t.Fatal(err)
	}
	if notNull != 5 {
		t.Fatalf("required columns must be NOT NULL, got %d", notNull)
	}

	var fkCount int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.table_constraints
		WHERE table_schema='public' AND table_name='agent_capability_gap'
		AND constraint_type='FOREIGN KEY'`).Scan(&fkCount); err != nil {
		t.Fatal(err)
	}
	if fkCount < 3 {
		t.Fatalf("workspace/requested_by/run_id foreign keys missing, got %d", fkCount)
	}

	if err := goose.DownTo(database, "migrations", 126); err != nil {
		t.Fatalf("A3 rollback: %v", err)
	}
	if err := database.QueryRow(`SELECT to_regclass('public.agent_capability_gap') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("rollback left agent_capability_gap")
	}
}
