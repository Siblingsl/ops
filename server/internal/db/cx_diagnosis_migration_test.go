package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestCXDiagnosisMigrationIsolationAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 72); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 73); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	if err := goose.DownTo(database, "migrations", 72); err != nil {
		t.Fatalf("empty report table should roll back: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 73); err != nil {
		t.Fatalf("upgrade after empty rollback: %v", err)
	}
	assertLegacyPlatformData(t, database, legacy)
	var workspace string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, legacy.accountIDs[0]).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO content_diagnosis(workspace_id,account_id,kind,input_hash,context_hash,input_scope,result,rules_version) VALUES($1,$2,'account_analysis',$3,'context','saved','{}','v1')`
	if _, err := database.Exec(insert, workspace, legacy.accountIDs[0], strings.Repeat("a", 64)); err != nil {
		t.Fatalf("insert valid report: %v", err)
	}
	other := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO workspace(id,name) VALUES($1,'其他工作区')`, other); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(insert, other, legacy.accountIDs[0], strings.Repeat("a", 64)); err == nil {
		t.Fatal("cross-workspace account accepted")
	}
	if _, err := database.Exec(insert, workspace, legacy.accountIDs[0], "invalid"); err == nil {
		t.Fatal("invalid hash accepted")
	}
	if _, err := database.Exec(`INSERT INTO content_diagnosis(workspace_id,account_id,kind,input_hash,context_hash,input_scope,result,rules_version,score) VALUES($1,$2,'account_analysis',$3,'context','saved','{}','v1',80)`, workspace, legacy.accountIDs[0], strings.Repeat("b", 64)); err == nil {
		t.Fatal("AI-only report accepted a score")
	}
	if err := goose.DownTo(database, "migrations", 72); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("must preserve reports on rollback: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM content_diagnosis`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("report lost: count=%d err=%v", count, err)
	}
}

func TestCXDiagnosisResultRevisionRollbackPreservesReports(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 73); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 74); err != nil {
		t.Fatalf("revision migration: %v", err)
	}
	var workspace string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, legacy.accountIDs[0]).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	inputHash := strings.Repeat("c", 64)
	if _, err := database.Exec(`INSERT INTO content_diagnosis(workspace_id,account_id,kind,input_hash,context_hash,input_scope,result,rules_version) VALUES($1,$2,'account_analysis',$3,'context','saved','{"overview":"保留的报告"}','v1')`, workspace, legacy.accountIDs[0], inputHash); err != nil {
		t.Fatal(err)
	}
	var revision int
	if err := database.QueryRow(`SELECT result_revision FROM content_diagnosis WHERE input_hash=$1`, inputHash).Scan(&revision); err != nil || revision != 1 {
		t.Fatalf("existing report should start at revision 1: revision=%d err=%v", revision, err)
	}
	if _, err := database.Exec(`UPDATE content_diagnosis SET result='{"overview":"人工已修改"}',result_revision=2 WHERE input_hash=$1`, inputHash); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 73); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("edited report must retain revision metadata: %v", err)
	}
	var result string
	if err := database.QueryRow(`SELECT result->>'overview' FROM content_diagnosis WHERE input_hash=$1`, inputHash).Scan(&result); err != nil || result != "人工已修改" {
		t.Fatalf("rollback must preserve the edited report: result=%q err=%v", result, err)
	}
	if _, err := database.Exec(`UPDATE content_diagnosis SET result_revision=1 WHERE input_hash=$1`, inputHash); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 73); err != nil {
		t.Fatalf("unmodified report can roll back revision metadata: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 74); err != nil {
		t.Fatalf("reapply revision migration: %v", err)
	}
	if err := database.QueryRow(`SELECT result->>'overview',result_revision FROM content_diagnosis WHERE input_hash=$1`, inputHash).Scan(&result, &revision); err != nil || result != "人工已修改" || revision != 1 {
		t.Fatalf("reapplying revision must preserve report content: result=%q revision=%d err=%v", result, revision, err)
	}
}

func TestCXProfileCheckMigrationRollbackPreservesSavedCheck(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 74); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if _, err := database.Exec(`INSERT INTO account_profile(account_id) VALUES ($1)`, legacy.accountIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 75); err != nil {
		t.Fatalf("profile check migration: %v", err)
	}
	var value string
	if err := database.QueryRow(`SELECT profile_check::text FROM account_profile WHERE account_id=$1`, legacy.accountIDs[0]).Scan(&value); err != nil || value != "{}" {
		t.Fatalf("legacy profiles should receive an empty check: value=%q err=%v", value, err)
	}
	if _, err := database.Exec(`UPDATE account_profile SET profile_check='{"input_hash":"kept"}' WHERE account_id=$1`, legacy.accountIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 74); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("saved homepage check must block destructive rollback: %v", err)
	}
	if err := database.QueryRow(`SELECT profile_check->>'input_hash' FROM account_profile WHERE account_id=$1`, legacy.accountIDs[0]).Scan(&value); err != nil || value != "kept" {
		t.Fatalf("rollback refusal must preserve saved check: value=%q err=%v", value, err)
	}
	if _, err := database.Exec(`UPDATE account_profile SET profile_check='{}' WHERE account_id=$1`, legacy.accountIDs[0]); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 74); err != nil {
		t.Fatalf("empty profile check can roll back: %v", err)
	}
}
