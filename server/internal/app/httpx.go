package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// APIError is rendered as {"error":{"code","message","detail","fields","request_id"}} (06 文档第 13.1 节).
type APIError struct {
	Status    int               `json:"-"`
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	Detail    any               `json:"detail,omitempty"`
	Fields    map[string]string `json:"fields,omitempty"`
	RequestID string            `json:"request_id,omitempty"`
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
	errUnauthorized    = apiErr(401, "unauthorized", "请先登录")
	errCSRF            = apiErr(403, "csrf_invalid", "页面已过期，请刷新后重试")
	errReauth          = apiErr(403, "reauth_required", "这是敏感操作，请先输入登录密码确认")
	errNotFound        = apiErr(404, "not_found", "内容不存在或已删除")
)

func validation(msg string) *APIError { return apiErr(422, "validation_failed", msg) }
func validationFields(msg string, fields map[string]string) *APIError {
	ae := validation(msg)
	ae.Fields = fields
	return ae
}
func stateInvalid(msg string) *APIError { return apiErr(409, "state_invalid", msg) }
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
	var pe *pgconn.PgError
	if errors.Is(err, pgx.ErrNoRows) {
		ae = errNotFound
	} else if errors.As(err, &pe) && pe.Code == "57014" {
		ae = apiErr(http.StatusGatewayTimeout, "database_timeout", "数据库操作超时，请稍后重试")
	} else if !errors.As(err, &ae) {
		slog.ErrorContext(r.Context(), "请求处理失败", "request_id", middleware.GetReqID(r.Context()), "route", requestRoute(r.Context()), "err", err)
		ae = apiErr(500, "internal", "服务器内部错误，请稍后重试")
	}
	writeJSON(w, ae.Status, map[string]any{"error": errorRequestID(ae, middleware.GetReqID(r.Context()))})
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
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return apiErr(408, "request_read_timeout", "请求读取超时，请稍后重试")
		}
		return requestFormatError(r.Context(), err)
	}
	return nil
}

func requestFormatError(ctx context.Context, err error) *APIError {
	slog.WarnContext(ctx, "请求 JSON 格式错误", "err", err)
	return validation("请求格式不正确，请检查 JSON 语法和字段类型")
}

// decodeOptional accepts an empty body (all fields keep their zero value).
func decodeOptional(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 8<<20))
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return apiErr(408, "request_read_timeout", "请求读取超时，请稍后重试")
		}
		return requestFormatError(r.Context(), err)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return requestFormatError(r.Context(), err)
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
	if event == "error" {
		if ae, ok := data.(*APIError); ok {
			data = errorRequestID(ae, s.w.Header().Get("X-Request-ID"))
		}
	}
	b, _ := json.Marshal(data)
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, b)
	s.flush()
}

func (s *sseWriter) fail(err error) {
	var ae *APIError
	if !errors.As(err, &ae) {
		slog.Error("流式请求失败", "request_id", s.w.Header().Get("X-Request-ID"), "err", err)
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
	ctxPreferFallback
)

// preferFallback lets a retry go straight to the route's backup model (UX-07「换备用模型」).
func preferFallback(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-AI-Prefer") == "fallback" {
			r = r.WithContext(context.WithValue(r.Context(), ctxPreferFallback, true))
		}
		next.ServeHTTP(w, r)
	})
}

type identity struct {
	UserID        uuid.UUID
	SessionID     uuid.UUID
	WorkspaceID   uuid.UUID
	Username      string
	Role          string
	SystemAdmin   bool
	AdminOverride bool
	ReauthOK      bool
	lastSeen      time.Time
}

func ident(ctx context.Context) *identity {
	id, _ := ctx.Value(ctxMember).(*identity)
	return id
}
