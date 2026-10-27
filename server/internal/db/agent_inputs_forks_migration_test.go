package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentInputsForksMigrationAndRollbackGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 68); err != nil {
		t.Fatalf("upgrade through 00068: %v", err)
	}
	if err := goose.DownTo(database, "migrations", 66); err != nil {
		t.Fatalf("empty input, branch, and message source data should roll back safely: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 68); err != nil {
		t.Fatalf("re-upgrade through 00068: %v", err)
	}

	var workspaceID, userID, conversationID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('输入分支迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"aw-input-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`,
		workspaceID, userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_input(conversation_id,workspace_id,user_id,kind,request_id,payload_hash,text)
		VALUES($1,$2,$3,'queue',$4,$5,'等待当前任务后执行')`, conversationID, workspaceID, userID,
		uuid.NewString(), strings.Repeat("a", 64)); err != nil {
		t.Fatalf("insert durable queued input: %v", err)
	}
	var inputID uuid.UUID
	if err := database.QueryRow(`SELECT id FROM agent_input WHERE conversation_id=$1`, conversationID).Scan(&inputID); err != nil {
		t.Fatal(err)
	}
	var messageID uuid.UUID
	if err := database.QueryRow(`INSERT INTO agent_message(conversation_id,seq,role,source_input_id)
		VALUES($1,1,'user',$2) RETURNING id`, conversationID, inputID).Scan(&messageID); err != nil {
		t.Fatalf("insert input source link: %v", err)
	}
	var otherConversationID uuid.UUID
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`, workspaceID, userID).Scan(&otherConversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_message(conversation_id,seq,role,source_input_id) VALUES($1,1,'user',$2)`, otherConversationID, inputID); err == nil {
		t.Fatal("cross-conversation input source must be rejected")
	}
	if err := goose.DownTo(database, "migrations", 67); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("migration must reject rollback while message source links exist: %v", err)
	}
	var sourceCount int
	if err := database.QueryRow(`SELECT count(*) FROM agent_message WHERE id=$1 AND source_input_id=$2`, messageID, inputID).Scan(&sourceCount); err != nil || sourceCount != 1 {
		t.Fatalf("refused 00068 rollback must preserve source link: count=%d err=%v", sourceCount, err)
	}
	if _, err := database.Exec(`DELETE FROM agent_message WHERE id=$1`, messageID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 66); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("migration must reject rollback while inputs exist: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM agent_input WHERE conversation_id=$1`, conversationID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("refused rollback must preserve queued input: count=%d err=%v", count, err)
	}
}
