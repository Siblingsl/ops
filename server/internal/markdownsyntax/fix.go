package markdownsyntax

import (
	"fmt"
)

// FixSuggestion is a safe single-occurrence text replacement for one unsupported construct.
// Clients must apply one suggestion at a time (no batch apply API).
type FixSuggestion struct {
	SectionID string `json:"section_id"`
	Syntax    string `json:"syntax"`
	From      string `json:"from"`
	To        string `json:"to"`
	Reason    string `json:"reason"`
	Line      int    `json:"line"`
	Column    int    `json:"column"`
	Offset    int    `json:"offset"`
	Length    int    `json:"length"`
}

// SuggestFixes returns auto-fix candidates for the safe subset (toc / footnote / unsafe_url markdown links).
func SuggestFixes(sections []Section) []FixSuggestion {
	out := make([]FixSuggestion, 0)
	for _, section := range sections {
		out = append(out, suggestFixesForContent(section.ID, section.Content)...)
		if len(out) >= maxFindings {
			return out[:maxFindings]
		}
	}
	return out
}

// FixPatch returns the suggestion that matches a finding, when the construct is auto-fixable.
func FixPatch(content string, f Finding) (FixSuggestion, bool) {
	for _, s := range suggestFixesForContent(f.SectionID, content) {
		if s.Syntax == f.Syntax && s.Line == f.Line && s.Column == f.Column {
			return s, true
		}
	}
	return FixSuggestion{}, false
}

// ApplyFix replaces the exact byte range when From still matches; refuses drift.
func ApplyFix(content string, fix FixSuggestion) (string, error) {
	if fix.Length < 0 || fix.Offset < 0 || fix.Offset+fix.Length > len(content) {
		return "", fmt.Errorf("fix range invalid")
	}
	got := content[fix.Offset : fix.Offset+fix.Length]
	if got != fix.From {
		return "", fmt.Errorf("fix source drifted")
	}
	return content[:fix.Offset] + fix.To + content[fix.Offset+fix.Length:], nil
}

func suggestFixesForContent(sectionID, content string) []FixSuggestion {
	source := []byte(content)
	out := make([]FixSuggestion, 0)
	add := func(syntax, from, to, reason string, at int) {
		line, column := sourceLocation(source, at)
		out = append(out, FixSuggestion{
			SectionID: sectionID, Syntax: syntax, From: from, To: to, Reason: reason,
			Line: line, Column: column, Offset: at, Length: len(from),
		})
	}
	for _, match := range tocMarker.FindAllIndex(source, -1) {
		if isEscaped(source, match[0]) {
			continue
		}
		from := string(source[match[0]:match[1]])
		add("toc", from, "", "移除自动目录标记。", match[0])
	}
	for _, match := range footnoteReference.FindAllSubmatchIndex(source, -1) {
		if isEscaped(source, match[0]) {
			continue
		}
		if match[1] < len(source) && source[match[1]] == ':' {
			continue
		}
		from := string(source[match[0]:match[1]])
		add("footnote", from, "", "移除脚注引用标记。", match[0])
	}
	for _, match := range footnoteDefinition.FindAllSubmatchIndex(source, -1) {
		if isEscaped(source, match[0]) {
			continue
		}
		end := match[1]
		if end < len(source) && (source[end] == '\n' || source[end] == '\r') {
			end++
			if end < len(source) && source[end-1] == '\r' && source[end] == '\n' {
				end++
			}
		}
		from := string(source[match[0]:end])
		add("footnote", from, "", "移除脚注定义行。", match[0])
	}
	for _, link := range findMarkdownLinks(source) {
		rawURL := string(source[link.urlStart:link.urlEnd])
		if !unsafeURL(rawURL) {
			continue
		}
		from := string(source[link.start:link.end])
		label := string(source[link.labelStart:link.labelEnd])
		add("unsafe_url", from, label, "去掉不安全链接，保留可见文字。", link.start)
	}
	return out
}

type mdLinkSpan struct {
	start, end, labelStart, labelEnd, urlStart, urlEnd int
}

// findMarkdownLinks finds `[label](url)` / `![alt](url)` with nested parentheses in url.
func findMarkdownLinks(source []byte) []mdLinkSpan {
	out := make([]mdLinkSpan, 0)
	for i := 0; i < len(source); i++ {
		if source[i] != '[' {
			continue
		}
		start := i
		if i > 0 && source[i-1] == '!' {
			start = i - 1
		}
		if isEscaped(source, start) {
			continue
		}
		labelStart := i + 1
		labelEnd := -1
		for j := labelStart; j < len(source); j++ {
			if source[j] == '\n' || source[j] == '\r' {
				break
			}
			if source[j] == ']' && !isEscaped(source, j) {
				labelEnd = j
				break
			}
		}
		if labelEnd < 0 || labelEnd+1 >= len(source) || source[labelEnd+1] != '(' {
			continue
		}
		urlStart := labelEnd + 2
		depth := 1
		urlEnd := -1
		for j := urlStart; j < len(source); j++ {
			switch source[j] {
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 {
					urlEnd = j
				}
			case '\n', '\r':
				depth = 0
			}
			if depth == 0 {
				break
			}
		}
		if urlEnd < 0 {
			continue
		}
		out = append(out, mdLinkSpan{
			start: start, end: urlEnd + 1,
			labelStart: labelStart, labelEnd: labelEnd,
			urlStart: urlStart, urlEnd: urlEnd,
		})
		i = urlEnd
	}
	return out
}
