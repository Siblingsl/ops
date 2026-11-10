package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

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
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Transport        string          `json:"transport"`
	Command          string          `json:"command,omitempty"`
	Args             []string        `json:"args,omitempty"`
	Cwd              string          `json:"cwd,omitempty"`
	EnvKeys          []string        `json:"env_keys,omitempty"`
	URL              string          `json:"url,omitempty"`
	ProtocolVersion  string          `json:"protocol_version,omitempty"`
	ServerName       string          `json:"server_name,omitempty"`
	ServerVersion    string          `json:"server_version,omitempty"`
	CatalogRevision  string          `json:"catalog_revision,omitempty"`
	ToolsCatalog     json.RawMessage `json:"tools_catalog,omitempty"`
	State            string          `json:"state"`
	Revision         int64           `json:"revision"`
	LastError        string          `json:"last_error,omitempty"`
	CreatedAt        string          `json:"created_at"`
	UpdatedAt        string          `json:"updated_at"`
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
				" (id, connection_id, workspace_id, user_id, run_id, tool_name, request_id, input_hash, state)"+
				" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatched')",
				callID, connectionID, id.WorkspaceID, id.UserID, nullUUIDOrNil(body.RunID), body.ToolName, requestID, inputHash)
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
		State      string `json:"state"`
		ErrorCode  string `json:"error_code"`
		DurationMs int64  `json:"duration_ms"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
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
		if _, err := s.db.Exec(r.Context(), "UPDATE agent_plugin_call SET state=$2, error_code=COALESCE(NULLIF($3,''), ''), duration_ms=$4 WHERE id=$1",
			callID, body.State, body.ErrorCode, body.DurationMs); err != nil {
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
