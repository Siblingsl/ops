package crawl

import (
	"strings"
	"testing"
)

func TestBoardParsers(t *testing.T) {
	items, err := ParseBaidu([]byte(`<!--s-data:{"data":{"cards":[{"content":[{"query":"真实标题","rawUrl":"https://example.com/a","hotScore":123}]}]}}-->`))
	if err != nil || len(items) != 1 || items[0].Title != "真实标题" {
		t.Fatalf("baidu %v %v", items, err)
	}
	items, err = ParseToutiao([]byte(`{"data":[{"Title":"榜单标题","Url":"https://example.com/b","HotValue":"99"}]}`))
	if err != nil || len(items) != 1 || items[0].Heat != "99" {
		t.Fatalf("toutiao %v %v", items, err)
	}
	if _, err = ParseBaidu([]byte("login page")); err == nil {
		t.Fatal("unknown HTML accepted")
	}
}
func TestFeeds(t *testing.T) {
	for _, body := range []string{`<rss><channel><item><title>资讯</title><link>/a</link><description>&lt;b&gt;摘要&lt;/b&gt;</description></item></channel></rss>`, `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>资讯</title><link rel="alternate" href="/a"/><summary>摘要</summary></entry></feed>`} {
		items, err := ParseRSS([]byte(body), "https://example.com/feed")
		if err != nil || len(items) != 1 || items[0].URL != "https://example.com/a" || strings.Contains(plain(items[0].Summary), "<") {
			t.Fatalf("feed %v %v", items, err)
		}
	}
}
