package app

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"testing"
)

func TestV421DailyConstraints(t *testing.T) {
	a, _ := v4Account(t, "每日推荐约束")
	for _, items := range []string{`{}`, `[]`} {
		if _, e := env.srv.db.Exec(context.Background(), `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date,$2,'manual')`, a.ID, items); e == nil {
			t.Fatalf("invalid daily items %s", items)
		}
	}
	if _, e := env.srv.db.Exec(context.Background(), `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date,'[{}]','manual')`, a.ID); e != nil {
		t.Fatal(e)
	}
	if _, e := env.srv.db.Exec(context.Background(), `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date,'[{}]','manual')`, a.ID); e == nil {
		t.Fatal("duplicate account/date/version")
	}
}

func TestE2E19DailyRecommend(t *testing.T) {
	a, path := v4Account(t, "每日推荐")
	opts, call := positioningOptions(t, path)
	fields := opts[0].StrategyFields
	env.mustJSON(t, "POST", path+"/strategy", map[string]any{"niche": fields.Niche, "audience": fields.Audience, "differentiation": fields.Differentiation, "persona": fields.Persona, "pillars": fields.Pillars, "cadence": fields.Cadence, "stage": "cold_start", "keywords": fields.Keywords, "daily_settings": map[string]any{"generate": "off"}, "ai_call_id": call}, nil)
	ctx := context.Background()
	var before int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM topic WHERE account_id=$1`, a.ID).Scan(&before)
	var d Daily
	env.mustJSON(t, "POST", path+"/daily/regenerate", nil, &d)
	if len(d.Items) < 3 {
		t.Fatalf("daily %+v", d)
	}
	for _, x := range d.Items {
		if len(x.Basis) == 0 || x.Basis[0].URL == "" {
			t.Fatal("missing linked basis")
		}
	}
	var after int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM topic WHERE account_id=$1`, a.ID).Scan(&after)
	if before != after {
		t.Fatal("generation inserted topics")
	}
	var adopted struct {
		TopicID uuid.UUID `json:"topic_id"`
	}
	env.mustJSON(t, "POST", fmt.Sprintf("/api/v1/daily/%s/items/0/adopt", d.ID), map[string]any{"planned_today": true}, &adopted)
	var source, audience string
	_ = env.srv.db.QueryRow(ctx, `SELECT source,audience FROM topic WHERE id=$1`, adopted.TopicID).Scan(&source, &audience)
	if source != "daily" || audience == "" {
		t.Fatal("incomplete adopted topic")
	}
	var started struct {
		WorkID uuid.UUID `json:"work_id"`
	}
	env.mustJSON(t, "POST", fmt.Sprintf("/api/v1/daily/%s/items/0/start", d.ID), nil, &started)
	var viewpoint string
	_ = env.srv.db.QueryRow(ctx, `SELECT viewpoint FROM work WHERE id=$1`, started.WorkID).Scan(&viewpoint)
	if viewpoint != "" {
		t.Fatal("H-02 viewpoint prefilled")
	}
	env.expectErr(t, "POST", fmt.Sprintf("/api/v1/daily/%s/items/0/start", d.ID), nil, "state_invalid")
	env.mustJSON(t, "POST", fmt.Sprintf("/api/v1/daily/%s/items/1/replace", d.ID), nil, nil)
	env.mustJSON(t, "POST", fmt.Sprintf("/api/v1/daily/%s/items/1/dismiss", d.ID), nil, nil)
	for i := 0; i < 2; i++ {
		env.mustJSON(t, "POST", path+"/daily/regenerate", nil, nil)
	}
	env.expectErr(t, "POST", path+"/daily/regenerate", nil, "state_invalid")
}

func TestV422StageWeights(t *testing.T) {
	if dailyWeight("cold_start", "pillar") <= dailyWeight("cold_start", "hot") {
		t.Fatal("cold-start must establish pillars")
	}
	if dailyWeight("growth", "hot") <= dailyWeight("growth", "pillar") {
		t.Fatal("growth must favor relevant timely topics")
	}
	if dailyWeight("cold_start", "slot") != 100 || dailyWeight("stable", "slot") != 100 {
		t.Fatal("adopted slots must remain priority")
	}
}
