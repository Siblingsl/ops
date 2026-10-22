package mock

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// LLM is an OpenAI-compatible fake used for local development and tests. It never calls a
// real model. Replies are deterministic and derived from the prompt so the UI flow is testable.
type LLM struct {
	Delay time.Duration
	// ForceDailyFormat forces daily_recommend to emit the given format for every item.
	// Test knob for D-048: reproduces a model returning a type the account does not use.
	ForceDailyFormat string
	// NoTools simulates a model that does not support native tool calls (16 文档第 13.4 节第 3 项).
	// OPS_MOCK_NO_TOOLS=1 has the same effect.
	NoTools bool
	// NoVision simulates a model that cannot read images. OPS_MOCK_NO_VISION=1 has the same effect.
	NoVision bool

	mu       sync.Mutex
	requests []string // full request bodies received, for HC-30 assertions
}

// Requests returns a copy of the request bodies received so far (16 文档第 13.4 节第 5 项).
func (l *LLM) Requests() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, len(l.requests))
	copy(out, l.requests)
	return out
}

// ResetRequests clears the recorded request bodies.
func (l *LLM) ResetRequests() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = nil
}

func (l *LLM) recordRequest(body string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = append(l.requests, body)
	if len(l.requests) > 500 {
		l.requests = l.requests[len(l.requests)-500:]
	}
}

type chatReq struct {
	Model      string          `json:"model"`
	Stream     bool            `json:"stream"`
	ToolChoice json.RawMessage `json:"tool_choice"`
	MaxTokens  *int            `json:"max_tokens"`
	Tools      []struct {
		Type     string `json:"type"`
		Function struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
		} `json:"function"`
	} `json:"tools"`
	Messages []struct {
		Role      string          `json:"role"`
		Content   json.RawMessage `json:"content"`
		ToolCalls []struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
		ToolCallID string `json:"tool_call_id"`
		Name       string `json:"name"`
	} `json:"messages"`
}

// mockToolCall is a tool call the fake decides to emit.
type mockToolCall struct {
	Name      string
	Arguments string
}

// content reads a plain string or OpenAI multimodal parts, returning the text and the image count.
func content(raw json.RawMessage) (string, int) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, 0
	}
	var parts []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		ImageURL struct {
			URL string `json:"url"`
		} `json:"image_url"`
	}
	_ = json.Unmarshal(raw, &parts)
	var b strings.Builder
	n := 0
	for _, p := range parts {
		switch p.Type {
		case "text":
			b.WriteString(p.Text)
		case "image_url":
			if strings.HasPrefix(p.ImageURL.URL, "data:image/") {
				n++
			}
		}
	}
	return b.String(), n
}

func (l *LLM) Handler() http.Handler {
	mux := http.NewServeMux()
	// OpenAI 兼容的模型列表，供「获取可用模型」按钮在开发环境端到端联调。
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "bad-key" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key"}}`))
			return
		}
		writeJSON(w, map[string]any{"object": "list", "data": []map[string]any{
			{"id": "mock-writer", "object": "model", "owned_by": "mock"},
			{"id": "mock-fast", "object": "model", "owned_by": "mock"},
			{"id": "mock-embed", "object": "model", "owned_by": "mock"},
			{"id": "mock-vision", "object": "model", "owned_by": "mock"},
		}})
	})
	mux.HandleFunc("/v1/search", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Parameters map[string]any `json:"parameters"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Parameters["enable_search"] != true {
			w.WriteHeader(400)
			return
		}
		writeJSON(w, map[string]any{"output": map[string]any{"search_info": map[string]any{"search_results": []map[string]string{{"title": "互联网运营协作公开案例", "url": "https://example.com/search-ops", "site_name": "模拟来源"}, {"title": "不应采用的内网链接", "url": "http://127.0.0.1/admin"}}}}, "usage": map[string]int{"input_tokens": 30, "output_tokens": 20}})
	})
	mux.HandleFunc("/v1/images/generations", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "bad-key" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key"}}`))
			return
		}
		// 1x1 PNG
		const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
		writeJSON(w, map[string]any{
			"created": time.Now().Unix(),
			"data":    []any{map[string]string{"b64_json": png1}},
		})
	})
	mux.HandleFunc("/v1/embeddings", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string   `json:"model"`
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		data := make([]any, len(req.Input))
		for i, in := range req.Input {
			data[i] = map[string]any{"index": i, "embedding": embed(in)}
		}
		writeJSON(w, map[string]any{"data": data, "model": req.Model})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ") == "bad-key" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}`))
			return
		}
		raw, _ := io.ReadAll(r.Body)
		l.recordRequest(string(raw))
		var req chatReq
		if err := json.Unmarshal(raw, &req); err != nil {
			w.WriteHeader(400)
			return
		}
		if req.Model == "mock-down" {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"error":{"message":"service unavailable"}}`))
			return
		}
		noTools := l.NoTools || os.Getenv("OPS_MOCK_NO_TOOLS") == "1"
		noVision := l.NoVision || os.Getenv("OPS_MOCK_NO_VISION") == "1"
		var sys, user string
		images := 0
		historyCalls := 0
		handledCalls := 0
		lastRole, lastContent := "", ""
		for _, m := range req.Messages {
			text, n := content(m.Content)
			if m.Role == "system" {
				sys += text
			} else if m.Role == "user" {
				user, images = text, n
				handledCalls = 0
			}
			historyCalls += len(m.ToolCalls)
			if m.Role == "assistant" {
				handledCalls += len(m.ToolCalls)
			}
			lastRole, lastContent = m.Role, text
		}
		task := ""
		if m := taskRe.FindAllStringSubmatch(sys+"\n"+user, -1); len(m) > 0 {
			task = m[len(m)-1][1]
		}
		toolsSent := len(req.Tools) > 0 || len(req.ToolChoice) > 0

		var reply string
		var calls []mockToolCall
		switch {
		case strings.Contains(user, "图片是什么颜色"):
			// 看图自检探测：内置红色图片（16 文档第 13.4 节第 3 项）。
			if noVision {
				reply = "无法识别图片内容"
			} else {
				reply = "红色"
			}
		case lastRole != "tool" && hasTool(req, "ops_probe_echo"):
			if noTools {
				reply = "本模型不支持工具调用"
			} else {
				calls = []mockToolCall{{Name: "ops_probe_echo", Arguments: `{"value":"ok"}`}}
			}
		case task == "agent_summary":
			reply = "对话历史摘要：用户正在整理账号内容，之前的结论与待办保持不变。"
		case task == "agent_chat":
			reply, calls = l.agentChat(user, lastRole, lastContent, toolsSent, historyCalls, handledCalls, noTools)
		case strings.Contains(user, "任务：metric_screenshot"):
			if images == 0 {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":{"message":"this task needs image input"}}`))
				return
			}
			reply = l.metricScreenshot(user, images)
		case lastRole == "tool":
			reply = "已读取：" + short(strings.TrimSpace(lastContent), 60)
		default:
			reply = l.respond(user)
		}
		// 单轮输出上限：max_tokens 已设置且输出超过上限时截断，并以 finish_reason=length 结束
		// （16 文档第 6.5 节）。token 估算口径与下方 usage 一致（runes*2/3）。
		truncated := false
		if req.MaxTokens != nil && *req.MaxTokens > 0 {
			maxRunes := *req.MaxTokens * 3 / 2
			if runes := []rune(reply); len(runes) > maxRunes {
				reply = string(runes[:maxRunes])
				truncated = true
				calls = nil
			}
		}
		promptTokens := utf8.RuneCountInString(sys+user) * 2 / 3
		completionTokens := utf8.RuneCountInString(reply) * 2 / 3
		usage := map[string]int{"prompt_tokens": promptTokens, "completion_tokens": completionTokens, "total_tokens": promptTokens + completionTokens}
		if !req.Stream {
			if l.Delay > 0 {
				time.Sleep(l.Delay)
			}
			msg := map[string]any{"role": "assistant", "content": reply}
			finish := "stop"
			if truncated {
				finish = "length"
			}
			if len(calls) > 0 {
				finish = "tool_calls"
				msg["tool_calls"] = toolCallsJSON(calls)
				if reply == "" {
					msg["content"] = nil
				}
			}
			writeJSON(w, map[string]any{
				"id": "mock", "object": "chat.completion", "model": req.Model,
				"choices": []any{map[string]any{"index": 0, "message": msg, "finish_reason": finish}},
				"usage":   usage,
			})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		delay := l.Delay
		if req.Model == "mock-slow" {
			delay = 80 * time.Millisecond
		}
		if len(calls) > 0 {
			// 工具调用分片下发：先给 id/name，再逐段给 arguments，供适配层验证按 index 累积。
			for i, c := range calls {
				callID := nextMockToolCallID()
				writeSSE(w, fl, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{
					"tool_calls": []any{map[string]any{"index": i, "id": callID, "type": "function",
						"function": map[string]any{"name": c.Name, "arguments": ""}}},
				}}}})
				for _, piece := range splitPieces(c.Arguments, 8) {
					writeSSE(w, fl, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{
						"tool_calls": []any{map[string]any{"index": i, "function": map[string]any{"arguments": piece}}},
					}}}})
				}
			}
			writeSSE(w, fl, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}})
		} else {
			runes := []rune(reply)
			for i := 0; i < len(runes); i += 6 {
				end := min(i+6, len(runes))
				writeSSE(w, fl, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]string{"content": string(runes[i:end])}}}})
				if delay > 0 {
					select {
					case <-r.Context().Done():
						return
					case <-time.After(delay):
					}
				}
			}
			finish := "stop"
			if truncated {
				finish = "length"
			}
			writeSSE(w, fl, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": finish}}})
		}
		b, _ := json.Marshal(map[string]any{"choices": []any{}, "usage": usage})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
		if fl != nil {
			fl.Flush()
		}
	})
	return mux
}

// hasTool reports whether the request declares a tool with the given function name.
func hasTool(req chatReq, name string) bool {
	for _, t := range req.Tools {
		if t.Function.Name == name {
			return true
		}
	}
	return false
}

// writeSSE writes one SSE frame and flushes it.
func writeSSE(w http.ResponseWriter, fl http.Flusher, v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(w, "data: %s\n\n", b)
	if fl != nil {
		fl.Flush()
	}
}

// splitPieces splits s into rune chunks of at most n runes.
func splitPieces(s string, n int) []string {
	if s == "" {
		return nil
	}
	rs := []rune(s)
	var out []string
	for i := 0; i < len(rs); i += n {
		out = append(out, string(rs[i:min(i+n, len(rs))]))
	}
	return out
}

// toolCallsJSON renders tool calls in the OpenAI response shape.
func toolCallsJSON(calls []mockToolCall) []any {
	out := make([]any, 0, len(calls))
	for _, c := range calls {
		out = append(out, map[string]any{
			"id": nextMockToolCallID(), "type": "function",
			"function": map[string]any{"name": c.Name, "arguments": c.Arguments},
		})
	}
	return out
}

// agentToolRe matches a "#tool name {json}" test instruction line.
var agentToolRe = regexp.MustCompile(`^#tool\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(\{.*\}))?\s*$`)

// agentRepeatRe matches a "#repeat name {json}" instruction line: the call is
// returned on every round (used to reach limits such as the round cap in tests).
var agentRepeatRe = regexp.MustCompile(`^#repeat\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(\{.*\}))?\s*$`)

var mockToolCallSequence atomic.Uint64

func nextMockToolCallID() string { return fmt.Sprintf("call_mock_%d", mockToolCallSequence.Add(1)) }

// parseAgentInstructions reads the #tool / #repeat / #text test instructions from the last user message.
func parseAgentInstructions(user string, handledCalls int) ([]mockToolCall, string) {
	var calls []mockToolCall
	var texts []string
	for _, raw := range strings.Split(user, "\n") {
		line := strings.TrimSpace(raw)
		if m := agentRepeatRe.FindStringSubmatch(line); m != nil {
			// 持续调用指令：每轮都重新返回，不参与已处理去重（用于轮次上限等场景）。
			args := m[2]
			if args == "" {
				args = "{}"
			}
			calls = append(calls, mockToolCall{Name: m[1], Arguments: args})
			continue
		}
		if m := agentToolRe.FindStringSubmatch(line); m != nil {
			if handledCalls > 0 {
				handledCalls--
				continue
			}
			args := m[2]
			if args == "" {
				args = "{}"
			}
			calls = append(calls, mockToolCall{Name: m[1], Arguments: args})
			continue
		}
		if strings.HasPrefix(line, "#text ") {
			texts = append(texts, strings.TrimSpace(strings.TrimPrefix(line, "#text ")))
		}
	}
	return calls, strings.Join(texts, "\n")
}

// agentChat answers one agent_chat round (16 文档第 13.4 节第 1、2 项).
func (l *LLM) agentChat(user, lastRole, lastContent string, toolsSent bool, historyCalls, handledCalls int, noTools bool) (string, []mockToolCall) {
	// 卡片说明轮：本轮不发送工具定义，也没有 tool_choice。
	if !toolsSent && historyCalls > 0 {
		return fmt.Sprintf("已为你准备了 %d 张卡片。", historyCalls), nil
	}
	if lastRole == "user" && strings.HasPrefix(lastContent, "以下是用户在操作卡片上的处理结果（系统生成，不是用户的话）") {
		return "我已核对操作结果，当前批次处理完毕。", nil
	}
	calls, text := parseAgentInstructions(user, handledCalls)
	if len(calls) > 0 {
		if noTools {
			return "本模型不支持工具调用，无法执行这一步。", nil
		}
		return text, calls
	}
	if text != "" {
		return text, nil
	}
	if lastRole == "tool" {
		return "已读取：" + short(strings.TrimSpace(lastContent), 60), nil
	}
	return "我可以帮你查询和整理系统里的内容；需要写入时会先给出操作卡片，由你逐张确认。", nil
}

var taskRe = regexp.MustCompile(`任务：([a-z_]+)`)

// tplRe reads the outline structure template so the fake outline follows it step by step.
var tplRe = regexp.MustCompile(`结构模板「[^」]*」：([^\n]+?)。大纲必须按这个结构展开`)

func field(prompt, label string) string {
	lines := strings.Split(prompt, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, label) {
			value := strings.TrimSpace(strings.TrimPrefix(line, label))
			if strings.HasPrefix(value, "<<<") && i+1 < len(lines) {
				return lines[i+1]
			}
			return value
		}
	}
	return ""
}

type block struct {
	ID, Head, Body string
}

var blockRe = regexp.MustCompile(`^【(?:源)?段落 id=([0-9a-f-]+)】(.*)$`)
var materialBlockHeaderRe = regexp.MustCompile(`^<<<素材 id=([0-9a-f-]+)>>>$`)

type factMaterial struct {
	ID      string
	Content string
}

func factMaterials(prompt string) []factMaterial {
	lines := strings.Split(prompt, "\n")
	var out []factMaterial
	for i := 0; i+2 < len(lines); i++ {
		match := materialBlockHeaderRe.FindStringSubmatch(lines[i])
		if match == nil || lines[i+2] != "<<<结束>>>" {
			continue
		}
		var payload struct {
			Content string `json:"content"`
		}
		if json.Unmarshal([]byte(lines[i+1]), &payload) == nil {
			out = append(out, factMaterial{ID: match[1], Content: payload.Content})
		}
		i += 2
	}
	return out
}

func blocks(prompt string) []block {
	var out []block
	var cur *block
	for _, line := range strings.Split(prompt, "\n") {
		if m := blockRe.FindStringSubmatch(line); m != nil {
			out = append(out, block{ID: m[1], Head: strings.TrimPrefix(strings.TrimSpace(m[2]), "小标题：")})
			cur = &out[len(out)-1]
			continue
		}
		if strings.HasPrefix(line, "## ") {
			cur = nil
			continue
		}
		if cur != nil {
			cur.Body += line + "\n"
		}
	}
	return out
}

func short(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n])
}

func nzs(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func js(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// embed hashes character bigrams into a fixed-size vector so texts sharing words are close.
func embed(s string) []float32 {
	const dim = 128
	v := make([]float32, dim)
	rs := []rune(s)
	for i := 0; i+1 < len(rs); i++ {
		h := uint32(2166136261)
		for _, r := range rs[i : i+2] {
			h ^= uint32(r)
			h *= 16777619
		}
		v[h%dim]++
	}
	return v
}

var idRe = regexp.MustCompile(`id=([0-9a-f-]{36})`)

func firstSentence(s string) string {
	for _, m := range regexp.MustCompile(`[^。！？\n]+[。！？]?`).FindAllString(s, -1) {
		if t := strings.TrimSpace(m); utf8.RuneCountInString(t) >= 6 && !strings.HasPrefix(t, "#") && !strings.HasPrefix(t, "【") {
			return t
		}
	}
	return ""
}

func sectionAfter(prompt, marker string) string {
	i := strings.Index(prompt, marker)
	if i < 0 {
		return ""
	}
	rest := prompt[i+len(marker):]
	if j := strings.Index(rest, "\n## "); j >= 0 {
		rest = rest[:j]
	}
	rest = strings.TrimSpace(rest)
	if strings.HasPrefix(rest, "<<<") {
		lines := strings.Split(rest, "\n")
		if len(lines) > 1 {
			var text string
			if json.Unmarshal([]byte(lines[1]), &text) == nil {
				return text
			}
		}
	}
	return rest
}

func (l *LLM) respond(prompt string) string {
	task := ""
	if matches := taskRe.FindAllStringSubmatch(prompt, -1); len(matches) > 0 {
		task = matches[len(matches)-1][1]
	}
	viewpoint := field(prompt, "核心观点：")
	if viewpoint == "" {
		viewpoint = "把复杂的事情讲清楚"
	}
	key := field(prompt, "本段要点：")
	heading := field(prompt, "本段小标题：")
	switch task {
	case "connectivity_test":
		return "连接正常"
	case "topic_suggest":
		dir := field(prompt, "方向关键词：")
		if dir == "" {
			dir = "日常经验"
		}
		var items []map[string]string
		angles := []string{"从一次真实经历切入", "拆解一个常见误区", "给出可直接照做的清单", "对比两种做法的得失", "回答读者最常问的问题", "复盘一次失败"}
		for i, a := range angles {
			items = append(items, map[string]string{
				"title":  fmt.Sprintf("%s：%s（%d）", dir, []string{"我踩过的坑", "大多数人想错了", "一张清单讲完", "两种选择怎么选", "被问了 100 遍的问题", "一次失败教会我的事"}[i], i+1),
				"angle":  a,
				"reason": "贴合账号定位，且与最近的选题不重复",
			})
		}
		return js(map[string]any{"topics": items})
	case "topic_hot_suggest":
		if marker := strings.Index(prompt, "## 以下真实热点"); marker >= 0 {
			part := prompt[marker:]
			if end := strings.Index(part, "最近的选题"); end >= 0 {
				part = part[:end]
			}
			ids := regexp.MustCompile(`"id":"([a-f0-9-]+)"`).FindAllStringSubmatch(part, -1)
			if len(ids) > 0 {
				items := []map[string]any{}
				for i := range 6 {
					items = append(items, map[string]any{"title": fmt.Sprintf("运营实践热点的新角度 %d", i+1), "angle": "用真实实践回应公开榜单标题", "reason": "依据输入的真实热点，事件细节需核实", "hot_item_id": ids[i%len(ids)][1]})
				}
				return js(map[string]any{"topics": items})
			}
		}
		dir := field(prompt, "方向关键词：")
		if dir == "" {
			dir = "当下讨论"
		}
		var items []map[string]any
		titles := []string{"这周大家都在问的一件事", "换个角度谈季节性话题", "把公开资讯落到你的读者身上", "常青问题的新切口", "别追热榜，追读者真实困扰", "用亲身经历回应时事讨论"}
		for i, title := range titles {
			items = append(items, map[string]any{
				"title":      fmt.Sprintf("%s · %s", dir, title),
				"angle":      "结合账号定位，用可核实的个人经验回应时效话题",
				"reason":     "合规来源：不依赖平台热榜；待用户核实时效",
				"timeliness": []string{"本周讨论", "季节性", "常青+当下", "待核实", "读者痛点", "时事旁观"}[i],
			})
		}
		return js(map[string]any{"topics": items})
	case "outline":
		heads := []string{"先说结论", "为什么会这样", "我的亲身经历", "具体怎么做", "需要注意的地方"}
		if m := tplRe.FindStringSubmatch(prompt); m != nil {
			heads = nil
			for _, step := range strings.Split(m[1], "→") {
				if s := strings.TrimSpace(step); s != "" && len(heads) < 8 {
					heads = append(heads, short(s, 16))
				}
			}
		}
		var items []map[string]any
		for i, h := range heads {
			items = append(items, map[string]any{"heading": h, "key_point": fmt.Sprintf("围绕「%s」展开第 %d 层论述", short(viewpoint, 24), i+1), "material_ids": []string{}})
		}
		return js(map[string]any{"items": items})
	case "section_draft":
		para := fmt.Sprintf("关于「%s」，我想先把话说清楚：%s。\n\n这不是空谈。回头看自己走过的路，真正起作用的往往是那些不起眼的小习惯。把它们一条条写下来，你会发现事情没有想象中复杂。",
			short(heading, 20), short(key, 60))
		if strings.Contains(heading, "为什么") {
			para += "\n\n有调查显示，【待核实：相关比例数据及来源】的人都遇到过类似的问题。"
		}
		return para
	case "section_edit":
		sel := field(prompt, "选中内容：")
		if field(prompt, "候选数：") == "3" {
			return js(map[string]any{"variants": []map[string]string{
				{"label": "更口语", "text": "说白了，" + sel},
				{"label": "更精炼", "text": short(sel, max(4, utf8.RuneCountInString(sel)/2)) + "。"},
				{"label": "换个角度", "text": "如果从读者的角度看，这件事可以这样理解：先想清楚为什么，再决定怎么做，最后才是做多少。"},
			}})
		}
		switch field(prompt, "模式：") {
		case "expand":
			return sel + "换句话说，这件事的关键不在于做得多，而在于每一步都想清楚为什么要做。"
		case "shorten":
			r := []rune(sel)
			return string(r[:max(1, len(r)/2)]) + "。"
		default:
			return "换个说法：" + sel
		}
	case "title":
		var ts []map[string]string
		maxChars := 30
		if strings.Contains(prompt, "平台：小红书") {
			maxChars = 20
		}
		for i, t := range []string{"%s", "我花了三年才想明白：%s", "关于%s，说点实在的", "%s，其实没那么难", "写给新手：%s", "一个被低估的道理：%s"} {
			ts = append(ts, map[string]string{"text": short(fmt.Sprintf(t, short(viewpoint, 14)), maxChars), "style": []string{"直述", "经历", "口语", "反常识", "对象", "观点"}[i]})
		}
		return js(map[string]any{"titles": ts})
	case "summary":
		return js(map[string]string{"summary": short("这篇文章想说的是："+viewpoint+"。从亲身经历出发，讲清楚为什么、怎么做和需要注意的地方。", 110)})
	case "fact_flag":
		var items []map[string]string
		materials := factMaterials(prompt)
		for _, b := range blocks(prompt) {
			for _, sent := range regexp.MustCompile(`[^。！？\n]+[。！？]?`).FindAllString(b.Body, -1) {
				sent = strings.TrimSpace(sent)
				var item map[string]string
				switch {
				case regexp.MustCompile(`\d`).MatchString(sent) || strings.Contains(sent, "%"):
					item = map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "data", "reason": "包含具体数字，需要确认来源"}
				case strings.Contains(sent, "调查") || strings.Contains(sent, "研究"):
					item = map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "quote", "reason": "引用了调查或研究，需要给出出处"}
				case strings.Contains(sent, "最") || strings.Contains(sent, "第一") || strings.Contains(sent, "绝对"):
					item = map[string]string{"section_id": b.ID, "quote": sent, "claim_type": "absolute", "reason": "绝对化表达，确认是否有依据"}
				}
				if item != nil {
					item["support_status"] = "unverified"
					for _, material := range materials {
						if strings.Contains(material.Content, sent) {
							item["support_status"] = "supported"
							item["material_id"] = material.ID
							item["material_quote"] = sent
							break
						}
					}
					items = append(items, item)
				}
			}
		}
		if items == nil {
			items = []map[string]string{}
		}
		return js(map[string]any{"items": items})
	case "rewrite_plan":
		var secs []map[string]any
		bs := blocks(prompt)
		target := field(prompt, "目标平台：")
		for i := 0; i < len(bs); i++ {
			ids := []string{bs[i].ID}
			if target == "小红书" && i+1 < len(bs) {
				ids = append(ids, bs[i+1].ID)
				i++
			}
			secs = append(secs, map[string]any{"source_section_ids": ids, "key_point": "压缩表达：" + short(bs[i].Head, 20)})
		}
		title := short(field(prompt, "源标题："), 18)
		return js(map[string]any{"title": title + "｜我的真实经验", "sections": secs, "topics": []string{"经验分享", "成长", "干货", "自我提升"}})
	case "section_rewrite":
		src := blocks(prompt)
		var b strings.Builder
		for _, s := range src {
			b.WriteString(short(s.Body, 60))
			b.WriteString("\n")
		}
		if field(prompt, "目标平台：") == "小红书" {
			return "✨ " + short(key, 30) + "\n" + strings.TrimSpace(b.String()) + "\n这一点真的很重要，建议收藏。"
		}
		return "## " + short(key, 20) + "\n\n" + strings.TrimSpace(b.String()) + "\n\n这里展开说说背后的原因和具体做法。"
	case "review_analysis":
		return js(map[string]any{
			"writing_insights": []string{"标题里写出具体数字的作品阅读更高", "开头先讲一个具体场景的作品读完率更好"},
			"conclusions":      []string{"带有亲身经历的文章阅读完成度更高", "标题中给出明确对象（如「写给新手」）的作品分享更多", "发布时间集中在晚上 8 点后的作品互动更好"},
			"topic_suggestions": []map[string]string{
				{"title": "写给新手的第一份避坑清单", "angle": "延续表现最好的清单体", "reason": "清单体分享率高"},
				{"title": "我做错过的三个决定", "angle": "真实经历复盘", "reason": "经历类完成度高"},
				{"title": "被问最多的五个问题", "angle": "问答体", "reason": "评论区高频问题"},
			},
		})
	case "style_summary":
		return "语气：亲切、克制，常用第一人称讲经历。\n句式：短句为主，段落短，常用设问引出观点。\n结构：先结论后展开，结尾给出可执行建议。"
	case "comic_storyboard":
		n := 6
		if v := field(prompt, "格数："); v != "" {
			fmt.Sscanf(v, "%d", &n)
		}
		if n < 2 {
			n = 2
		}
		ids := regexp.MustCompile(`id=([0-9a-f-]{36})`).FindAllStringSubmatch(prompt, -1)
		var charID string
		if len(ids) > 0 {
			charID = ids[0][1]
		}
		var panels []map[string]any
		for i := 0; i < n; i++ {
			cids := []string{}
			if charID != "" {
				cids = []string{charID}
			}
			panels = append(panels, map[string]any{
				"scene":         fmt.Sprintf("场景 %d：围绕「%s」的一幕", i+1, short(viewpoint, 16)),
				"character_ids": cids,
				"action":        fmt.Sprintf("角色做出第 %d 步反应", i+1),
				"shot":          []string{"远景", "中景", "近景", "特写", "过肩", "俯视"}[i%6],
				"narration":     fmt.Sprintf("旁白：关于「%s」的第 %d 层说明。", short(viewpoint, 12), i+1),
				"dialogue":      short(fmt.Sprintf("对白 %d", i+1), 20),
			})
		}
		return js(map[string]any{"panels": panels})
	case "comic_panel_text":
		return js(map[string]string{
			"narration":    "旁白：" + short(viewpoint, 40),
			"dialogue":     short("这件事得想清楚。", 30),
			"image_prompt": "暖色漫画风，角色表情生动，画面干净，留出气泡位置。",
		})
	case "comic_rewrite":
		ids := regexp.MustCompile(`【源分格 id=([0-9a-f-]{36})】`).FindAllStringSubmatch(prompt, -1)
		var panels []map[string]string
		for i, m := range ids {
			panels = append(panels, map[string]string{
				"source_panel_id": m[1],
				"narration":       fmt.Sprintf("改写旁白 %d：%s", i+1, short(viewpoint, 24)),
				"dialogue":        short(fmt.Sprintf("改写对白 %d", i+1), 20),
			})
		}
		if len(panels) == 0 {
			panels = []map[string]string{{"source_panel_id": "00000000-0000-0000-0000-000000000001", "narration": "旁白", "dialogue": "对白"}}
		}
		return js(map[string]any{"title": short(field(prompt, "源标题："), 18) + "｜跨平台", "panels": panels})
	case "image_suggest":
		if strings.Contains(prompt, "图片页") || strings.Contains(prompt, "封面页") {
			return js(map[string]any{"pages": []map[string]string{
				{"title": short(viewpoint, 12), "body": "封面：一句话抓住读者"},
				{"title": "要点一", "body": "把核心观点拆成可执行的一小步"},
				{"title": "要点二", "body": "用亲身经历说明为什么有效"},
				{"title": "收尾", "body": "留下一句可收藏的结论"},
			}})
		}
		return js(map[string]any{"suggestions": []map[string]string{
			{"description": "人物特写，略带思考表情", "prompt": "中景，自然光，真实感插画，人物侧脸思考，背景简洁"},
			{"description": "场景示意图", "prompt": "扁平插画，桌面与笔记本，暖色调，留白充足"},
		}})
	case "organize_notes":
		return "## 先说结论\n\n" + short(viewpoint, 80) + "\n\n## 具体怎么做\n\n把要点按顺序整理成可执行的步骤，不添加新的事实。"
	case "section_continue":
		return "换句话说，真正重要的是先想清楚下一步要做什么。"
	case "hook_suggest":
		return js(map[string]any{"variants": []map[string]string{
			{"label": "场景", "text": "上周三晚上十点，我还在改一份没人会看的报告。"},
			{"label": "提问", "text": "你有没有算过，自己一周有多少时间花在了没必要的事情上？"},
			{"label": "反常识", "text": "做得越多，不一定越好；很多时候，少做一件事反而更有用。"},
		}})
	case "outline_review":
		return js(map[string]any{"issues": []map[string]any{
			{"items": []int{1, 2}, "problem": "第 1、2 项的论点有重叠", "suggestion": "合并为一项，或让第 2 项聚焦原因"},
			{"items": []int{4}, "problem": "缺少具体的例子支撑", "suggestion": "补充一条经历类素材"},
		}, "overall": "结构清楚，先结论后展开；建议补充论据并减少重复。"})
	case "copilot_chat":
		question := sectionAfter(prompt, "## 作者的问题")
		if strings.Contains(question, "请逐段起草") || strings.Contains(question, "整篇或多段正文") {
			return "请逐段起草：建议按大纲顺序，从「先说结论」开始，一段写完再让我看论证。"
		}
		return js(map[string]any{"reply": "这段可以更紧凑，先给结论，再补自己的实际经历。", "suggestions": []map[string]string{
			{"kind": "rewrite", "target": "section", "text": "先明确问题，再写下亲身经历和下一步行动。", "reason": "先给结论，减少铺垫"},
			{"kind": "append", "text": "记录尝试的结果，下次继续改进。", "reason": "补充具体行动"},
			{"kind": "delete", "target": "section", "reason": "如果本段重复其他论据，可以单独确认清空本段"},
		}})
	case "polish_check":
		var issues []map[string]string
		for _, b := range blocks(prompt) {
			if s := firstSentence(b.Body); s != "" {
				issues = append(issues, map[string]string{"section_id": b.ID, "quote": s, "problem": "这里的论据还不够具体", "suggestion": "补一个具体的例子或数据来源"})
			}
		}
		if issues == nil {
			issues = []map[string]string{}
		}
		return js(map[string]any{"issues": issues})
	case "fix_suggest":
		sent := field(prompt, "命中的句子：")
		if sent == "" {
			sent = "这句话"
		}
		clean := strings.NewReplacer("最", "很", "第一", "领先", "绝对", "相当").Replace(sent)
		return js(map[string]any{"variants": []map[string]string{
			{"text": clean, "note": "去掉绝对化表达"},
			{"text": "在我的经验里，" + clean, "note": "改为个人经验表述"},
		}})
	case "topic_score":
		var scores []map[string]any
		for i, m := range regexp.MustCompile(`选题 id=([0-9a-f-]{36})`).FindAllStringSubmatch(prompt, -1) {
			scores = append(scores, map[string]any{"topic_id": m[1], "fit": 85 - i*7%40, "reason": "与账号定位的方向一致"})
		}
		if scores == nil {
			scores = []map[string]any{}
		}
		return js(map[string]any{"scores": scores})
	case "account_positioning":
		domain := nzs(field(prompt, "领域："), "职场成长")
		exp := short(nzs(field(prompt, "真实经历与资源："), "多年一线工作经历"), 24)
		pillars := func(names ...string) []map[string]any {
			var ps []map[string]any
			ratios := []int{40, 35, 25, 20}
			for i, n := range names {
				ps = append(ps, map[string]any{"name": n, "desc": n + "相关的经验与方法", "ratio": ratios[i],
					"examples": []string{n + "：我踩过的三个坑", n + "的一份清单"}})
			}
			return ps
		}
		return js(map[string]any{"options": []map[string]any{
			{"niche": domain + "里的实战经验", "audience": "刚入行 1–3 年、想少走弯路的人",
				"differentiation": "基于" + exp + "，只讲亲身做过的事", "persona": "坦诚的过来人",
				"pillars": pillars("实战复盘", "方法清单", "行业观察"), "cadence": map[string]any{"per_week": 3, "days": []int{1, 3, 5}},
				"keywords": []string{domain, "复盘", "新人"}, "taboo": []string{"情感八卦"}, "fit_reason": "经历具体，适合以复盘建立信任", "risks": []string{"更新压力较大"}},
			{"niche": domain + "工具与效率", "audience": "追求效率的在职人士",
				"differentiation": "把" + exp + "中的做法整理成可复用的工具", "persona": "务实的整理者",
				"pillars": pillars("工具测评", "流程模板", "效率误区"), "cadence": map[string]any{"per_week": 2, "days": []int{2, 5}},
				"keywords": []string{domain, "效率", "工具"}, "taboo": []string{"夸大收益"}, "fit_reason": "门槛低、易产出", "risks": []string{"同类账号多"}},
		}})
	case "strategy_revise":
		return js(map[string]any{"changes": []map[string]any{
			{"field": "keywords", "to": []string{"复盘", "新人", "沟通"}, "reason": "近 30 天沟通类作品阅读更高"},
			{"field": "stage", "to": "growth", "reason": "已稳定更新一个月，可以进入成长期"},
			{"field": "niche", "to": 123, "reason": "类型不对的建议应被丢弃"},
		}})
	case "strategy_outline":
		var slots []map[string]any
		for i, m := range regexp.MustCompile(`槽位 date=(\d{4}-\d{2}-\d{2}) 支柱=([^\n]+)`).FindAllStringSubmatch(prompt, -1) {
			p := strings.TrimSpace(m[2])
			title := fmt.Sprintf("%s：第 %d 个值得写的问题", p, i+1)
			if strings.Contains(prompt, "不要再给出这些标题") {
				title = "换个视角聊聊" + p
			}
			slots = append(slots, map[string]any{"date": m[1], "pillar": p, "title": title,
				"angle": "从一次真实经历切入", "reason": "按支柱轮换补齐", "hot_item_id": nil})
		}
		if slots == nil {
			slots = []map[string]any{}
		}
		return js(map[string]any{"slots": slots})
	case "daily_recommend":
		count, _ := strconv.Atoi(field(prompt, "推荐数量："))
		if count < 1 {
			count = 3
		}
		var candidates []map[string]any
		_ = json.Unmarshal([]byte(field(prompt, "规则候选：")), &candidates)
		format := l.ForceDailyFormat
		if format == "" {
			format = nzs(field(prompt, "作品类型："), "image_note")
		}
		items := []map[string]any{}
		for i := 0; i < count && len(candidates) > 0; i++ {
			c := candidates[i%len(candidates)]
			basis := map[string]any{"type": c["type"]}
			if c["id"] != nil {
				basis["id"] = c["id"]
			}
			if c["name"] != nil {
				basis["name"] = c["name"]
			}
			items = append(items, map[string]any{"title": fmt.Sprintf("%v：实践问题 %d（%d）", c["title"], i+1, len(prompt)), "angle": "由作者自己的实践展开", "audience": "正在尝试实践的读者", "hook": "一次真实困惑", "needed_materials": []string{"个人经历"}, "format": format, "reason": "优先补齐近期支柱与已确认计划", "basis": []map[string]any{basis}, "primary": i < 2})
		}
		return js(map[string]any{"items": items})
	case "daily_brief":
		pending := field(prompt, "待回填数据的已发布作品：")
		rec := field(prompt, "今日推荐")
		items := []string{}
		if strings.HasPrefix(rec, "0 条") {
			items = append(items, "今天没有新的推荐，先处理昨天的采用。")
		} else {
			items = append(items, "从今日推荐里挑一条开始写。")
		}
		if pending != "" && pending != "0" {
			items = append(items, "有 "+pending+" 篇已发布的作品还差数据回填。")
		}
		return js(map[string]any{"items": items})
	case "read_through":
		blocks := blocks(prompt)
		var su []map[string]any
		for i, bl := range blocks {
			if i >= 2 {
				break
			}
			action := "rewrite"
			if i == 1 {
				action = "append"
			}
			su = append(su, map[string]any{"section_id": bl.ID, "action": action,
				"text": fmt.Sprintf("换个更具体的说法：%s", short(bl.Head, 18)), "reason": "通读后认为该段可以更具体"})
		}
		if su == nil {
			su = []map[string]any{}
		}
		return js(map[string]any{"suggestions": su})
	case "reference_analyze":
		return js(map[string]any{"title_pattern": "问题场景加行动收益", "hook_type": "情景提问", "structure": []string{"界定问题", "分析障碍", "给出行动", "总结启发"}, "angle": "以读者困难组织论证", "tags": []string{"写作方法"}, "takeaways": []string{"将建议拆成可以验证的小任务"}})
	case "hot_relevance":
		items := []map[string]any{}
		for i, m := range regexp.MustCompile(`"id":"([a-f0-9-]+)"`).FindAllStringSubmatch(prompt, -1) {
			items = append(items, map[string]any{"hot_item_id": m[1], "relevance": max(60, 95-i*5), "reason": "与账号运营定位相关", "angle": "从真实实践切入，不补充未经证实的细节", "risk": []string{}})
		}
		return js(map[string]any{"items": items})
	case "profile_bootstrap":
		return js(map[string]any{
			"positioning_tags": []string{"职场成长", "效率方法"}, "target_audience": "工作 1–5 年的职场人",
			"persona_tone": "像一位有经验的同事，真诚具体", "banned_words_suggest": []string{"颠覆"},
			"style_summary": "短段落，先讲场景再给建议，结尾落到一个可执行的小动作。",
			"evidence":      map[string]string{"positioning_tags": "样本多次讨论会议、周报等职场话题", "target_audience": "样本中的场景多为入职不久的同事"},
		})
	case "material_extract":
		src := sectionAfter(prompt, "## 原文")
		var items []map[string]any
		for _, line := range strings.Split(src, "\n") {
			line = strings.TrimSpace(line)
			if utf8.RuneCountInString(line) < 8 {
				continue
			}
			kind := "opinion"
			switch {
			case regexp.MustCompile(`\d`).MatchString(line):
				kind = "data"
			case strings.Contains(line, "我"):
				kind = "experience"
			case strings.Contains(line, "公司") || strings.Contains(line, "案例"):
				kind = "case"
			}
			items = append(items, map[string]any{"kind": kind, "content": short(line, 200), "source_hint": "原文", "tags": []string{"提炼"}})
			if len(items) >= 8 {
				break
			}
		}
		if items == nil {
			items = []map[string]any{}
		}
		return js(map[string]any{"items": items})
	case "material_tag":
		return js(map[string]any{"kind": "opinion", "tags": []string{"方法论", "职场"}})
	case "inbox_triage":
		text := sectionAfter(prompt, "## 灵感")
		if regexp.MustCompile(`\d|我`).MatchString(text) {
			return js(map[string]any{"as": "material", "kind": "experience", "tags": []string{"灵感"}, "reason": "更像一条可引用的经历"})
		}
		return js(map[string]any{"as": "topic", "title": short(text, 24), "angle": "从读者的一个具体困扰切入", "audience": "关注这个话题的读者", "reason": "可以展开成一篇完整的内容"})
	case "memory_distill":
		return js(map[string]any{"memories": []map[string]string{
			{"kind": "tone", "scope": "draft", "text": "段落开头先讲一个具体场景", "evidence": "多次把抽象开头改成了场景"},
		}})
	case "tag_suggest":
		return js(map[string]any{"tags": []map[string]string{
			{"text": "#职场成长", "reason": "与正文主题一致"}, {"text": "#效率工具", "reason": "正文提到了具体方法"}, {"text": "#打工人日常", "reason": "贴近读者场景"},
		}})
	case "review_attribution":
		return js(map[string]any{"conclusions": []map[string]string{
			{"text": "标题含数字的作品平均阅读更高", "confidence": "基于本账号已录入数据的分组对比，每组样本不少于 3 篇"},
			{"text": "晚上发布的作品互动倾向更好", "confidence": "部分分组样本少于 3 篇，仅供参考"},
		}})
	case "work_breakdown":
		return js(map[string]any{
			"structure": []string{"开头：具体场景引入", "中段：拆解原因", "后段：给出方法", "结尾：一个可执行的小动作"},
			"opening":   "用一个具体时间和场景开头", "title_features": []string{"给出明确对象", "包含具体动作"},
			"angle": "从一个常见困扰切入", "reusable_rules": []string{"开头先讲场景再讲观点", "结尾给一个今天就能做的小动作"},
			"outline_template": []map[string]string{{"heading": "一个具体场景", "key_point": "让读者代入"}, {"heading": "为什么会这样", "key_point": "拆解原因"},
				{"heading": "我的做法", "key_point": "给出方法"}, {"heading": "从今天开始", "key_point": "一个小动作"}},
		})
	case "weekly_digest":
		return js(map[string]any{"summary": "上周按计划完成了发布，整体节奏稳定。", "highlights": []string{"保持了稳定的更新节奏"}, "next_focus": []string{"补录上周作品的数据"}})
	case "layout_suggest":
		sugs := []map[string]any{{"section": 1, "kind": "bold", "text": "这一句原文里没有", "reason": "编造的句子应被丢弃"}}
		if i := strings.Index(prompt, "### 第 1 段\n"); i >= 0 {
			body := prompt[i+len("### 第 1 段\n"):]
			if j := strings.Index(body, "。"); j > 0 {
				sugs = append(sugs, map[string]any{"section": 1, "kind": "bold", "text": strings.TrimSpace(body[:j+len("。")]), "reason": "开篇第一句适合加粗"})
			}
		}
		return js(map[string]any{"suggestions": sugs})
	default:
		return "好的。"
	}
}

var shotWorkRe = regexp.MustCompile(`(?m)^- 《(.+?)》 work_id=([0-9a-f-]+)，形态=([a-z_]+)`)

// metricScreenshot fakes a vision model: one row per image, titled after the listed works in order.
// The comments value never appears in raw_text, so the server must drop it as invented.
func (l *LLM) metricScreenshot(prompt string, images int) string {
	type shotWork struct {
		title, id, contentFormat string
	}
	var works []shotWork
	for _, m := range shotWorkRe.FindAllStringSubmatch(prompt, -1) {
		works = append(works, shotWork{title: m[1], id: m[2], contentFormat: m[3]})
	}
	reads := []string{"1.2万", "3,456", "10万+"}
	var rows []map[string]any
	for i := range images {
		var work shotWork
		if len(works) > 0 {
			work = works[i%len(works)]
		}
		r := reads[i%len(reads)]
		likes := strconv.Itoa(36 + i)
		rows = append(rows, map[string]any{
			"title": work.title, "work_id": work.id, "content_format": work.contentFormat, "published_at": "", "day_hint": "截至今日",
			"metrics":  map[string]any{"reads": r, "likes": likes, "favorites": 8, "comments": "999"},
			"raw_text": fmt.Sprintf("%s 阅读 %s 点赞 %s 收藏 8", work.title, r, likes),
		})
	}
	return js(map[string]any{"rows": rows})
}
