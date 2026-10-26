package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// 这组测试补的是 metrics_refresh 操作的两条真实分支：
//
//  1. `due_and_recent` 的目标由服务端自己算（`dueAndRecentPlatformRunTargets`），
//     客户端只能在冻结快照里挑；收尾时服务端要**重算一次**还有没有到期目标，
//     有就保持 queued 继续下一轮，没有才收成 succeeded。
//  2. `explicit` 目标受 15 分钟冷却保护（`platformMetricTargetCooldown`）。
//
// DEV-PS107 补 metrics 阶段时只覆盖了 account_sync；`finishPlatformV2StageTx`
// 里 `write.OperationKind == "metrics_refresh"` 那段一直是零覆盖。

// metricsRefreshFixture 建一条 metrics_refresh 操作，连接能力声明「目录 + 单篇指标都可读」。
func startMetricsRefreshFixture(t *testing.T) *platformRunFixture {
	t.Helper()
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:"+uuid.NewString())
	withPlatformSyncFeatureEnabled(t, "metrics_refresh", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection
		SET capabilities=$2,auto_collect=false WHERE id=$1`, f.Connection, []byte(
		`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0",`+
			`"workList":"supported","perNoteMetrics":"supported","noteContent":"unsupported"}`)); err != nil {
		t.Fatal(err)
	}
	return f
}

// insertPublishedMirror 直接落一行已发布的平台作品镜像，模拟账号同步发现的作品。
func insertPublishedMirror(t *testing.T, f *platformRunFixture, externalID string, publishedAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_work_mirror
		(workspace_id, account_id, platform, external_account_key, external_id, remote_content_type,
		 remote_status, title, published_at)
		VALUES ($1,$2,'xhs',$3,$4,'image_note','published','指标刷新样本',$5) RETURNING id`,
		f.Workspace, f.Account.ID, f.ExternalKey(), externalID, publishedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`DELETE FROM platform_work_mirror WHERE account_id=$1 AND external_id=$2`, f.Account.ID, externalID)
	})
	return id
}

// requestMetricsRefresh 发一次指标刷新请求，返回原始状态码与响应体。
func requestMetricsRefresh(t *testing.T, f *platformRunFixture, body map[string]any) (int, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return f.signedSyncRequest(t, "platform.metrics.refresh.request",
		"/api/v1/accounts/"+f.Account.ID.String()+"/platform-metrics-refresh", raw, uuid.NewString())
}

// dueAndRecentMetricsBody 是账号级「刷新作品指标」的请求体。
func dueAndRecentMetricsBody(t *testing.T, f *platformRunFixture) map[string]any {
	t.Helper()
	return map[string]any{
		"target_scope": "due_and_recent", "platform_work_ids": []string{}, "work_ids": []string{},
		"expected_connection_revision": connectionAuthRevision(t, f.Connection),
	}
}

// submitMetricsObservation 用给定 run 提交一条作品指标，随后不自动收尾。
func submitMetricsObservation(t *testing.T, f *platformRunFixture, run platformV2TestRun, seq int, externalIDs ...string) {
	t.Helper()
	rows := make([]any, 0, len(externalIDs))
	for _, externalID := range externalIDs {
		rows = append(rows, metricObservationRow(f.ExternalKey(), externalID))
	}
	submitPlatformV2Batch(t, f, run.ID, map[string]any{
		"protocol_version": 2, "lease_generation": run.LeaseGeneration,
		"authorization_revision": run.AuthorizationRevision, "batch_seq": seq, "final_batch": false,
		"run_status": "succeeded", "result_type": "metrics",
		"data": map[string]any{"observations": rows},
	})
}

// metricsRefreshOperation 读出最近一条 metrics_refresh 操作的状态。
func metricsRefreshOperation(t *testing.T, f *platformRunFixture) (status, stage, metricsState, metricsReason string, pending int) {
	t.Helper()
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status,stage,
		coalesce(coverage->'metrics'->>'state',''),coalesce(coverage->'metrics'->>'reason',''),
		coalesce((coverage->'metrics'->>'pending')::int,0)
		FROM platform_sync_operation WHERE account_id=$1 AND kind='metrics_refresh'
		ORDER BY created_at DESC LIMIT 1`, f.Account.ID).Scan(&status, &stage, &metricsState, &metricsReason, &pending); err != nil {
		t.Fatal(err)
	}
	return status, stage, metricsState, metricsReason, pending
}

// TestPlatformMetricsRefreshDueAndRecentCompletesWhenNoTargetsRemain 验证：
// 到期目标全部写完后，操作收成 succeeded，覆盖率记 complete。
func TestPlatformMetricsRefreshDueAndRecentCompletesWhenNoTargetsRemain(t *testing.T) {
	f := startMetricsRefreshFixture(t)
	first := "6a7c6caf00000000006033" + uuid.NewString()[:2]
	second := "6a7c6caf00000000006133" + uuid.NewString()[:2]
	publishedAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
	insertPublishedMirror(t, f, first, publishedAt)
	insertPublishedMirror(t, f, second, publishedAt)

	status, response := requestMetricsRefresh(t, f, dueAndRecentMetricsBody(t, f))
	if status != http.StatusAccepted {
		t.Fatalf("due_and_recent refresh must create an operation: %d %s", status, response)
	}
	var created struct {
		Status      string `json:"status"`
		TargetCount int    `json:"target_count"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		t.Fatal(err)
	}
	if created.Status != "queued" || created.TargetCount != 2 {
		t.Fatalf("due_and_recent refresh must count both mirrors: %s", response)
	}

	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "collect", "fixture-1")
	if run.Stage != "metrics" {
		t.Fatalf("metrics_refresh must start at metrics stage, got %q", run.Stage)
	}
	// 冻结目标必须由服务端给出，客户端不能自己挑作品。
	var bindingRaw []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, run.ID).Scan(&bindingRaw); err != nil {
		t.Fatal(err)
	}
	var binding struct {
		PlatformWorks []struct {
			ExternalID string `json:"external_id"`
		} `json:"platform_works"`
	}
	if err := json.Unmarshal(bindingRaw, &binding); err != nil {
		t.Fatal(err)
	}
	if len(binding.PlatformWorks) != 2 {
		t.Fatalf("due_and_recent run must freeze both mirrors, got %d", len(binding.PlatformWorks))
	}

	submitMetricsObservation(t, f, run, 0, first, second)
	submitPlatformV2Batch(t, f, run.ID, platformV2ControlBatch(run, 1, "complete", nil, "succeeded"))

	opStatus, opStage, metricsState, metricsReason, pending := metricsRefreshOperation(t, f)
	if opStatus != "succeeded" || opStage != "complete" || metricsState != "complete" || metricsReason != "" || pending != 0 {
		t.Fatalf("all targets written must close the refresh: status=%s stage=%s metrics=%s reason=%s pending=%d",
			opStatus, opStage, metricsState, metricsReason, pending)
	}
}

// TestPlatformMetricsRefreshDueAndRecentKeepsQueuedWhenTargetsRemain 验证：
// 只写了一部分到期目标时，服务端重算发现还有目标，必须保持 queued 而不是谎报完成。
func TestPlatformMetricsRefreshDueAndRecentKeepsQueuedWhenTargetsRemain(t *testing.T) {
	f := startMetricsRefreshFixture(t)
	first := "6a7c6caf00000000006233" + uuid.NewString()[:2]
	second := "6a7c6caf00000000006333" + uuid.NewString()[:2]
	publishedAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
	insertPublishedMirror(t, f, first, publishedAt)
	insertPublishedMirror(t, f, second, publishedAt)

	status, response := requestMetricsRefresh(t, f, dueAndRecentMetricsBody(t, f))
	if status != http.StatusAccepted {
		t.Fatalf("due_and_recent refresh must create an operation: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "collect", "fixture-1")

	// 只写第一篇，第二篇仍然到期。
	submitMetricsObservation(t, f, run, 0, first)
	submitPlatformV2Batch(t, f, run.ID, platformV2ControlBatch(run, 1, "complete", nil, "succeeded"))

	opStatus, opStage, metricsState, _, pending := metricsRefreshOperation(t, f)
	if opStatus != "queued" || opStage != "metrics" || metricsState != "partial" || pending != 1 {
		t.Fatalf("remaining due targets must keep the refresh queued: status=%s stage=%s metrics=%s pending=%d",
			opStatus, opStage, metricsState, pending)
	}

	// 下一轮只能拿到还没写的那一篇。
	env.srv.schedulePlatformRuns(context.Background())
	next := claimPlatformV2Run(t, f, "collect", "fixture-1")
	var bindingRaw []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, next.ID).Scan(&bindingRaw); err != nil {
		t.Fatal(err)
	}
	var binding struct {
		PlatformWorks []struct {
			ExternalID string `json:"external_id"`
		} `json:"platform_works"`
	}
	if err := json.Unmarshal(bindingRaw, &binding); err != nil {
		t.Fatal(err)
	}
	if len(binding.PlatformWorks) != 1 || binding.PlatformWorks[0].ExternalID != second {
		t.Fatalf("second round must only carry the unfinished target, got %+v", binding.PlatformWorks)
	}
}

// TestPlatformMetricsRefreshExplicitRejectsWithinCooldown 验证：
// 刚采过的作品在 15 分钟内不能被再次手动刷新，返回 429 并给出下次可用的时间。
func TestPlatformMetricsRefreshExplicitRejectsWithinCooldown(t *testing.T) {
	f := startMetricsRefreshFixture(t)
	externalID := "6a7c6caf00000000006433" + uuid.NewString()[:2]
	mirrorID := insertPublishedMirror(t, f, externalID, time.Now().UTC().Add(-48*time.Hour).Truncate(time.Second))

	status, response := requestMetricsRefresh(t, f, dueAndRecentMetricsBody(t, f))
	if status != http.StatusAccepted {
		t.Fatalf("due_and_recent refresh must create an operation: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "collect", "fixture-1")
	submitMetricsObservation(t, f, run, 0, externalID)
	submitPlatformV2Batch(t, f, run.ID, platformV2ControlBatch(run, 1, "complete", nil, "succeeded"))

	explicit := map[string]any{
		"target_scope": "explicit", "platform_work_ids": []string{mirrorID.String()}, "work_ids": []string{},
		"expected_connection_revision": connectionAuthRevision(t, f.Connection),
	}
	status, response = requestMetricsRefresh(t, f, explicit)
	if status != http.StatusTooManyRequests || apiCode(response) != "platform_target_cooldown" {
		t.Fatalf("explicit refresh within cooldown must be rejected: %d %s", status, response)
	}
	var body struct {
		Error struct {
			Detail struct {
				NextAllowedAt string `json:"next_allowed_at"`
			} `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Detail.NextAllowedAt == "" {
		t.Fatalf("cooldown rejection must carry next_allowed_at: %s", response)
	}
}
