package app

// 附录 A.9 visual 图片与漫画。

// cropCoordSchema 是 0 到 1 的相对裁剪坐标。
const cropCoordSchema = `{"type":"number","minimum":0,"maximum":1}`

var agentToolsVisual = []AgentTool{
	{
		Name: "assets__library", Domain: "visual", Kind: toolR, Method: "GET", Path: "/assets",
		Description: "列出图片库中的图片，可按账号、作品或是否为 AI 生成筛选。图片文件只给链接。",
		Params: []ToolParam{
			pQueryF("account_id", schemaUUID, false),
			pQueryF("work_id", schemaUUID, false),
			pQueryF("ai", enumOf("0", "1"), false),
		},
		MinRole: roleViewer,
		Target:  target("asset", ""),
	},
	{
		Name: "assets__smart_crop", Domain: "visual", Kind: toolR, Method: "GET", Path: "/assets/{id}/smart-crop",
		Description: "按给定比例计算一张图片的智能裁剪区域，返回 0 到 1 的相对坐标。",
		Params: []ToolParam{
			pPath("id"),
			pQueryF("aspects", strMax(60), false),
		},
		MinRole: roleViewer,
		Target:  target("asset", "id"),
		Notes:   "结果作为 `assets__crop` 裁剪坐标的 O 来源",
	},
	{
		Name: "assets__upload", Domain: "visual", Kind: toolW, Method: "POST", Path: "/works/{id}/assets",
		Description: "为作品上传一张图片。图片来自用户在本对话中上传的图片附件。",
		Params: []ToolParam{
			pPath("id"),
			pFile("file", true),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "assets__reuse", Domain: "visual", Kind: toolW, Method: "POST", Path: "/works/{id}/assets/reuse",
		Description: "把图片库中的一张图片复制到本作品，原图保持不变。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("asset_id", schemaUUID, true),
		},
		MinRole: roleEditor,
		Target:  target("work", "id"),
	},
	{
		Name: "assets__update", Domain: "visual", Kind: toolW, Method: "PATCH", Path: "/assets/{id}",
		Description: "修改一张图片的替代文字或排列顺序，只提交需要修改的字段。",
		Params: []ToolParam{
			pPath("id"),
			pBody("alt_text", strMax(500), false, "G"),
			pBodyF("position", schemaIntMin0, false),
		},
		MinRole: roleEditor,
		Target:  target("asset", "id"),
	},
	{
		Name: "assets__alt_suggest", Domain: "visual", Kind: toolG, Method: "POST", Path: "/assets/{id}/alt-suggestion",
		Description: "根据图片内容生成一句简洁客观的中文替代文字建议，只返回建议不写入。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleEditor,
		Target:  target("asset", "id"),
		Notes:   "使用视觉路由；不保存结果",
	},
	{
		Name: "assets__crop", Domain: "visual", Kind: toolW, Method: "POST", Path: "/assets/{id}/crop",
		Description: "按相对坐标裁剪图片并保存为一张新图片。坐标可由用户给出，也可取自智能裁剪结果。",
		Params: []ToolParam{
			pPath("id"),
			pBody("x1", cropCoordSchema, true, "O/U"),
			pBody("y1", cropCoordSchema, true, "O/U"),
			pBody("x2", cropCoordSchema, true, "O/U"),
			pBody("y2", cropCoordSchema, true, "O/U"),
			pBodyF("aspect", strMax(20), false),
		},
		MinRole: roleEditor,
		Target:  target("asset", "id"),
	},
	{
		Name: "assets__delete", Domain: "visual", Kind: toolX, Method: "DELETE", Path: "/assets/{id}",
		Description: "删除一张图片及其文件。此操作无法撤销，需要用户输入图片名称确认。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:       roleEditor,
		SecondConfirm: secondConfirmPlain(),
		Target:        target("asset", "id"),
	},
	{
		Name: "works__generate_image", Domain: "visual", Kind: toolW, Method: "POST", Path: "/works/{id}/generate-image",
		Description: "根据提示词为作品生成一张配图并保存到图片库，图上带 AI 生成标记。",
		Params: []ToolParam{
			pPath("id"),
			pBody("prompt", strMax(2000), true, "G"),
			pBodyF("size", strMax(20), false),
			pBodyF("background", schemaBool, false),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("work", "id"),
	},
	{
		Name: "cards__generate_image", Domain: "visual", Kind: toolW, Method: "POST", Path: "/works/{id}/cards/{sectionId}/generate-image",
		Description: "为一张图文卡片生成配图并保存。一次只处理一张卡片，提示词为空时按卡片文字自动生成。",
		Params: []ToolParam{
			pPath("id"),
			pPath("sectionId"),
			pBodyF("prompt", strMax(2000), false),
			pBodyF("size", strMax(20), false),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("section", "sectionId"),
	},
	{
		Name: "panels__update", Domain: "visual", Kind: toolW, Method: "PATCH", Path: "/panels/{id}",
		Description: "修改一个漫画分格的分镜文字或指定配图，只提交需要修改的字段。",
		Params: []ToolParam{
			pPath("id"),
			pBody("scene", strMax(200), false, "G"),
			pBody("action", strMax(200), false, "G"),
			pBody("shot", strMax(100), false, "G"),
			pBody("narration", strMax(200), false, "G"),
			pBody("dialogue", strMax(60), false, "G"),
			pBody("image_prompt", strMax(2000), false, "G"),
			pBodyF("character_ids", arrOf(schemaUUID, 0, 0), false),
			pBodyF("asset_id", schemaUUID, false),
			pBodyF("clear_asset", schemaBool, false),
		},
		MinRole: roleEditor,
		Target:  target("panel", "id"),
	},
	{
		Name: "panels__generate_text", Domain: "visual", Kind: toolW, Method: "POST", Path: "/panels/{id}/text",
		Description: "为一个漫画分格生成旁白、对白与绘图提示词并保存。",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole:     roleEditor,
		BodyClass:   true,
		ExecTimeout: agentExecAITimeout,
		Target:      target("panel", "id"),
	},
	{
		Name: "panels__generate_image", Domain: "visual", Kind: toolW, Method: "POST", Path: "/panels/{id}/generate-image",
		Description: "为一个漫画分格生成图片并保存，结合角色卡保持外貌一致。提示词为空时按分镜文字自动生成。",
		Params: []ToolParam{
			pPath("id"),
			pBodyF("prompt", strMax(2000), false),
			pBodyF("size", strMax(20), false),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Target:      target("panel", "id"),
	},
}
