package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestCXVisualDNAMigrationSchemaAndRollbackProtection(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 76); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 77); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name='account_visual_dna'`).Scan(&count); err != nil || count != 6 {
		t.Fatalf("visual DNA must have the documented six columns: count=%d err=%v", count, err)
	}
	if _, err := database.Exec(`INSERT INTO account_visual_dna(account_id,version,tokens,tokens_hash)
		VALUES($1,1,'{"schema":"ops.visual-dna/v1"}',$2)`, legacy.accountIDs[0], strings.Repeat("a", 64)); err != nil {
		t.Fatalf("insert valid historical version: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO account_visual_dna(account_id,version,tokens,tokens_hash)
		VALUES($1,1,'{}',$2)`, legacy.accountIDs[0], strings.Repeat("b", 64)); err == nil {
		t.Fatal("version primary key must reject a duplicate account/version pair")
	}
	if err := goose.DownTo(database, "migrations", 76); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("saved DNA versions must block destructive rollback: %v", err)
	}
	var stillThere int
	if err := database.QueryRow(`SELECT count(*) FROM account_visual_dna WHERE account_id=$1 AND version=1`, legacy.accountIDs[0]).Scan(&stillThere); err != nil || stillThere != 1 {
		t.Fatalf("rollback refusal must preserve token history: count=%d err=%v", stillThere, err)
	}
	if _, err := database.Exec(`INSERT INTO account_visual_dna(account_id,version,tokens,tokens_hash) VALUES($1,$2,'[]',$3)`, legacy.accountIDs[0], 2, strings.Repeat("c", 64)); err == nil {
		t.Fatal("tokens must be a JSON object")
	}
	if _, err := database.Exec(`INSERT INTO account_visual_dna(account_id,version,tokens,tokens_hash) VALUES($1,$2,'{}',$3)`, uuid.New(), 2, strings.Repeat("d", 64)); err == nil {
		t.Fatal("account foreign key must reject an unknown account")
	}
}
