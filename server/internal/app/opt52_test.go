package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT52TitlesAndSummaryIncludeAllHeadingsAndLastEnding(t *testing.T) {
	guest := env.registerClient(t, "opt52-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "全文取样模拟号"}, &a)
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/works", map[string]string{"title": "十段长文"}, &work)
	env.mustJSON(t, "PATCH", "/api/v1/works/"+work.ID.String(), map[string]any{"viewpoint": "各段均需要被概括", "base_revision": work.Revision}, &work)
	items := make([]OutlineItem, 10)
	for i := range items {
		items[i] = OutlineItem{Heading: fmt.Sprintf("小标题%d", i+1), KeyPoint: "作者段落要点"}
	}
	env.mustJSON(t, "PUT", "/api/v1/works/"+work.ID.String()+"/outline", map[string]any{"items": items, "confirm": true, "base_revision": work.Revision}, &work)
	for i, section := range work.Sections {
		start, end := fmt.Sprintf("第%d段开始句。", i+1), fmt.Sprintf("第%d段结尾句。", i+1)
		setSection(t, section, start+strings.Repeat("正", 800-runeLen(start)-runeLen(end))+end)
	}
	received := make(chan string, 2)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var request struct {
			Messages []struct{ Role, Content string }
		}
		if json.Unmarshal(raw, &request) != nil {
			w.WriteHeader(400)
			return
		}
		for _, message := range request.Messages {
			if message.Role == "user" {
				received <- message.Content
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		env.llm.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "首尾取样模拟模型", "base_url": model.URL + "/v1", "api_key": "opt52-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "title", "provider_id": provider.ID, "model": "mock-writer"}, {"task_type": "summary", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
	for _, path := range []string{"titles", "summary"} {
		env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/"+path, nil, nil)
		prompt := <-received
		for i, item := range items {
			if !strings.Contains(prompt, "## "+item.Heading+"\n") || !strings.Contains(prompt, fmt.Sprintf("第%d段开始句。", i+1)) || !strings.Contains(prompt, fmt.Sprintf("第%d段结尾句。", i+1)) {
				t.Fatalf("%s lost section %d", path, i+1)
			}
		}
	}
}

func TestOPT52DigestBudgetShortTextAndHeadingPreservation(t *testing.T) {
	secs := []Section{{Heading: "第一段", ContentMD: "短正文"}, {Heading: "第二段", ContentMD: strings.Repeat("长", 800) + "作者结尾"}}
	digest := bodyDigest(secs, 200)
	if runeLen(digest) > 200 || !strings.Contains(digest, "短正文") || !strings.Contains(digest, "作者结尾") {
		t.Fatalf("digest: %s", digest)
	}
	for _, budget := range []int{0, 1, 5} {
		text := bodyDigest(secs, budget)
		if !strings.Contains(text, "## 第一段") || !strings.Contains(text, "## 第二段") {
			t.Fatal("headings truncated")
		}
	}
	if bodyDigest(nil, 1500) != "" {
		t.Fatal("empty digest")
	}
}
