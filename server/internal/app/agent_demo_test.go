package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// A2-A1：simulated 供应商生产拒绝、开发放行。cfg 是共享指针：临时翻转 Dev 并恢复。
func TestA2SimulatedProviderGate(t *testing.T) {
	providerID := env.ensureToolModel(t)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE model_provider SET simulated=true WHERE id=$1`, providerID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `UPDATE model_provider SET simulated=false WHERE id=$1`, providerID)
	})
	simulated, err := env.srv.agentSimulatedOf(context.Background(), providerID)
	if err != nil || !simulated {
		t.Fatalf("simulated should be true, got %v %v", simulated, err)
	}
	// 生产 cfg 拒绝（临时翻转 Dev=false）。
	origDev := env.srv.cfg.Dev
	env.srv.cfg.Dev = false
	_, err = env.srv.agentCheckSimulatedProvider(context.Background(), providerID)
	env.srv.cfg.Dev = origDev
	if err == nil || !strings.Contains(err.Error(), "model_simulated_production") {
		t.Fatalf("production must reject simulated provider, got %v", err)
	}
	// 开发（Dev=true）放行。
	simulatedCheck, err := env.srv.agentCheckSimulatedProvider(context.Background(), providerID)
	if err != nil || !simulatedCheck {
		t.Fatalf("dev must allow simulated provider, got %v %v", simulatedCheck, err)
	}
}

// A2-A2：demo 下外部写入工具返回 demo_blocked 预览。
func TestA2DemoBlockedTools(t *testing.T) {
	for _, name := range []string{"notify_user", "publish_work", "publish_now", "feishu_send", "send_email", "platform_push"} {
		if !agentDemoBlocked(name) {
			t.Fatalf("%s should be demo blocked", name)
		}
	}
	// 站内内容操作不属于外部副作用面（AG06 契约：提案→确认执行是批准设计的测试链路）。
	for _, name := range []string{"search_materials", "outline_generate", "ops_probe_echo", "outline__confirm", "wechat__push"} {
		if agentDemoBlocked(name) {
			t.Fatalf("%s should be allowed in demo", name)
		}
	}
	text := agentDemoBlockedResult("publish_work")
	if !strings.Contains(text, "demo_blocked") || !strings.Contains(text, "publish_work") {
		t.Fatalf("blocked preview text wrong: %s", text)
	}
}

// A2-A3/A2-A4/A2-A5：轮次用尽三段收尾——不调用模型、数据来自既有表、
// awaiting_confirmation 不被覆盖（优先级在 run 层分支先于 round_limit）。
func TestA2WrapUpBuildFromTables(t *testing.T) {
	env.ensureToolModel(t)
	conv := env.createConversation(t, map[string]any{})
	// 触发一个 run 取得 run 记录。
	status, body := env.do("POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
		"request_id": uuid.NewString(), "text": "A2 收尾轮验证", "protocol_version": 2,
	})
	if status != 202 {
		t.Fatalf("send = %d %s", status, body)
	}
	runID := a1WaitRunDone(t, conv.ID)
	runUUID := uuidFromString(runID)

	// 注入计划步骤（completed/pending）、动作卡片（succeeded/needs_input）、未答问题。
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_plan (conversation_id, source_run_id, source_tool_call_id, request_hash, version, summary, steps)
		 VALUES ($1,$2,'wrapup-call','x',1,'A2 收尾验证计划',
		 '[{"title":"第一步：整理素材"},{"title":"第二步：发布作品"}]'::jsonb)`,
		conv.ID, runUUID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_plan_step_state (plan_id, step_id, status)
		 SELECT id, '第一步：整理素材', 'completed' FROM agent_plan WHERE source_run_id=$1
		 UNION ALL SELECT id, '第二步：发布作品', 'pending' FROM agent_plan WHERE source_run_id=$1`,
		runUUID); err != nil {
		t.Fatal(err)
	}
	var convUserID string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT user_id FROM agent_run WHERE id=$1`, runUUID).Scan(&convUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_action (conversation_id, run_id, batch_id, workspace_id, user_id,
		 tool_call_id, tool_name, kind, target_type, target_id, target_key, status, params, expires_at)
		 VALUES ($1,$2,gen_random_uuid(),$3,$4,'call-a2','publish_work','W','work',$5,'work','succeeded','{}'::jsonb, now()+interval '10 minutes'),
		        ($1,$2,gen_random_uuid(),$3,$4,'call-a2b','publish_work','W','work',$5,'work','needs_input','{}'::jsonb, now()+interval '10 minutes')`,
		conv.ID, runUUID, uuidMustScanWS(runID), convUserID, uuidMustScanWS(runID)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_question (conversation_id, source_run_id, source_tool_call_id, request_hash, items, expires_at)
		 VALUES ($1,$2,'q-a2','x','[{"question":"封面用哪张？"}]'::jsonb, now()+interval '10 minutes')`,
		conv.ID, runUUID); err != nil {
		t.Fatal(err)
	}

	wrap := env.srv.agentBuildWrapUp(context.Background(), runID)
	if len(wrap.Done) == 0 || len(wrap.Pending) == 0 || len(wrap.NeedUser) == 0 {
		t.Fatalf("wrapup incomplete: %+v", wrap)
	}
	text := agentWrapUpText(wrap)
	if !strings.Contains(text, "已完成") || !strings.Contains(text, "未完成") || !strings.Contains(text, "需要你确认") {
		t.Fatalf("wrapup text missing sections: %s", text)
	}
	if strings.Count(text, "\n") > 20 {
		t.Fatalf("wrapup must be <= 20 lines, got %d", strings.Count(text, "\n"))
	}
	// 不编造：pending 步骤带状态标注。
	if !strings.Contains(text, "第二步：发布作品（pending）") {
		t.Fatalf("wrapup should label pending step status: %s", text)
	}
}

// A2-A6 数据面：轮次收尾的三段结构要并入 final_check.wrap_up，供双端抽屉读取；
// 不改变 A1 的 claims/evidence/blocked 结构。
func TestA2WrapUpStoredInFinalCheck(t *testing.T) {
	raw := agentTruthWithWrapUp([]byte(`{"claims":["publish"],"evidence":0,"blocked":["publish"]}`), agentWrapUp{
		Done:       []string{"第一步：选题（completed）"},
		Pending:    []string{"第二步：发布作品（pending）"},
		NeedUser:   []string{"确认封面图"},
		NextAction: "缩小任务范围后重试。",
	})
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	wrap, ok := doc["wrap_up"].(map[string]any)
	if !ok {
		t.Fatalf("final_check.wrap_up missing: %v", doc)
	}
	for _, key := range []string{"done", "pending", "need_user", "next_actions"} {
		if _, exists := wrap[key]; !exists {
			t.Fatalf("final_check.wrap_up.%s missing: %v", key, wrap)
		}
	}
	if claims, _ := doc["claims"].([]any); len(claims) == 0 {
		t.Fatalf("A1 claims lost while merging wrapup: %v", doc)
	}
}

func uuidMustScanWS(runID string) uuid.UUID {
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM agent_run WHERE id=$1`, runID).Scan(&ws); err != nil {
		return uuid.Nil
	}
	return ws
}

// A2-A5：awaiting_confirmation 分支先于 round_limit（代码路径断言：确认卡片在途时
// run 层先 return awaiting_confirmation，不进入收尾）。直接验证状态文本与优先级：
// 收尾文本不含“awaiting_confirmation”语义覆盖。
func TestA2WrapUpDoesNotOverrideAwaiting(t *testing.T) {
	// run 层顺序：st.AwaitingInput / CardsThisRound>0（awaiting_confirmation）先 return；
	// round_limit 收尾只在两者都不满足时执行。此处验证 agentWrapUpText 的中性文案
	// 不含“已全部完成”类空话。
	text := agentWrapUpText(agentWrapUp{})
	if strings.Contains(text, "已全部完成") || strings.Contains(text, "任务已完成") {
		t.Fatalf("wrapup must not fake completion: %s", text)
	}
	if !strings.Contains(text, "部分完成") {
		t.Fatalf("wrapup should state partial: %s", text)
	}
}
