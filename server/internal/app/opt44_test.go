package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestOPT44TitlesUseStyleRecentAndStrongFeaturesAndRetryOnce(t *testing.T) {
	guest := env.registerClient(t, "opt44-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "标题质量模拟号"}, &a)
	path := "/api/v1/accounts/" + a.ID.String()
	summary := "作者风格摘要：先给结论，语气克制，短句解释事实。"
	env.mustJSON(t, "PUT", path+"/profile", map[string]any{"style_summary": summary, "banned_words": []string{"夸张禁用词"}}, nil)
	env.mustJSON(t, "POST", path+"/style-samples", map[string]string{"title": "完整样本", "content_md": "完整风格样本正文不可进入本次标题请求"}, nil)
	var recent []string
	for i := 0; i < 5; i++ {
		var history Work
		title := string(rune('甲'+i)) + "平静描述日常安排"
		reads := 10
		if i == 0 {
			title, reads = "7个问题，如何行动？", 1000
		}
		recent = append(recent, title)
		env.mustJSON(t, "POST", path+"/works", map[string]string{"title": title}, &history)
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot(work_id,captured_at,reads) VALUES($1,now(),$2)`, history.ID, reads); err != nil {
			t.Fatal(err)
		}
	}
	work := outlinedWork(t, a, "写出有依据的标题")
	var requests []string
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct{ Messages []struct{ Content string } }
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			w.WriteHeader(400)
			return
		}
		var prompt strings.Builder
		for _, message := range request.Messages {
			prompt.WriteString(message.Content + "\n")
		}
		requests = append(requests, prompt.String())
		text := []string{"先核对材料", "理解读者的问题", "把步骤说清楚", "从经验说起", "留一点思考空间"}
		if calls.Add(1) == 1 {
			text[0], text[1] = strings.Repeat("长", 33), strings.Repeat("超", 34)
		}
		titles := []map[string]string{}
		for _, value := range text {
			titles = append(titles, map[string]string{"text": value, "style": "克制"})
		}
		raw, _ := json.Marshal(map[string]any{"titles": titles})
		frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": string(raw)}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "标题质量模拟模型", "base_url": model.URL + "/v1", "api_key": "opt44-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "title", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
	var result struct {
		Titles []struct {
			Text      string
			Chars     int
			OverLimit bool `json:"over_limit"`
		} `json:"titles"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/titles", nil, &result)
	if calls.Load() != 2 || len(result.Titles) < 5 {
		t.Fatalf("calls=%d result=%+v", calls.Load(), result)
	}
	for _, title := range result.Titles {
		if title.OverLimit || title.Chars > 32 || strings.Contains(title.Text, "夸张禁用词") {
			t.Fatalf("invalid candidate: %+v", title)
		}
	}
	for _, prompt := range requests {
		if !strings.Contains(prompt, summary) || strings.Contains(prompt, "完整风格样本正文") || !strings.Contains(prompt, "本号读者对以下特征反馈更好") || !strings.Contains(prompt, "含数字") || !strings.Contains(prompt, "提问式") {
			t.Fatalf("style/strong feature context: %s", prompt)
		}
		for _, title := range recent {
			if !strings.Contains(prompt, title) {
				t.Fatalf("recent title missing: %s", title)
			}
		}
	}
	if !strings.Contains(requests[1], "2 条超过 32 字") || !strings.Contains(requests[1], "只输出修正后的 JSON") {
		t.Fatal("retry missing precise reason")
	}
}

func TestOPT44BannedCandidatesFilteredAndInvalidOutputStopsAfterTwoCalls(t *testing.T) {
	for _, enough := range []bool{true, false} {
		t.Run(fmt.Sprint(enough), func(t *testing.T) {
			guest := env.registerClient(t, "opt44-"+uuid.NewString()[:8], testPassword)
			t.Cleanup(func() { guest.restore(env) })
			var a Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "content_format": "image_note", "name": "标题过滤模拟号"}, &a)
			env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/profile", map[string]any{"banned_words": []string{"夸张禁用词"}}, nil)
			env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/style-samples", map[string]string{"title": "不能回退的样本", "content_md": "未生成摘要时也不读取本段完整风格样本"}, nil)
			work := outlinedWork(t, a, "标题过滤测试观点")
			var calls atomic.Int32
			model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var request struct{ Messages []struct{ Content string } }
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					w.WriteHeader(400)
					return
				}
				for _, message := range request.Messages {
					if strings.Contains(message.Content, "未生成摘要时也不读取") {
						t.Error("full style fallback used")
					}
				}
				titles := []map[string]string{{"text": "夸张禁用词不应返回"}, {"text": strings.Repeat("长", 21)}, {"text": " "}}
				if enough {
					for _, text := range []string{"观察手边的事实", "说清楚自己的经历", "把行动拆成小步", "从读者问题出发", "先想明白再动手"} {
						titles = append(titles, map[string]string{"text": text})
					}
				}
				raw, _ := json.Marshal(map[string]any{"titles": titles})
				frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": string(raw)}}}})
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
			}))
			t.Cleanup(model.Close)
			var provider Provider
			env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "候选过滤模拟模型", "base_url": model.URL + "/v1", "api_key": "opt44-local-mock-key", "models": []string{"mock-writer"}}, &provider)
			env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "title", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
			path := "/api/v1/works/" + work.ID.String() + "/titles"
			if enough {
				var response struct {
					Titles []struct {
						Text  string
						Chars int
					} `json:"titles"`
				}
				env.mustJSON(t, "POST", path, nil, &response)
				if calls.Load() != 1 || len(response.Titles) != 5 {
					t.Fatalf("valid filtered result: %+v calls=%d", response, calls.Load())
				}
				for _, title := range response.Titles {
					if title.Chars > 20 || strings.Contains(title.Text, "夸张禁用词") {
						t.Fatalf("invalid: %+v", title)
					}
				}
			} else {
				env.expectErr(t, "POST", path, nil, "ai_output_invalid")
				if calls.Load() != 2 {
					t.Fatalf("retry count: %d", calls.Load())
				}
			}
		})
	}
}
