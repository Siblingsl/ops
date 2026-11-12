package db

import (
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// DEV-CU P4-1（docs/36 §4.10）：agent_computer_command 命令账本表的可逆迁移。
// 列集、CHECK、唯一约束与三个索引在空库可直接建；down 先清数据再 DROP（无被引用外键）。
func TestAgentComputerCommandMigrationReversible(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 106); err != nil {
		t.Fatalf("upgrade to 106 (agent_computer_grant ready): %v", err)
	}
	if err := goose.UpTo(database, "migrations", latestMigrationVersion(t)); err != nil {
		t.Fatalf("upgrade to 107: %v", err)
	}

	// 建一条合法命令（合法 state / 幂等唯一约束随行验证）
	var workspaceID, userID, conversationID, grantID, commandID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('电脑命令迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"cu-cmd-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`,
		workspaceID, userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_computer_grant(id, workspace_id,user_id,conversation_id,target_handle,scope,request_id)
		VALUES(gen_random_uuid(),$1,$2,$3,'th-00107','observe',gen_random_uuid()) RETURNING id`,
		workspaceID, userID, conversationID).Scan(&grantID); err != nil {
		t.Fatalf("seed grant: %v", err)
	}
	if err := database.QueryRow(`INSERT INTO agent_computer_command
		(id, grant_id, workspace_id, user_id, conversation_id, request_id, action_kind, target_ref, input_hash, state, requires_confirmation, generation)
		VALUES(gen_random_uuid(),$1,$2,$3,$4,gen_random_uuid(),'observe','@s000107:e1','hash000107','queued',false,0) RETURNING id`,
		grantID, workspaceID, userID, conversationID).Scan(&commandID); err != nil {
		t.Fatalf("insert queued command: %v", err)
	}

	// state CHECK 六值逐个验证（合法值可写、非法值被拒）
	for _, state := range []string{"dispatched", "succeeded", "failed", "unknown_outcome", "cancelled"} {
		if _, err := database.Exec(`UPDATE agent_computer_command SET state=$1 WHERE id=$2`, state, commandID); err != nil {
			t.Fatalf("state %q must be allowed by CHECK: %v", state, err)
		}
	}
	if _, err := database.Exec(`UPDATE agent_computer_command SET state='bogus' WHERE id=$1`, commandID); err == nil {
		t.Fatal("state outside CHECK must be rejected")
	}

	// 唯一约束：同 grant + 同 request 第二条必须被拒
	requestID := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO agent_computer_command
		(id, grant_id, workspace_id, user_id, conversation_id, request_id, action_kind, input_hash)
		VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'observe','h1')`, grantID, workspaceID, userID, conversationID, requestID); err != nil {
		t.Fatalf("first insert with request_id: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO agent_computer_command
		(id, grant_id, workspace_id, user_id, conversation_id, request_id, action_kind, input_hash)
		VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'observe','h2')`, grantID, workspaceID, userID, conversationID, requestID); err == nil {
		t.Fatal("UNIQUE(grant_id, request_id) must reject duplicates")
	}

	// 三个索引存在（sweep / grant 队列 / run 维度）
	for _, idx := range []string{
		"idx_agent_computer_command_sweep",
		"idx_agent_computer_command_grant",
		"idx_agent_computer_command_run",
	} {
		var n int
		if err := database.QueryRow(`SELECT count(*) FROM pg_indexes WHERE indexname=$1`, idx).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("index %s must exist after up", idx)
		}
	}

	// down：表被删；再升级可重放
	if err := goose.DownTo(database, "migrations", 106); err != nil {
		t.Fatalf("down to 106 (table empty): %v", err)
	}
	var exists int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.tables WHERE table_name='agent_computer_command'`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists != 0 {
		t.Fatal("agent_computer_command must be dropped after down")
	}
	if err := goose.UpTo(database, "migrations", latestMigrationVersion(t)); err != nil {
		t.Fatalf("re-upgrade through 107: %v", err)
	}
	var again int
	if err := database.QueryRow(`SELECT count(*) FROM agent_computer_command WHERE id=$1`, commandID).Scan(&again); err != nil {
		t.Fatalf("table must be usable after re-upgrade: %v", err)
	}
}
