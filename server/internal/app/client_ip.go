package app

import (
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

// 客户端地址解析：只在「直连对端确实是自己的反向代理」时才采信 X-Forwarded-For。
//
// 背景：生产链路是 宿主机 Nginx -> 127.0.0.1:44537 -> 容器内 8080，
// Nginx 用 `$proxy_add_x_forwarded_for` 转发，它会把客户端自带的 XFF **原样保留**
// 并在末尾追加真实来源。也就是说 XFF 形如 `伪造值, 真实IP`，
// 取第一段就等于把攻击者可控的字符串写进审计日志和 session.ip。
//
// 正确做法与 Nginx 的写入顺序对齐：从右往左走，跳过可信代理，
// 第一个不属于可信网段的地址才是真实来源。
//
// 未配置 `OPS_TRUSTED_PROXIES` 时视为「没有任何可信代理」，
// XFF 一律不采信，直接用 TCP 对端地址（失败时不可伪造，只是变成代理自身 IP）。
const trustedProxiesEnv = "OPS_TRUSTED_PROXIES"

type proxyNets struct {
	nets []*net.IPNet
}

func (p *proxyNets) trusted(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, n := range p.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func (p *proxyNets) empty() bool { return p == nil || len(p.nets) == 0 }

// 缓存解析结果，避免每个请求都读一次 env 并重新解析掩码。
// 值为 nil 表示尚未加载；配置在进程生命周期内固定。
var trustedProxies atomic.Pointer[proxyNets]

func loadTrustedProxies() *proxyNets {
	if p := trustedProxies.Load(); p != nil {
		return p
	}
	p := parseTrustedProxies(os.Getenv(trustedProxiesEnv))
	trustedProxies.Store(p)
	return p
}

// parseTrustedProxies 接受逗号分隔的 CIDR 或单个 IP，忽略无法解析的条目。
// 解析不了就当作不可信：宁可退回 TCP 对端地址，也不要放宽到「全部信任」。
func parseTrustedProxies(raw string) *proxyNets {
	set := &proxyNets{}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, network, err := net.ParseCIDR(item); err == nil {
			set.nets = append(set.nets, network)
			continue
		}
		ip := net.ParseIP(item)
		if ip == nil {
			continue
		}
		bits := 128
		if v4 := ip.To4(); v4 != nil {
			ip, bits = v4, 32
		}
		set.nets = append(set.nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
	}
	return set
}

// remoteIP 从 RemoteAddr（形如 `1.2.3.4:5678` 或 `[::1]:5678`）取出裸地址。
func remoteIP(remoteAddr string) string {
	host := remoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return strings.Trim(host, "[]")
}

func clientIP(r *http.Request) string {
	peer := remoteIP(r.RemoteAddr)
	proxies := loadTrustedProxies()
	// 直连对端不是可信代理时，XFF 完全由客户端决定，采信即等于允许伪造。
	if proxies.empty() || !proxies.trusted(net.ParseIP(peer)) {
		return peer
	}
	hops := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(hops[i]))
		if ip == nil {
			continue
		}
		if !proxies.trusted(ip) {
			return ip.String()
		}
	}
	// 整条链都是可信代理（或头部为空）：用对端地址，不虚构来源。
	return peer
}
