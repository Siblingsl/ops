package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	xhtml "golang.org/x/net/html"

	"ops/internal/cxbuildvalidate"
	"ops/internal/cxcanonicaljson"
)

const (
	cxPrivacyScannerVersion = "cx-privacy-1"
	cxPrivacyCanaryVersion  = "cx-privacy-canary-1"
	cxPrivacyMaxFindings    = 200
)

var (
	cxPrivacyWinPathPattern = regexp.MustCompile(`(?i)\b[A-Z]:\\[^\r\n"'<>|?*]+`)
	cxPrivacyHomePattern    = regexp.MustCompile(`(?:^|[\s"'(])/(?:home|Users)/[^/\s"'<>]+(?:/[^\s"'<>]*)?`)
	cxPrivacyKeyPattern     = regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----`)
	cxPrivacyTokenPattern   = regexp.MustCompile(`(?i)\b(?:sk-[a-z0-9_-]{24,}|bearer\s+[a-z0-9._~+/-]{24,})\b`)
	cxPrivacyEmailPattern   = regexp.MustCompile(`(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`)
	cxPrivacyPhonePattern   = regexp.MustCompile(`\b1[3-9][0-9]{9}\b`)
	cxPrivacyIPv4Pattern    = regexp.MustCompile(`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`)
	cxPrivacyInternalHost   = regexp.MustCompile(`(?i)\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:local|lan|internal|localhost)\b`)
	cxPrivacyPolicyResolved = false // Q-CX-03: email/mobile severity remains a product decision.
	cxPrivacyStartupHealthy = cxPrivacyRunCanaries()
)

type cxPrivacyRule struct {
	ID       string
	Severity string
	Pattern  *regexp.Regexp
}

var cxPrivacyRules = []cxPrivacyRule{
	{ID: "absolute_path_windows", Severity: "error", Pattern: cxPrivacyWinPathPattern},
	{ID: "absolute_path_home", Severity: "error", Pattern: cxPrivacyHomePattern},
	{ID: "private_key_header", Severity: "error", Pattern: cxPrivacyKeyPattern},
	{ID: "credential_token", Severity: "error", Pattern: cxPrivacyTokenPattern},
	{ID: "email_candidate", Severity: "warn", Pattern: cxPrivacyEmailPattern},
	{ID: "mobile_candidate", Severity: "warn", Pattern: cxPrivacyPhonePattern},
	{ID: "ip_address", Severity: "warn", Pattern: cxPrivacyIPv4Pattern},
	{ID: "internal_hostname", Severity: "warn", Pattern: cxPrivacyInternalHost},
}

type cxPrivacyFinding struct {
	ID            string `json:"id"`
	Rule          string `json:"rule"`
	Severity      string `json:"severity"`
	Field         string `json:"field"`
	SectionID     string `json:"section_id,omitempty"`
	Offset        int    `json:"offset"`
	MaskedExcerpt string `json:"masked_excerpt"`
}

type cxPrivacyReport struct {
	ReportHash     string             `json:"report_hash"`
	InputHash      string             `json:"input_hash"`
	ScannerVersion string             `json:"scanner_version"`
	CanaryVersion  string             `json:"canary_version"`
	ScannerOK      bool               `json:"scanner_ok"`
	Coverage       map[string]string  `json:"coverage"`
	Level          string             `json:"level"`
	Errors         int                `json:"errors"`
	Warnings       int                `json:"warnings"`
	Findings       []cxPrivacyFinding `json:"findings"`
	Total          int                `json:"total"`
	Truncated      bool               `json:"truncated"`
	PolicyReady    bool               `json:"policy_ready"`
	BlockedBy      []string           `json:"blocked_by"`
}

type cxPrivacyInput struct {
	Field     string
	SectionID string
	Text      string
}

func cxScanBuildArtifacts(snapshot map[string]any, sections []cxbuildvalidate.Section, artifacts []cxBuildArtifact) (map[string]any, bool) {
	canariesOK := cxPrivacyStartupHealthy && cxPrivacyRunCanaries()
	sourceHash, sourceErr := cxcanonicaljson.Hash(snapshot)
	if sourceErr != nil {
		canariesOK = false
	}
	inputParts := make([]any, 0, len(artifacts))
	for _, artifact := range artifacts {
		inputParts = append(inputParts, map[string]any{"kind": artifact.Kind, "name": artifact.Name, "sha256": artifact.SHA256})
	}
	inputHash, inputErr := cxcanonicaljson.Hash(map[string]any{"source_hash": sourceHash, "artifacts": inputParts})
	if inputErr != nil {
		canariesOK = false
	}
	inputs := []cxPrivacyInput{}
	if work, ok := snapshot["work"].(map[string]any); ok {
		inputs = append(inputs, cxPrivacyInput{Field: "work.title", Text: cxString(work["title"])}, cxPrivacyInput{Field: "work.summary", Text: cxString(work["summary"])})
	}
	for _, section := range sections {
		inputs = append(inputs, cxPrivacyInput{Field: "section.heading", SectionID: section.ID, Text: section.Heading})
	}
	// Scan each submitted HTML DOM instead of its raw bytes so base64 image data
	// is not treated as decoded text. Markup, text, attributes, and CSS remain in scope.
	for _, artifact := range artifacts {
		inputs = append(inputs, cxPrivacyInput{Field: "filename", Text: artifact.Name})
		if artifact.Kind == "html" || artifact.Kind == "stable_html" {
			htmlInputs, ok := cxPrivacyHTMLInputs(artifact.Data, artifact.Kind)
			if !ok {
				canariesOK = false
			}
			inputs = append(inputs, htmlInputs...)
		} else if artifact.Kind == "csv" {
			decoded, _, decodeErr := cxPrivacyDecodeText(artifact.Data)
			if decodeErr != nil {
				canariesOK = false
			} else {
				inputs = append(inputs, cxPrivacyInput{Field: "artifact.csv", Text: decoded})
			}
		}
	}
	all := []cxPrivacyFinding{}
	for _, input := range inputs {
		all = append(all, cxPrivacyScanText(input)...)
	}
	if len(all) > 1 {
		sort.SliceStable(all, func(i, j int) bool {
			if all[i].Field != all[j].Field {
				return all[i].Field < all[j].Field
			}
			if all[i].SectionID != all[j].SectionID {
				return all[i].SectionID < all[j].SectionID
			}
			if all[i].Offset != all[j].Offset {
				return all[i].Offset < all[j].Offset
			}
			return all[i].Rule < all[j].Rule
		})
	}
	report := cxPrivacyReport{
		InputHash: inputHash, ScannerVersion: cxPrivacyScannerVersion, CanaryVersion: cxPrivacyCanaryVersion, ScannerOK: canariesOK,
		Coverage: map[string]string{"text": "scanned", "html_dom_attributes_css": "scanned", "image_bytes_exif": "not_scanned", "image_visible_text": "not_scanned", "zip_text_items": "not_applicable"},
		Level:    "pass", Findings: []cxPrivacyFinding{},
		Total: len(all), Truncated: len(all) > cxPrivacyMaxFindings, PolicyReady: cxPrivacyPolicyResolved, BlockedBy: []string{},
	}
	if !report.PolicyReady {
		report.BlockedBy = append(report.BlockedBy, "Q-CX-03")
	}
	if !canariesOK {
		report.Level = "block"
		report.BlockedBy = append(report.BlockedBy, "scanner_self_test")
	}
	for _, finding := range all {
		if finding.Severity == "error" {
			report.Level = "block"
			report.Errors++
		} else {
			if report.Level == "pass" {
				report.Level = "warn"
			}
			report.Warnings++
		}
	}
	if len(report.BlockedBy) > 0 {
		report.Level = "block"
	}
	if len(all) > cxPrivacyMaxFindings {
		all = all[:cxPrivacyMaxFindings]
	}
	report.Findings = all
	unsigned := map[string]any{
		"input_hash": report.InputHash, "scanner_version": report.ScannerVersion, "canary_version": report.CanaryVersion, "scanner_ok": report.ScannerOK,
		"coverage": report.Coverage, "level": report.Level, "errors": report.Errors, "warnings": report.Warnings,
		"findings": append([]cxPrivacyFinding(nil), all...), "total": report.Total, "truncated": report.Truncated,
		"policy_ready": report.PolicyReady, "blocked_by": report.BlockedBy,
	}
	// The report hash covers every finding, including entries beyond the response cap.
	unsigned["full_finding_ids"] = cxPrivacyFindingIDs(all, inputs)
	unsignedJSON, err := json.Marshal(unsigned)
	if err != nil {
		return map[string]any{"scanner_ok": false, "scanner_version": cxPrivacyScannerVersion, "error_code": "scanner_unverified"}, false
	}
	unsignedValue, err := cxcanonicaljson.Parse(unsignedJSON)
	if err != nil {
		return map[string]any{"scanner_ok": false, "scanner_version": cxPrivacyScannerVersion, "error_code": "scanner_unverified"}, false
	}
	report.ReportHash, err = cxcanonicaljson.Hash(unsignedValue)
	if err != nil {
		return map[string]any{"scanner_ok": false, "scanner_version": cxPrivacyScannerVersion, "error_code": "scanner_unverified"}, false
	}
	ready := report.ScannerOK && report.PolicyReady && report.Errors == 0
	encoded, err := json.Marshal(report)
	if err != nil {
		return map[string]any{"scanner_ok": false, "scanner_version": cxPrivacyScannerVersion, "error_code": "scanner_unverified"}, false
	}
	var result map[string]any
	if err := json.Unmarshal(encoded, &result); err != nil {
		return map[string]any{"scanner_ok": false, "scanner_version": cxPrivacyScannerVersion, "error_code": "scanner_unverified"}, false
	}
	return result, ready
}

func cxPrivacyHTMLInputs(data []byte, kind string) ([]cxPrivacyInput, bool) {
	doc, err := xhtml.Parse(strings.NewReader(string(data)))
	if err != nil {
		return nil, false // HTML validity is checked first; still fail closed if this independent parse disagrees.
	}
	inputs := []cxPrivacyInput{}
	var walk func(*xhtml.Node, string, string)
	walk = func(node *xhtml.Node, parentField, sectionID string) {
		field := parentField
		if node.Type == xhtml.ElementNode {
			field = parentField + "." + node.Data
			for _, attribute := range node.Attr {
				if strings.EqualFold(attribute.Key, "data-section-id") {
					sectionID = attribute.Val
				}
			}
			for _, attribute := range node.Attr {
				if node.Data == "img" && strings.EqualFold(attribute.Key, "src") && strings.HasPrefix(strings.ToLower(attribute.Val), "data:") {
					continue
				}
				inputs = append(inputs, cxPrivacyInput{Field: field + ".attr." + strings.ToLower(attribute.Key), SectionID: sectionID, Text: attribute.Val})
			}
		}
		if node.Type == xhtml.TextNode && node.Data != "" {
			inputs = append(inputs, cxPrivacyInput{Field: field + ".text", SectionID: sectionID, Text: node.Data})
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child, field, sectionID)
		}
	}
	walk(doc, "artifact."+kind, "")
	return inputs, true
}

func cxPrivacyScanText(input cxPrivacyInput) []cxPrivacyFinding {
	if input.Text == "" || !utf8.ValidString(input.Text) {
		return nil
	}
	findings := []cxPrivacyFinding{}
	for _, rule := range cxPrivacyRules {
		matches := rule.Pattern.FindAllStringIndex(input.Text, -1)
		for _, match := range matches {
			if rule.ID == "mobile_candidate" && ((match[0] > 0 && input.Text[match[0]-1] >= '0' && input.Text[match[0]-1] <= '9') || (match[1] < len(input.Text) && input.Text[match[1]] >= '0' && input.Text[match[1]] <= '9')) {
				continue
			}
			if rule.ID == "ip_address" && net.ParseIP(input.Text[match[0]:match[1]]) == nil {
				continue
			}
			offset := len([]rune(input.Text[:match[0]]))
			idInput := strings.Join([]string{rule.ID, input.Field, input.SectionID, strconv.Itoa(offset)}, "\x00")
			idHash := sha256.Sum256([]byte(idInput))
			findings = append(findings, cxPrivacyFinding{ID: hex.EncodeToString(idHash[:12]), Rule: rule.ID, Severity: rule.Severity,
				Field: input.Field, SectionID: input.SectionID, Offset: offset, MaskedExcerpt: cxPrivacyExcerpt(input.Text, match[0], match[1])})
		}
	}
	return findings
}

func cxPrivacyFindingIDs(findings []cxPrivacyFinding, inputs []cxPrivacyInput) []string {
	// IDs are deterministically derived from rule, field, section, and code-point offset.
	// Rebuild candidates when the response is truncated so the hash still covers hidden findings.
	out := make([]string, 0)
	for _, input := range inputs {
		for _, finding := range cxPrivacyScanText(input) {
			out = append(out, finding.ID)
		}
	}
	sort.Strings(out)
	return out
}

func cxPrivacyExcerpt(value string, start, end int) string {
	_ = value
	_ = start
	_ = end
	return "[已遮蔽]"
}

func cxPrivacyRunCanaries() bool {
	return len(cxPrivacyCanaryFailures()) == 0
}

func cxPrivacyCanaryFailures() []string {
	canaries := []struct {
		id       string
		pattern  *regexp.Regexp
		positive string
		negative string
	}{
		{"absolute_path_windows", cxPrivacyWinPathPattern, `C:\Users\fixture\article.html`, `C: is a drive label, not an absolute path`},
		{"absolute_path_home", cxPrivacyHomePattern, `/home/fixture/notes.txt`, `a home directory is not mentioned`},
		{"private_key_header", cxPrivacyKeyPattern, `-----BEGIN PRIVATE KEY-----`, `PRIVATE KEY is only described`},
		{"credential_token", cxPrivacyTokenPattern, `sk-` + strings.Repeat("a", 28), `The article mentions sk- as a term.`},
		{"email_candidate", cxPrivacyEmailPattern, `reader.fixture@example.invalid`, `reader fixture at example`},
		{"mobile_candidate", cxPrivacyPhonePattern, `13812345678`, `1381234567 is too short`},
		{"ip_address", cxPrivacyIPv4Pattern, `192.168.10.20`, `999.999.999.999 is not a usable IP`},
		{"internal_hostname", cxPrivacyInternalHost, `db01.ops.internal`, `example.com is public naming`},
	}
	failures := []string{}
	for _, canary := range canaries {
		if !cxPrivacyRuleMatches(canary.id, canary.pattern, canary.positive) || cxPrivacyRuleMatches(canary.id, canary.pattern, canary.negative) {
			failures = append(failures, canary.id)
		}
	}
	if net.ParseIP("999.999.999.999") != nil || net.ParseIP("192.168.10.20") == nil {
		failures = append(failures, "ipv4_address_validation")
	}
	if !cxPrivacyDecodeCanaries() {
		failures = append(failures, "text_encoding")
	}
	return failures
}

func cxPrivacyDecodeCanaries() bool {
	fixtures := [][]byte{
		[]byte("strict utf-8"),
		{0xef, 0xbb, 0xbf, 'u', 't', 'f', '8'},
		{0xff, 0xfe, 0x41, 0x00, 0xd8, 0x00},
		{0xfe, 0xff, 0x00, 0x41, 0x00, 0xd8},
		{0xd8, 0x00},
		{0x00, 0xd8},
	}
	for _, fixture := range fixtures {
		if _, _, err := cxPrivacyDecodeText(fixture); err != nil {
			return false
		}
	}
	for _, fixture := range [][]byte{{0x61, 0x00}, {0xd8, 0x00, 0x00}, {0xef, 0xbb, 0xbf, 0xff, 0xfe, 0x41, 0x00}} {
		if _, _, err := cxPrivacyDecodeText(fixture); err == nil {
			return false
		}
	}
	return true
}

// cxPrivacyDecodeText accepts strict UTF-8, BOM-labelled UTF-16, and only
// unlabelled UTF-16 whose opposite-endian interpretation is invalid. Ambiguous
// data fails closed instead of choosing an endian from NUL-byte frequency.
func cxPrivacyDecodeText(data []byte) (string, string, error) {
	if len(data) >= 3 && bytes.Equal(data[:3], []byte{0xef, 0xbb, 0xbf}) {
		text := data[3:]
		if !utf8.Valid(text) || !cxPrivacyTextControlsAllowed(string(text)) {
			return "", "", fmt.Errorf("encoding_undetermined")
		}
		return string(text), "utf-8-bom", nil
	}
	if len(data) >= 2 && data[0] == 0xff && data[1] == 0xfe {
		text, err := cxPrivacyDecodeUTF16(data[2:], true)
		if err != nil {
			return "", "", fmt.Errorf("encoding_undetermined")
		}
		return text, "utf-16le", nil
	}
	if len(data) >= 2 && data[0] == 0xfe && data[1] == 0xff {
		text, err := cxPrivacyDecodeUTF16(data[2:], false)
		if err != nil {
			return "", "", fmt.Errorf("encoding_undetermined")
		}
		return text, "utf-16be", nil
	}
	if utf8.Valid(data) && cxPrivacyTextControlsAllowed(string(data)) {
		return string(data), "utf-8", nil
	}
	le, leErr := cxPrivacyDecodeUTF16(data, true)
	be, beErr := cxPrivacyDecodeUTF16(data, false)
	if leErr == nil && beErr != nil {
		return le, "utf-16le-unmarked", nil
	}
	if beErr == nil && leErr != nil {
		return be, "utf-16be-unmarked", nil
	}
	return "", "", fmt.Errorf("encoding_undetermined")
}

func cxPrivacyDecodeUTF16(data []byte, littleEndian bool) (string, error) {
	if len(data) == 0 || len(data)%2 != 0 {
		return "", fmt.Errorf("odd UTF-16 byte count")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		if littleEndian {
			units[i] = uint16(data[i*2]) | uint16(data[i*2+1])<<8
		} else {
			units[i] = uint16(data[i*2])<<8 | uint16(data[i*2+1])
		}
	}
	runes := make([]rune, 0, len(units))
	for i := 0; i < len(units); i++ {
		unit := units[i]
		if unit >= 0xd800 && unit <= 0xdbff {
			if i+1 >= len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff {
				return "", fmt.Errorf("unpaired UTF-16 high surrogate")
			}
			runes = append(runes, utf16.DecodeRune(rune(unit), rune(units[i+1])))
			i++
			continue
		}
		if unit >= 0xdc00 && unit <= 0xdfff {
			return "", fmt.Errorf("unpaired UTF-16 low surrogate")
		}
		runes = append(runes, rune(unit))
	}
	if !equalUTF16Units(units, utf16.Encode(runes)) {
		return "", fmt.Errorf("UTF-16 round trip mismatch")
	}
	text := string(runes)
	if !cxPrivacyTextControlsAllowed(text) {
		return "", fmt.Errorf("disallowed control character")
	}
	return text, nil
}

func cxPrivacyTextControlsAllowed(text string) bool {
	for _, r := range text {
		if r == 0 || (unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t') {
			return false
		}
	}
	return true
}

func equalUTF16Units(left, right []uint16) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func cxPrivacyRuleMatches(ruleID string, pattern *regexp.Regexp, value string) bool {
	for _, match := range pattern.FindAllStringIndex(value, -1) {
		if ruleID == "ip_address" && net.ParseIP(value[match[0]:match[1]]) == nil {
			continue
		}
		if ruleID == "mobile_candidate" && ((match[0] > 0 && value[match[0]-1] >= '0' && value[match[0]-1] <= '9') || (match[1] < len(value) && value[match[1]] >= '0' && value[match[1]] <= '9')) {
			continue
		}
		return true
	}
	return false
}
