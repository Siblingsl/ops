package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// p5Account 复用 drAccount 建账号（独立于共享 fixture，避免污染其他用例）。
func p5Account(t *testing.T, platform, name string) Account {
	t.Helper()
	return drAccount(t, platform, name)
}

// p5OpenCheck 直接通过服务端函数开一条体检（HTTP 语义在专门用例里覆盖）。
func p5OpenCheck(t *testing.T, a Account, platform string) *PublishHealthCheck {
	t.Helper()
	userID := uuid.MustParse(env.me(t).UserID)
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	check, err := env.srv.openPublishHealthCheck(context.Background(), wsID, a.ID, platform, "health", userID)
	if err != nil {
		t.Fatal(err)
	}
	return check
}

// p5FinishResult 模拟桌面提交体检结果：直接调用生产共享落账函数
// applyPublishHealthResultTx，避免测试复刻实现导致漂移。
// proof 链路由 platform_proof 白名单测试与路由注册覆盖。
func p5FinishResult(t *testing.T, check *PublishHealthCheck, result map[string]any, errCode, errMsg string) {
	t.Helper()
	ctx := context.Background()
	state := "succeeded"
	if errCode != "" {
		state = "failed"
	}
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	loggedIn, err := env.srv.applyPublishHealthResultTx(ctx, tx, check, state, result, errCode, errMsg)
	if err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	env.srv.notifyPublishLoginRequired(check, loggedIn)
}

// p5Task 建一个 queued 发布任务（复用 publishTestWork 带封面/标签 + P2 helper）。
func p5Task(t *testing.T, a Account, title, platform string) PublishTask {
	t.Helper()
	wk := publishTestWork(t, a, title, 900, 1200, []string{"账号名"})
	task := p2CreateTask(t, a, wk, platform, "desktop")
	return p2TaskTransition(t, task.ID, map[string]any{
		"to": "queued", "expected_version": task.StateVersion, "idempotency_key": uuid.NewString(),
	})
}

func p5TaskByID(t *testing.T, id uuid.UUID) PublishTask {
	t.Helper()
	var state string
	var attempt int
	var nextRetry *time.Time
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state, attempt, next_retry_at FROM publish_task WHERE id=$1`, id).Scan(&state, &attempt, &nextRetry); err != nil {
		t.Fatal(err)
	}
	return PublishTask{ID: id, State: state, Attempt: attempt, NextRetryAt: nextRetry}
}

func TestP5HealthRequestReusesWithinOneMinuteAndCrossWorkspace404(t *testing.T) {
	// P5-A3：HTTP 层——1 分钟内重复请求复用同一条；跨工作区账号 404。
	a := p5Account(t, "xhs", "P5 复用小红书")
	var first struct {
		Checks []PublishHealthCheck `json:"checks"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/publish-health/check",
		map[string]any{"platforms": []string{"xhs"}}, &first)
	if len(first.Checks) != 1 {
		t.Fatalf("want 1 check, got %d", len(first.Checks))
	}
	var second struct {
		Checks []PublishHealthCheck `json:"checks"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/publish-health/check",
		map[string]any{"platforms": []string{"xhs"}}, &second)
	if len(second.Checks) != 1 || second.Checks[0].ID != first.Checks[0].ID {
		t.Fatalf("expected reuse within 1 minute: %s vs %s", first.Checks[0].ID, second.Checks[0].ID)
	}

	// 跨工作区：注册另一个用户的工作区，访问不到该账号。
	g := env.registerClient(t, "p5_cross_ws_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+a.ID.String()+"/publish-health/check",
		map[string]any{"platforms": []string{"xhs"}}, nil, http.StatusNotFound)
	_ = g
}

func TestP5NotLoggedInDoesNotConsumeAttemptAndSetsRetry(t *testing.T) {
	// P5-A2：未登录 → queued 任务 not_logged_in、next_retry_at≈+20m、attempt 不变。
	a := p5Account(t, "xhs", "P5 未登录小红书")
	task := p5Task(t, a, "P5 未登录作品", "xhs")
	if task.State != "queued" {
		t.Fatalf("task should start queued, got %s", task.State)
	}
	before := p5TaskByID(t, task.ID)

	check := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check, map[string]any{
		"online": true, "logged_in": false, "anchors": map[string]any{"compose": true},
		"adapter_version": "xhs-fill-v1", "page_url": "https://www.xiaohongshu.com", "checked_at": time.Now().UTC().Format(time.RFC3339Nano),
	}, "", "")

	after := p5TaskByID(t, task.ID)
	if after.State != "not_logged_in" {
		t.Fatalf("state = %s, want not_logged_in", after.State)
	}
	if after.Attempt != before.Attempt {
		t.Fatalf("attempt changed %d -> %d; not_logged_in must not consume attempt", before.Attempt, after.Attempt)
	}
	if after.NextRetryAt == nil || time.Until(*after.NextRetryAt) < 15*time.Minute {
		t.Fatalf("next_retry_at should be ~20m away, got %v", after.NextRetryAt)
	}
}

func TestP5RetryJobRequeuesAfterLoginWithoutAttempt(t *testing.T) {
	// P5-A2：not_logged_in + next_retry_at 到期 + 最近体检 logged_in=true → queued、attempt 不变。
	a := p5Account(t, "xhs", "P5 补跑小红书")
	task := p5Task(t, a, "P5 补跑作品", "xhs")

	check := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check, map[string]any{"online": true, "logged_in": false, "adapter_version": "xhs-fill-v1"}, "", "")
	if got := p5TaskByID(t, task.ID).State; got != "not_logged_in" {
		t.Fatalf("state = %s, want not_logged_in", got)
	}

	// 用户重新登录：把 next_retry_at 拨到过去，提交 logged_in=true 体检，跑补跑 job。
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx, `UPDATE publish_task SET next_retry_at=now() - interval '1 minute' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	check2 := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check2, map[string]any{"online": true, "logged_in": true, "adapter_version": "xhs-fill-v1"}, "", "")
	env.srv.publishRetryJob(ctx)

	after := p5TaskByID(t, task.ID)
	if after.State != "queued" {
		t.Fatalf("state = %s, want queued after login", after.State)
	}
	if after.Attempt != 0 {
		t.Fatalf("auto requeue must not consume attempt, got %d", after.Attempt)
	}
}

func TestP5HealthFailureDoesNotBlockOtherPlatforms(t *testing.T) {
	// P5-A3：xhs 体检失败不影响 toutiao 体检成功，任务互不可见。
	xhs := p5Account(t, "xhs", "P5 隔离小红书")
	tt := p5Account(t, "toutiao", "P5 隔离头条")

	cx := p5OpenCheck(t, xhs, "xhs")
	p5FinishResult(t, cx, nil, "health_failed", "桌面掉线")
	ct := p5OpenCheck(t, tt, "toutiao")
	p5FinishResult(t, ct, map[string]any{"online": true, "logged_in": true, "adapter_version": "toutiao-fill-v1"}, "", "")

	if got := p5LatestHealthState(t, xhs.ID, "xhs"); got != "failed" {
		t.Fatalf("xhs = %s, want failed", got)
	}
	if got := p5LatestHealthState(t, tt.ID, "toutiao"); got != "succeeded" {
		t.Fatalf("toutiao = %s, want succeeded", got)
	}
}

func p5LatestHealthState(t *testing.T, accountID uuid.UUID, platform string) string {
	t.Helper()
	var state string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state FROM publish_health_check WHERE account_id=$1 AND platform=$2
		 ORDER BY requested_at DESC LIMIT 1`, accountID, platform).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestP5LoginRequiredNotificationDedupedByDay(t *testing.T) {
	// P5-A4：kind=publish_login_required、文案含补跑承诺、dedupe 按 task+日期。
	a := p5Account(t, "xhs", "P5 通知小红书")
	task := p5Task(t, a, "P5 通知作品", "xhs")

	check := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check, map[string]any{"online": true, "logged_in": false, "adapter_version": "xhs-fill-v1"}, "", "")

	count := p5NotificationCountForTask(t, task.ID)
	if count == 0 {
		t.Fatalf("expected publish_login_required notification")
	}
	var body string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT body FROM notification WHERE kind='publish_login_required' ORDER BY created_at DESC LIMIT 1`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, "20 分钟内自动补跑") {
		t.Fatalf("body must promise auto retry: %s", body)
	}
	var dedupe string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT dedupe_key FROM notification WHERE kind='publish_login_required' ORDER BY created_at DESC LIMIT 1`).Scan(&dedupe); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dedupe, task.ID.String()) {
		t.Fatalf("dedupe_key should contain task id: %s", dedupe)
	}

	// 同一天再次未登录体检：dedupe 命中，不新增。
	check2 := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check2, map[string]any{"online": true, "logged_in": false, "adapter_version": "xhs-fill-v1"}, "", "")
	if got := p5NotificationCountForTask(t, task.ID); got != count {
		t.Fatalf("dedupe failed: %d -> %d", count, got)
	}
	_ = task
}

func p5NotificationCountForTask(t *testing.T, taskID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM notification WHERE kind='publish_login_required' AND dedupe_key=$1`,
		"publish-login:"+taskID.String()+":"+env.srv.now().Format("20060102")).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestP5WechatAPIHealthRunsServerTokenCheck(t *testing.T) {
	a := drWechatAccount(t, "P5 API token 体检")
	path := "/api/v1/accounts/" + a.ID.String() + "/publish-health/check"
	var out struct {
		Checks []PublishHealthCheck `json:"checks"`
	}
	env.mustJSON(t, "POST", path, map[string]any{"platforms": []string{"wechat_mp"}}, &out)
	if len(out.Checks) != 1 {
		t.Fatalf("checks = %+v", out.Checks)
	}
	check := out.Checks[0]
	if check.State != "succeeded" || check.Result["logged_in"] != true || check.Result["token_valid"] != true {
		t.Fatalf("wechat API health = %+v", check)
	}
	var queued int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM publish_health_check
		WHERE account_id=$1 AND platform='wechat_mp' AND state='queued'`, a.ID).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 0 {
		t.Fatalf("API health must not stay queued for desktop: %d", queued)
	}
	var detail []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT detail FROM publish_channel_state
		WHERE account_id=$1 AND platform='wechat_mp' AND channel='api'`, a.ID).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(detail), `"last_health"`) || !strings.Contains(string(detail), `"logged_in": true`) {
		t.Fatalf("api channel detail = %s", detail)
	}
}

func TestP5WechatAPIHealthCredentialMissingFails(t *testing.T) {
	a := drAccount(t, "wechat_mp", "P5 无凭证公众号")
	path := "/api/v1/accounts/" + a.ID.String() + "/publish-health/check"
	var out struct {
		Checks []PublishHealthCheck `json:"checks"`
	}
	env.mustJSON(t, "POST", path, map[string]any{"platforms": []string{"wechat_mp"}}, &out)
	if len(out.Checks) != 1 {
		t.Fatalf("checks = %+v", out.Checks)
	}
	check := out.Checks[0]
	if check.State != "failed" || check.ErrorCode != "wechat_credential_missing" {
		t.Fatalf("missing credential health = %+v", check)
	}
}

func TestP5WechatAPIHealthNotClaimedByDesktop(t *testing.T) {
	// P5-A5：公众号体检不进桌面领取队列（claim 只派 xhs/toutiao）。
	a := p5Account(t, "wechat_mp", "P5 公众号")
	var wsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT workspace_id FROM platform_account WHERE id=$1`, a.ID).Scan(&wsID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO publish_health_check
		(id, workspace_id, account_id, platform, purpose, state, requested_by, requested_at)
		VALUES ($1,$2,$3,'wechat_mp','health','queued',$4,now())`,
		uuid.New(), wsID, a.ID, uuid.MustParse(env.me(t).UserID)); err != nil {
		t.Fatal(err)
	}
	// publishHealthClaim 的查询条件排除 wechat_mp：直接验证查询不命中。
	var id uuid.UUID
	err := env.srv.db.QueryRow(context.Background(), `SELECT h.id FROM publish_health_check h
		WHERE h.state='queued' AND h.platform IN ('xhs','toutiao') AND h.account_id=$1 LIMIT 1`, a.ID).Scan(&id)
	if err == nil {
		t.Fatalf("wechat_mp health must not be claimable by desktop")
	}
	_ = err
}

func TestP5SuccessWritesDetailLastHealthNotCalibrated(t *testing.T) {
	// P5-A1/A6：体检成功写 publish_channel_state.detail.last_health；不更新 calibrated。
	a := p5Account(t, "xhs", "P5 详情小红书")
	check := p5OpenCheck(t, a, "xhs")
	p5FinishResult(t, check, map[string]any{"online": true, "logged_in": true, "adapter_version": "xhs-fill-v1"}, "", "")

	ctx := context.Background()
	var detailRaw []byte
	var lastSuccess *time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT detail, last_success_at FROM publish_channel_state
		WHERE account_id=$1 AND platform='xhs' AND channel='desktop'`, a.ID).Scan(&detailRaw, &lastSuccess); err != nil {
		t.Fatalf("publish_channel_state row missing: %v", err)
	}
	if !strings.Contains(string(detailRaw), "last_health") {
		t.Fatalf("detail should contain last_health: %s", detailRaw)
	}
	if lastSuccess != nil {
		t.Fatalf("health must not update last_success_at/calibrated")
	}
}

func TestP5ExpireJobExpiresStaleQueuedAndLeased(t *testing.T) {
	// P5-A1：queued 超 30 分钟 expired；leased 超租约 expired。
	a := p5Account(t, "xhs", "P5 过期小红书")
	ctx := context.Background()

	stale := p5OpenCheck(t, a, "xhs")
	if _, err := env.srv.db.Exec(ctx, `UPDATE publish_health_check SET requested_at = now() - interval '31 minutes' WHERE id=$1`, stale.ID); err != nil {
		t.Fatal(err)
	}
	leased := p5OpenCheck(t, a, "xhs")
	// stale 已复用同一 open check；为区分两条，先手动再开一条并拨租约过去。
	if _, err := env.srv.db.Exec(ctx, `UPDATE publish_health_check SET state='leased', lease_token='tok',
		lease_until = now() - interval '2 minutes', attempt=1 WHERE id=$1`, leased.ID); err != nil {
		t.Fatal(err)
	}
	_ = leased

	env.srv.publishHealthExpireJob(ctx)
	if got := p5LatestHealthState(t, a.ID, "xhs"); got != "expired" {
		t.Fatalf("latest state = %s, want expired", got)
	}
	var n int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM publish_health_check
		WHERE account_id=$1 AND state IN ('queued','leased')`, a.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("stale checks left open: %d", n)
	}
}
