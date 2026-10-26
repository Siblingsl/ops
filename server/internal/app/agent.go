package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 系统智能体（D-117 / 16 文档第 9、10、11 节）。本文件实现数据表对应的对话类接口、
// 工作区设置与页面初始化；运行循环与卡片在 DEV-AG05 / DEV-AG06，附件上传在 DEV-AG07。

const (
	// agentSettingKey 是工作区级智能体设置（16 文档第 10 节说明 4）。
	agentSettingKey = "agent.settings"
	// agentAttachmentDir 是附件在工作目录下的子目录；storage_path 存相对路径，便于整目录迁移。
	agentAttachmentDir = "agent"
)

// ---------- 工作区设置 ----------

// agentSettings 是工作区级智能体设置；缺省为开启、观察者可用、允许选模型。
type agentSettings struct {
	Enabled        bool `json:"enabled"`
	ViewerEnabled  bool `json:"viewer_enabled"`
	AllowModelPick bool `json:"allow_model_pick"`
}

func defaultAgentSettings() agentSettings {
	return agentSettings{Enabled: true, ViewerEnabled: true, AllowModelPick: true}
}

// agentSettingsOf 读取工作区设置；未配置时返回默认值，值损坏时同样回退默认，避免智能体不可用。
func (s *Server) agentSettingsOf(ctx context.Context, ws uuid.UUID) (agentSettings, error) {
	st := defaultAgentSettings()
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key=$2`, ws, agentSettingKey).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if len(raw) > 2 {
		if err := json.Unmarshal(raw, &st); err != nil {
			slog.Warn("智能体设置无法解析，使用默认值", "workspace_id", ws.String(), "err", err)
			return defaultAgentSettings(), nil
		}
	}
	return st, nil
}

func (s *Server) getAgentSettings(w http.ResponseWriter, r *http.Request) error {
	st, err := s.agentSettingsOf(r.Context(), ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	return ok(w, st)
}

func (s *Server) putAgentSettings(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	cur, err := s.agentSettingsOf(ctx, id.WorkspaceID)
	if err != nil {
		return err
	}
	if err := decode(r, &cur); err != nil {
		return err
	}
	b, _ := json.Marshal(cur)
	if _, err := s.db.Exec(ctx, `INSERT INTO app_setting (workspace_id, key, value) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id, key) DO UPDATE SET value=excluded.value`, id.WorkspaceID, agentSettingKey, b); err != nil {
		return err
	}
	s.audit(ctx, "agent_settings_update", "app_setting", agentSettingKey, "ok", map[string]any{
		"enabled": cur.Enabled, "viewer_enabled": cur.ViewerEnabled, "allow_model_pick": cur.AllowModelPick})
	return ok(w, cur)
}

// ---------- 可用性门槛（第 9.2、9.3 节） ----------

// agentAlwaysAllowed 列出不受工作区开关、观察者开关与超管代访问影响的两个入口。
// 两者始终可达，用 can_use / reason 表达当前状态（16 文档第 11 节；用户裁决 2026-10-15）。
func agentAlwaysAllowed(path string) bool {
	return path == "/api/v1/agent/bootstrap" || path == "/api/v1/agent/settings"
}

// agentGate 拦截 /agent/* 中除 bootstrap 与 settings 外的全部接口。
func (s *Server) agentGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if agentAlwaysAllowed(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if err := s.agentAccess(r.Context()); err != nil {
			writeError(w, r, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// agentAccess 判定当前身份能否使用智能体；不能时返回 403 agent_disabled。
func (s *Server) agentAccess(ctx context.Context) error {
	id := ident(ctx)
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "agent_disabled", "代访问期间不能使用智能体")
	}
	st, err := s.agentSettingsOf(ctx, id.WorkspaceID)
	if err != nil {
		return err
	}
	if !st.Enabled {
		return apiErr(403, "agent_disabled", "所有者已关闭智能体")
	}
	if id.Role == "viewer" && !st.ViewerEnabled {
		return apiErr(403, "agent_disabled", "所有者已关闭观察者使用智能体")
	}
	return nil
}

// agentBlockedReason 返回 bootstrap 的 reason（第 11.2 节），可用时为空串。
func (s *Server) agentBlockedReason(ctx context.Context, st agentSettings) string {
	id := ident(ctx)
	switch {
	case id.AdminOverride:
		return "admin_override"
	case !st.Enabled:
		return "disabled"
	case id.Role == "viewer" && !st.ViewerEnabled:
		return "viewer_disabled"
	}
	return ""
}

// ---------- 页面初始化 ----------

type agentModelRef struct {
	ProviderID uuid.UUID `json:"provider_id"`
	Model      string    `json:"model"`
}

type agentModelOption struct {
	ProviderID   uuid.UUID `json:"provider_id"`
	ProviderName string    `json:"provider_name"`
	Model        string    `json:"model"`
	Vision       bool      `json:"vision"`
	IsDefault    bool      `json:"is_default"`
}

// agentModels 返回可选模型（tools_ok=true）、默认模型，以及“默认模型未通过工具调用自检”标记（第 7.4 节）。
func (s *Server) agentModels(ctx context.Context) ([]agentModelOption, *agentModelRef, bool, error) {
	if request, ok := desktopRequestOf(ctx); ok {
		rt, err := s.resolveDesktopRouteTier(ctx, "agent_chat", "", request)
		if err != nil {
			var apiError *APIError
			if errors.As(err, &apiError) {
				return []agentModelOption{}, nil, apiError.Code == "desktop_ai_capability_unsupported", nil
			}
			return nil, nil, false, err
		}
		list := []agentModelOption{}
		def := &agentModelRef{ProviderID: rt.ProviderID, Model: rt.Model}
		if rt.ToolsOK {
			list = append(list, agentModelOption{ProviderID: rt.ProviderID, ProviderName: rt.ProviderName,
				Model: rt.Model, Vision: rt.VisionOK, IsDefault: true})
		}
		if rt.Fallback != nil && rt.Fallback.ToolsOK {
			list = append(list, agentModelOption{ProviderID: rt.Fallback.ProviderID, ProviderName: rt.Fallback.ProviderName,
				Model: rt.Fallback.Model, Vision: rt.Fallback.VisionOK})
		}
		if len(list) == 0 {
			return list, nil, true, nil
		}
		return list, def, false, nil
	}
	ws := ident(ctx).WorkspaceID
	rows, err := s.db.Query(ctx, `SELECT p.id, p.name, m.model, coalesce(m.vision_ok,false)
		FROM model_capability m JOIN model_provider p ON p.id=m.provider_id
		WHERE m.workspace_id=$1 AND p.workspace_id=$1 AND p.execution_location='server' AND m.config_revision=p.desktop_config_revision AND p.status='active' AND m.tools_ok
		ORDER BY p.created_at, m.model`, ws)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()
	list := []agentModelOption{}
	for rows.Next() {
		var m agentModelOption
		if err := rows.Scan(&m.ProviderID, &m.ProviderName, &m.Model, &m.Vision); err != nil {
			return nil, nil, false, err
		}
		list = append(list, m)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}

	// 默认模型取 agent_chat 路由，未配置时回落到 default 路由（第 7.4 节第 2 项）。
	var def *agentModelRef
	unsupported := false
	rt, err := s.resolveRoute(ctx, "agent_chat")
	if err == nil {
		available := false
		for i := range list {
			if list[i].ProviderID == rt.ProviderID && list[i].Model == rt.Model {
				available = true
				list[i].IsDefault = true
			}
		}
		if available {
			def = &agentModelRef{ProviderID: rt.ProviderID, Model: rt.Model}
		} else {
			// 路由指向的模型没有通过工具调用自检：不作为默认，界面提示“默认模型未通过工具调用自检”。
			unsupported = true
		}
	} else {
		var ae *APIError
		if !errors.As(err, &ae) {
			return nil, nil, false, err
		}
	}
	return list, def, unsupported, nil
}

func (s *Server) agentBootstrap(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if _, ok := desktopRequestOf(ctx); ok {
		w.Header().Set("Cache-Control", "no-store")
	}
	id := ident(ctx)
	st, err := s.agentSettingsOf(ctx, id.WorkspaceID)
	if err != nil {
		return err
	}
	models, def, unsupported, err := s.agentModels(ctx)
	if err != nil {
		return err
	}
	reason := s.agentBlockedReason(ctx, st)
	if reason == "" && len(models) == 0 {
		// 区分「没配模型」和「配了但没完成能力自检」：两者的处理动作不同，
		// 前端提示文案也不同。前者去添加供应商，后者只需去点一次自检。
		var hasProvider bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM model_provider
			WHERE workspace_id=$1 AND status='active' AND execution_location='server')`, id.WorkspaceID).Scan(&hasProvider); err != nil {
			return err
		}
		if hasProvider {
			reason = "not_tested"
		} else {
			reason = "no_model"
		}
	}
	return ok(w, map[string]any{
		"enabled":                   st.Enabled,
		"can_use":                   reason == "",
		"reason":                    reason,
		"role":                      id.Role,
		"read_only":                 id.Role == "viewer",
		"models":                    models,
		"default_model":             def,
		"default_model_unsupported": unsupported,
		"allow_model_pick":          st.AllowModelPick,
		"features":                  agentWorkbenchFeatures(),
		"limits":                    agentLimitsPayload(),
		"privacy_notice_seen":       s.userPrefs(ctx).AgentPrivacyNoticeSeen,
	})
}

// ---------- 对话 ----------

type agentConversation struct {
	ID              uuid.UUID  `json:"id"`
	Title           string     `json:"title"`
	TitleSource     string     `json:"title_source"`
	PinnedAt        *time.Time `json:"pinned_at"`
	ModelProviderID *uuid.UUID `json:"model_provider_id"`
	Model           string     `json:"model"`
	AccountID       *uuid.UUID `json:"account_id"`
	LastMessageAt   time.Time  `json:"last_message_at"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	Revision        int64      `json:"revision"`
}

type agentConversationListItem struct {
	agentConversation
	PendingActions int  `json:"pending_actions"`
	HasActiveRun   bool `json:"has_active_run"`
}

const agentConversationCols = `c.id, c.title, c.title_source, c.pinned_at, c.model_provider_id, c.model,
	c.account_id, c.last_message_at, c.created_at, c.updated_at, c.revision`

func scanAgentConversation(row pgx.Row) (*agentConversation, error) {
	var c agentConversation
	if err := row.Scan(&c.ID, &c.Title, &c.TitleSource, &c.PinnedAt, &c.ModelProviderID, &c.Model,
		&c.AccountID, &c.LastMessageAt, &c.CreatedAt, &c.UpdatedAt, &c.Revision); err != nil {
		return nil, err
	}
	return &c, nil
}

// agentConversationFor 读取本人本工作区的对话；不属于本人一律 404，不泄露是否存在（第 9.4 节）。
func (s *Server) agentConversationFor(ctx context.Context, id uuid.UUID) (*agentConversation, error) {
	c, err := scanAgentConversation(s.db.QueryRow(ctx,
		`SELECT `+agentConversationCols+` FROM agent_conversation c WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`,
		id, ident(ctx).WorkspaceID, ident(ctx).UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

func (s *Server) agentConversationPathID(r *http.Request) (uuid.UUID, error) {
	return pathID(r, "id")
}

// agentCursor 是对话列表的游标：置顶分组 + 置顶时间 + 最后消息时间 + ID。
type agentCursor struct {
	Pinned   bool
	PinnedAt time.Time
	LastAt   time.Time
	ID       uuid.UUID
}

func parseAgentCursor(r *http.Request) (*agentCursor, error) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, validation("分页游标无效")
	}
	parts := strings.Split(string(b), "|")
	if len(parts) != 4 {
		return nil, validation("分页游标无效")
	}
	c := agentCursor{}
	c.Pinned = parts[0] == "1"
	if c.PinnedAt, err = time.Parse(time.RFC3339Nano, parts[1]); err != nil {
		return nil, validation("分页游标无效")
	}
	if c.LastAt, err = time.Parse(time.RFC3339Nano, parts[2]); err != nil {
		return nil, validation("分页游标无效")
	}
	if c.ID, err = uuid.Parse(parts[3]); err != nil {
		return nil, validation("分页游标无效")
	}
	return &c, nil
}

func encodeAgentCursor(c *agentConversation) string {
	pinned := "0"
	pinnedAt := time.Time{}
	if c.PinnedAt != nil {
		pinned = "1"
		pinnedAt = *c.PinnedAt
	}
	raw := fmt.Sprintf("%s|%s|%s|%s", pinned, pinnedAt.UTC().Format(time.RFC3339Nano),
		c.LastMessageAt.UTC().Format(time.RFC3339Nano), c.ID.String())
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func (s *Server) listAgentConversations(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	cursor, err := parseAgentCursor(r)
	if err != nil {
		return err
	}
	limit := queryInt(r, "limit", listPageSize)
	if limit <= 0 || limit > listPageSize {
		limit = listPageSize
	}
	args := []any{id.WorkspaceID, id.UserID}
	where := ""
	if q := queryText(r, "q"); q != "" {
		args = append(args, truncateRunes(q, 100))
		n := len(args)
		where += fmt.Sprintf(` AND (c.title ILIKE '%%'||$%d||'%%' OR EXISTS (SELECT 1 FROM agent_message m
			WHERE m.conversation_id=c.id AND m.role='user' AND m.content ILIKE '%%'||$%d||'%%'))`, n, n)
	}
	if cursor != nil {
		if cursor.Pinned {
			// 已置顶分组之后是全部未置顶对话；同组内按置顶时间、最后消息时间、ID 继续。
			args = append(args, cursor.PinnedAt, cursor.LastAt, cursor.ID)
			n := len(args)
			where += fmt.Sprintf(` AND (c.pinned_at IS NULL OR c.pinned_at < $%d
				OR (c.pinned_at = $%d AND (c.last_message_at, c.id) < ($%d, $%d)))`, n-2, n-2, n-1, n)
		} else {
			args = append(args, cursor.LastAt, cursor.ID)
			n := len(args)
			where += fmt.Sprintf(` AND c.pinned_at IS NULL AND (c.last_message_at, c.id) < ($%d, $%d)`, n-1, n)
		}
	}
	args = append(args, limit+1)
	rows, err := s.db.Query(ctx, `SELECT `+agentConversationCols+`,
		(SELECT count(*) FROM agent_action a WHERE a.conversation_id=c.id AND a.status IN ('pending','needs_input')),
		EXISTS (SELECT 1 FROM agent_run r WHERE r.conversation_id=c.id AND r.status IN ('queued','running'))
		FROM agent_conversation c
		WHERE c.workspace_id=$1 AND c.user_id=$2`+where+fmt.Sprintf(`
		ORDER BY (c.pinned_at IS NULL), c.pinned_at DESC, c.last_message_at DESC, c.id DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []agentConversationListItem{}
	for rows.Next() {
		var c agentConversation
		var summary agentConversationListItem
		if err := rows.Scan(&c.ID, &c.Title, &c.TitleSource, &c.PinnedAt, &c.ModelProviderID, &c.Model,
			&c.AccountID, &c.LastMessageAt, &c.CreatedAt, &c.UpdatedAt, &c.Revision, &summary.PendingActions, &summary.HasActiveRun); err != nil {
			return err
		}
		summary.agentConversation = c
		list = append(list, summary)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	hasMore := len(list) > limit
	if hasMore {
		list = list[:limit]
	}
	var nextCursor *string
	if hasMore {
		v := encodeAgentCursor(&list[len(list)-1].agentConversation)
		nextCursor = &v
	}
	return ok(w, map[string]any{"items": list, "next_cursor": nextCursor})
}

func (s *Server) createAgentConversation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	var in struct {
		Title     string         `json:"title"`
		AccountID string         `json:"account_id"`
		Model     *agentModelRef `json:"model"`
		RequestID string         `json:"request_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	title := strings.TrimSpace(in.Title)
	source := "auto"
	if title == "" {
		title = "新对话"
	} else {
		if runeLen(title) > 60 {
			return validation("对话标题最多 60 字")
		}
		source = "user"
	}
	var accountID *uuid.UUID
	if strings.TrimSpace(in.AccountID) != "" {
		aid, err := uuid.Parse(strings.TrimSpace(in.AccountID))
		if err != nil {
			return errNotFound
		}
		if err := s.checkAgentAccount(ctx, aid); err != nil {
			return err
		}
		accountID = &aid
	}
	var providerID *uuid.UUID
	model := ""
	if in.Model != nil {
		ref, err := s.resolveAgentModel(ctx, *in.Model)
		if err != nil {
			return err
		}
		providerID, model = &ref.ProviderID, ref.Model
	}
	var requestID uuid.UUID
	if strings.TrimSpace(in.RequestID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(in.RequestID))
		if err != nil {
			return validation("请求编号无效")
		}
		requestID = parsed
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if requestID != uuid.Nil {
		payload := struct {
			Title      string
			AccountID  *uuid.UUID
			ProviderID *uuid.UUID
			Model      string
		}{title, accountID, providerID, model}
		replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, "conversation.create", requestID, payload)
		if err != nil {
			return err
		}
		if replayID != nil {
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			c, err := s.agentConversationFor(ctx, *replayID)
			if err != nil {
				return err
			}
			return ok(w, c)
		}
	}
	c, err := scanAgentConversation(tx.QueryRow(ctx, `INSERT INTO agent_conversation
		(workspace_id, user_id, title, title_source, account_id, model_provider_id, model)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, title, title_source, pinned_at, model_provider_id, model,
		account_id, last_message_at, created_at, updated_at, revision`,
		id.WorkspaceID, id.UserID, title, source, accountID, providerID, model))
	if err != nil {
		return err
	}
	if requestID != uuid.Nil {
		if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, "conversation.create", requestID, c.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, c)
}

func (s *Server) patchAgentConversation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	if _, err := s.agentConversationFor(ctx, cid); err != nil {
		return err
	}
	var in struct {
		ExpectedRevision *int64         `json:"expected_revision"`
		Title            *string        `json:"title"`
		Pinned           *bool          `json:"pinned"`
		AccountID        *string        `json:"account_id"`
		Model            *agentModelRef `json:"model"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision < 1 {
		return validation("对话修订号无效")
	}
	sets := []string{}
	args := []any{cid}
	if in.Title != nil {
		title := strings.TrimSpace(*in.Title)
		if title == "" {
			return validation("对话标题不能为空")
		}
		if runeLen(title) > 60 {
			return validation("对话标题最多 60 字")
		}
		args = append(args, title)
		sets = append(sets, fmt.Sprintf("title=$%d", len(args)), "title_source='user'")
	}
	if in.Pinned != nil {
		if *in.Pinned {
			sets = append(sets, "pinned_at=now()")
		} else {
			sets = append(sets, "pinned_at=NULL")
		}
	}
	if in.AccountID != nil {
		if strings.TrimSpace(*in.AccountID) == "" {
			sets = append(sets, "account_id=NULL")
		} else {
			aid, err := uuid.Parse(strings.TrimSpace(*in.AccountID))
			if err != nil {
				return errNotFound
			}
			if err := s.checkAgentAccount(ctx, aid); err != nil {
				return err
			}
			args = append(args, aid)
			sets = append(sets, fmt.Sprintf("account_id=$%d", len(args)))
		}
	}
	if in.Model != nil {
		ref, err := s.resolveAgentModel(ctx, *in.Model)
		if err != nil {
			return err
		}
		args = append(args, ref.ProviderID, ref.Model)
		sets = append(sets, fmt.Sprintf("model_provider_id=$%d", len(args)-1), fmt.Sprintf("model=$%d", len(args)))
	}
	if len(sets) == 0 {
		return validation("没有需要修改的字段")
	}
	sets = append(sets, "revision=revision+1", "updated_at=now()")
	args = append(args, id.WorkspaceID, id.UserID)
	where := fmt.Sprintf(` WHERE id=$%d AND workspace_id=$%d AND user_id=$%d`, 1, len(args)-1, len(args))
	if in.ExpectedRevision != nil {
		args = append(args, *in.ExpectedRevision)
		where += fmt.Sprintf(` AND revision=$%d`, len(args))
	}
	sql := `UPDATE agent_conversation SET ` + strings.Join(sets, ", ") + where +
		` RETURNING id, title, title_source, pinned_at, model_provider_id, model, account_id,
		last_message_at, created_at, updated_at, revision`
	c, err := scanAgentConversation(s.db.QueryRow(ctx, sql, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		if in.ExpectedRevision != nil {
			return apiErr(409, "agent_revision_conflict", "对话已被其他操作更新，请刷新后重试")
		}
		return errNotFound
	}
	if err != nil {
		return err
	}
	return ok(w, c)
}

func (s *Server) deleteAgentConversation(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	c, err := s.agentConversationFor(ctx, cid)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("confirm") != "true" {
		return validation("删除对话需要确认")
	}
	var executing bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing')`, c.ID).Scan(&executing); err != nil {
		return err
	}
	if executing {
		return apiErr(409, "agent_run_busy", "有卡片正在执行，请等它结束后再删除对话")
	}
	// 附件文件由应用代码在事务提交后删除，数据库级联只删记录（第 10 节说明 3）。
	paths, err := s.agentAttachmentPathsOf(ctx, c.ID)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		c.ID, id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	s.removeAgentFiles(paths)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) checkAgentAccount(ctx context.Context, accountID uuid.UUID) error {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM platform_account WHERE id=$1 AND workspace_id=$2)`,
		accountID, ident(ctx).WorkspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	return nil
}

// resolveAgentModel 校验所选模型已通过工具调用自检（第 7.4 节第 1、3 项）。
func (s *Server) resolveAgentModel(ctx context.Context, ref agentModelRef) (agentModelRef, error) {
	models, _, _, err := s.agentModels(ctx)
	if err != nil {
		return ref, err
	}
	for _, m := range models {
		if m.ProviderID == ref.ProviderID && m.Model == ref.Model {
			return agentModelRef{ProviderID: m.ProviderID, Model: m.Model}, nil
		}
	}
	return ref, apiErr(422, "agent_model_unsupported", "所选模型未通过工具调用自检或已不可用，请重新选择")
}

// ---------- 对话详情 ----------

type agentAttachmentView struct {
	ID     uuid.UUID `json:"id"`
	Kind   string    `json:"kind"`
	Name   string    `json:"name"`
	Mime   string    `json:"mime"`
	Bytes  int       `json:"bytes"`
	Width  *int      `json:"width"`
	Height *int      `json:"height"`
	URL    string    `json:"url"`
}

type agentToolCallView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Summary       string `json:"summary"`
	ResultPreview string `json:"result_preview"`
}

type agentMessageView struct {
	ID          uuid.UUID             `json:"id"`
	Seq         int                   `json:"seq"`
	Role        string                `json:"role"`
	Content     string                `json:"content"`
	AICallID    *uuid.UUID            `json:"ai_call_id"`
	ToolCalls   []agentToolCallView   `json:"tool_calls"`
	Attachments []agentAttachmentView `json:"attachments"`
	RunID       *uuid.UUID            `json:"run_id"`
	CreatedAt   time.Time             `json:"created_at"`
}

type agentTargetView struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
	Link string `json:"link"`
}

type agentChange struct {
	Field    string `json:"field"`
	Label    string `json:"label"`
	Before   string `json:"before"`
	After    string `json:"after"`
	Editable bool   `json:"editable"`
	Blank    bool   `json:"blank"`
}

// agentCardPreview 是 agent_action.preview 的约定结构，由提出卡片的运行循环写入（DEV-AG06）。
type agentCardPreview struct {
	Title         string        `json:"title"`
	TargetName    string        `json:"target_name"`
	Link          string        `json:"link"`
	Changes       []agentChange `json:"changes"`
	Notices       []string      `json:"notices"`
	AICost        bool          `json:"ai_cost"`
	SecondConfirm any           `json:"second_confirm"`
}

type agentActionView struct {
	ID             uuid.UUID       `json:"id"`
	RunID          uuid.UUID       `json:"run_id"`
	ToolName       string          `json:"tool_name"`
	Title          string          `json:"title"`
	Kind           string          `json:"kind"`
	Gate           string          `json:"gate"`
	SecondConfirm  any             `json:"second_confirm"`
	Status         string          `json:"status"`
	Target         agentTargetView `json:"target"`
	Changes        []agentChange   `json:"changes"`
	Notices        []string        `json:"notices"`
	AICost         bool            `json:"ai_cost"`
	Need           any             `json:"need"`
	ResultSummary  string          `json:"result_summary"`
	Error          any             `json:"error"`
	LastError      any             `json:"last_error"`
	ExpiresAt      time.Time       `json:"expires_at"`
	BatchID        uuid.UUID       `json:"batch_id"`
	CreatedAt      time.Time       `json:"created_at"`
	EditableFields []string        `json:"editable_fields"`
	BlankFields    []string        `json:"blank_fields"`
}

type agentActiveRun struct {
	ID              uuid.UUID  `json:"id"`
	Status          string     `json:"status"`
	Stage           string     `json:"stage"`
	Trigger         string     `json:"trigger"`
	ModelProviderID *uuid.UUID `json:"model_provider_id"`
	Model           string     `json:"model"`
	StartedAt       time.Time  `json:"started_at"`
}

func (s *Server) getAgentConversationDetail(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	c, err := s.agentConversationFor(ctx, cid)
	if err != nil {
		return err
	}
	// 读取时的惰性过期判断（第 5.9 节第 2 项）。
	if _, err := s.db.Exec(ctx, `UPDATE agent_action SET status='expired'
		WHERE conversation_id=$1 AND status IN ('pending','needs_input') AND expires_at < now()`, c.ID); err != nil {
		return err
	}
	messages, hasMore, err := s.agentMessages(ctx, c.ID, queryInt(r, "before_seq", 0))
	if err != nil {
		return err
	}
	actions, err := s.agentActions(ctx, c.ID)
	if err != nil {
		return err
	}
	active, err := s.agentActiveRunOf(ctx, c.ID)
	if err != nil {
		return err
	}
	var usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	}
	if err := s.db.QueryRow(ctx, `SELECT coalesce(sum(prompt_tokens),0), coalesce(sum(completion_tokens),0)
		FROM agent_run WHERE conversation_id=$1`, c.ID).Scan(&usage.PromptTokens, &usage.CompletionTokens); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"conversation": c, "messages": messages, "actions": actions, "usage": usage,
		"active_run": active, "has_more": hasMore,
		"can_continue": s.agentConversationCanContinue(ctx, c),
	})
}

// agentMessages 返回窗口内的消息；role=tool 不单独列出，而是折叠为助手消息的工具调用摘要（第 11.2 节）。
func (s *Server) agentMessages(ctx context.Context, convID uuid.UUID, before int) ([]agentMessageView, bool, error) {
	args := []any{convID}
	sql := `SELECT id, seq, role, content, ai_call_id, tool_calls, tool_call_id, attachment_ids, run_id, created_at
		FROM agent_message WHERE conversation_id=$1`
	if before > 0 {
		args = append(args, before)
		sql += ` AND seq < $2`
	}
	args = append(args, agentMessagePage+1)
	rows, err := s.db.Query(ctx, sql+fmt.Sprintf(` ORDER BY seq DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, false, err
	}
	type rawMessage struct {
		view   agentMessageView
		raw    []byte
		toolID string
		ids    []uuid.UUID
	}
	raw := []rawMessage{}
	toolResults := map[string]string{}
	attachmentIDs := []uuid.UUID{}
	for rows.Next() {
		var m rawMessage
		var toolCalls []byte
		if err := rows.Scan(&m.view.ID, &m.view.Seq, &m.view.Role, &m.view.Content, &m.view.AICallID, &toolCalls,
			&m.toolID, &m.ids, &m.view.RunID, &m.view.CreatedAt); err != nil {
			rows.Close()
			return nil, false, err
		}
		m.raw = toolCalls
		if m.view.Role == "tool" {
			toolResults[m.toolID] = m.view.Content
		}
		attachmentIDs = append(attachmentIDs, m.ids...)
		raw = append(raw, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(raw) > agentMessagePage
	if hasMore {
		raw = raw[:agentMessagePage]
	}
	attachments, err := s.agentAttachments(ctx, attachmentIDs)
	if err != nil {
		return nil, false, err
	}
	list := []agentMessageView{}
	for i := len(raw) - 1; i >= 0; i-- {
		m := raw[i]
		if m.view.Role == "tool" {
			continue
		}
		m.view.ToolCalls = agentToolCallsOf(m.raw, toolResults)
		m.view.Attachments = []agentAttachmentView{}
		for _, aid := range m.ids {
			if a, found := attachments[aid]; found {
				m.view.Attachments = append(m.view.Attachments, a)
			}
		}
		list = append(list, m.view)
	}
	return list, hasMore, nil
}

// agentToolCallsOf 把 assistant 消息的 tool_calls 与紧随其后的 tool 结果合并成前端展示用的折叠行。
func agentToolCallsOf(rawToolCalls []byte, results map[string]string) []agentToolCallView {
	out := []agentToolCallView{}
	if len(rawToolCalls) == 0 || string(rawToolCalls) == "null" {
		return out
	}
	var calls []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(rawToolCalls, &calls); err != nil {
		return out
	}
	for _, c := range calls {
		content := results[c.ID]
		out = append(out, agentToolCallView{
			ID:            c.ID,
			Name:          c.Name,
			Summary:       truncateRunes(firstLine(content), 120),
			ResultPreview: truncateRunes(content, 2000),
		})
	}
	return out
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		return s[:i]
	}
	return s
}

func (s *Server) agentAttachments(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]agentAttachmentView, error) {
	out := map[uuid.UUID]agentAttachmentView{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, kind, name, mime, bytes, width, height FROM agent_attachment
		WHERE id = ANY($1) AND user_id=$2`, ids, ident(ctx).UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a agentAttachmentView
		if err := rows.Scan(&a.ID, &a.Kind, &a.Name, &a.Mime, &a.Bytes, &a.Width, &a.Height); err != nil {
			return nil, err
		}
		a.URL = "/api/v1/agent/attachments/" + a.ID.String() + "/file"
		out[a.ID] = a
	}
	return out, rows.Err()
}

func (s *Server) agentActions(ctx context.Context, convID uuid.UUID) ([]agentActionView, error) {
	rows, err := s.db.Query(ctx, `SELECT id, run_id, tool_name, kind, gate, status, target_type, target_id, work_id,
		preview, editable_fields, blank_fields, need, result, error, last_error, expires_at, batch_id, created_at
		FROM agent_action WHERE conversation_id=$1 ORDER BY created_at, id`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []agentActionView{}
	for rows.Next() {
		view, err := agentActionViewFrom(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *view)
	}
	return list, rows.Err()
}

const agentActionCols = `id, run_id, tool_name, kind, gate, status, target_type, target_id, work_id,
	preview, editable_fields, blank_fields, need, result, error, last_error, expires_at, batch_id, created_at`

// agentActionViewFrom 扫描一行 agent_action 并组装成前端 / SSE 用的卡片视图（第 11.2 节）。
func agentActionViewFrom(row pgx.Row) (*agentActionView, error) {
	var (
		a          agentActionView
		workID     *uuid.UUID
		preview    []byte
		need, res  []byte
		errJSON    []byte
		lastErr    []byte
		targetType string
		targetID   string
	)
	if err := row.Scan(&a.ID, &a.RunID, &a.ToolName, &a.Kind, &a.Gate, &a.Status, &targetType, &targetID, &workID,
		&preview, &a.EditableFields, &a.BlankFields, &need, &res, &errJSON, &lastErr,
		&a.ExpiresAt, &a.BatchID, &a.CreatedAt); err != nil {
		return nil, err
	}
	var pv agentCardPreview
	_ = json.Unmarshal(preview, &pv)
	a.Title = pv.Title
	a.SecondConfirm = pv.SecondConfirm
	a.Changes = pv.Changes
	if a.Changes == nil {
		a.Changes = []agentChange{}
	}
	a.Notices = pv.Notices
	if a.Notices == nil {
		a.Notices = []string{}
	}
	a.AICost = pv.AICost
	a.Target = agentTargetView{Type: targetType, ID: targetID, Name: pv.TargetName, Link: pv.Link}
	if a.EditableFields == nil {
		a.EditableFields = []string{}
	}
	if a.BlankFields == nil {
		a.BlankFields = []string{}
	}
	a.Need = jsonOrNil(need)
	a.Error = jsonOrNil(errJSON)
	a.LastError = jsonOrNil(lastErr)
	var result struct {
		Summary string `json:"summary"`
	}
	_ = json.Unmarshal(res, &result)
	a.ResultSummary = result.Summary
	return &a, nil
}

// agentActionByID 读取一张卡片；不属于本次上下文时由调用方判 404。
func (s *Server) agentActionByID(ctx context.Context, id uuid.UUID) (*agentActionView, error) {
	view, err := agentActionViewFrom(s.db.QueryRow(ctx, `SELECT `+agentActionCols+` FROM agent_action WHERE id=$1`, id))
	if err != nil {
		return nil, err
	}
	return view, nil
}

func jsonOrNil(raw []byte) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

func (s *Server) agentActiveRunOf(ctx context.Context, convID uuid.UUID) (*agentActiveRun, error) {
	var run agentActiveRun
	err := s.db.QueryRow(ctx, `SELECT id, status, stage, trigger, model_provider_id, model, started_at
		FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')
		ORDER BY started_at DESC LIMIT 1`, convID).Scan(&run.ID, &run.Status, &run.Stage, &run.Trigger,
		&run.ModelProviderID, &run.Model, &run.StartedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// ---------- 附件文件 ----------

// agentAttachmentFile 把 storage_path 解析为磁盘路径；相对路径按工作目录解析。
func (s *Server) agentAttachmentFile(storagePath string) string {
	if filepath.IsAbs(storagePath) {
		return storagePath
	}
	return filepath.Join(s.cfg.DataDir, filepath.FromSlash(storagePath))
}

func (s *Server) removeAgentFiles(paths []string) {
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		// 第 8.2 节第 2 项：图片附件同时清理 model 与 thumb 变体。
		for _, full := range agentAttachmentAllPaths(p) {
			if err := os.Remove(s.agentAttachmentFile(full)); err != nil && !os.IsNotExist(err) {
				slog.Warn("删除智能体附件文件失败", "err", err)
			}
		}
	}
}

func (s *Server) agentAttachmentPathsOf(ctx context.Context, convID uuid.UUID) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT storage_path FROM agent_attachment WHERE conversation_id=$1`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	paths := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		paths = append(paths, p)
	}
	return paths, rows.Err()
}

// ---------- 路由 ----------

// agentRoutes registers the D-117 endpoints (16 文档第 11.1 节)。
func (s *Server) agentRoutes(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.agentGate)
		r.Get("/agent/bootstrap", s.h(s.agentBootstrap))
		r.Get("/agent/conversations", s.h(s.listAgentConversations))
		r.Post("/agent/conversations", s.h(s.createAgentConversation))
		r.Get("/agent/conversations/{id}", s.h(s.getAgentConversationDetail))
		r.Patch("/agent/conversations/{id}", s.h(s.patchAgentConversation))
		r.Delete("/agent/conversations/{id}", s.h(s.deleteAgentConversation))
		r.Get("/agent/settings", s.h(s.getAgentSettings))
		r.Put("/agent/settings", s.h(s.putAgentSettings))
		r.Post("/agent/conversations/{id}/messages", s.h(s.postAgentMessages))
		r.Post("/agent/conversations/{id}/continue", s.h(s.postAgentContinue))
		r.Post("/agent/conversations/{id}/regenerate", s.h(s.postAgentRegenerate))
		r.Post("/agent/conversations/{id}/messages/{messageId}/edit", s.h(s.postAgentMessageEdit))
		r.Post("/agent/runs/{id}/cancel", s.h(s.postAgentRunCancel))
		// 第 11.3 节：/agent/actions 下只有 {id}/execute 与 {id}/reject（HC-27 静态检查）。
		r.Post("/agent/actions/{id}/execute", s.h(s.postAgentActionExecute))
		r.Post("/agent/actions/{id}/reject", s.h(s.postAgentActionReject))
		// 第 11.1 节：附件上传、读取与删除。
		r.Post("/agent/attachments", s.h(s.postAgentAttachment))
		r.Get("/agent/attachments/{id}/file", s.h(s.getAgentAttachmentFile))
		r.Delete("/agent/attachments/{id}", s.h(s.deleteAgentAttachment))
	})
}
