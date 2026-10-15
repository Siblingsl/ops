package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sseServer streams the given SSE frames verbatim and records the request body it received.
func sseServer(t *testing.T, frames []string) (*httptest.Server, *string) {
	t.Helper()
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = string(body)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, f := range frames {
			fmt.Fprintf(w, "data: %s\n\n", f)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func decodeBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("请求体不是 JSON：%v（%s）", err, raw)
	}
	return out
}

// 判据 1：delta.tool_calls 按 index 累积，id/name 取首次非空，arguments 逐段拼接，finish_reason 记录。
func TestStreamAccumulatesToolCalls(t *testing.T) {
	frames := []string{
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"works__update","arguments":"{\"ti"}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tle\":\"新"}}]}}]}`,
		`{"choices":[{"index":1,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"topics__create","arguments":"{}"}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"标题\"}"}}]},"finish_reason":"tool_calls"}]}`,
		`{"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}`,
	}
	srv, _ := sseServer(t, frames)
	text, usage, calls, finish, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)
	if err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	if text != "" {
		t.Fatalf("仅工具调用时不应有文字，得到 %q", text)
	}
	if finish != "tool_calls" {
		t.Fatalf("finish_reason 应为 tool_calls，得到 %q", finish)
	}
	if usage.PromptTokens != 11 || usage.CompletionTokens != 7 {
		t.Fatalf("用量解析错误：%+v", usage)
	}
	if len(calls) != 2 {
		t.Fatalf("应累积 2 个工具调用，得到 %d：%+v", len(calls), calls)
	}
	if calls[0].ID != "call_a" || calls[0].Function.Name != "works__update" || calls[0].Function.Arguments != `{"title":"新标题"}` {
		t.Fatalf("第 1 个工具调用解析错误：%+v", calls[0])
	}
	if calls[0].Type != "function" {
		t.Fatalf("type 应补为 function，得到 %q", calls[0].Type)
	}
	if calls[1].ID != "call_b" || calls[1].Function.Name != "topics__create" || calls[1].Function.Arguments != "{}" {
		t.Fatalf("第 2 个工具调用解析错误：%+v", calls[1])
	}
}

// 判据 2：模型未返回 id 时生成 call_{轮次}_{index}。
func TestStreamGeneratesToolCallIDWhenMissing(t *testing.T) {
	frames := []string{
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"works__read","arguments":"{}"}}]}}]}`,
		`{"choices":[{"index":0,"delta":{"tool_calls":[{"index":2,"type":"function","function":{"name":"materials__list","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
	}
	srv, _ := sseServer(t, frames)
	_, _, calls, _, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m", Round: 4,
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)
	if err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("应累积 2 个工具调用，得到 %d", len(calls))
	}
	if calls[0].ID != "call_4_0" || calls[1].ID != "call_4_2" {
		t.Fatalf("缺失 id 回退命名错误：%q, %q", calls[0].ID, calls[1].ID)
	}
}

// 判据 3：不带 tools 的既有调用行为完全不变（请求体不含 tools/tool_choice/parallel_tool_calls）。
func TestStreamWithoutToolsKeepsRequestBody(t *testing.T) {
	srv, got := sseServer(t, []string{`{"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]}`})
	text, _, calls, finish, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)
	if err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	if text != "你好" || finish != "stop" || len(calls) != 0 {
		t.Fatalf("文字/结束原因错误：%q %q %+v", text, finish, calls)
	}
	body := decodeBody(t, *got)
	for _, k := range []string{"tools", "tool_choice", "parallel_tool_calls"} {
		if _, ok := body[k]; ok {
			t.Fatalf("不带工具时请求体不应含 %q：%s", k, *got)
		}
	}
	if body["stream"] != true {
		t.Fatalf("stream 应为 true：%s", *got)
	}
}

// 判据 4：带 tools 时发送 tools 与 tool_choice，且不发送 parallel_tool_calls。
func TestStreamSendsToolsAndToolChoice(t *testing.T) {
	srv, got := sseServer(t, []string{`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`})
	_, _, _, _, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m",
		Tools: []Tool{{Type: "function", Function: ToolFunction{
			Name: "works__update", Description: "修改作品", Parameters: json.RawMessage(`{"type":"object"}`),
		}}},
		ToolChoice: "auto",
		Messages:   []Message{{Role: "user", Content: "hi"}},
	}, nil)
	if err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	body := decodeBody(t, *got)
	if _, ok := body["parallel_tool_calls"]; ok {
		t.Fatalf("不应发送 parallel_tool_calls：%s", *got)
	}
	if body["tool_choice"] != "auto" {
		t.Fatalf("tool_choice 应为 auto：%s", *got)
	}
	tools, ok := body["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("tools 应为 1 个元素：%s", *got)
	}
	first := tools[0].(map[string]any)
	if first["type"] != "function" {
		t.Fatalf("tool.type 应为 function：%s", *got)
	}
	fn := first["function"].(map[string]any)
	if fn["name"] != "works__update" || fn["description"] != "修改作品" {
		t.Fatalf("tool.function 字段错误：%s", *got)
	}
	if _, ok := fn["parameters"].(map[string]any); !ok {
		t.Fatalf("parameters 应为对象：%s", *got)
	}
}

// 判据 4b：MaxTokens 只在设置时发送 max_tokens（16 文档第 6.5 节单轮输出上限）。
func TestStreamSendsMaxTokensOnlyWhenSet(t *testing.T) {
	srv, got := sseServer(t, []string{`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`})
	if _, _, _, _, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil); err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	if _, ok := decodeBody(t, *got)["max_tokens"]; ok {
		t.Fatalf("未设置 MaxTokens 时不应发送 max_tokens：%s", *got)
	}

	limit := 4096
	srv2, got2 := sseServer(t, []string{`{"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"length"}]}`})
	if _, _, _, _, err := Stream(context.Background(), srv2.Client(), Request{
		BaseURL: srv2.URL, APIKey: "k", Model: "m", MaxTokens: &limit,
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil); err != nil {
		t.Fatalf("Stream 出错：%v", err)
	}
	if v, ok := decodeBody(t, *got2)["max_tokens"].(float64); !ok || int(v) != 4096 {
		t.Fatalf("max_tokens 应为 4096：%s", *got2)
	}
}

// 判据 5：Message 序列化——助手有 tool_calls 且文字为空时 content 发 null；role=tool 发 tool_call_id；普通消息形状不变。
func TestMessageMarshalShapes(t *testing.T) {
	assistant := Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "call_a", Type: "function"}}}
	assistant.ToolCalls[0].Function.Name = "works__update"
	assistant.ToolCalls[0].Function.Arguments = "{}"
	raw, err := json.Marshal(assistant)
	if err != nil {
		t.Fatalf("序列化助手消息出错：%v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(raw, &asMap); err != nil {
		t.Fatalf("助手消息不是 JSON：%v", err)
	}
	if v, ok := asMap["content"]; !ok || v != nil {
		t.Fatalf("助手有 tool_calls 且文字为空时 content 应为 null，得到 %v", asMap["content"])
	}
	if _, ok := asMap["tool_calls"].([]any); !ok {
		t.Fatalf("助手消息应含 tool_calls：%s", raw)
	}

	tool := Message{Role: "tool", Content: "结果", ToolCallID: "call_a", Name: "works__update"}
	raw, err = json.Marshal(tool)
	if err != nil {
		t.Fatalf("序列化工具结果出错：%v", err)
	}
	var tm map[string]any
	_ = json.Unmarshal(raw, &tm)
	if tm["tool_call_id"] != "call_a" || tm["content"] != "结果" || tm["name"] != "works__update" {
		t.Fatalf("工具结果字段错误：%s", raw)
	}
	if _, ok := tm["tool_calls"]; ok {
		t.Fatalf("工具结果不应含 tool_calls：%s", raw)
	}

	plain, _ := json.Marshal(Message{Role: "user", Content: "hi"})
	if string(plain) != `{"role":"user","content":"hi"}` {
		t.Fatalf("普通消息序列化形状变化：%s", plain)
	}
}

// 判据 6：助手消息同时有文字与 tool_calls 时两者都发送。
func TestMessageMarshalKeepsContentWithToolCalls(t *testing.T) {
	raw, _ := json.Marshal(Message{Role: "assistant", Content: "先说明", ToolCalls: []ToolCall{{ID: "call_a", Type: "function"}}})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["content"] != "先说明" {
		t.Fatalf("有文字时应保留 content：%s", raw)
	}
	if _, ok := m["tool_calls"].([]any); !ok {
		t.Fatalf("应保留 tool_calls：%s", raw)
	}
}

// 判据 7：JSON 模式下 400 且提示 response_format 时，去掉 JSON 模式重试（既有行为保留）。
func TestStreamJSONFallbackOnResponseFormatError(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		calls++
		if strings.Contains(string(body), "response_format") {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"response_format unsupported"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	text, _, _, _, err := Stream(context.Background(), srv.Client(), Request{
		BaseURL: srv.URL, APIKey: "k", Model: "m", JSON: true,
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)
	if err != nil || text != "ok" || calls != 2 {
		t.Fatalf("JSON 回退重试失败：text=%q calls=%d err=%v", text, calls, err)
	}
}
