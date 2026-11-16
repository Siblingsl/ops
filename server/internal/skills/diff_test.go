package skills

import "testing"

func TestDiffFieldsUnchanged(t *testing.T) {
	f := SkillFields{
		Name: "n", Summary: "s", Triggers: "t", Instructions: "body",
		Platforms: []string{"wechat_mp"}, ContentFormats: []string{"long_article"},
		TaskTypes: []string{"title"}, TaskEnabled: true, AgentEnabled: true, Status: "active",
	}
	d, err := DiffFields(f, f, false)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Unchanged || len(d.Changes) != 0 || d.PromptAffecting {
		t.Fatalf("unchanged: %+v", d)
	}
	if d.FromHash == "" || d.FromHash != d.ToHash {
		t.Fatal("hash")
	}
}

func TestDiffFieldsInstructionsRedactedAndTaskUnion(t *testing.T) {
	from := SkillFields{
		Name: "n", Summary: "s", Triggers: "t", Instructions: "old secret",
		TaskTypes: []string{"title"}, TaskEnabled: true, AgentEnabled: true, Status: "active",
	}
	to := from
	to.Instructions = "new secret"
	to.TaskTypes = []string{"outline", "title"}
	d, err := DiffFields(from, to, true)
	if err != nil {
		t.Fatal(err)
	}
	if d.Unchanged || !d.PromptAffecting {
		t.Fatalf("%+v", d)
	}
	if len(d.Changes) != 2 {
		t.Fatalf("changes=%v", d.Changes)
	}
	var sawInstr bool
	for _, c := range d.Changes {
		if c.Field == "instructions" {
			sawInstr = true
			if !c.Redacted || c.From != nil || c.To != nil {
				t.Fatalf("instructions should redact: %+v", c)
			}
		}
	}
	if !sawInstr {
		t.Fatal("missing instructions change")
	}
	if len(d.AffectedTaskTypes) != 2 || d.AffectedTaskTypes[0] != "outline" || d.AffectedTaskTypes[1] != "title" {
		t.Fatalf("tasks=%v", d.AffectedTaskTypes)
	}
}

func TestDiffFieldsEmptyTaskTypesUsesDefaults(t *testing.T) {
	from := SkillFields{
		Name: "n", Summary: "s", Triggers: "t", Instructions: "a",
		TaskEnabled: true, AgentEnabled: true, Status: "active",
	}
	to := from
	to.Instructions = "b"
	d, err := DiffFields(from, to, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.AffectedTaskTypes) < len(skillTaskC0) {
		t.Fatalf("expected default C0 tasks, got %d", len(d.AffectedTaskTypes))
	}
}
