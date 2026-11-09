package ai

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// DEV-AI27-16（W16）：ASR 转写离线契约测试（不需要真实供应商）。
func TestTranscribeSendsMultipartAndParsesResult(t *testing.T) {
	var gotModel, gotFormat, gotAuth string
	var gotAudio []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			t.Errorf("路径错误：%s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart 解析失败：%v", err)
		}
		gotModel = r.FormValue("model")
		gotFormat = r.FormValue("response_format")
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Errorf("缺少 file 字段：%v", err)
			return
		}
		defer file.Close()
		gotAudio, _ = io.ReadAll(file)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"  你好，这是转写结果  ","duration":12.5}`))
	}))
	defer srv.Close()

	got, err := Transcribe(context.Background(), srv.Client(), srv.URL+"/v1", "test-key-placeholder", "whisper-1", "clip.webm", []byte("audio-bytes"))
	if err != nil {
		t.Fatalf("转写失败：%v", err)
	}
	if got.Text != "你好，这是转写结果" {
		t.Fatalf("文本未去除首尾空白：%q", got.Text)
	}
	if got.DurationSeconds != 12.5 {
		t.Fatalf("时长解析错误：%v", got.DurationSeconds)
	}
	if gotModel != "whisper-1" || gotFormat != "json" {
		t.Fatalf("表单字段错误：model=%q format=%q", gotModel, gotFormat)
	}
	if gotAuth != "Bearer test-key-placeholder" {
		t.Fatalf("Authorization 头错误：%q", gotAuth)
	}
	if string(gotAudio) != "audio-bytes" {
		t.Fatalf("音频字节未完整转发：%q", string(gotAudio))
	}
}

func TestTranscribeReportsUpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid api key"}`))
	}))
	defer srv.Close()

	_, err := Transcribe(context.Background(), srv.Client(), srv.URL, "k", "whisper-1", "a.webm", []byte("x"))
	var ue *UpstreamError
	if !errors.As(err, &ue) || ue.Status != http.StatusUnauthorized {
		t.Fatalf("应返回 UpstreamError 401，实际：%v", err)
	}
}

func TestTranscribeRejectsEmptyInput(t *testing.T) {
	if _, err := Transcribe(context.Background(), nil, "http://127.0.0.1:9/v1", "k", "m", "a.webm", nil); err == nil {
		t.Fatal("空音频应报错")
	}
	if _, err := Transcribe(context.Background(), nil, "http://127.0.0.1:9/v1", "k", "", "a.webm", []byte("x")); err == nil {
		t.Fatal("缺模型名应报错")
	}
}

func TestTranscribeRejectsEmptyText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"text":"   ","duration":3}`))
	}))
	defer srv.Close()
	_, err := Transcribe(context.Background(), srv.Client(), srv.URL, "k", "m", "a.webm", []byte("x"))
	if err == nil {
		t.Fatal("空转写文本应报错，不能当作成功")
	}
}
