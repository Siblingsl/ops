package app

import (
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

// REF41 A3：能力缺口台账。智能体在缺少完成用户请求所需能力时调用
// report_capability_gap 记录；同 workspace+gap_key 只累加 request_count。
// 记录是本地元工具，不生成 agent_action 卡片，也不进入普通对话的写入确认流。
// 列表与状态修改只有工作区所有者可见/可操作。

type agentCapabilityGap struct {
	ID           uuid.UUID  `json:"id"`
	WorkspaceID  uuid.UUID  `json:"workspace_id"`
	RequestedBy  *uuid.UUID `json:"requested_by"`
	RunID        *uuid.UUID `json:"run_id"`
	GapKey       string     `json:"gap_key"`
	Title        string     `json:"title"`
	Detail       string     `json:"detail"`
	RequestCount int        `json:"request_count"`
	Status       string     `json:"status"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

type agentCapabilityGapInput struct {
	GapKey     string `json:"gap_key"`
	Title      string `json:"title"`
	Detail     string `json:"detail"`
	Need       string `json:"need"`
	Workaround string `json:"workaround"`
}

func (in *agentCapabilityGapInput) normalize() (string, error) {
	in.GapKey = strings.TrimSpace(in.GapKey)
	in.Title = strings.TrimSpace(in.Title)
	in.Detail = strings.TrimSpace(in.Detail)
	in.Need = strings.TrimSpace(in.Need)
	in.Workaround = strings.TrimSpace(in.Workaround)
	if n := runeLen(in.GapKey); n < 3 || n > 80 {
		return "gap_key", validation("gap_key 需为 3–80 个字符")
	}
	if n := runeLen(in.Title); n < 1 || n > 120 {
		return "title", validation("title 需为 1–120 个字符")
	}
	parts := make([]string, 0, 3)
	if in.Detail != "" {
		parts = append(parts, in.Detail)
	}
	if in.Need != "" {
		parts = append(parts, "需要："+in.Need)
	}
	if in.Workaround != "" {
		parts = append(parts, "替代方案："+in.Workaround)
	}
	in.Detail = strings.Join(parts, "\n")
	if runeLen(in.Detail) > 1000 {
		return "detail", validation("detail、need、workaround 合计不能超过 1000 个字符")
	}
	return "", nil
}

// recordAgentCapabilityGap 在同一事务里写入缺口并累加同 key 的请求次数。
// 已标记 planned/declined 的缺口不因再次请求被重置回 open。
func (s *Server) recordAgentCapabilityGap(ctx context.Context, tx pgx.Tx, workspaceID, userID, runID uuid.UUID,
	in agentCapabilityGapInput) (uuid.UUID, error) {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `INSERT INTO agent_capability_gap
		(workspace_id, requested_by, run_id, gap_key, title, detail, request_count, status)
		VALUES ($1,$2,$3,$4,$5,$6,1,'open')
		ON CONFLICT (workspace_id, gap_key) DO UPDATE SET
			requested_by=EXCLUDED.requested_by,
			run_id=EXCLUDED.run_id,
			title=EXCLUDED.title,
			detail=EXCLUDED.detail,
			request_count=agent_capability_gap.request_count + 1,
			updated_at=now()
		RETURNING id`, workspaceID, userID, runID, in.GapKey, in.Title, in.Detail).Scan(&id)
	return id, err
}

// agentMetaReportCapabilityGap 是 report_capability_gap 的本地执行入口：
// 缺口写入与工具结果消息必须在同一事务提交，成功后只回执 {recorded:true}。
func (s *Server) agentMetaReportCapabilityGap(ctx context.Context, st *agentRunState, call ai.ToolCall,
	args map[string]any, send func(string, any)) error {
	if ident(ctx).Role != "owner" && ident(ctx).Role != "editor" {
		return s.agentToolError(ctx, st, call, "forbidden", "只有所有者或编辑者可以记录能力缺口", send)
	}
	var in agentCapabilityGapInput
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return s.agentToolError(ctx, st, call, "invalid_arguments", "能力缺口参数不合法", send)
	}
	field, err := in.normalize()
	if err != nil {
		return s.agentToolError(ctx, st, call, "invalid_arguments", field+": "+err.Error(), send)
	}
	ctx = context.WithoutCancel(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := s.recordAgentCapabilityGap(ctx, tx, st.WorkspaceID, st.UserID, st.RunID, in); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"recorded": true})
	rec := agentToolRecord{Model: payload, Raw: payload, Summary: "已记录能力缺口"}
	event, err := s.agentCommitToolOutcomeTx(ctx, tx, st, call, rec, "done")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if send != nil {
		send("tool", event)
	}
	return nil
}

func (s *Server) listAgentCapabilityGaps(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && status != "open" && status != "planned" && status != "declined" {
		return validation("status 只能是 open、planned 或 declined")
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, workspace_id, requested_by, run_id, gap_key, title,
		detail, request_count, status, created_at, updated_at
		FROM agent_capability_gap WHERE workspace_id=$1
		AND ($2='' OR status=$2) ORDER BY updated_at DESC, id DESC`,
		ident(r.Context()).WorkspaceID, status)
	if err != nil {
		return err
	}
	defer rows.Close()
	gaps := []agentCapabilityGap{}
	for rows.Next() {
		var g agentCapabilityGap
		if err := rows.Scan(&g.ID, &g.WorkspaceID, &g.RequestedBy, &g.RunID, &g.GapKey, &g.Title,
			&g.Detail, &g.RequestCount, &g.Status, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return err
		}
		gaps = append(gaps, g)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"gaps": gaps})
}

func (s *Server) patchAgentCapabilityGap(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Status = strings.TrimSpace(in.Status)
	if in.Status != "open" && in.Status != "planned" && in.Status != "declined" {
		return validationFields("状态不合法", map[string]string{"status": "只能是 open、planned 或 declined"})
	}
	var g agentCapabilityGap
	err = s.db.QueryRow(r.Context(), `UPDATE agent_capability_gap SET status=$1, updated_at=now()
		WHERE id=$2 AND workspace_id=$3
		RETURNING id, workspace_id, requested_by, run_id, gap_key, title, detail, request_count,
		status, created_at, updated_at`, in.Status, id, ident(r.Context()).WorkspaceID).Scan(
		&g.ID, &g.WorkspaceID, &g.RequestedBy, &g.RunID, &g.GapKey, &g.Title, &g.Detail,
		&g.RequestCount, &g.Status, &g.CreatedAt, &g.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound("能力缺口不存在")
	}
	if err != nil {
		return err
	}
	return ok(w, g)
}
