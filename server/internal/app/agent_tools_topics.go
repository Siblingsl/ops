package app

// 附录 A.5 topics 选题与系列。

var agentToolsTopics = []AgentTool{
	{
		Name: "topics__list", Domain: "topics", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/topics",
		Description: "列出账号选题池中的选题，可按状态或契合度排序。",
		Params: []ToolParam{
			pPath("accountId"),
			pQueryF("limit", intRange(1, 100), false),
			pQueryF("cursor", strMax(200), false),
			pQueryF("sort", enumOf("created", "score"), false),
			pQueryF("scores", enumOf("0", "1"), false),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "topics__suggest", Domain: "topics", Kind: toolG, Method: "POST", Path: "/accounts/{accountId}/topics/suggest",
		Description: "根据方向关键词生成选题建议，结果不写入选题池，需要用户逐条入库。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("direction", strMax(200), false),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "topics__hot_suggest", Domain: "topics", Kind: toolG, Method: "POST", Path: "/accounts/{accountId}/topics/hot-suggest",
		Description: "结合公开资讯摘要给出有时效感的选题建议，结果不写入选题池。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("direction", strMax(200), false),
			pBodyF("context", strMax(4000), false),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
		Notes:   "外部来源",
	},
	{
		Name: "topics__score", Domain: "topics", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/topics/score",
		Description: "为待定选题评估与账号定位的契合度并写入评分。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("account", "accountId"),
	},
	{
		Name: "topics__create", Domain: "topics", Kind: toolH, Method: "POST", Path: "/accounts/{accountId}/topics",
		Description: "把一条选题加入账号的选题池，需要用户确认标题与角度。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("title", strMax(64), true, "G"),
			pBody("angle", strMax(200), false, "G"),
			pBodyF("source", enumOf("ai", "review", "hot", "plan", "daily", "manual"), false),
			pBodyF("ai_call_id", schemaUUID, false),
			pBodyF("choice_index", schemaIntMin0, false),
			pBodyF("hot_item_id", schemaUUID, false),
			pBodyF("audience", strMax(100), false),
			pBodyF("hook", strMax(200), false),
			pBodyF("needed_materials", arrOf(schemaStr, 0, 20), false),
			pBodyF("format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note"), false),
			pBodyF("planned_date", `{"type":"string","format":"date"}`, false),
			pBodyF("series_id", schemaUUID, false),
			pBodyF("strategy_pillar", strMax(40), false),
		},
		Gate:    "H-01",
		MinRole: roleEditor,
		Target:  target("topic", ""),
	},
	{
		Name: "topics__update", Domain: "topics", Kind: toolW, Method: "PATCH", Path: "/topics/{id}",
		Description: "修改选题的标题、角度、状态或置顶等属性。",
		Params: []ToolParam{
			pPath("id"),
			pBody("title", strMax(64), false, "G/O"),
			pBody("angle", strMax(200), false, "G/O"),
			pBodyF("status", enumOf("pending", "adopted", "dropped"), false),
			pBodyF("audience", strMax(100), false),
			pBodyF("hook", strMax(200), false),
			pBodyF("needed_materials", arrOf(schemaStr, 0, 20), false),
			pBodyF("format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note"), false),
			pBodyF("planned_date", `{"type":"string","format":"date"}`, false),
			pBodyF("series_id", schemaUUID, false),
			pBodyF("score_fit", intRange(0, 100), false),
			pBodyF("pinned", schemaBool, false),
			pBodyF("strategy_pillar", strMax(40), false),
		},
		MinRole: roleEditor,
		Target:  target("topic", "id"),
	},
	{
		Name: "topics__delete", Domain: "topics", Kind: toolW, Method: "DELETE", Path: "/topics/{id}",
		Description: "把一条选题移入回收站，可以恢复。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("topic", "id"),
	},
	{
		Name: "topics__start_work", Domain: "topics", Kind: toolW, Method: "POST", Path: "/topics/{id}/works",
		Description: "从一条选题创建作品，观点留空等待作者填写。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("topic", "id"),
	},
	{
		Name: "series__list", Domain: "topics", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/series",
		Description: "列出账号的系列及其总纲。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "series__create", Domain: "topics", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/series",
		Description: "新建一个系列，包含名称与总纲说明。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("name", strMinMax(1, 40), true),
			pBody("outline", strMax(2000), false, "G"),
		},
		MinRole: roleEditor,
		Target:  target("series", ""),
	},
	{
		Name: "series__update", Domain: "topics", Kind: toolW, Method: "PATCH", Path: "/series/{id}",
		Description: "修改系列的名称或总纲说明。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("name", strMinMax(1, 40), false),
			pBodyF("outline", strMax(2000), false),
		},
		MinRole: roleEditor,
		Target:  target("series", "id"),
	},
	{
		Name: "series__delete", Domain: "topics", Kind: toolX, Method: "DELETE", Path: "/series/{id}",
		Description: "永久删除一个系列，此操作无法撤销。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("series", "id"),
	},
	{
		Name: "series__suggest", Domain: "topics", Kind: toolG, Method: "POST", Path: "/series/{id}/suggest",
		Description: "根据系列总纲建议还缺的选题，结果不写入选题池。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("series", "id"),
	},
}
