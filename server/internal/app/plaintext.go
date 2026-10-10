package app

import (
	"regexp"
	"strings"
)

var (
	reHeading   = regexp.MustCompile(`(?m)^#{1,6}\s+(.+)$`)
	reBold      = regexp.MustCompile(`\*\*(.+?)\*\*|__(.+?)__`)
	reItalic    = regexp.MustCompile(`\*(.+?)\*|_(.+?)_`)
	reUL        = regexp.MustCompile(`(?m)^\s*[-*+]\s+(.+)$`)
	reOL        = regexp.MustCompile(`(?m)^\s*\d+\.\s+(.+)$`)
	reQuote     = regexp.MustCompile(`(?m)^>\s?(.*)$`)
	reLink      = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	reImage     = regexp.MustCompile(`!\[[^\]]*\]\([^)]+\)`)
	reCodeFence = regexp.MustCompile("(?s)```[\\w]*\\n?(.*?)```")
	reInlineCode = regexp.MustCompile("`([^`]+)`")
	reBlankRuns = regexp.MustCompile(`\n{3,}`)
)

// mdToPlain converts Markdown to plain text using 06 文档第 5.4 节规则（小红书 / newspic 共用）.
func mdToPlain(md string) string {
	s := strings.ReplaceAll(md, "\r\n", "\n")
	s = reCodeFence.ReplaceAllString(s, "$1")
	s = reImage.ReplaceAllString(s, "")
	s = reLink.ReplaceAllString(s, "$1")
	s = reHeading.ReplaceAllString(s, "\n$1\n")
	s = reUL.ReplaceAllString(s, "· $1")
	s = reOL.ReplaceAllStringFunc(s, func(line string) string {
		m := reOL.FindStringSubmatch(line)
		if len(m) < 2 {
			return line
		}
		// Keep original number if present.
		num := regexp.MustCompile(`^\s*(\d+)\.`).FindStringSubmatch(line)
		if len(num) >= 2 {
			return num[1] + ". " + m[1]
		}
		return "1. " + m[1]
	})
	s = reQuote.ReplaceAllString(s, "「$1」")
	s = reBold.ReplaceAllString(s, "$1$2")
	s = reItalic.ReplaceAllString(s, "$1$2")
	s = reInlineCode.ReplaceAllString(s, "$1")
	s = reBlankRuns.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func comicPlainText(panels []ComicPanel) string {
	var parts []string
	for _, p := range panels {
		var b strings.Builder
		if n := strings.TrimSpace(p.Narration); n != "" {
			b.WriteString(n)
		}
		if d := strings.TrimSpace(p.Dialogue); d != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(d)
		}
		if b.Len() > 0 {
			parts = append(parts, b.String())
		}
	}
	return strings.Join(parts, "\n\n")
}
