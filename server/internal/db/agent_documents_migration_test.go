package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentDocumentsMigrationPreservesHistoryAndGuardsRollback(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 70); err != nil {
		t.Fatal(err)
	}
	var workspaceID, userID, attachmentID string
	if err := database.QueryRow("INSERT INTO workspace(name) VALUES('文档迁移') RETURNING id").Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow("INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id",
		"aw-document-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow("INSERT INTO agent_attachment(workspace_id,user_id,kind,name,mime,bytes,sha256,storage_path,text_content) VALUES($1,$2,'text','old.txt','text/plain',3,'old','old','历史正文') RETURNING id",
		workspaceID, userID).Scan(&attachmentID); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 71); err != nil {
		t.Fatal(err)
	}
	var status, text string
	if err := database.QueryRow("SELECT parse_status,text_content FROM agent_attachment WHERE id=$1", attachmentID).Scan(&status, &text); err != nil {
		t.Fatal(err)
	}
	if status != "ready" || text != "历史正文" {
		t.Fatalf("history changed: %q %q", status, text)
	}
	if err := goose.DownTo(database, "migrations", 70); err != nil {
		t.Fatalf("legacy-only rollback: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 71); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("INSERT INTO agent_attachment(workspace_id,user_id,kind,name,mime,bytes,sha256,storage_path,parse_status) VALUES($1,$2,'document','new.pdf','application/pdf',3,'new','new','quarantined')", workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 70); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("document data must prevent destructive rollback: %v", err)
	}
	var remaining int
	if err := database.QueryRow("SELECT count(*) FROM agent_attachment WHERE kind='document'").Scan(&remaining); err != nil || remaining != 1 {
		t.Fatalf("rollback lost document: %d %v", remaining, err)
	}
	if err := goose.UpTo(database, "migrations", 72); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 71); err != nil {
		t.Fatalf("empty parser receipt rollback: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 72); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE agent_attachment SET parser_version='ops-document-v1/pdf0.7.0' WHERE kind='document'"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 71); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("parser receipt must prevent destructive rollback: %v", err)
	}
}
