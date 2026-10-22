package config

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
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
	// DesktopAIEnabled is an explicit global kill switch for desktop model routing.
	DesktopAIEnabled bool
	// DesktopPlatformEnabled is an explicit global kill switch for platform collection
	// (D-129). It is process configuration, never overridable by a workspace policy row.
	DesktopPlatformEnabled bool
	// DesktopPlatformAutoAdopt is the second gate for D-129: even with a connection's
	// own switch on, platform readings are only written into official metrics when an
	// operator has explicitly enabled this after formal acceptance (DEV-PS62).
	DesktopPlatformAutoAdopt bool
	// AIWorkers is the per-workspace concurrency of background and streaming AI jobs (D-054).
	AIWorkers int
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
		SystemAdminUser:          env("OPS_SYSTEM_ADMIN_USER", "skyeder"),
		SystemAdminPassword:      os.Getenv("OPS_SYSTEM_ADMIN_PASSWORD"),
		DesktopAIEnabled:         false,
		DesktopPlatformEnabled:   false,
		DesktopPlatformAutoAdopt: false,
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
