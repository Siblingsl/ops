package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// 这组测试补 metrics_refresh 目标解析的两条此前零覆盖的分支：
//
//  1. `explicit` 的成功路径。既有用例只覆盖了 15 分钟冷却拒绝
//     （`TestPlatformMetricsRefreshExplicitRejectsWithinCooldown`），
//     真正「指定作品 → 冻结快照 → 采完收尾」这段一次都没跑过。
//  2. `due_and_recent` 的 D1/D3/D7/D14 节点判定（`countDueAndRecentMetricTargets`
//     里那段 `generate_series` + `metric_node_public`）。这条 SQL 决定
//     "哪些作品今天到期"，写错会让到期作品永远不被采，或者每天重复采同一批。

// runBindingSnapshot 读出一条 run 冻结的目标快照。
type runBindingSnapshot struct {
	LocalBindings []struct {
		WorkID     string `json:"work_id"`
		ExternalID string `json:"external_id"`
	} `json:"local_bindings"`
	PlatformWorks []struct {
		PlatformWorkID string `json:"platform_work_id"`
		ExternalID     string `json:"external_id"`
	} `json:"platform_works"`
}

func readRunBindingSnapshot(t *testing.T, runID uuid.UUID) runBindingSnapshot {
	t.Helper()
	var raw []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, runID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snapshot runBindingSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

// explicitMetricsBody 是「只刷新我勾选的这几篇」的请求体。
func explicitMetricsBody(t *testing.T, f *platformRunFixture, platformWorkIDs, workIDs []string) map[string]any {
	t.Helper()
	if platformWorkIDs == nil {
		platformWorkIDs = []string{}
	}
	if workIDs == nil {
		workIDs = []string{}
	}
	return map[string]any{
		"target_scope": "explicit", "platform_work_ids": platformWorkIDs, "work_ids": workIDs,
		"expected_connection_revision": connectionAuthRevision(t, f.Connection),
	}
}

// errorMessage 取出错误响应的可读文案。
func errorMessage(t *testing.T, response []byte) string {
	t.Helper()
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response, &body); err != nil {
		t.Fatalf("响应不是错误结构: %s", response)
	}
	return body.Error.Message
}

// TestPlatformMetricsRefreshExplicitFreezesRequestedMirror 验证：
// 指定平台作品后，冻结快照里只有这一篇，采完就收成 succeeded。
func TestPlatformMetricsRefreshExplicitFreezesRequestedMirror(t *testing.T) {
	f := startMetricsRefreshFixture(t)
	wanted := "6a7c6caf00000000007033" + uuid.NewString()[:2]
	other := "6a7c6caf00000000007133" + uuid.NewString()[:2]
	publishedAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
	mirrorID := insertPublishedMirror(t, f, wanted, publishedAt)
	// 另一篇也到期，但没被勾选，不能进冻结快照。
	insertPublishedMirror(t, f, other, publishedAt)

	status, response := requestMetricsRefresh(t, f, explicitMetricsBody(t, f, []string{mirrorID.String()}, nil))
	if status != http.StatusAccepted {
		t.Fatalf("explicit refresh must create an operation: %d %s", status, response)
	}
	var created struct {
		Status      string `json:"status"`
		TargetCount int    `json:"target_count"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		t.Fatal(err)
	}
	if created.Status != "queued" || created.TargetCount != 1 {
		t.Fatalf("explicit refresh must count exactly the requested work: %s", response)
	}

	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "collect", "fixture-1")
	if run.Stage != "metrics" {
		t.Fatalf("metrics_refresh must start at metrics stage, got %q", run.Stage)
	}
	snapshot := readRunBindingSnapshot(t, run.ID)
	if len(snapshot.PlatformWorks) != 1 || snapshot.PlatformWorks[0].ExternalID != wanted {
		t.Fatalf("explicit run must freeze only the requested work, got %+v", snapshot.PlatformWorks)
	}

	submitMetricsObservation(t, f, run, 0, wanted)
	submitPlatformV2Batch(t, f, run.ID, platformV2ControlBatch(run, 1, "complete", nil, "succeeded"))

	opStatus, opStage, metricsState, metricsReason, pending := metricsRefreshOperation(t, f)
	if opStatus != "succeeded" || opStage != "complete" || metricsState != "complete" || metricsReason != "" || pending != 0 {
		t.Fatalf("explicit refresh must close after the frozen target is written: status=%s stage=%s metrics=%s reason=%s pending=%d",
			opStatus, opStage, metricsState, metricsReason, pending)
	}
}

// TestPlatformMetricsRefreshExplicitMergesLocalWorkAndMirror 验证：
// 同一个平台编号同时被本地作品和镜像命中时，只算一个目标，
// 冻结快照里两边的引用都要在，否则写入时会被判成"不属于冻结目标"。
func TestPlatformMetricsRefreshExplicitMergesLocalWorkAndMirror(t *testing.T) {
	f := startMetricsRefreshFixture(t)
	externalID := "6a7c6caf00000000007233" + uuid.NewString()[:2]
	work := f.bindWork(t, "显式刷新样本", externalID)
	publishedAt := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Second)
	mirrorID := insertPublishedMirror(t, f, externalID, publishedAt)

	status, response := requestMetricsRefresh(t, f,
		explicitMetricsBody(t, f, []string{mirrorID.String()}, []string{work.ID.String()}))
	if status != http.StatusAccepted {
		t.Fatalf("explicit refresh must accept the merged target: %d %s", status, response)
	}
	var created struct {
		TargetCount int `json:"target_count"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		t.Fatal(err)
	}
	if created.TargetCount != 1 {
		t.Fatalf("same platform id must count once, got %d", created.TargetCount)
	}

	env.srv.schedulePlatformRuns(context.Background())
	run := claimPlatformV2Run(t, f, "collect", "fixture-1")
	snapshot := readRunBindingSnapshot(t, run.ID)
	if len(snapshot.PlatformWorks) != 1 || snapshot.PlatformWorks[0].ExternalID != externalID {
		t.Fatalf("merged target must carry the mirror reference, got %+v", snapshot.PlatformWorks)
	}
	if len(snapshot.LocalBindings) != 1 || snapshot.LocalBindings[0].WorkID != work.ID.String() {
		t.Fatalf("merged target must carry the local binding, got %+v", snapshot.LocalBindings)
	}

	// 冻结快照里带了本地绑定，观测就必须带上冻结时的两个修订号，
	// 否则写入侧会判成"作品绑定或发布修订已变化"。
	submitMetricsObservationWithBinding(t, f, run, 0, externalID)
	submitPlatformV2Batch(t, f, run.ID, platformV2ControlBatch(run, 1, "complete", nil, "succeeded"))
	if opStatus, _, _, _, _ := metricsRefreshOperation(t, f); opStatus != "succeeded" {
		t.Fatalf("merged explicit refresh must close, got %s", opStatus)
	}
}

// TestPlatformMetricsRefreshExplicitRejectsTargetsOutsideAccount 验证：
// 勾选的作品必须属于当前账号，否则一律 422，不能悄悄放宽范围。
func TestPlatformMetricsRefreshExplicitRejectsTargetsOutsideAccount(t *testing.T) {
	f := startMetricsRefreshFixture(t)

	// 一个不存在的镜像编号走的就是"不属于当前账号"那条分支。
	status, response := requestMetricsRefresh(t, f, explicitMetricsBody(t, f, []string{uuid.NewString()}, nil))
	if status != http.StatusUnprocessableEntity || apiCode(response) != "validation_failed" {
		t.Fatalf("foreign mirror must be rejected: %d %s", status, response)
	}
	if message := errorMessage(t, response); message != "所选平台作品不属于当前账号" {
		t.Fatalf("unexpected message: %s", message)
	}

	// 本地作品没有精确绑定编号时同样拒绝。
	pub := env.srv.today().AddDate(0, 0, -1).Add(20 * time.Hour)
	unbound := drWork(t, f.Account, "没有平台编号的作品", "published", &pub)
	status, response = requestMetricsRefresh(t, f, explicitMetricsBody(t, f, nil, []string{unbound.ID.String()}))
	if status != http.StatusUnprocessableEntity || apiCode(response) != "validation_failed" {
		t.Fatalf("unbound local work must be rejected: %d %s", status, response)
	}
	if message := errorMessage(t, response); message != "所选本地作品没有当前账号下已核验的平台绑定" {
		t.Fatalf("unexpected message: %s", message)
	}
}

// TestPlatformMetricsRefreshTargetScopeValidation 验证：
// 两种 scope 都不接受对方的参数，空 explicit 也不行。
func TestPlatformMetricsRefreshTargetScopeValidation(t *testing.T) {
	f := startMetricsRefreshFixture(t)

	body := dueAndRecentMetricsBody(t, f)
	body["work_ids"] = []string{uuid.NewString()}
	status, response := requestMetricsRefresh(t, f, body)
	if status != http.StatusUnprocessableEntity || apiCode(response) != "validation_failed" {
		t.Fatalf("due_and_recent must reject work ids: %d %s", status, response)
	}
	if message := errorMessage(t, response); message != "due_and_recent 不接受作品 ID" {
		t.Fatalf("unexpected message: %s", message)
	}

	status, response = requestMetricsRefresh(t, f, explicitMetricsBody(t, f, nil, nil))
	if status != http.StatusUnprocessableEntity || apiCode(response) != "validation_failed" {
		t.Fatalf("empty explicit must be rejected: %d %s", status, response)
	}
	if message := errorMessage(t, response); message != "explicit 必须指定 1～20 个作品" {
		t.Fatalf("unexpected message: %s", message)
	}
}

// TestPlatformMetricsRefreshDueAndRecentTracksDayNodes 验证 D1/D3/D7/D14 节点判定：
// 只有真正到点、且该节点还没有精确记录的作品才算到期。
//
// 每个用例用独立账号：同一账号同时只能有一个未结束的指标刷新操作，
// 在同一个 fixture 里连发两次会被 409 `operation_in_progress` 挡掉。
func TestPlatformMetricsRefreshDueAndRecentTracksDayNodes(t *testing.T) {
	// 三天前发布、一个节点都没采：D1 与 D3 都已到点，算到期。
	t.Run("过点且无精确节点算到期", func(t *testing.T) {
		f := startMetricsRefreshFixture(t)
		due := f.bindWork(t, "三天前发布", "6a7c6caf00000000007333"+uuid.NewString()[:2])
		setWorkPublishedAt(t, due.ID, env.srv.today().AddDate(0, 0, -3).Add(9*time.Hour))
		if count := requestDueAndRecentCount(t, f); count != 1 {
			t.Fatalf("三天前发布且无节点必须到期，实际 %d", count)
		}
	})

	// 今天刚发布：D1 还没到，不算到期。
	t.Run("未到 D1 不算到期", func(t *testing.T) {
		f := startMetricsRefreshFixture(t)
		fresh := f.bindWork(t, "今天发布", "6a7c6caf00000000007433"+uuid.NewString()[:2])
		setWorkPublishedAt(t, fresh.ID, env.srv.today().Add(9*time.Hour))
		if count := requestDueAndRecentCount(t, f); count != 0 {
			t.Fatalf("今天发布的作品不该到期，实际 %d", count)
		}
	})

	// 三天前发布但 D1、D3 都已有精确节点：只剩 D7 没到，不算到期。
	t.Run("精确节点齐全不算到期", func(t *testing.T) {
		f := startMetricsRefreshFixture(t)
		done := f.bindWork(t, "三天前发布且节点齐全", "6a7c6caf00000000007533"+uuid.NewString()[:2])
		setWorkPublishedAt(t, done.ID, env.srv.today().AddDate(0, 0, -3).Add(9*time.Hour))
		insertApprovedNode(t, done.ID, 1)
		insertApprovedNode(t, done.ID, 3)
		if count := requestDueAndRecentCount(t, f); count != 0 {
			t.Fatalf("D1/D3 都有精确节点时不该到期，实际 %d", count)
		}
	})

	// 三天前发布、只有 D1 精确节点：D3 还缺，仍然算到期。
	t.Run("缺 D3 仍算到期", func(t *testing.T) {
		f := startMetricsRefreshFixture(t)
		partial := f.bindWork(t, "只采了 D1", "6a7c6caf00000000007633"+uuid.NewString()[:2])
		setWorkPublishedAt(t, partial.ID, env.srv.today().AddDate(0, 0, -3).Add(9*time.Hour))
		insertApprovedNode(t, partial.ID, 1)
		if count := requestDueAndRecentCount(t, f); count != 1 {
			t.Fatalf("缺 D3 精确节点必须仍然到期，实际 %d", count)
		}
	})
}

// requestDueAndRecentCount 发一次 due_and_recent 请求并返回服务端算出的到期目标数。
// 没有到期目标时服务端不建操作，直接 200 `status=no_targets`。
func requestDueAndRecentCount(t *testing.T, f *platformRunFixture) int {
	t.Helper()
	status, response := requestMetricsRefresh(t, f, dueAndRecentMetricsBody(t, f))
	var body struct {
		Status      string `json:"status"`
		TargetCount int    `json:"target_count"`
	}
	if err := json.Unmarshal(response, &body); err != nil {
		t.Fatalf("响应不是 JSON: %d %s", status, response)
	}
	switch status {
	case http.StatusAccepted:
		if body.Status != "queued" {
			t.Fatalf("有到期目标时必须建出操作: %s", response)
		}
		return body.TargetCount
	case http.StatusOK:
		if body.Status != "no_targets" || body.TargetCount != 0 {
			t.Fatalf("没有到期目标时必须回 no_targets: %s", response)
		}
		return 0
	default:
		t.Fatalf("due_and_recent refresh 失败: %d %s", status, response)
		return 0
	}
}

// submitMetricsObservationWithBinding 提交一条带本地绑定修订的指标观测。
// 冻结快照里同时有本地作品时，写入侧会按 `binding_revision`/`publish_revision`
// 核对是不是同一份绑定，缺了就报"作品绑定或发布修订已变化"。
func submitMetricsObservationWithBinding(t *testing.T, f *platformRunFixture, run platformV2TestRun, seq int, externalID string) {
	t.Helper()
	var bindingRevision, publishRevision int
	column := "xhs_note_id"
	if f.Account.Platform == "wechat_mp" {
		column = "wechat_msgid"
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT metric_binding_revision,coalesce(publish_revision,1) FROM work WHERE account_id=$1 AND `+column+`=$2`,
		f.Account.ID, externalID).Scan(&bindingRevision, &publishRevision); err != nil {
		t.Fatal(err)
	}
	row := metricObservationRow(f.ExternalKey(), externalID)
	row["binding_revision"] = bindingRevision
	row["publish_revision"] = publishRevision
	submitPlatformV2Batch(t, f, run.ID, map[string]any{
		"protocol_version": 2, "lease_generation": run.LeaseGeneration,
		"authorization_revision": run.AuthorizationRevision, "batch_seq": seq, "final_batch": false,
		"run_status": "succeeded", "result_type": "metrics",
		"data": map[string]any{"observations": []any{row}},
	})
}

// setWorkPublishedAt 把作品的发布时间改到指定时刻。
func setWorkPublishedAt(t *testing.T, workID uuid.UUID, publishedAt time.Time) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, workID, publishedAt); err != nil {
		t.Fatal(err)
	}
}

// insertApprovedNode 给作品补一个已核准的日节点快照。
// 注意 `metric_snapshot_node` 是 DEFERRABLE 唯一约束，不能当 `ON CONFLICT` 的仲裁者，
// 所以这里先删后插。
func insertApprovedNode(t *testing.T, workID uuid.UUID, dayOffset int) {
	t.Helper()
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx,
		`DELETE FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser' AND day_offset=$2`,
		workID, dayOffset); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot
		(work_id, captured_at, reads, likes, source, day_offset, quality_state, observed_at, as_of_at)
		VALUES ($1,now(),100,10,'xhs_browser',$2,'approved',now(),now())`,
		workID, dayOffset); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`DELETE FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser' AND day_offset=$2`,
			workID, dayOffset)
	})
}
