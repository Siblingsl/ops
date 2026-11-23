package wechat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Q-24（docs/41）：微信出站必须直连，不得继承环境代理变量——出口 IP 要与
// OPS_PUBLIC_IP / 公众号 IP 白名单一致（NFR-02），且与 crawl.Client 约定对齐。
func TestClientTransportIgnoresEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("http_proxy", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")

	c := New("https://api.weixin.qq.com")
	// http.Transport 语义：Transport 显式设置且 Proxy == nil → 不使用任何代理
	//（ProxyFromEnvironment 仅在 Transport 为 nil 回落 DefaultTransport 或 Proxy 函数内部触发）。
	tr, ok := c.http.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport 类型 = %T，期望 *http.Transport", c.http.Transport)
	}
	if tr.Proxy != nil {
		t.Fatal("Transport.Proxy 应为 nil（显式禁用代理），与 crawl.Client 约定一致")
	}
}

func TestClientGetTokenParsesToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("出站请求携带了 Proxy-Authorization，说明走了代理")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok123","expires_in":7200}`))
	}))
	defer srv.Close()

	tok, err := New(srv.URL).GetToken(context.Background(), "appid", "secret")
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if tok.AccessToken != "tok123" || tok.ExpiresIn != 7200 {
		t.Fatalf("回读不正确：%+v", tok)
	}
}

func TestClientDoMapsWechatError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":40164,"errmsg":"invalid ip 1.2.3.4, not in whitelist"}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL).GetToken(context.Background(), "appid", "secret")
	if err == nil {
		t.Fatal("40164 应返回错误")
	}
	we, ok := err.(*Error)
	if !ok {
		t.Fatalf("期望 *wechat.Error，得到 %T", err)
	}
	if we.Code != 40164 {
		t.Fatalf("errcode = %d，期望 40164", we.Code)
	}
	if got := we.Readable(); got == "" || got == we.Msg {
		t.Fatalf("40164 应映射为中文引导文案，得到 %q", got)
	}
}

// Q-26（docs/41）：draft/batchget、draft/count、draft/delete 是 docs/02 矩阵内
// 个人号可用能力，此前只有 adapter 缺口。以下按官方请求/响应形状锁定适配器契约。
func TestClientDraftBatchGetParsesListAndClampsPaging(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cgi-bin/draft/batchget" {
			t.Errorf("请求路径 = %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"total_count":3,"item_count":2,"item":[
			{"media_id":"d1","update_time":1700000000,"content":{"news_item":[{"title":"标题一","content":"正文一"}]}},
			{"media_id":"d2","update_time":1690000000}
		]}`))
	}))
	defer srv.Close()

	total, items, err := New(srv.URL).DraftBatchGet(context.Background(), "tok", -5, 99, true)
	if err != nil {
		t.Fatalf("DraftBatchGet: %v", err)
	}
	if total != 3 || len(items) != 2 {
		t.Fatalf("total=%d items=%d，期望 3/2", total, len(items))
	}
	if items[0].MediaID != "d1" || items[0].Title != "标题一" || items[0].UpdateTime != 1700000000 {
		t.Fatalf("首条解析不正确：%+v", items[0])
	}
	if items[1].MediaID != "d2" || items[1].Title != "" {
		t.Fatalf("无正文条目应只有 media_id：%+v", items[1])
	}
	if gotBody["offset"] != float64(0) || gotBody["count"] != float64(20) || gotBody["no_content"] != float64(1) {
		t.Fatalf("分页参数未夹紧或 no_content 未生效：%+v", gotBody)
	}
}

func TestClientDraftCountAndDelete(t *testing.T) {
	var deleted string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cgi-bin/draft/count":
			_, _ = w.Write([]byte(`{"total_count":7}`))
		case "/cgi-bin/draft/delete":
			var in struct {
				MediaID string `json:"media_id"`
			}
			_ = json.NewDecoder(r.Body).Decode(&in)
			deleted = in.MediaID
			_, _ = w.Write([]byte(`{"errcode":0,"errmsg":"ok"}`))
		default:
			t.Errorf("意外路径 %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	c := New(srv.URL)
	total, err := c.DraftCount(context.Background(), "tok")
	if err != nil || total != 7 {
		t.Fatalf("DraftCount = %d, %v，期望 7", total, err)
	}
	if err := c.DraftDelete(context.Background(), "tok", "d1"); err != nil {
		t.Fatalf("DraftDelete: %v", err)
	}
	if deleted != "d1" {
		t.Fatalf("删除 media_id = %q，期望 d1", deleted)
	}
}

func TestClientDraftDeleteMapsMissingDraft(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"errcode":40007,"errmsg":"invalid media_id"}`))
	}))
	defer srv.Close()

	err := New(srv.URL).DraftDelete(context.Background(), "tok", "gone")
	we, ok := err.(*Error)
	if !ok || we.Code != 40007 {
		t.Fatalf("期望 40007 *wechat.Error，得到 %T %v", err, err)
	}
}
