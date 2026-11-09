package app

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

// withTrustedProxies 设置 env 并清掉进程级缓存，保证用例之间互不影响。
// t.Setenv 自带还原；缓存需要单独还原，否则下一个用例会读到上一个的解析结果。
func withTrustedProxies(t *testing.T, raw string) {
	t.Helper()
	t.Setenv(trustedProxiesEnv, raw)
	prev := trustedProxies.Swap(nil)
	t.Cleanup(func() { trustedProxies.Store(prev) })
}

func TestClientIPIgnoresForwardedForWithoutTrustedProxies(t *testing.T) {
	withTrustedProxies(t, "")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.7:4567"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := clientIP(req); got != "203.0.113.7" {
		t.Fatalf("clientIP = %q, want TCP 对端地址 203.0.113.7（未配可信代理时不得采信 XFF）", got)
	}
}

func TestClientIPIgnoresForwardedForWhenPeerIsNotProxy(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.7:4567"
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.9")

	if got := clientIP(req); got != "203.0.113.7" {
		t.Fatalf("clientIP = %q, want 203.0.113.7（直连对端不在可信网段时，头部完全由客户端控制）", got)
	}
}

func TestClientIPSkipsForgedPrefixFromTrustedProxy(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8,172.16.0.0/12")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "172.17.0.1:4567"
	// Nginx `$proxy_add_x_forwarded_for` 的产物：客户端自带的伪造值在前，真实来源在最后。
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.9")

	if got := clientIP(req); got != "198.51.100.9" {
		t.Fatalf("clientIP = %q, want 198.51.100.9（应从右往左取第一个非可信地址，而不是取第一段）", got)
	}
}

func TestClientIPWalksPastMultipleTrustedHops(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4567"
	req.Header.Set("X-Forwarded-For", "1.2.3.4, 198.51.100.9, 10.0.0.8, 10.0.0.9")

	if got := clientIP(req); got != "198.51.100.9" {
		t.Fatalf("clientIP = %q, want 198.51.100.9（链上连续的代理跳跃都要跳过）", got)
	}
}

func TestClientIPFallsBackToPeerWhenAllHopsTrusted(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4567"
	req.Header.Set("X-Forwarded-For", "10.0.0.8, 10.0.0.9")

	if got := clientIP(req); got != "10.0.0.5" {
		t.Fatalf("clientIP = %q, want 10.0.0.5（整条链都是代理时用对端地址，不虚构来源）", got)
	}
}

func TestClientIPWithoutHeaderUsesPeer(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4567"

	if got := clientIP(req); got != "10.0.0.5" {
		t.Fatalf("clientIP = %q, want 10.0.0.5", got)
	}
}

func TestClientIPMalformedConfigFailsClosed(t *testing.T) {
	// 配置写错时不能退化成「信任所有人」，否则一次笔误就把加固整个抵消。
	withTrustedProxies(t, "not-a-cidr, 10.0.0.0/8, ,, ")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.7:4567"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := clientIP(req); got != "203.0.113.7" {
		t.Fatalf("clientIP = %q, want 203.0.113.7（非法条目应被忽略，不得放宽为全信任）", got)
	}

	// 同一份配置里合法的那一条仍要生效。
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.RemoteAddr = "10.1.2.3:4567"
	req2.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got := clientIP(req2); got != "198.51.100.9" {
		t.Fatalf("clientIP = %q, want 198.51.100.9（合法条目 10.0.0.0/8 仍应被采纳）", got)
	}
}

func TestClientIPAcceptsBareAddressesInConfig(t *testing.T) {
	withTrustedProxies(t, "127.0.0.1, 10.0.0.7")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "127.0.0.1:44537"
	req.Header.Set("X-Forwarded-For", "198.51.100.9")

	if got := clientIP(req); got != "198.51.100.9" {
		t.Fatalf("clientIP = %q, want 198.51.100.9（单个 IP 不带掩码也要能配）", got)
	}
}

func TestClientIPIPv6PeerAndHops(t *testing.T) {
	withTrustedProxies(t, "2001:db8::/32")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "[2001:db8::1]:4567"
	// 客户端地址故意放在可信网段之外，否则会被误判成又一跳代理。
	req.Header.Set("X-Forwarded-For", "2001:db9::99")

	if got := clientIP(req); got != "2001:db9::99" {
		t.Fatalf("clientIP = %q, want 2001:db9::99（IPv6 对端与网段都要识别）", got)
	}
}

func TestClientIPUnparseableHeaderEntryDoesNotLeakThrough(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.5:4567"
	req.Header.Set("X-Forwarded-For", "198.51.100.9, not-an-ip, 10.0.0.5")

	if got := clientIP(req); got != "198.51.100.9" {
		t.Fatalf("clientIP = %q, want 198.51.100.9（无法解析的条目跳过，不要把它当结果返回）", got)
	}
}

// 这条用例守的是「中间件链不得改写 RemoteAddr」，而不是 clientIP 本身：
// 一旦有人把 chi 的 middleware.RealIP 加回 buildRouter，XFF 第一段会先被写进
// r.RemoteAddr，clientIP 拿到的「对端地址」已经是伪造值，上面所有单测仍然会通过，
// 但线上审计照样可伪造。只有走完整 Router 才能发现。
func TestLoginAuditIgnoresForwardedForThroughFullRouter(t *testing.T) {
	withTrustedProxies(t, "")

	body := `{"username":"no-such-user-for-xff-check","password":"irrelevant-password-123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")

	rec := httptest.NewRecorder()
	env.srv.Router().ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Fatalf("login status = %d, want 401（body=%s）", rec.Code, rec.Body.String())
	}

	var ip string
	err := env.srv.db.QueryRow(context.Background(), `
		SELECT detail->>'ip' FROM audit_log
		WHERE action = 'login_failed' AND created_at > now() - interval '30 seconds'
		ORDER BY created_at DESC LIMIT 1`).Scan(&ip)
	if err != nil {
		t.Fatalf("查询登录失败审计: %v", err)
	}
	if ip != "127.0.0.1" {
		t.Fatalf("审计 ip = %q, want 127.0.0.1；说明 X-Forwarded-For 仍然影响了客户端地址解析", ip)
	}
}
