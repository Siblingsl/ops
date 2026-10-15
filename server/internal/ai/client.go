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
	"sort"
	"strings"
	"unicode/utf8"
)

// Tool is one entry of the OpenAI-compatible tools array (16 文档第 7.1 节).
type Tool struct {
	Type     string       `json:"type"` // 固定 "function"
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// ToolCall is a native tool call returned by the model.
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"` // "function"
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
	// Images are data URLs; when set the message is sent as OpenAI multimodal content parts.
	Images []string `json:"-"`
	// ToolCalls is set on assistant messages that ask for tool calls.
	ToolCalls []ToolCall `json:"-"`
	// ToolCallID links a role=tool message back to its assistant tool call.
	ToolCallID string `json:"-"`
	// Name is the optional tool name on role=tool messages.
	Name string `json:"-"`
}

func (m Message) MarshalJSON() ([]byte, error) {
	// role=tool: string content plus tool_call_id（16 文档第 7.1 节第 1 项）。
	if m.Role == "tool" {
		out := map[string]any{"role": m.Role, "content": m.Content, "tool_call_id": m.ToolCallID}
		if m.Name != "" {
			out["name"] = m.Name
		}
		return json.Marshal(out)
	}
	if len(m.Images) > 0 {
		parts := []map[string]any{{"type": "text", "text": m.Content}}
		for _, u := range m.Images {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": u}})
		}
		out := map[string]any{"role": m.Role, "content": parts}
		if len(m.ToolCalls) > 0 {
			out["tool_calls"] = m.ToolCalls
		}
		return json.Marshal(out)
	}
	// 助手消息带 tool_calls 且文字为空时，content 发送 null（16 文档第 7.1 节第 1 项）。
	if len(m.ToolCalls) > 0 {
		var content any
		if m.Content != "" {
			content = m.Content
		}
		return json.Marshal(map[string]any{"role": m.Role, "content": content, "tool_calls": m.ToolCalls})
	}
	return json.Marshal(struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}{m.Role, m.Content})
}

type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

type Request struct {
	BaseURL     string
	APIKey      string
	Model       string
	Messages    []Message
	JSON        bool
	Temperature *float64
	// Tools / ToolChoice enable native tool calling; empty Tools keeps the old request body.
	Tools      []Tool
	ToolChoice string // "" 表示不发送；"auto" | "none" | "required"
	// Round is the run round number, used to name tool calls that arrive without an id.
	Round int
	// MaxTokens caps one round's output; nil keeps the old request body (16 文档第 6.5 节).
	MaxTokens *int
}

type UpstreamError struct {
	Status int
	Body   string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("模型服务返回 HTTP %d：%s", e.Status, e.Body)
}

// Stream calls /chat/completions with stream=true and invokes onDelta for each text chunk.
// It returns the text, usage, accumulated tool calls and the finish reason.
func Stream(ctx context.Context, hc *http.Client, req Request, onDelta func(string)) (string, Usage, []ToolCall, string, error) {
	text, usage, calls, finish, err := stream(ctx, hc, req, onDelta, req.JSON)
	var ue *UpstreamError
	if err != nil && req.JSON && asUpstream(err, &ue) && ue.Status == 400 && strings.Contains(ue.Body, "response_format") {
		return stream(ctx, hc, req, onDelta, false)
	}
	return text, usage, calls, finish, err
}

func asUpstream(err error, target **UpstreamError) bool {
	ue, ok := err.(*UpstreamError)
	if ok {
		*target = ue
	}
	return ok
}

// deltaToolCall is one fragment of a streamed tool call (16 文档第 7.1 节第 2 项).
type deltaToolCall struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

func stream(ctx context.Context, hc *http.Client, req Request, onDelta func(string), jsonMode bool) (string, Usage, []ToolCall, string, error) {
	body := map[string]any{
		"model":          req.Model,
		"messages":       req.Messages,
		"stream":         true,
		"stream_options": map[string]bool{"include_usage": true},
	}
	if jsonMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	// 不发送 parallel_tool_calls；不带 tools 时请求体与既有行为完全一致。
	if len(req.Tools) > 0 {
		body["tools"] = req.Tools
	}
	if req.ToolChoice != "" {
		body["tool_choice"] = req.ToolChoice
	}
	// 单轮输出上限（16 文档第 6.5 节）；未设置时请求体与既有行为完全一致。
	if req.MaxTokens != nil {
		body["max_tokens"] = *req.MaxTokens
	}
	b, _ := json.Marshal(body)
	url := strings.TrimRight(req.BaseURL, "/") + "/chat/completions"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return "", Usage{}, nil, "", err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Authorization", "Bearer "+req.APIKey)
	resp, err := hc.Do(hreq)
	if err != nil {
		return "", Usage{}, nil, "", fmt.Errorf("无法连接模型服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return "", Usage{}, nil, "", &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}

	var out strings.Builder
	var usage Usage
	var finish string
	acc := map[int]*ToolCall{}
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
					Content   string          `json:"content"`
					ToolCalls []deltaToolCall `json:"tool_calls"`
				} `json:"delta"`
				Message struct {
					Content   string          `json:"content"`
					ToolCalls []deltaToolCall `json:"tool_calls"`
				} `json:"message"`
				FinishReason string `json:"finish_reason"`
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
			// 流式工具调用：按 index 累积，id/name 取首次非空值，arguments 逐段拼接。
			frags := append(append([]deltaToolCall{}, c.Delta.ToolCalls...), c.Message.ToolCalls...)
			for _, f := range frags {
				idx := 0
				if f.Index != nil {
					idx = *f.Index
				}
				cur, ok := acc[idx]
				if !ok {
					cur = &ToolCall{}
					acc[idx] = cur
				}
				if f.ID != "" && cur.ID == "" {
					cur.ID = f.ID
				}
				if f.Type != "" && cur.Type == "" {
					cur.Type = f.Type
				}
				if f.Function.Name != "" && cur.Function.Name == "" {
					cur.Function.Name = f.Function.Name
				}
				cur.Function.Arguments += f.Function.Arguments
			}
			if c.FinishReason != "" {
				finish = c.FinishReason
			}
		}
		if chunk.Usage != nil {
			usage = *chunk.Usage
		}
	}
	if err := sc.Err(); err != nil {
		return out.String(), usage, nil, finish, err
	}
	if usage.PromptTokens == 0 {
		n := 0
		for _, m := range req.Messages {
			n += utf8.RuneCountInString(m.Content)
		}
		usage = Usage{PromptTokens: n * 2 / 3, CompletionTokens: utf8.RuneCountInString(out.String()) * 2 / 3}
	}
	return out.String(), usage, orderToolCalls(acc, req.Round), finish, nil
}

// orderToolCalls returns accumulated calls sorted by index; missing id/type are filled in.
func orderToolCalls(acc map[int]*ToolCall, round int) []ToolCall {
	if len(acc) == 0 {
		return nil
	}
	idxs := make([]int, 0, len(acc))
	for i := range acc {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	calls := make([]ToolCall, 0, len(idxs))
	for _, i := range idxs {
		c := *acc[i]
		if c.Type == "" {
			c.Type = "function"
		}
		if c.ID == "" {
			c.ID = fmt.Sprintf("call_%d_%d", round, i)
		}
		calls = append(calls, c)
	}
	return calls
}

// Embed calls the OpenAI-compatible /embeddings endpoint and returns one vector per input.
func Embed(ctx context.Context, hc *http.Client, baseURL, apiKey, model string, inputs []string) ([][]float32, error) {
	b, _ := json.Marshal(map[string]any{"model": model, "input": inputs})
	url := strings.TrimRight(baseURL, "/") + "/embeddings"
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := hc.Do(hreq)
	if err != nil {
		return nil, fmt.Errorf("无法连接向量模型服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, &UpstreamError{Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	vecs := make([][]float32, len(inputs))
	for _, d := range out.Data {
		if d.Index >= 0 && d.Index < len(vecs) {
			vecs[d.Index] = d.Embedding
		}
	}
	for i := range vecs {
		if vecs[i] == nil {
			return nil, fmt.Errorf("向量模型缺少第 %d 条结果", i+1)
		}
	}
	return vecs, nil
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
