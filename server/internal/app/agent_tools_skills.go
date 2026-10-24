package app

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
)

// DEV-SK3 / 23 文档第 8.3、8.4 节：技能管理工具，全部挂 profile 领域，固定 Method + Path。
// name / summary / triggers / instructions 接受 U / 受控 G（skills__draft）/ 受限 O
// （skills__get）；revision、指纹与公开确认不属于模型可填字段，守卫由专用钩子冻结。

// schemaPublishConfirmation 是公开确认对象（10.3.1 节）：confirmed 由用户执行请求勾选，
// digest 在卡片提出时冻结，执行时由服务端按最终内容复核。
const schemaPublishConfirmation = `{"type":"object","properties":{"confirmed":{"type":"boolean"},"digest":{"type":"string"}},"required":["confirmed","digest"]}`

var agentToolsSkills = []AgentTool{
	{
		Name: "skills__list", Domain: "profile", Kind: toolR, Method: "GET", Path: "/skills",
		Description: "查看技能列表：view=library 为技能库（不含正文），view=effective 为当前上下文入选集（含引用号与 catalog_id，可据此 load_skill）",
		Params: []ToolParam{
			pQueryF("view", enumOf("library", "effective"), false),
			pQueryF("scope", enumOf("builtin", "workspace", "account", "personal"), false),
			pQueryF("account_id", schemaUUID, false),
			pQueryF("work_id", schemaUUID, false),
			pQueryF("q", strMax(100), false),
			pQueryF("cursor", strMax(300), false),
			pQueryF("limit", intRange(1, 12), false),
		},
		MinRole: roleViewer,
		Notes:   "不返回正文；运行内 effective 视图使用运行状态目录，结果不进入内容来源集合",
	},
	{
		Name: "skills__get", Domain: "profile", Kind: toolR, Method: "GET", Path: "/skills/{id}",
		Description: "读取单个有权查看的技能定义（含完整正文），可作为技能编辑 / 另存的底稿；结果只作技能字段来源",
		Params: []ToolParam{
			pPath("id"),
		},
		MinRole: roleViewer,
		Target:  target("skill", "id"),
	},
	{
		Name: "skills__draft", Domain: "profile", Kind: toolG, Method: "POST", Path: "/skills/draft", SSE: true,
		Description: "按用户需求起草一份技能底稿（四个文字字段加适用条件），不保存；成功后可经 skills__create / skills__update 提出卡片",
		Params: []ToolParam{
			pBody("brief", strMinMax(1, 2000), true, "U"),
			pBodyF("source_skill_id", schemaUUID, false),
			pBodyF("source_revision", schemaInt, false),
			pBodyF("platforms", arrOf(schemaStr, 0, 3), false),
			pBodyF("content_formats", arrOf(schemaStr, 0, 9), false),
			pBodyF("task_types", arrOf(schemaStr, 0, 25), false),
			pBodyF("task_enabled", schemaBool, false),
			pBodyF("agent_enabled", schemaBool, false),
		},
		MinRole:     roleEditor,
		ExecTimeout: agentExecAITimeout,
		Notes:       "缓冲式 SSE：只发 stage / done / error，不传送正文 delta（23 文档 4.3 节）",
	},
	{
		Name: "skills__create", Domain: "profile", Kind: toolW, Method: "POST", Path: "/skills",
		Description: "创建一条技能定义（单条）。公开范围（workspace/account）必须由用户在卡片上单独确认公开；账号层创建会同时自动启用",
		Params: []ToolParam{
			pBodyF("scope", enumOf("personal", "workspace", "account"), true),
			pBodyF("account_id", schemaUUID, false),
			pBody("name", strMinMax(1, 30), true, "U/G/O"),
			pBody("summary", strMinMax(1, 60), true, "U/G/O"),
			pBody("triggers", strMinMax(1, 120), true, "U/G/O"),
			pBody("instructions", strMinMax(1, 1200), true, "U/G/O"),
			pBodyF("platforms", arrOf(schemaStr, 0, 3), false),
			pBodyF("content_formats", arrOf(schemaStr, 0, 9), false),
			pBodyF("task_types", arrOf(schemaStr, 0, 25), false),
			pBodyF("task_enabled", schemaBool, false),
			pBodyF("agent_enabled", schemaBool, false),
			pBodyF("status", enumOf("active", "disabled"), false),
			pBodyF("copy_from_id", schemaUUID, false),
			// DEV-SK3：公开确认摘要由钩子在提出时冻结；Human 的 publish_confirmation
			// 对象由执行请求组装（16 文档 3.5 节人工字段不得与参数同名）。
			pBodyF("publish_digest", strMax(80), false),
		},
		Human:          []HumanField{hBody("publish_confirmation", schemaPublishConfirmation)},
		EnrichExecute:  skillsCreateEnrich,
		ProposePreview: skillsCreatePreview,
		MinRole:        roleEditor,
		Notes:          "scope、目标账号与内容在卡片提出后固定；更改目标必须重新提卡",
	},
	{
		Name: "skills__update", Domain: "profile", Kind: toolW, Method: "PUT", Path: "/skills/{id}",
		Description: "修改一条技能定义。模型只提交待改字段，提出卡片时按当前完整定义合并为底稿；公开定义需用户单独确认公开",
		Params: []ToolParam{
			pPath("id"),
			pBody("name", strMinMax(1, 30), false, "U/G/O"),
			pBody("summary", strMinMax(1, 60), false, "U/G/O"),
			pBody("triggers", strMinMax(1, 120), false, "U/G/O"),
			pBody("instructions", strMinMax(1, 1200), false, "U/G/O"),
			pBodyF("platforms", arrOf(schemaStr, 0, 3), false),
			pBodyF("content_formats", arrOf(schemaStr, 0, 9), false),
			pBodyF("task_types", arrOf(schemaStr, 0, 25), false),
			pBodyF("task_enabled", schemaBool, false),
			pBodyF("agent_enabled", schemaBool, false),
			pBodyF("status", enumOf("active", "disabled"), false),
			pBodyF("base_revision", schemaInt, false),
			pBodyF("impact_token", strMax(80), false),
			pBodyF("publish_digest", strMax(80), false),
		},
		Human:          []HumanField{hBody("publish_confirmation", schemaPublishConfirmation)},
		EnrichExecute:  skillsUpdateEnrich,
		ProposePreview: skillsUpdatePreview,
		Preview:        previewFields("revision"),
		Fingerprint:    true,
		MinRole:        roleEditor,
		Notes:          "底稿保留字段免重做来源匹配；stale 表示需重新预览，不可直接重试",
	},
	{
		Name: "skills__set_binding", Domain: "profile", Kind: toolW,
		Method: "PUT", Path: "/accounts/{accountId}/skill-bindings/{audience}/{skillId}",
		Description: "对单个账号的一个分区（public / personal）单项启用或停用一个技能，可调整同层 priority；一次只改一项",
		Params: []ToolParam{
			pPath("accountId"),
			pPathEnum("audience", "public", "personal"),
			pPath("skillId"),
			pBodyF("enabled", schemaBool, true),
			pBodyF("priority", intRange(0, 999), false),
			pBodyF("base_revision", strMax(80), false),
		},
		Target:         target("skill_binding", "skillId"),
		ProposePreview: skillsSetBindingPreview,
		MinRole:        roleEditor,
		Notes:          "分区 base_revision 由钩子冻结；旧修订一律 stale，即使结果看起来已达成",
	},
	{
		Name: "skills__delete", Domain: "profile", Kind: toolX, Method: "DELETE", Path: "/skills/{id}",
		Description: "删除一条技能定义（级联删除全部绑定）；内置技能拒绝删除",
		Params: []ToolParam{
			pPath("id"),
			pQueryF("base_revision", schemaInt, false),
			pQueryF("impact_token", strMax(80), false),
		},
		Human:          []HumanField{hQuery("confirm", schemaBool)},
		SecondConfirm:  secondConfirmPlain(),
		ProposePreview: skillsDeletePreview,
		MinRole:        roleEditor,
		Notes:          "修订与影响集合在卡片提出时冻结，执行前重验；变化返回 stale",
	},
}

// skillsCreatePreview 在提出卡片时规范化完整输入并冻结公开确认摘要（8.4 节）。
func skillsCreatePreview(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	scope, _ := args["scope"].(string)
	fields, err := skillFieldsFromArgs(args)
	if err != nil {
		return nil, nil, err
	}
	if scope == "personal" {
		delete(args, "publish_digest")
		return []agentChange{{Field: "scope", Label: "保存范围", After: "个人（仅本人可见）"}}, nil, nil
	}
	var accountID *uuid.UUID
	if scope == "account" {
		acc, err := s.account(ctx, uuid.MustParse(agentArgStr(args, "account_id")))
		if err != nil {
			return nil, nil, err
		}
		accountID = &acc.ID
	}
	digest, err := skillPublishDigest("create", nil, scope, accountID, fields)
	if err != nil {
		return nil, nil, err
	}
	args["publish_digest"] = digest
	after := "工作区（全体成员可见）"
	if scope == "account" {
		after = "账号（保存后同时启用）"
	}
	return []agentChange{{Field: "scope", Label: "公开范围", After: after}}, nil, nil
}

// skillsUpdatePreview 读取完整底稿，合并模型改动并冻结 CAS 与公开确认守卫（8.4 节）。
func skillsUpdatePreview(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	id, err := uuid.Parse(agentArgStr(args, "id"))
	if err != nil {
		return nil, nil, err
	}
	sr, err := s.skillVisibleDef(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	before := map[string]any{
		"name": sr.Def.Fields.Name, "summary": sr.Def.Fields.Summary,
		"triggers": sr.Def.Fields.Triggers, "instructions": sr.Def.Fields.Instructions,
		"platforms": sr.Def.Fields.Platforms, "content_formats": sr.Def.Fields.ContentFormats,
		"task_types": sr.Def.Fields.TaskTypes, "task_enabled": sr.Def.Fields.TaskEnabled,
		"agent_enabled": sr.Def.Fields.AgentEnabled, "status": sr.Def.Fields.Status,
		"revision": sr.Def.Revision, "scope": sr.Def.Scope,
	}
	merged := map[string]any{}
	for k, v := range before {
		merged[k] = v
	}
	for _, k := range []string{"name", "summary", "triggers", "instructions", "platforms",
		"content_formats", "task_types", "task_enabled", "agent_enabled", "status"} {
		if v, ok := args[k]; ok && v != nil {
			merged[k] = v
		}
	}
	fields, err := skillFieldsFromArgs(merged)
	if err != nil {
		return nil, nil, err
	}
	// 底稿合并后的完整字段写回参数，分发时构造完整 PUT 请求体（11.1 节）。
	for _, k := range []string{"name", "summary", "triggers", "instructions", "platforms", "content_formats", "task_types"} {
		args[k] = merged[k]
	}
	args["task_enabled"] = fields.TaskEnabled
	args["agent_enabled"] = fields.AgentEnabled
	args["status"] = fields.Status
	args["base_revision"] = sr.Def.Revision
	bindings, err := s.skillImpactBindings(ctx, sr.Def)
	if err != nil {
		return nil, nil, err
	}
	token, err := skillImpactToken(sr.Def.ID, sr.Def.Revision, "update", bindings)
	if err != nil {
		return nil, nil, err
	}
	args["impact_token"] = token
	if sr.Def.Scope == "personal" {
		delete(args, "publish_digest")
		return []agentChange{{Field: "scope", Label: "可见范围", After: "个人（仅本人）"}}, before, nil
	}
	digest, err := skillPublishDigest("update", &sr.Def.ID, sr.Def.Scope, sr.Def.AccountID, fields)
	if err != nil {
		return nil, nil, err
	}
	args["publish_digest"] = digest
	return []agentChange{{Field: "scope", Label: "可见范围", After: "公开（修改后需重新确认公开）"}}, before, nil
}

// skillsSetBindingPreview 读取指定分区的当前配置与 base_revision（8.4 节专用钩子）。
func skillsSetBindingPreview(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	_, err := uuid.Parse(agentArgStr(args, "accountId"))
	if err != nil {
		return nil, nil, err
	}
	audience := agentArgStr(args, "audience")
	skillID, err := uuid.Parse(agentArgStr(args, "skillId"))
	if err != nil {
		return nil, nil, err
	}
	var parts struct {
		Public struct {
			BaseRevision string           `json:"base_revision"`
			Items        []map[string]any `json:"items"`
		} `json:"public"`
		Mine struct {
			BaseRevision string           `json:"base_revision"`
			Items        []map[string]any `json:"items"`
		} `json:"mine"`
	}
	if before, ok := s.agentPreviewAt(ctx, st, t, args, "/accounts/{accountId}/skill-bindings"); ok {
		raw, _ := json.Marshal(before)
		_ = json.Unmarshal(raw, &parts)
	}
	fp := parts.Public.BaseRevision
	partition := "公共"
	if audience == "personal" {
		fp = parts.Mine.BaseRevision
		partition = "本人"
	}
	if fp == "" {
		return nil, nil, apiErr(409, "stale", "读取绑定分区失败，请刷新后重试")
	}
	args["base_revision"] = fp
	enabled, _ := args["enabled"].(bool)
	action := "停用"
	if enabled {
		action = "启用"
	}
	after := action + "（" + partition + "分区）"
	if enabled {
		if pr, ok := args["priority"]; ok {
			after += "，priority=" + agentItoa(int(toFloat(pr)))
		}
	}
	var current any
	items := parts.Public.Items
	if audience == "personal" {
		items = parts.Mine.Items
	}
	for _, it := range items {
		if it["skill_id"] == skillID.String() {
			current = it
		}
	}
	return []agentChange{{Field: "enabled", Label: "技能启用", Before: bindingEnabledText(current), After: after}}, nil, nil
}

func bindingEnabledText(current any) string {
	if current == nil {
		return "未启用"
	}
	m, _ := current.(map[string]any)
	if v, ok := m["priority"].(float64); ok {
		return "已启用（priority=" + agentItoa(int(v)) + "）"
	}
	return "已启用"
}

func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	}
	return 0
}

// skillsDeletePreview 冻结修订与影响集合（8.4 节）。
func skillsDeletePreview(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	id, err := uuid.Parse(agentArgStr(args, "id"))
	if err != nil {
		return nil, nil, err
	}
	sr, err := s.skillVisibleDef(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if sr.Def.Builtin {
		return nil, nil, apiErr(422, "immutable_skill", "内置技能不能删除")
	}
	bindings, err := s.skillImpactBindings(ctx, sr.Def)
	if err != nil {
		return nil, nil, err
	}
	token, err := skillImpactToken(sr.Def.ID, sr.Def.Revision, "delete", bindings)
	if err != nil {
		return nil, nil, err
	}
	args["base_revision"] = sr.Def.Revision
	args["impact_token"] = token
	return []agentChange{{Field: "affected_bindings", Label: "受影响绑定数",
		After: agentItoa(len(bindings))}}, nil, nil
}

// skillFieldsFromArgs 从卡片参数构造规范化 DefinitionFields（口径与 HTTP 一致）。
func skillFieldsFromArgs(args map[string]any) (SkillFields, error) {
	strs := func(key string) []string {
		raw, _ := json.Marshal(args[key])
		var arr []string
		_ = json.Unmarshal(raw, &arr)
		return arr
	}
	f := SkillFields{
		Name:           agentArgStr(args, "name"),
		Summary:        agentArgStr(args, "summary"),
		Triggers:       agentArgStr(args, "triggers"),
		Instructions:   agentArgStr(args, "instructions"),
		Platforms:      strs("platforms"),
		ContentFormats: strs("content_formats"),
		TaskTypes:      strs("task_types"),
		TaskEnabled:    true,
		AgentEnabled:   true,
		Status:         "active",
	}
	if v, ok := args["task_enabled"].(bool); ok {
		f.TaskEnabled = v
	}
	if v, ok := args["agent_enabled"].(bool); ok {
		f.AgentEnabled = v
	}
	if v, ok := args["status"].(string); ok && v != "" {
		f.Status = v
	}
	if err := validateSkillFields(&f); err != nil {
		return f, err
	}
	return f, nil
}

// skillsCreateEnrich / skillsUpdateEnrich 在执行前把冻结摘要参数移出请求体：
// 公开确认对象由执行层的人工字段组装，API 请求体只接受 publish_confirmation。
func skillsCreateEnrich(ctx context.Context, s *Server, st *agentRunState, t *AgentTool, args map[string]any) error {
	delete(args, "publish_digest")
	return nil
}

func skillsUpdateEnrich(ctx context.Context, s *Server, st *agentRunState, t *AgentTool, args map[string]any) error {
	delete(args, "publish_digest")
	return nil
}
