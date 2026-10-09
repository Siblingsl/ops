package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestMainChain walks the MVP main flow through the HTTP API (08 文档 E2E 主链路的接口层版本).
func TestMainChain(t *testing.T) {
	f := env.accounts(t)
	wid := f.wechat.ID.String()

	// 档案、风格样本、素材
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+wid+"/profile", map[string]any{
		"positioning_tags": []string{"效率", "职场"}, "target_audience": "刚工作三年的年轻人", "persona_tone": "真诚、克制",
		"banned_words": []string{"颠覆"}, "default_theme": "ink",
		"wechat_defaults": map[string]any{"author": "小周", "open_comment": false},
	}, nil)
	var p Profile
	env.mustJSON(t, "GET", "/api/v1/accounts/"+wid+"/profile", nil, &p)
	if p.WechatDefaults.Author != "小周" || p.WechatDefaults.OpenComment {
		t.Fatalf("profile defaults: %+v", p.WechatDefaults)
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+wid+"/style-samples", map[string]string{"title": "旧文一篇", "content_md": strings.Repeat("我习惯先写结论，再讲经历。", 30)}, nil)
	var mat map[string]any
	env.mustJSON(t, "POST", "/api/v1/materials", map[string]any{"account_id": wid, "kind": "experience", "content": "第一份工作时每天加班到十点", "source": "亲身经历"}, &mat)

	// 选题 -> 作品
	var topicRes struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+wid+"/topics", map[string]string{"title": "加班不等于努力", "angle": "从亲身经历切入"}, &topicRes)
	env.mustJSON(t, "PATCH", "/api/v1/topics/"+topicRes.Topic.ID.String(), map[string]string{"status": "adopted"}, nil)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/topics/"+topicRes.Topic.ID.String()+"/works", nil, &wk)
	if wk.TopicID == nil || wk.WechatFields.Author != "小周" {
		t.Fatalf("work from topic: %+v", wk)
	}
	id := wk.ID.String()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"viewpoint": "加班时长不能证明努力，产出才能", "material_ids": []any{mat["id"]}}, nil)
	var outline struct {
		Items []OutlineItem `json:"items"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/outline/generate", nil, &outline)
	if len(outline.Items) < 3 {
		t.Fatalf("outline items: %d", len(outline.Items))
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+id+"/outline", map[string]any{"items": outline.Items, "confirm": true}, &wk)
	if wk.OutlineConfirmedAt == nil || len(wk.Sections) != len(outline.Items) {
		t.Fatalf("outline confirm: sections=%d", len(wk.Sections))
	}
	for _, sec := range wk.Sections[:3] {
		evs := env.sse(t, "/api/v1/sections/"+sec.ID.String()+"/draft", nil)
		deltas := 0
		for _, e := range evs {
			if e.Name == "delta" {
				deltas++
			}
		}
		if ev := lastEvent(t, evs); ev.Name != "done" || deltas < 2 {
			t.Fatalf("draft stream: %s deltas=%d", ev.Name, deltas)
		}
	}
	// 删掉未起草的段落，手动编辑一段
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	for _, sec := range wk.Sections[3:] {
		env.mustJSON(t, "DELETE", "/api/v1/sections/"+sec.ID.String(), nil, nil)
	}
	first := wk.Sections[0]
	var upd struct {
		Section Section `json:"section"`
	}
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+first.ID.String(), map[string]any{"content_md": first.ContentMD + "\n\n这是我自己补的一句。", "base_revision": first.Revision}, &upd)
	if upd.Section.Origin != "mixed" {
		t.Fatalf("origin after human edit: %s", upd.Section.Origin)
	}
	// 并发编辑冲突（E-13）
	env.expectErr(t, "PATCH", "/api/v1/sections/"+first.ID.String(), map[string]any{"content_md": "旧版本覆盖", "base_revision": first.Revision}, "version_conflict")

	if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+first.ID.String()+"/edit", map[string]string{"mode": "shorten", "selection": "这是我自己补的一句。"})); ev.Name != "done" {
		t.Fatalf("edit: %s %s", ev.Name, ev.Data)
	}
	var titles struct {
		Titles []struct {
			Text string `json:"text"`
		} `json:"titles"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/titles", nil, &titles)
	if len(titles.Titles) < 5 {
		t.Fatalf("titles: %v", titles.Titles)
	}
	var sum struct {
		Summary string `json:"summary"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/summary", nil, &sum)
	cover := env.upload(t, id, testPNG(1200, 600))
	env.upload(t, id, testPNG(600, 600))
	env.mustJSON(t, "PATCH", "/api/v1/works/"+id, map[string]any{"title": titles.Titles[0].Text, "summary": sum.Summary,
		"cover_asset_id": cover.ID, "cover_crops": map[string]cropBox{"2.35_1": {0, 0.1, 1, 0.5}, "1_1": {0.25, 0, 0.75, 1}}}, nil)

	// 版本
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/versions", nil, nil)
	var versions []map[string]any
	env.mustJSON(t, "GET", "/api/v1/works/"+id+"/versions", nil, &versions)
	if len(versions) < 2 {
		t.Fatalf("versions: %d", len(versions))
	}

	// 检查：账号禁用词命中
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+wk.Sections[1].ID.String(), map[string]any{"content_md": wk.Sections[1].ContentMD + "\n\n这会颠覆你的认知。", "base_revision": wk.Sections[1].Revision}, nil)
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/checks", map[string]int{"html_chars": 5000, "html_bytes": 15000}, nil)
	run := env.latestCheck(t, id)
	found := false
	for _, it := range run.Items {
		if it.Category == "sensitive" && it.MatchedText == "颠覆" {
			found = true
			env.expectErr(t, "PATCH", "/api/v1/check-items/"+it.ID.String(), map[string]string{"resolution": "verified"}, "validation_failed")
		}
	}
	if !found {
		t.Fatal("banned word not flagged")
	}
	env.confirmChecks(t, id)
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	if wk.Status != "ready" {
		t.Fatalf("status %s", wk.Status)
	}

	// 推送（新建草稿）
	var preview map[string]any
	env.mustJSON(t, "GET", "/api/v1/works/"+id+"/wechat/push-preview", nil, &preview)
	if preview["mode"] != "new" {
		t.Fatalf("preview mode %v", preview["mode"])
	}
	evs := env.push(t, wk, map[string]any{"confirm_over_limit": true})
	done := lastEvent(t, evs)
	if done.Name != "done" {
		t.Fatalf("push: %s %s", done.Name, done.Data)
	}
	var d struct {
		DraftMediaID string `json:"draft_media_id"`
	}
	_ = json.Unmarshal(done.Data, &d)
	uploads := 0
	for _, c := range env.mockWX.Calls() {
		if c == "/cgi-bin/media/uploadimg" {
			uploads++
		}
	}
	// 后台修改后再次推送：必须让人选择（E-18）
	resp, err := http.Post(env.mock.URL+"/mock/drafts/"+d.DraftMediaID+"/touch", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	if wk.Status != "pushed" {
		t.Fatalf("status after push: %s", wk.Status)
	}
	if ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true})); ev.Name != "need_choice" {
		t.Fatalf("want need_choice after backend edit, got %s %s", ev.Name, ev.Data)
	}
	ev := lastEvent(t, env.push(t, wk, map[string]any{"confirm_over_limit": true, "overwrite_choice": "overwrite"}))
	if ev.Name != "done" || !strings.Contains(string(ev.Data), `"update"`) {
		t.Fatalf("overwrite: %s %s", ev.Name, ev.Data)
	}
	after := 0
	for _, c := range env.mockWX.Calls() {
		if c == "/cgi-bin/media/uploadimg" {
			after++
		}
	}
	if after != uploads {
		t.Fatalf("images re-uploaded despite cache: %d -> %d", uploads, after)
	}

	// 派生到小红书 + 分段改写
	var derived Work
	env.mustJSON(t, "POST", "/api/v1/works/"+id+"/derive", map[string]string{"target_account_id": f.xhs.ID.String()}, &derived)
	if derived.Source == nil || len(derived.Sections) == 0 || derived.OutlineConfirmedAt == nil {
		t.Fatalf("derived: %+v", derived)
	}
	did := derived.ID.String()
	for _, sec := range derived.Sections {
		if ev := lastEvent(t, env.sse(t, "/api/v1/sections/"+sec.ID.String()+"/rewrite", nil)); ev.Name != "done" {
			t.Fatalf("rewrite: %s %s", ev.Name, ev.Data)
		}
	}
	env.upload(t, did, testPNG(800, 1000))
	env.mustJSON(t, "PATCH", "/api/v1/works/"+did, map[string]any{"title": "加班不等于努力", "topics": []string{"#职场", "效率"}}, nil)
	env.confirmChecks(t, did)
	env.mustJSON(t, "POST", "/api/v1/works/"+did+"/xhs/pack", nil, &derived)
	if derived.Status != "packed" || len(derived.Topics) != 2 || derived.Topics[0] != "职场" {
		t.Fatalf("pack: %s %v", derived.Status, derived.Topics)
	}
	zr := env.request("GET", "/api/v1/works/"+did+"/xhs/pack.zip", nil, "")
	zb, _ := io.ReadAll(zr.Body)
	zr.Body.Close()
	zf, err := zip.NewReader(bytes.NewReader(zb), int64(len(zb)))
	if err != nil || len(zf.File) != 1 || zf.File[0].Name != "01.jpg" {
		t.Fatalf("zip: %v %d", err, len(zb))
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+did+"/published", map[string]string{}, &derived)
	if derived.Status != "published" {
		t.Fatalf("xhs published: %s", derived.Status)
	}
	// 已发布作品只读（E-14）
	env.expectErr(t, "PATCH", "/api/v1/works/"+did, map[string]string{"title": "改"}, "state_invalid")
	env.expectErr(t, "POST", "/api/v1/works/"+did+"/unlock", nil, "confirm_required")
	env.mustJSON(t, "POST", "/api/v1/works/"+did+"/unlock", map[string]bool{"confirm": true}, nil)

	// 工作台、看板、用量、日志
	var dash map[string]any
	env.mustJSON(t, "GET", "/api/v1/accounts/"+wid+"/dashboard", nil, &dash)
	var board []BoardRow
	env.mustJSON(t, "GET", "/api/v1/accounts/"+wid+"/board", nil, &board)
	if len(board) == 0 {
		t.Fatal("board empty")
	}
	var usage struct {
		Rows  []map[string]any `json:"rows"`
		Total struct {
			Calls int `json:"calls"`
		} `json:"total"`
	}
	env.mustJSON(t, "GET", "/api/v1/usage?group_by=task", nil, &usage)
	if usage.Total.Calls < 5 {
		t.Fatalf("usage calls %d", usage.Total.Calls)
	}
	var logs []map[string]any
	env.mustJSON(t, "GET", "/api/v1/audit-logs?action=wechat_push", nil, &logs)
	if len(logs) < 2 {
		t.Fatalf("audit logs: %d", len(logs))
	}

	// 回收站
	var del map[string]any
	env.mustJSON(t, "DELETE", "/api/v1/works/"+id, nil, &del)
	if del["derived_count"].(float64) != 1 || del["had_wechat_draft"] != true {
		t.Fatalf("delete info: %v", del)
	}
	env.mustJSON(t, "GET", "/api/v1/works/"+did, nil, &derived)
	if derived.Source == nil {
		t.Fatal("derived lost its source reference")
	}
	var trash []map[string]any
	env.mustJSON(t, "GET", "/api/v1/trash?type=work", nil, &trash)
	if len(trash) != 1 || trash[0]["days_left"].(float64) != 30 {
		t.Fatalf("trash: %v", trash)
	}
	env.mustJSON(t, "POST", "/api/v1/trash/work/"+id+"/restore", nil, nil)
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &wk)
	env.mustJSON(t, "DELETE", "/api/v1/works/"+id, nil, nil)
	env.expectErr(t, "DELETE", "/api/v1/trash/work/"+id, nil, "confirm_required")
	env.mustJSON(t, "DELETE", "/api/v1/trash/work/"+id+"?confirm=true", nil, nil)
	env.expectErr(t, "GET", "/api/v1/works/"+id, nil, "not_found")
}

func TestModelConfigAndLimit(t *testing.T) {
	var list []Provider
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &list)
	if len(list) != 1 || !strings.Contains(list[0].KeyMask, "*") {
		t.Fatalf("providers: %+v", list)
	}
	// 新增密钥需要再次输入密码
	env.srv.db.Exec(context.Background(), `UPDATE session SET reauth_until=NULL`)
	in := map[string]any{"name": "坏密钥", "base_url": env.mock.URL + "/v1", "api_key": "bad-key", "models": []string{"m1"}}
	env.expectErr(t, "POST", "/api/v1/model-providers", in, "reauth_required")
	env.reauth(t)
	var p Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", in, &p)
	var res struct {
		OK     bool   `json:"ok"`
		Result string `json:"result"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+p.ID.String()+"/test", nil, &res)
	if res.OK || strings.Contains(res.Result, "bad-key") {
		t.Fatalf("bad key test: %+v", res)
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+list[0].ID.String()+"/test", nil, &res)
	if !res.OK {
		t.Fatalf("good key test: %+v", res)
	}
	// 某个任务路由到坏供应商：调用失败但返回可读错误
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "title", "provider_id": p.ID, "model": "m1"}}, nil)
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "路由测试"}, &wk)
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/titles", nil, "ai_upstream_error")
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "title"}}, nil)
	env.expectErr(t, "DELETE", "/api/v1/model-providers/"+list[0].ID.String(), nil, "confirm_required")
	env.mustJSON(t, "DELETE", "/api/v1/model-providers/"+p.ID.String(), nil, nil)

	// 每日用量上限（E-10）
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"ai_limit": map[string]any{"enabled": true, "daily_tokens": 1000}}, nil)
	env.expectErr(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/topics/suggest", nil, "ai_quota_exceeded")
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"ai_limit": map[string]any{"enabled": false, "daily_tokens": 2000000}}, nil)
}

func TestCredentialErrors(t *testing.T) {
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "白名单测试", "content_format": "long_article"}, &a)
	env.reauth(t)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx-ip-blocked", "app_secret": "x"}, nil)
	var res map[string]any
	st, b := env.do("POST", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential/test", nil)
	_ = json.Unmarshal(b, &res)
	if !strings.Contains(string(b), "白名单") {
		t.Fatalf("40164 not explained: %d %s", st, b)
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String(), nil, &a)
	if a.Credential == nil || a.Credential.State != "error" || strings.Contains(string(b), "\"x\"") {
		t.Fatalf("credential state: %+v", a.Credential)
	}
	env.expectErr(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]string{"content_format": "comic"}, "confirm_required")
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/disable", nil, nil)
	env.expectErr(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "x"}, "state_invalid")
}

func TestAuthLockoutAndReset(t *testing.T) {
	jar := env.client.Jar
	defer func() { env.client.Jar = jar }()
	env.client.Jar = nil
	for i := 0; i < 4; i++ {
		env.expectErr(t, "POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": "wrong-password"}, "unauthenticated")
	}
	env.expectErr(t, "POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": "wrong-password"}, "login_locked")
	env.expectErr(t, "POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}, "login_locked")
	if _, err := ResetPassword(context.Background(), env.srv, "owner", "short"); err == nil {
		t.Fatal("short password accepted")
	}
	if _, err := ResetPassword(context.Background(), env.srv, "owner", testPassword); err != nil {
		t.Fatal(err)
	}
	st, _ := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
	if st != 200 {
		t.Fatalf("login after reset: %d", st)
	}
	// 重置后旧会话全部失效：用原来的 cookie 重新登录拿新会话
	env.client.Jar = jar
	env.expectErr(t, "GET", "/api/v1/auth/me", nil, "unauthenticated")
	env.mustJSON(t, "POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}, nil)
	var me struct {
		CSRF string `json:"csrf_token"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	env.csrf = me.CSRF
	saved := env.csrf
	env.csrf = "bad"
	env.expectErr(t, "POST", "/api/v1/auth/logout", nil, "csrf_invalid")
	env.csrf = saved
}
