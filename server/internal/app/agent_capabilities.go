package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// TL-01（docs/38 §14）：能力目录只读接口——按业务域聚合工具，供能力中心展示。
// 只返回 name/label/kind/min_role/gates/available；绝不返回 path/method/params。
// label 从工具 Description 提取首句业务化短名，缺描述的工具不展示（避免 311 条硬编码）。

type agentCapabilityTool struct {
	Name      string   `json:"name"`
	Label     string   `json:"label"`
	Kind      string   `json:"kind"`
	MinRole   string   `json:"min_role"`
	Gates     []string `json:"gates,omitempty"`
	Available bool     `json:"available"`
}

type agentCapabilityDomain struct {
	Key         string                `json:"key"`
	Label       string                `json:"label"`
	Description string                `json:"description,omitempty"`
	Tools       []agentCapabilityTool `json:"tools"`
}

// TL-05（docs/38 §14）：外部工具只读投影。只展示已启用连接中通过目录/参数 schema
// 校验、且确实会注册进模型工具目录的条目；来源只开放连接名/传输/服务器，不回传
// command/url/env 或调用入参/结果，避免秘密与业务数据经能力中心泄露。
type agentCapabilityExternalCall struct {
	State      string `json:"state"`
	ErrorCode  string `json:"error_code,omitempty"`
	DurationMS int64  `json:"duration_ms"`
	At         string `json:"at"`
}

type agentCapabilityExternalTool struct {
	ToolName        string                       `json:"tool_name"`
	Label           string                       `json:"label"`
	Kind            string                       `json:"kind"`
	MinRole         string                       `json:"min_role"`
	Permission      string                       `json:"permission"`
	Available       bool                         `json:"available"`
	ConnectionID    string                       `json:"connection_id"`
	ConnectionName  string                       `json:"connection_name"`
	Transport       string                       `json:"transport"`
	ServerName      string                       `json:"server_name,omitempty"`
	ServerVersion   string                       `json:"server_version,omitempty"`
	ProtocolVersion string                       `json:"protocol_version,omitempty"`
	CatalogRevision string                       `json:"catalog_revision,omitempty"`
	LastCall        *agentCapabilityExternalCall `json:"last_call,omitempty"`
}

type agentCapabilityExternalResult struct {
	Enabled bool                          `json:"enabled"`
	Tools   []agentCapabilityExternalTool `json:"tools"`
}

// agentCapabilityLabel 取描述第一句（到，、。/括号前）作为业务短名；空描述返回空串（不展示）。
func agentCapabilityLabel(description string) string {
	desc := strings.TrimSpace(description)
	if desc == "" {
		return ""
	}
	for _, sep := range []string{"，", "。", "；", "（", "("} {
		if i := strings.Index(desc, sep); i > 0 {
			desc = desc[:i]
			break
		}
	}
	return truncateRunes(strings.TrimSpace(desc), 24)
}

func (s *Server) getAgentCapabilities(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := requireAgentFeature("workbench_ui"); err != nil {
		return err
	}
	domains := []agentCapabilityDomain{}
	for _, domain := range agentDomains {
		entry := agentCapabilityDomain{Key: domain.Name, Label: domain.Name, Description: domain.Desc, Tools: []agentCapabilityTool{}}
		for i := range agentCatalog() {
			tool := &agentCatalogList[i]
			if tool.Domain != domain.Name || tool.Name == "" || strings.Contains(tool.Name, "plugin_") {
				continue
			}
			label := agentCapabilityLabel(tool.Description)
			if label == "" {
				continue
			}
			gates := []string{}
			if tool.Gate != "" {
				gates = append(gates, tool.Gate)
			}
			if tool.SecondConfirm != nil {
				gates = append(gates, "second_confirm")
			}
			entry.Tools = append(entry.Tools, agentCapabilityTool{
				Name:      tool.Name,
				Label:     label,
				Kind:      string(tool.Kind),
				MinRole:   string(tool.MinRole),
				Gates:     gates,
				Available: agentToolVisible(tool, id) && agentMetaFeatureAllowed(nil, tool),
			})
		}
		if len(entry.Tools) > 0 {
			domains = append(domains, entry)
		}
	}
	external, err := s.agentCapabilityExternalTools(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"domains":        domains,
		"external_tools": external,
	})
}

// agentCapabilityExternalTools 返回 TL-05 外部工具区。plugin_mcp 默认关闭：
// 关闭时 enabled=false 且 tools 不出现，能力中心不渲染该区。
func (s *Server) agentCapabilityExternalTools(ctx context.Context, id *identity) (agentCapabilityExternalResult, error) {
	if id == nil {
		return agentCapabilityExternalResult{}, errUnauthenticated
	}
	if !s.agentWorkbenchFeatures(ctx)["plugin_mcp"] {
		return agentCapabilityExternalResult{Enabled: false, Tools: []agentCapabilityExternalTool{}}, nil
	}
	result := agentCapabilityExternalResult{Enabled: true, Tools: []agentCapabilityExternalTool{}}
	recent, err := s.agentPluginRecentCalls(ctx, id)
	if err != nil {
		return result, err
	}
	rows, err := s.db.Query(ctx, `SELECT id::text, name, transport, server_name, server_version,
		protocol_version, catalog_revision, tools_catalog
		FROM agent_plugin_connection
		WHERE user_id=$1 AND workspace_id=$2 AND state='enabled' AND jsonb_typeof(tools_catalog)='array'
		ORDER BY updated_at DESC LIMIT 10`, id.UserID, id.WorkspaceID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var connectionID, name, transport, serverName, serverVersion, protocolVersion, catalogRevision string
		var catalogJSON json.RawMessage
		if err := rows.Scan(&connectionID, &name, &transport, &serverName, &serverVersion,
			&protocolVersion, &catalogRevision, &catalogJSON); err != nil {
			return result, err
		}
		var catalogTools []McpCatalogTool
		if err := json.Unmarshal(catalogJSON, &catalogTools); err != nil {
			// 损坏目录不展示、也不注册；能力中心不能假装它是可用工具。
			continue
		}
		short := sanitizeToolSegment(name)
		for i, ct := range catalogTools {
			if i >= 50 || ct.Name == "" {
				continue
			}
			modelName := fmt.Sprintf("mcp__%s__%s", short, ct.Name)
			if len(modelName) > 128 {
				continue
			}
			// 与动态目录注册同一道 schema 门：不支持的基础子集会跳过注册，
			// 这里也不能把它列为“可用外部工具”。
			if _, err := mcpInputSchemaParams(ct.InputSchema); err != nil {
				continue
			}
			tool := &AgentTool{Name: modelName, Kind: toolG, Method: "POST", MinRole: roleEditor}
			permission := "编辑及以上 · 结果仅生成，业务写入仍需逐卡确认"
			if id.Role == "viewer" {
				permission = "观察者可查看，不可调用"
			}
			entry := agentCapabilityExternalTool{
				ToolName:        ct.Name,
				Label:           ct.Name,
				Kind:            string(toolG),
				MinRole:         string(roleEditor),
				Permission:      permission,
				Available:       agentToolVisible(tool, id),
				ConnectionID:    connectionID,
				ConnectionName:  name,
				Transport:       transport,
				ServerName:      serverName,
				ServerVersion:   serverVersion,
				ProtocolVersion: protocolVersion,
				CatalogRevision: catalogRevision,
			}
			if call, ok := recent[connectionID+"\x00"+modelName]; ok {
				entry.LastCall = call
			} else if call, ok := recent[connectionID+"\x00"+ct.Name]; ok {
				entry.LastCall = call
			}
			result.Tools = append(result.Tools, entry)
		}
	}
	return result, rows.Err()
}

// agentPluginRecentCalls 只取每个工具最近一条调用的状态/耗时/错误码；不读取
// args_json/result_json，能力中心与审计展示都不携带入参/结果正文。
func (s *Server) agentPluginRecentCalls(ctx context.Context, id *identity) (map[string]*agentCapabilityExternalCall, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT ON (connection_id, tool_name)
		connection_id::text, tool_name, state, COALESCE(error_code,''), COALESCE(duration_ms,0),
		to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM agent_plugin_call
		WHERE user_id=$1 AND workspace_id=$2
		ORDER BY connection_id, tool_name, created_at DESC`, id.UserID, id.WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*agentCapabilityExternalCall{}
	for rows.Next() {
		var connectionID, toolName, state, errorCode, at string
		var durationMS int64
		if err := rows.Scan(&connectionID, &toolName, &state, &errorCode, &durationMS, &at); err != nil {
			return nil, err
		}
		out[connectionID+"\x00"+toolName] = &agentCapabilityExternalCall{
			State: state, ErrorCode: errorCode, DurationMS: durationMS, At: at,
		}
	}
	return out, rows.Err()
}
