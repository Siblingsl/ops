package app

// REF41 P7：定时漂移告警与发布巡检。巡检只读：scheduled/submitted 任务每 15
// 分钟核对“平台实际定时 vs 计划定时”（漂移阈值 60 秒）与是否已公开；发现已
// 公开时调既有 handlePublished，不直接改写任务。漂移产生 drift 事件与通知，
// 同一任务同一类漂移 1 小时内只通知一次；巡检失败不改变任务状态。

import (
	"context"
	"time"

	"github.com/google/uuid"
)

const (
	publishDriftTolerance  = 60 * time.Second
	publishPatrolInterval  = 15 * time.Minute
	publishDriftDedupeHour = time.Hour
)

// publishPlannedAt 取计划定时：任务 plan_at 优先，为空回退里程碑 scheduled_at。
func (s *Server) publishPlannedAt(ctx context.Context, task *PublishTask) *time.Time {
	if task.PlanAt != nil {
		return task.PlanAt
	}
	var scheduled *time.Time
	_ = s.db.QueryRow(ctx, `SELECT scheduled_at FROM work_publish_state
		WHERE work_id=$1 AND scheduled_at IS NOT NULL`, task.WorkID).Scan(&scheduled)
	return scheduled
}

// publishScheduleDrift 判定漂移：两侧都有时间且差值绝对值 > 60 秒。
func publishScheduleDrift(planned, platform *time.Time) bool {
	if planned == nil || platform == nil {
		return false
	}
	diff := platform.Sub(*planned)
	if diff < 0 {
		diff = -diff
	}
	return diff > publishDriftTolerance
}

// publishPatrolJob 每 15 分钟一轮（挂在 RunJobs 的 ct ticker）；用 job_marker
// 游标避免全表扫，桌面平台经由 publish_health_check purpose='patrol' 只读核对。
func (s *Server) publishPatrolJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id, account_id, work_id, platform, mode,
		state, plan_at, platform_schedule_at
		FROM publish_task WHERE state IN ('submitted','scheduled')`)
	if err != nil {
		return
	}
	type patrolTask struct {
		ID          uuid.UUID
		WorkspaceID uuid.UUID
		AccountID   uuid.UUID
		WorkID      uuid.UUID
		Platform    string
		Mode        string
		State       string
		PlanAt      *time.Time
		PlatformAt  *time.Time
	}
	tasks := []patrolTask{}
	for rows.Next() {
		var t patrolTask
		var mode string
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &t.AccountID, &t.WorkID, &t.Platform, &mode,
			&t.State, &t.PlanAt, &t.PlatformAt); err != nil {
			rows.Close()
			return
		}
		_ = mode
		t.Mode = mode
		tasks = append(tasks, t)
	}
	rows.Close()

	for _, t := range tasks {
		marker := "publish-patrol:" + t.ID.String()
		if !s.shouldRunPatrol(ctx, marker, publishPatrolInterval) {
			continue
		}
		// P7-N2：桌面平台巡检复用 P5 体检（purpose='patrol'），由桌面 claim 实际执行；
		// 巡检只排队只读体检，不直接改任务状态。公众号 API 通道由服务端 token 体检覆盖。
		if t.Mode == "desktop" {
			// 体检排队失败不阻断本轮漂移检查；下一轮会再补。
			_, _ = s.openPublishHealthCheck(ctx, t.WorkspaceID, t.AccountID, t.Platform, "patrol", uuid.Nil)
		}
		if t.State == "scheduled" && t.PlatformAt == nil {
			s.recordPublishDrift(ctx, t.ID, t.WorkspaceID, "platform_schedule_missing",
				nil, nil, "scheduled 任务缺少平台定时")
		}
		if publishScheduleDrift(t.PlanAt, t.PlatformAt) {
			s.recordPublishDrift(ctx, t.ID, t.WorkspaceID, "schedule_drift",
				t.PlanAt, t.PlatformAt, "平台定时与计划定时偏差超过 60 秒")
		}
		s.touchJobMarker(ctx, marker)
	}
}

// shouldRunPatrol 读 job_marker(key,created_at) 游标；同任务 15 分钟内只跑一轮。
// job_marker 是既有一次性标记表，这里以“最近一轮巡检时间”复用：upsert 更新 created_at。
func (s *Server) shouldRunPatrol(ctx context.Context, marker string, interval time.Duration) bool {
	var last *time.Time
	_ = s.db.QueryRow(ctx, `SELECT created_at FROM job_marker WHERE key=$1`, marker).Scan(&last)
	return last == nil || s.now().Sub(*last) >= interval
}

func (s *Server) touchJobMarker(ctx context.Context, marker string) {
	_, _ = s.db.Exec(ctx, `INSERT INTO job_marker (key, created_at)
		VALUES ($1, now())
		ON CONFLICT (key) DO UPDATE SET created_at=now()`, marker)
}

// recordPublishDrift 写 drift 事件 + publish_drift 通知；1 小时窗口内去重
// （通知 dedupe 按小时窗，事件仍逐条记录便于审计）。
func (s *Server) recordPublishDrift(ctx context.Context, taskID, workspaceID uuid.UUID,
	kind string, planned, platform *time.Time, message string) {
	var state string
	if err := s.db.QueryRow(ctx, `SELECT state FROM publish_task WHERE id=$1`, taskID).Scan(&state); err != nil {
		return
	}
	if state == "published" {
		// 已公开任务不再产生漂移告警。
		return
	}
	now := s.now()
	evidence := map[string]any{"drift_kind": kind, "message": message}
	if planned != nil {
		evidence["planned_at"] = planned.UTC().Format(time.RFC3339Nano)
	}
	if platform != nil {
		evidence["platform_at"] = platform.UTC().Format(time.RFC3339Nano)
	}
	// 1 小时窗口内同类漂移只记一次事件（P7-A4 去重口径；事件与通知同窗）。
	var recent int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task_event
		WHERE task_id=$1 AND event_kind='drift'
		AND evidence->>'drift_kind'=$2 AND created_at > now() - interval '1 hour'`,
		taskID, kind).Scan(&recent)
	if recent > 0 {
		return
	}
	raw := jsonArg(evidence)
	if _, err := s.db.Exec(ctx, `INSERT INTO publish_task_event
		(task_id, from_state, to_state, state_version, event_kind, evidence, note, idempotency_key, request_hash)
		VALUES ($1, $2, $2, (SELECT state_version FROM publish_task WHERE id=$1), 'drift', $3, $4,
		$5, $6)`,
		taskID, state, raw, message, "drift:"+taskID.String()+":"+kind+":"+now.Format("2006010215"),
		sha256Hex(raw)); err != nil {
		return
	}
	plannedText, platformText := "未记录", "未记录"
	if planned != nil {
		plannedText = planned.Local().Format("01-02 15:04")
	}
	if platform != nil {
		platformText = platform.Local().Format("01-02 15:04")
	}
	// 巡检不修改平台定时；建议用户到平台后台核对。
	body := "计划时间 " + plannedText + "，平台时间 " + platformText +
		"。巡检不会替你改平台时间；请到平台后台核对定时或链接。"
	s.notifyWorkspace(ctx, workspaceID, []string{"owner", "admin", "member"}, "publish_drift",
		"发布定时漂移提醒", body, "/ops", "publish-drift:"+taskID.String()+":"+now.Format("20060102")+"-"+now.Format("15"))
}
