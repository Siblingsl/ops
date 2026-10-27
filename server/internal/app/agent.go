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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
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
	ProviderID        uuid.UUID `json:"provider_id"`
	ProviderName      string    `json:"provider_name"`
	Model             string    `json:"model"`
	ExecutionLocation string    `json:"execution_location"`
	Vision            bool      `json:"vision"`
	IsDefault         bool      `json:"is_default"`
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
				Model: rt.Model, ExecutionLocation: agentModelExecutionLocation(rt), Vision: rt.VisionOK, IsDefault: true})
		}
		if rt.Fallback != nil && rt.Fallback.ToolsOK {
			list = append(list, agentModelOption{ProviderID: rt.Fallback.ProviderID, ProviderName: rt.Fallback.ProviderName,
				Model: rt.Fallback.Model, ExecutionLocation: agentModelExecutionLocation(rt.Fallback), Vision: rt.Fallback.VisionOK})
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
		m.ExecutionLocation = "server"
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

func agentModelExecutionLocation(value *route) string {
	if value != nil && value.Desktop != nil {
		return "desktop"
	}
	return "server"
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
	ID                 uuid.UUID  `json:"id"`
	Title              string     `json:"title"`
	TitleSource        string     `json:"title_source"`
	PinnedAt           *time.Time `json:"pinned_at"`
	ModelProviderID    *uuid.UUID `json:"model_provider_id"`
	Model              string     `json:"model"`
	AccountID          *uuid.UUID `json:"account_id"`
	LastMessageAt      time.Time  `json:"last_message_at"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
	Revision           int64      `json:"revision"`
	ArchivedAt         *time.Time `json:"archived_at"`
	GroupID            *uuid.UUID `json:"group_id"`
	ReadUptoMessageSeq int64      `json:"read_upto_message_seq"`
	ForceUnread        bool       `json:"force_unread"`
	Mode               string     `json:"mode"`
	ReasoningEffort    *string    `json:"reasoning_effort,omitempty"`
	ParentID           *uuid.UUID `json:"parent_id,omitempty"`
	ForkUptoSeq        *int       `json:"fork_upto_seq,omitempty"`
}

type agentConversationListItem struct {
	agentConversation
	PendingActions        int            `json:"pending_actions"`
	HasActiveRun          bool           `json:"has_active_run"`
	HasUnread             bool           `json:"has_unread"`
	Goal                  *agentGoalView `json:"goal,omitempty"`
	MatchedMessageID      *uuid.UUID     `json:"matched_message_id,omitempty"`
	MatchedMessageSeq     *int64         `json:"matched_message_seq,omitempty"`
	MatchedMessageSnippet string         `json:"matched_message_snippet,omitempty"`
}

const agentConversationCols = `c.id, c.title, c.title_source, c.pinned_at, c.model_provider_id, c.model,
	c.account_id, c.last_message_at, c.created_at, c.updated_at, c.revision,
	c.archived_at, c.group_id, c.read_upto_message_seq, c.force_unread, c.mode, c.reasoning_effort, c.parent_id, c.fork_upto_seq`

func scanAgentConversation(row pgx.Row) (*agentConversation, error) {
	var c agentConversation
	if err := row.Scan(&c.ID, &c.Title, &c.TitleSource, &c.PinnedAt, &c.ModelProviderID, &c.Model,
		&c.AccountID, &c.LastMessageAt, &c.CreatedAt, &c.UpdatedAt, &c.Revision,
		&c.ArchivedAt, &c.GroupID, &c.ReadUptoMessageSeq, &c.ForceUnread, &c.Mode, &c.ReasoningEffort, &c.ParentID, &c.ForkUptoSeq); err != nil {
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
	c.Mode = agentEffectiveMode(c.Mode, ident(ctx).Role)
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
	where := ` AND c.archived_at IS NULL`
	unreadSQL := `(c.force_unread OR EXISTS (SELECT 1 FROM agent_message um WHERE um.conversation_id=c.id
		AND um.role IN ('assistant','action_result','system_note') AND um.seq>c.read_upto_message_seq))`
	if agentWorkbenchFeatures()["event_resume"] {
		unreadSQL = `(c.force_unread OR EXISTS (SELECT 1 FROM agent_event ue WHERE ue.conversation_id=c.id
			AND ue.type='message.saved' AND ue.payload->>'role' IN ('assistant','action_result','system_note')
			AND ue.event_seq>c.read_upto_event_seq))`
	}
	q := truncateRunes(queryText(r, "q"), 100)
	join := ""
	matchedIDSQL, matchedSeqSQL, matchedSnippetSQL := `NULL::uuid`, `NULL::bigint`, `''::text`
	if q != "" {
		args = append(args, q)
		n := len(args)
		join = fmt.Sprintf(` LEFT JOIN LATERAL (
			SELECT m.id, m.seq, m.content FROM agent_message m
			WHERE m.conversation_id=c.id AND m.role IN ('user','assistant','action_result','system_note')
				AND m.content ILIKE '%%'||$%d||'%%'
			ORDER BY m.seq DESC LIMIT 1
		) matched ON true`, n)
		matchedIDSQL, matchedSeqSQL = `matched.id`, `matched.seq`
		matchedSnippetSQL = fmt.Sprintf(`CASE WHEN matched.id IS NULL THEN '' ELSE
			substring(matched.content FROM greatest(1, strpos(lower(matched.content), lower($%d))-60) FOR 140) END`, n)
		where += fmt.Sprintf(` AND (c.title ILIKE '%%'||$%d||'%%' OR matched.id IS NOT NULL)`, n)
	}
	archiveFilter := strings.TrimSpace(r.URL.Query().Get("archived"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	switch archiveFilter {
	case "", "false":
	case "true":
		if err := requireAgentFeature("conversation_organize"); err != nil {
			return err
		}
		where = strings.Replace(where, ` AND c.archived_at IS NULL`, ` AND c.archived_at IS NOT NULL`, 1)
	case "all":
		if state != "task" || !agentWorkbenchFeatures()["goals"] {
			if err := requireAgentFeature("conversation_organize"); err != nil {
				return err
			}
		}
		where = strings.Replace(where, ` AND c.archived_at IS NULL`, "", 1)
	default:
		return validation("归档筛选无效")
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("account_id")); raw != "" {
		if err := requireAgentFeature("conversation_organize"); err != nil {
			return err
		}
		accountID, err := uuid.Parse(raw)
		if err != nil {
			return validation("账号筛选无效")
		}
		args = append(args, accountID)
		where += fmt.Sprintf(` AND c.account_id=$%d`, len(args))
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("group_id")); raw != "" {
		if err := requireAgentFeature("conversation_organize"); err != nil {
			return err
		}
		if raw == "none" {
			where += ` AND c.group_id IS NULL`
		} else {
			groupID, err := uuid.Parse(raw)
			if err != nil {
				return validation("分组筛选无效")
			}
			args = append(args, groupID)
			where += fmt.Sprintf(` AND c.group_id=$%d`, len(args))
		}
	}
	if state != "" {
		if state == "goal" || state == "task" {
			if err := requireAgentFeature("goals"); err != nil {
				return err
			}
		} else if err := requireAgentFeature("conversation_organize"); err != nil {
			return err
		}
		switch state {
		case "active":
			where += ` AND EXISTS (SELECT 1 FROM agent_run r WHERE r.conversation_id=c.id AND r.status IN ('queued','running'))`
		case "needs_action":
			where += ` AND EXISTS (SELECT 1 FROM agent_action a WHERE a.conversation_id=c.id AND a.status IN ('pending','needs_input'))`
		case "unread":
			where += ` AND ` + unreadSQL
		case "goal":
			where += ` AND EXISTS (SELECT 1 FROM agent_goal g WHERE g.conversation_id=c.id
				AND g.status NOT IN ('completed','cancelled'))`
		case "task":
			where += ` AND (EXISTS (SELECT 1 FROM agent_run r WHERE r.conversation_id=c.id AND r.status IN ('queued','running'))
				OR EXISTS (SELECT 1 FROM agent_action a WHERE a.conversation_id=c.id AND a.status IN ('pending','needs_input'))
				OR EXISTS (SELECT 1 FROM agent_goal g WHERE g.conversation_id=c.id AND g.status NOT IN ('completed','cancelled')))`
		default:
			return validation("对话状态筛选无效")
		}
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
		EXISTS (SELECT 1 FROM agent_run r WHERE r.conversation_id=c.id AND r.status IN ('queued','running')),
		`+unreadSQL+`,
		`+matchedIDSQL+`, `+matchedSeqSQL+`, `+matchedSnippetSQL+`
		FROM agent_conversation c`+join+`
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
		var matchedID pgtype.UUID
		var matchedSeq pgtype.Int8
		if err := rows.Scan(&c.ID, &c.Title, &c.TitleSource, &c.PinnedAt, &c.ModelProviderID, &c.Model,
			&c.AccountID, &c.LastMessageAt, &c.CreatedAt, &c.UpdatedAt, &c.Revision,
			&c.ArchivedAt, &c.GroupID, &c.ReadUptoMessageSeq, &c.ForceUnread, &c.Mode, &c.ReasoningEffort,
			&c.ParentID, &c.ForkUptoSeq,
			&summary.PendingActions, &summary.HasActiveRun, &summary.HasUnread,
			&matchedID, &matchedSeq, &summary.MatchedMessageSnippet); err != nil {
			return err
		}
		if matchedID.Valid {
			matchUUID := uuid.UUID(matchedID.Bytes)
			summary.MatchedMessageID = &matchUUID
		}
		if matchedSeq.Valid {
			seq := matchedSeq.Int64
			summary.MatchedMessageSeq = &seq
		}
		c.Mode = agentEffectiveMode(c.Mode, id.Role)
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
	if agentWorkbenchFeatures()["goals"] && len(list) > 0 {
		conversationIDs := make([]uuid.UUID, 0, len(list))
		for _, item := range list {
			conversationIDs = append(conversationIDs, item.ID)
		}
		goals, err := s.getAgentGoalList(ctx, id.UserID, id.WorkspaceID, conversationIDs)
		if err != nil {
			return err
		}
		for i := range list {
			list[i].Goal = goals[list[i].ID]
		}
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
		account_id, last_message_at, created_at, updated_at, revision, archived_at, group_id,
		read_upto_message_seq, force_unread, mode, reasoning_effort, parent_id, fork_upto_seq`,
		id.WorkspaceID, id.UserID, title, source, accountID, providerID, model))
	if err != nil {
		return err
	}
	c.Mode = agentEffectiveMode(c.Mode, id.Role)
	baselineSeq, err := appendAgentEventTx(ctx, tx, c.ID, nil, "conversation.updated", map[string]any{"snapshot_baseline": true}, nil)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET read_upto_event_seq=$2 WHERE id=$1`, c.ID, baselineSeq); err != nil {
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
		ExpectedRevision      *int64          `json:"expected_revision"`
		Title                 *string         `json:"title"`
		Pinned                *bool           `json:"pinned"`
		AccountID             *string         `json:"account_id"`
		Model                 *agentModelRef  `json:"model"`
		Mode                  *string         `json:"mode"`
		ReasoningEffort       *string         `json:"reasoning_effort"`
		GroupID               json.RawMessage `json:"group_id"`
		Archived              *bool           `json:"archived"`
		ConfirmPendingActions *bool           `json:"confirm_pending_actions"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.ExpectedRevision != nil && *in.ExpectedRevision < 1 {
		return validation("对话修订号无效")
	}
	organizeChange := in.Archived != nil || in.GroupID != nil
	if organizeChange {
		if err := requireAgentFeature("conversation_organize"); err != nil {
			return err
		}
		if in.ExpectedRevision == nil {
			return validation("会话组织修改需要 expected_revision")
		}
	}
	if err := agentValidateModeRequest(ctx, in.Mode); err != nil {
		return err
	}
	if in.ReasoningEffort != nil {
		return apiErr(422, "agent_model_unsupported", "当前模型适配器未声明可选推理强度")
	}
	if in.Mode != nil && in.ExpectedRevision == nil {
		return validation("修改模式需要 expected_revision")
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
	if in.Mode != nil {
		args = append(args, *in.Mode)
		sets = append(sets, fmt.Sprintf("mode=$%d", len(args)))
	}
	var groupID *uuid.UUID
	if in.GroupID != nil {
		groupID, err = groupIDFromJSON(in.GroupID)
		if err != nil {
			return err
		}
		args = append(args, groupID)
		sets = append(sets, fmt.Sprintf("group_id=$%d", len(args)))
	}
	if in.Archived != nil {
		args = append(args, *in.Archived)
		sets = append(sets, fmt.Sprintf("archived_at=CASE WHEN $%d THEN COALESCE(archived_at,now()) ELSE NULL END", len(args)))
	}
	if len(sets) == 0 {
		return validation("没有需要修改的字段")
	}
	var tx pgx.Tx
	if organizeChange || in.AccountID != nil || in.Model != nil || in.Mode != nil {
		tx, err = s.db.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		current, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+`
			FROM agent_conversation c WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`,
			cid, id.WorkspaceID, id.UserID))
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		if err != nil {
			return err
		}
		if in.ExpectedRevision != nil && current.Revision != *in.ExpectedRevision {
			return apiErr(409, "agent_revision_conflict", "对话已被其他操作更新，请刷新后重试")
		}
		if in.AccountID != nil || in.Model != nil || in.Mode != nil {
			var active, executing, pending bool
			if err := tx.QueryRow(ctx, `SELECT
				EXISTS (SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')),
				EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing'),
				EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input'))`, cid).
				Scan(&active, &executing, &pending); err != nil {
				return err
			}
			if active || executing {
				return apiErr(409, "agent_run_busy", "运行或卡片执行期间不能修改对话账号、模型和模式")
			}
			if in.AccountID != nil && pending {
				var next *uuid.UUID
				if raw := strings.TrimSpace(*in.AccountID); raw != "" {
					parsed, _ := uuid.Parse(raw)
					next = &parsed
				}
				if !agentSameUUID(next, current.AccountID) {
					return apiErr(409, "agent_action_state_invalid", "请先处理操作卡片，或新建对话后切换账号")
				}
			}
		}
		if groupID != nil {
			var allowed bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_conversation_group
				WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`, *groupID, id.WorkspaceID, id.UserID).Scan(&allowed); err != nil {
				return err
			}
			if !allowed {
				return errNotFound
			}
		}
		if in.Archived != nil && *in.Archived && current.ArchivedAt == nil {
			var active, executing bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')),
				EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing')`, cid).Scan(&active, &executing); err != nil {
				return err
			}
			if active || executing {
				return apiErr(409, "agent_run_busy", "有运行或操作卡片正在执行，请等它结束后再归档")
			}
			var pending int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input')`, cid).Scan(&pending); err != nil {
				return err
			}
			if pending > 0 && (in.ConfirmPendingActions == nil || !*in.ConfirmPendingActions) {
				return apiErr(409, "agent_archive_confirmation_required", "仍有待处理操作卡片；确认归档后卡片会保留并按原时限过期")
			}
		}
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
		last_message_at, created_at, updated_at, revision, archived_at, group_id, read_upto_message_seq, force_unread, mode,
		reasoning_effort, parent_id, fork_upto_seq`
	query := s.db.QueryRow
	if tx != nil {
		query = tx.QueryRow
	}
	c, err := scanAgentConversation(query(ctx, sql, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		if in.ExpectedRevision != nil {
			return apiErr(409, "agent_revision_conflict", "对话已被其他操作更新，请刷新后重试")
		}
		return errNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if organizeChange && errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return errNotFound
		}
		return err
	}
	if tx != nil {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	c.Mode = agentEffectiveMode(c.Mode, id.Role)
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
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lockedConversationID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		c.ID, id.WorkspaceID, id.UserID).Scan(&lockedConversationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	var active, executing bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')),
		EXISTS (SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status='executing')`, c.ID).Scan(&active, &executing); err != nil {
		return err
	}
	if active || executing {
		return apiErr(409, "agent_run_busy", "有运行或操作卡片正在执行，请等它结束后再删除对话")
	}
	attachmentIDs, err := agentConversationAttachmentIDsTx(ctx, tx, []uuid.UUID{c.ID})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		c.ID, id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	paths, err := agentDeleteUnreferencedAttachmentsTx(ctx, tx, attachmentIDs)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
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
	ID            string               `json:"id"`
	Name          string               `json:"name"`
	Summary       string               `json:"summary"`
	ResultPreview string               `json:"result_preview"`
	Status        string               `json:"status,omitempty"`
	DurationMS    *int64               `json:"duration_ms,omitempty"`
	Error         *agentToolEventError `json:"error,omitempty"`
}

type agentSkillUsageView struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Scope  string    `json:"scope"`
	Loaded bool      `json:"loaded"`
	Used   *bool     `json:"used,omitempty"`
	Reason string    `json:"reason,omitempty"`
}

type agentMessageView struct {
	ID              uuid.UUID               `json:"id"`
	Seq             int                     `json:"seq"`
	MessageKey      string                  `json:"message_key,omitempty"`
	Role            string                  `json:"role"`
	Content         string                  `json:"content"`
	AICallID        *uuid.UUID              `json:"ai_call_id"`
	ToolCalls       []agentToolCallView     `json:"tool_calls"`
	Attachments     []agentAttachmentView   `json:"attachments"`
	ContextRefs     []agentContextReference `json:"context_refs"`
	SkillRequests   []agentSkillRequest     `json:"skill_requests"`
	SkillUsage      []agentSkillUsageView   `json:"skill_usage"`
	RunID           *uuid.UUID              `json:"run_id"`
	SourceMessageID *uuid.UUID              `json:"source_message_id,omitempty"`
	CreatedAt       time.Time               `json:"created_at"`
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
	Revision       int64           `json:"revision"`
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
	ID              uuid.UUID               `json:"id"`
	Status          string                  `json:"status"`
	Stage           string                  `json:"stage"`
	Trigger         string                  `json:"trigger"`
	ModelProviderID *uuid.UUID              `json:"model_provider_id"`
	Model           string                  `json:"model"`
	StartedAt       time.Time               `json:"started_at"`
	Mode            string                  `json:"mode"`
	ConfigSnapshot  *agentRunConfigSnapshot `json:"config_snapshot,omitempty"`
	Reason          string                  `json:"reason,omitempty"`
	ErrorCode       string                  `json:"error_code,omitempty"`
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
	// 惰性过期先提交，再以同一个只读快照读取消息、partial、卡片和事件水位。
	if _, err := s.agentMutateActions(ctx, c.ID, `UPDATE agent_action SET status='expired'
		WHERE conversation_id=$1 AND status IN ('pending','needs_input') AND expires_at < now()`, c.ID); err != nil {
		return err
	}
	if err := s.agentExpireQuestions(ctx, c.ID); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	c, err = scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, cid, ident(ctx).WorkspaceID, ident(ctx).UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	c.Mode = agentEffectiveMode(c.Mode, ident(ctx).Role)
	var lastEventSeq, readUptoEventSeq int64
	var partial map[string]any
	var partialRunID *uuid.UUID
	var partialMessageKey *string
	var partialOutput *string
	var partialChunkIndex *int
	var partialUpdatedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT c.next_event_seq,c.read_upto_event_seq,r.id,r.partial_message_key,r.partial_output,
		r.partial_chunk_index,r.partial_updated_at FROM agent_conversation c LEFT JOIN LATERAL (
			SELECT * FROM agent_run WHERE conversation_id=c.id ORDER BY started_at DESC,id DESC LIMIT 1
		) r ON true
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, c.ID,
		ident(ctx).WorkspaceID, ident(ctx).UserID).Scan(&lastEventSeq, &readUptoEventSeq, &partialRunID,
		&partialMessageKey, &partialOutput, &partialChunkIndex, &partialUpdatedAt); err != nil {
		return err
	}
	if partialRunID != nil && partialMessageKey != nil && partialOutput != nil && *partialOutput != "" {
		partial = map[string]any{"run_id": partialRunID, "message_key": *partialMessageKey,
			"text": *partialOutput, "chunk_index": partialChunkIndex, "updated_at": partialUpdatedAt,
			"complete": false}
	}
	var hasUnread bool
	unreadQuery := `SELECT c.force_unread OR EXISTS (SELECT 1 FROM agent_message m WHERE m.conversation_id=c.id
		AND m.role IN ('assistant','action_result','system_note') AND m.seq>c.read_upto_message_seq)
		FROM agent_conversation c WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`
	if agentWorkbenchFeatures()["event_resume"] {
		unreadQuery = `SELECT c.force_unread OR EXISTS (SELECT 1 FROM agent_event e WHERE e.conversation_id=c.id
			AND e.type='message.saved' AND e.payload->>'role' IN ('assistant','action_result','system_note')
			AND e.event_seq>c.read_upto_event_seq) FROM agent_conversation c
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`
	}
	if err := tx.QueryRow(ctx, unreadQuery, c.ID, ident(ctx).WorkspaceID, ident(ctx).UserID).Scan(&hasUnread); err != nil {
		return err
	}
	messages, hasMore, err := s.agentMessages(ctx, tx, c.ID, queryInt(r, "before_seq", 0))
	if err != nil {
		return err
	}
	actions, err := s.agentActions(ctx, tx, c.ID)
	if err != nil {
		return err
	}
	plans, err := s.agentLoadPlans(ctx, tx, c.ID)
	if err != nil {
		return err
	}
	questions, err := s.agentLoadQuestions(ctx, tx, c.ID)
	if err != nil {
		return err
	}
	inputs, err := agentLoadInputs(ctx, tx, c.ID)
	if err != nil {
		return err
	}
	var goal *agentGoalView
	if agentWorkbenchFeatures()["goals"] {
		goal, err = s.agentGoalForConversation(ctx, tx, c.ID)
		if err != nil {
			return err
		}
	}
	var inputQueuePaused bool
	if err := tx.QueryRow(ctx, `SELECT input_queue_paused FROM agent_conversation WHERE id=$1`, c.ID).Scan(&inputQueuePaused); err != nil {
		return err
	}
	var currentPlan *agentPlanView
	for i := range plans {
		if plans[i].Status == "current" {
			currentPlan = &plans[i]
			break
		}
	}
	latest, err := s.agentLatestRunOf(ctx, tx, c.ID)
	if err != nil {
		return err
	}
	active := latest
	if active != nil && active.Status != "queued" && active.Status != "running" {
		active = nil
	}
	var usage struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
	}
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(prompt_tokens),0), coalesce(sum(completion_tokens),0)
		FROM agent_run WHERE conversation_id=$1`, c.ID).Scan(&usage.PromptTokens, &usage.CompletionTokens); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"conversation": c, "messages": messages, "actions": actions, "plans": plans, "current_plan": currentPlan, "questions": questions, "inputs": inputs, "input_queue_paused": inputQueuePaused, "usage": usage, "goal": goal,
		"active_run": active, "last_run": latest, "has_more": hasMore,
		"can_continue":   s.agentConversationCanContinue(ctx, c),
		"last_event_seq": lastEventSeq, "read_upto_event_seq": readUptoEventSeq,
		"partial_output": partial, "has_unread": hasUnread,
	})
}

// agentMessages 返回窗口内的消息；role=tool 不单独列出，而是折叠为助手消息的工具调用摘要（第 11.2 节）。
func (s *Server) agentMessages(ctx context.Context, tx pgx.Tx, convID uuid.UUID, before int) ([]agentMessageView, bool, error) {
	args := []any{convID}
	sql := `SELECT id, seq, message_key, role, content, ai_call_id, tool_calls, tool_call_id, attachment_ids, context_refs, skill_requests, run_id, created_at, source_message_id
		FROM agent_message WHERE conversation_id=$1`
	if before > 0 {
		args = append(args, before)
		sql += ` AND seq < $2`
	}
	args = append(args, agentMessagePage+1)
	rows, err := tx.Query(ctx, sql+fmt.Sprintf(` ORDER BY seq DESC LIMIT $%d`, len(args)), args...)
	if err != nil {
		return nil, false, err
	}
	type rawMessage struct {
		view          agentMessageView
		raw           []byte
		toolID        string
		ids           []uuid.UUID
		contextRefs   []byte
		skillRequests []byte
	}
	raw := []rawMessage{}
	toolResults := map[uuid.UUID]map[string]string{}
	attachmentIDs := []uuid.UUID{}
	for rows.Next() {
		var m rawMessage
		var toolCalls []byte
		if err := rows.Scan(&m.view.ID, &m.view.Seq, &m.view.MessageKey, &m.view.Role, &m.view.Content, &m.view.AICallID, &toolCalls,
			&m.toolID, &m.ids, &m.contextRefs, &m.skillRequests, &m.view.RunID, &m.view.CreatedAt, &m.view.SourceMessageID); err != nil {
			rows.Close()
			return nil, false, err
		}
		m.raw = toolCalls
		m.view.ContextRefs = []agentContextReference{}
		m.view.SkillRequests = []agentSkillRequest{}
		m.view.SkillUsage = []agentSkillUsageView{}
		if err := json.Unmarshal(m.contextRefs, &m.view.ContextRefs); err != nil {
			rows.Close()
			return nil, false, err
		}
		if err := json.Unmarshal(m.skillRequests, &m.view.SkillRequests); err != nil {
			rows.Close()
			return nil, false, err
		}
		if m.view.Role == "tool" {
			runID := uuid.Nil
			if m.view.RunID != nil {
				runID = *m.view.RunID
			}
			if toolResults[runID] == nil {
				toolResults[runID] = map[string]string{}
			}
			toolResults[runID][m.toolID] = m.view.Content
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
	attachments, err := s.agentAttachments(ctx, tx, attachmentIDs, convID)
	if err != nil {
		return nil, false, err
	}
	list := []agentMessageView{}
	for i := len(raw) - 1; i >= 0; i-- {
		m := raw[i]
		if m.view.Role == "tool" {
			continue
		}
		runID := uuid.Nil
		if m.view.RunID != nil {
			runID = *m.view.RunID
		}
		m.view.ToolCalls = agentToolCallsOf(m.raw, toolResults[runID])
		m.view.Attachments = []agentAttachmentView{}
		if m.view.AICallID != nil {
			m.view.SkillUsage, err = s.agentAICallSkillUsage(ctx, tx, *m.view.AICallID)
			if err != nil {
				return nil, false, err
			}
		}
		for _, aid := range m.ids {
			if a, found := attachments[aid]; found {
				m.view.Attachments = append(m.view.Attachments, a)
			}
		}
		list = append(list, m.view)
	}
	if err := agentLoadToolActivity(ctx, tx, convID, list); err != nil {
		return nil, false, err
	}
	requestedByRun := map[uuid.UUID][]agentSkillRequest{}
	for i := range list {
		message := &list[i]
		if message.Role == "user" && message.RunID != nil {
			requestedByRun[*message.RunID] = message.SkillRequests
			continue
		}
		if message.Role != "assistant" || message.RunID == nil {
			continue
		}
		requests := requestedByRun[*message.RunID]
		if len(requests) == 0 {
			continue
		}
		seen := make(map[uuid.UUID]bool, len(message.SkillUsage))
		for _, usage := range message.SkillUsage {
			seen[usage.ID] = true
		}
		for _, request := range requests {
			if !seen[request.SkillID] {
				message.SkillUsage = append(message.SkillUsage, agentSkillUsageView{
					ID: request.SkillID, Name: request.Name, Loaded: false,
				})
			}
		}
	}
	return list, hasMore, nil
}

func (s *Server) agentAICallSkillUsage(ctx context.Context, tx pgx.Tx, callID uuid.UUID) ([]agentSkillUsageView, error) {
	var sharedRaw, privateRaw []byte
	var ownerID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT context_refs,private_context_refs,context_owner_user_id
		FROM ai_call WHERE id=$1`, callID).Scan(&sharedRaw, &privateRaw, &ownerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return []agentSkillUsageView{}, nil
		}
		return nil, err
	}
	var shared struct {
		Skills struct {
			Items []SkillUseItem `json:"items"`
		} `json:"skills"`
	}
	if len(sharedRaw) > 0 {
		if err := json.Unmarshal(sharedRaw, &shared); err != nil {
			return nil, err
		}
	}
	items := append([]SkillUseItem{}, shared.Skills.Items...)
	if ownerID != nil && *ownerID == ident(ctx).UserID && len(privateRaw) > 0 {
		var private struct {
			Items []SkillUseItem `json:"items"`
		}
		if err := json.Unmarshal(privateRaw, &private); err != nil {
			return nil, err
		}
		items = append(items, private.Items...)
	}
	out := make([]agentSkillUsageView, 0, len(items))
	for _, item := range items {
		usage := agentSkillUsageView{ID: item.ID, Name: item.Name, Scope: item.Scope, Loaded: item.Used}
		if item.Reason != nil {
			usage.Reason = *item.Reason
		}
		out = append(out, usage)
	}
	return out, nil
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

func (s *Server) agentAttachments(ctx context.Context, tx pgx.Tx, ids []uuid.UUID, conversationID uuid.UUID) (map[uuid.UUID]agentAttachmentView, error) {
	out := map[uuid.UUID]agentAttachmentView{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `SELECT id, kind, name, mime, bytes, width, height FROM agent_attachment
		WHERE id = ANY($1) AND workspace_id=$2 AND user_id=$3
		AND EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=agent_attachment.id AND r.conversation_id=$4)`,
		ids, ident(ctx).WorkspaceID, ident(ctx).UserID, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a agentAttachmentView
		if err := rows.Scan(&a.ID, &a.Kind, &a.Name, &a.Mime, &a.Bytes, &a.Width, &a.Height); err != nil {
			return nil, err
		}
		a.URL = "/api/v1/agent/attachments/" + a.ID.String() + "/file?conversation_id=" + conversationID.String()
		out[a.ID] = a
	}
	return out, rows.Err()
}

func (s *Server) agentActions(ctx context.Context, tx pgx.Tx, convID uuid.UUID) ([]agentActionView, error) {
	rows, err := tx.Query(ctx, `SELECT `+agentActionCols+`
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
	preview, editable_fields, blank_fields, need, result, error, last_error, expires_at, batch_id, created_at,revision`

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
		&a.ExpiresAt, &a.BatchID, &a.CreatedAt, &a.Revision); err != nil {
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

func (s *Server) agentLatestRunOf(ctx context.Context, tx pgx.Tx, convID uuid.UUID) (*agentActiveRun, error) {
	var run agentActiveRun
	var snapshot []byte
	err := tx.QueryRow(ctx, `SELECT id, status, stage, trigger, model_provider_id, model, started_at,reason,error_code,mode,config_snapshot
		FROM agent_run WHERE conversation_id=$1
		ORDER BY started_at DESC LIMIT 1`, convID).Scan(&run.ID, &run.Status, &run.Stage, &run.Trigger,
		&run.ModelProviderID, &run.Model, &run.StartedAt, &run.Reason, &run.ErrorCode, &run.Mode, &snapshot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if string(snapshot) != "{}" {
		if err := json.Unmarshal(snapshot, &run.ConfigSnapshot); err != nil {
			return nil, err
		}
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
		r.Get("/agent/conversation-groups", s.h(s.listAgentConversationGroups))
		r.Post("/agent/conversation-groups", s.h(s.createAgentConversationGroup))
		r.Patch("/agent/conversation-groups/{id}", s.h(s.patchAgentConversationGroup))
		r.Delete("/agent/conversation-groups/{id}", s.h(s.deleteAgentConversationGroup))
		r.Post("/agent/conversations/{id}/read", s.h(s.markAgentConversationRead))
		r.Get("/agent/conversations/{id}/search", s.h(s.searchAgentConversationMessages))
		r.Post("/agent/conversations/{id}/fork", s.h(s.postAgentConversationFork))
		r.Get("/agent/conversations/{id}/artifacts", s.h(s.listAgentArtifacts))
		r.Get("/agent/artifacts/{id}", s.h(s.getAgentArtifact))
		r.Post("/agent/artifacts/{id}/versions", s.h(s.postAgentArtifactVersion))
		r.Get("/agent/conversations/{id}/events", s.h(s.getAgentConversationEvents))
		r.Get("/agent/context-candidates", s.h(s.getAgentContextCandidates))
		r.Post("/agent/context-preview", s.h(s.postAgentContextPreview))
		r.Get("/agent/settings", s.h(s.getAgentSettings))
		r.Put("/agent/settings", s.h(s.putAgentSettings))
		r.Post("/agent/conversations/{id}/messages", s.h(s.postAgentMessages))
		r.Get("/agent/conversations/{id}/compact-preview", s.h(s.getAgentCompactPreview))
		r.Post("/agent/conversations/{id}/compact", s.h(s.postAgentCompact))
		r.Post("/agent/conversations/{id}/goal", s.h(s.postAgentGoal))
		r.Patch("/agent/conversations/{id}/goal", s.h(s.patchAgentGoal))
		r.Post("/agent/goals/{id}/control", s.h(s.postAgentGoalControl))
		r.Post("/agent/goals/{id}/confirm-criterion", s.h(s.postAgentGoalConfirmCriterion))
		r.Get("/agent/routines", s.h(s.getAgentRoutineList))
		r.Post("/agent/routines", s.h(s.postAgentRoutine))
		r.Get("/agent/routines/{id}", s.h(s.getAgentRoutine))
		r.Patch("/agent/routines/{id}", s.h(s.patchAgentRoutine))
		r.Delete("/agent/routines/{id}", s.h(s.deleteAgentRoutine))
		r.Post("/agent/routines/{id}/control", s.h(s.postAgentRoutineControl))
		r.Get("/agent/routines/{id}/occurrences", s.h(s.getAgentRoutineOccurrences))
		r.Post("/agent/conversations/{id}/inputs", s.h(s.postAgentInput))
		r.Post("/agent/conversations/{id}/inputs/resume", s.h(s.resumeAgentInputs))
		r.Patch("/agent/inputs/{id}", s.h(s.patchAgentInput))
		r.Delete("/agent/inputs/{id}", s.h(s.deleteAgentInput))
		r.Post("/agent/conversations/{id}/continue", s.h(s.postAgentContinue))
		r.Post("/agent/conversations/{id}/regenerate", s.h(s.postAgentRegenerate))
		r.Post("/agent/conversations/{id}/messages/{messageId}/edit", s.h(s.postAgentMessageEdit))
		r.Post("/agent/runs/{id}/cancel", s.h(s.postAgentRunCancel))
		r.Post("/agent/plans/{id}/accept", s.h(s.postAgentPlanAccept))
		r.Post("/agent/questions/{id}/answer", s.h(s.postAgentQuestionAnswer))
		// 第 11.3 节：/agent/actions 下只有 {id}/execute 与 {id}/reject（HC-27 静态检查）。
		r.Post("/agent/actions/{id}/execute", s.h(s.postAgentActionExecute))
		r.Post("/agent/actions/{id}/reject", s.h(s.postAgentActionReject))
		// 第 11.1 节：附件上传、读取与删除。
		r.Post("/agent/attachments", s.h(s.postAgentAttachment))
		r.Get("/agent/attachments/{id}/file", s.h(s.getAgentAttachmentFile))
		r.Delete("/agent/attachments/{id}", s.h(s.deleteAgentAttachment))
	})
}
