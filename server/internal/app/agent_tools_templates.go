package app

// 附录 A：创作模板（DEV-416，18 §3.7）。保存走写卡片确认，内置模板不可改。
var agentToolsTemplates = []AgentTool{
	{
		Name: "templates__list", Domain: "templates", Kind: toolR, Method: "GET", Path: "/creation-templates",
		Description: "列出当前工作区的创作模板，包含内置与工作区模板；可按作品形态过滤。模板决定大纲结构、语气、段落区间与提示词补充。",
		Params: []ToolParam{
			pQueryF("content_format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note", "micro_post"), false),
		},
		MinRole: roleViewer,
		Target:  target("template", ""),
	},
	{
		Name: "templates__save", Domain: "templates", Kind: toolW, Method: "POST", Path: "/creation-templates",
		Description: "把用户确认的模板内容保存为当前工作区的新模板。内置模板不能修改；要基于内置模板调整时，另存为新的工作区模板。",
		Params: []ToolParam{
			pBodyF("content_format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note", "micro_post"), true),
			pBody("name", strMax(20), true, "U"),
			pBody("structure", arrOf(`{"type":"object","properties":{"heading":{"type":"string","maxLength":40},"key_point":{"type":"string","maxLength":200},"role":{"type":"string","maxLength":40}},"required":["heading"],"additionalProperties":false}`, 1, 20), true, "U"),
			pBodyF("prompt_addon", strMax(500), false),
			pBodyF("section_min", intRange(0, 20), false),
			pBodyF("section_max", intRange(0, 20), false),
			pBodyF("tone", strMax(40), false),
		},
		MinRole: roleEditor,
		Target:  target("template", ""),
	},
}
