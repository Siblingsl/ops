// Package crawl owns every outbound request to public content sources.
package crawl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	ErrDisabled = errors.New("热点采集未开启")
	ErrRobots   = errors.New("robots 不允许")
	ErrLimited  = errors.New("达到采集限额或来源正在暂停")
)

const UserAgent = "Mozilla/5.0 (compatible; OPSReference/1.0)"

type Limits struct {
	Enabled       bool `json:"-"`
	IntervalMin   int  `json:"interval_min"`
	MaxItems      int  `json:"max_items"`
	DailyRequests int  `json:"daily_requests"`
	FailLimit     int  `json:"fail_limit"`
	PauseHours    int  `json:"pause_hours"`
}

func (l Limits) Validate() error {
	if l.IntervalMin < 10 || l.MaxItems < 1 || l.MaxItems > 100 || l.DailyRequests < 1 || l.DailyRequests > 2000 || l.FailLimit < 1 || l.FailLimit > 3 || l.PauseHours < 6 || l.PauseHours > 168 {
		return errors.New("最短 10 分钟，每次 1–100 条，每日最多 2000 次；连续失败最多 3 次，暂停至少 6 小时")
	}
	return nil
}

type Source struct {
	Key  string
	Kind string
	URL  string
}
type Outcome struct {
	Status      int
	Requests    int
	RobotsAllow bool
	Error       string
	Paused      bool
}

// Store makes budgets and source claims shared across workers and restarts.
type Store interface {
	Claim(context.Context, Source, time.Time, Limits) error
	Reserve(context.Context, time.Time, int) error
	Finish(context.Context, Source, time.Time, Limits, Outcome)
}

type Options struct {
	Mode      func() bool
	Now       func() time.Time
	Store     Store
	LocalHost string
}
type Client struct {
	options Options
	http    *http.Client
	mu      sync.Mutex
	robots  map[string]robotCache
}
type robotCache struct {
	text  string
	until time.Time
	err   error
}

func New(o Options) *Client {
	if o.Now == nil {
		o.Now = time.Now
	}
	c := &Client{options: o, robots: map[string]robotCache{}}
	tr := &http.Transport{Proxy: nil, ResponseHeaderTimeout: 15 * time.Second, DialContext: c.dial}
	c.http = &http.Client{Transport: tr, Timeout: 25 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		// Cross-origin links are queued separately; redirects cannot escape source limits.
		if len(via) >= 5 || req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {
			return errors.New("不读取跨域重定向")
		}
		return http.ErrUseLastResponse
	}}
	return c
}

func (c *Client) dial(ctx context.Context, network, address string) (net.Conn, error) {
	if address == c.options.LocalHost && c.options.LocalHost != "" {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, errors.New("无法解析来源地址")
	}
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, errors.New("不允许读取内网或保留地址")
		}
	}
	return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
}

func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		_, n, _ := net.ParseCIDR(block)
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

func Sensitive(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, d := range []string{"xiaohongshu.com", "xhslink.com", "xhscdn.com"} {
		if host == d || strings.HasSuffix(host, "."+d) {
			return "xhs_page"
		}
	}
	if host == "mp.weixin.qq.com" || strings.HasSuffix(host, ".mp.weixin.qq.com") {
		return "wechat_page"
	}
	return ""
}

func (c *Client) validURL(raw string, source Source) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
		return nil, errors.New("来源必须为不含账号信息的 HTTP(S) 地址")
	}
	if p := Sensitive(u.Hostname()); p != "" && source.Kind != p {
		return nil, errors.New("敏感平台链接必须进入独立读取队列")
	}
	if ip := net.ParseIP(u.Hostname()); ip != nil && !publicIP(ip) && u.Host != c.options.LocalHost {
		return nil, errors.New("不允许读取内网或保留地址")
	}
	return u, nil
}

func (c *Client) request(ctx context.Context, u *url.URL, lim Limits, out *Outcome) ([]byte, int, error) {
	if c.options.Mode == nil || !c.options.Mode() || !lim.Enabled {
		return nil, 0, ErrDisabled
	}
	if err := c.options.Store.Reserve(ctx, c.options.Now(), lim.DailyRequests); err != nil {
		return nil, 0, err
	}
	out.Requests++
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept", "text/html,application/json,application/rss+xml,application/atom+xml,text/plain;q=0.8")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20+1))
	if len(b) > 4<<20 {
		return nil, res.StatusCode, errors.New("来源页面过大")
	}
	return b, res.StatusCode, err
}

func blocked(b []byte, status int) bool {
	if status == 403 || status == 429 {
		return true
	}
	text := strings.ToLower(string(b))
	for _, s := range []string{"captcha", "验证码", "滑块验证", "环境异常", "登录后查看", "请先登录", "sign in to continue"} {
		if strings.Contains(text, s) {
			return true
		}
	}
	return false
}

// Read performs one source operation. Robots and target requests share the daily budget.
func (c *Client) Read(ctx context.Context, source Source, lim Limits) ([]byte, Outcome, error) {
	return c.ReadValidated(ctx, source, lim, nil)
}

func (c *Client) ReadValidated(ctx context.Context, source Source, lim Limits, validate func([]byte) error) (body []byte, out Outcome, err error) {
	if c.options.Mode == nil || !c.options.Mode() || !lim.Enabled {
		return nil, out, ErrDisabled
	}
	if err = lim.Validate(); err != nil {
		return
	}
	if c.options.Store == nil {
		return nil, out, errors.New("缺少采集预算存储")
	}
	u, err := c.validURL(source.URL, source)
	if err != nil {
		return nil, out, err
	}
	if err = c.options.Store.Claim(ctx, source, c.options.Now(), lim); err != nil {
		return nil, out, err
	}
	defer func() {
		if err != nil {
			out.Error = err.Error()
		}
		c.options.Store.Finish(ctx, source, c.options.Now(), lim, out)
	}()
	origin := u.Scheme + "://" + u.Host
	c.mu.Lock()
	cache, ok := c.robots[origin]
	c.mu.Unlock()
	if !ok || !c.options.Now().Before(cache.until) {
		ru, _ := url.Parse(origin + "/robots.txt")
		b, status, e := c.request(ctx, ru, lim, &out)
		cache = robotCache{until: c.options.Now().Add(24 * time.Hour)}
		if e != nil {
			cache.err = e
		} else if blocked(b, status) {
			out.Paused = true
			out.Status = status
			cache.err = ErrRobots
		} else if status == 404 {
			cache.text = ""
		} else if status >= 200 && status < 300 {
			cache.text = string(b)
		} else {
			cache.err = ErrRobots
		}
		c.mu.Lock()
		c.robots[origin] = cache
		c.mu.Unlock()
	}
	if cache.err != nil {
		return nil, out, cache.err
	}
	path := u.EscapedPath()
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	out.RobotsAllow = RobotsAllowed(cache.text, path)
	if !out.RobotsAllow {
		return nil, out, ErrRobots
	}
	body, out.Status, err = c.request(ctx, u, lim, &out)
	if err != nil {
		return
	}
	if blocked(body, out.Status) {
		out.Paused = true
		err = errors.New("来源触发访问限制，已暂停")
	} else if out.Status < 200 || out.Status >= 300 {
		err = fmt.Errorf("来源返回 HTTP %d", out.Status)
	}
	if err == nil && validate != nil {
		err = validate(body)
	}
	return
}

// RobotsAllowed applies the longest matching rule, with Allow winning equal lengths.
func RobotsAllowed(text, path string) bool {
	type rule struct {
		pattern string
		allow   bool
	}
	var generic, specific []rule
	agents := []string{}
	hadRules := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key, val := strings.ToLower(strings.TrimSpace(parts[0])), strings.TrimSpace(parts[1])
		if key == "user-agent" {
			if hadRules {
				agents = nil
				hadRules = false
			}
			agents = append(agents, strings.ToLower(val))
			continue
		}
		if key != "allow" && key != "disallow" {
			continue
		}
		hadRules = true
		if val == "" {
			continue
		}
		for _, a := range agents {
			if a == "*" {
				generic = append(generic, rule{val, key == "allow"})
				break
			}
			if strings.Contains(strings.ToLower(UserAgent), a) {
				specific = append(specific, rule{val, key == "allow"})
				break
			}
		}
	}
	rules := generic
	if len(specific) > 0 {
		rules = specific
	}
	best := -1
	allowed := true
	for _, r := range rules {
		pattern := regexp.QuoteMeta(r.pattern)
		pattern = strings.ReplaceAll(pattern, `\*`, ".*")
		if strings.HasSuffix(pattern, `\$`) {
			pattern = strings.TrimSuffix(pattern, `\$`) + "$"
		}
		match, _ := regexp.MatchString("^"+pattern, path)
		n := len(strings.TrimSuffix(strings.ReplaceAll(r.pattern, "*", ""), "$"))
		if match && (n > best || n == best && r.allow) {
			best = n
			allowed = r.allow
		}
	}
	return allowed
}
