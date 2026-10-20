package app

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

// 灰度、kill switch 与运营诊断（20 文档 §14、§17.3）。
//
// 全局 kill switch 是系统配置（system_setting），不由工作区策略覆盖；它与进程配置
// OPS_DESKTOP_PLATFORM_ENABLED 叠加：任一关闭即停，避免部署时漏改一处而误开。

const (
	platformKillSwitchKey = "platform_collection.kill_switch"

	// §17.3 的初始灰度阈值。冲突率与登录要求率按窗口内比例判断，其余按次数。
	platformThresholdConflictRate = 0.05
	platformThresholdSchemaPerDay = 2
	platformThresholdLoginRate    = 0.20
	platformDiagnosticsWindowDays = 7
)

// platformCollectionGloballyEnabled 是准入判断的唯一入口：进程配置与 DB 开关都必须开启。
func (s *Server) platformCollectionGloballyEnabled(ctx context.Context) bool {
	if s.cfg == nil || !s.cfg.DesktopPlatformEnabled {
		return false
	}
	killed, err := s.systemBool(ctx, platformKillSwitchKey, false)
	if err != nil {
		// 读不到开关时按“已关闭”处理：安全侧失败，不因为配置读取异常而放开采集。
		slog.Error("平台采集：读取全局开关失败，按关闭处理", "err", err)
		return false
	}
	return !killed
}

// platformDiagnostics 是一次窗口内的运营计数，供 owner 与超管页展示。
// 只含计数与比例，不含工作区名称、作品标题或任何业务内容。
type platformDiagnostics struct {
	WindowDays           int     `json:"window_days"`
	RunsTotal            int     `json:"runs_total"`
	RunsSucceeded        int     `json:"runs_succeeded"`
	RunsPartial          int     `json:"runs_partial"`
	RunsFailed           int     `json:"runs_failed"`
	RunFailureRate       float64 `json:"run_failure_rate"`
	Observations         int     `json:"observations"`
	ObservationsValid    int     `json:"observations_valid"`
	ObservationsPending  int     `json:"observations_pending"`
	ObservationsRejected int     `json:"observations_rejected"`
	// 字段缺失率：metric_meta.missing_fields 非空的观测占比。
	ObservationsWithMissing int     `json:"observations_with_missing"`
	FieldMissingRate        float64 `json:"field_missing_rate"`
	// 冲突率与登录要求率按 run 的错误码/停止原因统计。
	Conflicts         int      `json:"conflicts"`
	ConflictRate      float64  `json:"conflict_rate"`
	LoginRequired     int      `json:"login_required"`
	ChallengeRequired int      `json:"challenge_required"`
	LoginRequiredRate float64  `json:"login_required_rate"`
	SchemaChanged     int      `json:"schema_changed"`
	AdoptedMetrics    int      `json:"adopted_metrics"`
	AutoAdoptRate     float64  `json:"auto_adopt_rate"`
	Degraded          bool     `json:"degraded"`
	DegradedReasons   []string `json:"degraded_reasons"`
}

// platformWorkspaceDiagnostics 统计单个工作区近 N 天的计数（owner 在连接摘要查看）。
func (s *Server) platformWorkspaceDiagnostics(ctx context.Context, workspaceID uuid.UUID) (platformDiagnostics, error) {
	since := s.now().AddDate(0, 0, -platformDiagnosticsWindowDays)
	d := platformDiagnostics{WindowDays: platformDiagnosticsWindowDays, DegradedReasons: []string{}}
	if err := s.db.QueryRow(ctx, `SELECT
		  count(*),
		  count(*) FILTER (WHERE status='succeeded'),
		  count(*) FILTER (WHERE status='partial'),
		  count(*) FILTER (WHERE status='failed'),
		  count(*) FILTER (WHERE error_code='platform_result_conflict'),
		  count(*) FILTER (WHERE error_code='platform_login_required'),
		  count(*) FILTER (WHERE error_code='platform_challenge_required'),
		  count(*) FILTER (WHERE error_code='platform_schema_changed')
		FROM platform_sync_run WHERE workspace_id=$1 AND created_at >= $2`,
		workspaceID, since).Scan(&d.RunsTotal, &d.RunsSucceeded, &d.RunsPartial, &d.RunsFailed,
		&d.Conflicts, &d.LoginRequired, &d.ChallengeRequired, &d.SchemaChanged); err != nil {
		return d, err
	}
	if err := s.db.QueryRow(ctx, `SELECT
		  count(*),
		  count(*) FILTER (WHERE quality_state='valid'),
		  count(*) FILTER (WHERE quality_state='needs_confirmation'),
		  count(*) FILTER (WHERE quality_state='rejected'),
		  count(*) FILTER (WHERE jsonb_array_length(coalesce(field_paths->'_missing','[]'::jsonb)) > 0)
		FROM platform_metric_observation WHERE workspace_id=$1 AND created_at >= $2`,
		workspaceID, since).Scan(&d.Observations, &d.ObservationsValid, &d.ObservationsPending,
		&d.ObservationsRejected, &d.ObservationsWithMissing); err != nil {
		return d, err
	}
	// 自动采用率：窗口内由观测投影出的正式指标占比。
	if err := s.db.QueryRow(ctx, `SELECT
		  count(*) FILTER (WHERE m.observation_id IS NOT NULL),
		  count(*)
		FROM metric_snapshot m JOIN work w ON w.id=m.work_id
		JOIN platform_account a ON a.id=w.account_id
		WHERE a.workspace_id=$1 AND m.created_at >= $2`, workspaceID, since).
		Scan(&d.AdoptedMetrics, new(int)); err != nil {
		return d, err
	}
	d.decorate()
	return d, nil
}

// platformGlobalDiagnostics 按平台与适配器版本聚合全局计数（超管页），不含业务内容。
func (s *Server) platformGlobalDiagnostics(ctx context.Context) ([]map[string]any, error) {
	since := s.now().AddDate(0, 0, -platformDiagnosticsWindowDays)
	rows, err := s.db.Query(ctx, `SELECT c.platform,
		  coalesce(r.adapter_version, ''), coalesce(r.mapping_version, 1),
		  count(*),
		  count(*) FILTER (WHERE r.status='failed'),
		  count(*) FILTER (WHERE r.error_code='platform_schema_changed')
		FROM platform_sync_run r JOIN platform_connection c ON c.id=r.connection_id
		WHERE r.created_at >= $1
		GROUP BY 1,2,3 ORDER BY 1,2,3`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var platform, adapter string
		var mapping, total, failed, schema int
		if err := rows.Scan(&platform, &adapter, &mapping, &total, &failed, &schema); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"platform": platform, "adapter_version": adapter, "mapping_version": mapping,
			"runs": total, "failed": failed, "schema_changed": schema,
		})
	}
	return out, rows.Err()
}

// decorate 计算比例并给出降级原因（§17.3 的初始阈值）。
func (d *platformDiagnostics) decorate() {
	if d.RunsTotal > 0 {
		d.RunFailureRate = float64(d.RunsFailed) / float64(d.RunsTotal)
		d.LoginRequiredRate = float64(d.LoginRequired+d.ChallengeRequired) / float64(d.RunsTotal)
		d.ConflictRate = float64(d.Conflicts) / float64(d.RunsTotal)
	}
	if d.Observations > 0 {
		d.FieldMissingRate = float64(d.ObservationsWithMissing) / float64(d.Observations)
		d.AutoAdoptRate = float64(d.ObservationsValid) / float64(d.Observations)
	}
	if d.ConflictRate > platformThresholdConflictRate {
		d.Degraded = true
		d.DegradedReasons = append(d.DegradedReasons, "conflict_rate")
	}
	if d.LoginRequiredRate > platformThresholdLoginRate {
		d.Degraded = true
		d.DegradedReasons = append(d.DegradedReasons, "login_required_rate")
	}
	if float64(d.SchemaChanged)/float64(platformDiagnosticsWindowDays) > platformThresholdSchemaPerDay {
		d.Degraded = true
		d.DegradedReasons = append(d.DegradedReasons, "schema_changed_rate")
	}
}

// enforcePlatformGrayThresholds 由调度器每轮调用：超阈值时把该工作区所有连接的
// auto_adopt 关掉（只降级为“只写观测”，不停自动采集），并写审计。
func (s *Server) enforcePlatformGrayThresholds(ctx context.Context) {
	if s.cfg == nil || !s.cfg.DesktopPlatformEnabled {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT workspace_id FROM platform_connection WHERE state='active'`)
	if err != nil {
		slog.Error("平台灰度：读取工作区失败", "err", err)
		return
	}
	var workspaces []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			workspaces = append(workspaces, id)
		}
	}
	rows.Close()
	for _, ws := range workspaces {
		diag, err := s.platformWorkspaceDiagnostics(ctx, ws)
		if err != nil {
			slog.Error("平台灰度：统计失败", "workspace_id", ws, "err", err)
			continue
		}
		if !diag.Degraded {
			continue
		}
		tag, err := s.db.Exec(ctx, `UPDATE platform_connection SET auto_adopt=false, updated_at=now()
			WHERE workspace_id=$1 AND auto_adopt`, ws)
		if err != nil {
			slog.Error("平台灰度：自动降级失败", "workspace_id", ws, "err", err)
			continue
		}
		if tag.RowsAffected() > 0 {
			s.audit(ctx, "platform_gray_degrade", "workspace", ws.String(), "ok", map[string]any{
				"reasons": diag.DegradedReasons, "runs": diag.RunsTotal,
				"conflict_rate": diag.ConflictRate, "login_required_rate": diag.LoginRequiredRate,
			})
			slog.Warn("平台采集自动降级为只写观测", "workspace_id", ws, "reasons", diag.DegradedReasons)
		}
	}
}

// platformDiagnosticsHandler 是 GET /platform-collection/diagnostics：owner 查看本工作区计数。
func (s *Server) platformDiagnosticsHandler(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	diag, err := s.platformWorkspaceDiagnostics(r.Context(), id.WorkspaceID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, diag)
}

// platformGrayStatus 供能力接口与页面显示当前是否被全局关闭或降级。
func (s *Server) platformGrayStatus(ctx context.Context) map[string]any {
	killed, _ := s.systemBool(ctx, platformKillSwitchKey, false)
	enabled := s.platformCollectionGloballyEnabled(ctx)
	return map[string]any{
		"process_enabled": s.cfg != nil && s.cfg.DesktopPlatformEnabled,
		"kill_switch":     killed,
		"effective":       enabled,
	}
}
