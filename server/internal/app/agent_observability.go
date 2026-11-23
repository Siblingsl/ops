package app

import (
	"log/slog"
	"net/http"
	"strconv"
)

// OT-04：智能体工作台的可观测聚合。只返回按工作区聚合的计数、比例与平均时长，
// 不读取消息正文、提示词、工具参数或浏览器页面内容。
type agentObservabilityView struct {
	WindowDays         int     `json:"window_days"`
	RunsTotal          int     `json:"runs_total"`
	RunsFailed         int     `json:"runs_failed"`
	RunFailureRate     float64 `json:"run_failure_rate"`
	AvgRunDurationMs   float64 `json:"avg_run_duration_ms"`
	ToolCalls          int     `json:"tool_calls"`
	ToolFailures       int     `json:"tool_failures"`
	ToolFailureRate    float64 `json:"tool_failure_rate"`
	BrowserCommands    int     `json:"browser_commands"`
	BrowserFailures    int     `json:"browser_failures"`
	BrowserUnknown     int     `json:"browser_unknown_outcome"`
	BrowserFailureRate float64 `json:"browser_failure_rate"`
}

func ratio(part, total int) float64 {
	if total <= 0 {
		return 0
	}
	return float64(part) / float64(total)
}

func (s *Server) getAgentObservability(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id := ident(ctx)
	days := 7
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 90 {
			return validation("统计窗口需为 1–90 天")
		}
		days = n
	}
	since := s.now().AddDate(0, 0, -days)
	view := agentObservabilityView{WindowDays: days}

	err := s.db.QueryRow(ctx, `SELECT
		  count(*) FILTER (WHERE status IN ('completed','failed','stopped')),
		  count(*) FILTER (WHERE status='failed'),
		  coalesce(avg(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)
		    FILTER (WHERE finished_at IS NOT NULL AND status IN ('completed','failed','stopped')),0)
		FROM agent_run
		WHERE workspace_id=$1 AND started_at >= $2`, id.WorkspaceID, since).
		Scan(&view.RunsTotal, &view.RunsFailed, &view.AvgRunDurationMs)
	if err != nil {
		return err
	}
	view.RunFailureRate = ratio(view.RunsFailed, view.RunsTotal)

	err = s.db.QueryRow(ctx, `SELECT
		  count(*) FILTER (WHERE status IN ('succeeded','failed')),
		  count(*) FILTER (WHERE status='failed')
		FROM agent_action
		WHERE workspace_id=$1 AND created_at >= $2`, id.WorkspaceID, since).
		Scan(&view.ToolCalls, &view.ToolFailures)
	if err != nil {
		return err
	}
	view.ToolFailureRate = ratio(view.ToolFailures, view.ToolCalls)

	err = s.db.QueryRow(ctx, `SELECT
		  count(*) FILTER (WHERE c.state IN ('succeeded','failed','unknown_outcome')),
		  count(*) FILTER (WHERE c.state='failed'),
		  count(*) FILTER (WHERE c.state='unknown_outcome')
		FROM agent_browser_command c
		JOIN agent_browser_grant g ON g.id=c.grant_id
		JOIN agent_conversation conv ON conv.id=g.conversation_id
		WHERE conv.workspace_id=$1 AND c.created_at >= $2`, id.WorkspaceID, since).
		Scan(&view.BrowserCommands, &view.BrowserFailures, &view.BrowserUnknown)
	if err != nil {
		return err
	}
	// unknown_outcome 是保守计入口径：无法确认成功时不能计为成功。
	view.BrowserFailureRate = ratio(view.BrowserFailures+view.BrowserUnknown, view.BrowserCommands)

	slog.Info("agent_observability_read",
		"workspace_id", id.WorkspaceID.String(),
		"window_days", view.WindowDays,
		"runs_total", view.RunsTotal,
		"runs_failed", view.RunsFailed,
		"run_failure_rate", view.RunFailureRate,
		"avg_run_duration_ms", view.AvgRunDurationMs,
		"tool_calls", view.ToolCalls,
		"tool_failures", view.ToolFailures,
		"browser_commands", view.BrowserCommands,
		"browser_failures", view.BrowserFailures,
		"browser_unknown_outcome", view.BrowserUnknown,
	)
	return ok(w, view)
}
