package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

type agentPlanStepDefinition struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	TargetRef  string `json:"target_ref,omitempty"`
	Acceptance string `json:"acceptance"`
}

type agentPlanEvidenceRef struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type agentPlanStepState struct {
	StepID       string                 `json:"step_id"`
	Status       string                 `json:"status"`
	EvidenceRefs []agentPlanEvidenceRef `json:"evidence_refs"`
	Revision     int64                  `json:"revision"`
}

type agentPlanView struct {
	ID          uuid.UUID                 `json:"id"`
	Version     int                       `json:"version"`
	SourceRunID uuid.UUID                 `json:"source_run_id"`
	Summary     string                    `json:"summary"`
	Steps       []agentPlanStepDefinition `json:"steps"`
	StepStates  []agentPlanStepState      `json:"step_states"`
	Status      string                    `json:"status"`
	AcceptedAt  *time.Time                `json:"accepted_at"`
	CreatedAt   time.Time                 `json:"created_at"`
}

func agentDecodeToolArgument(args map[string]any, key string, out any) error {
	raw, err := json.Marshal(args[key])
	if err != nil {
		return apiErr(422, "invalid_arguments", "工具参数无法解析："+key)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return apiErr(422, "invalid_arguments", "工具参数不正确："+key)
	}
	return nil
}

func agentValidatePlanSteps(steps []agentPlanStepDefinition) error {
	seen := map[string]bool{}
	for i := range steps {
		steps[i].ID = strings.TrimSpace(steps[i].ID)
		steps[i].Title = strings.TrimSpace(steps[i].Title)
		steps[i].TargetRef = strings.TrimSpace(steps[i].TargetRef)
		steps[i].Acceptance = strings.TrimSpace(steps[i].Acceptance)
		if steps[i].ID == "" || runeLen(steps[i].ID) > 80 || seen[steps[i].ID] ||
			runeLen(steps[i].Title) == 0 || runeLen(steps[i].Title) > 200 ||
			runeLen(steps[i].TargetRef) > 500 || runeLen(steps[i].Acceptance) == 0 || runeLen(steps[i].Acceptance) > 500 {
			return apiErr(422, "invalid_arguments", "计划步骤编号须唯一，标题、目标和验收条件不得超出长度限制")
		}
		seen[steps[i].ID] = true
	}
	return nil
}

func (s *Server) agentMetaPresentPlan(ctx context.Context, st *agentRunState, call ai.ToolCall,
	args map[string]any) ([]byte, string, error) {
	if agentEffectiveMode(st.Mode, ident(ctx).Role) != "plan" || (st.ExecutionOrigin != "interactive" && st.ExecutionOrigin != "goal") {
		return nil, "", apiErr(403, "forbidden", "当前模式或运行来源不能创建计划")
	}
	summary, _ := args["summary"].(string)
	summary = strings.TrimSpace(summary)
	var steps []agentPlanStepDefinition
	if err := agentDecodeToolArgument(args, "steps", &steps); err != nil {
		return nil, "", err
	}
	if runeLen(summary) == 0 || runeLen(summary) > 2000 || len(steps) < 1 || len(steps) > 12 {
		return nil, "", apiErr(422, "invalid_arguments", "计划摘要为1～2000字，步骤为1～12项")
	}
	if err := agentValidatePlanSteps(steps); err != nil {
		return nil, "", err
	}
	requestHash, err := agentRequestPayloadHash(map[string]any{"summary": summary, "steps": steps})
	if err != nil {
		return nil, "", err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return nil, "", err
	}
	var plan agentPlanView
	var rawSteps []byte
	var planRequestHash string
	err = tx.QueryRow(ctx, `SELECT id,version,source_run_id,summary,steps,status,accepted_at,created_at,request_hash
		FROM agent_plan WHERE source_run_id=$1 AND source_tool_call_id=$2`, st.RunID, call.ID).
		Scan(&plan.ID, &plan.Version, &plan.SourceRunID, &plan.Summary, &rawSteps, &plan.Status, &plan.AcceptedAt, &plan.CreatedAt, &planRequestHash)
	if err == nil {
		if planRequestHash != requestHash {
			return nil, "", apiErr(409, "agent_request_conflict", "计划工具调用编号已用于不同内容")
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, "", err
		}
		_ = json.Unmarshal(rawSteps, &plan.Steps)
		payload, _ := json.Marshal(map[string]any{"ok": true, "plan_id": plan.ID, "version": plan.Version, "status": plan.Status})
		return payload, "计划第" + agentItoa(plan.Version) + "版", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, "", err
	}
	if err := tx.QueryRow(ctx, `SELECT coalesce(max(version),0)+1 FROM agent_plan WHERE conversation_id=$1`, st.ConversationID).Scan(&plan.Version); err != nil {
		return nil, "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_plan SET status='superseded' WHERE conversation_id=$1 AND status='current'`, st.ConversationID); err != nil {
		return nil, "", err
	}
	plan.ID, plan.SourceRunID, plan.Summary, plan.Steps, plan.Status = uuid.New(), st.RunID, summary, steps, "current"
	stepsJSON, _ := json.Marshal(steps)
	if _, err := tx.Exec(ctx, `INSERT INTO agent_plan
		(id,conversation_id,source_run_id,source_tool_call_id,request_hash,version,summary,steps,status)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'current')`, plan.ID, st.ConversationID, st.RunID, call.ID,
		requestHash, plan.Version, summary, stepsJSON); err != nil {
		return nil, "", err
	}
	for _, step := range steps {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_plan_step_state(plan_id,step_id) VALUES($1,$2)`, plan.ID, step.ID); err != nil {
			return nil, "", err
		}
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "plan.updated", map[string]any{
		"plan_id": plan.ID, "version": plan.Version, "status": "current",
	}, nil); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	payload, _ := json.Marshal(map[string]any{"ok": true, "plan_id": plan.ID, "version": plan.Version, "status": plan.Status})
	return payload, "已保存计划第" + agentItoa(plan.Version) + "版", nil
}

func (s *Server) agentMetaUpdatePlanStep(ctx context.Context, st *agentRunState, call ai.ToolCall,
	args map[string]any) ([]byte, string, error) {
	planID, err := uuid.Parse(agentArgStr(args, "plan_id"))
	if err != nil || planID == uuid.Nil {
		return nil, "", apiErr(422, "invalid_arguments", "计划编号无效")
	}
	expectedVersion, ok := args["expected_version"].(int64)
	if !ok || expectedVersion < 1 {
		return nil, "", apiErr(422, "invalid_arguments", "计划版本无效")
	}
	stepID, _ := args["step_id"].(string)
	stepID = strings.TrimSpace(stepID)
	status, _ := args["status"].(string)
	switch status {
	case "pending", "in_progress", "waiting_user", "completed", "failed", "skipped":
	default:
		return nil, "", apiErr(422, "invalid_arguments", "计划步骤状态无效")
	}
	var evidence []agentPlanEvidenceRef
	if raw, exists := args["evidence_refs"]; exists {
		if err := agentDecodeToolArgument(args, "evidence_refs", &evidence); err != nil {
			return nil, "", err
		}
		_ = raw
	}
	if len(evidence) > 10 {
		return nil, "", apiErr(422, "invalid_arguments", "每个计划步骤最多关联10项证据")
	}
	requestHash, err := agentRequestPayloadHash(map[string]any{"plan_id": planID, "expected_version": expectedVersion,
		"step_id": stepID, "status": status, "evidence_refs": evidence})
	if err != nil {
		return nil, "", err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return nil, "", err
	}
	var version int
	var planStatus string
	err = tx.QueryRow(ctx, `SELECT version,status FROM agent_plan WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
		planID, st.ConversationID).Scan(&version, &planStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", errNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if version != int(expectedVersion) || planStatus != "current" {
		return nil, "", apiErr(409, "agent_revision_conflict", "计划版本已变化，请刷新后再更新步骤")
	}
	var stepRaw []byte
	if err := tx.QueryRow(ctx, `SELECT steps FROM agent_plan WHERE id=$1`, planID).Scan(&stepRaw); err != nil {
		return nil, "", err
	}
	var steps []agentPlanStepDefinition
	if err := json.Unmarshal(stepRaw, &steps); err != nil {
		return nil, "", err
	}
	found := false
	for _, step := range steps {
		found = found || step.ID == stepID
	}
	if !found {
		return nil, "", apiErr(422, "invalid_arguments", "步骤编号不属于该计划")
	}
	if status == "completed" && len(evidence) == 0 {
		return nil, "", apiErr(422, "agent_plan_evidence_required", "完成计划步骤必须关联已保存的结果证据")
	}
	if err := agentValidatePlanEvidence(ctx, tx, st.ConversationID, evidence); err != nil {
		return nil, "", err
	}
	var oldCallID, oldHash string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT source_tool_call_id,request_hash,revision FROM agent_plan_step_state
		WHERE plan_id=$1 AND step_id=$2 FOR UPDATE`, planID, stepID).Scan(&oldCallID, &oldHash, &revision)
	if err != nil {
		return nil, "", err
	}
	if oldCallID == call.ID {
		if oldHash != requestHash {
			return nil, "", apiErr(409, "agent_request_conflict", "步骤工具调用编号已用于不同内容")
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, "", err
		}
		payload, _ := json.Marshal(map[string]any{"ok": true, "plan_id": planID, "version": version,
			"step_id": stepID, "status": status, "revision": revision})
		return payload, "计划步骤状态已保存", nil
	}
	var reusedCallID bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_plan_step_state
		WHERE plan_id=$1 AND source_tool_call_id=$2 AND step_id<>$3)`, planID, call.ID, stepID).Scan(&reusedCallID); err != nil {
		return nil, "", err
	}
	if reusedCallID {
		return nil, "", apiErr(409, "agent_request_conflict", "步骤工具调用编号已用于该计划的其他更新")
	}
	evidenceJSON, _ := json.Marshal(evidence)
	if _, err := tx.Exec(ctx, `UPDATE agent_plan_step_state SET status=$3,evidence_refs=$4,revision=revision+1,
		source_tool_call_id=$5,request_hash=$6,updated_at=now() WHERE plan_id=$1 AND step_id=$2`,
		planID, stepID, status, evidenceJSON, call.ID, requestHash); err != nil {
		return nil, "", err
	}
	revision++
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "plan.updated", map[string]any{
		"plan_id": planID, "version": version, "step_id": stepID, "status": status, "revision": revision,
	}, nil); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	payload, _ := json.Marshal(map[string]any{"ok": true, "plan_id": planID, "version": version,
		"step_id": stepID, "status": status, "revision": revision})
	return payload, "计划步骤状态已保存", nil
}

func agentValidatePlanEvidence(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, evidence []agentPlanEvidenceRef) error {
	seen := map[string]bool{}
	for i := range evidence {
		evidence[i].Kind = strings.TrimSpace(evidence[i].Kind)
		evidence[i].ID = strings.TrimSpace(evidence[i].ID)
		id, err := uuid.Parse(evidence[i].ID)
		if err != nil || id == uuid.Nil {
			return apiErr(422, "agent_plan_evidence_invalid", "计划步骤引用的证据编号无效")
		}
		key := evidence[i].Kind + ":" + id.String()
		if seen[key] {
			return apiErr(422, "agent_plan_evidence_invalid", "计划步骤不能重复关联同一证据")
		}
		seen[key] = true
		var valid bool
		switch evidence[i].Kind {
		case "artifact_version":
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_artifact_version v JOIN agent_artifact a
				ON a.id=v.artifact_id WHERE v.id=$1 AND a.conversation_id=$2 AND v.status IN ('draft','applied'))`,
				id, conversationID).Scan(&valid)
		case "action":
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE id=$1 AND conversation_id=$2 AND status='succeeded')`,
				id, conversationID).Scan(&valid)
		case "read_result":
			var toolName, content string
			err = tx.QueryRow(ctx, `SELECT tool_name,content FROM agent_message WHERE id=$1 AND conversation_id=$2 AND role='tool'`,
				id, conversationID).Scan(&toolName, &content)
			if err == nil {
				entry := agentTool(toolName)
				var result struct {
					OK    bool `json:"ok"`
					Error any  `json:"error"`
				}
				valid = entry != nil && entry.Kind == toolR && json.Unmarshal([]byte(content), &result) == nil && result.OK && result.Error == nil
			}
		default:
			return apiErr(422, "agent_plan_evidence_invalid", "计划步骤的证据类型不受支持")
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !valid {
			return apiErr(422, "agent_plan_evidence_invalid", "证据不存在、不属于当前对话或未成功完成")
		}
	}
	return nil
}

func (s *Server) agentLoadPlans(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID) ([]agentPlanView, error) {
	rows, err := tx.Query(ctx, `SELECT id,version,source_run_id,summary,steps,status,accepted_at,created_at
		FROM agent_plan WHERE conversation_id=$1 ORDER BY version DESC`, conversationID)
	if err != nil {
		return nil, err
	}
	plans := []agentPlanView{}
	for rows.Next() {
		var plan agentPlanView
		var stepsRaw []byte
		if err := rows.Scan(&plan.ID, &plan.Version, &plan.SourceRunID, &plan.Summary, &stepsRaw, &plan.Status, &plan.AcceptedAt, &plan.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal(stepsRaw, &plan.Steps); err != nil {
			rows.Close()
			return nil, err
		}
		plan.StepStates = []agentPlanStepState{}
		plans = append(plans, plan)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range plans {
		rows, err := tx.Query(ctx, `SELECT step_id,status,evidence_refs,revision FROM agent_plan_step_state WHERE plan_id=$1 ORDER BY step_id`, plans[i].ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var state agentPlanStepState
			var raw []byte
			if err := rows.Scan(&state.StepID, &state.Status, &raw, &state.Revision); err != nil {
				rows.Close()
				return nil, err
			}
			state.EvidenceRefs = []agentPlanEvidenceRef{}
			if err := json.Unmarshal(raw, &state.EvidenceRefs); err != nil {
				rows.Close()
				return nil, err
			}
			plans[i].StepStates = append(plans[i].StepStates, state)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return plans, nil
}

type agentPlanAcceptRequest struct {
	ProtocolVersion int    `json:"protocol_version"`
	ExpectedVersion int    `json:"expected_version"`
	RequestID       string `json:"request_id"`
}

func (s *Server) postAgentPlanAccept(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("plans"); err != nil {
		return err
	}
	if ident(r.Context()).Role == "viewer" {
		return apiErr(403, "forbidden", "观察者不能接受计划")
	}
	planID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil || planID == uuid.Nil {
		return errNotFound
	}
	var req agentPlanAcceptRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ProtocolVersion != 2 {
		return apiErr(422, "validation_failed", "计划接受需要使用智能体协议版本2")
	}
	if err := requireAgentFeature("event_resume"); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil || req.ExpectedVersion < 1 {
		return validation("计划接受需要有效的expected_version和request_id")
	}
	var conversationID uuid.UUID
	var summary string
	var stepsRaw []byte
	if err := s.db.QueryRow(r.Context(), `SELECT p.conversation_id,p.summary,p.steps FROM agent_plan p JOIN agent_conversation c
		ON c.id=p.conversation_id WHERE p.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, planID,
		ident(r.Context()).WorkspaceID, ident(r.Context()).UserID).Scan(&conversationID, &summary, &stepsRaw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	conv, err := s.agentConversationFor(r.Context(), conversationID)
	if err != nil {
		return err
	}
	if err := s.agentExpireQuestions(r.Context(), conversationID); err != nil {
		return err
	}
	selected := *conv
	selected.Mode = "execute"
	payload := map[string]any{"plan_id": planID, "expected_version": req.ExpectedVersion}
	protocol := &agentRunProtocolRequest{RequestID: requestID, Payload: payload}
	runID, after, found, err := s.existingAgentRunRequest(r.Context(), conversationID, "plan_accept", protocol)
	if err != nil {
		return err
	}
	if found {
		messageID, err := agentRunMessageID(r.Context(), s.db, conversationID, runID)
		if err != nil {
			return err
		}
		writeAgentRunAccepted(w, conversationID, runID, messageID, after)
		return nil
	}
	var steps []agentPlanStepDefinition
	if err := json.Unmarshal(stepsRaw, &steps); err != nil {
		return err
	}
	acceptedPlan, _ := json.Marshal(map[string]any{"plan_id": planID, "version": req.ExpectedVersion,
		"summary": summary, "steps": steps})
	text := "请按已接受的计划继续执行。计划接受不等于批准任何业务写入；写入仍须逐张操作卡片确认。\n" +
		agentDataBlock("已接受计划", string(acceptedPlan))
	prepared, err := s.agentPrepareRun(r.Context(), conv, &selected, "plan_accept", protocol,
		func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
			ctx := r.Context()
			var version int
			var status string
			var acceptedAt *string
			if err := tx.QueryRow(ctx, `SELECT version,status,accepted_at::text FROM agent_plan
				WHERE id=$1 AND conversation_id=$2 FOR UPDATE`, planID, c.ID).Scan(&version, &status, &acceptedAt); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, false, errNotFound
				}
				return nil, false, err
			}
			if version != req.ExpectedVersion || status != "current" || acceptedAt != nil {
				return nil, false, apiErr(409, "agent_revision_conflict", "计划已修订或已接受，请刷新后查看当前版本")
			}
			var pendingQuestion bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending')`, c.ID).Scan(&pendingQuestion); err != nil {
				return nil, false, err
			}
			if pendingQuestion {
				return nil, false, apiErr(409, "agent_question_pending", "请先回答或明确替代当前澄清问题")
			}
			var pendingAction bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1
				AND status IN ('pending','needs_input','executing'))`, c.ID).Scan(&pendingAction); err != nil {
				return nil, false, err
			}
			if pendingAction {
				return nil, false, apiErr(409, "agent_action_state_invalid", "请先逐张处理当前操作卡片，再接受新计划")
			}
			if _, err := tx.Exec(ctx, `UPDATE agent_plan SET accepted_at=now() WHERE id=$1`, planID); err != nil {
				return nil, false, err
			}
			message, err := s.agentInsertRowTx(ctx, tx, c.ID, nil, "user", text, nil, "", "", nil)
			if err != nil {
				return nil, false, err
			}
			if _, err := appendAgentEventTx(ctx, tx, c.ID, nil, "plan.updated", map[string]any{"plan_id": planID,
				"version": version, "status": "accepted"}, nil); err != nil {
				return nil, false, err
			}
			return &message.ID, false, nil
		})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, conversationID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}
