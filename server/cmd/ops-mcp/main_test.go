package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func decodeRPC(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("响应不是 JSON: %v\n%s", err, raw)
	}
	return got
}

func TestMCPInitializeAndToolsList(t *testing.T) {
	p := &mcpProxy{endpoint: "http://127.0.0.1:1/api/v1/mcp/call", token: "secret-test-token"}
	initResp, write := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	if !write {
		t.Fatal("initialize 应回包")
	}
	result := initResp.Result.(map[string]any)
	if result["protocolVersion"] != protocolVersion {
		t.Fatalf("protocolVersion=%v", result["protocolVersion"])
	}
	if result["serverInfo"].(map[string]any)["name"] != serverName {
		t.Fatal("serverInfo 缺 name")
	}

	listResp, _ := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	tools := listResp.Result.(map[string]any)["tools"].([]toolDef)
	if len(tools) != 5 {
		t.Fatalf("工具数量=%d，期望 5", len(tools))
	}
	want := []string{"list_topics", "get_work", "get_review", "get_metrics", "list_benchmark_targets"}
	for i, name := range want {
		if tools[i].Name != name {
			t.Fatalf("工具[%d]=%s，期望 %s", i, tools[i].Name, name)
		}
		if tools[i].Annotations["readOnlyHint"] != true {
			t.Fatalf("工具 %s 缺 readOnlyHint", name)
		}
	}
}

func TestMCPUnknownMethodAndNotification(t *testing.T) {
	p := &mcpProxy{endpoint: "http://127.0.0.1:1", token: "t"}
	resp, write := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":"x","method":"tools/write"}`))
	if !write || resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("未知方法应返回 -32601: %+v", resp)
	}
	if _, write := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)); write {
		t.Fatal("notification 不应回包")
	}
	if resp, write := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize"`)); !write || resp.Error == nil || resp.Error.Code != -32700 {
		t.Fatalf("坏 JSON 应返回 -32700: %+v", resp)
	}
}

func TestMCPToolCallProxiesBearerAndArguments(t *testing.T) {
	var gotAuth, gotTool string
	var gotArgs map[string]any
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method=%s", r.Method)
		}
		gotAuth = r.Header.Get("Authorization")
		var body struct {
			Tool      string         `json:"tool"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		gotTool, gotArgs = body.Tool, body.Arguments
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"topics":[],"read_only":true}`))
	}))
	defer backend.Close()

	p := &mcpProxy{endpoint: backend.URL, token: "ops_mcp_test_token", client: backend.Client()}
	resp, write := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_topics","arguments":{"account_id":"acc","limit":5}}}`))
	if !write || resp.Error != nil {
		t.Fatalf("tools/call 失败: %+v", resp)
	}
	root := resp.Result.(map[string]any)
	if root["isError"] != false {
		t.Fatalf("isError=%v", root["isError"])
	}
	content := root["content"].([]map[string]any)
	if len(content) != 1 || content[0]["type"] != "text" {
		t.Fatalf("content=%+v", content)
	}
	if gotAuth != "Bearer ops_mcp_test_token" {
		t.Fatalf("Authorization=%q", gotAuth)
	}
	if gotTool != "list_topics" || gotArgs["account_id"] != "acc" || gotArgs["limit"] != float64(5) {
		t.Fatalf("转发参数错误 tool=%q args=%+v", gotTool, gotArgs)
	}
	marshaled, _ := json.Marshal(resp)
	if bytes.Contains(marshaled, []byte("ops_mcp_test_token")) {
		t.Fatal("响应泄漏 token")
	}
}

func TestMCPToolCallSurfacesBackendError(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"mcp_scope_denied","message":"缺少 scope"}}`))
	}))
	defer backend.Close()

	p := &mcpProxy{endpoint: backend.URL, token: "t", client: backend.Client()}
	resp, _ := p.handleMessage(context.Background(), []byte(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get_work","arguments":{"work_id":"w"}}}`))
	root := resp.Result.(map[string]any)
	if root["isError"] != true {
		t.Fatalf("isError=%v", root["isError"])
	}
	text := root["content"].([]map[string]any)[0]["text"].(string)
	if !strings.Contains(text, "mcp_scope_denied") {
		t.Fatalf("错误文本=%q", text)
	}
}

func TestMCPStdioLoopHandlesNotifications(t *testing.T) {
	p := &mcpProxy{endpoint: "http://127.0.0.1:1", token: "t"}
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	}, "\n")
	var out bytes.Buffer
	if err := p.serveStdio(context.Background(), strings.NewReader(input), &out); err != nil {
		t.Fatalf("serveStdio: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("输出行数=%d，期望 2（通知不回包）\n%s", len(lines), out.String())
	}
	if decodeRPC(t, []byte(lines[0]))["jsonrpc"] != "2.0" {
		t.Fatal("首行不是 JSON-RPC 2.0")
	}
	if len(decodeRPC(t, []byte(lines[1]))["result"].(map[string]any)["tools"].([]any)) != 5 {
		t.Fatal("第二行 tools/list 数量不对")
	}
}

func TestMCPHTTPHandler(t *testing.T) {
	p := &mcpProxy{endpoint: "http://127.0.0.1:1", token: "t"}
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":3,"method":"ping"}`))
	rec := httptest.NewRecorder()
	p.httpHandler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if decodeRPC(t, rec.Body.Bytes())["result"] == nil {
		t.Fatal("ping 无 result")
	}

	rec = httptest.NewRecorder()
	p.httpHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/mcp", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", rec.Code)
	}
}

func TestNormalizeHTTPAddrStaysLoopbackByDefault(t *testing.T) {
	cases := map[string]string{
		":8092":        "127.0.0.1:8092",
		"8092":         "127.0.0.1:8092",
		"127.0.0.1:9":  "127.0.0.1:9",
		"0.0.0.0:8092": "0.0.0.0:8092",
	}
	for in, want := range cases {
		if got := normalizeHTTPAddr(in); got != want {
			t.Fatalf("normalizeHTTPAddr(%q)=%q，期望 %q", in, got, want)
		}
	}
}

// TestMCPStdioProcess 真正启动独立二进制，通过 stdin/stdout 完成 initialize 与
// tools/call；后端只替身 HTTP 数据面，目的是证明“独立进程 + stdio 协议”可用，
// 不替代 E2 的真实数据面 E2E。
func TestMCPStdioProcess(t *testing.T) {
	var gotAuth string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"topics":[],"read_only":true}`))
	}))
	defer backend.Close()

	exe := filepath.Join(t.TempDir(), "ops-mcp-test.exe")
	build := exec.Command("go", "build", "-o", exe, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("构建独立进程失败: %v", err)
	}

	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(),
		"OPS_MCP_ENDPOINT="+backend.URL,
		"OPS_MCP_TOKEN=ops_mcp_process_token",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动独立进程失败: %v", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	lines := []string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_topics","arguments":{"account_id":"00000000-0000-0000-0000-000000000001"}}}`,
	}
	if _, err := stdin.Write([]byte(strings.Join(lines, "\n") + "\n")); err != nil {
		t.Fatalf("写 stdin 失败: %v", err)
	}
	_ = stdin.Close()

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), maxMessageBytes)
	var responses []map[string]any
	deadline := time.Now().Add(10 * time.Second)
	for len(responses) < 2 && time.Now().Before(deadline) {
		if !scanner.Scan() {
			break
		}
		var got map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &got); err != nil {
			t.Fatalf("独立进程输出不是 JSON: %v\n%s\nstderr=%s", err, scanner.Text(), stderr.String())
		}
		responses = append(responses, got)
	}
	if len(responses) != 2 {
		t.Fatalf("收到 %d 条响应，期望 2\nstderr=%s", len(responses), stderr.String())
	}
	if responses[0]["result"].(map[string]any)["serverInfo"].(map[string]any)["name"] != serverName {
		t.Fatalf("initialize 响应错误: %+v", responses[0])
	}
	call := responses[1]["result"].(map[string]any)
	if call["isError"] != false {
		t.Fatalf("tools/call 响应错误: %+v", call)
	}
	if gotAuth != "Bearer ops_mcp_process_token" {
		t.Fatalf("独立进程未带 Bearer，Authorization=%q", gotAuth)
	}
	if strings.Contains(stderr.String(), "ops_mcp_process_token") {
		t.Fatal("stderr 泄漏 token")
	}
	_ = cmd.Wait()
}
