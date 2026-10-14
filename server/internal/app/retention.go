package app

import (
	"context"
	"log/slog"
	"time"
)

const opt11EmptyUUID = "00000000-0000-0000-0000-000000000000"

type retentionStats struct {
	AICalls      int
	AuditLogs    int
	Disclosures  int
	WorkVersions int
	MaxBatch     int
	MaxBatchMS   int64
}

func (s *Server) runRetentionCleanup(ctx context.Context) {
	key := "opt11-retention:" + s.today().Format("2006-01-02")
	var done bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`, key).Scan(&done); err != nil {
		slog.Error("读取保留期清理标记失败", "err", err)
		return
	}
	if done {
		return
	}
	stats, err := s.purgeRetention(ctx)
	if err != nil {
		slog.Error("清理长期数据失败", "err", err)
		return
	}
	if !s.markOnce(ctx, key) {
		slog.Warn("记录保留期清理标记失败")
		return
	}
	if stats.AICalls+stats.AuditLogs+stats.Disclosures+stats.WorkVersions > 0 {
		slog.Info("长期数据清理完成", "ai_calls", stats.AICalls, "audit_logs", stats.AuditLogs,
			"ai_disclosures", stats.Disclosures, "work_versions", stats.WorkVersions,
			"max_batch", stats.MaxBatch, "max_batch_ms", stats.MaxBatchMS)
	}
}

func (s *Server) purgeRetention(ctx context.Context) (retentionStats, error) {
	stats := retentionStats{}
	cutoffs := []struct {
		name   string
		query  string
		cutoff time.Time
		total  *int
	}{
		{name: "ai_call", query: opt11ArchiveAICalls, cutoff: s.now().AddDate(0, 0, -180), total: &stats.AICalls},
		{name: "audit_log", query: opt11DeleteOldAuditLogs, cutoff: s.now().AddDate(0, 0, -365), total: &stats.AuditLogs},
		{name: "ai_disclosure", query: opt11DeleteOldDisclosures, cutoff: s.now().AddDate(0, 0, -365), total: &stats.Disclosures},
		{name: "work_version", query: opt11PruneWorkVersions, cutoff: s.now(), total: &stats.WorkVersions},
	}
	for _, item := range cutoffs {
		for {
			started := time.Now()
			var count int
			if err := s.db.QueryRow(ctx, item.query, item.cutoff).Scan(&count); err != nil {
				return stats, err
			}
			elapsed := time.Since(started).Milliseconds()
			if count == 0 {
				break
			}
			*item.total += count
			if count > stats.MaxBatch {
				stats.MaxBatch = count
			}
			if elapsed > stats.MaxBatchMS {
				stats.MaxBatchMS = elapsed
			}
			slog.Info("保留期清理批次", "table", item.name, "count", count, "duration_ms", elapsed)
		}
	}
	return stats, nil
}

const opt11ArchiveAICalls = `
WITH batch AS MATERIALIZED (
	SELECT id FROM ai_call WHERE created_at < $1 ORDER BY created_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
), deleted AS (
	DELETE FROM ai_call c USING batch b WHERE c.id=b.id
	RETURNING c.account_id,c.workspace_id,c.task_type,c.provider,c.model,c.is_eval,c.prompt_tokens,c.completion_tokens,c.latency_ms,c.status,c.created_at
), resolved AS MATERIALIZED (
	SELECT date_trunc('month',d.created_at)::date AS month,
		coalesce(d.workspace_id,a.workspace_id,'` + opt11EmptyUUID + `'::uuid) AS workspace_id,
		coalesce(d.account_id,'` + opt11EmptyUUID + `'::uuid) AS account_id,
		d.task_type,d.provider,d.model,d.is_eval,d.prompt_tokens,d.completion_tokens,d.latency_ms,d.status
	FROM deleted d LEFT JOIN platform_account a ON a.id=d.account_id
), upserted AS (
	INSERT INTO ai_call_monthly_summary (month,workspace_id,account_id,task_type,provider,model,is_eval,call_count,success_count,failed_count,prompt_tokens,completion_tokens,latency_ms)
	SELECT month,workspace_id,account_id,task_type,provider,model,is_eval,count(*),
		count(*) FILTER (WHERE status='ok'),count(*) FILTER (WHERE status<>'ok'),
		coalesce(sum(prompt_tokens),0),coalesce(sum(completion_tokens),0),coalesce(sum(latency_ms),0)
	FROM resolved GROUP BY month,workspace_id,account_id,task_type,provider,model,is_eval
	ON CONFLICT (month,workspace_id,account_id,task_type,provider,model,is_eval) DO UPDATE SET
		call_count=ai_call_monthly_summary.call_count+excluded.call_count,
		success_count=ai_call_monthly_summary.success_count+excluded.success_count,
		failed_count=ai_call_monthly_summary.failed_count+excluded.failed_count,
		prompt_tokens=ai_call_monthly_summary.prompt_tokens+excluded.prompt_tokens,
		completion_tokens=ai_call_monthly_summary.completion_tokens+excluded.completion_tokens,
		latency_ms=ai_call_monthly_summary.latency_ms+excluded.latency_ms
	RETURNING 1
)
SELECT count(*) FROM resolved WHERE (SELECT count(*) FROM upserted)>=0`

const opt11DeleteOldAuditLogs = `
WITH batch AS MATERIALIZED (
	SELECT id FROM audit_log WHERE created_at < $1 ORDER BY created_at,id LIMIT 5000 FOR UPDATE SKIP LOCKED
), deleted AS (
	DELETE FROM audit_log a USING batch b WHERE a.id=b.id RETURNING 1
)
SELECT count(*) FROM deleted`

const opt11DeleteOldDisclosures = `
WITH batch AS MATERIALIZED (
	SELECT ci.id FROM check_item ci JOIN check_run cr ON cr.id=ci.check_run_id
	WHERE ci.category='ai_disclosure' AND cr.created_at < $1
	ORDER BY cr.created_at,ci.id LIMIT 5000 FOR UPDATE OF ci SKIP LOCKED
), deleted AS (
	DELETE FROM check_item ci USING batch b WHERE ci.id=b.id RETURNING 1
)
SELECT count(*) FROM deleted`

const opt11PruneWorkVersions = `
WITH ranked AS MATERIALIZED (
	SELECT id,work_id,reason,row_number() OVER (PARTITION BY work_id ORDER BY version_no DESC) AS position
	FROM work_version
), batch AS MATERIALIZED (
	SELECT v.id FROM work_version v JOIN ranked r ON r.id=v.id
	WHERE r.position>50 AND r.reason NOT IN ('check','publish') AND v.created_at<=$1
	ORDER BY v.work_id,v.version_no LIMIT 5000 FOR UPDATE OF v SKIP LOCKED
), deleted AS (
	DELETE FROM work_version v USING batch b WHERE v.id=b.id RETURNING 1
)
SELECT count(*) FROM deleted`
