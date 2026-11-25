package privacy

import (
	"fmt"
	"strings"
	"testing"

	"ops/internal/cxbuildvalidate"
)

func TestRulesPositiveAndNegative(t *testing.T) {
	cases := []struct {
		rule     string
		positive string
		negative string
	}{
		{"absolute_path_windows", `C:\Users\fixture\article.html`, `C: is a drive label, not an absolute path`},
		{"absolute_path_home", `/home/fixture/notes.txt`, `a home directory is not mentioned`},
		{"private_key_header", `-----BEGIN PRIVATE KEY-----`, `PRIVATE KEY is only described`},
		{"credential_token", `sk-` + strings.Repeat("a", 28), `The article mentions sk- as a term.`},
		{"email_candidate", `reader.fixture@example.invalid`, `reader fixture at example`},
		{"mobile_candidate", `13812345678`, `1381234567 is too short`},
		{"ip_address", `192.168.10.20`, `999.999.999.999 is not a usable IP`},
		{"internal_hostname", `db01.ops.internal`, `example.com is public naming`},
	}
	for _, tc := range cases {
		if !RuleMatches(tc.rule, tc.positive) {
			t.Errorf("%s must match %q", tc.rule, tc.positive)
		}
		if RuleMatches(tc.rule, tc.negative) {
			t.Errorf("%s must not match %q", tc.rule, tc.negative)
		}
	}
	if RuleMatches("mobile_candidate", "013812345678") {
		t.Fatal("mobile candidate must reject a longer digit run")
	}
	if RuleMatches("unknown_rule", "anything") {
		t.Fatal("unknown rule must not match")
	}
}

func TestScanTextFindingsAndExcerpt(t *testing.T) {
	findings := ScanText(Input{Field: "work.title", SectionID: "s1", Text: "联系 reader@example.invalid 和 192.168.10.20"})
	if len(findings) != 2 {
		t.Fatalf("want 2 findings, got %+v", findings)
	}
	for _, finding := range findings {
		if finding.ID == "" || finding.MaskedExcerpt != "[已遮蔽]" {
			t.Fatalf("finding must be masked and identified: %+v", finding)
		}
	}
	if findings[0].Offset <= 0 {
		t.Fatalf("offset must be code-point based: %+v", findings[0])
	}
}

func TestCanarySelfCheck(t *testing.T) {
	if !RunCanaries() {
		t.Fatalf("canary failures: %v", CanaryFailures())
	}
	if !StartupHealthy {
		t.Fatal("startup health must be equivalent to RunCanaries")
	}
	if failures := CanaryFailures(); len(failures) != 0 {
		t.Fatalf("want no failures, got %v", failures)
	}
}

func TestDecodeTextVariants(t *testing.T) {
	cases := []struct {
		name     string
		data     []byte
		want     string
		encoding string
		wantErr  bool
	}{
		{"utf8", []byte("严格 UTF-8"), "严格 UTF-8", "utf-8", false},
		{"utf8-bom", []byte{0xef, 0xbb, 0xbf, 'u', 't', 'f', '8'}, "utf8", "utf-8-bom", false},
		{"utf16le-bom", []byte{0xff, 0xfe, 0x41, 0x00}, "A", "utf-16le", false},
		{"utf16be-bom", []byte{0xfe, 0xff, 0x00, 0x41}, "A", "utf-16be", false},
		{"unmarked-le", []byte{0xd8, 0x00}, "Ø", "utf-16le-unmarked", false},
		{"unmarked-be", []byte{0x00, 0xd8}, "Ø", "utf-16be-unmarked", false},
		{"ambiguous-unmarked", []byte{0x61, 0x00}, "", "", true},
		{"invalid-bom", []byte{0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x41, 0x00}, "", "", true},
		{"unpaired-high", []byte{0xff, 0xfe, 0x00, 0xd8}, "", "", true},
		{"control", []byte{0xff, 0xfe, 0x01, 0x00}, "", "", true},
	}
	for _, tc := range cases {
		text, encoding, err := DecodeText(tc.data)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s: expected error, got %q/%s", tc.name, text, encoding)
			}
			continue
		}
		if err != nil || text != tc.want || encoding != tc.encoding {
			t.Errorf("%s: got %q/%s/%v, want %q/%s", tc.name, text, encoding, err, tc.want, tc.encoding)
		}
	}
}

func TestHTMLInputsSkipDataImageButScanTextAttributesAndCSS(t *testing.T) {
	data := []byte(`<section><div data-section-id="s1" title="C:\Users\fixture\a.txt" style="background:url('/home/fixture/bg.png')"><img src="data:image/png;base64,QUJD" alt="13812345678"><p>reader@example.invalid</p></div></section>`)
	inputs, ok := HTMLInputs(data, "html")
	if !ok {
		t.Fatal("valid HTML must parse")
	}
	for _, input := range inputs {
		if strings.Contains(input.Text, "data:image") {
			t.Fatalf("img data: src must be skipped: %+v", input)
		}
	}
	joinedFields := ""
	for _, input := range inputs {
		joinedFields += input.Field + "\n"
	}
	if !strings.Contains(joinedFields, ".attr.title") || !strings.Contains(joinedFields, ".attr.style") || !strings.Contains(joinedFields, ".attr.alt") {
		t.Fatalf("attributes and CSS must stay in scope: %s", joinedFields)
	}
	all := []Finding{}
	for _, input := range inputs {
		all = append(all, ScanText(input)...)
	}
	rules := map[string]bool{}
	for _, finding := range all {
		rules[finding.Rule] = true
	}
	for _, want := range []string{"absolute_path_windows", "absolute_path_home", "mobile_candidate", "email_candidate"} {
		if !rules[want] {
			t.Fatalf("missing %s in %+v", want, all)
		}
	}
}

func TestFindingsTruncatedButHashCoversAll(t *testing.T) {
	makeTitle := func(last string) string {
		parts := make([]string, 0, 210)
		for i := 0; i < 209; i++ {
			parts = append(parts, fmt.Sprintf("u%03d@example.invalid", i))
		}
		parts = append(parts, last)
		return strings.Join(parts, " ")
	}
	first, _ := ScanBuildArtifacts(map[string]any{"work": map[string]any{"title": makeTitle("hidden-a@example.invalid")}}, nil, nil)
	second, _ := ScanBuildArtifacts(map[string]any{"work": map[string]any{"title": makeTitle("hidden-b@example.invalid")}}, nil, nil)
	if first["total"].(float64) != 210 || second["total"].(float64) != 210 {
		t.Fatalf("want 210 total findings: %v / %v", first["total"], second["total"])
	}
	if first["truncated"] != true || len(first["findings"].([]any)) != MaxFindings {
		t.Fatalf("want capped findings and truncated=true: truncated=%v len=%d", first["truncated"], len(first["findings"].([]any)))
	}
	if first["report_hash"] == "" || first["report_hash"] == second["report_hash"] {
		t.Fatalf("report hash must cover hidden findings: %v / %v", first["report_hash"], second["report_hash"])
	}
	_ = cxbuildvalidate.Section{}
}
