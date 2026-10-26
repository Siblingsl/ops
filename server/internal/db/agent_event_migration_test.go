package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentEventMigrationPreservesUnreadAndGuardsNewData(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 62); err != nil {
		t.Fatal(err)
	}
	var workspaceID, userID string
	if err := database.QueryRow(`INSERT INTO workspace (name) VALUES ('事件迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user (username,password_hash) VALUES ($1,'x') RETURNING id`,
		"aw-event-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	conversations := []string{}
	for _, read := range []bool{true, false} {
		var id string
		if err := database.QueryRow(`INSERT INTO agent_conversation (workspace_id,user_id) VALUES ($1,$2) RETURNING id`,
			workspaceID, userID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		conversations = append(conversations, id)
		if _, err := database.Exec(`INSERT INTO agent_message (conversation_id,seq,role,content) VALUES ($1,1,'assistant','历史答复')`, id); err != nil {
			t.Fatal(err)
		}
		if read {
			if _, err := database.Exec(`UPDATE agent_conversation SET read_upto_message_seq=1 WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := goose.UpTo(database, "migrations", 63); err != nil {
		t.Fatal(err)
	}
	for i, id := range conversations {
		var next, read int64
		var unread bool
		var baselines, saved int
		if err := database.QueryRow(`SELECT next_event_seq,read_upto_event_seq,force_unread,
			(SELECT count(*) FROM agent_event WHERE conversation_id=c.id AND type='conversation.updated'),
			(SELECT count(*) FROM agent_event WHERE conversation_id=c.id AND type='message.saved')
			FROM agent_conversation c WHERE id=$1`, id).Scan(&next, &read, &unread, &baselines, &saved); err != nil {
			t.Fatal(err)
		}
		if next != 1 || read != 1 || unread != (i == 1) || baselines != 1 || saved != 0 {
			t.Fatalf("历史阅读基线错误：next=%d read=%d unread=%v baseline=%d saved=%d", next, read, unread, baselines, saved)
		}
	}
	// 只有迁移生成的基线时可安全回退；新运行/事件事实存在时必须前滚修复。
	if err := goose.DownTo(database, "migrations", 62); err != nil {
		t.Fatalf("仅基线事件应允许无损回退：%v", err)
	}
	if err := goose.UpTo(database, "migrations", 63); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_event (conversation_id,event_seq,type,payload,expires_at)
		VALUES ($1,2,'message.delta','{"message_key":"migration-check","text":"partial","chunk_index":1}',now()+interval '7 days')`, conversations[0]); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 62); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("存在新事件应拒绝破坏性回滚：%v", err)
	}
	var deltas int
	if err := database.QueryRow(`SELECT count(*) FROM agent_event WHERE type='message.delta'`).Scan(&deltas); err != nil || deltas != 1 {
		t.Fatalf("失败的回退必须保留事件：%d %v", deltas, err)
	}
}
