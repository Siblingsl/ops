package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// BE-02（docs/33 §11.5；agent_run.go 批次）：
// pending 计数 / 溯源打标 / loaded_domains 回写失败必须可观测；控制流保持 best-effort。

func TestBE02AgentCountPendingFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("agent_run_pending_count_failed")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n := env.srv.agentCountPending(ctx, uuid.New())
	if n != 0 {
		t.Fatalf("计数失败应回落为 0，实际 %d", n)
	}
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "待处理操作卡片计数失败" && record["error_code"] == "agent_run_pending_count_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("agentCountPending 查询失败必须 Warn 可观测")
	}
}

func TestBE02AgentTagSourceCallFailureIsObservable(t *testing.T) {
	sink := opt15Capture(t)
	observeWarnLast.Delete("agent_run_tag_source_failed")
	ctx, st := aw06ToolRun(t)
	callID := "be02-tag-" + uuid.NewString()[:8]
	aiCallID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO ai_call(id,workspace_id,task_type,provider,model,status)
		VALUES($1,$2,'titles','mock','mock-writer','ok')`, aiCallID, st.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message(id,conversation_id,run_id,role,content,tool_name,tool_call_id,seq)
		VALUES($1,$2,$3,'tool','{}','skills__draft',$4,
			(SELECT coalesce(max(seq),0)+1 FROM agent_message WHERE conversation_id=$2))`,
		uuid.New(), st.ConversationID, st.RunID, callID); err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	// skills__draft 走 done.ai_call_id 直取来源，避免 cancelled ctx 在 Link 阶段提前返回。
	env.srv.agentTagSourceCall(cancelCtx, st, "skills__draft", callID, time.Now().Add(-time.Second),
		[]byte(`{"ai_call_id":"`+aiCallID.String()+`"}`))
	found := false
	for _, record := range sink.records(t) {
		if record["msg"] == "工具结果溯源打标失败" && record["error_code"] == "agent_run_tag_source_failed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("agentTagSourceCall UPDATE 失败必须 Warn 可观测")
	}
}

func TestBE02FinishAgentRunWritesLoadedDomains(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	ctx, st := aw06ToolRun(t)
	st.Domains = []string{"works", "writing"}
	st.Model.ProviderID = uuid.MustParse(env.ensureToolModel(t))
	env.srv.finishAgentRun(ctx, st, "completed", "", nil)
	var domains []string
	if err := env.srv.db.QueryRow(ctx, `SELECT loaded_domains FROM agent_conversation WHERE id=$1`, st.ConversationID).Scan(&domains); err != nil {
		t.Fatal(err)
	}
	if len(domains) < 2 || domains[0] != "works" {
		t.Fatalf("finishAgentRun 应回写 loaded_domains，实际 %#v", domains)
	}
}
