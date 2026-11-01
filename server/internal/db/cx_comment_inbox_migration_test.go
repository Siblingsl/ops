package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// DEV-CX13-E / FR-CX-22 / T-CX22：comment_inbox 约束与软删除语义。
func TestCXCommentInboxMigrationConstraints(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 81); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 82); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	accountID := legacy.accountIDs[0]
	var workspaceID string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}

	id := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO comment_inbox (id,workspace_id,account_id,author_alias,content,captured_at,category,reply_status)
		VALUES ($1,$2,$3,'读者甲','这篇的步骤写得很清楚',$4,'praise','drafted')`, id, workspaceID, accountID, "2026-10-31T10:00:00Z"); err != nil {
		t.Fatalf("valid insert: %v", err)
	}
	// 枚举与状态约束。
	if _, err := database.Exec(`INSERT INTO comment_inbox (workspace_id,account_id,content,captured_at,reply_status)
		VALUES ($1,$2,'x',$3,'sent')`, workspaceID, accountID, "2026-10-31T10:00:00Z"); err == nil {
		t.Fatal("invalid reply_status must be rejected")
	}
	if _, err := database.Exec(`INSERT INTO comment_inbox (workspace_id,account_id,content,captured_at,category)
		VALUES ($1,$2,'x',$3,'other')`, workspaceID, accountID, "2026-10-31T10:00:00Z"); err == nil {
		t.Fatal("invalid category must be rejected")
	}
	// 软删除清正文：删除置 deleted_at 并清空 content/reply_draft。
	if _, err := database.Exec(`UPDATE comment_inbox SET deleted_at=now(), content='', reply_draft='', author_alias='' WHERE id=$1`, id); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	var content string
	if err := database.QueryRow(`SELECT content FROM comment_inbox WHERE id=$1`, id).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(content) != "" {
		t.Fatalf("deleted comment must have empty content: %q", content)
	}
}
