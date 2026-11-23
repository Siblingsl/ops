package app

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestA6BuiltinRolesSeededAndReadOnly(t *testing.T) {
	// A6-A1/A2：三内置角色 seed、字段完整、builtin 唯一；不可删（409）。
	a := drAccount(t, "xhs", "A6 角色小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedAgentRoles(context.Background(), wsID)

	var list struct {
		Roles []AgentRole `json:"roles"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent-roles", nil, &list)
	if len(list.Roles) < 3 {
		t.Fatalf("want >=3 builtin roles, got %d", len(list.Roles))
	}
	keys := map[string]AgentRole{}
	for _, role := range list.Roles {
		if role.BuiltinKey != "" {
			keys[role.BuiltinKey] = role
		}
	}
	for _, key := range []string{"topic_planner", "reviewer", "publisher"} {
		role, ok := keys[key]
		if !ok {
			t.Fatalf("builtin %s missing", key)
		}
		if len(role.ToolAllowlist) == 0 {
			t.Fatalf("%s should have tools", key)
		}
		if role.MaxRounds < 1 || role.MaxRounds > 30 {
			t.Fatalf("%s budget invalid: %d", key, role.MaxRounds)
		}
	}
	// 内置不可删。
	reviewer := keys["reviewer"]
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent-roles/"+reviewer.ID.String(), nil, nil, http.StatusConflict)
}

func TestA6AllowlistEnforcedToolNotAllowed(t *testing.T) {
	// A6-A3：白名单外工具逐次调用前拒绝 tool_not_allowed；空表无工具。
	role := &AgentRole{ToolAllowlist: []string{"topics__", "works__get"}}
	if !agentRoleAllowed(role, "topics__suggest") {
		t.Fatalf("prefix topics__ should allow topics__suggest")
	}
	if agentRoleAllowed(role, "publish_task_create") {
		t.Fatalf("publish_task_create must be denied")
	}
	empty := &AgentRole{}
	if agentRoleAllowed(empty, "topics__suggest") {
		t.Fatalf("empty allowlist means no tools")
	}
	if !agentRoleAllowed(nil, "publish_task_create") {
		t.Fatalf("nil role must not restrict")
	}
}

func TestA6AdminToolsNeverGrantable(t *testing.T) {
	// A6-A4：settings__/users__/billing__ 前缀创建/PATCH 都拒绝。
	env.mustJSONStatus(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "管理员bot", "tool_allowlist": []string{"settings__models"}}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "用户bot", "tool_allowlist": []string{"users__list"}}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "账单bot", "tool_allowlist": []string{"billing__pay"}}, nil, http.StatusUnprocessableEntity)

	// 创建合法角色后 PATCH 换入管理员工具也拒绝。
	var created struct {
		Role AgentRole `json:"role"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "合法角色", "tool_allowlist": []string{"topics__"}}, &created)
	env.mustJSONStatus(t, "PATCH", "/api/v1/agent-roles/"+created.Role.ID.String(),
		map[string]any{"tool_allowlist": []string{"topics__", "settings__workspace"}}, nil, http.StatusUnprocessableEntity)
}

func TestA6BudgetMinOfRoleAndGlobal(t *testing.T) {
	// A6-A5：预算取小——角色 3 轮 < 全局 → 3；角色 30 轮 > 全局 → 全局。
	role := &AgentRole{MaxRounds: 3, MaxSeconds: 60}
	rounds, seconds := agentRoleBudgets(role, 8, 180)
	if rounds != 3 || seconds != 60 {
		t.Fatalf("role budgets: %d/%d", rounds, seconds)
	}
	high := &AgentRole{MaxRounds: 30, MaxSeconds: 900}
	rounds2, seconds2 := agentRoleBudgets(high, 8, 180)
	if rounds2 != 8 || seconds2 != 180 {
		t.Fatalf("global smaller must win: %d/%d", rounds2, seconds2)
	}
}

func TestA6RoleCRUDAndCrossWorkspace(t *testing.T) {
	// A6-A5/A6：自定义角色 CRUD；跨工作区 404；重名 409。
	_ = drAccount(t, "xhs", "A6 角色小红书")
	var created struct {
		Role AgentRole `json:"role"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "自定义运营", "persona": "专注发布核对", "tool_allowlist": []string{"works__"}, "max_rounds": 5, "max_seconds": 120}, &created)
	if created.Role.ID == uuid.Nil {
		t.Fatalf("create failed: %+v", created)
	}
	if len(created.Role.ToolAllowlist) != 1 || created.Role.MaxRounds != 5 {
		t.Fatalf("created fields wrong: %+v", created.Role)
	}

	// 重名 409。
	env.mustJSONStatus(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "自定义运营", "tool_allowlist": []string{}}, nil, http.StatusConflict)

	// PATCH 修改预算与停用。
	env.mustJSON(t, "PATCH", "/api/v1/agent-roles/"+created.Role.ID.String(),
		map[string]any{"max_rounds": 10, "status": "disabled"}, nil)
	var list struct {
		Roles []AgentRole `json:"roles"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent-roles", nil, &list)
	for _, role := range list.Roles {
		if role.ID == created.Role.ID {
			if role.Status != "disabled" || role.MaxRounds != 10 {
				t.Fatalf("patch failed: %+v", role)
			}
		}
	}

	// 自定义角色可删。
	env.mustJSON(t, "DELETE", "/api/v1/agent-roles/"+created.Role.ID.String(), nil, &struct{}{})

	// 跨工作区 404：另一用户 PATCH 该角色（agentRoleOf 按 workspace 过滤）。
	g := env.registerClient(t, "a6_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "PATCH", "/api/v1/agent-roles/"+created.Role.ID.String(),
		map[string]any{"status": "active"}, nil, http.StatusNotFound)
	_ = list
}

func TestA6DisabledRoleBlocksRunStart(t *testing.T) {
	// A6-A3：禁用角色的 run 启动被拒 agent_role_disabled（run 受理先解析角色再选模型？——
	// 实际顺序是先选模型后解析角色，故需先 ensureToolModel 配置可用模型）。
	env.ensureToolModel(t)
	a := drAccount(t, "xhs", "A6 禁用小红书")
	_ = a
	var created struct {
		Role AgentRole `json:"role"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent-roles",
		map[string]any{"name": "禁用角色", "tool_allowlist": []string{"topics__"}}, &created)
	env.mustJSON(t, "PATCH", "/api/v1/agent-roles/"+created.Role.ID.String(),
		map[string]any{"status": "disabled"}, nil)

	var conv struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/agent/conversations", map[string]any{}, &conv)
	env.mustJSONStatus(t, "POST", "/api/v1/agent/conversations/"+conv.ID+"/messages",
		map[string]any{"request_id": uuid.NewString(), "text": "开始", "protocol_version": 2,
			"role_id": created.Role.ID.String()}, nil, http.StatusConflict)
}

func TestA6BuiltinAllowlistDenyPublishWrite(t *testing.T) {
	// A6-A2 边界：reviewer 白名单不允许发布写入工具；publisher 不含自动发布（D-117 不变）。
	a := drAccount(t, "xhs", "A6 白名单小红书")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	env.srv.seedAgentRoles(context.Background(), wsID)
	var list struct {
		Roles []AgentRole `json:"roles"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent-roles", nil, &list)
	for _, role := range list.Roles {
		if role.BuiltinKey == "reviewer" {
			for _, tool := range role.ToolAllowlist {
				if strings.HasPrefix(tool, "publish") || strings.HasPrefix(tool, "notify") {
					t.Fatalf("reviewer must not have publish/notify tools: %v", role.ToolAllowlist)
				}
			}
		}
		if role.BuiltinKey == "publisher" {
			for _, tool := range role.ToolAllowlist {
				if strings.Contains(tool, "publish_now") || strings.Contains(tool, "batch") {
					t.Fatalf("publisher must not contain auto-publish/batch: %v", role.ToolAllowlist)
				}
			}
		}
	}
}
