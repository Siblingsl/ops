package db

// REF41 P4-A2：publish_channel_state 表结构、约束与回滚。
// docs/41 计划迁移号 00114 已被并发任务占用，本文件按实际 00116 验证；
// 不修改 00114/00115，也不伪造“计划号与实现一致”。

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestPublishChannelStateMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 116); err != nil {
		t.Fatalf("upgrade through 00116: %v", err)
	}

	var workspaceID, userID, accountID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('P4 通道状态迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"p4-channel-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO platform_account(workspace_id,platform,name,content_format)
		VALUES($1,'xhs','P4 小红书','image_note') RETURNING id`, workspaceID).Scan(&accountID); err != nil {
		t.Fatal(err)
	}

	if _, err := database.Exec(`INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version,last_success_at,calibrated_by)
		VALUES($1,'xhs','desktop','xhs-fill-v1',now(),$2)`, accountID, userID); err != nil {
		t.Fatalf("insert channel state: %v", err)
	}
	var version string
	if err := database.QueryRow(`SELECT adapter_version FROM publish_channel_state WHERE account_id=$1`, accountID).Scan(&version); err != nil || version != "xhs-fill-v1" {
		t.Fatalf("channel state version=%q err=%v", version, err)
	}
	if _, err := database.Exec(`INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version) VALUES($1,'xhs','desktop','xhs-fill-v2')`, accountID); err == nil ||
		!strings.Contains(err.Error(), "publish_channel_state_pkey") {
		t.Fatalf("重复 account/platform/channel 必须被主键拒绝: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version) VALUES($1,'weibo','desktop','x')`, accountID); err == nil ||
		!strings.Contains(err.Error(), "publish_channel_state_platform_check") {
		t.Fatalf("平台 CHECK 必须拒绝 weibo: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version,detail) VALUES($1,'xhs','manual','manual-v1','[]'::jsonb)`, accountID); err == nil ||
		!strings.Contains(err.Error(), "publish_channel_state_detail_check") {
		t.Fatalf("detail 必须是 object: %v", err)
	}

	// last_success_at 部分索引：名称、列、谓词逐项断言（P4-A2 证据缺口补齐）。
	var indexDef string
	if err := database.QueryRow(`SELECT indexdef FROM pg_indexes
		WHERE indexname='publish_channel_state_success'`).Scan(&indexDef); err != nil {
		t.Fatalf("last_success_at 部分索引必须存在: %v", err)
	}
	// pg_indexes.indexdef 输出带 schema 前缀（public.publish_channel_state）。
	if !strings.Contains(indexDef, "(last_success_at)") ||
		!strings.Contains(indexDef, "publish_channel_state USING btree") {
		t.Fatalf("索引列必须是 last_success_at: %s", indexDef)
	}
	if !strings.Contains(indexDef, "WHERE (last_success_at IS NOT NULL)") {
		t.Fatalf("索引谓词必须是 last_success_at IS NOT NULL: %s", indexDef)
	}

	if err := goose.DownTo(database, "migrations", 115); err != nil {
		t.Fatalf("rollback to 00115: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.tables WHERE table_name='publish_channel_state'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback must drop publish_channel_state: count=%d err=%v", count, err)
	}
	if err := goose.UpTo(database, "migrations", 116); err != nil {
		t.Fatalf("re-upgrade through 00116: %v", err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.tables WHERE table_name='publish_channel_state'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("re-upgrade must recreate publish_channel_state: count=%d err=%v", count, err)
	}
}
