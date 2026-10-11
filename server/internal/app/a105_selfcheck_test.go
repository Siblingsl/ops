package app

import (
	"strings"
	"testing"
)

// DEV-A105（13 文档）：起草自检前置——绝对化用语在初稿上机械修正，修正记录透明可还原；
// 无问题时不出现在结果里。账号禁用词与待核实标记不静默替换（E-11）。
func TestA105DraftSelfCheck(t *testing.T) {
	text := "最好的办法是绝对专注，第一次做难免出错。"
	fixed, fixes, changed := selfCheckDraft(text)
	if !changed || len(fixes) != 2 {
		t.Fatalf("fixes: %+v", fixes)
	}
	if !strings.Contains(fixed, "很好的") || !strings.Contains(fixed, "相当专注") {
		t.Fatalf("fixed: %s", fixed)
	}
	// 「第一次」是正常表达：第一 被保守地跳过，不能误伤。
	if strings.Contains(fixed, "领先") {
		t.Fatalf("should not rewrite 第一: %s", fixed)
	}
	for _, f := range fixes {
		if f.From == "第一" {
			t.Fatalf("第一 should not be auto-fixed: %+v", fixes)
		}
	}
	if _, fixes2, changed2 := selfCheckDraft("这段没有绝对化用语。"); changed2 || len(fixes2) != 0 {
		t.Fatalf("clean text: %+v", fixes2)
	}
}
