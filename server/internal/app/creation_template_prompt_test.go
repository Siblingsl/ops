package app

import (
	"strings"
	"testing"
)

// CF-TPL-03（18 §3.5、T-101-4..6 / T-101-8）：模板提示词注入与段落数软提示。
func TestCreationTemplatePromptInjection(t *testing.T) {
	tpl := CreationTemplate{
		Name: "观点文",
		Structure: []TemplateStep{
			{Heading: "提出观点"},
			{Heading: "论据一"},
			{Heading: "回应反例"},
		},
		Tone:        "克制、具体",
		PromptAddon: "每个论据给具体场景。",
		SectionMin:  3,
		SectionMax:  5,
	}
	prompt := templatePrompt(&tpl)
	for _, want := range []string{"结构模板「观点文」", "提出观点 → 论据一 → 回应反例", "语气要求：克制、具体", "段落数建议 3 到 5 个", "补充要求：每个论据给具体场景。", "分工：模板负责结构"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("模板提示词缺少 %q：%s", want, prompt)
		}
	}
	if strings.Index(prompt, "提出观点") > strings.Index(prompt, "论据一") || strings.Index(prompt, "论据一") > strings.Index(prompt, "回应反例") {
		t.Fatalf("模板结构顺序被破坏：%s", prompt)
	}
	if templatePrompt(nil) != "" {
		t.Fatal("无模板时不应注入")
	}
}

func TestTemplateSectionHint(t *testing.T) {
	if got := templateSectionHint("观点文", 3, 5, 4); got != "" {
		t.Fatalf("区间内不应提示：%s", got)
	}
	for _, tc := range []struct {
		count int
		want  string
	}{
		{2, "本次生成 2 个"},
		{7, "本次生成 7 个"},
	} {
		got := templateSectionHint("观点文", 3, 5, tc.count)
		if !strings.Contains(got, "建议 3 到 5 个段落") || !strings.Contains(got, tc.want) || !strings.Contains(got, "不阻断") {
			t.Fatalf("count=%d 软提示不正确：%s", tc.count, got)
		}
	}
	if got := templateSectionHint("观点文", 0, 0, 2); got != "" {
		t.Fatalf("未设置区间不应提示：%s", got)
	}
}

// T-101-7：作品记录 template_id；编辑器切换模板只改后续生成依据，不动已写段落。
func TestCreationTemplateSwitchKeepsSections(t *testing.T) {
	f := env.accounts(t)
	mk := func(name string, format string) CreationTemplate {
		var tpl CreationTemplate
		env.mustJSON(t, "POST", "/api/v1/creation-templates", map[string]any{
			"content_format": format, "name": name,
			"structure":   []map[string]any{{"heading": name + "结构一"}, {"heading": name + "结构二"}},
			"section_min": 2, "section_max": 4, "tone": "平实",
		}, &tpl)
		return tpl
	}
	a, b := mk("模板甲", "long_article"), mk("模板乙", "long_article")
	other := mk("图文模板", "image_note")

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]any{
		"title": "切换模板", "template_id": a.ID,
	}, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "模板只影响后续生成"}, nil)
	var confirmed Work
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/outline", map[string]any{
		"items": []OutlineItem{{Heading: "已确认的一段", KeyPoint: "不要被切换改掉"}}, "confirm": true,
	}, &confirmed)
	if confirmed.TemplateID == nil || *confirmed.TemplateID != a.ID || len(confirmed.Sections) != 1 {
		t.Fatalf("作品应记录模板甲并生成段落：%+v", confirmed)
	}

	var switched Work
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{"template_id": b.ID}, &switched)
	if switched.TemplateID == nil || *switched.TemplateID != b.ID {
		t.Fatalf("切换后 template_id 应为模板乙：%+v", switched)
	}
	if len(switched.Sections) != 1 || switched.Sections[0].Heading != "已确认的一段" || switched.Sections[0].ContentMD != confirmed.Sections[0].ContentMD {
		t.Fatalf("切换模板不应改已写段落：before=%+v after=%+v", confirmed.Sections, switched.Sections)
	}
	if len(switched.Outline) != 1 || switched.Outline[0].Heading != "已确认的一段" || switched.OutlineConfirmedAt == nil {
		t.Fatalf("切换模板不应改已确认大纲：%+v", switched.Outline)
	}

	env.expectErr(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]any{"template_id": other.ID}, "validation_failed")
}
func TestCreationTemplateOutlineSoftHint(t *testing.T) {
	f := env.accounts(t)
	var tpl CreationTemplate
	env.mustJSON(t, "POST", "/api/v1/creation-templates", map[string]any{
		"content_format": "long_article",
		"name":           "软提示模板",
		"structure":      []map[string]any{{"heading": "开头"}, {"heading": "收尾"}},
		"section_min":    3,
		"section_max":    5,
		"tone":           "平实",
		"prompt_addon":   "不要写口号。",
	}, &tpl)

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]any{
		"title": "模板软提示", "template_id": tpl.ID,
	}, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "模板应约束结构"}, nil)

	var out struct {
		Items        []OutlineItem `json:"items"`
		TemplateHint string        `json:"template_hint"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/outline/generate", nil, &out)
	if len(out.Items) != 2 || out.Items[0].Heading != "开头" || out.Items[1].Heading != "收尾" {
		t.Fatalf("大纲未按模板结构输出：%+v", out.Items)
	}
	if !strings.Contains(out.TemplateHint, "建议 3 到 5 个段落") || !strings.Contains(out.TemplateHint, "本次生成 2 个") || !strings.Contains(out.TemplateHint, "不阻断") {
		t.Fatalf("段落数软提示缺失：%q", out.TemplateHint)
	}
}
