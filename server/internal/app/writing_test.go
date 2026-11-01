package app

import (
	"strings"
	"testing"
)


// DEV-CX13-D / 24 §4.10.2：登记窗口元数据后的发送前预算检查——
// 未登记不检查（现状 413/context_length_exceeded 映射兜底）；登记极小窗口时输入估算
// 超限 409 context_budget_exceeded 且不调用模型；登记充足窗口正常完成；负值清除登记。
// 窗口由用户按厂商文档显式登记，服务端不猜测厂商容量。载体：走 runAI 的 title 任务。
func TestCXContextBudgetGateBeforeSend(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "预算门禁验收"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "按可信材料给读者清楚步骤", "base_revision": work.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "当前章节", "key_point": "按依据解释", "material_ids": []string{}}},
	}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+work.Sections[0].ID.String(), map[string]any{
		"content_md": strings.Repeat("正文里解释了三天内可以完成的步骤，并按依据说明每一步的边界与前置条件，帮助读者判断哪一步适用于自己的情况。", 40), "base_revision": work.Sections[0].Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)

	var list []struct {
		ID                  string `json:"id"`
		ContextWindowTokens *int   `json:"context_window_tokens"`
	}
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	if len(list) == 0 {
		t.Fatal("dev mock provider expected")
	}
	providerID := list[0].ID
	path := "/api/v1/works/" + work.ID.String() + "/titles"
	const modelReply = `{"titles":[{"text":"三天内看懂内容表达","angle":"步骤型","reason":"呼应正文"}]}`

	// 未登记：不检查，正常完成。
	env.llm.PushReplies(modelReply)
	env.mustJSON(t, "POST", path, map[string]any{}, &struct{}{})

	// 登记极小窗口：估算输入超限 → 409，模型不被调用。
	tiny := 1200
	env.mustJSON(t, "PATCH", "/api/v1/model-providers/"+providerID, map[string]any{"context_window_tokens": tiny}, nil)
	callsBefore := len(env.llm.Requests())
	status, body := env.do("POST", path, map[string]any{})
	if status != 409 || !strings.Contains(string(body), "context_budget_exceeded") {
		t.Fatalf("tiny window must 409 before sending: %d %s", status, body)
	}
	if len(env.llm.Requests()) != callsBefore {
		t.Fatal("budget gate must not call the model")
	}

	// 登记充足窗口：正常完成。
	env.mustJSON(t, "PATCH", "/api/v1/model-providers/"+providerID, map[string]any{"context_window_tokens": 200000}, nil)
	env.llm.PushReplies(modelReply)
	env.mustJSON(t, "POST", path, map[string]any{}, &struct{}{})

	// 负值清除登记：恢复不检查。
	env.mustJSON(t, "PATCH", "/api/v1/model-providers/"+providerID, map[string]any{"context_window_tokens": -1}, nil)
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	if list[0].ContextWindowTokens != nil {
		t.Fatalf("negative clears registration: %+v", list[0].ContextWindowTokens)
	}
}
