// Package compliance contains pure text-compliance, custom-theme contrast, and
// layout-suggestion algorithms. It has no HTTP, database, server, or clock dependency.
package compliance

import (
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"ops/internal/secure"
)

// PendingMarker matches unresolved editorial markers.
var PendingMarker = regexp.MustCompile(`【待核实[^】]*】`)

// AdWords is the advertising-law absolute-word list shared by formal checks and live lint.
var AdWords = []string{"最", "第一", "唯一", "首个", "顶级", "极致", "绝对", "100%", "永久", "国家级", "世界级"}

// SourceLabels maps a sensitive-word source to its user-facing label.
var SourceLabels = map[string]string{"base": "通用词库", "custom": "自定义词库", "account": "账号禁用词", "memory": "AI 记忆中的避免用词"}

// SentenceAround returns the sentence surrounding a byte-indexed match.
func SentenceAround(text string, idx, n int) string {
	runes := []rune(text)
	start := len([]rune(text[:idx]))
	end := start + len([]rune(text[idx:idx+n]))
	isStop := func(r rune) bool { return r == '。' || r == '！' || r == '？' || r == '\n' || r == '!' || r == '?' }
	for start > 0 && !isStop(runes[start-1]) {
		start--
	}
	for end < len(runes) && !isStop(runes[end]) {
		end++
	}
	if end < len(runes) {
		end++
	}
	return strings.TrimSpace(string(runes[start:end]))
}

// Fingerprint returns the stable 32-hex check fingerprint.
func Fingerprint(category, matched, sentence string) string {
	return secure.SHA256Hex([]byte(category + "|" + matched + "|" + sentence))[:32]
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// CustomThemePrimaryContrastRatio returns the WCAG contrast ratio against white.
func CustomThemePrimaryContrastRatio(color string) float64 {
	channels := [3]float64{}
	for i, offset := range []int{1, 3, 5} {
		value, _ := strconv.ParseUint(color[offset:offset+2], 16, 8)
		channel := float64(value) / 255
		if channel <= 0.04045 {
			channels[i] = channel / 12.92
		} else {
			channels[i] = math.Pow((channel+0.055)/1.055, 2.4)
		}
	}
	luminance := channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722
	return 1.05 / (luminance + 0.05)
}

// ValidateCustomThemeInput validates and normalizes the pure custom-theme fields.
// An empty error message means valid.
func ValidateCustomThemeInput(base, primaryColor string, fontSize int, lineHeight float64, paragraphGap int, headingStyle, quoteStyle string) (normalizedBase string, errMsg string) {
	normalizedBase = base
	if normalizedBase == "" {
		normalizedBase = "ink"
	}
	if !hexColor.MatchString(primaryColor) {
		return normalizedBase, "主色需要是 #RRGGBB 格式"
	}
	if CustomThemePrimaryContrastRatio(primaryColor) < 4.5 {
		return normalizedBase, "主色与白色背景的文字对比度不足 4.5:1"
	}
	if fontSize < 14 || fontSize > 17 {
		return normalizedBase, "正文字号需在 14–17px 之间"
	}
	if lineHeight < 1.4 || lineHeight > 2.2 {
		return normalizedBase, "行距需在 1.4–2.2 之间"
	}
	if paragraphGap < 8 || paragraphGap > 32 {
		return normalizedBase, "段间距需在 8–32px 之间"
	}
	switch headingStyle {
	case "plain", "underline", "bar", "block":
	default:
		return normalizedBase, "标题样式无效"
	}
	switch quoteStyle {
	case "bar", "box", "italic":
	default:
		return normalizedBase, "引用样式无效"
	}
	return normalizedBase, ""
}

// LayoutSuggestion is one deterministic layout suggestion.
type LayoutSuggestion struct {
	SectionID uuid.UUID `json:"section_id"`
	Kind      string    `json:"kind"`
	Text      string    `json:"text"`
	Reason    string    `json:"reason"`
}

var (
	keySentence = regexp.MustCompile(`[^。！？\n]*(关键是|本质上|核心是|说到底|记住|真正重要的是)[^。！？\n]*[。！？]?`)
	enumMarker  = regexp.MustCompile(`(第[一二三四五六七八九十]|首先|其次|最后|[1-9][.、])`)
)

// LayoutRules returns the rule-first layout suggestions for one section.
func LayoutRules(sectionID uuid.UUID, content string, golden []string) []LayoutSuggestion {
	out := []LayoutSuggestion{}
	for _, g := range golden {
		g = strings.TrimSpace(g)
		if g == "" || !strings.Contains(content, g) || strings.Contains(content, "**"+g) {
			continue
		}
		out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "bold", Text: g, Reason: "这是你收藏的金句，加粗后更醒目"})
	}
	for _, m := range keySentence.FindAllString(content, 3) {
		m = strings.TrimSpace(m)
		if m == "" || strings.Contains(content, "**"+m) || runeCount(m) > 60 {
			continue
		}
		out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "bold", Text: m, Reason: "这是观点句，加粗便于读者抓重点"})
	}
	for _, para := range strings.Split(content, "\n\n") {
		if strings.HasPrefix(strings.TrimSpace(para), "-") {
			continue
		}
		if len(enumMarker.FindAllString(para, -1)) >= 3 {
			out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "list", Text: strings.TrimSpace(para), Reason: "这段有 3 个以上的并列要点，改成列表更清楚"})
		}
	}
	if runeCount(content) > 800 && !strings.Contains(content, "\n---\n") {
		paras := strings.Split(content, "\n\n")
		if len(paras) >= 4 {
			out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "divider", Text: strings.TrimSpace(paras[len(paras)/2]), Reason: "这段较长，在中间加分割线可以让阅读喘口气"})
		}
	}
	return out
}

func runeCount(s string) int { return len([]rune(s)) }
