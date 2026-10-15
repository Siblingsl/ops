package app

import (
	"context"
	"log/slog"
	"mime"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type requestTrace struct{ WorkspaceID uuid.UUID }
type requestTraceKey struct{}

func (s *Server) HTTPServer(addr string) *http.Server {
	return &http.Server{Addr: addr, Handler: s.Router(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
}

var streamingRequests = map[string]bool{
	"POST /api/v1/accounts/{accountId}/style-summary":     true,
	"POST /api/v1/accounts/{accountId}/profile/bootstrap": true,
	"POST /api/v1/accounts/{accountId}/strategy/options":  true,
	"POST /api/v1/works/{id}/organize-notes":              true,
	"POST /api/v1/works/{id}/copilot":                     true,
	"POST /api/v1/works/{id}/wechat/push":                 true,
	"POST /api/v1/sections/{id}/draft":                    true,
	"POST /api/v1/sections/{id}/edit":                     true,
	"POST /api/v1/sections/{id}/rewrite":                  true,
	"POST /api/v1/sections/{id}/continue":                 true,
	"GET /api/v1/notifications/stream":                    true,
}

func requestReadDeadline(router chi.Router) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			budget := 30 * time.Second
			lookup := chi.NewRouteContext()
			if router.Match(lookup, r.Method, r.URL.Path) && streamingRequests[r.Method+" "+lookup.RoutePattern()] {
				budget = 90 * time.Second
			}
			if kind, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); kind == "multipart/form-data" {
				budget = 120 * time.Second
			}
			controller := http.NewResponseController(w)
			_ = controller.SetReadDeadline(time.Now().Add(budget))
			defer controller.SetReadDeadline(time.Time{})
			next.ServeHTTP(w, r)
		})
	}
}

func requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		trace := &requestTrace{}
		r = r.WithContext(context.WithValue(r.Context(), requestTraceKey{}, trace))
		requestID := middleware.GetReqID(r.Context())
		w.Header().Set("X-Request-ID", requestID)
		wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		defer func() {
			duration := time.Since(started)
			status := wrapped.Status()
			if status == 0 {
				status = http.StatusOK
			}
			route := requestRoute(r.Context())
			workspace := ""
			if trace.WorkspaceID != uuid.Nil {
				workspace = trace.WorkspaceID.String()
			}
			level := slog.LevelInfo
			if duration > time.Second {
				level = slog.LevelWarn
			}
			slog.Log(r.Context(), level, "HTTP 请求", "request_id", requestID, "method", r.Method, "route", route, "status", status, "duration_ms", float64(duration)/float64(time.Millisecond), "workspace_id", workspace)
		}()
		next.ServeHTTP(wrapped, r)
	})
}

func errorRequestID(err *APIError, requestID string) *APIError {
	copy := *err
	copy.RequestID = requestID
	return &copy
}

func requestRoute(ctx context.Context) string {
	if route := chi.RouteContext(ctx); route != nil && route.RoutePattern() != "" {
		return route.RoutePattern()
	}
	return "<unmatched>"
}
