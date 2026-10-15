package mock

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type parsedCall struct {
	ID   string
	Name string
	Args string
}

type chatResult struct {
	Content string
	Calls   []parsedCall
	Finish  string
	Raw     string
}

// chat posts a chat completion request to the fake and parses the SSE stream (or JSON reply).
func chat(t *testing.T, h http.Handler, body map[string]any) chatResult {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("模型返回 HTTP %d：%s", rec.Code, rec.Body.String())
	}
	out := chatResult{Raw: rec.Body.String()}
	if body["stream"] != true {
		var resp struct {
			Choices []struct {
				Message struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"message"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || len(resp.Choices) == 0 {
			t.Fatalf("非流式响应无法解析：%s", rec.Body.String())
		}
		out.Content = resp.Choices[0].Message.Content
		out.Finish = resp.Choices[0].FinishReason
		for _, c := range resp.Choices[0].Message.ToolCalls {
			out.Calls = append(out.Calls, parsedCall{ID: c.ID, Name: c.Function.Name, Args: c.Function.Arguments})
		}
		return out
	}
	byIndex := map[int]*parsedCall{}
	var order []int
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		line = strings.TrimSpace(line)
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
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    *int   `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		for _, c := range chunk.Choices {
			out.Content += c.Delta.Content
			if c.FinishReason != "" {
				out.Finish = c.FinishReason
			}
			for _, tc := range c.Delta.ToolCalls {
				idx := 0
				if tc.Index != nil {
					idx = *tc.Index
				}
				cur, ok := byIndex[idx]
				if !ok {
					cur = &parsedCall{}
					byIndex[idx] = cur
					order = append(order, idx)
				}
				if tc.ID != "" && cur.ID == "" {
					cur.ID = tc.ID
				}
				if tc.Function.Name != "" && cur.Name == "" {
					cur.Name = tc.Function.Name
				}
				cur.Args += tc.Function.Arguments
			}
		}
	}
	for _, idx := range order {
		out.Calls = append(out.Calls, *byIndex[idx])
	}
	return out
}

func userMsg(text string) map[string]any {
	return map[string]any{"role": "user", "content": text}
}

func tool(name string) map[string]any {
	return map[string]any{"type": "function", "function": map[string]any{
		"name": name, "description": "测试工具", "parameters": map[string]any{"type": "object"},
	}}
}

func redImageMsg(text string) map[string]any {
	return map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": text},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,iVBORw0KGgo="}},
	}}
}

// 判据 1：agent_chat 多行 #tool 指令按顺序返回多个工具调用，参数可解析。
func TestAgentChatToolInstructions(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools":    []any{tool("works__update"), tool("topics__create")},
		"messages": []any{userMsg("任务：agent_chat\n#tool works__update {\"title\":\"新标题\"}\n#tool topics__create {\"title\":\"新选题\"}")},
	})
	if len(res.Calls) != 2 {
		t.Fatalf("应返回 2 个工具调用，得到 %d：%s", len(res.Calls), res.Raw)
	}
	if res.Calls[0].Name != "works__update" || res.Calls[0].Args != `{"title":"新标题"}` {
		t.Fatalf("第 1 个调用错误：%+v", res.Calls[0])
	}
	if res.Calls[1].Name != "topics__create" || res.Calls[1].Args != `{"title":"新选题"}` {
		t.Fatalf("第 2 个调用错误：%+v", res.Calls[1])
	}
	if res.Calls[0].ID == "" || res.Calls[1].ID == "" {
		t.Fatalf("工具调用应带 id：%+v", res.Calls)
	}
	if res.Content != "" {
		t.Fatalf("仅工具调用时不应有文字：%q", res.Content)
	}
	if res.Finish != "tool_calls" {
		t.Fatalf("finish_reason 应为 tool_calls，得到 %q", res.Finish)
	}
}

// 判据 2：#text 指令返回纯文字。
func TestAgentChatTextInstruction(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools":    []any{tool("works__read")},
		"messages": []any{userMsg("任务：agent_chat\n#text 你好，我可以帮你。")},
	})
	if res.Content != "你好，我可以帮你。" || len(res.Calls) != 0 {
		t.Fatalf("纯文字指令结果错误：%q calls=%+v", res.Content, res.Calls)
	}
}

// 判据 3：说明轮（无工具定义、无 tool_choice）按历史工具调用数返回“N 张卡片”。
func TestAgentChatCardExplanationRound(t *testing.T) {
	h := (&LLM{}).Handler()
	assistant := map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{
		map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "works__update", "arguments": "{}"}},
		map[string]any{"id": "call_2", "type": "function", "function": map[string]any{"name": "topics__create", "arguments": "{}"}},
	}}
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{
			userMsg("任务：agent_chat\n#tool works__update {}"),
			assistant,
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":true}"},
			map[string]any{"role": "tool", "tool_call_id": "call_2", "content": "{\"ok\":true}"},
		},
	})
	if !strings.Contains(res.Content, "2 张卡片") {
		t.Fatalf("说明轮应报告 2 张卡片：%q", res.Content)
	}
	if len(res.Calls) != 0 {
		t.Fatalf("说明轮不应再返回工具调用：%+v", res.Calls)
	}
}

// 判据 4：无指令且最后一条消息是工具结果时，返回“已读取”加结果摘要。
func TestAgentChatToolResultSummary(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools": []any{tool("works__read")},
		"messages": []any{
			userMsg("任务：agent_chat\n帮我看一下作品"),
			map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "works__read", "arguments": "{}"}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "作品《秋天的第一杯奶茶》状态 draft"},
		},
	})
	if !strings.HasPrefix(res.Content, "已读取") || !strings.Contains(res.Content, "秋天的第一杯奶茶") {
		t.Fatalf("工具结果摘要错误：%q", res.Content)
	}
}

// 判据 5：模拟“不支持工具调用”时，即使有 #tool 指令也不返回工具调用。
func TestAgentChatNoToolsSimulated(t *testing.T) {
	h := (&LLM{NoTools: true}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools":    []any{tool("works__update")},
		"messages": []any{userMsg("任务：agent_chat\n#tool works__update {}")},
	})
	if len(res.Calls) != 0 {
		t.Fatalf("模拟不支持工具时不应返回工具调用：%+v", res.Calls)
	}
	if res.Content == "" {
		t.Fatalf("应返回说明文字")
	}
}

// 判据 6：环境变量可模拟“不支持工具调用”。
func TestAgentChatNoToolsEnv(t *testing.T) {
	t.Setenv("OPS_MOCK_NO_TOOLS", "1")
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools":    []any{tool("works__update")},
		"messages": []any{userMsg("任务：agent_chat\n#tool works__update {}")},
	})
	if len(res.Calls) != 0 {
		t.Fatalf("环境变量模拟不支持工具时不应返回工具调用：%+v", res.Calls)
	}
}

// 判据 7：自检探测——请求带 ops_probe_echo 时返回该工具调用；随后带工具结果的一轮返回非空文字。
func TestProbeEchoToolCall(t *testing.T) {
	h := (&LLM{}).Handler()
	first := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools":    []any{tool("ops_probe_echo")},
		"messages": []any{userMsg("调用 ops_probe_echo，value 填 ok")},
	})
	if len(first.Calls) != 1 || first.Calls[0].Name != "ops_probe_echo" {
		t.Fatalf("应返回 ops_probe_echo 调用：%+v", first.Calls)
	}
	var args map[string]string
	if json.Unmarshal([]byte(first.Calls[0].Args), &args) != nil || args["value"] != "ok" {
		t.Fatalf("探测参数应为 value=ok：%s", first.Calls[0].Args)
	}
	second := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"tools": []any{tool("ops_probe_echo")},
		"messages": []any{
			userMsg("调用 ops_probe_echo，value 填 ok"),
			map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{
				map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "ops_probe_echo", "arguments": `{"value":"ok"}`}},
			}},
			map[string]any{"role": "tool", "tool_call_id": "call_1", "content": "ok"},
		},
	})
	if strings.TrimSpace(second.Content) == "" || len(second.Calls) != 0 {
		t.Fatalf("工具结果一轮应返回非空文字：%q calls=%+v", second.Content, second.Calls)
	}
}

// 判据 8：看图探测——带图片并询问颜色时返回“红色”；模拟不支持看图时不返回“红”。
func TestVisionProbe(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{redImageMsg("图片是什么颜色？只回答颜色")},
	})
	if !strings.Contains(res.Content, "红") {
		t.Fatalf("看图探测应回答红色：%q", res.Content)
	}
	h2 := (&LLM{NoVision: true}).Handler()
	res2 := chat(t, h2, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{redImageMsg("图片是什么颜色？只回答颜色")},
	})
	if strings.Contains(res2.Content, "红") {
		t.Fatalf("模拟不支持看图时不应回答红色：%q", res2.Content)
	}
}

// 判据 9：环境变量可模拟“不支持看图”。
func TestVisionProbeEnv(t *testing.T) {
	t.Setenv("OPS_MOCK_NO_VISION", "1")
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{redImageMsg("图片是什么颜色？只回答颜色")},
	})
	if strings.Contains(res.Content, "红") {
		t.Fatalf("环境变量模拟不支持看图时不应回答红色：%q", res.Content)
	}
}

// 判据 10：agent_summary 返回固定摘要。
func TestAgentSummary(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{userMsg("请压缩历史。\n\n任务：agent_summary")},
	})
	if strings.TrimSpace(res.Content) == "" {
		t.Fatalf("agent_summary 应返回非空摘要")
	}
}

// 判据 11：记录收到的完整请求，供 HC-30 检查；可重置。
func TestRecordsRequests(t *testing.T) {
	l := &LLM{}
	h := l.Handler()
	chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{userMsg("任务：agent_chat\n#text 记录我")},
	})
	reqs := l.Requests()
	if len(reqs) != 1 || !strings.Contains(reqs[0], "记录我") {
		t.Fatalf("应记录完整请求：%+v", reqs)
	}
	l.ResetRequests()
	if len(l.Requests()) != 0 {
		t.Fatalf("重置后不应有记录")
	}
}

// 判据 12：非流式请求也返回工具调用。
func TestNonStreamToolCall(t *testing.T) {
	h := (&LLM{}).Handler()
	res := chat(t, h, map[string]any{
		"model": "mock", "stream": false,
		"tools":    []any{tool("works__update")},
		"messages": []any{userMsg("任务：agent_chat\n#tool works__update {}")},
	})
	if len(res.Calls) != 1 || res.Calls[0].Name != "works__update" {
		t.Fatalf("非流式应返回工具调用：%+v", res.Calls)
	}
	if res.Finish != "tool_calls" {
		t.Fatalf("非流式 finish_reason 应为 tool_calls：%q", res.Finish)
	}
}

// 判据 13：max_tokens 设置且输出超过上限时截断，finish_reason=length；未设置时不受影响。
func TestMaxTokensTruncation(t *testing.T) {
	h := (&LLM{}).Handler()
	text := strings.Repeat("这是一段很长的回复。", 40)

	full := chat(t, h, map[string]any{
		"model": "mock", "stream": true,
		"messages": []any{userMsg("任务：agent_chat\n#text " + text)},
	})
	if full.Content != text || full.Finish != "stop" {
		t.Fatalf("未设置 max_tokens 时不应截断：finish=%q len=%d", full.Finish, len([]rune(full.Content)))
	}

	capped := chat(t, h, map[string]any{
		"model": "mock", "stream": true, "max_tokens": 5,
		"messages": []any{userMsg("任务：agent_chat\n#text " + text)},
	})
	if capped.Finish != "length" {
		t.Fatalf("截断时 finish_reason 应为 length：%q", capped.Finish)
	}
	if len([]rune(capped.Content)) != 7 {
		t.Fatalf("按 token 估算应截到 7 个字符（5*3/2）：%d", len([]rune(capped.Content)))
	}

	nonStream := chat(t, h, map[string]any{
		"model": "mock", "stream": false, "max_tokens": 5,
		"messages": []any{userMsg("任务：agent_chat\n#text " + text)},
	})
	if nonStream.Finish != "length" {
		t.Fatalf("非流式截断时 finish_reason 应为 length：%q", nonStream.Finish)
	}
}
