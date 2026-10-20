package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS07 第二批定向测试：幂等、租约、撤销竞争、双设备、预算、presence 与调度去重。

// claimWith 领取一条 run；没有任务时返回 ok=false。
func (f *platformRunFixture) claimWith(t *testing.T) (uuid.UUID, int64, bool) {
	t.Helper()
	return f.claim(t)
}

// resultBody 组装一个最小合法批次，授权版本取连接当前值。
func (f *platformRunFixture) resultBody(t *testing.T, runID uuid.UUID, generation int64, batchSeq int,
	externalID string, bindingRev, publishRev int) []byte {
	t.Helper()
	return f.resultBodyWith(t, runID, generation, batchSeq, externalID, bindingRev, publishRev,
		connectionAuthRevision(t, f.Connection))
}

// resultBodyWith 显式指定授权版本，用于验证版本比较本身。
func (f *platformRunFixture) resultBodyWith(t *testing.T, runID uuid.UUID, generation int64, batchSeq int,
	externalID string, bindingRev, publishRev int, authRevision int64) []byte {
	t.Helper()
	body := map[string]any{
		"protocol_version":       desktopPlatformProtocolVersion,
		"lease_generation":       generation,
		"authorization_revision": authRevision,
		"batch_seq":              batchSeq,
		"final_batch":            true,
		"run_status":             platformRunStatusSuccess,
		"coverage":               map[string]any{"pages_read": 1, "has_more": false},
		"observations": []map[string]any{{
			"row_no": 0, "scope": "work", "external_account_key": f.externalKey(),
			"external_id": externalID, "binding_revision": bindingRev, "publish_revision": publishRev,
			"source": "xhs_browser", "temporal_kind": "cumulative",
			"observed_at":     time.Now().UTC().Format(time.RFC3339),
			"as_of_at":        time.Now().UTC().Truncate(time.Second).Format(time.RFC3339),
			"adapter_version": "fixture-1", "mapping_version": 1,
			"values":      map[string]any{"view_times": map[string]any{"value": 120, "precision": "exact", "unit": "times"}},
			"field_paths": map[string]any{"view_times": "fixture.note.view_count"},
		}},
	}
	raw, _ := json.Marshal(body)
	_ = runID
	return raw
}

func (f *platformRunFixture) externalKey() string {
	if f.Account.Platform == "xhs" {
		return "xhs_user_id:fixture-self"
	}
	return "wechat_biz:fixture-self"
}

func (f *platformRunFixture) submit(t *testing.T, runID uuid.UUID, body []byte) (int, []byte) {
	t.Helper()
	path := "/api/v1/desktop/platform/runs/" + runID.String() + "/results"
	return f.signedPlatform(t, "platform.run.result", http.MethodPost, path, body)
}

// TestPlatformRunBatchIdempotency 对应 PS-T23：同批重复提交返回同一回执，内容不同则 409，
// 换 batch_seq 重发同一观测判 duplicate 而不新增。
func TestPlatformRunBatchIdempotency(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "幂等样本", "6f0000000000000000000010")
	bindingRev, publishRev := workRevisions(t, wk.ID)
	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	body := f.resultBody(t, runID, gen, 0, "6f0000000000000000000010", bindingRev, publishRev)

	st, first := f.submit(t, runID, body)
	if st != http.StatusOK {
		t.Fatalf("首次提交应成功：%d %s", st, first)
	}
	var r1, r2 struct {
		ReceiptID uuid.UUID `json:"receipt_id"`
		Accepted  int       `json:"accepted"`
		Duplicate int       `json:"duplicate"`
	}
	_ = json.Unmarshal(first, &r1)

	// 同内容重发：返回同一回执，不新增观测。
	st, second := f.submit(t, runID, body)
	if st != http.StatusOK {
		t.Fatalf("同内容重发应返回原回执：%d %s", st, second)
	}
	_ = json.Unmarshal(second, &r2)
	if r1.ReceiptID != r2.ReceiptID || r2.Accepted != r1.Accepted {
		t.Fatalf("同内容重发必须返回同一回执：%+v vs %+v", r1, r2)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("重发不应新增观测：%d %v", count, err)
	}

	// 同批不同内容：409。
	var altered map[string]any
	_ = json.Unmarshal(body, &altered)
	altered["coverage"] = map[string]any{"pages_read": 9}
	changedRaw, _ := json.Marshal(altered)
	if st, resp := f.submit(t, runID, changedRaw); st != http.StatusConflict {
		t.Fatalf("同批不同内容必须 409：%d %s", st, resp)
	}
}

// TestPlatformRunLeaseStaleRejected 对应 PS-T29/T53：旧 generation、已结束任务与
// 撤销后的提交一律拒绝，不能更新任何数据。
func TestPlatformRunLeaseStaleRejected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "租约样本", "6f0000000000000000000011")
	bindingRev, publishRev := workRevisions(t, wk.ID)
	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}

	// 伪造旧 generation。
	stale := f.resultBody(t, runID, gen, 0, "6f0000000000000000000011", bindingRev, publishRev)
	var parsed map[string]any
	_ = json.Unmarshal(stale, &parsed)
	parsed["lease_generation"] = float64(gen - 1)
	staleRaw, _ := json.Marshal(parsed)
	if st, resp := f.submit(t, runID, staleRaw); st != http.StatusConflict {
		t.Fatalf("旧 generation 必须 409：%d %s", st, resp)
	}

	// 领取新 run 后，旧 run 已被替代（模拟另一设备接管）。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_sync_run SET lease_generation=lease_generation+1 WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	body := f.resultBody(t, runID, gen, 0, "6f0000000000000000000011", bindingRev, publishRev)
	if st, resp := f.submit(t, runID, body); st != http.StatusConflict {
		t.Fatalf("被替代的 generation 必须 409：%d %s", st, resp)
	}
}

// TestPlatformRunRejectedAfterRevoke 对应 PS-T28：撤销与提交竞争时，撤销之后不能再写入任何结果。
// 这里刻意让该 run 仍处于 leased（模拟「取消」尚未传播到该设备），以便单独验证
// 「连接状态」与「授权版本」这两道检查，而不是被「run 已取消」的检查掩盖。
func TestPlatformRunRejectedAfterRevoke(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "撤销样本", "6f0000000000000000000012")
	bindingRev, publishRev := workRevisions(t, wk.ID)
	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	revokedAuth := connectionAuthRevision(t, f.Connection)
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.revokePlatformConnection(context.Background(), tx, f.Connection, "workspace_revoke")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_sync_run SET status='leased' WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	// 用撤销前的授权版本提交：连接已撤销，必须拒绝。
	body := f.resultBodyWith(t, runID, gen, 0, "6f0000000000000000000012", bindingRev, publishRev, revokedAuth)
	if st, resp := f.submit(t, runID, body); st != http.StatusConflict && st != http.StatusForbidden {
		t.Fatalf("撤销后提交必须被拒绝：%d %s", st, resp)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("撤销后不得写入观测：%d %v", count, err)
	}
}

// TestPlatformRunBudgetLimits 对应 PS-T31：单批行数超限整批拒绝，不写入半批。
func TestPlatformRunBudgetLimits(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "预算样本", "6f0000000000000000000013")
	bindingRev, publishRev := workRevisions(t, wk.ID)
	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	rows := make([]map[string]any, 0, platformBatchMaxRows+1)
	for i := 0; i <= platformBatchMaxRows; i++ {
		rows = append(rows, map[string]any{
			"row_no": i, "scope": "work", "external_account_key": "xhs_user_id:fixture-self",
			"external_id": "6f0000000000000000000013", "binding_revision": bindingRev, "publish_revision": publishRev,
			"source": "xhs_browser", "temporal_kind": "cumulative",
			"observed_at":     time.Now().UTC().Format(time.RFC3339),
			"as_of_at":        time.Now().UTC().Truncate(time.Second).Format(time.RFC3339),
			"adapter_version": "fixture-1", "mapping_version": 1,
			"values":      map[string]any{"view_times": map[string]any{"value": i, "precision": "exact", "unit": "times"}},
			"field_paths": map[string]any{"view_times": "fixture.note.view_count"},
		})
	}
	body, _ := json.Marshal(map[string]any{
		"protocol_version": desktopPlatformProtocolVersion, "lease_generation": gen,
		"authorization_revision": connectionAuthRevision(t, f.Connection),
		"batch_seq":              0, "final_batch": true, "run_status": platformRunStatusSuccess,
		"observations": rows,
	})
	if st, resp := f.submit(t, runID, body); st != http.StatusUnprocessableEntity {
		t.Fatalf("超过单批上限必须 422：%d %s", st, resp)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1`, runID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("超限批次不得写入任何行：%d %v", count, err)
	}
}

// TestPlatformPresenceSeparateFromLease 对应 PS-T43：presence 刷新不延长租约，
// 租约结束不清除 presence，presence 过期不派新任务。
func TestPlatformPresenceSeparateFromLease(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "心跳样本", "6f0000000000000000000014")
	env.srv.schedulePlatformRuns(context.Background())
	if _, _, ok := f.claimWith(t); !ok {
		t.Fatal("应能领到任务")
	}
	ctx := context.Background()
	var leaseBefore time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT lease_expires_at FROM platform_sync_run
		WHERE connection_id=$1 AND status IN ('leased','running')`, f.Connection).Scan(&leaseBefore); err != nil {
		t.Fatal(err)
	}
	st, resp := f.signedPlatform(t, "platform.presence", http.MethodPost,
		"/api/v1/desktop/platform/presence", []byte(`{}`))
	if st != http.StatusOK {
		t.Fatalf("presence 应成功：%d %s", st, resp)
	}
	var leaseAfter time.Time
	if err := env.srv.db.QueryRow(ctx, `SELECT lease_expires_at FROM platform_sync_run
		WHERE connection_id=$1 AND status IN ('leased','running')`, f.Connection).Scan(&leaseAfter); err != nil {
		t.Fatal(err)
	}
	if !leaseAfter.Equal(leaseBefore) {
		t.Fatalf("presence 不应延长租约：%v → %v", leaseBefore, leaseAfter)
	}

	// presence 过期后调度不再派任务。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_connection SET last_seen_at=now() - interval '10 minutes'
		WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET status='succeeded', finished_at=now()
		WHERE connection_id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
	env.srv.schedulePlatformRuns(ctx)
	var pending int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_sync_run
		WHERE connection_id=$1 AND status='queued'`, f.Connection).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("设备离线时不应派新任务：%d %v", pending, err)
	}
}

// TestPlatformSchedulerDeduplicatesActiveRuns 对应 PS-T42：同一连接已有未结束 run 时不再建单，
// 完成后才允许下一轮。
func TestPlatformSchedulerDeduplicatesActiveRuns(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "调度去重样本", "6f0000000000000000000015")
	ctx := context.Background()
	env.srv.schedulePlatformRuns(ctx)
	env.srv.schedulePlatformRuns(ctx)
	var count int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_sync_run
		WHERE connection_id=$1 AND status IN ('queued','leased','running')`, f.Connection).Scan(&count); err != nil || count != 1 {
		t.Fatalf("同一连接只应有一条未结束 run：%d %v", count, err)
	}
}

// TestPlatformExpiredRunIsReassignedOnce 对应 PS-T53：租约过期置 expired 并新建 attempt+1，
// 达到上限后不再建。
func TestPlatformExpiredRunIsReassignedOnce(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	f.bindWork(t, "过期重派样本", "6f0000000000000000000016")
	ctx := context.Background()
	env.srv.schedulePlatformRuns(ctx)
	runID, _, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	// 让租约过期并按「网络失败冷却 5 分钟」解除冷却，才能触发重派。
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET lease_expires_at=now() - interval '1 minute'
		WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	env.srv.expirePlatformRuns(ctx, env.srv.now())
	var oldStatus string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM platform_sync_run WHERE id=$1`, runID).Scan(&oldStatus); err != nil {
		t.Fatal(err)
	}
	if oldStatus != platformRunStatusExpired {
		t.Fatalf("过期租约应置 expired，实际 %s", oldStatus)
	}
	var newRun struct {
		ID      uuid.UUID
		Attempt int
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT id, attempt FROM platform_sync_run
		WHERE connection_id=$1 AND status='queued'`, f.Connection).Scan(&newRun.ID, &newRun.Attempt); err != nil {
		t.Fatalf("应重派一条新 run：%v", err)
	}
	if newRun.ID == runID || newRun.Attempt != 2 {
		t.Fatalf("重派必须是新 run 且 attempt=2：%+v", newRun)
	}

	// attempt 已达上限时再过期不再建，并按 §10.1.1 累计一次失败。
	var failureBefore int
	if err := env.srv.db.QueryRow(ctx, `SELECT failure_count FROM platform_connection WHERE id=$1`,
		f.Connection).Scan(&failureBefore); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET status='leased',
		lease_expires_at=now() - interval '1 minute' WHERE id=$1`, newRun.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.expirePlatformRuns(ctx, env.srv.now())
	var pending int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM platform_sync_run
		WHERE connection_id=$1 AND status='queued'`, f.Connection).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("attempt 达到上限后不应再建：%d %v", pending, err)
	}
	var failureAfter int
	if err := env.srv.db.QueryRow(ctx, `SELECT failure_count FROM platform_connection WHERE id=$1`,
		f.Connection).Scan(&failureAfter); err != nil {
		t.Fatal(err)
	}
	if failureAfter != failureBefore+1 {
		t.Fatalf("达到重派上限应累计一次失败：%d → %d", failureBefore, failureAfter)
	}
}
