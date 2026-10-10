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
	defer t.Stop()
	s.interruptJobs(ctx)
	s.runJobsOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.runJobsOnce(ctx)
		}
	}
}

func (s *Server) runJobsOnce(ctx context.Context) {
	if _, err := s.db.Exec(ctx, `DELETE FROM session WHERE expires_at < now()`); err != nil {
		slog.Error("清理过期会话失败", "err", err)
	}
	if n, err := s.PurgeExpiredTrash(ctx); err != nil {
		slog.Error("清理回收站失败", "err", err)
	} else if n > 0 {
		slog.Info("回收站到期清理", "count", n)
	}
	s.refreshTokens(ctx)
	// FR-M10-06：约每 2 小时扫一次（本调度为 10 分钟一次，用分钟位粗控）
	if s.now().Minute() < 10 && s.now().Hour()%2 == 0 {
		s.syncDraftsJob(ctx)
	}
	s.purgeDeletedSections(ctx)
	s.metricRemindersJob(ctx)
	s.reindexEmbeddings(ctx)
	// 每日 / 每周任务只在凌晨后跑一次（markOnce 保证幂等）
	if h := s.now().In(s.loc).Hour(); h >= 3 {
		s.distillDaily(ctx)
		s.inboxTriageDaily(ctx)
		s.weeklyDigestJob(ctx)
	}
	_, _ = s.db.Exec(ctx, `DELETE FROM job_marker WHERE created_at < now() - interval '60 days'`)
	_, _ = s.db.Exec(ctx, `DELETE FROM ux_event WHERE created_at < now() - interval '180 days'`)
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
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM model_provider WHERE workspace_id=$1)`, ws).Scan(&exists); err != nil || exists {
		return err
	}
	enc, err := s.box.Encrypt("local-dev-key")
	if err != nil {
		return err
	}
	var id uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
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
