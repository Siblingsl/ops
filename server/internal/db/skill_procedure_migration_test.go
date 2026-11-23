package db

// REF41 A5-A1：skill procedure 扩展列、origin 枚举放宽与回滚。
// docs/41 计划迁移号 00122 已被 I3 占用，本文件按实际 00130 验证（00129 已被并发 A6 agent_roles 占用，D-211 顺延）。

import (
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestSkillProcedureMigrationStructureAndRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 130); err != nil {
		t.Fatalf("upgrade through 00130: %v", err)
	}

	var workspaceID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('A5 技能流程迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}

	var skillID string
	if err := database.QueryRow(`INSERT INTO skill (workspace_id, name, summary, triggers, instructions, origin, procedure, procedure_version, distill_confidence)
		VALUES ($1,'发布流程','七步发布','发布作品时','步骤见 procedure','distilled',
			$2::jsonb, 1, 0.85) RETURNING id`,
		workspaceID,
		`[{"seq":1,"title":"确认平台","action":"读作品与账号定位","tool":"","inputs":{},"outputs":{},"requires":[],"gate":"confirm"}]`,
	).Scan(&skillID); err != nil {
		t.Fatalf("insert distilled skill with procedure: %v", err)
	}

	// origin 新值可写入，旧三值不受影响。
	var origin string
	if err := database.QueryRow(`SELECT origin FROM skill WHERE id=$1`, skillID).Scan(&origin); err != nil {
		t.Fatal(err)
	}
	if origin != "distilled" {
		t.Fatalf("origin = %q, want distilled", origin)
	}
	if _, err := database.Exec(`INSERT INTO skill (workspace_id, name, summary, triggers, instructions, origin)
		VALUES ($1,'手工技能','手工','何时用','正文','manual')`, workspaceID); err != nil {
		t.Fatalf("manual origin still valid: %v", err)
	}

	// distill_confidence 越界拒绝。
	if _, err := database.Exec(`UPDATE skill SET distill_confidence = 1.5 WHERE id=$1`, skillID); err == nil {
		t.Fatal("distill_confidence > 1 must be rejected")
	}

	// procedure 必须是数组。
	if _, err := database.Exec(`UPDATE skill SET procedure = '{"seq":1}'::jsonb WHERE id=$1`, skillID); err == nil {
		t.Fatal("procedure must stay an array")
	}

	// procedure_version 非负。
	if _, err := database.Exec(`UPDATE skill SET procedure_version = -1 WHERE id=$1`, skillID); err == nil {
		t.Fatal("negative procedure_version must be rejected")
	}

	// replay_policy 只允许 suggest_only。
	if _, err := database.Exec(`UPDATE skill SET replay_policy = 'auto' WHERE id=$1`, skillID); err == nil {
		t.Fatal("replay_policy other than suggest_only must be rejected")
	}
	var replay string
	if err := database.QueryRow(`SELECT replay_policy FROM skill WHERE id=$1`, skillID).Scan(&replay); err != nil {
		t.Fatal(err)
	}
	if replay != "suggest_only" {
		t.Fatalf("replay_policy default = %q, want suggest_only", replay)
	}

	// source_run_id 外键：不存在的 run 拒绝。
	if _, err := database.Exec(`UPDATE skill SET source_run_id = $2 WHERE id=$1`, skillID, uuid.NewString()); err == nil {
		t.Fatal("source_run_id FK must be enforced")
	}

	// 回滚到 00060 再前滚；先清掉 distilled 数据行，否则旧 origin 约束恢复会失败。
	if _, err := database.Exec(`DELETE FROM skill WHERE workspace_id=$1`, workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 60); err != nil {
		t.Fatalf("down to 00060: %v", err)
	}
	var procedureExists int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name='skill' AND column_name='procedure'`).Scan(&procedureExists); err != nil {
		t.Fatal(err)
	}
	if procedureExists != 0 {
		t.Fatal("procedure column must be dropped on down")
	}
	if err := goose.UpTo(database, "migrations", 130); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}
