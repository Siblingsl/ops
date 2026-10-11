package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func opt04Stream(ctx context.Context, path, csrf string) <-chan sseEvent {
	out := make(chan sseEvent, 4096)
	go func() {
		defer close(out)
		req, _ := http.NewRequestWithContext(ctx, "POST", env.http.URL+path, bytes.NewBufferString("{}"))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-CSRF-Token", csrf)
		rsp, err := env.client.Do(req)
		if err != nil {
			b, _ := json.Marshal(map[string]string{"message": err.Error()})
			out <- sseEvent{Name: "error", Data: b}
			return
		}
		defer rsp.Body.Close()
		scanner := bufio.NewScanner(rsp.Body)
		scanner.Buffer(make([]byte, 65536), 1<<20)
		var event sseEvent
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				event.Name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				event.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
			case line == "" && event.Name != "":
				out <- event
				event = sseEvent{}
			}
		}
		if err := scanner.Err(); err != nil {
			b, _ := json.Marshal(map[string]string{"message": err.Error()})
			out <- sseEvent{Name: "error", Data: b}
		}
	}()
	return out
}

func opt04Wait(t *testing.T, events <-chan sseEvent, name, stage string) sseEvent {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event, open := <-events:
			if !open {
				t.Fatal("stream ended before expected event")
			}
			if event.Name == "error" && name != "error" {
				t.Fatalf("stream error: %s", event.Data)
			}
			if event.Name == name && (stage == "" || strings.Contains(string(event.Data), `"stage":"`+stage+`"`)) {
				return event
			}
		case <-timer.C:
			t.Fatalf("no %s/%s event", name, stage)
		}
	}
}

func TestOPT04ConcurrentDraftsQueueAndBoundModelRequests(t *testing.T) {
	guest := env.registerClient(t, "opt04-stream", testPassword)
	defer guest.restore(env)
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{
		"platform": "wechat_mp", "name": "流式并发验证", "content_format": "long_article",
	}, &a)
	work := outlinedWork(t, a, "一次只做好一件事，这是我的经验判断")
	oldWorkers := env.srv.cfg.AIWorkers
	env.srv.cfg.AIWorkers = 1
	defer func() { env.srv.cfg.AIWorkers = oldWorkers }()
	var active, peak, calls atomic.Int32
	started := make(chan struct{}, 2)
	gate := make(chan struct{}, 2)
	model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/chat/completions" {
			calls.Add(1)
			n := active.Add(1)
			defer active.Add(-1)
			for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
			}
			started <- struct{}{}
			select {
			case <-gate:
			case <-r.Context().Done():
				return
			}
		}
		env.llm.Handler().ServeHTTP(w, r)
	}))
	defer model.Close()
	defer close(gate)
	var provider struct{ ID uuid.UUID }
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "并发验收模拟模型", "base_url": model.URL + "/v1", "api_key": "opt04-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{
		{"task_type": "default", "provider_id": provider.ID, "model": "mock-writer"},
	}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	first := opt04Stream(ctx, "/api/v1/sections/"+work.Sections[0].ID.String()+"/draft", env.csrf)
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("first model request did not start")
	}
	second := opt04Stream(ctx, "/api/v1/sections/"+work.Sections[1].ID.String()+"/draft", env.csrf)
	jobEvent := opt04Wait(t, second, "job", "")
	var job struct{ ID uuid.UUID }
	if err := json.Unmarshal(jobEvent.Data, &job); err != nil {
		t.Fatal(err)
	}
	opt04Wait(t, second, "stage", "queued")
	var status string
	var startedAt *time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT status,started_at FROM ai_job WHERE id=$1`, job.ID).Scan(&status, &startedAt); err != nil || status != "queued" || startedAt != nil {
		t.Fatalf("waiting job: status=%s started=%v err=%v", status, startedAt, err)
	}
	if calls.Load() != 1 || active.Load() != 1 {
		t.Fatalf("second model ran while queued: calls=%d active=%d", calls.Load(), active.Load())
	}
	gate <- struct{}{}
	opt04Wait(t, first, "done", "")
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("second model did not start after first completion")
	}
	gate <- struct{}{}
	opt04Wait(t, second, "done", "")
	if peak.Load() != 1 || calls.Load() != 2 {
		t.Fatalf("peak=%d calls=%d", peak.Load(), calls.Load())
	}
	var saved Work
	env.mustJSON(t, "GET", "/api/v1/works/"+work.ID.String(), nil, &saved)
	for _, section := range saved.Sections {
		if strings.TrimSpace(section.ContentMD) == "" {
			t.Fatalf("section %s was not saved", section.ID)
		}
	}
	t.Logf("AIWorkers=1; peak in-flight model requests=%d; both sections saved", peak.Load())
}

func TestOPT04QueuedTimeoutAndCancellationReleaseNoSlot(t *testing.T) {
	ctx := v4Context(t, env.accounts(t).wechat)
	ws := ident(ctx).WorkspaceID
	s := env.srv
	oldTimeout := s.aiQueueTimeout
	if oldTimeout != time.Minute {
		t.Fatalf("queue timeout default=%s", oldTimeout)
	}
	s.jobMu.Lock()
	oldSem := s.jobSems[ws]
	sem := make(chan struct{}, 1)
	s.jobSems[ws] = sem
	s.jobMu.Unlock()
	defer func() {
		s.aiQueueTimeout = oldTimeout
		s.jobMu.Lock()
		if oldSem == nil {
			delete(s.jobSems, ws)
		} else {
			s.jobSems[ws] = oldSem
		}
		s.jobMu.Unlock()
	}()
	sem <- struct{}{}
	s.aiQueueTimeout = 50 * time.Millisecond
	queued := false
	_, err := s.waitAIWorker(ctx, func() { queued = true })
	var ae *APIError
	if !queued || !errors.As(err, &ae) || ae.Code != "ai_queue_timeout" || ae.Status != 503 || len(sem) != 1 {
		t.Fatalf("queue timeout: queued=%v err=%v occupied=%d", queued, err, len(sem))
	}
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.waitAIWorker(cancelCtx, func() {})
	if !errors.Is(err, context.Canceled) || len(sem) != 1 {
		t.Fatalf("cancelled waiter took a slot: %v occupied=%d", err, len(sem))
	}
	<-sem
	release, err := s.waitAIWorker(ctx, func() { t.Error("free worker should not queue") })
	if err != nil {
		t.Fatal(err)
	}
	release()
	if len(sem) != 0 {
		t.Fatal("worker slot was not released")
	}

	sem <- struct{}{}
	var before, after int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	rsp := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/opt04-ephemeral", nil).WithContext(ctx)
	if err := s.streamAIEphemeral(rsp, req, aiTask{Type: "section_continue", Account: &env.accounts(t).wechat}, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rsp.Body.String(), `"stage":"queued"`) || !strings.Contains(rsp.Body.String(), `"code":"ai_queue_timeout"`) {
		t.Fatalf("ephemeral bypassed queue: %s", rsp.Body)
	}
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call`).Scan(&after); err != nil || after != before {
		t.Fatalf("queued ephemeral called model: %d -> %d err=%v", before, after, err)
	}
	<-sem
}
