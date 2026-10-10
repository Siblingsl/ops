package mock

import (
	"encoding/json"
	"net/http"
)

// HotHandler serves only deterministic development fixtures, never real websites.
func HotHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("User-agent: *\nDisallow: /private\nDisallow: /trending/\n"))
	})
	mux.HandleFunc("/mock/hot/baidu", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<!--s-data:{"data":{"cards":[{"content":[{"query":"互联网运营团队的新实践","rawUrl":"https://example.com/ops","hotScore":"10000"},{"query":"电商用户增长的真实案例","rawUrl":"https://example.com/growth","hotScore":"9000"},{"query":"内容运营与职场沟通","rawUrl":"https://example.com/content","hotScore":"8000"},{"query":"灾难事故伤亡消息","rawUrl":"https://example.com/disaster","hotScore":"7000"}]}]}}-->`))
	})
	mux.HandleFunc("/mock/hot/toutiao", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"Title": "互联网运营团队的新实践", "Url": "https://example.com/ops", "HotValue": "9000"}, {"Title": "职场沟通与运营经验", "Url": "https://example.com/team", "HotValue": "8000"}}})
	})
	mux.HandleFunc("/mock/hot/rss", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(`<rss version="2.0"><channel><title>模拟资讯</title><item><title>互联网运营团队协作新方法</title><link>https://example.com/rss-ops</link><description>公开摘要</description></item></channel></rss>`))
	})
	mux.HandleFunc("/mock/page/", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/mock/page/login":
			_, _ = w.Write([]byte("请先登录"))
		case "/mock/page/captcha":
			_, _ = w.Write([]byte("验证码"))
		case "/mock/page/429":
			w.WriteHeader(429)
		default:
			_, _ = w.Write([]byte(`<html><head><title>运营复盘参考</title><meta name="description" content="公开文章摘要"></head><body><article>以实际场景开始，解释原因，提供练习步骤。</article></body></html>`))
		}
	})
	return mux
}
