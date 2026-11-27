package app

import (
	"context"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type requestTrace struct{ WorkspaceID uuid.UUID }
type requestTraceKey struct{}
type httpRequestBudget struct {
	modelDeadline time.Time
}
type httpRequestBudgetKey struct{}

func (s *Server) HTTPServer(addr string) *http.Server {
	return &http.Server{Addr: addr, Handler: s.Router(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
}

var streamingRequests = map[string]bool{
	"POST /api/v1/accounts/{accountId}/style-summary":                 true,
	"POST /api/v1/accounts/{accountId}/profile/bootstrap":             true,
	"POST /api/v1/accounts/{accountId}/strategy/options":              true,
	"POST /api/v1/works/{id}/organize-notes":                          true,
	"POST /api/v1/works/{id}/copilot":                                 true,
	"POST /api/v1/works/{id}/wechat/push":                             true,
	"POST /api/v1/sections/{id}/draft":                                true,
	"POST /api/v1/sections/{id}/edit":                                 true,
	"POST /api/v1/sections/{id}/rewrite":                              true,
	"POST /api/v1/sections/{id}/continue":                             true,
	"POST /api/v1/agent/conversations/{id}/messages":                  true,
	"POST /api/v1/agent/conversations/{id}/continue":                  true,
	"POST /api/v1/agent/conversations/{id}/regenerate":                true,
	"POST /api/v1/agent/conversations/{id}/messages/{messageId}/edit": true,
}

// sseRequests 是服务端单向推送的 SSE 端点：请求体在建立连接时就已读完，
// 之后连接上没有新的客户端字节。对它们设置读取截止时间只会在到期时
// 强制关闭健康的长连接，并让复用该 keep-alive 连接的后续请求同时被
// 取消（服务端因此记录 499 client_closed_request）。SSE 的存活应由
// ctx 取消与服务端心跳写失败来判定，不能使用 ReadDeadline。
var sseRequests = map[string]bool{
	"GET /api/v1/notifications/stream":            true,
	"GET /api/v1/agent/conversations/{id}/events": true,
}

func requestReadDeadline(router chi.Router) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			startedAt := time.Now()
			budget := 30 * time.Second
			modelBudget := 25 * time.Second
			lookup := chi.NewRouteContext()
			matched := router.Match(lookup, r.Method, r.URL.Path)
			pattern := lookup.RoutePattern()
			streaming := matched && streamingRequests[r.Method+" "+pattern]
			sse := matched && sseRequests[r.Method+" "+pattern]
			if streaming {
				budget = 90 * time.Second
				modelBudget = 0
			}
			if kind, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); kind == "multipart/form-data" {
				budget = 120 * time.Second
				modelBudget = 115 * time.Second
			}
			if sse {
				// SSE 连接只写不读，不能用读取截止时间做存活上限。
				budget = 0
				modelBudget = 0
			}
			requestBudget := httpRequestBudget{}
			if modelBudget > 0 {
				requestBudget.modelDeadline = startedAt.Add(modelBudget)
			}
			r = r.WithContext(context.WithValue(r.Context(), httpRequestBudgetKey{}, requestBudget))
			if budget > 0 {
				controller := http.NewResponseController(w)
				_ = controller.SetReadDeadline(startedAt.Add(budget))
				defer controller.SetReadDeadline(time.Time{})
			}
			next.ServeHTTP(w, r)
		})
	}
}

func httpRequestBudgetOf(ctx context.Context) (httpRequestBudget, bool) {
	budget, ok := ctx.Value(httpRequestBudgetKey{}).(httpRequestBudget)
	return budget, ok
}

// stripNulQuery 删除查询串里的 NUL（%00）。PostgreSQL 的 text 不允许 NUL，
// 未清洗时会以 57014/编码错误冒成 500；这里统一按“未提供该值”处理，避免整条接口不可用。
func stripNulQuery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, "%00") {
			clone := *r
			u := *r.URL
			u.RawQuery = strings.ReplaceAll(r.URL.RawQuery, "%00", "")
			clone.URL = &u
			r = &clone
		}
		next.ServeHTTP(w, r)
	})
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
			attrs := []any{"request_id", requestID, "method", r.Method, "route", route, "status", status,
				"duration_ms", float64(duration) / float64(time.Millisecond), "workspace_id", workspace}
			// 16 文档第 2.3 节「请求构造」第 6 项：经分发器的请求在访问日志中标记 via=agent。
			if p := agentPrincipalOf(r.Context()); p != nil {
				attrs = append(attrs, "via", "agent")
				if p.ActionID != uuid.Nil {
					attrs = append(attrs, "agent_action_id", p.ActionID.String())
				}
			}
			slog.Log(r.Context(), level, "HTTP 请求", attrs...)
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
