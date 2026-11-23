package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func builtinSeedCounts(t *testing.T, workspaceID uuid.UUID) (roles, templates int) {
	t.Helper()
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_role
		WHERE workspace_id=$1 AND builtin_key IN ('topic_planner','reviewer','publisher')`,
		workspaceID).Scan(&roles); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM workflow_template
		WHERE workspace_id=$1 AND builtin_key IN ('benchmark_decompose','weekly_review','publish_prepare')`,
		workspaceID).Scan(&templates); err != nil {
		t.Fatal(err)
	}
	return roles, templates
}

// A6/A7：新建 workspace 必须立即可见三角色 + 三模板；重复 seed 不重复，
// 已停用的内置行不能被重新启用。
func TestA6A7BuiltinSeedOnWorkspaceCreate(t *testing.T) {
	var created struct {
		ID uuid.UUID `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/workspaces", map[string]any{
		"name": "A6A7 种子创建", "switch": false,
	}, &created)
	if created.ID == uuid.Nil {
		t.Fatal("create workspace returned empty id")
	}
	roles, templates := builtinSeedCounts(t, created.ID)
	if roles != 3 || templates != 3 {
		t.Fatalf("builtin seed after create = roles %d templates %d, want 3/3", roles, templates)
	}

	if _, err := env.srv.db.Exec(context.Background(), `UPDATE agent_role SET status='disabled'
		WHERE workspace_id=$1 AND builtin_key='reviewer'`, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workflow_template SET status='disabled'
		WHERE workspace_id=$1 AND builtin_key='weekly_review'`, created.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedWorkspaceBuiltins(context.Background(), created.ID)
	roles, templates = builtinSeedCounts(t, created.ID)
	if roles != 3 || templates != 3 {
		t.Fatalf("builtin seed after repeat = roles %d templates %d, want 3/3", roles, templates)
	}
	var roleStatus, templateStatus string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM agent_role
		WHERE workspace_id=$1 AND builtin_key='reviewer'`, created.ID).Scan(&roleStatus); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM workflow_template
		WHERE workspace_id=$1 AND builtin_key='weekly_review'`, created.ID).Scan(&templateStatus); err != nil {
		t.Fatal(err)
	}
	if roleStatus != "disabled" || templateStatus != "disabled" {
		t.Fatalf("disabled builtin was re-enabled: role=%q template=%q", roleStatus, templateStatus)
	}
}

// A6/A7：生产/非 dev 模式启动回填不能依赖 SeedDevModel；旧工作区也必须补齐。
func TestA6A7BuiltinSeedBackfillWithoutDev(t *testing.T) {
	oldDev := env.srv.cfg.Dev
	env.srv.cfg.Dev = false
	defer func() { env.srv.cfg.Dev = oldDev }()

	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO workspace(name) VALUES('A6A7 非 dev 回填') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.SeedWorkspaceBuiltins(context.Background()); err != nil {
		t.Fatal(err)
	}
	roles, templates := builtinSeedCounts(t, workspaceID)
	if roles != 3 || templates != 3 {
		t.Fatalf("non-dev backfill = roles %d templates %d, want 3/3", roles, templates)
	}
	if err := env.srv.SeedWorkspaceBuiltins(context.Background()); err != nil {
		t.Fatal(err)
	}
	roles, templates = builtinSeedCounts(t, workspaceID)
	if roles != 3 || templates != 3 {
		t.Fatalf("non-dev repeat backfill = roles %d templates %d, want 3/3", roles, templates)
	}
}
