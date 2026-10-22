package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestToutiaoPublicPreviewContentScopeExpiryAndRevision(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			work := ttReady(t, format)
			first := env.upload(t, work.ID.String(), testPNG(8, 8))
			env.mustJSON(t, "PATCH", "/api/v1/assets/"+first.ID.String(), map[string]string{"alt_text": "作者的观察配图"}, nil)
			if _, err := env.srv.db.Exec(context.Background(), `UPDATE asset SET ai_generated=true WHERE id=$1`, first.ID); err != nil {
				t.Fatal(err)
			}
			unused := env.upload(t, work.ID.String(), testPNG(9, 9))
			var otherWork Work
			env.mustJSON(t, "POST", "/api/v1/accounts/"+work.AccountID.String()+"/works", map[string]string{"title": "其他作品", "content_format": format}, &otherWork)
			foreign := env.upload(t, otherWork.ID.String(), testPNG(10, 10))
			content := "公开正文，保留作者观察。"
			if format == "long_article" {
				content += "\n\n![正文配图](/api/v1/assets/" + first.ID.String() + "/file)"
			}
			section := work.Sections[0]
			env.mustJSON(t, "PATCH", "/api/v1/sections/"+section.ID.String(), map[string]any{"content_md": content, "heading": "内部大纲小标题", "base_revision": section.Revision}, nil)
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
			env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "不可泄露的微头条内部名", "base_revision": work.Revision}, nil)
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
			env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
			token, expiry := ttPreviewToken(t, work)
			if expiry.Sub(env.srv.now()) > 24*time.Hour || expiry.Sub(env.srv.now()) < 24*time.Hour-time.Minute {
				t.Fatal("预览有效期不是 24 小时")
			}
			path := "/api/v1/public-previews/" + token
			resp := opt37AnonymousGet(t, path)
			data, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Fatalf("匿名读取失败：%d %s", resp.StatusCode, data)
			}
			var preview struct {
				Platform, ContentFormat, Title, BodyText, ArticleHTML string
				Images                                                []struct{ URL string }
			}
			// Use explicit JSON keys for the public contract.
			var public map[string]json.RawMessage
			if err := json.Unmarshal(data, &public); err != nil {
				t.Fatal(err)
			}
			_ = json.Unmarshal(public["platform"], &preview.Platform)
			_ = json.Unmarshal(public["content_format"], &preview.ContentFormat)
			_ = json.Unmarshal(public["title"], &preview.Title)
			_ = json.Unmarshal(public["body_text"], &preview.BodyText)
			_ = json.Unmarshal(public["article_html"], &preview.ArticleHTML)
			_ = json.Unmarshal(public["images"], &preview.Images)
			if preview.Platform != "toutiao" || preview.ContentFormat != format || !strings.Contains(preview.BodyText, "公开正文") {
				t.Fatalf("预览内容不符：%s", data)
			}
			if !strings.Contains(string(public["images"]), `"ai_generated":true`) {
				t.Fatal("分享预览丢失 AI 图片标识")
			}
			for _, key := range []string{"internal_title", "sections", "material_ids", "viewpoint", "status", "check_run"} {
				if _, ok := public[key]; ok {
					t.Fatalf("泄露内部字段 %s", key)
				}
			}
			if format == "micro_post" && (strings.Contains(string(data), work.Title) || strings.Contains(string(data), "内部大纲小标题") || len(preview.Images) != len(work.Assets)) {
				t.Fatalf("微头条混入内部内容或漏图：%s", data)
			}
			if format == "micro_post" && !strings.Contains(string(data), "作者的观察配图") {
				t.Fatal("微头条分享丢失替代文字")
			}
			if format == "long_article" && (preview.Title != work.Title || len(preview.Images) != 1 || !strings.Contains(preview.ArticleHTML, path+"/assets/"+first.ID.String()) || strings.Contains(preview.ArticleHTML, "<style>")) {
				t.Fatalf("文章格式或图片映射错误：%s", data)
			}
			assetPath := path + "/assets/" + first.ID.String()
			for _, p := range []string{assetPath, path + "/assets/" + foreign.ID.String(), path + "/assets/" + uuid.NewString()} {
				r := opt37AnonymousGet(t, p)
				r.Body.Close()
				want := http.StatusNotFound
				if p == assetPath {
					want = http.StatusOK
				}
				if r.StatusCode != want {
					t.Fatalf("图片范围 %s: %d", p, r.StatusCode)
				}
			}
			if format == "long_article" {
				r := opt37AnonymousGet(t, path+"/assets/"+unused.ID.String())
				r.Body.Close()
				if r.StatusCode != http.StatusNotFound {
					t.Fatal("未引用图片可被匿名读取")
				}
			}
			oldNow := env.srv.now
			t.Cleanup(func() { env.srv.now = oldNow })
			env.srv.now = func() time.Time { return expiry }
			for _, p := range []string{path, assetPath} {
				r := opt37AnonymousGet(t, p)
				r.Body.Close()
				if r.StatusCode != http.StatusGone {
					t.Fatalf("过期内容仍可读：%d", r.StatusCode)
				}
			}
			env.srv.now = oldNow
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
			env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "已修改", "base_revision": work.Revision}, nil)
			for _, p := range []string{path, assetPath} {
				r := opt37AnonymousGet(t, p)
				r.Body.Close()
				if r.StatusCode != http.StatusGone {
					t.Fatalf("旧修订预览仍可读：%d", r.StatusCode)
				}
			}
			if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET deleted_at=now() WHERE id=$1`, work.ID); err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{path, assetPath} {
				r := opt37AnonymousGet(t, p)
				r.Body.Close()
				if r.StatusCode != http.StatusNotFound {
					t.Fatalf("删除后预览仍可读：%d", r.StatusCode)
				}
			}
		})
	}
}

func TestToutiaoPublicPreviewRejectsUnpackedAndStaleMaterial(t *testing.T) {
	work := ttReady(t, "micro_post")
	env.expectErr(t, "POST", "/api/v1/works/"+work.ID.String()+"/preview-link", map[string]int{"basis_revision": work.Revision}, "human_step_required")
	material := ttMaterial(t, &work)
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
	token, _ := ttPreviewToken(t, work)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE material SET content=content || '更新' WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v1/public-previews/" + token, "/api/v1/public-previews/" + token + "/assets/" + work.Assets[0].ID.String()} {
		resp := opt37AnonymousGet(t, path)
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusGone || strings.Contains(string(data), material.Content) {
			t.Fatalf("失效素材泄露：%d %s", resp.StatusCode, data)
		}
	}
	// A valid signature for a different workspace cannot grant this work.
	claims, _ := env.srv.verifyPreview(token)
	claims.WorkspaceID = uuid.New()
	wrongWorkspace, _ := env.srv.signPreview(claims)
	wrong := opt37AnonymousGet(t, "/api/v1/public-previews/"+wrongWorkspace)
	wrong.Body.Close()
	if wrong.StatusCode != http.StatusNotFound {
		t.Fatalf("跨工作区预览状态 %d", wrong.StatusCode)
	}
}

func ttPreviewToken(t *testing.T, work Work) (string, time.Time) {
	t.Helper()
	var link struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/preview-link", map[string]int{"basis_revision": work.Revision}, &link)
	if link.Token == "" || link.ExpiresAt.IsZero() {
		t.Fatal("头条分享链接缺少 token 或有效期")
	}
	return link.Token, link.ExpiresAt
}

func TestToutiaoPublicPreviewCreationBindsConfirmedRevision(t *testing.T) {
	for _, format := range []string{"long_article", "micro_post"} {
		t.Run(format, func(t *testing.T) {
			work := ttReady(t, format)
			path := "/api/v1/works/" + work.ID.String() + "/preview-link"
			env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
			for _, body := range []any{nil, map[string]int{"basis_revision": 0}, map[string]int{"basis_revision": -1}} {
				env.expectErr(t, "POST", path, body, "validation_failed")
			}
			confirmedRevision := work.Revision
			env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "确认分享期间改稿", "base_revision": work.Revision}, nil)
			env.confirmChecks(t, work.ID.String())
			env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
			env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
			env.expectErr(t, "POST", path, map[string]int{"basis_revision": confirmedRevision}, "version_conflict")
			token, _ := ttPreviewToken(t, work)
			claims, err := env.srv.verifyPreview(token)
			if err != nil || claims.BasisRevision != work.Revision {
				t.Fatalf("分享未绑定确认的修订：%+v %v", claims, err)
			}
		})
	}
}

func TestToutiaoPublicPreviewAgentFreezesRevision(t *testing.T) {
	work := ttReady(t, "micro_post")
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)
	propose := func() *agentActionView {
		events := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "请为这篇作品生成匿名分享预览\n" + agentLoadDomain("works") +
			"\n#tool works__preview_link {\"id\":\"" + work.ID.String() + "\"}"})
		action := findActionEvent(t, events)
		if action == nil {
			t.Fatal("没有生成分享确认卡片")
		}
		var params map[string]any
		if err := env.srv.db.QueryRow(context.Background(), `SELECT params FROM agent_action WHERE id=$1`, action.ID).Scan(&params); err != nil {
			t.Fatal(err)
		}
		if params["basis_revision"] != float64(work.Revision) {
			t.Fatalf("卡片没有冻结真实修订号：%+v", params)
		}
		return action
	}
	action := propose()
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"title": "卡片确认前改稿", "base_revision": work.Revision}, nil)
	env.confirmChecks(t, work.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &work)
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/toutiao/pack", map[string]int{"basis_revision": work.Revision}, nil)
	// Execution must not silently replace the frozen revision with the new one.
	events := env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	if !strings.Contains(string(lastEvent(t, events).Data), "version_conflict") {
		t.Fatalf("过期分享卡片未拒绝：%s", lastEvent(t, events).Data)
	}
	action = propose()
	events = env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	var done struct {
		Action struct {
			Status string `json:"status"`
		} `json:"action"`
		SecretOnce map[string]string `json:"secret_once"`
	}
	if err := json.Unmarshal(lastEvent(t, events).Data, &done); err != nil {
		t.Fatal(err)
	}
	claims, err := env.srv.verifyPreview(done.SecretOnce["token"])
	if done.Action.Status != "succeeded" || err != nil || claims.BasisRevision != work.Revision {
		t.Fatalf("重新确认的卡片未生成正确分享：status=%s err=%v", done.Action.Status, err)
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT result::text FROM agent_action WHERE id=$1`, action.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, done.SecretOnce["token"]) {
		t.Fatal("分享密钥不应写入卡片持久化结果")
	}
}
