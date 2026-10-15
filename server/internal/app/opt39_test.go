package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func opt39Work(t *testing.T, title string) Work {
	t.Helper()
	a := env.accounts(t).wechat
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": title}, &work)
	return work
}

func TestOPT39AltTextIsSavedAndListed(t *testing.T) {
	work := opt39Work(t, "OPT39 图片替代文字")
	asset := env.upload(t, work.ID.String(), testPNG(32, 24))
	var before Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &before)
	var updated []Asset
	env.mustJSON(t, "PATCH", "/api/v1/assets/"+asset.ID.String(), map[string]string{"alt_text": "  一只猫坐在窗边  "}, &updated)
	if len(updated) != 1 || updated[0].ID != asset.ID || updated[0].AltText != "一只猫坐在窗边" {
		t.Fatalf("updated assets = %+v", updated)
	}
	var listed []LibraryAsset
	env.mustJSON(t, "GET", "/api/v1/assets?work_id="+work.ID.String(), nil, &listed)
	found := false
	for _, item := range listed {
		if item.ID == asset.ID {
			found = true
			if item.AltText != "一只猫坐在窗边" {
				t.Fatalf("library alt_text = %q", item.AltText)
			}
		}
	}
	if !found {
		t.Fatal("updated image is missing from the library")
	}
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &after)
	if after.Revision <= before.Revision {
		t.Fatalf("alt text edit did not advance revision: %d -> %d", before.Revision, after.Revision)
	}
	var previewLink struct {
		Token string `json:"token"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/preview-link", nil, &previewLink)
	var preview struct {
		Assets []struct {
			ID      string `json:"id"`
			AltText string `json:"alt_text"`
		} `json:"assets"`
	}
	env.mustJSON(t, "GET", "/api/v1/public-previews/"+previewLink.Token, nil, &preview)
	found = false
	for _, item := range preview.Assets {
		if item.ID == asset.ID.String() && item.AltText == "一只猫坐在窗边" {
			found = true
		}
	}
	if !found {
		t.Fatalf("public preview omitted saved alt_text: %+v", preview.Assets)
	}

	dst := opt39Work(t, "OPT39 复用替代文字")
	var copied Asset
	env.mustJSON(t, "POST", "/api/v1/works/"+dst.ID.String()+"/assets/reuse", map[string]string{"asset_id": asset.ID.String()}, &copied)
	if copied.AltText != "一只猫坐在窗边" {
		t.Fatalf("reused asset lost alt_text: %+v", copied)
	}
}

func TestOPT39AltSuggestionUsesVisionRouteWithoutSaving(t *testing.T) {
	work := opt39Work(t, "OPT39 AI 替代文字")
	asset := env.upload(t, work.ID.String(), testPNG(24, 24))
	type modelPart struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	received := make(chan []modelPart, 1)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var request struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		for _, message := range request.Messages {
			if message.Role != "user" {
				continue
			}
			var parts []modelPart
			if err := json.Unmarshal(message.Content, &parts); err != nil {
				http.Error(w, "expected multimodal user content", http.StatusBadRequest)
				return
			}
			received <- parts
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		env.llm.Handler().ServeHTTP(w, r)
	}))
	defer model.Close()
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "OPT39 视觉模拟模型", "base_url": model.URL + "/v1", "api_key": "opt39-local-mock-key", "models": []string{"mock-vision"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "metric_screenshot", "provider_id": provider.ID, "model": "mock-vision"}}, nil)

	var result struct {
		Suggestion string `json:"suggestion"`
	}
	env.mustJSON(t, "POST", "/api/v1/assets/"+asset.ID.String()+"/alt-suggestion", nil, &result)
	if strings.TrimSpace(result.Suggestion) == "" {
		t.Fatal("AI suggestion is empty")
	}
	var parts []modelPart
	select {
	case parts = <-received:
	case <-time.After(5 * time.Second):
		t.Fatal("image_alt did not use the configured metric_screenshot vision route")
	}
	var text string
	var images []string
	for _, part := range parts {
		if part.Type == "text" {
			text = part.Text
		}
		if part.Type == "image_url" {
			images = append(images, part.ImageURL.URL)
		}
	}
	if !strings.Contains(text, "替代文字") || !strings.Contains(text, "只输出") {
		t.Fatalf("vision request omitted the alt-text instruction: %q", text)
	}
	if len(images) != 1 || !strings.HasPrefix(images[0], "data:image/") {
		t.Fatalf("vision request images = %v", images)
	}
	var listed []LibraryAsset
	env.mustJSON(t, "GET", "/api/v1/assets?work_id="+work.ID.String(), nil, &listed)
	for _, item := range listed {
		if item.ID == asset.ID && item.AltText != "" {
			t.Fatalf("AI suggestion was saved without confirmation: %q", item.AltText)
		}
	}
}
