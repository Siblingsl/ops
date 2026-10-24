package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-SK2 / docs/23 第 6.3、7 节：一次用户动作一个技能快照、发送前复核与隐私拆分。

// skillAllowedSetVersion 是代码内置的允许清单版本（快照证据字段；清单变化随版本发布）。
const skillAllowedSetVersion = "sk-c0.18-c1.7-v1"

// SkillUseItem 是装配留痕与持久化回执共用的逐项记录（11.2 节 SkillUseItem）。
type SkillUseItem struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Scope       string    `json:"scope"`
	Revision    int64     `json:"revision"`
	ContentHash string    `json:"content_hash"`
	Selected    bool      `json:"selected"`
	Used        bool      `json:"used"`
	Reason      *string   `json:"reason"`
	Chars       int       `json:"chars"`
	Seq         int       `json:"seq"` // 候选顺序，用于本人回执合并
}

// SkillSnapshot 固定一次动作的身份、目标形态、入选顺序、完整指令区与引用。
type SkillSnapshot struct {
	Input             SkillResolveInput
	TargetFormat      string
	AllowedSetVersion string
	Items             []SkillUseItem // 全部候选（含排除原因），Seq 为原序
	Selected          []SkillResolvedItem
	SlotText          string // 最终装配文本（空表示不输出技能槽）
	SlotChars         int
	Assembled         bool // 是否有实际装入（决定 refs / 提示词）
	PersonalUsed      int
	// PublicItems / PrivateItems 是持久化拆分：私有项绝不进入共享 refs（10.3 节）。
	PublicItems  []SkillUseItem
	PrivateItems []SkillUseItem
}

func (snap *SkillSnapshot) skillByID(id uuid.UUID) *skillDef {
	for _, it := range snap.Selected {
		if it.Def.ID == id {
			return it.Def
		}
	}
	return nil
}

// loadSkillSnapshot 用同一只读 REPEATABLE READ 事务读取账号 / 作品、绑定分区与定义；
// 事务结束即释放，不跨模型请求持有（6.3 节）。
func (s *Server) loadSkillSnapshot(ctx context.Context, in SkillResolveInput) (*SkillSnapshot, error) {
	format, err := s.skillResolveTargetFormat(ctx, in.Account, in.WorkID, in.TargetFormat)
	if err != nil {
		return nil, err
	}
	in.TargetFormat = format
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	res, err := s.resolveSkillSetQ(ctx, tx, in)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	snap := &SkillSnapshot{Input: in, TargetFormat: format, AllowedSetVersion: skillAllowedSetVersion, Selected: res.Selected}
	_, trace, total := assembleSkillSlot(res.Selected)
	snap.SlotText, snap.SlotChars, snap.Assembled = assembleTraceText(trace), total, total > 0
	usedByID := map[uuid.UUID]bool{}
	for _, tr := range trace {
		if tr.Used {
			usedByID[tr.Def.ID] = true
		}
	}

	seq := 0
	for _, it := range res.Items {
		reason := it.Reason
		u := SkillUseItem{
			ID: it.Def.ID, Name: it.Def.Fields.Name, Scope: it.Def.Scope,
			Revision: it.Def.Revision, ContentHash: it.Def.contentHash(),
			Selected: it.Reason == "" || it.Reason == skillReasonBudget,
			Used:     usedByID[it.Def.ID],
			Reason:   nilIfEmpty(reason), Seq: seq,
		}
		seq++
		if it.Def.Scope == "personal" {
			if u.Used {
				snap.PersonalUsed++
			}
			snap.PrivateItems = append(snap.PrivateItems, u)
		} else {
			snap.PublicItems = append(snap.PublicItems, u)
		}
		snap.Items = append(snap.Items, u)
	}
	return snap, nil
}

// assembleTraceText 从装配留痕重建槽位文本（与 assembleSkillSlot 输出一致）。
func assembleTraceText(trace []skillSlotItem) string {
	if len(trace) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(skillSlotHeader())
	any := false
	for _, tr := range trace {
		if tr.Used {
			b.WriteString(skillSlotItemText(tr.Def.Fields))
			any = true
		}
	}
	if !any {
		return ""
	}
	return b.String()
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ---------- 执行上下文缓存：一个用户动作复用同一快照 ----------

type skillSnapshotHolder struct {
	mu    sync.Mutex
	input SkillResolveInput
	snap  *SkillSnapshot
}

type skillSnapshotCtxKey struct{}

// withSkillSnapshotHolder 在最外层 AI 执行上下文安装快照持有者；
// runAIJSON 的两次校验尝试共用同一动作快照（6.3 节）。
func withSkillSnapshotHolder(ctx context.Context) context.Context {
	return context.WithValue(ctx, skillSnapshotCtxKey{}, &skillSnapshotHolder{})
}

// skillSnapshotFor 取（必要时建立）本次动作的技能快照。
// 数据库读取失败明确失败，不静默当作“无绑定”（3.3 节）。
func (s *Server) skillSnapshotFor(ctx context.Context, in SkillResolveInput) (context.Context, *SkillSnapshot, error) {
	h, _ := ctx.Value(skillSnapshotCtxKey{}).(*skillSnapshotHolder)
	if h == nil {
		h = &skillSnapshotHolder{}
		ctx = context.WithValue(ctx, skillSnapshotCtxKey{}, h)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.snap != nil && skillSnapshotInputEqual(h.input, in) {
		return ctx, h.snap, nil
	}
	snap, err := s.loadSkillSnapshot(ctx, in)
	if err != nil {
		return ctx, nil, err
	}
	h.input, h.snap = in, snap
	return ctx, snap, nil
}

func skillSnapshotInputEqual(a, b SkillResolveInput) bool {
	eqID := func(x, y *uuid.UUID) bool {
		if (x == nil) != (y == nil) {
			return false
		}
		return x == nil || *x == *y
	}
	eqAcc := (a.Account == nil) == (b.Account == nil) && (a.Account == nil || a.Account.ID == b.Account.ID)
	if !eqAcc {
		return false
	}
	return a.WorkspaceID == b.WorkspaceID &&
		a.ActorKind == b.ActorKind && eqID(a.ActorUserID, b.ActorUserID) &&
		eqID(a.WorkID, b.WorkID) && a.TargetFormat == b.TargetFormat &&
		a.Surface == b.Surface && a.TaskType == b.TaskType && a.Bare == b.Bare
}

// verifySkillSnapshot 在每次真正发送前复核（6.3 节）：身份、账号 / 作品目标，
// 以及快照中所有入选技能的绑定身份、priority、定义修订 / 状态 / 入口资格。
// 变化返回 skill_context_changed，不转备用模型绕过。
func (s *Server) verifySkillSnapshot(ctx context.Context, snap *SkillSnapshot) error {
	if snap == nil || len(snap.Selected) == 0 {
		// 无入选技能：仍需复核账号与身份目标。
	}
	in := snap.Input
	if in.ActorKind == "user" && in.ActorUserID != nil {
		var okMember bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_member wm JOIN app_user u ON u.id=wm.user_id
			WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.status='active' AND u.disabled_at IS NULL)`,
			in.WorkspaceID, *in.ActorUserID).Scan(&okMember); err != nil {
			return err
		}
		if !okMember {
			return skillContextChanged()
		}
	}
	// 账号目标：状态必须仍为启用。
	var accStatus string
	if err := s.db.QueryRow(ctx, `SELECT status FROM platform_account WHERE id=$1`, in.Account.ID).Scan(&accStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return skillContextChanged()
		}
		return err
	}
	if accStatus != "active" {
		return skillContextChanged()
	}
	// 作品目标：形态仍一致。
	if in.WorkID != nil {
		var wf string
		err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`,
			*in.WorkID, in.Account.ID).Scan(&wf)
		if errors.Is(err, pgx.ErrNoRows) {
			return skillContextChanged()
		}
		if err != nil {
			return err
		}
		if wf != snap.TargetFormat {
			return skillContextChanged()
		}
	}
	if len(snap.Selected) == 0 {
		return nil
	}
	// 入选技能：绑定身份与 priority、定义修订 / 状态 / 入口资格。
	type liveRow struct {
		bindingID            uuid.UUID
		priority             int
		revision             int64
		status               string
		taskOn, agentOn      bool
		platforms, formats   []string
	}
	rows, err := s.db.Query(ctx, `SELECT b.id, b.priority, sk.revision, sk.status, sk.task_enabled, sk.agent_enabled,
		sk.platforms, sk.content_formats, sk.id FROM skill_binding b JOIN skill sk ON sk.id=b.skill_id
		WHERE b.account_id=$1 AND (b.audience_user_id IS NULL OR ($2::uuid IS NOT NULL AND b.audience_user_id=$2))`,
		in.Account.ID, in.ActorUserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	live := map[uuid.UUID]liveRow{}
	for rows.Next() {
		var r liveRow
		var id uuid.UUID
		if err := rows.Scan(&r.bindingID, &r.priority, &r.revision, &r.status, &r.taskOn, &r.agentOn, &r.platforms, &r.formats, &id); err != nil {
			return err
		}
		live[id] = r
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, sel := range snap.Selected {
		def := sel.Def
		if def.Builtin {
			continue // 注册表随版本发布，运行内不变。
		}
		lr, ok := live[def.ID]
		if !ok || lr.bindingID != sel.BindingID || lr.priority != sel.Priority ||
			lr.revision != def.Revision || lr.status != def.Fields.Status ||
			lr.taskOn != def.Fields.TaskEnabled || lr.agentOn != def.Fields.AgentEnabled {
			return skillContextChanged()
		}
	}
	return nil
}

func skillContextChanged() error {
	return apiErr(409, "skill_context_changed", "技能配置在本次执行期间发生了变化，请重新发起任务")
}

// skillSharedRefs 构造可进入共享 context_refs 的技能引用（10.3 节）：
// 公共项含 ID、名称、修订、使用原因；个人项只含匿名数量，绝不存正文或可定位标识。
func skillSharedRefs(snap *SkillSnapshot) map[string]any {
	items := make([]SkillUseItem, 0, len(snap.PublicItems))
	items = append(items, snap.PublicItems...)
	return map[string]any{
		"context": map[string]any{
			"account_id":    snap.Input.Account.ID,
			"work_id":       canonUUID(snap.Input.WorkID),
			"target_format": snap.TargetFormat,
			"surface":       snap.Input.Surface,
			"task_type":     strOrNil(snap.Input.TaskType),
			"actor_kind":    snap.Input.ActorKind,
		},
		"budget":                skillSlotBudget,
		"assembled_chars":       nullableInt(snap.SlotChars, snap.Assembled),
		"items":                 items,
		"personal_used_count":   snap.PersonalUsed,
		"allowed_set_version":   snap.AllowedSetVersion,
	}
}

func strOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt(v int, present bool) any {
	if !present {
		return nil
	}
	return v
}

// GET /ai-calls/{id}/skill-context：已发生调用的技能使用回执（11.2 节）。
// 先校验调用记录的工作区访问权限，再比较真实用户 ID；不接受参数代读；
// 本人合并私有项，其他成员只看公共项与匿名数量；不返回正文与 catalog_id。
func (s *Server) getAICallSkillContext(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var accountID *uuid.UUID
	var refs, private json.RawMessage
	err = s.db.QueryRow(ctx, `SELECT account_id, context_refs, private_context_refs FROM ai_call WHERE id=$1 AND workspace_id=$2`,
		id, ident(ctx).WorkspaceID).Scan(&accountID, &refs, &private)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var shared struct {
		Skills *struct {
			Context         map[string]any `json:"context"`
			Budget          int            `json:"budget"`
			AssembledChars  *int           `json:"assembled_chars"`
			Items           []SkillUseItem `json:"items"`
			PersonalUsed    int            `json:"personal_used_count"`
			AllowedSetVer   string         `json:"allowed_set_version"`
		} `json:"skills"`
	}
	if len(refs) > 0 {
		_ = json.Unmarshal(refs, &shared)
	}
	items := []SkillUseItem{}
	personalUsed := 0
	budget := skillSlotBudget
	var assembled any
	surface, taskType := "task", ""
	if shared.Skills != nil {
		if v, ok := shared.Skills.Context["surface"].(string); ok {
			surface = v
		}
		if v, ok := shared.Skills.Context["task_type"].(string); ok {
			taskType = v
		}
		budget = shared.Skills.Budget
		assembled = shared.Skills.AssembledChars
		items = append(items, shared.Skills.Items...)
		personalUsed = shared.Skills.PersonalUsed
	}
	// 本人：合并私有项（按 Seq 回原序）；私有记录所属用户删除后保持私有，
	// 不因 owner 为空转为公开（10.3 节）。
	var priv struct {
		Items []SkillUseItem `json:"items"`
	}
	if len(private) > 0 {
		_ = json.Unmarshal(private, &priv)
	}
	var owner uuid.UUID
	ownerErr := s.db.QueryRow(ctx, `SELECT context_owner_user_id FROM ai_call WHERE id=$1`, id).Scan(&owner)
	if ownerErr == nil && owner != uuid.Nil && owner == ident(ctx).UserID {
		items = append(items, priv.Items...)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].Seq < items[j].Seq })
	var workID, targetFormat, actorKind any
	if shared.Skills != nil {
		workID = shared.Skills.Context["work_id"]
		targetFormat = shared.Skills.Context["target_format"]
		actorKind = shared.Skills.Context["actor_kind"]
	}
	contextObj := map[string]any{
		"account_id": accountID, "work_id": workID,
		"target_format": targetFormat, "surface": surface,
		"task_type": taskOrNil(taskType), "actor_kind": actorKind,
	}
	return ok(w, map[string]any{
		"ai_call_id": id, "context": contextObj, "budget": budget,
		"assembled_chars": assembled, "items": items, "personal_used_count": personalUsed,
	})
}

func taskOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
