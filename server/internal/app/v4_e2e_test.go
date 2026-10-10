package app

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

type strategyView struct {
	Active   *Strategy   `json:"active"`
	Versions []*Strategy `json:"versions"`
}

// v4Account creates a fresh account so strategy/plan state does not leak into other tests.
func v4Account(t *testing.T, name string) (Account, string) {
	t.Helper()
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": name, "content_format": "image_note"}, &a)
	return a, "/api/v1/accounts/" + a.ID.String()
}

func positioningOptions(t *testing.T, acc string) ([]PositioningOption, string) {
	t.Helper()
	ev := lastEvent(t, env.sse(t, acc+"/strategy/options", map[string]any{
		"domain": "互联网运营", "experiences": "在电商公司做了五年用户增长，带过三人小团队", "weekly_hours": 6}))
	if ev.Name != "done" {
		t.Fatalf("positioning draft: %s %s", ev.Name, ev.Data)
	}
	var d struct {
		AICallID string `json:"ai_call_id"`
		Result   struct {
			Options []PositioningOption `json:"options"`
		} `json:"result"`
	}
	if err := json.Unmarshal(ev.Data, &d); err != nil {
		t.Fatal(err)
	}
	return d.Result.Options, d.AICallID
}

// E2E-17（第一部分）：起号向导只给草稿，点"启用方案"才落库；方案有版本且可恢复；同步档案需显式勾选。
func TestE2E17PositioningWizard(t *testing.T) {
	a, acc := v4Account(t, "起号测试")

	env.expectErr(t, "POST", acc+"/strategy/options", map[string]any{"domain": "互联网运营"}, "validation_failed")

	opts, callID := positioningOptions(t, acc)
	if len(opts) < 2 || len(opts) > 3 {
		t.Fatalf("want 2–3 options, got %d", len(opts))
	}
	for i, o := range opts {
		sum := 0
		for _, p := range o.Pillars {
			sum += p.Ratio
		}
		if len(o.Pillars) < 3 || len(o.Pillars) > 5 || sum != 100 {
			t.Fatalf("option %d pillars invalid: %+v", i, o.Pillars)
		}
		if !citesExperience(o.Differentiation, "在电商公司做了五年用户增长，带过三人小团队") {
			t.Fatalf("option %d differentiation must cite the questionnaire: %s", i, o.Differentiation)
		}
	}

	var view strategyView
	env.mustJSON(t, "GET", acc+"/strategy", nil, &view)
	if view.Active != nil || len(view.Versions) != 0 {
		t.Fatal("drafting a strategy must not write anything")
	}

	bad := opts[0].StrategyFields
	bad.Pillars = append([]Pillar{}, bad.Pillars...)
	bad.Pillars[0].Ratio += 10
	env.expectErr(t, "POST", acc+"/strategy", bad, "validation_failed")

	var prof Profile
	env.mustJSON(t, "GET", acc+"/profile", nil, &prof)
	first := opts[0].StrategyFields
	first.BlockedWords = []string{"暴富"}
	var res struct {
		Strategy Strategy `json:"strategy"`
		Synced   []string `json:"synced"`
	}
	env.mustJSON(t, "POST", acc+"/strategy", map[string]any{
		"niche": first.Niche, "audience": first.Audience, "differentiation": first.Differentiation, "persona": first.Persona,
		"pillars": first.Pillars, "cadence": first.Cadence, "keywords": first.Keywords, "blocked_words": first.BlockedWords,
		"ai_call_id": callID, "choice_index": 0}, &res)
	if res.Strategy.Version != 1 || res.Strategy.Status != "active" || len(res.Synced) != 0 {
		t.Fatalf("activate: %+v", res)
	}
	var unchanged Profile
	env.mustJSON(t, "GET", acc+"/profile", nil, &unchanged)
	if unchanged.TargetAudience != prof.TargetAudience || unchanged.PersonaTone != prof.PersonaTone {
		t.Fatal("profile fields sync only when the user ticks them")
	}

	second := opts[1].StrategyFields
	second.BlockedWords = []string{"暴富"}
	env.mustJSON(t, "POST", acc+"/strategy", map[string]any{
		"niche": second.Niche, "audience": second.Audience, "persona": second.Persona, "pillars": second.Pillars,
		"cadence": second.Cadence, "blocked_words": second.BlockedWords, "sync_profile": []string{"audience", "blocked_words", "unknown"}}, &res)
	if res.Strategy.Version != 2 || fmt.Sprint(res.Synced) != "[audience blocked_words]" {
		t.Fatalf("second version: %+v", res)
	}
	env.mustJSON(t, "GET", acc+"/profile", nil, &prof)
	if prof.TargetAudience != second.Audience || !contains(prof.BannedWords, "暴富") || prof.PersonaTone == second.Persona {
		t.Fatalf("profile sync: %+v", prof)
	}

	env.mustJSON(t, "GET", acc+"/strategy", nil, &view)
	if view.Active == nil || view.Active.Version != 2 || len(view.Versions) != 2 || view.Versions[1].Status != "archived" {
		t.Fatalf("versions: %+v", view)
	}
	env.expectErr(t, "POST", acc+"/strategy/versions/2/restore", nil, "state_invalid")
	env.mustJSON(t, "POST", acc+"/strategy/versions/1/restore", nil, &res)
	if res.Strategy.Version != 3 || res.Strategy.Niche != first.Niche {
		t.Fatalf("restore: %+v", res.Strategy)
	}
	_ = a
}

// DEV-V404：方案调整只返回逐条建议；字段名或取值不合法的建议被丢弃；接受部分建议后另存为新版本。
func TestStrategyRevise(t *testing.T) {
	_, acc := v4Account(t, "调整方案测试")
	env.expectErr(t, "POST", acc+"/strategy/revise", nil, "state_invalid")

	opts, _ := positioningOptions(t, acc)
	var res struct {
		Strategy Strategy `json:"strategy"`
	}
	env.mustJSON(t, "POST", acc+"/strategy", opts[0].StrategyFields, &res)

	var rev struct {
		Changes  []StrategyChange `json:"changes"`
		Current  Strategy         `json:"current"`
		AICallID string           `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", acc+"/strategy/revise", map[string]string{"note": "想多写沟通"}, &rev)
	fields := map[string]StrategyChange{}
	for _, c := range rev.Changes {
		fields[c.Field] = c
	}
	if len(rev.Changes) != 2 || fields["keywords"].Field == "" || fields["stage"].Field == "" {
		t.Fatalf("changes: %+v", rev.Changes)
	}
	if string(fields["stage"].From) != `"cold_start"` {
		t.Fatalf("from must come from the current version: %s", fields["stage"].From)
	}
	var view strategyView
	env.mustJSON(t, "GET", acc+"/strategy", nil, &view)
	if len(view.Versions) != 1 {
		t.Fatal("revise must not write a version by itself")
	}

	next := rev.Current.StrategyFields
	if err := applyStrategyChange(&next, "keywords", fields["keywords"].To); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "POST", acc+"/strategy", map[string]any{
		"niche": next.Niche, "audience": next.Audience, "differentiation": next.Differentiation, "persona": next.Persona,
		"pillars": next.Pillars, "cadence": next.Cadence, "stage": next.Stage, "keywords": next.Keywords, "ai_call_id": rev.AICallID}, &res)
	if res.Strategy.Version != 2 || res.Strategy.Stage != "cold_start" || !contains(res.Strategy.Keywords, "沟通") {
		t.Fatalf("accepted only keywords: %+v", res.Strategy)
	}
}

func TestAssignPillars(t *testing.T) {
	ps := []Pillar{{Name: "A", Ratio: 60}, {Name: "B", Ratio: 20}, {Name: "C", Ratio: 20}}
	got := assignPillars(ps, 20)
	count := map[string]int{}
	for i, p := range got {
		count[p]++
		if i >= 2 && got[i-1] == p && got[i-2] == p {
			t.Fatalf("pillar %s three times in a row: %v", p, got)
		}
	}
	if count["A"] < 11 || count["A"] > 13 || count["B"] < 3 || count["C"] < 3 {
		t.Fatalf("distribution off: %v", count)
	}
	heavy := assignPillars([]Pillar{{Name: "A", Ratio: 90}, {Name: "B", Ratio: 5}, {Name: "C", Ratio: 5}}, 12)
	for i := 2; i < len(heavy); i++ {
		if heavy[i] == heavy[i-1] && heavy[i] == heavy[i-2] {
			t.Fatalf("heavy pillar three in a row: %v", heavy)
		}
	}
}

// E2E-17（第二部分）：启用方案后按节奏生成 4 周槽位；生成大纲只写建议不建选题；逐槽采用后选题池与日历出现计划。
func TestE2E17OutlinePlan(t *testing.T) {
	a, acc := v4Account(t, "大纲测试")
	var plan struct {
		HasStrategy bool        `json:"has_strategy"`
		Today       string      `json:"today"`
		Slots       []*PlanSlot `json:"slots"`
	}
	env.mustJSON(t, "GET", acc+"/plan", nil, &plan)
	if plan.HasStrategy || len(plan.Slots) != 0 {
		t.Fatalf("no strategy, no slots: %+v", plan)
	}
	env.expectErr(t, "POST", acc+"/plan/suggest", nil, "state_invalid")

	opts, _ := positioningOptions(t, acc)
	f := opts[0].StrategyFields
	f.Cadence = Cadence{Days: []int{1, 2, 3, 4, 5, 6, 7}}
	env.mustJSON(t, "POST", acc+"/strategy", f, nil)

	env.mustJSON(t, "GET", acc+"/plan", nil, &plan)
	if !plan.HasStrategy || len(plan.Slots) < 21 || len(plan.Slots) > 28 {
		t.Fatalf("daily cadence should give one slot per remaining day: %d", len(plan.Slots))
	}
	for _, sl := range plan.Slots {
		if sl.Date < plan.Today || sl.Status != "empty" || sl.Pillar == "" || sl.Format != "image_note" {
			t.Fatalf("slot: %+v", sl)
		}
	}
	var topicsBefore []Topic
	env.mustJSON(t, "GET", acc+"/topics", nil, &topicsBefore)

	var sug struct {
		Updated int `json:"updated"`
	}
	env.mustJSON(t, "POST", acc+"/plan/suggest", nil, &sug)
	if sug.Updated != len(plan.Slots) {
		t.Fatalf("suggest filled %d of %d", sug.Updated, len(plan.Slots))
	}
	var topicsAfter []Topic
	env.mustJSON(t, "GET", acc+"/topics", nil, &topicsAfter)
	if len(topicsAfter) != len(topicsBefore) {
		t.Fatal("generating the outline must not create topics (H-01)")
	}

	env.mustJSON(t, "GET", acc+"/plan", nil, &plan)
	first, second, third := plan.Slots[0], plan.Slots[1], plan.Slots[2]
	if first.Status != "suggested" || first.Suggestion == nil || first.Suggestion.Title == "" {
		t.Fatalf("suggested slot: %+v", first)
	}

	var adopted struct {
		Slot    PlanSlot  `json:"slot"`
		TopicID uuid.UUID `json:"topic_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+first.ID.String()+"/adopt", nil, &adopted)
	if adopted.Slot.Status != "adopted" || adopted.Slot.TopicTitle == nil || *adopted.Slot.TopicTitle != first.Suggestion.Title {
		t.Fatalf("adopt: %+v", adopted.Slot)
	}
	env.expectErr(t, "POST", "/api/v1/plan-slots/"+first.ID.String()+"/adopt", nil, "state_invalid")
	env.mustJSON(t, "GET", acc+"/topics", nil, &topicsAfter)
	if len(topicsAfter) != len(topicsBefore)+1 {
		t.Fatal("adopting one slot creates exactly one topic")
	}
	tp := topicsAfter[0]
	if tp.Source != "plan" || tp.PlannedDate == nil || *tp.PlannedDate != first.Date || tp.StrategyPillar == nil || *tp.StrategyPillar != first.Pillar {
		t.Fatalf("topic from slot: %+v", tp)
	}
	var cal struct {
		Items []CalendarItem `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/calendar?account_id="+a.ID.String()+"&from="+first.Date+"&to="+first.Date, nil, &cal)
	if len(cal.Items) != 1 || cal.Items[0].Kind != "topic" {
		t.Fatalf("calendar shows the planned topic: %+v", cal.Items)
	}

	var regen struct {
		Slot PlanSlot `json:"slot"`
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+second.ID.String()+"/regenerate", nil, &regen)
	if regen.Slot.Suggestion == nil || regen.Slot.Suggestion.Title == second.Suggestion.Title {
		t.Fatalf("regenerate should give a different title: %+v", regen.Slot.Suggestion)
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+third.ID.String()+"/clear", nil, &regen)
	if regen.Slot.Status != "empty" || regen.Slot.Suggestion != nil {
		t.Fatalf("clear: %+v", regen.Slot)
	}
	env.expectErr(t, "POST", "/api/v1/plan-slots/"+first.ID.String()+"/clear", nil, "state_invalid")
	env.expectErr(t, "POST", "/api/v1/plan-slots/"+third.ID.String()+"/adopt", nil, "validation_failed")

	env.mustJSON(t, "DELETE", "/api/v1/topics/"+adopted.TopicID.String(), nil, nil)
	env.mustJSON(t, "GET", acc+"/plan", nil, &plan)
	if plan.Slots[0].Status != "suggested" || plan.Slots[0].TopicID != nil {
		t.Fatalf("deleting the topic frees the slot: %+v", plan.Slots[0])
	}

	f.Cadence = Cadence{Days: []int{3}}
	env.mustJSON(t, "POST", acc+"/strategy", f, nil)
	env.mustJSON(t, "GET", acc+"/plan", nil, &plan)
	for _, sl := range plan.Slots {
		d, _ := time.Parse("2006-01-02", sl.Date)
		if isoWeekday(d) != 3 {
			t.Fatalf("new cadence must rebuild unadopted slots: %+v", sl)
		}
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
