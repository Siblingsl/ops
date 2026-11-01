package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestCXBuildMigrationIndexesAndRollbackProtection(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 75); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	if err := goose.UpTo(database, "migrations", 76); err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	var workID uuid.UUID
	if err := database.QueryRow(`INSERT INTO work(account_id,content_format) VALUES($1,'long_article') RETURNING id`, legacy.accountIDs[0]).Scan(&workID); err != nil {
		t.Fatal(err)
	}
	var workspaceID uuid.UUID
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, legacy.accountIDs[0]).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	buildID := uuid.New()
	hash := strings.Repeat("a", 64)
	if _, err := database.Exec(`INSERT INTO work_build(id,workspace_id,work_id,basis_revision,targets,source_snapshot,source_hash,params,params_hash,deadline_at)
		VALUES($1,$2,$3,1,ARRAY['wechat_html'], '{}',$4,'{}',$4,now()+interval '120 seconds')`, buildID, workspaceID, workID, hash); err != nil {
		t.Fatalf("insert valid build row: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO work_build_artifact(workspace_id,build_id,kind,name,storage_path,mime,bytes,sha256)
		VALUES($1,$2,'html','article.html',$3,'text/html',12,$4)`, workspaceID, buildID, "builds/"+workspaceID.String()+"/"+buildID.String()+"/artifact", hash); err != nil {
		t.Fatalf("insert valid artifact row: %v", err)
	}
	if _, err := database.Exec(`UPDATE work_build SET status='built',finished_at=now() WHERE id=$1`, buildID); err == nil {
		t.Fatal("built status without manifest/hash/expiry must be rejected")
	}
	if err := goose.DownTo(database, "migrations", 75); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("saved build data must block destructive rollback: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM work_build_artifact WHERE build_id=$1`, buildID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rollback refusal must preserve artifact index: count=%d err=%v", count, err)
	}
}
