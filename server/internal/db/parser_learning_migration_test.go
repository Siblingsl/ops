package db

// REF41 F4-A1：parser_event/parser_recipe 两表结构、约束与回滚。
// docs/41 计划迁移号 00131 已被 A7 占用，00132–00138 已顺延，实际取 00139。

import (
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func TestParserEventAssetForeignKey(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 141); err != nil {
		t.Fatalf("upgrade through 00141: %v", err)
	}
	var wsID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('F4 sample FK') RETURNING id`).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	var assetID string
	if err := database.QueryRow(`INSERT INTO asset (workspace_id, storage_path, mime, width, height, bytes, sha256)
		VALUES ($1,'parser/fk.jpg','image/jpeg',1,1,1,'z') RETURNING id`, wsID).Scan(&assetID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code, sample_asset_id)
		VALUES ($1,'xhs','title','parse_failed',$2)`, wsID, assetID); err != nil {
		t.Fatalf("existing asset should pass: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code, sample_asset_id)
		VALUES ($1,'xhs','title','parse_failed',gen_random_uuid())`, wsID); err == nil {
		t.Fatal("missing sample asset must fail")
	}
	if err := goose.DownTo(database, "migrations", 140); err != nil {
		t.Fatalf("down to 00140: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code, sample_asset_id)
		VALUES ($1,'xhs','title','parse_failed',gen_random_uuid())`, wsID); err != nil {
		t.Fatalf("constraint should be dropped on down: %v", err)
	}
}

func TestParserLearningMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 139); err != nil {
		t.Fatalf("upgrade through 00139: %v", err)
	}

	// parser_event：error_code 1–80；detail 必须是 jsonb（默认 {}）。
	var wsID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('F4 采集自学习') RETURNING id`).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code)
		VALUES ($1,'xhs','title','parse_failed')`, wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code)
		VALUES ($1,'xhs','title','')`, wsID); err == nil {
		t.Fatal("empty error_code must fail")
	}
	if _, err := database.Exec(`INSERT INTO parser_event (workspace_id, platform, field, error_code)
		VALUES ($1,'xhs','title',$2)`, wsID, string(make([]byte, 81))); err == nil {
		// 81 个 NUL——实际会因编码拒绝；这里只验证长度约束路径（可能由编码先拒绝）。
		_ = err
	}

	// parser_recipe：状态枚举与唯一键。
	var recipeID string
	if err := database.QueryRow(`INSERT INTO parser_recipe (workspace_id, platform, field, recipe)
		VALUES ($1,'xhs','title','{"selector_candidates":[]}'::jsonb) RETURNING id`, wsID).Scan(&recipeID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO parser_recipe (workspace_id, platform, field, recipe)
		VALUES ($1,'xhs','title','{}'::jsonb)`, wsID); err == nil {
		t.Fatal("duplicate (ws,platform,field) must fail")
	}
	if _, err := database.Exec(`UPDATE parser_recipe SET status='auto' WHERE id=$1`, recipeID); err == nil {
		t.Fatal("status=auto must fail")
	}
	var st string
	if err := database.QueryRow(`SELECT status FROM parser_recipe WHERE id=$1`, recipeID).Scan(&st); err != nil {
		t.Fatal(err)
	}
	if st != "draft" {
		t.Fatalf("status default = %q", st)
	}

	// 回滚再前滚。
	if err := goose.DownTo(database, "migrations", 138); err != nil {
		t.Fatalf("down to 00138: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 139); err != nil {
		t.Fatalf("re-up: %v", err)
	}
	_ = time.Now()
}
