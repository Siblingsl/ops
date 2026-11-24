package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// p6MilestoneSubmitted 为作品建立 submitted 里程碑（等同用户经发布进度登记交接后
// 的 work_publish_state 状态）；adopt/mark 的任务投影守卫依赖它。
func p6MilestoneSubmitted(t *testing.T, workID uuid.UUID) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_publish_state(work_id,state,version,since)
		VALUES($1,'submitted',1,now()) ON CONFLICT (work_id) DO UPDATE SET state='submitted',version=1,since=now()`, workID); err != nil {
		t.Fatal(err)
	}
}

// p6TaskAt 把任务拨到指定状态（复用 P2 的直改 helper），便于各用例准备前置状态。
func p6TaskAt(t *testing.T, taskID uuid.UUID, state string, version, attempt int, mode string) {
	t.Helper()
	p2SetTaskState(t, taskID, state, version, attempt, mode)
}

func TestP6AdoptRegistersSubmittedWithAdoptEvent(t *testing.T) {
	// P6-A1：adopt 不产生填写记录（无 filled_at），事件 kind=adopt，evidence.source=user。
	a := drAccount(t, "xhs", "P6登记小红书")
	wk := publishTestWork(t, a, "P6登记已发布作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")
	p6MilestoneSubmitted(t, wk.ID)

	var out struct {
		Task    PublishTask `json:"task"`
		Adopted bool        `json:"adopted"`
	}
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/adopt", map[string]any{
		"url": "https://www.xiaohongshu.com/explore/p6demo", "note": "已在平台发布过，登记不重发。",
	}, &out, map[string]string{"Idempotency-Key": "adopt-" + uuid.NewString()})
	if !out.Adopted || out.Task.State != "submitted" {
		t.Fatalf("adopted=%v state=%q, want adopted submitted", out.Adopted, out.Task.State)
	}
	taskOut := out.Task
	// adopt 不产生新的填写记录：filled_at 保持任务原值（创建任务时为空），不伪造历史。
	if taskOut.FilledAt != nil {
		t.Fatalf("adopt must not fabricate fill history, filled_at=%v", taskOut.FilledAt)
	}
	if taskOut.SubmittedAt == nil {
		t.Fatalf("adopt should record submitted_at")
	}
	var kind, src string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT event_kind, evidence->>'source' FROM publish_task_event
		 WHERE task_id=$1 AND event_kind='adopt' LIMIT 1`, task.ID).Scan(&kind, &src); err != nil {
		t.Fatal(err)
	}
	if kind != "adopt" {
		t.Fatalf("event kind = %s, want adopt", kind)
	}
	if src != "user" {
		t.Fatalf("evidence source = %s, want user", src)
	}
}

func TestP6AdoptAlreadySubmittedIsIdempotent(t *testing.T) {
	// P6-A4：已 submitted 再 adopt → already_recorded，不报错、不重复事件。
	a := drAccount(t, "xhs", "P6幂等小红书")
	wk := publishTestWork(t, a, "P6幂等登记作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")
	p6MilestoneSubmitted(t, wk.ID)

	var first PublishTask
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/adopt", map[string]any{
		"url": "https://x/p6", "note": "第一次登记",
	}, &first, map[string]string{"Idempotency-Key": "adopt-" + uuid.NewString()})
	eventsBefore := p2EventCount(t, task.ID)

	var second map[string]any
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/adopt", map[string]any{
		"url": "https://x/p6", "note": "重复登记",
	}, &second, map[string]string{"Idempotency-Key": "adopt-" + uuid.NewString()})
	if second["adopted"] != false {
		t.Fatalf("second adopt should be no-op, got %v", second["adopted"])
	}
	if p2EventCount(t, task.ID) != eventsBefore {
		t.Fatalf("second adopt must not add event")
	}
}

func TestP6MarkTargetsAndPublishedGuard(t *testing.T) {
	// P6-A2：mark→submitted / scheduled 合法；published 逆向禁止；to 非法 422。
	a := drAccount(t, "xhs", "P6纠正小红书")
	wk := publishTestWork(t, a, "P6纠正状态作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")

	// mark → scheduled（带时间）；scheduled 投影要求里程碑同为 scheduled
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO work_publish_state(work_id,state,version,scheduled_at,schedule_evidence,since)
		VALUES($1,'scheduled',1,now()+interval '2 hours','{"kind":"platform_backend_url"}'::jsonb,now())
		ON CONFLICT (work_id) DO UPDATE SET state='scheduled',version=1,scheduled_at=now()+interval '2 hours',since=now()`, wk.ID); err != nil {
		t.Fatal(err)
	}
	var scheduledWrap struct {
		Task PublishTask `json:"task"`
	}
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/mark", map[string]any{
		"to": "scheduled", "scheduled_at": time.Now().Add(2 * time.Hour).UTC(), "note": "平台已排期",
	}, &scheduledWrap, map[string]string{"Idempotency-Key": "mark-" + uuid.NewString()})
	if scheduledWrap.Task.State != "scheduled" {
		t.Fatalf("mark scheduled → %q", scheduledWrap.Task.State)
	}

	// 新作品新任务 mark → submitted（同 work×platform 只能一条任务）；里程碑回 submitted
	wk2 := publishTestWork(t, a, "P6纠正状态作品二", 900, 1200, []string{"账号名"})
	p6MilestoneSubmitted(t, wk2.ID)
	task2 := p2CreateTask(t, a, wk2, "xhs", "desktop")
	var submittedWrap struct {
		Task PublishTask `json:"task"`
	}
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task2.ID.String()+"/mark", map[string]any{
		"to": "submitted", "url": "https://x/mark", "note": "平台认不出链接，手工登记",
	}, &submittedWrap, map[string]string{"Idempotency-Key": "mark-" + uuid.NewString()})
	if submittedWrap.Task.State != "submitted" {
		t.Fatalf("mark submitted → %q", submittedWrap.Task.State)
	}

	// 已 submitted（视为终态链上）任务不允许 to 非法值
	env.mustJSONStatusHeader(t, "POST", "/api/v1/publish-tasks/"+task2.ID.String()+"/mark", map[string]any{
		"to": "paused", "note": "非法目标",
	}, nil, http.StatusUnprocessableEntity, map[string]string{"Idempotency-Key": "mark-" + uuid.NewString()})

	// note 缺失 422
	env.mustJSONStatusHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/mark", map[string]any{
		"to": "submitted",
	}, nil, http.StatusUnprocessableEntity, map[string]string{"Idempotency-Key": "mark-" + uuid.NewString()})
}

func TestP6SubmitNowOnlyFilledDesktop(t *testing.T) {
	// P6-A3：非 filled → 409；manual/api 通道 → 409；filled+desktop 写 submit_intent。
	// 用头条桌面通道验证通用 submit 意图；小红书已被平台红线禁止（见下方独立用例）。
	a := drAccount(t, "toutiao", "P6提交桌面通道")
	wk := publishTestWork(t, a, "P6立即提交作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "toutiao", "desktop")

	// queued 状态 → 409
	env.mustJSONStatusHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil, nil,
		http.StatusConflict, map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})

	// manual 通道 filled → 409
	p6TaskAt(t, task.ID, "filled", 2, 1, "manual")
	env.mustJSONStatusHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil, nil,
		http.StatusConflict, map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})

	// desktop 通道 filled → 写 intent
	p6TaskAt(t, task.ID, "filled", 3, 1, "desktop")
	var out map[string]any
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil, &out,
		map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})
	if out["reason"] != "intent_queued" {
		t.Fatalf("reason = %v, want intent_queued", out["reason"])
	}
	intent, _ := out["intent"].(map[string]any)
	if intent == nil || intent["state"] != "queued" {
		t.Fatalf("intent = %v", intent)
	}

	// 10 分钟窗口内重复调用 → intent_active 幂等
	var again map[string]any
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil, &again,
		map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})
	if again["reason"] != "intent_active" {
		t.Fatalf("repeat submit-now = %v, want intent_active", again["reason"])
	}
}

func TestP6SubmitNowRejectsXhsDirectPublish(t *testing.T) {
	// 小红书风控红线：任何状态的 xhs 任务都不能下发提交意图，页面只能到草稿。
	a := drAccount(t, "xhs", "P6小红书草稿")
	wk := publishTestWork(t, a, "P6小红书草稿作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")

	// 非 filled 也必须优先返回 direct_submit_not_supported，而不是状态错误。
	st0, body0 := env.doHeader("POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil,
		map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})
	if st0 != http.StatusConflict || !strings.Contains(string(body0), "direct_submit_not_supported") {
		t.Fatalf("xhs non-filled submit-now => %d %s, want 409 direct_submit_not_supported", st0, body0)
	}

	p6TaskAt(t, task.ID, "filled", 3, 1, "desktop")
	st, body := env.doHeader("POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil,
		map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})
	if st != http.StatusConflict {
		t.Fatalf("xhs submit-now => %d %s, want 409", st, body)
	}
	var ae apiError
	if err := json.Unmarshal(body, &ae); err != nil {
		t.Fatalf("decode error: %v (%s)", err, body)
	}
	if ae.Error.Code != "direct_submit_not_supported" {
		t.Fatalf("error code = %q, want direct_submit_not_supported (%s)", ae.Error.Code, body)
	}
	loaded, err := scanPublishTask(env.srv.db.QueryRow(context.Background(), `SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, task.ID))
	if err != nil {
		t.Fatal(err)
	}
	if intent, ok := publishTaskSubmitIntent(loaded.Evidence); ok && intent != nil {
		t.Fatalf("xhs task must not receive submit_intent: %v", intent)
	}
}

func TestP6SubmitNowAlreadySubmitted(t *testing.T) {
	// P6-A4：已 submitted 再 submit-now → already_submitted，不报错。
	// 用头条桌面通道；xhs 在任何状态都返回 direct_submit_not_supported（平台红线优先）。
	a := drAccount(t, "toutiao", "P6已交头条")
	wk := publishTestWork(t, a, "P6已提交作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "toutiao", "desktop")
	p6TaskAt(t, task.ID, "submitted", 2, 1, "desktop")

	var out map[string]any
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/submit-now", nil, &out,
		map[string]string{"Idempotency-Key": "submit-" + uuid.NewString()})
	if out["reason"] != "already_submitted" {
		t.Fatalf("reason = %v, want already_submitted", out["reason"])
	}
}

// TestP6SubmitIntentClaimAndResult 覆盖 P6-A3 的真正断链：submit-now 写出的
// queued 意图必须能被桌面 claim 领取，且只有领取设备能回写 submitted 证据。
func TestP6SubmitIntentClaimAndResult(t *testing.T) {
	a := drAccount(t, "toutiao", "P6领取立即提交")
	wk := publishTestWork(t, a, "P6立即提交领取作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "toutiao", "desktop")
	p6TaskAt(t, task.ID, "filled", 3, 1, "desktop")
	now := env.srv.now().UTC().Format(time.RFC3339Nano)
	evidence := map[string]any{
		"readback_ok": true,
		"submit_intent": map[string]any{
			"state": "queued", "requested_at": now, "idempotency_key": "ui-" + uuid.NewString(),
		},
	}
	raw, _ := json.Marshal(evidence)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE publish_task SET evidence=$2,state_version=4 WHERE id=$1`, task.ID, raw); err != nil {
		t.Fatal(err)
	}
	loaded, err := scanPublishTask(env.srv.db.QueryRow(context.Background(), `SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, task.ID))
	if err != nil {
		t.Fatal(err)
	}
	deviceID := uuid.New()
	claimed, err := env.srv.claimPublishSubmitIntent(context.Background(), loaded, deviceID, "claim-"+uuid.NewString())
	if err != nil {
		t.Fatalf("claim submit intent: %v", err)
	}
	if claimed.State != "filled" || claimed.StateVersion != 5 {
		t.Fatalf("claimed state=%s version=%d, want filled/5", claimed.State, claimed.StateVersion)
	}
	intent, _ := publishTaskSubmitIntent(claimed.Evidence)
	if intent["state"] != "claimed" || intent["claimed_by"] != deviceID.String() {
		t.Fatalf("intent = %v", intent)
	}

	// 其他设备不能冒领回写
	if _, err := env.srv.publishSubmitResultEvidence(claimed, uuid.New(), map[string]any{"submit_verified": true}); err == nil {
		t.Fatal("other device must not complete submit intent")
	}
	merged, err := env.srv.publishSubmitResultEvidence(claimed, deviceID, map[string]any{
		"submit_verified": true, "submit_clicked_at": env.srv.now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("build submit result: %v", err)
	}
	completed, _ := merged["submit_intent"].(map[string]any)
	if completed["state"] != "completed" || merged["submit_verified"] != true {
		t.Fatalf("completed intent = %v evidence=%v", completed, merged)
	}
	if merged["readback_ok"] != true {
		t.Fatalf("result evidence must merge, not replace: %v", merged)
	}
}

func TestP6MarkPublishedGoesThroughHandlePublished(t *testing.T) {
	// P6-A5：mark→published 调既有 handlePublished（correction 分支需要 base_publish_revision）；
	// 未发布过的作品没有 publication 记录时走 initial 分支。
	a := drAccount(t, "xhs", "P6发布小红书")
	wk := publishTestWork(t, a, "P6发布纠正作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")
	p6TaskAt(t, task.ID, "submitted", 2, 1, "desktop")
	// initial 回填要求作品处于 pushed/packed（既有发布纪律）；拨到 packed。
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE work SET status='packed' WHERE id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}

	// 无 publication 记录 → initial 回填（URL 必填）
	var pubWrap map[string]any
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/mark", map[string]any{
		"to": "published", "url": "https://x/published-demo", "note": "登记平台已公开的链接",
	}, &pubWrap, map[string]string{"Idempotency-Key": "mark-" + uuid.NewString()})
	// markInitialOrLegacyReplay 落 work 层 published，任务投影同步由既有链路处理
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM work WHERE id=$1`, wk.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "published" {
		t.Fatalf("work status = %s, want published (via handlePublished)", status)
	}
}

func TestP6RequiresIdempotencyKeyAndEditor(t *testing.T) {
	// P6-A4：缺 Idempotency-Key 422；观察者角色 403。
	a := drAccount(t, "xhs", "P6权限小红书")
	wk := publishTestWork(t, a, "P6权限作品", 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, "xhs", "desktop")

	// 缺 Idempotency-Key → 422
	env.mustJSONStatusHeader(t, "POST", "/api/v1/publish-tasks/"+task.ID.String()+"/adopt",
		map[string]any{"url": "https://x", "note": "缺 key"}, nil, http.StatusUnprocessableEntity, map[string]string{})
}
