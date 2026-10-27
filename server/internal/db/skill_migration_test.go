package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// DEV-SK1 / 23 文档第 5.1 节第 7 项与 T-SK-26：有技能或私有记录时 Down 拒绝；
// 清理后空库可回退，再前滚恢复。
func TestSkillMigrationDownGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	freshDB, freshURL := newToutiaoMigrationTestDB(t)
	if err := Migrate(freshURL); err != nil {
		t.Fatalf("migrate fresh database: %v", err)
	}
	if version, err := goose.GetDBVersion(freshDB); err != nil || version != 70 {
		t.Fatalf("fresh migration version: got %d, err=%v", version, err)
	}
	var wsID, userID string
	if err := freshDB.QueryRow(`INSERT INTO workspace (name) VALUES ('技能迁移测试') RETURNING id`).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	if err := freshDB.QueryRow(`INSERT INTO app_user (username, password_hash) VALUES ($1, 'x') RETURNING id`,
		"sk-mig-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}

	// 有技能定义：Down 拒绝。
	if _, err := freshDB.Exec(`INSERT INTO skill (workspace_id, name, summary, triggers, instructions) VALUES ($1,'守卫','摘要','触发','正文')`, wsID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(freshDB, "migrations", 59); err == nil || !strings.Contains(err.Error(), "技能或私有记录仍存在") {
		t.Fatalf("down with skill must be rejected, got %v", err)
	}
	if _, err := freshDB.Exec(`DELETE FROM skill WHERE workspace_id=$1`, wsID); err != nil {
		t.Fatal(err)
	}

	// 有私有审计：Down 拒绝。
	if _, err := freshDB.Exec(`INSERT INTO audit_log (actor_id, workspace_id, action, target_type, target_id, result, visibility)
		VALUES ($1,$2,'skill_create','skill',$3,'ok','personal')`, userID, wsID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(freshDB, "migrations", 59); err == nil || !strings.Contains(err.Error(), "技能或私有记录仍存在") {
		t.Fatalf("down with personal audit must be rejected, got %v", err)
	}
	if _, err := freshDB.Exec(`DELETE FROM audit_log WHERE actor_id=$1 AND visibility='personal'`, userID); err != nil {
		t.Fatal(err)
	}

	// 空库可回退，且回退后可再次前滚。
	if err := goose.DownTo(freshDB, "migrations", 59); err != nil {
		t.Fatalf("empty down must succeed: %v", err)
	}
	if version, err := goose.GetDBVersion(freshDB); err != nil || version != 59 {
		t.Fatalf("down version: got %d, err=%v", version, err)
	}
	if err := goose.UpTo(freshDB, "migrations", 60); err != nil {
		t.Fatalf("re-up: %v", err)
	}
	if version, err := goose.GetDBVersion(freshDB); err != nil || version != 60 {
		t.Fatalf("re-up version: got %d, err=%v", version, err)
	}
}

// T-SK-29：SQL CHECK——归属恰一非空与双开关不同时关闭。
func TestSkillSQLConstraints(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	freshDB, freshURL := newToutiaoMigrationTestDB(t)
	if err := Migrate(freshURL); err != nil {
		t.Fatal(err)
	}
	var wsID, userID string
	if err := freshDB.QueryRow(`INSERT INTO workspace (name) VALUES ('技能约束测试') RETURNING id`).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	if err := freshDB.QueryRow(`INSERT INTO app_user (username, password_hash) VALUES ($1, 'x') RETURNING id`,
		"sk-ck-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	ins := func(cols string) error {
		_, err := freshDB.Exec(`INSERT INTO skill (`+cols+`, name, summary, triggers, instructions)
			VALUES ($1,$2,'名','摘','触','正文')`, wsID, userID)
		return err
	}
	if err := ins("workspace_id, user_id"); err == nil {
		t.Fatal("two owners must violate num_nonnulls CHECK")
	}
	bothOff := func() error {
		_, err := freshDB.Exec(`INSERT INTO skill (workspace_id, name, summary, triggers, instructions, task_enabled, agent_enabled)
			VALUES ($1,'名','摘','触','正文',false,false)`, wsID)
		return err
	}
	if err := bothOff(); err == nil {
		t.Fatal("both switches off must violate CHECK")
	}
	if _, err := freshDB.Exec(`INSERT INTO skill (workspace_id, name, summary, triggers, instructions, agent_enabled)
		VALUES ($1,'仅智能体','摘','触','正文',false)`, wsID); err != nil {
		t.Fatalf("task-only switch (task on, agent off) must be allowed: %v", err)
	}
}
