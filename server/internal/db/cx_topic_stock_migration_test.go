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
	if _, err := database.Exec(`INSERT INTO topic(account_id,title,source,status,deleted_at) VALUES ($1,'已删除待定','manual','pending',now())`, accountID); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := database.QueryRow(`SELECT count(*) FROM topic WHERE account_id=$1`, accountID).Scan(&before); err != nil || before != 4 {
		t.Fatalf("迁移前数量: %d %v", before, err)
	}
	if err := goose.UpTo(database, "migrations", 88); err != nil {
		t.Fatal(err)
	}
	var after, mismatched, fabricated int
	if err := database.QueryRow(`SELECT count(*), count(*) FILTER (WHERE stock_status <> CASE status WHEN 'adopted' THEN 'used' WHEN 'dropped' THEN 'dropped' ELSE 'idea' END), count(*) FILTER (WHERE verified_at IS NOT NULL OR used_at IS NOT NULL OR stock_changed_at IS NOT NULL) FROM topic WHERE account_id=$1`, accountID).Scan(&after, &mismatched, &fabricated); err != nil {
		t.Fatal(err)
	}
	if after != before || mismatched != 0 || fabricated != 0 {
		t.Fatalf("迁移后数量/映射/伪造时间: %d/%d/%d", after, mismatched, fabricated)
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

func TestCXTopicStockMigrationRejectsRollbackWithSavedPolicy(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 88); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	accountID := legacy.accountIDs[0]
	if _, err := database.Exec(`INSERT INTO account_profile(account_id,topic_stock_policy) VALUES ($1,'{"target_ready":20,"warn_ready":8}'::jsonb)`, accountID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 85); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("保存过库存配置时降级必须拒绝: %v", err)
	}
	var target int
	if err := database.QueryRow(`SELECT (topic_stock_policy->>'target_ready')::int FROM account_profile WHERE account_id=$1`, accountID).Scan(&target); err != nil || target != 20 {
		t.Fatalf("拒绝回滚必须保留配置: %d %v", target, err)
	}
	// 仅修改本测试的临时库，证明没有新增库存事实时可按顺序降级及重升级。
	if _, err := database.Exec(`UPDATE account_profile SET topic_stock_policy='{}'::jsonb WHERE account_id=$1`, accountID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 85); err != nil {
		t.Fatalf("无库存事实时降级: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 88); err != nil {
		t.Fatalf("重新升级: %v", err)
	}
	var policy string
	if err := database.QueryRow(`SELECT topic_stock_policy::text FROM account_profile WHERE account_id=$1`, accountID).Scan(&policy); err != nil || policy != "{}" {
		t.Fatalf("重新升级保留账号: %q %v", policy, err)
	}
}
