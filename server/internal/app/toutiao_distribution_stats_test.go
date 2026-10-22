package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestToutiaoDistributionStatsAndTagHistoryStayWithinWorkShape(t *testing.T) {
	a := drAccount(t, "toutiao", "分发统计形态隔离")
	ctx := context.Background()
	path := "/api/v1/accounts/" + a.ID.String()
	for i, format := range []string{"long_article", "micro_post"} {
		work := ttMetricWork(t, a, format, format+"已发布", env.srv.today().AddDate(0, 0, -8))
		var topicID uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO topic(account_id,title,format) VALUES($1,$2,$2) RETURNING id`, a.ID, format).Scan(&topicID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `UPDATE work SET topic_id=$2,topics=$3 WHERE id=$1`, work.ID, topicID, []string{"共同话题", format}); err != nil {
			t.Fatal(err)
		}
		var recID uuid.UUID
		items, _ := json.Marshal([]map[string]any{{"title": format, "format": format, "basis": []map[string]string{{"type": "topic"}}}})
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO daily_recommendation(account_id,date,version,items,trigger) VALUES($1,current_date,$2,$3,'manual') RETURNING id`, a.ID, i+1, items).Scan(&recID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO daily_recommendation_action(recommendation_id,item_index,action,topic_id,work_id) VALUES($1,0,'started',$2,$3)`, recID, topicID, work.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,reads,likes,day_offset) VALUES($1,$2,$3,$4,7)`, work.ID, env.srv.now(), 100+i*800, 10+i*80); err != nil {
			t.Fatal(err)
		}
	}
	for i, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			var stats DailyStats
			env.mustJSON(t, "GET", path+"/daily/stats?content_format="+format, nil, &stats)
			want := float64(100 + i*800)
			if stats.Total != 2 || stats.Adopted != 2 || len(stats.Performance) != 1 || stats.Performance[0].Works != 1 || stats.Performance[0].AvgReads == nil || *stats.Performance[0].AvgReads != want {
				t.Fatalf("分形态表现与账号总量错误：%+v", stats)
			}
			if len(stats.Sources) != 1 || stats.Sources[0].Published != 1 || stats.Sources[0].AvgReads == nil || *stats.Sources[0].AvgReads != want {
				t.Fatalf("来源表现混合了形态：%+v", stats.Sources)
			}
			var target Work
			env.mustJSON(t, "POST", path+"/works", map[string]string{"title": "待写话题", "content_format": format}, &target)
			env.llm.ResetRequests()
			var tags struct {
				History []struct{ Text, Reason string } `json:"history"`
			}
			env.mustJSON(t, "POST", "/api/v1/works/"+target.ID.String()+"/tag-suggest", nil, &tags)
			if len(tags.History) != 2 {
				t.Fatalf("话题历史应只取同形态：%+v", tags.History)
			}
			for _, tag := range tags.History {
				if !strings.Contains(tag.Reason, fmt.Sprintf("平均阅读 %.0f", want)) {
					t.Fatalf("话题平均阅读串用其他形态：%+v", tag)
				}
			}
			requests := strings.Join(env.llm.Requests(), "\n")
			if !strings.Contains(requests, "今日头条话题标签") || strings.Contains(requests, "小红书话题标签") {
				t.Fatalf("话题请求平台错误：%s", requests)
			}
		})
	}
	var defaultStats DailyStats
	env.mustJSON(t, "GET", path+"/daily/stats", nil, &defaultStats)
	if defaultStats.ContentFormat != "long_article" || len(defaultStats.Performance) != 1 || defaultStats.Performance[0].AvgReads == nil || *defaultStats.Performance[0].AvgReads != 100 {
		t.Fatalf("省略形态应按账号默认形态统计：%+v", defaultStats)
	}
	env.expectErr(t, "GET", path+"/daily/stats?content_format=comic", nil, "validation_failed")
}
