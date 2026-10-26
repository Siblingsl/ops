package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentWorkbenchMigrationUpgradeDefaultsAndDownGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, databaseURL := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 60); err != nil {
		t.Fatalf("migrate baseline through 00060: %v", err)
	}
	var workspaceID, userID, conversationID string
	if err := database.QueryRow(`INSERT INTO workspace (name) VALUES ('工作台迁移测试') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user (username, password_hash) VALUES ($1, 'x') RETURNING id`,
		"aw-mig-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation (workspace_id, user_id, title)
		VALUES ($1,$2,'历史会话') RETURNING id`, workspaceID, userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 61); err != nil {
		t.Fatalf("upgrade through 00061: %v", err)
	}
	var revision int64
	var mode string
	var readUpto int64
	var forceUnread bool
	var fixedContext []byte
	var archivedAt *string
	if err := database.QueryRow(`SELECT revision, mode, read_upto_message_seq, force_unread,
		fixed_context_refs, archived_at::text FROM agent_conversation WHERE id=$1`, conversationID).
		Scan(&revision, &mode, &readUpto, &forceUnread, &fixedContext, &archivedAt); err != nil {
		t.Fatal(err)
	}
	if revision != 1 || mode != "execute" || readUpto != 0 || forceUnread || string(fixedContext) != "[]" || archivedAt != nil {
		t.Fatalf("legacy conversation defaults changed: revision=%d mode=%s read=%d unread=%v refs=%s archived=%v",
			revision, mode, readUpto, forceUnread, fixedContext, archivedAt)
	}
	var flags int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema='public' AND table_name='agent_conversation' AND column_name IN
		('revision','archived_at','group_id','mode','reasoning_effort','read_upto_message_seq','force_unread','fixed_context_refs')`).Scan(&flags); err != nil || flags != 8 {
		t.Fatalf("phase A conversation schema columns=%d err=%v", flags, err)
	}
	var groupID string
	if err := database.QueryRow(`INSERT INTO agent_conversation_group (workspace_id,user_id,name)
		VALUES ($1,$2,'内容运营') RETURNING id`, workspaceID, userID).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE agent_conversation SET group_id=$1 WHERE id=$2`, groupID, conversationID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 60); err == nil || !strings.Contains(err.Error(), "工作台") {
		t.Fatalf("down with new workbench state must be rejected, got %v", err)
	}
	if _, err := database.Exec(`UPDATE agent_conversation SET group_id=NULL WHERE id=$1`, conversationID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DELETE FROM agent_conversation_group WHERE id=$1`, groupID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`DELETE FROM agent_conversation WHERE id=$1`, conversationID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 60); err != nil {
		t.Fatalf("empty down should succeed: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 61); err != nil {
		t.Fatalf("re-up through 00061: %v", err)
	}
	if err := Migrate(databaseURL); err != nil {
		t.Fatalf("complete migration chain after re-up: %v", err)
	}
}
