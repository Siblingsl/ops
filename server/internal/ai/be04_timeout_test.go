package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// BE-04（docs/33 §11.4 / BE-04）：超时反例与 nil 回退禁用（fail-closed）。
// 4.3 实测（be04_probe_test.go / be04_volume_test.go，本批已留证）：
//   - nil client 回退 http.DefaultClient（无超时），挂起上游 3s 未返回（生产 goroutine
//     将无限占住）；
//   - 注入 500ms 超时的 client，挂起请求 501.9ms/501.4ms（ASR/TTS）返回；
//   - 8MiB 体量 3 轮 17.6~19.5ms 全部完成——超时收紧不截断大体量正常传输。
// 修复：Transcribe/Speech 的 `hc == nil → http.DefaultClient` 回退改为显式错误
// （fail-closed）。生产调用方全部经 aiClientForRoute（aiHTTP 5min 或桌面 deadline
// client），从不传 nil；测试中的 nil 用例相应改为断言显式错误。

func TestBE04NilClientIsRejectedFailClosed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("nil client 不应发起任何请求（fail-closed）")
	}))
	defer srv.Close()

	if _, err := Transcribe(context.Background(), nil, srv.URL+"/v1", "k", "m", "a.webm", []byte("x")); err == nil || !strings.Contains(err.Error(), "http_client_nil") {
		t.Fatalf("Transcribe nil client 应显式报 http_client_nil，实际：%v", err)
	}
	if _, _, err := Speech(context.Background(), nil, srv.URL+"/v1", "k", SpeechRequest{Text: "x", Model: "m", Voice: "v"}); err == nil || !strings.Contains(err.Error(), "http_client_nil") {
		t.Fatalf("Speech nil client 应显式报 http_client_nil，实际：%v", err)
	}
}

func TestBE04HangUpstreamReturnsWithinInjectedDeadline(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release // 挂起：模拟上游无响应
	}))
	defer srv.Close()
	defer close(release)

	hc := &http.Client{Timeout: 500 * time.Millisecond}
	start := time.Now()
	if _, err := Transcribe(context.Background(), hc, srv.URL+"/v1", "k", "m", "a.webm", []byte("x")); err == nil {
		t.Fatal("挂起上游必须返回超时错误，不得静默")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("500ms 超时的 client 实际 %v 才返回（deadline 未生效）", elapsed)
	}
	if _, _, err := Speech(context.Background(), hc, srv.URL+"/v1", "k", SpeechRequest{Text: "x", Model: "m", Voice: "v"}); err == nil {
		t.Fatal("TTS 挂起上游必须返回超时错误")
	}
}
