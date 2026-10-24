package app

import (
	"strings"
	"testing"
)

func skillMdFixture() string {
	return `---
format_version: 1
name: 小红书开头钩子
summary: 为小红书笔记生成开头
triggers: 起草笔记第一段、改写开头或生成开头钩子时使用
platforms: [xhs]
formats: [image_note]
tasks: [section_draft, hook_suggest]
task_enabled: true
agent_enabled: true
---
完整指令正文，第一段。

第二段。
`
}

// T-SK-3：UTF-8 / BOM / CRLF 合法。
func TestSkillMarkdownParseValid(t *testing.T) {
	raw := []byte(skillMdFixture())
	p, err := parseSkillMarkdown(raw, nil)
	if err != nil {
		t.Fatalf("plain: %v", err)
	}
	if p.Fields.Name != "小红书开头钩子" || p.Fields.Platforms[0] != "xhs" {
		t.Fatalf("fields: %+v", p.Fields)
	}
	if strings.Join(p.Fields.TaskTypes, ",") != "hook_suggest,section_draft" {
		t.Fatalf("tasks normalized: %v", p.Fields.TaskTypes)
	}
	if !strings.Contains(p.Fields.Instructions, "第二段。") {
		t.Fatalf("body lost: %q", p.Fields.Instructions)
	}
	// BOM + CRLF。
	bom := append([]byte{0xEF, 0xBB, 0xBF}, []byte(strings.ReplaceAll(skillMdFixture(), "\n", "\r\n"))...)
	p2, err := parseSkillMarkdown(bom, nil)
	if err != nil {
		t.Fatalf("bom/crlf: %v", err)
	}
	if p2.Fields.Name != p.Fields.Name || p2.Fields.Instructions != p.Fields.Instructions {
		t.Fatal("BOM/CRLF handling must be transparent")
	}
	// 缺省 format_version / 开关告警；数组缺省 []。
	minimal := "---\nname: 最小\nsummary: 摘要\ntriggers: 触发\n---\n正文"
	p3, err := parseSkillMarkdown([]byte(minimal), nil)
	if err != nil {
		t.Fatalf("minimal: %v", err)
	}
	codes := map[string]bool{}
	for _, w := range p3.Warnings {
		codes[w.Field] = true
	}
	if !codes["format_version"] || !codes["task_enabled"] || !codes["agent_enabled"] {
		t.Fatalf("want defaults warnings, got %+v", p3.Warnings)
	}
	if len(p3.Fields.Platforms) != 0 || len(p3.Fields.TaskTypes) != 0 {
		t.Fatal("missing arrays default to empty")
	}
}

// T-SK-3 / T-SK-24：超 64 KiB、重复键、别名、合并键、自定义标签、额外文档、
// 非法版本、字段非法与超 1200 字拒绝，不落库（纯解析无副作用）。
func TestSkillMarkdownRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"重复键", "---\nname: a\nname: b\nsummary: s\ntriggers: t\n---\n正文"},
		{"别名", "---\nx: &a 值\nname: *a\nsummary: s\ntriggers: t\n---\n正文"},
		{"合并键", "---\nx: &a {p: 1}\n<<: *a\nname: n\nsummary: s\ntriggers: t\n---\n正文"},
		{"自定义标签", "---\nname: !!custom 值\nsummary: s\ntriggers: t\n---\n正文"},
		{"未知版本", "---\nformat_version: 2\nname: n\nsummary: s\ntriggers: t\n---\n正文"},
		{"非法 YAML", "---\nname: [未闭合\nsummary: s\n---\n正文"},
		{"frontmatter 缺结束", "---\nname: n\nsummary: s\n"},
		{"正文为空", "---\nname: n\nsummary: s\ntriggers: t\n---\n   \n"},
		{"正文超 1200 字", "---\nname: n\nsummary: s\ntriggers: t\n---\n" + strings.Repeat("字", 1201)},
		{"名称超长", "---\nname: " + strings.Repeat("名", 31) + "\nsummary: s\ntriggers: t\n---\n正文"},
		{"名称内嵌换行", "---\nname: \"a\\nb\"\nsummary: s\ntriggers: t\n---\n正文"},
		{"平台枚举非法", "---\nname: n\nsummary: s\ntriggers: t\nplatforms: [weibo]\n---\n正文"},
		{"平台形态无有效组合", "---\nname: n\nsummary: s\ntriggers: t\nplatforms: [xhs]\nformats: [long_article]\n---\n正文"},
		{"任务不在允许清单", "---\nname: n\nsummary: s\ntriggers: t\ntasks: [image_gen]\n---\n正文"},
		{"双开关关闭", "---\nname: n\nsummary: s\ntriggers: t\ntask_enabled: false\nagent_enabled: false\n---\n正文"},
		{"数组提供非字符串", "---\nname: n\nsummary: s\ntriggers: t\nplatforms: [1, 2]\n---\n正文"},
	}
	for _, c := range cases {
		if _, err := parseSkillMarkdown([]byte(c.raw), nil); err == nil {
			t.Fatalf("%s: want reject", c.name)
		}
	}
	// 超 64 KiB。
	big := "---\nname: n\nsummary: s\ntriggers: t\n---\n" + strings.Repeat("字", 70000)
	if _, err := parseSkillMarkdown([]byte(big), nil); err == nil {
		t.Fatal("oversize should reject")
	}
}

// T-SK-4：密钥检测覆盖整个原始文件（含未知键），命中不回显；否定式话术不误拒。
func TestSkillMarkdownSecrets(t *testing.T) {
	// 合成测试值：sk- 前缀样式的假密钥。
	leak := "---\nname: n\nsummary: s\ntriggers: t\nunknown_key: sk-TESTKEY0000000000000000abc\n---\n正文"
	_, err := parseSkillMarkdown([]byte(leak), nil)
	if err == nil || !strings.Contains(errTextOf(err), "密钥") {
		t.Fatalf("synthetic secret must be rejected, got %v", err)
	}
	// 关键词后的否定式话术：无连续 16 位以上字母数字，不应误拒。
	ok := "---\nname: 不写密钥\nsummary: 提醒不要把 api_key 写进技能\ntriggers: 处理密钥话题时\n---\n不要在正文里写“一键爆文”这种说法。"
	if _, err := parseSkillMarkdown([]byte(ok), nil); err != nil {
		t.Fatalf("normal negative phrasing rejected: %v", err)
	}
}

func errTextOf(err error) string { return err.Error() }

// T-SK-24：export→parse 保留全部行为字段；正文分隔线与 YAML 文档边界不混淆。
func TestSkillExportRoundTrip(t *testing.T) {
	fields := SkillFields{
		Name: "往返", Summary: "检查导出", Triggers: "全字段",
		Instructions: "第一行\n\n---\n\n正文里的水平线\n",
		Platforms:    []string{"wechat_mp", "xhs"}, ContentFormats: []string{"long_article", "image_note"},
		TaskTypes: []string{"outline", "title"},
		TaskEnabled: true, AgentEnabled: false, Status: "active",
	}
	md, err := exportSkillMarkdown(fields)
	if err != nil {
		t.Fatal(err)
	}
	p, err := parseSkillMarkdown([]byte(md), nil)
	if err != nil {
		t.Fatalf("round trip parse: %v\n%s", err, md)
	}
	if len(p.Warnings) != 0 {
		t.Fatalf("round trip must not warn: %+v", p.Warnings)
	}
	got := p.Fields
	if got.Name != fields.Name || got.Summary != fields.Summary || got.Triggers != fields.Triggers {
		t.Fatalf("text fields changed: %+v", got)
	}
	// 数组按规范化口径（去重、字节序升序）往返（T-SK-35）。
	if strings.Join(got.Platforms, ",") != strings.Join(normalizeEnumArray(fields.Platforms), ",") ||
		strings.Join(got.ContentFormats, ",") != strings.Join(normalizeEnumArray(fields.ContentFormats), ",") ||
		strings.Join(got.TaskTypes, ",") != strings.Join(normalizeEnumArray(fields.TaskTypes), ",") {
		t.Fatalf("arrays changed: %+v", got)
	}
	if got.TaskEnabled != fields.TaskEnabled || got.AgentEnabled != fields.AgentEnabled {
		t.Fatalf("switches changed: %+v", got)
	}
	if got.Instructions != fields.Instructions {
		t.Fatalf("body changed:\n%q\n%q", got.Instructions, fields.Instructions)
	}
	// 正文中的 --- 水平线不会被当作第二个 YAML 文档（4.2 节第 6 项）。
	if !strings.Contains(got.Instructions, "\n---\n") {
		t.Fatal("horizontal rule lost")
	}
	// 关闭分隔行之后以 --- 开头的内容是 Markdown，不再是 YAML 文档。
	extra := "---\nname: 后续\nsummary: s\ntriggers: t\n---\n---\n这一段是正文"
	if _, err := parseSkillMarkdown([]byte(extra), nil); err != nil {
		t.Fatalf("body after closing delimiter must not be YAML: %v", err)
	}
}
