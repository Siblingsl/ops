package skills

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"ops/internal/platformfmt"
)

// DEV-SK1 / docs/23：技能字段、任务清单与纯校验（D-176 Phase 1 自 app 下沉）。

const (
	InstructionLimit = 1200
	SlotBudget       = 3600
	EffectiveLimit   = 20
	CatalogRenderMax = 8
	HintLimit        = 40
	WorkspaceLimit   = 50
	AccountLimit     = 30
	PersonalLimit    = 50
	BindingLimit     = 20
	NameMax          = 30
	SummaryMax       = 60
	TriggerMax       = 120
	ImportMaxBytes   = 64 << 10
	JSONMaxBytes     = 128 << 10
)

// 兼容旧常量名（app 薄封装仍引用）。
const (
	skillInstructionLimit = InstructionLimit
	skillSlotBudget       = SlotBudget
	skillEffectiveLimit   = EffectiveLimit
	skillNameMax          = NameMax
	skillSummaryMax       = SummaryMax
	skillTriggerMax       = TriggerMax
	skillImportMaxBytes   = ImportMaxBytes
)

var skillTaskC0 = []string{
	"outline", "section_draft", "section_edit", "title", "summary", "rewrite_plan",
	"section_rewrite", "comic_storyboard", "comic_panel_text", "comic_rewrite",
	"section_continue", "hook_suggest", "topic_suggest", "topic_hot_suggest",
	"image_suggest", "organize_notes", "daily_recommend", "strategy_outline",
}

var skillTaskC1 = []string{
	"tag_suggest", "outline_review", "read_through", "polish_check",
	"fix_suggest", "layout_suggest", "copilot_chat",
}

var skillTaskAllowedSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range append(append([]string{}, skillTaskC0...), skillTaskC1...) {
		m[t] = true
	}
	return m
}()

var skillTaskDefaultSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range skillTaskC0 {
		m[t] = true
	}
	return m
}()

func TaskAllowed(taskType string) bool { return skillTaskAllowedSet[taskType] }

func TaskApplicable(f SkillFields, taskType string) bool {
	if len(f.TaskTypes) == 0 {
		return skillTaskDefaultSet[taskType]
	}
	for _, t := range f.TaskTypes {
		if t == taskType {
			return true
		}
	}
	return false
}

// SkillFields 是 DraftFields + status（11.1 节 DefinitionFields）。
type SkillFields struct {
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    bool     `json:"task_enabled"`
	AgentEnabled   bool     `json:"agent_enabled"`
	Status         string   `json:"status,omitempty"`
}

// ValidationError 是纯字段校验错误；app 映射为 APIError。
type ValidationError struct {
	Message string
	Fields  map[string]string
}

func (e *ValidationError) Error() string { return e.Message }

func validationErr(msg string) error { return &ValidationError{Message: msg} }
func validationFieldsErr(msg string, fields map[string]string) error {
	return &ValidationError{Message: msg, Fields: fields}
}

func NormalizeEnumArray(a []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(a))
	for _, v := range a {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

func NormalizeText(f *SkillFields) error {
	normLine := func(s string) (string, error) {
		s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
		s = strings.TrimFunc(s, func(r rune) bool {
			return r == ' ' || r == '\t' || r == 0x3000 || r == '\n' || r == 0x00A0 || r == 0x2028 || r == 0x2029 ||
				(r >= 0x2000 && r <= 0x200A)
		})
		for _, r := range s {
			if r == '\n' || (r >= 0x00 && r <= 0x1F) || r == 0x7F {
				return "", validationErr("技能文本不能包含换行或控制字符")
			}
		}
		return s, nil
	}
	var err error
	if f.Name, err = normLine(f.Name); err != nil {
		return err
	}
	if f.Summary, err = normLine(f.Summary); err != nil {
		return err
	}
	if f.Triggers, err = normLine(f.Triggers); err != nil {
		return err
	}
	f.Instructions = strings.ReplaceAll(strings.ReplaceAll(f.Instructions, "\r\n", "\n"), "\r", "\n")
	return nil
}

func textHasControl(s string) bool {
	for _, r := range s {
		if r == '\n' || (r >= 0x00 && r <= 0x1F) || r == 0x7F {
			return true
		}
	}
	return false
}

func runeLen(s string) int { return utf8.RuneCountInString(s) }

// ValidateFields 是纯字段校验；密钥检测仍在 app。
func ValidateFields(f *SkillFields) error {
	if err := NormalizeText(f); err != nil {
		return err
	}
	f.Platforms = NormalizeEnumArray(f.Platforms)
	f.ContentFormats = NormalizeEnumArray(f.ContentFormats)
	f.TaskTypes = NormalizeEnumArray(f.TaskTypes)
	switch {
	case f.Name == "" || runeLen(f.Name) > skillNameMax:
		return validationFieldsErr("技能名称需要 1–30 字", map[string]string{"name": "invalid"})
	case f.Summary == "" || runeLen(f.Summary) > skillSummaryMax:
		return validationFieldsErr("技能用途需要 1–60 字", map[string]string{"summary": "invalid"})
	case f.Triggers == "" || runeLen(f.Triggers) > skillTriggerMax:
		return validationFieldsErr("触发说明需要 1–120 字", map[string]string{"triggers": "invalid"})
	case strings.TrimSpace(f.Instructions) == "":
		return validationFieldsErr("技能正文不能为空", map[string]string{"instructions": "invalid"})
	case runeLen(f.Instructions) > skillInstructionLimit:
		return validationFieldsErr(fmt.Sprintf("技能正文最多 %d 字", skillInstructionLimit), map[string]string{"instructions": "invalid"})
	}
	for _, s := range []string{f.Name, f.Summary, f.Triggers} {
		if textHasControl(s) {
			return validationErr("技能名称、用途与触发说明不能包含换行或控制字符")
		}
	}
	if f.Status != "active" && f.Status != "disabled" {
		return validationFieldsErr("技能状态只能是 active 或 disabled", map[string]string{"status": "invalid"})
	}
	if !f.TaskEnabled && !f.AgentEnabled {
		return validationFieldsErr("生成与智能体入口不能同时关闭", map[string]string{"task_enabled": "invalid", "agent_enabled": "invalid"})
	}
	for _, p := range f.Platforms {
		if _, ok := platformfmt.FormatMatrix[p]; !ok {
			return validationFieldsErr("平台不在支持清单", map[string]string{"platforms": "invalid"})
		}
	}
	formatSet := map[string]bool{}
	for _, fs := range platformfmt.FormatMatrix {
		for _, fm := range fs {
			formatSet[fm] = true
		}
	}
	for _, fm := range f.ContentFormats {
		if !formatSet[fm] {
			return validationFieldsErr("作品形态不在支持清单", map[string]string{"content_formats": "invalid"})
		}
	}
	if err := ValidateCombos(f.Platforms, f.ContentFormats); err != nil {
		return err
	}
	for _, t := range f.TaskTypes {
		if !TaskAllowed(t) {
			return validationFieldsErr("任务不在技能允许清单", map[string]string{"task_types": "invalid"})
		}
	}
	return nil
}

func ValidateCombos(platforms, formats []string) error {
	for _, p := range platforms {
		ok := false
		if len(formats) == 0 {
			ok = len(platformfmt.FormatMatrix[p]) > 0
		} else {
			for _, fm := range formats {
				if platformfmt.Valid(p, fm) {
					ok = true
					break
				}
			}
		}
		if !ok {
			return validationFieldsErr("所选平台与作品形态没有有效组合", map[string]string{"platforms": "invalid", "content_formats": "invalid"})
		}
	}
	for _, fm := range formats {
		ok := false
		if len(platforms) == 0 {
			for p := range platformfmt.FormatMatrix {
				if platformfmt.Valid(p, fm) {
					ok = true
					break
				}
			}
		} else {
			for _, p := range platforms {
				if platformfmt.Valid(p, fm) {
					ok = true
					break
				}
			}
		}
		if !ok {
			return validationFieldsErr("所选作品形态与平台没有有效组合", map[string]string{"platforms": "invalid", "content_formats": "invalid"})
		}
	}
	return nil
}

func MatchesTarget(f SkillFields, platform, format string) bool {
	if !platformfmt.Valid(platform, format) {
		return false
	}
	if len(f.Platforms) > 0 && !strIn(f.Platforms, platform) {
		return false
	}
	if len(f.ContentFormats) > 0 && !strIn(f.ContentFormats, format) {
		return false
	}
	return true
}

func strIn(arr []string, v string) bool {
	for _, x := range arr {
		if x == v {
			return true
		}
	}
	return false
}

// 测试与 builtin 兼容的旧名。
func normalizeEnumArray(a []string) []string             { return NormalizeEnumArray(a) }
func validateSkillFields(f *SkillFields) error           { return ValidateFields(f) }
func validateSkillCombos(platforms, formats []string) error { return ValidateCombos(platforms, formats) }
func skillTaskAllowed(taskType string) bool              { return TaskAllowed(taskType) }
func skillMatchesTarget(f SkillFields, platform, format string) bool {
	return MatchesTarget(f, platform, format)
}
