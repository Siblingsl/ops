package app

// 附录 A.2 accounts 平台账号与工作台。

var agentToolsAccounts = []AgentTool{
	{
		Name: "accounts__list", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts",
		Description: "列出当前工作区的平台账号及其状态。",
		MinRole:     roleViewer,
		Target:      target("account", ""),
	},
	{
		Name: "accounts__get", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}",
		Description: "查看一个平台账号的详情。凭证只返回配置状态，AppID 与密钥掩码已脱敏。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__board", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/board",
		Description: "查看账号工作台的待办看板，包含需要处理的事项。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__health", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/health",
		Description: "查看账号健康度，包含内容节奏与凭证状态。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__next_actions", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/next-actions",
		Description: "查看账号的下一步建议动作。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__rhythm", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/rhythm",
		Description: "查看账号的内容节奏统计。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__brief", Domain: "accounts", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/brief",
		Description: "查看今日智能简报。只读模式不会创建简报生成任务。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		Fixed:   fixedArgs("prepare", "false"),
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
		Notes:   "第 14.2 节第 2 项前置修改：prepare=false 只读模式",
	},
	{
		Name: "accounts__create", Domain: "accounts", Kind: toolW, Method: "POST", Path: "/accounts",
		Description: "新建一个平台账号。账号类型创建后不能修改，请与用户确认后再执行。",
		Params: []ToolParam{
			pBodyF("platform", enumOf("wechat_mp", "xhs"), true),
			pBodyF("name", strMinMax(1, 60), true),
			pBodyF("content_format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note"), true),
			pBodyF("type_note", strMax(200), false),
		},
		MinRole: roleOwner,
		Target:  target("account", ""),
	},
	{
		Name: "accounts__update", Domain: "accounts", Kind: toolW, Method: "PATCH", Path: "/accounts/{accountId}",
		Description: "修改账号名称、类型说明、每日推送上限或公众号数据自动同步开关。账号类型不可修改。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("name", strMinMax(1, 60), false),
			pBodyF("type_note", strMax(200), false),
			pBodyF("daily_push_limit", intRange(1, 20), false),
			pBodyF("metrics_wechat_auto", schemaBool, false),
		},
		MinRole: roleOwner,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__disable", Domain: "accounts", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/disable",
		Description: "停用一个账号。停用后该账号不再出现在日常运营列表中，数据保留。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleOwner,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__enable", Domain: "accounts", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/enable",
		Description: "重新启用一个已停用的账号。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleOwner,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__delete", Domain: "accounts", Kind: toolX, Method: "DELETE", Path: "/accounts/{accountId}",
		Description: "删除账号及其作品数据。此操作无法撤销，需要用户输入账号名称确认。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		Human: []HumanField{
			hQuery("confirm", schemaBool),
		},
		MinRole:       roleOwner,
		SecondConfirm: secondConfirmAccountName(),
		Target:        target("account", "accountId"),
	},
	{
		Name: "accounts__test_wechat_credential", Domain: "accounts", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/wechat-credential/test",
		Description: "检测公众号凭证是否可用。会请求微信接口并更新凭证检测状态。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleOwner,
		Target:  target("account", "accountId"),
	},
	{
		Name: "accounts__wechat_link_check", Domain: "accounts", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/wechat/link-check",
		Description: "检测公众号发布链路的连通性。会请求微信接口。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleOwner,
		Target:  target("account", "accountId"),
	},
}
