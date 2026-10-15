package app

// 附录 A.1 workspace 工作区与成员。

var agentToolsWorkspace = []AgentTool{
	{
		Name: "workspace__list", Domain: "workspace", Kind: toolR, Method: "GET", Path: "/workspaces",
		Description: "列出本人所属的工作区。切换工作区只给出页面链接，由用户在左上角菜单操作。",
		MinRole:     roleViewer,
		Target:      target("workspace", ""),
	},
	{
		Name: "workspace__members", Domain: "workspace", Kind: toolR, Method: "GET", Path: "/workspaces/current/members",
		Description: "列出当前工作区的成员及其角色与状态。",
		MinRole:     roleViewer,
		Target:      target("workspace", ""),
	},
	{
		Name: "workspace__invites", Domain: "workspace", Kind: toolR, Method: "GET", Path: "/workspaces/current/invites",
		Description: "列出当前工作区未撤销的邀请。邀请码在结果中已脱敏，只显示状态与有效期。",
		MinRole:     roleOwner,
		Target:      target("workspace", ""),
	},
	{
		Name: "workspace__create", Domain: "workspace", Kind: toolW, Method: "POST", Path: "/workspaces",
		Description: "新建一个工作区。创建后不会自动切换，需要用户在工作区菜单中切换。",
		Params: []ToolParam{
			pBodyF("name", strMax(60), false),
		},
		Fixed:   fixedArgs("switch", false),
		MinRole: roleEditor,
		Target:  target("workspace", ""),
	},
	{
		Name: "workspace__rename", Domain: "workspace", Kind: toolW, Method: "PATCH", Path: "/workspaces/{id}",
		Description: "重命名工作区。只能修改当前所在的工作区。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("name", strMinMax(1, 60), true),
		},
		MinRole: roleOwner,
		Target:  target("workspace", "id"),
	},
	{
		Name: "workspace__create_invite", Domain: "workspace", Kind: toolW, Method: "POST", Path: "/workspaces/current/invites",
		Description: "创建一个邀请码，用于邀请他人加入当前工作区。邀请码只展示一次，请提醒用户立即复制保存。",
		Params: []ToolParam{
			pBodyF("role", enumOf("editor", "owner", "viewer"), false),
			pBodyF("max_uses", intRange(1, 100), false),
			pBodyF("days", intRange(1, 90), false),
		},
		MinRole: roleOwner,
		Target:  target("workspace", ""),
		Secrets: []string{"code"},
	},
	{
		Name: "workspace__send_invite_email", Domain: "workspace", Kind: toolW, Method: "POST", Path: "/workspaces/current/invites/{id}/send-email",
		Description: "把已有邀请的邀请码发送到指定邮箱。邮箱地址必须由用户提供。",
		Params: []ToolParam{
			pPath("id"),
			pBody("email", strMax(200), true, "U"),
		},
		MinRole: roleOwner,
		Target:  target("invite", "id"),
	},
	{
		Name: "workspace__revoke_invite", Domain: "workspace", Kind: toolW, Method: "POST", Path: "/workspaces/current/invites/{id}/revoke",
		Description: "撤销一个尚未使用的邀请，撤销后该邀请码立即失效。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleOwner,
		Target:  target("invite", "id"),
	},
	{
		Name: "workspace__set_member", Domain: "workspace", Kind: toolW, Method: "PATCH", Path: "/workspaces/current/members/{userId}",
		Description: "修改成员的观察者、编辑者或所有者角色，或启用、停用成员。移出成员请使用单独的工具。",
		Params: []ToolParam{
			pPath("userId"),
			pBodyF("role", enumOf("owner", "editor", "viewer"), false),
			pBodyF("status", enumOf("active", "disabled"), false),
		},
		MinRole: roleOwner,
		Target:  target("member", "userId"),
	},
	{
		Name: "workspace__remove_member", Domain: "workspace", Kind: toolX, Method: "PATCH", Path: "/workspaces/current/members/{userId}",
		Description: "把成员移出工作区。此操作无法撤销，需要用户输入成员用户名确认。",
		Params: []ToolParam{
			pPath("userId"),
		},
		Fixed:         fixedArgs("remove", true),
		MinRole:       roleOwner,
		SecondConfirm: secondConfirmUsername(),
		Target:        target("member", "userId"),
	},
	{
		Name: "workspace__transfer_owner", Domain: "workspace", Kind: toolX, Method: "POST", Path: "/workspaces/current/transfer",
		Description: "把工作区所有权转让给另一位成员，自己降为编辑者。此操作无法撤销，需要用户输入对方用户名确认。",
		Params: []ToolParam{
			pBodyF("user_id", schemaUUID, true),
		},
		MinRole:       roleOwner,
		SecondConfirm: secondConfirmUsername(),
		Target:        target("member", "user_id"),
	},
}
