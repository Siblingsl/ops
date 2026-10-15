package app

// 附录 A.12 settings 设置、质量与系统。

// settingsModelTaskTypes 是 PUT /model-routes 接受的任务类型（model_settings.go 的 taskTypes）。
var settingsModelTaskTypes = []string{
	"default", "topic_suggest", "topic_hot_suggest", "outline", "section_draft", "section_edit", "title", "summary",
	"fact_flag", "rewrite_plan", "section_rewrite", "review_analysis", "style_summary", "comic_storyboard",
	"comic_panel_text", "comic_rewrite", "image_suggest", "image_gen", "organize_notes", "section_continue",
	"hook_suggest", "outline_review", "copilot_chat", "read_through", "polish_check", "fix_suggest", "topic_score",
	"profile_bootstrap", "account_positioning", "strategy_revise", "strategy_outline", "hot_relevance",
	"daily_recommend", "reference_analyze", "material_extract", "material_tag", "inbox_triage", "memory_distill",
	"tag_suggest", "review_attribution", "work_breakdown", "weekly_digest", "metric_screenshot", "layout_suggest",
	"agent_chat", "agent_summary", "embedding", "tier_economy", "tier_quality",
}

// settingsEditableTasks 是提示词模板与提示词对比测试接受的任务类型（r4.go 的 editablePromptTasks）。
var settingsEditableTasks = []string{
	"topic_suggest", "outline", "section_draft", "section_edit", "comic_storyboard", "image_suggest",
	"organize_notes", "style_summary", "review_analysis", "account_positioning", "strategy_revise",
	"strategy_outline", "hot_relevance", "daily_recommend", "reference_analyze",
}

// settingsTrashTypes 是回收站接口实际接受的类型（settings.go 的 trashTables）。
var settingsTrashTypes = []string{"work", "topic", "material", "style_sample", "character_card", "reference"}

var agentToolsSettings = []AgentTool{
	{
		Name: "audit__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/audit-logs",
		Description: "查看当前工作区的操作日志，可按动作筛选、按时间向前翻页。未能归属工作区的历史记录仅系统管理员可见。",
		Params: []ToolParam{
			pQueryF("action", strMax(60), false),
			pQueryF("limit", intRange(1, 50), false),
			pQueryF("before", `{"type":"string","format":"date-time"}`, false),
		},
		MinRole: roleViewer,
		Target:  target("audit_log", ""),
	},
	{
		Name: "models__providers", Domain: "settings", Kind: toolR, Method: "GET", Path: "/model-providers",
		Description: "列出工作区的模型供应商，给出名称、模型、状态、能力与熔断状态。密钥只显示脱敏后的掩码。",
		MinRole:     roleViewer,
		Target:      target("model_provider", ""),
	},
	{
		Name: "models__routes", Domain: "settings", Kind: toolR, Method: "GET", Path: "/model-routes",
		Description: "列出各任务类型当前使用的供应商与模型，以及备用模型。",
		MinRole:     roleViewer,
		Target:      target("model_route", ""),
	},
	{
		Name: "models__set_route", Domain: "settings", Kind: toolW, Method: "PUT", Path: "/model-routes",
		Description: "把某一个任务类型的请求改到指定供应商的模型；不填供应商或模型表示改回默认。",
		Params: []ToolParam{
			pBodyF("task_type", enumOf(settingsModelTaskTypes...), true),
			pBodyF("provider_id", schemaUUID, false),
			pBodyF("model", strMax(100), false),
		},
		MinRole: roleOwner,
		Target:  target("model_route", "task_type"),
		Notes:   "分发器包装为单元素数组，一张卡片只改一个任务类型的路由",
	},
	{
		Name: "models__test", Domain: "settings", Kind: toolW, Method: "POST", Path: "/model-providers/{id}/test",
		Description: "向指定供应商发起一次连通测试，并记录测试结果与耗时。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("model", strMax(100), false),
		},
		MinRole: roleOwner,
		Target:  target("model_provider", "id"),
	},
	{
		Name: "models__selftest", Domain: "settings", Kind: toolW, Method: "POST", Path: "/model-providers/{id}/selftest",
		Description: "对指定供应商做一次能力自检，逐项探测对话、JSON 模式、流式输出、文生图、联网搜索、工具调用与看图，并保存能力记录。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("model", strMax(100), false),
		},
		MinRole: roleEditor,
		Target:  target("model_provider", "id"),
	},
	{
		Name: "ai__status", Domain: "settings", Kind: toolR, Method: "GET", Path: "/ai/status",
		Description: "查看当前工作区 AI 是否可用，图片识别与出图路由是否存在，以及今日已用 token 数。",
		MinRole:     roleViewer,
		Target:      target("ai", ""),
	},
	{
		Name: "usage__get", Domain: "settings", Kind: toolR, Method: "GET", Path: "/usage",
		Description: "查看 AI 用量统计，可按日期、任务类型、模型或账号分组。",
		Params: []ToolParam{
			pQueryF("from", `{"type":"string","format":"date"}`, false),
			pQueryF("to", `{"type":"string","format":"date"}`, false),
			pQueryF("group_by", enumOf("day", "task", "model", "account"), false),
		},
		MinRole: roleViewer,
		Target:  target("usage", ""),
	},
	{
		Name: "quality__board", Domain: "settings", Kind: toolR, Method: "GET", Path: "/quality",
		Description: "查看 AI 质量看板：各任务类型的采纳率、重试率、差评原因与近期趋势。",
		Params: []ToolParam{
			pQueryF("days", intRange(7, 180), false),
			pQueryF("task_type", strMax(60), false),
		},
		MinRole: roleViewer,
		Target:  target("quality", ""),
	},
	{
		Name: "quality__calls", Domain: "settings", Kind: toolR, Method: "GET", Path: "/quality/calls",
		Description: "查看最近的 AI 调用明细，可按任务类型与反馈结果筛选。",
		Params: []ToolParam{
			pQueryF("task_type", strMax(60), false),
			pQueryF("outcome", enumOf("accepted", "rejected", "edited", "regenerated", "down"), false),
		},
		MinRole: roleViewer,
		Target:  target("quality", ""),
	},
	{
		Name: "ai_jobs__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/ai-jobs",
		Description: "列出本人发起的 AI 任务及其状态。",
		Params: []ToolParam{
			pQueryF("status", enumOf("active", "queued", "running", "done", "failed", "cancelled"), false),
			pQueryF("work_id", schemaUUID, false),
		},
		MinRole: roleViewer,
		Target:  target("ai_job", ""),
	},
	{
		Name: "ai_jobs__get", Domain: "settings", Kind: toolR, Method: "GET", Path: "/ai-jobs/{id}",
		Description: "查看一个 AI 任务的详情与结果。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("ai_job", "id"),
	},
	{
		Name: "ai_jobs__cancel", Domain: "settings", Kind: toolW, Method: "POST", Path: "/ai-jobs/{id}/cancel",
		Description: "取消一个排队中或运行中的 AI 任务；取消后的结果不会写入作品。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("ai_job", "id"),
	},
	{
		Name: "feedback__post", Domain: "settings", Kind: toolW, Method: "POST", Path: "/ai-calls/{id}/feedback",
		Description: "为一次 AI 调用记录采纳结果、评价与原因，用于质量统计。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("outcome", enumOf("accepted", "rejected", "edited", "regenerated"), false),
			pBodyF("choice_index", intRange(0, 20), false),
			pBodyF("edit_ratio", `{"type":"number","minimum":0,"maximum":1}`, false),
			pBodyF("rating", intRange(-1, 1), false),
			pBodyF("reason_tags", arrOf(enumOf("太夸张", "太长", "太短", "跑题", "语气不对", "编造内容", "其他"), 0, 7), false),
			pBody("note", strMax(200), false, "U"),
			pBodyF("sample_text", strMax(500), false),
		},
		MinRole: roleEditor,
		Target:  target("ai_call", "id"),
	},
	{
		Name: "settings__get", Domain: "settings", Kind: toolR, Method: "GET", Path: "/settings",
		Description: "查看工作区设置：每日 token 上限、采样温度、每周复盘草稿开关与邮件配置。邮件配置已整体脱敏。",
		MinRole:     roleViewer,
		Target:      target("settings", ""),
	},
	{
		Name: "settings__update", Domain: "settings", Kind: toolW, Method: "PUT", Path: "/settings",
		Description: "修改每日 token 上限、采样温度或每周复盘草稿开关。邮件配置需要在设置页维护。",
		Params: []ToolParam{
			pBodyF("ai_limit", `{"type":"object","properties":{"enabled":{"type":"boolean"},"daily_tokens":{"type":"integer","minimum":1000}}}`, false),
			pBodyF("ai_sampling", `{"type":"object","properties":{"temperature":{"type":["number","null"],"minimum":0,"maximum":2}}}`, false),
			pBodyF("review_weekly_draft", enumOf("on", "off"), false),
		},
		MinRole: roleOwner,
		Target:  target("settings", ""),
		Notes:   "按字段部分更新（第 3.4 节第 6 条）：只提交要修改的字段",
	},
	{
		Name: "words__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/sensitive-words",
		Description: "列出工作区的敏感词，含基础词库与自定义词。",
		MinRole:     roleViewer,
		Target:      target("sensitive_word", ""),
	},
	{
		Name: "words__create", Domain: "settings", Kind: toolW, Method: "POST", Path: "/sensitive-words",
		Description: "新增若干自定义敏感词，可指定分类。重复的词会被跳过。",
		Params: []ToolParam{
			pBodyF("words", arrOf(strMinMax(1, 50), 1, 0), true),
			pBodyF("category", schemaStr, false),
		},
		MinRole: roleEditor,
		Target:  target("sensitive_word", ""),
	},
	{
		Name: "words__delete", Domain: "settings", Kind: toolX, Method: "DELETE", Path: "/sensitive-words/{id}",
		Description: "删除一个自定义敏感词。基础词库只读、不能删除；此操作无法撤销，需要用户输入该词确认。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("sensitive_word", "id"),
	},
	{
		Name: "prompts__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/prompt-templates",
		Description: "列出可编辑的任务指令模板及其版本。",
		MinRole:     roleViewer,
		Target:      target("prompt_template", ""),
	},
	{
		Name: "prompts__update", Domain: "settings", Kind: toolW, Method: "PUT", Path: "/prompt-templates/{taskType}",
		Description: "保存一个新的任务指令模板版本，内容由用户提供。",
		Params: []ToolParam{
			pPathEnum("taskType", settingsEditableTasks...),
			pBody("content", strMinMax(1, 8000), true, "U"),
		},
		MinRole: roleEditor,
		Target:  target("prompt_template", "taskType"),
	},
	{
		Name: "prompt_eval__cases", Domain: "settings", Kind: toolR, Method: "GET", Path: "/prompt-eval/cases",
		Description: "列出提示词对比测试的用例，可按任务类型筛选。",
		Params: []ToolParam{
			pQueryF("task_type", enumOf(settingsEditableTasks...), false),
		},
		MinRole: roleViewer,
		Target:  target("prompt_eval_case", ""),
	},
	{
		Name: "prompt_eval__runs", Domain: "settings", Kind: toolR, Method: "GET", Path: "/prompt-eval/cases/{id}/runs",
		Description: "列出某个用例的历史对比结果与人工结论。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("prompt_eval_case", "id"),
	},
	{
		Name: "prompt_eval__create_case", Domain: "settings", Kind: toolW, Method: "POST", Path: "/prompt-eval/cases",
		Description: "把一个任务最近一次的上下文快照保存为测试用例。",
		Params: []ToolParam{
			pBodyF("task_type", enumOf(settingsEditableTasks...), true),
			pBodyF("name", strMax(60), false),
		},
		MinRole: roleOwner,
		Target:  target("prompt_eval_case", ""),
	},
	{
		Name: "prompt_eval__delete_case", Domain: "settings", Kind: toolX, Method: "DELETE", Path: "/prompt-eval/cases/{id}",
		Description: "删除一个测试用例及其对比结果。此操作无法撤销，需要用户输入用例名确认。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleOwner,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("prompt_eval_case", "id"),
	},
	{
		Name: "prompt_eval__create_run", Domain: "settings", Kind: toolW, Method: "POST", Path: "/prompt-eval/runs",
		Description: "用同一份上下文对比当前模板与候选模板，调用 AI 两次并保存两段输出。",
		Params: []ToolParam{
			pBodyF("case_id", schemaUUID, true),
			pBodyF("template_b", strMinMax(1, 8000), true),
		},
		MinRole:     roleOwner,
		ExecTimeout: agentExecAITimeout,
		Target:      target("prompt_eval_case", "case_id"),
	},
	{
		Name: "prompt_eval__replay", Domain: "settings", Kind: toolW, Method: "POST", Path: "/prompt-eval/replay",
		Description: "按任务类型重放已有用例，统计输出与解析成功率。调用 AI 多次，卡片显示调用次数。",
		Params: []ToolParam{
			pBodyF("task_types", arrOf(enumOf(settingsEditableTasks...), 0, 15), false),
		},
		MinRole:     roleOwner,
		ExecTimeout: agentExecAITimeout,
		Target:      target("prompt_eval", ""),
		Notes:       "空表示全部可编辑任务；每个任务取最近 10 个用例、合计最多 30 个",
	},
	{
		Name: "prompt_eval__update_run", Domain: "settings", Kind: toolW, Method: "PATCH", Path: "/prompt-eval/runs/{id}",
		Description: "记录一次对比的人工结论：新的更好、旧的更好或差不多。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("verdict", enumOf("b_better", "a_better", "same"), true),
		},
		MinRole: roleEditor,
		Target:  target("prompt_eval_run", "id"),
	},
	{
		Name: "trash__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/trash",
		Description: "列出回收站中的对象，可按类型筛选；每项显示剩余保留天数。",
		Params: []ToolParam{
			pQueryF("type", enumOf(settingsTrashTypes...), false),
		},
		MinRole: roleViewer,
		Target:  target("trash", ""),
	},
	{
		Name: "trash__restore", Domain: "settings", Kind: toolW, Method: "POST", Path: "/trash/{type}/{id}/restore",
		Description: "把回收站中的一项恢复到原位置。",
		Params: []ToolParam{
			pPathEnum("type", settingsTrashTypes...),
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("trash", ""),
	},
	{
		Name: "trash__purge", Domain: "settings", Kind: toolX, Method: "DELETE", Path: "/trash/{type}/{id}",
		Description: "从回收站彻底删除一项，删除后无法恢复。需要用户在卡片上确认，一张卡片一项。",
		Params: []ToolParam{
			pPathEnum("type", settingsTrashTypes...),
			pPath("id"),
		},
		Human: []HumanField{
			hQuery("confirm", schemaBool),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("trash", ""),
		Notes:         "一张卡片一项",
	},
	{
		Name: "notifications__list", Domain: "settings", Kind: toolR, Method: "GET", Path: "/notifications",
		Description: "列出本人的通知，含未读数与进行中的任务数。",
		Params: []ToolParam{
			pQueryF("since", `{"type":"string","format":"date-time"}`, false),
		},
		MinRole: roleViewer,
		Target:  target("notification", ""),
	},
	{
		Name: "notifications__read", Domain: "settings", Kind: toolW, Method: "POST", Path: "/notifications/{id}/read",
		Description: "把一条通知标记为已读。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("notification", "id"),
	},
	{
		Name: "notifications__read_all", Domain: "settings", Kind: toolW, Method: "POST", Path: "/notifications/read-all",
		Description: "把本人的通知标记为已读，只改自己的已读状态。",
		MinRole:     roleEditor,
		Target:      target("notification", ""),
	},
	{
		Name: "prefs__get", Domain: "settings", Kind: toolR, Method: "GET", Path: "/me/preferences",
		Description: "查看本人的编辑与 AI 偏好设置。",
		MinRole:     roleViewer,
		Target:      target("prefs", ""),
	},
	{
		Name: "prefs__update", Domain: "settings", Kind: toolW, Method: "PUT", Path: "/me/preferences",
		Description: "修改本人的偏好设置，只提交要修改的字段。",
		Params: []ToolParam{
			pBodyF("default_variants", `{"type":"integer","enum":[1,3]}`, false),
			pBodyF("use_history", schemaBool, false),
			pBodyF("live_lint", schemaBool, false),
			pBodyF("ghost_text", schemaBool, false),
			pBodyF("ghost_key", enumOf("Alt+/", "Alt+.", "Ctrl+."), false),
			pBodyF("auto_jump_next_empty", schemaBool, false),
			pBodyF("focus_default", schemaBool, false),
			pBodyF("write_ending_first", schemaBool, false),
			pBodyF("ux_events", schemaBool, false),
			pBodyF("cost_tier", enumOf("economy", "standard", "quality"), false),
			pBodyF("saved_views", arrOf(`{"type":"object"}`, 0, 30), false),
			pBodyF("agent_privacy_notice_seen", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("prefs", ""),
		Notes:   "按字段部分更新（第 3.4 节第 6 条）：只提交要修改的字段",
	},
	{
		Name: "demo__import", Domain: "settings", Kind: toolW, Method: "POST", Path: "/demo",
		Description: "导入一份示例账号与示例内容，用于了解功能。每个工作区只能导入一次。",
		MinRole:     roleOwner,
		Target:      target("demo", ""),
	},
	{
		Name: "demo__clear", Domain: "settings", Kind: toolX, Method: "DELETE", Path: "/demo",
		Description:   "删除示例账号及其示例内容。此操作无法撤销，需要用户二次确认。",
		MinRole:       roleOwner,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("demo", ""),
	},
	{
		Name: "system__info", Domain: "settings", Kind: toolR, Method: "GET", Path: "/system/info",
		Description: "查看系统版本、运行环境、数据占用空间与出网地址。",
		MinRole:     roleViewer,
		Target:      target("system", ""),
	},
}
