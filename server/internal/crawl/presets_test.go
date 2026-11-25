package crawl

import (
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestOPTA04PresetSourcesArePublicAndClientFree(t *testing.T) {
	list := PresetRSSSources()
	if len(list) != 5 {
		t.Fatalf("preset count = %d", len(list))
	}
	seen := map[string]bool{}
	for _, p := range list {
		if p.Kind != "rss" || p.Key == "" || p.Name == "" || p.Category == "" || p.Description == "" {
			t.Fatalf("incomplete preset %+v", p)
		}
		if seen[p.Key] {
			t.Fatalf("duplicate preset key %s", p.Key)
		}
		seen[p.Key] = true
		if !strings.HasPrefix(p.URL, "https://") {
			t.Fatalf("preset must be https: %s", p.URL)
		}
		u, err := url.Parse(p.URL)
		if err != nil || u.Host == "" || u.User != nil {
			t.Fatalf("invalid preset url %s %v", p.URL, err)
		}
		if Sensitive(u.Hostname()) != "" {
			t.Fatalf("sensitive preset domain %s", p.URL)
		}
	}
	// 预置模板不得绕过统一采集客户端（HC-23 同一红线）。
	for _, name := range []string{"presets.go", "sources.go"} {
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "http.Client") || strings.Contains(string(b), "http.Get(") {
			t.Fatalf("%s must not instantiate its own network client", name)
		}
	}
}

func TestOPTA04PresetSourceKeysAreStable(t *testing.T) {
	want := map[string]string{
		"preset:rss:36kr":       "https://36kr.com/feed",
		"preset:rss:sspai":      "https://sspai.com/feed",
		"preset:rss:ifanr":      "https://www.ifanr.com/feed",
		"preset:rss:ruanyifeng": "https://www.ruanyifeng.com/blog/atom.xml",
		"preset:rss:huxiu":      "https://www.huxiu.com/rss/0.xml",
	}
	got := map[string]string{}
	for _, p := range PresetRSSSources() {
		got[p.Key] = p.URL
	}
	for key, link := range want {
		if got[key] != link {
			t.Fatalf("%s => %q, want %q", key, got[key], link)
		}
	}
}
