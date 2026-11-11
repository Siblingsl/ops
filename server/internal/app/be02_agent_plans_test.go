package app

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"ops/internal/ai"
)

// BE-02（docs/33 §11.5 / BE-02；agent_plans.go 批次）：计划工具 JSON 解析/序列化不得静默。
// 修复前：幂等命中路径 `_ = json.Unmarshal(rawSteps, &plan.Steps)`——坏 JSON 仍返回 ok，
// 工具摘要冒充成功且步骤为空；若干 `payload, _ := json.Marshal` 同口径吞错。
// 修复后：Unmarshal/Marshal 失败一律上抛；正常幂等命中仍返回原 plan_id/version。

func TestBE02PresentPlanIdempotentCorruptStepsSurfacesError(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	ctx, st := aw06ToolRun(t)
	st.Mode = "plan"
	st.ExecutionOrigin = "interactive"

	steps := []agentPlanStepDefinition{{
		ID: "read", Title: "读取", Acceptance: "有读取结果",
	}}
	requestHash, err := agentRequestPayloadHash(map[string]any{
		"summary": "核对计划", "steps": steps,
	})
	if err != nil {
		t.Fatal(err)
	}
	callID := "call-be02-plan-corrupt"
	planID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_plan
		(id,conversation_id,source_run_id,source_tool_call_id,request_hash,version,summary,steps,status)
		VALUES($1,$2,$3,$4,$5,1,$6,$7,'current')`,
		// 满足 jsonb 数组约束，但元素不是步骤对象——Go Unmarshal 到切片必失败。
		planID, st.ConversationID, st.RunID, callID, requestHash, "核对计划", []byte(`[1]`)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM agent_plan WHERE id=$1`, planID)
	})

	_, _, err = env.srv.agentMetaPresentPlan(ctx, st, ai.ToolCall{ID: callID}, map[string]any{
		"summary": "核对计划",
		"steps": []map[string]any{
			{"id": "read", "title": "读取", "acceptance": "有读取结果"},
		},
	})
	if err == nil {
		t.Fatal("损坏的 steps JSON 在幂等命中路径必须上抛，不得伪装成功")
	}
}

func TestBE02PresentPlanIdempotentReplayPreservesPlan(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	ctx, st := aw06ToolRun(t)
	st.Mode = "plan"
	st.ExecutionOrigin = "interactive"

	args := map[string]any{
		"summary": "核对近期内容",
		"steps": []map[string]any{
			{"id": "read", "title": "读取近期内容", "acceptance": "引用已保存的读取结果"},
		},
	}
	call := ai.ToolCall{ID: "call-be02-plan-ok"}
	payload1, summary1, err := env.srv.agentMetaPresentPlan(ctx, st, call, args)
	if err != nil {
		t.Fatalf("首次 present_plan: %v", err)
	}
	var first map[string]any
	if err := json.Unmarshal(payload1, &first); err != nil {
		t.Fatal(err)
	}
	payload2, summary2, err := env.srv.agentMetaPresentPlan(ctx, st, call, args)
	if err != nil {
		t.Fatalf("幂等重放 present_plan: %v", err)
	}
	var second map[string]any
	if err := json.Unmarshal(payload2, &second); err != nil {
		t.Fatal(err)
	}
	if first["plan_id"] != second["plan_id"] || first["version"] != second["version"] {
		t.Fatalf("幂等重放应返回同一 plan：first=%v second=%v", first, second)
	}
	if summary1 == "" || summary2 == "" {
		t.Fatalf("工具摘要不得为空：%q / %q", summary1, summary2)
	}
	t.Cleanup(func() {
		if id, ok := first["plan_id"].(string); ok {
			_, _ = env.srv.db.Exec(ctx, `DELETE FROM agent_plan_step_state WHERE plan_id=$1`, id)
			_, _ = env.srv.db.Exec(ctx, `DELETE FROM agent_plan WHERE id=$1`, id)
		}
	})
}
