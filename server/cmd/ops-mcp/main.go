// Command ops-mcp 是 REF41 E2 的独立 MCP Server 进程。
//
// 形态：
//   - 默认 stdio：逐行 JSON-RPC 2.0，供本地 MCP 客户端拉起；
//   - 可选 HTTP：`-http 127.0.0.1:8092`，POST /mcp 接收同协议请求。
//
// 只读边界：进程本身不连数据库，也不实现任何写工具；五个工具全部转发到
// OPS 的 POST /api/v1/mcp/call 数据面，token/scope/租户隔离/限流/审计仍由
// 服务端统一裁决。因此独立进程不能绕过 D-117 或直接写库。
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	serverName       = "ops-mcp"
	serverVersion    = "1.0.0"
	protocolVersion  = "2024-11-05"
	defaultEndpoint  = "http://127.0.0.1:8080/api/v1/mcp/call"
	maxMessageBytes  = 1 << 20
	maxResponseBytes = 8 << 20
	httpTimeout      = 30 * time.Second
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpProxy struct {
	endpoint string
	token    string
	client   *http.Client
}

type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations map[string]any `json:"annotations,omitempty"`
}

var readOnlyAnnotation = map[string]any{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false}

var mcpTools = []toolDef{
	{
		Name:        "list_topics",
		Description: "列出指定账号的选题（只读，最多 50 条）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"account_id": map[string]any{"type": "string", "description": "平台账号 UUID"},
				"status":     map[string]any{"type": "string", "description": "选题状态，可选"},
				"limit":      map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
			},
			"required":             []string{"account_id"},
			"additionalProperties": false,
		},
		Annotations: readOnlyAnnotation,
	},
	{
		Name:        "get_work",
		Description: "读取一篇作品及其分节正文（只读）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"work_id": map[string]any{"type": "string", "description": "作品 UUID"},
			},
			"required":             []string{"work_id"},
			"additionalProperties": false,
		},
		Annotations: readOnlyAnnotation,
	},
	{
		Name:        "get_review",
		Description: "读取一篇作品已生成的复盘报告（只读）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"work_id": map[string]any{"type": "string", "description": "作品 UUID"},
			},
			"required":             []string{"work_id"},
			"additionalProperties": false,
		},
		Annotations: readOnlyAnnotation,
	},
	{
		Name:        "get_metrics",
		Description: "读取指定账号在日期区间内的每日指标（只读）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"account_id": map[string]any{"type": "string", "description": "平台账号 UUID"},
				"from":       map[string]any{"type": "string", "description": "起始日期 YYYY-MM-DD"},
				"to":         map[string]any{"type": "string", "description": "结束日期 YYYY-MM-DD"},
			},
			"required":             []string{"account_id", "from", "to"},
			"additionalProperties": false,
		},
		Annotations: readOnlyAnnotation,
	},
	{
		Name:        "list_benchmark_targets",
		Description: "列出竞对/对标目标（只读，可按账号过滤）。",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"account_id": map[string]any{"type": "string", "description": "平台账号 UUID，可选"},
			},
			"additionalProperties": false,
		},
		Annotations: readOnlyAnnotation,
	},
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("ops-mcp: ")

	var endpoint, httpAddr, tokenFlag, tokenFile string
	flag.StringVar(&endpoint, "endpoint", envOr("OPS_MCP_ENDPOINT", defaultEndpoint), "OPS MCP data-plane URL")
	flag.StringVar(&httpAddr, "http", "", "可选 HTTP 监听地址，例如 127.0.0.1:8092；为空则只走 stdio")
	flag.StringVar(&tokenFlag, "token", "", "MCP token；建议改用 OPS_MCP_TOKEN 或 -token-file，避免进程列表泄漏")
	flag.StringVar(&tokenFile, "token-file", "", "从文件读取 MCP token（取首行）")
	flag.Parse()

	token := strings.TrimSpace(tokenFlag)
	if tokenFile != "" {
		data, err := os.ReadFile(tokenFile)
		if err != nil {
			log.Fatalf("读取 token 文件失败：%v", err)
		}
		token = strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	}
	if token == "" {
		token = strings.TrimSpace(os.Getenv("OPS_MCP_TOKEN"))
	}
	if token == "" {
		log.Fatal("缺少 MCP token：设置 OPS_MCP_TOKEN、-token 或 -token-file")
	}
	if endpoint == "" {
		log.Fatal("缺少 -endpoint")
	}

	proxy := &mcpProxy{
		endpoint: endpoint,
		token:    token,
		client:   &http.Client{Timeout: httpTimeout},
	}

	if httpAddr != "" {
		addr := normalizeHTTPAddr(httpAddr)
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("监听 %s 失败：%v", addr, err)
		}
		log.Printf("HTTP MCP 已监听 %s（POST /mcp）", listener.Addr().String())
		mux := http.NewServeMux()
		mux.Handle("/mcp", proxy.httpHandler())
		mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		})
		srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP MCP 退出：%v", err)
		}
		return
	}

	if err := proxy.serveStdio(context.Background(), os.Stdin, os.Stdout); err != nil {
		log.Fatalf("stdio 退出：%v", err)
	}
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// normalizeHTTPAddr 把裸 ":8092" 收紧到回环地址，避免默认暴露到局域网。
func normalizeHTTPAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if strings.HasPrefix(addr, ":") {
		return "127.0.0.1" + addr
	}
	if !strings.Contains(addr, ":") {
		return "127.0.0.1:" + addr
	}
	return addr
}

func (p *mcpProxy) serveStdio(ctx context.Context, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64<<10), maxMessageBytes)
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		resp, write := p.handleMessage(ctx, line)
		if !write {
			continue
		}
		if err := enc.Encode(resp); err != nil {
			return fmt.Errorf("写入 JSON-RPC 响应失败: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return errors.New("单条 JSON-RPC 消息超过 1 MiB")
		}
		return fmt.Errorf("读取 stdio 失败: %w", err)
	}
	return nil
}

func (p *mcpProxy) httpHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxMessageBytes+1))
		if err != nil {
			http.Error(w, "read failed", http.StatusBadRequest)
			return
		}
		if len(body) > maxMessageBytes {
			http.Error(w, "message too large", http.StatusRequestEntityTooLarge)
			return
		}
		resp, write := p.handleMessage(r.Context(), bytes.TrimSpace(body))
		w.Header().Set("Content-Type", "application/json")
		if !write {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(resp)
	})
}

func (p *mcpProxy) handleMessage(ctx context.Context, raw []byte) (*rpcResponse, bool) {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return errorResponse(nil, -32700, "JSON 解析失败", nil), true
	}
	if req.JSONRPC != "2.0" {
		return errorResponse(req.ID, -32600, "仅支持 JSON-RPC 2.0", nil), true
	}
	// JSON-RPC notification 没有 id；MCP 的 initialized/cancelled 通知不需要回包。
	if len(req.ID) == 0 || bytes.Equal(bytes.TrimSpace(req.ID), []byte("null")) {
		return nil, false
	}
	switch req.Method {
	case "initialize":
		return resultResponse(req.ID, map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": serverName, "version": serverVersion},
			"instructions":    "OPS 只读 MCP：五个工具均转发到已认证的数据面，不支持写/发布/确认。",
		}), true
	case "ping":
		return resultResponse(req.ID, map[string]any{}), true
	case "tools/list":
		return resultResponse(req.ID, map[string]any{"tools": mcpTools}), true
	case "tools/call":
		return p.handleToolCall(ctx, req)
	default:
		return errorResponse(req.ID, -32601, "未知方法："+req.Method, nil), true
	}
}

func (p *mcpProxy) handleToolCall(ctx context.Context, req rpcRequest) (*rpcResponse, bool) {
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if len(req.Params) == 0 || json.Unmarshal(req.Params, &params) != nil {
		return errorResponse(req.ID, -32602, "tools/call 参数无效", nil), true
	}
	if params.Name == "" {
		return errorResponse(req.ID, -32602, "tools/call 缺少 name", nil), true
	}
	args := params.Arguments
	if len(args) == 0 || bytes.Equal(bytes.TrimSpace(args), []byte("null")) {
		args = json.RawMessage(`{}`)
	}
	body, err := json.Marshal(map[string]any{"tool": params.Name, "arguments": args})
	if err != nil {
		return toolErrorResponse(req.ID, "参数序列化失败"), true
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
	if err != nil {
		return toolErrorResponse(req.ID, "构造请求失败"), true
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+p.token)
	resp, err := p.client.Do(httpReq)
	if err != nil {
		return toolErrorResponse(req.ID, "无法连接 OPS 数据面"), true
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return toolErrorResponse(req.ID, "读取 OPS 响应失败"), true
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return toolErrorResponse(req.ID, apiErrorText(resp.StatusCode, data)), true
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return toolErrorResponse(req.ID, "OPS 返回了非 JSON 内容"), true
	}
	text, _ := json.Marshal(parsed)
	return resultResponse(req.ID, map[string]any{
		"content":           []map[string]any{{"type": "text", "text": string(text)}},
		"structuredContent": parsed,
		"isError":           false,
	}), true
}

// apiErrorText 只提取错误码/消息，不回传整个响应体，也不带 token。
func apiErrorText(status int, data []byte) string {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &envelope) == nil && envelope.Error.Code != "" {
		return fmt.Sprintf("%s：%s", envelope.Error.Code, envelope.Error.Message)
	}
	return fmt.Sprintf("OPS 数据面返回 HTTP %d", status)
}

func resultResponse(id json.RawMessage, result any) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func errorResponse(id json.RawMessage, code int, message string, data any) *rpcResponse {
	return &rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message, Data: data}}
}

func toolErrorResponse(id json.RawMessage, message string) *rpcResponse {
	return resultResponse(id, map[string]any{
		"content": []map[string]any{{"type": "text", "text": message}},
		"isError": true,
	})
}
