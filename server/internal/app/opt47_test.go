package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOPT47CompletedBodyOffersTitleImagesThenExistingCheckFlow(t *testing.T) {
	now := time.Now()
	w := naWork{ID: uuid.New(), Status: "drafting", UpdatedAt: now, OutlineConfirmed: true, Viewpoint: true, HasSections: true, ContentFormat: "long_article"}
	in := naInput{Now: now, AccountID: uuid.New(), Platform: "wechat_mp", Works: []naWork{w}}
	assert := func(kind, suffix string) {
		t.Helper()
		list := nextActions(in, 10)
		if len(list) != 1 || list[0].Kind != kind || !strings.HasSuffix(list[0].Link, suffix) {
			t.Fatalf("next step: %+v", list)
		}
		if strings.Contains(list[0].Action, "全部") {
			t.Fatal("bulk action added")
		}
	}
	assert("title", "#step-title")
	in.Works[0].Title = "正文完成的作品"
	assert("cover", "#step-images")
	in.Works[0].ImagesReady = true
	assert("layout", "/preview?next=check")
	in.Platform = "xhs"
	assert("layout", "/check?start=1")
	in.Works[0].ImagesReady = false
	assert("cover", "#step-images")
	in.Works[0].Title = " "
	in.Works[0].PlannedDate = &now
	assert("planned", "#step-title")
}

func TestOPT47DoesNotBypassOutlineOrEmptySections(t *testing.T) {
	now := time.Now()
	base := naWork{ID: uuid.New(), Status: "drafting", UpdatedAt: now, OutlineConfirmed: true, Viewpoint: true, HasSections: true, ContentFormat: "long_article"}
	for _, change := range []func(*naWork){
		func(w *naWork) { w.OutlineConfirmed = false },
		func(w *naWork) { w.Viewpoint = false },
		func(w *naWork) { w.EmptySections = []uuid.UUID{uuid.New()} },
	} {
		w := base
		change(&w)
		list := nextActions(naInput{Now: now, Platform: "wechat_mp", Works: []naWork{w}}, 10)
		if len(list) != 1 || list[0].Kind != "draft" {
			t.Fatalf("human/body prerequisite bypassed: %+v", list)
		}
	}
	for _, change := range []func(*naWork){
		func(w *naWork) { w.HasSections = false },
		func(w *naWork) { w.ContentFormat = "comic" },
		func(w *naWork) { w.ContentFormat = "card_post" },
	} {
		w := base
		change(&w)
		if list := nextActions(naInput{Now: now, Platform: "wechat_mp", Works: []naWork{w}}, 10); len(list) != 0 {
			t.Fatalf("unavailable/gated action: %+v", list)
		}
	}
}

func TestOPT47PublishedWechatSuggestsManualXhsDerivation(t *testing.T) {
	now := time.Now()
	w := naWork{ID: uuid.New(), Title: "已发布公众号文章", Status: "published", UpdatedAt: now, ContentFormat: "long_article"}
	get := func(platform string, work naWork) []NextAction {
		t.Helper()
		return nextActions(naInput{Now: now, AccountID: uuid.New(), Platform: platform, Works: []naWork{work}}, 10)
	}
	list := get("wechat_mp", w)
	if len(list) != 1 || list[0].Kind != "derive" || list[0].Action != "派生小红书" || list[0].Link != "/works/"+w.ID.String() {
		t.Fatalf("published WeChat article should offer a manual derive step: %+v", list)
	}
	for name, variant := range map[string]struct {
		platform string
		change   func(*naWork)
	}{
		"already-derived": {"wechat_mp", func(w *naWork) { w.HasXhsDerived = true }},
		"other-platform":  {"xhs", func(*naWork) {}},
		"other-format":    {"wechat_mp", func(w *naWork) { w.ContentFormat = "comic" }},
		"not-published":   {"wechat_mp", func(w *naWork) { w.Status = "pushed" }},
	} {
		w := w
		variant.change(&w)
		for _, action := range get(variant.platform, w) {
			if action.Kind == "derive" {
				t.Fatalf("%s unexpectedly offered derivation: %+v", name, action)
			}
		}
	}
}

func TestOPT47NextActionsAPIIncludesCompletedUntitledWork(t *testing.T) {
	guest := env.registerClient(t, "opt47-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "下一步模拟号"}, &a)
	work := outlinedWork(t, a, "作者已经逐段写完，需要继续完成标题和封面")
	for _, section := range work.Sections {
		setSection(t, section, "这段由作者填写的正文。")
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "", "base_revision": work.Revision}, &work)
	var actions []NextAction
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/next-actions?limit=10", nil, &actions)
	found := false
	for _, action := range actions {
		if action.WorkID != nil && *action.WorkID == work.ID {
			found = action.Kind == "title" && action.Link == "/works/"+work.ID.String()+"#step-title"
		}
	}
	if !found {
		t.Fatalf("completed untitled work missing: %+v", actions)
	}
}

func TestOPT47NextActionsAPIOffersDerivationOnlyUntilXhsChildExists(t *testing.T) {
	guest := env.registerClient(t, "opt47-derived-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var source Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "已发布公众号"}, &source)
	work := outlinedWork(t, source, "发布后尚可逐篇派生")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='published', published_at=$2 WHERE id=$1`, work.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	getActions := func() []NextAction {
		t.Helper()
		var actions []NextAction
		env.mustJSON(t, "GET", "/api/v1/accounts/"+source.ID.String()+"/next-actions?limit=10", nil, &actions)
		return actions
	}
	assertDerive := func(want bool) {
		t.Helper()
		found := false
		for _, action := range getActions() {
			if action.WorkID != nil && *action.WorkID == work.ID && action.Kind == "derive" {
				found = action.Link == "/works/"+work.ID.String() && action.Action == "派生小红书"
			}
		}
		if found != want {
			t.Fatalf("derive prompt found=%v want=%v", found, want)
		}
	}
	assertDerive(true)
	var target Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "content_format": "image_note", "name": "派生目标"}, &target)
	var derived Work
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/derive", map[string]string{"target_account_id": target.ID.String()}, &derived)
	assertDerive(false)
}
