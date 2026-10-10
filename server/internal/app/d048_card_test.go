package app

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
)

// D-048：图文卡片（card_post）工作流——大纲即卡片清单，逐卡 AI 配图，
// 公众号写入图片消息草稿，小红书发布包含卡片图与文案。
func buildCardWork(t *testing.T, platform string) (Account, Work) {
	t.Helper()
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": platform, "name": "卡片号-" + platform, "content_format": "card_post"}, &a)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "效率工具卡片"}, &wk)
	wid := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+wid, map[string]string{"viewpoint": "少而精的工具才用得久"}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/outline/generate", nil, &outline)
	env.mustJSON(t, "PUT", "/api/v1/works/"+wid+"/outline", map[string]any{"items": outline.Items, "confirm": true}, &wk)
	if len(wk.Sections) < 2 {
		t.Fatalf("cards: %d", len(wk.Sections))
	}
	for _, sec := range wk.Sections {
		ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil))
		if ev.Name != "done" {
			t.Fatalf("card draft: %s %s", ev.Name, ev.Data)
		}
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)
	for _, sec := range wk.Sections {
		var out struct {
			ImageURL string `json:"image_url"`
		}
		env.mustJSON(t, "POST", fmt.Sprintf("/api/v1/works/%s/cards/%s/generate-image", wid, sec.ID.String()), nil, &out)
		if out.ImageURL == "" {
			t.Fatal("card image missing")
		}
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)
	if len(wk.Cards) != len(wk.Sections) {
		t.Fatalf("work.cards %d, sections %d", len(wk.Cards), len(wk.Sections))
	}
	for _, c := range wk.Cards {
		if c.ImageAssetID == nil || c.ImageURL == "" {
			t.Fatalf("card without image: %+v", c)
		}
	}
	return a, wk
}

func TestD048CardPostWechatPush(t *testing.T) {
	a, wk := buildCardWork(t, "wechat_mp")
	wid := wk.ID.String()
	env.confirmChecks(t, wid)
	env.mustJSON(t, "GET", "/api/v1/works/"+wid, nil, &wk)
	if wk.Status != "ready" {
		t.Fatalf("status %s", wk.Status)
	}
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	var res map[string]any
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil, &res)
	ev := lastEvent(t, env.sse(t, "/api/v1/works/"+wid+"/wechat/push", map[string]any{"revision": wk.Revision, "fields": wk.WechatFields}))
	if ev.Name != "done" {
		t.Fatalf("push: %s %s", ev.Name, ev.Data)
	}
}

func TestD048CardPostXhsPack(t *testing.T) {
	_, wk := buildCardWork(t, "xhs")
	wid := wk.ID.String()
	env.confirmChecks(t, wid)
	env.mustJSON(t, "POST", "/api/v1/works/"+wid+"/xhs/pack", nil, nil)
	resp := env.request("GET", "/api/v1/works/"+wid+"/xhs/pack.zip", nil, "")
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("pack.zip: %d %s", resp.StatusCode, b)
	}
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	// 卡片图 + 文案.txt
	if len(zr.File) != len(wk.Cards)+1 {
		t.Fatalf("zip files %d, want %d", len(zr.File), len(wk.Cards)+1)
	}
	var text string
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, ".txt") {
			rc, _ := f.Open()
			tb, _ := io.ReadAll(rc)
			_ = rc.Close()
			text = string(tb)
		}
	}
	if text == "" || !strings.Contains(text, wk.Cards[0].Heading) {
		t.Fatalf("card text missing: %q", truncate(text, 80))
	}
}
