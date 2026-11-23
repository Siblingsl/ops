package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

		"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"ops/internal/skills"
)

// REF41 A5（docs/41 §A5）：流程技能蒸馏与发布技能模板。
// 从一次成功/失败的 agent run 蒸馏技能草稿（默认 disabled），提供 procedure 校验与
// 只建计划的回放；不复制隐私/密钥/隐藏推理。内置“发布流程”七步模板走 skills.Builtin。

// skillProcedureMaxSteps 是 procedure 步数上限（A5 §1）。
const skillProcedureMaxSteps = 12

// skillsBuiltinPublishFlowKey 是内置发布流程技能的 key（D-211/A5-A6）。
const skillsBuiltinPublishFlowKey = "builtin:publish_flow"

// skillsBuiltinPublishFlow 取内置发布流程定义；不存在返回 nil。
func skillsBuiltinPublishFlow() *skills.Def {
	return skills.BuiltinByKey(skillsBuiltinPublishFlowKey)
}

// skillsBuiltinPublishFlowSteps 解码内置发布流程的 procedure 步骤。
func skillsBuiltinPublishFlowSteps() []skillProcedureStep {
	def := skillsBuiltinPublishFlow()
	if def == nil {
		return nil
	}
	return skillProcedureOf([]byte(builtinProcedureRaw()))
}

// builtinProcedureRaw 取内置表里 publish_flow 的 procedure JSON。
func builtinProcedureRaw() string {
	for _, b := range skills.Builtins {
		if b.Key == skillsBuiltinPublishFlowKey {
			return b.Procedure
		}
	}
	return ""
}

// skillProcedureStep 是 procedure 每步的结构。
type skillProcedureStep struct {
	Seq      int             `json:"seq"`
	Title    string          `json:"title"`
	Action   string          `json:"action"`
	Tool     string          `json:"tool,omitempty"`
	Inputs   json.RawMessage `json:"inputs,omitempty"`
	Outputs  json.RawMessage `json:"outputs,omitempty"`
	Requires []string        `json:"requires,omitempty"`
	Gate     string          `json:"gate"`
}

// skillProcedureValidate 校验 procedure 数组：≤12 步、title ≤80、action ≤200、
// tool 必须在工具目录中或为空、gate ∈ none|confirm。
func skillProcedureValidate(steps []skillProcedureStep) error {
	if err := skillProcedureValidateStructureOnly(steps); err != nil {
		return err
	}
	for i := range steps {
		st := &steps[i]
		if st.Tool != "" && agentTool(st.Tool) == nil {
			return validationFields(
				fmt.Sprintf("procedure 第 %d 步 tool 不在工具目录：%s", st.Seq, st.Tool),
				map[string]string{"procedure": "invalid_tool"})
		}
	}
	return nil
}

// skillProcedureValidateStructureOnly 只做步数/顺序/长度/gate 结构校验，不查工具目录。
func skillProcedureValidateStructureOnly(steps []skillProcedureStep) error {
	if len(steps) < 1 || len(steps) > skillProcedureMaxSteps {
		return validationFields(
			fmt.Sprintf("procedure 需要 1–%d 步", skillProcedureMaxSteps),
			map[string]string{"procedure": "invalid"})
	}
	for i := range steps {
		st := &steps[i]
		if st.Seq != i+1 {
			return validationFields("procedure 步序必须从 1 连续递增", map[string]string{"procedure": "invalid"})
		}
		if runeLen(st.Title) == 0 || runeLen(st.Title) > 80 {
			return validationFields("procedure 每步 title 需要 1–80 字", map[string]string{"procedure": "invalid"})
		}
		if runeLen(st.Action) == 0 || runeLen(st.Action) > 200 {
			return validationFields("procedure 每步 action 需要 1–200 字", map[string]string{"procedure": "invalid"})
		}
		if st.Gate != "none" && st.Gate != "confirm" {
			return validationFields("procedure gate 只允许 none|confirm", map[string]string{"procedure": "invalid"})
		}
	}
	return nil
}

// skillProcedureSummary 把步骤串成 instructions 摘要（≤1200 字）。
func skillProcedureSummary(steps []skillProcedureStep) string {
	parts := make([]string, 0, len(steps))
	for _, st := range steps {
		parts = append(parts, fmt.Sprintf("%d. %s：%s", st.Seq, st.Title, st.Action))
	}
	text := strings.Join(parts, "\n")
	if runeLen(text) > 1200 {
		text = string([]rune(text)[:1200])
	}
	return text
}

// skillDistillAIOutput 是 AI 蒸馏输出契约。
type skillDistillAIOutput struct {
	Steps          []skillProcedureStep `json:"steps"`
	Platforms      []string             `json:"platforms"`
	ContentFormats []string             `json:"content_formats"`
	Confidence     float64              `json:"confidence"`
}

func (o *skillDistillAIOutput) validate() error {
	if err := skillProcedureValidate(o.Steps); err != nil {
		return err
	}
	if o.Confidence < 0 || o.Confidence > 1 {
		return validationFields("confidence 需要 0–1", map[string]string{"confidence": "invalid"})
	}
	return nil
}

// skillDistillPrompt 构造蒸馏输入：只包含用户可见内容与工具调用摘要。
func skillDistillPrompt(name, summary, triggers, runBrief string, toolSummaries []string) string {
	var b strings.Builder
	b.WriteString("从下面一次 agent 运行的可见摘要中蒸馏一个可复用流程技能。\n")
	b.WriteString("输出 JSON：{\"steps\":[{\"seq\":1,\"title\":\"\",\"action\":\"\",\"tool\":\"\",\"inputs\":{},\"outputs\":{},\"requires\":[],\"gate\":\"none|confirm\"}],\"platforms\":[],\"content_formats\":[],\"confidence\":0.0}\n")
	b.WriteString("要求：步骤 ≤12；每步 title ≤80 字、action ≤200 字；tool 只能留空或取自列出的现有工具名；\n")
	b.WriteString("gate 为 confirm 表示该步回放时需要用户确认；不得包含任何密钥、评论者身份或隐藏推理。\n")
	fmt.Fprintf(&b, "\n技能名：%s\n技能摘要：%s\n触发场景：%s\n", name, summary, triggers)
	if runBrief != "" {
		b.WriteString("\n运行概要（用户可见消息）：\n" + runBrief + "\n")
	}
	if len(toolSummaries) > 0 {
		b.WriteString("\n工具调用摘要：\n")
		for _, t := range toolSummaries {
			b.WriteString("- " + t + "\n")
		}
	}
	b.WriteString("\n可用工具名（只能从中选择或留空）：\n")
	for _, t := range agentCatalog() {
		b.WriteString(t.Name + " ")
	}
	b.WriteString("\n")
	return b.String()
}

// skillRunVisibleBrief 取 run 的用户可见消息摘要（不读隐藏推理）。
func (s *Server) skillRunVisibleBrief(ctx context.Context, runID, wsID uuid.UUID) (string, error) {
	rows, err := s.db.Query(ctx, `SELECT role, content FROM agent_message
		WHERE run_id=$1 AND role IN ('user','assistant') ORDER BY seq`, runID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var parts []string
	for rows.Next() {
		var role, content string
		if err := rows.Scan(&role, &content); err != nil {
			return "", err
		}
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		if runeLen(content) > 400 {
			content = string([]rune(content)[:400])
		}
		parts = append(parts, role+": "+content)
		if len(parts) >= 10 {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return strings.Join(parts, "\n"), nil
}

// skillRunToolSummaries 取 run 的工具调用摘要（只名称 + 完成态，不含参数正文）。
func (s *Server) skillRunToolSummaries(ctx context.Context, runID, wsID uuid.UUID) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT tool_name, jsonb_typeof(tool_calls)
		FROM agent_message WHERE run_id=$1 AND tool_name<>'' ORDER BY seq`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name, kind string
		if err := rows.Scan(&name, &kind); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// postSkillDistill 从一次 agent run 蒸馏技能草稿：POST /agent-runs/{id}/distill-skill。
func (s *Server) postSkillDistill(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	runID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	var in struct {
		Name     string `json:"name"`
		Summary  string `json:"summary"`
		Triggers string `json:"triggers"`
		Scope    string `json:"scope"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	name := strings.TrimSpace(in.Name)
	summary := strings.TrimSpace(in.Summary)
	triggers := strings.TrimSpace(in.Triggers)
	if runeLen(name) < 1 || runeLen(name) > 30 {
		return validationFields("name 需要 1–30 字", map[string]string{"name": "invalid"})
	}
	if runeLen(summary) < 1 || runeLen(summary) > 60 {
		return validationFields("summary 需要 1–60 字", map[string]string{"summary": "invalid"})
	}
	if runeLen(triggers) < 1 || runeLen(triggers) > 120 {
		return validationFields("triggers 需要 1–120 字", map[string]string{"triggers": "invalid"})
	}
	if in.Scope == "" {
		in.Scope = "workspace"
	}
	if in.Scope != "workspace" && in.Scope != "personal" {
		return validationFields("蒸馏 scope 只允许 workspace|personal", map[string]string{"scope": "invalid"})
	}

	// run 归属：同工作区即可蒸馏；跨工作区 404。
	var runWS uuid.UUID
	var runUser uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT workspace_id, user_id FROM agent_run WHERE id=$1`, runID).
		Scan(&runWS, &runUser)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && runWS != idv.WorkspaceID) {
		return errNotFound
	}
	if err != nil {
		return err
	}

	// 一个 run 只蒸馏一个技能：重复请求幂等返回同草稿。
	var existing uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM skill WHERE source_run_id=$1 LIMIT 1`, runID).Scan(&existing); err == nil {
		row, err := s.skillVisibleDef(ctx, existing)
		if err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"idempotent": true, "skill": skillDTOOf(row.Def, row.CreatedBy, row.CreatedAt, row.UpdatedAt)})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	// 密钥检测：输入与输出都拒绝。
	secrets := s.agentSecretValues(ctx, idv.WorkspaceID)
	brief, err := s.skillRunVisibleBrief(ctx, runID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	toolSummaries, err := s.skillRunToolSummaries(ctx, runID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	userText := name + summary + triggers + brief
	if agentContainsSecret(userText, secrets) {
		return apiErr(422, "skill_secret_detected", "运行内容疑似包含密钥，已拒绝蒸馏").With(map[string]string{"field": "run"})
	}

	output, aiResult, err := func() (*skillDistillAIOutput, *aiResult, error) {
		var out skillDistillAIOutput
		prompt := skillDistillPrompt(name, summary, triggers, brief, toolSummaries)
		res, err := s.runAIJSON(ctx, aiTask{Type: "skill_distill", User: prompt, JSON: true, Bare: true,
			Refs: map[string]any{"run_id": runID}}, &out, func() error { return out.validate() })
		if err != nil {
			return nil, nil, err
		}
		return &out, res, nil
	}()
	if err != nil {
		return err
	}
	if agentContainsSecret(skillProcedureSummary(output.Steps), secrets) {
		return apiErr(422, "skill_secret_detected", "蒸馏结果疑似包含密钥，已拒绝保存").With(map[string]string{"field": "procedure"})
	}

	// 建 skill 草稿：origin=distilled、status=disabled。
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	instructions := skillProcedureSummary(output.Steps)
	if runeLen(instructions) < 1 {
		instructions = summary
	}
	var wsID any = idv.WorkspaceID
	var userID any
	if in.Scope == "personal" {
		wsID = nil
		userID = idv.UserID
	}
	var newID uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO skill
		(workspace_id, user_id, name, summary, triggers, instructions, platforms, content_formats,
		 task_enabled, agent_enabled, status, origin, procedure, procedure_version, source_run_id,
		 distill_confidence, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,true,'disabled','distilled',$9,1,$10,$11,$12)
		RETURNING id`,
		wsID, userID, name, summary, triggers, instructions,
		normalizeEnumArray(output.Platforms), normalizeEnumArray(output.ContentFormats),
		marshalSkillProcedure(output.Steps), runID, output.Confidence, idv.UserID).Scan(&newID)
	if err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23505" {
			return apiErr(422, "name_conflict", "同一范围内已有同名技能")
		}
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (actor_id, workspace_id, action, target_type, target_id, result, visibility)
		VALUES ($1,$2,'skill_distill','skill',$3,'ok','personal')`, idv.UserID, idv.WorkspaceID, newID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"idempotent": false,
		"ai_call_id": aiResult.CallID,
		"skill": map[string]any{
			"id": newID, "name": name, "summary": summary, "status": "disabled",
			"origin": "distilled", "procedure_version": 1,
			"procedure": output.Steps, "confidence": output.Confidence,
		},
	})
}

// marshalSkillProcedure 编码步骤数组（非法 JSON 输入已在校验层拒绝）。
func marshalSkillProcedure(steps []skillProcedureStep) []byte {
	data, err := json.Marshal(steps)
	if err != nil {
		return []byte("[]")
	}
	return data
}

// skillProcedureOf 从库行解码 procedure。
func skillProcedureOf(raw []byte) []skillProcedureStep {
	var steps []skillProcedureStep
	if err := json.Unmarshal(raw, &steps); err != nil {
		return nil
	}
	return steps
}

// postSkillProcedureValidate 只校验 procedure，不执行：POST /skills/{id}/procedure/validate。
func (s *Server) postSkillProcedureValidate(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	idv := ident(r.Context())
	skillID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	ctx := r.Context()
	var rawProcedure []byte
	var wsID *uuid.UUID
	var userID *uuid.UUID
	var accountID *uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT procedure, workspace_id, user_id, account_id FROM skill WHERE id=$1`,
		skillID).Scan(&rawProcedure, &wsID, &userID, &accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	// 可见性：workspace 命中或本人 personal。
	visible := (wsID != nil && *wsID == idv.WorkspaceID) || (userID != nil && *userID == idv.UserID)
	if !visible {
		return errNotFound
	}
	steps := skillProcedureOf(rawProcedure)
	err = skillProcedureValidate(steps)
	result := map[string]any{"valid": err == nil}
	if err != nil {
		result["error"] = err.Error()
	}
	// 逐步工具门禁提示：不执行，只标记。
	flags := make([]map[string]any, 0, len(steps))
	for _, st := range steps {
		flag := map[string]any{"seq": st.Seq, "gate": st.Gate, "tool": st.Tool, "tool_known": st.Tool == "" || agentTool(st.Tool) != nil}
		flags = append(flags, flag)
	}
	result["steps"] = flags
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "skill_procedure_invalid", "procedure 校验未通过").With(result)
	}
	return ok(w, result)
}

// postSkillReplay 回放技能：只创建计划（agent_plan），不直接执行工具。
// POST /skills/{id}/replay {account_id?, goal}。
func (s *Server) postSkillReplay(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	skillID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	var in struct {
		AccountID string `json:"account_id"`
		Goal      string `json:"goal"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	goal := strings.TrimSpace(in.Goal)
	if runeLen(goal) < 1 || runeLen(goal) > 2000 {
		return validationFields("goal 需要 1–2000 字", map[string]string{"goal": "invalid"})
	}

	// 技能可见 + status=active + replay_policy=suggest_only。
	// builtin 技能不入库（静态注册表）：先查注册表，再查库内行。
	var name string
	var status, replayPolicy, rawProcedure string
	var wsID, userID *uuid.UUID
	isBuiltin := false
	if builtin := skillBuiltinByID(skillID); builtin != nil {
		isBuiltin = true
		name = builtin.Fields.Name
		status = builtin.Fields.Status
		replayPolicy = "suggest_only"
		rawProcedure = builtin.Procedure
		err = nil
	} else {
		err = s.db.QueryRow(ctx, `SELECT name, status, replay_policy, procedure, workspace_id, user_id
			FROM skill WHERE id=$1`, skillID).Scan(&name, &status, &replayPolicy, &rawProcedure, &wsID, &userID)
	}
	if errors.Is(err, pgx.ErrNoRows) || (!isBuiltin && err == nil && wsID == nil && (userID == nil || *userID != idv.UserID)) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if wsID != nil && *wsID != idv.WorkspaceID {
		return errNotFound
	}
	if status != "active" {
		return apiErr(409, "skill_not_active", "技能未启用，不能回放").With(map[string]string{"status": status})
	}
	if replayPolicy != "suggest_only" {
		return apiErr(409, "skill_replay_policy_invalid", "技能回放策略不允许建议式回放")
	}
	steps := skillProcedureOf([]byte(rawProcedure))
	// 回放守卫按结构 → 权限顺序：先做结构/长度校验（tool 存在性除外，交给下方
	// 权限守卫以 403 tool_not_allowed 表达“不得提升权限”语义）。
	if err := skillProcedureValidateStructureOnly(steps); err != nil {
		return err
	}

	// 回放不得提升权限：procedure 引用的工具必须在当前用户可用的目录中。
	for _, st := range steps {
		if st.Tool != "" && agentTool(st.Tool) == nil {
			return apiErr(http.StatusForbidden, "tool_not_allowed",
				fmt.Sprintf("技能第 %d 步引用的工具当前不可用：%s", st.Seq, st.Tool))
		}
	}

	// 建回放 run（trigger='skill_replay'）+ agent_plan（requiresConfirmation 语义由
	// 计划 accept 流程承担）；不调用任何工具。
	var convID uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO agent_conversation (workspace_id, user_id, title)
		VALUES ($1,$2,$3) RETURNING id`, idv.WorkspaceID, idv.UserID,
		"技能回放 · "+name).Scan(&convID); err != nil {
		return err
	}
	var runID, planID uuid.UUID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `INSERT INTO agent_run
		(conversation_id, workspace_id, user_id, trigger, status, stage, execution_origin)
		VALUES ($1,$2,$3,'skill_replay','awaiting_confirmation','queued','interactive')
		RETURNING id`, convID, idv.WorkspaceID, idv.UserID).Scan(&runID); err != nil {
		return err
	}
	planSteps := make([]agentPlanStepDefinition, 0, len(steps))
	for _, st := range steps {
		acceptance := st.Action
		if st.Gate == "confirm" {
			acceptance = st.Action + "（需确认）"
		}
		planSteps = append(planSteps, agentPlanStepDefinition{
			ID:         fmt.Sprintf("s%d", st.Seq),
			Title:      st.Title,
			TargetRef:  st.Tool,
			Acceptance: acceptance,
		})
	}
	summary := "技能回放：" + name + " · " + goal
	if runeLen(summary) > 2000 {
		summary = string([]rune(summary)[:2000])
	}
	planVersion := 1
	stepsJSON, err := json.Marshal(planSteps)
	if err != nil {
		return err
	}
	requestHash, hashErr := agentRequestPayloadHash(map[string]any{"skill_id": skillID, "goal": goal})
	if hashErr != nil {
		return hashErr
	}
	if err := tx.QueryRow(ctx, `INSERT INTO agent_plan
		(id,conversation_id,source_run_id,source_tool_call_id,request_hash,version,summary,steps,status)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'current') RETURNING id`,
		uuid.New(), convID, runID, "skill_replay", requestHash, planVersion, summary, stepsJSON).Scan(&planID); err != nil {
		return err
	}
	for _, st := range planSteps {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_plan_step_state(plan_id,step_id) VALUES($1,$2)`, planID, st.ID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (actor_id, workspace_id, action, target_type, target_id, result, visibility)
		VALUES ($1,$2,'skill_replay','skill',$3,'ok','personal')`, idv.UserID, idv.WorkspaceID, skillID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"run_id": runID, "conversation_id": convID, "plan_id": planID,
		"summary": summary, "steps": planSteps,
		"note": "回放只组装计划，不会自动执行任何工具；每一步仍需你逐步确认。",
	})
}
