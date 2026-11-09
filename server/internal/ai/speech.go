package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DEV-AI27-16 第五批（A1，27 §11.4.4）：TTS 语音合成。
// 走 OpenAI 兼容的 POST {base_url}/audio/speech；复用既有供应商 base_url 与密钥。
// 返回音频字节（audio/mpeg），调用方直接以流/整段返回给渲染器播放。
//
// 局限（如实登记）：只覆盖 OpenAI 兼容合成协议；火山等其他供应商需各自适配器。
// 本机模型 modalities 仅 text+image 时，tts 路由不可用（422 voice_capability_unsupported），
// 真实验收标「未执行（缺音频模型）」——自动化契约测试可跑，不伪装真实通过。

const speechMaxAudioBytes = 20 << 20 // 20MiB：与上传上限同量级，防异常供应商回包拖垮内存

// SpeechVoice 是一次合成的输入（27 §11.4.4：文本 + 音色；采样率由供应商决定）。
type SpeechRequest struct {
	Text   string
	Model  string
	Voice  string
	Speed  float64 // 0.25~4.0，0 表示用供应商默认
	Format string  // mp3（默认）/wav/opus；非空即透传
}

// Speech 把一段文本交给 TTS 供应商并返回音频字节与 MIME。
// 失败时返回带原因的错误；不静默降级成空音频。
func Speech(ctx context.Context, hc *http.Client, baseURL, apiKey string, req SpeechRequest) ([]byte, string, error) {
	if strings.TrimSpace(req.Text) == "" {
		return nil, "", fmt.Errorf("speech_text_empty")
	}
	if strings.TrimSpace(req.Model) == "" {
		return nil, "", fmt.Errorf("tts_model_missing")
	}
	if strings.TrimSpace(req.Voice) == "" {
		return nil, "", fmt.Errorf("tts_voice_missing")
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	payload := map[string]any{
		"model": req.Model,
		"input": req.Text,
		"voice": req.Voice,
	}
	if req.Speed > 0 {
		payload["speed"] = req.Speed
	}
	payload["response_format"] = req.Format
	if req.Format == "" {
		payload["response_format"] = "mp3"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, "", fmt.Errorf("speech_encode: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/audio/speech", bytes.NewReader(body))
	if err != nil {
		return nil, "", fmt.Errorf("speech_request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(apiKey) != "" {
		httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := hc.Do(httpReq)
	if err != nil {
		return nil, "", fmt.Errorf("speech_request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, "", &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	audio, err := io.ReadAll(io.LimitReader(resp.Body, speechMaxAudioBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("speech_read: %w", err)
	}
	if len(audio) == 0 {
		return nil, "", fmt.Errorf("speech_empty")
	}
	if len(audio) > speechMaxAudioBytes {
		return nil, "", fmt.Errorf("speech_too_large")
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" || strings.Contains(mime, "application/json") {
		mime = "audio/mpeg"
	}
	return audio, mime, nil
}
