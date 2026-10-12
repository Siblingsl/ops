package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"ops/internal/ai"
	"ops/internal/mock"
)

func opt19CircuitServer(now *time.Time) *Server {
	return &Server{now: func() time.Time { return *now }, aiHTTP: &http.Client{Timeout: time.Second}, firstTokenTimeout: time.Second,
		providerCircuits: map[uuid.UUID]*providerCircuit{}}
}

func TestOPT19ProviderCircuitFastFailureAndRecovery(t *testing.T) {
	now := time.Now()
	s := opt19CircuitServer(&now)
	var calls atomic.Int32
	var down atomic.Bool
	down.Store(true)
	model := (&mock.LLM{}).Handler()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if down.Load() {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":{"message":"local test outage"}}`))
			return
		}
		model.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	rt := &route{ProviderID: uuid.New(), BaseURL: upstream.URL + "/v1", APIKey: "local-test-key", Model: "mock-fast"}
	call := func() error {
		streamed := false
		_, _, err := s.callModel(context.Background(), rt, &ContextPack{System: "只使用人工提供的内容", User: "人工正文"}, false, nil, &streamed)
		return err
	}
	for i := 0; i < 3; i++ {
		var upstreamError *ai.UpstreamError
		if err := call(); !errors.As(err, &upstreamError) || upstreamError.Status != 500 {
			t.Fatalf("call %d: %v", i+1, err)
		}
	}
	start := time.Now()
	err := call()
	elapsed := time.Since(start)
	var unavailable *APIError
	if !errors.As(err, &unavailable) || unavailable.Code != "ai_provider_unavailable" || !strings.Contains(unavailable.Message, "约 60 秒后恢复") || elapsed >= time.Second || calls.Load() != 3 {
		t.Fatalf("fourth call: err=%v elapsed=%s upstream=%d", err, elapsed, calls.Load())
	}
	t.Logf("HTTP 500 x3; fourth request=%s, upstream calls=%d", elapsed, calls.Load())
	down.Store(false)
	now = now.Add(59 * time.Second)
	if call() == nil || calls.Load() != 3 {
		t.Fatal("probe before 60 seconds")
	}
	now = now.Add(time.Second)
	if err := call(); err != nil || calls.Load() != 4 {
		t.Fatalf("60-second recovery: %v calls=%d", err, calls.Load())
	}
	if state, _ := s.providerCircuitStatus(rt.ProviderID); state != "closed" {
		t.Fatalf("after recovery: %s", state)
	}
}

func TestOPT19WindowSuccessAndCancellation(t *testing.T) {
	now := time.Now()
	s := opt19CircuitServer(&now)
	id := uuid.New()
	fail := &ai.UpstreamError{Status: 500, Body: "local outage"}
	attempt := func(ctx context.Context, err error) {
		a, beginErr := s.beginProviderCall(id)
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		s.finishProviderCall(id, a, ctx, err)
	}
	attempt(context.Background(), fail)
	attempt(context.Background(), fail)
	now = now.Add(61 * time.Second)
	attempt(context.Background(), fail)
	if state, _ := s.providerCircuitStatus(id); state != "closed" {
		t.Fatal("expired failures were counted")
	}
	attempt(context.Background(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 3; i++ {
		attempt(ctx, context.Canceled)
		attempt(context.Background(), &ai.UpstreamError{Status: 401})
		attempt(context.Background(), &ai.UpstreamError{Status: 400})
	}
	if state, _ := s.providerCircuitStatus(id); state != "closed" {
		t.Fatal("cancellation/input/auth error opened circuit")
	}
	for i := 0; i < 3; i++ {
		attempt(context.Background(), fail)
	}
	if state, _ := s.providerCircuitStatus(id); state != "open" {
		t.Fatal("three fresh failures did not open circuit")
	}
	if state, _ := s.providerCircuitStatus(uuid.New()); state != "closed" {
		t.Fatal("other provider affected")
	}
}

func TestOPT19SingleProbeAndOldCallsCannotClose(t *testing.T) {
	now := time.Now()
	s := opt19CircuitServer(&now)
	id := uuid.New()
	old, _ := s.beginProviderCall(id)
	fail := &ai.UpstreamError{Status: 500, Body: "local outage"}
	for i := 0; i < 3; i++ {
		a, _ := s.beginProviderCall(id)
		s.finishProviderCall(id, a, context.Background(), fail)
	}
	now = now.Add(time.Minute)
	probe, err := s.beginProviderCall(id)
	if err != nil || !probe.probe {
		t.Fatalf("probe: %v", err)
	}
	var wg sync.WaitGroup
	var rejected atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.beginProviderCall(id); err != nil {
				rejected.Add(1)
			}
		}()
	}
	wg.Wait()
	if rejected.Load() != 8 {
		t.Fatalf("concurrent probes: rejected=%d", rejected.Load())
	}
	s.finishProviderCall(id, old, context.Background(), nil)
	s.finishProviderCall(id, probe, context.Background(), fail)
	if state, seconds := s.providerCircuitStatus(id); state != "open" || seconds != 60 {
		t.Fatalf("failed probe: %s %d", state, seconds)
	}
	now = now.Add(time.Minute)
	probe, _ = s.beginProviderCall(id)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.finishProviderCall(id, probe, ctx, ctx.Err())
	probe, err = s.beginProviderCall(id)
	if err != nil || !probe.probe {
		t.Fatalf("cancelled probe not released: %v", err)
	}
	s.finishProviderCall(id, probe, context.Background(), nil)
	s.finishProviderCall(id, old, context.Background(), fail)
	if state, _ := s.providerCircuitStatus(id); state != "closed" {
		t.Fatalf("old call reopened: %s", state)
	}
}

func TestOPT19APIStateFallbackAndWorkspaceIsolation(t *testing.T) {
	guest := env.registerClient(t, "opt19-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	account, _ := v4Account(t, "故障验收账号")
	var work Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/works", map[string]string{"title": "供应商故障验收"}, &work)
	var providers []Provider
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &providers)
	healthy := providers[0]
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":{"message":"local outage"}}`))
	}))
	defer upstream.Close()
	env.reauth(t)
	var broken Provider
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{"name": "持续500验收", "base_url": upstream.URL + "/v1", "api_key": "local-opt19-key", "models": []string{"mock-fast"}}, &broken)
	route := map[string]any{"task_type": "tag_suggest", "provider_id": broken.ID, "model": "mock-fast"}
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []any{route}, nil)
	path := "/api/v1/works/" + work.ID.String() + "/tag-suggest"
	for i := 0; i < 3; i++ {
		env.expectErr(t, "POST", path, nil, "ai_upstream_error")
	}
	start := time.Now()
	status, body := env.do("POST", path, nil)
	elapsed := time.Since(start)
	var got apiError
	_ = json.Unmarshal(body, &got)
	if status != 503 || got.Error.Code != "ai_provider_unavailable" || !strings.Contains(got.Error.Message, "供应商暂不可用") || elapsed >= time.Second || calls.Load() != 3 {
		t.Fatalf("fourth HTTP: %d %s duration=%s calls=%d", status, body, elapsed, calls.Load())
	}
	t.Logf("fourth complete HTTP=%s; 503 Chinese error; upstream calls=%d", elapsed, calls.Load())
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &providers)
	found := false
	for _, p := range providers {
		if p.ID == broken.ID {
			found = p.CircuitState == "open" && p.RetryAfter > 0 && p.RetryAfter <= 60
		}
	}
	if !found {
		t.Fatal("provider state missing")
	}
	route["fallback_provider_id"], route["fallback_model"] = healthy.ID, "mock-fast"
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []any{route}, nil)
	env.mustJSON(t, "POST", path, nil, nil)
	if calls.Load() != 3 {
		t.Fatal("open primary contacted during fallback")
	}
	var successes int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM ai_call WHERE work_id=$1 AND provider=$2 AND status='ok'`, work.ID, healthy.Name).Scan(&successes); err != nil || successes != 1 {
		t.Fatalf("fallback success=%d err=%v", successes, err)
	}
	other := env.registerClient(t, "opt19-other-"+uuid.NewString()[:8], testPassword)
	env.mustJSON(t, "GET", "/api/v1/model-providers", nil, &providers)
	for _, p := range providers {
		if p.ID == broken.ID || p.CircuitState != "closed" {
			t.Fatal("other workspace affected")
		}
	}
	other.restore(env)
}
