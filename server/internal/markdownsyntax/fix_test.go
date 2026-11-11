package markdownsyntax

import "testing"

func TestFixPatchSafeSubsetAndApplyOnce(t *testing.T) {
	cases := []struct {
		name, content, syntax, want string
	}{
		{"toc", "前言\n[[TOC]]\n正文", "toc", "前言\n\n正文"},
		{"footnote ref", "引用[^a]。\n\n[^a]: 来源", "footnote", "引用。\n\n[^a]: 来源"},
		{"unsafe url", "看[这里](javascript:alert(1))结束", "unsafe_url", "看这里结束"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report := Scan([]Section{{ID: "s1", Heading: "样本", Content: tc.content}}, 1, nil)
			var finding Finding
			for _, issue := range report.Issues {
				if issue.Syntax == tc.syntax {
					finding = issue
					break
				}
			}
			if finding.Syntax == "" {
				t.Fatalf("missing %s finding: %+v", tc.syntax, report.Issues)
			}
			fix, ok := FixPatch(tc.content, finding)
			if !ok {
				t.Fatalf("FixPatch missed %s: suggestions=%+v", tc.syntax, report.FixSuggestions)
			}
			got, err := ApplyFix(tc.content, fix)
			if err != nil || got != tc.want {
				t.Fatalf("ApplyFix=%q err=%v want=%q fix=%+v", got, err, tc.want, fix)
			}
			again := Scan([]Section{{ID: "s1", Heading: "样本", Content: got}}, 1, nil)
			for _, issue := range again.Issues {
				if issue.Syntax == tc.syntax && issue.Line == finding.Line && issue.Column == finding.Column {
					t.Fatalf("applied fix left same finding: %+v", again.Issues)
				}
			}
		})
	}
}

func TestApplyFixRejectsDriftedRange(t *testing.T) {
	fix := FixSuggestion{From: "[[TOC]]", To: "", Offset: 0, Length: 7}
	if _, err := ApplyFix("a [[TOC]] b", fix); err == nil {
		t.Fatal("wrong offset must fail")
	}
	fix.Offset = 2
	if _, err := ApplyFix("xxCHANGED", fix); err == nil {
		t.Fatal("drifted From must fail")
	}
}

func TestSuggestFixesSkipsUnsupportedMath(t *testing.T) {
	report := Scan([]Section{{ID: "s1", Heading: "样本", Content: "公式 $x^2$"}}, 1, nil)
	if !report.HasErrors {
		t.Fatal("math must still block")
	}
	for _, s := range report.FixSuggestions {
		if s.Syntax == "math" {
			t.Fatalf("math must not be auto-fixable: %+v", s)
		}
	}
}
