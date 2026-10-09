// Package ai is the model adapter layer (06 文档第 5.1 节): one OpenAI-compatible protocol,
// streaming text plus usage.
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type Request struct {
	BaseURL  string
	APIKey   string
	Model    string
	Messages []Message
	JSON     bool
}

type UpstreamError struct {
	Status int
	Body   string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("模型服务返回 HTTP %d：%s", e.Status, e.Body)
}

// Stream calls /chat/completions with stream=true and invokes onDelta for each text chunk.
func Stream(ctx context.Context, hc *http.Client, req Request, onDelta func(string)) (string, Usage, error) {
	text, usage, err := stream(ctx, hc, req, onDelta, req.JSON)
	var ue *UpstreamError
	if err != nil && req.JSON && asUpstream(err, &ue) && ue.Status == 400 && strings.Contains(ue.Body, "response_format") {
		return stream(ctx, hc, req, onDelta, false)
	}
	return text, usage, err
}

func asUpstream(err error, target **UpstreamError) bool {
	ue, ok := err.(*UpstreamError)
	if ok {
		*target = ue
	}
	return ok
}

func stream(ctx context.Context, hc *http.Client, req Request, onDelta func(string), jsonMode bool) (string, Usage, error) {
	body := map[string]any{
		"model":          req.Model,
		"messages":       req.Messages,
		"stream":         true,
		"stream_options": map[string]bool{"include_usage": true},
	}
	if jsonMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(req.BaseURL, "/") + "/chat/completions"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return "", Usage{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Authorization", "Bearer "+req.APIKey)
	resp, err := hc.Do(hreq)
	if err != nil {
		return "", Usage{}, fmt.Errorf("无法连接模型服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", Usage{}, &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}

	var out strings.Builder
	var usage Usage
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage *Usage `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		for _, c := range chunk.Choices {
			piece := c.Delta.Content
			if piece == "" {
				piece = c.Message.Content
			}
			if piece != "" {
				out.WriteString(piece)
				if onDelta != nil {
					onDelta(piece)
				}
			}
		}
		if chunk.Usage != nil {
			usage = *chunk.Usage
		}
	}
	if err := sc.Err(); err != nil {
		return out.String(), usage, err
	}
	if usage.PromptTokens == 0 {
		n := 0
		for _, m := range req.Messages {
			n += utf8.RuneCountInString(m.Content)
		}
		usage = Usage{PromptTokens: n * 2 / 3, CompletionTokens: utf8.RuneCountInString(out.String()) * 2 / 3}
	}
	return out.String(), usage, nil
}

// ExtractJSON returns the first top-level JSON object in s (models sometimes wrap JSON in fences).
func ExtractJSON(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < start {
		return s
	}
	return s[start : end+1]
}
