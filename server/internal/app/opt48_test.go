package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func opt48Model(t *testing.T, output func() string, requests *[]string) *httptest.Server {
	t.Helper()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct{ Messages []struct{ Content string } }
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var prompt strings.Builder
		for _, message := range request.Messages {
			prompt.WriteString(message.Content)
			prompt.WriteByte('\n')
		}
		*requests = append(*requests, prompt.String())
		frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": output()}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
	}))
	t.Cleanup(model.Close)
	return model
}

func opt48Route(t *testing.T, model *httptest.Server, task string) {
	t.Helper()
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "OPT48 模拟模型", "base_url": model.URL + "/v1", "api_key": "opt48-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": task, "provider_id": provider.ID, "model": "mock-writer"}}, nil)
}

func TestOPT48RejectedTitleSamplesReachNextTitlePrompt(t *testing.T) {
	guest := env.registerClient(t, "opt48-title-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "反馈标题模拟号"}, &account)
	work := outlinedWork(t, account, "根据读者反馈调整标题表达")
	var requests []string
	titles := map[string]any{"titles": []map[string]string{{"text": "逐步整理日常工作", "style": "平实"}, {"text": "记录工作中的发现", "style": "克制"}, {"text": "把复杂任务拆小", "style": "直接"}, {"text": "先确认再开始行动", "style": "务实"}, {"text": "从实践总结方法", "style": "经验"}}}
	raw, _ := json.Marshal(titles)
	model := opt48Model(t, func() string { return string(raw) }, &requests)
	opt48Route(t, model, "title")
	for i := 1; i <= 3; i++ {
		var response struct {
			AICallID uuid.UUID `json:"ai_call_id"`
		}
		env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/titles", nil, &response)
		env.mustJSON(t, "POST", "/api/v1/ai-calls/"+response.AICallID.String()+"/feedback", map[string]any{
			"outcome": "rejected", "reason_tags": []string{"太夸张"}, "sample_text": fmt.Sprintf("夸张标题样例%d", i),
		}, nil)
	}
	var response struct {
		AICallID uuid.UUID `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/titles", nil, &response)
	if len(requests) != 4 {
		t.Fatalf("model calls=%d", len(requests))
	}
	for i := 1; i <= 3; i++ {
		if !strings.Contains(requests[3], fmt.Sprintf("夸张标题样例%d", i)) || !strings.Contains(requests[3], "太夸张") {
			t.Fatalf("rejected sample %d and reason must appear in next title request: %s", i, requests[3])
		}
	}
	if _, err := env.srv.aggregateRejectionTags(context.Background(), &account, env.srv.now().AddDate(0, 0, -60)); err != nil {
		t.Fatal(err)
	}
	var status, scope string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status,scope FROM account_memory WHERE account_id=$1 AND source='rejection' ORDER BY created_at DESC LIMIT 1`, account.ID).Scan(&status, &scope); err != nil || status != "suggested" || scope != "title" {
		t.Fatalf("repeated rejection should only create a suggested title memory: status=%q scope=%q err=%v", status, scope, err)
	}
}

func TestOPT48TopicAcceptedAndRejectedSamplesReachTopicPrompt(t *testing.T) {
	guest := env.registerClient(t, "opt48-topic-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var account Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "反馈选题模拟号"}, &account)
	var requests []string
	call := 0
	model := opt48Model(t, func() string {
		call++
		items := make([]map[string]any, 6)
		for i := range items {
			items[i] = map[string]any{"title": fmt.Sprintf("日常选题%d", i+1), "angle": "从具体做法展开", "reason": "便于实践", "audience": "普通读者", "hook": "一个小问题", "needed_materials": []string{}, "format": "long_article"}
		}
		raw, _ := json.Marshal(map[string]any{"topics": items})
		return string(raw)
	}, &requests)
	opt48Route(t, model, "topic_suggest")
	path := "/api/v1/accounts/" + account.ID.String() + "/topics/suggest"
	var first struct {
		Suggestions []topicSuggestion `json:"suggestions"`
		AICallID    uuid.UUID         `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", path, map[string]string{"direction": "复盘"}, &first)
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", map[string]any{
		"title": "作者采纳的选题原文", "angle": "从具体做法展开", "source": "ai", "ai_call_id": first.AICallID, "choice_index": 0,
	}, nil)
	var second struct {
		AICallID uuid.UUID `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", path, map[string]string{"direction": "复盘"}, &second)
	env.mustJSON(t, "POST", "/api/v1/ai-calls/"+second.AICallID.String()+"/feedback", map[string]any{
		"outcome": "rejected", "reason_tags": []string{"跑题"}, "sample_text": "作者拒绝的选题原文｜偏离账号方向",
	}, nil)
	var third struct {
		AICallID uuid.UUID `json:"ai_call_id"`
	}
	env.mustJSON(t, "POST", path, map[string]string{"direction": "复盘"}, &third)
	if len(requests) != 3 || !strings.Contains(requests[1], "作者采纳的选题原文") ||
		!strings.Contains(requests[2], "作者采纳的选题原文") || !strings.Contains(requests[2], "作者拒绝的选题原文") || !strings.Contains(requests[2], "跑题") {
		t.Fatalf("accepted/rejected topic samples missing from prompts: %+v", requests)
	}
}
