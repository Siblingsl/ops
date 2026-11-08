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
			desc := fmt.Sprintf("MCP 工具（连接：%s）。结果供用户确认后采用，不直接写业务数据。", connName)
			tools = append(tools, AgentTool{
				Name:    toolName,
				Domain:  "mcp",
				Kind:    toolG,
				Method:  "POST",
				Path:    "/tools/mcp/connections",
				Description: desc,
				MinRole: roleEditor,
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

// agentMCPDynamicToolsForWorkspace 供 run 内工具分发层调用：
// 返回当前用户/工作区 enabled 连接的全部 MCP 工具目录项（每次调用实时查 DB，不走全局缓存）。
// 模型 dispatch 到这些工具时走 /tools/mcp/connections（list）+ mcp-host 桥执行。
func (s *Server) agentMCPDynamicToolsForWorkspace(ctx context.Context, workspaceID, userID uuid.UUID) []AgentTool {
	return ai27MCPDynamicTools(ctx, s, workspaceID, userID)
}
