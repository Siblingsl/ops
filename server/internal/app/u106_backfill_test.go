package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-U106（12 文档）：粘贴批量回填——表格文本解析（Tab/竖线/表头别名）、精确与模糊标题
// 匹配、"10万+/千分位"数字解析；确认写入全部数据列；无效行明确报错，不静默跳过。
func TestU106MetricsPasteImport(t *testing.T) {
	_ = env.accounts(t)
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "回填验收号", "content_format": "long_article"}, &a)
	var w1, w2 Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "谈谈内容运营的三个习惯"}, &w1)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "写给新手的第一份避坑清单"}, &w2)

	text := "标题\t阅读\t点赞\t在看\t收藏\t评论\t分享\t涨粉\n" +
		"谈谈内容运营的三个习惯\t1,234\t56\t7\t8\t9\t10\t2\n" +
		"写给新手的避坑清单\t10万+\t1,024\t0\t99\t12\t3\t1\n" +
		"完全不存在的标题\t100\t1\t0\t0\t0\t0\t0"
	var out struct {
		Preview []struct {
			Title         string     `json:"title"`
			WorkID        *uuid.UUID `json:"work_id"`
			Matched       bool       `json:"matched"`
			MatchType     string     `json:"match_type"`
			Similarity    float64    `json:"similarity"`
			Estimated     bool       `json:"estimated"`
			Reads         *int       `json:"reads"`
			Likes         *int       `json:"likes"`
			Wows          *int       `json:"wows"`
			Favorites     *int       `json:"favorites"`
			Comments      *int       `json:"comments"`
			Shares        *int       `json:"shares"`
			FollowsGained *int       `json:"follows_gained"`
			Error         string     `json:"error"`
		} `json:"preview"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]string{"text": text}, &out)
	if len(out.Preview) != 3 {
		t.Fatalf("preview rows: %+v", out.Preview)
	}
	r1, r2, r3 := out.Preview[0], out.Preview[1], out.Preview[2]
	if r1.MatchType != "exact" || r1.WorkID == nil || *r1.WorkID != w1.ID {
		t.Fatalf("row1: %+v", r1)
	}
	if r1.Reads == nil || *r1.Reads != 1234 || *r1.Likes != 56 || *r1.Wows != 7 || *r1.Favorites != 8 || *r1.Comments != 9 || *r1.Shares != 10 || *r1.FollowsGained != 2 {
		t.Fatalf("row1 numbers: %+v", r1)
	}
	if r2.MatchType != "fuzzy" || r2.WorkID == nil || *r2.WorkID != w2.ID || r2.Similarity < 0.3 {
		t.Fatalf("row2 fuzzy: %+v", r2)
	}
	if r2.Reads == nil || *r2.Reads != 100000 || !r2.Estimated {
		t.Fatalf("row2 10万+: %+v", r2)
	}
	if r3.MatchType != "none" || r3.WorkID != nil || r3.Matched {
		t.Fatalf("row3 none: %+v", r3)
	}

	// 确认写入：两行全字段落库。
	confirm := map[string]any{"rows": []map[string]any{
		{"title": r1.Title, "work_id": w1.ID.String(), "reads": 1234, "likes": 56, "wows": 7, "favorites": 8, "comments": 9, "shares": 10, "follows_gained": 2},
		{"title": r2.Title, "work_id": w2.ID.String(), "reads": 100000, "likes": 1024, "favorites": 99},
	}}
	var imp struct {
		Imported int `json:"imported"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", confirm, &imp)
	if imp.Imported != 2 {
		t.Fatalf("imported %d", imp.Imported)
	}
	var reads, likes, wows, shares int
	if e := env.srv.db.QueryRow(context.Background(), `SELECT reads, likes, wows, shares FROM metric_snapshot WHERE work_id=$1 ORDER BY captured_at DESC LIMIT 1`, w1.ID).Scan(&reads, &likes, &wows, &shares); e != nil {
		t.Fatal(e)
	}
	if reads != 1234 || likes != 56 || wows != 7 || shares != 10 {
		t.Fatalf("w1 snapshot: %d %d %d %d", reads, likes, wows, shares)
	}

	// 确认里带无效作品：报行号，不静默跳过。
	bad := map[string]any{"rows": []map[string]any{
		{"title": "A", "work_id": uuid.NewString(), "reads": 1},
		{"title": "B", "work_id": uuid.NewString(), "reads": 2},
	}}
	ae := env.expectErr(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", bad, "validation_failed")
	if !strings.Contains(ae.Error.Message, "第 1 行") {
		t.Fatalf("row number in error: %s", ae.Error.Message)
	}
}

func TestU106MetricsImportDuplicateTitleRequiresDisambiguation(t *testing.T) {
	_ = env.accounts(t)
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "同名回填验收号", "content_format": "long_article"}, &a)
	var first, second Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "同名作品需要按时间区分"}, &first)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "同名作品需要按时间区分"}, &second)
	firstPublishedAt := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	secondPublishedAt := firstPublishedAt.Add(48 * time.Hour)
	for _, work := range []struct {
		id uuid.UUID
		at time.Time
	}{{first.ID, firstPublishedAt}, {second.ID, secondPublishedAt}} {
		if _, err := env.srv.db.Exec(t.Context(), `UPDATE work SET published_at=$2 WHERE id=$1`, work.id, work.at); err != nil {
			t.Fatal(err)
		}
	}

	type matchRow struct {
		WorkID  *uuid.UUID `json:"work_id"`
		Matched bool       `json:"matched"`
	}
	var noDate struct {
		Preview []matchRow `json:"preview"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]string{
		"text": "标题\t阅读\n同名作品需要按时间区分\t123",
	}, &noDate)
	if len(noDate.Preview) != 1 || noDate.Preview[0].WorkID != nil || noDate.Preview[0].Matched {
		t.Fatalf("同名作品无发布时间应保持未匹配：%+v", noDate.Preview)
	}

	var dated struct {
		Preview []matchRow `json:"preview"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", map[string]string{
		"text": "标题\t发布时间\t阅读\n同名作品需要按时间区分\t" + firstPublishedAt.Format(time.RFC3339) + "\t123",
	}, &dated)
	if len(dated.Preview) != 1 || dated.Preview[0].WorkID == nil || *dated.Preview[0].WorkID != first.ID || !dated.Preview[0].Matched {
		t.Fatalf("发布时间应唯一匹配对应作品：%+v", dated.Preview)
	}

	bad := map[string]any{"rows": []map[string]any{{"title": "同名作品需要按时间区分", "reads": 123}}}
	if ae := env.expectErr(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/metrics/import", bad, "validation_failed"); !strings.Contains(ae.Error.Message, "第 1 行") {
		t.Fatalf("无作品 ID 时应拒绝有歧义的写入：%s", ae.Error.Message)
	}
	for _, workID := range []uuid.UUID{first.ID, second.ID} {
		var count int
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, workID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("歧义导入写入了作品 %s 的数据：count=%d err=%v", workID, count, err)
		}
	}
}
