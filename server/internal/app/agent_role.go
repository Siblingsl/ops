package app

// REF41 A6：角色 bot 与工具白名单。角色是工作区内的 bot 配置：人设/工具白名单/
// 预算/模型路由。白名单强制在 run 循环内逐次调用前检查，越权返回 tool_not_allowed
// 不执行；空白名单表示无工具（不是全部）。管理员工具（settings__*/users__*/billing__*）
// 不可授予。预算取角色值与全局值较小者。不改变 D-117：卡片仍逐张确认。

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// agentRoleBuiltinKeys 是三个内置角色（seed 到每个工作区；可停用不可删）。
var agentRoleBuiltinKeys = []string{"topic_planner", "reviewer", "publisher"}

// agentRoleAdminToolPrefixes 是角色不能授予的管理员工具前缀（A6-A4）。
var agentRoleAdminToolPrefixes = []string{"settings__", "users__", "billing__"}

// agentRoleBuiltinSpecs 内置角色的默认工具白名单（只读诊断 + 需确认的 W 卡片工具）。
var agentRoleBuiltinSpecs = map[string]struct {
	Name    string
	Persona string
	Tools   []string
}{
	"topic_planner": {
		Name:    "选题策划",
		Persona: "围绕账号定位收集素材、对比竞品，提出可执行的选题建议；不直接发布。",
		Tools:   []string{"topics__", "materials__", "benchmark__", "review__", "topic_create"},
	},
	"reviewer": {
		Name:    "审稿人",
		Persona: "只做诊断与建议：检查结构、标题、合规风险，给出修改理由；不执行任何写入。",
		Tools:   []string{"works__get", "review__", "diagnosis__", "polish_check"},
	},
	"publisher": {
		Name:    "发布运营",
		Persona: "准备发布字段、核对 manifest 与回读结果；发布动作永远由用户逐张确认。",
		Tools:   []string{"works__", "publish_manifest__", "publish_task__", "publish_task_create"},
	},
}

// AgentRole 是角色 bot 的投影。
type AgentRole struct {
	ID            uuid.UUID `json:"id"`
	WorkspaceID   uuid.UUID `json:"workspace_id"`
	Name          string    `json:"name"`
	Persona       string    `json:"persona"`
	ToolAllowlist []string  `json:"tool_allowlist"`
	MaxRounds     int       `json:"max_rounds"`
	MaxSeconds    int       `json:"max_seconds"`
	ModelTaskType string    `json:"model_task_type"`
	Status        string    `json:"status"`
	BuiltinKey    string    `json:"builtin_key"`
}

const agentRoleCols = `id, workspace_id, name, persona, tool_allowlist, max_rounds, max_seconds,
	model_task_type, status, builtin_key`

func scanAgentRole(row pgx.Row) (*AgentRole, error) {
	var r AgentRole
	if err := row.Scan(&r.ID, &r.WorkspaceID, &r.Name, &r.Persona, &r.ToolAllowlist, &r.MaxRounds,
		&r.MaxSeconds, &r.ModelTaskType, &r.Status, &r.BuiltinKey); err != nil {
		return nil, err
	}
	return &r, nil
}

// seedAgentRoles 为工作区补齐三个内置角色（幂等；builtin_key 唯一索引去重）。
func (s *Server) seedAgentRoles(ctx context.Context, ws uuid.UUID) {
	for _, key := range agentRoleBuiltinKeys {
		spec := agentRoleBuiltinSpecs[key]
			if _, err := s.db.Exec(ctx, `INSERT INTO agent_role
			(workspace_id, name, persona, tool_allowlist, model_task_type, builtin_key)
			VALUES ($1,$2,$3,$4,'',$5) ON CONFLICT (workspace_id, builtin_key) WHERE builtin_key <> '' DO NOTHING`,
			ws, spec.Name, spec.Persona, spec.Tools, key); err != nil {
			s.observeFailure(ctx, slog.LevelWarn, "内置角色 seed 失败", observeFields{
				ErrorCode: "agent_role_seed_failed", Route: "internal/agent/roles/seed",
				Extras: map[string]any{"workspace_id": ws.String(), "builtin_key": key, "err": err.Error()},
			})
			return
		}
	}
}

// agentRoleOf 按 ID 加载角色并校验工作区归属（A6 跨工作区不可见）。
func (s *Server) agentRoleOf(ctx context.Context, ws, roleID uuid.UUID) (*AgentRole, error) {
	row := s.db.QueryRow(ctx, `SELECT `+agentRoleCols+` FROM agent_role WHERE id=$1 AND workspace_id=$2`,
		roleID, ws)
	r, err := scanAgentRole(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return r, err
}

// agentRoleAdminToolDenied 管理员工具不可授予（A6-A4）。
func agentRoleAdminToolDenied(allowlist []string) bool {
	for _, name := range allowlist {
		for _, prefix := range agentRoleAdminToolPrefixes {
			if strings.HasPrefix(name, prefix) {
				return true
			}
		}
	}
	return false
}

// agentRoleAllowed 判断 run 的角色白名单是否放行该工具；无角色返回 true（不额外限制）。
// 空白名单表示无工具（不是全部）。
func agentRoleAllowed(role *AgentRole, toolName string) bool {
	if role == nil {
		return true
	}
	if len(role.ToolAllowlist) == 0 {
		return false
	}
	for _, pattern := range role.ToolAllowlist {
		if pattern == toolName {
			return true
		}
		if strings.HasSuffix(pattern, "__") && strings.HasPrefix(toolName, pattern) {
			return true
		}
		if strings.HasSuffix(pattern, "*") && strings.HasPrefix(toolName, strings.TrimSuffix(pattern, "*")) {
			return true
		}
	}
	return false
}

// agentRoleIDOrNull 空 role_id 存 NULL。
func agentRoleIDOrNull(id string) any {
	if id == "" {
		return nil
	}
	uid, err := uuid.Parse(id)
	if err != nil {
		return nil
	}
	return uid
}

// agentRoleBudgets 返回角色预算与全局值取小后的生效预算（A6-A5）。
func agentRoleBudgets(role *AgentRole, globalMaxRounds, globalMaxSeconds int) (int, int) {
	rounds, seconds := globalMaxRounds, globalMaxSeconds
	if role != nil {
		if role.MaxRounds < rounds {
			rounds = role.MaxRounds
		}
		if role.MaxSeconds < seconds {
			seconds = role.MaxSeconds
		}
	}
	return rounds, seconds
}

// ---------- HTTP handlers ----------

func (s *Server) listAgentRoles(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `SELECT `+agentRoleCols+` FROM agent_role
		WHERE workspace_id=$1 ORDER BY created_at`, ws)
	if err != nil {
		return err
	}
	items := []AgentRole{}
	for rows.Next() {
		r2, err := scanAgentRole(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, *r2)
	}
	rows.Close()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"roles": items})
}

func (s *Server) createAgentRole(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	user := ident(r.Context()).UserID
	var in struct {
		Name          string   `json:"name"`
		Persona       string   `json:"persona"`
		ToolAllowlist []string `json:"tool_allowlist"`
		MaxRounds     int      `json:"max_rounds"`
		MaxSeconds    int      `json:"max_seconds"`
		ModelTaskType string   `json:"model_task_type"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if runeLen(name) < 1 || runeLen(name) > 30 {
		return validation("角色名需为 1–30 字")
	}
	if runeLen(in.Persona) > 800 {
		return validation("人设不超过 800 字")
	}
	if in.ToolAllowlist == nil {
		in.ToolAllowlist = []string{}
	}
	if agentRoleAdminToolDenied(in.ToolAllowlist) {
		return validation("角色不能授予管理员工具")
	}
	rounds, seconds := in.MaxRounds, in.MaxSeconds
	if rounds == 0 {
		rounds = 8
	}
	if seconds == 0 {
		seconds = 180
	}
	if rounds < 1 || rounds > 30 || seconds < 30 || seconds > 900 {
		return validation("预算超出范围：轮数 1–30，秒数 30–900")
	}
	var id uuid.UUID
	err := s.db.QueryRow(r.Context(), `INSERT INTO agent_role
		(workspace_id, name, persona, tool_allowlist, max_rounds, max_seconds, model_task_type, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		ws, name, in.Persona, in.ToolAllowlist, rounds, seconds, strings.TrimSpace(in.ModelTaskType), user).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return apiErr(http.StatusConflict, "agent_role_exists", "同工作区已存在同名角色")
		}
		return err
	}
	s.audit(r.Context(), "agent_role_create", "agent_role", id.String(), "ok", map[string]any{"name": name})
	role, err := s.agentRoleOf(r.Context(), ws, id)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"role": role})
}

func (s *Server) patchAgentRole(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	roleID, err := uuid.Parse(chi.URLParam(r, "roleID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_role_id", "角色 ID 不合法")
	}
	var in struct {
		Name          *string   `json:"name"`
		Persona       *string   `json:"persona"`
		ToolAllowlist []string  `json:"tool_allowlist"`
		MaxRounds     *int      `json:"max_rounds"`
		MaxSeconds    *int      `json:"max_seconds"`
		Status        *string   `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	role, err := s.agentRoleOf(r.Context(), ws, roleID)
	if err != nil {
		return err
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if runeLen(name) < 1 || runeLen(name) > 30 {
			return validation("角色名需为 1–30 字")
		}
		role.Name = name
	}
	if in.Persona != nil {
		if runeLen(*in.Persona) > 800 {
			return validation("人设不超过 800 字")
		}
		role.Persona = *in.Persona
	}
	if in.ToolAllowlist != nil {
		if agentRoleAdminToolDenied(in.ToolAllowlist) {
			return validation("角色不能授予管理员工具")
		}
		role.ToolAllowlist = in.ToolAllowlist
	}
	if in.MaxRounds != nil {
		if *in.MaxRounds < 1 || *in.MaxRounds > 30 {
			return validation("轮数需为 1–30")
		}
		role.MaxRounds = *in.MaxRounds
	}
	if in.MaxSeconds != nil {
		if *in.MaxSeconds < 30 || *in.MaxSeconds > 900 {
			return validation("秒数需为 30–900")
		}
		role.MaxSeconds = *in.MaxSeconds
	}
	if in.Status != nil {
		if *in.Status != "active" && *in.Status != "disabled" {
			return validation("状态只能是 active/disabled")
		}
		role.Status = *in.Status
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE agent_role SET name=$2, persona=$3, tool_allowlist=$4,
		max_rounds=$5, max_seconds=$6, status=$7, updated_at=now() WHERE id=$1 AND workspace_id=$8`,
		roleID, role.Name, role.Persona, role.ToolAllowlist, role.MaxRounds, role.MaxSeconds, role.Status, ws)
	if err != nil {
		if isUniqueViolation(err) {
			return apiErr(http.StatusConflict, "agent_role_exists", "同工作区已存在同名角色")
		}
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "agent_role_patch", "agent_role", roleID.String(), "ok", nil)
	updated, err := s.agentRoleOf(r.Context(), ws, roleID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"role": updated})
}

func (s *Server) deleteAgentRole(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	roleID, err := uuid.Parse(chi.URLParam(r, "roleID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_role_id", "角色 ID 不合法")
	}
	role, err := s.agentRoleOf(r.Context(), ws, roleID)
	if err != nil {
		return err
	}
	if role.BuiltinKey != "" {
		return apiErr(http.StatusConflict, "agent_role_builtin", "内置角色只能停用，不能删除")
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM agent_role WHERE id=$1 AND workspace_id=$2 AND builtin_key=''`,
		roleID, ws); err != nil {
		return err
	}
	s.audit(r.Context(), "agent_role_delete", "agent_role", roleID.String(), "ok", nil)
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": true})
}
