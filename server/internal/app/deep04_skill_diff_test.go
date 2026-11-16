package app

import (
	"testing"
)

// DEEP-04：保存前 diff——字段变更、个人正文脱敏、跨修订 409。

func TestDEEP04SkillDiffPromptAffectingAndPersonalRedaction(t *testing.T) {
	created := skillPersonalCreate(t, "DEEP04-差分")
	sid := skillIDOf(t, created)
	rev := int64(created["revision"].(float64))

	var diff struct {
		Unchanged         bool             `json:"unchanged"`
		PromptAffecting   bool             `json:"prompt_affecting"`
		Changes           []map[string]any `json:"changes"`
		AffectedTaskTypes []string         `json:"affected_task_types"`
		FromHash          string           `json:"from_hash"`
		ToHash            string           `json:"to_hash"`
	}
	fields := map[string]any{
		"name": created["name"], "summary": created["summary"], "triggers": created["triggers"],
		"instructions": "改写后的正文", "platforms": created["platforms"], "content_formats": created["content_formats"],
		"task_types": []string{"title", "outline"}, "task_enabled": true, "agent_enabled": true, "status": "active",
	}
	env.mustJSON(t, "POST", "/api/v1/skills/"+sid.String()+"/diff", map[string]any{
		"base_revision": rev, "fields": fields,
	}, &diff)
	if diff.Unchanged || !diff.PromptAffecting || diff.FromHash == "" || diff.FromHash == diff.ToHash {
		t.Fatalf("diff=%+v", diff)
	}
	var sawInstr, redacted bool
	for _, c := range diff.Changes {
		if c["field"] == "instructions" {
			sawInstr = true
			redacted, _ = c["redacted"].(bool)
			if c["from"] != nil || c["to"] != nil {
				t.Fatalf("personal instructions must redact: %#v", c)
			}
		}
	}
	if !sawInstr || !redacted {
		t.Fatalf("expected redacted instructions change, got %#v", diff.Changes)
	}
	if len(diff.AffectedTaskTypes) < 2 {
		t.Fatalf("task union: %v", diff.AffectedTaskTypes)
	}

	env.expectErr(t, "POST", "/api/v1/skills/"+sid.String()+"/diff", map[string]any{
		"base_revision": rev + 1, "fields": fields,
	}, "stale")
}
