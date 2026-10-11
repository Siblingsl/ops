package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-U107（12 文档）：提示词模板包真实模型批量重放——选定任务类型，后台逐用例以当前
// 路由与模板重放（is_eval 用量），汇总 JSON 解析成功率与逐条输出；不自动改写提示词。
func TestU107PromptEvalBatch(t *testing.T) {
	_ = env.accounts(t)
	var ws uuid.UUID
	if e := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE name='测试公众号' LIMIT 1`).Scan(&ws); e != nil {
		t.Fatal(e)
	}
	insertCase := func(task, name, system, user string, jsonMode bool) uuid.UUID {
		snap, _ := json.Marshal(evalSnapshot{System: system, UserRest: user, JSON: jsonMode})
		var id uuid.UUID
		if e := env.srv.db.QueryRow(context.Background(),
			`INSERT INTO prompt_eval_case (workspace_id, task_type, name, context_snapshot, created_by)
			 SELECT $1,$2,$3,$4, id FROM app_user LIMIT 1 RETURNING id`, ws, task, name, snap).Scan(&id); e != nil {
			t.Fatal(e)
		}
		return id
	}
	case1 := insertCase("topic_suggest", "选题用例", "你是一位内容助手。", "任务：topic_suggest\n方向关键词：批量重放", true)
	_ = insertCase("topic_suggest", "选题用例 2", "你是一位内容助手。", "任务：topic_suggest\n方向关键词：第二轮", true)
	case3 := insertCase("section_draft", "起草用例", "你是一位内容助手。", "任务：section_draft\n本段小标题：为什么\n本段要点：批量重放自检", false)

	// 未知任务类型拒绝。
	env.expectErr(t, "POST", "/api/v1/prompt-eval/replay", map[string]any{"task_types": []string{"nope"}}, "validation_failed")

	var start struct {
		JobID uuid.UUID `json:"job_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/prompt-eval/replay", map[string]any{"task_types": []string{"topic_suggest"}}, &start)
	if start.JobID == uuid.Nil {
		t.Fatal("no job")
	}
	var result json.RawMessage
	deadline := time.Now().Add(30 * time.Second)
	for {
		var j struct {
			Status string          `json:"status"`
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
		}
		env.mustJSON(t, "GET", "/api/v1/ai-jobs/"+start.JobID.String(), nil, &j)
		if j.Status == "done" {
			result = j.Result
			break
		}
		if j.Status == "failed" || j.Status == "cancelled" {
			t.Fatalf("batch job: %s %s", j.Status, j.Error)
		}
		if time.Now().After(deadline) {
			t.Fatal("batch job timeout")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var out struct {
		Tasks []struct {
			TaskType string `json:"task_type"`
			Cases    int    `json:"cases"`
			JSONOK   int    `json:"json_ok"`
			Failed   int    `json:"failed"`
		} `json:"tasks"`
		Rows []struct {
			CaseID uuid.UUID `json:"case_id"`
			OK     bool      `json:"ok"`
			JSONOK *bool     `json:"json_ok"`
			Output string    `json:"output"`
		} `json:"rows"`
	}
	if e := json.Unmarshal(result, &out); e != nil {
		t.Fatalf("result: %s", result)
	}
	if len(out.Tasks) != 1 || out.Tasks[0].Cases != 2 || out.Tasks[0].JSONOK != 2 || out.Tasks[0].Failed != 0 {
		t.Fatalf("summary: %+v", out.Tasks)
	}
	if len(out.Rows) != 2 || !out.Rows[0].OK || out.Rows[0].JSONOK == nil || !*out.Rows[0].JSONOK || out.Rows[0].Output == "" {
		t.Fatalf("rows: %+v", out.Rows)
	}
	if out.Rows[0].CaseID != case1 && out.Rows[1].CaseID != case1 {
		t.Fatalf("case1 missing: %+v", out.Rows)
	}

	// 评测调用计入 is_eval 用量，且与业务调用区分。
	var n int
	if e := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM ai_call WHERE task_type='topic_suggest' AND is_eval AND context_refs->>'prompt_eval'='true'`).Scan(&n); e != nil || n < 2 {
		t.Fatalf("eval calls %d %v", n, e)
	}

	// 第二次：包含文本任务（section_draft 无 JSON 断言）。
	env.mustJSON(t, "POST", "/api/v1/prompt-eval/replay", map[string]any{"task_types": []string{"topic_suggest", "section_draft"}}, &start)
	var result2 json.RawMessage
	deadline = time.Now().Add(30 * time.Second)
	for {
		var j struct {
			Status string          `json:"status"`
			Result json.RawMessage `json:"result"`
			Error  string          `json:"error"`
		}
		env.mustJSON(t, "GET", "/api/v1/ai-jobs/"+start.JobID.String(), nil, &j)
		if j.Status == "done" {
			result2 = j.Result
			break
		}
		if j.Status == "failed" || j.Status == "cancelled" {
			t.Fatalf("batch job 2: %s %s", j.Status, j.Error)
		}
		if time.Now().After(deadline) {
			t.Fatal("batch job 2 timeout")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var out2 struct {
		Tasks []struct {
			TaskType string `json:"task_type"`
			Cases    int    `json:"cases"`
		} `json:"tasks"`
		Rows []struct {
			TaskType string `json:"task_type"`
			JSONOK   *bool  `json:"json_ok"`
		} `json:"rows"`
	}
	if e := json.Unmarshal(result2, &out2); e != nil {
		t.Fatalf("result2: %s", result2)
	}
	if len(out2.Tasks) != 2 {
		t.Fatalf("summary2: %+v", out2.Tasks)
	}
	foundDraft := false
	for _, ts := range out2.Tasks {
		if ts.TaskType == "section_draft" {
			foundDraft = ts.Cases == 1
		}
	}
	if !foundDraft {
		t.Fatalf("section_draft summary missing: %+v", out2.Tasks)
	}
	for _, r := range out2.Rows {
		if r.TaskType == "section_draft" && r.JSONOK != nil {
			t.Fatal("text task should not have json verdict")
		}
	}
	_ = case3

	// 没有用例的任务类型：明确报错。
	env.expectErr(t, "POST", "/api/v1/prompt-eval/replay", map[string]any{"task_types": []string{"title"}}, "validation_failed")
}
