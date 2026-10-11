package app

import "strings"

// DEV-A105（13 文档）：起草自检前置。AI 初稿生成后自动修复表达规则里最机械的一类问题
//（绝对化用语），修正透明标注且可撤销；账号禁用词与待核实标记不在此列——E-11 要求它们
// 保持可解释，由检查阶段提示，不做静默替换。

var draftSelfCheckPairs = [][2]string{
	{"最好的", "很好的"}, {"最佳的", "很好的"}, {"最强的", "很强的"},
	{"最大的", "很大的"}, {"最高的", "很高的"}, {"最快的", "很快的"},
	{"最差的", "较差的"}, {"最严重的", "比较严重的"},
	{"绝对", "相当"},
}

type draftFix struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Count int    `json:"count"`
}

// selfCheckDraft applies the conservative absolute-word fixes; returns the fixed text,
// the applied fixes, and whether anything changed. 「绝对化」 itself is protected from the
// 绝对 rewrite (it names the rule, not an absolute claim).
func selfCheckDraft(text string) (string, []draftFix, bool) {
	const placeholder = "\x00ABS\x00"
	fixed := strings.ReplaceAll(text, "绝对化", placeholder)
	fixes := []draftFix{}
	for _, pair := range draftSelfCheckPairs {
		if n := strings.Count(fixed, pair[0]); n > 0 {
			fixed = strings.ReplaceAll(fixed, pair[0], pair[1])
			fixes = append(fixes, draftFix{From: pair[0], To: pair[1], Count: n})
		}
	}
	fixed = strings.ReplaceAll(fixed, placeholder, "绝对化")
	if fixed == text {
		return text, nil, false
	}
	return fixed, fixes, len(fixes) > 0
}
