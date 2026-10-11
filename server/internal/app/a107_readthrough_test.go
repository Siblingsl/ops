package app

import (
	"strings"
	"testing"
)

// DEV-A107（13 文档）：整篇通读建议——AI 通读全文按段落输出结构化建议（改写/补充），
// 逐条应用走 A104 的对比确认通道；H-02 观点门槛与空内容拦截。
func TestA107ReadThrough(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "通读验收"}, &wk)
	wid := wk.ID.String()

	// H-02：没有观点不能通读。
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wid+"/read-through", nil, "human_step_required")
	if !strings.Contains(ae.Error.Message, "核心观点") {
		t.Fatalf("message: %s", ae.Error.Message)
	}
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wid, map[string]string{"viewpoint": "把复杂的事情讲清楚"}, nil)
	env.expectErr(t, "POST", "/api/v1/works/"+wid+"/read-through", nil, "validation_failed")

	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/outline/generate", nil, &outline)
	env.mustJSON(t, "PUT", "/api/v1/works/"+wid+"/outline", map[string]any{"items": outline.Items[:2], "confirm": true}, &wk)
	for _, sec := range wk.Sections {
		ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil))
		if ev.Name != "done" {
			t.Fatalf("draft: %s %s", ev.Name, ev.Data)
		}
	}

	var out struct {
		Suggestions []struct {
			SectionID string `json:"section_id"`
			Action    string `json:"action"`
			Text      string `json:"text"`
			Reason    string `json:"reason"`
		} `json:"suggestions"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/read-through", nil, &out)
	if len(out.Suggestions) == 0 || len(out.Suggestions) > 2 {
		t.Fatalf("suggestions: %+v", out.Suggestions)
	}
	valid := map[string]bool{}
	for _, s := range wk.Sections {
		valid[s.ID.String()] = true
	}
	actions := map[string]bool{}
	for _, su := range out.Suggestions {
		if !valid[su.SectionID] || (su.Action != "rewrite" && su.Action != "append") || su.Text == "" || su.Reason == "" {
			t.Fatalf("suggestion: %+v", su)
		}
		actions[su.Action] = true
	}
	if !actions["rewrite"] || !actions["append"] {
		t.Fatalf("mock should cover both actions: %+v", actions)
	}
}
