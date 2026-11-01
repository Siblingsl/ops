package db

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// DEV-CX13-F / FR-CX-23 / T-CX23：ops_standard 唯一约束与归档语义。
func TestCXOpsStandardMigrationConstraints(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 83); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 84); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	accountID := legacy.accountIDs[0]
	var workspaceID string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	seed := func(version int, day string) error {
		_, err := database.Exec(`INSERT INTO ops_standard (workspace_id,account_id,version,positioning,text_rules,visual_rules,content_hash,effective_from)
			VALUES ($1,$2,$3,'定位','[]'::jsonb,'{}'::jsonb,'hash',$4)`, workspaceID, accountID, version, day)
		return err
	}
	if err := seed(1, "2026-10-01"); err != nil {
		t.Fatalf("v1: %v", err)
	}
	// 同账号 version 唯一。
	if err := seed(1, "2026-11-01"); err == nil || !strings.Contains(err.Error(), "ops_standard_account_id_version_key") {
		t.Fatalf("duplicate version must be rejected: %v", err)
	}
	// 同账号 effective_from 唯一（同日并发冲突 409 的库层保障）。
	if err := seed(2, "2026-10-01"); err == nil || !strings.Contains(err.Error(), "ops_standard_account_id_effective_from_key") {
		t.Fatalf("duplicate effective_from must be rejected: %v", err)
	}
	if err := seed(2, "2026-11-01"); err != nil {
		t.Fatalf("v2 future: %v", err)
	}
	// 归档只改可见性：内容与生效语义不变，历史查询仍可解析。
	var standardID string
	if err := database.QueryRow(`SELECT id FROM ops_standard WHERE version=1`).Scan(&standardID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE ops_standard SET archived_at=$2 WHERE id=$1`, standardID, time.Now()); err != nil {
		t.Fatal(err)
	}
	var positioning, day string
	if err := database.QueryRow(`SELECT positioning,effective_from::text FROM ops_standard WHERE id=$1`, standardID).Scan(&positioning, &day); err != nil {
		t.Fatal(err)
	}
	if positioning != "定位" || day != "2026-10-01" {
		t.Fatalf("archive must not alter content: %s %s", positioning, day)
	}
	// check_run.ops_standard_basis 可空快照列。
	var runID uuid.UUID
	if err := database.QueryRow(`INSERT INTO check_run (work_id,revision,target_platform,fact_status,ops_standard_basis)
		VALUES ($1,1,'wechat_mp','skipped',$2) RETURNING id`, legacy.workIDs[0],
		`{"standard_id":"`+standardID+`","version":1,"content_hash":"hash","account_timezone":"Asia/Shanghai","checked_at":"2026-10-15"}`).Scan(&runID); err != nil {
		t.Fatalf("ops_standard_basis snapshot: %v", err)
	}
}
