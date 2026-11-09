package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
)

// DEV-AI27-16（W16）：ASR 转写（27 文档 §11.4.3）。
// 走 OpenAI 兼容的 POST {base_url}/audio/transcriptions；复用既有供应商 base_url 与密钥，
// 不引入第二套密钥存储。音频只在内存中转发，不落盘（§11.4.3）。
//
// 局限（如实登记）：本函数只覆盖 OpenAI 兼容的 multipart 转写协议；
// 其他供应商需要各自的适配器，不在本批范围。

const transcriptionMaxResponseBytes = 1 << 20

// Transcription 是一次转写的结果。DurationSeconds 来自供应商回执，
// 缺失时为 0（不能据此推断音频长度，也不能把 0 记成已计费）。
type Transcription struct {
	Text            string
	DurationSeconds float64
}

// Transcribe 把一段音频交给真实 ASR 供应商并返回转写文本。
// 失败时返回带原因的错误，由调用方决定错误码；不静默降级到「空转写」。
func Transcribe(ctx context.Context, hc *http.Client, baseURL, apiKey, model, filename string, audio []byte) (Transcription, error) {
	if len(audio) == 0 {
		return Transcription{}, fmt.Errorf("audio_empty")
	}
	if strings.TrimSpace(model) == "" {
		return Transcription{}, fmt.Errorf("asr_model_missing")
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	if filename == "" {
		filename = "audio.webm"
	}

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if err := w.WriteField("model", model); err != nil {
		return Transcription{}, fmt.Errorf("transcription_encode: %w", err)
	}
	if err := w.WriteField("response_format", "json"); err != nil {
		return Transcription{}, fmt.Errorf("transcription_encode: %w", err)
	}
	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		return Transcription{}, fmt.Errorf("transcription_encode: %w", err)
	}
	if _, err := part.Write(audio); err != nil {
		return Transcription{}, fmt.Errorf("transcription_encode: %w", err)
	}
	if err := w.Close(); err != nil {
		return Transcription{}, fmt.Errorf("transcription_encode: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/audio/transcriptions", &body)
	if err != nil {
		return Transcription{}, fmt.Errorf("transcription_request: %w", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	if strings.TrimSpace(apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return Transcription{}, fmt.Errorf("transcription_request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, transcriptionMaxResponseBytes))
	if err != nil {
		return Transcription{}, fmt.Errorf("transcription_read: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return Transcription{}, &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	var out struct {
		Text     string  `json:"text"`
		Duration float64 `json:"duration"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return Transcription{}, fmt.Errorf("transcription_decode: %w", err)
	}
	text := strings.TrimSpace(out.Text)
	if text == "" {
		return Transcription{}, fmt.Errorf("transcription_empty")
	}
	return Transcription{Text: text, DurationSeconds: out.Duration}, nil
}
