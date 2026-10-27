package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

var (
	errAgentGoalBudgetReached  = errors.New("agent goal budget reached")
	errAgentGoalPaused         = errors.New("agent goal is not active")
	errAgentGoalNoContinuation = errors.New("agent goal has no background continuation")
)

type agentGoalCriterion struct {
	ID                   string                 `json:"id"`
	Text                 string                 `json:"text"`
	RequiresConfirmation bool                   `json:"requires_confirmation"`
	Status               string                 `json:"status"`
	EvidenceRefs         []agentPlanEvidenceRef `json:"evidence_refs"`
	ConfirmedAt          *time.Time             `json:"confirmed_at,omitempty"`
}

type agentGoalView struct {
	ID              uuid.UUID            `json:"id"`
	ConversationID  uuid.UUID            `json:"conversation_id"`
	Revision        int64                `json:"revision"`
	Objective       string               `json:"objective"`
	Criteria        []agentGoalCriterion `json:"criteria"`
	Constraints     string               `json:"constraints"`
	AccountID       *uuid.UUID           `json:"account_id,omitempty"`
	ModelProviderID *uuid.UUID           `json:"model_provider_id,omitempty"`
	Model           string               `json:"model"`
	AllowBackground bool                 `json:"allow_background"`
	Status          string               `json:"status"`
	RunBudget       int                  `json:"run_budget"`
	SecondsBudget   int                  `json:"seconds_budget"`
	TokenBudget     *int                 `json:"token_budget,omitempty"`
	UsedRuns        int                  `json:"used_runs"`
	UsedSeconds     int                  `json:"used_seconds"`
	UsedTokens      int                  `json:"used_tokens"`
	NoProgressRuns  int                  `json:"no_progress_runs"`
	Blocker         string               `json:"blocker,omitempty"`
	CreatedAt       time.Time            `json:"created_at"`
	UpdatedAt       time.Time            `json:"updated_at"`
}

type agentGoalCriterionInput struct {
	Text                 string `json:"text"`
	RequiresConfirmation bool   `json:"requires_confirmation"`
}

type agentGoalMutationRequest struct {
	RequestID        string                    `json:"request_id"`
	ExpectedRevision int64                     `json:"expected_revision"`
	Objective        string                    `json:"objective"`
	Criteria         []agentGoalCriterionInput `json:"criteria"`
	Constraints      string                    `json:"constraints"`
	AccountID        string                    `json:"account_id"`
	Model            *agentModelRef            `json:"model"`
	AllowBackground  bool                      `json:"allow_background"`
	RunBudget        *int                      `json:"run_budget"`
	SecondsBudget    *int                      `json:"seconds_budget"`
	TokenBudget      json.RawMessage           `json:"token_budget"`
}

type agentGoalControlRequest struct {
	ExpectedRevision int64  `json:"expected_revision"`
	RequestID        string `json:"request_id"`
	Action           string `json:"action"`
}

type agentGoalConfirmRequest struct {
	ExpectedRevision int64  `json:"expected_revision"`
	RequestID        string `json:"request_id"`
	CriterionID      string `json:"criterion_id"`
	Confirmed        bool   `json:"confirmed"`
}

const agentGoalSelect = `SELECT id,conversation_id,revision,objective,criteria,constraints_text,account_id,
	model_provider_id,model,allow_background,status,run_budget,seconds_budget,token_budget,used_runs,
	used_seconds,used_tokens,no_progress_runs,blocker,created_at,updated_at FROM agent_goal`

func scanAgentGoal(row pgx.Row) (*agentGoalView, error) {
	var goal agentGoalView
	var criteria []byte
	var accountID, providerID *uuid.UUID
	var tokenBudget *int
	if err := row.Scan(&goal.ID, &goal.ConversationID, &goal.Revision, &goal.Objective, &criteria,
		&goal.Constraints, &accountID, &providerID, &goal.Model, &goal.AllowBackground, &goal.Status,
		&goal.RunBudget, &goal.SecondsBudget, &tokenBudget, &goal.UsedRuns, &goal.UsedSeconds,
		&goal.UsedTokens, &goal.NoProgressRuns, &goal.Blocker, &goal.CreatedAt, &goal.UpdatedAt); err != nil {
		return nil, err
	}
	goal.AccountID, goal.ModelProviderID, goal.TokenBudget = accountID, providerID, tokenBudget
	if err := json.Unmarshal(criteria, &goal.Criteria); err != nil {
		return nil, err
	}
	if goal.Criteria == nil {
		goal.Criteria = []agentGoalCriterion{}
	}
	return &goal, nil
}

func (s *Server) agentGoalForConversation(ctx context.Context, reader agentRequestReader, conversationID uuid.UUID) (*agentGoalView, error) {
	id := ident(ctx)
	goal, err := scanAgentGoal(reader.QueryRow(ctx, agentGoalSelect+` WHERE conversation_id=$1 AND workspace_id=$2 AND user_id=$3
		ORDER BY updated_at DESC,id DESC LIMIT 1`, conversationID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return goal, err
}

func (s *Server) agentGoalByID(ctx context.Context, reader agentRequestReader, goalID uuid.UUID) (*agentGoalView, error) {
	id := ident(ctx)
	goal, err := scanAgentGoal(reader.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		goalID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return goal, err
}

func agentGoalCanManage(ctx context.Context) error {
	id := ident(ctx)
	if id == nil || id.AdminOverride || (id.Role != string(roleOwner) && id.Role != string(roleEditor)) {
		return apiErr(403, "forbidden", "只有当前工作区所有者或编辑者可修改任务目标")
	}
	return nil
}

func agentGoalRequestID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, validation("请求编号无效")
	}
	return id, nil
}

func agentGoalCriteria(inputs []agentGoalCriterionInput) ([]agentGoalCriterion, error) {
	if len(inputs) < 1 || len(inputs) > 5 {
		return nil, apiErr(422, "invalid_arguments", "完成条件须为1～5项")
	}
	out := make([]agentGoalCriterion, 0, len(inputs))
	for _, input := range inputs {
		text := strings.TrimSpace(input.Text)
		if runeLen(text) == 0 || runeLen(text) > 500 {
			return nil, apiErr(422, "invalid_arguments", "每条完成条件须为1～500字")
		}
		out = append(out, agentGoalCriterion{ID: uuid.NewString(), Text: text,
			RequiresConfirmation: input.RequiresConfirmation, Status: "unverified", EvidenceRefs: []agentPlanEvidenceRef{}})
	}
	return out, nil
}

func agentGoalRequestPayload(req agentGoalMutationRequest, accountID *uuid.UUID,
	model agentModelRef, runBudget, secondsBudget int, tokenBudget *int) map[string]any {
	return map[string]any{"objective": strings.TrimSpace(req.Objective), "criteria": req.Criteria,
		"constraints": strings.TrimSpace(req.Constraints), "account_id": accountID, "model": model,
		"allow_background": req.AllowBackground, "run_budget": runBudget, "seconds_budget": secondsBudget,
		"token_budget": tokenBudget}
}

func agentGoalBudgets(req agentGoalMutationRequest, old *agentGoalView) (int, int, *int, error) {
	runs, seconds := 10, 1800
	var tokens *int
	if old != nil {
		runs, seconds, tokens = old.RunBudget, old.SecondsBudget, old.TokenBudget
	}
	if req.RunBudget != nil {
		runs = *req.RunBudget
	}
	if req.SecondsBudget != nil {
		seconds = *req.SecondsBudget
	}
	if req.TokenBudget != nil {
		if string(req.TokenBudget) == "null" {
			tokens = nil
		} else {
			var n int
			if err := json.Unmarshal(req.TokenBudget, &n); err != nil {
				return 0, 0, nil, apiErr(422, "invalid_arguments", "token_budget 必须为整数或 null")
			}
			tokens = &n
		}
	}
	if runs < 1 || runs > 10 || seconds < 60 || seconds > 1800 || tokens != nil && (*tokens < 1000 || *tokens > 100000) {
		return 0, 0, nil, apiErr(422, "invalid_arguments", "目标预算超出允许范围")
	}
	return runs, seconds, tokens, nil
}

func (s *Server) agentGoalSelection(ctx context.Context, conversationID uuid.UUID) (*agentGoalView, error) {
	goal, err := s.agentGoalForConversation(ctx, s.db, conversationID)
	if err != nil || goal == nil {
		return goal, err
	}
	if goal.Status == "completed" || goal.Status == "cancelled" {
		return nil, nil
	}
	if goal.Status != "active" {
		return nil, apiErr(409, "agent_goal_waiting_user", "当前目标已暂停或等待处理，请先在任务面板恢复")
	}
	return goal, nil
}

func (s *Server) postAgentGoal(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("goals"); err != nil {
		return err
	}
	if err := agentGoalCanManage(r.Context()); err != nil {
		return err
	}
	conversationID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conversation, err := s.agentConversationFor(r.Context(), conversationID)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conversation); err != nil {
		return err
	}
	var req agentGoalMutationRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := agentGoalRequestID(req.RequestID)
	if err != nil {
		return err
	}
	objective, constraints := strings.TrimSpace(req.Objective), strings.TrimSpace(req.Constraints)
	if runeLen(objective) == 0 || runeLen(objective) > 500 || runeLen(constraints) > 1000 {
		return apiErr(422, "invalid_arguments", "目标为1～500字，约束最多1000字")
	}
	criteria, err := agentGoalCriteria(req.Criteria)
	if err != nil {
		return err
	}
	runBudget, secondsBudget, tokenBudget, err := agentGoalBudgets(req, nil)
	if err != nil {
		return err
	}
	accountID := conversation.AccountID
	if strings.TrimSpace(req.AccountID) != "" {
		parsed, parseErr := uuid.Parse(strings.TrimSpace(req.AccountID))
		if parseErr != nil {
			return errNotFound
		}
		accountID = &parsed
	}
	if accountID == nil {
		return apiErr(422, "agent_goal_account_required", "创建任务目标前请选择一个工作区账号")
	}
	if err := s.checkAgentAccount(r.Context(), *accountID); err != nil {
		return err
	}
	selected := *conversation
	selected.AccountID = accountID
	model, err := s.agentRunModel(r.Context(), &selected)
	if req.Model != nil {
		model, err = s.resolveAgentModel(r.Context(), *req.Model)
	}
	if err != nil {
		return err
	}
	payload := agentGoalRequestPayload(req, accountID, model, runBudget, secondsBudget, tokenBudget)
	ctx := r.Context()
	id := ident(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	current, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+`
		FROM agent_conversation c WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, conversationID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if current.Revision != conversation.Revision {
		return apiErr(409, "agent_revision_conflict", "对话设置已变化，请刷新后重试")
	}
	if err := agentCheckRunLimitsWith(ctx, tx, conversationID, id.UserID); err != nil {
		return err
	}
	operation := "conversation.goal:" + conversationID.String()
	replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		goal, err := s.agentGoalByID(ctx, tx, *replayID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"goal": goal, "replayed": true})
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_goal WHERE conversation_id=$1 AND status NOT IN ('completed','cancelled'))`, conversationID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return apiErr(409, "agent_goal_exists", "本对话已有未结束目标，请编辑或先终止原目标")
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET account_id=$2,model_provider_id=$3,model=$4,
		revision=revision+1,updated_at=now() WHERE id=$1`, conversationID, accountID, model.ProviderID, model.Model); err != nil {
		return err
	}
	criteriaJSON, _ := json.Marshal(criteria)
	var goalID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO agent_goal
		(conversation_id,workspace_id,user_id,objective,criteria,constraints_text,account_id,model_provider_id,model,
		 allow_background,run_budget,seconds_budget,token_budget)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
		conversationID, id.WorkspaceID, id.UserID, objective, criteriaJSON, constraints, accountID, model.ProviderID,
		model.Model, req.AllowBackground, runBudget, secondsBudget, tokenBudget).Scan(&goalID); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, conversationID, nil, "goal.updated", map[string]any{
		"goal_id": goalID, "revision": 1, "status": "active",
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, goalID); err != nil {
		return err
	}
	goal, err := s.agentGoalByID(ctx, tx, goalID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"goal": goal, "replayed": false})
}

func (s *Server) patchAgentGoal(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("goals"); err != nil {
		return err
	}
	if err := agentGoalCanManage(r.Context()); err != nil {
		return err
	}
	conversationID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	conversation, err := s.agentConversationFor(r.Context(), conversationID)
	if err != nil {
		return err
	}
	var req agentGoalMutationRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ExpectedRevision < 1 {
		return validation("expected_revision 无效")
	}
	requestID, err := agentGoalRequestID(req.RequestID)
	if err != nil {
		return err
	}
	objective, constraints := strings.TrimSpace(req.Objective), strings.TrimSpace(req.Constraints)
	if runeLen(objective) == 0 || runeLen(objective) > 500 || runeLen(constraints) > 1000 {
		return apiErr(422, "invalid_arguments", "目标为1～500字，约束最多1000字")
	}
	criteria, err := agentGoalCriteria(req.Criteria)
	if err != nil {
		return err
	}
	currentGoal, err := s.agentGoalForConversation(r.Context(), s.db, conversationID)
	if err != nil {
		return err
	}
	if currentGoal == nil {
		return errNotFound
	}
	if currentGoal.Revision != req.ExpectedRevision {
		return apiErr(409, "agent_revision_conflict", "目标已变化，请刷新后再编辑")
	}
	runBudget, secondsBudget, tokenBudget, err := agentGoalBudgets(req, currentGoal)
	if err != nil {
		return err
	}
	accountID := currentGoal.AccountID
	if strings.TrimSpace(req.AccountID) != "" {
		parsed, parseErr := uuid.Parse(strings.TrimSpace(req.AccountID))
		if parseErr != nil {
			return errNotFound
		}
		accountID = &parsed
	}
	if accountID == nil {
		return apiErr(422, "agent_goal_account_required", "任务目标需要绑定一个工作区账号")
	}
	if err := s.checkAgentAccount(r.Context(), *accountID); err != nil {
		return err
	}
	selected := *conversation
	selected.AccountID = accountID
	model := agentModelRef{}
	if req.Model != nil {
		model, err = s.resolveAgentModel(r.Context(), *req.Model)
	} else if currentGoal.ModelProviderID != nil && currentGoal.Model != "" {
		model, err = s.resolveAgentModel(r.Context(), agentModelRef{ProviderID: *currentGoal.ModelProviderID, Model: currentGoal.Model})
	} else {
		model, err = s.agentRunModel(r.Context(), &selected)
	}
	if err != nil {
		return err
	}
	payload := agentGoalRequestPayload(req, accountID, model, runBudget, secondsBudget, tokenBudget)
	ctx := r.Context()
	id := ident(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		conversationID, id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	if err := agentCheckRunLimitsWith(ctx, tx, conversationID, id.UserID); err != nil {
		return err
	}
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE conversation_id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		conversationID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	operation := "goal.update:" + goal.ID.String()
	replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		goal, err = s.agentGoalByID(ctx, tx, *replayID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"goal": goal, "replayed": true})
	}
	if goal.Revision != req.ExpectedRevision || goal.Status == "completed" || goal.Status == "cancelled" {
		return apiErr(409, "agent_revision_conflict", "目标状态已变化，请刷新后重试")
	}
	if goal.Status == "budget_limited" && (runBudget <= goal.UsedRuns || secondsBudget <= goal.UsedSeconds || tokenBudget != nil && *tokenBudget <= goal.UsedTokens) {
		return apiErr(409, "agent_goal_budget_reached", "提高预算并确认仍有工作区用量后才可恢复")
	}
	newStatus := goal.Status
	criteriaJSON, _ := json.Marshal(criteria)
	_, err = tx.Exec(ctx, `UPDATE agent_conversation SET account_id=$2,model_provider_id=$3,model=$4,
		revision=revision+1,updated_at=now() WHERE id=$1`, conversationID, accountID, model.ProviderID, model.Model)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE agent_goal SET revision=revision+1,objective=$2,criteria=$3,constraints_text=$4,
		account_id=$5,model_provider_id=$6,model=$7,allow_background=$8,status=$9,run_budget=$10,
		seconds_budget=$11,token_budget=$12,no_progress_runs=0,blocker='',updated_at=now() WHERE id=$1`,
		goal.ID, objective, criteriaJSON, constraints, accountID, model.ProviderID, model.Model,
		req.AllowBackground, newStatus, runBudget, secondsBudget, tokenBudget)
	if err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, conversationID, nil, "goal.updated", map[string]any{
		"goal_id": goal.ID, "revision": goal.Revision + 1, "status": newStatus,
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, goal.ID); err != nil {
		return err
	}
	goal, err = s.agentGoalByID(ctx, tx, goal.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"goal": goal, "replayed": false})
}

func (s *Server) postAgentGoalControl(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("goals"); err != nil {
		return err
	}
	if err := agentGoalCanManage(r.Context()); err != nil {
		return err
	}
	goalID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var req agentGoalControlRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := agentGoalRequestID(req.RequestID)
	if err != nil {
		return err
	}
	if req.ExpectedRevision < 1 || (req.Action != "pause" && req.Action != "resume" && req.Action != "cancel") {
		return validation("目标操作或 expected_revision 无效")
	}
	ctx := r.Context()
	id := ident(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, goalID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, goal.ConversationID); err != nil {
		return err
	}
	goal, err = scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 FOR UPDATE`, goalID))
	if err != nil {
		return err
	}
	operation := "goal.control:" + goalID.String()
	replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, req)
	if err != nil {
		return err
	}
	if replayID != nil {
		goal, err = s.agentGoalByID(ctx, tx, *replayID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"goal": goal, "replayed": true})
	}
	if goal.Revision != req.ExpectedRevision {
		return apiErr(409, "agent_revision_conflict", "目标已变化，请刷新后重试")
	}
	newStatus := goal.Status
	switch req.Action {
	case "pause":
		if goal.Status == "completed" || goal.Status == "cancelled" {
			return apiErr(409, "agent_goal_state_invalid", "已结束的目标不能暂停")
		}
		newStatus = "paused"
	case "resume":
		if goal.Status != "paused" && goal.Status != "blocked" && goal.Status != "waiting_user" && goal.Status != "budget_limited" {
			return apiErr(409, "agent_goal_state_invalid", "当前目标状态不能恢复")
		}
		if goal.Status == "budget_limited" && (goal.RunBudget <= goal.UsedRuns || goal.SecondsBudget <= goal.UsedSeconds || goal.TokenBudget != nil && *goal.TokenBudget <= goal.UsedTokens) {
			return apiErr(409, "agent_goal_budget_reached", "请先提高目标预算后再恢复；预算已达硬上限时请建立新目标")
		}
		var waiting bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input','executing'))
			OR EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at>now())
			OR EXISTS(SELECT 1 FROM agent_input WHERE conversation_id=$1 AND status IN ('pending','needs_review'))`, goal.ConversationID).Scan(&waiting); err != nil {
			return err
		}
		if waiting {
			return apiErr(409, "agent_goal_waiting_user", "请先处理本对话待办，再恢复目标")
		}
		if err := s.checkLimit(ctx); err != nil {
			return err
		}
		newStatus = "active"
	case "cancel":
		if goal.Status == "completed" || goal.Status == "cancelled" {
			return apiErr(409, "agent_goal_state_invalid", "目标已结束")
		}
		newStatus = "cancelled"
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_goal SET status=$2,revision=revision+1,blocker='',no_progress_runs=0,updated_at=now() WHERE id=$1`, goalID, newStatus); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, goal.ConversationID, nil, "goal.updated", map[string]any{
		"goal_id": goalID, "revision": goal.Revision + 1, "status": newStatus,
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, goalID); err != nil {
		return err
	}
	var activeRun *uuid.UUID
	if req.Action == "pause" || req.Action == "cancel" {
		activeRun = new(uuid.UUID)
		err = tx.QueryRow(ctx, `SELECT id FROM agent_run WHERE goal_id=$1 AND status IN ('queued','running')`, goalID).Scan(activeRun)
		if errors.Is(err, pgx.ErrNoRows) {
			activeRun = nil
		} else if err != nil {
			return err
		}
	}
	var resumeState *agentRunState
	if req.Action == "resume" {
		if err := agentCheckRunLimitsWith(ctx, tx, goal.ConversationID, id.UserID); err != nil {
			return err
		}
		conversation, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, goal.ConversationID, id.WorkspaceID, id.UserID))
		if err != nil {
			return err
		}
		if goal.AccountID == nil || goal.ModelProviderID == nil || strings.TrimSpace(goal.Model) == "" {
			return apiErr(422, "agent_goal_target_changed", "任务目标的账号或模型不可用，请编辑目标")
		}
		if err := s.checkAgentAccount(ctx, *goal.AccountID); err != nil {
			return err
		}
		model, err := s.resolveAgentModel(ctx, agentModelRef{ProviderID: *goal.ModelProviderID, Model: goal.Model})
		if err != nil {
			return err
		}
		conversation.Mode = agentEffectiveMode(conversation.Mode, id.Role)
		resumeState, err = s.agentStartRunTx(ctx, tx, "goal", conversation, model, uuid.Nil, nil, nil)
		if err != nil {
			return err
		}
	}
	goal, err = s.agentGoalByID(ctx, tx, goalID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if activeRun != nil {
		s.agentCancelRun(*activeRun)
	}
	if resumeState != nil {
		if err := s.startAgentRunBackground(ctx, resumeState); err != nil {
			return err
		}
		return ok(w, map[string]any{"goal": goal, "run_id": resumeState.RunID, "replayed": false})
	}
	return ok(w, map[string]any{"goal": goal, "replayed": false})
}

func (s *Server) postAgentGoalConfirmCriterion(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("goals"); err != nil {
		return err
	}
	if err := agentGoalCanManage(r.Context()); err != nil {
		return err
	}
	goalID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var req agentGoalConfirmRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := agentGoalRequestID(req.RequestID)
	if err != nil {
		return err
	}
	criterionID, err := uuid.Parse(strings.TrimSpace(req.CriterionID))
	if err != nil || criterionID == uuid.Nil || !req.Confirmed || req.ExpectedRevision < 1 {
		return validation("人工确认参数无效")
	}
	ctx := r.Context()
	id := ident(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, goalID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, goal.ConversationID); err != nil {
		return err
	}
	goal, err = scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 FOR UPDATE`, goalID))
	if err != nil {
		return err
	}
	operation := "goal.confirm:" + goalID.String()
	replayID, err := claimAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, req)
	if err != nil {
		return err
	}
	if replayID != nil {
		goal, err = s.agentGoalByID(ctx, tx, *replayID)
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"goal": goal, "replayed": true})
	}
	if goal.Revision != req.ExpectedRevision || goal.Status == "completed" || goal.Status == "cancelled" {
		return apiErr(409, "agent_revision_conflict", "目标已变化或结束，请刷新后重试")
	}
	found := false
	for i := range goal.Criteria {
		if goal.Criteria[i].ID != criterionID.String() {
			continue
		}
		if !goal.Criteria[i].RequiresConfirmation || goal.Criteria[i].Status != "needs_confirmation" {
			return apiErr(409, "agent_goal_state_invalid", "此完成条件不需要人工确认或状态已变化")
		}
		goal.Criteria[i].Status = "confirmed"
		now := time.Now().UTC()
		goal.Criteria[i].ConfirmedAt = &now
		found = true
		break
	}
	if !found {
		return apiErr(404, "not_found", "完成条件不存在")
	}
	criteriaJSON, _ := json.Marshal(goal.Criteria)
	allComplete := true
	for _, criterion := range goal.Criteria {
		allComplete = allComplete && (criterion.Status == "verified" || criterion.Status == "confirmed")
	}
	newStatus := goal.Status
	if allComplete {
		newStatus = "completed"
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_goal SET criteria=$2,status=$3,revision=revision+1,updated_at=now() WHERE id=$1`, goalID, criteriaJSON, newStatus); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, goal.ConversationID, nil, "goal.updated", map[string]any{
		"goal_id": goalID, "revision": goal.Revision + 1, "status": newStatus,
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(ctx, tx, id.WorkspaceID, id.UserID, operation, requestID, goalID); err != nil {
		return err
	}
	goal, err = s.agentGoalByID(ctx, tx, goalID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if goal.Status == "completed" {
		s.notify(ctx, id.WorkspaceID, id.UserID, "agent_goal", "AI 对话有结果", "AI 对话有结果或需要处理",
			"/agent/c/"+goal.ConversationID.String(), "agent_goal:"+requestID.String()+":completed")
	}
	return ok(w, map[string]any{"goal": goal, "replayed": false})
}

func (s *Server) getAgentGoalList(ctx context.Context, userID, workspaceID uuid.UUID,
	conversationIDs []uuid.UUID) (map[uuid.UUID]*agentGoalView, error) {
	goals := make(map[uuid.UUID]*agentGoalView, len(conversationIDs))
	if len(conversationIDs) == 0 {
		return goals, nil
	}
	rows, err := s.db.Query(ctx, agentGoalSelect+` WHERE workspace_id=$1 AND user_id=$2 AND conversation_id=ANY($3)
		AND status NOT IN ('completed','cancelled')`, workspaceID, userID, conversationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		goal, err := scanAgentGoal(rows)
		if err != nil {
			return nil, err
		}
		goals[goal.ConversationID] = goal
	}
	return goals, rows.Err()
}

func (s *Server) agentGoalConversationFor(ctx context.Context, goalID uuid.UUID) (uuid.UUID, error) {
	var conversationID uuid.UUID
	id := ident(ctx)
	err := s.db.QueryRow(ctx, `SELECT conversation_id FROM agent_goal WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		goalID, id.WorkspaceID, id.UserID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errNotFound
	}
	return conversationID, err
}

type agentGoalProgressItem struct {
	ID           string                 `json:"id"`
	Result       string                 `json:"result"`
	EvidenceRefs []agentPlanEvidenceRef `json:"evidence_refs"`
}

func (s *Server) agentMetaReportGoalProgress(ctx context.Context, st *agentRunState, call ai.ToolCall,
	args map[string]any) ([]byte, string, error) {
	if st.GoalID == nil || st.ExecutionOrigin != "goal" {
		return nil, "", apiErr(403, "forbidden", "当前运行没有可报告的任务目标")
	}
	var req struct {
		GoalID           uuid.UUID               `json:"goal_id"`
		ExpectedRevision int64                   `json:"expected_revision"`
		Criteria         []agentGoalProgressItem `json:"criteria"`
		Blocker          string                  `json:"blocker"`
	}
	if err := agentDecodeToolArgument(args, "goal_id", &req.GoalID); err != nil {
		return nil, "", err
	}
	if err := agentDecodeToolArgument(args, "expected_revision", &req.ExpectedRevision); err != nil {
		return nil, "", err
	}
	if err := agentDecodeToolArgument(args, "criteria", &req.Criteria); err != nil {
		return nil, "", err
	}
	if raw, exists := args["blocker"]; exists {
		if err := agentDecodeToolArgument(args, "blocker", &req.Blocker); err != nil {
			return nil, "", err
		}
		_ = raw
	}
	if req.GoalID != *st.GoalID || req.ExpectedRevision < 1 || len(req.Criteria) < 1 || len(req.Criteria) > 5 || runeLen(req.Blocker) > 500 {
		return nil, "", apiErr(422, "invalid_arguments", "任务目标进度参数无效")
	}
	seen := map[string]bool{}
	for i := range req.Criteria {
		item := &req.Criteria[i]
		item.ID = strings.TrimSpace(item.ID)
		if _, err := uuid.Parse(item.ID); err != nil || seen[item.ID] || (item.Result != "met" && item.Result != "unmet" && item.Result != "unverifiable") {
			return nil, "", apiErr(422, "invalid_arguments", "完成条件编号重复或结果无效")
		}
		seen[item.ID] = true
		if len(item.EvidenceRefs) > 10 {
			return nil, "", apiErr(422, "invalid_arguments", "每条完成条件最多关联10项证据")
		}
		if item.Result == "met" && len(item.EvidenceRefs) == 0 {
			return nil, "", apiErr(422, "agent_plan_evidence_required", "报告完成必须提供可核验的证据")
		}
	}
	requestID := uuid.NewSHA1(st.RunID, []byte(call.ID))
	if requestID == uuid.Nil {
		return nil, "", apiErr(422, "invalid_arguments", "工具调用编号无效")
	}
	ctx = context.WithoutCancel(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return nil, "", err
	}
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND user_id=$4 FOR UPDATE`,
		req.GoalID, st.ConversationID, st.WorkspaceID, st.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", errNotFound
	}
	if err != nil {
		return nil, "", err
	}
	operation := "goal.progress:" + goal.ID.String()
	payload := map[string]any{"goal_id": req.GoalID, "expected_revision": req.ExpectedRevision,
		"criteria": req.Criteria, "blocker": req.Blocker}
	replayID, err := claimAgentRequest(ctx, tx, st.WorkspaceID, st.UserID, operation, requestID, payload)
	if err != nil {
		return nil, "", err
	}
	if replayID != nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, "", err
		}
		body, _ := json.Marshal(map[string]any{"ok": true, "goal": goal, "replayed": true})
		return body, "任务进度已核对", nil
	}
	if goal.Revision != req.ExpectedRevision || goal.Status != "active" {
		return nil, "", apiErr(409, "agent_revision_conflict", "目标版本或状态已变化，请稍后重试")
	}
	byID := make(map[string]int, len(goal.Criteria))
	for i := range goal.Criteria {
		byID[goal.Criteria[i].ID] = i
	}
	refs := []agentPlanEvidenceRef{}
	for _, item := range req.Criteria {
		if _, exists := byID[item.ID]; !exists {
			return nil, "", apiErr(422, "invalid_arguments", "完成条件不属于当前目标")
		}
		refs = append(refs, item.EvidenceRefs...)
	}
	if err := agentValidatePlanEvidence(ctx, tx, st.ConversationID, refs); err != nil {
		return nil, "", err
	}
	changed := false
	for _, item := range req.Criteria {
		criterion := &goal.Criteria[byID[item.ID]]
		status := "unverified"
		switch item.Result {
		case "met":
			status = "verified"
			if criterion.RequiresConfirmation {
				status = "needs_confirmation"
			}
		case "unverifiable":
			status = "unverifiable"
		}
		before, _ := json.Marshal([]any{criterion.Status, criterion.EvidenceRefs})
		criterion.Status, criterion.EvidenceRefs = status, item.EvidenceRefs
		after, _ := json.Marshal([]any{criterion.Status, criterion.EvidenceRefs})
		changed = changed || !bytes.Equal(before, after)
	}
	blocker := truncate(strings.TrimSpace(req.Blocker), 500)
	changed = changed || blocker != goal.Blocker
	goal.Blocker = blocker
	criteriaJSON, _ := json.Marshal(goal.Criteria)
	allComplete := true
	for _, criterion := range goal.Criteria {
		allComplete = allComplete && (criterion.Status == "verified" || criterion.Status == "confirmed")
	}
	newStatus := goal.Status
	if allComplete {
		newStatus = "completed"
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_goal SET criteria=$2,blocker=$3,status=$4,revision=revision+1,
		progress_run_id=CASE WHEN $5 THEN $6 ELSE progress_run_id END,updated_at=now() WHERE id=$1`,
		goal.ID, criteriaJSON, blocker, newStatus, changed, st.RunID); err != nil {
		return nil, "", err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "goal.updated", map[string]any{
		"goal_id": goal.ID, "revision": goal.Revision + 1, "status": newStatus,
	}, nil); err != nil {
		return nil, "", err
	}
	if err := completeAgentRequest(ctx, tx, st.WorkspaceID, st.UserID, operation, requestID, goal.ID); err != nil {
		return nil, "", err
	}
	goal, err = s.agentGoalByID(ctx, tx, goal.ID)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	body, _ := json.Marshal(map[string]any{"ok": true, "goal": goal})
	return body, "任务进度已核对", nil
}

func (s *Server) agentGoalBoundary(ctx context.Context, st *agentRunState) error {
	if st.GoalID == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var status string
	var secondsBudget int
	var tokenBudget *int
	err := s.db.QueryRow(ctx, `SELECT status,seconds_budget,token_budget FROM agent_goal
		WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND user_id=$4`,
		*st.GoalID, st.ConversationID, st.WorkspaceID, st.UserID).Scan(&status, &secondsBudget, &tokenBudget)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return errAgentGoalPaused
	}
	usedSeconds := st.GoalUsedSeconds + int(time.Since(st.StartedAt).Seconds())
	if usedSeconds >= secondsBudget || tokenBudget != nil && st.GoalUsedTokens+st.PromptTokens+st.CompletionTokens >= *tokenBudget {
		return errAgentGoalBudgetReached
	}
	return nil
}

func (s *Server) finishAgentGoalTx(ctx context.Context, tx pgx.Tx, st *agentRunState, runStatus, reason string) (string, error) {
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND conversation_id=$2 FOR UPDATE`, *st.GoalID, st.ConversationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	if err != nil {
		return "", err
	}
	var progressRun *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT progress_run_id FROM agent_goal WHERE id=$1`, goal.ID).Scan(&progressRun); err != nil {
		return "", err
	}
	seconds := int(time.Since(st.StartedAt).Seconds())
	if seconds < 0 {
		seconds = 0
	}
	tokens := st.PromptTokens + st.CompletionTokens
	goal.UsedSeconds += seconds
	goal.UsedTokens += tokens
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input','executing'))
		OR EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at>now())
		OR EXISTS(SELECT 1 FROM agent_input WHERE conversation_id=$1 AND status IN ('pending','needs_review'))`, st.ConversationID).Scan(&pending); err != nil {
		return "", err
	}
	allComplete := true
	for _, criterion := range goal.Criteria {
		allComplete = allComplete && (criterion.Status == "verified" || criterion.Status == "confirmed")
	}
	newStatus, blocker, noProgress, notice := goal.Status, goal.Blocker, goal.NoProgressRuns, ""
	if goal.Status == "active" || goal.Status == "waiting_user" {
		switch {
		case pending || runStatus == "awaiting_input" || runStatus == "awaiting_confirmation":
			newStatus, notice = "waiting_user", "needs_user"
		case runStatus == "stopped":
			newStatus = "paused"
		case runStatus == "failed":
			newStatus, blocker, notice = "blocked", "本次运行失败，请检查会话后再恢复", "blocked"
		case allComplete:
			newStatus, blocker, notice = "completed", "", "completed"
		case reason == "goal_budget" || goal.UsedRuns >= goal.RunBudget || goal.UsedSeconds >= goal.SecondsBudget || goal.TokenBudget != nil && goal.UsedTokens >= *goal.TokenBudget:
			newStatus, notice = "budget_limited", "budget_limited"
		default:
			if progressRun != nil && *progressRun == st.RunID {
				noProgress = 0
			} else if runStatus == "completed" {
				noProgress++
			}
			if noProgress >= 2 {
				newStatus, blocker, notice = "blocked", "连续两次运行没有产生新的完成证据", "blocked"
			}
		}
	}
	if goal.Status == "completed" {
		notice = "completed"
	}
	if goal.Status == "paused" || goal.Status == "blocked" || goal.Status == "budget_limited" || goal.Status == "cancelled" || goal.Status == "completed" {
		newStatus = goal.Status
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_goal SET status=$2,blocker=$3,used_seconds=used_seconds+$4,
		used_tokens=used_tokens+$5,no_progress_runs=$6,progress_run_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,
		goal.ID, newStatus, blocker, seconds, tokens, noProgress); err != nil {
		return "", err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "goal.updated", map[string]any{
		"goal_id": goal.ID, "revision": goal.Revision + 1, "status": newStatus, "used_runs": goal.UsedRuns,
		"used_seconds": goal.UsedSeconds, "used_tokens": goal.UsedTokens, "no_progress_runs": noProgress,
	}, nil); err != nil {
		return "", err
	}
	return notice, nil
}

func (s *Server) agentContinueGoalBackground(ctx context.Context, conversationID, goalID uuid.UUID) error {
	_, err := s.agentStartGoalRun(ctx, conversationID, goalID, true)
	return err
}

func (s *Server) agentStartGoalRun(ctx context.Context, conversationID, goalID uuid.UUID, backgroundOnly bool) (*agentRunState, error) {
	if !agentWorkbenchFeatures()["goals"] {
		return nil, errAgentGoalNoContinuation
	}
	id := ident(ctx)
	if id == nil || id.Role == string(roleViewer) || id.AdminOverride {
		return nil, apiErr(403, "forbidden", "当前身份不能继续此任务目标")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return nil, err
	}
	conv, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
		WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, conversationID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAgentGoalNoContinuation
	}
	if err != nil {
		return nil, err
	}
	goal, err := scanAgentGoal(tx.QueryRow(ctx, agentGoalSelect+` WHERE id=$1 AND conversation_id=$2 AND workspace_id=$3 AND user_id=$4 FOR UPDATE`,
		goalID, conversationID, id.WorkspaceID, id.UserID))
	if err != nil {
		return nil, err
	}
	if goal.Status != "active" || backgroundOnly && !goal.AllowBackground || conv.ArchivedAt != nil {
		return nil, errAgentGoalNoContinuation
	}
	if err := agentCheckRunLimitsWith(ctx, tx, conversationID, id.UserID); err != nil {
		if backgroundOnly {
			return nil, errAgentGoalNoContinuation
		}
		return nil, err
	}
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_action WHERE conversation_id=$1 AND status IN ('pending','needs_input','executing'))
		OR EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at>now())
		OR EXISTS(SELECT 1 FROM agent_input WHERE conversation_id=$1 AND status IN ('pending','needs_review'))`, conversationID).Scan(&pending); err != nil {
		return nil, err
	}
	if pending || goal.UsedRuns >= goal.RunBudget || goal.UsedSeconds >= goal.SecondsBudget || goal.TokenBudget != nil && goal.UsedTokens >= *goal.TokenBudget {
		if backgroundOnly {
			return nil, errAgentGoalNoContinuation
		}
		return nil, apiErr(409, "agent_goal_waiting_user", "任务仍有待处理事项或已达到预算")
	}
	if goal.AccountID == nil {
		return nil, apiErr(422, "agent_goal_account_required", "任务目标账号不可用")
	}
	if err := s.checkAgentAccount(ctx, *goal.AccountID); err != nil {
		return nil, err
	}
	conv.AccountID, conv.ModelProviderID, conv.Model = goal.AccountID, goal.ModelProviderID, goal.Model
	conv.Mode = agentEffectiveMode(conv.Mode, id.Role)
	model, err := s.agentRunModel(ctx, conv)
	if err != nil {
		return nil, err
	}
	if err := s.checkLimit(ctx); err != nil {
		return nil, err
	}
	if err := s.checkAgentAccount(ctx, *goal.AccountID); err != nil {
		return nil, err
	}
	st, err := s.agentStartRunTx(ctx, tx, "goal", conv, model, uuid.Nil, nil, nil)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if err := s.startAgentRunBackground(ctx, st); err != nil {
		return nil, err
	}
	return st, nil
}
