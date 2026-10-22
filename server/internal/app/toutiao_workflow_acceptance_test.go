package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestToutiaoAccountRolesIsolationAndDisableRestore(t *testing.T) {
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "toutiao", "name": "权限与恢复验收", "content_format": "long_article"}, &account)
	path := "/api/v1/accounts/" + account.ID.String()
	var works []Work
	for _, format := range []string{"long_article", "micro_post"} {
		var work Work
		env.mustJSON(t, "POST", path+"/works", map[string]string{"title": "形态保留", "content_format": format}, &work)
		works = append(works, work)
	}
	for _, role := range []string{"editor", "viewer"} {
		var invite struct {
			Code string `json:"code"`
		}
		env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": role, "max_uses": 1, "days": 1}, &invite)
		guest := env.registerClient(t, "tt-"+role+"-"+uuid.NewString()[:8], testPassword)
		guest.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": invite.Code, "switch": true}, nil)
		var me struct {
			CSRF string `json:"csrf_token"`
		}
		guest.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
		guest.csrf = me.CSRF
		guest.expectErr(t, "POST", "/api/v1/accounts", map[string]string{"platform": "toutiao", "name": "不应创建"}, "forbidden")
		guest.expectErr(t, "PATCH", path, map[string]string{"name": "不应管理"}, "forbidden")
		guest.expectErr(t, "POST", path+"/disable", nil, "forbidden")
		for _, work := range works {
			guest.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, nil)
			if role == "viewer" {
				guest.expectErr(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]string{"title": "不能写入"}, "forbidden")
			}
		}
		guest.restore(env)
	}
	other := env.registerClient(t, "tt-other-"+uuid.NewString()[:8], testPassword)
	other.expectErr(t, "GET", path, nil, "not_found")
	for _, work := range works {
		other.expectErr(t, "GET", "/api/v1/works/"+work.ID.String(), nil, "not_found")
		other.expectErr(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]string{"title": "越权"}, "not_found")
		other.expectErr(t, "GET", "/api/v1/works/"+work.ID.String()+"/toutiao/pack?basis_revision=1", nil, "not_found")
	}
	other.restore(env)
	env.mustJSON(t, "POST", path+"/disable", nil, nil)
	env.expectErr(t, "POST", path+"/works", map[string]string{"title": "停用不得新建"}, "state_invalid")
	env.mustJSON(t, "POST", path+"/enable", nil, nil)
	for _, work := range works {
		var restored Work
		env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &restored)
		if restored.ContentFormat != work.ContentFormat || restored.AccountID != account.ID {
			t.Fatal("disable/restore changed the work snapshot")
		}
		status, _ := env.do("PATCH", "/api/v1/works/"+work.ID.String(), map[string]string{"content_format": "micro_post"})
		if status < 400 {
			t.Fatal("work type PATCH accepted")
		}
	}
	env.expectErr(t, "PATCH", path, map[string]string{"platform": "xhs"}, "validation_failed")
}

func TestToutiaoCreationFallbackAndExistingSourceSnapshots(t *testing.T) {
	account := drAccount(t, "toutiao", "来源优先完整验收")
	path := "/api/v1/accounts/" + account.ID.String()
	var topic struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", path+"/topics", map[string]string{"title": "旧文章选题", "format": "long_article"}, &topic)
	items, _ := json.Marshal([]DailyItem{{topicSuggestion: topicSuggestion{Title: "旧文章推荐", Format: "long_article", NeededMaterials: []string{}}, Basis: []DailyBasis{}, Primary: true}})
	var dailyID, slotID uuid.UUID
	ctx := context.Background()
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO daily_recommendation(account_id,date,items,trigger) VALUES($1,$2::date,$3,'manual') RETURNING id`, account.ID, env.srv.today().Format("2006-01-02"), items).Scan(&dailyID); err != nil {
		t.Fatal(err)
	}
	suggestion, _ := json.Marshal(SlotSuggestion{Title: "旧文章槽位", Angle: "观察"})
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO account_plan_slot(account_id,date,pillar,format,status,suggestion) VALUES($1,$2::date,'观察','long_article','suggested',$3) RETURNING id`, account.ID, env.srv.today().AddDate(0, 0, 1).Format("2006-01-02"), suggestion).Scan(&slotID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "PATCH", path, map[string]any{"content_format": "micro_post", "confirm_type_change": true}, nil)
	var topicFormat, slotFormat, dailyFormat string
	if err := env.srv.db.QueryRow(ctx, `SELECT format FROM topic WHERE id=$1`, topic.Topic.ID).Scan(&topicFormat); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT format FROM account_plan_slot WHERE id=$1`, slotID).Scan(&slotFormat); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT items->0->>'format' FROM daily_recommendation WHERE id=$1`, dailyID).Scan(&dailyFormat); err != nil {
		t.Fatal(err)
	}
	if topicFormat != "long_article" || slotFormat != topicFormat || dailyFormat != topicFormat {
		t.Fatal("default migration rewrote existing source shapes")
	}
	var work Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+topic.Topic.ID.String()+"/works", nil, &work)
	if work.ContentFormat != "long_article" {
		t.Fatal("topic source lost priority")
	}
	var started struct {
		WorkID uuid.UUID `json:"work_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/daily/"+dailyID.String()+"/items/0/start", nil, &started)
	env.mustJSON(t, "GET", "/api/v1/works/"+started.WorkID.String(), nil, &work)
	if work.ContentFormat != "long_article" {
		t.Fatal("old daily item rejected or changed after default switch")
	}
	var adopted struct {
		TopicID uuid.UUID `json:"topic_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/plan-slots/"+slotID.String()+"/adopt", nil, &adopted)
	env.mustJSON(t, "POST", "/api/v1/topics/"+adopted.TopicID.String()+"/works", nil, &work)
	if work.ContentFormat != "long_article" {
		t.Fatal("old slot changed after default switch")
	}
	for _, requested := range []string{"", "long_article", "micro_post"} {
		env.mustJSON(t, "POST", path+"/works", map[string]string{"content_format": requested}, &work)
		want := requested
		if want == "" {
			want = "micro_post"
		}
		if work.ContentFormat != want {
			t.Fatalf("manual fallback got %s want %s", work.ContentFormat, want)
		}
		var emptyTopicID uuid.UUID
		if err := env.srv.db.QueryRow(ctx, `INSERT INTO topic(account_id,title,format) VALUES($1,'无形态来源','') RETURNING id`, account.ID).Scan(&emptyTopicID); err != nil {
			t.Fatal(err)
		}
		env.mustJSON(t, "POST", "/api/v1/topics/"+emptyTopicID.String()+"/works", map[string]string{"content_format": requested}, &work)
		if work.ContentFormat != want {
			t.Fatalf("empty topic fallback got %s want %s", work.ContentFormat, want)
		}
	}
}

func TestToutiaoGatesPromptAndVersionRestore(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			var account Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "toutiao", "name": "门槛与版本", "content_format": format}, &account)
			var work Work
			env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]any{}, &work)
			path := "/api/v1/works/" + work.ID.String()
			env.expectErr(t, "POST", path+"/outline/generate", nil, "human_step_required")
			env.mustJSON(t, "PATCH", path, map[string]string{"viewpoint": "先整理一个小步骤，再持续执行。"}, nil)
			var out struct {
				Items []OutlineItem `json:"items"`
			}
			env.mustJSON(t, "POST", path+"/outline/generate", nil, &out)
			env.mustJSON(t, "PUT", path+"/outline", map[string]any{"items": out.Items[:2], "confirm": false}, &work)
			if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_section(work_id,position,heading,content_md) VALUES($1,0,'未确认大纲的旧段落','')`, work.ID); err != nil {
				t.Fatal(err)
			}
			env.mustJSON(t, "GET", path, nil, &work)
			env.expectErr(t, "POST", "/api/v1/sections/"+work.Sections[0].ID.String()+"/draft", nil, "human_step_required")
			env.mustJSON(t, "PUT", path+"/outline", map[string]any{"items": out.Items[:2], "confirm": true}, &work)
			env.llm.ResetRequests()
			if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+work.Sections[0].ID.String()+"/draft", nil)); ev.Name != "done" {
				t.Fatalf("draft %s %s", ev.Name, ev.Data)
			}
			requests := strings.Join(env.llm.Requests(), "\n")
			if !strings.Contains(requests, "今日头条") {
				t.Fatal("draft lost platform context")
			}
			for _, oldInstruction := range []string{"小红书笔记正文", "封面裁剪必须", "必须提供公众号摘要"} {
				if strings.Contains(requests, oldInstruction) {
					t.Fatalf("old platform instruction leaked: %s", oldInstruction)
				}
			}
			env.expectErr(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, "version_conflict")
			for _, section := range work.Sections {
				var current Work
				env.mustJSON(t, "GET", path, nil, &current)
				for _, latest := range current.Sections {
					if latest.ID == section.ID {
						env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": "这是一次亲自记录的观察，先完成一个步骤。", "base_revision": latest.Revision}, nil)
					}
				}
			}
			env.mustJSON(t, "PATCH", path, map[string]string{"title": "版本验收内部名称"}, nil)
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", path, nil, &work)
			env.mustJSON(t, "POST", path+"/versions", nil, nil)
			version := latestVersionNo(t, work.ID.String())
			env.mustJSON(t, "PATCH", path, map[string]any{"title": "后续修改", "base_revision": work.Revision}, &work)
			env.mustJSON(t, "POST", fmt.Sprintf("%s/versions/%d/restore", path, version), map[string]int{"base_revision": work.Revision}, &work)
			if work.ContentFormat != format || work.Title != "版本验收内部名称" || work.Status == "ready" || work.Status == "packed" {
				t.Fatalf("restore recovered old approval or changed shape: %+v", work)
			}
			env.expectErr(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, "human_step_required")
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", path, nil, &work)
			planned := env.srv.today().AddDate(0, 0, 1).Format("2006-01-02")
			env.mustJSON(t, "PATCH", path, map[string]any{"planned_date": planned, "base_revision": work.Revision}, &work)
			if work.Status != "ready" {
				t.Fatal("planning date invalidated approval")
			}
			env.mustJSON(t, "PATCH", path, map[string]any{"topics": []string{"观察"}, "base_revision": work.Revision}, &work)
			if work.Status == "ready" {
				t.Fatal("topic edit retained old approval")
			}
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", path, nil, &work)
			if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='reviewing',review_required=true WHERE id=$1`, work.ID); err != nil {
				t.Fatal(err)
			}
			env.expectErr(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, "human_step_required")
		})
	}
}

func TestToutiaoPublishedURLCorrectionAndAtomicMetricRollback(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			work := ttReady(t, format)
			path := "/api/v1/works/" + work.ID.String()
			env.mustJSON(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
			for _, bad := range []map[string]any{{"url": "javascript:alert(1)"}, {"url": "https://user:password@example.test/a"}, {"published_at": env.srv.now().Add(time.Hour)}} {
				env.expectErr(t, "POST", path+"/published", bad, "validation_failed")
			}
			at := env.srv.today().AddDate(0, 0, -2).Add(12 * time.Hour)
			url := "https://example.test/unparsed-toutiao-share?item=opaque"
			env.mustJSON(t, "POST", path+"/published", map[string]any{"url": url, "published_at": at, "confirm_published": true}, &work)
			if work.Status != "published" || !work.Locked || work.PublishedURL == nil || *work.PublishedURL != url {
				t.Fatalf("manual publication failed: %+v", work)
			}
			env.expectErr(t, "PATCH", path, map[string]string{"title": "禁止改已发布稿"}, "state_invalid")
			for _, offset := range []int{1, 9} {
				if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,impressions) VALUES($1,$2,'manual',$3,100,1000)`, work.ID, at.AddDate(0, 0, 1), offset); err != nil {
					t.Fatal(err)
				}
			}
			base := work.PublishRevision
			newAt := at.AddDate(0, 0, 1)
			correction := cl04CorrectionBody(base, &newAt, &url, "纠正采集日期")
			env.expectErr(t, "POST", path+"/published", correction, "publish_metric_node_conflict")
			var unchanged Work
			env.mustJSON(t, "GET", path, nil, &unchanged)
			if !unchanged.PublishedAt.Equal(at) || unchanged.PublishRevision != base || !unchanged.Locked {
				t.Fatal("failed correction changed publication")
			}
			var count, minOffset, maxOffset int
			if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*),min(day_offset),max(day_offset) FROM metric_snapshot WHERE work_id=$1 AND impressions=1000`, work.ID).Scan(&count, &minOffset, &maxOffset); err != nil || count != 2 || minOffset != 1 || maxOffset != 9 {
				t.Fatalf("partial metric write: %d/%d/%d %v", count, minOffset, maxOffset, err)
			}
			url = "https://example.test/corrected"
			env.mustJSON(t, "POST", path+"/published", cl04CorrectionBody(base, nil, &url, "只更正链接"), &work)
			if work.Status != "published" || !work.Locked || *work.PublishedURL != url {
				t.Fatal("link correction downgraded publication")
			}
			env.expectErr(t, "POST", path+"/published", cl04CorrectionBody(base, nil, &url, "旧修订重试"), "publish_revision_conflict")
		})
	}
}

func TestToutiaoDerivationRejectsBeforeModelAndKeepsIndependentSource(t *testing.T) {
	source := ttReady(t, "micro_post")
	target := drAccount(t, "wechat_mp", "反向不允许")
	for _, targetID := range []uuid.UUID{target.ID, source.AccountID} {
		env.llm.ResetRequests()
		env.expectErr(t, "POST", "/api/v1/works/"+source.ID.String()+"/derive", map[string]any{"target_account_id": targetID, "target_content_format": "long_article"}, "validation_failed")
		if len(env.llm.Requests()) != 0 {
			t.Fatal("unsupported derivation called a model")
		}
	}
	source = ttReady(t, "long_article")
	private := ttMaterial(t, &source)
	var derived Work
	env.llm.ResetRequests()
	env.mustJSON(t, "POST", "/api/v1/works/"+source.ID.String()+"/derive", map[string]any{"target_account_id": target.ID}, &derived)
	for _, id := range derived.MaterialIDs {
		if id == private.ID {
			t.Fatal("private source material authorization copied")
		}
	}
	for _, section := range derived.Sections {
		if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+section.ID.String()+"/rewrite", nil)); ev.Name != "done" {
			t.Fatal("rewrite failed")
		}
	}
	if requests := strings.Join(env.llm.Requests(), "\n"); strings.Contains(requests, private.Content) {
		t.Fatal("source-only private material entered the target model context")
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+derived.ID.String(), nil, &derived)
	before := derived.Sections[0].ContentMD
	section := source.Sections[0]
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": "源稿新观察，等待作者自行改写目标。", "base_revision": section.Revision}, nil)
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+derived.ID.String(), nil, &after)
	if !after.SourceUpdated || after.Sections[0].ContentMD != before {
		t.Fatal("source edit overwrote derived content or lost update reminder")
	}
}

func TestToutiaoContentRevisionAndFamilyFirstPublicationWarnings(t *testing.T) {
	work := ttReady(t, "micro_post")
	path := "/api/v1/works/" + work.ID.String()
	for _, change := range []string{"text", "topics", "image", "order"} {
		env.confirmChecks(t, work.ID.String())
		env.mustJSON(t, "GET", path, nil, &work)
		before := work.Revision
		switch change {
		case "text":
			section := work.Sections[0]
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": "新的亲身观察。", "base_revision": section.Revision}, nil)
		case "topics":
			env.mustJSON(t, "PATCH", path, map[string]any{"topics": []string{"新话题"}, "base_revision": work.Revision}, nil)
		case "image":
			env.upload(t, work.ID.String(), testPNG(320, 240))
		case "order":
			env.mustJSON(t, "PATCH", "/api/v1/assets/"+work.Assets[0].ID.String(), map[string]int{"position": 1}, nil)
		}
		env.mustJSON(t, "GET", path, nil, &work)
		if work.Revision <= before || work.Status == "ready" {
			t.Fatalf("%s did not invalidate revision/checks", change)
		}
		env.expectErr(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": before}, "version_conflict")
	}
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", path, nil, &work)
	var pack toutiaoPackView
	env.mustJSON(t, "POST", path+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, &pack)
	if strings.Contains(strings.Join(pack.Warnings, " "), "家族已有") {
		t.Fatal("empty family falsely reported previous publication")
	}
	old := drAccount(t, "wechat_mp", "站外家族来源")
	root := drWork(t, old, "根稿", "drafting", nil)
	mid := drWork(t, old, "中间稿", "drafting", nil)
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET source_work_id=$2 WHERE id=$1`, mid.ID, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET source_work_id=$2 WHERE id=$1`, work.ID, mid.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET status='published',published_at=now() WHERE id=$1`, root.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", path, nil, &work)
	env.mustJSON(t, "GET", path+"/toutiao/pack?basis_revision="+fmt.Sprint(work.Revision), nil, &pack)
	if !strings.Contains(strings.Join(pack.Warnings, " "), "家族已有其他平台发布记录") {
		t.Fatal("multi-generation family publication warning missing")
	}
}

func TestToutiaoReadModelsUseWorkShapeSnapshots(t *testing.T) {
	account := drAccount(t, "toutiao", "跨页面形态")
	path := "/api/v1/accounts/" + account.ID.String()
	day := env.srv.today().Format("2006-01-02")
	works := map[uuid.UUID]string{}
	for _, format := range []string{"long_article", "micro_post"} {
		var work Work
		env.mustJSON(t, "POST", path+"/works", map[string]string{"title": "跨页面验收" + format, "content_format": format}, &work)
		env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"planned_date": day, "base_revision": work.Revision}, &work)
		works[work.ID] = format
	}
	env.mustJSON(t, "PATCH", path, map[string]any{"content_format": "micro_post", "confirm_type_change": true}, nil)
	var search struct {
		Items []SearchHit `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/search?q=跨页面验收&types=work&account_id="+account.ID.String(), nil, &search)
	if len(search.Items) != 2 {
		t.Fatalf("search lost works: %+v", search)
	}
	for _, hit := range search.Items {
		if hit.Platform != "toutiao" || hit.ContentFormat != works[hit.ID] || hit.Link != "/works/"+hit.ID.String() {
			t.Fatalf("search snapshot or next route incorrect: %+v", hit)
		}
	}
	var calendar struct {
		Items []CalendarItem `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/calendar?account_id="+account.ID.String()+"&from="+day+"&to="+day, nil, &calendar)
	if len(calendar.Items) != 2 {
		t.Fatalf("calendar lost works: %+v", calendar)
	}
	for _, item := range calendar.Items {
		if item.Platform != "toutiao" || item.ContentFormat != works[item.ID] {
			t.Fatalf("calendar used default shape: %+v", item)
		}
	}
	for id := range works {
		env.mustJSON(t, "DELETE", "/api/v1/works/"+id.String(), nil, nil)
	}
	var trash []struct {
		ID            uuid.UUID `json:"id"`
		AccountID     uuid.UUID `json:"account_id"`
		Platform      string    `json:"platform"`
		ContentFormat string    `json:"content_format"`
	}
	env.mustJSON(t, "GET", "/api/v1/trash?type=work", nil, &trash)
	seen := 0
	for _, item := range trash {
		if format, ok := works[item.ID]; ok {
			seen++
			if item.AccountID != account.ID || item.Platform != "toutiao" || item.ContentFormat != format {
				t.Fatalf("trash used default shape: %+v", item)
			}
			env.mustJSON(t, "POST", "/api/v1/trash/work/"+item.ID.String()+"/restore", nil, nil)
			var restored Work
			env.mustJSON(t, "GET", "/api/v1/works/"+item.ID.String(), nil, &restored)
			if restored.ContentFormat != format {
				t.Fatal("restore lost shape")
			}
		}
	}
	if seen != 2 {
		t.Fatalf("trash lost works: %d", seen)
	}
}
