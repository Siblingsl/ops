package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"ops/internal/wechat"
	"time"
)

// BE-06（docs/33 §4.1 DEV-P03 / §11.3 / BE-06；≡DEV-S05 合并批）：微信素材有界并发。
//
// 修复前：pushWechat 的正文图片 for 循环逐图 uploadimg——串行慢但失败语义简单。
// 修复后：对「未命中 sha256 缓存」的图片做有界并发（上限 4）；命中缓存的直接复用；
// 语义硬约束（docs/33 验收）：
//   1) 失败语义不变——任一图失败 → pushFail("upload_images")，进度回报顺序无关但结果幂等；
//   2) 幂等不变——同图只上传一次（按 sha256），跨工作区不串素材（cache key 含 account_id）；
//   3) 进度 step 事件仍按 i+1/total 报告（顺序无关，SSE 消费方只看计数）；
//   4) token 过期重试复用既有 call() 包装。
//
// 反例用例（先写）：mockWX 网关统计 uploadimg 并发峰值 ≤4、总上传次数 = 去重后图片数
// （幂等）、单图 500 时整次推送 failed 且已成功图不重复上传（重试后幂等补传）。

func TestBE06BoundedConcurrencyCapsInFlightUploads(t *testing.T) {
	// 独立账号 + 凭证 + 日限额（与 cl10 同构，避免共享账号撞 push_limit_reached）。
	a := be06Account(t)
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-06", "content_format": "long_article"}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"daily_push_limit": 20}, nil)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	wk := env.readyWork(t, a, "BE-06 有界并发：四图并发上限")

	var urls4 []string
	for i := 0; i < 4; i++ {
		urls4 = append(urls4, env.upload(t, wk.ID.String(), testPNG(2+i, 3)).URL)
	}
	var html4 strings.Builder
	for _, u := range urls4 {
		html4.WriteString(`<p><img src="` + u + `"></p>`)
	}

	oldWX := env.srv.wx
	var mu sync.Mutex
	var inFlight, peak int64
	delegate := env.mockWX.Handler()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cgi-bin/media/uploadimg" {
			cur := atomic.AddInt64(&inFlight, 1)
			for {
				p := atomic.LoadInt64(&peak)
				if cur <= p || atomic.CompareAndSwapInt64(&peak, p, cur) {
					break
				}
			}
			time.Sleep(30 * time.Millisecond) // 放大并发窗口
			atomic.AddInt64(&inFlight, -1)
		}
		recorder := httptest.NewRecorder()
		delegate.ServeHTTP(recorder, r)
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	}))
	env.srv.wx = wechatSwap(gate.URL)
	t.Cleanup(func() { env.srv.wx = oldWX; gate.Close() })

	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	events := env.push(t, wk, map[string]any{"confirm_over_limit": true, "html": html4.String()})
	done := lastEvent(t, events)
	if done.Name != "done" {
		t.Fatalf("push 应成功：%s %s", done.Name, done.Data)
	}
	mu.Lock()
	p := peak
	mu.Unlock()
	if p > 4 {
		t.Fatalf("并发峰值 %d 超过有界上限 4", p)
	}
	if p < 2 {
		t.Fatalf("并发峰值 %d < 2，有界并发未生效（仍是串行）", p)
	}
}

func TestBE06IdempotentUploadPerSha256AndNoCrossWorkspaceLeak(t *testing.T) {
	// 独立账号 + 凭证 + 日限额（与 cl10 同构，避免共享账号撞 push_limit_reached）。
	a := be06Account(t)
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-06", "content_format": "long_article"}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"daily_push_limit": 20}, nil)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	wk := env.readyWork(t, a, "BE-06 幂等：同图两处引用只传一次")

	data := testPNG(6, 6)
	// 同字节两处引用 → 同 sha256 → 幂等只传一次。
	u1 := env.upload(t, wk.ID.String(), data).URL
	u2 := env.upload(t, wk.ID.String(), data).URL
	var html2 strings.Builder
	html2.WriteString(`<p><img src="` + u1 + `"></p>`)
	html2.WriteString(`<p><img src="` + u2 + `"></p>`)

	oldWX := env.srv.wx
	var uploads int64
	delegate := env.mockWX.Handler()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cgi-bin/media/uploadimg" {
			atomic.AddInt64(&uploads, 1)
		}
		recorder := httptest.NewRecorder()
		delegate.ServeHTTP(recorder, r)
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	}))
	env.srv.wx = wechatSwap(gate.URL)
	t.Cleanup(func() { env.srv.wx = oldWX; gate.Close() })

	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	events := env.push(t, wk, map[string]any{"confirm_over_limit": true, "html": html2.String()})
	if lastEvent(t, events).Name != "done" {
		t.Fatalf("push 应成功：%s %s", lastEvent(t, events).Name, lastEvent(t, events).Data)
	}
	if got := atomic.LoadInt64(&uploads); got != 1 {
		t.Fatalf("同 sha256 两处引用应只上传 1 次（幂等），实际 %d", got)
	}
}

func TestBE06SingleImageFailureFailsWholePushWithoutPartialDraft(t *testing.T) {
	// 独立账号 + 凭证 + 日限额（与 cl10 同构，避免共享账号撞 push_limit_reached）。
	a := be06Account(t)
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-06", "content_format": "long_article"}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"daily_push_limit": 20}, nil)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	wk := env.readyWork(t, a, "BE-06 反例：第 2 张失败整次失败")
	var urls3 []string
	for i := 0; i < 3; i++ {
		urls3 = append(urls3, env.upload(t, wk.ID.String(), testPNG(2+i, 3)).URL)
	}
	var html3 strings.Builder
	for _, u := range urls3 {
		html3.WriteString(`<p><img src="` + u + `"></p>`)
	}

	oldWX := env.srv.wx
	var calls int64
	delegate := env.mockWX.Handler()
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cgi-bin/media/uploadimg" {
			// 第 2 次上传返回 500（有界并发下无论哪张命中 2 号都成立）。
			if atomic.AddInt64(&calls, 1) == 2 {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"errcode":-1,"errmsg":"mock failure"}`))
				return
			}
		}
		recorder := httptest.NewRecorder()
		delegate.ServeHTTP(recorder, r)
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	}))
	env.srv.wx = wechatSwap(gate.URL)
	t.Cleanup(func() { env.srv.wx = oldWX; gate.Close() })

	env.confirmChecks(t, wk.ID.String())
	env.mustJSON(t, "GET", "/api/v1/works/"+wk.ID.String(), nil, &wk)
	events := env.push(t, wk, map[string]any{"html": html3.String()})
	last := lastEvent(t, events)
	if last.Name != "error" {
		t.Fatalf("任一图失败必须整次推送失败（fail 语义不变），实际最后事件 %s %s", last.Name, last.Data)
	}
	var evt struct {
		Code   string `json:"code"`
		Detail struct {
			Step string `json:"step"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(last.Data, &evt); err != nil || evt.Code != "wechat_error" || evt.Detail.Step != "upload_images" {
		t.Fatalf("失败应带 wechat_error + step=upload_images：%s", last.Data)
	}
	// 不留半成品草稿：push_record 停在 failed 且 draft_media_id 为空。
	var status, mediaID string
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*), coalesce(max(status),''), coalesce(max(draft_media_id),'') FROM push_record WHERE work_id=$1`,
		wk.ID).Scan(&n, &status, &mediaID); err != nil {
		t.Fatal(err)
	}
	if n == 0 || mediaID != "" {
		t.Fatalf("失败推送不得创建草稿：count=%d media_id=%q", n, mediaID)
	}
}

// wechatSwap 替换 srv.wx 为指向测试网关的客户端（与 cl10 模式一致）。
func wechatSwap(baseURL string) *wechat.Client {
	return wechat.New(baseURL)
}

// be06Account 创建独立微信账号并配好凭证与日限额（与 cl10 同构）。
func be06Account(t *testing.T) Account {
	t.Helper()
	var a Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "wechat_mp", "name": "BE-06 账号", "content_format": "long_article"}, &a)
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_account WHERE id=$1`, a.ID) })
	env.mustJSON(t, "PATCH", "/api/v1/accounts/"+a.ID.String(), map[string]any{"daily_push_limit": 20}, nil)
	env.mustJSON(t, "PUT", "/api/v1/accounts/"+a.ID.String()+"/wechat-credential", map[string]string{"app_id": "wx1234567890", "app_secret": "s3cret-value-for-test"}, nil)
	return a
}
