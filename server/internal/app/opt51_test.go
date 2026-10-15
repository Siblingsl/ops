package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func TestOPT51ModelReceivesTaskTemperaturesAndZeroOverride(t *testing.T) {
	a := opt42Account(t)
	ctx := context.Background()
	var ws uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&ws); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(ctx, ctxMember, &identity{WorkspaceID: ws})
	received := make(chan *float64, 16)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var request struct {
			Temperature *float64 `json:"temperature"`
		}
		if json.Unmarshal(raw, &request) != nil {
			w.WriteHeader(400)
			return
		}
		received <- request.Temperature
		r.Body = io.NopCloser(bytes.NewReader(raw))
		env.llm.Handler().ServeHTTP(w, r)
	}))
	t.Cleanup(model.Close)
	var provider Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "温度参数模拟模型", "base_url": model.URL + "/v1", "api_key": "opt51-local-mock-key", "models": []string{"mock-writer"}}, &provider)
	tasks := []struct {
		task string
		json bool
		want float64
	}{{"title", true, 0.9}, {"topic_suggest", true, 0.9}, {"hook_suggest", true, 0.9}, {"section_draft", false, 0.7}, {"section_edit", false, 0.7}, {"fact_flag", true, 0.2}, {"outline", true, 0.2}, {"image_suggest", false, 0.3}}
	routes := []map[string]any{}
	for _, task := range tasks {
		routes = append(routes, map[string]any{"task_type": task.task, "provider_id": provider.ID, "model": "mock-writer"})
	}
	env.mustJSON(t, "PUT", "/api/v1/model-routes", routes, nil)
	call := func(task string, jsonMode bool, want float64) {
		t.Helper()
		if _, err := env.srv.runAI(ctx, aiTask{Type: task, Account: &a, JSON: jsonMode, User: "温度请求验收"}, nil); err != nil {
			t.Fatal(err)
		}
		got := <-received
		if got == nil || *got != want {
			t.Fatalf("%s temperature=%v want=%v", task, got, want)
		}
		value, ok := env.srv.lastPacks.Load(ws.String() + "/" + task)
		if !ok {
			t.Fatal("snapshot missing")
		}
		if _, err := env.srv.runSnapshot(ctx, task, value.(evalSnapshot), "回归模板"); err != nil {
			t.Fatal(err)
		}
		if got := <-received; got == nil || *got != want {
			t.Fatalf("snapshot changed temperature: %v", got)
		}
	}
	for _, task := range tasks {
		call(task.task, task.json, task.want)
	}
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"ai_sampling": map[string]any{"temperature": 0}}, nil)
	call("title", true, 0)
	call("fact_flag", true, 0)
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"ai_sampling": map[string]any{"temperature": nil}}, nil)
	call("title", true, 0.9)
}

func TestOPT51OverrideValidationAndWorkspaceIsolation(t *testing.T) {
	opt42Account(t)
	for _, value := range []float64{-0.1, 2.1} {
		env.expectErr(t, "PUT", "/api/v1/settings", map[string]any{"ai_sampling": map[string]any{"temperature": value}}, "validation_failed")
	}
	env.mustJSON(t, "PUT", "/api/v1/settings", map[string]any{"ai_sampling": map[string]any{"temperature": 0.4}}, nil)
	var first struct {
		Sampling samplingConfig `json:"ai_sampling"`
	}
	env.mustJSON(t, "GET", "/api/v1/settings", nil, &first)
	if first.Sampling.Temperature == nil || *first.Sampling.Temperature != 0.4 {
		t.Fatal("override not persisted")
	}
	other := env.registerClient(t, "opt51-other-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	var second struct {
		Sampling samplingConfig `json:"ai_sampling"`
	}
	env.mustJSON(t, "GET", "/api/v1/settings", nil, &second)
	if second.Sampling.Temperature != nil {
		t.Fatal("override leaked between workspaces")
	}
	ws := env.wsID(t)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "PUT", "/api/v1/settings", map[string]any{"ai_sampling": map[string]any{"temperature": 0.5}}, "forbidden")
}
