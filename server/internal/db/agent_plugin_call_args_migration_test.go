package db

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// CF-DESK-03（90 D-186）：00109 增列可回退、非空快照拒绝降级、事件白名单随版本进出。
func TestAgentPluginCallArgsMigrationGuardsRollbackAndRegistersEventType(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 108); err != nil {
		t.Fatal(err)
	}
	if hasColumn(t, database, "agent_plugin_call", "args_json") {
		t.Fatal("00108 不应已有 args_json")
	}
	if strings.Contains(eventConstraint(t, database), "mcp.call_requested") {
		t.Fatal("00108 不应登记 mcp.call_requested")
	}

	if err := goose.UpTo(database, "migrations", 109); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"args_json", "result_json", "input_schema_hash", "catalog_revision", "protocol_version", "result_hash"} {
		if !hasColumn(t, database, "agent_plugin_call", column) {
			t.Fatalf("00109 缺少列 %s", column)
		}
	}
	if !strings.Contains(eventConstraint(t, database), "mcp.call_requested") {
		t.Fatal("00109 应登记 mcp.call_requested 事件类型")
	}

	var workspace, user, connection string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('插件调用迁移') RETURNING id`).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`, "w14mig-"+uuid.NewString()[:8]).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_plugin_connection(id,workspace_id,user_id,name,transport,command)
		VALUES($1,$2,$3,'迁移连接','stdio','node') RETURNING id`, uuid.New(), workspace, user).Scan(&connection); err != nil {
		t.Fatal(err)
	}
	callID := uuid.New()
	if _, err := database.Exec(`INSERT INTO agent_plugin_call
		(id,connection_id,workspace_id,user_id,tool_name,request_id,input_hash,state,args_json,result_json)
		VALUES($1,$2,$3,$4,'mcp__mig__echo',$5,'hash','succeeded','{"text":"[REDACTED]"}','{"echo":"ok"}')`,
		callID, connection, workspace, user, uuid.New()); err != nil {
		t.Fatal(err)
	}

	if err := goose.DownTo(database, "migrations", 108); err == nil || !strings.Contains(err.Error(), "refusing downgrade") {
		t.Fatalf("非空快照必须拒绝降级：%v", err)
	}
	if !hasColumn(t, database, "agent_plugin_call", "args_json") {
		t.Fatal("拒绝降级后不得丢列")
	}

	if _, err := database.Exec(`UPDATE agent_plugin_call SET args_json=NULL, result_json=NULL WHERE id=$1`, callID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 108); err != nil {
		t.Fatalf("无快照时应可安全回退：%v", err)
	}
	if hasColumn(t, database, "agent_plugin_call", "args_json") {
		t.Fatal("回退后应删除 args_json")
	}
	if strings.Contains(eventConstraint(t, database), "mcp.call_requested") {
		t.Fatal("回退后不应保留 mcp.call_requested")
	}
	if err := goose.UpTo(database, "migrations", 109); err != nil {
		t.Fatalf("再次升级失败：%v", err)
	}
}

func hasColumn(t *testing.T, database *sql.DB, table, column string) bool {
	t.Helper()
	var exists bool
	if err := database.QueryRow(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema='public' AND table_name=$1 AND column_name=$2)`, table, column).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	return exists
}

func eventConstraint(t *testing.T, database *sql.DB) string {
	t.Helper()
	var def string
	if err := database.QueryRow(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname='agent_event_type_check'`).Scan(&def); err != nil {
		if err == sql.ErrNoRows {
			return ""
		}
		t.Fatal(err)
	}
	return def
}
