package app

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"testing"
	"time"
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

func TestV424OnOpenIdempotence(t *testing.T) {
	a, path := v4Account(t, "打开准备推荐")
	opts, _ := positioningOptions(t, path)
	f := opts[0].StrategyFields
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	var first struct {
		JobID     *uuid.UUID `json:"job_id"`
		Preparing bool       `json:"preparing"`
	}
	env.mustJSON(t, "GET", path+"/daily", nil, &first)
	if first.JobID == nil {
		t.Fatal("first open did not create job")
	}
	for i := 0; i < 4; i++ {
		var again struct {
			JobID *uuid.UUID `json:"job_id"`
		}
		env.mustJSON(t, "GET", path+"/daily", nil, &again)
		if again.JobID == nil || *again.JobID != *first.JobID {
			t.Fatal("repeated open created another job")
		}
	}
	for i := 0; i < 100; i++ {
		var status string
		e := env.srv.db.QueryRow(context.Background(), `SELECT status FROM ai_job WHERE id=$1`, first.JobID).Scan(&status)
		if e != nil {
			t.Fatal(e)
		}
		if status == "done" {
			break
		}
		if status == "failed" {
			t.Fatal("preparation failed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	var n int
	e := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM daily_recommendation WHERE account_id=$1`, a.ID).Scan(&n)
	if e != nil || n != 1 {
		t.Fatalf("daily count %d %v", n, e)
	}
	var before int
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='daily_recommend'`, a.ID).Scan(&before)
	env.mustJSON(t, "GET", path+"/hot", nil, nil)
	_ = env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE account_id=$1 AND task_type='daily_recommend'`, a.ID).Scan(&n)
	if n != before {
		t.Fatal("hot open repeated recommendation")
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

func TestV424BackgroundActivityAndBudget(t *testing.T) {
	ctx := context.Background()
	s := env.srv
	a, path := v4Account(t, "后台推荐")
	opts, _ := positioningOptions(t, path)
	f := opts[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "background", "hour": 0}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	env.mustJSON(t, "GET", path+"/daily", nil, nil)
	_, e := s.db.Exec(ctx, `UPDATE account_ops_activity SET last_opened_at=$2 WHERE account_id=$1`, a.ID, s.now().AddDate(0, 0, -8))
	if e != nil {
		t.Fatal(e)
	}
	s.dailyBackground(ctx)
	var n int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM ai_job WHERE account_id=$1 AND task_type='ops_daily'`, a.ID).Scan(&n)
	if n != 0 {
		t.Fatal("inactive account generated")
	}
	_, _ = s.db.Exec(ctx, `UPDATE account_ops_activity SET last_opened_at=$2 WHERE account_id=$1`, a.ID, s.now())
	s.dailyBackground(ctx)
	var status string
	for i := 0; i < 100; i++ {
		_ = s.db.QueryRow(ctx, `SELECT status FROM ai_job WHERE account_id=$1 AND task_type='ops_daily'`, a.ID).Scan(&status)
		if status == "done" || status == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "done" {
		t.Fatalf("background status %s", status)
	}
	var ws uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws)
	var original []byte
	_ = s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='ai_limit'`, ws).Scan(&original)
	t.Cleanup(func() {
		if len(original) > 0 {
			_, _ = s.db.Exec(ctx, `UPDATE app_setting SET value=$2 WHERE workspace_id=$1 AND key='ai_limit'`, ws, original)
		} else {
			_, _ = s.db.Exec(ctx, `DELETE FROM app_setting WHERE workspace_id=$1 AND key='ai_limit'`, ws)
		}
	})
	b, bpath := v4Account(t, "用量限制推荐")
	f.DailySettings = map[string]any{"generate": "on_open"}
	env.mustJSON(t, "POST", bpath+"/strategy", f, nil)
	_, _ = s.db.Exec(ctx, `INSERT INTO app_setting(workspace_id,key,value) VALUES($1,'ai_limit','{"enabled":true,"daily_tokens":0}') ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value`, ws)
	env.mustJSON(t, "GET", bpath+"/daily", nil, nil)
	for i := 0; i < 100; i++ {
		_ = s.db.QueryRow(ctx, `SELECT status FROM ai_job WHERE account_id=$1 AND task_type='ops_daily'`, b.ID).Scan(&status)
		if status == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if status != "failed" {
		t.Fatal("budget did not stop preparation")
	}
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM daily_recommendation WHERE account_id=$1`, b.ID).Scan(&n)
	if n != 0 {
		t.Fatal("quota exceeded recommendation written")
	}
}
