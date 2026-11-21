package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// REF41 F3（docs/41 §F3）：定时任务补跑。
// runJobOnce 统一台账：每次执行写 job_run（计划时间/开始/结束/状态/耗时/错误/补跑）；
// jobCatchUpJob 对每日/每周 allowlist 错过 2 周期且 7 天内补跑一次；高频不补；
// 补跑前查 job_marker 业务幂等，已做则 skipped；唯一键抢占避免多实例重复。

// jobCatchUpAllowlist 是补跑白名单（F3 §2；高频 1 分钟/10 分钟 ticker 不入列）。
var jobCatchUpAllowlist = map[string]time.Duration{
	"daily-brief":       24 * time.Hour,
	"weekly-digest":     7 * 24 * time.Hour,
	"metric-reminder":   24 * time.Hour,
	"publish-patrol":    24 * time.Hour,
	"memory-decay":      24 * time.Hour,
	"benchmark-monitor": 24 * time.Hour,
}

// jobCatchUpMaxAge 是补跑窗口上限（F3 §2：7 天）。
const jobCatchUpMaxAge = 7 * 24 * time.Hour

// runJobOnce 记录并执行一次 job：插入 running（唯一键抢占）→ fn → 终态。
// fn 返回 skipped 时写 skipped（业务幂等，不算失败）。
func (s *Server) runJobOnce(ctx context.Context, ws *uuid.UUID, key string, scheduledAt time.Time, catchUp bool, fn func(ctx context.Context) error) error {
	var wsArg any
	if ws != nil {
		wsArg = *ws
	}
	var runID uuid.UUID
	err := s.db.QueryRow(ctx, `INSERT INTO job_run (workspace_id, job_key, scheduled_at, started_at, status, catch_up)
		VALUES ($1,$2,$3,now(),'running',$4) RETURNING id`, wsArg, key, scheduledAt, catchUp).Scan(&runID)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23505" {
		// 多实例抢占：同 (ws, key, scheduled_at) 已在跑，跳过。
		return nil
	}
	if err != nil {
		return err
	}
	start := time.Now()
	fnErr := fn(ctx)
	durationMS := int(time.Since(start).Milliseconds())
	status := "succeeded"
	errorCode, errorMessage := "", ""
	if fnErr != nil {
		var jErr *jobSkipError
		if errors.As(fnErr, &jErr) {
			status = "skipped"
		} else {
			status = "failed"
			errorCode = "job_failed"
			errorMessage = truncate(fnErr.Error(), 500)
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE job_run SET finished_at=now(), status=$2, duration_ms=$3,
		error_code=$4, error_message=$5 WHERE id=$1`, runID, status, durationMS, errorCode, errorMessage); err != nil {
		slog.Error("写 job_run 终态失败", "job", key, "err", err)
	}
	return fnErr
}

// jobSkipError 表示业务幂等命中（job_marker 已做），不是失败。
type jobSkipError struct{ reason string }

func (e *jobSkipError) Error() string { return e.reason }

// jobCatchUpJob 每 10 分钟触发（挂在 RunJobs 10 分钟 ticker）：读白名单最近成功，
// 错过 2 周期且 7 天内 → 以 scheduled_at=now 补跑一次（catch_up=true）。
func (s *Server) jobCatchUpJob(ctx context.Context) {
	day := s.today().Format("2006-01-02")
	for key, period := range jobCatchUpAllowlist {
		var lastSuccess *time.Time
		var last *time.Time
		var lastCatchUp *time.Time
		err := s.db.QueryRow(ctx, `SELECT max(scheduled_at) FROM job_run
			WHERE job_key=$1 AND status='succeeded'`, key).Scan(&lastSuccess)
		if err != nil {
			continue
		}
		err = s.db.QueryRow(ctx, `SELECT max(scheduled_at) FROM job_run WHERE job_key=$1`, key).Scan(&last)
		if err != nil {
			continue
		}
		err = s.db.QueryRow(ctx, `SELECT max(scheduled_at) FROM job_run WHERE job_key=$1 AND catch_up=true`, key).Scan(&lastCatchUp)
		if err != nil {
			continue
		}
		// F3 §4：一次补跑失败后不得自动重试；只有后续又有成功记录才重新计时。
		if lastCatchUp != nil && (lastSuccess == nil || lastCatchUp.After(*lastSuccess)) {
			continue
		}
		reference := last
		if lastSuccess != nil {
			reference = lastSuccess
		}
		if reference == nil {
			continue
		}
		behind := time.Since(*reference)
		if behind <= 2*period || behind >= jobCatchUpMaxAge {
			continue
		}
		// 补跑一次：scheduled_at=now；唯一键天然幂等（10 分钟 ticker 不会重复插入）。
		_ = s.runJobOnce(ctx, nil, key, time.Now(), true, func(c context.Context) error {
			// 业务幂等：job_marker 已做则 skipped（补跑不重复已完成业务）。
			var done bool
			if err := s.db.QueryRow(c, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`,
				"catchup-marker:"+key+":"+day).Scan(&done); err == nil && done {
				return &jobSkipError{reason: "job_marker 已完成"}
			}
			err := s.runCatchUpJobBody(c, key)
			if err != nil {
				return err
			}
			s.markOnce(c, "catchup-marker:"+key+":"+day)
			return nil
		})
	}
}

// runCatchUpJobBody 按白名单 key 分发补跑体；未识别 key 返回错误。
func (s *Server) runCatchUpJobBody(ctx context.Context, key string) error {
	switch key {
	case "daily-brief":
		s.dailyBriefJobForDay(ctx, s.today().AddDate(0, 0, -1))
		return nil
	case "weekly-digest":
		s.weeklyDigestJobForDay(ctx, s.today().AddDate(0, 0, -1))
		return nil
	case "metric-reminder":
		s.metricRemindersJob(ctx)
		return nil
	case "publish-patrol":
		s.publishPatrolJob(ctx)
		return nil
	case "memory-decay":
		s.memoryDecayJob(ctx)
		return nil
	case "benchmark-monitor":
		s.benchmarkMonitorJob(ctx)
		return nil
	}
	return fmt.Errorf("未知补跑任务 %s", key)
}

// listJobRuns 系统-任务页：只返回当前 workspace 的最近 job 列表（owner）。
// F3-N5：不能把其他 workspace 或系统级（workspace_id=NULL）行混进当前工作区页面。
func (s *Server) listJobRuns(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	limit := 50
	rows, err := s.db.Query(r.Context(), `SELECT id, workspace_id, job_key, scheduled_at, started_at, finished_at,
		status, catch_up, duration_ms, error_code, error_message
		FROM job_run WHERE workspace_id=$1 ORDER BY scheduled_at DESC LIMIT $2`, ident(r.Context()).WorkspaceID, limit)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var ws *uuid.UUID
		var key, status, errorCode, errorMessage string
		var scheduledAt time.Time
		var startedAt, finishedAt *time.Time
		var catchUp bool
		var durationMS *int
		if err := rows.Scan(&id, &ws, &key, &scheduledAt, &startedAt, &finishedAt, &status, &catchUp, &durationMS, &errorCode, &errorMessage); err != nil {
			return err
		}
		items = append(items, map[string]any{
			"id": id, "workspace_id": ws, "job_key": key, "scheduled_at": scheduledAt,
			"started_at": startedAt, "finished_at": finishedAt, "status": status,
			"catch_up": catchUp, "duration_ms": durationMS,
			"error_code": errorCode, "error_message": errorMessage,
		})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"items": items})
}

// runJobNow 手动“立即补跑”：只对 allowlist（F3 §3 前端入口）。
func (s *Server) runJobNow(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		JobKey string `json:"job_key"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	if _, ok := jobCatchUpAllowlist[in.JobKey]; !ok {
		return apiErr(http.StatusUnprocessableEntity, "job_not_catchable", "该任务不在补跑白名单")
	}
	ctx := r.Context()
	err := s.runJobOnce(ctx, nil, in.JobKey, time.Now(), true, func(c context.Context) error {
		return s.runCatchUpJobBody(c, in.JobKey)
	})
	if err != nil {
		return apiErr(http.StatusInternalServerError, "job_run_failed", "补跑执行失败").With(map[string]string{"error": err.Error()})
	}
	s.audit(ctx, "job_run_now", "job_run", in.JobKey, "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// SeedJobRunsHandler E2E 专用：种两条台账（正常 + catch_up），仅测试服务注册。
// 台账查询按当前工作区过滤（listJobRuns WHERE workspace_id=$1），种子行必须
// 归到调用方会话的工作区，否则列表永远为空（docs/41 Q-02）。
func SeedJobRunsHandler(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		c, err := r.Cookie(sessionCookie)
		if err != nil || c.Value == "" {
			http.Error(w, "seed 需要调用方会话（workspace 归属）", http.StatusUnauthorized)
			return
		}
		id, err := s.loadIdentity(r.Context(), c.Value)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		ctx := r.Context()
		now := time.Now()
		if _, err := s.db.Exec(ctx, `INSERT INTO job_run (workspace_id, job_key, scheduled_at, started_at, finished_at, status, catch_up, duration_ms)
			VALUES ($2, 'daily-housekeeping', $1, $1, $1, 'succeeded', false, 120)
			ON CONFLICT DO NOTHING`, now.Add(-time.Hour), id.WorkspaceID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO job_run (workspace_id, job_key, scheduled_at, started_at, finished_at, status, catch_up, duration_ms)
			VALUES ($2, 'daily-brief', $1, $1, $1, 'succeeded', true, 300)
			ON CONFLICT DO NOTHING`, now.Add(-30*time.Minute), id.WorkspaceID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO job_run (workspace_id, job_key, scheduled_at, status)
			VALUES ($2, 'collect-hot', $1, 'succeeded') ON CONFLICT DO NOTHING`, now.Add(-15*time.Minute), id.WorkspaceID); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}
