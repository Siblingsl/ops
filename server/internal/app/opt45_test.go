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

func TestOPT45RetryIncludesValidationOrParseReasonAndHonoursLimit(t *testing.T) {
	for _, scenario := range []struct {
		name, first  string
		repair, fail bool
	}{
		{"missing", `{}`, false, false},
		{"parse", `{"summary":`, false, false},
		{"bracket", "```json\n{\"summary\":\"只缺右括号的摘要\"\n```", true, false},
		{"string", `{"summary":"未闭合的字符串`, false, false},
		{"always-invalid", `{}`, false, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			guest := env.registerClient(t, "opt45-"+uuid.NewString()[:8], testPassword)
			t.Cleanup(func() { guest.restore(env) })
			var a Account
			env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "纠错模拟号"}, &a)
			work := outlinedWork(t, a, "只在格式错误时做一次明确纠错")
			var calls atomic.Int32
			prompts := make(chan string, 2)
			model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Messages []struct{ Role, Content string }
				}
				if json.NewDecoder(r.Body).Decode(&request) != nil {
					w.WriteHeader(400)
					return
				}
				for _, message := range request.Messages {
					if message.Role == "user" {
						prompts <- message.Content
					}
				}
				reply := `{"summary":"按错误原因修正后的摘要"}`
				if calls.Add(1) == 1 || scenario.fail {
					reply = scenario.first
				}
				frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": reply}}}})
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
			}))
			t.Cleanup(model.Close)
			var provider Provider
			env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "JSON纠错模拟模型", "base_url": model.URL + "/v1", "api_key": "opt45-local-mock-key", "models": []string{"mock-writer"}}, &provider)
			env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "summary", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
			path := "/api/v1/works/" + work.ID.String() + "/summary"
			if scenario.fail {
				env.expectErr(t, "POST", path, nil, "ai_output_invalid")
			} else {
				var out struct{ Summary string }
				env.mustJSON(t, "POST", path, nil, &out)
				if out.Summary == "" {
					t.Fatal("empty successful summary")
				}
			}
			first := <-prompts
			if scenario.repair {
				if calls.Load() != 1 {
					t.Fatalf("bracket repair must avoid another model call: %d", calls.Load())
				}
			} else {
				second := <-prompts
				if calls.Load() != 2 || !strings.Contains(second, "上一次输出不符合要求：") || !strings.Contains(second, "只输出修正后的 JSON") || second == first {
					t.Fatalf("retry=%d prompt=%s", calls.Load(), second)
				}
				if scenario.name == "missing" && !strings.Contains(second, "摘要为空") {
					t.Fatal("missing validation reason")
				}
				if scenario.name == "parse" && !strings.Contains(second, "unexpected end of JSON input") {
					t.Fatal("missing parse reason")
				}
			}
		})
	}
}

func TestOPT45BracketRepairDoesNotInventValuesOrDropTrailingPartialItems(t *testing.T) {
	for _, text := range []string{`{"items":[{"text":"第一条"},{"text":"第二条"}`, `{"text":"包含括号 } 和转义 \"","items":[1,2`} {
		var out map[string]any
		if err := json.Unmarshal([]byte(completeJSONBrackets(text)), &out); err != nil {
			t.Fatalf("safe bracket repair: %s: %v", text, err)
		}
		if strings.Contains(text, "第二条") {
			items := out["items"].([]any)
			if len(items) != 2 || items[1].(map[string]any)["text"] != "第二条" {
				t.Fatal("last item lost")
			}
		}
	}
	for _, text := range []string{`{"text":"未闭合`, `{"number":`, `{"items":[1,`, `{"items":[1}`} {
		if json.Valid([]byte(completeJSONBrackets(text))) {
			t.Fatalf("unsafe repair accepted: %s", text)
		}
	}
}

func TestOPT45RetryCannotReuseFieldsFromFailedAttempt(t *testing.T) {
	a := opt42Account(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	var out struct {
		Summary string
		Count   int
	}
	replies := []string{`{"Summary":"旧值","Count":"类型错误"}`, `{}`}
	var calls atomic.Int32
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reply := replies[calls.Add(1)-1]
		frame, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"delta": map[string]string{"content": reply}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", frame)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "JSON字段隔离模拟模型", "base_url": model.URL + "/v1", "api_key": "opt45-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "summary", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
	_, err := env.srv.runAIJSON(ctx, aiTask{Type: "summary", Account: &a, User: "输出摘要与计数"}, &out, func() error {
		if out.Summary == "" {
			return fmt.Errorf("摘要为空")
		}
		return nil
	})
	if err == nil || out.Summary != "" || calls.Load() != 2 {
		t.Fatalf("failed field reused: %+v err=%v calls=%d", out, err, calls.Load())
	}
}
