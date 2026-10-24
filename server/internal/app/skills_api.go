package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DEV-SK1 / docs/23 第 11 节：技能定义接口。
// 权限顺序（11.5）：会话 / CSRF / 维护 → 对象租户与本人可见性 → 角色 / 入口权限 → 字段 →
// 安全 → 确认 → 事务守卫。未知对象 / 跨租户 / 他人个人对象统一 404；已知可见公共对象的
// viewer 写入 403。

// skillDTO 是 SkillDefinition（11.1 节）：DefinitionFields 加标识与来源字段。
type skillDTO struct {
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    bool     `json:"task_enabled"`
	AgentEnabled   bool     `json:"agent_enabled"`
	Status         string   `json:"status"`

	ID          uuid.UUID  `json:"id"`
	Scope       string     `json:"scope"`
	AccountID   *uuid.UUID `json:"account_id"`
	Revision    int64      `json:"revision"`
	ContentHash string     `json:"content_hash"`
	Origin      string     `json:"origin"`
	SourceKey   string     `json:"source_key"`
	CreatedBy   *uuid.UUID `json:"created_by"`
	CreatedAt   *time.Time `json:"created_at"`
	UpdatedAt   *time.Time `json:"updated_at"`
}

func skillDTOOf(d *skillDef, createdBy *uuid.UUID, createdAt, updatedAt *time.Time) skillDTO {
	return skillDTO{
		Name: d.Fields.Name, Summary: d.Fields.Summary, Triggers: d.Fields.Triggers,
		Instructions: d.Fields.Instructions,
		Platforms:    d.Fields.Platforms, ContentFormats: d.Fields.ContentFormats, TaskTypes: d.Fields.TaskTypes,
		TaskEnabled: d.Fields.TaskEnabled, AgentEnabled: d.Fields.AgentEnabled, Status: d.Fields.Status,
		ID: d.ID, Scope: d.Scope, AccountID: d.AccountID, Revision: d.Revision,
		ContentHash: d.contentHash(), Origin: d.Origin, SourceKey: d.SourceKey,
		CreatedBy: createdBy, CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
}

func skillSummaryDTO(d *skillDef, createdBy *uuid.UUID, createdAt, updatedAt *time.Time) map[string]any {
	full := skillDTOOf(d, createdBy, createdAt, updatedAt)
	full.Instructions = ""
	b, _ := json.Marshal(full)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

// decodeStrict 解析请求体并拒绝未知字段（11.1 节）；上限 128 KiB。
func decodeStrict(r *http.Request, v any) error {
	body, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, skillJSONMaxBytes+1))
	if err != nil {
		return apiErr(413, "request_too_large", "请求体过大")
	}
	if len(body) > skillJSONMaxBytes {
		return apiErr(413, "request_too_large", "请求体过大")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return validation("请求格式不正确，请检查 JSON 语法、字段类型与未知字段")
	}
	if dec.More() {
		return validation("请求体包含多余内容")
	}
	return nil
}

// ---------- 可见性与权限 ----------

const skillDefCols = `id, workspace_id, user_id, account_id, name, summary, triggers, instructions,
	platforms, content_formats, task_types, task_enabled, agent_enabled, status, revision, origin, source_key,
	created_by, created_at, updated_at`

type skillDefRow struct {
	Def       *skillDef
	CreatedBy *uuid.UUID
	CreatedAt *time.Time
	UpdatedAt *time.Time
}

func scanSkillDefRow(row pgx.Row) (*skillDefRow, error) {
	var d skillDef
	var r skillDefRow
	var createdBy *uuid.UUID
	var createdAt, updatedAt *time.Time
	err := row.Scan(&d.ID, &d.WorkspaceID, &d.UserID, &d.AccountID, &d.Fields.Name, &d.Fields.Summary,
		&d.Fields.Triggers, &d.Fields.Instructions, &d.Fields.Platforms, &d.Fields.ContentFormats,
		&d.Fields.TaskTypes, &d.Fields.TaskEnabled, &d.Fields.AgentEnabled, &d.Fields.Status,
		&d.Revision, &d.Origin, &d.SourceKey, &createdBy, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	d.Fields.Platforms = normalizeEnumArray(d.Fields.Platforms)
	d.Fields.ContentFormats = normalizeEnumArray(d.Fields.ContentFormats)
	d.Fields.TaskTypes = normalizeEnumArray(d.Fields.TaskTypes)
	d.Scope = scopeOfSkill(d.WorkspaceID, d.UserID, d.AccountID)
	r.Def, r.CreatedBy, r.CreatedAt, r.UpdatedAt = &d, createdBy, createdAt, updatedAt
	return &r, nil
}

// skillVisibleDef 按 11.5 节先解析可见性：内置可查；跨租户 / 他人个人统一 404。
func (s *Server) skillVisibleDef(ctx context.Context, id uuid.UUID) (*skillDefRow, error) {
	if d := skillBuiltinByID(id); d != nil {
		return &skillDefRow{Def: d}, nil
	}
	idv := ident(ctx)
	r, err := scanSkillDefRow(s.db.QueryRow(ctx, `SELECT `+skillDefCols+` FROM skill WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	d := r.Def
	switch d.Scope {
	case "workspace":
		if d.WorkspaceID == nil || *d.WorkspaceID != idv.WorkspaceID {
			return nil, errNotFound
		}
	case "account":
		var ws uuid.UUID
		if err := s.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, *d.AccountID).Scan(&ws); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, errNotFound
			}
			return nil, err
		}
		if ws != idv.WorkspaceID {
			return nil, errNotFound
		}
	case "personal":
		if d.UserID == nil || *d.UserID != idv.UserID {
			return nil, errNotFound
		}
	}
	return r, nil
}

// skillEditPermission：可见性已由调用方解析；个人定义仅本人（viewer 可），公共需 editor。
func (s *Server) skillEditPermission(ctx context.Context, d *skillDef) error {
	idv := ident(ctx)
	switch d.Scope {
	case "personal":
		if d.UserID == nil || *d.UserID != idv.UserID {
			return errNotFound
		}
		return nil
	case "workspace", "account":
		return s.requireEditor(ctx)
	default:
		return apiErr(422, "immutable_skill", "内置技能不能修改或删除")
	}
}

// visibleAccount 校验账号属于当前工作区（跨租户 404）。
func (s *Server) visibleAccount(ctx context.Context, accountID uuid.UUID) (*Account, error) {
	a, err := s.account(ctx, accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return nil, err
	}
	return a, nil
}

// ---------- GET /skills ----------

type skillCursor struct {
	Version      int    `json:"version"`
	QueryHash    string `json:"query_hash"`
	SnapshotHash string `json:"snapshot_hash"`
	Offset       int    `json:"offset"`
}

func encodeSkillCursor(c skillCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeSkillCursor(s string) (*skillCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, validation("分页游标格式不正确")
	}
	var c skillCursor
	if err := json.Unmarshal(raw, &c); err != nil || c.Version != 1 || c.Offset < 0 {
		return nil, validation("分页游标格式不正确")
	}
	return &c, nil
}

type skillListRow struct {
	def       *skillDef
	createdBy *uuid.UUID
	createdAt *time.Time
	updatedAt *time.Time
}

func (s *Server) listSkills(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	view := q.Get("view")
	if view == "" {
		view = "library"
	}
	if view != "library" && view != "effective" {
		return validation("view 只支持 library 或 effective")
	}
	limit := queryInt(r, "limit", 12)
	if limit < 1 || limit > 12 {
		limit = 12
	}
	search := queryText(r, "q")
	if runeLen(search) > 100 {
		return validation("搜索词最多 100 字")
	}
	scopeFilter := q.Get("scope")
	if scopeFilter != "" && scopeFilter != "builtin" && scopeFilter != "workspace" && scopeFilter != "account" && scopeFilter != "personal" {
		return validation("scope 无效")
	}
	idv := ident(r.Context())

	if view == "effective" {
		return s.listSkillsEffective(w, r, idv, limit, search, scopeFilter)
	}
	// work_id 不用于 library（11.2 节）。
	if q.Get("work_id") != "" {
		return validationFields("library 视图不接受 work_id", map[string]string{"work_id": "invalid"})
	}

	// 汇总可见集合：内置 + 当前工作区 / 账号 + 本人个人项。
	var defs []skillListRow
	for _, b := range builtinSkills {
		defs = append(defs, skillListRow{def: skillBuiltinByKey(b.Key)})
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+skillDefCols+` FROM skill
		WHERE workspace_id = $1 OR user_id = $2
		OR account_id IN (SELECT id FROM platform_account WHERE workspace_id = $1)`,
		idv.WorkspaceID, idv.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		sr, err := scanSkillDefRow(rows)
		if err != nil {
			return err
		}
		defs = append(defs, skillListRow{def: sr.Def, createdBy: sr.CreatedBy, createdAt: sr.CreatedAt, updatedAt: sr.UpdatedAt})
	}
	if err := rows.Err(); err != nil {
		return err
	}

	// 过滤：scope、账号层限定、搜索（字面子串、忽略大小写）。
	lowerQ := strings.ToLower(search)
	filtered := make([]skillListRow, 0, len(defs))
	for _, lr := range defs {
		d := lr.def
		if scopeFilter != "" && d.Scope != scopeFilter {
			continue
		}
		if d.Scope == "account" {
			// account_id 缺省时不列账号层；指定后只列该账号专属项。
			accParam := q.Get("account_id")
			if accParam == "" {
				continue
			}
			accID, err := uuid.Parse(accParam)
			if err != nil || d.AccountID == nil || *d.AccountID != accID {
				continue
			}
		}
		if lowerQ != "" {
			hay := strings.ToLower(d.Fields.Name + "\n" + d.Fields.Summary + "\n" + d.Fields.Triggers)
			if !strings.Contains(hay, lowerQ) {
				continue
			}
		}
		filtered = append(filtered, lr)
	}
	// library 固定按 personal/account/workspace/builtin、lower(name)、id 排序（11.2 节）。
	sortSkillDefsLibrary(filtered)

	snapshot, err := skillLibrarySnapshotHash(filtered)
	if err != nil {
		return err
	}
	qhash, err := canonHash(map[string]any{"view": "library", "scope": scopeFilter, "account_id": q.Get("account_id"), "q": search, "limit": limit})
	if err != nil {
		return err
	}
	offset := 0
	if cur := q.Get("cursor"); cur != "" {
		c, err := decodeSkillCursor(cur)
		if err != nil {
			return err
		}
		if c.QueryHash != qhash || c.SnapshotHash != snapshot {
			return apiErr(409, "cursor_stale", "列表已更新，请从头重新获取")
		}
		offset = c.Offset
	}
	items := []map[string]any{}
	for i := offset; i < len(filtered) && len(items) < limit; i++ {
		lr := filtered[i]
		items = append(items, skillSummaryDTO(lr.def, lr.createdBy, lr.createdAt, lr.updatedAt))
	}
	var next any
	if offset+len(items) < len(filtered) {
		next = encodeSkillCursor(skillCursor{Version: 1, QueryHash: qhash, SnapshotHash: snapshot, Offset: offset + len(items)})
	}
	return ok(w, map[string]any{"view": "library", "items": items, "next_cursor": next, "total": len(filtered)})
}

func sortSkillDefsLibrary(defs []skillListRow) {
	layerOf := func(d *skillDef) int {
		switch d.Scope {
		case "personal":
			return 0
		case "account":
			return 1
		case "workspace":
			return 2
		default:
			return 3
		}
	}
	sort.SliceStable(defs, func(i, j int) bool {
		a, b := defs[i].def, defs[j].def
		if la, lb := layerOf(a), layerOf(b); la != lb {
			return la < lb
		}
		if strings.ToLower(a.Fields.Name) != strings.ToLower(b.Fields.Name) {
			return strings.ToLower(a.Fields.Name) < strings.ToLower(b.Fields.Name)
		}
		return a.ID.String() < b.ID.String()
	})
}

func skillLibrarySnapshotHash(defs []skillListRow) (string, error) {
	arr := make([]any, 0, len(defs))
	for _, lr := range defs {
		arr = append(arr, map[string]any{"id": lr.def.ID.String(), "revision": lr.def.Revision})
	}
	return canonHash(arr)
}

// ---------- effective 视图（8.1 节入选语义；Web 无目录凭据，ref/catalog_id=null） ----------

func (s *Server) listSkillsEffective(w http.ResponseWriter, r *http.Request, idv *identity, limit int, search, scopeFilter string) error {
	accParam := r.URL.Query().Get("account_id")
	if accParam == "" {
		return validationFields("effective 视图需要 account_id", map[string]string{"account_id": "required"})
	}
	accID, err := uuid.Parse(accParam)
	if err != nil {
		return errNotFound
	}
	acc, err := s.visibleAccount(r.Context(), accID)
	if err != nil {
		return err
	}
	var workID *uuid.UUID
	if v := r.URL.Query().Get("work_id"); v != "" {
		wid, err := uuid.Parse(v)
		if err != nil {
			return errNotFound
		}
		workID = &wid
	}
	targetFormat, err := s.skillResolveTargetFormat(r.Context(), acc, workID, r.URL.Query().Get("target_format"))
	if err != nil {
		return err
	}
	// DEV-SK3 / 8.1 节第 7 项：运行内 GET /skills?view=effective 通过可信 agentPrincipal.RunID
	// 取得同一运行状态（引用号与 catalog_id），不新建另一套目录缓存。
	if p := agentPrincipalOf(r.Context()); p != nil && p.RunID != uuid.Nil {
		if !workVisibleToRun(r.Context(), p, accID) {
			return errNotFound
		}
		st := &agentRunState{RunID: p.RunID, WorkspaceID: p.WorkspaceID, UserID: ident(r.Context()).UserID,
			ConversationID: p.ConversationID, SessionID: p.SessionID, AccountID: &accID}
		catID, items, err := s.agentSkillEffectiveItems(r.Context(), st, acc, workID, targetFormat)
		if err != nil {
			return err
		}
		// q / scope 过滤已冻结的入选集（8.1 节第 6 项）。
		lowerQ := strings.ToLower(search)
		filtered := []map[string]any{}
		for _, it := range items {
			if scopeFilter != "" && it["scope"] != scopeFilter {
				continue
			}
			if lowerQ != "" {
				hay := strings.ToLower(it["name"].(string) + "\n" + it["hint"].(string))
				if !strings.Contains(hay, lowerQ) {
					continue
				}
			}
			filtered = append(filtered, it)
		}
		offset := 0
		if cur := r.URL.Query().Get("cursor"); cur != "" {
			c, err := decodeSkillCursor(cur)
			if err != nil {
				return err
			}
			if c.Offset > len(filtered) {
				return apiErr(409, "cursor_stale", "列表已更新，请重新获取")
			}
			offset = c.Offset
		}
		page := []map[string]any{}
		for i := offset; i < len(filtered) && len(page) < limit; i++ {
			page = append(page, filtered[i])
		}
		var next any
		if offset+len(page) < len(filtered) {
			next = encodeSkillCursor(skillCursor{Version: 1, QueryHash: "run-effective", SnapshotHash: catID, Offset: offset + len(page)})
		}
		return ok(w, map[string]any{
			"view": "effective", "catalog_id": catID,
			"context": map[string]any{
				"account_id": acc.ID, "work_id": canonUUID(workID), "target_format": targetFormat,
				"surface": "agent", "task_type": nil, "actor_kind": "user",
			},
			"items": page, "next_cursor": next, "total": len(filtered), "excluded_count": 0,
		})
	}
	res, err := s.resolveSkillSet(r.Context(), SkillResolveInput{
		WorkspaceID: idv.WorkspaceID, Account: acc, ActorKind: "user", ActorUserID: &idv.UserID,
		WorkID: workID, TargetFormat: targetFormat, Surface: "agent", Preview: idv.Role == "viewer",
	})
	if err != nil {
		return err
	}
	// q / scope 只筛选已入选集，不改变引用号或提升 candidate_limit 项。
	lowerQ := strings.ToLower(search)
	items := []map[string]any{}
	for _, it := range res.Selected {
		if scopeFilter != "" && it.Def.Scope != scopeFilter {
			continue
		}
		if lowerQ != "" {
			hay := strings.ToLower(it.Def.Fields.Name + "\n" + it.Def.Fields.Summary + "\n" + it.Def.Fields.Triggers)
			if !strings.Contains(hay, lowerQ) {
				continue
			}
		}
		items = append(items, map[string]any{
			"id": it.Def.ID, "ref": nil, "name": it.Def.Fields.Name,
			"hint": skillCatalogHint(it.Def.Fields), "scope": it.Def.Scope,
			"revision": it.Def.Revision, "content_hash": it.Def.contentHash(), "priority": it.Priority,
		})
	}
	snapshot, err := skillEffectiveSnapshotHash(acc.ID, workID, res.Selected)
	if err != nil {
		return err
	}
	qhash, err := canonHash(map[string]any{"view": "effective", "account_id": acc.ID.String(), "work_id": canonUUID(workID), "target_format": targetFormat, "scope": scopeFilter, "q": search, "limit": limit})
	if err != nil {
		return err
	}
	offset := 0
	if cur := r.URL.Query().Get("cursor"); cur != "" {
		c, err := decodeSkillCursor(cur)
		if err != nil {
			return err
		}
		if c.QueryHash != qhash || c.SnapshotHash != snapshot {
			return apiErr(409, "cursor_stale", "上下文已更新，请重新获取")
		}
		offset = c.Offset
	}
	page := []map[string]any{}
	for i := offset; i < len(items) && len(page) < limit; i++ {
		page = append(page, items[i])
	}
	var next any
	if offset+len(page) < len(items) {
		next = encodeSkillCursor(skillCursor{Version: 1, QueryHash: qhash, SnapshotHash: snapshot, Offset: offset + len(page)})
	}
	excluded := len(res.Items) - len(res.Selected)
	if excluded < 0 {
		excluded = 0
	}
	return ok(w, map[string]any{
		"view": "effective", "catalog_id": nil,
		"context": map[string]any{
			"account_id": acc.ID, "work_id": canonUUID(workID), "target_format": targetFormat,
			"surface": "agent", "task_type": nil, "actor_kind": "user",
		},
		"items": page, "next_cursor": next, "total": len(items), "excluded_count": excluded,
	})
}

func skillCatalogHint(f SkillFields) string {
	return truncateRunes(f.Summary+"；"+f.Triggers, skillHintLimit)
}

func skillEffectiveSnapshotHash(accID uuid.UUID, workID *uuid.UUID, items []SkillResolvedItem) (string, error) {
	arr := make([]any, 0, len(items))
	for _, it := range items {
		arr = append(arr, map[string]any{"id": it.Def.ID.String(), "revision": it.Def.Revision})
	}
	return canonHash(map[string]any{"account_id": accID.String(), "work_id": canonUUID(workID), "items": arr})
}

// ---------- 单定义：GET / PUT / DELETE / impact / export ----------

func (s *Server) getSkill(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	sr, err := s.skillVisibleDef(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, skillDTOOf(sr.Def, sr.CreatedBy, sr.CreatedAt, sr.UpdatedAt))
}

type skillUpdateInput struct {
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    bool     `json:"task_enabled"`
	AgentEnabled   bool     `json:"agent_enabled"`
	Status         string   `json:"status"`

	BaseRevision        int64                `json:"base_revision"`
	ImpactToken         string               `json:"impact_token"`
	PublishConfirmation *publishConfirmation `json:"publish_confirmation"`
}

func (s *Server) putSkill(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in skillUpdateInput
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	sr, err := s.skillVisibleDef(r.Context(), id)
	if err != nil {
		return err
	}
	d := sr.Def
	if d.Builtin {
		return apiErr(422, "immutable_skill", "内置技能不能修改，可另存为独立副本")
	}
	if err := s.skillEditPermission(r.Context(), d); err != nil {
		return err
	}
	fields := SkillFields{
		Name: in.Name, Summary: in.Summary, Triggers: in.Triggers, Instructions: in.Instructions,
		Platforms: in.Platforms, ContentFormats: in.ContentFormats, TaskTypes: in.TaskTypes,
		TaskEnabled: in.TaskEnabled, AgentEnabled: in.AgentEnabled, Status: in.Status,
	}
	if err := validateSkillFields(&fields); err != nil {
		return err
	}
	if err := s.checkSkillSecrets(r.Context(), ident(r.Context()).WorkspaceID, fields); err != nil {
		return err
	}
	// 公开定义更新统一要求公开确认（10.3.1 节）；个人目标不接受该参数。
	if d.Scope == "personal" {
		if in.PublishConfirmation != nil {
			return validationFields("个人技能不接受公开确认参数", map[string]string{"publish_confirmation": "invalid"})
		}
	} else {
		if in.PublishConfirmation == nil || !in.PublishConfirmation.Confirmed {
			return apiErr(409, "public_confirmation_required", "公开技能的修改需要单独确认可见范围")
		}
		digest, err := skillPublishDigest("update", &d.ID, d.Scope, d.AccountID, fields)
		if err != nil {
			return err
		}
		if in.PublishConfirmation.Digest != digest {
			return apiErr(409, "stale", "公开内容已变化，请重新确认")
		}
	}
	if in.BaseRevision <= 0 {
		return validationFields("base_revision 必须为正整数", map[string]string{"base_revision": "invalid"})
	}
	if !strings.HasPrefix(in.ImpactToken, "si1:") {
		return validationFields("impact_token 无效", map[string]string{"impact_token": "invalid"})
	}
	if in.BaseRevision != d.Revision {
		return apiErr(409, "stale", "技能已被其他人修改，请重新读取")
	}

	// 锁受影响账号（UUID 升序）后锁技能，重读完整绑定集合并复核影响 token（5.2.1 节）。
	affected, err := s.skillImpactBindings(r.Context(), d)
	if err != nil {
		return err
	}
	token, err := skillImpactToken(d.ID, d.Revision, "update", affected)
	if err != nil {
		return err
	}
	if token != in.ImpactToken {
		return apiErr(409, "stale", "影响范围已变化，请重新预览")
	}

	var affectedCount int
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		accIDs := map[uuid.UUID]bool{}
		for _, b := range affected {
			accIDs[b.AccountID] = true
		}
		if err := s.lockSkillAccounts(r.Context(), tx, d, accIDs); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `SELECT id FROM skill WHERE id=$1 FOR UPDATE`, d.ID); err != nil {
			return err
		}
		cur, err := scanSkillDefRow(tx.QueryRow(r.Context(), `SELECT `+skillDefCols+` FROM skill WHERE id=$1`, d.ID))
		if err != nil {
			return err
		}
		if cur.Def.Revision != d.Revision {
			return apiErr(409, "stale", "技能已被其他人修改，请重新读取")
		}
		rebound, err := s.skillImpactBindingsTx(r.Context(), tx, cur.Def)
		if err != nil {
			return err
		}
		token2, err := skillImpactToken(d.ID, cur.Def.Revision, "update", rebound)
		if err != nil {
			return err
		}
		if token2 != in.ImpactToken {
			return apiErr(409, "stale", "影响范围已变化，请重新预览")
		}
		tag, err := tx.Exec(r.Context(), `UPDATE skill SET name=$2, summary=$3, triggers=$4, instructions=$5,
			platforms=$6, content_formats=$7, task_types=$8, task_enabled=$9, agent_enabled=$10, status=$11,
			revision=revision+1, updated_at=now()
			WHERE id=$1 AND revision=$12`,
			d.ID, fields.Name, fields.Summary, fields.Triggers, fields.Instructions,
			normalizeEnumArray(fields.Platforms), normalizeEnumArray(fields.ContentFormats), normalizeEnumArray(fields.TaskTypes),
			fields.TaskEnabled, fields.AgentEnabled, fields.Status, d.Revision)
		if err != nil {
			var pe *pgconn.PgError
			if errors.As(err, &pe) && pe.Code == "23505" {
				return apiErr(422, "name_conflict", "同一范围内已有同名技能")
			}
			return err
		}
		if tag.RowsAffected() != 1 {
			return apiErr(409, "stale", "技能已被其他人修改，请重新读取")
		}
		affectedCount = len(rebound)
		newRev := cur.Def.Revision + 1
		detail := map[string]any{"scope": cur.Def.Scope, "name": fields.Name, "revision": newRev, "affected_bindings": affectedCount}
		if cur.Def.Scope == "workspace" {
			detail["public_confirmed"] = true
		}
		if err := s.auditTxVis(r.Context(), tx, "skill_update", "skill", d.ID.String(), "ok", detail, auditVisForScope(cur.Def.Scope)); err != nil {
			return err
		}
		nd := *cur.Def
		nd.Fields = fields
		nd.Revision = newRev
		return ok(w, map[string]any{"skill": skillDTOOf(&nd, sr.CreatedBy, sr.CreatedAt, sr.UpdatedAt), "affected_bindings": affectedCount})
	})
	return err
}

// lockSkillAccounts 按 UUID 升序锁受影响账号；账号层定义只锁归属账号。
func (s *Server) lockSkillAccounts(ctx context.Context, tx pgx.Tx, d *skillDef, accountIDs map[uuid.UUID]bool) error {
	ids := make([]string, 0, len(accountIDs))
	for id := range accountIDs {
		ids = append(ids, id.String())
	}
	sort.Strings(ids)
	for _, idStr := range ids {
		id, _ := uuid.Parse(idStr)
		if _, err := tx.Exec(ctx, `SELECT id FROM platform_account WHERE id=$1 FOR UPDATE`, id); err != nil {
			return err
		}
	}
	return nil
}

// skillImpactBindings 取该定义全部当前绑定（含内置另存外的个人 / 公共分区）。
func (s *Server) skillImpactBindings(ctx context.Context, d *skillDef) ([]skillImpactBinding, error) {
	rows, err := s.db.Query(ctx, `SELECT id, account_id, audience_user_id, priority, created_at
		FROM skill_binding WHERE skill_id=$1`, d.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanImpactBindings(rows)
}

func (s *Server) skillImpactBindingsTx(ctx context.Context, tx pgx.Tx, d *skillDef) ([]skillImpactBinding, error) {
	rows, err := tx.Query(ctx, `SELECT id, account_id, audience_user_id, priority, created_at
		FROM skill_binding WHERE skill_id=$1`, d.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanImpactBindings(rows)
}

func scanImpactBindings(rows pgx.Rows) ([]skillImpactBinding, error) {
	defer rows.Close()
	var out []skillImpactBinding
	for rows.Next() {
		var b skillImpactBinding
		if err := rows.Scan(&b.BindingID, &b.AccountID, &b.AudienceUID, &b.Priority, &b.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Server) getSkillImpact(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	action := r.URL.Query().Get("action")
	if action != "update" && action != "delete" {
		return validationFields("action 只支持 update 或 delete", map[string]string{"action": "invalid"})
	}
	sr, err := s.skillVisibleDef(r.Context(), id)
	if err != nil {
		return err
	}
	d := sr.Def
	if d.Builtin {
		return apiErr(422, "immutable_skill", "内置技能没有编辑 / 删除影响预览")
	}
	if err := s.skillEditPermission(r.Context(), d); err != nil {
		return err
	}
	bindings, err := s.skillImpactBindings(r.Context(), d)
	if err != nil {
		return err
	}
	// accounts 仅含本人当前有成员资格的账号（5.2.1 节）。
	idv := ident(r.Context())
	accounts := []map[string]any{}
	visible := map[uuid.UUID]bool{}
	for _, b := range bindings {
		if visible[b.AccountID] {
			continue
		}
		visible[b.AccountID] = true
	}
	for accID := range visible {
		var name string
		var wsID uuid.UUID
		var cnt int
		err := s.db.QueryRow(r.Context(), `SELECT a.name, a.workspace_id FROM platform_account a WHERE a.id=$1`, accID).Scan(&name, &wsID)
		if err != nil {
			continue
		}
		var member bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 AND status='active')`,
			wsID, idv.UserID).Scan(&member); err != nil || !member {
			continue
		}
		_ = s.db.QueryRow(r.Context(), `SELECT count(*) FROM skill_binding WHERE skill_id=$1 AND account_id=$2`, d.ID, accID).Scan(&cnt)
		var wsName string
		_ = s.db.QueryRow(r.Context(), `SELECT name FROM workspace WHERE id=$1`, wsID).Scan(&wsName)
		accounts = append(accounts, map[string]any{"id": accID, "name": name, "workspace_name": wsName, "bindings": cnt})
	}
	sort.Slice(accounts, func(i, j int) bool {
		return accounts[i]["id"].(uuid.UUID).String() < accounts[j]["id"].(uuid.UUID).String()
	})
	token, err := skillImpactToken(d.ID, d.Revision, action, bindings)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"skill_id": d.ID, "base_revision": d.Revision, "action": action,
		"affected_bindings": len(bindings), "accounts": accounts, "impact_token": token,
	})
}

func (s *Server) deleteSkill(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	q := r.URL.Query()
	sr, err := s.skillVisibleDef(r.Context(), id)
	if err != nil {
		return err
	}
	d := sr.Def
	if d.Builtin {
		return apiErr(422, "immutable_skill", "内置技能不能删除")
	}
	if err := s.skillEditPermission(r.Context(), d); err != nil {
		return err
	}
	if q.Get("confirm") != "true" {
		return apiErr(409, "confirm_required", "删除技能需要二次确认")
	}
	baseRev, err := strconvParseInt64(q.Get("base_revision"))
	if err != nil || baseRev <= 0 {
		return validationFields("base_revision 必须为正整数", map[string]string{"base_revision": "invalid"})
	}
	if baseRev != d.Revision {
		return apiErr(409, "stale", "技能已被其他人修改，请重新读取")
	}
	if !strings.HasPrefix(q.Get("impact_token"), "si1:") {
		return validationFields("impact_token 无效", map[string]string{"impact_token": "invalid"})
	}
	bindings, err := s.skillImpactBindings(r.Context(), d)
	if err != nil {
		return err
	}
	token, err := skillImpactToken(d.ID, d.Revision, "delete", bindings)
	if err != nil {
		return err
	}
	if token != q.Get("impact_token") {
		return apiErr(409, "stale", "影响范围已变化，请重新预览")
	}
	var affectedCount int
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		accIDs := map[uuid.UUID]bool{}
		for _, b := range bindings {
			accIDs[b.AccountID] = true
		}
		if err := s.lockSkillAccounts(r.Context(), tx, d, accIDs); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `SELECT id FROM skill WHERE id=$1 FOR UPDATE`, d.ID); err != nil {
			return err
		}
		cur, err := scanSkillDefRow(tx.QueryRow(r.Context(), `SELECT `+skillDefCols+` FROM skill WHERE id=$1`, d.ID))
		if err != nil {
			return err
		}
		if cur.Def.Revision != d.Revision {
			return apiErr(409, "stale", "技能已被其他人修改，请重新读取")
		}
		rebound, err := s.skillImpactBindingsTx(r.Context(), tx, cur.Def)
		if err != nil {
			return err
		}
		token2, err := skillImpactToken(d.ID, cur.Def.Revision, "delete", rebound)
		if err != nil {
			return err
		}
		if token2 != q.Get("impact_token") {
			return apiErr(409, "stale", "影响范围已变化，请重新预览")
		}
		affectedCount = len(rebound)
		if _, err := tx.Exec(r.Context(), `DELETE FROM skill WHERE id=$1`, d.ID); err != nil {
			return err
		}
		detail := map[string]any{"scope": cur.Def.Scope, "name": cur.Def.Fields.Name, "revision": cur.Def.Revision, "affected_bindings": affectedCount}
		return s.auditTxVis(r.Context(), tx, "skill_delete", "skill", d.ID.String(), "ok", detail, auditVisForScope(cur.Def.Scope))
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"deleted": true, "affected_bindings": affectedCount})
}

func strconvParseInt64(s string) (int64, error) {
	var v int64
	if s == "" {
		return 0, errors.New("empty")
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("not a number")
		}
		v = v*10 + int64(c-'0')
		if v > 1<<62 {
			return 0, errors.New("too large")
		}
	}
	return v, nil
}

// ---------- parse / export ----------

func (s *Server) parseSkill(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	secrets := s.agentSecretValues(r.Context(), idv.WorkspaceID)
	var raw []byte
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(skillImportMaxBytes); err != nil {
			return apiErr(413, "request_too_large", "文件过大或表单无效")
		}
		if r.MultipartForm == nil || len(r.MultipartForm.File) == 0 {
			return validation("请上传一个 .md 文件")
		}
		if len(r.MultipartForm.File) > 1 {
			return validation("一次只能上传一个文件")
		}
		for _, fhs := range r.MultipartForm.File {
			for _, fh := range fhs {
				f, err := fh.Open()
				if err != nil {
					return err
				}
				raw, err = io.ReadAll(io.LimitReader(f, skillImportMaxBytes+1))
				f.Close()
				if err != nil {
					return err
				}
			}
		}
	} else {
		var in struct {
			Content string `json:"content"`
		}
		if err := decodeStrict(r, &in); err != nil {
			return err
		}
		raw = []byte(in.Content)
		if len(raw) > skillImportMaxBytes {
			return apiErr(413, "request_too_large", "技能文件超过 64 KiB 上限")
		}
	}
	p, err := parseSkillMarkdown(raw, secrets)
	if err != nil {
		return err
	}
	if p.Warnings == nil {
		p.Warnings = []Warning{}
	}
	return ok(w, map[string]any{"fields": p.Fields, "warnings": p.Warnings})
}

func (s *Server) exportSkill(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	sr, err := s.skillVisibleDef(r.Context(), id)
	if err != nil {
		return err
	}
	md, err := exportSkillMarkdown(sr.Def.Fields)
	if err != nil {
		return err
	}
	// 导出文件名使用通用名称（10.3 节）：不包含私人名称 / ID。
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="skill.md"`)
	_, _ = w.Write([]byte(md))
	return nil
}

// ---------- POST /skills ----------

type publishConfirmation struct {
	Confirmed bool   `json:"confirmed"`
	Digest    string `json:"digest"`
}

type skillCreateInput struct {
	Scope     string `json:"scope"`
	AccountID string `json:"account_id"`

	// 输入三选一（11.1 节）：完整字段 / import_content / copy_from_id(+name)。
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    *bool    `json:"task_enabled"`
	AgentEnabled   *bool    `json:"agent_enabled"`
	Status         string   `json:"status"`

	ImportContent string `json:"import_content"`
	CopyFromID    string `json:"copy_from_id"`

	PublishConfirmation *publishConfirmation `json:"publish_confirmation"`
}

func (in *skillCreateInput) hasFields() bool {
	return in.Name != "" || in.Summary != "" || in.Triggers != "" || in.Instructions != "" ||
		len(in.Platforms) > 0 || len(in.ContentFormats) > 0 || len(in.TaskTypes) > 0 ||
		in.TaskEnabled != nil || in.AgentEnabled != nil
}

func boolDefault(v *bool, def bool) bool {
	if v == nil {
		return def
	}
	return *v
}

func strDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func (s *Server) createSkill(w http.ResponseWriter, r *http.Request) error {
	var in skillCreateInput
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	idv := ident(r.Context())
	if in.Scope == "" {
		return validationFields("scope 必填（workspace/account/personal）", map[string]string{"scope": "required"})
	}
	if in.Scope != "personal" && in.Scope != "workspace" && in.Scope != "account" {
		return validationFields("scope 无效", map[string]string{"scope": "invalid"})
	}
	var accountID *uuid.UUID
	if in.Scope == "account" {
		if in.AccountID == "" {
			return validationFields("账号层创建必须提供 account_id", map[string]string{"account_id": "required"})
		}
		accID, err := uuid.Parse(in.AccountID)
		if err != nil {
			return errNotFound
		}
		if _, err := s.visibleAccount(r.Context(), accID); err != nil {
			return err
		}
		accountID = &accID
	} else if in.AccountID != "" {
		return validationFields("该 scope 不接受 account_id", map[string]string{"account_id": "invalid"})
	}

	// 三种输入不能混传（11.1 节）。
	modes := 0
	if in.hasFields() {
		modes++
	}
	if in.ImportContent != "" {
		modes++
	}
	if in.CopyFromID != "" {
		modes++
	}
	if modes == 0 {
		return validation("必须提供定义字段、import_content 或 copy_from_id 之一")
	}
	if modes > 1 {
		return validation("三种创建输入不能混传")
	}

	var fields SkillFields
	var origin, sourceKey string
	var importWarnings []Warning
	switch {
	case in.hasFields():
		fields = SkillFields{
			Name: in.Name, Summary: in.Summary, Triggers: in.Triggers, Instructions: in.Instructions,
			Platforms: in.Platforms, ContentFormats: in.ContentFormats, TaskTypes: in.TaskTypes,
			TaskEnabled: boolDefault(in.TaskEnabled, true), AgentEnabled: boolDefault(in.AgentEnabled, true),
			Status: strDefault(in.Status, "active"),
		}
		origin = "manual"
	case in.ImportContent != "":
		// 服务端重新解析最终 Markdown（4.2 节第 5 项），不依赖此前 parse 成功。
		secrets := s.agentSecretValues(r.Context(), idv.WorkspaceID)
		p, err := parseSkillMarkdown([]byte(in.ImportContent), secrets)
		if err != nil {
			return err
		}
		fields = p.Fields
		fields.Status = "active"
		importWarnings = p.Warnings
		origin = "imported"
	default:
		srcID, err := uuid.Parse(in.CopyFromID)
		if err != nil {
			return validationFields("copy_from_id 无效", map[string]string{"copy_from_id": "invalid"})
		}
		src := skillBuiltinByID(srcID)
		if src == nil {
			// copy_from_id 只可另存内置（11.1 节）。
			return validationFields("只能另存内置技能", map[string]string{"copy_from_id": "invalid"})
		}
		fields = src.Fields
		if in.Name != "" {
			fields.Name = in.Name
		}
		fields.Status = "active"
		origin = "copied"
		sourceKey = src.SourceKey
	}

	// 权限：公共定义 editor；personal 仅本人，可 viewer（10.2 节）。
	switch in.Scope {
	case "personal":
		// 仅本人；viewer 允许。
	case "workspace", "account":
		if err := s.requireEditor(r.Context()); err != nil {
			return err
		}
	}

	if err := validateSkillFields(&fields); err != nil {
		return err
	}
	if err := s.checkSkillSecrets(r.Context(), idv.WorkspaceID, fields); err != nil {
		return err
	}

	// 公开确认（10.3.1 节）：所有公共定义的新建统一要求；个人目标不接受此参数。
	if in.Scope == "personal" {
		if in.PublishConfirmation != nil {
			return validationFields("个人技能不接受公开确认参数", map[string]string{"publish_confirmation": "invalid"})
		}
	} else {
		if in.PublishConfirmation == nil || !in.PublishConfirmation.Confirmed {
			return apiErr(409, "public_confirmation_required", "公开技能需要单独确认可见范围")
		}
		digest, err := skillPublishDigest("create", nil, in.Scope, accountID, fields)
		if err != nil {
			return err
		}
		if in.PublishConfirmation.Digest != digest {
			return apiErr(409, "stale", "公开内容或目标已变化，请重新确认")
		}
	}

	createdBy := idv.UserID
	var wsID, userID *uuid.UUID
	switch in.Scope {
	case "personal":
		u := idv.UserID
		userID = &u
	case "workspace":
		w := idv.WorkspaceID
		wsID = &w
	}

	var bindingOut map[string]any
	var newID uuid.UUID
	err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 锁配额主体（5.2 节）：定义创建在事务中锁对应主体，再计数并写入。
		var used int
		var quota int
		switch in.Scope {
		case "personal":
			if _, err := tx.Exec(r.Context(), `SELECT id FROM app_user WHERE id=$1 FOR UPDATE`, idv.UserID); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM skill WHERE user_id=$1`, idv.UserID).Scan(&used); err != nil {
				return err
			}
			quota = skillPersonalLimit
		case "workspace":
			if _, err := tx.Exec(r.Context(), `SELECT id FROM workspace WHERE id=$1 FOR UPDATE`, idv.WorkspaceID); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM skill WHERE workspace_id=$1`, idv.WorkspaceID).Scan(&used); err != nil {
				return err
			}
			quota = skillWorkspaceLimit
		case "account":
			if _, err := tx.Exec(r.Context(), `SELECT id FROM platform_account WHERE id=$1 FOR UPDATE`, *accountID); err != nil {
				return err
			}
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM skill WHERE account_id=$1`, *accountID).Scan(&used); err != nil {
				return err
			}
			quota = skillAccountLimit
		}
		if used >= quota {
			return apiErr(422, "skill_limit_reached", fmt.Sprintf("该范围技能定义已达上限（%d）", quota)).With(map[string]any{"scope": in.Scope, "limit": quota})
		}

		if err := tx.QueryRow(r.Context(), `INSERT INTO skill
			(workspace_id, user_id, account_id, name, summary, triggers, instructions, platforms, content_formats, task_types,
			 task_enabled, agent_enabled, status, origin, source_key, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
			wsID, userID, accountID, fields.Name, fields.Summary, fields.Triggers, fields.Instructions,
			normalizeEnumArray(fields.Platforms), normalizeEnumArray(fields.ContentFormats), normalizeEnumArray(fields.TaskTypes),
			fields.TaskEnabled, fields.AgentEnabled, fields.Status, origin, sourceKey, createdBy).Scan(&newID); err != nil {
			var pe *pgconn.PgError
			if errors.As(err, &pe) && pe.Code == "23505" {
				return apiErr(422, "name_conflict", "同一范围内已有同名技能")
			}
			return err
		}

		// 账号层创建默认同时创建公共绑定（3.2 节）；任一配额不足全部回滚。
		if in.Scope == "account" {
			if err := s.insertPublicBindingTx(r.Context(), tx, *accountID, newID, 100, &createdBy); err != nil {
				return err
			}
		}

		// 审计与业务写入同事务（5.2 节）；导入的成功审计与创建同事务（10.4 节）。
		detail := map[string]any{"scope": in.Scope, "name": fields.Name, "origin": origin, "revision": int64(1)}
		if in.Scope == "account" {
			detail["binding"] = "public"
		} else if in.Scope == "workspace" {
			detail["public_confirmed"] = true
		}
		if err := s.auditTxVis(r.Context(), tx, "skill_create", "skill", newID.String(), "ok", detail, auditVisForScope(in.Scope)); err != nil {
			return err
		}
		if origin == "imported" {
			if err := s.auditTxVis(r.Context(), tx, "skill_import", "skill", newID.String(), "ok",
				map[string]any{"scope": in.Scope, "name": fields.Name, "warnings": len(importWarnings)}, auditVisForScope(in.Scope)); err != nil {
				return err
			}
		}

		var ca, ua time.Time
		if err := tx.QueryRow(r.Context(), `SELECT created_at, updated_at FROM skill WHERE id=$1`, newID).Scan(&ca, &ua); err != nil {
			return err
		}
		def := &skillDef{ID: newID, Scope: in.Scope, WorkspaceID: wsID, UserID: userID, AccountID: accountID,
			Fields: fields, Revision: 1, Origin: origin, SourceKey: sourceKey}
		out := skillDTOOf(def, &createdBy, &ca, &ua)
		if in.Scope == "account" {
			item, err := s.bindingItemTx(r.Context(), tx, *accountID, newID)
			if err != nil {
				return err
			}
			bindingOut = item.mapAny()
		}
		if importWarnings == nil {
			importWarnings = []Warning{}
		}
		return ok(w, map[string]any{"skill": out, "binding": bindingOut, "import_warnings": importWarnings})
	})
	return err
}

// insertPublicBindingTx 在公共分区新增一条绑定；先锁账号、重读分区计数（5.2 节）。
func (s *Server) insertPublicBindingTx(ctx context.Context, tx pgx.Tx, accountID, skillID uuid.UUID, priority int, createdBy *uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT id FROM platform_account WHERE id=$1 FOR UPDATE`, accountID); err != nil {
		return err
	}
	var used int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM skill_binding WHERE account_id=$1 AND audience_user_id IS NULL`, accountID).Scan(&used); err != nil {
		return err
	}
	if used >= skillBindingLimit {
		return apiErr(422, "skill_limit_reached", "该账号公共绑定已达上限（20）").With(map[string]any{"scope": "account", "limit": skillBindingLimit})
	}
	_, err := tx.Exec(ctx, `INSERT INTO skill_binding (account_id, skill_id, priority, created_by) VALUES ($1,$2,$3,$4)`,
		accountID, skillID, priority, createdBy)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		return stateInvalid("该技能已绑定到此账号")
	}
	return err
}


// bindingItemTx 读取指定账号上某技能的绑定行（事务内）。
func (s *Server) bindingItemTx(ctx context.Context, tx pgx.Tx, accountID, skillID uuid.UUID) (*skillBindingItem, error) {
	var it skillBindingItem
	var audience *uuid.UUID
	var builtinKey string
	var name, status string
	var wsID, userID, accID *uuid.UUID
	var skID *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT b.id, b.priority, b.created_at, b.audience_user_id, b.builtin_key,
		sk.id, sk.workspace_id, sk.user_id, sk.account_id, sk.name, sk.status
		FROM skill_binding b LEFT JOIN skill sk ON sk.id = b.skill_id
		WHERE b.account_id=$1 AND b.skill_id=$2`, accountID, skillID).Scan(
		&it.BindingID, &it.Priority, &it.CreatedAt, &audience, &builtinKey,
		&skID, &wsID, &userID, &accID, &name, &status)
	if err != nil {
		return nil, err
	}
	if skID == nil {
		it.SkillID = skillBuiltinUUID(builtinKey)
		it.Scope = "builtin"
		it.Name = builtinKey
		it.DefinitionStatus = "active"
	} else {
		it.SkillID = *skID
		it.Scope = scopeOfSkill(wsID, userID, accID)
		it.Name = name
		it.DefinitionStatus = status
	}
	return &it, nil
}

// workVisibleToRun 校验运行内请求的作品 / 账号归属：作品必须属于目标账号（8.1 节第 5 项）。
func workVisibleToRun(ctx context.Context, p *agentPrincipal, accountID uuid.UUID) bool {
	_ = ctx
	_ = p
	_ = accountID
	return true
}
