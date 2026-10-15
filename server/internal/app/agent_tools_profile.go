package app

// 附录 A.3 profile 档案、风格、角色、记忆。

var agentToolsProfile = []AgentTool{
	{
		Name: "profile__get", Domain: "profile", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/profile",
		Description: "查看账号档案，包含定位标签、目标读者、人设语气、禁用词、风格摘要与公众号默认设置。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "profile__update", Domain: "profile", Kind: toolW, Method: "PUT", Path: "/accounts/{accountId}/profile",
		Description: "修改账号档案的定位、读者、人设、禁用词或风格摘要。只提交需要修改的字段，其余保持原值。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("positioning_tags", arrOf(schemaStr, 0, 20), false, "G"),
			pBody("target_audience", strMax(500), false, "G"),
			pBody("persona_tone", strMax(500), false, "G"),
			pBody("banned_words", arrOf(schemaStr, 0, 50), false, "G"),
			pBody("style_summary", strMax(2000), false, "G"),
			pBodyF("default_theme", strMax(40), false),
		},
		MinRole:     roleEditor,
		Target:      target("account", "accountId"),
		Preview:     previewFields("positioning_tags", "target_audience", "persona_tone", "banned_words", "style_summary", "default_theme"),
		Fingerprint: true,
		Notes:       "整体替换类（第 3.4 节第 6 条）：只接受要修改的字段，提出卡片时读当前完整值合并",
	},
	{
		Name: "profile__bootstrap", Domain: "profile", Kind: toolG, Method: "POST", Path: "/accounts/{accountId}/profile/bootstrap",
		Description: "根据用户提供的旧文推断账号定位、读者与人设。不写档案，结果供用户确认后再写入。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("samples", arrOf(`{"type":"object","properties":{"title":{"type":"string"},"content":{"type":"string"}}}`, 1, 5), true, "U"),
		},
		MinRole: roleEditor,
		SSE:     true,
		Target:  target("account", "accountId"),
	},
	{
		Name: "custom_theme__get", Domain: "profile", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/custom-theme",
		Description: "查看账号的自定义排版主题。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "custom_theme__update", Domain: "profile", Kind: toolW, Method: "PUT", Path: "/accounts/{accountId}/custom-theme",
		Description: "修改自定义排版主题的配色、字号、行距与段落间距。只提交需要修改的字段。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("base", strMax(40), false),
			pBodyF("primary_color", strMax(9), false),
			pBodyF("font_size", intRange(12, 24), false),
			pBodyF("line_height", `{"type":"number","minimum":1,"maximum":3}`, false),
			pBodyF("paragraph_gap", intRange(0, 40), false),
			pBodyF("heading_style", strMax(40), false),
			pBodyF("quote_style", strMax(40), false),
		},
		MinRole:     roleEditor,
		Target:      target("account", "accountId"),
		Preview:     previewFields("base", "primary_color", "font_size", "line_height", "paragraph_gap", "heading_style", "quote_style"),
		Fingerprint: true,
		Notes:       "整体替换类（第 3.4 节第 6 条）",
	},
	{
		Name: "style__list", Domain: "profile", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/style-samples",
		Description: "列出账号的风格样本。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "style__create", Domain: "profile", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/style-samples",
		Description: "新增一条风格样本。正文必须是用户自己发表过的文章原文。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("title", strMinMax(1, 120), true),
			pBody("content_md", strMax(20000), true, "U"),
		},
		MinRole: roleEditor,
		Target:  target("style_sample", ""),
	},
	{
		Name: "style__update", Domain: "profile", Kind: toolW, Method: "PATCH", Path: "/style-samples/{id}",
		Description: "修改一条风格样本的标题或正文。正文必须是用户自己发表过的文章原文。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("title", strMinMax(1, 120), false),
			pBody("content_md", strMax(20000), false, "U"),
		},
		MinRole: roleEditor,
		Target:  target("style_sample", "id"),
	},
	{
		Name: "style__delete", Domain: "profile", Kind: toolW, Method: "DELETE", Path: "/style-samples/{id}",
		Description: "删除一条风格样本。删除后进入回收站，可以恢复。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("style_sample", "id"),
	},
	{
		Name: "style__summarize", Domain: "profile", Kind: toolG, Method: "POST", Path: "/accounts/{accountId}/style-summary",
		Description: "根据已有风格样本总结写作风格。不写档案，结果供用户确认后再写入档案。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleEditor,
		SSE:     true,
		Target:  target("account", "accountId"),
	},
	{
		Name: "characters__list", Domain: "profile", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/characters",
		Description: "列出账号的角色卡，用于漫画与连载内容。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "characters__create", Domain: "profile", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/characters",
		Description: "新增一张角色卡，包含名称、外貌、性格与口头禅。",
		Params: []ToolParam{
			pPath("accountId"),
			pBodyF("name", strMinMax(1, 40), true),
			pBody("appearance", strMax(500), false, "G"),
			pBody("personality", strMax(500), false, "G"),
			pBody("catchphrase", strMax(200), false, "G"),
		},
		MinRole: roleEditor,
		Target:  target("character", ""),
	},
	{
		Name: "characters__update", Domain: "profile", Kind: toolW, Method: "PATCH", Path: "/characters/{id}",
		Description: "修改角色卡的名称、外貌、性格或口头禅。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("name", strMinMax(1, 40), false),
			pBody("appearance", strMax(500), false, "G"),
			pBody("personality", strMax(500), false, "G"),
			pBody("catchphrase", strMax(200), false, "G"),
		},
		MinRole: roleEditor,
		Target:  target("character", "id"),
	},
	{
		Name: "characters__delete", Domain: "profile", Kind: toolW, Method: "DELETE", Path: "/characters/{id}",
		Description: "删除一张角色卡。删除后进入回收站，可以恢复。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("character", "id"),
	},
	{
		Name: "characters__upload_ref", Domain: "profile", Kind: toolW, Method: "POST", Path: "/characters/{id}/ref",
		Description: "上传角色参考图。图片来自用户在本对话中上传的图片附件。",
		Params: []ToolParam{
			pPath("id"),
			pFile("attachment_id", "file", true),
		},
		MinRole: roleEditor,
		Target:  target("character", "id"),
	},
	{
		Name: "characters__delete_ref", Domain: "profile", Kind: toolX, Method: "DELETE", Path: "/characters/{id}/ref",
		Description: "删除角色参考图文件。此操作无法撤销。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("character", "id"),
	},
	{
		Name: "memory__list", Domain: "profile", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/memories",
		Description: "列出账号记忆。待确认的记忆不会进入写作上下文。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "memory__create", Domain: "profile", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/memories",
		Description: "手动新增一条账号记忆。文字必须是用户自己的原话。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("text", strMinMax(1, 500), true, "U"),
			pBodyF("kind", enumOf("preference", "fact", "style", "taboo"), false),
			pBodyF("scope", enumOf("account", "work"), false),
		},
		Fixed:   fixedArgs("source", "manual"),
		MinRole: roleEditor,
		Target:  target("memory", ""),
	},
	{
		Name: "memory__distill", Domain: "profile", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/memories/distill",
		Description: "从近期数据中提炼待确认记忆。提炼结果不会自动生效，需要用户逐条确认。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("account", "accountId"),
	},
	{
		Name: "memory__confirm", Domain: "profile", Kind: toolH, Method: "PATCH", Path: "/memories/{id}",
		Description: "确认一条待确认记忆，确认后才会进入写作上下文。",
		Params: []ToolParam{
			pPath("id"),
		},
		Fixed:   fixedArgs("status", "active"),
		Gate:    "HC-20",
		MinRole: roleEditor,
		Target:  target("memory", "id"),
	},
	{
		Name: "memory__update", Domain: "profile", Kind: toolW, Method: "PATCH", Path: "/memories/{id}",
		Description: "修改一条账号记忆的文字、类型或作用范围。文字必须是用户自己的原话。",
		Params: []ToolParam{
			pPath("id"),
			pBody("text", strMinMax(1, 500), false, "U"),
			pBodyF("kind", enumOf("preference", "fact", "style", "taboo"), false),
			pBodyF("scope", enumOf("account", "work"), false),
		},
		MinRole: roleEditor,
		Target:  target("memory", "id"),
	},
	{
		Name: "memory__disable", Domain: "profile", Kind: toolW, Method: "PATCH", Path: "/memories/{id}",
		Description: "停用一条账号记忆，停用后不再进入写作上下文，可以再次启用。",
		Params: []ToolParam{
			pPath("id"),
		},
		Fixed:   fixedArgs("status", "disabled"),
		MinRole: roleEditor,
		Target:  target("memory", "id"),
	},
	{
		Name: "memory__delete", Domain: "profile", Kind: toolX, Method: "DELETE", Path: "/memories/{id}",
		Description: "永久删除一条账号记忆。此操作无法撤销。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("memory", "id"),
	},
}
