package app

// 附录 A.7 works 作品。

var agentToolsWorks = []AgentTool{
	{
		Name: "works__list", Domain: "works", Kind: toolR, Method: "GET", Path: "/accounts/{accountId}/works",
		Description: "列出某个平台账号下的作品，包含状态、字数、段落数、计划日期与最近更新时间。",
		Params: []ToolParam{
			pPath("accountId"),
		},
		MinRole: roleViewer,
		Target:  target("account", "accountId"),
	},
	{
		Name: "works__get", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}",
		Description: "查看作品属性与段落概要：状态、修订号、观点是否为空、大纲是否确认、段落 ID 与小标题、字数与前 200 字。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
		Project: agentProjectWork,
	},
	{
		Name: "works__read_sections", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}",
		Description: "读取指定段落的完整正文，最多 5 段；没有指定段落时只返回段落概要。",
		Params: []ToolParam{
			pPath("id"),
			pQuery("section_ids", arrOf(schemaUUID, 1, 5), false, "O"),
		},
		MinRole:     roleViewer,
		Target:      target("work", "id"),
		ProjectArgs: agentProjectWorkSections,
	},
	{
		Name: "works__family", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/family",
		Description: "查看一篇作品的派生家族：源作品与全部派生作品的平台、状态、层级与是否需要同步。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "works__series_context", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/series-context",
		Description: "查看作品在系列中的位置，给出上一篇与下一篇的衔接信息。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "works__source_diff", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/source-diff",
		Description: "对照派生作品与源作品，逐段列出源段落自上次改写后是否发生变化。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "works__activity", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/activity",
		Description: "查看作品动态：成员操作、段落修改与批注记录。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "works__versions", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/versions",
		Description: "列出作品的历史版本，包含版本号、原因、标题与创建时间。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "works__version_get", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/versions/{no}",
		Description: "读取某个历史版本的快照，包含标题、摘要、观点、大纲与全部段落。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("no"),
		},
		MinRole: roleViewer,
		Target:  target("version", "no"),
	},
	{
		Name: "works__lint", Domain: "works", Kind: toolR, Method: "POST", Path: "/works/{id}/lint",
		Description: "检查一段文字是否包含禁用词或待核实占位，只返回命中位置与建议，不写入任何数据。",
		Params: []ToolParam{
			pPath("id"),
			pBody("text", strMax(20000), false, "O"),
			pBody("texts", arrOf(schemaStr, 1, 0), false, "O"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__create", Domain: "works", Kind: toolW, Method: "POST", Path: "/accounts/{accountId}/works",
		Description: "在一个平台账号下新建作品。标题可留空（显示为未命名作品）；头条账号可按用户要求选择文章或微头条。创建后进入编辑，观点与大纲仍由用户自己写。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("title", strMax(64), false, "G"),
			pBodyF("content_format", enumOf("long_article", "qa_article", "briefing", "card_post", "script", "comic", "image_note", "list_note", "micro_post"), false),
		},
		MinRole: roleEditor,
		Target:  target("account", "accountId"),
	},
	{
		Name: "works__import_published", Domain: "works", Kind: toolH, Method: "POST", Path: "/accounts/{accountId}/works/import",
		Description: "把用户已发表的旧文回填为作品，需要用户确认该文确已发表。标题与段落必须是用户粘贴或上传的原文。",
		Params: []ToolParam{
			pPath("accountId"),
			pBody("title", strMax(64), true, "U"),
			pBody("sections", arrOf(`{"type":"object","properties":{"heading":{"type":"string"},"content_md":{"type":"string"}},"required":["content_md"]}`, 1, 0), true, "U"),
			pBodyF("published_date", strMax(10), false),
		},
		Human: []HumanField{
			hBody("confirm_published", schemaBool),
		},
		MinRole:   roleEditor,
		Gate:      "H-07",
		BodyClass: true,
		Target:    target("account", "accountId"),
	},
	{
		Name: "works__update", Domain: "works", Kind: toolW, Method: "PATCH", Path: "/works/{id}",
		Description: "修改作品的标题、摘要、标签、计划日期、负责人、审阅设置、主题与封面。不接受核心观点。",
		Params: []ToolParam{
			pPath("id"),
			pBody("title", strMax(64), false, "G"),
			pBody("summary", strMax(200), false, "G"),
			pBodyF("tags", arrOf(schemaStr, 0, 0), false),
			pBodyF("planned_date", strMax(10), false),
			pBodyF("assignee_id", schemaUUID, false),
			pBodyF("reviewer_id", schemaUUID, false),
			pBodyF("review_required", schemaBool, false),
			pBodyF("theme", strMax(40), false),
			pBodyF("cover_asset_id", schemaUUID, false),
			pBody("cover_crops", `{"type":"object","properties":{"2.35_1":{"type":"object"},"1_1":{"type":"object"}}}`, false, "O/U"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__set_viewpoint", Domain: "works", Kind: toolH, Method: "PATCH", Path: "/works/{id}",
		Description: "保存用户自己写的作品核心观点，保存后才能生成大纲。观点必须来自用户原话。",
		Params: []ToolParam{
			pPath("id"),
			pBody("viewpoint", strMax(2000), true, "U"),
		},
		MinRole: roleEditor,
		Gate:    "H-02",
		Target:  target("work", "id"),
	},
	{
		Name: "works__set_post_push_todos", Domain: "works", Kind: toolW, Method: "PUT", Path: "/works/{id}/post-push-todos",
		Description: "保存作品的后台待办清单，用于记录发布后的收尾事项。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("todos", arrOf(`{"type":"object","properties":{"key":{"type":"string"},"label":{"type":"string"},"done":{"type":"boolean"}},"required":["label"]}`, 1, 20), true),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__set_title_favorites", Domain: "works", Kind: toolW, Method: "PUT", Path: "/works/{id}/title-favorites",
		Description: "保存收藏的标题候选，供后续挑选；不会修改作品当前标题。",
		Params: []ToolParam{
			pPath("id"),
			pBody("items", arrOf(`{"type":"object","properties":{"text":{"type":"string"},"style":{"type":"string"}},"required":["text"]}`, 1, 20), true, "G"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__delete", Domain: "works", Kind: toolW, Method: "DELETE", Path: "/works/{id}",
		Description: "把作品移入回收站，之后可以从回收站恢复。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__duplicate", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/duplicate",
		Description: "复制一篇作品为新作品，包含段落、图片与素材绑定。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__derive", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/derive",
		Description: "把作品派生到另一个平台的账号，调用 AI 规划目标段落。头条目标必须指定文章或微头条；服务端按已确认的跨平台矩阵校验。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("target_account_id", schemaUUID, true),
			pBodyF("target_content_format", enumOf("long_article", "micro_post"), false),
		},
		MinRole:     roleEditor,
		Target:      target("work", "id"),
		ExecTimeout: agentExecAITimeout,
	},
	{
		Name: "works__unlock", Domain: "works", Kind: toolX, Method: "POST", Path: "/works/{id}/unlock",
		Description: "解锁已发表作品以便继续修改。修改不会同步到平台，需要用户确认。",
		Params: []ToolParam{
			pPath("id"),
		},
		Human: []HumanField{
			hBody("confirm", schemaBool),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("work", "id"),
	},
	{
		Name: "works__create_version", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/versions",
		Description: "手动保存一个作品版本，便于之后回退。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__restore_version", Domain: "works", Kind: toolX, Method: "POST", Path: "/works/{id}/versions/{no}/restore",
		Description: "把作品恢复到指定历史版本，当前正文会被覆盖，系统先自动保存一个版本。",
		Params: []ToolParam{
			pPath("id"),
			pPathInt("no"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		BodyClass:     true,
		Target:        target("version", "no"),
	},
	{
		Name: "works__preview_link", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/preview-link",
		Description: "生成 24 小时匿名分享预览链接；支持公众号与已准备发布包的头条作品，头条链接绑定卡片确认的修订。持有链接即可查看发布内容，链接只展示一次。",
		Params: []ToolParam{
			pPath("id"),
			pBodyFixed("basis_revision", `{"type":"integer","minimum":1}`, false),
		},
		MinRole:        roleEditor,
		Target:         target("work", "id"),
		ProposePreview: previewShareLink,
		Secrets:        []string{"token"},
	},
	{
		Name: "works__polish_check", Domain: "works", Kind: toolG, Method: "POST", Path: "/works/{id}/polish-check",
		Description: "对作品做表达体检，指出长句、重复与逻辑问题，只返回建议，不改正文。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("section_id", schemaUUID, false),
		},
		Fixed:   fixedArgs("ai", true),
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__polish_ignore", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/polish-ignore",
		Description: "忽略或恢复表达体检中的某条问题，避免重复提示。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("key", strMax(200), false),
			pBodyF("clear", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__golden_sentence", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/golden-sentences",
		Description: "保存或移除作品的金句，金句必须摘自本作品正文原文。",
		Params: []ToolParam{
			pPath("id"),
			pBody("text", strMax(80), true, "O"),
			pBodyF("remove", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__tag_suggest", Domain: "works", Kind: toolG, Method: "POST", Path: "/works/{id}/tag-suggest",
		Description: "根据作品内容建议话题标签，并给出理由，不写入作品。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "works__layout_suggest", Domain: "works", Kind: toolG, Method: "POST", Path: "/works/{id}/layout-suggest",
		Description: "根据作品正文建议排版改进，如加粗、列表与分割线，只返回建议。",
		Params: []ToolParam{
			pPath("id"),
		},
		Fixed:   fixedArgs("ai", true),
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "comments__list", Domain: "works", Kind: toolR, Method: "GET", Path: "/works/{id}/comments",
		Description: "列出作品下的批注，包含未解决数量与分页游标。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("work", "id"),
	},
	{
		Name: "comments__create", Domain: "works", Kind: toolW, Method: "POST", Path: "/works/{id}/comments",
		Description: "在作品或某一段落上添加批注，可以提及成员。批注内容代表用户本人。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("section_id", schemaUUID, false),
			pBody("anchor_text", strMax(200), false, "O"),
			pBody("body", strMax(2000), true, "U"),
			pBodyF("mentions", arrOf(schemaUUID, 1, 0), false),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "comments__update", Domain: "works", Kind: toolW, Method: "PATCH", Path: "/comments/{id}",
		Description: "修改批注内容或标记为已解决。",
		Params: []ToolParam{
			pPath("id"),
			pBody("body", strMax(2000), false, "U"),
			pBodyF("resolved", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("comment", "id"),
	},
	{
		Name: "stars__list", Domain: "works", Kind: toolR, Method: "GET", Path: "/stars",
		Description: "列出本人收藏的作品、选题与素材。",
		MinRole:     roleViewer,
		Target:      target("star", ""),
	},
	{
		Name: "stars__add", Domain: "works", Kind: toolW, Method: "POST", Path: "/stars",
		Description: "收藏一个作品、选题或素材。",
		Params: []ToolParam{
			pBodyF("object_type", enumOf("work", "topic", "material"), true),
			pBodyF("object_id", schemaUUID, true),
		},
		MinRole: roleEditor,
		Target:  target("star", ""),
	},
	{
		Name: "stars__remove", Domain: "works", Kind: toolW, Method: "DELETE", Path: "/stars/{type}/{id}",
		Description: "取消收藏一个作品、选题或素材。",
		Params: []ToolParam{
			pPathEnum("type", "work", "topic", "material"),
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("star", ""),
	},
}
