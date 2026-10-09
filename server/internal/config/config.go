package config

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
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
}

func Load() (*Config, error) {
	c := &Config{
		Dev:         os.Getenv("OPS_DEV") != "0",
		Listen:      env("OPS_LISTEN", ":8080"),
		DatabaseURL: env("OPS_DATABASE_URL", "postgres://ops:ops_dev_password@localhost:5440/ops?sslmode=disable"),
		DataDir:     env("OPS_DATA_DIR", "./data"),
		StaticDir:   os.Getenv("OPS_STATIC_DIR"),
		MockListen:  env("OPS_MOCK_LISTEN", "127.0.0.1:8091"),
		PublicIP:    os.Getenv("OPS_PUBLIC_IP"),
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

