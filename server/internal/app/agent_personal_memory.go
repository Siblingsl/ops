package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-13（W13）：个人跨对话记忆（27 文档 §11.1）。
// 状态机 candidate → active / ignored；active → disabled / source_unavailable / deleted。
// 候选不参与注入；确认只能由本人 PATCH（模型/工具只能提案 candidate）；无"全部确认"。
// 删除仅保留无正文标记用于去重；同 hash 被忽略/删除后不再反复生成（27 §11.1.2）。
// 注入预算：本人 active 项按更新时间取 ≤10 条、合计 ≤2000 字（27 §11.1.2 建议值）。

const (
	personalMemoryMaxText   = 2000
	personalMemoryInjectMax = 10
	personalMemoryBudget    = 2000
)

type personalMemory struct {
	ID          string `json:"id"`
	Text        string `json:"text"`
	State       string `json:"state"`
	SourceRef   string `json:"source_conversation_id,omitempty"`
	Revision    int64  `json:"revision"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	Superseded  string `json:"supersedes_id,omitempty"`
}

type memorySettingsView struct {
	UseEnabled     bool   `json:"use_enabled"`
	CaptureEnabled bool   `json:"capture_enabled"`
	Revision       int64  `json:"revision"`
}

func personalMemoryHash(text string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(text)))
	return hex.EncodeToString(sum[:])
}

// personalMemoryGuard：viewer 与代访问拒绝；个人记忆是本人私有功能。
func (s *Server) personalMemoryGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "memory_policy_denied", "代访问期间不能使用个人记忆")
	}
	if id.Role == "viewer" {
		return apiErr(403, "memory_policy_denied", "观察者角色未开放个人记忆")
	}
	return nil
}

// GET /agent/personal-memories?state=candidate
func (s *Server) listPersonalMemories(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	state := r.URL.Query().Get("state")
	args := []any{id.UserID, id.WorkspaceID}
	query := `SELECT id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
		to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
		COALESCE(supersedes_id::text,'')
		FROM agent_personal_memory WHERE user_id=$1 AND workspace_id=$2`
	switch state {
	case "candidate", "active", "ignored", "disabled", "source_unavailable":
		query += ` AND state=$3`
		args = append(args, state)
	case "":
		query += ` AND state <> 'deleted'`
	default:
		return apiErr(422, "validation_failed", "未知状态筛选")
	}
	query += ` ORDER BY updated_at DESC LIMIT 200`
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []personalMemory{}
	for rows.Next() {
		var m personalMemory
		if err := rows.Scan(&m.ID, &m.Text, &m.State, &m.SourceRef, &m.Revision, &m.CreatedAt, &m.UpdatedAt, &m.Superseded); err != nil {
			return err
		}
		items = append(items, m)
	}
	return ok(w, map[string]any{"memories": items})
}

// POST /agent/personal-memories：本人显式创建（直接 active）。
func (s *Server) createPersonalMemory(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || len([]rune(text)) > personalMemoryMaxText {
		return apiErr(422, "validation_failed", "记忆内容需 1～2000 字")
	}
	hash := personalMemoryHash(text)
	memoryID := uuid.New()
	var created personalMemory
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 同 hash 已有候选/active：幂等返回既有项（不重复入库）。
		existing, err := tx.Query(r.Context(), `
			SELECT id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
				to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''
			FROM agent_personal_memory WHERE user_id=$1 AND content_hash=$2 AND state IN ('candidate','active')`,
			id.UserID, hash)
		if err != nil {
			return err
		}
		defer existing.Close()
		if existing.Next() {
			return existing.Scan(&created.ID, &created.Text, &created.State, &created.SourceRef, &created.Revision, &created.CreatedAt, &created.UpdatedAt, &created.Superseded)
		}
		existing.Close()
		row := tx.QueryRow(r.Context(), `
			INSERT INTO agent_personal_memory (id, workspace_id, user_id, text, state, content_hash)
			VALUES ($1,$2,$3,$4,'active',$5)
			RETURNING id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
				to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''`,
			memoryID, id.WorkspaceID, id.UserID, text, hash)
		return row.Scan(&created.ID, &created.Text, &created.State, &created.SourceRef, &created.Revision, &created.CreatedAt, &created.UpdatedAt, &created.Superseded)
	}); err != nil {
		return err
	}
	return ok(w, created)
}

// PATCH /agent/personal-memories/{id}：本人 CAS 操作。action: confirm/edit/ignore/disable。
func (s *Server) patchPersonalMemory(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	memoryID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		Action           string `json:"action"`
		Text             string `json:"text"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	text := strings.TrimSpace(body.Text)
	if body.Action == "edit" && (text == "" || len([]rune(text)) > personalMemoryMaxText) {
		return apiErr(422, "validation_failed", "记忆内容需 1～2000 字")
	}
	var updated personalMemory
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var current string
		var revision int64
		if err := tx.QueryRow(r.Context(), `
			SELECT state, revision FROM agent_personal_memory
			WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state <> 'deleted'`,
			memoryID, id.UserID, id.WorkspaceID).Scan(&current, &revision); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		if revision != body.ExpectedRevision {
			return apiErr(409, "memory_revision_conflict", "记忆已被修改，请刷新后重试")
		}
		var nextState string
		switch body.Action {
		case "confirm":
			if current != "candidate" {
				return apiErr(409, "memory_state_conflict", "只有候选可以确认")
			}
			nextState = "active"
		case "edit":
			if current != "candidate" && current != "active" {
				return apiErr(409, "memory_state_conflict", "当前状态不可编辑")
			}
			nextState = "active"
		case "ignore":
			if current != "candidate" {
				return apiErr(409, "memory_state_conflict", "只有候选可以忽略")
			}
			nextState = "ignored"
		case "disable":
			if current != "active" {
				return apiErr(409, "memory_state_conflict", "只有启用中的记忆可以停用")
			}
			nextState = "disabled"
		default:
			return apiErr(422, "validation_failed", "未知操作")
		}
		// 编辑会改内容：换 hash 前查重（同 hash 已 active 则冲突）。
		if body.Action == "edit" {
			newHash := personalMemoryHash(text)
			var dup bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS(SELECT 1 FROM agent_personal_memory
					WHERE user_id=$1 AND content_hash=$2 AND state IN ('candidate','active') AND id<>$3)`,
				id.UserID, newHash, memoryID).Scan(&dup); err != nil {
				return err
			}
			if dup {
				return apiErr(409, "memory_duplicate", "已存在相同内容的记忆")
			}
			row := tx.QueryRow(r.Context(), `
				UPDATE agent_personal_memory SET text=$2, content_hash=$3, state='active', revision=revision+1, updated_at=now()
				WHERE id=$1
				RETURNING id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
					to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
					to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''`,
				memoryID, text, newHash)
			return row.Scan(&updated.ID, &updated.Text, &updated.State, &updated.SourceRef, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt, &updated.Superseded)
		}
		row := tx.QueryRow(r.Context(), `
			UPDATE agent_personal_memory SET state=$2, revision=revision+1, updated_at=now()
			WHERE id=$1
			RETURNING id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
				to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''`,
			memoryID, nextState)
		return row.Scan(&updated.ID, &updated.Text, &updated.State, &updated.SourceRef, &updated.Revision, &updated.CreatedAt, &updated.UpdatedAt, &updated.Superseded)
	}); err != nil {
		return err
	}
	return ok(w, updated)
}

// DELETE /agent/personal-memories/{id}：删除；仅保留无正文标记用于去重（27 §11.1.2）。
func (s *Server) deletePersonalMemory(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	memoryID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE agent_personal_memory SET state='deleted', text='', revision=revision+1, updated_at=now()
		WHERE id=$1 AND user_id=$2 AND workspace_id=$3 AND state <> 'deleted'`,
		memoryID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	// 删除即停止注入：清理未决 usage 记录语义由 run 端组装时按 state 过滤，这里无需回滚已发内容。
	return ok(w, map[string]any{"deleted": true})
}

// GET /agent/memory-settings?conversation_id=：全局 + 会话覆盖 + effective。
func (s *Server) getMemorySettings(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	var global memorySettingsView
	if err := s.db.QueryRow(r.Context(), `
		SELECT use_enabled, capture_enabled, revision FROM agent_memory_setting WHERE user_id=$1`,
		id.UserID).Scan(&global.UseEnabled, &global.CaptureEnabled, &global.Revision); err != nil {
		if err == pgx.ErrNoRows {
			global = memorySettingsView{UseEnabled: true, CaptureEnabled: true, Revision: 1}
		} else {
			return err
		}
	}
	effectiveUse, effectiveCapture := global.UseEnabled, global.CaptureEnabled
	overrides := map[string]string{}
	if raw := r.URL.Query().Get("conversation_id"); raw != "" {
		conversationID, err := uuid.Parse(raw)
		if err != nil {
			return errNotFound
		}
		var useOverride, captureOverride string
		if err := s.db.QueryRow(r.Context(), `
			SELECT memory_use_override, memory_capture_override FROM agent_conversation
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
			conversationID, id.WorkspaceID, id.UserID).Scan(&useOverride, &captureOverride); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		if useOverride == "on" {
			effectiveUse = true
		} else if useOverride == "off" {
			effectiveUse = false
		}
		if captureOverride == "on" {
			effectiveCapture = true
		} else if captureOverride == "off" {
			effectiveCapture = false
		}
		overrides["memory_use_override"] = useOverride
		overrides["memory_capture_override"] = captureOverride
	}
	return ok(w, map[string]any{
		"use_enabled": effectiveUse, "capture_enabled": effectiveCapture,
		"global_use_enabled": global.UseEnabled, "global_capture_enabled": global.CaptureEnabled,
		"revision": global.Revision, "overrides": overrides,
	})
}

// PATCH /agent/memory-settings：全局布尔或会话覆盖（expected_revision CAS 全局）。
func (s *Server) patchMemorySettings(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	var body struct {
		UseEnabled            *bool  `json:"use_enabled"`
		CaptureEnabled        *bool  `json:"capture_enabled"`
		ExpectedRevision      int64  `json:"expected_revision"`
		ConversationID        string `json:"conversation_id"`
		MemoryUseOverride     string `json:"memory_use_override"`
		MemoryCaptureOverride string `json:"memory_capture_override"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	for _, v := range []string{body.MemoryUseOverride, body.MemoryCaptureOverride} {
		if v != "" && v != "on" && v != "off" {
			return apiErr(422, "validation_failed", "覆盖值只能是 on/off/空")
		}
	}
	if body.ConversationID != "" {
		conversationID, err := uuid.Parse(body.ConversationID)
		if err != nil {
			return errNotFound
		}
		tag, err := s.db.Exec(r.Context(), `
			UPDATE agent_conversation SET memory_use_override=$2, memory_capture_override=$3
			WHERE id=$1 AND workspace_id=$4 AND user_id=$5`,
			conversationID, body.MemoryUseOverride, body.MemoryCaptureOverride, id.WorkspaceID, id.UserID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		return ok(w, map[string]any{"updated": true})
	}
	var result memorySettingsView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO agent_memory_setting (user_id) VALUES ($1)
			ON CONFLICT (user_id) DO NOTHING`, id.UserID); err != nil {
			return err
		}
		sets := []string{"updated_at=now()"}
		args := []any{id.UserID}
		if body.UseEnabled != nil {
			args = append(args, *body.UseEnabled)
			sets = append(sets, `use_enabled=$`+strconv.Itoa(len(args)))
		}
		if body.CaptureEnabled != nil {
			args = append(args, *body.CaptureEnabled)
			sets = append(sets, `capture_enabled=$`+strconv.Itoa(len(args)))
		}
		args = append(args, body.ExpectedRevision)
		row := tx.QueryRow(r.Context(), `
			UPDATE agent_memory_setting SET `+strings.Join(sets, ", ")+`, revision=revision+1
			WHERE user_id=$1 AND revision=$`+strconv.Itoa(len(args))+`
			RETURNING use_enabled, capture_enabled, revision`, args...)
		if err := row.Scan(&result.UseEnabled, &result.CaptureEnabled, &result.Revision); err != nil {
			if err == pgx.ErrNoRows {
				return apiErr(409, "memory_revision_conflict", "设置已被修改，请刷新后重试")
			}
			return err
		}
		return nil
	}); err != nil {
		return err
	}
	return ok(w, result)
}

// POST /agent/personal-memory-candidates：run 内部提案端点（toolG memory__propose_candidate 走此路由）。
// 只写 candidate；同 hash 已 candidate/active 幂等返回既有；ignored/deleted 后拒绝再生成。
func (s *Server) proposePersonalMemoryCandidate(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.personalMemoryGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "personal_memories"); err != nil {
		return err
	}
	var body struct {
		Text              string `json:"text"`
		ConversationID    string `json:"conversation_id"`
		ConversationRev   int64  `json:"source_revision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || len([]rune(text)) > personalMemoryMaxText {
		return apiErr(422, "validation_failed", "候选内容需 1～2000 字")
	}
	var sourceID *uuid.UUID
	if body.ConversationID != "" {
		cid, err := uuid.Parse(body.ConversationID)
		if err != nil {
			return apiErr(400, "bad_request", "conversation_id 必须是 UUID")
		}
		// 来源会话必须属于本人当前工作区（防跨租户借道）。
		var okOwner bool
		if err := s.db.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`,
			cid, id.WorkspaceID, id.UserID).Scan(&okOwner); err != nil {
			return err
		}
		if !okOwner {
			return errNotFound
		}
		sourceID = &cid
	}
	hash := personalMemoryHash(text)
	var created personalMemory
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var existingState string
		var existingID uuid.UUID
		err := tx.QueryRow(r.Context(), `
			SELECT id, state FROM agent_personal_memory WHERE user_id=$1 AND content_hash=$2 AND state IN ('candidate','active','ignored')`,
			id.UserID, hash).Scan(&existingID, &existingState)
		switch {
		case err == nil:
			// ignored：同内容不再生成（27 §11.1.2）；candidate/active：幂等返回。
			if existingState == "ignored" {
				return apiErr(409, "memory_ignored_duplicate", "该内容此前已被忽略，不再生成候选")
			}
			row := tx.QueryRow(r.Context(), `
				SELECT id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
					to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
					to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''
				FROM agent_personal_memory WHERE id=$1`, existingID)
			return row.Scan(&created.ID, &created.Text, &created.State, &created.SourceRef, &created.Revision, &created.CreatedAt, &created.UpdatedAt, &created.Superseded)
		case err == pgx.ErrNoRows:
			// 继续创建
		default:
			return err
		}
		row := tx.QueryRow(r.Context(), `
			INSERT INTO agent_personal_memory (id, workspace_id, user_id, text, state, source_conversation_id, source_revision, content_hash)
			VALUES ($1,$2,$3,$4,'candidate',$5,$6,$7)
			RETURNING id::text, text, state, COALESCE(source_conversation_id::text,''), revision,
				to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
				to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''`,
			uuid.New(), id.WorkspaceID, id.UserID, text, sourceID, body.ConversationRev, hash)
		return row.Scan(&created.ID, &created.Text, &created.State, &created.SourceRef, &created.Revision, &created.CreatedAt, &created.UpdatedAt, &created.Superseded)
	}); err != nil {
		return err
	}
	return ok(w, created)
}

// personalMemorySystemBlock：run 组装时调用；返回注入的 system 文本（空=不注入），
// 并把命中/省略写入 agent_memory_usage（27 §11.1.2）。
// 决策链：feature 开关 → 全局 use → 会话覆盖；capture 只约束候选提炼，不影响注入。
func (s *Server) personalMemorySystemBlock(ctx context.Context, userID, workspaceID, conversationID, runID uuid.UUID) string {
	if s.agentWorkbenchFeatures(ctx)["personal_memories"] != true {
		return ""
	}
	var useEnabled, captureEnabled = true, true
	var useOverride, captureOverride string
	err := s.db.QueryRow(ctx, `SELECT use_enabled, capture_enabled FROM agent_memory_setting WHERE user_id=$1`, userID).
		Scan(&useEnabled, &captureEnabled)
	if err != nil && err != pgx.ErrNoRows {
		return ""
	}
	err = s.db.QueryRow(ctx, `SELECT memory_use_override, memory_capture_override FROM agent_conversation WHERE id=$1`, conversationID).
		Scan(&useOverride, &captureOverride)
	if err != nil && err != pgx.ErrNoRows {
		return ""
	}
	effectiveUse := useEnabled
	if useOverride == "on" {
		effectiveUse = true
	} else if useOverride == "off" {
		effectiveUse = false
	}
	if !effectiveUse {
		return ""
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, text, revision FROM agent_personal_memory
		WHERE user_id=$1 AND workspace_id=$2 AND state='active'
		ORDER BY updated_at DESC LIMIT $3`, userID, workspaceID, personalMemoryInjectMax)
	if err != nil {
		return ""
	}
	type entry struct {
		id  uuid.UUID
		rev int64
		rev_ string
		text string
	}
	used := []entry{}
	omitted := []entry{}
	budget := personalMemoryBudget
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.text, &e.rev); err != nil {
			rows.Close()
			return ""
		}
		if len([]rune(e.text)) > budget || len(used) >= personalMemoryInjectMax {
			omitted = append(omitted, e)
			continue
		}
		budget -= len([]rune(e.text))
		used = append(used, e)
	}
	rows.Close()
	for _, e := range used {
		_, _ = s.db.Exec(ctx, `INSERT INTO agent_memory_usage (run_id, memory_id, revision, used) VALUES ($1,$2,$3,true)`, runID, e.id, e.rev)
	}
	for _, e := range omitted {
		reason := "budget"
		if len(used) >= personalMemoryInjectMax {
			reason = "limit"
		}
		_, _ = s.db.Exec(ctx, `INSERT INTO agent_memory_usage (run_id, memory_id, revision, used, omitted_reason) VALUES ($1,$2,$3,false,$4)`, runID, e.id, e.rev, reason)
	}
	if len(used) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n## 本人确认过的长期偏好（跨对话记忆；当前用户明确要求可覆盖）\n")
	for _, e := range used {
		b.WriteString("- " + strings.ReplaceAll(e.text, "\n", " ") + "\n")
	}
	return b.String()
}

