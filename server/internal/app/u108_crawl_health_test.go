package app

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestU108SourceHealth(t *testing.T) {
	a, _ := v4Account(t, "来源健康度")
	ctx := context.Background()
	db := env.srv.db
	key := "u108-" + uuid.NewString()
	empty := key + "-empty"
	for _, k := range []string{key, empty} {
		if _, err := db.Exec(ctx, `INSERT INTO crawl_source(key,kind,name) VALUES($1,'rss',$1)`, k); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _, _ = db.Exec(ctx, `DELETE FROM crawl_source WHERE key=ANY($1)`, []string{key, empty}) })
	now := env.srv.now()
	for _, run := range []struct {
		days, status, items int
		failure             string
	}{{1, 200, 5, ""}, {2, 500, 0, "failed"}, {10, 200, 3, ""}, {31, 200, 99, ""}} {
		at := now.AddDate(0, 0, -run.days)
		if _, err := db.Exec(ctx, `INSERT INTO crawl_run(source_key,started_at,finished_at,http_status,items,error) VALUES($1,$2,$2,$3,$4,$5)`, key, at, run.status, run.items, run.failure); err != nil {
			t.Fatal(err)
		}
	}
	var hot uuid.UUID
	if err := db.QueryRow(ctx, `INSERT INTO hot_item(source_key,title,title_norm,url) VALUES($1,'健康度样例','健康度样例','https://example.com/u108') RETURNING id`, key).Scan(&hot); err != nil {
		t.Fatal(err)
	}
	for _, age := range []int{1, 10} {
		if _, err := db.Exec(ctx, `INSERT INTO account_hot_match(account_id,date,hot_item_id,relevance,status,created_at) VALUES($1,$2::timestamptz::date,$3,80,'converted',$2::timestamptz)`, a.ID, now.AddDate(0, 0, -age), hot); err != nil {
			t.Fatal(err)
		}
	}
	var rec uuid.UUID
	items := fmt.Sprintf(`[{"basis":[{"type":"hot","id":"%s"},{"type":"hot","id":"%s"}]},{"basis":[{"type":"hot","id":"%s"}]}]`, hot, hot, hot)
	if err := db.QueryRow(ctx, `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,current_date,$2,'manual') RETURNING id`, a.ID, items).Scan(&rec); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"adopted", "started"} {
		if _, err := db.Exec(ctx, `INSERT INTO daily_recommendation_action(recommendation_id,item_index,action,created_at) VALUES($1,0,$2,$3)`, rec, action, now.Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	other := env.registerClient(t, "u108-tenant-"+uuid.NewString()[:8], testPassword)
	other.expectErr(t, "GET", "/api/v1/admin/crawl/health", nil, "forbidden")
	other.restore(env)
	loginCrawlAdmin(t)
	var before, after int
	_ = db.QueryRow(ctx, `SELECT count(*) FROM crawl_run`).Scan(&before)
	var out struct {
		Sources []sourceHealthRow `json:"sources"`
	}
	env.mustJSON(t, "GET", "/api/v1/admin/crawl/health", nil, &out)
	_ = db.QueryRow(ctx, `SELECT count(*) FROM crawl_run`).Scan(&after)
	if before != after {
		t.Fatal("健康度查询发起采集")
	}
	found, foundEmpty := false, false
	for _, row := range out.Sources {
		if row.Key == key {
			found = true
			if row.Days7.Runs != 2 || row.Days7.SuccessRate == nil || *row.Days7.SuccessRate != .5 || row.Days7.Items != 5 || row.Days7.Matches != 1 || row.Days7.Converted != 1 || row.Days7.Adopted != 1 {
				t.Fatalf("7 天统计错误: %+v", row.Days7)
			}
			if row.Days30.Runs != 3 || row.Days30.Successful != 2 || row.Days30.Items != 8 || row.Days30.Matches != 2 || row.Days30.Converted != 2 || row.Days30.Adopted != 1 {
				t.Fatalf("30 天统计错误: %+v", row.Days30)
			}
		}
		if row.Key == empty {
			foundEmpty = true
			if row.Days7.Runs != 0 || row.Days30.SuccessRate != nil {
				t.Fatal("空来源显示虚假成功率")
			}
		}
	}
	if !found || !foundEmpty {
		t.Fatal("缺少来源行")
	}
}
