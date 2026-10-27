package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ops/internal/config"
)

// D-153：跨源前端白名单中间件。用假的 next 处理器，不依赖数据库与业务路由。
func TestCORS(t *testing.T) {
	newServer := func(origins ...string) *Server {
		return &Server{cfg: &config.Config{CORSOrigins: origins}}
	}
	echo := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Total-Count", "7")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	hasToken := func(list, want string) bool {
		for _, part := range strings.Split(list, ",") {
			if strings.TrimSpace(part) == want {
				return true
			}
		}
		return false
	}

	t.Run("白名单为空时完全不介入", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
		req.Header.Set("Origin", "https://web.88813888.xyz")
		newServer().cors(echo).ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("未启用 CORS 时不应回 ACAO，得到 %q", got)
		}
		if got := rec.Header().Get("Vary"); got != "" {
			t.Fatalf("未启用 CORS 时不应改写 Vary，得到 %q", got)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("状态码 = %d，期望 200", rec.Code)
		}
	})

	t.Run("白名单来源回 ACAO 与凭据，并暴露业务头", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/works", nil)
		req.Header.Set("Origin", "https://web.88813888.xyz")
		newServer("https://web.88813888.xyz").cors(echo).ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://web.88813888.xyz" {
			t.Fatalf("ACAO = %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("Allow-Credentials = %q", got)
		}
		expose := rec.Header().Get("Access-Control-Expose-Headers")
		for _, name := range []string{"X-Request-ID", "X-Total-Count", "X-Has-More", "X-Offset", "X-Limit", "X-Next-Cursor", "X-OPS-Basis-Revision"} {
			if !hasToken(expose, name) {
				t.Fatalf("Expose-Headers 缺少 %s：%q", name, expose)
			}
		}
		if got := rec.Header().Get("Vary"); got != "Origin" {
			t.Fatalf("Vary = %q，期望 Origin", got)
		}
	})

	t.Run("非白名单来源不回 ACAO", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/works", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		newServer("https://web.88813888.xyz").cors(echo).ServeHTTP(rec, req)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("非白名单来源不应回 ACAO，得到 %q", got)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("非预检请求仍应正常处理，状态码 = %d", rec.Code)
		}
	})

	t.Run("预检：白名单 204 且带方法与头", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/works", nil)
		req.Header.Set("Origin", "https://web.88813888.xyz")
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "x-csrf-token")
		newServer("https://web.88813888.xyz").cors(echo).ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("预检状态码 = %d，期望 204", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
			t.Fatal("预检缺少 Allow-Methods")
		}
		allowHeaders := rec.Header().Get("Access-Control-Allow-Headers")
		for _, name := range []string{"X-CSRF-Token", "X-AI-Prefer", "Idempotency-Key", "Content-Type"} {
			if !hasToken(allowHeaders, name) {
				t.Fatalf("Allow-Headers 缺少 %s：%q", name, allowHeaders)
			}
		}
		if got := rec.Header().Get("Access-Control-Max-Age"); got != "600" {
			t.Fatalf("Max-Age = %q，期望 600", got)
		}
	})

	t.Run("桌面安全协议来源通过白名单预检", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/me", nil)
		req.Header.Set("Origin", "ops-desktop://business")
		req.Header.Set("Access-Control-Request-Method", "GET")
		req.Header.Set("Access-Control-Request-Headers", "x-csrf-token")
		newServer("ops-desktop://business").cors(echo).ServeHTTP(rec, req)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("桌面协议预检状态码 = %d，期望 204", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "ops-desktop://business" {
			t.Fatalf("桌面协议 ACAO = %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Fatalf("桌面协议 Allow-Credentials = %q", got)
		}
	})

	t.Run("预检：非白名单 403", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/works", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		req.Header.Set("Access-Control-Request-Method", "POST")
		newServer("https://web.88813888.xyz").cors(echo).ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("非白名单预检状态码 = %d，期望 403", rec.Code)
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("非白名单预检不应回 ACAO，得到 %q", got)
		}
	})

	// 桌面端 WS 通道靠"请求没有 Origin 头"区分浏览器，因此必须对它完全透明。
	t.Run("桌面通道完全 pass-through", func(t *testing.T) {
		for _, method := range []string{http.MethodGet, http.MethodOptions} {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(method, desktopChannelPath, nil)
			req.Header.Set("Origin", "https://web.88813888.xyz")
			req.Header.Set("Access-Control-Request-Method", "GET")
			newServer("https://web.88813888.xyz").cors(echo).ServeHTTP(rec, req)
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Fatalf("%s 桌面通道不应回 ACAO，得到 %q", method, got)
			}
			if got := rec.Header().Get("Vary"); got != "" {
				t.Fatalf("%s 桌面通道不应改写 Vary，得到 %q", method, got)
			}
			if method == http.MethodOptions && rec.Code != http.StatusOK {
				t.Fatalf("桌面通道的 OPTIONS 不应被 CORS 拦截，状态码 = %d", rec.Code)
			}
		}
	})
}
