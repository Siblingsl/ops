package db

import (
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"
)

// DEV-CX13-D / 24 §4.10.2：model_provider.context_window_tokens 可空登记列——
// 有效值 ≥1024；NULL 合法（未登记不做发送前检查）；0/负值被 CHECK 拒绝。
func TestCXModelContextWindowMigrationConstraint(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.Up(database, "migrations"); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	var workspaceID string
	if err := database.QueryRow(`SELECT id FROM workspace LIMIT 1`).Scan(&workspaceID); err != nil {
		t.Skipf("no workspace fixture: %v", err)
	}
	insert := func(window any) error {
		_, err := database.Exec(`INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, models, context_window_tokens)
			VALUES ($1, '窗口测试', 'http://127.0.0.1:1', decode('00','hex'), '{}', $2)`, workspaceID, window)
		return err
	}
	if err := insert(nil); err != nil {
		t.Fatalf("NULL window must be allowed: %v", err)
	}
	if err := insert(200000); err != nil {
		t.Fatalf("registered window must be allowed: %v", err)
	}
	if err := insert(512); err == nil {
		t.Fatal("window below 1024 must be rejected")
	}
	if err := insert(-1); err == nil {
		t.Fatal("negative window must be rejected")
	}
	var registered sql.NullInt64
	if err := database.QueryRow(`SELECT context_window_tokens FROM model_provider WHERE name='窗口测试' ORDER BY created_at DESC LIMIT 1`).Scan(&registered); err != nil {
		t.Fatal(err)
	}
	if !registered.Valid || registered.Int64 != 200000 {
		t.Fatalf("registered window must persist: %+v", registered)
	}
}
