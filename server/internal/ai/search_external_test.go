package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOPTA04SearchExternalTavily(t *testing.T) {
	payload := `{"results":[{"title":"公开热点一","url":"https://example.com/a","content":"第一段摘要"},{"title":"公开热点二","url":"https://example.com/b","content":"第二段摘要"}]}`
	var gotAuth, gotType string
	var body map[string]any
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method %s", r.Method)
		}
		gotAuth, gotType = r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer mock.Close()
	results, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "tavily", Endpoint: mock.URL, APIKey: "test-key", Query: "运营"})
	if err != nil || len(results) != 2 {
		t.Fatalf("tavily results %v %v", results, err)
	}
	if results[0].URL != "https://example.com/a" || results[0].Summary != "第一段摘要" {
		t.Fatalf("tavily result %+v", results[0])
	}
	if gotAuth != "Bearer test-key" || !strings.HasPrefix(gotType, "application/json") {
		t.Fatalf("tavily headers %q %q", gotAuth, gotType)
	}
	if body["query"] != "运营" || body["search_depth"] != "basic" || body["include_answer"] != false {
		t.Fatalf("tavily body %+v", body)
	}
}

func TestOPTA04SearchExternalBocha(t *testing.T) {
	payload := `{"data":{"webPages":{"value":[{"name":"商业观察","url":"https://example.com/bocha","snippet":"摘要内容","siteName":"示例站"}]}}}`
	var body map[string]any
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer mock.Close()
	results, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "bocha", Endpoint: mock.URL, APIKey: "bocha-key", Query: "商业"})
	if err != nil || len(results) != 1 {
		t.Fatalf("bocha results %v %v", results, err)
	}
	if results[0].SiteName != "示例站" || results[0].Summary != "摘要内容" {
		t.Fatalf("bocha result %+v", results[0])
	}
	if body["freshness"] != "oneWeek" || body["summary"] != false {
		t.Fatalf("bocha body %+v", body)
	}
}

func TestOPTA04SearchExternalSearxng(t *testing.T) {
	payload := `{"results":[{"title":"自建实例结果","url":"https://example.com/searx","content":"实例摘要"}]}`
	var query, accept, agent string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method %s", r.Method)
		}
		query, accept, agent = r.URL.Query().Get("q"), r.Header.Get("Accept"), r.Header.Get("User-Agent")
		if r.URL.Query().Get("format") != "json" {
			t.Errorf("format=%s", r.URL.Query().Get("format"))
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer mock.Close()
	results, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "searxng", Endpoint: mock.URL + "/search", APIKey: "sx-key", Query: "科技", UserAgent: "OPSReference/1.0"})
	if err != nil || len(results) != 1 || results[0].URL != "https://example.com/searx" {
		t.Fatalf("searxng results %v %v", results, err)
	}
	if query != "科技" || accept != "application/json" || agent != "OPSReference/1.0" {
		t.Fatalf("searxng request q=%q accept=%q agent=%q", query, accept, agent)
	}
}

func TestOPTA04SearchExternalHTTPErrors(t *testing.T) {
	for _, status := range []int{402, 429, 401, 403, 500} {
		body := "response-body-must-not-leak"
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}))
		_, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "tavily", Endpoint: mock.URL, APIKey: "k", Query: "q"})
		mock.Close()
		upstream, ok := err.(*SearchHTTPError)
		if !ok || upstream.Status != status {
			t.Fatalf("status %d err %v", status, err)
		}
		if strings.Contains(err.Error(), body) {
			t.Fatalf("status %d leaked response body", status)
		}
		switch status {
		case 402, 429:
			if !strings.Contains(err.Error(), "额度耗尽或触发限流") {
				t.Fatalf("status %d message %q", status, err.Error())
			}
		case 401, 403:
			if !strings.Contains(err.Error(), "认证失败或被拒绝") {
				t.Fatalf("status %d message %q", status, err.Error())
			}
		}
	}
}

func TestOPTA04SearchExternalEmptyResults(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"results":[]}`)
	}))
	defer mock.Close()
	if _, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "tavily", Endpoint: mock.URL, APIKey: "k", Query: "q"}); err == nil || !strings.Contains(err.Error(), "未返回有效公开链接结果") {
		t.Fatalf("empty results err %v", err)
	}
	if _, err := SearchExternal(context.Background(), mock.Client(), ExternalSearchRequest{Engine: "unknown", Endpoint: mock.URL, Query: "q"}); err == nil {
		t.Fatal("unknown engine accepted")
	}
}
