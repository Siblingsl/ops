package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCXTitleRulesUseRunePositionsAndKeepAdLawAsOneDimension(t *testing.T) {
	result := scoreCXTitle("wechat_mp", "3天内看懂内容", []string{"内容"})
	if result.RuleScore != 50 || result.RuleMax != 60 || result.Coverage != "complete" {
		t.Fatalf("scoreCXTitle() = %+v, want complete 50/60", result)
	}
	if got := result.Dimensions["keywords"]; got.Score == nil || *got.Score != 10 {
		t.Fatalf("keyword score = %+v, want 10 for match at rune index 5", got)
	}
	if got := result.Dimensions["specificity"]; got.Score == nil || *got.Score != 10 {
		t.Fatalf("specificity score = %+v, want 10 for number, time and configured object", got)
	}

	withEmoji := scoreCXTitle("wechat_mp", "😀内容", []string{"内容"})
	if got := withEmoji.Dimensions["keywords"]; got.Score == nil || *got.Score != 10 {
		t.Fatalf("keyword score after emoji = %+v, want rune-index match", got)
	}

	adLaw := scoreCXTitle("wechat_mp", "最好用的运营方法!!!!!", []string{"运营"})
	if got := adLaw.Dimensions["cleanliness"]; got.Score == nil || *got.Score != 0 {
		t.Fatalf("cleanliness score = %+v, want 0 for M9 ad-law hit", got)
	}
	if adLaw.RuleScore <= 0 {
		t.Fatalf("ad-law hit must zero only cleanliness, got total rule score %d", adLaw.RuleScore)
	}
}

func TestCXTitleRulesReportUnavailableInputsAndXHSTitleLengthBands(t *testing.T) {
	partial := scoreCXTitle("wechat_mp", "说明一条具体内容主题", nil)
	if partial.RuleMax != 50 || partial.Coverage != "partial" || partial.Dimensions["keywords"].State != "unavailable" {
		t.Fatalf("missing positioning must be unavailable, got %+v", partial)
	}

	for _, test := range []struct{ length, want int }{{20, 10}, {21, 6}, {30, 6}, {31, 3}} {
		title := make([]rune, test.length)
		for i := range title {
			title[i] = '甲'
		}
		got := scoreCXTitle("xhs", string(title), []string{"甲"}).Dimensions["length"]
		if got.Score == nil || *got.Score != test.want {
			t.Fatalf("xhs title length %d score = %+v, want %d", test.length, got, test.want)
		}
	}
}

func TestCXTitleAIOutputRejectsUnknownFieldsAndUnverifiableSpans(t *testing.T) {
	valid := `{"dimensions":[{"key":"promise","score":12,"evidence":"正文证据"},{"key":"audience","score":8,"evidence":"正文证据"},{"key":"uniqueness","score":8,"evidence":"正文证据"},{"key":"risk","score":4,"evidence":"正文证据"}],"findings":[{"dimension":"promise","severity":"medium","evidence":"正文证据","span":{"start":0,"end":4,"unit":"unicode_code_point"},"section_id":"section-1","message":"标题承诺需要正文支撑","suggestion":"收窄承诺"}],"candidates":["三天内看懂内容表达"]}`
	var output cxTitleAIOutput
	if err := json.Unmarshal([]byte(valid), &output); err != nil {
		t.Fatalf("valid title diagnosis should decode: %v", err)
	}
	if err := output.validate("三天内看懂内容", []cxTitleDiagnosisSection{{ID: "section-1", Text: "正文证据可核验"}}); err != nil {
		t.Fatalf("valid rune span should be accepted: %v", err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"candidates":[`, `"extra":"ignored","candidates":[`, 1),
		strings.Replace(valid, `"end":4`, `"end":3`, 1),
		strings.Replace(valid, `"section_id":"section-1"`, `"section_id":"foreign-section"`, 1),
		strings.Replace(valid, `"end":4`, `"end":99`, 1),
		strings.Replace(valid, `"score":12`, `"score":12,"score":13`, 1),
	} {
		var invalid cxTitleAIOutput
		if err := json.Unmarshal([]byte(raw), &invalid); err != nil {
			continue
		}
		if err := invalid.validate("三天内看懂内容", []cxTitleDiagnosisSection{{ID: "section-1", Text: "正文证据可核验"}}); err == nil {
			t.Fatalf("invalid output must be rejected: %s", raw)
		}
	}
}

func TestCXTitleDiagnosisTaskHasRoutePromptAndNoSkillSupport(t *testing.T) {
	hasRoute, hasPrompt := false, false
	for _, task := range taskTypes {
		hasRoute = hasRoute || task.Type == "cx_title_diagnose"
	}
	for _, prompt := range editablePromptTasks {
		if prompt.Type == "cx_title_diagnose" {
			hasPrompt = true
			if prompt.Default == "" {
				t.Fatal("title diagnosis needs a default prompt")
			}
		}
	}
	if !hasRoute || !hasPrompt || skillTaskAllowed("cx_title_diagnose") || skillTaskApplicable(SkillFields{}, "cx_title_diagnose") {
		t.Fatalf("title task registration or skill boundary invalid: route=%v prompt=%v", hasRoute, hasPrompt)
	}
}

func TestCXTitleDiagnosisPersistsReportWithoutChangingWorkAndReusesSameInput(t *testing.T) {
	account := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "旧标题保持不变"}, &work)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET positioning_tags=$1 WHERE account_id=$2`, []string{"内容"}, account.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"viewpoint": "按可信材料给读者清楚步骤", "base_revision": work.Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	var outlined Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{
		"confirm": true, "base_revision": work.Revision,
		"items": []map[string]any{{"heading": "当前章节", "key_point": "按依据解释", "material_ids": []string{}}},
	}, &outlined)
	if len(outlined.Sections) != 1 {
		t.Fatalf("outline result = %+v", outlined)
	}
	var current Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &current)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+outlined.Sections[0].ID.String(), map[string]any{
		"content_md": "正文里解释了三天内可以完成的步骤。", "base_revision": outlined.Sections[0].Revision,
	}, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &current)
	const modelReply = `{"dimensions":[{"key":"promise","score":12,"evidence":"标题提出可理解的结果"},{"key":"audience","score":8,"evidence":"内容主题可辨认"},{"key":"uniqueness","score":8,"evidence":"表达直接"},{"key":"risk","score":4,"evidence":"未见明显风险"}],"findings":[],"candidates":["三天内看懂内容表达"]}`
	env.llm.PushReplies(modelReply)
	beforeCalls := len(env.llm.Requests())
	payload := map[string]any{"basis_revision": current.Revision, "title": "3天内看懂内容"}
	path := "/api/v1/works/" + work.ID.String() + "/diagnose-title"
	var first struct {
		DiagnosisID   uuid.UUID `json:"diagnosis_id"`
		InputScope    string    `json:"input_scope"`
		PromptVersion string    `json:"prompt_version"`
		Reused        bool      `json:"reused"`
		Result        struct {
			Title        string `json:"title"`
			InputScope   string `json:"input_scope"`
			RulesVersion string `json:"rules_version"`
			RuleScore    int    `json:"rule_score"`
			RuleMax      int    `json:"rule_max"`
			AIScore      int    `json:"ai_score"`
			Score        int    `json:"score"`
			Sources      struct {
				WorkUpdatedAt        string `json:"work_updated_at"`
				AssembledAt          string `json:"assembled_at"`
				PositioningUpdatedAt string `json:"positioning_updated_at"`
				Sections             []struct {
					UpdatedAt string `json:"updated_at"`
				} `json:"sections"`
			} `json:"sources"`
		} `json:"result"`
	}
	env.mustJSON(t, "POST", path, payload, &first)
	if first.DiagnosisID == uuid.Nil || first.Result.Title != "3天内看懂内容" || first.Result.InputScope != "unsaved" || first.Result.RulesVersion != "cx-title-1" || !strings.Contains(first.PromptVersion, "/cx-title-system-2/") || first.Result.RuleScore != 50 || first.Result.RuleMax != 60 || first.Result.AIScore != 32 || first.Result.Score != 82 || first.Reused {
		t.Fatalf("unexpected diagnosis result: %+v", first)
	}
	requestBodies := strings.Join(env.llm.Requests()[beforeCalls:], "\n")
	if !strings.Contains(requestBodies, "不得提供规避或操纵平台 AI 生成检测的建议") || !strings.Contains(requestBodies, "不按“规避/不要规避”等词语单独判断") {
		t.Fatalf("title model request must carry the versioned anti-evasion system boundary")
	}
	if first.Result.Sources.WorkUpdatedAt == "" || first.Result.Sources.AssembledAt == "" || first.Result.Sources.PositioningUpdatedAt == "" || len(first.Result.Sources.Sections) != 1 || first.Result.Sources.Sections[0].UpdatedAt == "" {
		t.Fatalf("title diagnosis source revisions need timestamps: %+v", first.Result.Sources)
	}
	var unchanged Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &unchanged)
	if unchanged.Title != "旧标题保持不变" || unchanged.Revision != current.Revision {
		t.Fatalf("diagnosis must not write the work, before=%+v after=%+v", current, unchanged)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM content_diagnosis WHERE id=$1 AND kind='title' AND input_scope='unsaved'`, first.DiagnosisID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("title report row count=%d err=%v", count, err)
	}
	var history struct {
		Items []struct {
			DiagnosisID uuid.UUID `json:"diagnosis_id"`
			Stale       bool      `json:"stale"`
		} `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String()+"/diagnoses?kind=title", nil, &history)
	if len(history.Items) != 1 || history.Items[0].DiagnosisID != first.DiagnosisID || history.Items[0].Stale {
		t.Fatalf("title history should return current report: %+v", history)
	}
	var detail struct {
		DiagnosisID uuid.UUID `json:"diagnosis_id"`
		Stale       bool      `json:"stale"`
		Result      struct {
			Title string `json:"title"`
		} `json:"result"`
	}
	env.mustJSON(t, "GET", "/api/v1/diagnoses/"+first.DiagnosisID.String(), nil, &detail)
	if detail.DiagnosisID != first.DiagnosisID || detail.Stale || detail.Result.Title != "3天内看懂内容" {
		t.Fatalf("generic diagnosis detail should dispatch to title report: %+v", detail)
	}
	var refs, privateRefs []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT context_refs,private_context_refs FROM ai_call WHERE task_type='cx_title_diagnose' AND work_id=$1 ORDER BY created_at DESC LIMIT 1`, work.ID).Scan(&refs, &privateRefs); err != nil || strings.Contains(string(refs)+string(privateRefs), "三天内可以完成") {
		t.Fatalf("raw work body must not enter ai_call metadata: %s %s (%v)", refs, privateRefs, err)
	}
	var reused struct {
		DiagnosisID uuid.UUID `json:"diagnosis_id"`
		Reused      bool      `json:"reused"`
	}
	env.mustJSON(t, "POST", path, payload, &reused)
	if reused.DiagnosisID != first.DiagnosisID || !reused.Reused || len(env.llm.Requests())-beforeCalls != 1 {
		t.Fatalf("same source/input should reuse the diagnosis: first=%+v reused=%+v model_calls=%d", first, reused, len(env.llm.Requests())-beforeCalls)
	}
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_section SET content_md='作品正文已经变化。',revision=revision+1 WHERE work_id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/diagnoses/"+first.DiagnosisID.String(), nil, &detail)
	if !detail.Stale || detail.Result.Title != "3天内看懂内容" {
		t.Fatalf("changed source should retain report and mark it stale: %+v", detail)
	}
	userID := uuid.MustParse(env.me(t).UserID)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, ownerWS(t), userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, ownerWS(t), userID)
	})
	env.expectErr(t, "POST", path, payload, "forbidden")
}

// DEV-CX13-D / 24 §4.10.2：登记窗口元数据后的发送前预算检查——
// 未登记不检查（现状 413 映射兜底）；登记极小窗口时输入估算超限 409 context_budget_exceeded；
