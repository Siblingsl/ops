package config

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	CrawlMode    string
	Dev          bool
	Listen       string
	DatabaseURL  string
	DataDir      string
	StaticDir    string
	MasterKey    []byte
	WechatBase   string
	MockListen   string
	PublicIP     string
	CookieSecure bool
	// CookieSameSite 是会话 Cookie 的 SameSite 策略。桌面包从安全的自定义协议
	// 跨站请求 API，因此生产部署设为 None，并同时开启 Secure。
	CookieSameSite http.SameSite
	// CORSOrigins 是允许跨源调用 API 的前端来源白名单。为空表示不启用 CORS。
	CORSOrigins []string
	// DesktopAIEnabled is an explicit global kill switch for desktop model routing.
	DesktopAIEnabled bool
	// DesktopPlatformEnabled is an explicit global kill switch for platform collection
	// (D-129). It is process configuration, never overridable by a workspace policy row.
	DesktopPlatformEnabled bool
	// DesktopPlatformAutoAdopt is the second gate for D-129: even with a connection's
	// own switch on, platform readings are only written into official metrics when an
	// operator has explicitly enabled this after formal acceptance (DEV-PS62).
	DesktopPlatformAutoAdopt bool
	// DesktopLatestVersion / DesktopReleaseNotes / DesktopDownloadURL / DesktopDownloadSHA256
	// 是 OPT-E02 的只读版本元数据（GET /desktop/release）。它们只影响该接口的响应，
	// 格式异常不会阻断服务启动，统一由出口函数清洗与降级。
	DesktopLatestVersion  string
	DesktopReleaseNotes   string
	DesktopDownloadURL    string
	DesktopDownloadSHA256 string
	// AIWorkers is the per-workspace concurrency of background and streaming AI jobs (D-054).
	AIWorkers int
	// OfficeRenderDir 是 C3 独立 Node Office 渲染器目录（含 render.mjs 与 templates）。
	// 为空时服务端在常见工作目录中探测；显式配置不存在的目录会让构建明确失败，
	// 而不是回退到伪文件（C3-A5）。
	OfficeRenderDir string
	// Permanent system admin (D-044). Ensured on every serve start.
	SystemAdminUser     string
	SystemAdminPassword string
}

func Load() (*Config, error) {
	c := &Config{
		Dev:                      os.Getenv("OPS_DEV") != "0",
		Listen:                   env("OPS_LISTEN", ":8080"),
		DatabaseURL:              env("OPS_DATABASE_URL", "postgres://ops:ops_dev_password@localhost:5440/ops?sslmode=disable"),
		DataDir:                  env("OPS_DATA_DIR", "./data"),
		StaticDir:                os.Getenv("OPS_STATIC_DIR"),
		MockListen:               env("OPS_MOCK_LISTEN", "127.0.0.1:8091"),
		PublicIP:                 os.Getenv("OPS_PUBLIC_IP"),
		OfficeRenderDir:          strings.TrimSpace(os.Getenv("OPS_OFFICE_RENDER_DIR")),
		SystemAdminUser:          env("OPS_SYSTEM_ADMIN_USER", "skyeder"),
		SystemAdminPassword:      os.Getenv("OPS_SYSTEM_ADMIN_PASSWORD"),
		DesktopAIEnabled:         false,
		DesktopPlatformEnabled:   false,
		DesktopPlatformAutoAdopt: false,
		// OPT-E02：桌面端版本更新元数据。非法值不在 Load 阶段报错，避免一个写错的
		// 下载链接让整个服务起不来；由 /desktop/release 出口统一置空降级。
		DesktopLatestVersion:  strings.TrimSpace(os.Getenv("OPS_DESKTOP_LATEST_VERSION")),
		DesktopReleaseNotes:   strings.TrimSpace(os.Getenv("OPS_DESKTOP_RELEASE_NOTES")),
		DesktopDownloadURL:    strings.TrimSpace(os.Getenv("OPS_DESKTOP_DOWNLOAD_URL")),
		DesktopDownloadSHA256: strings.TrimSpace(os.Getenv("OPS_DESKTOP_SHA256")),
	}
	if v := strings.TrimSpace(os.Getenv("OPS_DESKTOP_AI_ENABLED")); v != "" {
		switch strings.ToLower(v) {
		case "1", "true":
			c.DesktopAIEnabled = true
		case "0", "false":
			c.DesktopAIEnabled = false
		default:
			return nil, errors.New("OPS_DESKTOP_AI_ENABLED 只能为 0/1/false/true")
		}
	}
	if v := strings.TrimSpace(os.Getenv("OPS_DESKTOP_PLATFORM_ENABLED")); v != "" {
		switch strings.ToLower(v) {
		case "1", "true":
			c.DesktopPlatformEnabled = true
		case "0", "false":
			c.DesktopPlatformEnabled = false
		default:
			return nil, errors.New("OPS_DESKTOP_PLATFORM_ENABLED 只能为 0/1/false/true")
		}
	}
	// 自动采用的闸门单独一个变量：验收未过也能回滚，且不必连带停掉自动采集。
	if v := strings.TrimSpace(os.Getenv("OPS_DESKTOP_PLATFORM_AUTO_ADOPT")); v != "" {
		switch strings.ToLower(v) {
		case "1", "true":
			c.DesktopPlatformAutoAdopt = true
		case "0", "false":
			c.DesktopPlatformAutoAdopt = false
		default:
			return nil, errors.New("OPS_DESKTOP_PLATFORM_AUTO_ADOPT 只能为 0/1/false/true")
		}
	}
	c.AIWorkers = 3
	c.CrawlMode = env("OPS_CRAWL_MODE", "off")
	if c.CrawlMode != "off" && c.CrawlMode != "allow" {
		return nil, errors.New("OPS_CRAWL_MODE 只能为 off 或 allow")
	}
	if n, err := strconv.Atoi(os.Getenv("OPS_AI_WORKERS")); err == nil && n >= 1 && n <= 32 {
		c.AIWorkers = n
	}
	c.WechatBase = os.Getenv("OPS_WECHAT_BASE")
	if c.WechatBase == "" {
		if c.Dev {
			c.WechatBase = "http://" + c.MockListen
		} else {
			c.WechatBase = "https://api.weixin.qq.com"
		}
	}
	// 默认：生产 Secure、开发非 Secure。纯 HTTP 上线可设 OPS_COOKIE_SECURE=0。
	if v := os.Getenv("OPS_COOKIE_SECURE"); v == "0" || strings.EqualFold(v, "false") {
		c.CookieSecure = false
	} else if v == "1" || strings.EqualFold(v, "true") {
		c.CookieSecure = true
	} else {
		c.CookieSecure = !c.Dev
	}

	// 桌面包使用 ops-desktop://business，访问 HTTPS API 属于跨站请求，生产环境用 None。
	c.CookieSameSite = http.SameSiteLaxMode
	switch v := strings.ToLower(strings.TrimSpace(os.Getenv("OPS_COOKIE_SAMESITE"))); v {
	case "", "lax":
		c.CookieSameSite = http.SameSiteLaxMode
	case "strict":
		c.CookieSameSite = http.SameSiteStrictMode
	case "none":
		if !c.CookieSecure {
			return nil, errors.New("OPS_COOKIE_SAMESITE=none 必须同时设置 OPS_COOKIE_SECURE=1")
		}
		c.CookieSameSite = http.SameSiteNoneMode
	default:
		return nil, errors.New("OPS_COOKIE_SAMESITE 只能为 lax/strict/none")
	}

	// 跨源页面来源白名单，逗号分隔。桌面发行版使用 ops-desktop://business。
	// 留空即不启用 CORS。
	if raw := strings.TrimSpace(os.Getenv("OPS_CORS_ORIGINS")); raw != "" {
		for _, item := range strings.Split(raw, ",") {
			origin := normalizeOrigin(item)
			if origin == "" {
				continue
			}
			c.CORSOrigins = append(c.CORSOrigins, origin)
		}
		if len(c.CORSOrigins) == 0 {
			return nil, errors.New("OPS_CORS_ORIGINS 中没有合法的来源（应形如 https://web.example.com 或 ops-desktop://business）")
		}
	}

	if raw := os.Getenv("OPS_MASTER_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 {
			return nil, errors.New("OPS_MASTER_KEY 必须是 32 字节的 base64 编码")
		}
		c.MasterKey = key
	} else if c.Dev {
		// Development only: a fixed key so local data survives restarts. Never used in production.
		sum := sha256.Sum256([]byte("ops-local-development-key"))
		c.MasterKey = sum[:]
	} else {
		return nil, errors.New("生产环境必须设置 OPS_MASTER_KEY")
	}

	abs, err := filepath.Abs(c.DataDir)
	if err != nil {
		return nil, err
	}
	c.DataDir = abs
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// normalizeOrigin 把配置里的一项整理成 scheme://host[:port] 形式：
// 去掉首尾空白与末尾的斜杠，丢掉带路径或查询串的非法项。
func normalizeOrigin(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	v = strings.TrimSuffix(v, "/")
	if strings.ContainsAny(v, "?#") {
		return ""
	}
	if v == "ops-desktop://business" {
		return v
	}
	scheme, rest, ok := strings.Cut(v, "://")
	if !ok || (scheme != "http" && scheme != "https") {
		return ""
	}
	if rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return scheme + "://" + rest
}
