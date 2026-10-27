package config

import (
	"net/http"
	"testing"
)

// D-153：跨源前端白名单与 Cookie SameSite 的解析。
func TestLoadCORSAndSameSite(t *testing.T) {
	t.Run("默认不启用 CORS，SameSite=Lax", func(t *testing.T) {
		t.Setenv("OPS_CORS_ORIGINS", "")
		t.Setenv("OPS_COOKIE_SAMESITE", "")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if len(c.CORSOrigins) != 0 {
			t.Fatalf("默认不应启用 CORS，得到 %v", c.CORSOrigins)
		}
		if c.CookieSameSite != http.SameSiteLaxMode {
			t.Fatalf("默认 SameSite 应为 Lax，得到 %v", c.CookieSameSite)
		}
	})

	t.Run("多个来源按逗号拆分并规范化", func(t *testing.T) {
		t.Setenv("OPS_CORS_ORIGINS", " https://web.88813888.xyz/ , https://staging.88813888.xyz")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		want := []string{"https://web.88813888.xyz", "https://staging.88813888.xyz"}
		if len(c.CORSOrigins) != len(want) {
			t.Fatalf("来源数量 = %d，期望 %d（%v）", len(c.CORSOrigins), len(want), c.CORSOrigins)
		}
		for i := range want {
			if c.CORSOrigins[i] != want[i] {
				t.Fatalf("来源[%d] = %q，期望 %q", i, c.CORSOrigins[i], want[i])
			}
		}
	})

	t.Run("全部非法时报错", func(t *testing.T) {
		t.Setenv("OPS_CORS_ORIGINS", "web.88813888.xyz,ftp://x,https://web.88813888.xyz/path")
		if _, err := Load(); err == nil {
			t.Fatal("期望因没有合法来源而报错")
		}
	})

	t.Run("SameSite=none 需要 Secure", func(t *testing.T) {
		t.Setenv("OPS_COOKIE_SAMESITE", "none")
		t.Setenv("OPS_COOKIE_SECURE", "0")
		if _, err := Load(); err == nil {
			t.Fatal("SameSite=none 且未开 Secure 时应报错")
		}
		t.Setenv("OPS_COOKIE_SECURE", "1")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if c.CookieSameSite != http.SameSiteNoneMode {
			t.Fatalf("SameSite 应为 None，得到 %v", c.CookieSameSite)
		}
	})

	t.Run("非法 SameSite 报错", func(t *testing.T) {
		t.Setenv("OPS_COOKIE_SAMESITE", "loose")
		if _, err := Load(); err == nil {
			t.Fatal("非法 SameSite 应报错")
		}
	})
}

func TestNormalizeOrigin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://web.88813888.xyz", "https://web.88813888.xyz"},
		{"ops-desktop://business", "ops-desktop://business"},
		{"ops-desktop://attacker", ""},
		{"  https://web.88813888.xyz/  ", "https://web.88813888.xyz"},
		{"http://localhost:5173", "http://localhost:5173"},
		{"https://web.88813888.xyz/path", ""},
		{"https://web.88813888.xyz?q=1", ""},
		{"web.88813888.xyz", ""},
		{"ftp://web.88813888.xyz", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizeOrigin(c.in); got != c.want {
			t.Fatalf("normalizeOrigin(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}
