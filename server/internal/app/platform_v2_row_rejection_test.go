package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// startCatalogStageFixture 把一条 account_sync 操作推进到 catalog 阶段并领到 run。
//
// 为什么单独抽出来：DEV-PS107 的 metrics 阶段测试从 catalog 的「完成」开始，
// 而「一批里混着无效行」必须发生在 catalog 阶段中间，所以需要一个停在
// catalog 领单状态的夹具。
func startCatalogStageFixture(t *testing.T, capabilities string) (*platformRunFixture, platformV2TestRun) {
	t.Helper()
	f := startMetricsStageFixture(t, capabilities)
	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if profile.Stage != "profile" {
		t.Fatalf("initial stage must be profile, got %q", profile.Stage)
	}
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "complete", nil, "succeeded"))
	env.srv.schedulePlatformRuns(context.Background())
	catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if catalog.Stage != "catalog" {
		t.Fatalf("profile completion must schedule catalog, got %q", catalog.Stage)
	}
	return f, catalog
}

// submitV2BatchRaw 提交一批 v2 结果并原样返回状态码与响应体。
//
// 不用 submitPlatformV2Batch：那个辅助函数在非 200 时直接 Fatal，
// 而这里要断言的恰恰是"批里有无效行时整批仍然是 200、只是那一行被拒"。
func submitV2BatchRaw(t *testing.T, f *platformRunFixture, runID uuid.UUID, body map[string]any) (int, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return f.signedPlatform(t, "platform.run.result", http.MethodPost,
		"/api/v1/desktop/platform/runs/"+runID.String()+"/results", raw)
}

// catalogItem 造一条目录行，remoteStatus 用来触发不同的行级处置。
func catalogItem(externalKey, externalID, remoteStatus string) map[string]any {
	publishedAt := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	return map[string]any{
		"external_id": externalID, "author_external_account_key": externalKey,
		"remote_content_type": "image_note", "remote_status": remoteStatus, "title": "行级处置样本",
		"summary": "简短摘要", "author_display": "巡检号", "published_at": publishedAt,
		"topics": []string{}, "tags": []string{},
		"field_states": map[string]string{"title": "present", "published_at": "present", "summary": "present"},
	}
}

// TestPlatformV2CatalogRejectsInvalidRowWithoutDroppingBatch 验证：一批里有一条
// 字段非法的目录行时，只有那一行被拒，其余行照常入库，整批仍返回 200。
//
// 这条行为此前没有任何测试覆盖。它决定了「平台返回一条脏数据」到底是
// 丢掉整批（客户端会以为整批失败并重试）还是只丢那一行。
func TestPlatformV2CatalogRejectsInvalidRowWithoutDroppingBatch(t *testing.T) {
	f, catalog := startCatalogStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"unknown","noteContent":"unsupported"}`)
	key := f.ExternalKey()
	goodOne := "6a7c6caf00000000006033" + uuid.NewString()[:2]
	bad := "6a7c6caf00000000006133" + uuid.NewString()[:2]
	goodTwo := "6a7c6caf00000000006233" + uuid.NewString()[:2]

	status, receipt := submitV2BatchRaw(t, f, catalog.ID, map[string]any{
		"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{"items": []any{
			catalogItem(key, goodOne, "published"),
			catalogItem(key, bad, "not-a-real-status"),
			catalogItem(key, goodTwo, "published"),
		}, "enumeration_complete": false, "partition": "published", "consistency": "best_effort"},
	})
	if status != http.StatusOK {
		t.Fatalf("one invalid row must not fail the batch: %d %s", status, receipt)
	}
	var out struct {
		Accepted int              `json:"accepted"`
		Rejected int              `json:"rejected"`
		Rows     []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(receipt, &out); err != nil {
		t.Fatal(err)
	}
	if out.Accepted != 2 || out.Rejected != 1 {
		t.Fatalf("invalid row must be isolated: accepted=%d rejected=%d rows=%v", out.Accepted, out.Rejected, out.Rows)
	}
	if len(out.Rows) != 3 || out.Rows[1]["state"] != "rejected" || out.Rows[1]["error_code"] != "invalid_row" {
		t.Fatalf("rejected row must be reported in place: %v", out.Rows)
	}

	var mirrors int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_work_mirror
		WHERE account_id=$1 AND external_id IN ($2,$3,$4)`, f.Account.ID, goodOne, bad, goodTwo).Scan(&mirrors); err != nil {
		t.Fatal(err)
	}
	if mirrors != 2 {
		t.Fatalf("invalid row must not reach the mirror: mirrors=%d", mirrors)
	}

	// 被拒的行不能把 run 拖成失败：后续 control 仍要能正常收尾。
	submitPlatformV2Batch(t, f, catalog.ID, platformV2ControlBatch(catalog, 1, "complete", map[string]any{
		"enumeration_complete": true, "total_count": 2, "partition": "published", "consistency": "best_effort",
	}, "succeeded"))
	var runStatus string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM platform_sync_run WHERE id=$1`,
		catalog.ID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" && runStatus != "partial" {
		t.Fatalf("run must still settle after a rejected row, got %q", runStatus)
	}
}

// TestPlatformV2CatalogSkipsUnpublishedRow 验证：非已发布状态的行按"跳过"处理，
// 不算接受也不算拒绝——它既不该进镜像，也不该被当成失败。
func TestPlatformV2CatalogSkipsUnpublishedRow(t *testing.T) {
	f, catalog := startCatalogStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"unknown","noteContent":"unsupported"}`)
	key := f.ExternalKey()
	published := "6a7c6caf00000000006333" + uuid.NewString()[:2]
	draft := "6a7c6caf00000000006433" + uuid.NewString()[:2]

	status, receipt := submitV2BatchRaw(t, f, catalog.ID, map[string]any{
		"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{"items": []any{
			catalogItem(key, published, "published"),
			catalogItem(key, draft, "draft"),
		}, "enumeration_complete": false, "partition": "published", "consistency": "best_effort"},
	})
	if status != http.StatusOK {
		t.Fatalf("unpublished row must not fail the batch: %d %s", status, receipt)
	}
	var out struct {
		Accepted int              `json:"accepted"`
		Rows     []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(receipt, &out); err != nil {
		t.Fatal(err)
	}
	if out.Accepted != 1 || len(out.Rows) != 2 || out.Rows[1]["state"] != "skipped" {
		t.Fatalf("unpublished row must be skipped in place: %v", out.Rows)
	}
	var mirrors int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_work_mirror
		WHERE account_id=$1 AND external_id IN ($2,$3)`, f.Account.ID, published, draft).Scan(&mirrors); err != nil {
		t.Fatal(err)
	}
	if mirrors != 1 {
		t.Fatalf("only published rows may enter the mirror: mirrors=%d", mirrors)
	}
}

// TestPlatformV2MetricsRejectsRowWithoutExternalID 验证：metrics 批次里缺少稳定
// 外部编号的行被单独拒绝，同批其它行照常写观测。
func TestPlatformV2MetricsRejectsRowWithoutExternalID(t *testing.T) {
	f := startMetricsStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"supported","noteContent":"unsupported"}`)
	first, second := completePlatformV2CatalogStage(t, f)

	env.srv.schedulePlatformRuns(context.Background())
	metrics := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if metrics.Stage != "metrics" {
		t.Fatalf("expected metrics stage, got %q", metrics.Stage)
	}
	key := f.ExternalKey()
	orphan := metricObservationRow(key, first)
	delete(orphan, "external_id")
	status, receipt := submitV2BatchRaw(t, f, metrics.ID, map[string]any{
		"protocol_version": 2, "lease_generation": metrics.LeaseGeneration,
		"authorization_revision": metrics.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "metrics",
		"data": map[string]any{"observations": []any{
			metricObservationRow(key, second), orphan,
		}},
	})
	if status != http.StatusOK {
		t.Fatalf("one invalid metric row must not fail the batch: %d %s", status, receipt)
	}
	var out struct {
		Accepted int              `json:"accepted"`
		Rejected int              `json:"rejected"`
		Rows     []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(receipt, &out); err != nil {
		t.Fatal(err)
	}
	if out.Accepted != 1 || out.Rejected != 1 {
		t.Fatalf("invalid metric row must be isolated: accepted=%d rejected=%d rows=%v", out.Accepted, out.Rejected, out.Rows)
	}
	if len(out.Rows) != 2 || out.Rows[1]["state"] != "rejected" {
		// 不钉死 error_code：目录 inline_metrics 那条路径报 invalid_metric，
		// 独立的 metrics 批次报 invalid_row，两处措辞尚未统一。这里只断言
		// 「那一行被拒且被就地标注」，避免把不一致固化成契约。
		t.Fatalf("invalid metric row must be reported in place: %v", out.Rows)
	}
	var observations int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_metric_observation
		WHERE account_id=$1 AND external_id IN ($2,$3)`, f.Account.ID, first, second).Scan(&observations); err != nil {
		t.Fatal(err)
	}
	if observations != 1 {
		t.Fatalf("only the valid metric row may be written: observations=%d", observations)
	}
}
