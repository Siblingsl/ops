package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestConversionAttributionMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 126); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"conversion_link", "conversion_event", "conversion_ingest_token"} {
		var exists bool
		if err := database.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("missing table %s", table)
		}
	}

	var sourceDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='conversion_link'
		AND c.conname='conversion_link_platform_check'`).Scan(&sourceDef); err != nil {
		t.Fatal(err)
	}
	for _, platform := range []string{"wechat_mp", "site", "youtube", "bilibili", "x", "other"} {
		if !strings.Contains(sourceDef, "'"+platform+"'") {
			t.Fatalf("conversion_link platform CHECK missing %s: %s", platform, sourceDef)
		}
	}
	if strings.Contains(sourceDef, "'xhs'") || strings.Contains(sourceDef, "'toutiao'") {
		t.Fatalf("conversion_link must not allow xhs/toutiao: %s", sourceDef)
	}

	var tokenDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='conversion_ingest_token'
		AND c.conname='conversion_ingest_token_token_hash_check'`).Scan(&tokenDef); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(tokenDef, "0-9a-f") {
		t.Fatalf("token_hash CHECK missing hex constraint: %s", tokenDef)
	}

	var activeIndex int
	if err := database.QueryRow(`SELECT count(*) FROM pg_indexes WHERE schemaname='public'
		AND tablename='conversion_link' AND indexname='conversion_link_work_platform_active'`).Scan(&activeIndex); err != nil {
		t.Fatal(err)
	}
	if activeIndex != 1 {
		t.Fatalf("active work+platform unique index missing: %d", activeIndex)
	}

	if err := goose.DownTo(database, "migrations", 125); err != nil {
		t.Fatalf("I7 rollback: %v", err)
	}
	for _, table := range []string{"conversion_link", "conversion_event", "conversion_ingest_token"} {
		var exists bool
		if err := database.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("rollback left table %s", table)
		}
	}
}
