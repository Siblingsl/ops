package app

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestA7BuiltinTemplatesSeededAndNoBatch(t *testing.T) {
	// A7-A1/A5：三内置模板 seed、步骤结构合法、无自动发布/批量执行步骤。
	a := drAccount(t, "xhs", "A7 模板小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedWorkflowTemplates(context.Background(), wsID)

	var list struct {
		Templates []WorkflowTemplate `json:"templates"`
	}
	env.mustJSON(t, "GET", "/api/v1/workflows", nil, &list)
	if len(list.Templates) < 3 {
		t.Fatalf("want >=3 builtin templates, got %d", len(list.Templates))
	}
	keys := map[string]WorkflowTemplate{}
	for _, t2 := range list.Templates {
		if t2.BuiltinKey != "" {
			keys[t2.BuiltinKey] = t2
		}
	}
	for _, key := range []string{"benchmark_decompose", "weekly_review", "publish_prepare"} {
		tpl, ok := keys[key]
		if !ok {
			t.Fatalf("builtin %s missing", key)
		}
		if len(tpl.Steps) < 1 || len(tpl.Steps) > 12 {
			t.Fatalf("%s steps count invalid: %d", key, len(tpl.Steps))
		}
		if err := validateWorkflowSteps(tpl.Steps); err != nil {
			t.Fatalf("%s steps invalid: %v", key, err)
		}
	}
	// 内置模板不含自动发布/批量执行步骤。
	for _, key := range []string{"benchmark_decompose", "weekly_review", "publish_prepare"} {
		tpl := keys[key]
		for _, step := range tpl.Steps {
			tools, _ := step["tools"].([]any)
			for _, tool := range tools {
				name, _ := tool.(string)
				if strings.Contains(name, "batch") || strings.Contains(name, "publish_now") || strings.Contains(name, "publish__push") {
					t.Fatalf("%s contains auto-publish/batch step tool %s", key, name)
				}
			}
		}
	}
	// 内置不可删。
	publish := keys["publish_prepare"]
	env.mustJSONStatus(t, "DELETE", "/api/v1/workflows/"+publish.ID.String(), nil, nil, http.StatusConflict)
}

func TestA7TemplateStepValidation(t *testing.T) {
	// A7-A1：0/13 步、重复 key、非法 requires 拒绝。
	one := []map[string]any{{"key": "a", "title": "步骤A", "requires": []string{}}}
	env.mustJSON(t, "POST", "/api/v1/workflows", map[string]any{"name": "A7 单步模板", "steps": one}, &struct{}{})
	env.mustJSONStatus(t, "POST", "/api/v1/workflows", map[string]any{"name": "A7 空步骤", "steps": []map[string]any{}}, nil, http.StatusUnprocessableEntity)
	thirteen := []map[string]any{}
	for i := 0; i < 13; i++ {
		thirteen = append(thirteen, map[string]any{"key": string(rune('a' + i)), "title": "x", "requires": []string{}})
	}
	env.mustJSONStatus(t, "POST", "/api/v1/workflows", map[string]any{"name": "A7 超步数", "steps": thirteen}, nil, http.StatusUnprocessableEntity)
	dup := []map[string]any{
		{"key": "same", "title": "一", "requires": []string{}},
		{"key": "same", "title": "二", "requires": []string{}},
	}
	env.mustJSONStatus(t, "POST", "/api/v1/workflows", map[string]any{"name": "A7 重复key", "steps": dup}, nil, http.StatusUnprocessableEntity)
	badReq := []map[string]any{{"key": "a", "title": "x", "requires": []string{"secret_key"}}}
	env.mustJSONStatus(t, "POST", "/api/v1/workflows", map[string]any{"name": "A7 非法requires", "steps": badReq}, nil, http.StatusUnprocessableEntity)
}

func TestA7StartOnlyCreatesRunAndPlanNoExecution(t *testing.T) {
	// A7-A2：启动只建 conversation+run+plan+step_state，不执行工具；返回预览。
	a := drAccount(t, "xhs", "A7 启动小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedWorkflowTemplates(context.Background(), wsID)
	provider := env.ensureToolModel(t)

	var tpl struct {
		Templates []WorkflowTemplate `json:"templates"`
	}
	env.mustJSON(t, "GET", "/api/v1/workflows", nil, &tpl)
	var publishTpl WorkflowTemplate
	for _, t2 := range tpl.Templates {
		if t2.BuiltinKey == "publish_prepare" {
			publishTpl = t2
		}
	}
	wk := publishTestWork(t, a, "A7 工作流作品", 900, 1200, []string{"账号名"})

	var out struct {
		ConversationID string         `json:"conversation_id"`
		RunID          string         `json:"run_id"`
		Plan           map[string]any `json:"plan"`
	}
	env.mustJSON(t, "POST", "/api/v1/workflows/"+publishTpl.ID.String()+"/start",
		map[string]any{"account_id": a.ID.String(), "work_id": wk.ID.String()}, &out)
	if out.ConversationID == "" || out.RunID == "" || out.Plan == nil {
		t.Fatalf("start output incomplete: %+v", out)
	}
	// run 处于 queued，不执行任何工具。
	var runState string
	var actions int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_run WHERE id=$1`, out.RunID).Scan(&runState); err != nil {
		t.Fatal(err)
	}
	if runState != "awaiting_confirmation" {
		t.Fatalf("run state = %s, want awaiting_confirmation (plan waiting for user)", runState)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_action WHERE run_id=$1`, out.RunID).Scan(&actions); err != nil {
		t.Fatal(err)
	}
	if actions != 0 {
		t.Fatalf("start must not execute tools, actions=%d", actions)
	}
	// plan 步骤状态全 pending。
	var pending int
	var total int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FILTER (WHERE s.status='pending'), count(*) FROM agent_plan_step_state s
		 JOIN agent_plan p ON p.id=s.plan_id WHERE p.id=$1`,
		uuid.MustParse(out.Plan["id"].(string))).Scan(&pending, &total); err != nil {
		t.Fatal(err)
	}
	if total != len(publishTpl.Steps) || pending != total {
		t.Fatalf("plan steps total=%d pending=%d, want all pending", total, pending)
	}
	// A7-N6：计划步骤必须输出 id/acceptance，供计划卡与 update_plan_step 按 id 对应。
	steps, ok := out.Plan["steps"].([]any)
	if !ok || len(steps) != len(publishTpl.Steps) {
		t.Fatalf("plan steps payload = %#v, want %d items", out.Plan["steps"], len(publishTpl.Steps))
	}
	for i, item := range steps {
		step, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("step %d payload = %#v", i, item)
		}
		id, _ := step["id"].(string)
		acceptance, _ := step["acceptance"].(string)
		if strings.TrimSpace(id) == "" || strings.TrimSpace(acceptance) == "" {
			t.Fatalf("step %d missing id/acceptance: %#v", i, step)
		}
	}
	_ = provider
}

func TestA7StartMissingInputRejected(t *testing.T) {
	// A7-A3：缺 work_id → 422 workflow_missing_input，missing 列出 work_id。
	a := drAccount(t, "xhs", "A7 缺参小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedWorkflowTemplates(context.Background(), wsID)
	var tpl struct {
		Templates []WorkflowTemplate `json:"templates"`
	}
	env.mustJSON(t, "GET", "/api/v1/workflows", nil, &tpl)
	var publishTpl WorkflowTemplate
	for _, t2 := range tpl.Templates {
		if t2.BuiltinKey == "publish_prepare" {
			publishTpl = t2
		}
	}
	var runsBefore int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_run WHERE workspace_id=$1`, wsID).Scan(&runsBefore); err != nil {
		t.Fatal(err)
	}
	var out struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Detail  struct {
				Missing []string `json:"missing"`
			} `json:"detail"`
		} `json:"error"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/workflows/"+publishTpl.ID.String()+"/start",
		map[string]any{"account_id": a.ID.String()}, &out, http.StatusUnprocessableEntity)
	if out.Error.Code != "workflow_missing_input" {
		t.Fatalf("code = %s", out.Error.Code)
	}
	found := false
	for _, m := range out.Error.Detail.Missing {
		if m == "work_id" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing should list work_id: %+v", out.Error.Detail.Missing)
	}
	// 启动失败不留半成品：请求前后 run 总数不变（工作区为包内共享）。
	var runs int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_run WHERE workspace_id=$1`, wsID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != runsBefore {
		t.Fatalf("failed start must leave no run: before=%d after=%d", runsBefore, runs)
	}
}

func TestA7DisabledTemplateStartRejected(t *testing.T) {
	// A7 边界：停用模板 409 workflow_template_disabled。
	a := drAccount(t, "xhs", "A7 停用小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedWorkflowTemplates(context.Background(), wsID)
	var tpl struct {
		Templates []WorkflowTemplate `json:"templates"`
	}
	env.mustJSON(t, "GET", "/api/v1/workflows", nil, &tpl)
	var weekly WorkflowTemplate
	for _, t2 := range tpl.Templates {
		if t2.BuiltinKey == "weekly_review" {
			weekly = t2
		}
	}
	env.mustJSON(t, "PATCH", "/api/v1/workflows/"+weekly.ID.String(),
		map[string]any{"status": "disabled"}, nil)
	env.mustJSONStatus(t, "POST", "/api/v1/workflows/"+weekly.ID.String()+"/start",
		map[string]any{"account_id": a.ID.String(), "date_range": "2026-11-01..2026-11-07"}, nil, http.StatusConflict)
}
