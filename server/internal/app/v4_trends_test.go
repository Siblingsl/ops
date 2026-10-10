package app

import (
	"context"
	"github.com/google/uuid"
	"testing"
)

func TestV432TrendHistoryAndWriting(t *testing.T) {
	enableTestCrawl(t)
	ctx := context.Background()
	s := env.srv
	_, _ = s.db.Exec(ctx, `UPDATE crawl_source SET enabled=true WHERE key='baidu'`)
	src, e := scanCrawlSource(s.db.QueryRow(ctx, `SELECT `+crawlSourceCols+` FROM crawl_source WHERE key='baidu'`))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.collectSource(ctx, src); e != nil {
		t.Fatal(e)
	}
	env.mustJSON(t, "PUT", "/api/v1/hot-sources", map[string]any{"sources": []string{"baidu"}}, nil)
	a, path := v4Account(t, "热点趋势")
	opts, _ := positioningOptions(t, path)
	f := opts[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	env.mustJSON(t, "POST", path+"/hot/refresh", nil, nil)
	b, _ := v4Account(t, "另一个账号在写")
	var hot, topic uuid.UUID
	e = s.db.QueryRow(ctx, `SELECT hot_item_id FROM account_hot_match WHERE account_id=$1 ORDER BY relevance DESC LIMIT 1`, a.ID).Scan(&hot)
	if e != nil {
		t.Fatal(e)
	}
	e = s.db.QueryRow(ctx, `INSERT INTO topic(account_id,title,source,hot_item_id) VALUES($1,'其他账号角度','hot',$2) RETURNING id`, b.ID, hot).Scan(&topic)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.db.Exec(ctx, `INSERT INTO work(account_id,topic_id,title,content_format) VALUES($1,$2,'进行中的不同角度','image_note')`, b.ID, topic)
	if e != nil {
		t.Fatal(e)
	}
	var before, after int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call`).Scan(&before)
	var trends []HotTrend
	env.mustJSON(t, "GET", path+"/hot/trends", nil, &trends)
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call`).Scan(&after)
	if before != after {
		t.Fatal("rule trend called model")
	}
	found := false
	for _, x := range trends {
		if len(x.Points) == 0 || len(x.Sources) == 0 {
			t.Fatal("missing history or source rank")
		}
		for _, w := range x.Writing {
			if w.Account == b.Name {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("other account writing missing")
	}
}
