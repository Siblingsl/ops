package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type opt15Logs struct {
	sync.Mutex
	bytes.Buffer
}

func (b *opt15Logs) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *opt15Logs) records(t *testing.T) []map[string]any {
	t.Helper()
	b.Lock()
	defer b.Unlock()
	var records []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(b.Buffer.Bytes()), []byte("\n")) {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	return records
}
func opt15Capture(t *testing.T) *opt15Logs {
	t.Helper()
	sink := &opt15Logs{}
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(sink, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })
	return sink
}

func TestOPT15AccessLogsAndErrorCorrelation(t *testing.T) {
	sink := opt15Capture(t)
	resp := env.request("GET", "/api/v1/works/"+"00000000-0000-0000-0000-000000000000"+"?private=opt15-query-sentinel", nil, "")
	id := resp.Header.Get("X-Request-ID")
	var body struct {
		Error APIError `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if id == "" || body.Error.RequestID != id || resp.StatusCode != 404 {
		t.Fatalf("trace header/body: %s %+v", id, body)
	}
	matched := false
	for _, record := range sink.records(t) {
		if record["request_id"] != id || record["msg"] != "HTTP 请求" {
			continue
		}
		matched = true
		if record["route"] != "/api/v1/works/{id}" || record["method"] != "GET" || record["status"] != float64(404) || record["workspace_id"] == "" || record["duration_ms"] == nil {
			t.Fatalf("access fields: %+v", record)
		}
		encoded, _ := json.Marshal(record)
		if strings.Contains(string(encoded), "opt15-query-sentinel") || strings.Contains(string(encoded), "00000000-0000") {
			t.Fatalf("raw request values logged: %s", encoded)
		}
	}
	if !matched {
		t.Fatal("response ID has no matching access log")
	}
	router := chi.NewRouter()
	router.Use(middleware.RequestID, requestLog, middleware.Recoverer)
	router.Post("/fail/{id}", env.srv.h(func(http.ResponseWriter, *http.Request) error { return errors.New("opt15 forced internal failure") }))
	req := httptest.NewRequest("POST", "/fail/opt15-path-sentinel?private=opt15-query-sentinel", strings.NewReader("opt15-body-sentinel"))
	req.Header.Set("Authorization", "Bearer opt15-header-sentinel")
	req.Header.Set("Cookie", "session=opt15-cookie-sentinel")
	result := httptest.NewRecorder()
	router.ServeHTTP(result, req)
	id = result.Header().Get("X-Request-ID")
	if result.Code != 500 || id == "" || !strings.Contains(result.Body.String(), id) {
		t.Fatalf("internal failure: %d %s", result.Code, result.Body)
	}
	access, internal := false, false
	for _, record := range sink.records(t) {
		if record["request_id"] != id {
			continue
		}
		access = access || record["msg"] == "HTTP 请求"
		internal = internal || record["msg"] == "请求处理失败"
		encoded, _ := json.Marshal(record)
		for _, marker := range []string{"opt15-path-sentinel", "opt15-query-sentinel", "opt15-body-sentinel", "opt15-header-sentinel", "opt15-cookie-sentinel"} {
			if strings.Contains(string(encoded), marker) {
				t.Fatalf("request data logged: %s", encoded)
			}
		}
	}
	if !access || !internal {
		t.Fatal("internal error and access record do not share request ID")
	}
}

func TestOPT15SlowSSEAndBackgroundErrorTrace(t *testing.T) {
	sink := opt15Capture(t)
	router := chi.NewRouter()
	router.Use(middleware.RequestID, requestLog)
	started := make(chan struct{})
	router.Post("/stream", func(w http.ResponseWriter, r *http.Request) {
		sse := newSSE(w)
		close(started)
		sse.send("delta", map[string]string{"text": "首字"})
		time.Sleep(1100 * time.Millisecond)
		err := asAPIError(context.WithoutCancel(r.Context()), errors.New("opt15 background failure"))
		sse.send("error", err)
		sse.fail(errors.New("opt15 stream failure"))
	})
	server := httptest.NewServer(router)
	defer server.Close()
	resp, err := http.Post(server.URL+"/stream", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	id := resp.Header.Get("X-Request-ID")
	scanner := bufio.NewScanner(resp.Body)
	if !scanner.Scan() || scanner.Text() != "event: delta" {
		t.Fatal("first event not flushed")
	}
	select {
	case <-started:
	default:
		t.Fatal("first event arrived before handler")
	}
	var stream strings.Builder
	for scanner.Scan() {
		stream.WriteString(scanner.Text())
		stream.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if id == "" || strings.Count(stream.String(), `"request_id":"`+id+`"`) != 2 {
		t.Fatalf("SSE errors lost request ID: %s", stream.String())
	}
	access, aiFailure, sseFailure := false, false, false
	for _, record := range sink.records(t) {
		if record["request_id"] != id {
			continue
		}
		switch record["msg"] {
		case "HTTP 请求":
			access = true
			if record["level"] != "WARN" || record["duration_ms"].(float64) <= 1000 || record["status"] != float64(200) {
				t.Fatalf("slow record: %+v", record)
			}
		case "AI 任务失败":
			aiFailure = true
		case "流式请求失败":
			sseFailure = true
		}
	}
	if !access || !aiFailure || !sseFailure {
		t.Fatal("slow access and asynchronous/SSE errors not correlated")
	}
}

type opt15DeadlineWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *opt15DeadlineWriter) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}

func TestOPT15HTTPReadAndIdleBudgets(t *testing.T) {
	hs := env.srv.HTTPServer("127.0.0.1:0")
	if hs.IdleTimeout != 60*time.Second || hs.ReadHeaderTimeout != 10*time.Second || hs.ReadTimeout != 0 || hs.WriteTimeout != 0 {
		t.Fatalf("server budgets: %+v", hs)
	}
	for _, tc := range []struct {
		path, contentType string
		budget            time.Duration
	}{
		{"/api/v1/auth/login", "application/json", 30 * time.Second},
		{"/api/v1/sections/123/draft", "application/json", 90 * time.Second},
		{"/api/v1/works/123/assets", "multipart/form-data; boundary=opt15", 120 * time.Second},
	} {
		t.Run(tc.path, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(requestReadDeadline(router))
			router.Post("/api/v1/auth/login", func(http.ResponseWriter, *http.Request) {})
			router.Post("/api/v1/sections/{id}/draft", func(http.ResponseWriter, *http.Request) {})
			router.Post("/api/v1/works/{id}/assets", func(http.ResponseWriter, *http.Request) {})
			writer := &opt15DeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
			req := httptest.NewRequest("POST", tc.path, strings.NewReader("{}"))
			req.Header.Set("Content-Type", tc.contentType)
			before := time.Now()
			router.ServeHTTP(writer, req)
			if len(writer.deadlines) != 2 || !writer.deadlines[1].IsZero() {
				t.Fatalf("read deadline not cleared: %+v", writer.deadlines)
			}
			duration := writer.deadlines[0].Sub(before)
			if duration < tc.budget || duration > tc.budget+time.Second {
				t.Fatalf("budget %s, got %s", tc.budget, duration)
			}
		})
	}
}

func TestOPT15SlowRequestBodyTimesOut(t *testing.T) {
	sink := opt15Capture(t)
	hs := env.srv.HTTPServer("127.0.0.1:0")
	listener, err := net.Listen("tcp", hs.Addr)
	if err != nil {
		t.Fatal(err)
	}
	defer hs.Close()
	go hs.Serve(listener)
	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(40 * time.Second))
	started := time.Now()
	fmt.Fprint(conn, "POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	duration := time.Since(started)
	if resp.StatusCode != 408 || duration < 30*time.Second || duration > 33*time.Second || !bytes.Contains(body, []byte("request_read_timeout")) {
		t.Fatalf("slow body: %d %s %s", resp.StatusCode, duration, body)
	}
	id := resp.Header.Get("X-Request-ID")
	matched := false
	for _, record := range sink.records(t) {
		if record["request_id"] == id && record["msg"] == "HTTP 请求" {
			matched = record["level"] == "WARN" && record["status"] == float64(408)
		}
	}
	if !matched {
		t.Fatal("timeout response has no correlated slow request log")
	}
	t.Logf("incomplete JSON body rejected after %s with 408, request_id=%s", duration, id)
}
