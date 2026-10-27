package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentRoutinesMigrationAndRollbackGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	emptyDB, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(emptyDB, "migrations", 69); err != nil {
		t.Fatalf("empty database upgrade through 00069: %v", err)
	}
	if err := goose.UpTo(emptyDB, "migrations", 70); err != nil {
		t.Fatalf("empty database upgrade through 00070: %v", err)
	}
	if err := goose.DownTo(emptyDB, "migrations", 69); err != nil {
		t.Fatalf("empty-data rollback through 00070: %v", err)
	}
	if err := goose.UpTo(emptyDB, "migrations", 70); err != nil {
		t.Fatalf("empty database re-up through 00070: %v", err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 69); err != nil {
		t.Fatalf("upgrade through 00069: %v", err)
	}
	var workspaceID, userID, accountID, conversationID, oldQueueRunID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('例行迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"aw-routine-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO platform_account(workspace_id,platform,name,content_format)
		VALUES($1,'wechat_mp','例行账号','long_article') RETURNING id`, workspaceID).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id,account_id)
		VALUES($1,$2,$3) RETURNING id`, workspaceID, userID, accountID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,session_id,trigger,status)
		VALUES($1,$2,$3,gen_random_uuid(),'queue','completed') RETURNING id`, conversationID, workspaceID, userID).Scan(&oldQueueRunID); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 70); err != nil {
		t.Fatalf("upgrade through 00070 with historical queue run: %v", err)
	}
	var queueTrigger string
	if err := database.QueryRow(`SELECT trigger FROM agent_run WHERE id=$1`, oldQueueRunID).Scan(&queueTrigger); err != nil || queueTrigger != "queue" {
		t.Fatalf("migration must preserve historical queue runs: trigger=%q err=%v", queueTrigger, err)
	}
	var providerID string
	if err := database.QueryRow(`INSERT INTO model_provider(workspace_id,name,base_url,api_key_enc,models)
		VALUES($1,'routine migration model','https://example.invalid',decode('','hex'),ARRAY['m']) RETURNING id`, workspaceID).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	var routineID, occurrenceID, runID string
	if err := database.QueryRow(`INSERT INTO agent_routine(workspace_id,user_id,account_id,name,prompt,cadence,
		time_of_day,timezone,destination,model_provider_id,model,next_due_at)
		VALUES($1,$2,$3,'每周报告','只读报告','daily','08:00','Asia/Shanghai','new',$4,'m',now()) RETURNING id`,
		workspaceID, userID, accountID, providerID).Scan(&routineID); err != nil {
		t.Fatalf("insert routine after upgrade: %v", err)
	}
	if err := database.QueryRow(`INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,status)
		VALUES($1,now(),gen_random_uuid(),'running') RETURNING id`, routineID).Scan(&occurrenceID); err != nil {
		t.Fatalf("insert routine occurrence: %v", err)
	}
	if err := database.QueryRow(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,trigger,status,execution_origin,
		routine_occurrence_id)
		VALUES($1,$2,$3,'routine','running','routine',$4) RETURNING id`, conversationID, workspaceID, userID, occurrenceID).Scan(&runID); err != nil {
		t.Fatalf("routine run must not require a user session: %v", err)
	}
	if _, err := database.Exec(`UPDATE agent_routine_occurrence SET run_id=$2 WHERE id=$1`, occurrenceID, runID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 69); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("migration must refuse rollback while routine data exists: %v", err)
	}
	var remaining int
	if err := database.QueryRow(`SELECT count(*) FROM agent_routine_occurrence WHERE id=$1`, occurrenceID).Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("refused rollback must preserve occurrence: count=%d err=%v", remaining, err)
	}
}
