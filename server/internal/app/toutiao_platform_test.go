package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"ops/internal/secure"
)

func TestToutiaoAccountSupportsArticleAndMicroPostWithoutCredentials(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			var account Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
				"platform": "toutiao", "name": "头条账号-" + format, "content_format": format,
			}, &account)
			if account.Platform != "toutiao" || account.ContentFormat != format {
				t.Fatalf("account platform/format = %s/%s, want toutiao/%s", account.Platform, account.ContentFormat, format)
			}
			if account.Credential != nil {
				t.Fatalf("toutiao account unexpectedly exposes WeChat credential: %+v", account.Credential)
			}
		})
	}
	for _, format := range []string{"image_note", "comic", "micro_post_v2"} {
		t.Run("reject_"+format, func(t *testing.T) {
			env.expectErr(t, "POST", "/api/v1/accounts", map[string]string{
				"platform": "toutiao", "name": "非法头条账号", "content_format": format,
			}, "validation_failed")
		})
	}
}

func TestToutiaoDerivationMatrixIsExplicitAndRequiresSelectedTargetShape(t *testing.T) {
	cases := []struct {
		name   string
		source Account
		format string
		target Account
		want   bool
	}{
		{"wechat_article_to_tt_article", Account{Platform: "wechat_mp"}, "long_article", Account{Platform: "toutiao"}, true},
		{"wechat_article_to_tt_micro", Account{Platform: "wechat_mp"}, "long_article", Account{Platform: "toutiao"}, true},
		{"xhs_note_to_tt_article", Account{Platform: "xhs"}, "image_note", Account{Platform: "toutiao"}, true},
		{"xhs_note_to_tt_micro", Account{Platform: "xhs"}, "image_note", Account{Platform: "toutiao"}, true},
		{"tt_article_to_wechat", Account{Platform: "toutiao"}, "long_article", Account{Platform: "wechat_mp", ContentFormat: "long_article"}, true},
		{"tt_article_to_xhs", Account{Platform: "toutiao"}, "long_article", Account{Platform: "xhs", ContentFormat: "image_note"}, true},
		{"tt_micro_to_xhs_rejected", Account{Platform: "toutiao"}, "micro_post", Account{Platform: "xhs", ContentFormat: "image_note"}, false},
		{"tt_same_platform_rejected", Account{Platform: "toutiao"}, "long_article", Account{Platform: "toutiao"}, false},
		{"unsupported_source_rejected", Account{Platform: "wechat_mp"}, "qa_article", Account{Platform: "toutiao"}, false},
		{"unknown_platform_rejected", Account{Platform: "unregistered_platform"}, "long_article", Account{Platform: "toutiao"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			format := tc.target.ContentFormat
			if tc.target.Platform == "toutiao" {
				format = "long_article"
			}
			err := deriveAllowedForFormat(&tc.source, &tc.target, tc.format, format)
			if (err == nil) != tc.want {
				t.Fatalf("deriveAllowedForFormat(%s/%s -> %s/%s) error=%v, want allowed=%t", tc.source.Platform, tc.format, tc.target.Platform, format, err, tc.want)
			}
			if tc.target.Platform == "toutiao" && tc.want {
				if err := deriveAllowedForFormat(&tc.source, &tc.target, tc.format, "micro_post"); err != nil {
					t.Fatalf("documented Toutiao micro-post target rejected: %v", err)
				}
			}
		})
	}

	var source Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "派生入口来源", "content_format": "long_article"}, &source)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+source.ID.String()+"/works", map[string]string{"title": "长文来源"}, &work)
	var target Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "toutiao", "name": "派生入口目标", "content_format": "long_article"}, &target)
	env.llm.ResetRequests()
	env.expectErr(t, "POST", "/api/v1/works/"+work.ID.String()+"/derive", map[string]string{"target_account_id": target.ID.String()}, "validation_failed")
	if len(env.llm.Requests()) != 0 {
		t.Fatalf("missing target shape reached the model: %v", env.llm.Requests())
	}
}

func TestToutiaoImpressionsRemainSeparateNullableMetricAndReviseAtomically(t *testing.T) {
	account := drAccount(t, "toutiao", "头条展现指标")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	work := drWork(t, account, "展现量与阅读量分开", "published", &publishedAt)
	path := "/api/v1/works/" + work.ID.String() + "/metrics"
	capturedAt := publishedAt.AddDate(0, 0, 1)
	var metric Metric
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": capturedAt, "reads": 500, "impressions": int64(1000)}, &metric)
	if metric.Reads == nil || *metric.Reads != 500 || metric.Impressions == nil || *metric.Impressions != 1000 || metric.CTR == nil || *metric.CTR != 0.5 {
		t.Fatalf("Toutiao metric fields/CTR = %+v", metric)
	}
	var merged Metric
	env.mustJSON(t, "POST", path, map[string]any{"captured_at": capturedAt, "likes": 4}, &merged)
	if merged.Impressions == nil || *merged.Impressions != 1000 || merged.Revision != metric.Revision+1 {
		t.Fatalf("missing impressions should preserve the existing value while a new likes value revises the row: %+v", merged)
	}
	env.mustJSON(t, "PATCH", "/api/v1/metrics/"+metric.ID.String(), map[string]any{
		"base_revision": merged.Revision, "reads": 900, "impressions": int64(3000),
	}, &merged)
	if merged.Revision != metric.Revision+2 || merged.CTR == nil || *merged.CTR != 0.3 {
		t.Fatalf("impressions edit should revise one snapshot and recalculate CTR: %+v", merged)
	}
	env.expectErr(t, "PATCH", "/api/v1/metrics/"+metric.ID.String(), map[string]any{
		"base_revision": merged.Revision, "reads": 900, "impressions": -1,
	}, "validation_failed")

	legacy := drAccount(t, "wechat_mp", "旧平台不接受展现指标")
	legacyWork := drWork(t, legacy, "公众号指标", "published", &publishedAt)
	env.expectErr(t, "POST", "/api/v1/works/"+legacyWork.ID.String()+"/metrics", map[string]any{"reads": 100, "impressions": 1000}, "validation_failed")
	if got, estimated, err := parseCount64("9.2亿+"); err != nil || got != 920000000 || !estimated {
		t.Fatalf("64-bit impression parser = %d estimated=%t err=%v", got, estimated, err)
	}
	if got, _, err := parseCount64("9007199254740993"); err != nil || got != 9007199254740993 {
		t.Fatalf("64-bit parser lost precision: %d err=%v", got, err)
	}
	if _, _, err := parseCount64("1.01"); err == nil {
		t.Fatal("fractional impression count should be rejected")
	}
}

func TestToutiaoTitlelessPasteAndCSVUseSafeManualMatching(t *testing.T) {
	account := drAccount(t, "toutiao", "头条指标导入")
	publishedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, env.srv.loc)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{
		"title": "微头条内部名称", "content_format": "micro_post",
	}, &work)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='published',published_at=$2 WHERE id=$1`, work.ID, publishedAt); err != nil {
		t.Fatal(err)
	}

	rows := env.srv.parseMetricText(context.Background(), account.ID, account.Platform, "展现量\t阅读\n9007199254740993\t500")
	if len(rows) != 1 || rows[0].Title != "" || rows[0].WorkID != nil || rows[0].ImpressionsExact == nil || *rows[0].ImpressionsExact != "9007199254740993" {
		t.Fatalf("titleless paste preview must preserve exact count and wait for manual matching: %+v", rows)
	}
	dup := drWork(t, account, "重复内部名称", "published", &publishedAt)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET title='微头条内部名称',content_format='micro_post' WHERE id=$1`, dup.ID); err != nil {
		t.Fatal(err)
	}
	ambiguous := env.srv.parseMetricText(context.Background(), account.ID, account.Platform, "标题\t展现量\t阅读\n微头条内部名称\t1000\t500")
	if len(ambiguous) != 1 || ambiguous[0].WorkID != nil || ambiguous[0].MatchType != "none" {
		t.Fatalf("duplicate Toutiao titles must remain unmatched: %+v", ambiguous)
	}

	capturedAt := publishedAt.AddDate(0, 0, 1)
	var csv bytes.Buffer
	mw := multipart.NewWriter(&csv)
	part, err := mw.CreateFormFile("file", "metrics.csv")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(part, "work_id,content_format,published_at,captured_at,impressions,reads\n"+
		work.ID.String()+",micro_post,"+publishedAt.Format(time.RFC3339)+","+capturedAt.Format(time.RFC3339)+",1000,500\n")
	_ = mw.Close()
	resp := env.request("POST", "/api/v1/accounts/"+account.ID.String()+"/metrics/import", &csv, mw.FormDataContentType())
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("CSV preview status=%d body=%s", resp.StatusCode, body)
	}
	var preview struct {
		Preview []metricPreviewRow `json:"preview"`
	}
	if err := json.Unmarshal(body, &preview); err != nil {
		t.Fatal(err)
	}
	if len(preview.Preview) != 1 || preview.Preview[0].WorkID == nil || *preview.Preview[0].WorkID != work.ID || preview.Preview[0].ImpressionsExact == nil || *preview.Preview[0].ImpressionsExact != "1000" {
		t.Fatalf("CSV metadata preview did not preserve id/format/date/count: %+v", preview.Preview)
	}
	var wrongFormatCSV bytes.Buffer
	wrongMW := multipart.NewWriter(&wrongFormatCSV)
	wrongPart, err := wrongMW.CreateFormFile("file", "wrong-format.csv")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(wrongPart, "work_id,content_format,impressions\n"+work.ID.String()+",long_article,1000\n")
	_ = wrongMW.Close()
	wrongResp := env.request("POST", "/api/v1/accounts/"+account.ID.String()+"/metrics/import", &wrongFormatCSV, wrongMW.FormDataContentType())
	defer wrongResp.Body.Close()
	wrongBody, _ := io.ReadAll(wrongResp.Body)
	if wrongResp.StatusCode != 200 {
		t.Fatalf("wrong-shape CSV preview status=%d body=%s", wrongResp.StatusCode, wrongBody)
	}
	var wrongPreview struct {
		Preview []metricPreviewRow `json:"preview"`
	}
	if err := json.Unmarshal(wrongBody, &wrongPreview); err != nil {
		t.Fatal(err)
	}
	if len(wrongPreview.Preview) != 1 || wrongPreview.Preview[0].WorkID != nil || wrongPreview.Preview[0].MatchType != "none" {
		t.Fatalf("CSV shape conflict must require manual matching: %+v", wrongPreview.Preview)
	}
	var imported struct {
		Imported int `json:"imported"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/metrics/import", map[string]any{"source": "file", "rows": []map[string]any{{
		"work_id": work.ID.String(), "content_format": "micro_post", "published_at": publishedAt.Format(time.RFC3339),
		"captured_at": capturedAt.Format(time.RFC3339), "impressions": 1000, "reads": 500,
	}}}, &imported)
	if imported.Imported != 1 {
		t.Fatalf("imported=%d", imported.Imported)
	}
	var stored int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT impressions FROM metric_snapshot WHERE work_id=$1`, work.ID).Scan(&stored); err != nil || stored != 1000 {
		t.Fatalf("stored impressions=%d err=%v", stored, err)
	}
	env.expectErr(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/metrics/import", map[string]any{"rows": []map[string]any{{
		"work_id": work.ID.String(), "content_format": "long_article", "impressions": 2000,
	}}}, "validation_failed")
}

func TestToutiaoBoardReviewAndPreferencesStaySeparatedByFormat(t *testing.T) {
	ctx := context.Background()
	account := drAccount(t, "toutiao", "头条混合形态复盘")
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, env.srv.loc)
	formats := []string{"long_article", "micro_post"}
	for _, format := range formats {
		for i := 0; i < 10; i++ {
			title := fmt.Sprintf("稳定写作习惯%s", []string{"甲", "乙", "丙", "丁", "戊"}[i%5])
			reads := 100
			if i < 5 {
				title = fmt.Sprintf("2026个高效写作习惯%d", i)
				reads = 1000
			}
			var workID uuid.UUID
			publishedAt := base.Add(time.Duration(len(format)*100+i) * time.Hour)
			if err := env.srv.db.QueryRow(ctx, `INSERT INTO work(account_id,content_format,title,status,published_at)
				VALUES($1,$2,$3,'published',$4) RETURNING id`, account.ID, format, title, publishedAt).Scan(&workID); err != nil {
				t.Fatal(err)
			}
			if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,likes)
				VALUES($1,$2,'manual',7,$3,1)`, workID, publishedAt.AddDate(0, 0, 7), reads); err != nil {
				t.Fatal(err)
			}
		}
	}
	var articleRows []BoardRow
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/board?content_format=long_article", nil, &articleRows)
	var microRows []BoardRow
	env.mustJSON(t, "GET", "/api/v1/accounts/"+account.ID.String()+"/board?content_format=micro_post", nil, &microRows)
	if len(articleRows) != 10 || len(microRows) != 10 {
		t.Fatalf("board must split 10 articles and 10 micro-posts, got article=%d micro=%d", len(articleRows), len(microRows))
	}
	for _, row := range articleRows {
		if row.ContentFormat != "long_article" {
			t.Fatalf("article board contains %s", row.ContentFormat)
		}
	}

	samples, err := env.srv.perfSamples(ctx, account.ID)
	if err != nil {
		t.Fatal(err)
	}
	revision := prefInputRevision(t, account.ID)
	if applied, err := env.srv.persistToutiaoDataPreferences(ctx, account.ID, revision, samples, false); err != nil || !applied {
		t.Fatalf("persist split preferences applied=%v err=%v", applied, err)
	}
	for _, format := range formats {
		prefs, err := env.srv.loadDataPreferences(ctx, account.ID, format)
		if err != nil || len(prefs) == 0 {
			t.Fatalf("load %s preferences: count=%d err=%v", format, len(prefs), err)
		}
		for _, pref := range prefs {
			if !strings.HasPrefix(pref.Feature, format+":") {
				t.Fatalf("preference %q crossed its format namespace %q", pref.Feature, format)
			}
		}
	}
	var articleBasis, microBasis string
	if err := env.srv.db.QueryRow(ctx, `SELECT basis_meta->>'content_format' FROM account_data_preference
		WHERE account_id=$1 AND feature LIKE 'long_article:%' LIMIT 1`, account.ID).Scan(&articleBasis); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT basis_meta->>'content_format' FROM account_data_preference
		WHERE account_id=$1 AND feature LIKE 'micro_post:%' LIMIT 1`, account.ID).Scan(&microBasis); err != nil {
		t.Fatal(err)
	}
	if articleBasis != "long_article" || microBasis != "micro_post" {
		t.Fatalf("basis formats article=%q micro=%q", articleBasis, microBasis)
	}
}

func TestToutiaoDefaultFormatChangeOnlyAffectsNewWorks(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "双形态账号", "content_format": "long_article",
	}, &account)
	accountPath := "/api/v1/accounts/" + account.ID.String()

	var first Work
	env.mustJSON(t, "POST", accountPath+"/works", map[string]string{"title": "旧默认文章"}, &first)
	if first.ContentFormat != "long_article" {
		t.Fatalf("first work format = %s, want long_article", first.ContentFormat)
	}
	env.expectErr(t, "PATCH", accountPath, map[string]string{"content_format": "micro_post"}, "confirm_required")
	var changed struct {
		Account Account `json:"account"`
	}
	env.mustJSON(t, "PATCH", accountPath, map[string]any{"content_format": "micro_post", "confirm_type_change": true}, &changed)
	if changed.Account.ContentFormat != "micro_post" {
		t.Fatalf("new account default = %s, want micro_post", changed.Account.ContentFormat)
	}

	var old Work
	env.mustJSON(t, "GET", "/api/v1/works/"+first.ID.String(), nil, &old)
	if old.ContentFormat != "long_article" {
		t.Fatalf("existing work format changed with account default: %s", old.ContentFormat)
	}
	var second Work
	env.mustJSON(t, "POST", accountPath+"/works", map[string]string{"title": "新默认微头条"}, &second)
	if second.ContentFormat != "micro_post" {
		t.Fatalf("new work format = %s, want micro_post", second.ContentFormat)
	}
}

func TestToutiaoMicroPostRulesDoNotRequireImagesOrArticleTitle(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "无图微头条检查", "content_format": "micro_post",
	}, &account)
	work := &Work{
		ID: uuid.New(), AccountID: account.ID, Platform: "toutiao", ContentFormat: "micro_post",
		Title: "只用于系统识别的内部名称", Sections: []Section{{ContentMD: "正文观点与理由。"}},
		Assets: []Asset{}, Panels: []ComicPanel{},
	}
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: workspaceID})
	items, err := env.srv.buildRuleItems(ctx, work, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var title, images bool
	for _, item := range items {
		if item.Category != "format" {
			continue
		}
		switch item.Location["field"] {
		case "title":
			title = item.Passed
			if !strings.Contains(item.Message, "内部名称") {
				t.Errorf("micro-post title check should identify the internal name: %s", item.Message)
			}
		case "images":
			images = item.Passed
			if !strings.Contains(item.Message, "可选") {
				t.Errorf("micro-post image check should say images are optional: %s", item.Message)
			}
		}
	}
	if !title || !images {
		t.Fatalf("micro-post checks should pass with an internal name and no images: title=%v images=%v", title, images)
	}
}

func TestToutiaoCreationFormatsAndSourceWins(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "逐篇选择形态", "content_format": "long_article",
	}, &account)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{
		"title": "手动创建微头条", "content_format": "micro_post",
	}, &work)
	if work.ContentFormat != "micro_post" {
		t.Fatalf("manual work format = %s, want micro_post", work.ContentFormat)
	}

	var created struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]string{
		"title": "来源指定微头条", "format": "micro_post",
	}, &created)
	path := "/api/v1/topics/" + created.Topic.ID.String() + "/works"
	env.expectErr(t, "POST", path, map[string]string{"content_format": "long_article"}, "validation_failed")
	env.mustJSON(t, "POST", path, map[string]string{"content_format": "micro_post"}, &work)
	if work.ContentFormat != "micro_post" {
		t.Fatalf("topic-derived work format = %s, want micro_post", work.ContentFormat)
	}
}

func TestToutiaoDailyAndPlanSourceFormatsSurviveDefault(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "来源形态不随默认变化", "content_format": "long_article",
	}, &account)
	items, err := json.Marshal([]DailyItem{{
		topicSuggestion: topicSuggestion{Title: "推荐的微头条", Angle: "一个观点", NeededMaterials: []string{}, Format: "micro_post"},
		Basis:           []DailyBasis{}, Primary: true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	var recommendationID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO daily_recommendation(account_id,date,items,trigger)
		VALUES($1,$2::date,$3,'manual') RETURNING id`, account.ID, env.srv.today().Format("2006-01-02"), items).Scan(&recommendationID); err != nil {
		t.Fatal(err)
	}
	dailyPath := "/api/v1/daily/" + recommendationID.String() + "/items/0/start"
	env.expectErr(t, "POST", dailyPath, map[string]string{"content_format": "long_article"}, "validation_failed")
	var started struct {
		WorkID *uuid.UUID `json:"work_id"`
	}
	env.mustJSON(t, "POST", dailyPath, map[string]string{"content_format": "micro_post"}, &started)
	if started.WorkID == nil {
		t.Fatal("daily start did not return a work id")
	}
	var dailyWork Work
	env.mustJSON(t, "GET", "/api/v1/works/"+started.WorkID.String(), nil, &dailyWork)
	if dailyWork.ContentFormat != "micro_post" {
		t.Fatalf("daily work format = %s, want micro_post", dailyWork.ContentFormat)
	}

	suggestion, err := json.Marshal(SlotSuggestion{Title: "计划微头条", Angle: "一个观察"})
	if err != nil {
		t.Fatal(err)
	}
	var slotID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO account_plan_slot(account_id,date,pillar,format,status,suggestion)
		VALUES($1,$2::date,'观察','micro_post','suggested',$3) RETURNING id`, account.ID, env.srv.today().AddDate(0, 0, 1).Format("2006-01-02"), suggestion).Scan(&slotID); err != nil {
		t.Fatal(err)
	}
	planPath := "/api/v1/plan-slots/" + slotID.String() + "/adopt"
	env.expectErr(t, "POST", planPath, map[string]string{"content_format": "long_article"}, "validation_failed")
	var adopted struct {
		TopicID uuid.UUID `json:"topic_id"`
	}
	env.mustJSON(t, "POST", planPath, map[string]string{"content_format": "micro_post"}, &adopted)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+adopted.TopicID.String()+"/works", nil, &work)
	if work.ContentFormat != "micro_post" {
		t.Fatalf("plan work format = %s, want micro_post", work.ContentFormat)
	}
}

func TestToutiaoTopicSuggestionUsesRequestedFormat(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "微头条选题生成", "content_format": "long_article",
	}, &account)
	env.llm.ResetRequests()
	var response struct {
		Suggestions []topicSuggestion `json:"suggestions"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics/suggest", map[string]string{
		"direction": "职场效率", "content_format": "micro_post",
	}, &response)
	if len(response.Suggestions) < 5 {
		t.Fatalf("got %d suggestions, want at least 5", len(response.Suggestions))
	}
	for i, suggestion := range response.Suggestions {
		if suggestion.Format != "micro_post" {
			t.Fatalf("suggestion %d format = %q, want micro_post", i, suggestion.Format)
		}
	}
	requests := strings.Join(env.llm.Requests(), "\n")
	if !strings.Contains(requests, "本次作品形态：微头条") || !strings.Contains(requests, "平台：今日头条；账号类型：微头条") {
		t.Fatalf("model request did not carry the requested Toutiao shape: %s", requests)
	}
}

func TestToutiaoPackRequiresBasisAndKeepsMicroTitleInternal(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "微头条发布包", "content_format": "micro_post",
	}, &account)
	work := env.readyWork(t, account, "先把真实观察讲清楚，再补充理由。")
	internalName := "系统内名称不得进入发布正文"
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{
		"title": internalName, "base_revision": work.Revision,
	}, nil)
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
	env.expectErr(t, "POST", path, map[string]any{}, "validation_failed")
	var view toutiaoPackView
	env.mustJSON(t, "POST", path, map[string]any{"basis_revision": work.Revision}, &view)
	if view.Platform != "toutiao" || view.ContentFormat != "micro_post" || view.InternalTitle != internalName || view.PublishTitle != nil {
		t.Fatalf("unexpected micro-post pack identity: %+v", view)
	}
	if strings.Contains(view.BodyText, internalName) {
		t.Fatalf("internal name leaked into publish body: %q", view.BodyText)
	}
	var fetched toutiaoPackView
	env.mustJSON(t, "GET", path+"?basis_revision="+strconv.Itoa(work.Revision), nil, &fetched)
	if fetched.BasisRevision != work.Revision || fetched.BodyText != view.BodyText {
		t.Fatalf("GET pack view differs from prepared revision: %+v", fetched)
	}
	resp := env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("download Toutiao micro-post pack => %d: %s", resp.StatusCode, body)
	}
	files := readToutiaoZip(t, resp.Body)
	if _, ok := files["title.txt"]; ok {
		t.Fatal("micro-post pack must not contain a publish title file")
	}
	if strings.Contains(string(files["body.txt"]), internalName) {
		t.Fatalf("micro-post internal title leaked into release files: body=%q manifest=%s", files["body.txt"], files["manifest.json"])
	}
	var manifest toutiaoPackManifest
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil || manifest.PublishTitle != nil || manifest.InternalTitle != internalName {
		t.Fatalf("micro-post manifest unexpectedly has a publish title: %+v, err=%v", manifest, err)
	}
	if _, ok := files["发布说明.txt"]; !ok {
		t.Fatal("micro-post pack is missing manual publishing instructions")
	}
}

func TestToutiaoArticlePackContainsReferencedOfflineImageAndSafeText(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "toutiao", "name": "文章离线包", "content_format": "long_article",
	}, &account)
	work := env.readyWork(t, account, "先明确目标，再安排一小步。")
	if len(work.Assets) == 0 || len(work.Sections) == 0 {
		t.Fatalf("ready work missing section or test image: sections=%d assets=%d", len(work.Sections), len(work.Assets))
	}
	imageURL := "/api/v1/assets/" + work.Assets[0].ID.String() + "/file"
	content := "保留 hello_world。\n\n- 列表项\n\n![正文图](" + imageURL + ")\n\n![同图重复引用](" + imageURL + ")\n\n<script>alert(1)</script>\n\n|列|值|\n|---|---|\n|A|B|\n\n[危险](javascript:alert(1))"
	section := work.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{
		"content_md": content, "base_revision": section.Revision,
	}, nil)
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	path := "/api/v1/works/" + work.ID.String() + "/toutiao/pack"
	var view toutiaoPackView
	env.mustJSON(t, "POST", path, map[string]int{"basis_revision": work.Revision}, &view)
	if view.PublishTitle == nil || view.ContentFormat != "long_article" {
		t.Fatalf("article pack identity = %+v", view)
	}
	for _, fragment := range []string{"hello_world", "列表项", "A / B"} {
		if !strings.Contains(view.BodyText, fragment) {
			t.Fatalf("converted article body missing %q: %s", fragment, view.BodyText)
		}
	}
	for _, fragment := range []string{"![", "/api/v1/assets/", "<script>", "javascript:"} {
		if strings.Contains(view.BodyText, fragment) {
			t.Fatalf("converted article body contains private/unsafe syntax %q: %s", fragment, view.BodyText)
		}
	}
	if len(view.Images) != 1 || len(view.Images[0].Uses) != 2 || view.Images[0].File != "images/01.jpg" {
		t.Fatalf("image dedupe or position mapping failed: %+v", view.Images)
	}
	if len(view.Warnings) == 0 || !strings.Contains(strings.Join(view.Warnings, " "), "代码块或表格") {
		t.Fatalf("expected explicit table/code conversion warning: %v", view.Warnings)
	}
	resp := env.request("GET", path+".zip?basis_revision="+strconv.Itoa(work.Revision), nil, "")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("download Toutiao article pack => %d: %s", resp.StatusCode, body)
	}
	files := readToutiaoZip(t, resp.Body)
	for _, name := range []string{"title.txt", "body.txt", "article.html", "topics.txt", "image-map.json", "manifest.json", "发布说明.txt", "images/01.jpg"} {
		if _, ok := files[name]; !ok {
			t.Fatalf("article pack is missing %s; got %v", name, sortedToutiaoFiles(files))
		}
	}
	if strings.Contains(string(files["article.html"]), "<script>") || strings.Contains(string(files["article.html"]), "javascript:") {
		t.Fatalf("unsafe markup survived article preview: %s", files["article.html"])
	}
	var manifest toutiaoPackManifest
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Platform != "toutiao" || manifest.ContentFormat != "long_article" || manifest.BasisRevision != work.Revision || len(manifest.Files) != len(files)-1 {
		t.Fatalf("manifest does not describe this revision and all non-manifest files: %+v", manifest)
	}
	if strings.Contains(string(files["manifest.json"]), "/api/v1/assets/") {
		t.Fatalf("offline manifest contains private application image URLs: %s", files["manifest.json"])
	}
	for _, entry := range manifest.Files {
		content, ok := files[entry.Name]
		if !ok || len(content) != entry.Size || secure.SHA256Hex(content) != entry.SHA {
			t.Fatalf("manifest checksum does not match %s", entry.Name)
		}
	}
	if _, ok := files["images/02.jpg"]; ok {
		t.Fatal("repeated references to one asset must not duplicate the image file")
	}
}

func readToutiaoZip(t *testing.T, source io.Reader) map[string][]byte {
	t.Helper()
	data, err := io.ReadAll(source)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range reader.File {
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, readErr := io.ReadAll(rc)
		closeErr := rc.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		files[file.Name] = content
	}
	return files
}

func sortedToutiaoFiles(files map[string][]byte) []string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
