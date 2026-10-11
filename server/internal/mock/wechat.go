// Package mock provides local stand-ins for the WeChat API and an OpenAI-compatible model
// so the whole flow runs without real credentials (08 文档第 6.3 节).
package mock

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type draft struct {
	MediaID   string
	Article   map[string]any
	UpdatedAt time.Time
}

type Wechat struct {
	mu     sync.Mutex
	tokens map[string]time.Time
	drafts map[string]*draft
	images map[string][]byte
	calls  []string

	articleTotals map[string][]map[string]any // nil: one sample article per day
	datacubeErr   int
}

// SetArticleTotals replaces the getarticletotal data keyed by ref_date; nil restores the sample.
func (m *Wechat) SetArticleTotals(data map[string][]map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.articleTotals = data
}

// SetDatacubeDenied makes datacube calls fail with 48001, like an unverified account.
func (m *Wechat) SetDatacubeDenied(denied bool) {
	code := 0
	if denied {
		code = 48001
	}
	m.SetDatacubeError(code)
}

// SetDatacubeError makes datacube calls fail with the given errcode (0 clears it).
func (m *Wechat) SetDatacubeError(code int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.datacubeErr = code
}

func NewWechat() *Wechat {
	return &Wechat{tokens: map[string]time.Time{}, drafts: map[string]*draft{}, images: map[string][]byte{}}
}

func (m *Wechat) Calls() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.calls...)
}

func wxErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, map[string]any{"errcode": code, "errmsg": msg})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func (m *Wechat) checkToken(w http.ResponseWriter, r *http.Request) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, r.URL.Path)
	exp, ok := m.tokens[r.URL.Query().Get("access_token")]
	if !ok || exp.Before(time.Now()) {
		wxErr(w, 40001, "invalid credential, access_token is invalid or not latest")
		return false
	}
	return true
}

func (m *Wechat) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/cgi-bin/token", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch {
		case q.Get("appid") == "" || !strings.HasPrefix(q.Get("appid"), "wx"):
			wxErr(w, 40013, "invalid appid")
		case q.Get("appid") == "wx-ip-blocked":
			wxErr(w, 40164, "invalid ip 1.2.3.4, not in whitelist")
		case q.Get("secret") == "" || q.Get("secret") == "wrong":
			wxErr(w, 40125, "invalid appsecret")
		default:
			tok := "mock-token-" + uuid.NewString()
			m.mu.Lock()
			m.tokens[tok] = time.Now().Add(2 * time.Hour)
			m.calls = append(m.calls, r.URL.Path)
			m.mu.Unlock()
			writeJSON(w, map[string]any{"access_token": tok, "expires_in": 7200})
		}
	})
	mux.HandleFunc("/cgi-bin/media/uploadimg", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		data, ok := readMedia(w, r)
		if !ok {
			return
		}
		if len(data) > 1<<20 {
			wxErr(w, 40009, "invalid image size")
			return
		}
		id := uuid.NewString()
		m.mu.Lock()
		m.images[id] = data
		m.mu.Unlock()
		writeJSON(w, map[string]any{"url": "http://" + r.Host + "/mock/img/" + id})
	})
	mux.HandleFunc("/cgi-bin/material/add_material", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		data, ok := readMedia(w, r)
		if !ok {
			return
		}
		id := uuid.NewString()
		m.mu.Lock()
		m.images[id] = data
		m.mu.Unlock()
		writeJSON(w, map[string]any{"media_id": "mock-media-" + id, "url": "http://" + r.Host + "/mock/img/" + id})
	})
	mux.HandleFunc("/cgi-bin/draft/add", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		var in struct {
			Articles []map[string]any `json:"articles"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || len(in.Articles) == 0 {
			wxErr(w, 44003, "empty news data")
			return
		}
		if code, msg := validateArticle(in.Articles[0]); code != 0 {
			wxErr(w, code, msg)
			return
		}
		id := "mock-draft-" + uuid.NewString()
		m.mu.Lock()
		m.drafts[id] = &draft{MediaID: id, Article: in.Articles[0], UpdatedAt: time.Now()}
		m.mu.Unlock()
		writeJSON(w, map[string]any{"media_id": id})
	})
	mux.HandleFunc("/cgi-bin/draft/update", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		var in struct {
			MediaID  string         `json:"media_id"`
			Articles map[string]any `json:"articles"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			wxErr(w, 44003, "empty news data")
			return
		}
		if code, msg := validateArticle(in.Articles); code != 0 {
			wxErr(w, code, msg)
			return
		}
		m.mu.Lock()
		d, ok := m.drafts[in.MediaID]
		if ok {
			d.Article = in.Articles
			d.UpdatedAt = time.Now()
		}
		m.mu.Unlock()
		if !ok {
			wxErr(w, 40007, "invalid media_id")
			return
		}
		writeJSON(w, map[string]any{"errcode": 0, "errmsg": "ok"})
	})
	mux.HandleFunc("/cgi-bin/draft/get", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		var in struct {
			MediaID string `json:"media_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		m.mu.Lock()
		d, ok := m.drafts[in.MediaID]
		m.mu.Unlock()
		if !ok {
			wxErr(w, 40007, "invalid media_id")
			return
		}
		writeJSON(w, map[string]any{"news_item": []any{d.Article}})
	})
	mux.HandleFunc("/datacube/getarticletotal", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		var in struct {
			BeginDate string `json:"begin_date"`
			EndDate   string `json:"end_date"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		m.mu.Lock()
		code, data := m.datacubeErr, m.articleTotals
		m.mu.Unlock()
		switch code {
		case 0:
		case 48001:
			wxErr(w, code, "api unauthorized")
			return
		default:
			wxErr(w, code, "mock datacube failure")
			return
		}
		if in.BeginDate == "" || in.BeginDate != in.EndDate {
			wxErr(w, 61501, "date range error")
			return
		}
		list := []map[string]any{}
		if data != nil {
			list = append(list, data[in.BeginDate]...)
		} else if ref, err := time.Parse("2006-01-02", in.BeginDate); err == nil {
			details := []any{}
			for d := 0; d < 7 && !ref.AddDate(0, 0, d).After(time.Now().AddDate(0, 0, -1)); d++ {
				details = append(details, map[string]any{"stat_date": ref.AddDate(0, 0, d).Format("2006-01-02"),
					"target_user": 1000, "int_page_read_user": 120 * (d + 1), "int_page_read_count": 180 * (d + 1),
					"share_user": 8 * (d + 1), "share_count": 10 * (d + 1), "add_to_fav_user": 3 * (d + 1), "add_to_fav_count": 3 * (d + 1)})
			}
			list = append(list, map[string]any{"ref_date": in.BeginDate, "msgid": "1000" + ref.Format("0102") + "_1", "title": "模拟稿件", "details": details})
		}
		writeJSON(w, map[string]any{"list": list})
	})
	mux.HandleFunc("/cgi-bin/draft/batchget", func(w http.ResponseWriter, r *http.Request) {
		if !m.checkToken(w, r) {
			return
		}
		var in struct {
			Offset int `json:"offset"`
			Count  int `json:"count"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in.Count <= 0 {
			in.Count = 20
		}
		m.mu.Lock()
		ids := make([]string, 0, len(m.drafts))
		for id := range m.drafts {
			ids = append(ids, id)
		}
		m.mu.Unlock()
		total := len(ids)
		if in.Offset > total {
			in.Offset = total
		}
		end := in.Offset + in.Count
		if end > total {
			end = total
		}
		items := []any{}
		for _, id := range ids[in.Offset:end] {
			items = append(items, map[string]any{"media_id": id})
		}
		writeJSON(w, map[string]any{"total_count": total, "item_count": len(items), "item": items})
	})
	mux.HandleFunc("/mock/img/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		data, ok := m.images[strings.TrimPrefix(r.URL.Path, "/mock/img/")]
		m.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", http.DetectContentType(data))
		_, _ = w.Write(data)
	})
	mux.HandleFunc("/mock/drafts/", m.draftPage)
	mux.HandleFunc("/mock/drafts", m.draftPage)
	return mux
}

func readMedia(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	f, _, err := r.FormFile("media")
	if err != nil {
		wxErr(w, 41005, "media data missing")
		return nil, false
	}
	defer f.Close()
	data, _ := io.ReadAll(f)
	return data, true
}

func validateArticle(a map[string]any) (int, string) {
	title, _ := a["title"].(string)
	content, _ := a["content"].(string)
	if len([]rune(title)) == 0 || len([]rune(title)) > 32 {
		return 45003, "title size out of limit"
	}
	if author, _ := a["author"].(string); len([]rune(author)) > 16 {
		return 45110, "author size out of limit"
	}
	if digest, _ := a["digest"].(string); len([]rune(digest)) > 120 {
		return 45004, "description size out of limit"
	}
	if len([]rune(content)) >= 20000 || len(content) >= 1<<20 {
		return 45002, "content size out of limit"
	}
	if strings.Contains(strings.ToLower(content), "<script") {
		return 45166, "invalid content"
	}
	if t, _ := a["article_type"].(string); t == "newspic" {
		info, _ := a["image_info"].(map[string]any)
		list, _ := info["image_list"].([]any)
		if len(list) == 0 || len(list) > 20 {
			return 40007, "invalid image_list"
		}
		for _, it := range list {
			m, _ := it.(map[string]any)
			if id, _ := m["image_media_id"].(string); id == "" {
				return 40007, "invalid image_media_id"
			}
		}
	} else {
		if thumb, _ := a["thumb_media_id"].(string); thumb == "" {
			return 40007, "invalid media_id"
		}
	}
	return 0, ""
}

// draftPage is a stand-in for the 公众号后台草稿箱: lists drafts, previews them and can
// simulate an edit made in the backend (E-18).
func (m *Wechat) draftPage(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/mock/drafts"), "/")
	if r.Method == http.MethodPost && strings.HasSuffix(id, "/touch") {
		id = strings.TrimSuffix(id, "/touch")
		m.mu.Lock()
		if d, ok := m.drafts[id]; ok {
			c, _ := d.Article["content"].(string)
			d.Article["content"] = c + "<p>（在公众号后台补充的一句话）</p>"
			d.UpdatedAt = time.Now()
		}
		m.mu.Unlock()
		http.Redirect(w, r, "/mock/drafts/"+id, http.StatusSeeOther)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	b.WriteString(`<!doctype html><meta charset="utf-8"><title>模拟公众号草稿箱</title>
<style>body{font-family:system-ui,"PingFang SC","Microsoft YaHei";background:#f2f3f5;margin:0;color:#222}
.top{background:#fff;padding:14px 24px;border-bottom:1px solid #e5e5e5;font-weight:600}.top span{color:#888;font-weight:400;margin-left:8px;font-size:13px}
.wrap{max-width:760px;margin:24px auto;padding:0 16px}.card{background:#fff;border-radius:8px;padding:16px 20px;margin-bottom:12px;display:block;color:inherit;text-decoration:none}
.card:hover{box-shadow:0 2px 10px rgba(0,0,0,.06)}.meta{color:#888;font-size:13px;margin-top:6px}.phone{background:#fff;max-width:420px;margin:0 auto;padding:20px 16px;border-radius:12px}
h1{font-size:22px;line-height:1.4}button{background:#07c160;color:#fff;border:0;border-radius:4px;padding:8px 14px;cursor:pointer}</style>
<div class="top">模拟公众号后台 · 草稿箱<span>本地开发用，代替 mp.weixin.qq.com</span></div><div class="wrap">`)
	if d, ok := m.drafts[id]; ok {
		title, _ := d.Article["title"].(string)
		author, _ := d.Article["author"].(string)
		content, _ := d.Article["content"].(string)
		fmt.Fprintf(&b, `<p><a href="/mock/drafts">← 返回草稿箱</a></p><div class="phone"><h1>%s</h1><div class="meta">%s · 草稿 · 最后修改 %s</div><hr style="border:0;border-top:1px solid #eee;margin:16px 0">%s</div>
<form method="post" action="/mock/drafts/%s/touch" style="text-align:center;margin:20px"><button>模拟在后台修改这篇草稿</button></form>`,
			html.EscapeString(title), html.EscapeString(author), d.UpdatedAt.Format("01-02 15:04:05"), content, d.MediaID)
	} else {
		list := make([]*draft, 0, len(m.drafts))
		for _, d := range m.drafts {
			list = append(list, d)
		}
		sort.Slice(list, func(i, j int) bool { return list[i].UpdatedAt.After(list[j].UpdatedAt) })
		if len(list) == 0 {
			b.WriteString(`<div class="card">草稿箱是空的。</div>`)
		}
		for _, d := range list {
			title, _ := d.Article["title"].(string)
			fmt.Fprintf(&b, `<a class="card" href="/mock/drafts/%s"><div>%s</div><div class="meta">最后修改 %s</div></a>`,
				d.MediaID, html.EscapeString(title), d.UpdatedAt.Format("01-02 15:04:05"))
		}
	}
	b.WriteString(`</div>`)
	_, _ = w.Write([]byte(b.String()))
}
