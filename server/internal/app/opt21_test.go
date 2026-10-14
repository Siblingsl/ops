package app

import (
	"context"
	"testing"
)

func TestOPT21PasteImportCreatesPublishedWorkAndOrderedSections(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "OPT21 旧文导入", "content_format": "long_article",
	}, &account)

	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works/import", map[string]any{
		"confirm_published": true,
		"title":             "从粘贴内容导入的旧文",
		"published_date":    "2024-06-15",
		"sections": []map[string]string{
			{"heading": "先说明问题", "content_md": "这是第一段旧文正文。"},
			{"heading": "再给方法", "content_md": "这是第二段旧文正文。"},
		},
	}, &work)

	if work.Status != "published" || !work.Locked {
		t.Fatalf("imported work status/locked = %q/%v, want published/true", work.Status, work.Locked)
	}
	if work.Title != "从粘贴内容导入的旧文" || work.PublishedURL != nil {
		t.Fatalf("imported title/url = %q/%v", work.Title, work.PublishedURL)
	}
	if work.PublishedAt == nil || work.PublishedAt.In(env.srv.loc).Format("2006-01-02") != "2024-06-15" {
		t.Fatalf("published date = %v, want 2024-06-15 in Shanghai time", work.PublishedAt)
	}
	if len(work.Sections) != 2 {
		t.Fatalf("imported sections = %d, want 2", len(work.Sections))
	}
	for i, want := range []struct{ heading, body string }{
		{"先说明问题", "这是第一段旧文正文。"},
		{"再给方法", "这是第二段旧文正文。"},
	} {
		got := work.Sections[i]
		if got.Position != i+1 || got.Heading != want.heading || got.ContentMD != want.body || got.Origin != "human" {
			t.Fatalf("section %d = %+v, want heading=%q body=%q origin=human", i, got, want.heading, want.body)
		}
	}

	var pushes, metrics int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM push_record WHERE work_id=$1`, work.ID).Scan(&pushes); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, work.ID).Scan(&metrics); err != nil {
		t.Fatal(err)
	}
	if pushes != 0 || metrics != 0 {
		t.Fatalf("import created push/metric rows = %d/%d, want 0/0", pushes, metrics)
	}

	var target Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "OPT21 派生目标", "content_format": "image_note",
	}, &target)
	if err := deriveAllowed(&account, &target, work.ContentFormat); err != nil {
		t.Fatalf("imported long article should remain eligible for XHS derivation: %v", err)
	}
}

func TestOPT21ImportRequiresConfirmationAndAllowsMissingDate(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "OPT21 确认门槛", "content_format": "long_article",
	}, &account)

	payload := map[string]any{
		"title":    "没有发布日期的旧文",
		"sections": []map[string]string{{"heading": "正文", "content_md": "保留原文内容。"}},
	}
	env.expectErr(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works/import", payload, "human_step_required")

	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work WHERE account_id=$1`, account.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("work count without confirmation = %d, want 0", count)
	}

	payload["confirm_published"] = true
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works/import", payload, &work)
	if work.Status != "published" || !work.Locked || work.PublishedAt != nil {
		t.Fatalf("imported work status/locked/date = %q/%v/%v, want published/true/no date", work.Status, work.Locked, work.PublishedAt)
	}
}
