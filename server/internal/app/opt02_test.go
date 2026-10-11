package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func opt02Account(t *testing.T) (Account, string) {
	t.Helper()
	guest := env.registerClient(t, "opt02-"+uuid.NewString()[:8], testPassword)
	t.Cleanup(func() { guest.restore(env) })
	a, path := v4Account(t, "推荐事务验收")
	options, _ := positioningOptions(t, path)
	f := options[0].StrategyFields
	f.DailySettings = map[string]any{"generate": "off"}
	env.mustJSON(t, "POST", path+"/strategy", f, nil)
	return a, path
}

func opt02Model(t *testing.T, wait func(http.ResponseWriter, *http.Request)) {
	t.Helper()
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		wait(w, r)
		if r.Context().Err() == nil {
			env.llm.Handler().ServeHTTP(w, r)
		}
	}))
	t.Cleanup(model.Close)
	var provider struct{ ID uuid.UUID }
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "推荐延迟模拟模型", "base_url": model.URL + "/v1", "api_key": "opt02-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{
		{"task_type": "tier_quality", "provider_id": provider.ID, "model": "mock-writer"},
	}, nil)
}

func opt02FirstDelta(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"\\n\"}}]}\n\n")
	w.(http.Flusher).Flush()
}

type opt02Response struct {
	status int
	body   []byte
	err    error
}

func opt02Request(ctx context.Context, method, path string) opt02Response {
	req, err := http.NewRequestWithContext(ctx, method, env.http.URL+path, bytes.NewBufferString("{}"))
	if err != nil {
		return opt02Response{err: err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", env.csrf)
	rsp, err := env.client.Do(req)
	if err != nil {
		return opt02Response{err: err}
	}
	defer rsp.Body.Close()
	body, err := io.ReadAll(rsp.Body)
	return opt02Response{rsp.StatusCode, body, err}
}

func opt02WaitModel(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("model request did not start")
	}
}

func opt02IdleTransactions(t *testing.T) int {
	t.Helper()
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestOPT02ConcurrentGenerationCreatesOneVersion(t *testing.T) {
	for _, force := range []bool{false, true} {
		t.Run(fmt.Sprint("manual=", force), func(t *testing.T) {
			a, _ := opt02Account(t)
			started := make(chan struct{}, 2)
			gate := make(chan struct{})
			release := sync.OnceFunc(func() { close(gate) })
			opt02Model(t, func(w http.ResponseWriter, r *http.Request) {
				opt02FirstDelta(w)
				started <- struct{}{}
				select {
				case <-gate:
				case <-r.Context().Done():
				}
			})
			ctx, cancel := context.WithTimeout(v4Context(t, a), 15*time.Second)
			defer cancel()
			defer release()
			type result struct {
				d   *Daily
				err error
			}
			results := make(chan result, 2)
			for i := 0; i < 2; i++ {
				go func() {
					d, err := env.srv.generateDaily(ctx, &a, "manual", force)
					results <- result{d, err}
				}()
			}
			opt02WaitModel(t, started)
			opt02WaitModel(t, started)
			if n := opt02IdleTransactions(t); n != 0 {
				t.Errorf("idle in transaction while generating: %d", n)
			}
			release()
			var id uuid.UUID
			for i := 0; i < 2; i++ {
				r := <-results
				if r.err != nil {
					t.Fatal(r.err)
				}
				if r.d.Version != 1 || i > 0 && r.d.ID != id {
					t.Fatalf("both calls must return the winning version: %+v", r.d)
				}
				id = r.d.ID
			}
			var versions, manual int
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM daily_recommendation WHERE account_id=$1`, a.ID).Scan(&versions); err != nil || versions != 1 {
				t.Fatalf("versions=%d err=%v", versions, err)
			}
			if err := env.srv.db.QueryRow(ctx, `SELECT coalesce((SELECT manual_count FROM account_daily_claim WHERE account_id=$1 AND date=$2),0)`, a.ID, env.srv.today()).Scan(&manual); err != nil {
				t.Fatal(err)
			}
			wantManual := 0
			if force {
				wantManual = 1
			}
			if manual != wantManual {
				t.Fatalf("manual count=%d want=%d", manual, wantManual)
			}
		})
	}
}

func opt02DashboardLoad(t *testing.T, ctx context.Context, path string, perWorker int) time.Duration {
	t.Helper()
	samples := make(chan time.Duration, 4*perWorker)
	errors := make(chan string, 4*perWorker)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < perWorker; n++ {
				start := time.Now()
				r := opt02Request(ctx, "GET", path+"/dashboard")
				samples <- time.Since(start)
				if r.err != nil || r.status != 200 {
					errors <- fmt.Sprintf("dashboard: status=%d err=%v body=%s", r.status, r.err, r.body)
				}
				select {
				case <-time.After(25 * time.Millisecond):
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	wg.Wait()
	close(samples)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	var durations []time.Duration
	for d := range samples {
		durations = append(durations, d)
	}
	if len(durations) != 4*perWorker {
		t.Fatalf("dashboard samples=%d want=%d", len(durations), 4*perWorker)
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	return durations[(len(durations)*95+99)/100-1]
}

func TestOPT02SlowModelDoesNotHoldTransactionOrDelayDashboard(t *testing.T) {
	a, path := opt02Account(t)
	ctx, cancel := context.WithTimeout(v4Context(t, a), 70*time.Second)
	defer cancel()
	opt02DashboardLoad(t, ctx, path, 10)
	baseline := opt02DashboardLoad(t, ctx, path, 200)
	started := make(chan struct{}, 1)
	opt02Model(t, func(w http.ResponseWriter, r *http.Request) {
		opt02FirstDelta(w)
		started <- struct{}{}
		select {
		case <-time.After(30 * time.Second):
		case <-r.Context().Done():
		}
	})
	result := make(chan error, 1)
	go func() {
		_, err := env.srv.generateDaily(ctx, &a, "manual", true)
		result <- err
	}()
	opt02WaitModel(t, started)
	waitStart := time.Now()
	var peak atomic.Int32
	var checks atomic.Int32
	stop := make(chan struct{})
	monitorDone := make(chan struct{})
	go func() {
		defer close(monitorDone)
		for {
			var count int32
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`).Scan(&count); err != nil {
				peak.Store(-1)
				return
			}
			checks.Add(1)
			for old := peak.Load(); count > old && !peak.CompareAndSwap(old, count); old = peak.Load() {
			}
			select {
			case <-stop:
				return
			case <-time.After(time.Second):
			}
		}
	}()
	defer func() { close(stop); <-monitorDone }()
	during := opt02DashboardLoad(t, ctx, path, 200)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	degradation := (float64(during)/float64(baseline) - 1) * 100
	t.Logf("4 workers, 800 baseline/800 during requests, 25ms pacing: p95 baseline=%s during=%s degradation=%.2f%%; model wait=%s, idle peak=%d in %d samples", baseline, during, degradation, time.Since(waitStart), peak.Load(), checks.Load())
	if peak.Load() != 0 || checks.Load() < 29 {
		t.Errorf("idle in transaction peak=%d samples=%d", peak.Load(), checks.Load())
	}
	if degradation > 20 {
		t.Errorf("dashboard p95 degradation %.2f%% exceeds 20%%", degradation)
	}
}

func TestOPT02ReplaceRechecksProcessedItem(t *testing.T) {
	a, path := opt02Account(t)
	var daily Daily
	env.mustJSON(t, "POST", path+"/daily/regenerate", nil, &daily)
	started := make(chan struct{}, 1)
	gate := make(chan struct{})
	release := sync.OnceFunc(func() { close(gate) })
	opt02Model(t, func(w http.ResponseWriter, r *http.Request) {
		opt02FirstDelta(w)
		started <- struct{}{}
		select {
		case <-gate:
		case <-r.Context().Done():
		}
	})
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	itemPath := fmt.Sprintf("/api/v1/daily/%s/items/0", daily.ID)
	result := make(chan opt02Response, 1)
	go func() { result <- opt02Request(ctx, "POST", itemPath+"/replace") }()
	opt02WaitModel(t, started)
	if n := opt02IdleTransactions(t); n != 0 {
		t.Errorf("replacement holds %d idle transactions", n)
	}
	adoptCtx, adoptCancel := context.WithTimeout(ctx, time.Second)
	defer adoptCancel()
	adopted := opt02Request(adoptCtx, "POST", itemPath+"/adopt")
	if adopted.err != nil || adopted.status != 200 {
		t.Fatalf("adopt must finish while replacement waits: %+v", adopted)
	}
	release()
	r := <-result
	var ae apiError
	if err := json.Unmarshal(r.body, &ae); err != nil || r.err != nil || r.status != 409 || ae.Error.Code != "state_invalid" || !strings.Contains(ae.Error.Message, "生成期间") {
		t.Fatalf("replacement conflict: %+v body=%s err=%v", r, r.body, err)
	}
	current, err := env.srv.latestDaily(v4Context(t, a), &a, daily.Date)
	if err != nil || current.Items[0].Title != daily.Items[0].Title || current.Items[0].Action != "adopted" {
		t.Fatalf("adopted item overwritten: %+v err=%v", current, err)
	}
	var replaced int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM daily_recommendation_action WHERE recommendation_id=$1 AND action='replaced'`, daily.ID).Scan(&replaced); err != nil || replaced != 0 {
		t.Fatalf("replaced actions=%d err=%v", replaced, err)
	}
}

func TestOPT02ReplacePreservesOtherItemChanges(t *testing.T) {
	for _, index := range []int{0, 1} {
		t.Run(fmt.Sprint("concurrent item=", index), func(t *testing.T) {
			a, path := opt02Account(t)
			var daily Daily
			env.mustJSON(t, "POST", path+"/daily/regenerate", nil, &daily)
			started := make(chan struct{}, 1)
			gate := make(chan struct{})
			release := sync.OnceFunc(func() { close(gate) })
			var calls atomic.Int32
			opt02Model(t, func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) != 1 {
					return
				}
				opt02FirstDelta(w)
				started <- struct{}{}
				select {
				case <-gate:
				case <-r.Context().Done():
				}
			})
			defer release()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			result := make(chan opt02Response, 1)
			go func() { result <- opt02Request(ctx, "POST", fmt.Sprintf("/api/v1/daily/%s/items/0/replace", daily.ID)) }()
			opt02WaitModel(t, started)
			otherCtx, otherCancel := context.WithTimeout(ctx, time.Second)
			defer otherCancel()
			other := opt02Request(otherCtx, "POST", fmt.Sprintf("/api/v1/daily/%s/items/%d/replace", daily.ID, index))
			if other.err != nil || other.status != 200 {
				t.Fatalf("other item blocked: %+v", other)
			}
			var otherResult struct {
				Recommendation Daily `json:"recommendation"`
			}
			if err := json.Unmarshal(other.body, &otherResult); err != nil {
				t.Fatal(err)
			}
			release()
			r := <-result
			wantStatus := 200
			if index == 0 {
				wantStatus = 409
				var ae apiError
				if err := json.Unmarshal(r.body, &ae); err != nil || ae.Error.Code != "state_invalid" || !strings.Contains(ae.Error.Message, "生成期间") {
					t.Fatalf("same item conflict: %s err=%v", r.body, err)
				}
			}
			if r.err != nil || r.status != wantStatus {
				t.Fatalf("replace: %+v body=%s", r, r.body)
			}
			current, err := env.srv.latestDaily(v4Context(t, a), &a, daily.Date)
			if err != nil || current.Items[0].Title == daily.Items[0].Title || current.Items[index].Title != otherResult.Recommendation.Items[index].Title || current.Items[0].Primary != daily.Items[0].Primary {
				t.Fatalf("other replacement lost: %+v err=%v", current, err)
			}
			var originalFeedback int
			if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM ai_feedback WHERE ai_call_id=$1 AND outcome='regenerated'`, daily.AICallID).Scan(&originalFeedback); err != nil || originalFeedback < 1 {
				t.Fatalf("original AI feedback=%d err=%v", originalFeedback, err)
			}
		})
	}
}
