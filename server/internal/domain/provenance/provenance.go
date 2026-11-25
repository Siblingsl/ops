// Package provenance contains the pure content-provenance normalization and
// matching engine (16 §4 and 23 §8.3.2). It has no HTTP, database, server, or
// clock dependency.
package provenance

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/unicode/norm"
)

const (
	SrcUser       = "user"
	SrcAttachment = "attachment"
	SrcG          = "G"
	SrcO          = "O"

	// DEV-SK3 / 23 文档第 8.3.2 节：来源按目的分类。
	// skills__draft / skills__get 只产生 skill_definition 来源（供技能文字字段）；
	// 其他 G/O 不可给技能文字字段供源，技能来源也不可给观点 / 正文 / 素材供源。
	PurposeBusiness = "business"
	PurposeSkill    = "skill_definition"

	// MinProvenanceChars 是第 4.4 节第 3 项的短值豁免：不足 4 个字符视为 F。
	MinProvenanceChars = 4
)

// SkillDefTextFields 是技能定义的四个文字字段（8.3.2 节白名单）。
var SkillDefTextFields = map[string]bool{
	"name": true, "summary": true, "triggers": true, "instructions": true,
}

// SkillDefSourceTools 是产生 skill_definition 来源的工具。
var SkillDefSourceTools = map[string]bool{
	"skills__get": true, "skills__draft": true,
}

// SkillExcludedSourceTools 的全部结果与技能回执不进入任何内容来源集合（8.3.2 节）。
var SkillExcludedSourceTools = map[string]bool{
	"load_skill": true, "skills__list": true, "get_context": true, "get_skill_context": true,
}

// Source 是一条候选来源。一个来源内部可以有多个候选文本（第 4.4 节第 2 项：
// G 类结果中的每个文本字段都是一个候选），第 4.4 节第 4 项要求多段落全部来自同一个来源。
type Source struct {
	Kind     string
	Purpose  string // business | skill_definition（8.3.2 节）
	Tool     string
	Text     string // 归一化前的原文，用于错误信息
	AICallID uuid.UUID
	// Norms 是该来源下的全部候选归一化文本。
	Norms []string
}

// SourceSet 是本对话的来源集合（第 4.4 节第 2 项）。
type SourceSet struct {
	Sources []Source
}

// Hit 描述一次来源命中，用于第 4.4 节第 6 项的 applied 注入。
type Hit struct {
	Kind     string
	AICallID uuid.UUID
}

// SkillDefTexts 从技能定义结果 JSON 中白名单提取四个文字字段值。
func SkillDefTexts(body string) []string {
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return nil
	}
	var out []string
	var walk func(x any)
	walk = func(x any) {
		switch t := x.(type) {
		case map[string]any:
			for k, e := range t {
				if SkillDefTextFields[k] {
					if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
						out = append(out, s)
					}
					continue
				}
				walk(e)
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return out
}

// ToolSourceKind 按第 4.2 节判定工具结果的类别：G 类工具与带 AI 的 W 工具 → G；
// R 工具返回的系统已有数据 → O；其余（纯 W、H、X、未知工具）不进来源集合。
func ToolSourceKind(kind string, aiCost bool) string {
	switch {
	case kind == "G":
		return SrcG
	case kind == "W" && aiCost:
		return SrcG
	case kind == "R":
		return SrcO
	}
	return ""
}

// ResultTexts 递归收集工具结果 JSON 里的全部字符串值。
func ResultTexts(body string) []string {
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		// 非 JSON 的工具结果按整段文本作为唯一候选（第 4.4 节第 2 项）。
		if t := strings.TrimSpace(body); t != "" {
			return []string{t}
		}
		return nil
	}
	out := []string{}
	var walk func(x any)
	walk = func(x any) {
		switch t := x.(type) {
		case string:
			if t = strings.TrimSpace(t); t != "" {
				out = append(out, t)
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		case map[string]any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return out
}

// NormalizeAll 归一化一组文本。
func NormalizeAll(list []string) []string {
	out := make([]string, 0, len(list))
	for _, t := range list {
		out = append(out, Normalize(t))
	}
	return out
}

// Normalize 归一化（第 4.4 节第 1 项）：Unicode NFKC；去掉所有空白字符；
// 全角与半角标点统一；Markdown 强调符号（*、_、`）去掉。大小写按文档口径保留原样。
func Normalize(s string) string {
	s = norm.NFKC.String(s)
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			continue
		case r == '*' || r == '_' || r == '`':
			continue
		case r == '，' || r == '、':
			b.WriteRune(',')
		case r == '。':
			b.WriteRune('.')
		case r == '！':
			b.WriteRune('!')
		case r == '？':
			b.WriteRune('?')
		case r == '；':
			b.WriteRune(';')
		case r == '：':
			b.WriteRune(':')
		case r == '“' || r == '”' || r == '＂':
			b.WriteRune('"')
		case r == '‘' || r == '’' || r == '＇':
			b.WriteRune('\'')
		case r == '（':
			b.WriteRune('(')
		case r == '）':
			b.WriteRune(')')
		case r == '—' || r == '－' || r == '–':
			b.WriteRune('-')
		case r == '《' || r == '》' || r == '「' || r == '」' || r == '『' || r == '』':
			continue
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// DigitsOnly 去掉千分位逗号与小数点后的尾零差异，仅保留数字串（第 4.4 节第 5 项）。
func DigitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// SourceAllowed 判断一个来源能否供某类字段（8.3.2 节）：技能文字字段只收 U 与
// skill_definition；业务字段不接受 skill_definition。
func SourceAllowed(src Source, kinds []string, purpose string) bool {
	if !KindAllowed(kinds, src.Kind) {
		return false
	}
	if purpose == PurposeSkill {
		return src.Purpose == PurposeSkill || src.Kind == SrcUser || src.Kind == SrcAttachment
	}
	return src.Purpose != PurposeSkill
}

// Match 对一个字段值执行来源校验，返回命中来源；未命中返回零值。
func (set *SourceSet) Match(kinds []string, purpose, value string) (Hit, bool) {
	if utf8.RuneCountInString(Normalize(value)) < MinProvenanceChars {
		// 第 4.4 节第 3 项：长度不足 4 个字符视为 F，允许任意短文字。
		return Hit{Kind: "F"}, true
	}
	// 第 4.4 节第 4 项：段落正文例外，按空行拆分后逐段判定，且全部段落来自同一个来源。
	// 当多个来源都包含某一段时（例如同一文本既在用户消息里、也在文本附件里），
	// 逐段取命中来源的交集：只要存在单一来源覆盖全部段落即通过；
	// 交集为空（不同段落分别只来自不同来源）才视为跨来源拼接而拒绝。
	var common map[int]bool
	for _, para := range strings.Split(value, "\n\n") {
		if strings.TrimSpace(para) == "" {
			continue
		}
		pn := Normalize(para)
		if utf8.RuneCountInString(pn) < MinProvenanceChars {
			continue
		}
		hits := set.MatchParagraphIndexes(kinds, purpose, pn)
		if len(hits) == 0 {
			return Hit{}, false
		}
		if common == nil {
			common = hits
		} else {
			for idx := range common {
				if !hits[idx] {
					delete(common, idx)
				}
			}
		}
		if len(common) == 0 {
			// 第 4.4 节第 4 项：不允许跨来源拼接。
			return Hit{}, false
		}
	}
	if common == nil {
		// 全部段落都因过短而豁免。
		return Hit{Kind: "F"}, true
	}
	// 取下标最小的公共来源，保持与来源遍历顺序一致的确定性。
	best := -1
	for idx := range common {
		if best == -1 || idx < best {
			best = idx
		}
	}
	src := set.Sources[best]
	return Hit{Kind: src.Kind, AICallID: src.AICallID}, true
}

// MatchParagraphIndexes 返回包含该归一化段落的全部来源下标（第 4.4 节第 3 项：
// 必须是某一个候选文本的连续子串；同一来源命中多个候选只计一次）。
func (set *SourceSet) MatchParagraphIndexes(kinds []string, purpose, norm string) map[int]bool {
	out := map[int]bool{}
	for i, src := range set.Sources {
		if !SourceAllowed(src, kinds, purpose) {
			continue
		}
		for _, cand := range src.Norms {
			if strings.Contains(cand, norm) {
				out[i] = true
				break
			}
		}
	}
	return out
}

// KindAllowed 判断来源类别是否满足字段声明的类别组合（第 4.2 节）。
func KindAllowed(kinds []string, got string) bool {
	for _, k := range kinds {
		if k == got {
			return true
		}
	}
	return false
}

// KindsOf 把 Source 串拆成类别集合；空或 F 表示不做来源校验。
func KindsOf(source string) []string {
	switch strings.TrimSpace(source) {
	case "", "F":
		return nil
	case "U/G/O", "U/O/G", "G/U/O", "G/O/U", "O/U/G", "O/G/U":
		return []string{SrcUser, SrcAttachment, SrcG, SrcO}
	}
	out := []string{}
	for _, part := range strings.Split(source, "/") {
		switch strings.TrimSpace(part) {
		case "U":
			out = append(out, SrcUser, SrcAttachment)
		case "G":
			// 第 4.2 节：G 是「用户原文或受控生成」，来源集合为 U 的全部来源加生成结果。
			out = append(out, SrcUser, SrcAttachment, SrcG)
		case "O":
			out = append(out, SrcO)
		}
	}
	return out
}

// SourceIsU 判断字段是否只允许用户来源（第 4.5 节：仅 U 类字段失败时清空并请用户亲填；
// 含 G 或 O 的组合字段（如 U/G/O、U/O、G/O）失败时按 G、O 类处理，直接拒绝创建卡片，HC-29）。
func SourceIsU(source string) bool {
	kinds := KindsOf(source)
	if len(kinds) == 0 {
		return false
	}
	for _, k := range kinds {
		if k != SrcUser && k != SrcAttachment {
			return false
		}
	}
	return true
}

// NeedsProvenance 判断参数是否需要来源校验。
func NeedsProvenance(source string) bool { return len(KindsOf(source)) > 0 }

// ParamValueTexts 把一个参数值摊平成待校验的文本片段。
// 数组按元素展开，数组元素为对象时递归取其字符串字段（第 4.3 节的 sections / items / panels）。
func ParamValueTexts(v any) []string {
	switch t := v.(type) {
	case string:
		if strings.TrimSpace(t) == "" {
			return nil
		}
		return []string{t}
	case []any:
		out := []string{}
		for _, e := range t {
			out = append(out, ParamValueTexts(e)...)
		}
		return out
	case map[string]any:
		out := []string{}
		for _, e := range t {
			out = append(out, ParamValueTexts(e)...)
		}
		return out
	}
	return nil
}

// NumberValueText 取数字参数值的文本形式（第 4.4 节第 5 项）。
func NumberValueText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		b, _ := json.Marshal(t)
		return string(b)
	case json.Number:
		return t.String()
	}
	return ""
}

// DigitsMatched 判断数字串是否在任一来源中原样出现（第 4.4 节第 5 项）。
// 允许千分位逗号差异：来源侧同样只保留数字后做包含判断。
func DigitsMatched(set *SourceSet, kinds []string, digits string) bool {
	if digits == "" {
		return true
	}
	for _, src := range set.Sources {
		if !KindAllowed(kinds, src.Kind) {
			continue
		}
		if strings.Contains(DigitsOnly(Normalize(src.Text)), digits) {
			return true
		}
	}
	return false
}
