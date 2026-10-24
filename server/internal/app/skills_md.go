package app

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// DEV-SK1 / docs/23 第 4.2 节：技能 .md 解析与导出。
// 只接受单个 frontmatter 映射与后续 Markdown 正文；禁止 YAML 别名、合并键、重复键、
// 自定义标签与额外 YAML 文档；不进行模板求值、联网或引用文件读取。

var skillBOM = []byte{0xEF, 0xBB, 0xBF}

type skillParsed struct {
	Fields   SkillFields
	Warnings []Warning
}

// Warning 是字段级告警（11.1 节）：消息不得包含原始敏感值。
type Warning struct {
	Code    string `json:"code"`
	Field   string `json:"field"`
	Message string `json:"message"`
}

func (p *skillParsed) warn(code, field, msg string) {
	p.Warnings = append(p.Warnings, Warning{Code: code, Field: field, Message: msg})
}

// parseSkillMarkdown 解析原始 .md 文件内容。secrets 为本工作区已存密钥明文，
// 在解析前对整个原始文件检查（未知键不能成为绕过路径）。
func parseSkillMarkdown(raw []byte, secrets []string) (*skillParsed, error) {
	if len(raw) > skillImportMaxBytes {
		return nil, apiErr(413, "request_too_large", "技能文件超过 64 KiB 上限")
	}
	if agentContainsSecret(string(raw), secrets) {
		return nil, apiErr(422, "skill_secret_detected", "文件疑似包含密钥，已拒绝处理（不会保存或回显原文）").With(map[string]string{"field": "content"})
	}
	text := string(bytes.TrimPrefix(raw, skillBOM))
	if !utf8.ValidString(text) {
		return nil, validationFields("文件必须是有效 UTF-8", map[string]string{"content": "invalid"})
	}
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")

	fm, body, err := splitSkillFrontmatter(text)
	if err != nil {
		return nil, err
	}
	out := &skillParsed{}
	if err := decodeSkillFrontmatter(fm, out); err != nil {
		return nil, err
	}
	body = strings.TrimPrefix(body, "\n")
	if strings.TrimSpace(body) == "" {
		return nil, validationFields("技能正文不能为空", map[string]string{"instructions": "invalid"})
	}
	if runeLen(body) > skillInstructionLimit {
		return nil, validationFields(fmt.Sprintf("技能正文最多 %d 字（当前 %d 字）", skillInstructionLimit, runeLen(body)), map[string]string{"instructions": "invalid"})
	}
	out.Fields.Instructions = body
	f := out.Fields
	// DraftFields 不含 status；解析层按“再导入默认 active”校验（4.2 节第 6 项）。
	f.Status = "active"
	if err := validateSkillFields(&f); err != nil {
		return nil, err
	}
	f.Status = ""
	out.Fields = f
	return out, nil
}


// splitSkillFrontmatter 提取文件开头的 frontmatter；关闭分隔行之后的 Markdown
//（包括 --- 水平线）不作为额外 YAML 文档解析。
func splitSkillFrontmatter(text string) (string, string, error) {
	lines := strings.Split(text, "\n")
	if len(lines) == 0 || strings.TrimRight(lines[0], " \t") != "---" {
		return "", "", validationFields("文件必须以 --- frontmatter 开始", map[string]string{"content": "invalid"})
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimRight(lines[i], " \t") == "---" {
			fm := strings.Join(lines[1:i], "\n")
			body := strings.Join(lines[i+1:], "\n")
			return fm, body, nil
		}
	}
	return "", "", validationFields("frontmatter 缺少结束分隔行", map[string]string{"content": "invalid"})
}

var skillYAMLStdTags = map[string]bool{
	"!!str": true, "!!int": true, "!!bool": true, "!!float": true, "!!null": true,
	"!!seq": true, "!!map": true, "!!binary": true, "!!timestamp": true,
}

// decodeSkillFrontmatter 校验并读取 frontmatter 字段。
func decodeSkillFrontmatter(fm string, out *skillParsed) error {
	if strings.TrimSpace(fm) == "" {
		return validationFields("frontmatter 不能为空", map[string]string{"content": "invalid"})
	}
	dec := yaml.NewDecoder(strings.NewReader(fm))
	var node yaml.Node
	if err := dec.Decode(&node); err != nil {
		return validationFields("frontmatter YAML 解析失败", map[string]string{"content": "invalid"})
	}
	// 额外 YAML 文档拒绝。
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return validationFields("frontmatter 只能包含一个 YAML 文档", map[string]string{"content": "invalid"})
	}
	if err := validateYAMLNode(&node); err != nil {
		return err
	}
	if node.Kind == yaml.DocumentNode && len(node.Content) == 1 {
		node = *node.Content[0]
	}
	if node.Kind != yaml.MappingNode {
		return validationFields("frontmatter 必须是键值映射", map[string]string{"content": "invalid"})
	}
	seen := map[string]bool{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		kn, vn := node.Content[i], node.Content[i+1]
		key := kn.Value
		if seen[key] {
			return validationFields("frontmatter 存在重复键", map[string]string{"content": "invalid"})
		}
		seen[key] = true
		if err := decodeSkillKey(key, vn, out); err != nil {
			return err
		}
	}
	// 缺省告警：format_version / 两开关缺省各按默认值并告警（4.2 节第 3 项）。
	if !seen["format_version"] {
		out.warn("defaulted", "format_version", "format_version 缺省按 1 处理")
	}
	if !seen["task_enabled"] {
		out.Fields.TaskEnabled = true
		out.warn("defaulted", "task_enabled", "task_enabled 缺省按 true 处理")
	}
	if !seen["agent_enabled"] {
		out.Fields.AgentEnabled = true
		out.warn("defaulted", "agent_enabled", "agent_enabled 缺省按 true 处理")
	}
	return nil
}

// validateYAMLNode 拒绝别名、合并键与自定义标签。
func validateYAMLNode(n *yaml.Node) error {
	if n == nil {
		return nil
	}
	if n.Alias != nil {
		return validationFields("frontmatter 不允许 YAML 别名", map[string]string{"content": "invalid"})
	}
	if n.Tag == "!!merge" {
		return validationFields("frontmatter 不允许合并键", map[string]string{"content": "invalid"})
	}
	if n.Tag != "" && !skillYAMLStdTags[n.Tag] {
		return validationFields("frontmatter 不允许自定义 YAML 标签", map[string]string{"content": "invalid"})
	}
	for _, c := range n.Content {
		if err := validateYAMLNode(c); err != nil {
			return err
		}
	}
	return nil
}

func decodeSkillKey(key string, vn *yaml.Node, out *skillParsed) error {
	badValue := func(field string) error {
		return validationFields("字段值类型不正确", map[string]string{field: "invalid"})
	}
	switch key {
	case "format_version":
		if vn.Kind != yaml.ScalarNode || vn.Tag != "!!int" {
			return badValue("format_version")
		}
		var v int
		if err := yaml.Unmarshal([]byte(vn.Value), &v); err != nil || vn.Value != "1" {
			return validationFields("format_version 只支持 1", map[string]string{"format_version": "invalid"})
		}
	case "name", "summary", "triggers":
		if vn.Kind != yaml.ScalarNode || vn.Tag != "!!str" {
			return badValue(key)
		}
		switch key {
		case "name":
			out.Fields.Name = vn.Value
		case "summary":
			out.Fields.Summary = vn.Value
		case "triggers":
			out.Fields.Triggers = vn.Value
		}
	case "platforms", "formats", "tasks":
		var arr []string
		if vn.Kind == yaml.ScalarNode && (vn.Tag == "!!null" || vn.Value == "") {
			arr = []string{}
		} else if vn.Kind == yaml.SequenceNode {
			for _, item := range vn.Content {
				if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
					return badValue(key)
				}
				arr = append(arr, item.Value)
			}
		} else {
			return badValue(key)
		}
		switch key {
		case "platforms":
			out.Fields.Platforms = arr
		case "formats":
			out.Fields.ContentFormats = arr
		case "tasks":
			out.Fields.TaskTypes = arr
		}
	case "task_enabled", "agent_enabled":
		if vn.Kind != yaml.ScalarNode || vn.Tag != "!!bool" {
			return badValue(key)
		}
		v := vn.Value == "true"
		switch key {
		case "task_enabled":
			out.Fields.TaskEnabled = v
		case "agent_enabled":
			out.Fields.AgentEnabled = v
		}
	default:
		// 未知键告警；预览只显示键名，绝不回显原始值。
		out.warn("unknown_key", key, "未知的 frontmatter 键将被忽略")
	}
	return nil
}

// exportSkillMarkdown 以第 4.2 节格式导出；文本用 YAML 字符串编码，正文不改写。
// ID、归属、绑定、status 之外的行为字段全部随包迁移（T-SK-24）。
func exportSkillMarkdown(f SkillFields) (string, error) {
	if err := validateSkillFields(&f); err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("---\n")
	writeYAMLScalar := func(key, val string) {
		enc, _ := yaml.Marshal(val)
		b.WriteString(key + ": " + strings.TrimRight(string(enc), "\n") + "\n")
	}
	writeYAMLSeq := func(key string, vals []string) {
		if len(vals) == 0 {
			b.WriteString(key + ": []\n")
			return
		}
		parts := make([]string, 0, len(vals))
		for _, v := range vals {
			enc, _ := yaml.Marshal(v)
			parts = append(parts, strings.TrimRight(string(enc), "\n"))
		}
		b.WriteString(key + ": [" + strings.Join(parts, ", ") + "]\n")
	}
	b.WriteString("format_version: 1\n")
	writeYAMLScalar("name", f.Name)
	writeYAMLScalar("summary", f.Summary)
	writeYAMLScalar("triggers", f.Triggers)
	writeYAMLSeq("platforms", f.Platforms)
	writeYAMLSeq("formats", f.ContentFormats)
	writeYAMLSeq("tasks", f.TaskTypes)
	fmt.Fprintf(&b, "task_enabled: %t\n", f.TaskEnabled)
	fmt.Fprintf(&b, "agent_enabled: %t\n", f.AgentEnabled)
	b.WriteString("---\n")
	b.WriteString(f.Instructions)
	return b.String(), nil
}
