package db

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

// DEV-CX12 / FR-CX-18：benchmark_target/benchmark_note 两层库约束与旧 strategy.benchmarks 幂等回填。
func TestCXBenchmarkLibraryMigrationConstraintsAndIdempotentBackfill(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 79); err != nil {
		t.Fatal(err)
	}
	legacy := seedLegacyPlatformData(t, database)
	accountID := legacy.accountIDs[0]
	workspaceID := workspaceForCXBenchmark(database, t, accountID)

	// 旧方案写入两条 benchmarks：一条带 URL 的正常项、一条缺 URL 且空名项（规格：缺URL/重复名不丢）。
	benchmarks := []map[string]any{
		{"name": "对标小绿书", "note": "", "links": []string{"https://www.xiaohongshu.com/user/example?utm=ad#frag"}},
		{"name": "", "note": "", "links": []string{}},
	}
	encoded, _ := json.Marshal(benchmarks)
	strategyID := seedBenchmarkStrategy(t, database, accountID, string(encoded))

	if err := goose.UpTo(database, "migrations", 80); err != nil {
		t.Fatalf("upgrade: %v", err)
	}

	var imported int
	if err := database.QueryRow(`SELECT count(*) FROM benchmark_target WHERE migration_source_key LIKE $1 || ':%'`,
		strategyID).Scan(&imported); err != nil {
		t.Fatal(err)
	}
	if imported != 2 {
		t.Fatalf("both legacy benchmarks must be imported (missing URL and empty name kept): imported=%d", imported)
	}
	var candidateCount int
	if err := database.QueryRow(`SELECT count(*) FROM benchmark_target WHERE status='candidate' AND fit_score IS NULL AND answers='{}'::jsonb AND migration_source_key LIKE $1 || ':%'`,
		strategyID).Scan(&candidateCount); err != nil {
		t.Fatal(err)
	}
	if candidateCount != 2 {
		t.Fatalf("backfill must not answer the four questions for the user: candidates=%d", candidateCount)
	}
	var emptyName string
	if err := database.QueryRow(`SELECT name FROM benchmark_target WHERE migration_source_key LIKE $1 || ':2:%'`,
		strategyID).Scan(&emptyName); err != nil {
		t.Fatalf("empty-name legacy entry must be kept: %v", err)
	}
	if strings.TrimSpace(emptyName) == "" {
		t.Fatal("empty legacy name must not be dropped")
	}

	// 重跑幂等：直接重放回填 INSERT 语句，不得新增行。
	if err := reRunBenchmarkBackfill(database); err != nil {
		t.Fatalf("re-running the backfill must be idempotent: %v", err)
	}
	var afterRerun int
	if err := database.QueryRow(`SELECT count(*) FROM benchmark_target WHERE migration_source_key LIKE $1 || ':%'`,
		strategyID).Scan(&afterRerun); err != nil {
		t.Fatal(err)
	}
	if afterRerun != imported {
		t.Fatalf("idempotent rerun must not duplicate rows: before=%d after=%d", imported, afterRerun)
	}

	// 约束：非法平台枚举拒绝；同账号同平台同 normalized_url 唯一；无 URL 允许多条；跨工作区复合外键拒绝。
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name)
		VALUES($1,$2,'bilibili','非法平台')`, workspaceID, accountID); err == nil {
		t.Fatal("platform outside the documented enum must be rejected")
	}
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name,url,normalized_url)
		VALUES($1,$2,'xhs','第二条','https://xhslink.com/a','https://xhslink.com/a')`, workspaceID, accountID); err != nil {
		t.Fatalf("distinct URLs must be storable: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name,url,normalized_url)
		VALUES($1,$2,'xhs','URL重复','https://xhslink.com/b','https://xhslink.com/a')`, workspaceID, accountID); err == nil {
		t.Fatal("duplicate normalized_url per account/platform must be rejected")
	}
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name)
		VALUES($1,$2,'xhs','无URL甲')`, workspaceID, accountID); err != nil {
		t.Fatalf("empty URL entries must be allowed: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name)
		VALUES($1,$2,'xhs','无URL乙')`, workspaceID, accountID); err != nil {
		t.Fatalf("multiple empty-URL entries must be allowed: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO benchmark_target(workspace_id,account_id,platform,name)
		VALUES($1,$2,'xhs','跨工作区')`, uuid.NewString(), accountID); err == nil {
		t.Fatal("workspace/account mismatch must be rejected by the composite foreign key")
	}

	// fit_score 范围约束与 notes 父级归属。
	targetID := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO benchmark_target(id,workspace_id,account_id,platform,name,fit_score)
		VALUES($1,$2,$3,'xhs','四问库',50)`, targetID, workspaceID, accountID); err != nil {
		t.Fatalf("valid target insert: %v", err)
	}
	if _, err := database.Exec(`UPDATE benchmark_target SET fit_score=101 WHERE id=$1`, targetID); err == nil {
		t.Fatal("fit_score>100 must be rejected")
	}
	if _, err := database.Exec(`UPDATE benchmark_target SET fit_score=-1 WHERE id=$1`, targetID); err == nil {
		t.Fatal("negative fit_score must be rejected")
	}
	noteID := uuid.NewString()
	if _, err := database.Exec(`INSERT INTO benchmark_note(id,workspace_id,target_id,structure,structure_hash)
		VALUES($1,$2,$3,'{"hook_type":"question"}'::jsonb,'hash-a')`, noteID, workspaceID, targetID); err != nil {
		t.Fatalf("valid note insert: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO benchmark_note(id,workspace_id,target_id,structure,structure_hash)
		VALUES($1,$2,$3,'[]'::jsonb,'hash-b')`, uuid.NewString(), workspaceID, targetID); err == nil {
		t.Fatal("structure must be a JSON object, not an array")
	}
	if _, err := database.Exec(`INSERT INTO benchmark_note(id,workspace_id,target_id,structure,structure_hash)
		VALUES($1,$2,$3,'{"hook_type":"claim"}'::jsonb,'hash-c')`, uuid.NewString(), workspaceID, uuid.NewString()); err == nil {
		t.Fatal("note under a foreign target must be rejected by the composite foreign key")
	}

	// 回滚保护：库内有数据时拒绝回滚。
	if err := goose.DownTo(database, "migrations", 79); err == nil || !strings.Contains(err.Error(), "拒绝回滚") {
		t.Fatalf("saved benchmark data must block destructive rollback: %v", err)
	}
	var stillThere int
	if err := database.QueryRow(`SELECT count(*) FROM benchmark_target`).Scan(&stillThere); err != nil || stillThere < 1 {
		t.Fatalf("rollback refusal must preserve the records: count=%d err=%v", stillThere, err)
	}
}

func workspaceForCXBenchmark(database *sql.DB, t *testing.T, accountID string) string {
	t.Helper()
	var workspaceID string
	if err := database.QueryRow(`SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	return workspaceID
}

// seedBenchmarkStrategy 找到账号最新 strategy 并写入 benchmarks；没有则创建一条 active 方案。
func seedBenchmarkStrategy(t *testing.T, database *sql.DB, accountID, encoded string) string {
	t.Helper()
	var strategyID string
	err := database.QueryRow(`SELECT id FROM account_strategy WHERE account_id=$1 ORDER BY version DESC LIMIT 1`,
		accountID).Scan(&strategyID)
	switch {
	case err == sql.ErrNoRows:
		if _, err := database.Exec(`INSERT INTO account_strategy(account_id,version,status,benchmarks)
			VALUES($1,1,'active',$2::jsonb)`, accountID, encoded); err != nil {
			t.Fatalf("seed strategy with benchmarks: %v", err)
		}
		if err := database.QueryRow(`SELECT id FROM account_strategy WHERE account_id=$1 ORDER BY version DESC LIMIT 1`,
			accountID).Scan(&strategyID); err != nil {
			t.Fatal(err)
		}
		return strategyID
	case err != nil:
		t.Fatalf("lookup strategy: %v", err)
	}
	if _, err := database.Exec(`UPDATE account_strategy SET benchmarks=$1::jsonb WHERE id=$2`, encoded, strategyID); err != nil {
		t.Fatalf("update legacy benchmarks: %v", err)
	}
	return strategyID
}

// reRunBenchmarkBackfill 重放 00080 的回填 INSERT 以验证幂等。
func reRunBenchmarkBackfill(database *sql.DB) error {
	_, err := database.Exec(`INSERT INTO benchmark_target (workspace_id, account_id, platform, name, url, normalized_url,
	  positioning, answers, fit_score, status, migration_source_key)
	SELECT p.workspace_id, s.account_id, p.platform,
	  left(CASE WHEN btrim(COALESCE(b.b->>'name','')) = '' THEN '（未命名对标账号）' ELSE b.b->>'name' END, 100),
	  COALESCE((SELECT x FROM jsonb_array_elements_text(COALESCE(b.b->'links','[]'::jsonb)) x LIMIT 1), ''),
	  '',
	  '',
	  '{}'::jsonb, NULL, 'candidate',
	  s.id::text || ':' || b.idx || ':' || md5(COALESCE(b.b::text,''))
	FROM account_strategy s
	JOIN platform_account p ON p.id = s.account_id
	CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.benchmarks,'[]'::jsonb)) WITH ORDINALITY AS b(b, idx)
	WHERE NOT EXISTS (
	  SELECT 1 FROM benchmark_target t
	  WHERE t.migration_source_key = s.id::text || ':' || b.idx || ':' || md5(COALESCE(b.b::text,''))
	)`)
	return err
}
