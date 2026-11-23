package db

// REF41 F3-A1：job_run 表结构、唯一键抢占与回滚。
// docs/41 计划迁移号 00130 已被 A5 占用（D-211），00131–00136 已顺延，实际取 00137。

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestJobRunMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 137); err != nil {
		t.Fatalf("upgrade through 00137: %v", err)
	}

	now := time.Now()
	// 首次插入 running 成功。
	var runID uuid.UUID
	if err := database.QueryRow(`INSERT INTO job_run (job_key, scheduled_at) VALUES ('daily-brief', $1) RETURNING id`,
		now).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	// 唯一键抢占：同 key+scheduled_at 二次插入拒绝（NULL workspace 用 COALESCE 归一）。
	if _, err := database.Exec(`INSERT INTO job_run (job_key, scheduled_at) VALUES ('daily-brief', $1)`, now); err == nil {
		t.Fatal("duplicate slot must fail")
	}
	// 状态枚举：paused 拒绝。
	if _, err := database.Exec(`UPDATE job_run SET status='paused' WHERE id=$1`, runID); err == nil {
		t.Fatal("status=paused must fail")
	}
	// duration_ms 负值拒绝。
	if _, err := database.Exec(`UPDATE job_run SET duration_ms=-1 WHERE id=$1`, runID); err == nil {
		t.Fatal("negative duration must fail")
	}
	// job_key 长度边界。
	if _, err := database.Exec(`INSERT INTO job_run (job_key, scheduled_at) VALUES ('', $1)`, now); err == nil {
		t.Fatal("empty job_key must fail")
	}
	// catch_up 默认 false。
	var catchUp bool
	if err := database.QueryRow(`SELECT catch_up FROM job_run WHERE id=$1`, runID).Scan(&catchUp); err != nil {
		t.Fatal(err)
	}
	if catchUp {
		t.Fatal("catch_up default must be false")
	}

	// 回滚再前滚。
	if err := goose.DownTo(database, "migrations", 136); err != nil {
		t.Fatalf("down to 00136: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 137); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}
