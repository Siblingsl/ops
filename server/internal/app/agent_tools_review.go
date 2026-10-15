package app

// 附录 A.11 review 数据与复盘。

var agentToolsReview = []AgentTool{
	{
		Name: "review__dashboard", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/dashboard",
		Description: "查看账号工作台概览：各状态作品数、待办清单、待处理选题与今日用量。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "review__top_works", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/top-works",
		Description: "查看账号表现靠前的作品及其阅读与互动数据，用于挑选值得拆解的作品。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "review__digests", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/digests",
		Description: "查看账号历次周报的内容与统计。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "metrics__list", Domain: "review", Kind: toolR, Method: "GET", Path: "/works/{id}/metrics",
		Description: "查看一篇作品已录入的数据快照；按节点视图返回第 1、3、7、30 天的槽位与第 7 天口径。",
		Params: []ToolParam{
			pPath("id"),
			pQueryF("view", enumOf("nodes"), false),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "metrics__unmatched", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/metrics/unmatched",
		Description: "查看公众号同步后没有对上作品的数据，需要逐条指定作品或忽略。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "followers__list", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/followers",
		Description: "查看账号按天记录的粉丝数据，包括新增关注、取消关注与粉丝总数。",
		Params: []ToolParam{
			pPath("accountId"),
			pQueryF("days", intRange(1, 90), false),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "reviews__list", Domain: "review", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/reviews",
		Description: "查看账号的复盘报告列表及其结论、选题建议、写作结论与处理状态。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "metrics__create", Domain: "review", Kind: toolW, Method: "POST", Path: "/works/{id}/metrics",
		Description: "为已发布的作品录入一条数据快照，至少填写一项数字；同一天同来源会合并到已有的一条。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("captured_at", `{"type":"string","format":"date-time"}`, false),
			pBody("reads", schemaIntMin0, false, "U/O"),
			pBody("likes", schemaIntMin0, false, "U/O"),
			pBody("wows", schemaIntMin0, false, "U/O"),
			pBody("favorites", schemaIntMin0, false, "U/O"),
			pBody("comments", schemaIntMin0, false, "U/O"),
			pBody("shares", schemaIntMin0, false, "U/O"),
			pBody("follows_gained", schemaIntMin0, false, "U/O"),
			pBodyF("note", strMax(500), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "metrics__update", Domain: "review", Kind: toolW, Method: "PATCH", Path: "/metrics/{id}",
		Description: "修改一条已录入的数据快照的数字、采集时间与备注。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("captured_at", `{"type":"string","format":"date-time"}`, false),
			pBody("reads", schemaIntMin0, false, "U/O"),
			pBody("likes", schemaIntMin0, false, "U/O"),
			pBody("wows", schemaIntMin0, false, "U/O"),
			pBody("favorites", schemaIntMin0, false, "U/O"),
			pBody("comments", schemaIntMin0, false, "U/O"),
			pBody("shares", schemaIntMin0, false, "U/O"),
			pBody("follows_gained", schemaIntMin0, false, "U/O"),
			pBodyF("note", strMax(500), false),
		},
		MinRole: roleEditor,
		Target:  target("metric", "id"),
	},
	{
		Name: "metrics__delete", Domain: "review", Kind: toolX, Method: "DELETE", Path: "/metrics/{id}",
		Description: "删除一条数据快照，删除后无法恢复。需要用户输入作品标题确认。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("metric", "id"),
	},
	{
		Name: "metrics__import", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/metrics/import",
		Description: "把用户确认过的数据行逐行写入对应作品，数字来自用户提供的表格文本。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("rows", arrOf(`{"type":"object","properties":{"title":{"type":"string"},"work_id":{"type":"string"},"reads":{"type":"integer","minimum":0},"likes":{"type":"integer","minimum":0},"wows":{"type":"integer","minimum":0},"favorites":{"type":"integer","minimum":0},"comments":{"type":"integer","minimum":0},"shares":{"type":"integer","minimum":0},"follows_gained":{"type":"integer","minimum":0}}}`, 1, 0), true, "U"),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "metrics__sync_wechat", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/metrics/sync-wechat",
		Description: "向微信数据接口同步公众号近期群发文章的数据与粉丝数据，没对上作品的文章进入待匹配。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "metrics__assign_unmatched", Domain: "review", Kind: toolW, Method: "POST", Path: "/metrics/unmatched/{id}/assign",
		Description: "把一条没对上的文章数据指定到本账号的一篇作品。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("work_id", schemaUUID, true),
		},
		MinRole: roleEditor,
		Target:  target("metric_unmatched", "id"),
	},
	{
		Name: "metrics__ignore_unmatched", Domain: "review", Kind: toolW, Method: "POST", Path: "/metrics/unmatched/{id}/ignore",
		Description: "忽略一条没对上的文章数据，之后同步不再提示这一条。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("metric_unmatched", "id"),
	},
	{
		Name: "metrics__recognize_screenshots", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/metrics/screenshots",
		Description: "识别用户上传的数据截图并返回待确认的数据行，不会直接写入数据。",
		Params: []ToolParam{
			pPath("accountId"),
			pFiles("attachment_ids", "files", true),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("account", "accountId"),
	},
	{
		Name: "metrics__confirm_screenshot_row", Domain: "review", Kind: toolW, Method: "POST", Path: "/metrics/screenshots/{id}/rows/{idx}/confirm",
		Description: "确认截图识别结果中的一行并写入数据，一次只处理一行，需要指定该行对应的作品。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("idx"),
			pBodyF("work_id", schemaUUID, true),
			pBodyF("captured_at", `{"type":"string","format":"date-time"}`, false),
			pBody("reads", schemaIntMin0, false, "U/O"),
			pBody("likes", schemaIntMin0, false, "U/O"),
			pBody("wows", schemaIntMin0, false, "U/O"),
			pBody("favorites", schemaIntMin0, false, "U/O"),
			pBody("comments", schemaIntMin0, false, "U/O"),
			pBody("shares", schemaIntMin0, false, "U/O"),
			pBody("follows_gained", schemaIntMin0, false, "U/O"),
			pBodyF("note", strMax(500), false),
		},
		MinRole: roleEditor,
		Target:  target("metric_upload", "id"),
	},
	{
		Name: "followers__record", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/followers",
		Description: "录入一天的粉丝数据，包括新增关注、取消关注与粉丝总数，至少填写一项。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("date", `{"type":"string","format":"date"}`, true),
			pBody("new_follow", schemaIntMin0, false, "U"),
			pBody("cancel_follow", schemaIntMin0, false, "U"),
			pBody("cumulate", schemaIntMin0, false, "U"),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "reviews__create", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/reviews",
		Description: "调用 AI 生成复盘报告并写入账号的复盘记录，报告只给结论与选题建议，不会写入选题池。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("work_ids", arrOf(schemaUUID, 0, 30), false),
			pBodyF("recent", intRange(1, 30), false),
			pBodyF("background", schemaBool, false),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("account", "accountId"),
	},
	{
		Name: "reviews__adopt_suggestion", Domain: "review", Kind: toolH, Method: "POST", Path: "/review-reports/{id}/suggestions/{index}/adopt",
		Description: "把复盘报告中的一条选题建议采纳为选题，一次只处理一条。需要用户确认。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("index"),
		},
		Gate:    "H-08",
		MinRole: roleEditor,
		Target:  target("review_report", "id"),
	},
	{
		Name: "reviews__remember_insight", Domain: "review", Kind: toolH, Method: "POST", Path: "/review-reports/{id}/insights/{index}/remember",
		Description: "把复盘报告中的一条写作结论记为账号记忆，一次只处理一条。需要用户确认。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("index"),
		},
		Gate:    "HC-20",
		MinRole: roleEditor,
		Target:  target("review_report", "id"),
	},
	{
		Name: "reviews__ignore_insight", Domain: "review", Kind: toolW, Method: "POST", Path: "/review-reports/{id}/insights/{index}/ignore",
		Description: "忽略复盘报告中的一条写作结论，并记为对 AI 输出的否定反馈。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("index"),
		},
		MinRole: roleEditor,
		Target:  target("review_report", "id"),
	},
	{
		Name: "reviews__attribution", Domain: "review", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/reviews/attribution",
		Description: "调用 AI 归纳账号作品的分组表现并沉淀为读者数据偏好；样本不够时只返回提示。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("account", "accountId"),
	},
	{
		Name: "works__breakdown", Domain: "review", Kind: toolG, Method: "POST", Path: "/works/{id}/breakdown",
		Description: "调用 AI 拆解本账号表现靠前作品的结构、开头、标题特征与选题角度，只返回结果不写入作品。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
}
