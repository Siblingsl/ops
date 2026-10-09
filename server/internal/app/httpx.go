package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// APIError is rendered as {"error":{"code","message","detail"}} (06 文档第 13.1 节).
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func apiErr(status int, code, msg string) *APIError {
	return &APIError{Status: status, Code: code, Message: msg}
}

func (e *APIError) With(detail any) *APIError {
	c := *e
	c.Detail = detail
	return &c
}

var (
	errUnauthenticated = apiErr(401, "unauthenticated", "请先登录")
	errCSRF            = apiErr(403, "csrf_invalid", "页面已过期，请刷新后重试")
	errReauth          = apiErr(403, "reauth_required", "这是敏感操作，请先输入登录密码确认")
	errNotFound        = apiErr(404, "not_found", "内容不存在或已删除")
)

func validation(msg string) *APIError    { return apiErr(422, "validation_failed", msg) }
func stateInvalid(msg string) *APIError  { return apiErr(409, "state_invalid", msg) }
func humanStep(h, msg string) *APIError {
	return apiErr(409, "human_step_required", msg).With(map[string]string{"checkpoint": h})
}

type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) h(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		err := fn(w, r)
		if err == nil {
			return
		}
		writeError(w, r, err)
	}
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var ae *APIError
	if errors.Is(err, pgx.ErrNoRows) {
		ae = errNotFound
	} else if !errors.As(err, &ae) {
		slog.Error("请求处理失败", "path", r.URL.Path, "err", err)
		ae = apiErr(500, "internal", "服务器内部错误，请稍后重试")
	}
	writeJSON(w, ae.Status, map[string]any{"error": ae})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func ok(w http.ResponseWriter, v any) error {
	writeJSON(w, 200, v)
	return nil
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 8<<20))
	if err := dec.Decode(v); err != nil {
		return validation("请求格式不正确：" + err.Error())
	}
	return nil
}

func pathID(r *http.Request, name string) (uuid.UUID, error) {
	id, err := uuid.Parse(chi.URLParam(r, name))
	if err != nil {
		return uuid.Nil, errNotFound
	}
	return id, nil
}

func chiParam(r *http.Request, name string) string { return chi.URLParam(r, name) }

func queryInt(r *http.Request, name string, def int) int {
	if v, err := strconv.Atoi(r.URL.Query().Get(name)); err == nil {
		return v
	}
	return def
}

func runeLen(s string) int { return len([]rune(s)) }

func clientIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		return strings.TrimSpace(strings.Split(xf, ",")[0])
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

// SSE writer for AI streaming and push progress.
type sseWriter struct {
	w http.ResponseWriter
	f http.Flusher
}

func newSSE(w http.ResponseWriter) *sseWriter {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	f, _ := w.(http.Flusher)
	s := &sseWriter{w: w, f: f}
	s.flush()
	return s
}

func (s *sseWriter) send(event string, data any) {
	b, _ := json.Marshal(data)
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.flush()
}

func (s *sseWriter) fail(err error) {
	var ae *APIError
	if !errors.As(err, &ae) {
		slog.Error("流式请求失败", "err", err)
		ae = apiErr(500, "internal", "服务器内部错误，请稍后重试")
	}
	s.send("error", ae)
}

func (s *sseWriter) flush() {
	if s.f != nil {
		s.f.Flush()
	}
}

type ctxKey int

const (
	ctxMember ctxKey = iota
)

type identity struct {
	MemberID    uuid.UUID
	SessionID   uuid.UUID
	WorkspaceID uuid.UUID
	Username    string
	ReauthOK    bool
}

func ident(ctx context.Context) *identity {
	id, _ := ctx.Value(ctxMember).(*identity)
	return id
}
