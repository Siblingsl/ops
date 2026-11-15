package db

import (
	"database/sql"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// P0-3（CF-DESK-03 桌面消费接线）：00111 增 claimed_at 可回退、pending 部分索引随版本进出。
func TestAgentPluginCallClaimMigrationRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 110); err != nil {
		t.Fatal(err)
	}
	if hasColumn(t, database, "agent_plugin_call", "claimed_at") {
		t.Fatal("00110 不应已有 claimed_at")
	}

	if err := goose.UpTo(database, "migrations", 111); err != nil {
		t.Fatal(err)
	}
	if !hasColumn(t, database, "agent_plugin_call", "claimed_at") {
		t.Fatal("00111 缺少列 claimed_at")
	}
	if !hasIndex(t, database, "idx_agent_plugin_call_pending") {
		t.Fatal("00111 缺少 pending 部分索引")
	}

	var workspace, user, connection string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('插件领取迁移') RETURNING id`).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`, "mcpclaim-"+uuid.NewString()[:8]).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_plugin_connection(id,workspace_id,user_id,name,transport,command)
		VALUES($1,$2,$3,'迁移连接','stdio','node') RETURNING id`, uuid.New(), workspace, user).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_plugin_call
		(id,connection_id,workspace_id,user_id,tool_name,request_id,input_hash,state,claimed_at)
		VALUES($1,$2,$3,$4,'mcp__mig__echo',$5,'hash','dispatched',now())`,
		uuid.New(), connection, workspace, user, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 110); err != nil {
		t.Fatalf("00111 应可安全回退：%v", err)
	}
	if hasColumn(t, database, "agent_plugin_call", "claimed_at") {
		t.Fatal("回退后应删除 claimed_at")
	}
	if err := goose.UpTo(database, "migrations", 111); err != nil {
		t.Fatalf("再次升级失败：%v", err)
	}
}

func hasIndex(t *testing.T, database *sql.DB, name string) bool {
	t.Helper()
	var exists bool
	if err := database.QueryRow(`SELECT EXISTS (SELECT 1 FROM pg_indexes
		WHERE schemaname='public' AND indexname=$1)`, name).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}
