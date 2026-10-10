package app

import (
	"context"
	"strconv"
	"testing"
)

// D-048：方案的作品形态必须等于账号类型（空值补齐，不一致明确拒绝）；
// 大纲槽位与采用后的选题按账号类型；遗留不一致版本恢复被拒且提示明确。
func TestD048StrategyTypeConstraint(t *testing.T) {
	a, path := v4Account(t, "方案类型约束")
	opts, call := positioningOptions(t, path)

	// 与账号类型不一致的方案不能保存或启用（comic 对 xhs 合法，但不是这个账号的类型）。
	bad := opts[0].StrategyFields
	bad.Cadence.Format = "comic"
	env.expectErr(t, "POST", path+"/strategy", bad, "validation_failed")

	// 空形态补齐为账号类型并启用。
	ok := opts[0].StrategyFields
	ok.Cadence.Format = ""
	env.mustJSON(t, "POST", path+"/strategy", map[string]any{"niche": ok.Niche, "audience": ok.Audience,
		"differentiation": ok.Differentiation, "persona": ok.Persona, "pillars": ok.Pillars, "cadence": ok.Cadence,
		"stage": "cold_start", "keywords": ok.Keywords, "daily_settings": ok.DailySettings, "ai_call_id": call}, nil)
	var view strategyView
	env.mustJSON(t, "GET", path+"/strategy", nil, &view)
	if view.Active == nil || view.Active.Cadence.Format != "image_note" {
		t.Fatalf("active cadence: %+v", view.Active)
	}

	// 大纲槽位按账号类型生成，采用后的选题形态 = 账号类型。
	env.mustJSON(t, "POST", path+"/plan/suggest", nil, nil)
	var plan struct {
		Slots []PlanSlot `json:"slots"`
	}
	env.mustJSON(t, "GET", path+"/plan", nil, &plan)
	if len(plan.Slots) == 0 {
		t.Fatal("no slots")
	}
	for _, s := range plan.Slots {
		if s.Format != "image_note" {
			t.Fatalf("slot format: %s", s.Format)
		}
	}
	var adopted struct {
		TopicID string `json:"topic_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+plan.Slots[0].ID.String()+"/adopt", map[string]string{"title": "槽位采用测试"}, &adopted)
	var tf string
	if e := env.srv.db.QueryRow(context.Background(), `SELECT coalesce(format,'') FROM topic WHERE id=$1`, adopted.TopicID).Scan(&tf); e != nil || tf != "image_note" {
		t.Fatalf("adopted topic format: %s %v", tf, e)
	}

	// 遗留不一致版本（SQL 模拟升级前数据）：恢复被明确拒绝。
	// 先启用第二个版本，把第一版归档后再篡改其 cadence。
	env.mustJSON(t, "POST", path+"/strategy", map[string]any{"niche": ok.Niche + "（调整）", "audience": ok.Audience,
		"differentiation": ok.Differentiation, "persona": ok.Persona, "pillars": ok.Pillars, "cadence": ok.Cadence,
		"stage": "cold_start", "keywords": ok.Keywords, "daily_settings": ok.DailySettings}, nil)
	if _, e := env.srv.db.Exec(context.Background(),
		`UPDATE account_strategy SET cadence=jsonb_set(cadence,'{format}','"comic"') WHERE account_id=$1 AND version=$2`, a.ID, view.Active.Version); e != nil {
		t.Fatal(e)
	}
	ae := env.expectErr(t, "POST", path+"/strategy/versions/"+strconv.Itoa(view.Active.Version)+"/restore", nil, "validation_failed")
	if ae.Error.Message == "" {
		t.Fatal("empty restore error")
	}
}
