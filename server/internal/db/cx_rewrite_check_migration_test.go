package db

import (
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
)

// DEV-CX12 / FR-CX-15：check_item 支持 category=rewrite 与 resolution_note 列。
func TestCXRewriteCheckMigrationConstraintsAndRollbackProtection(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 80); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 81); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	// rewrite 类别可写入；resolution_note 默认空串。
	if _, err := database.Exec(`INSERT INTO check_run (work_id, revision, target_platform, fact_status)
		VALUES ($1, 1, 'wechat_mp', 'skipped')`, legacy.workIDs[0]); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	var runID string
	if err := database.QueryRow(`SELECT id FROM check_run WHERE work_id=$1 ORDER BY created_at DESC LIMIT 1`, legacy.workIDs[0]).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO check_item (check_run_id, category, passed, fingerprint, message)
		VALUES ($1, 'rewrite', false, 'fp-rewrite-1', '改写度：与参考正文明显同源')`, runID); err != nil {
		t.Fatalf("rewrite category must be storable: %v", err)
	}
	if _, err := database.Exec(`UPDATE check_item SET resolution='acknowledged', resolution_note='确认这是本人早前发布的另一篇稿件' WHERE fingerprint='fp-rewrite-1'`); err != nil {
		t.Fatalf("resolution_note must be storable: %v", err)
	}
	var note string
	if err := database.QueryRow(`SELECT resolution_note FROM check_item WHERE fingerprint='fp-rewrite-1'`).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "本人早前发布") {
		t.Fatalf("note roundtrip: %s", note)
	}
	// 非法类别仍被约束拒绝。
	if _, err := database.Exec(`INSERT INTO check_item (check_run_id, category, passed, fingerprint, message)
		VALUES ($1, 'invented', false, 'fp-x', 'x')`, runID); err == nil {
		t.Fatal("unknown category must be rejected")
	}
	// 回滚保护：含 rewrite 项时回滚应被 category 约束重建阻断……回滚删除列与改约束不删除数据，
	// 但 rewrite 行会违反旧 category 约束，goose Down 会失败——这是期望的保护行为。
	if err := goose.DownTo(database, "migrations", 80); err == nil {
		t.Fatal("rollback with rewrite rows must fail (constraint would reject existing data)")
	}
}
