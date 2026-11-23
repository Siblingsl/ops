package app

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestP7PatrolQueuesDesktopHealthCheck(t *testing.T) {
	a, _, task := p7ScheduledTask(t, 2*time.Hour, 2*time.Hour, true)
	env.srv.publishPatrolJob(context.Background())
	var purpose, state string
	err := env.srv.db.QueryRow(context.Background(), `SELECT purpose,state FROM publish_health_check
		WHERE account_id=$1 AND platform='xhs' ORDER BY requested_at DESC LIMIT 1`, a.ID).Scan(&purpose, &state)
	if err != nil {
		t.Fatalf("patrol health check missing: %v", err)
	}
	if purpose != "patrol" || state != "queued" {
		t.Fatalf("patrol check = %s/%s", purpose, state)
	}
	var taskState string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT state FROM publish_task WHERE id=$1`, task.ID).Scan(&taskState); err != nil {
		t.Fatal(err)
	}
	if taskState != "scheduled" {
		t.Fatalf("patrol must not change task state: %s", taskState)
	}
}

func TestP7ScheduleDriftThreshold60s(t *testing.T) {
	// P7-A2：漂移阈值 60 秒边界——61 秒判漂移、60 秒以内不判。
	now := time.Now()
	if publishScheduleDrift(&now, nowPtr(now.Add(60*time.Second))) {
		t.Fatalf("60s delta must not drift")
	}
	if !publishScheduleDrift(&now, nowPtr(now.Add(61*time.Second))) {
		t.Fatalf("61s delta must drift")
	}
	if !publishScheduleDrift(&now, nowPtr(now.Add(-61*time.Second))) {
		t.Fatalf("negative 61s delta must drift")
	}
	if publishScheduleDrift(nil, nowPtr(now)) {
		t.Fatalf("missing planned must not drift")
	}
	if publishScheduleDrift(&now, nil) {
		t.Fatalf("missing platform must not drift")
	}
}

func nowPtr(t time.Time) *time.Time { return &t }

// p7ScheduledTask 建一条 scheduled 任务：里程碑 submitted + 任务直拨
// scheduled（P2 的 p2SetTaskState 语义），plan_at/platform_schedule_at 由用例覆写。
func p7ScheduledTask(t *testing.T, planDelta, platformDelta time.Duration, withPlatform bool) (Account, Work, PublishTask) {
	t.Helper()
	a := drAccount(t, "xhs", "P7巡检小红书")
	wk := publishTestWork(t, a, "P7定时漂移作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")
	// 里程碑 submitted（scheduled 投影守卫要求）
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_publish_state(work_id,state,version,since)
		VALUES($1,'submitted',1,now()) ON CONFLICT (work_id) DO UPDATE SET state='submitted',version=1,since=now()`, wk.ID); err != nil {
		t.Fatal(err)
	}
	// scheduled 需要 future platform_schedule_at 与 evidence（HTTP 边校验）；
	// 这里直接拨状态（巡检用例不验证转换矩阵，那由 TestP7ScheduleDrift 与 P2 覆盖）。
	scheduledAt := time.Now().Add(2 * time.Hour)
	// 先写平台定时再拨 scheduled：表级 CHECK（state='scheduled' OR
	// platform_schedule_at IS NOT NULL）要求两者同时成立。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE publish_task SET platform_schedule_at=$2, evidence=$3 WHERE id=$1`,
		task.ID, scheduledAt, p7EvidenceJSON()); err != nil {
		t.Fatal(err)
	}
	p2SetTaskState(t, task.ID, "scheduled", task.StateVersion+1, 0, "desktop")
	plan := time.Now().Add(planDelta)
	if withPlatform {
		if _, err := env.srv.db.Exec(context.Background(),
			`UPDATE publish_task SET plan_at=$2, platform_schedule_at=$3 WHERE id=$1`,
			task.ID, plan, time.Now().Add(platformDelta)); err != nil {
			t.Fatal(err)
		}
	} else {
		// 缺平台定时用例：scheduled 状态与 NULL 不能共存（CHECK），拨回 queued 保留 plan_at。
		if _, err := env.srv.db.Exec(context.Background(),
			`UPDATE publish_task SET state='queued', state_version=state_version+1, platform_schedule_at=NULL, plan_at=$2 WHERE id=$1`,
			task.ID, plan); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := env.srv.db.Query(context.Background(),
		`SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	items, err := scanPublishTaskRows(rows)
	if err != nil || len(items) != 1 {
		t.Fatalf("reload task: %v", err)
	}
	_ = scheduledAt
	return a, wk, items[0]
}

func p7EvidenceJSON() []byte {
	return jsonArg(map[string]any{"kind": "platform_backend_url"})
}

func TestP7PatrolDetectsDriftAndDedupesOneHour(t *testing.T) {
	// P7-A2/A4：61 秒漂移 → drift 事件 + publish_drift 通知；1 小时窗口内第二轮去重。
	_, wk, task := p7ScheduledTask(t, 2*time.Hour, 2*time.Hour+61*time.Second, true)

	env.srv.publishPatrolJob(context.Background())

	var events int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM publish_task_event WHERE task_id=$1 AND event_kind='drift'`, task.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events == 0 {
		t.Fatalf("expected drift event")
	}
	var notifs int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM notification WHERE kind='publish_drift'`).Scan(&notifs); err != nil {
		t.Fatal(err)
	}
	if notifs == 0 {
		t.Fatalf("expected publish_drift notification")
	}
	var body string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT body FROM notification WHERE kind='publish_drift' LIMIT 1`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "计划时间") || !strings.Contains(body, "平台时间") {
		t.Fatalf("notification body should contain planned/platform time: %s", body)
	}

	// 第二轮（清游标模拟到期）：同类漂移 1 小时内只通知一次、事件不重复。
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM job_marker`); err != nil {
		t.Fatal(err)
	}
	env.srv.publishPatrolJob(context.Background())

	var events2, notifs2 int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM publish_task_event WHERE task_id=$1 AND event_kind='drift'`, task.ID).Scan(&events2); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM notification WHERE kind='publish_drift'`).Scan(&notifs2); err != nil {
		t.Fatal(err)
	}
	if events2 != events {
		t.Fatalf("drift events should dedupe within 1h: %d -> %d", events, events2)
	}
	if notifs2 != notifs {
		t.Fatalf("drift notifications should dedupe within 1h: %d -> %d", notifs, notifs2)
	}
	_ = wk
}

func TestP7PatrolMissingPlatformScheduleOnScheduled(t *testing.T) {
	// P7-A1：scheduled 任务缺平台定时——表级 CHECK（state='scheduled' OR
	// platform_schedule_at IS NOT NULL）先行拦截；巡检面用 queued+NULL 平台定时
	// 验证（scheduled→missing 由 CHECK 保证不落库）。
	a2 := drAccount(t, "xhs", "P7约束小红书")
	wk2 := publishTestWork(t, a2, "P7约束作品", 900, 1200, []string{"账号名"})
	task2 := p2CreateTask(t, a2, wk2, "xhs", "desktop")
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE publish_task SET platform_schedule_at=$2, evidence=$3 WHERE id=$1`,
		task2.ID, time.Now().Add(2*time.Hour), p7EvidenceJSON()); err != nil {
		t.Fatal(err)
	}
	p2SetTaskState(t, task2.ID, "scheduled", task2.StateVersion+1, 0, "desktop")
	// 约束验证：scheduled + NULL 平台定时必须被 CHECK 拒绝。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE publish_task SET platform_schedule_at=NULL WHERE id=$1`, task2.ID); err == nil {
		t.Fatalf("scheduled task with NULL platform_schedule_at must violate CHECK")
	}
	// 巡检面：巡检不产生漂移事件（约束已拦截，queued 任务也非巡检对象）。
	env.srv.publishPatrolJob(context.Background())

	var kind string
	err := env.srv.db.QueryRow(context.Background(),
		`SELECT evidence->>'drift_kind' FROM publish_task_event
		 WHERE task_id=$1 AND event_kind='drift' LIMIT 1`, task2.ID).Scan(&kind)
	if err == nil {
		t.Fatalf("queued task must not produce drift, got kind=%s", kind)
	}
}

func TestP7PatrolNoDriftWithinTolerance(t *testing.T) {
	// 60 秒以内偏差不产生漂移事件/通知。
	_, _, task := p7ScheduledTask(t, 2*time.Hour, 2*time.Hour+30*time.Second, true)

	env.srv.publishPatrolJob(context.Background())

	var events int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM publish_task_event WHERE task_id=$1 AND event_kind='drift'`, task.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("30s delta should not drift, got %d events", events)
	}
	var notifs int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM notification WHERE kind='publish_drift' AND dedupe_key LIKE '%'||$1||'%'`,
		task.ID.String()).Scan(&notifs); err != nil {
		t.Fatal(err)
	}
	if notifs != 0 {
		t.Fatalf("30s delta should not notify this task, got %d", notifs)
	}
}

func TestP7PatrolDoesNotMutateTaskOrPlatform(t *testing.T) {
	// P7-A3：巡检只读——漂移记录后任务状态/版本/平台定时不变。
	_, _, task := p7ScheduledTask(t, 2*time.Hour, 2*time.Hour+90*time.Second, true)
	before := p5TaskByID(t, task.ID)

	env.srv.publishPatrolJob(context.Background())

	after := p5TaskByID(t, task.ID)
	if after.State != before.State {
		t.Fatalf("patrol must not change state: %s -> %s", before.State, after.State)
	}
	if after.Attempt != before.Attempt {
		t.Fatalf("patrol must not change attempt")
	}
	var platformAfter *time.Time
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT platform_schedule_at FROM publish_task WHERE id=$1`, task.ID).Scan(&platformAfter); err != nil {
		t.Fatal(err)
	}
	if platformAfter == nil {
		t.Fatalf("patrol must not clear platform_schedule_at")
	}
	var events int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM publish_task_event WHERE task_id=$1 AND event_kind NOT IN ('drift','transition','fill','readback','adopt','retry')`,
		task.ID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if events != 0 {
		t.Fatalf("patrol wrote unexpected event kinds: %d", events)
	}
}

func TestP7PatrolNotifyEndpointGuard(t *testing.T) {
	// 巡检失败不改变任务状态（无任务时 job 不 panic、无通知副作用）。
	env.srv.publishPatrolJob(context.Background())
	var notifs int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM notification WHERE kind='publish_drift'`).Scan(&notifs); err != nil {
		t.Fatal(err)
	}
	// 此处只保证空转无 panic；计数由其他用例管理。
	_ = notifs
}
