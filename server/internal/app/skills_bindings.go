package app

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DEV-SK1 / docs/23 第 11.2–11.3 节：绑定配置、单项绑定 CAS 与上下文预览。

// BindingItem（11.2 节）：配置不声称 selected / used。
type skillBindingItem struct {
	BindingID        uuid.UUID `json:"binding_id"`
	SkillID          uuid.UUID `json:"skill_id"`
	Scope            string    `json:"scope"`
	Name             string    `json:"name"`
	Priority         int       `json:"priority"`
	CreatedAt        time.Time `json:"created_at"`
	DefinitionStatus string    `json:"definition_status"`
}

func (it *skillBindingItem) mapAny() map[string]any {
	return map[string]any{
		"binding_id": it.BindingID, "skill_id": it.SkillID, "scope": it.Scope,
		"name": it.Name, "priority": it.Priority, "created_at": it.CreatedAt,
		"definition_status": it.DefinitionStatus,
	}
}

// skillPartRow 是一个绑定分区的一行：绑定 + 解析出的定义。
type skillPartRow struct {
	Binding   skillBindingItem
	Audience  *uuid.UUID
	Builtin   bool
	Layer     int // 账号 1 / 工作区 2 / 内置 3 / 个人 0
	CreatedAt time.Time
}

// loadSkillPartition 读取指定分区并按解析层顺序、priority、创建时间、技能 ID 排序。
func (s *Server) loadSkillPartition(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, accountID uuid.UUID, audience *uuid.UUID) ([]skillPartRow, string, error) {
	sql := `SELECT b.id, b.priority, b.created_at, b.audience_user_id, b.builtin_key,
		sk.id, sk.workspace_id, sk.user_id, sk.account_id, COALESCE(sk.name,''), COALESCE(sk.status,'')
		FROM skill_binding b LEFT JOIN skill sk ON sk.id = b.skill_id
		WHERE b.account_id = $1`
	args := []any{accountID}
	if audience != nil {
		sql += ` AND b.audience_user_id = $2`
		args = append(args, *audience)
	} else {
		sql += ` AND b.audience_user_id IS NULL`
	}
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	var out []skillPartRow
	fingers := []skillBindingFinger{}
	for rows.Next() {
		var (
			bindingID           uuid.UUID
			priority            int
			createdAt           time.Time
			aud                 *uuid.UUID
			builtin             string
			skID                *uuid.UUID
			wsID, userID, accID *uuid.UUID
			name, status        string
		)
		if err := rows.Scan(&bindingID, &priority, &createdAt, &aud, &builtin,
			&skID, &wsID, &userID, &accID, &name, &status); err != nil {
			return nil, "", err
		}
		row := skillPartRow{Audience: aud, Builtin: skID == nil, CreatedAt: createdAt,
			Binding: skillBindingItem{BindingID: bindingID, Priority: priority, CreatedAt: createdAt}}
		if skID == nil {
			// 内置绑定按规范 key 解析；退役 key 保留配置项（可取消启用），不宣称生效。
			row.Binding.SkillID = skillBuiltinUUID(builtin)
			row.Binding.Scope = "builtin"
			row.Binding.Name = builtin
			row.Binding.DefinitionStatus = "disabled"
			row.Layer = 3
			if def := skillBuiltinByKey(builtin); def != nil {
				row.Binding.Name = def.Fields.Name
				row.Binding.DefinitionStatus = "active"
			}
		} else {
			row.Binding.SkillID = *skID
			row.Binding.Scope = scopeOfSkill(wsID, userID, accID)
			row.Binding.Name = name
			row.Binding.DefinitionStatus = status
			row.Layer = skillLayer(&skillDef{Scope: row.Binding.Scope, AccountID: accID, WorkspaceID: wsID}, accountID)
		}
		out = append(out, row)
		fingers = append(fingers, skillBindingFinger{BindingID: bindingID, SkillID: row.Binding.SkillID, Priority: priority, CreatedAt: createdAt})
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Layer != b.Layer {
			return a.Layer < b.Layer
		}
		if a.Binding.Priority != b.Binding.Priority {
			return a.Binding.Priority < b.Binding.Priority
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.Before(b.CreatedAt)
		}
		return a.Binding.SkillID.String() < b.Binding.SkillID.String()
	})
	fp, err := skillPartitionFingerprint(accountID, audience, fingers)
	if err != nil {
		return nil, "", err
	}
	return out, fp, nil
}

// GET /accounts/{id}/skill-bindings：public 与 mine 两个可见分区；不返回其他人的个人数量或配置。
func (s *Server) getSkillBindings(w http.ResponseWriter, r *http.Request) error {
	accID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	acc, err := s.visibleAccount(r.Context(), accID)
	if err != nil {
		return err
	}
	idv := ident(r.Context())
	self := idv.UserID
	pubRows, pubFP, err := s.loadSkillPartition(r.Context(), s.db, acc.ID, nil)
	if err != nil {
		return err
	}
	mineRows, mineFP, err := s.loadSkillPartition(r.Context(), s.db, acc.ID, &self)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"account_id": acc.ID,
		"public":     skillPartitionJSON(pubRows, pubFP),
		"mine":       skillPartitionJSON(mineRows, mineFP),
	})
}

func skillPartitionJSON(rows []skillPartRow, fp string) map[string]any {
	items := make([]skillBindingItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.Binding)
	}
	return map[string]any{"base_revision": fp, "count": len(rows), "limit": skillBindingLimit, "items": items}
}

// PUT /accounts/{id}/skill-bindings/{audience}/{skillId}：单项修改，幂等请求不重置 created_at。
func (s *Server) putSkillBinding(w http.ResponseWriter, r *http.Request) error {
	accID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	audience := chiParam(r, "audience")
	if audience != "public" && audience != "personal" {
		return validationFields("audience 只支持 public 或 personal", map[string]string{"audience": "invalid"})
	}
	skillID, err := pathID(r, "skillId")
	if err != nil {
		return err
	}
	var in struct {
		Enabled      bool   `json:"enabled"`
		Priority     *int   `json:"priority"`
		BaseRevision string `json:"base_revision"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	if in.Priority != nil && (*in.Priority < 0 || *in.Priority > 999) {
		return validationFields("priority 范围 0..999", map[string]string{"priority": "invalid"})
	}
	if !in.Enabled && in.Priority != nil {
		return validationFields("取消启用时不能携带 priority", map[string]string{"priority": "invalid"})
	}
	if !stringsHasPrefix(in.BaseRevision, "sb1:") {
		return validationFields("base_revision 必须是 sb1 分区指纹", map[string]string{"base_revision": "invalid"})
	}

	idv := ident(r.Context())
	// 可见性优先（11.5 节）：先解析账号与技能的租户 / 本人可见性，再做角色判断。
	acc, err := s.visibleAccount(r.Context(), accID)
	if err != nil {
		return err
	}
	sr, err := s.skillVisibleDef(r.Context(), skillID)
	if err != nil {
		return err
	}
	def := sr.Def
	isBuiltin := def.Builtin
	if audience == "public" {
		if err := s.requireEditor(r.Context()); err != nil {
			return err
		}
		// 公共绑定只能引用内置 / 本工作区 / 本账号技能（3.2 节）。
		if !isBuiltin {
			switch def.Scope {
			case "workspace", "account":
			default:
				return validationFields("公共绑定只能引用内置 / 本工作区 / 本账号技能", map[string]string{"skill_id": "invalid"})
			}
		}
	} else {
		// 本人绑定：只能引用本人的个人技能；创建人必须也是本人；viewer 一律 403。
		if isBuiltin || def.Scope != "personal" || def.UserID == nil || *def.UserID != idv.UserID {
			return errNotFound
		}
		if err := s.requireEditor(r.Context()); err != nil {
			return err
		}
	}

	var audienceUID *uuid.UUID
	if audience == "personal" {
		u := idv.UserID
		audienceUID = &u
	}

	// 成员退出与绑定写入串行化（5.2.1 节）：个人绑定事务先对真实 membership 行加共享锁。
	if audience == "personal" {
		if _, err := s.db.Exec(r.Context(), `SELECT id FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,
			idv.WorkspaceID, idv.UserID); err != nil {
			return err
		}
	}

	// 先核验修订（旧修订一律 stale，即使请求结果看起来已达成也不跳过 CAS）。
	_, currentFP, err := s.loadSkillPartition(r.Context(), s.db, acc.ID, audienceUID)
	if err != nil {
		return err
	}
	if currentFP != in.BaseRevision {
		return apiErr(409, "stale", "绑定配置已被其他人修改，请重新读取")
	}

	var resp struct {
		audience string
		changed  bool
		fp       string
		count    int
		item     *skillBindingItem
	}
	resp.audience = audience
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `SELECT id FROM platform_account WHERE id=$1 FOR UPDATE`, acc.ID); err != nil {
			return err
		}
		rows, fp, err := s.loadSkillPartition(r.Context(), tx, acc.ID, audienceUID)
		if err != nil {
			return err
		}
		if fp != in.BaseRevision {
			return apiErr(409, "stale", "绑定配置已被其他人修改，请重新读取")
		}
		resp.fp = fp
		resp.count = len(rows)
		// 查找现有绑定：内置按 key，数据库技能按 skill_id。
		var existing *skillPartRow
		for i := range rows {
			if rows[i].Binding.SkillID == def.ID {
				existing = &rows[i]
				break
			}
		}
		if in.Enabled {
			if existing != nil {
				newPriority := existing.Binding.Priority
				if in.Priority != nil && *in.Priority != newPriority {
					if _, err := tx.Exec(r.Context(), `UPDATE skill_binding SET priority=$2 WHERE id=$1`,
						existing.Binding.BindingID, *in.Priority); err != nil {
						return err
					}
					resp.changed = true
					newPriority = *in.Priority
				}
				resp.item = &skillBindingItem{BindingID: existing.Binding.BindingID, SkillID: def.ID,
					Scope: existing.Binding.Scope, Name: existing.Binding.Name,
					Priority: newPriority, CreatedAt: existing.CreatedAt, DefinitionStatus: existing.Binding.DefinitionStatus}
				rows2, fp2, err := s.loadSkillPartition(r.Context(), tx, acc.ID, audienceUID)
				if err != nil {
					return err
				}
				resp.fp, resp.count = fp2, len(rows2)
				return nil
			}
			// 新增：重读分区计数（锁内）。
			var used int
			if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM skill_binding WHERE account_id=$1 AND audience_user_id IS NOT DISTINCT FROM $2`,
				acc.ID, audienceUID).Scan(&used); err != nil {
				return err
			}
			if used >= skillBindingLimit {
				return apiErr(422, "skill_limit_reached", "该分区绑定已达上限（20）").With(map[string]any{"limit": skillBindingLimit})
			}
			priority := 100
			if in.Priority != nil {
				priority = *in.Priority
			}
			var bindID uuid.UUID
			var bindSQL string
			var args []any
			if isBuiltin {
				bindSQL = `INSERT INTO skill_binding (account_id, audience_user_id, builtin_key, priority, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`
				args = []any{acc.ID, audienceUID, def.BuiltinKey, priority, idv.UserID}
			} else {
				bindSQL = `INSERT INTO skill_binding (account_id, audience_user_id, skill_id, priority, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`
				args = []any{acc.ID, audienceUID, def.ID, priority, idv.UserID}
			}
			if err := tx.QueryRow(r.Context(), bindSQL, args...).Scan(&bindID); err != nil {
				var pe *pgconn.PgError
				if errors.As(err, &pe) && pe.Code == "23505" {
					return stateInvalid("该技能已绑定到此账号")
				}
				return err
			}
			resp.changed = true
		} else {
			if existing != nil {
				if _, err := tx.Exec(r.Context(), `DELETE FROM skill_binding WHERE id=$1`, existing.Binding.BindingID); err != nil {
					return err
				}
				resp.changed = true
			}
			resp.item = nil
		}
		rows2, fp2, err := s.loadSkillPartition(r.Context(), tx, acc.ID, audienceUID)
		if err != nil {
			return err
		}
		resp.fp, resp.count = fp2, len(rows2)
		if resp.item == nil && in.Enabled {
			for i := range rows2 {
				if rows2[i].Binding.SkillID == def.ID {
					resp.item = &rows2[i].Binding
					break
				}
			}
		}
		// 绑定变更与审计同事务（5.2 节）：日志失败回滚业务写入；
		// 无变化请求不重复审计（11.3 节）。
		if resp.changed {
			detail := map[string]any{"audience": audience, "enabled": in.Enabled, "partition_count": resp.count}
			if in.Priority != nil {
				detail["priority"] = *in.Priority
			}
			if !isBuiltin {
				detail["skill_id"] = def.ID.String()
			}
			vis := auditVisWorkspace
			if audience == "personal" {
				vis = auditVisPersonal
			}
			if err := s.auditTxVis(r.Context(), tx, "skill_binding_update", "platform_account", acc.ID.String(), "ok", detail, vis); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	// 审计在响应写入前完成即可；读回最终 item。
	if resp.item == nil && in.Enabled {
		rows3, _, err := s.loadSkillPartition(r.Context(), s.db, acc.ID, audienceUID)
		if err == nil {
			for i := range rows3 {
				if rows3[i].Binding.SkillID == def.ID {
					resp.item = &rows3[i].Binding
					break
				}
			}
		}
	}
	var itemOut any
	if resp.item != nil {
		itemOut = resp.item.mapAny()
	}
	return ok(w, map[string]any{
		"audience": resp.audience, "changed": resp.changed, "base_revision": resp.fp,
		"count": resp.count, "limit": skillBindingLimit, "item": itemOut,
	})
}

func stringsHasPrefix(s, p string) bool {
	return len(s) >= len(p) && s[:len(p)] == p
}

// GET /accounts/{id}/skill-context：解析 / 预算预览（11.2 节）。
func (s *Server) getSkillContext(w http.ResponseWriter, r *http.Request) error {
	accID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	acc, err := s.visibleAccount(r.Context(), accID)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	surface := q.Get("surface")
	if surface != "task" && surface != "agent" {
		return validationFields("surface 只支持 task 或 agent", map[string]string{"surface": "invalid"})
	}
	var taskType *string
	if v := q.Get("task_type"); v != "" {
		if surface == "agent" {
			return validationFields("agent 预览不接受 task_type", map[string]string{"task_type": "invalid"})
		}
		taskType = &v
	}
	if surface == "task" && taskType == nil {
		return validationFields("task 预览必须提供 task_type", map[string]string{"task_type": "required"})
	}
	var workID *uuid.UUID
	if v := q.Get("work_id"); v != "" {
		wid, err := uuid.Parse(v)
		if err != nil {
			return errNotFound
		}
		workID = &wid
	}
	idv := ident(r.Context())
	ctxStatus := "ok"
	if acc.Status != "active" {
		ctxStatus = "account_disabled"
	}
	if ctxStatus == "ok" && surface == "task" && !skillTaskAllowed(*taskType) {
		ctxStatus = "task_unsupported"
	}
	contextObj := map[string]any{
		"account_id": acc.ID, "work_id": canonUUID(workID), "surface": surface,
		"task_type": taskType, "actor_kind": "user",
	}
	if ctxStatus != "ok" {
		return ok(w, map[string]any{
			"context": contextObj, "context_status": ctxStatus, "can_execute": false,
			"budget": skillSlotBudget, "assembled_chars": nil, "items": []any{}, "personal_used_count": 0,
		})
	}
	targetFormat, err := s.skillResolveTargetFormat(r.Context(), acc, workID, q.Get("target_format"))
	if err != nil {
		return err
	}
	contextObj["target_format"] = targetFormat
	preview := idv.Role == "viewer"
	res, err := s.resolveSkillSet(r.Context(), SkillResolveInput{
		WorkspaceID: idv.WorkspaceID, Account: acc, ActorKind: "user", ActorUserID: &idv.UserID,
		WorkID: workID, TargetFormat: targetFormat, Surface: surface, TaskType: strDeref(taskType),
		Bare: false, Preview: preview,
	})
	if err != nil {
		return err
	}
	items := []map[string]any{}
	personalUsed := 0
	var assembled any
	if surface == "agent" {
		// 智能体预览不模拟模型选择（11.2 节）：入选项 selected=true、used=false、reason=not_loaded。
		for _, it := range res.Items {
			selected := it.Reason == ""
			reason := it.Reason
			if selected {
				reason = skillReasonNotLoaded
			}
			items = append(items, map[string]any{
				"id": it.Def.ID, "name": it.Def.Fields.Name, "scope": it.Def.Scope,
				"revision": it.Def.Revision, "content_hash": it.Def.contentHash(),
				"selected": selected, "used": false, "reason": reason, "chars": 0,
			})
		}
	} else {
		// 预览按候选集顺序展示全部条目：落选项带首个排除原因（11.2 节 SkillUseItem）。
		_, trace, total := assembleSkillSlot(res.Items)
		if total > 0 {
			assembled = total
		}
		for _, tr := range trace {
			var reason any
			if tr.Reason != "" {
				reason = tr.Reason
			}
			// selected 表示入选（过滤通过）；budget_exceeded 属于入选但未装入。
			sel := reason == nil || tr.Reason == skillReasonBudget
			items = append(items, map[string]any{
				"id": tr.Def.ID, "name": tr.Def.Fields.Name, "scope": tr.Def.Scope,
				"revision": tr.Def.Revision, "content_hash": tr.Def.contentHash(),
				"selected": sel, "used": tr.Used, "reason": reason, "chars": tr.Chars,
			})
			if tr.Used && tr.Def.Scope == "personal" {
				personalUsed++
			}
		}
	}
	return ok(w, map[string]any{
		"context": contextObj, "context_status": "ok",
		"can_execute": !preview, "budget": skillSlotBudget,
		"assembled_chars": assembled, "items": items, "personal_used_count": personalUsed,
	})
}

func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// skillRoutes 注册技能接口（23 文档第 11 节）。
func (s *Server) skillRoutes(r chi.Router) {
	r.Get("/skills", s.h(s.listSkills))
	r.Post("/skills", s.h(s.createSkill))
	r.Post("/skills/parse", s.h(s.parseSkill))
	r.Post("/skills/draft", s.h(s.draftSkill))
	r.Get("/skills/{id}", s.h(s.getSkill))
	r.Put("/skills/{id}", s.h(s.putSkill))
	r.Delete("/skills/{id}", s.h(s.deleteSkill))
	r.Get("/skills/{id}/impact", s.h(s.getSkillImpact))
	r.Get("/skills/{id}/export", s.h(s.exportSkill))
	r.Get("/accounts/{accountId}/skill-bindings", s.h(s.getSkillBindings))
	r.Put("/accounts/{accountId}/skill-bindings/{audience}/{skillId}", s.h(s.putSkillBinding))
	r.Get("/accounts/{accountId}/skill-context", s.h(s.getSkillContext))
	r.Get("/ai-calls/{id}/skill-context", s.h(s.getAICallSkillContext))
}
