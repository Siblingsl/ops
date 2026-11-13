package app

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// DEV-AI27-14（W14 第三批，深化 5/5）：MCP 动态目录进 run 工具链。
// 当 plugin_mcp 开启且有 enabled 连接时，把连接的 MCP 工具动态注册为
// `mcp__<connection_short>__<tool>` 格式的模型工具目录项。
// 工具 Kind=toolG（不直接写业务数据，结果供用户确认后采用——27 §11.2.3 readOnly 只是服务端声明）。
// dispatch 走 /tools/mcp/connections（list）+ 模型工具目录引用（dispatch 由桌面 mcp-host 执行）。
// 目录变更（catalog_revision 变化）→ 工具目录下次 agentCatalog() 缓存重建时生效。

type McpCatalogTool struct {
	Name            string          `json:"name"`
	DescriptionHash string          `json:"description_hash"`
	InputSchema     json.RawMessage `json:"input_schema,omitempty"`
	OutputSchema    json.RawMessage `json:"output_schema,omitempty"`
}

// ai27MCPDynamicTools 查询 enabled 连接的 tools_catalog，动态生成模型工具目录项。
// 每个 MCP 工具注册为 `mcp__<conn_short>__<tool_name>` 格式（前缀防跨连接重名）。
// 连接数上限 10（27 §11.2 建议值）、每连接工具数上限 50（防目录爆炸）。
func ai27MCPDynamicTools(ctx context.Context, s *Server, workspaceID, userID uuid.UUID) []AgentTool {
	if !s.agentWorkbenchFeatures(ctx)["plugin_mcp"] {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id::text, name, tools_catalog FROM agent_plugin_connection
		WHERE user_id=$1 AND workspace_id=$2 AND state='enabled' AND jsonb_typeof(tools_catalog)='array'
		ORDER BY created_at LIMIT 10`, userID, workspaceID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var tools []AgentTool
	for rows.Next() {
		var connID, connName string
		var catalogJSON json.RawMessage
		if err := rows.Scan(&connID, &connName, &catalogJSON); err != nil {
			continue
		}
		var catalogTools []McpCatalogTool
		if err := json.Unmarshal(catalogJSON, &catalogTools); err != nil {
			continue
		}
		for i, ct := range catalogTools {
			if i >= 50 {
				break
			}
			if ct.Name == "" {
				continue
			}
			// 连接名短化（防工具名过长）：取前 12 字符的安全子集。
			short := sanitizeToolSegment(connName)
			toolName := fmt.Sprintf("mcp__%s__%s", short, ct.Name)
			if len(toolName) > 128 {
				continue
			}
			// CF-DESK-03（90 D-186 P3）：input_schema→Params 只接受基础 JSON Schema 子集；
			// 不支持的 schema 明确报错并跳过该工具注册，不「看起来相似」就兼容（27 §11.2.2）。
			params, err := mcpInputSchemaParams(ct.InputSchema)
			if err != nil {
				continue
			}
			desc := fmt.Sprintf("MCP 工具（连接：%s）。结果供用户确认后采用，不直接写业务数据。", connName)
			tools = append(tools, AgentTool{
				Name:        toolName,
				Domain:      "mcp",
				Kind:        toolG,
				Method:      "POST",
				Path:        "/tools/mcp/calls",
				Params:      params,
				Fixed:       map[string]any{"tool_name": toolName},
				Description: desc,
				MinRole:     roleEditor,
			})
		}
	}
	return tools
}

func sanitizeToolSegment(name string) string {
	var out []byte
	for _, b := range []byte(name) {
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_' || b == '-' {
			out = append(out, b)
		}
		if len(out) >= 12 {
			break
		}
	}
	if len(out) == 0 {
		return "conn"
	}
	return string(out)
}

// mcpInputSchemaParams 把 MCP 工具的 input_schema（JSON Schema）映射为 AgentTool.Params。
// 只接受基础子集：顶层 object，properties 各字段类型为 string/number/boolean/array/object
// （D-186 P3：不含 $ref 与 union；契约 §2.4 第 1 点）。additionalProperties 缺省按 false 收窄。
// 不支持的形状返回错误，调用方跳过该工具注册。
func mcpInputSchemaParams(raw json.RawMessage) ([]ToolParam, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var schema struct {
		Type       string `json:"type"`
		Properties map[string]struct {
			Type  string          `json:"type"`
			AnyOf json.RawMessage `json:"anyOf"`
			OneOf json.RawMessage `json:"oneOf"`
			AllOf json.RawMessage `json:"allOf"`
			Ref   string          `json:"$ref"`
		} `json:"properties"`
		Required             []string `json:"required"`
		AdditionalProperties *bool    `json:"additionalProperties"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, fmt.Errorf("input_schema 不是合法 JSON 对象: %w", err)
	}
	if schema.Type != "" && schema.Type != "object" {
		return nil, fmt.Errorf("input_schema 顶层类型 %q 不支持（仅 object）", schema.Type)
	}
	required := map[string]bool{}
	for _, name := range schema.Required {
		required[name] = true
	}
	// additionalProperties 显式 true 不收窄也无法按字段校验，视为不支持。
	if schema.AdditionalProperties != nil && *schema.AdditionalProperties {
		return nil, fmt.Errorf("additionalProperties:true 不支持（无法按字段校验）")
	}
	var params []ToolParam
	for name, prop := range schema.Properties {
		if prop.Ref != "" || len(prop.AnyOf) > 0 || len(prop.OneOf) > 0 || len(prop.AllOf) > 0 {
			return nil, fmt.Errorf("属性 %q 使用 $ref/组合类型，超出基础子集", name)
		}
		switch prop.Type {
		case "string", "number", "boolean", "array", "object":
		case "":
			return nil, fmt.Errorf("属性 %q 缺少 type", name)
		default:
			return nil, fmt.Errorf("属性 %q 类型 %q 不支持", name, prop.Type)
		}
		params = append(params, pBodyF(name, string(prop.Type), required[name]))
	}
	return params, nil
}

// agentMCPDynamicToolsForWorkspace 供 run 内工具分发层调用：
// 返回当前用户/工作区 enabled 连接的全部 MCP 工具目录项（每次调用实时查 DB，不走全局缓存）。
// 模型 dispatch 到这些工具时走 /tools/mcp/connections（list）+ mcp-host 桥执行。
func (s *Server) agentMCPDynamicToolsForWorkspace(ctx context.Context, workspaceID, userID uuid.UUID) []AgentTool {
	return ai27MCPDynamicTools(ctx, s, workspaceID, userID)
}
