package provenance

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestNormalizeAndDigitsOnly(t *testing.T) {
	cases := []struct{ in, want string }{
		{"秋天的**第一杯**咖啡", "秋天的第一杯咖啡"},
		{"全角，标点。测试", "全角,标点.测试"},
		{"Hello   World", "HelloWorld"},
		{"ＡＢＣ１２３", "ABC123"},
		{"`code` 与 _斜体_", "code与斜体"},
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := DigitsOnly("1,234.00 元"); got != "123400" {
		t.Fatalf("DigitsOnly = %q", got)
	}
}

func TestKindAndPurposeRules(t *testing.T) {
	if got := KindsOf("G"); !KindAllowed(got, SrcUser) || !KindAllowed(got, SrcAttachment) || !KindAllowed(got, SrcG) || KindAllowed(got, SrcO) {
		t.Fatalf("G kinds = %v", got)
	}
	if got := KindsOf("U/G/O"); len(got) != 4 {
		t.Fatalf("U/G/O kinds = %v", got)
	}
	for source, wantU := range map[string]bool{"U": true, "U/G/O": false, "U/O": false, "G/O": false, "G": false, "O": false, "F": false, "": false} {
		if got := SourceIsU(source); got != wantU {
			t.Errorf("SourceIsU(%q) = %v, want %v", source, got, wantU)
		}
	}
	for source, wantNeeds := range map[string]bool{"U": true, "U/G/O": true, "U/O": true, "G/O": true, "G": true, "O": true, "F": false, "": false} {
		if got := NeedsProvenance(source); got != wantNeeds {
			t.Errorf("NeedsProvenance(%q) = %v, want %v", source, got, wantNeeds)
		}
	}
	if NeedsProvenance("F") || NeedsProvenance("") {
		t.Fatal("F and empty must not need provenance")
	}

	all := []string{SrcUser, SrcAttachment, SrcG, SrcO}
	if !SourceAllowed(Source{Kind: SrcG, Purpose: PurposeBusiness}, all, PurposeBusiness) {
		t.Fatal("business G source must serve business fields")
	}
	if SourceAllowed(Source{Kind: SrcG, Purpose: PurposeBusiness}, all, PurposeSkill) {
		t.Fatal("business G source must not serve skill fields")
	}
	if SourceAllowed(Source{Kind: SrcG, Purpose: PurposeSkill}, all, PurposeBusiness) {
		t.Fatal("skill source must not serve business fields")
	}
	if !SourceAllowed(Source{Kind: SrcG, Purpose: PurposeSkill}, all, PurposeSkill) {
		t.Fatal("skill source must serve skill fields")
	}
	if !SourceAllowed(Source{Kind: SrcUser, Purpose: PurposeBusiness}, all, PurposeSkill) {
		t.Fatal("user source must serve skill fields")
	}
	if !SourceAllowed(Source{Kind: SrcAttachment, Purpose: PurposeBusiness}, all, PurposeSkill) {
		t.Fatal("attachment source must serve skill fields")
	}
	if SourceAllowed(Source{Kind: SrcO}, all, PurposeBusiness) == false {
		t.Fatal("O source must serve business fields")
	}
}

func TestToolSourceRulesAndExcludedTools(t *testing.T) {
	cases := []struct {
		kind   string
		aiCost bool
		want   string
	}{
		{"G", false, SrcG},
		{"W", true, SrcG},
		{"W", false, ""},
		{"R", false, SrcO},
		{"H", false, ""},
		{"X", false, ""},
	}
	for _, c := range cases {
		if got := ToolSourceKind(c.kind, c.aiCost); got != c.want {
			t.Errorf("ToolSourceKind(%q,%v) = %q, want %q", c.kind, c.aiCost, got, c.want)
		}
	}
	for _, name := range []string{"load_skill", "skills__list", "get_context", "get_skill_context"} {
		if !SkillExcludedSourceTools[name] {
			t.Errorf("%s must be excluded", name)
		}
	}
	for _, name := range []string{"skills__get", "skills__draft"} {
		if !SkillDefSourceTools[name] {
			t.Errorf("%s must be a skill source tool", name)
		}
	}
}

func TestSkillDefTextsWhitelistAndNestedExclusion(t *testing.T) {
	body := `{"name":"标题","summary":"摘要","triggers":["触发"],"instructions":"步骤","error":"错误","warnings":["警告"],"meta":{"instructions_extra":"不应采集"}}`
	texts := SkillDefTexts(body)
	want := map[string]bool{"标题": true, "摘要": true, "步骤": true}
	if len(texts) != len(want) {
		t.Fatalf("whitelist texts = %+v", texts)
	}
	for _, text := range texts {
		if !want[text] {
			t.Fatalf("unexpected skill text %q", text)
		}
	}
	if got := SkillDefTexts("not json"); got != nil {
		t.Fatalf("invalid JSON must return nil: %+v", got)
	}
}

func TestResultTexts(t *testing.T) {
	body := `{"title":" 标题 ","nested":{"body":"正文"},"list":["一","二"],"empty":"  ","meta":{"id":1}}`
	got := ResultTexts(body)
	if len(got) != 4 {
		t.Fatalf("result texts = %+v", got)
	}
	if plain := ResultTexts("  plain body  "); len(plain) != 1 || plain[0] != "plain body" {
		t.Fatalf("non-JSON body = %+v", plain)
	}
	if empty := ResultTexts("   "); empty != nil {
		t.Fatalf("blank body = %+v", empty)
	}
}

func TestSourceSetMatchExactSubstringMultiParagraphAndShort(t *testing.T) {
	set := &SourceSet{Sources: []Source{
		{Kind: SrcG, AICallID: uuid.New(), Norms: []string{"第一段的正文内容", "第二段的正文内容"}},
		{Kind: SrcG, AICallID: uuid.New(), Norms: []string{"别处的文字"}},
	}}
	kinds := []string{SrcUser, SrcAttachment, SrcG, SrcO}
	if _, ok := set.Match(kinds, PurposeBusiness, "第一段的正文内容"); !ok {
		t.Fatal("exact candidate must match")
	}
	if _, ok := set.Match(kinds, PurposeBusiness, "第一段的正文"); !ok {
		t.Fatal("substring must match")
	}
	if _, ok := set.Match(kinds, PurposeBusiness, "第一段的正文内容\n\n第二段的正文内容"); !ok {
		t.Fatal("same-source paragraphs must pass")
	}
	if _, ok := set.Match(kinds, PurposeBusiness, "第一段的正文内容\n\n别处的文字"); ok {
		t.Fatal("cross-source paragraphs must fail")
	}

	set2 := &SourceSet{Sources: []Source{
		{Kind: SrcUser, Norms: []string{"第一段的正文内容"}},
		{Kind: SrcG, AICallID: uuid.New(), Norms: []string{"第一段的正文内容", "第二段的正文内容"}},
	}}
	hit, ok := set2.Match(kinds, PurposeBusiness, "第一段的正文内容\n\n第二段的正文内容")
	if !ok || hit.Kind != SrcG {
		t.Fatalf("intersection must choose covering source: %+v %v", hit, ok)
	}

	if _, ok := set.Match(nil, PurposeBusiness, "无"); !ok {
		t.Fatal("short value must be treated as F")
	}
	if _, ok := set.Match(kinds, PurposeBusiness, "abc"); !ok {
		t.Fatal("3-rune value must be treated as F")
	}
	if _, ok := set.Match(kinds, PurposeBusiness, "abcd"); ok {
		t.Fatal("4-rune unsupported value must fail")
	}
}

func TestParamValueTextsNumberAndDigitsMatched(t *testing.T) {
	v := []any{"标题", map[string]any{"body": "正文", "empty": "  "}, nil}
	got := ParamValueTexts(v)
	if len(got) != 2 || got[0] != "标题" || got[1] != "正文" {
		t.Fatalf("param texts = %+v", got)
	}
	if got := NumberValueText(float64(1234)); got != "1234" {
		t.Fatalf("float text = %q", got)
	}
	if got := NumberValueText(json.Number("1.50")); got != "1.50" {
		t.Fatalf("json number text = %q", got)
	}
	if got := NumberValueText(true); got != "" {
		t.Fatalf("bool text = %q", got)
	}

	set := &SourceSet{Sources: []Source{
		{Kind: SrcG, Text: "营收 1,234 万元"},
		{Kind: SrcO, Text: "营收 9876 万元"},
	}}
	if !DigitsMatched(set, []string{SrcG}, "1234") {
		t.Fatal("thousands separators must be ignored")
	}
	if !DigitsMatched(set, nil, "") {
		t.Fatal("empty digits must pass")
	}
	if DigitsMatched(set, []string{SrcO}, "1234") {
		t.Fatal("digit match must respect kinds")
	}
}
