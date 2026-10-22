package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"ops/internal/ai"
)

func newDesktopCancellationTestState() (*Server, *desktopConnection, *desktopPending) {
	p := &desktopPending{
		id: uuid.New(), started: make(chan desktopResponseStart, 1),
		responseQueue: make(chan []byte, desktopInflightChunks), responseDone: make(chan struct{}),
		credits: make(chan struct{}, desktopInflightChunks), requestDone: make(chan struct{}),
		responseLimit: 1024,
	}
	c := &desktopConnection{
		control: make(chan desktopFrame, 4), done: make(chan struct{}),
		pending: map[uuid.UUID]*desktopPending{p.id: p},
	}
	return &Server{}, c, p
}

func assertDesktopCancelFrame(t *testing.T, c *desktopConnection, wantReason string) {
	t.Helper()
	select {
	case frame := <-c.control:
		var message desktopWireMessage
		if err := json.Unmarshal(frame.data, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type != "request.cancel" || message.ErrorCode != wantReason {
			t.Fatalf("unexpected cancellation frame: %#v", message)
		}
	default:
		t.Fatal("request.cancel was not sent to the desktop worker")
	}
}

func assertDesktopPendingClosed(t *testing.T, s *Server, c *desktopConnection, p *desktopPending) {
	t.Helper()
	select {
	case <-p.requestDone:
	default:
		t.Fatal("cancelled request was left open")
	}
	if s.desktopPendingOf(c, p.id) != nil {
		t.Fatal("cancelled request remained pending")
	}
}

func TestDesktopCallCancellationEmitsCancelFrame(t *testing.T) {
	t.Run("HTTP context canceled before response", func(t *testing.T) {
		s, c, p := newDesktopCancellationTestState()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		req := &http.Request{Method: http.MethodPost, Body: io.NopCloser(strings.NewReader("")), ContentLength: 0}
		if _, err := s.desktopUploadAndWait(ctx, c, p, req); !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context cancellation, got %v", err)
		}
		assertDesktopCancelFrame(t, c, "cancelled")
		assertDesktopPendingClosed(t, s, c, p)
	})

	t.Run("downstream stops reading response", func(t *testing.T) {
		s, c, p := newDesktopCancellationTestState()
		reader, writer := io.Pipe()
		p.response = writer
		p.responseQueue <- []byte("upstream response")
		if err := reader.Close(); err != nil {
			t.Fatal(err)
		}
		s.desktopPumpResponse(c, p, writer)
		assertDesktopCancelFrame(t, c, "response_consumer_closed")
		assertDesktopPendingClosed(t, s, c, p)
	})
}

func TestDesktopSlowResponseConsumerKeepsControlResponsive(t *testing.T) {
	s := &Server{now: time.Now}
	requestID := uuid.New()
	p := &desktopPending{
		id: requestID, responseStarted: true,
		responseQueue: make(chan []byte, desktopInflightChunks),
		responseDone:  make(chan struct{}), requestDone: make(chan struct{}),
		responseLimit: int64(desktopInflightChunks * desktopChunkBytes),
	}
	c := &desktopConnection{
		control: make(chan desktopFrame, 4), done: make(chan struct{}),
		pending: map[uuid.UUID]*desktopPending{requestID: p},
	}
	chunk := make([]byte, desktopChunkBytes)
	for i := 0; i < desktopInflightChunks; i++ {
		p.responseQueue <- chunk
	}

	reader, writer := io.Pipe()
	p.response = writer
	pumpDone := make(chan struct{})
	go func() {
		s.desktopPumpResponse(c, p, writer)
		close(pumpDone)
	}()
	deadline := time.Now().Add(time.Second)
	for len(p.responseQueue) == desktopInflightChunks && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := len(p.responseQueue); got != desktopInflightChunks-1 {
		t.Fatalf("slow consumer should hold one chunk at the pipe and bound the queue to %d chunks; queued=%d", desktopInflightChunks-1, got)
	}

	if err := s.desktopHandleMessage(c, []byte(`{"type":"channel.heartbeat"}`)); err != nil {
		t.Fatalf("heartbeat must remain processable while the response consumer is blocked: %v", err)
	}
	frame := <-c.control
	var heartbeat desktopWireMessage
	if err := json.Unmarshal(frame.data, &heartbeat); err != nil || heartbeat.Type != "channel.heartbeat_ack" {
		t.Fatalf("unexpected heartbeat response while response window is full: message=%+v err=%v", heartbeat, err)
	}

	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-pumpDone:
	case <-time.After(time.Second):
		t.Fatal("closing the downstream reader should release the blocked response pump")
	}
	assertDesktopCancelFrame(t, c, "response_consumer_closed")
	assertDesktopPendingClosed(t, s, c, p)
}

func TestDesktopTransportErrorsDoNotRetryAsProviderFailures(t *testing.T) {
	for _, testCase := range []struct {
		name string
		err  error
		want bool
	}{
		{name: "offline error response", err: &ai.UpstreamError{Status: http.StatusBadGateway,
			Body: `{"error":{"code":"desktop_ai_offline"}}`}},
		{name: "protocol error response", err: &ai.UpstreamError{Status: http.StatusBadGateway,
			Body: `{"error":{"code":"desktop_ai_protocol"}}`}},
		{name: "transport interruption", err: errDesktopModelTransport},
		{name: "stream rejection", err: errDesktopModelStream},
		{name: "provider server error remains retryable", err: &ai.UpstreamError{Status: http.StatusServiceUnavailable}, want: true},
		{name: "provider rate limit remains retryable", err: &ai.UpstreamError{Status: http.StatusTooManyRequests}, want: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := retryable(testCase.err); got != testCase.want {
				t.Fatalf("retryable(%v)=%v, want %v", testCase.err, got, testCase.want)
			}
		})
	}
	for _, code := range []string{"offline", "timeout", "unauthorized", "redirect", "protocol", "unknown"} {
		if mapped := desktopUpstreamErrorCode(code); !strings.HasPrefix(mapped, "desktop_ai_") {
			t.Fatalf("worker error %q has unclassified code %q", code, mapped)
		}
	}
}

func TestDesktopRequestBudgetsMatchExistingBrowserLimits(t *testing.T) {
	server := &Server{}
	newRouter := func(pattern string) chi.Router {
		router := chi.NewRouter()
		router.Use(requestReadDeadline(router))
		router.Use(server.desktopRequestContext)
		router.Post(pattern, func(w http.ResponseWriter, r *http.Request) {
			request, ok := desktopRequestOf(r.Context())
			if !ok {
				t.Error("desktop request context was not attached")
				return
			}
			modelDeadline := request.ModelDeadline
			if modelDeadline.IsZero() {
				modelDeadline = time.Time{}
			}
			if !modelDeadline.IsZero() {
				w.Header().Set("X-Model-Deadline", modelDeadline.Format(time.RFC3339Nano))
			}
		})
		return router
	}
	deviceID := uuid.NewString()
	run := func(t *testing.T, router chi.Router, target, contentType string) (time.Time, time.Time, bool) {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, target, strings.NewReader("{}"))
		req.Header.Set("X-OPS-Desktop-Device", deviceID)
		req.Header.Set("X-OPS-Desktop-Policy", "1")
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		parse := func(name string) time.Time {
			value := recorder.Header().Get(name)
			if value == "" {
				return time.Time{}
			}
			parsed, err := time.Parse(time.RFC3339Nano, value)
			if err != nil {
				t.Fatal(err)
			}
			return parsed
		}
		return parse("X-Request-Deadline"), parse("X-Model-Deadline"), recorder.Code == http.StatusOK
	}

	t.Run("ordinary JSON leaves five seconds for the browser response", func(t *testing.T) {
		router := newRouter("/api/v1/works/{id}/generate-image")
		started := time.Now()
		_, modelDeadline, ok := run(t, router, "/api/v1/works/"+uuid.NewString()+"/generate-image", "application/json")
		if !ok || modelDeadline.IsZero() {
			t.Fatal("desktop JSON request deadlines were not attached")
		}
		if got := modelDeadline.Sub(started).Round(time.Second); got != 25*time.Second {
			t.Fatalf("ordinary model deadline=%s, want 25s", got)
		}
	})

	t.Run("multipart shares the 120-second browser budget", func(t *testing.T) {
		router := newRouter("/api/v1/accounts/{accountId}/metrics/screenshots")
		started := time.Now()
		_, modelDeadline, ok := run(t, router, "/api/v1/accounts/"+uuid.NewString()+"/metrics/screenshots", "multipart/form-data; boundary=test")
		if !ok || modelDeadline.IsZero() {
			t.Fatal("desktop upload deadlines were not attached")
		}
		if got := modelDeadline.Sub(started).Round(time.Second); got != 115*time.Second {
			t.Fatalf("upload model deadline=%s, want 115s", got)
		}
	})

	t.Run("streaming jobs retain their independent model budget", func(t *testing.T) {
		for _, route := range []struct{ pattern, path string }{
			{"/api/v1/sections/{id}/draft", "/api/v1/sections/" + uuid.NewString() + "/draft"},
			{"/api/v1/agent/conversations/{id}/messages", "/api/v1/agent/conversations/" + uuid.NewString() + "/messages"},
			{"/api/v1/agent/conversations/{id}/continue", "/api/v1/agent/conversations/" + uuid.NewString() + "/continue"},
			{"/api/v1/agent/conversations/{id}/regenerate", "/api/v1/agent/conversations/" + uuid.NewString() + "/regenerate"},
			{"/api/v1/agent/conversations/{id}/messages/{messageId}/edit", "/api/v1/agent/conversations/" + uuid.NewString() + "/messages/" + uuid.NewString() + "/edit"},
		} {
			router := newRouter(route.pattern)
			_, modelDeadline, ok := run(t, router, route.path, "application/json")
			if !ok || !modelDeadline.IsZero() {
				t.Fatalf("streaming request %s inherited a short model budget: %v", route.pattern, modelDeadline)
			}
		}
	})
}

func TestInheritDesktopRequestPreservesExecutionBoundary(t *testing.T) {
	request := desktopRequest{
		DeviceID: uuid.New(), ConnectionID: uuid.New(), Generation: 4, RouteRevision: 9,
		ModelDeadline: time.Now().Add(25 * time.Second), RouteSnapshot: &desktopRouteSnapshot{},
	}
	source := withDesktopRequest(context.Background(), request)
	target := inheritDesktopRequest(source, context.Background())
	got, ok := desktopRequestOf(target)
	if !ok || got != request {
		t.Fatalf("background job must preserve the initiating desktop context: got %#v, present=%v", got, ok)
	}
	background := inheritDesktopRequestForBackground(source, context.Background())
	backgroundRequest, ok := desktopRequestOf(background)
	if !ok || !backgroundRequest.ModelDeadline.IsZero() || backgroundRequest.RouteSnapshot != request.RouteSnapshot {
		t.Fatalf("background jobs must preserve routing scope without inheriting the request deadline: %#v", backgroundRequest)
	}
	if _, ok := desktopRequestOf(inheritDesktopRequest(context.Background(), context.Background())); ok {
		t.Fatal("server-originated background jobs must not gain desktop context")
	}
}

func TestDesktopAIClientUsesRequestModelDeadline(t *testing.T) {
	now := time.Now()
	server := &Server{now: func() time.Time { return now }}
	request := desktopRequest{ModelDeadline: now.Add(25 * time.Second)}
	ctx := withDesktopRequest(context.Background(), request)
	route := &route{Desktop: &desktopExecution{Deadline: now.Add(5 * time.Minute)}}
	_, client := server.aiClientForRoute(ctx, route)
	if client.Timeout != 25*time.Second {
		t.Fatalf("desktop model client timeout=%s, want 25s", client.Timeout)
	}
}

func TestDesktopRouteSnapshotSurvivesMappingUpdateOnlyForStartedTask(t *testing.T) {
	ctx := context.Background()
	userID, workspaceID, deviceID := uuid.New(), uuid.New(), uuid.New()
	username := "desktop_snapshot_" + userID.String()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id, username, password_hash) VALUES ($1,$2,'test')`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id, name, created_by_user_id) VALUES ($1,'desktop snapshot test',$2)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device (id,user_id,public_key,name,platform) VALUES ($1,$2,$3,'test','windows-x64')`,
		deviceID, userID, make([]byte, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_route_state (workspace_id,user_id,device_id,revision) VALUES ($1,$2,$3,2)`,
		workspaceID, userID, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_route (workspace_id,user_id,device_id,task_type,execution_location,model)
		VALUES ($1,$2,$3,'default','disabled','')`, workspaceID, userID, deviceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, workspaceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM app_user WHERE id=$1`, userID)
	})

	request := desktopRequest{DeviceID: deviceID, RouteRevision: 2, RouteSnapshot: &desktopRouteSnapshot{}}
	snapshot, err := env.srv.desktopRouteSnapshotFor(ctx, request, workspaceID, userID)
	if err != nil {
		t.Fatalf("load route snapshot: %v", err)
	}
	if snapshot.routes["default"].ExecutionLocation != "disabled" {
		t.Fatalf("unexpected initial mapping: %#v", snapshot.routes)
	}
	if _, err := env.srv.db.Exec(ctx, `DELETE FROM desktop_route WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`,
		workspaceID, userID, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE desktop_route_state SET revision=3 WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`,
		workspaceID, userID, deviceID); err != nil {
		t.Fatal(err)
	}
	continued, err := env.srv.desktopRouteSnapshotFor(ctx, request, workspaceID, userID)
	if err != nil || continued.routes["default"].ExecutionLocation != "disabled" {
		t.Fatalf("started task must keep its immutable route snapshot: snapshot=%#v err=%v", continued, err)
	}
	if _, err := env.srv.desktopRouteSnapshotFor(ctx,
		desktopRequest{DeviceID: deviceID, RouteRevision: 2, RouteSnapshot: &desktopRouteSnapshot{}}, workspaceID, userID); err == nil {
		t.Fatal("new request with stale route revision must not reuse the old mapping")
	}
}

func TestDesktopUpstreamErrorDoesNotCompletePartialResponse(t *testing.T) {
	requestID := uuid.New()
	p := &desktopPending{
		id: requestID, responseStarted: true, responseDone: make(chan struct{}),
		responseQueue: make(chan []byte, 4), requestDone: make(chan struct{}), responseLimit: 1024,
	}
	p.responseQueue <- []byte("partial response")
	c := &desktopConnection{pending: map[uuid.UUID]*desktopPending{requestID: p}, done: make(chan struct{})}
	s := &Server{}

	raw := []byte(`{"type":"upstream.error","request_id":"` + requestID.String() + `","error_code":"credential_echo"}`)
	if err := s.desktopHandleMessage(c, raw); err != nil {
		t.Fatalf("upstream.error 应被接受：%v", err)
	}

	reader, writer := io.Pipe()
	p.response = writer
	go s.desktopPumpResponse(c, p, writer)
	body, err := io.ReadAll(reader)
	if string(body) != "partial response" {
		t.Fatalf("应保留已读取字节供解析器拒绝不完整响应，得到 %q", body)
	}
	if err == nil || err.Error() != "客户端模型响应被安全过滤或意外中止" {
		t.Fatalf("中止必须以读取错误结束，避免把截断响应视为成功，得到 %v", err)
	}
}

func TestDesktopUpstreamErrorRequiresHeadersAndAllowlistedCode(t *testing.T) {
	for _, tc := range []struct {
		name    string
		started bool
		code    string
	}{
		{name: "before headers", started: false, code: "credential_echo"},
		{name: "unknown code", started: true, code: "raw_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requestID := uuid.New()
			p := &desktopPending{id: requestID, responseStarted: tc.started, responseDone: make(chan struct{})}
			c := &desktopConnection{pending: map[uuid.UUID]*desktopPending{requestID: p}}
			raw := []byte(`{"type":"upstream.error","request_id":"` + requestID.String() + `","error_code":"` + tc.code + `"}`)
			if err := (&Server{}).desktopHandleMessage(c, raw); err == nil {
				t.Fatal("非法 upstream.error 应被拒绝")
			}
			select {
			case <-p.responseDone:
				t.Fatal("非法 upstream.error 不得结束响应")
			default:
			}
		})
	}
}

func TestDesktopRetryAfterRejectsUnsafeValues(t *testing.T) {
	for _, value := range []string{"", "-1", "999999", "0\r\nSet-Cookie: x=y", "not a date"} {
		if desktopRetryAfterAllowed(value) {
			t.Errorf("不应转发非法 Retry-After %q", value)
		}
	}
	if !desktopRetryAfterAllowed("30") || !desktopRetryAfterAllowed("Wed, 21 Oct 2015 07:28:00 GMT") {
		t.Fatal("应接受有限秒数和有效 HTTP 日期")
	}
	h := desktopResponseHeaders(desktopResponseStart{contentType: "application/json", retryAfter: "1\r\nX-Leak: yes"})
	if h.Get("Retry-After") != "" || h.Get("X-Leak") != "" {
		t.Fatalf("不安全的上游响应头被转发：%v", h)
	}
}

func TestDesktopControlFramesAreBoundedInBothDirections(t *testing.T) {
	c := &desktopConnection{control: make(chan desktopFrame, 1), done: make(chan struct{})}
	if err := (&Server{}).desktopSendJSON(c, desktopWireMessage{Type: "channel.heartbeat"}); err != nil {
		t.Fatalf("合法控制消息应可发送：%v", err)
	}
	if err := (&Server{}).desktopSendJSON(c, desktopWireMessage{
		Type: "request.open", Model: string(make([]byte, desktopMaxControlBytes)),
	}); err == nil {
		t.Fatal("超过 16 KiB 的控制消息必须拒绝发送")
	}
	if err := (&Server{}).desktopHandleMessage(c, make([]byte, desktopMaxControlBytes+1)); err == nil {
		t.Fatal("超过 16 KiB 的控制消息必须拒绝接收")
	}
}

func TestDesktopControlFramesAreRateLimited(t *testing.T) {
	c := &desktopConnection{}
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	for i := 0; i < desktopControlBurst; i++ {
		if !c.allowControlFrame(false, now) {
			t.Fatalf("burst 内第 %d 条控制消息不应被限流", i+1)
		}
	}
	if c.allowControlFrame(false, now) {
		t.Fatal("超过控制消息突发额度后必须限流")
	}
	if !c.allowControlFrame(false, now.Add(time.Second)) {
		t.Fatal("额度应按每秒速率恢复")
	}
}
