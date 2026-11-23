package app

// REF41 A7：工作流模板（基于计划）。启动只创建 conversation+run+plan 并返回预览，
// 用户经现有计划确认接口确认后才开始执行；每步仍走计划状态与动作卡片，不做
// “全部执行”。缺必需输入 422 并列出缺什么；启动失败事务回滚不留半成品。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// workflowAllowedRequires 是步骤 requires 允许的上下文键（docs/41 A7 白名单）。
var workflowAllowedRequires = []string{"account_id", "work_id", "topic_id", "benchmark_target_id", "date_range"}

// workflowBuiltinSpecs 内置三模板（不含自动发布/批量执行步骤）。
var workflowBuiltinSpecs = []struct {
	Key         string
	Name        string
	Description string
	Steps       []map[string]any
}{
	{
		Key:         "benchmark_decompose",
		Name:        "竞对拆解",
		Description: "选目标 → 抓作品 → AI 初拆 → 人工确认 → 入库。",
		Steps: []map[string]any{
			{"key": "select_target", "title": "选择竞对目标", "requires": []string{"benchmark_target_id"}, "outputs": []string{"benchmark_target_id"}, "confirm": false, "tools": []string{"benchmark__list"}},
			{"key": "capture_work", "title": "抓取竞对作品", "requires": []string{"benchmark_target_id"}, "outputs": []string{"note_id"}, "confirm": false, "tools": []string{"benchmark__notes"}},
			{"key": "ai_draft", "title": "AI 初拆结构", "requires": []string{"benchmark_target_id"}, "outputs": []string{"structure"}, "confirm": false, "tools": []string{"benchmark__decompose"}},
			{"key": "confirm_structure", "title": "人工确认拆解", "requires": []string{"benchmark_target_id"}, "outputs": []string{}, "confirm": true, "tools": []string{"benchmark__confirm"}},
		},
	},
	{
		Key:         "weekly_review",
		Name:        "周复盘",
		Description: "拉指标 → 同龄对比 → 生成复盘 → 人工确认。",
		Steps: []map[string]any{
			{"key": "pull_metrics", "title": "拉取一周指标", "requires": []string{"account_id", "date_range"}, "outputs": []string{"metrics"}, "confirm": false, "tools": []string{"metrics__read"}},
			{"key": "peer_compare", "title": "同龄对比", "requires": []string{"account_id", "date_range"}, "outputs": []string{"peer_card"}, "confirm": false, "tools": []string{"review__peer"}},
			{"key": "confirm_review", "title": "人工确认复盘", "requires": []string{"account_id"}, "outputs": []string{}, "confirm": true, "tools": []string{"review__confirm"}},
		},
	},
	{
		Key:         "publish_prepare",
		Name:        "发布准备",
		Description: "读作品 → 生成 manifest → 校验 → 生成封面 → 停在待填。",
		Steps: []map[string]any{
			{"key": "read_work", "title": "读取作品", "requires": []string{"work_id"}, "outputs": []string{"work"}, "confirm": false, "tools": []string{"works__get"}},
			{"key": "build_manifest", "title": "生成发布字段", "requires": []string{"work_id"}, "outputs": []string{"manifest"}, "confirm": false, "tools": []string{"publish_manifest__build"}},
			{"key": "validate_manifest", "title": "校验发布字段", "requires": []string{"work_id"}, "outputs": []string{}, "confirm": false, "tools": []string{"publish_manifest__validate"}},
			{"key": "await_fill", "title": "停在待填（用户去平台填写）", "requires": []string{"work_id"}, "outputs": []string{}, "confirm": true, "tools": []string{"publish_task__get"}},
		},
	},
}

// WorkflowTemplate 是模板投影。
type WorkflowTemplate struct {
	ID          uuid.UUID        `json:"id"`
	WorkspaceID uuid.UUID        `json:"workspace_id"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Steps       []map[string]any `json:"steps"`
	Status      string           `json:"status"`
	BuiltinKey  string           `json:"builtin_key"`
}

const workflowTemplateCols = `id, workspace_id, name, description, steps, status, builtin_key`

func scanWorkflowTemplate(row pgx.Row) (*WorkflowTemplate, error) {
	var t WorkflowTemplate
	var raw []byte
	if err := row.Scan(&t.ID, &t.WorkspaceID, &t.Name, &t.Description, &raw, &t.Status, &t.BuiltinKey); err != nil {
		return nil, err
	}
	t.Steps = []map[string]any{}
	_ = json.Unmarshal(raw, &t.Steps)
	return &t, nil
}

// validateWorkflowSteps 校验步骤结构：key 唯一、requires 只允许白名单键。
func validateWorkflowSteps(steps []map[string]any) error {
	seen := map[string]bool{}
	for i, step := range steps {
		key, _ := step["key"].(string)
		if key == "" {
			return validation(fmt.Sprintf("第 %d 步缺少 key", i+1))
		}
		if seen[key] {
			return validation("步骤 key 重复：" + key)
		}
		seen[key] = true
		requiresRaw, _ := step["requires"].([]any)
		for _, item := range requiresRaw {
			r, _ := item.(string)
			if !workflowRequiresAllowed(r) {
				return validation("步骤 " + key + " 的 requires 含非法上下文键：" + r)
			}
		}
	}
	return nil
}

func workflowRequiresAllowed(key string) bool {
	for _, allowed := range workflowAllowedRequires {
		if allowed == key {
			return true
		}
	}
	return false
}

// seedWorkflowTemplates 为工作区补齐三内置模板（幂等）。
func (s *Server) seedWorkflowTemplates(ctx context.Context, ws uuid.UUID) {
	for _, spec := range workflowBuiltinSpecs {
		steps, _ := json.Marshal(spec.Steps)
		if _, err := s.db.Exec(ctx, `INSERT INTO workflow_template
			(workspace_id, name, description, steps, builtin_key)
			VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, builtin_key) WHERE builtin_key <> '' DO NOTHING`,
			ws, spec.Name, spec.Description, string(steps), spec.Key); err != nil {
			s.observeFailure(ctx, slog.LevelWarn, "内置工作流模板 seed 失败", observeFields{
				ErrorCode: "workflow_template_seed_failed", Route: "internal/workflows/seed",
				Extras: map[string]any{"workspace_id": ws.String(), "builtin_key": spec.Key, "err": err.Error()},
			})
			return
		}
	}
}

// ---------- HTTP handlers ----------

func (s *Server) listWorkflowTemplates(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `SELECT `+workflowTemplateCols+` FROM workflow_template
		WHERE workspace_id=$1 ORDER BY created_at`, ws)
	if err != nil {
		return err
	}
	items := []WorkflowTemplate{}
	for rows.Next() {
		t, err := scanWorkflowTemplate(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, *t)
	}
	rows.Close()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"templates": items})
}

func (s *Server) createWorkflowTemplate(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	user := ident(r.Context()).UserID
	var in struct {
		Name        string           `json:"name"`
		Description string           `json:"description"`
		Steps       []map[string]any `json:"steps"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if runeLen(name) < 1 || runeLen(name) > 40 {
		return validation("模板名需为 1–40 字")
	}
	if runeLen(in.Description) > 200 {
		return validation("描述不超过 200 字")
	}
	if len(in.Steps) < 1 || len(in.Steps) > 12 {
		return validation("步骤数需为 1–12")
	}
	if err := validateWorkflowSteps(in.Steps); err != nil {
		return err
	}
	steps, _ := json.Marshal(in.Steps)
	var id uuid.UUID
	err := s.db.QueryRow(r.Context(), `INSERT INTO workflow_template
		(workspace_id, name, description, steps, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		ws, name, in.Description, string(steps), user).Scan(&id)
	if err != nil {
		if isUniqueViolation(err) {
			return apiErr(http.StatusConflict, "workflow_template_exists", "同工作区已存在同名模板")
		}
		return err
	}
	s.audit(r.Context(), "workflow_template_create", "workflow_template", id.String(), "ok", map[string]any{"name": name})
	t, err := scanWorkflowTemplate(s.db.QueryRow(r.Context(),
		`SELECT `+workflowTemplateCols+` FROM workflow_template WHERE id=$1`, id))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"template": t})
}

func (s *Server) patchWorkflowTemplate(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	tplID, err := uuid.Parse(chi.URLParam(r, "templateID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_template_id", "模板 ID 不合法")
	}
	var in struct {
		Status *string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	t, err := scanWorkflowTemplate(s.db.QueryRow(r.Context(),
		`SELECT `+workflowTemplateCols+` FROM workflow_template WHERE id=$1 AND workspace_id=$2`, tplID, ws))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if in.Status != nil {
		if *in.Status != "active" && *in.Status != "disabled" {
			return validation("状态只能是 active/disabled")
		}
		t.Status = *in.Status
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE workflow_template SET status=$2, updated_at=now()
		WHERE id=$1 AND workspace_id=$3`, tplID, t.Status, ws); err != nil {
		return err
	}
	s.audit(r.Context(), "workflow_template_patch", "workflow_template", tplID.String(), "ok", nil)
	updated, err := scanWorkflowTemplate(s.db.QueryRow(r.Context(),
		`SELECT `+workflowTemplateCols+` FROM workflow_template WHERE id=$1`, tplID))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"template": updated})
}

func (s *Server) deleteWorkflowTemplate(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	tplID, err := uuid.Parse(chi.URLParam(r, "templateID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_template_id", "模板 ID 不合法")
	}
	t, err := scanWorkflowTemplate(s.db.QueryRow(r.Context(),
		`SELECT `+workflowTemplateCols+` FROM workflow_template WHERE id=$1 AND workspace_id=$2`, tplID, ws))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if t.BuiltinKey != "" {
		return apiErr(http.StatusConflict, "workflow_template_builtin", "内置模板只能停用，不能删除")
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM workflow_template WHERE id=$1 AND workspace_id=$2 AND builtin_key=''`,
		tplID, ws); err != nil {
		return err
	}
	s.audit(r.Context(), "workflow_template_delete", "workflow_template", tplID.String(), "ok", nil)
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": true})
}

// workflowStartInput 是 POST /workflows/{id}/start 的输入。
type workflowStartInput struct {
	ConversationID    string `json:"conversation_id"`
	AccountID         string `json:"account_id"`
	WorkID            string `json:"work_id"`
	TopicID           string `json:"topic_id"`
	BenchmarkTargetID string `json:"benchmark_target_id"`
	DateRange         string `json:"date_range"`
}

// workflowStartHandler 启动模板：校验 active/归属/必需输入 → 建 conversation（可选）+
// run + plan + step_state；不执行任何工具；失败事务回滚。
func (s *Server) workflowStartHandler(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	user := ident(r.Context()).UserID
	tplID, err := uuid.Parse(chi.URLParam(r, "templateID"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_template_id", "模板 ID 不合法")
	}
	var in workflowStartInput
	if err := decode(r, &in); err != nil {
		return err
	}
	t, err := scanWorkflowTemplate(s.db.QueryRow(r.Context(),
		`SELECT `+workflowTemplateCols+` FROM workflow_template WHERE id=$1 AND workspace_id=$2`, tplID, ws))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if t.Status != "active" {
		return apiErr(http.StatusConflict, "workflow_template_disabled", "该模板已停用")
	}
	// 必需输入检查：收集上下文键 → 逐步骤核对 requires，缺什么列出什么（A7-A3）。
	context := map[string]bool{"account_id": in.AccountID != ""}
	if in.WorkID != "" {
		context["work_id"] = true
	}
	if in.TopicID != "" {
		context["topic_id"] = true
	}
	if in.BenchmarkTargetID != "" {
		context["benchmark_target_id"] = true
	}
	if in.DateRange != "" {
		context["date_range"] = true
	}
	missing := []string{}
	for _, step := range t.Steps {
		requiresRaw, _ := step["requires"].([]any)
		for _, item := range requiresRaw {
			key, _ := item.(string)
			if !context[key] {
				missing = append(missing, key)
			}
		}
	}
	if len(missing) > 0 {
		return apiErr(http.StatusUnprocessableEntity, "workflow_missing_input",
			"缺少必需输入："+strings.Join(workflowUniqueStrings(missing), "、")).With(map[string]any{"missing": workflowUniqueStrings(missing)})
	}
	// 解析 account 归属。
	accountID, err := uuid.Parse(in.AccountID)
	if err != nil {
		return validation("account_id 必须是 UUID")
	}
	if _, err := s.account(r.Context(), accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	// 事务：建 conversation（可选）+ run + plan + step_state。
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	convID, err := uuid.Parse(in.ConversationID)
	if in.ConversationID != "" && err == nil {
		var n int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_conversation
			WHERE id=$1 AND workspace_id=$2`, convID, ws).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return errNotFound
		}
	} else {
		if err := tx.QueryRow(r.Context(), `INSERT INTO agent_conversation (workspace_id, user_id, title)
			VALUES ($1,$2,$3) RETURNING id`, ws, user, t.Name).Scan(&convID); err != nil {
			return err
		}
	}
	var providerID uuid.UUID
	if err := tx.QueryRow(r.Context(), `SELECT id FROM model_provider
		WHERE workspace_id=$1 AND execution_location='server' AND status='active' ORDER BY created_at LIMIT 1`,
		ws).Scan(&providerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusUnprocessableEntity, "agent_model_unsupported", "还没有可用的模型，请先到模型配置中为智能体对话选择模型")
		}
		return err
	}
	requestID := uuid.New()
	var runID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_run
		(conversation_id, workspace_id, user_id, trigger, status, stage, model_provider_id, model,
		 protocol_version, request_id, request_hash, mode, execution_origin, config_snapshot)
		VALUES ($1,$2,$3,'message','awaiting_confirmation','confirmation',$4,'mock-writer',2,$5,$6,'plan','interactive','{}'::jsonb)
		RETURNING id`,
		convID, ws, user, providerID, requestID,
		sha256Hex([]byte(requestID.String()))).Scan(&runID); err != nil {
		return err
	}
	planSteps := []map[string]any{}
	for _, step := range t.Steps {
		title, _ := step["title"].(string)
		key, _ := step["key"].(string)
		acceptance := "按模板步骤完成"
		if outputs, ok := step["outputs"].([]any); ok && len(outputs) > 0 {
			parts := make([]string, 0, len(outputs))
			for _, output := range outputs {
				if value, ok := output.(string); ok && strings.TrimSpace(value) != "" {
					parts = append(parts, value)
				}
			}
			if len(parts) > 0 {
				acceptance = "产出：" + strings.Join(parts, "、")
			}
		}
		// A7-N6：计划卡与 update_plan_step 统一按 id 识别步骤；模板 key 必须映射为 id，
		// 否则 step_states 与计划卡无法对应，确认后首步永远不会显示“进行中”。
		planSteps = append(planSteps, map[string]any{"id": key, "title": title, "acceptance": acceptance})
	}
	stepsJSON, _ := json.Marshal(planSteps)
	var planID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_plan
		(conversation_id, source_run_id, source_tool_call_id, request_hash, version, summary, steps, status)
		VALUES ($1,$2,'workflow-start',$3,1,$4,$5,'current')
		RETURNING id`,
		convID, runID, sha256Hex([]byte(t.ID.String())), "工作流「"+t.Name+"」", stepsJSON).Scan(&planID); err != nil {
		return err
	}
	for _, step := range t.Steps {
		key, _ := step["key"].(string)
		if _, err := tx.Exec(r.Context(), `INSERT INTO agent_plan_step_state (plan_id, step_id)
			VALUES ($1,$2) ON CONFLICT (plan_id, step_id) DO NOTHING`, planID, key); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_conversation SET last_message_at=now(), updated_at=now()
		WHERE id=$1`, convID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.audit(r.Context(), "workflow_start", "workflow_template", tplID.String(), "ok",
		map[string]any{"run_id": runID.String(), "conversation_id": convID.String()})
	plan, _ := scanWorkflowPlan(s.db.QueryRow(r.Context(),
		`SELECT id, conversation_id, version, summary, steps, status FROM agent_plan WHERE id=$1`, planID))
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"conversation_id": convID, "run_id": runID, "plan": plan,
	})
}

func scanWorkflowPlan(row interface{ Scan(...any) error }) (map[string]any, error) {
	var id, convID uuid.UUID
	var version int
	var summary []byte
	var steps []byte
	var status string
	if err := row.Scan(&id, &convID, &version, &summary, &steps, &status); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "conversation_id": convID, "version": version,
		"summary": string(summary), "steps": json.RawMessage(steps), "status": status}, nil
}

func workflowUniqueStrings(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range items {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
