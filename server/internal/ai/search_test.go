package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSearchRequiresProviderEvidence(t *testing.T) {
	payload := `{"output":[{"type":"web_search_call","status":"completed"},{"type":"message","content":[{"annotations":[{"type":"url_citation","title":"真实来源","url":"https://example.com/news"}]}]}],"usage":{"input_tokens":10,"output_tokens":20}}`
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("unexpected cookie")
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer mock.Close()
	results, usage, e := Search(context.Background(), mock.Client(), mock.URL+"/responses", "test-key", "doubao-test", "查询公开资讯")
	if e != nil || len(results) != 1 || usage.PromptTokens != 10 {
		t.Fatalf("native evidence %v %v", results, e)
	}
	payload = strings.Replace(payload, `"type":"web_search_call","status":"completed"`, `"type":"reasoning","status":"completed"`, 1)
	if _, _, e = Search(context.Background(), mock.Client(), mock.URL+"/responses", "test-key", "doubao-test", "资讯"); e == nil {
		t.Fatal("model citations without completed search accepted")
	}
}
