package app

import (
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

func TestOPT47DoesNotBypassOutlineOrEmptySectionsOrAddPublishedDerivation(t *testing.T) {
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
		func(w *naWork) { w.Status = "published" },
	} {
		w := base
		change(&w)
		if list := nextActions(naInput{Now: now, Platform: "wechat_mp", Works: []naWork{w}}, 10); len(list) != 0 {
			t.Fatalf("unavailable/gated action: %+v", list)
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
