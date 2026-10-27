package db

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pressly/goose/v3"
)

func TestAgentPlansQuestionsMigrationAndRollbackGuard(t *testing.T) {
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	database, _ := newToutiaoMigrationTestDB(t)
	if err := goose.UpTo(database, "migrations", 66); err != nil {
		t.Fatalf("upgrade through 00066: %v", err)
	}
	if err := goose.DownTo(database, "migrations", 65); err != nil {
		t.Fatalf("empty workbench tables should roll back safely: %v", err)
	}
	if err := goose.UpTo(database, "migrations", 66); err != nil {
		t.Fatalf("re-upgrade through 00066: %v", err)
	}

	var workspaceID, userID, conversationID, runID string
	if err := database.QueryRow(`INSERT INTO workspace(name) VALUES('计划问题迁移') RETURNING id`).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO app_user(username,password_hash) VALUES($1,'x') RETURNING id`,
		"aw-plan-migration-"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`,
		workspaceID, userID).Scan(&conversationID); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`INSERT INTO agent_run(conversation_id,workspace_id,user_id,session_id,trigger,status)
		VALUES($1,$2,$3,gen_random_uuid(),'message','awaiting_input') RETURNING id`, conversationID, workspaceID, userID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO agent_plan(conversation_id,source_run_id,source_tool_call_id,request_hash,version,summary,steps)
		VALUES($1,$2,'plan-call',$3,1,'本周内容计划','[{"id":"review","title":"检查内容","acceptance":"引用已保存结果"}]')`,
		conversationID, runID, strings.Repeat("a", 64)); err != nil {
		t.Fatalf("insert versioned plan: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO agent_question(conversation_id,source_run_id,source_tool_call_id,request_hash,items,expires_at)
		VALUES($1,$2,'question-call',$3,'[{"id":"goal","title":"目标","required":true,"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]',now()+interval '1 day')`,
		conversationID, runID, strings.Repeat("b", 64)); err != nil {
		t.Fatalf("insert structured question: %v", err)
	}
	if err := goose.DownTo(database, "migrations", 65); err == nil || !strings.Contains(err.Error(), "拒绝") {
		t.Fatalf("migration must reject rollback while new records exist: %v", err)
	}
	var plans, questions, awaiting int
	if err := database.QueryRow(`SELECT (SELECT count(*) FROM agent_plan),(SELECT count(*) FROM agent_question),
		(SELECT count(*) FROM agent_run WHERE status='awaiting_input')`).Scan(&plans, &questions, &awaiting); err != nil {
		t.Fatal(err)
	}
	if plans != 1 || questions != 1 || awaiting != 1 {
		t.Fatalf("refused rollback must preserve data: plans=%d questions=%d awaiting=%d", plans, questions, awaiting)
	}
}
