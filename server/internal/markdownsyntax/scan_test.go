package markdownsyntax

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type syntaxFixture struct {
	Name      string   `json:"name"`
	Markdown  string   `json:"markdown"`
	Issues    []string `json:"issues"`
	Converted []string `json:"converted"`
	Warnings  []string `json:"warnings"`
	Truncated bool     `json:"truncated"`
}

func TestScanMatchesSharedCX01Fixtures(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "testdata", "cx01-syntax-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []syntaxFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			report := Scan([]Section{{ID: "fixture", Heading: fixture.Name, Content: fixture.Markdown}}, 1, nil)
			assertSyntaxes := func(label string, got []Finding, want []string) {
				set := map[string]bool{}
				for _, finding := range got {
					set[finding.Syntax] = true
				}
				actual := make([]string, 0, len(set))
				for syntax := range set {
					actual = append(actual, syntax)
				}
				sort.Strings(actual)
				expected := append([]string(nil), want...)
				sort.Strings(expected)
				if strings.Join(actual, ",") != strings.Join(expected, ",") {
					t.Errorf("%s classifications=%v, want %v", label, actual, expected)
				}
			}
			assertSyntaxes("issues", report.Issues, fixture.Issues)
			assertSyntaxes("converted", report.Converted, fixture.Converted)
			assertSyntaxes("warnings", report.Warnings, fixture.Warnings)
			if report.Truncated != fixture.Truncated {
				t.Errorf("truncated=%v, want %v", report.Truncated, fixture.Truncated)
			}
			if report.HasErrors != (len(fixture.Issues) > 0) {
				t.Errorf("blocked=%v for expected issues %v", report.HasErrors, fixture.Issues)
			}
		})
	}
}

func TestScanLeavesSupportedDOMAndCodeExamplesUnblocked(t *testing.T) {
	input := []Section{{ID: "s1", Heading: "开头", Content: "# 一级\n## 二级\n### 三级\n#### 加粗\n- [ ] 待办\n\n`[^1] $100`\n\\[[TOC]]\n\n```text\n[^1] $x^2$ Mermaid\n```\n\n<dl><dt>术语</dt><dd style=\"color:#123456\">说明</dd></dl>\n\n| 列 | 值 |\n| --- | --- |\n| A | B |"}}
	report := Scan(input, 7, map[string]bool{})
	if report.HasErrors || len(report.Issues) != 0 {
		t.Fatalf("supported structures and code examples must stay unblocked: %+v", report)
	}
	if len(report.Converted) != 4 {
		t.Fatalf("h1/h2/h4 and task list conversions should be visible, got %+v", report.Converted)
	}
	if report.BasisRevision != 7 || len(report.InputHash) != 64 || report.RulesVersion != "cx-render-1" {
		t.Fatalf("report must carry revision, canonical hash, and rules version: %+v", report)
	}
}

func TestScanReportsUnsupportedSyntaxOutsideCodeAndEscapes(t *testing.T) {
	for _, tc := range []struct {
		name, content, syntax string
		line, column          int
	}{
		{"footnote", "引用[^a]。\n\n[^a]: 来源", "footnote", 1, 3},
		{"definition list", "术语\n: 说明", "definition_list", 2, 1},
		{"reference link", "[文档][ref]\n\n[ref]: https://example.com", "reference_link", 1, 1},
		{"inline math", "公式 $x^2$", "math", 1, 4},
		{"block math", "$$\nx^2\n$$", "math", 1, 1},
		{"toc", "[[TOC]]", "toc", 1, 1},
		{"mermaid", "```mermaid\ngraph TD\n```", "mermaid", 1, 1},
		{"deep list", "- one\n  - two\n    - three\n      - four", "list_too_deep", 4, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report := Scan([]Section{{ID: "s1", Heading: "样本", Content: tc.content}}, 1, nil)
			if !report.HasErrors {
				t.Fatalf("%s must block, report=%+v", tc.name, report)
			}
			for _, finding := range report.Issues {
				if finding.Syntax == tc.syntax {
					if finding.Line != tc.line || finding.Column != tc.column {
						t.Fatalf("%s location=(%d,%d), want (%d,%d)", tc.name, finding.Line, finding.Column, tc.line, tc.column)
					}
					return
				}
			}
			t.Fatalf("%s not reported: %+v", tc.name, report.Issues)
		})
	}
}

func TestScanReportsOneReferenceLinkAtItsUsage(t *testing.T) {
	content := "[文档][ref]\n\n[ref]: https://example.com"
	report := Scan([]Section{{ID: "s1", Heading: "引用", Content: content}}, 1, nil)
	var found []Finding
	for _, issue := range report.Issues {
		if issue.Syntax == "reference_link" {
			found = append(found, issue)
		}
	}
	if len(found) != 1 || found[0].Line != 1 || found[0].Column != 1 {
		t.Fatalf("reference link should have one finding at the usage, got %+v", found)
	}
}

func TestScanRejectsDangerousHTMLAndMasksSensitiveExcerpt(t *testing.T) {
	for _, content := range []string{
		`<script>alert(1)</script>`,
		`<p onclick="run()">text</p>`,
		`<a href="javascript:alert(1)">text</a>`,
		`<link rel="stylesheet" href="https://cdn.example.com/theme.css">`,
	} {
		report := Scan([]Section{{ID: "s1", Heading: "样本", Content: content}}, 1, nil)
		if !report.HasErrors || len(report.Issues) == 0 {
			t.Fatalf("dangerous HTML must block: %q => %+v", content, report)
		}
	}
	content := "联系 author@example.com 后引用[^a]。\n[^a]: 来源"
	report := Scan([]Section{{ID: "s1", Heading: "样本", Content: content}}, 1, nil)
	for _, issue := range report.Issues {
		if issue.Syntax == "footnote" {
			if strings.Contains(issue.Excerpt, "author@example.com") || len([]rune(issue.Excerpt)) > 80 {
				t.Fatalf("excerpt must mask secrets and stay within 80 code points: %q", issue.Excerpt)
			}
			return
		}
	}
	t.Fatalf("footnote report missing: %+v", report)
}

func TestScanWarnsAboutRenderedFallbacksAndUnmanagedImages(t *testing.T) {
	managedID := "123e4567-e89b-12d3-a456-426614174000"
	content := "[相对链接](guide.md)\n\n![外链图](https://cdn.example.com/a.png)\n\n" +
		"![本作品图片](/api/v1/assets/" + managedID + "/file)\n\n<custom-box>保留子内容</custom-box>"
	report := Scan([]Section{{ID: "s1", Heading: "样本", Content: content}}, 1, map[string]bool{managedID: true})
	if report.HasErrors {
		t.Fatalf("warnings and safe unknown-tag fallback must not block: %+v", report)
	}
	warnings := map[string]int{}
	for _, warning := range report.Warnings {
		warnings[warning.Syntax]++
	}
	if warnings["relative_link"] != 1 || warnings["unmanaged_image"] != 1 {
		t.Fatalf("relative links and unmanaged images need explicit warnings; got %+v", report.Warnings)
	}
	converted := map[string]int{}
	for _, item := range report.Converted {
		converted[item.Syntax]++
	}
	if converted["html_tag_fallback"] != 1 {
		t.Fatalf("unknown safe HTML fallback must be reported without flattening children: %+v", report.Converted)
	}
}

func TestScanKeepsMoreThanFiftyErrorsBlockingAfterTruncation(t *testing.T) {
	var body strings.Builder
	body.WriteString("[^x]: source\n")
	for i := 0; i < 51; i++ {
		body.WriteString("引用[^x]。\n")
	}
	report := Scan([]Section{{ID: "s1", Heading: "样本", Content: body.String()}}, 3, nil)
	if !report.HasErrors || !report.Truncated || report.Total <= 50 || len(report.Issues) != 50 {
		t.Fatalf("more than fifty findings must remain blocked and report truncation: total=%d issues=%d truncated=%v blocked=%v", report.Total, len(report.Issues), report.Truncated, report.HasErrors)
	}
}
