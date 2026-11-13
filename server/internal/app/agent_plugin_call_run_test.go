package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CF-DESK-03（90 D-186 已批准）定向测试：T-AI27-P05～P08 四组。
// 不 mock 端到端：全部走真实路由 + 真实账本；桌面 mcp-host 的 mock stdio tools/call
// 由 desktop/test/mcp-host.test.cjs 覆盖（真传输层另列，见 34 §5 验收「真服务器验收另列」）。

func w14RunSetup(t *testing.T, name string, catalog []map[string]any) (pluginConnection, uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "plugin_mcp")
	var conn pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections", map[string]any{
		"name": name, "transport": "stdio", "command": "node", "args": []string{"mock.js"},
		"cwd": "F:\\code\\project\\OPS\\.tmp", "env_keys": []string{"MCP_TOKEN"},
	}, &conn)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision,
		"protocol_version": "2025-06-18", "server_name": name, "server_version": "0.1.0",
		"catalog_revision": "rev-cfdesk03", "tools_catalog": catalog,
	}, &conn)
	sess, ws, user := env.agentSession(t)
	return conn, sess, ws, user
}

func w14DynamicTools(t *testing.T, ws, user uuid.UUID) []AgentTool {
	t.Helper()
	tools := env.srv.agentMCPDynamicToolsForWorkspace(context.Background(), ws, user)
	if len(tools) == 0 {
		t.Fatal("已启用连接应生成动态工具目录")
	}
	return tools
}

func w14FindTool(t *testing.T, tools []AgentTool, fullName string) AgentTool {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == fullName {
			return tool
		}
	}
	t.Fatalf("目录中没有工具 %q：%+v", fullName, tools)
	return AgentTool{}
}

type w14DispatchOutcome struct {
	res *agentDispatchResult
	err error
}

func w14DispatchAsync(ctx context.Context, tool AgentTool, principal agentPrincipal, args map[string]any) <-chan w14DispatchOutcome {
	done := make(chan w14DispatchOutcome, 1)
	req := agentDispatchRequest{Principal: principal, Tool: &tool, Args: args, Timeout: 50 * time.Second}
	go func() {
		res, err := env.srv.dispatchAgentTool(ctx, req)
		done <- w14DispatchOutcome{res: res, err: err}
	}()
	return done
}

func w14WaitLedgerRow(t *testing.T, runID uuid.UUID) (string, string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var callID, argsJSON string
		err := env.srv.db.QueryRow(context.Background(),
			`SELECT id::text, COALESCE(args_json::text,'') FROM agent_plugin_call WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1`,
			runID).Scan(&callID, &argsJSON)
		if err == nil {
			return callID, argsJSON
		}
		if err != nil && err != pgx.ErrNoRows {
			t.Fatalf("读取调用账本失败：%v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("等待调用账本行超时")
	return "", ""
}

func w14NewPrincipal(t *testing.T, sess, ws, user uuid.UUID) agentPrincipal {
	t.Helper()
	var conv uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO agent_conversation(workspace_id,user_id) VALUES($1,$2) RETURNING id`, ws, user).Scan(&conv); err != nil {
		t.Fatalf("创建测试会话失败：%v", err)
	}
	return agentPrincipal{SessionID: sess, WorkspaceID: ws, UserID: user, ConversationID: conv, RunID: uuid.New()}
}

func w14AwaitOutcome(t *testing.T, done <-chan w14DispatchOutcome) *agentDispatchResult {
	t.Helper()
	select {
	case out := <-done:
		if out.err != nil {
			t.Fatalf("分发返回错误：%v", out.err)
		}
		return out.res
	case <-time.After(40 * time.Second):
		t.Fatal("等待分发结果超时")
		return nil
	}
}

func w14ResultError(t *testing.T, res *agentDispatchResult) (string, string) {
	t.Helper()
	var envelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.Raw, &envelope); err != nil {
		t.Fatalf("失败结果不是 JSON：%v (%s)", err, res.Raw)
	}
	return envelope.Error.Code, envelope.Error.Message
}

// T-AI27-P05：路由登记 / 动态工具 Path 指向新入口 / GET 仍只读 / 非 run 上下文拒绝。
func TestW1403P05RunMCPCallRouteAndCatalog(t *testing.T) {
	conn, _, ws, user := w14RunSetup(t, "CFDESK03 P05 Route", []map[string]any{
		{"name": "echo", "description_hash": "aa", "input_schema": map[string]any{
			"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}, "required": []string{"text"},
		}},
	})
	tools := w14DynamicTools(t, ws, user)
	tool := w14FindTool(t, tools, "mcp__CFDESK03P05R__echo")
	if tool.Method != "POST" || tool.Path != "/tools/mcp/calls" {
		t.Fatalf("动态工具应指向 POST /tools/mcp/calls：%s %s", tool.Method, tool.Path)
	}
	if tool.Kind != toolG {
		t.Fatalf("MCP 工具必须是 toolG（结果供确认，不直接写业务数据）：%v", tool.Kind)
	}
	if len(tool.Params) != 1 || tool.Params[0].Name != "text" || !tool.Params[0].Required {
		t.Fatalf("input_schema 未映射为 Params：%+v", tool.Params)
	}

	// GET /tools/mcp/connections 保持只读列连接语义（不是调用入口）。
	var list struct {
		Connections []pluginConnection `json:"connections"`
	}
	env.mustJSON(t, "GET", "/api/v1/tools/mcp/connections", nil, &list)
	if len(list.Connections) != 1 || list.Connections[0].ID != conn.ID {
		t.Fatalf("GET 连接列表异常：%+v", list.Connections)
	}
	if st, _ := env.do("POST", "/api/v1/tools/mcp/connections", map[string]any{"connection_id": conn.ID}); st != 405 {
		t.Fatalf("旧路径 POST 不应存在，got %d", st)
	}

	// 非会话 run 上下文（普通 HTTP 调用）不得冒充工具调用。
	env.expectErr(t, "POST", "/api/v1/tools/mcp/calls", map[string]any{
		"tool_name": tool.Name, "args": map[string]any{"text": "x"},
	}, "validation_failed")
}

// T-AI27-P06：args/result 脱敏落账本、input_hash 语义不变、request_id 幂等、回执异结果 409。
func TestW1403P06LedgerRedactionAndIdempotency(t *testing.T) {
	_, sess, ws, user := w14RunSetup(t, "CFDESK03 P06 Ledger", []map[string]any{
		{"name": "echo", "description_hash": "aa", "input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text":  map[string]any{"type": "string"},
				"count": map[string]any{"type": "number"},
			},
			"required": []string{"text"}, "additionalProperties": false,
		}},
	})
	tool := w14FindTool(t, w14DynamicTools(t, ws, user), "mcp__CFDESK03P06L__echo")
	principal := w14NewPrincipal(t, sess, ws, user)
	args := map[string]any{"text": "Bearer sk-abcdefgh12345678", "count": 2}
	done := w14DispatchAsync(context.Background(), tool, principal, args)
	callID, storedArgs := w14WaitLedgerRow(t, principal.RunID)
	if strings.Contains(storedArgs, "sk-abcdefgh") || !strings.Contains(storedArgs, "[REDACTED]") {
		t.Fatalf("入参未脱敏落账：%s", storedArgs)
	}

	rawArgs, _ := json.Marshal(args)
	sum := sha256.Sum256(append([]byte(tool.Name+"."), rawArgs...))
	wantHash := hex.EncodeToString(sum[:])
	var inputHash string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT input_hash FROM agent_plugin_call WHERE id=$1`, callID).Scan(&inputHash); err != nil {
		t.Fatal(err)
	}
	if inputHash != wantHash {
		t.Fatalf("input_hash 语义被改变：%s vs %s", inputHash, wantHash)
	}

	var receipt map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls/"+callID+"/receipt", map[string]any{
		"state": "succeeded", "duration_ms": 12,
		"result": map[string]any{"echo": "ok", "token": "ghp_abcdefgh12345678"},
	}, &receipt)
	res := w14AwaitOutcome(t, done)
	if res.Status != 200 || strings.Contains(string(res.Raw), "ghp_abcdefgh") ||
		(!strings.Contains(string(res.Raw), "[REDACTED]") && !strings.Contains(string(res.Raw), "已隐藏")) {
		t.Fatalf("回执结果未脱敏：%d %s", res.Status, res.Raw)
	}
	var storedResult, resultHash string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT COALESCE(result_json::text,''), result_hash FROM agent_plugin_call WHERE id=$1`, callID).Scan(&storedResult, &resultHash); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(storedResult, "ghp_abcdefgh") || !strings.Contains(storedResult, "[REDACTED]") {
		t.Fatalf("result_json 未脱敏：%s", storedResult)
	}
	// jsonb 落库会重排键；按规范 JSON（解析后重新序列化）核对哈希，而不是比对文本字节序。
	var canonical any
	if err := json.Unmarshal([]byte(storedResult), &canonical); err != nil {
		t.Fatalf("result_json 不是合法 JSON：%v", err)
	}
	canonicalJSON, _ := json.Marshal(canonical)
	resSum := sha256.Sum256(canonicalJSON)
	if resultHash != hex.EncodeToString(resSum[:]) {
		t.Fatalf("result_hash 与脱敏快照不一致：%s vs %s", resultHash, hex.EncodeToString(resSum[:]))
	}
	// 迟到异结果 409（终态幂等由既有 W14 用例覆盖）。
	env.expectErr(t, "POST", "/api/v1/agent/plugin-calls/"+callID+"/receipt", map[string]any{
		"state": "failed", "error_code": "late",
	}, "plugin_receipt_conflict")

	// 管理侧入口同一脱敏规则：同 request_id 幂等且只剩脱敏快照。
	conn := w14EnabledConnectionFor(t)
	requestID := uuid.NewString()
	var first, second struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": requestID, "tool_name": "echo",
		"args": map[string]any{"text": "token=abcdefgh12345678"},
	}, &first)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls", map[string]any{
		"connection_id": conn.ID, "request_id": requestID, "tool_name": "echo",
		"args": map[string]any{"text": "token=abcdefgh12345678"},
	}, &second)
	if first.ID != second.ID {
		t.Fatalf("同 request_id 应幂等：%s vs %s", first.ID, second.ID)
	}
	var mgmtArgs string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT COALESCE(args_json::text,'') FROM agent_plugin_call WHERE id=$1`, first.ID).Scan(&mgmtArgs); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(mgmtArgs, "abcdefgh") || !strings.Contains(mgmtArgs, "[REDACTED]") {
		t.Fatalf("管理侧入参未脱敏：%s", mgmtArgs)
	}
}

// w14EnabledConnectionFor 返回当前会话已启用连接（供管理侧入口测试复用目录）。
func w14EnabledConnectionFor(t *testing.T) pluginConnection {
	t.Helper()
	var conn pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections", map[string]any{
		"name": "CFDESK03 P06 Mgmt", "transport": "stdio", "command": "node", "args": []string{"mock.js"},
		"cwd": "F:\\code\\project\\OPS\\.tmp", "env_keys": []string{"MCP_TOKEN"},
	}, &conn)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "enable", "expected_revision": conn.Revision,
		"protocol_version": "2025-06-18", "server_name": "p06", "server_version": "0.1.0",
		"catalog_revision": "rev-p06", "tools_catalog": []map[string]any{
			{"name": "echo", "description_hash": "aa", "input_schema": map[string]any{}},
		},
	}, &conn)
	return conn
}

// T-AI27-P07：同步等待四路（成功/失败/取消 499/超时 unknown_outcome）+ 不重放。
func TestW1403P07WaitFourPaths(t *testing.T) {
	_, sess, ws, user := w14RunSetup(t, "CFDESK03 P07 Wait", []map[string]any{
		{"name": "echo", "description_hash": "aa", "input_schema": map[string]any{}},
	})
	tool := w14FindTool(t, w14DynamicTools(t, ws, user), "mcp__CFDESK03P07W__echo")

	// 失败终态：回执 failed → 等待方拿到 failed，不显示为成功。
	principal := w14NewPrincipal(t, sess, ws, user)
	done := w14DispatchAsync(context.Background(), tool, principal, map[string]any{})
	callID, _ := w14WaitLedgerRow(t, principal.RunID)
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-calls/"+callID+"/receipt", map[string]any{
		"state": "failed", "error_code": "mcp_tool_error", "duration_ms": 7,
	}, nil)
	res := w14AwaitOutcome(t, done)
	var view pluginCallView
	if err := json.Unmarshal(res.Raw, &view); err != nil {
		t.Fatalf("失败结果解析：%v (%s)", err, res.Raw)
	}
	if res.Status != 200 || view.State != "failed" || view.ErrorCode != "mcp_tool_error" {
		t.Fatalf("失败终态异常：%d %+v", res.Status, view)
	}

	// 取消：run ctx 取消 → 499 mcp_wait_cancelled，账本留 dispatched（sweep 兜底）。
	ctx, cancel := context.WithCancel(context.Background())
	p2 := w14NewPrincipal(t, sess, ws, user)
	done2 := w14DispatchAsync(ctx, tool, p2, map[string]any{})
	w14WaitLedgerRow(t, p2.RunID)
	cancel()
	res2 := w14AwaitOutcome(t, done2)
	code, _ := w14ResultError(t, res2)
	if res2.Status != 499 || code != "mcp_wait_cancelled" {
		t.Fatalf("取消应 499 mcp_wait_cancelled：%d %s", res2.Status, res2.Raw)
	}
	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM agent_plugin_call WHERE run_id=$1`, p2.RunID).Scan(&state); err != nil || state != "dispatched" {
		t.Fatalf("取消后账本应留 dispatched：%s %v", state, err)
	}

	// 超时：created_at 早于预算+2s 的 dispatched 由 sweep 转 unknown_outcome，不重放。
	conn := w14EnabledConnectionFor(t)
	oldID := uuid.New()
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_plugin_call (id, connection_id, workspace_id, user_id, tool_name, request_id, input_hash, state, created_at)
		VALUES ($1,$2,$3,$4,'echo',$5,'hash','dispatched', now() - interval '40 seconds')`,
		oldID, conn.ID, ws, user, uuid.New()); err != nil {
		t.Fatal(err)
	}
	env.srv.sweepAgentPluginCalls(context.Background())
	var sweptState, sweptErr string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state, error_code FROM agent_plugin_call WHERE id=$1`, oldID).Scan(&sweptState, &sweptErr); err != nil {
		t.Fatal(err)
	}
	if sweptState != "unknown_outcome" || sweptErr != "mcp_wait_timeout" {
		t.Fatalf("超时应 unknown_outcome/mcp_wait_timeout：%s/%s", sweptState, sweptErr)
	}
}

// T-AI27-P08：schema→Params 基础子集、不支持 schema 跳过、目录变更失效、撤权取消在途。
func TestW1403P08SchemaParamsAndCatalogChanges(t *testing.T) {
	// 基础子集：5 种类型 + required 逐项映射。
	conn, sess, ws, user := w14RunSetup(t, "CFDESK03 P08 Schema", []map[string]any{
		{"name": "echo", "description_hash": "aa", "input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text":   map[string]any{"type": "string"},
				"count":  map[string]any{"type": "number"},
				"flag":   map[string]any{"type": "boolean"},
				"items":  map[string]any{"type": "array"},
				"struct": map[string]any{"type": "object"},
			},
			"required": []string{"text"},
		}},
		// 不支持的 schema：$ref / union / additionalProperties:true / 顶层数组 → 该工具跳过注册。
		{"name": "ref_tool", "description_hash": "bb", "input_schema": map[string]any{
			"type": "object", "properties": map[string]any{"x": map[string]any{"$ref": "#/definitions/x"}},
		}},
		{"name": "union_tool", "description_hash": "cc", "input_schema": map[string]any{
			"type": "object", "properties": map[string]any{"x": map[string]any{"anyOf": []any{map[string]any{"type": "string"}}}},
		}},
		{"name": "open_tool", "description_hash": "dd", "input_schema": map[string]any{
			"type": "object", "properties": map[string]any{"x": map[string]any{"type": "string"}}, "additionalProperties": true,
		}},
		{"name": "top_array_tool", "description_hash": "ee", "input_schema": map[string]any{
			"type": "array", "items": map[string]any{"type": "string"},
		}},
	})
	tools := w14DynamicTools(t, ws, user)
	tool := w14FindTool(t, tools, "mcp__CFDESK03P08S__echo")
	if len(tool.Params) != 5 {
		t.Fatalf("基础子集映射数量错误：%+v", tool.Params)
	}
	for _, p := range tool.Params {
		if p.In != "body" {
			t.Fatalf("MCP 参数应走 body：%+v", p)
		}
		if p.Name == "text" && !p.Required {
			t.Fatalf("required 未映射：%+v", p)
		}
		if p.Name != "text" && p.Required {
			t.Fatalf("非必填参数被标 required：%+v", p)
		}
	}
	for _, skipped := range []string{"__ref_tool", "__union_tool", "__open_tool", "__top_array_tool"} {
		for _, got := range tools {
			if strings.HasSuffix(got.Name, skipped) {
				t.Fatalf("不支持的 schema 不应注册：%s", got.Name)
			}
		}
	}

	// 撤权取消在途：dispatch 后停用连接，等待方 409 plugin_not_enabled 且账本 cancelled。
	principal := w14NewPrincipal(t, sess, ws, user)
	done := w14DispatchAsync(context.Background(), tool, principal, map[string]any{"text": "x"})
	w14WaitLedgerRow(t, principal.RunID)
	var disabled pluginConnection
	env.mustJSON(t, "POST", "/api/v1/agent/plugin-connections/"+conn.ID+"/actions", map[string]any{
		"action": "disable", "expected_revision": conn.Revision,
	}, &disabled)
	res := w14AwaitOutcome(t, done)
	code, _ := w14ResultError(t, res)
	if res.Status != 409 || code != "plugin_not_enabled" {
		t.Fatalf("撤权应取消在途：%d %s", res.Status, res.Raw)
	}
	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM agent_plugin_call WHERE run_id=$1`, principal.RunID).Scan(&state); err != nil || state != "cancelled" {
		t.Fatalf("在途取消后账本应 cancelled：%s %v", state, err)
	}

	// 目录消失后旧工具 dispatch：404，不派发、不越权。
	principal2 := w14NewPrincipal(t, sess, ws, user)
	res2 := w14AwaitOutcome(t, w14DispatchAsync(context.Background(), tool, principal2, map[string]any{"text": "x"}))
	if res2.Status != 404 {
		t.Fatalf("目录变更后旧工具应 404：%d %s", res2.Status, res2.Raw)
	}
}
