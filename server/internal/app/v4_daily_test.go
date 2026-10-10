package app

import (
	"context"
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
