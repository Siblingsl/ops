package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func agentEffectiveMode(mode, role string) string {
	if role == "viewer" {
		return "discuss"
	}
	if mode == "" {
		return "execute"
	}
	return mode
}

func agentValidateModeRequest(ctx context.Context, mode *string) error {
	if mode == nil {
		return nil
	}
	if err := requireAgentFeature("plans"); err != nil {
		return err
	}
	*mode = strings.TrimSpace(*mode)
	if *mode != "discuss" && *mode != "plan" && *mode != "execute" {
		return validation("模式必须为讨论、计划或执行")
	}
	if ident(ctx).Role == "viewer" && *mode != "discuss" {
		return apiErr(403, "forbidden", "观察者仅可使用讨论模式")
	}
	return nil
}

// 只读模式的建议由agent_chat生成，不调用可能产生业务副作用的G工具。
// 来源值仅由服务端设置；尚未实现的后台来源一律不可调用。
func agentRunToolAllowed(st *agentRunState, tool *AgentTool, id *identity) bool {
	if !agentToolVisible(tool, id) {
		return false
	}
	if st.ExecutionOrigin != "" && st.ExecutionOrigin != "interactive" && st.ExecutionOrigin != "goal" {
		return false
	}
	if st.ExecutionOrigin == "goal" && st.GoalID == nil {
		return false
	}
	mode := agentEffectiveMode(st.Mode, id.Role)
	switch tool.Name {
	case "present_plan":
		if mode != "plan" {
			return false
		}
	case "update_plan_step":
		if mode == "discuss" {
			return false
		}
	}
	if mode != "execute" {
		return (mode == "discuss" || mode == "plan") && tool.Kind == toolR
	}
	return true
}

type agentRuntimeModel struct {
	ProviderID   uuid.UUID `json:"provider_id"`
	ProviderName string    `json:"provider_name,omitempty"`
	Model        string    `json:"model"`
	Channel      string    `json:"channel"`
}

type agentRunConfigSnapshot struct {
	Version         int                     `json:"version"`
	UserID          uuid.UUID               `json:"user_id"`
	WorkspaceID     uuid.UUID               `json:"workspace_id"`
	Role            string                  `json:"role"`
	AccountID       *uuid.UUID              `json:"account_id"`
	Mode            string                  `json:"mode"`
	ExecutionOrigin string                  `json:"execution_origin"`
	SelectedModel   agentModelRef           `json:"selected_model"`
	ActualModel     *agentRuntimeModel      `json:"actual_model,omitempty"`
	ContextRefs     []agentContextReference `json:"context_refs"`
	SkillRequests   []agentSkillRequest     `json:"skill_requests"`
}

func agentInitialRunConfig(ctx context.Context, tx pgx.Tx, st *agentRunState) (*agentRunConfigSnapshot, error) {
	snapshot := &agentRunConfigSnapshot{Version: 1, UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: ident(ctx).Role,
		AccountID: st.AccountID, Mode: st.Mode, ExecutionOrigin: st.ExecutionOrigin, SelectedModel: st.Model,
		ContextRefs: []agentContextReference{}, SkillRequests: []agentSkillRequest{}}
	var fixed, refs, skills []byte
	if err := tx.QueryRow(ctx, `SELECT fixed_context_refs FROM agent_conversation WHERE id=$1`, st.ConversationID).Scan(&fixed); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(fixed, &snapshot.ContextRefs); err != nil {
		return nil, err
	}
	err := tx.QueryRow(ctx, `SELECT context_refs,skill_requests FROM agent_message WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, st.ConversationID).Scan(&refs, &skills)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if len(refs) > 0 {
		var messageRefs []agentContextReference
		if err := json.Unmarshal(refs, &messageRefs); err != nil {
			return nil, err
		}
		snapshot.ContextRefs = append(snapshot.ContextRefs, messageRefs...)
	}
	if len(skills) > 0 {
		if err := json.Unmarshal(skills, &snapshot.SkillRequests); err != nil {
			return nil, err
		}
	}
	// 快照只保存资格/版本定位，不复制对象名称、资料内容或个人技能正文。
	for i := range snapshot.ContextRefs {
		snapshot.ContextRefs[i].Name = ""
	}
	for i := range snapshot.SkillRequests {
		snapshot.SkillRequests[i].Name = ""
	}
	return snapshot, nil
}

func (s *Server) agentRecordRuntimeConfig(ctx context.Context, st *agentRunState, rt *route) error {
	channel := "server"
	if rt.Desktop != nil {
		channel = "desktop"
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return err
	}
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT config_snapshot FROM agent_run WHERE id=$1`, st.RunID).Scan(&raw); err != nil {
		return err
	}
	var snapshot agentRunConfigSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	snapshot.ActualModel = &agentRuntimeModel{ProviderID: rt.ProviderID, ProviderName: rt.ProviderName, Model: rt.Model, Channel: channel}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_run SET config_snapshot=$2 WHERE id=$1`, st.RunID, data); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "context.updated", map[string]any{"run_id": st.RunID, "actual_model": snapshot.ActualModel}, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	st.RuntimeModel = snapshot.ActualModel
	return nil
}
