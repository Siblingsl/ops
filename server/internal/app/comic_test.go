package app

import (
	"strings"
	"testing"
)

func TestMDToPlain(t *testing.T) {
	in := "## 标题\n\n这是**加粗**和[链接](https://x.com)。\n\n- 一项\n- 二项\n\n> 引用句\n"
	out := mdToPlain(in)
	for _, want := range []string{"标题", "加粗", "链接", "· 一项", "「引用句」"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %q", want, out)
		}
	}
	if strings.Contains(out, "https://") || strings.Contains(out, "**") {
		t.Fatalf("should strip md markers: %q", out)
	}
}

func TestComicStoryboardHumanGates(t *testing.T) {
	_ = env.accounts(t)
	var comic Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]any{
		"platform": "xhs", "name": "漫画号", "content_format": "comic",
	}, &comic)

	var char CharacterCard
	env.mustJSON(t, "POST", "/api/v1/accounts/"+comic.ID.String()+"/characters", map[string]string{
		"name": "小周", "appearance": "短发圆眼镜", "personality": "谨慎", "catchphrase": "先想清楚",
	}, &char)

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+comic.ID.String()+"/works", map[string]string{"title": "第一组漫画"}, &wk)
	ae := env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/storyboard/generate",
		map[string]any{"panel_count": 4, "character_ids": []string{char.ID.String()}}, "human_step_required")
	if !strings.Contains(string(ae.Error.Detail), "H-02") {
		t.Fatalf("want H-02, got %s", ae.Error.Detail)
	}

	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "把复杂的事情拆成几格说清楚"}, nil)
	var gen struct {
		Panels []ComicPanel `json:"panels"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/storyboard/generate",
		map[string]any{"panel_count": 4, "character_ids": []string{char.ID.String()}}, &gen)
	if len(gen.Panels) != 4 {
		t.Fatalf("panels: %d", len(gen.Panels))
	}

	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/storyboard", map[string]any{"panels": gen.Panels}, &wk)
	if wk.OutlineConfirmedAt != nil {
		t.Fatal("unconfirmed save should not set outline_confirmed_at")
	}
	ae = env.expectErr(t, "POST", "/api/v1/panels/"+wk.Panels[0].ID.String()+"/text", nil, "human_step_required")
	if !strings.Contains(string(ae.Error.Detail), "H-03") {
		t.Fatalf("want H-03, got %s", ae.Error.Detail)
	}

	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/storyboard", map[string]any{"panels": gen.Panels, "confirm": true}, &wk)
	if wk.OutlineConfirmedAt == nil || len(wk.Panels) != 4 {
		t.Fatalf("confirm: confirmed=%v panels=%d", wk.OutlineConfirmedAt, len(wk.Panels))
	}

	var text struct {
		Dialogue    string `json:"dialogue"`
		ImagePrompt string `json:"image_prompt"`
	}
	env.mustJSON(t, "POST", "/api/v1/panels/"+wk.Panels[0].ID.String()+"/text", nil, &text)
	if text.Dialogue == "" || !strings.Contains(text.ImagePrompt, "短发") {
		t.Fatalf("panel text should include appearance in prompt: %+v", text)
	}
}

func TestNewspicPush(t *testing.T) {
	fx := env.accounts(t)
	var comic Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]any{
		"platform": "wechat_mp", "name": "公众号漫画", "content_format": "comic",
	}, &comic)
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+comic.ID.String()+"/wechat-credential",
		map[string]string{"app_id": "wxcomic0001", "app_secret": "comic-secret-value"}, nil)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+comic.ID.String()+"/wechat-credential/test", nil, &map[string]any{})

	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+comic.ID.String()+"/works", map[string]string{"title": "四格心情"}, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wk.ID.String(), map[string]string{"viewpoint": "把一天拆成四格"}, nil)
	var gen struct {
		Panels []ComicPanel `json:"panels"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/storyboard/generate",
		map[string]any{"panel_count": 4, "character_ids": []string{}}, &gen)
	env.mustJSON(t, "PUT", "/api/v1/works/"+wk.ID.String()+"/storyboard", map[string]any{"panels": gen.Panels, "confirm": true}, &wk)
	for i := range wk.Panels {
		env.mustJSON(t, "POST", "/api/v1/panels/"+wk.Panels[i].ID.String()+"/text", nil, nil)
		a := env.upload(t, wk.ID.String(), testPNG(120, 120))
		env.mustJSON(t, "PATCH", "/api/v1/panels/"+wk.Panels[i].ID.String(), map[string]any{"asset_id": a.ID}, &wk)
	}
	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	if wk.Status != "ready" {
		t.Fatalf("status=%s", wk.Status)
	}

	evs := env.push(t, wk, nil)
	done := lastEvent(t, evs)
	if done.Name != "done" {
		t.Fatalf("push events: last=%s all=%+v", done.Name, evs)
	}
	var sawAddMaterial bool
	for _, c := range env.mockWX.Calls() {
		if strings.Contains(c, "add_material") {
			sawAddMaterial = true
			break
		}
	}
	if !sawAddMaterial {
		t.Fatalf("expected add_material calls, got %v", env.mockWX.Calls())
	}
	_ = fx
}
