package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// RunJobs runs periodic maintenance until ctx is cancelled.
func (s *Server) RunJobs(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	ct := time.NewTicker(time.Minute)
	defer ct.Stop()
	defer t.Stop()
	s.interruptJobs(ctx)
	s.runJobsOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.runJobsOnce(ctx)
		case <-ct.C:
			s.runAgentRoutines(ctx)
			s.collectHot(ctx)
			s.collectReferences(ctx)
			s.dailyBackground(ctx)
			s.collectSummaries(ctx)
			// REF41 P5：未登录任务 20 分钟自动补跑 + 体检过期清理（每分钟幂等）。
			s.publishRetryJob(ctx)
			s.publishHealthExpireJob(ctx)
			// REF41 P7：定时漂移巡检（每分钟触发、游标内 15 分钟一轮；只读，不改平台）。
			s.publishPatrolJob(ctx)
			// REF41 P8：生产 API runner（queued + api → Preflight/Fill/Readback → filled；
			// 不自动 Submit，不绕过用户发布动作）。
			s.publishAPIRunnerJob(ctx)
			// REF41 I1：竞对监控调度（每分钟触发、游标 10 分钟一轮；只读公开页）。
			s.benchmarkMonitorJob(ctx)
			// REF41 F1：告警评估（每分钟触发、游标 5 分钟一轮；只读聚合 + 通知）。
			s.alertMonitorJob(ctx)
			// REF41 F3：定时补跑检查（每分钟触发；只对白名单每日/每周任务，10 分钟幂等由唯一键保证）。
			s.jobCatchUpJob(ctx)
		}
	}
}

func (s *Server) runJobsOnce(ctx context.Context) {
	s.runAgentRoutines(ctx)
	// DEV-A13：委派组恢复 sweep（幂等；不建 run、不重放工具）。
	s.sweepDelegationGroups(ctx)
	// DEV-CU P4-6：电脑命令超时扫描（dispatched 超 deadline+2s → unknown_outcome；不重放）。
	s.sweepComputerCommands(ctx)
	// Q-23（docs/41）：浏览器命令超时 sweep 与电脑命令对称接入——等待方断开或桌面
	// 执行器不在线时，dispatched 超 deadline 的命令不能永久停留中间态（27 §13.3）。
	s.sweepAgentBrowserCommands(ctx)
	if _, err := s.db.Exec(ctx, `DELETE FROM session WHERE expires_at < now()`); err != nil {
		slog.Error("清理过期会话失败", "err", err)
	}
	if n, err := s.PurgeExpiredTrash(ctx); err != nil {
		slog.Error("清理回收站失败", "err", err)
	} else if n > 0 {
		slog.Info("回收站到期清理", "count", n)
	}
	// DEV-AI27-09（W09 第三批，27 §14.6 证据保留策略）：未被批注引用的浏览器证据
	// 创建超 24h 后删除；被批注引用的保留（引用计数）。命令账本不动（去重窗 ≥24h）。
	if n, err := s.CleanupStaleBrowserEvidence(ctx); err != nil {
		slog.Error("清理过期浏览器证据失败", "err", err)
	} else if n > 0 {
		slog.Info("过期浏览器证据清理", "count", n)
	}
	if n, err := s.cleanupCXBuilds(ctx); err != nil {
		slog.Error("清理内容构建产物失败", "err", err)
	} else if n > 0 {
		slog.Info("清理内容构建产物", "builds", n)
	}
	s.refreshTokens(ctx)
	// FR-M10-06：约每 2 小时扫一次（本调度为 10 分钟一次，用分钟位粗控）
	if s.now().Minute() < 10 && s.now().Hour()%2 == 0 {
		s.syncDraftsJob(ctx)
	}
	s.purgeDeletedSections(ctx)
	s.metricRemindersJob(ctx)
	// 平台采集调度（20 文档 §10.1.1）：每 10 分钟按 next_due_at 生成有界任务。
	s.enforcePlatformGrayThresholds(ctx)
	s.schedulePlatformRuns(ctx)
	s.purgeMetricUploads(ctx)
	s.wechatMetricsDaily(ctx)
	s.day7PrefsJob(ctx)
	s.reindexEmbeddings(ctx)
	s.purgeHot(ctx)
	s.collectReferences(ctx)
	s.dailyBackground(ctx)
	s.collectSummaries(ctx)
	// 每日 / 每周任务只在凌晨后跑一次（markOnce 保证幂等）
	if h := s.now().In(s.loc).Hour(); h >= 3 {
		s.runDailyHousekeeping(ctx)
		s.runRetentionCleanup(ctx)
		s.runAgentCleanup(ctx)
	}
	// REF41 I3：问题簇每小时重算（软删只降计数；已忽略/已转选题不自动改状态）。
	s.commentClusterJob(ctx)
	// REF41 I5：9 点后按 1/3/7/30 天节点发一次同龄对比通知（job_marker 与通知 dedupe 双幂等）。
	s.reviewPeerJob(ctx)
	s.purgeJobRetention(ctx)
}

// purgeJobRetention：调度标记与 UX 事件保留清理；失败 Warn 可观测（BE-02）。
func (s *Server) purgeJobRetention(ctx context.Context) {
	if _, err := s.db.Exec(ctx, `DELETE FROM job_marker WHERE created_at < now() - interval '60 days'`); err != nil {
		s.observeFailure(ctx, slog.LevelWarn, "调度标记保留清理失败", observeFields{
			ErrorCode: "jobs_marker_purge_failed", Route: "internal/jobs/run_once",
			Extras: map[string]any{"err": err.Error()},
		})
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM ux_event WHERE created_at < now() - interval '180 days'`); err != nil {
		s.observeFailure(ctx, slog.LevelWarn, "UX 事件保留清理失败", observeFields{
			ErrorCode: "jobs_ux_event_purge_failed", Route: "internal/jobs/run_once",
			Extras: map[string]any{"err": err.Error()},
		})
	}
}

func (s *Server) runDailyHousekeeping(ctx context.Context) {
	// REF41 A4：记忆 90 天衰减（confidence ×0.9 下限 0.5；不自动 disabled）。
	s.memoryDecayJob(ctx)
	// REF41 F4：采集失败聚集 → 规则模板配方草稿（7 天 ≥3；draft 不重复生成）。
	s.parserRecipeJob(ctx)
	// REF41 I3：读者关注点周统计（当前周 + 上一周）。
	s.readerTermsJob(ctx)
	today := s.today()
	s.runDailyHousekeepingFor(ctx, today.AddDate(0, 0, -1))
	s.runDailyHousekeepingFor(ctx, today)
}

func (s *Server) runDailyHousekeepingFor(ctx context.Context, day time.Time) {
	day = time.Date(day.In(s.loc).Year(), day.In(s.loc).Month(), day.In(s.loc).Day(), 0, 0, 0, 0, s.loc)
	// REF41 F3：每日任务统一走 job_run 台账（scheduled_at=当日 03:00 窗口）。
	dayWindow := day.Add(3 * time.Hour)
	if err := s.runJobOnce(ctx, nil, "daily-housekeeping", dayWindow, false, func(c context.Context) error {
		s.runDailyHousekeepingBody(c, day)
		return nil
	}); err != nil {
		slog.Error("每日任务执行失败", "day", day.Format("2006-01-02"), "err", err)
	}
}

func (s *Server) runDailyHousekeepingBody(ctx context.Context, day time.Time) {
	key := "daily-housekeeping:" + day.Format("2006-01-02")
	var done bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`, key).Scan(&done); err != nil {
		slog.Error("读取每日任务标记失败", "day", day.Format("2006-01-02"), "err", err)
		return
	}
	if done {
		return
	}
	s.distillDailyForDay(ctx, day)
	s.inboxTriageDailyForDay(ctx, day)
	s.weeklyDigestJobForDay(ctx, day)
	s.weeklyReviewDraftJobForDay(ctx, day)
	s.dailyBriefJobForDay(ctx, day)
	if !s.markOnce(ctx, key) {
		slog.Warn("记录每日任务标记失败", "day", day.Format("2006-01-02"))
	}
}

// PurgeExpiredTrash permanently deletes items that stayed in the trash longer than trashDays.
func (s *Server) PurgeExpiredTrash(ctx context.Context) (int, error) {
	cutoff := s.now().AddDate(0, 0, -trashDays)
	n := 0
	for typ, def := range trashTables {
		rows, err := s.db.Query(ctx, `SELECT id FROM `+def.table+` WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
		if err != nil {
			return n, err
		}
		var ids []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, id := range ids {
			if err := s.purge(ctx, typ, id); err != nil {
				return n, err
			}
			s.audit(ctx, "trash_expire", typ, id.String(), "ok", nil)
			n++
		}
	}
	return n, nil
}

func (s *Server) refreshTokens(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT c.account_id FROM wechat_credential c JOIN platform_account a ON a.id=c.account_id
		LEFT JOIN wechat_token t ON t.account_id=c.account_id
		WHERE a.status='active' AND c.last_check_ok AND t.expires_at IS NOT NULL AND t.expires_at < now() + interval '15 minutes'`)
	if err != nil {
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if _, err := s.accessToken(ctx, id, true); err != nil {
			slog.Warn("预刷新 access_token 失败", "account", id, "err", err)
		}
	}
}

// SeedDevModel registers the local fake model for every workspace missing one (dev mode).
// 内置角色/模板由 SeedWorkspaceBuiltins 单独负责，不能混在 dev-only 分支里。
func (s *Server) SeedDevModel(ctx context.Context) error {
	if !s.cfg.Dev {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id FROM workspace`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ws uuid.UUID
		if err := rows.Scan(&ws); err != nil {
			return err
		}
		if err := s.seedDevModelFor(ctx, ws); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Server) seedDevModelFor(ctx context.Context, ws uuid.UUID) error {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM model_provider WHERE workspace_id=$1 AND execution_location='server')`, ws).Scan(&exists); err != nil || exists {
		return err
	}
	enc, err := s.box.Encrypt("local-dev-key")
	if err != nil {
		return err
	}
	var id uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models, simulated) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
		ws, "本地模拟模型", "http://"+s.cfg.MockListen+"/v1", enc, s.box.Version, []string{"mock-writer", "mock-fast", "mock-embed"}).Scan(&id); err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `INSERT INTO model_route (workspace_id, task_type, provider_id, model) VALUES
		($1,'default',$2,'mock-writer'), ($1,'fact_flag',$2,'mock-fast'), ($1,'section_continue',$2,'mock-fast'),
		($1,'material_tag',$2,'mock-fast'), ($1,'topic_score',$2,'mock-fast'), ($1,'fix_suggest',$2,'mock-fast'),
		($1,'inbox_triage',$2,'mock-fast'), ($1,'tag_suggest',$2,'mock-fast'), ($1,'embedding',$2,'mock-embed')
		ON CONFLICT (workspace_id, task_type) DO NOTHING`, ws, id)
	if err == nil {
		slog.Info("已添加本地模拟模型（仅开发模式）", "workspace_id", ws.String())
	}
	return err
}
