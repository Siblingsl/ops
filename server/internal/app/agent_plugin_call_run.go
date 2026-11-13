package app

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// mcpPayloadLimit 与 createPluginCall / receipt 的 MaxBytesReader(128KiB) 对齐（契约 §2.2 第 1 点）。
const mcpPayloadLimit = 128 * 1024

// 脱敏规则与桌面 mcp-host.ts:76-77 同形（契约 §2.2 第 2 点）：
// Bearer 头、sk-/ghp/gho/xox 形状令牌、token=/key=/secret= 键值。
var (
	mcpBearerPattern   = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9\-._~+/=]{8,}`)
	mcpTokenShape      = regexp.MustCompile(`(?:sk|ghp|gho|xox)[A-Za-z0-9_-]{8,}`)
	mcpKeyValuePattern = regexp.MustCompile(`(?i)(token|key|secret|password|authorization)\s*[=:]\s*[^\s,;]+`)
	// 敏感键整值遮罩（键名大小写不敏感）；命中即不落明文。
	mcpSensitiveKey = regexp.MustCompile(`(?i)(token|secret|password|passwd|authorization|api[-_]?key|access[-_]?key|private[-_]?key|credential|cookie|env_values?)`)
)

// redactMCPJSON 返回脱敏后的 JSON 快照；超过 128KiB 的不落明文，只记截断摘要。
// 非 JSON 输入（理论上不会出现）原样返回，避免把二进制写进账本。
func redactMCPJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	out, err := json.Marshal(redactMCPValue("", v))
	if err != nil {
		return raw
	}
	if len(out) > mcpPayloadLimit {
		limited, _ := json.Marshal(map[string]any{"truncated": true, "stored_bytes": len(out)})
		return limited
	}
	return out
}

func redactMCPValue(key string, v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if mcpSensitiveKey.MatchString(k) {
				switch val.(type) {
				case string, float64, bool, json.Number:
					out[k] = "[REDACTED]"
					continue
				}
			}
			out[k] = redactMCPValue(k, val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i := range x {
			out[i] = redactMCPValue(key, x[i])
		}
		return out
	case string:
		s := mcpBearerPattern.ReplaceAllString(x, "Bearer [REDACTED]")
		s = mcpTokenShape.ReplaceAllString(s, "[REDACTED]")
		s = mcpKeyValuePattern.ReplaceAllString(s, "$1=[REDACTED]")
		return s
	default:
		return v
	}
}

// waitForMCPCall：登记后轮询等待终态（契约 §2.3 第 1 点，逐行对齐 waitForBrowserCommand）。
// 499 → 账本留 dispatched，sweep 兜底；超 deadline+2s 由 sweep 转 unknown_outcome，不重放。
func (s *Server) waitForMCPCall(r *http.Request, w http.ResponseWriter, callID uuid.UUID) error {
	deadline := s.now().Add(pluginCallWaitBudget)
	for {
		if r.Context().Err() != nil {
			return apiErr(499, "mcp_wait_cancelled", "任务已取消，停止等待 MCP 调用回执")
		}
		var state string
		var connState string
		var result json.RawMessage
		var errorCode string
		var createdAt time.Time
		err := s.db.QueryRow(r.Context(), `
			SELECT c.state, COALESCE(conn.state,''), COALESCE(c.result_json, 'null'::jsonb), COALESCE(c.error_code,''), c.created_at
			FROM agent_plugin_call c
			LEFT JOIN agent_plugin_connection conn ON conn.id = c.connection_id
			WHERE c.id=$1`, callID).Scan(&state, &connState, &result, &errorCode, &createdAt)
		if err != nil {
			return err
		}
		// 契约 §2.5 第 3 点：disable / revoke 立即停止新派发、取消在途请求。
		// 连接被停用或删除后，等待方不能继续挂到 35s 预算；账本转 cancelled 且不重放。
		if state != "succeeded" && state != "failed" && state != "unknown_outcome" && connState != "enabled" {
			if _, err := s.db.Exec(r.Context(), `
				UPDATE agent_plugin_call SET state='cancelled', error_code='plugin_not_enabled'
				WHERE id=$1 AND state='dispatched'`, callID); err != nil {
				return err
			}
			return apiErr(409, "plugin_not_enabled", "连接已停用或撤销，调用已取消且不会重放")
		}
		if state == "succeeded" || state == "failed" || state == "unknown_outcome" {
			v, err := scanPluginCall(s.db.QueryRow(r.Context(), `SELECT `+pluginCallColumns+` FROM agent_plugin_call c WHERE c.id=$1`, callID))
			if err != nil {
				return err
			}
			if len(result) > 0 && string(result) != "null" {
				v.Result = result
			}
			return ok(w, v)
		}
		// dispatched 超等待预算+2s（账本无 deadline 列，按 created_at 计）：
		// sweep 转 unknown_outcome（不重放、不显示为已撤回）。
		if s.now().After(createdAt.Add(pluginCallWaitBudget + 2*time.Second)) {
			s.sweepAgentPluginCalls(r.Context())
		}
		if s.now().After(deadline) {
			// 预算耗尽：如实返回当前非终态（dispatched=执行未回执）。
			v, err := scanPluginCall(s.db.QueryRow(r.Context(), `SELECT `+pluginCallColumns+` FROM agent_plugin_call c WHERE c.id=$1`, callID))
			if err != nil {
				return err
			}
			return ok(w, v)
		}
		select {
		case <-r.Context().Done():
			return apiErr(499, "mcp_wait_cancelled", "任务已取消，停止等待 MCP 调用回执")
		case <-time.After(pluginCallWaitPoll):
		}
	}
}

// sweepAgentPluginCalls：把 dispatched 超过等待预算（+2s 时钟误差）的调用转 unknown_outcome
// （契约 §2.3：连接失联/进程崩溃对应 unknown_outcome，不重放）。
func (s *Server) sweepAgentPluginCalls(ctx context.Context) {
	if _, err := s.db.Exec(ctx, `
		UPDATE agent_plugin_call SET state='unknown_outcome', error_code='mcp_wait_timeout'
		WHERE state='dispatched' AND created_at < $1`,
		s.now().Add(-(pluginCallWaitBudget + 2*time.Second))); err != nil {
		return
	}
}

// pluginCallColumns / scanPluginCall / pluginCallView：调用账本视图（含 CF-DESK-03 新列）。
const pluginCallColumns = "c.id::text, c.connection_id::text, c.workspace_id::text, c.user_id::text," +
	" COALESCE(c.run_id::text,''), c.tool_name, c.request_id::text, c.input_hash, c.state," +
	" c.error_code, COALESCE(c.duration_ms,0), c.created_at, c.input_schema_hash, c.catalog_revision, c.protocol_version, c.result_hash"

type pluginCallView struct {
	ID              string          `json:"id"`
	ConnectionID    string          `json:"connection_id"`
	WorkspaceID     string          `json:"workspace_id"`
	UserID          string          `json:"user_id"`
	RunID           string          `json:"run_id"`
	ToolName        string          `json:"tool_name"`
	RequestID       string          `json:"request_id"`
	InputHash       string          `json:"input_hash"`
	State           string          `json:"state"`
	ErrorCode       string          `json:"error_code"`
	DurationMs      int64           `json:"duration_ms"`
	CreatedAt       time.Time       `json:"created_at"`
	InputSchemaHash string          `json:"input_schema_hash"`
	CatalogRevision string          `json:"catalog_revision"`
	ProtocolVersion string          `json:"protocol_version"`
	ResultHash      string          `json:"result_hash"`
	Result          json.RawMessage `json:"result,omitempty"`
}

func scanPluginCall(row pgx.Row) (pluginCallView, error) {
	var v pluginCallView
	var createdAt time.Time
	err := row.Scan(&v.ID, &v.ConnectionID, &v.WorkspaceID, &v.UserID, &v.RunID, &v.ToolName,
		&v.RequestID, &v.InputHash, &v.State, &v.ErrorCode, &v.DurationMs, &createdAt,
		&v.InputSchemaHash, &v.CatalogRevision, &v.ProtocolVersion, &v.ResultHash)
	v.CreatedAt = createdAt
	return v, err
}
