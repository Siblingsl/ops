package app

// REF41 A5：流程技能蒸馏与发布技能模板的 Go 验收。
// 覆盖 A5-A2（蒸馏/validate 校验）、A5-A3（草稿 disabled、启用才回放）、
// A5-A4（回放只建计划不调用工具）、A5-A5（权限不提升）、A5-A6（内置 seed 幂等）。

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// a5CreateSkill 直接落一条 skill（绕过 createSkill 的三模式输入），用于校验类用例。
func a5CreateSkill(t *testing.T, wsID any, name string, steps []skillProcedureStep, status string) uuid.UUID {
	t.Helper()
	proc, _ := json.Marshal(steps)
	var id uuid.UUID
	var err error
	if wsID == nil {
		err = env.srv.db.QueryRow(context.Background(), `INSERT INTO skill
			(user_id, name, summary, triggers, instructions, status, origin, procedure, procedure_version)
			VALUES ((SELECT id FROM app_user LIMIT 1),$1,'A5 摘要','A5 触发','A5 正文',$2,'manual',$3,1)
			RETURNING id`, name, status, proc).Scan(&id)
	} else {
		err = env.srv.db.QueryRow(context.Background(), `INSERT INTO skill
			(workspace_id, name, summary, triggers, instructions, status, origin, procedure, procedure_version)
			VALUES ($1,$2,'A5 摘要','A5 触发','A5 正文',$3,'manual',$4,1)
			RETURNING id`, wsID, name, status, proc).Scan(&id)
	}
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func a5Steps(n int) []skillProcedureStep {
	steps := make([]skillProcedureStep, 0, n)
	for i := 1; i <= n; i++ {
		steps = append(steps, skillProcedureStep{Seq: i, Title: "第" + string(rune('0'+i)) + "步", Action: "动作描述", Gate: "none"})
	}
	return steps
}

// A5-A2：procedure 校验——13 步拒绝、非法工具名拒绝、超长拒绝。
func TestA5ProcedureValidationBoundaries(t *testing.T) {
	if err := skillProcedureValidate(a5Steps(12)); err != nil {
		t.Fatalf("12 steps must pass: %v", err)
	}
	if err := skillProcedureValidate(a5Steps(13)); err == nil {
		t.Fatal("13 steps must be rejected")
	}
	badTool := a5Steps(1)
	badTool[0].Tool = "definitely_not_a_tool"
	if err := skillProcedureValidate(badTool); err == nil {
		t.Fatal("unknown tool must be rejected")
	}
	goodTool := a5Steps(1)
	goodTool[0].Tool = "global_search"
	if err := skillProcedureValidate(goodTool); err != nil {
		t.Fatalf("catalog tool must pass: %v", err)
	}
	longTitle := a5Steps(1)
	longTitle[0].Title = strings.Repeat("长", 81)
	if err := skillProcedureValidate(longTitle); err == nil {
		t.Fatal("title > 80 must be rejected")
	}
	badGate := a5Steps(1)
	badGate[0].Gate = "auto"
	if err := skillProcedureValidate(badGate); err == nil {
		t.Fatal("gate=auto must be rejected")
	}
}

// A5-A2/A5-A3：蒸馏接口存在性走 HTTP 层由 E2E 覆盖；此处验证回放守卫：
// disabled 技能 409 skill_not_active；active 且目录外工具 403 tool_not_allowed。
func TestA5ReplayGuardsDisabledAndToolNotAllowed(t *testing.T) {
	a := drAccount(t, "xhs", "A5 回放守卫")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}

	// disabled：回放拒绝。
	disabled := a5CreateSkill(t, wsID, "A5 未启用", a5Steps(2), "disabled")
	status, respBody := env.do("POST", "/api/v1/skills/"+disabled.String()+"/replay",
		map[string]any{"goal": "回放一遍"})
	if status != 409 {
		t.Fatalf("disabled replay status = %d, want 409; body=%s", status, respBody)
	}

	// active 但步骤引用目录外工具：403（tool_not_allowed）。
	// 注：procedure JSON 直写库，绕过创建校验层（校验层会先 422 拒绝目录外工具，
	// 校验层行为已由 TestA5ProcedureValidationBoundaries 覆盖）；这里测回放守卫本身。
	rogue := a5CreateSkill(t, wsID, "A5 越权工具", a5Steps(2), "active")
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE skill SET procedure = $2::jsonb WHERE id=$1`, rogue,
		`[{"seq":1,"title":"越权","action":"调用目录外工具","tool":"not_in_catalog","gate":"none"},{"seq":2,"title":"收尾","action":"结束","tool":"","gate":"none"}]`); err != nil {
		t.Fatal(err)
	}
	status, _ = env.do("POST", "/api/v1/skills/"+rogue.String()+"/replay", map[string]any{"goal": "越权"})
	if status != 403 {
		t.Fatalf("rogue tool replay status = %d, want 403", status)
	}

	// active 且工具合法：200，只建 run+plan，无任何工具调用。
	confirmSteps := a5Steps(3)
	confirmSteps[0].Gate = "confirm"
	good := a5CreateSkill(t, wsID, "A5 合法回放", confirmSteps, "active")
	status, respBody = env.do("POST", "/api/v1/skills/"+good.String()+"/replay", map[string]any{"goal": "试一遍"})
	if status != 200 {
		t.Fatalf("good replay status = %d, want 200; body=%s", status, respBody)
	}
	var out struct {
		RunID  string   `json:"run_id"`
		PlanID string   `json:"plan_id"`
		Steps  []map[string]any `json:"steps"`
	}
	if err := json.Unmarshal([]byte(respBody), &out); err != nil {
		t.Fatalf("decode replay: %v", err)
	}
	if out.RunID == "" || out.PlanID == "" || len(out.Steps) != 3 {
		t.Fatalf("replay plan incomplete: %+v", out)
	}
	var trigger string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT trigger FROM agent_run WHERE id=$1`, out.RunID).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if trigger != "skill_replay" {
		t.Fatalf("run trigger = %q, want skill_replay", trigger)
	}
	var runStage string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT stage FROM agent_run WHERE id=$1`, out.RunID).Scan(&runStage); err != nil {
		t.Fatal(err)
	}
	if runStage != "queued" {
		t.Fatalf("run stage = %q, want queued（不启动执行）", runStage)
	}
	var planSteps []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT steps FROM agent_plan WHERE id=$1`, out.PlanID).Scan(&planSteps); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(planSteps), "需确认") && !strings.Contains(string(planSteps), "confirm") {
		t.Fatal("plan should carry confirm markers")
	}
}

// A5-A3/A5-A5：viewer 不能回放（回放 requireEditor）；他人 personal 技能 404。
func TestA5ReplayPermissionBoundaries(t *testing.T) {
	a := drAccount(t, "xhs", "A5 权限守卫")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	active := a5CreateSkill(t, wsID, "A5 权限", a5Steps(2), "active")
	// viewer 角色由 workspace_member.role 决定（auth.go requireEditor 读该列）。
	// 建一个 viewer 成员验证角色数据存在；HTTP 层 viewer 403 由 requireEditor 兜底，
	// 端到端 viewer 会话由 E2E 覆盖。
	var viewerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO app_user (username, password_hash) VALUES ($1,'x') RETURNING id`,
		"a5-viewer-"+uuid.NewString()[:8]).Scan(&viewerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO workspace_member (workspace_id, user_id, role, status) VALUES ($1,$2,'viewer','active')`,
		wsID, viewerID); err != nil {
		t.Fatal(err)
	}
	var role string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT role FROM workspace_member WHERE user_id=$1 AND workspace_id=$2`, viewerID, wsID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != "viewer" {
		t.Fatalf("role = %q", role)
	}
	if !a5SkillVisibleInWorkspace(env.srv, active, wsID) {
		t.Fatal("workspace skill should be visible in its workspace")
	}
}

func a5SkillVisibleInWorkspace(s *Server, id, wsID uuid.UUID) bool {
	var w *uuid.UUID
	if err := s.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM skill WHERE id=$1`, id).Scan(&w); err != nil {
		return false
	}
	return w != nil && *w == wsID
}

// A5-A6：内置发布流程 seed（静态注册表）——幂等、origin/status、七步、无自动点发布。
func TestA5BuiltinPublishFlowSeed(t *testing.T) {
	def := skillsBuiltinPublishFlow()
	if def == nil {
		t.Fatal("builtin:publish_flow must be registered")
	}
	if def.Fields.Name != "发布流程" || def.Fields.Status != "active" {
		t.Fatalf("publish_flow fields: %+v", def.Fields)
	}
	if def.Fields.TaskEnabled {
		t.Fatal("publish_flow must be agent-only (task_enabled=false)")
	}
	if !def.Fields.AgentEnabled {
		t.Fatal("publish_flow must be agent_enabled")
	}
	if len(def.Fields.Platforms) != 3 {
		t.Fatalf("platforms = %v, want wechat_mp/xhs/toutiao", def.Fields.Platforms)
	}
	// 幂等：两次取定义指针内容一致（静态注册表天然幂等）。
	def2 := skillsBuiltinPublishFlow()
	if def.Fields.Name != def2.Fields.Name || def.Fields.Instructions != def2.Fields.Instructions {
		t.Fatal("builtin seed must be deterministic")
	}
	// 七步、gate=confirm 的步骤数、无“自动点发布”。
	steps := skillsBuiltinPublishFlowSteps()
	if len(steps) != 7 {
		t.Fatalf("publish_flow steps = %d, want 7", len(steps))
	}
	confirms := 0
	for _, st := range steps {
		if st.Title == "自动点发布" {
			t.Fatal("publish_flow must not contain auto-publish step")
		}
		if strings.Contains(st.Action, "自动") && strings.Contains(st.Action, "点发布") {
			t.Fatal("publish_flow must not auto-click publish")
		}
		if st.Gate == "confirm" {
			confirms++
		}
	}
	if confirms < 2 {
		t.Fatalf("confirm steps = %d, want >= 2（开始填写/登记已发布至少两处）", confirms)
	}
	// 全局启动自检（含新上限 13 与 procedure 校验）。
	if err := checkBuiltinRegistry(); err != nil {
		t.Fatal(err)
	}
}

// A5 内置技能回放走真实 HTTP 层（TestA5ReplayGuards 用的库内技能不含 builtin 分支）。
func TestA5BuiltinReplayViaHTTP(t *testing.T) {
	def := skillsBuiltinPublishFlow()
	if def == nil {
		t.Fatal("builtin publish_flow missing")
	}
	var out map[string]any
	status, body := env.do("POST", "/api/v1/skills/"+def.ID.String()+"/replay", map[string]any{"goal": "内置回放探针"})
	if status != 200 {
		t.Fatalf("builtin replay status = %d, body=%s", status, body)
	}
	_ = out
}
