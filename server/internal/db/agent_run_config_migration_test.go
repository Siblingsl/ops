package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentRunConfigMigrationKeepsHistoricalUnknownAndGuardsRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 64); err != nil {
		t.Fatal(err)
	}
	var workspace, user, conversation, run string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('模式快照迁移') RETURNING id`).Scan(&workspace); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`, "aw07-"+uuid.NewString()[:8]).Scan(&user); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`, workspace, user).Scan(&conversation); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,session_id,trigger,status) VALUES($1,$2,$3,gen_random_uuid(),'message','completed') RETURNING id`, conversation, workspace, user).Scan(&run); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 65); err != nil {
		t.Fatal(err)
	}
	var mode, origin, snapshot string
	if err := database.QueryRow(`SELECT mode,execution_origin,config_snapshot::text FROM agent_run WHERE id=$1`, run).Scan(&mode, &origin, &snapshot); err != nil {
		t.Fatal(err)
	}
	if mode != "execute" || origin != "interactive" || snapshot != "{}" {
		t.Fatalf("历史运行不得伪造配置：mode=%s origin=%s snapshot=%s", mode, origin, snapshot)
	}
	if err := goose.DownTo(database, "migrations", 64); err != nil {
		t.Fatalf("只有历史默认值应可安全回退：%v", err)
	}
	if err := goose.UpTo(database, "migrations", 65); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE agent_conversation SET mode='plan' WHERE id=$1`, conversation); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 64); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("新模式不能回滚到忽略模式的旧运行：%v", err)
	}
	if _, err := database.Exec(`UPDATE agent_conversation SET mode='execute' WHERE id=$1`, conversation); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE agent_run SET config_snapshot='{"version":1}' WHERE id=$1`, run); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 64); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("新快照必须保留：%v", err)
	}
	if err := database.QueryRow(`SELECT config_snapshot::text FROM agent_run WHERE id=$1`, run).Scan(&snapshot); err != nil || !strings.Contains(snapshot, "version") {
		t.Fatalf("失败回退丢失新快照：%s %v", snapshot, err)
	}
}
