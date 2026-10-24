package app

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/google/uuid"
)

// DEV-SK3 / docs/23 第 8 节：智能体技能接入。
// 目录与已加载集合属于当前 run，保存在进程内存中，不持久化正文或映射；
// 服务重启后运行标记 interrupted，新 run 重新发现与加载（6.3、8.2 节）。

// skillCatalogRenderMax / 环境块预算常量见 skills.go。

// agentSkillCatalogItem 是目录里一个冻结条目：ref 永不重指（8.1 节）。
type agentSkillCatalogItem struct {
	Ref       string
	Def       *skillDef
	BindingID uuid.UUID
	Priority  int
}

// agentSkillContext 是一个运行 / 账号 / 作品 / 形态上下文的目录与已加载集合。
type agentSkillContext struct {
	CatalogID    uuid.UUID
	AccountID    uuid.UUID
	WorkID       *uuid.UUID
	TargetFormat string
	Items        []agentSkillCatalogItem // 入选集冻结顺序
	Loaded       []*agentSkillCatalogItem
	LoadedChars  int
}

// agentSkillRunState 是一次运行的技能状态：多个上下文目录 + 当前活动上下文。
type agentSkillRunState struct {
	mu         sync.Mutex
	Active     *agentSkillContext
	Contexts   map[string]*agentSkillContext
	ChangedErr error // 目录失效后停止使用的信号（8.1 节第 8 项）
}

func (rs *agentSkillRunState) contextKey(accountID uuid.UUID, workID *uuid.UUID, format string) string {
	key := accountID.String() + "|"
	if workID != nil {
		key += workID.String()
	}
	return key + "|" + format
}

// agentSkillStates 保存每个运行的状态；run 结束由 finishAgentRun 清理。
var agentSkillStates sync.Map // runID -> *agentSkillRunState

func agentSkillStateOf(runID uuid.UUID) *agentSkillRunState {
	if v, ok := agentSkillStates.Load(runID); ok {
		return v.(*agentSkillRunState)
	}
	rs := &agentSkillRunState{Contexts: map[string]*agentSkillContext{}}
	agentSkillStates.Store(runID, rs)
	return rs
}

// agentReleaseSkillState 在运行结束时丢弃内存中的目录与正文。
func agentReleaseSkillState(runID uuid.UUID) {
	agentSkillStates.Delete(runID)
}

// agentSkillEnsureContext 取（必要时建立）指定上下文的目录快照（8.1 节第 1 项）。
// 目录冻结 ≤20 个入选 ID / 修订 / 哈希 / 绑定与顺序，并分配 s1…sN 与随机 catalog_id。
func (s *Server) agentSkillEnsureContext(ctx context.Context, st *agentRunState, account *Account,
	workID *uuid.UUID, targetFormat string) (*agentSkillContext, error) {
	rs := agentSkillStateOf(st.RunID)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.ChangedErr != nil {
		return nil, rs.ChangedErr
	}
	key := rs.contextKey(account.ID, workID, targetFormat)
	if c, ok := rs.Contexts[key]; ok {
		return c, nil
	}
	in := SkillResolveInput{
		WorkspaceID: st.WorkspaceID, Account: account, ActorKind: "user", ActorUserID: &st.UserID,
		WorkID: workID, TargetFormat: targetFormat, Surface: "agent",
	}
	res, err := s.resolveSkillSet(ctx, in)
	if err != nil {
		return nil, err
	}
	c := &agentSkillContext{CatalogID: uuid.New(), AccountID: account.ID, WorkID: workID, TargetFormat: targetFormat}
	for i, it := range res.Selected {
		c.Items = append(c.Items, agentSkillCatalogItem{
			Ref: "s" + agentItoa(i+1), Def: it.Def, BindingID: it.BindingID, Priority: it.Priority,
		})
	}
	rs.Contexts[key] = c
	return c, nil
}

// agentSkillActive 返回当前活动上下文（可能为 nil：无账号或尚未发现）。
func agentSkillActive(runID uuid.UUID) *agentSkillContext {
	rs := agentSkillStateOf(runID)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.Active
}

// agentSkillCatalogByRef 在指定目录中按引用号查找条目。
func agentSkillCatalogByRef(c *agentSkillContext, ref string) *agentSkillCatalogItem {
	for i := range c.Items {
		if c.Items[i].Ref == ref {
			return &c.Items[i]
		}
	}
	return nil
}

// agentSkillZoneHeader 是可信技能区的标题与声明（8.2 节）：与 AI 任务槽共用声明口径，
// 但标题明确为「用户已配置技能」，固定系统规则授权这一受限来源。
func agentSkillZoneHeader() string { return "## 用户已配置技能\n" + skillSlotDeclaration + "\n" }

// agentSkillLoadedText 组装当前上下文已加载技能的可信指令区文本（8.2 节）。
func agentSkillLoadedText(c *agentSkillContext) (string, int) {
	if c == nil || len(c.Loaded) == 0 {
		return "", 0
	}
	var b strings.Builder
	b.WriteString(agentSkillZoneHeader())
	chars := runeLen(b.String())
	for _, it := range c.Loaded {
		text := skillSlotItemText(it.Def.Fields)
		b.WriteString(text)
		chars += runeLen(text)
	}
	return b.String(), chars
}

// agentSkillLoad 实现元工具 load_skill（8.2 节）：只回执，正文进可信指令区。
// 返回回执 payload；错误以 APIError 表达（unknown_skill_ref / skill_budget_exceeded /
// skill_context_changed）。
func (s *Server) agentSkillLoad(ctx context.Context, st *agentRunState, account *Account,
	args map[string]any) (map[string]any, error) {
	rs := agentSkillStateOf(st.RunID)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.ChangedErr != nil {
		return nil, rs.ChangedErr
	}
	ref, _ := args["skill_ref"].(string)
	catalogID, _ := args["catalog_id"].(string)
	cid, err := uuid.Parse(catalogID)
	if err != nil {
		return nil, apiErr(422, "unknown_skill_ref", "catalog_id 无效，请用 get_context 获取当前目录")
	}
	// 目录必须属于当前运行；正文永不通过失败响应返回。
	var target *agentSkillContext
	for _, c := range rs.Contexts {
		if c.CatalogID == cid {
			target = c
			break
		}
	}
	if target == nil {
		return nil, apiErr(422, "unknown_skill_ref", "catalog_id 不属于当前运行")
	}
	item := agentSkillCatalogByRef(target, ref)
	if item == nil {
		return nil, apiErr(422, "unknown_skill_ref", "skill_ref 不在这个目录中")
	}
	// WorkID 缺省明确表示账号默认上下文，不能沿用上一次作品。
	var workID *uuid.UUID
	if v, _ := args["work_id"].(string); v != "" {
		wid, err := uuid.Parse(v)
		if err != nil {
			return nil, apiErr(422, "unknown_skill_ref", "work_id 无效")
		}
		workID = &wid
	}
	// 指定作品必须属于对话账号；目录上下文与 WorkID 必须一致。
	if (target.WorkID == nil) != (workID == nil) || (workID != nil && *target.WorkID != *workID) {
		return nil, apiErr(422, "unknown_skill_ref", "work_id 与目录上下文不一致")
	}
	if workID != nil {
		var wf string
		if err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`,
			*workID, target.AccountID).Scan(&wf); err != nil {
			return nil, apiErr(422, "unknown_skill_ref", "作品不属于当前账号或不存在")
		}
	}
	// 加载前复核目录资格（8.2 节权限行）：统一解析器核验绑定 / 定义 / 入口 / 形态。
	in := SkillResolveInput{
		WorkspaceID: st.WorkspaceID, Account: account, ActorKind: "user", ActorUserID: &st.UserID,
		WorkID: target.WorkID, TargetFormat: target.TargetFormat, Surface: "agent",
	}
	res, err := s.resolveSkillSet(ctx, in)
	if err != nil {
		return nil, err
	}
	stillSelected := false
	for _, it := range res.Selected {
		if it.Def.ID == item.Def.ID && it.BindingID == item.BindingID {
			stillSelected = true
			break
		}
	}
	if !stillSelected || item.Def.Fields.Status != "active" || !item.Def.Fields.AgentEnabled {
		return nil, skillContextChanged()
	}
	// 幂等：同一上下文、同一 ID / 修订重复请求不重复追加。
	for _, loaded := range target.Loaded {
		if loaded.Def.ID == item.Def.ID {
			if loaded.Def.Revision != item.Def.Revision {
				return nil, skillContextChanged()
			}
			return agentSkillReceipt(target, item, "loaded", 0), nil
		}
	}
	text := skillSlotItemText(item.Def.Fields)
	headerChars := 0
	if len(target.Loaded) == 0 {
		headerChars = runeLen(agentSkillZoneHeader())
	}
	if target.LoadedChars+headerChars+runeLen(text) > skillSlotBudget {
		return nil, apiErr(422, "skill_budget_exceeded", "已加载技能的指令区已满，无法再装入这一条")
	}
	// 成功后原子切换活动上下文并清空旧集合（8.2 节上下文切换行）：
	// 切换到另一上下文时新上下文的已加载集合本来独立；同一上下文内只追加。
	target.Loaded = append(target.Loaded, item)
	target.LoadedChars += runeLen(text)
	rs.Active = target
	return agentSkillReceipt(target, item, "loaded", runeLen(text)), nil
}

func agentSkillReceipt(c *agentSkillContext, item *agentSkillCatalogItem, status string, chars int) map[string]any {
	var workID any
	if c.WorkID != nil {
		workID = *c.WorkID
	}
	return map[string]any{
		"ok": true, "status": status, "skill_id": item.Def.ID, "name": item.Def.Fields.Name,
		"revision": item.Def.Revision, "content_hash": item.Def.contentHash(),
		"catalog_id": c.CatalogID, "work_id": workID, "chars": chars,
	}
}

// agentSkillVerifyActive 每轮及备用模型重试前复核当前活动目录（8.2 节失效行）。
// 修订、解绑 / 重绑、priority、停用、删除、资格或目标形态变化时返回
// skill_context_changed，停止运行；未入选技能变化留待新 run。
func (s *Server) agentSkillVerifyActive(ctx context.Context, st *agentRunState, account *Account) error {
	rs := agentSkillStateOf(st.RunID)
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rs.ChangedErr != nil {
		return rs.ChangedErr
	}
	c := rs.Active
	if c == nil {
		return nil
	}
	if account == nil || c.AccountID != account.ID {
		return skillContextChanged()
	}
	in := SkillResolveInput{
		WorkspaceID: st.WorkspaceID, Account: account, ActorKind: "user", ActorUserID: &st.UserID,
		WorkID: c.WorkID, TargetFormat: c.TargetFormat, Surface: "agent",
	}
	res, err := s.resolveSkillSet(ctx, in)
	if err != nil {
		return err
	}
	live := map[uuid.UUID]SkillResolvedItem{}
	for _, it := range res.Selected {
		live[it.Def.ID] = it
	}
	for _, item := range c.Items {
		lv, ok := live[item.Def.ID]
		if !ok || lv.BindingID != item.BindingID || lv.Priority != item.Priority ||
			lv.Def.Revision != item.Def.Revision || lv.Def.Fields.Status != "active" {
			rs.ChangedErr = skillContextChanged()
			return rs.ChangedErr
		}
	}
	// 已加载集合仍须逐条有效（更严格：加载后再失效同样停止）。
	for _, loaded := range c.Loaded {
		lv, ok := live[loaded.Def.ID]
		if !ok || lv.Def.Revision != loaded.Def.Revision {
			rs.ChangedErr = skillContextChanged()
			return rs.ChangedErr
		}
	}
	return nil
}

// agentEnvSkillSection 构造环境块的技能目录（8.1 节第 2 项）：
// 只渲染前 8 条，且目录连同键名、JSON 转义与遗漏说明按最终序列化 ≤600，只保留完整条目。
func agentEnvSkillSection(c *agentSkillContext) *agentEnvSkills {
	if c == nil || len(c.Items) == 0 {
		return nil
	}
	sec := &agentEnvSkills{CatalogID: c.CatalogID.String(), Items: []agentEnvSkillItem{}}
	omitted := len(c.Items)
	for i, item := range c.Items {
		if i >= skillCatalogRenderMax {
			break
		}
		// 试探加入一条后按最终序列化检查预算；超出则不保留该条（只保留完整条目）。
		cand := &agentEnvSkills{CatalogID: sec.CatalogID, Omitted: omitted - 1,
			OmittedNote: "还有 " + agentItoa(omitted-1) + " 条，可用 skills__list 的 effective 视图查询",
			Items: append(append([]agentEnvSkillItem{}, sec.Items...), agentEnvSkillItem{
				Ref: item.Ref, Name: item.Def.Fields.Name, Hint: skillCatalogHint(item.Def.Fields)})}
		if runeLen(agentSkillSectionJSON(cand)) > skillCatalogBudget {
			break
		}
		sec = cand
		omitted--
	}
	if sec.Omitted > 0 {
		sec.OmittedNote = "还有 " + agentItoa(sec.Omitted) + " 条，可用 skills__list 的 effective 视图查询"
	}
	return sec
}

// skillCatalogBudget 是目录段的序列化字符预算（8.1 节第 2 项）。
const skillCatalogBudget = 600

// agentSkillSectionJSON 序列化目录段（含包装键名的最终口径）。
func agentSkillSectionJSON(sec *agentEnvSkills) string {
	b, err := json.Marshal(map[string]any{"skills": sec})
	if err != nil {
		return ""
	}
	return string(b)
}

// agentEnvSkills 是环境块的技能目录载荷（8.1 节第 1 项）。
type agentEnvSkills struct {
	CatalogID   string              `json:"catalog_id"`
	Items       []agentEnvSkillItem `json:"items"`
	Omitted     int                 `json:"omitted"`
	OmittedNote string              `json:"omitted_note,omitempty"`
}

type agentEnvSkillItem struct {
	Ref  string `json:"ref"`
	Name string `json:"name"`
	Hint string `json:"hint"`
}

// agentSkillsForToolList 是 skills__list effective 视图在运行内的返回。
func (s *Server) agentSkillEffectiveItems(ctx context.Context, st *agentRunState, account *Account,
	workID *uuid.UUID, targetFormat string) (catalogID string, items []map[string]any, err error) {
	c, err := s.agentSkillEnsureContext(ctx, st, account, workID, targetFormat)
	if err != nil {
		return "", nil, err
	}
	items = []map[string]any{}
	for _, item := range c.Items {
		items = append(items, map[string]any{
			"id": item.Def.ID, "ref": item.Ref, "name": item.Def.Fields.Name,
			"hint": skillCatalogHint(item.Def.Fields), "scope": item.Def.Scope,
			"revision": item.Def.Revision, "content_hash": item.Def.contentHash(), "priority": item.Priority,
		})
	}
	return c.CatalogID.String(), items, nil
}

// agentSkillsGetContextSummary 是 get_context 的技能摘要（8.2 节）：
// {catalog_id,work_id,loaded_refs,chars,budget}。
func agentSkillsGetContextSummary(runID uuid.UUID) map[string]any {
	c := agentSkillActive(runID)
	if c == nil {
		return nil
	}
	refs := []string{}
	for _, it := range c.Loaded {
		refs = append(refs, it.Ref)
	}
	var workID any
	if c.WorkID != nil {
		workID = *c.WorkID
	}
	return map[string]any{
		"catalog_id": c.CatalogID, "work_id": workID,
		"loaded_refs": refs, "chars": c.LoadedChars, "budget": skillSlotBudget,
	}
}

// agentSkillEnvJSON 供测试与 get_context 复用的目录 JSON。
func agentSkillEnvJSON(c *agentSkillContext) json.RawMessage {
	sec := agentEnvSkillSection(c)
	if sec == nil {
		return json.RawMessage("null")
	}
	b, _ := json.Marshal(sec)
	return b
}
