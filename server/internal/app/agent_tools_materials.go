package app

// 附录 A.4 materials 素材与收件箱。

var agentToolsMaterials = []AgentTool{
	{
		Name: "materials__list", Domain: "materials", Kind: toolR, Method: "GET", Path: "/materials",
		Description: "列出素材库中的素材，可按账号、共享范围、用法与关键词筛选。",
		Params: []ToolParam{
			pQueryF("account_id", schemaUUID, true),
			pQueryF("scope", enumOf("account", "shared"), false),
			pQueryF("q", strMax(200), false),
			pQueryF("usage", enumOf("unused", "used", "expired"), false),
		},
		MinRole: roleViewer,
		Target:  target("material", ""),
		Notes:   "外部来源",
	},
	{
		Name: "materials__get", Domain: "materials", Kind: toolR, Method: "GET", Path: "/materials/{id}",
		Description: "查看一条素材的完整内容、来源、标签与有效期。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("material", "id"),
		Notes:   "外部来源",
	},
	{
		Name: "materials__usage", Domain: "materials", Kind: toolR, Method: "GET", Path: "/materials/{id}/usage",
		Description: "查看一条素材被哪些作品引用。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("material", "id"),
	},
	{
		Name: "materials__duplicates", Domain: "materials", Kind: toolR, Method: "GET", Path: "/materials/duplicates",
		Description: "找出内容相似、可能重复的素材分组。",
		Params: []ToolParam{
			pQueryF("account_id", schemaUUID, true),
		},
		MinRole: roleViewer,
		Target:  target("material", ""),
	},
	{
		Name: "materials__extract", Domain: "materials", Kind: toolG, Method: "POST", Path: "/materials/extract",
		Description: "把用户粘贴的原文提炼成一条条可复用的原子素材，只返回建议，不写入素材库。",
		Params: []ToolParam{
			pBody("text", strMax(20000), true, "U"),
			pBodyF("account_id", schemaUUID, false),
		},
		MinRole: roleEditor,
		Target:  target("material", ""),
	},
	{
		Name: "materials__tag_suggest", Domain: "materials", Kind: toolG, Method: "POST", Path: "/materials/tag-suggest",
		Description: "根据素材内容建议类型与不超过五个标签，优先复用已有标签。",
		Params: []ToolParam{
			pBodyF("content", strMax(5000), true),
			pBodyF("ai", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("material", ""),
	},
	{
		Name: "materials__retrieve", Domain: "materials", Kind: toolG, Method: "POST", Path: "/accounts/{accountId}/retrieve",
		Description: "按关键词在账号的素材与历史正文中检索，返回相关片段与匹配理由。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("query", strMax(2000), true),
			pBodyF("types", arrOf(enumOf("material", "history"), 0, 2), false),
			pBodyF("limit", intRange(1, 30), false),
			pBodyF("exclude_ids", arrOf(schemaUUID, 0, 30), false),
			pBodyF("work_id", schemaUUID, false),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "materials__create", Domain: "materials", Kind: toolW, Method: "POST", Path: "/materials",
		Description: "新增一条素材，包含内容、类型、来源、标签与有效期。",
		Params: []ToolParam{
			pBody("content", strMax(5000), true, "U/G/O"),
			pBodyF("kind", enumOf("experience", "opinion", "case", "data"), true),
			pBodyF("account_id", schemaUUID, false),
			pBody("source", strMax(500), false, "U/G/O"),
			pBodyF("tags", arrOf(schemaStr, 0, 20), false),
			pBodyF("valid_until", `{"type":"string","format":"date"}`, false),
			pBodyF("read_page", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("material", ""),
	},
	{
		Name: "materials__update", Domain: "materials", Kind: toolW, Method: "PATCH", Path: "/materials/{id}",
		Description: "修改一条素材的内容、类型、来源、标签或有效期。",
		Params: []ToolParam{
			pPath("id"),
			pBody("content", strMax(5000), true, "U/G/O"),
			pBodyF("kind", enumOf("experience", "opinion", "case", "data"), true),
			pBodyF("account_id", schemaUUID, false),
			pBody("source", strMax(500), false, "U/G/O"),
			pBodyF("tags", arrOf(schemaStr, 0, 20), false),
			pBodyF("valid_until", `{"type":"string","format":"date"}`, false),
		},
		MinRole: roleEditor,
		Target:  target("material", "id"),
	},
	{
		Name: "materials__delete", Domain: "materials", Kind: toolW, Method: "DELETE", Path: "/materials/{id}",
		Description: "把一条素材移入回收站，可以恢复。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("material", "id"),
	},
	{
		Name: "materials__merge", Domain: "materials", Kind: toolW, Method: "POST", Path: "/materials/merge",
		Description: "把一组重复素材合并为一条，保留其中一条并丢弃其余。",
		Params: []ToolParam{
			pBodyF("keep_id", schemaUUID, true),
			pBodyF("drop_ids", arrOf(schemaUUID, 1, 10), true),
		},
		MinRole: roleEditor,
		Target:  target("material", "keep_id"),
	},
	{
		Name: "inbox__list", Domain: "materials", Kind: toolR, Method: "GET", Path: "/inbox",
		Description: "列出灵感收件箱中的条目，默认只看未处理的。",
		Params: []ToolParam{
			pQueryF("status", enumOf("new", "converted", "dismissed"), false),
			pQueryF("cursor", strMax(200), false),
		},
		MinRole: roleViewer,
		Target:  target("inbox", ""),
		Notes:   "外部来源",
	},
	{
		Name: "inbox__create", Domain: "materials", Kind: toolW, Method: "POST", Path: "/inbox",
		Description: "记录一条灵感，内容必须来自用户本人。",
		Params: []ToolParam{
			pBody("content", strMax(2000), true, "U"),
			pBodyF("account_id", schemaUUID, false),
			pBodyF("source", enumOf("quick", "share", "palette", "mobile"), false),
			pBodyF("read_page", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("inbox", ""),
	},
	{
		Name: "inbox__triage", Domain: "materials", Kind: toolW, Method: "POST", Path: "/inbox/{id}/triage",
		Description: "判断一条灵感适合作为选题还是素材，并给出整理建议。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("inbox", "id"),
	},
	{
		Name: "inbox__convert_to_topic", Domain: "materials", Kind: toolH, Method: "POST", Path: "/inbox/{id}/convert",
		Description: "把一条灵感转为选题，需要用户确认标题与角度后入库。",
		Params: []ToolParam{
			pPath("id"),
			pBody("title", strMax(64), false, "G/O"),
			pBody("angle", strMax(200), false, "G/O"),
			pBodyF("account_id", schemaUUID, false),
			pBodyF("audience", strMax(100), false),
		},
		Fixed:   fixedArgs("to", "topic"),
		Gate:    "H-01",
		MinRole: roleEditor,
		Target:  target("inbox", "id"),
	},
	{
		Name: "inbox__convert_to_material", Domain: "materials", Kind: toolW, Method: "POST", Path: "/inbox/{id}/convert",
		Description: "把一条灵感转为素材，内容取用户原文或收件箱原文。",
		Params: []ToolParam{
			pPath("id"),
			pBody("content", strMax(5000), false, "U/O"),
			pBodyF("account_id", schemaUUID, false),
			pBodyF("kind", enumOf("experience", "opinion", "case", "data"), false),
			pBodyF("tags", arrOf(schemaStr, 0, 20), false),
		},
		Fixed:   fixedArgs("to", "material"),
		MinRole: roleEditor,
		Target:  target("inbox", "id"),
	},
	{
		Name: "inbox__dismiss", Domain: "materials", Kind: toolW, Method: "DELETE", Path: "/inbox/{id}",
		Description: "把一条灵感标记为已忽略，不再出现在收件箱中。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("inbox", "id"),
	},
}
