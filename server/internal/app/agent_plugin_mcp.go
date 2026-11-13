package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-14（W14）：插件/MCP 连接注册、状态机与调用回执（27 文档 §11.2）。
// 边界（27 §11.2.3/§11.7）：readOnly 声明不自动授权；OPS 业务写入仍走原逐张卡片；
// 插件不得绕过 W/H/X 与 HC 红线；秘密值不入库不进回执（只存 env 键名清单）；
// 安装与启用分离（创建=draft，enable 显式操作）；无批量执行端点。
// 状态机：draft → ready_disabled → enabled ⇄ disabled；revoke → revoked（终态）。

type pluginConnection struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Transport       string          `json:"transport"`
	Command         string          `json:"command,omitempty"`
	Args            []string        `json:"args,omitempty"`
	Cwd             string          `json:"cwd,omitempty"`
	EnvKeys         []string        `json:"env_keys,omitempty"`
	URL             string          `json:"url,omitempty"`
	ProtocolVersion string          `json:"protocol_version,omitempty"`
	ServerName      string          `json:"server_name,omitempty"`
	ServerVersion   string          `json:"server_version,omitempty"`
	CatalogRevision string          `json:"catalog_revision,omitempty"`
	ToolsCatalog    json.RawMessage `json:"tools_catalog,omitempty"`
	State           string          `json:"state"`
	Revision        int64           `json:"revision"`
	LastError       string          `json:"last_error,omitempty"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
}

const pluginConnectionColumnsPlain = "id::text, name, transport, command, args, cwd, env_keys, url," +
	" protocol_version, server_name, server_version, catalog_revision, tools_catalog," +
	" state, revision, last_error," +
	" to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')," +
	" to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"

const pluginConnectionColumns = "c.id::text, c.name, c.transport, c.command, c.args, c.cwd, c.env_keys, c.url," +
	" c.protocol_version, c.server_name, c.server_version, c.catalog_revision, c.tools_catalog," +
	" c.state, c.revision, c.last_error," +
	" to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')," +
	" to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"

func scanPluginConnection(row pgx.Row) (pluginConnection, error) {
	var v pluginConnection
	err := row.Scan(&v.ID, &v.Name, &v.Transport, &v.Command, &v.Args, &v.Cwd, &v.EnvKeys, &v.URL,
		&v.ProtocolVersion, &v.ServerName, &v.ServerVersion, &v.CatalogRevision, &v.ToolsCatalog,
		&v.State, &v.Revision, &v.LastError, &v.CreatedAt, &v.UpdatedAt)
	return v, err
}

func (s *Server) pluginGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "plugin_policy_denied", "代访问期间不能管理插件连接")
	}
	if id.Role == "viewer" {
		return apiErr(403, "plugin_policy_denied", "观察者角色未开放插件管理")
	}
	return nil
}

// GET /agent/plugin-connections
func (s *Server) listPluginConnections(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), "SELECT "+pluginConnectionColumns+" FROM agent_plugin_connection c"+
		" WHERE c.user_id=$1 AND c.workspace_id=$2 AND c.state <> 'revoked'"+
		" ORDER BY c.updated_at DESC LIMIT 100", id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	connections := []pluginConnection{}
	for rows.Next() {
		v, err := scanPluginConnection(rows)
		if err != nil {
			return err
		}
		connections = append(connections, v)
	}
	return ok(w, map[string]any{"connections": connections})
}

// POST /agent/plugin-connections：创建 draft（安装与启用分离，27 §11.2.1）。
func (s *Server) createPluginConnection(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	var body struct {
		Name      string   `json:"name"`
		Transport string   `json:"transport"`
		Command   string   `json:"command"`
		Args      []string `json:"args"`
		Cwd       string   `json:"cwd"`
		EnvKeys   []string `json:"env_keys"`
		URL       string   `json:"url"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.EnvKeys == nil {
		body.EnvKeys = []string{}
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len([]rune(body.Name)) > 64 {
		return apiErr(422, "validation_failed", "连接名需 1～64 字")
	}
	if body.Transport != "stdio" && body.Transport != "http" {
		return apiErr(422, "validation_failed", "transport 只能是 stdio 或 http")
	}
	if body.Transport == "stdio" && strings.TrimSpace(body.Command) == "" {
		return apiErr(422, "validation_failed", "stdio 连接必须提供 command")
	}
	if body.Transport == "http" {
		body.URL = strings.TrimSpace(body.URL)
		// 27 §11.2.2：默认 HTTPS；本机开发明文 HTTP 须显式标注，不自动放行任意内网。
		if !strings.HasPrefix(body.URL, "https://") {
			return apiErr(422, "validation_failed", "http 传输要求 https:// 地址（本机开发明文连接另行显式标注）")
		}
	}
	envKeyPattern := regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	for _, key := range body.EnvKeys {
		if !envKeyPattern.MatchString(key) {
			return apiErr(422, "validation_failed", "环境变量键名非法："+key)
		}
	}
	connectionID := uuid.New()
	var created pluginConnection
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), "INSERT INTO agent_plugin_connection"+
			" (id, workspace_id, user_id, name, transport, command, args, cwd, env_keys, url, state)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft') RETURNING "+pluginConnectionColumnsPlain,
			connectionID, id.WorkspaceID, id.UserID, body.Name, body.Transport,
			strings.TrimSpace(body.Command), body.Args, strings.TrimSpace(body.Cwd), body.EnvKeys, strings.TrimSpace(body.URL))
		var err error
		created, err = scanPluginConnection(row)
		return err
	}); err != nil {
		return err
	}
	return ok(w, created)
}

// POST /agent/plugin-connections/{id}/actions：enable/disable/revoke/validate（expected_revision CAS）。
func (s *Server) actionPluginConnection(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	connectionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		Action           string          `json:"action"`
		ExpectedRevision int64           `json:"expected_revision"`
		ProtocolVersion  string          `json:"protocol_version"`
		ServerName       string          `json:"server_name"`
		ServerVersion    string          `json:"server_version"`
		CatalogRevision  string          `json:"catalog_revision"`
		ToolsCatalog     json.RawMessage `json:"tools_catalog"`
		LastError        string          `json:"last_error"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	// validate 由本机桥握手后上报目录/错误；enable/disable/revoke 为本人操作。
	transitions := map[string]map[string]string{
		"enable":   {"draft": "enabled", "ready_disabled": "enabled", "disabled": "enabled"},
		"disable":  {"enabled": "disabled", "ready_disabled": "ready_disabled"},
		"revoke":   {"draft": "revoked", "ready_disabled": "revoked", "enabled": "revoked", "disabled": "revoked", "error": "revoked"},
		"validate": {"draft": "ready_disabled", "ready_disabled": "ready_disabled", "enabled": "enabled", "disabled": "disabled", "error": "ready_disabled"},
	}
	next, allowed := transitions[body.Action]
	if !allowed {
		return apiErr(422, "validation_failed", "未知操作")
	}
	var updated pluginConnection
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var currentState string
		if err := tx.QueryRow(r.Context(), "SELECT state FROM agent_plugin_connection"+
			" WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state <> 'revoked'",
			connectionID, id.UserID, id.WorkspaceID).Scan(&currentState); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		target, reachable := next[currentState]
		if !reachable {
			return apiErr(409, "plugin_state_conflict", "当前状态不支持该操作")
		}
		// A3（宿主接线后 validate 成为真实握手结果的上报口）：失败（last_error 非空）不推进
		// 状态——"已验证"必须对应真实握手成功；失败只记 last_error，UI 如实展示，不伪造。
		validateFailure := body.Action == "validate" && strings.TrimSpace(body.LastError) != ""
		if validateFailure {
			target = currentState
		}
		// 原子 CAS：WHERE revision=$3，冲突返回零行（plugin_revision_conflict）。
		var catalogArg any
		if len(body.ToolsCatalog) > 0 {
			catalogArg = string(body.ToolsCatalog)
		}
		// validate 成功时清掉上一次失败的残留 last_error（否则旧错误永远挂在卡片上）。
		clearLastError := body.Action == "validate" && !validateFailure
		row := tx.QueryRow(r.Context(), "UPDATE agent_plugin_connection SET state=$2, revision=revision+1, updated_at=now(),"+
			" protocol_version=CASE WHEN $4<>'' THEN $4 ELSE protocol_version END,"+
			" server_name=CASE WHEN $5<>'' THEN $5 ELSE server_name END,"+
			" server_version=CASE WHEN $6<>'' THEN $6 ELSE server_version END,"+
			" catalog_revision=CASE WHEN $7<>'' THEN $7 ELSE catalog_revision END,"+
			" tools_catalog=CASE WHEN jsonb_typeof($8::jsonb)='array' THEN $8::jsonb ELSE tools_catalog END,"+
			" last_error=CASE WHEN $9<>'' THEN $9 WHEN $10 THEN '' ELSE last_error END"+
			" WHERE id=$1 AND revision=$3 RETURNING "+pluginConnectionColumnsPlain,
			connectionID, target, body.ExpectedRevision,
			body.ProtocolVersion, body.ServerName, body.ServerVersion, body.CatalogRevision,
			catalogArg, body.LastError, clearLastError)
		var err error
		updated, err = scanPluginConnection(row)
		if err == pgx.ErrNoRows {
			return apiErr(409, "plugin_revision_conflict", "连接已被修改，请刷新后重试")
		}
		return err
	}); err != nil {
		return err
	}
	return ok(w, updated)
}

// DELETE /agent/plugin-connections/{id}：撤销（终态；配置删除，调用回执随级联保留审计）。
func (s *Server) deletePluginConnection(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	connectionID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), "DELETE FROM agent_plugin_connection"+
		" WHERE id=$1 AND user_id=$2 AND workspace_id=$3", connectionID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"revoked": true})
}

// POST /agent/plugin-calls：登记调用（dispatched）。未启用连接拒绝（P03 业务旁路防线）。
func (s *Server) createPluginCall(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	var body struct {
		ConnectionID string         `json:"connection_id"`
		RunID        string         `json:"run_id"`
		RequestID    string         `json:"request_id"`
		ToolName     string         `json:"tool_name"`
		Args         map[string]any `json:"args"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	connectionID, err := uuid.Parse(body.ConnectionID)
	if err != nil {
		return apiErr(400, "bad_request", "connection_id 必须是 UUID")
	}
	requestID, err := uuid.Parse(body.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	if strings.TrimSpace(body.ToolName) == "" {
		return apiErr(422, "validation_failed", "tool_name 必填")
	}
	argsJSON, _ := json.Marshal(body.Args)
	// 契约 §2.2 第 2 点：账本只存脱敏后的入参快照；input_hash 仍按原始入参计算（幂等语义不变）。
	storedArgs := redactMCPJSON(argsJSON)
	hasher := sha256.New()
	hasher.Write(append([]byte(body.ToolName+"."), argsJSON...))
	inputHash := hex.EncodeToString(hasher.Sum(nil))
	callID := uuid.New()
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var state string
		if err := tx.QueryRow(r.Context(), "SELECT state FROM agent_plugin_connection"+
			" WHERE id=$1 AND user_id=$2 AND workspace_id=$3",
			connectionID, id.UserID, id.WorkspaceID).Scan(&state); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		if state != "enabled" {
			return apiErr(409, "plugin_not_enabled", "连接未启用，不允许调用")
		}
		var existingID uuid.UUID
		var existingState string
		err := tx.QueryRow(r.Context(), "SELECT id, state FROM agent_plugin_call"+
			" WHERE connection_id=$1 AND request_id=$2", connectionID, requestID).Scan(&existingID, &existingState)
		switch {
		case err == nil:
			callID = existingID
			return nil
		case err == pgx.ErrNoRows:
			_, err = tx.Exec(r.Context(), "INSERT INTO agent_plugin_call"+
				" (id, connection_id, workspace_id, user_id, run_id, tool_name, request_id, input_hash, state, args_json)"+
				" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched',$9)",
				callID, connectionID, id.WorkspaceID, id.UserID, nullUUIDOrNil(body.RunID), body.ToolName, requestID, inputHash, storedArgs)
			return err
		default:
			return err
		}
	}); err != nil {
		return err
	}
	return ok(w, map[string]any{"id": callID.String()})
}

// POST /agent/plugin-calls/{id}/receipt：回执（终态幂等/异结果 409，与浏览器账本同语义）。
func (s *Server) receiptPluginCall(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	callID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		State      string          `json:"state"`
		ErrorCode  string          `json:"error_code"`
		DurationMs int64           `json:"duration_ms"`
		Result     json.RawMessage `json:"result,omitempty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.State != "succeeded" && body.State != "failed" && body.State != "unknown_outcome" {
		return apiErr(422, "validation_failed", "回执状态只能是 succeeded/failed/unknown_outcome")
	}
	var currentState string
	if err := s.db.QueryRow(r.Context(), "SELECT state FROM agent_plugin_call"+
		" WHERE id=$1 AND user_id=$2 AND workspace_id=$3",
		callID, id.UserID, id.WorkspaceID).Scan(&currentState); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if currentState == "dispatched" {
		// CF-DESK-03（契约 §2.2/§2.3）：回执带脱敏 result 快照与哈希（27 §11.2.4）。
		storedResult := redactMCPJSON(body.Result)
		resultHash := ""
		if len(storedResult) > 0 && string(storedResult) != "null" {
			sum := sha256.Sum256(storedResult)
			resultHash = hex.EncodeToString(sum[:])
		}
		if _, err := s.db.Exec(r.Context(), "UPDATE agent_plugin_call SET state=$2, error_code=COALESCE(NULLIF($3,''), ''), duration_ms=$4,"+
			" result_json=$5, result_hash=$6 WHERE id=$1",
			callID, body.State, body.ErrorCode, body.DurationMs, nullJSON(storedResult), resultHash); err != nil {
			return err
		}
		return ok(w, map[string]any{"state": body.State})
	}
	if currentState == body.State {
		return ok(w, map[string]any{"state": currentState})
	}
	return apiErr(409, "plugin_receipt_conflict", "调用已有不同最终结果，迟到回执仅核对")
}

func nullUUIDOrNil(raw string) *uuid.UUID {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	id, err := uuid.Parse(trimmed)
	if err != nil {
		return nil
	}
	return &id
}

// ---- CF-DESK-03（90 D-186 已批准）：run 内 tools/call 执行链路 ----
// 对齐契约 docs/design/mcp-tools-call-contract.md §2（已批准结论：P1 新端点 /
// P2 增列 24h / P3 基础子集 / P4 维持 5 态 / P5 等待 35s）。

// pluginCallWaitBudget：run 内同步等待硬上限（对齐浏览器先例 browserCommandWaitBudget；
// D-186 P5 维持 35s，不采纳 27 的发现 15s / 调用 60s 分段）。
const pluginCallWaitBudget = 35 * time.Second

const pluginCallWaitPoll = 200 * time.Millisecond

// runPluginMCPCall 是 run 内模型调用入口（POST /tools/mcp/calls）。
// connection_id 与 tool_name 由服务端按动态目录反查绑定（契约 §2.1 第 2 点：
// 不接受模型自报连接/任意工具名，防跨连接重名与越权）。
func (s *Server) runPluginMCPCall(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "plugin_mcp"); err != nil {
		return err
	}
	principal := agentPrincipalOf(r.Context())
	if principal == nil || principal.RunID == uuid.Nil || principal.ConversationID == uuid.Nil {
		return apiErr(422, "validation_failed", "该接口只能由会话任务内的工具调用发起")
	}
	// 模型参数按 input_schema 平铺在请求体；tool_name 由目录 Fixed 注入
	//（调用方不持连接/工具句柄）。这里先拆出 tool_name，其余字段即 args。
	var body map[string]any
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	toolName, _ := body["tool_name"].(string)
	delete(body, "tool_name")
	args := body
	if !strings.HasPrefix(toolName, "mcp__") {
		return apiErr(422, "validation_failed", "tool_name 必须是 mcp__ 前缀的动态工具")
	}
	// 按动态目录反查：tool_name 必须在当前用户/工作区 enabled 连接的目录里（重查一次）。
	tool, connID, catalogRevision, protocolVersion, err := s.resolveMCPDynamicTool(r.Context(), id.UserID, id.WorkspaceID, toolName)
	if err != nil {
		return err
	}
	// 按冻结 input_schema 完整校验 args（契约 §2.4 第 2 点）；失败落 failed，不派发。
	argsJSON, _ := json.Marshal(args)
	// 契约 §2.2 第 2 点：入参快照先脱敏再落账本；input_hash 用原始入参保证幂等语义。
	storedArgs := redactMCPJSON(argsJSON)
	if err := validateMCPArgsAgainstSchema(tool.InputSchema, argsJSON); err != nil {
		callID := uuid.New()
		inputHash := mcpInputHash(toolName, argsJSON)
		if _, err := s.db.Exec(r.Context(), "INSERT INTO agent_plugin_call"+
			" (id, connection_id, workspace_id, user_id, run_id, tool_name, request_id, input_hash, state, error_code,"+
			" args_json, input_schema_hash, catalog_revision, protocol_version)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed','mcp_schema_invalid',$9,$10,$11,$12)",
			callID, connID, id.WorkspaceID, id.UserID, &principal.RunID, toolName, uuid.New(), inputHash,
			storedArgs, mcpSchemaHash(tool.InputSchema), catalogRevision, protocolVersion); err != nil {
			return err
		}
		return apiErr(422, "mcp_schema_invalid", "参数不符合工具 input_schema："+err.Error())
	}
	inputHash := mcpInputHash(toolName, argsJSON)
	requestID := uuid.New()
	callID := uuid.New()
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var state string
		if err := tx.QueryRow(r.Context(), "SELECT state FROM agent_plugin_connection"+
			" WHERE id=$1 AND user_id=$2 AND workspace_id=$3",
			connID, id.UserID, id.WorkspaceID).Scan(&state); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		if state != "enabled" {
			return apiErr(409, "plugin_not_enabled", "连接未启用，不允许调用")
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO agent_plugin_call"+
			" (id, connection_id, workspace_id, user_id, run_id, tool_name, request_id, input_hash, state,"+
			" args_json, input_schema_hash, catalog_revision, protocol_version)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched',$9,$10,$11,$12)",
			callID, connID, id.WorkspaceID, id.UserID, &principal.RunID, toolName, requestID, inputHash,
			storedArgs, mcpSchemaHash(tool.InputSchema), catalogRevision, protocolVersion)
		return err
	}); err != nil {
		return err
	}
	s.emitBrowserCommandEvent(r.Context(), principal.ConversationID, "mcp.call_requested", map[string]any{
		"call_id": callID.String(), "tool_name": toolName,
	})
	return s.waitForMCPCall(r, w, callID)
}

// resolveMCPDynamicTool 在当前 enabled 连接的目录里反查工具（契约 §2.1 第 2 点）。
func (s *Server) resolveMCPDynamicTool(ctx context.Context, userID, workspaceID uuid.UUID, toolName string) (McpCatalogTool, uuid.UUID, string, string, error) {
	rows, err := s.db.Query(ctx, `SELECT id::text, name, catalog_revision, protocol_version, tools_catalog FROM agent_plugin_connection
		WHERE user_id=$1 AND workspace_id=$2 AND state='enabled' AND jsonb_typeof(tools_catalog)='array'`, userID, workspaceID)
	if err != nil {
		return McpCatalogTool{}, uuid.Nil, "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var connID, connName, catalogRevision, protocolVersion string
		var catalogJSON json.RawMessage
		if err := rows.Scan(&connID, &connName, &catalogRevision, &protocolVersion, &catalogJSON); err != nil {
			continue
		}
		var catalogTools []McpCatalogTool
		if err := json.Unmarshal(catalogJSON, &catalogTools); err != nil {
			continue
		}
		for _, ct := range catalogTools {
			if ct.Name == "" {
				continue
			}
			if fmt.Sprintf("mcp__%s__%s", sanitizeToolSegment(connName), ct.Name) == toolName {
				return ct, uuid.MustParse(connID), catalogRevision, protocolVersion, nil
			}
		}
	}
	return McpCatalogTool{}, uuid.Nil, "", "", apiErr(404, "not_found", "工具不在当前已启用连接的目录中")
}

// mcpInputHash：保持 00092 语义 sha256(tool_name + "." + args_json)。
func mcpInputHash(toolName string, argsJSON []byte) string {
	hasher := sha256.New()
	hasher.Write(append([]byte(toolName+"."), argsJSON...))
	return hex.EncodeToString(hasher.Sum(nil))
}

// mcpSchemaHash：冻结 input_schema 的哈希（契约 §2.2 第 1 点 input_schema_hash）。
func mcpSchemaHash(raw json.RawMessage) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// validateMCPArgsAgainstSchema 按 JSON Schema 基础子集完整校验 args（契约 §2.4 第 2 点）。
func validateMCPArgsAgainstSchema(schemaRaw json.RawMessage, argsJSON []byte) error {
	if len(schemaRaw) == 0 {
		return nil
	}
	var schema struct {
		Type       string `json:"type"`
		Properties map[string]struct {
			Type string `json:"type"`
		} `json:"properties"`
		Required             []string `json:"required"`
		AdditionalProperties *bool    `json:"additionalProperties"`
	}
	if err := json.Unmarshal(schemaRaw, &schema); err != nil {
		return fmt.Errorf("input_schema 解析失败")
	}
	if schema.Type != "" && schema.Type != "object" {
		return fmt.Errorf("input_schema 顶层类型不支持")
	}
	var args map[string]any
	if len(argsJSON) > 0 {
		if err := json.Unmarshal(argsJSON, &args); err != nil {
			return fmt.Errorf("args 不是 JSON 对象")
		}
	}
	additionalAllowed := schema.AdditionalProperties != nil && *schema.AdditionalProperties
	known := map[string]bool{}
	for name := range schema.Properties {
		known[name] = true
	}
	for name := range args {
		if !known[name] && !additionalAllowed {
			return fmt.Errorf("额外字段 %q 不被工具接受", name)
		}
	}
	for _, name := range schema.Required {
		if _, ok := args[name]; !ok {
			return fmt.Errorf("缺少必填参数 %q", name)
		}
	}
	for name, prop := range schema.Properties {
		value, ok := args[name]
		if !ok {
			continue
		}
		if err := validateMCPValueAgainstType(prop.Type, value); err != nil {
			return fmt.Errorf("参数 %q：%w", name, err)
		}
	}
	return nil
}

func validateMCPValueAgainstType(typ string, value any) error {
	switch typ {
	case "string":
		if _, ok := value.(string); !ok {
			return fmt.Errorf("应为字符串")
		}
	case "number":
		if _, ok := value.(float64); !ok {
			return fmt.Errorf("应为数字")
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("应为布尔")
		}
	case "array":
		if _, ok := value.([]any); !ok {
			return fmt.Errorf("应为数组")
		}
	case "object":
		if _, ok := value.(map[string]any); !ok {
			return fmt.Errorf("应为对象")
		}
	}
	return nil
}
