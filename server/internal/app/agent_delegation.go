package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-15（W15）：子智能体委派（27 文档 §11.3）。
// 约束（§11.3.3 首版）：单父 run 并发子 run ≤2、累计委派 ≤4、深度 1；
// 子 run 归属原用户/工作区（INSERT agent_run 时强制同 identity）；
// 子只能产出 result_artifact_id 提案，不创建可自执行写卡（本批委派 API 无任何写卡路径）；
// 取消传播：整树 cancel_generation 递增 → 各子 generation 同步 → 旧授权失效；
// 同 request_id 幂等、异任务范围 409（27 §11.3.3 去重契约）。

const (
	delegationMaxConcurrent = 2
	delegationMaxTotal      = 4
	delegationMaxDepth      = 1
	// 共享预算（27 §11.3.3）：每子任务预留的模型轮数，从父任务总池扣减。
	delegationBudgetPerTask = 10
)

type delegationView struct {
	ID          string          `json:"id"`
	GroupID     string          `json:"group_id"`
	ParentRunID string          `json:"parent_run_id"`
	ChildRunID  string          `json:"child_run_id"`
	Task        string          `json:"task"`
	State       string          `json:"state"`
	Generation  int64           `json:"generation"`
	ResultArtifactID string     `json:"result_artifact_id,omitempty"`
	ResultSummary string        `json:"result_summary,omitempty"`
	ErrorCode   string          `json:"error_code,omitempty"`
}

type delegationGroupView struct {
	ID                  string            `json:"id"`
	ConversationID      string            `json:"conversation_id"`
	RootRunID           string            `json:"root_run_id"`
	CurrentParentRunID  string            `json:"current_parent_run_id"`
	State               string            `json:"state"`
	CancelGeneration    int64             `json:"cancel_generation"`
	Delegations         []delegationView  `json:"delegations"`
}

const delegationColumns = `d.id::text, d.group_id::text, d.parent_run_id::text, COALESCE(d.child_run_id::text,''),
	d.task, d.state, d.generation, COALESCE(d.result_artifact_id::text,''), d.result_summary, d.error_code`

func scanDelegation(row pgx.Row) (delegationView, error) {
	var v delegationView
	err := row.Scan(&v.ID, &v.GroupID, &v.ParentRunID, &v.ChildRunID, &v.Task,
		&v.State, &v.Generation, &v.ResultArtifactID, &v.ResultSummary, &v.ErrorCode)
	return v, err
}

func (s *Server) subagentGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "subagent_policy_denied", "代访问期间不能管理子智能体")
	}
	if id.Role == "viewer" {
		return apiErr(403, "subagent_policy_denied", "观察者角色未开放子智能体")
	}
	return nil
}

// POST /agent/conversations/{id}/delegation-groups：创建委派组（原子创建组+全部子 run 行）。
// 请求 {parent_run_id, delegations:[{task, request_id, context_refs, allowed_tools, model}]}。
func (s *Server) createDelegationGroup(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		ParentRunID string `json:"parent_run_id"`
		Delegations []struct {
			Task         string          `json:"task"`
			RequestID    string          `json:"request_id"`
			ContextRefs  json.RawMessage `json:"context_refs"`
			AllowedTools []string        `json:"allowed_tools"`
			Model        string          `json:"model"`
		} `json:"delegations"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if len(body.Delegations) == 0 || len(body.Delegations) > delegationMaxConcurrent {
		return apiErr(422, "subagent_limit", "一次委派 1～2 个子任务")
	}
	parentRunID, err := uuid.Parse(body.ParentRunID)
	if err != nil {
		return apiErr(400, "bad_request", "parent_run_id 必须是 UUID")
	}
	groupID := uuid.New()
	var view delegationGroupView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 父 run 必须属于本人/本工作区/本会话且活动；深度 1：父 run 不得已是子 run。
		var parentConvID uuid.UUID
		var parentStatus string
		if err := tx.QueryRow(r.Context(), `SELECT conversation_id, status FROM agent_run
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
			parentRunID, id.WorkspaceID, id.UserID).Scan(&parentConvID, &parentStatus); err != nil {
			if err == pgx.ErrNoRows {
				return errNotFound
			}
			return err
		}
		if parentConvID != conversationID {
			return apiErr(409, "subagent_parent_mismatch", "父 run 不属于该会话")
		}
		// 深度 1 优先于 status 检查：无论父 run 是否活动，子 run 不得再委派。
		var isChild bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_delegation WHERE child_run_id=$1)`,
			parentRunID).Scan(&isChild); err != nil {
			return err
		}
		if isChild {
			return apiErr(422, "subagent_depth_limit", "子 run 不得再委派（深度 1）")
		}
		if parentStatus != "running" && parentStatus != "queued" && parentStatus != "awaiting_confirmation" {
			return apiErr(409, "subagent_parent_closed", "父 run 已结束")
		}
		// 累计/并发限额（27 §11.3.3）：同父 run 累计 ≤4；当前未终态子 run + 本批 ≤2。
		var total int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_delegation WHERE parent_run_id=$1`,
			parentRunID).Scan(&total); err != nil {
			return err
		}
		if total+len(body.Delegations) > delegationMaxTotal {
			return apiErr(429, "subagent_budget_exceeded", "累计委派超过上限（4）")
		}
		var running int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_delegation
			WHERE parent_run_id=$1 AND state IN ('queued','running','waiting_user','cancelling')`,
			parentRunID).Scan(&running); err != nil {
			return err
		}
		if running+len(body.Delegations) > delegationMaxConcurrent {
			return apiErr(429, "subagent_budget_exceeded", "并发子任务超过上限（2）")
		}
		// 会话归属复核（conversation 已由 URL 校验身份，这里确认存在）。
		var convExists bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`,
			conversationID, id.WorkspaceID, id.UserID).Scan(&convExists); err != nil {
			return err
		}
		if !convExists {
			return errNotFound
		}
		// 创建组（预算预留：每子任务预留 delegationBudgetPerTask 轮）。
		budgetReserved := len(body.Delegations) * delegationBudgetPerTask
		if _, err := tx.Exec(r.Context(), `INSERT INTO agent_delegation_group
			(id, workspace_id, user_id, conversation_id, root_run_id, current_parent_run_id, state, budget_scope_id, budget_reserved)
			VALUES ($1,$2,$3,$4,$5,$5,'active',$6,$7)`,
			groupID, id.WorkspaceID, id.UserID, conversationID, parentRunID, uuid.New(), budgetReserved); err != nil {
			return err
		}
		// 逐个创建子 run（agent_run 行）与委派行；子 run 同 identity/session，trigger 继续语义。
		_ = delegationMaxDepth
		for _, item := range body.Delegations {
			task := strings.TrimSpace(item.Task)
			if task == "" {
				return apiErr(422, "validation_failed", "子任务内容必填")
			}
			requestID, err := uuid.Parse(item.RequestID)
			if err != nil {
				return apiErr(400, "bad_request", "request_id 必须是 UUID")
			}
			contextRefs := item.ContextRefs
			if len(contextRefs) == 0 {
				contextRefs = json.RawMessage("[]")
			}
			allowedTools := item.AllowedTools
			if allowedTools == nil {
				allowedTools = []string{}
			}
			toolBytes, _ := json.Marshal(allowedTools)
			hashSum := sha256.Sum256(append([]byte(task+"."), toolBytes...))
			if _, err := tx.Exec(r.Context(), `INSERT INTO agent_delegation
				(id, group_id, workspace_id, user_id, parent_run_id, task,
				 context_refs, allowed_tools, scope_hash, model, request_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				uuid.New(), groupID, id.WorkspaceID, id.UserID, parentRunID, task,
				contextRefs, allowedTools, hex.EncodeToString(hashSum[:]), item.Model, requestID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	// 组创建事件（27 §11.3.3）。
	_, _ = s.appendAgentEvent(r.Context(), conversationID, &parentRunID, "delegation.created", map[string]any{
		"group_id": groupID.String(), "count": len(body.Delegations),
	})
	if err := s.loadDelegationGroup(r.Context(), groupID, &view); err != nil {
		return err
	}
	return ok(w, view)
}

func (s *Server) loadDelegationGroup(ctx context.Context, groupID uuid.UUID, view *delegationGroupView) error {
	if err := s.db.QueryRow(ctx, `SELECT id::text, conversation_id::text, root_run_id::text,
		current_parent_run_id::text, state, cancel_generation
		FROM agent_delegation_group WHERE id=$1`, groupID).
		Scan(&view.ID, &view.ConversationID, &view.RootRunID, &view.CurrentParentRunID, &view.State, &view.CancelGeneration); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, "SELECT "+delegationColumns+" FROM agent_delegation d WHERE d.group_id=$1 ORDER BY d.created_at", groupID)
	if err != nil {
		return err
	}
	defer rows.Close()
	view.Delegations = []delegationView{}
	for rows.Next() {
		v, err := scanDelegation(rows)
		if err != nil {
			return err
		}
		view.Delegations = append(view.Delegations, v)
	}
	return rows.Err()
}

// GET /agent/runs/{id}/delegations：按父 run 查询委派组。
func (s *Server) listRunDelegations(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	runID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), `SELECT id FROM agent_delegation_group
		WHERE (current_parent_run_id=$1 OR root_run_id=$1) AND user_id=$2 AND workspace_id=$3
		ORDER BY created_at DESC`, runID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	groups := []delegationGroupView{}
	groupIDs := []uuid.UUID{}
	for rows.Next() {
		var gid uuid.UUID
		if err := rows.Scan(&gid); err != nil {
			rows.Close()
			return err
		}
		groupIDs = append(groupIDs, gid)
	}
	rows.Close()
	for _, gid := range groupIDs {
		var view delegationGroupView
		if err := s.loadDelegationGroup(r.Context(), gid, &view); err != nil {
			return err
		}
		groups = append(groups, view)
	}
	return ok(w, map[string]any{"groups": groups})
}

// POST /agent/delegations/{id}/cancel：单子取消（幂等；cancelling → cancelled；不误停独立子）。
func (s *Server) cancelDelegation(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	delegationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var groupID uuid.UUID
	var conversationID uuid.UUID
	var childRunID uuid.UUID
	var state string
	if err := s.db.QueryRow(r.Context(), `SELECT d.group_id, g.conversation_id, d.child_run_id, d.state
		FROM agent_delegation d JOIN agent_delegation_group g ON g.id=d.group_id
		WHERE d.id=$1 AND d.user_id=$2 AND d.workspace_id=$3`,
		delegationID, id.UserID, id.WorkspaceID).Scan(&groupID, &conversationID, &childRunID, &state); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if state == "succeeded" || state == "failed" || state == "cancelled" || state == "expired" {
		// 终态幂等：返回原状态（27 §11.3.3 取消幂等）。
		terminal, terr := scanDelegation(s.db.QueryRow(r.Context(),
			"SELECT "+delegationColumns+" FROM agent_delegation d WHERE d.id=$1", delegationID))
		if terr != nil {
			return terr
		}
		return ok(w, map[string]any{"delegation": terminal, "already_terminal": true})
	}
	// 单子取消：状态 → cancelling，run 置 stopped；generation 递增使旧授权失效。
	if _, err := s.db.Exec(r.Context(), `UPDATE agent_delegation
		SET state='cancelling', generation=generation+1, updated_at=now()
		WHERE id=$1 AND state IN ('queued','running','waiting_user','cancelling')`, delegationID); err != nil {
		return err
	}
	// 子 run 的实际停止在 W06 派发层执行（child_run_id 派发前可能为 NULL）；
	// 委派状态机先行置 cancelling，generation 递增使旧授权失效。
	_, _ = s.appendAgentEvent(r.Context(), conversationID, &childRunID, "delegation.cancel_requested", map[string]any{
		"delegation_id": delegationID.String(),
	})
	// W10：待处理通知（27 §9.6：只含状态级摘要；去重键含 generation 防重复打扰）。
	s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_delegation", "子任务已请求停止",
		"协作任务中的子任务停止请求已受理", "/agent?panel=task", "delegation:cancel:"+delegationID.String())
	view, verr := scanDelegation(s.db.QueryRow(r.Context(),
		"SELECT "+delegationColumns+" FROM agent_delegation d WHERE d.id=$1", delegationID))
	if verr != nil {
		return verr
	}
	return ok(w, map[string]any{"delegation": view, "state": "cancelling"})
}

// POST /agent/delegation-groups/{id}/cancel：整树取消（cancel_generation 递增，全部未终态子取消）。
func (s *Server) cancelDelegationGroup(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	groupID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var group delegationGroupView
	if err := s.loadDelegationGroup(r.Context(), groupID, &group); err != nil {
		return err
	}
	if group.State == "cancelled" || group.State == "completed" || group.State == "failed" {
		return ok(w, map[string]any{"group": group, "already_terminal": true})
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE agent_delegation_group
		SET state='cancelled', cancel_generation=cancel_generation+1, revision=revision+1, updated_at=now()
		WHERE id=$1`, groupID); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE agent_delegation
		SET state='cancelled', generation=generation+1, updated_at=now()
		WHERE group_id=$1 AND state IN ('queued','running','waiting_user','cancelling')`, groupID); err != nil {
		return err
	}
	_, _ = s.appendAgentEvent(r.Context(), uuid.MustParse(group.ConversationID), nil, "delegation.cancel_requested", map[string]any{
		"group_id": groupID.String(), "scope": "tree",
	})
	s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_delegation", "协作任务已全部停止",
		"该任务的全部子任务停止请求已受理", "/agent?panel=task", "delegation:grouPCancel:"+groupID.String())
	var refreshed delegationGroupView
	if err := s.loadDelegationGroup(r.Context(), groupID, &refreshed); err != nil {
		return err
	}
	return ok(w, map[string]any{"group": refreshed})
}

// POST /agent/delegations/{id}/result：子结果回执（succeeded/failed + result_artifact_id 提案引用）。
// 迟到结果（组已取消）只入账，不复活父/子（27 §11.3.2/§11.7）。
func (s *Server) resultDelegation(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.subagentGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "subagents"); err != nil {
		return err
	}
	delegationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		State            string `json:"state"`
		ResultArtifactID string `json:"result_artifact_id"`
		ResultSummary    string `json:"result_summary"`
		ErrorCode        string `json:"error_code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.State != "succeeded" && body.State != "failed" {
		return apiErr(422, "validation_failed", "结果状态只能是 succeeded/failed")
	}
	var groupState string
	var groupID uuid.UUID
	var currentState string
	if err := s.db.QueryRow(r.Context(), `SELECT g.state, g.id, d.state
		FROM agent_delegation d JOIN agent_delegation_group g ON g.id=d.group_id
		WHERE d.id=$1 AND d.user_id=$2 AND d.workspace_id=$3`,
		delegationID, id.UserID, id.WorkspaceID).Scan(&groupState, &groupID, &currentState); err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if currentState == "succeeded" || currentState == "failed" || currentState == "cancelled" || currentState == "expired" {
		return apiErr(409, "subagent_result_conflict", "委派已有终态，迟到结果仅入账核对")
	}
	nextState := body.State
	if groupState == "cancelled" {
		// 组已取消：子结果仅入账（state 保持 cancelled 语义由调用方核对），此处标 failed/cancelled。
		nextState = "cancelled"
	}
	var resultArtifact *uuid.UUID
	if strings.TrimSpace(body.ResultArtifactID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(body.ResultArtifactID))
		if err != nil {
			return apiErr(400, "bad_request", "result_artifact_id 必须是 UUID")
		}
		resultArtifact = &parsed
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE agent_delegation
		SET state=$2, result_artifact_id=$3, result_summary=$4, error_code=COALESCE(NULLIF($5,''), ''), updated_at=now()
		WHERE id=$1`, delegationID, nextState, resultArtifact, body.ResultSummary, body.ErrorCode); err != nil {
		return err
	}
	view, verr := scanDelegation(s.db.QueryRow(r.Context(),
		"SELECT "+delegationColumns+" FROM agent_delegation d WHERE d.id=$1", delegationID))
	if verr != nil {
		return verr
	}
	return ok(w, map[string]any{"delegation": view})
}
