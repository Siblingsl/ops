package app

import (
	"strings"
	"testing"
)

// DEV-A104（13 文档）：副驾驶建议结构化——一条回复可提取最多三条可执行建议
//（改写/补充），逐条应用走既有对比确认通道；拒绝整篇输出的规则不变。
func TestA104CopilotSuggestions(t *testing.T) {
	reply := "这段的论证是清楚的。\n\n建议改为：先给一个具体场景，再引出结论。\n\n建议补充：结尾可以补一个今天就能做的小动作。\n\n建议补充：加一句数据来源说明。"
	list := copilotSuggestions(reply)
	if len(list) != 3 {
		t.Fatalf("suggestions: %+v", list)
	}
	if list[0].Kind != "rewrite" || !strings.Contains(list[0].Text, "具体场景") {
		t.Fatalf("first: %+v", list[0])
	}
	if list[1].Kind != "append" || list[2].Kind != "append" {
		t.Fatalf("kinds: %+v", list)
	}
	if copilotSuggestion(reply) != list[0].Text {
		t.Fatal("copilotSuggestion should return the first rewrite")
	}
	// 没有建议标记时为空；超过三条截断。
	if n := copilotSuggestions("这段写得不错，没有需要改的地方。"); len(n) != 0 {
		t.Fatalf("no-marker reply: %+v", n)
	}
	many := "建议改为：一\n\n建议改为：二\n\n建议改为：三\n\n建议改为：四"
	if n := copilotSuggestions(many); len(n) != 3 {
		t.Fatalf("cap: %+v", n)
	}
}
