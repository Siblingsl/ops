package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func opt37CreateWork(t *testing.T, title string) Work {
	t.Helper()
	a := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title}, &work)
	_, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_section (work_id,position,heading,content_md) VALUES ($1,0,'扫码预览','手机上也能检查排版')`, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	return work
}

func opt37PreviewToken(t *testing.T, workID uuid.UUID) (string, time.Time) {
	t.Helper()
	var link struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+workID.String()+"/preview-link", nil, &link)
	if link.Token == "" || link.ExpiresAt.IsZero() {
		t.Fatal("preview-link response must include token and expiry")
	}
	return link.Token, link.ExpiresAt
}

func opt37AnonymousGet(t *testing.T, path string) *http.Response {
	t.Helper()
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(env.http.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestOPT37PreviewLinkIsReadOnlyAndExpires(t *testing.T) {
	work := opt37CreateWork(t, "OPT37 手机扫码预览")
	now := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	oldNow := env.srv.now
	env.srv.now = func() time.Time { return now }
	t.Cleanup(func() { env.srv.now = oldNow })
	token, expiresAt := opt37PreviewToken(t, work.ID)
	if !expiresAt.Equal(now.Add(24 * time.Hour)) {
		t.Fatalf("expiry = %s, want %s", expiresAt, now.Add(24*time.Hour))
	}

	resp := opt37AnonymousGet(t, "/api/v1/public-previews/"+token)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("anonymous preview: %d %s", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", resp.Header.Get("Cache-Control"))
	}
	if resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", resp.Header.Get("Referrer-Policy"))
	}
	var got struct {
		Title       string `json:"title"`
		AccountName string `json:"account_name"`
		Theme       string `json:"theme"`
		Sections    []struct {
			Heading   string `json:"heading"`
			ContentMD string `json:"content_md"`
		} `json:"sections"`
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Title != "OPT37 手机扫码预览" || got.AccountName != "测试公众号" || got.Theme != work.Theme {
		t.Fatalf("preview metadata = %#v", got)
	}
	if len(got.Sections) != 1 || got.Sections[0].Heading != "扫码预览" || got.Sections[0].ContentMD != "手机上也能检查排版" {
		t.Fatalf("preview sections = %#v", got.Sections)
	}
	if strings.Contains(string(body), `"status"`) || strings.Contains(string(body), `"wechat_fields"`) {
		t.Fatalf("public response contains non-preview work fields: %s", body)
	}
	dot := strings.LastIndexByte(token, '.')
	tamperedSignature := []byte(token[dot+1:])
	if tamperedSignature[0] == 'A' {
		tamperedSignature[0] = 'B'
	} else {
		tamperedSignature[0] = 'A'
	}
	invalid := opt37AnonymousGet(t, "/api/v1/public-previews/"+token[:dot+1]+string(tamperedSignature))
	defer invalid.Body.Close()
	if invalid.StatusCode != http.StatusNotFound {
		t.Fatalf("tampered preview status = %d, want 404", invalid.StatusCode)
	}

	unauthenticated := &http.Client{Timeout: 10 * time.Second}
	request, _ := http.NewRequest(http.MethodPost, env.http.URL+"/api/v1/works/"+work.ID.String()+"/preview-link", strings.NewReader(`{}`))
	request.Header.Set("Content-Type", "application/json")
	createResp, err := unauthenticated.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	createResp.Body.Close()
	if createResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous link creation status = %d, want 401", createResp.StatusCode)
	}

	env.srv.now = func() time.Time { return now.Add(24 * time.Hour) }
	expired := opt37AnonymousGet(t, "/api/v1/public-previews/"+token)
	defer expired.Body.Close()
	if expired.StatusCode != http.StatusGone {
		body, _ := io.ReadAll(expired.Body)
		t.Fatalf("expired preview: %d %s", expired.StatusCode, body)
	}
}

func TestOPT37PreviewAssetIsScopedToLinkedWork(t *testing.T) {
	first := opt37CreateWork(t, "OPT37 图片所属作品")
	second := opt37CreateWork(t, "OPT37 另一个作品")
	asset := env.upload(t, first.ID.String(), testPNG(8, 8))
	firstToken, _ := opt37PreviewToken(t, first.ID)
	secondToken, _ := opt37PreviewToken(t, second.ID)
	path := "/api/v1/public-previews/%s/assets/%s"

	allowed := opt37AnonymousGet(t, fmt.Sprintf(path, firstToken, asset.ID.String()))
	defer allowed.Body.Close()
	if allowed.StatusCode != http.StatusOK || !strings.HasPrefix(allowed.Header.Get("Content-Type"), "image/") {
		body, _ := io.ReadAll(allowed.Body)
		t.Fatalf("linked work asset: %d %q %s", allowed.StatusCode, allowed.Header.Get("Content-Type"), body)
	}

	denied := opt37AnonymousGet(t, fmt.Sprintf(path, secondToken, asset.ID.String()))
	defer denied.Body.Close()
	if denied.StatusCode != http.StatusNotFound {
		t.Fatalf("other work asset status = %d, want 404", denied.StatusCode)
	}
}
