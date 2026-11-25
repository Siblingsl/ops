package compliance

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSentenceAroundChineseAndBoundaries(t *testing.T) {
	text := "第一句。这里有稳赚的说法！下一句"
	idx := strings.Index(text, "稳赚")
	if got := SentenceAround(text, idx, len("稳赚")); got != "这里有稳赚的说法！" {
		t.Fatalf("Chinese sentence = %q", got)
	}
	english := "First sentence! Second sentence? Third"
	idx = strings.Index(english, "Second")
	if got := SentenceAround(english, idx, len("Second")); got != "Second sentence?" {
		t.Fatalf("English sentence = %q", got)
	}
	if got := SentenceAround("只有一句", 0, len("只有")); got != "只有一句" {
		t.Fatalf("boundary sentence = %q", got)
	}
	if got := SentenceAround("末尾句。", 0, len("末尾")); got != "末尾句。" {
		t.Fatalf("punctuation boundary = %q", got)
	}
}

func TestFingerprintStable(t *testing.T) {
	first := Fingerprint("sensitive", "稳赚", "这里有稳赚的说法！")
	if len(first) != 32 || first != Fingerprint("sensitive", "稳赚", "这里有稳赚的说法！") {
		t.Fatalf("fingerprint must be stable 32 hex: %q", first)
	}
	if first == Fingerprint("sensitive", "稳赚", "另一句") {
		t.Fatal("fingerprint must include sentence")
	}
}

func TestCustomThemeContrastRatio(t *testing.T) {
	if got := CustomThemePrimaryContrastRatio("#000000"); got < 20.99 || got > 21.01 {
		t.Fatalf("black contrast = %v", got)
	}
	if got := CustomThemePrimaryContrastRatio("#ffffff"); got != 1 {
		t.Fatalf("white contrast = %v", got)
	}
	if got := CustomThemePrimaryContrastRatio("#777777"); got >= 4.5 {
		t.Fatalf("low contrast must be below 4.5:1: %v", got)
	}
	if got := CustomThemePrimaryContrastRatio("#767676"); got < 4.5 {
		t.Fatalf("boundary contrast should pass: %v", got)
	}
}

func TestValidateCustomThemeInput(t *testing.T) {
	base, msg := ValidateCustomThemeInput("", "#000000", 14, 1.4, 8, "plain", "bar")
	if base != "ink" || msg != "" {
		t.Fatalf("legal boundary: base=%q msg=%q", base, msg)
	}
	if base, msg := ValidateCustomThemeInput("paper", "#000000", 17, 2.2, 32, "block", "italic"); base != "paper" || msg != "" {
		t.Fatalf("all legal styles: base=%q msg=%q", base, msg)
	}
	cases := []struct {
		name           string
		primary        string
		size           int
		line           float64
		gap            int
		heading, quote string
		want           string
	}{
		{"color-format", "123", 14, 1.4, 8, "plain", "bar", "主色需要是 #RRGGBB 格式"},
		{"contrast", "#ffffff", 14, 1.4, 8, "plain", "bar", "主色与白色背景的文字对比度不足 4.5:1"},
		{"font-low", "#000000", 13, 1.4, 8, "plain", "bar", "正文字号需在 14–17px 之间"},
		{"font-high", "#000000", 18, 1.4, 8, "plain", "bar", "正文字号需在 14–17px 之间"},
		{"line-low", "#000000", 14, 1.3, 8, "plain", "bar", "行距需在 1.4–2.2 之间"},
		{"line-high", "#000000", 14, 2.3, 8, "plain", "bar", "行距需在 1.4–2.2 之间"},
		{"gap-low", "#000000", 14, 1.4, 7, "plain", "bar", "段间距需在 8–32px 之间"},
		{"gap-high", "#000000", 14, 1.4, 33, "plain", "bar", "段间距需在 8–32px 之间"},
		{"heading", "#000000", 14, 1.4, 8, "other", "bar", "标题样式无效"},
		{"quote", "#000000", 14, 1.4, 8, "plain", "other", "引用样式无效"},
	}
	for _, tc := range cases {
		base, msg := ValidateCustomThemeInput("", tc.primary, tc.size, tc.line, tc.gap, tc.heading, tc.quote)
		if base != "ink" || msg != tc.want {
			t.Errorf("%s: base=%q msg=%q want %q", tc.name, base, msg, tc.want)
		}
	}
}

func TestLayoutRulesFourKindsAndDeduplication(t *testing.T) {
	id := uuid.New()
	golden := "收藏的金句"
	content := "收藏的金句。\n\n真正重要的是保持节奏。\n\n第一，甲；其次，乙；最后，丙。"
	out := LayoutRules(id, content, []string{golden})
	kinds := map[string]bool{}
	for _, suggestion := range out {
		kinds[suggestion.Kind] = true
		if suggestion.SectionID != id {
			t.Fatalf("section id mismatch: %+v", suggestion)
		}
	}
	if !kinds["bold"] || !kinds["list"] {
		t.Fatalf("want bold and list: %+v", out)
	}
	if len(out) != 3 {
		t.Fatalf("want golden bold + viewpoint bold + list, got %d: %+v", len(out), out)
	}

	long := strings.Repeat("这是一段较长的正文。", 90) + "\n\n第二段" + "\n\n第三段" + "\n\n第四段"
	out = LayoutRules(id, long, nil)
	foundDivider := false
	for _, suggestion := range out {
		if suggestion.Kind == "divider" {
			foundDivider = true
		}
	}
	if !foundDivider {
		t.Fatalf("want divider: %+v", out)
	}

	already := "**收藏的金句**。\n\n- 第一，甲；其次，乙；最后，丙。\n\n" +
		strings.Repeat("这是一段较长的正文。", 90) + "\n---\n第四段"
	out = LayoutRules(id, already, []string{golden})
	for _, suggestion := range out {
		if suggestion.Kind == "bold" || suggestion.Kind == "list" || suggestion.Kind == "divider" {
			t.Fatalf("bold/list/divider should be skipped: %+v", suggestion)
		}
	}
	if len(out) != 0 {
		t.Fatalf("existing emphasis/list/divider must be skipped: %+v", out)
	}
}
