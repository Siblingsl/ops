package db

// REF41 A8-A1：agent_run 成本字段、非负约束、provider 价格约束与回退回滚。

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestAgentCostMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 128); err != nil {
		t.Fatal(err)
	}

	var cols int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='agent_run'
		AND column_name IN ('cost_micros','cost_currency')`).Scan(&cols); err != nil {
		t.Fatal(err)
	}
	if cols != 2 {
		t.Fatalf("agent_run cost columns = %d, want 2", cols)
	}

	var costDef, currencyDef string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='agent_run'
		AND c.conname='agent_run_cost_micros_nonnegative'`).Scan(&costDef); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(costDef, "cost_micros IS NULL") || !strings.Contains(costDef, ">= 0") {
		t.Fatalf("cost_micros CHECK missing: %s", costDef)
	}
	if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
		JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='agent_run'
		AND c.conname='agent_run_cost_currency_nonempty'`).Scan(&currencyDef); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(currencyDef, "cost_currency <>") {
		t.Fatalf("cost_currency CHECK missing: %s", currencyDef)
	}

	for _, name := range []string{
		"model_provider_input_price_micros_nonnegative",
		"model_provider_output_price_micros_nonnegative",
	} {
		var def string
		if err := database.QueryRow(`SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
			JOIN pg_class t ON t.oid=c.conrelid WHERE t.relname='model_provider'
			AND c.conname=$1`, name).Scan(&def); err != nil {
			t.Fatalf("missing %s: %v", name, err)
		}
		if !strings.Contains(def, ">= 0") {
			t.Fatalf("%s does not enforce nonnegative price: %s", name, def)
		}
	}

	// A2 已有价格字段仍在；A8 的 Down 只回退成本列，不删除 A2 字段。
	if err := goose.DownTo(database, "migrations", 127); err != nil {
		t.Fatalf("A8 rollback: %v", err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='agent_run'
		AND column_name IN ('cost_micros','cost_currency')`).Scan(&cols); err != nil {
		t.Fatal(err)
	}
	if cols != 0 {
		t.Fatalf("rollback left %d cost columns", cols)
	}
	var priceCols int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='model_provider'
		AND column_name IN ('input_price_micros_per_1k','output_price_micros_per_1k','price_currency')`).Scan(&priceCols); err != nil {
		t.Fatal(err)
	}
	if priceCols != 3 {
		t.Fatalf("A8 rollback must keep A2 price columns, got %d", priceCols)
	}
}
