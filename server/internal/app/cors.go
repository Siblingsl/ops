package app

import (
	"net/http"
	"strconv"
	"strings"
)

// 跨源前端白名单。Electron 桌面业务窗口使用安全自定义协议，跨源访问 HTTPS API，因此：
//   - 必须回写 Access-Control-Allow-Origin，并带上 Allow-Credentials（会话靠 Cookie）；
//   - 必须 expose 业务用到的自定义响应头，否则分页与基版本校验在跨域下静默退化；
//   - 桌面请求的 Cookie 使用 SameSite=None; Secure（见 config.CookieSameSite）。
const (
	corsAllowMethods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
	corsAllowHeaders = "Accept, Content-Type, X-CSRF-Token, X-AI-Prefer, Idempotency-Key"
	corsMaxAge       = "600"
)

// corsExposeHeaders 是前端真正读取的响应头（web/src/lib/api.ts 与打包页）。
var corsExposeHeaders = strings.Join([]string{
	"X-Request-ID",
	"X-Total-Count",
	"X-Has-More",
	"X-Offset",
	"X-Limit",
	"X-Next-Cursor",
	"X-OPS-Basis-Revision",
}, ", ")

// desktopChannelPath 必须保持"无 Origin 头"这一安全前提（desktop_connection.go），
// 因此 CORS 中间件对它完全透明：不回 ACAO、不处理预检。
const desktopChannelPath = "/api/v1/desktop/channel"

// cors 在 OPS_CORS_ORIGINS 为空时完全不介入，行为与改造前一致。
func (s *Server) cors(next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(s.cfg.CORSOrigins))
	for _, origin := range s.cfg.CORSOrigins {
		allowed[origin] = struct{}{}
	}
	if len(allowed) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == desktopChannelPath {
			next.ServeHTTP(w, r)
			return
		}
		// 响应随 Origin 变化，任何中间缓存都必须按 Origin 分桶。
		w.Header().Add("Vary", "Origin")

		origin := strings.TrimSpace(r.Header.Get("Origin"))
		_, ok := allowed[origin]
		if origin != "" && ok {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
		}

		// 预检：无论是否白名单都必须在此应答，避免落到业务路由被当成 405。
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if origin == "" || !ok {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			h := w.Header()
			h.Set("Access-Control-Allow-Methods", corsAllowMethods)
			h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
			h.Set("Access-Control-Max-Age", corsMaxAge)
			h.Set("Content-Length", strconv.Itoa(0))
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
