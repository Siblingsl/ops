package app

// 附录 A.10 publish 检查、审阅与发布。

// wechatFieldsSchema 是公众号推送字段（WechatDefaults）的参数 Schema。
const wechatFieldsSchema = `{"type":"object","properties":{"author":{"type":"string"},"open_comment":{"type":"boolean"},"fans_only_comment":{"type":"boolean"},"source_url":{"type":"string"}}}`

var agentToolsPublish = []AgentTool{
	{
		Name: "checks__latest", Domain: "publish", Kind: toolR, Method: "GET", Path: "/works/{id}/checks/latest",
		Description: "查看作品最近一次发布前检查的结果，包含逐项状态、通过数与阻断项。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "checks__report", Domain: "publish", Kind: toolR, Method: "GET", Path: "/works/{id}/checks/report",
		Description: "汇总一次发布前检查的明细，供说明与核对使用。打印页只给链接。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
		Notes:   "打印页只给链接（页面键 `work_check_report`）",
	},
	{
		Name: "checks__start", Domain: "publish", Kind: toolW, Method: "POST", Path: "/works/{id}/checks",
		Description: "发起一次发布前检查，逐项给出格式、敏感词、广告法、事实等结果，并调用 AI 做事实核查。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		ClientPayload: "wechat_html_metrics",
		ExecTimeout:   agentExecAITimeout,
		Target:        target("work", "id"),
	},
	{
		Name: "checks__fix_suggest", Domain: "publish", Kind: toolG, Method: "POST", Path: "/check-items/{id}/fix-suggest",
		Description: "针对一个检查项命中的句子给出 1 到 3 条改写建议，只返回建议不修改正文。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("check_item", "id"),
		Notes:   "逐条处理（HC-18）；采用修改须经 `sections__update`，之后需要重新检查",
	},
	{
		Name: "checks__resolve_item", Domain: "publish", Kind: toolH, Method: "PATCH", Path: "/check-items/{id}",
		Description: "逐项处理一个发布前检查项，记录作者选择的处理方式。格式问题只能修改后重新检查。",
		Params: []ToolParam{
			pPath("id"),
		},
		Human: []HumanField{
			hBody("resolution", enumOf("acknowledged", "kept", "modified", "verified")),
		},
		MinRole: roleEditor,
		Gate:    "H-04",
		Target:  target("check_item", "id"),
		Notes:   "处理方式不预选；一张卡片一项",
	},
	{
		Name: "checks__complete", Domain: "publish", Kind: toolH, Method: "POST", Path: "/works/{id}/checks/complete",
		Description: "把一次发布前检查标记为完成。还有格式问题或未逐项确认时接口会拒绝。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Gate:    "H-04",
		Target:  target("work", "id"),
	},
	{
		Name: "works__approve_review", Domain: "publish", Kind: toolH, Method: "POST", Path: "/works/{id}/review/approve",
		Description: "审阅通过一篇待审阅的作品。只有工作区所有者或指定审阅人可以执行，由接口判定。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Gate:    "H-09",
		Target:  target("work", "id"),
	},
	{
		Name: "wechat__push_preview", Domain: "publish", Kind: toolR, Method: "GET", Path: "/works/{id}/wechat/push-preview",
		Description: "读取写入公众号草稿前的预览信息，包含当前字段、今日次数与凭证状态。凭证字段已脱敏。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "wechat__push", Domain: "publish", Kind: toolH, Method: "POST", Path: "/works/{id}/wechat/push",
		Description: "把一篇作品写入公众号草稿箱，不会发表。需要用户确认，超限或覆盖已有草稿时再确认一次。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("fields", wechatFieldsSchema, false),
		},
		Human: []HumanField{
			hBody("overwrite_choice", enumOf("new", "overwrite")),
			hBody("confirm_over_limit", schemaBool),
		},
		MinRole:       roleEditor,
		ClientPayload: "wechat_html",
		SSE:           true,
		Gate:          "H-05",
		SecondConfirm: secondConfirmPlain(),
		ExecTimeout:   agentExecPushTimeout,
		Target:        target("work", "id"),
		Notes:         "`fields`（作者、留言设置、原文链接）默认取档案，卡片可改",
	},
	{
		Name: "wechat__sync_draft", Domain: "publish", Kind: toolW, Method: "POST", Path: "/works/{id}/wechat/sync-draft",
		Description: "查询公众号草稿是否还在草稿箱，并更新标记。不会把作品改成已发布。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
		Notes:   "请求微信接口；不会改为已发布（HC-07）",
	},
	{
		Name: "xhs__create_pack", Domain: "publish", Kind: toolW, Method: "POST", Path: "/works/{id}/xhs/pack",
		Description: "为小红书作品生成发布包，包含按顺序的图片与文案。检查未完成或需要审阅时接口会拒绝。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "xhs__get_pack", Domain: "publish", Kind: toolR, Method: "GET", Path: "/works/{id}/xhs/pack",
		Description: "查看小红书发布包的状态与内容清单。压缩包只给链接，由用户下载。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
		Notes:   "压缩包只给链接（页面键 `work_pack`）",
	},
	{
		Name: "publish_link__parse", Domain: "publish", Kind: toolR, Method: "POST", Path: "/publish-link/parse",
		Description: "解析一条平台文章链接，提取平台、作品标识与发布时间。只返回结果不写数据。",
		Params: []ToolParam{
			pBody("url", strMax(1024), true, "U"),
		},
		MinRole: roleEditor,
		Target:  target("publish_link", ""),
		Notes:   "结果作为回填链接的 O 来源",
	},
	{
		Name: "works__mark_published", Domain: "publish", Kind: toolH, Method: "POST", Path: "/works/{id}/published",
		Description: "记录用户已在平台上发布这篇作品，回填链接与发布时间。需要用户确认。",
		Params: []ToolParam{
			pPath("id"),
			pBody("url", strMax(1024), false, "U/O"),
			pBody("published_at", `{"type":"string","format":"date-time"}`, false, "U/O"),
		},
		MinRole: roleEditor,
		Gate:    "H-07",
		Target:  target("work", "id"),
	},
}
