package app

import ()

// DEV-AI27-06（W06）：Agent 工具闭环——将 W04/W14/W15/W17 的资源接入 run 工具目录。
// 工具目录注册+开关联动的可见性过滤。实际派发编排由桌面客户端执行（浏览器桥/MCP 宿主/电脑控制 worker）。
// 模式语义（27 §8.6）：B=浏览器研究交互（讨论/计划/goal 可用）；R=只读观察；
// G=提案（不写业务数据）；子智能体元工具=固定 schema 管理本任务委派。

// ai27BrowserTools 注册浏览器研究交互工具（27 §8.1 语义名），仅 chrome_connect 开启时可见。
// 派发走 POST /agent/browser/commands（W04 第二批账本），由桌面桥执行并返回回执。
func ai27BrowserTools() []AgentTool {
	tools := []AgentTool{
		{
			Name: "browser_get_context", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "查看当前已授权连接与标签摘要。不列出未授权标签的全文。",
			MinRole:     roleEditor,
		},
		{
			Name: "browser_observe", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "观察获准标签的脱敏可见内容与可交互节点。需要 browser grant。跨域子 frame 仅在用户已授权该 origin 时可用 frame_id + frame_origin 读取（A7）。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
				pBody("frame_id", `{"type":"integer","minimum":1,"maximum":4096}`, false, "U"),
				pBody("frame_origin", `{"type":"string","minLength":1,"maxLength":255}`, false, "U"),
			},
			// A30b 片 2（拍板：账本存载荷+同步等待）：动作名由目录固定注入——模型参数
			// 平铺进账本 payload，模型不持租约句柄；服务端按 run 自查租约。
			Fixed:   map[string]any{"action": "observe"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_navigate", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "导航获准标签到标准 http/https URL。返回实际最终 URL 与标题。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
				pBody("url", `{"type":"string"}`, true, "U"),
			},
			Fixed:   map[string]any{"action": "navigate"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_click", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "点击获准标签中本次观察到的节点。需要 ref 与 doc_rev（来自 observe）。跨域子 frame 需同时提供已授权 origin 的 frame_id + frame_origin（A7）。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
				pBody("ref", `{"type":"string"}`, true, "U"),
				pBody("doc_rev", `{"type":"string"}`, true, "U"),
				pBody("frame_id", `{"type":"integer","minimum":1,"maximum":4096}`, false, "U"),
				pBody("frame_origin", `{"type":"string","minLength":1,"maxLength":255}`, false, "U"),
			},
			Fixed:   map[string]any{"action": "click"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_type", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "在获准标签的已验证文本控件中输入短文本。拒绝密码/MFA/上传控件。跨域子 frame 需同时提供已授权 origin 的 frame_id + frame_origin（A7）。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
				pBody("ref", `{"type":"string"}`, true, "U"),
				pBody("text", `{"type":"string"}`, true, "U"),
				pBody("doc_rev", `{"type":"string"}`, true, "U"),
				pBody("frame_id", `{"type":"integer","minimum":1,"maximum":4096}`, false, "U"),
				pBody("frame_origin", `{"type":"string","minLength":1,"maxLength":255}`, false, "U"),
			},
			Fixed:   map[string]any{"action": "type"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_observe_frames", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "跨 frame 观察获准标签：子 frame 只上报 origin 与节点计数，跨域内容默认隔离；用户授权该 origin 后，用 browser_observe 带 frame_id + frame_origin 读取该 frame 的节点。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
			},
			Fixed:   map[string]any{"action": "observe_frames"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_extract", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "从获准标签的指定 CSS 选择器提取文本。需要 doc_rev。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
				pBody("selector", `{"type":"string"}`, true, "U"),
				pBody("doc_rev", `{"type":"string"}`, true, "U"),
			},
			Fixed:   map[string]any{"action": "extract"},
			MinRole: roleEditor,
		},
		{
			Name: "browser_screenshot", Domain: "browser", Kind: toolR, Method: "POST", Path: "/tools/browser/commands",
			Description: "截取获准标签的可见区域（JPEG ≤2MiB）。需要模型 vision 能力。",
			Params: []ToolParam{
				pBody("tab_id", `{"type":"integer"}`, true, "U"),
			},
			Fixed:   map[string]any{"action": "screenshot"},
			MinRole: roleEditor,
		},
		{
			// A30：浏览器侧镜像 A12 决策 A——没有租约时请求用户选标签，有租约时报现状。
			Name: "browser_request_tab", Domain: "browser", Kind: toolR, Method: "POST",
			Path:        "/tools/browser/tab-requests",
			Description: "当前没有标签租约时，请用户在浏览器中选择要操作的标签页。选定后租约立即生效；不要替用户猜测标签。",
			MinRole:     roleEditor,
		},
	}
	return tools
}

// ai27DelegationTools 注册子智能体委派元工具（27 §11.3.3），仅 subagents 开启时可见。
// 固定 schema 只能管理本任务的委派；子任务不得递归委派。
func ai27DelegationTools() []AgentTool {
	return []AgentTool{
		{
			Name: "delegate_task", Domain: "subagent", Kind: toolG, Method: "POST",
			Path:        "/tools/subagent/conversations/{id}/delegation-groups",
			Description: "将当前任务拆分为 1~2 个独立的子任务并行研究。子任务只能提案结果，不能执行业务写入。父 run 汇总时保留来源、分歧与失败。",
			Params: []ToolParam{
				pPath("conversationId"),
				pBody("parent_run_id", `{"type":"string"}`, true, "U"),
				pBody("delegations", `{"type":"array","items":{"type":"object","properties":{"task":{"type":"string"},"request_id":{"type":"string"}}},"minItems":1,"maxItems":2}`, true, "U"),
			},
			MinRole: roleEditor,
		},
		{
			Name: "stop_delegation", Domain: "subagent", Kind: toolR, Method: "POST",
			Path:        "/tools/subagent/delegations/{id}/cancel",
			Description: "停止指定的子任务。不影响独立的其他子任务。",
			Params: []ToolParam{
				pPath("id"),
			},
			MinRole: roleEditor,
		},
	}
}

// ai27ComputerTools 注册电脑控制工具（27 §11.5.3），仅 computer_use 开启时可见。
// 语义限 observe/focus/scroll/select/invoke/type/request_handoff，效果未知的先确认。
func ai27ComputerTools() []AgentTool {
	return []AgentTool{
		{
			Name: "computer_observe", Domain: "computer", Kind: toolR, Method: "GET", Path: "/tools/computer/grants",
			Description: "查看当前活动的前台租约状态。",
			MinRole:     roleEditor,
		},
		{
			Name: "computer_request_handoff", Domain: "computer", Kind: toolR, Method: "POST",
			Path:        "/tools/computer/grants/{id}/handoff",
			Description: "用户接管前台控制。本机先停控，服务端记录。",
			Params: []ToolParam{
				pPath("id"),
			},
			MinRole: roleEditor,
		},
		{
			Name: "computer_request_target", Domain: "computer", Kind: toolR, Method: "POST",
			Path:        "/tools/computer/target-requests",
			Description: "当前没有前台租约时，请用户在本机选择要操作的应用窗口。选定后立即生效；不要替用户猜测目标。",
			MinRole:     roleEditor,
		},
	}
}

// ai27MCPTools 注册 MCP 连接目录查询工具（27 §11.2），仅 plugin_mcp 开启时可见。
// MCP 工具的动态目录由连接注册表承载；模型通过此工具查询可用连接与工具清单。
func ai27MCPTools() []AgentTool {
	return []AgentTool{
		{
			Name: "mcp__list_connections", Domain: "mcp", Kind: toolR, Method: "GET",
			Path:        "/tools/mcp/connections",
			Description: "列出当前工作区已启用的 MCP 连接与其工具/资源/提示模板目录。",
			MinRole:     roleEditor,
		},
	}
}
