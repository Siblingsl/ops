package app

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-SK1 / docs/23：技能系统统一生效模型。
// 权限判断、归属解析、过滤、排序、修订与排除原因只在本文件实现（第 3.3 节）；
// contextpack、智能体目录、加载元工具与页面预览都调用这里，不各写一套。

const (
	skillInstructionLimit = 1200 // 单技能正文字数上限（4.1）
	skillSlotBudget       = 3600 // 技能槽总预算（7.1 / 16.4 二次裁决）
	skillEffectiveLimit   = 20   // 入选集上限（6.1）
	skillCatalogRenderMax = 8    // 智能体环境块目录渲染上限（8.1）
	skillHintLimit        = 40   // 目录 hint 字数（8.1）
	skillWorkspaceLimit   = 50   // 每工作区定义上限（3.1）
	skillAccountLimit     = 30   // 每账号定义上限
	skillPersonalLimit    = 50   // 每人个人定义上限
	skillBindingLimit     = 20   // 公共 / 本人绑定每分区上限（3.2）
	skillNameMax          = 30
	skillSummaryMax       = 60
	skillTriggerMax       = 120
	skillImportMaxBytes   = 64 << 10 // .md 原始文件上限（4.2）
	skillJSONMaxBytes     = 128 << 10
)

// skillTaskC0 是默认创作集合（6.2 节，16.4 二次裁决 18 项）：空 task_types 时生效。
var skillTaskC0 = []string{
	"outline", "section_draft", "section_edit", "title", "summary", "rewrite_plan",
	"section_rewrite", "comic_storyboard", "comic_panel_text", "comic_rewrite",
	"section_continue", "hook_suggest", "topic_suggest", "topic_hot_suggest",
	"image_suggest", "organize_notes", "daily_recommend", "strategy_outline",
}

// skillTaskC1 是可显式选用的辅助集合：必须逐项出现在 task_types 才生效。
var skillTaskC1 = []string{
	"tag_suggest", "outline_review", "read_through", "polish_check",
	"fix_suggest", "layout_suggest", "copilot_chat",
}

var skillTaskAllowedSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range append(append([]string{}, skillTaskC0...), skillTaskC1...) {
		m[t] = true
	}
	return m
}()

var skillTaskDefaultSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range skillTaskC0 {
		m[t] = true
	}
	return m
}()

// skillTaskAllowed 判断任务是否在技能允许清单（6.2 节）。image_gen、embedding、
// agent_chat 等内部 / 路由任务不在清单内，不做技能注入。
func skillTaskAllowed(taskType string) bool { return skillTaskAllowedSet[taskType] }

// skillTaskApplicable 判断具体任务是否命中某技能的 task_types 配置（空 = 默认 C0）。
func skillTaskApplicable(f SkillFields, taskType string) bool {
	if len(f.TaskTypes) == 0 {
		return skillTaskDefaultSet[taskType]
	}
	for _, t := range f.TaskTypes {
		if t == taskType {
			return true
		}
	}
	return false
}

// ---------- 定义与候选 ----------

// SkillFields 是 DraftFields + status（11.1 节 DefinitionFields）。
type SkillFields struct {
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    bool     `json:"task_enabled"`
	AgentEnabled   bool     `json:"agent_enabled"`
	Status         string   `json:"status,omitempty"`
}

// skillDef 是统一解析器看到的定义（DB 行或内置注册表）。
type skillDef struct {
	ID          uuid.UUID
	Builtin     bool
	BuiltinKey  string
	Scope       string // builtin | workspace | account | personal
	WorkspaceID *uuid.UUID
	UserID      *uuid.UUID
	AccountID   *uuid.UUID
	Fields      SkillFields
	Revision    int64
	Origin      string
	SourceKey   string
	ContentHash string
}

func (d *skillDef) contentHash() string {
	if d.ContentHash == "" {
		d.ContentHash = skillContentHash(d.Fields)
	}
	return d.ContentHash
}

// 层序：个人→账号→工作区→内置（6.1 节第 5 项）。
func skillLayer(d *skillDef, accountID uuid.UUID) int {
	switch {
	case d.Scope == "personal":
		return 0
	case d.AccountID != nil && *d.AccountID == accountID:
		return 1
	case d.WorkspaceID != nil:
		return 2
	default:
		return 3
	}
}

// 排除原因码（6.1 节）。
const (
	skillReasonRetired   = "builtin_retired"
	skillReasonDisabled  = "disabled"
	skillReasonTaskOff   = "task_disabled"
	skillReasonAgentOff  = "agent_disabled"
	skillReasonPlatform  = "platform_mismatch"
	skillReasonFormat    = "format_mismatch"
	skillReasonTask      = "task_mismatch"
	skillReasonLimit     = "candidate_limit"
	skillReasonBudget    = "budget_exceeded"
	skillReasonNotLoaded = "not_loaded"
)

// SkillResolveInput 是统一解析器输入（6.1 节）。身份由服务端组成，
// 不接受客户端指定 ActorKind / ActorUserID / Preview。
type SkillResolveInput struct {
	WorkspaceID  uuid.UUID
	Account      *Account
	ActorKind    string // "user" | "system"
	ActorUserID  *uuid.UUID
	WorkID       *uuid.UUID
	TargetFormat string
	Surface      string // "task" | "agent"
	TaskType     string
	Bare         bool
	Preview      bool
}

// SkillResolvedItem 是候选集一项：绑定信息 + 定义 + 首个排除原因（""=通过过滤）。
type SkillResolvedItem struct {
	Def       *skillDef
	BindingID uuid.UUID
	Priority  int
	Layer     int
	CreatedAt time.Time
	Reason    string
	Selected  bool
}

type SkillResolveResult struct {
	Items    []SkillResolvedItem // 候选集（含未入选原因）
	Selected []SkillResolvedItem // 入选集 ≤20（过滤通过、去重、排序后）
}

// resolveSkillSet 是唯一生效集解析器（6.1 节）。数据库读取失败明确失败，
// 不静默当作“无绑定”；无账号、Bare、不支持技能的任务不注入也不查询技能表。
func (s *Server) resolveSkillSet(ctx context.Context, in SkillResolveInput) (*SkillResolveResult, error) {
	return s.resolveSkillSetQ(ctx, s.db, in)
}

// skillQuerier 是解析器可用的最小查询接口：统一解析、快照与复核共用，
// 使快照能整体在 REPEATABLE READ 事务内读取（6.3 节）。
type skillQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Server) resolveSkillSetQ(ctx context.Context, q skillQuerier, in SkillResolveInput) (*SkillResolveResult, error) {
	res := &SkillResolveResult{Items: []SkillResolvedItem{}, Selected: []SkillResolvedItem{}}
	if in.Account == nil || in.Bare {
		return res, nil
	}
	if in.Surface == "task" && (in.TaskType == "" || !skillTaskAllowed(in.TaskType)) {
		return res, nil
	}
	if in.Surface != "task" && in.Surface != "agent" {
		return nil, fmt.Errorf("技能解析 Surface 非法")
	}
	if in.ActorKind != "user" && in.ActorKind != "system" {
		return nil, fmt.Errorf("技能解析执行主体非法")
	}
	if in.ActorKind == "system" && in.ActorUserID != nil {
		return nil, fmt.Errorf("系统执行不得携带个人身份")
	}

	type row struct {
		bindingID uuid.UUID
		priority  int
		createdAt time.Time
		audience  *uuid.UUID
		builtin   string
		def       *skillDef
	}

	// 内置绑定没有 skill 行；LEFT JOIN 的占位列不参与内置定义解析，真实字段从注册表读取。
	sql := `SELECT b.id, b.priority, b.created_at, b.audience_user_id, b.builtin_key,
		sk.id, sk.workspace_id, sk.user_id, sk.account_id, COALESCE(sk.name,''), COALESCE(sk.summary,''), COALESCE(sk.triggers,''),
		COALESCE(sk.instructions,''), sk.platforms, sk.content_formats, sk.task_types,
		COALESCE(sk.task_enabled,false), COALESCE(sk.agent_enabled,false), COALESCE(sk.status,''), COALESCE(sk.revision,0), COALESCE(sk.origin,''), COALESCE(sk.source_key,'')
		FROM skill_binding b LEFT JOIN skill sk ON sk.id = b.skill_id
		WHERE b.account_id = $1`
	args := []any{in.Account.ID}
	if in.ActorKind == "user" && in.ActorUserID != nil {
		sql += ` AND (b.audience_user_id IS NULL OR b.audience_user_id = $2)`
		args = append(args, *in.ActorUserID)
	} else {
		sql += ` AND b.audience_user_id IS NULL`
	}
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var candidates []row
	for rows.Next() {
		var r row
		var (
			id, wsID, userID, accID               *uuid.UUID
			name, summary, triggers, instructions string
			platforms, formats, taskTypes         []string
			taskOn, agentOn                       bool
			status                                string
			revision                              int64
			origin, sourceKey                     string
		)
		if err := rows.Scan(&r.bindingID, &r.priority, &r.createdAt, &r.audience, &r.builtin,
			&id, &wsID, &userID, &accID, &name, &summary, &triggers, &instructions,
			&platforms, &formats, &taskTypes, &taskOn, &agentOn, &status, &revision, &origin, &sourceKey); err != nil {
			return nil, err
		}
		if id == nil {
			// 内置绑定：按规范 key 解析；解析器拒绝未知 key（5.3 节退役）。
			def := skillBuiltinByKey(r.builtin)
			if def == nil {
				def = &skillDef{Builtin: true, BuiltinKey: r.builtin, Scope: "builtin",
					Fields:   SkillFields{Name: r.builtin, Status: "active", TaskEnabled: true, AgentEnabled: true},
					Revision: 0, Origin: "builtin", SourceKey: r.builtin}
				r.def = def
				r.def.ContentHash = ""
				candidates = append(candidates, r)
				continue
			}
			r.def = def
		} else {
			r.def = &skillDef{
				ID: *id, Scope: scopeOfSkill(wsID, userID, accID),
				WorkspaceID: wsID, UserID: userID, AccountID: accID,
				Fields: SkillFields{Name: name, Summary: summary, Triggers: triggers, Instructions: instructions,
					Platforms: normalizeEnumArray(platforms), ContentFormats: normalizeEnumArray(formats),
					TaskTypes: normalizeEnumArray(taskTypes), TaskEnabled: taskOn, AgentEnabled: agentOn, Status: status},
				Revision: revision, Origin: origin, SourceKey: sourceKey,
			}
		}
		candidates = append(candidates, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, r := range candidates {
		def := r.def
		item := SkillResolvedItem{Def: def, BindingID: r.bindingID, Priority: r.priority,
			Layer: skillLayer(def, in.Account.ID), CreatedAt: r.createdAt}
		// 归属校验（5.1 节第 2 项）：仅凭外键存在不代表有权引用；异常归属按内部错误明确失败。
		switch {
		case r.audience == nil:
			if !def.Builtin && def.WorkspaceID == nil && (def.AccountID == nil || *def.AccountID != in.Account.ID) {
				return nil, fmt.Errorf("技能归属异常，拒绝解析")
			}
			if !def.Builtin && def.WorkspaceID != nil && *def.WorkspaceID != in.WorkspaceID {
				return nil, fmt.Errorf("技能归属异常，拒绝解析")
			}
		default:
			if def.Scope != "personal" || def.UserID == nil || r.audience == nil ||
				*def.UserID != *r.audience || (in.ActorUserID != nil && *r.audience != *in.ActorUserID) {
				return nil, fmt.Errorf("技能归属异常，拒绝解析")
			}
		}
		// 过滤顺序（6.1 节）：builtin_retired→disabled→task_disabled/agent_disabled→
		// platform→format→task。每项只给首个排除原因。
		switch {
		case def.Builtin && def.Revision == 0:
			item.Reason = skillReasonRetired
		case def.Fields.Status != "active":
			item.Reason = skillReasonDisabled
		case in.Surface == "task" && !def.Fields.TaskEnabled:
			item.Reason = skillReasonTaskOff
		case in.Surface == "agent" && !def.Fields.AgentEnabled:
			item.Reason = skillReasonAgentOff
		case len(def.Fields.Platforms) > 0 && !strIn(def.Fields.Platforms, in.Account.Platform):
			item.Reason = skillReasonPlatform
		case !skillMatchesTarget(def.Fields, in.Account.Platform, in.TargetFormat):
			item.Reason = skillReasonFormat
		case in.Surface == "task" && !skillTaskApplicable(def.Fields, in.TaskType):
			item.Reason = skillReasonTask
		}
		res.Items = append(res.Items, item)
	}

	// 排序（6.1 节第 5 项）：层→priority 升序→绑定创建时间→技能 UUID。
	// 候选集（含被排除项）统一按该键排序，入选集为其中过滤通过、去重后的前 20；
	// 上下文预览按同一顺序展示候选与排除原因。
	items := res.Items
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Layer != b.Layer {
			return a.Layer < b.Layer
		}
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.Before(b.CreatedAt)
		}
		return a.Def.ID.String() < b.Def.ID.String()
	})
	seen := map[uuid.UUID]bool{}
	for _, it := range items {
		if seen[it.Def.ID] {
			continue
		}
		seen[it.Def.ID] = true
		if it.Reason != "" {
			continue
		}
		if len(res.Selected) < skillEffectiveLimit {
			it.Selected = true
			res.Selected = append(res.Selected, it)
		} else {
			// 超出入选上限的过滤通过项标记 candidate_limit，不伪装成已注入。
			for i := range res.Items {
				if res.Items[i].Def.ID == it.Def.ID && res.Items[i].Reason == "" {
					res.Items[i].Reason = skillReasonLimit
					break
				}
			}
		}
	}
	return res, nil
}

func scopeOfSkill(wsID, userID, accID *uuid.UUID) string {
	switch {
	case userID != nil:
		return "personal"
	case accID != nil:
		return "account"
	case wsID != nil:
		return "workspace"
	default:
		return "builtin"
	}
}

func strIn(arr []string, v string) bool {
	for _, s := range arr {
		if s == v {
			return true
		}
	}
	return false
}

// skillMatchesTarget 实际匹配必须同时满足目标平台与目标形态（4.1.1 节第 3 项）。
func skillMatchesTarget(f SkillFields, platform, format string) bool {
	if len(f.Platforms) > 0 && !strIn(f.Platforms, platform) {
		return false
	}
	if len(f.ContentFormats) > 0 && !strIn(f.ContentFormats, format) {
		return false
	}
	return validFormat(platform, format)
}

// ---------- 字段规范化与校验（4.1.1 节） ----------

// normalizeEnumArray 去重并按 UTF-8 字节序升序（4.1.1 节第 2 项）。
func normalizeEnumArray(a []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(a))
	for _, v := range a {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// normalizeSkillText 统一 CRLF/CR→LF；name/summary/triggers 去首尾 Unicode 空白并禁止
// 内嵌换行与控制字符；instructions 保留空白但 TrimSpace 不得为空。
func normalizeSkillText(f *SkillFields) error {
	normLine := func(s string) (string, error) {
		s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
		s = strings.TrimFunc(s, func(r rune) bool {
			return r == ' ' || r == '\t' || r == 0x3000 || r == '\n' || r == 0x00A0 || r == 0x2028 || r == 0x2029 ||
				(r >= 0x2000 && r <= 0x200A)
		})
		for _, r := range s {
			if r == '\n' || (r >= 0x00 && r <= 0x1F) || r == 0x7F {
				return "", validation("技能文本不能包含换行或控制字符")
			}
		}
		return s, nil
	}
	var err error
	if f.Name, err = normLine(f.Name); err != nil {
		return err
	}
	if f.Summary, err = normLine(f.Summary); err != nil {
		return err
	}
	if f.Triggers, err = normLine(f.Triggers); err != nil {
		return err
	}
	f.Instructions = strings.ReplaceAll(strings.ReplaceAll(f.Instructions, "\r\n", "\n"), "\r", "\n")
	return nil
}

func skillTextHasControl(s string) bool {
	for _, r := range s {
		if r == '\n' || (r >= 0x00 && r <= 0x1F) || r == 0x7F {
			return true
		}
	}
	return false
}

// validateSkillFields 是纯字段校验（类型、长度、枚举、入口组合、平台组合）；
// 密钥检测在调用方统一执行（10.1 节分工）。
func validateSkillFields(f *SkillFields) error {
	if err := normalizeSkillText(f); err != nil {
		return err
	}
	// 适用数组去重并按 UTF-8 字节序升序保存（4.1.1 节第 2 项）。
	f.Platforms = normalizeEnumArray(f.Platforms)
	f.ContentFormats = normalizeEnumArray(f.ContentFormats)
	f.TaskTypes = normalizeEnumArray(f.TaskTypes)
	switch {
	case f.Name == "" || runeLen(f.Name) > skillNameMax:
		return validationFields("技能名称需要 1–30 字", map[string]string{"name": "invalid"})
	case f.Summary == "" || runeLen(f.Summary) > skillSummaryMax:
		return validationFields("技能用途需要 1–60 字", map[string]string{"summary": "invalid"})
	case f.Triggers == "" || runeLen(f.Triggers) > skillTriggerMax:
		return validationFields("触发说明需要 1–120 字", map[string]string{"triggers": "invalid"})
	case strings.TrimSpace(f.Instructions) == "":
		return validationFields("技能正文不能为空", map[string]string{"instructions": "invalid"})
	case runeLen(f.Instructions) > skillInstructionLimit:
		return validationFields(fmt.Sprintf("技能正文最多 %d 字", skillInstructionLimit), map[string]string{"instructions": "invalid"})
	}
	for _, s := range []string{f.Name, f.Summary, f.Triggers} {
		if skillTextHasControl(s) {
			return validation("技能名称、用途与触发说明不能包含换行或控制字符")
		}
	}
	if f.Status != "active" && f.Status != "disabled" {
		return validationFields("技能状态只能是 active 或 disabled", map[string]string{"status": "invalid"})
	}
	if !f.TaskEnabled && !f.AgentEnabled {
		return validationFields("生成与智能体入口不能同时关闭", map[string]string{"task_enabled": "invalid", "agent_enabled": "invalid"})
	}
	for _, p := range f.Platforms {
		if _, ok := formatMatrix[p]; !ok {
			return validationFields("平台不在支持清单", map[string]string{"platforms": "invalid"})
		}
	}
	formatSet := map[string]bool{}
	for _, fs := range formatMatrix {
		for _, fm := range fs {
			formatSet[fm] = true
		}
	}
	for _, fm := range f.ContentFormats {
		if !formatSet[fm] {
			return validationFields("作品形态不在支持清单", map[string]string{"content_formats": "invalid"})
		}
	}
	if err := validateSkillCombos(f.Platforms, f.ContentFormats); err != nil {
		return err
	}
	for _, t := range f.TaskTypes {
		if !skillTaskAllowed(t) {
			return validationFields("任务不在技能允许清单", map[string]string{"task_types": "invalid"})
		}
	}
	return nil
}

// validateSkillCombos：每个显式平台和显式形态都必须至少参与一个有效组合（4.1.1 节第 3 项）。
func validateSkillCombos(platforms, formats []string) error {
	for _, p := range platforms {
		ok := false
		if len(formats) == 0 {
			ok = len(formatMatrix[p]) > 0
		} else {
			for _, fm := range formats {
				if validFormat(p, fm) {
					ok = true
					break
				}
			}
		}
		if !ok {
			return validationFields("所选平台与作品形态没有有效组合", map[string]string{"platforms": "invalid", "content_formats": "invalid"})
		}
	}
	for _, fm := range formats {
		ok := false
		if len(platforms) == 0 {
			for p := range formatMatrix {
				if validFormat(p, fm) {
					ok = true
					break
				}
			}
		} else {
			for _, p := range platforms {
				if validFormat(p, fm) {
					ok = true
					break
				}
			}
		}
		if !ok {
			return validationFields("所选作品形态与平台没有有效组合", map[string]string{"platforms": "invalid", "content_formats": "invalid"})
		}
	}
	return nil
}

// checkSkillSecrets 复用既有密钥检测（10.1 节第 ① 项），覆盖全部文本字段。
func (s *Server) checkSkillSecrets(ctx context.Context, wsID uuid.UUID, f SkillFields) error {
	secrets := s.agentSecretValues(ctx, wsID)
	for field, text := range map[string]string{
		"name": f.Name, "summary": f.Summary, "triggers": f.Triggers, "instructions": f.Instructions,
	} {
		if agentContainsSecret(text, secrets) {
			return apiErr(422, "skill_secret_detected", "内容疑似包含密钥，请删除后重试（不会保存或回显原文）").With(map[string]string{"field": field})
		}
	}
	return nil
}

// ---------- 目标形态与装配 ----------

// skillResolveTargetFormat 落实 6.1 节第 1 项：有 WorkID 取作品形态（并校验归属），
// 显式 TargetFormat 与作品不一致返回 422，否则账号默认。返回形态与实际使用的作品 ID。
func (s *Server) skillResolveTargetFormat(ctx context.Context, account *Account, workID *uuid.UUID, explicit string) (string, error) {
	if workID != nil {
		var wf string
		err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`,
			*workID, account.ID).Scan(&wf)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errNotFound
		}
		if err != nil {
			return "", err
		}
		if explicit != "" && explicit != wf {
			return "", validation("目标形态与作品实际形态不一致")
		}
		return wf, nil
	}
	if explicit != "" {
		if !validFormat(account.Platform, explicit) {
			return "", validation("目标形态对该平台无效")
		}
		return explicit, nil
	}
	return account.ContentFormat, nil
}

// skillSlotItem 是装配后的逐项留痕（7.2 节 Slot 语义的技能扩展）。
type skillSlotItem struct {
	Def    *skillDef
	Chars  int // 该项实际加入指令区的增量字符数（未使用为 0）
	Used   bool
	Reason string // 预算阶段 budget_exceeded；装配前已排除的沿用解析原因
}

// skillSlotDeclaration 是代码固定生成的技能声明（7.1 节）：只指导方法，低于权限、
// 系统规则、输出契约、模板结构及账号硬约束；本次明确写法要求优先于技能。
const skillSlotDeclaration = "以下「写作技能」来自账号配置，只指导写作方法：优先级低于系统规则、任务输出要求、模板结构与账号硬约束；作者本次明确提出的写法要求优先于技能内容。技能按个人→账号→工作区→内置及同层优先级依次列出，软写法冲突时排在前面的技能优先，后项不得覆盖前项。产生多个候选时，每个候选都遵守同一优先关系，不以候选多样性为由忽略适用技能。"

// skillSlotHeader / skillSlotItemPrefix 构成槽位包装；预算以最终字符串 rune 数为准。
func skillSlotHeader() string { return "## 写作技能\n" + skillSlotDeclaration + "\n" }
func skillSlotFooter() string { return "\n以上技能指令结束。" + skillSlotDeclaration + "\n" }

func skillSlotItemText(f SkillFields) string {
	return "### " + f.Name + "\n" + f.Instructions + "\n\n"
}

// assembleSkillSlot 按入选顺序逐条尝试完整装入（7.1 节）：装不下标记
// used=false / reason=budget_exceeded，可继续尝试后续较短技能；不截短正文。
// 返回最终槽位文本（空表示不输出任何技能内容）、逐项留痕与总字符数。
func assembleSkillSlot(items []SkillResolvedItem) (string, []skillSlotItem, int) {
	if len(items) == 0 {
		return "", nil, 0
	}
	header := skillSlotHeader()
	var b strings.Builder
	b.WriteString(header)
	total := runeLen(header) + runeLen(skillSlotFooter())
	trace := make([]skillSlotItem, 0, len(items))
	usedAny := false
	for _, it := range items {
		if it.Reason != "" {
			trace = append(trace, skillSlotItem{Def: it.Def, Chars: 0, Used: false, Reason: it.Reason})
			continue
		}
		text := skillSlotItemText(it.Def.Fields)
		n := runeLen(text)
		if total+n > skillSlotBudget {
			trace = append(trace, skillSlotItem{Def: it.Def, Chars: 0, Used: false, Reason: skillReasonBudget})
			continue
		}
		b.WriteString(text)
		total += n
		usedAny = true
		trace = append(trace, skillSlotItem{Def: it.Def, Chars: n, Used: true})
	}
	if !usedAny {
		// 无实际使用技能时不输出空标题或声明（7.1 节第 3 项）。
		return "", trace, 0
	}
	b.WriteString(skillSlotFooter())
	return b.String(), trace, total
}
