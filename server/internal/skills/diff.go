package skills

import (
	"reflect"
	"sort"
)

// FieldChange 是 DefinitionFields 单字段差异（DEEP-04）。
type FieldChange struct {
	Field    string `json:"field"`
	From     any    `json:"from,omitempty"`
	To       any    `json:"to,omitempty"`
	Redacted bool   `json:"redacted,omitempty"`
}

// FieldsDiff 是两次 DefinitionFields 的结构化 diff。
type FieldsDiff struct {
	FromHash          string        `json:"from_hash"`
	ToHash            string        `json:"to_hash"`
	Unchanged         bool          `json:"unchanged"`
	Changes           []FieldChange `json:"changes"`
	PromptAffecting   bool          `json:"prompt_affecting"`
	AffectedTaskTypes []string      `json:"affected_task_types"`
}

// DiffFields 比较两份已规范化字段。redactInstructions 为真时不回传 instructions 正文。
func DiffFields(from, to SkillFields, redactInstructions bool) (FieldsDiff, error) {
	fromHash := ContentHash(from)
	toHash := ContentHash(to)
	out := FieldsDiff{
		FromHash:  fromHash,
		ToHash:    toHash,
		Unchanged: fromHash == toHash,
		Changes:   []FieldChange{},
	}
	if out.Unchanged {
		out.AffectedTaskTypes = []string{}
		return out, nil
	}
	add := func(field string, a, b any, redact bool) {
		if reflect.DeepEqual(a, b) {
			return
		}
		ch := FieldChange{Field: field}
		if redact {
			ch.Redacted = true
		} else {
			ch.From, ch.To = a, b
		}
		out.Changes = append(out.Changes, ch)
	}
	add("name", from.Name, to.Name, false)
	add("summary", from.Summary, to.Summary, false)
	add("triggers", from.Triggers, to.Triggers, false)
	add("instructions", from.Instructions, to.Instructions, redactInstructions)
	add("platforms", append([]string(nil), from.Platforms...), append([]string(nil), to.Platforms...), false)
	add("content_formats", append([]string(nil), from.ContentFormats...), append([]string(nil), to.ContentFormats...), false)
	add("task_types", append([]string(nil), from.TaskTypes...), append([]string(nil), to.TaskTypes...), false)
	add("task_enabled", from.TaskEnabled, to.TaskEnabled, false)
	add("agent_enabled", from.AgentEnabled, to.AgentEnabled, false)
	add("status", from.Status, to.Status, false)

	out.PromptAffecting = true
	out.AffectedTaskTypes = unionTaskTypes(from.TaskTypes, to.TaskTypes)
	return out, nil
}

func unionTaskTypes(a, b []string) []string {
	set := map[string]bool{}
	add := func(ts []string) {
		if len(ts) == 0 {
			for _, t := range skillTaskC0 {
				set[t] = true
			}
			return
		}
		for _, t := range ts {
			set[t] = true
		}
	}
	add(a)
	add(b)
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}
