package app

// 附录 A.8 writing 大纲与正文。

// outlineItemSchema 是大纲条目（OutlineItem）的参数 Schema。
const outlineItemSchema = `{"type":"object","properties":{"heading":{"type":"string"},"key_point":{"type":"string"},"material_ids":{"type":"array","items":{"type":"string","format":"uuid"}},"section_id":{"type":"string","format":"uuid"}}}`

// outlineTemplateSchema 是大纲模板（OutlineTemplate）的参数 Schema。
const outlineTemplateSchema = `{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string","maxLength":20},"structure":{"type":"string","maxLength":500}},"required":["name","structure"]}`

// comicPanelSchema 是分镜格（ComicPanel）中由模型提供的字段。
const comicPanelSchema = `{"type":"object","properties":{"scene":{"type":"string"},"character_ids":{"type":"array","items":{"type":"string","format":"uuid"}},"action":{"type":"string"},"shot":{"type":"string"},"narration":{"type":"string"},"dialogue":{"type":"string"},"image_prompt":{"type":"string"}}}`

var agentToolsWriting = []AgentTool{
	{
		Name: "outline__generate", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/outline/generate",
		Description: "围绕作者的核心观点生成 4 到 8 个段落的大纲，只返回结果不保存。核心观点为空时接口会要求作者先写下自己的观点。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("template", strMax(64), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "outline__review", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/outline/review",
		Description: "检查大纲的结构问题，例如论点重复、缺少反方、逻辑跳跃、结尾没有回到核心观点，只给出建议不修改大纲。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("items", arrOf(outlineItemSchema, 0, 0), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "outline__templates", Domain: "writing", Kind: toolR, Method: "GET", Path: "/outline-templates",
		Description: "列出可用的大纲结构模板，包含内置模板与本工作区自定义的模板。",
		MinRole:     roleViewer,
		Target:      target("outline_template", ""),
	},
	{
		Name: "outline__templates_update", Domain: "writing", Kind: toolW, Method: "PUT", Path: "/outline-templates",
		Description: "替换本工作区的自定义大纲模板，最多 30 个。内置模板不受影响。",
		Params: []ToolParam{
			pBodyF("items", arrOf(outlineTemplateSchema, 0, 30), false),
		},
		MinRole:     roleEditor,
		Target:      target("outline_template", ""),
		Fingerprint: true,
		Notes:       "整体替换类（第 3.4 节第 6 条）：只接受要保留的模板，提出卡片时读取当前完整值合并",
	},
	{
		Name: "outline__save", Domain: "writing", Kind: toolW, Method: "PUT", Path: "/works/{id}/outline",
		Description: "保存作品大纲的条目。只写入大纲，不创建段落，也不会把大纲标记为已确认。",
		Params: []ToolParam{
			pPath("id"),
			pBody("items", arrOf(outlineItemSchema, 0, 0), true, "G"),
			pBodyF("base_revision", schemaInt, false),
		},
		Fixed:          fixedArgs("confirm", false),
		MinRole:        roleEditor,
		BodyClass:      true,
		Target:         target("work", "id"),
		Notes:          "`base_revision` 取提出卡片时的值",
		ProposePreview: previewOutlineSave,
	},
	{
		Name: "outline__confirm", Domain: "writing", Kind: toolH, Method: "PUT", Path: "/works/{id}/outline",
		Description: "请作者确认当前大纲，确认后按大纲生成段落。卡片完整展示大纲，作者勾选确认后才能执行。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("base_revision", schemaInt, false),
			pBodyF("items", `{"type":"array"}`, false),
		},
		Human: []HumanField{
			hBody("confirm", schemaBool),
		},
		MinRole:        roleEditor,
		Gate:           "H-03",
		BodyClass:      true,
		Target:         target("work", "id"),
		Notes:          "条目由分发器在执行时读取当前大纲；`base_revision` 取提出卡片时的值",
		ProposePreview: previewOutlineConfirm,
		EnrichExecute:  enrichOutlineConfirm,
	},
	{
		Name: "storyboard__generate", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/storyboard/generate",
		Description: "为漫画作品生成指定格数的分镜，每格含场景、出场角色、动作、镜头、旁白与对白，只返回结果不保存。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("panel_count", intRange(2, 20), true),
			pBodyF("character_ids", arrOf(schemaUUID, 0, 0), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "storyboard__save", Domain: "writing", Kind: toolW, Method: "PUT", Path: "/works/{id}/storyboard",
		Description: "保存漫画分镜的各格内容，替换该作品已有分镜，不会把分镜标记为已确认。",
		Params: []ToolParam{
			pPath("id"),
			pBody("panels", arrOf(comicPanelSchema, 2, 20), true, "G"),
		},
		Fixed:     fixedArgs("confirm", false),
		MinRole:   roleEditor,
		BodyClass: true,
		Target:    target("work", "id"),
	},
	{
		Name: "storyboard__confirm", Domain: "writing", Kind: toolH, Method: "PUT", Path: "/works/{id}/storyboard",
		Description: "请作者确认当前分镜，确认后分镜文字才可用于后续生图。卡片完整展示分镜，作者勾选确认后才能执行。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("panels", `{"type":"array"}`, false),
		},
		Human: []HumanField{
			hBody("confirm", schemaBool),
		},
		MinRole:        roleEditor,
		Gate:           "H-03",
		BodyClass:      true,
		Target:         target("work", "id"),
		Notes:          "分格由分发器在执行时读取当前分镜，提出后被修改则 stale",
		ProposePreview: previewStoryboardConfirm,
		EnrichExecute:  enrichStoryboardConfirm,
		Fingerprint:    true,
	},
	{
		Name: "sections__create", Domain: "writing", Kind: toolW, Method: "POST", Path: "/works/{id}/sections",
		Description: "在作品末尾新增一个段落，可以同时给出小标题。小标题只能来自用户原文或本次生成结果。",
		Params: []ToolParam{
			pPath("id"),
			pBody("heading", strMax(200), false, "G"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "sections__reorder", Domain: "writing", Kind: toolW, Method: "PUT", Path: "/works/{id}/sections/order",
		Description: "按给定顺序重排作品的全部段落。必须列出该作品当前全部有效段落，不能遗漏、重复或包含其他作品的段落。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("ids", arrOf(schemaUUID, 0, 0), true),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "sections__update", Domain: "writing", Kind: toolW, Method: "PATCH", Path: "/sections/{id}",
		Description: "修改一个段落的小标题或正文。只提交需要修改的字段，正文必须与该段当前修订号一致。",
		Params: []ToolParam{
			pPath("id"),
			pBody("heading", strMax(200), false, "G/O"),
			pBody("content_md", strMax(20000), false, "G/O"),
			pBodyF("base_revision", schemaInt, false),
		},
		MinRole:        roleEditor,
		BodyClass:      true,
		Target:         target("section", "id"),
		Notes:          "`base_revision` 取提出卡片时的值；命中 G 来源时分发器为段落写入附加 `applied`",
		ProposePreview: previewSectionUpdate,
	},
	{
		Name: "sections__delete", Domain: "writing", Kind: toolW, Method: "DELETE", Path: "/sections/{id}",
		Description: "删除一个段落。删除后可以恢复，作品的其他内容不受影响。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:   roleEditor,
		BodyClass: true,
		Target:    target("section", "id"),
	},
	{
		Name: "sections__restore", Domain: "writing", Kind: toolW, Method: "POST", Path: "/sections/{id}/restore",
		Description: "恢复一个已删除的段落，回到它原来的位置。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:   roleEditor,
		BodyClass: true,
		Target:    target("section", "id"),
	},
	{
		Name: "sections__set_materials", Domain: "writing", Kind: toolW, Method: "PUT", Path: "/sections/{id}/materials",
		Description: "设置某一段落引用的素材，替换该段原有的素材绑定。只能使用本工作区已有的素材。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("material_ids", arrOf(schemaUUID, 0, 0), true),
		},
		MinRole: roleEditor,
		Target:  target("section", "id"),
	},
	{
		Name: "sections__draft", Domain: "writing", Kind: toolW, Method: "POST", Path: "/sections/{id}/draft",
		Description: "为单个段落起草正文，一次只处理一个段落，需要作者先确认大纲。会调用 AI 并写入正文。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("instruction", strMax(1000), false),
			pBodyF("tier", enumOf("economy", "quality", "standard"), false),
		},
		MinRole:     roleEditor,
		BodyClass:   true,
		SSE:         true,
		ExecTimeout: agentExecAITimeout,
		Target:      target("section", "id"),
	},
	{
		Name: "sections__rewrite", Domain: "writing", Kind: toolW, Method: "POST", Path: "/sections/{id}/rewrite",
		Description: "按目标账号的定位改写派生作品的一段，只保留源段落中的事实，不新增事实。会调用 AI 并写入正文。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:     roleEditor,
		BodyClass:   true,
		SSE:         true,
		ExecTimeout: agentExecAITimeout,
		Target:      target("section", "id"),
	},
	{
		Name: "sections__edit", Domain: "writing", Kind: toolG, Method: "POST", Path: "/sections/{id}/edit",
		Description: "对选中的文字做改写、扩写或缩写，只返回候选文字，不写入段落。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("mode", enumOf("rewrite", "expand", "shorten"), true),
			pBody("selection", strMax(20000), false, "O"),
			pBodyF("instruction", strMax(1000), false),
			pBodyF("variants", `{"type":"integer","enum":[1,3]}`, false),
			pBodyF("tier", enumOf("economy", "quality", "standard"), false),
		},
		MinRole: roleEditor,
		Target:  target("section", "id"),
	},
	{
		Name: "sections__hooks", Domain: "writing", Kind: toolG, Method: "POST", Path: "/sections/{id}/hooks",
		Description: "为段落生成开头、结尾或金句候选，每种给出三个风格不同的选项，只返回候选不写入段落。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("kind", enumOf("opening", "ending", "quote"), true),
			pBodyF("selection", strMax(20000), false),
		},
		MinRole: roleEditor,
		Target:  target("section", "id"),
	},
	{
		Name: "sections__image_suggest", Domain: "writing", Kind: toolG, Method: "POST", Path: "/sections/{id}/image-suggest",
		Description: "为段落生成 2 到 4 条配图建议，每条含画面描述与文生图提示词，不保存图片。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("section", "id"),
	},
	{
		Name: "sections__revisions", Domain: "writing", Kind: toolR, Method: "GET", Path: "/sections/{id}/revisions",
		Description: "列出某一段落最近的正文历史版本，最多 10 条。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("section", "id"),
	},
	{
		Name: "sections__restore_revision", Domain: "writing", Kind: toolW, Method: "POST", Path: "/sections/{id}/revisions/{rid}/restore",
		Description: "把某一段落回滚到一个历史版本，只影响这一段，作品的其他内容不变。",
		Params: []ToolParam{
			pPath("id"),
			pPath("rid"),
		},
		MinRole:   roleEditor,
		BodyClass: true,
		Target:    target("section_revision", "rid"),
	},
	{
		Name: "works__read_through", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/read-through",
		Description: "通读整篇作品，按段落给出最多 5 条改写或补充建议，每条附一句理由，不写入正文。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__titles", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/titles",
		Description: "为作品生成标题候选。给出原句时在其基础上改写，不写入作品标题。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("base", strMax(64), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__summary", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/summary",
		Description: "根据正文生成不超过 120 字的摘要，只返回结果不写入作品。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__organize_notes", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/organize-notes",
		Description: "把作者提供的要点或口述转写整理成带小标题的初稿，只整理不扩充，不写入作品。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("notes", strMax(20000), true),
		},
		MinRole: roleEditor,
		SSE:     true,
		Target:  target("work", "id"),
	},
	{
		Name: "works__organize_apply", Domain: "writing", Kind: toolH, Method: "POST", Path: "/works/{id}/organize-notes/apply",
		Description: "把整理好的初稿应用为作品的段落与大纲，会替换全部段落，需要作者确认并二次确认。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("source_tool_call_id", strMax(64), true),
			pBodyF("markdown", `{"type":"string"}`, false),
		},
		MinRole:        roleEditor,
		Gate:           "H-03",
		SecondConfirm:  secondConfirmPlain(),
		BodyClass:      true,
		Target:         target("work", "id"),
		Notes:          "`markdown` 由分发器从 `source_tool_call_id` 指向的整理结果读取",
		ProposePreview: previewOrganizeApply,
		EnrichExecute:  enrichOrganizeApply,
	},
	{
		Name: "xhs__pages", Domain: "writing", Kind: toolG, Method: "POST", Path: "/works/{id}/xhs/pages",
		Description: "把小红书笔记拆成若干图片页文案，第 1 页为封面页，其后为要点页，只返回结果。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
}
