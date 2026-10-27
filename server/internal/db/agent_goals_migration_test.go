package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentGoalsMigrationAndRollbackGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 68); err != nil {
		t.Fatalf("upgrade through 00068: %v", err)
	}
	var workspaceID, userID, conversationID, queuedRunID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('队列目标迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"aw-queue-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`,
		workspaceID, userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,session_id,trigger,status)
		VALUES($1,$2,$3,gen_random_uuid(),'queue','completed') RETURNING id`, conversationID, workspaceID, userID).Scan(&queuedRunID); err != nil {
		t.Fatalf("insert historical queue run: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 69); err != nil {
		t.Fatalf("upgrade through 00069 with historical queue run: %v", err)
	}
	var trigger string
	if err := database.QueryRow(`SELECT trigger FROM agent_run WHERE id=$1`, queuedRunID).Scan(&trigger); err != nil || trigger != "queue" {
		t.Fatalf("00069 must preserve historical queue trigger: trigger=%q err=%v", trigger, err)
	}
	if err := goose.DownTo(database, "migrations", 68); err != nil {
		t.Fatalf("empty goals and trigger extension should roll back with historical queue run: %v", err)
	}
	if err := database.QueryRow(`SELECT trigger FROM agent_run WHERE id=$1`, queuedRunID).Scan(&trigger); err != nil || trigger != "queue" {
		t.Fatalf("safe rollback must preserve historical queue trigger: trigger=%q err=%v", trigger, err)
	}
	if err := goose.UpTo(database, "migrations", 69); err != nil {
		t.Fatalf("re-upgrade through 00069: %v", err)
	}
	var goalID string
	if err := database.QueryRow(`INSERT INTO agent_goal(conversation_id,workspace_id,user_id,objective,criteria)
		VALUES($1,$2,$3,'整理账号近期运营问题','[{"id":"c1","text":"定位问题"}]') RETURNING id`,
		conversationID, workspaceID, userID).Scan(&goalID); err != nil {
		t.Fatalf("insert private goal: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,session_id,trigger,goal_id)
		VALUES($1,$2,$3,$4,'goal',$5)`, conversationID, workspaceID, userID, uuid.New(), goalID); err != nil {
		t.Fatalf("insert goal run: %v", err)
	}
	if err := goose.DownTo(database, "migrations", 68); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("migration must refuse rollback while goal/run data exists: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM agent_goal WHERE id=$1`, goalID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("refused rollback must preserve goal: count=%d err=%v", count, err)
	}
}
