package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// OPT-W03：根路由 GET /preview/{token} 直出只读 HTML 扫码预览页。
// 本文件只验证页面契约；原有 JSON/图片接口的既有断言保留在 opt37_test.go / be02_preview_link_test.go。

func TestPublicPreviewHTMLPageRendersSecurely(t *testing.T) {
	work := opt37CreateWork(t, "OPT-W03 扫码预览")
	asset := env.upload(t, work.ID.String(), testPNG(8, 8))
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET title=$1 WHERE id=$2`,
		`<script>alert("title")</script> 安全标题`, work.ID); err != nil {
		t.Fatal(err)
	}
	content := "第一段正文。\n\n<script>alert('body')</script>\n\n![审阅配图](/api/v1/assets/" + asset.ID.String() + "/file)"
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work_section SET heading=$1, content_md=$2 WHERE work_id=$3`,
		`<script>alert("heading")</script> 章节标题`, content, work.ID); err != nil {
		t.Fatal(err)
	}
	token, _ := opt37PreviewToken(t, work.ID)

	resp := opt37AnonymousGet(t, "/preview/"+token)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTML 预览状态 = %d，正文 = %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := resp.Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", got)
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	const wantCSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"
	if got := resp.Header.Get("Content-Security-Policy"); got != wantCSP {
		t.Fatalf("Content-Security-Policy = %q", got)
	}

	html := string(body)
	imageURL := "/api/v1/public-previews/" + token + "/assets/" + asset.ID.String()
	for _, want := range []string{
		"安全标题",
		"章节标题",
		"第一段正文",
		"内部审阅预览 · 禁止直接当作已发表",
		imageURL,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("HTML 预览缺少 %q：%s", want, html)
		}
	}
	if strings.Contains(html, "<script>") {
		t.Fatalf("HTML 预览未转义 <script>，存在 XSS：%s", html)
	}
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Fatalf("HTML 预览应以实体形式保留被转义的脚本文本：%s", html)
	}

	imageResp := opt37AnonymousGet(t, imageURL)
	defer imageResp.Body.Close()
	if imageResp.StatusCode != http.StatusOK {
		t.Fatalf("预览图片资产状态 = %d", imageResp.StatusCode)
	}
	if got := imageResp.Header.Get("Content-Type"); !strings.HasPrefix(got, "image/") {
		t.Fatalf("预览图片 Content-Type = %q", got)
	}
}

func TestPublicPreviewHTMLPageExpiredAndForged(t *testing.T) {
	work := opt37CreateWork(t, "OPT-W03 过期与伪造")
	now := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	oldNow := env.srv.now
	env.srv.now = func() time.Time { return now }
	t.Cleanup(func() { env.srv.now = oldNow })
	token, _ := opt37PreviewToken(t, work.ID)

	env.srv.now = func() time.Time { return now.Add(25 * time.Hour) }
	expired := opt37AnonymousGet(t, "/preview/"+token)
	defer expired.Body.Close()
	expiredBody, _ := io.ReadAll(expired.Body)
	if expired.StatusCode != http.StatusGone {
		t.Fatalf("过期预览状态 = %d，正文 = %s", expired.StatusCode, expiredBody)
	}
	if !strings.Contains(string(expiredBody), "此预览链接已过期，请在 OPS 桌面端重新生成") {
		t.Fatalf("过期预览缺少中文提示：%s", expiredBody)
	}
	if got := expired.Header.Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("过期预览 Content-Type = %q", got)
	}
	if expired.Header.Get("Content-Security-Policy") == "" {
		t.Fatal("过期预览页缺少 Content-Security-Policy")
	}

	dot := strings.LastIndexByte(token, '.')
	if dot < 0 {
		t.Fatalf("预览 token 格式异常：%q", token)
	}
	signature := []byte(token[dot+1:])
	if signature[0] == 'A' {
		signature[0] = 'B'
	} else {
		signature[0] = 'A'
	}
	forgedToken := token[:dot+1] + string(signature)
	forged := opt37AnonymousGet(t, "/preview/"+forgedToken)
	defer forged.Body.Close()
	forgedBody, _ := io.ReadAll(forged.Body)
	if forged.StatusCode != http.StatusNotFound {
		t.Fatalf("伪造 token 状态 = %d，正文 = %s", forged.StatusCode, forgedBody)
	}
	if !strings.Contains(string(forgedBody), "预览链接无效") {
		t.Fatalf("伪造 token 缺少中文提示：%s", forgedBody)
	}
}

func TestPublicPreviewJSONContractUnchanged(t *testing.T) {
	work := opt37CreateWork(t, "OPT-W03 JSON 契约")
	token, _ := opt37PreviewToken(t, work.ID)

	resp := opt37AnonymousGet(t, "/api/v1/public-previews/"+token)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("JSON 预览状态 = %d，正文 = %s", resp.StatusCode, body)
	}
	if got := resp.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("JSON 预览 Content-Type = %q", got)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"title", "account_name", "theme", "custom_theme", "sections", "assets"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("JSON 契约缺少字段 %s：%s", key, body)
		}
	}
	if _, ok := payload["platform"]; ok {
		t.Fatalf("公众号 JSON 不应出现 platform 字段：%s", body)
	}
	var title string
	if err := json.Unmarshal(payload["title"], &title); err != nil || title != work.Title {
		t.Fatalf("title = %q（err=%v），want %q", title, err, work.Title)
	}
	var sections []struct {
		Heading   string `json:"heading"`
		ContentMD string `json:"content_md"`
	}
	if err := json.Unmarshal(payload["sections"], &sections); err != nil {
		t.Fatal(err)
	}
	if len(sections) != 1 || sections[0].Heading != "扫码预览" || sections[0].ContentMD != "手机上也能检查排版" {
		t.Fatalf("sections = %#v", sections)
	}
	var assets []struct {
		ID      string `json:"id"`
		AltText string `json:"alt_text"`
	}
	if err := json.Unmarshal(payload["assets"], &assets); err != nil {
		t.Fatal(err)
	}
	if assets == nil {
		t.Fatal("assets 必须是数组，不能是 null")
	}
}

// 头条分支只允许用 body_text / topics / images 等结构化字段渲染，禁止注入 article_html 原文。
func TestPublicPreviewPageViewToutiaoCompatible(t *testing.T) {
	data := &publicPreviewData{
		Platform:      "toutiao",
		ContentFormat: "micro_post",
		Title:         "头条审阅标题",
		AccountName:   "测试头条",
		BodyText:      "第一段正文。\n\n第二段正文。",
		Topics:        []string{"#话题一", "话题二"},
		Images:        []previewImage{{URL: "/api/v1/public-previews/x/assets/y", AltText: "配图说明"}},
	}
	view := buildPublicPreviewPageView(data, "x")
	if !view.IsToutiao || !view.IsMicroPost {
		t.Fatalf("头条视图标记错误：%+v", view)
	}
	if len(view.Paragraphs) != 2 || view.Paragraphs[0] != "第一段正文。" {
		t.Fatalf("头条正文段落 = %#v", view.Paragraphs)
	}
	if len(view.Topics) != 2 || view.Topics[0] != "话题一" {
		t.Fatalf("头条话题 = %#v", view.Topics)
	}
	var buf bytes.Buffer
	if err := publicPreviewPageTemplate.Execute(&buf, view); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	for _, want := range []string{"今日头条 · 微头条", "头条审阅标题", "第一段正文", "#话题一", "配图说明"} {
		if !strings.Contains(html, want) {
			t.Fatalf("头条预览页缺少 %q：%s", want, html)
		}
	}
}
