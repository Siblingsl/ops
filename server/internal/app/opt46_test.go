package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestOPT46TaskMemoriesAppearInModelRequestAndRefs(t *testing.T) {
	guest := env.registerClient(t, "opt46-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "content_format": "long_article", "name": "记忆映射模拟号"}, &a)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	memories := map[string]Memory{}
	for _, rule := range []struct{ key, kind, scope, text string }{
		{"all", "wording", "all", "通用偏好：短句说明过程"},
		{"draft", "structure", "draft", "正文偏好：先写结论再展开"},
		{"topic", "avoid", "topic", "选题偏好：避开重复角度"},
		{"title", "tone", "title", "标题偏好：语气克制"},
		{"fact-all", "fact", "all", "作者事实：作者在上海工作"},
		{"fact-draft", "fact", "draft", "作者事实：作者从事产品设计"},
		{"disabled", "fact", "all", "停用事实绝不能注入"},
	} {
		var m Memory
		env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/memories", map[string]string{"kind": rule.kind, "scope": rule.scope, "text": rule.text}, &m)
		memories[rule.key] = m
	}
	env.mustJSON(t, "PATCH", "/api/v1/memories/"+memories["disabled"].ID.String(), map[string]string{"status": "disabled"}, nil)
	if _, err := env.srv.suggestMemory(ctx, a.ID, "fact", "all", "待确认事实绝不能注入", "instruction", nil); err != nil {
		t.Fatal(err)
	}
	received := make(chan string, 16)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var request struct{ Messages []struct{ Content string } }
		if json.Unmarshal(raw, &request) != nil {
			w.WriteHeader(400)
			return
		}
		var prompt strings.Builder
		for _, message := range request.Messages {
			prompt.WriteString(message.Content + "\n")
		}
		received <- prompt.String()
		r.Body = io.NopCloser(bytes.NewReader(raw))
		env.llm.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "记忆映射模拟模型", "base_url": model.URL + "/v1", "api_key": "opt46-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	tasks := []string{"outline", "outline_review", "summary", "rewrite_plan", "daily_recommend", "title", "section_draft", "fact_flag", "image_suggest"}
	routes := []map[string]any{}
	for _, task := range tasks {
		routes = append(routes, map[string]any{"task_type": task, "provider_id": provider.ID, "model": "mock-writer"})
	}
	env.mustJSON(t, "PUT", "/api/v1/model-routes", routes, nil)
	for _, task := range tasks {
		res, err := env.srv.runAI(ctx, aiTask{Type: task, Account: &a, User: "只验证已确认记忆上下文"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		prompt := <-received
		var slots []Slot
		raw, _ := json.Marshal(res.Refs["slots"])
		if err := json.Unmarshal(raw, &slots); err != nil {
			t.Fatal(err)
		}
		wantScope := taskMemoryScope(task)
		for key, memory := range memories {
			want := key != "disabled" && (memory.Scope == "all" || memory.Scope == wantScope)
			if task == "fact_flag" {
				want = key != "disabled" && memory.Kind == "fact"
			}
			if strings.Contains(prompt, memory.Text) != want || slotHas(slots, "memory", memory.ID.String()) != want {
				t.Fatalf("%s memory %s want=%v", task, key, want)
			}
		}
		if strings.Contains(prompt, "待确认事实绝不能注入") {
			t.Fatalf("%s included suggested memory", task)
		}
	}
	work := outlinedWork(t, a, "请求大纲必须出现正文记忆")
	<-received // outlinedWork invokes outline once.
	var outline struct {
		Refs struct {
			Slots []Slot `json:"slots"`
		} `json:"refs"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/outline/generate", nil, &outline)
	if !slotHas(outline.Refs.Slots, "memory", memories["draft"].ID.String()) || !strings.Contains(<-received, memories["draft"].Text) {
		t.Fatal("outline endpoint lost draft memory in request/refs")
	}
}
