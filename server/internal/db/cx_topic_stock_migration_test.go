package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

func TestCXTopicStockMigrationPreservesLegacyFacts(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 85); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	accountID := legacy.accountIDs[0]
	for _, status := range []string{"pending", "adopted", "dropped"} {
		if _, err := database.Exec(`INSERT INTO topic(account_id,title,source,status) VALUES ($1,$2,'manual',$2)`, accountID, status); err != nil {
			t.Fatal(err)
		}
	}
	if err := goose.UpTo(database, "migrations", 87); err != nil {
		t.Fatal(err)
	}
	for status, stock := range map[string]string{"pending": "idea", "adopted": "used", "dropped": "dropped"} {
		var actual string
		var missing bool
		if err := database.QueryRow(`SELECT stock_status, verified_at IS NULL AND used_at IS NULL AND stock_changed_at IS NULL FROM topic WHERE account_id=$1 AND title=$2`, accountID, status).Scan(&actual, &missing); err != nil {
			t.Fatal(err)
		}
		if actual != stock || !missing {
			t.Fatalf("%s: stock=%s missing=%v", status, actual, missing)
		}
	}
	if _, err := database.Exec(`UPDATE topic SET stock_changed_at=now() WHERE account_id=$1 AND title='dropped'`, accountID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 86); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("有事件时间时回滚应拒绝: %v", err)
	}
}
