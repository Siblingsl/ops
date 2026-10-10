package app

import (
	"encoding/json"
	"fmt"
	"testing"
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
	ev := lastEvent(t, env.sse(t, acc+"/strategy/draft", map[string]any{
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

	env.expectErr(t, "POST", acc+"/strategy/draft", map[string]any{"domain": "互联网运营"}, "validation_failed")

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

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
