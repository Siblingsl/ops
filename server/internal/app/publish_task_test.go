package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func p2CreateTask(t *testing.T, a Account, wk Work, platform, mode string) PublishTask {
	t.Helper()
	publishBuild(t, wk.ID.String(), platform)
	var result createPublishTasksResult
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks", map[string]any{
		"platforms": []string{platform}, "mode": mode,
	}, &result)
	if len(result.Tasks) != 1 {
		t.Fatalf("create P2 task: %+v", result)
	}
	return result.Tasks[0]
}

func p2TaskTransition(t *testing.T, taskID uuid.UUID, body map[string]any) PublishTask {
	t.Helper()
	var out PublishTask
	env.mustJSON(t, "POST", "/api/v1/publish-tasks/"+taskID.String()+"/transition", body, &out)
	return out
}

func p2SetTaskState(t *testing.T, taskID uuid.UUID, state string, version, attempt int, mode string) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE publish_task
		SET state=$2,state_version=$3,attempt=$4,mode=$5,updated_at=now() WHERE id=$1`,
		taskID, state, version, attempt, mode); err != nil {
		t.Fatal(err)
	}
}

func p2Milestone(t *testing.T, workID uuid.UUID, state string) {
	t.Helper()
	if state == "scheduled" {
		at := env.srv.now().Add(2 * time.Hour)
		_, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_publish_state
			(work_id,state,version,scheduled_at,schedule_evidence,since)
			VALUES($1,'scheduled',1,$2,'{"kind":"platform_backend_url"}'::jsonb,now())
			ON CONFLICT (work_id) DO UPDATE SET state='scheduled',version=1,scheduled_at=$2,
			schedule_evidence='{"kind":"platform_backend_url"}'::jsonb,since=now()`, workID, at)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	_, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_publish_state(work_id,state,version,since)
		VALUES($1,$2,1,now()) ON CONFLICT (work_id) DO UPDATE SET state=$2,version=1,since=now()`, workID, state)
	if err != nil {
		t.Fatal(err)
	}
}

func p2EventCount(t *testing.T, taskID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_task_event WHERE task_id=$1`, taskID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestP2DesktopClaimViewIncludesManifestAndAccount(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2桌面领取视图")
	wk := publishTestWork(t, a, "P2桌面领取视图作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "desktop")
	queued := p2TaskTransition(t, task.ID, map[string]any{
		"to": "queued", "expected_version": 1, "idempotency_key": uuid.NewString(),
	})

	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), ctxMember, &identity{WorkspaceID: workspaceID})
	view, err := env.srv.publishTaskClaimView(ctx, &queued, env.srv.now().Add(publishTaskLease))
	if err != nil {
		t.Fatal(err)
	}
	if view["account_name"] != a.Name {
		t.Fatalf("claim account_name = %v, want %s", view["account_name"], a.Name)
	}
	payload, ok := view["manifest"].(PublishManifestPayload)
	if !ok {
		t.Fatalf("claim manifest type = %T", view["manifest"])
	}
	if payload.Fields.Title != wk.Title {
		t.Fatalf("claim manifest title = %q, want %q", payload.Fields.Title, wk.Title)
	}
	if revision, ok := view["manifest_revision"].(int); !ok || revision < 1 {
		t.Fatalf("claim manifest_revision = %v", view["manifest_revision"])
	}
	if hash, ok := view["manifest_content_hash"].(string); !ok || hash == "" {
		t.Fatalf("claim manifest_content_hash = %v", view["manifest_content_hash"])
	}
}

func TestP2TransitionMatrix(t *testing.T) {
	states := []string{"ready", "queued", "filling", "filled", "awaiting_user", "submitted", "scheduled", "published", "failed", "not_logged_in", "skipped", "stopped"}
	legal := map[string]map[string]bool{
		"ready":         {"queued": true, "awaiting_user": true, "submitted": true, "scheduled": true, "stopped": true, "skipped": true},
		"queued":        {"filling": true, "stopped": true, "skipped": true},
		"filling":       {"filled": true, "failed": true, "not_logged_in": true, "stopped": true, "skipped": true},
		"filled":        {"awaiting_user": true, "submitted": true, "stopped": true, "skipped": true},
		"awaiting_user": {"submitted": true, "stopped": true, "skipped": true},
		"failed":        {"queued": true, "submitted": true, "scheduled": true, "stopped": true, "skipped": true},
		"not_logged_in": {"queued": true, "submitted": true, "scheduled": true, "stopped": true, "skipped": true},
		"submitted":     {"scheduled": true, "published": true, "stopped": true, "skipped": true},
		"scheduled":     {"published": true, "stopped": true, "skipped": true},
		"published":     {},
		"skipped":       {},
		"stopped":       {},
	}
	for _, from := range states {
		for _, to := range states {
			want := legal[from][to]
			if got := publishTaskTransitionAllowed(from, to); got != want {
				t.Errorf("%s -> %s: got %v want %v", from, to, got, want)
			}
		}
	}
}

func TestP2InvalidEdgeReturns409(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2非法边")
	wk := publishTestWork(t, a, "P2非法边作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	ae := expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/transition", map[string]any{
		"to": "filled", "expected_version": 1, "idempotency_key": uuid.NewString(),
		"evidence": map[string]any{"readback_ok": true},
	}, http.StatusConflict, "publish_task_state_invalid")
	if ae.Error.Code == "" {
		t.Fatal("expected API error code")
	}
}

func TestP2CreateUniqueAndQueue(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2排队")
	wk := publishTestWork(t, a, "P2排队作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")

	var again createPublishTasksResult
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks", map[string]any{
		"platforms": []string{"wechat_mp"}, "mode": "api",
	}, &again)
	if len(again.Created) != 0 || len(again.Skipped) != 1 {
		t.Fatalf("重复创建必须复用: %+v", again)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_task WHERE work_id=$1 AND platform='wechat_mp'`, wk.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("同 work×platform 只能有一条任务，got %d", count)
	}

	queued := p2TaskTransition(t, task.ID, map[string]any{
		"to": "queued", "expected_version": 1, "idempotency_key": uuid.NewString(),
	})
	if queued.State != "queued" || queued.StateVersion != 2 {
		t.Fatalf("queue: %+v", queued)
	}
}

func TestP2IdempotencyReplayAndConflict(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2幂等")
	wk := publishTestWork(t, a, "P2幂等作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	key := uuid.NewString()
	body := map[string]any{"to": "queued", "expected_version": 1, "idempotency_key": key}
	first := p2TaskTransition(t, task.ID, body)
	second := p2TaskTransition(t, task.ID, body)
	if first.ID != second.ID || second.State != "queued" || second.StateVersion != 2 {
		t.Fatalf("same key/payload must replay: first=%+v second=%+v", first, second)
	}
	if n := p2EventCount(t, task.ID); n != 2 {
		t.Fatalf("create event + one transition event expected, got %d", n)
	}
	conflict := map[string]any{"to": "queued", "expected_version": 1, "idempotency_key": key,
		"evidence": map[string]any{"changed": true}}
	expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/transition", conflict,
		http.StatusConflict, "idempotency_conflict")
}

func TestP2LegalEdgesHTTP(t *testing.T) {
	// ready -> awaiting_user（manual）
	a := drAccount(t, "wechat_mp", "P2人工通道")
	wk := publishTestWork(t, a, "P2人工作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "manual")
	got := p2TaskTransition(t, task.ID, map[string]any{"to": "awaiting_user", "expected_version": 1, "idempotency_key": uuid.NewString()})
	if got.State != "awaiting_user" {
		t.Fatalf("manual ready->awaiting_user: %+v", got)
	}

	// ready -> queued -> filling -> filled -> awaiting_user
	a = drAccount(t, "wechat_mp", "P2填写链路")
	wk = publishTestWork(t, a, "P2填写链路作品", 900, 900, nil)
	task = p2CreateTask(t, a, wk, "wechat_mp", "api")
	queued := p2TaskTransition(t, task.ID, map[string]any{"to": "queued", "expected_version": 1, "idempotency_key": uuid.NewString()})
	filling := p2TaskTransition(t, queued.ID, map[string]any{"to": "filling", "expected_version": 2, "idempotency_key": uuid.NewString()})
	filled := p2TaskTransition(t, filling.ID, map[string]any{"to": "filled", "expected_version": 3, "idempotency_key": uuid.NewString(), "evidence": map[string]any{"readback": map[string]any{"ok": true}}})
	awaiting := p2TaskTransition(t, filled.ID, map[string]any{"to": "awaiting_user", "expected_version": 4, "idempotency_key": uuid.NewString(), "evidence": map[string]any{"screenshot_asset_id": uuid.NewString()}})
	if awaiting.State != "awaiting_user" {
		t.Fatalf("filling chain: %+v", awaiting)
	}

	// ready -> submitted，随后 submitted -> scheduled
	a = drAccount(t, "wechat_mp", "P2已提交预约")
	wk = publishTestWork(t, a, "P2已提交预约作品", 900, 900, nil)
	task = p2CreateTask(t, a, wk, "wechat_mp", "api")
	p2Milestone(t, wk.ID, "submitted")
	submitted := p2TaskTransition(t, task.ID, map[string]any{"to": "submitted", "expected_version": 1, "idempotency_key": uuid.NewString()})
	p2Milestone(t, wk.ID, "scheduled")
	at := env.srv.now().Add(time.Hour)
	scheduled := p2TaskTransition(t, submitted.ID, map[string]any{"to": "scheduled", "expected_version": 2, "idempotency_key": uuid.NewString(),
		"platform_schedule_at": at, "evidence": map[string]any{"kind": "platform_backend_url"}})
	if scheduled.State != "scheduled" || scheduled.PlatformScheduleAt == nil {
		t.Fatalf("submitted->scheduled: %+v", scheduled)
	}

	// failed -> queued
	a = drAccount(t, "wechat_mp", "P2失败重试")
	wk = publishTestWork(t, a, "P2失败重试作品", 900, 900, nil)
	task = p2CreateTask(t, a, wk, "wechat_mp", "api")
	p2SetTaskState(t, task.ID, "failed", 2, 1, "api")
	retried := p2TaskTransition(t, task.ID, map[string]any{"to": "queued", "expected_version": 2, "idempotency_key": uuid.NewString()})
	if retried.State != "queued" {
		t.Fatalf("failed->queued: %+v", retried)
	}

	// 任意非终态 -> stopped / skipped
	a = drAccount(t, "wechat_mp", "P2终止")
	wk = publishTestWork(t, a, "P2终止作品", 900, 900, nil)
	task = p2CreateTask(t, a, wk, "wechat_mp", "api")
	stopped := p2TaskTransition(t, task.ID, map[string]any{"to": "stopped", "expected_version": 1, "idempotency_key": uuid.NewString(), "confirm": true})
	if stopped.State != "stopped" {
		t.Fatalf("ready->stopped: %+v", stopped)
	}
	wk = publishTestWork(t, a, "P2跳过作品", 900, 900, nil)
	task = p2CreateTask(t, a, wk, "wechat_mp", "api")
	skipped := p2TaskTransition(t, task.ID, map[string]any{"to": "skipped", "expected_version": 1, "idempotency_key": uuid.NewString(), "reason": "本期不发布"})
	if skipped.State != "skipped" {
		t.Fatalf("ready->skipped: %+v", skipped)
	}
}

func TestP2PublishedOnlyViaMarkPublished(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2公开同步")
	wk := publishTestWork(t, a, "P2公开同步作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	p2SetTaskState(t, task.ID, "submitted", 2, 0, "api")
	p2Milestone(t, wk.ID, "submitted")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='pushed' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/transition", map[string]any{
		"to": "published", "expected_version": 2, "idempotency_key": uuid.NewString(),
	}, http.StatusConflict, "publish_task_state_invalid")

	var result map[string]any
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]any{}, &result)
	var state string
	var publishedAt *time.Time
	if err := env.srv.db.QueryRow(context.Background(), `SELECT state,published_at FROM publish_task WHERE id=$1`, task.ID).Scan(&state, &publishedAt); err != nil {
		t.Fatal(err)
	}
	if state != "published" || publishedAt == nil {
		t.Fatalf("published task projection not synced: state=%s at=%v", state, publishedAt)
	}
}

// TestP2PublishedProjectionIsPlatformScoped：同作品 wechat_mp 任务 submitted 后，
// 若该作品（xhs 平台账号）公开发布，只有 xhs 平台任务翻 published，wechat_mp 任务保持 submitted。
// 发布事实按作品平台归属投影，不得跨平台传染（P4-A3/A5 根因回归）。
func TestP2PublishedProjectionIsPlatformScoped(t *testing.T) {
	// 作品挂在 xhs 账号上：work 自身平台由 account.platform 决定。
	xhs := drAccount(t, "xhs", "P2平台投影xhs")
	wk := publishTestWork(t, xhs, "P2平台投影作品", 900, 1200, []string{"测试"})

	// 同一作品建两个平台的任务并都推到 submitted。
	publishBuild(t, wk.ID.String(), "xhs")
	publishBuild(t, wk.ID.String(), "wechat_mp")
	var created createPublishTasksResult
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/publish-tasks", map[string]any{
		"platforms": []string{"xhs", "wechat_mp"}, "mode": "desktop",
	}, &created)
	if len(created.Tasks) != 2 {
		t.Fatalf("expect 2 tasks across platforms, got %d: %+v", len(created.Tasks), created)
	}
	byPlatform := map[string]PublishTask{}
	for _, task := range created.Tasks {
		byPlatform[task.Platform] = task
	}
	xhsTask, mpTask := byPlatform["xhs"], byPlatform["wechat_mp"]
	if xhsTask.ID == uuid.Nil || mpTask.ID == uuid.Nil {
		t.Fatalf("missing platform tasks: %+v", created)
	}
	p2SetTaskState(t, xhsTask.ID, "submitted", 2, 0, "desktop")
	p2SetTaskState(t, mpTask.ID, "submitted", 2, 0, "desktop")
	p2Milestone(t, wk.ID, "submitted")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='pushed' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}

	// xhs 公开发布回填。
	var result map[string]any
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]any{}, &result)

	var xhsState, mpState string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM publish_task WHERE id=$1`, xhsTask.ID).Scan(&xhsState); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM publish_task WHERE id=$1`, mpTask.ID).Scan(&mpState); err != nil {
		t.Fatal(err)
	}
	if xhsState != "published" {
		t.Fatalf("xhs task should be published, got %s", xhsState)
	}
	if mpState != "submitted" {
		t.Fatalf("wechat_mp task must stay submitted after xhs published, got %s", mpState)
	}
}

func TestP2BatchLimitAndBatchCreation(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2批次")
	works := make([]Work, 0, 21)
	for i := 0; i < 21; i++ {
		works = append(works, publishTestWork(t, a, "P2批次作品"+string(rune('A'+i)), 900, 900, nil))
	}
	ids := make([]uuid.UUID, 0, len(works))
	for _, wk := range works {
		ids = append(ids, wk.ID)
	}
	expectStatusErr(t, "POST", "/api/v1/publish-batches", map[string]any{
		"label": "超过上限", "work_ids": ids, "platforms": []string{"wechat_mp"}, "mode": "api",
	}, http.StatusUnprocessableEntity, "publish_batch_limit")

	batchWorks := works[:2]
	for _, wk := range batchWorks {
		publishBuild(t, wk.ID.String(), "wechat_mp")
	}
	var batch publishBatchResult
	env.mustJSON(t, "POST", "/api/v1/publish-batches", map[string]any{
		"label": "P2批次小样", "work_ids": []uuid.UUID{batchWorks[0].ID, batchWorks[1].ID},
		"platforms": []string{"wechat_mp"}, "mode": "api",
	}, &batch)
	if batch.Batch.Total != 2 || len(batch.Tasks) != 2 || len(batch.Created) != 2 {
		t.Fatalf("batch creation: %+v", batch)
	}
}

func TestP2FillingConcurrencyLimit(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2并发")
	tasks := make([]PublishTask, 0, 3)
	for i := 0; i < 3; i++ {
		wk := publishTestWork(t, a, "P2并发作品"+string(rune('A'+i)), 900, 900, nil)
		task := p2CreateTask(t, a, wk, "wechat_mp", "api")
		p2TaskTransition(t, task.ID, map[string]any{"to": "queued", "expected_version": 1, "idempotency_key": uuid.NewString()})
		tasks = append(tasks, task)
	}
	for i, task := range tasks {
		body := map[string]any{
			"to": "filling", "expected_version": 2, "idempotency_key": uuid.NewString(),
			"evidence": map[string]any{"device_id": "test"},
		}
		if i < 2 {
			got := p2TaskTransition(t, task.ID, body)
			if got.State != "filling" {
				t.Fatalf("task %d fill: %+v", i, got)
			}
		} else {
			expectStatusErr(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/transition", body,
				http.StatusConflict, "publish_task_busy")
		}
	}
}

func TestP2CrossWorkspaceTaskAndBatch404(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P2越权")
	wk := publishTestWork(t, a, "P2越权作品", 900, 900, nil)
	task := p2CreateTask(t, a, wk, "wechat_mp", "api")
	publishBuild(t, wk.ID.String(), "wechat_mp")
	var batch publishBatchResult
	env.mustJSON(t, "POST", "/api/v1/publish-batches", map[string]any{
		"label": "P2越权批次", "work_ids": []uuid.UUID{wk.ID}, "platforms": []string{"wechat_mp"}, "mode": "api",
	}, &batch)

	other := env.registerClient(t, "p2-other-"+uuid.NewString()[:8], testPassword)
	other.use()
	status, body := env.do("GET", "/api/v1/publish-tasks/"+task.ID.String()+"/events", nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross workspace task events: want 404, got %d %s", status, body)
	}
	status, body = env.do("GET", "/api/v1/publish-batches/"+batch.Batch.ID.String(), nil)
	if status != http.StatusNotFound {
		t.Fatalf("cross workspace batch: want 404, got %d %s", status, body)
	}
	other.restore(env)

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	_ = json.RawMessage(body)
}
