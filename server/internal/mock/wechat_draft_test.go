package mock

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Q-26（docs/41）：draft/batchget、draft/count、draft/delete 的 mock 端点要与
// 官方响应形状一致，否则适配器单测会与真实接口漂移。
func TestWechatDraftBatchCountDelete(t *testing.T) {
	m := NewWechat()
	srv := httptest.NewServer(m.Handler())
	defer srv.Close()
	tok := mockToken(t, srv.URL)

	m.mu.Lock()
	m.drafts["d1"] = &draft{MediaID: "d1", Article: map[string]any{"title": "标题一"}, UpdatedAt: time.Now().Add(-time.Minute)}
	m.drafts["d2"] = &draft{MediaID: "d2", Article: map[string]any{"title": "标题二"}, UpdatedAt: time.Now()}
	m.mu.Unlock()

	var count struct {
		TotalCount int `json:"total_count"`
	}
	postJSON(t, srv.URL+"/cgi-bin/draft/count?access_token="+tok, map[string]any{}, &count)
	if count.TotalCount != 2 {
		t.Fatalf("count = %d，期望 2", count.TotalCount)
	}

	var page struct {
		TotalCount int `json:"total_count"`
		ItemCount  int `json:"item_count"`
		Item       []struct {
			MediaID string `json:"media_id"`
			Content *struct {
				NewsItem []map[string]any `json:"news_item"`
			} `json:"content"`
		} `json:"item"`
	}
	postJSON(t, srv.URL+"/cgi-bin/draft/batchget?access_token="+tok, map[string]any{"offset": 0, "count": 2, "no_content": 1}, &page)
	if page.TotalCount != 2 || page.ItemCount != 2 || len(page.Item) != 2 {
		t.Fatalf("batchget = %+v，期望 2/2/2", page)
	}
	if page.Item[0].MediaID != "d2" {
		t.Fatalf("应按 update_time 倒序，首条 = %s", page.Item[0].MediaID)
	}
	if page.Item[0].Content != nil {
		t.Fatal("no_content=1 不应返回正文")
	}

	postJSON(t, srv.URL+"/cgi-bin/draft/batchget?access_token="+tok, map[string]any{"offset": 0, "count": 1, "no_content": 0}, &page)
	if page.Item[0].Content == nil || len(page.Item[0].Content.NewsItem) == 0 {
		t.Fatal("no_content=0 应返回 content.news_item")
	}

	if err := postJSONStatus(t, srv.URL+"/cgi-bin/draft/delete?access_token="+tok, map[string]any{"media_id": "d1"}); err != 0 {
		t.Fatalf("delete errcode = %d，期望 0", err)
	}
	postJSON(t, srv.URL+"/cgi-bin/draft/count?access_token="+tok, map[string]any{}, &count)
	if count.TotalCount != 1 {
		t.Fatalf("delete 后 count = %d，期望 1", count.TotalCount)
	}
	if err := postJSONStatus(t, srv.URL+"/cgi-bin/draft/delete?access_token="+tok, map[string]any{"media_id": "d1"}); err != 40007 {
		t.Fatalf("重复删除 errcode = %d，期望 40007", err)
	}
}

func mockToken(t *testing.T, base string) string {
	t.Helper()
	resp, err := http.Get(base + "/cgi-bin/token?grant_type=client_credential&appid=wx-mock&secret=s")
	if err != nil {
		t.Fatalf("获取 mock token: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.AccessToken == "" {
		t.Fatalf("mock token 解析失败：%v %+v", err, out)
	}
	return out.AccessToken
}

func postJSON(t *testing.T, url string, in, out any) {
	t.Helper()
	body, _ := json.Marshal(in)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatalf("解析 %s 响应：%v", url, err)
	}
}

func postJSONStatus(t *testing.T, url string, in any) int {
	t.Helper()
	var out struct {
		ErrCode int `json:"errcode"`
	}
	postJSON(t, url, in, &out)
	return out.ErrCode
}
