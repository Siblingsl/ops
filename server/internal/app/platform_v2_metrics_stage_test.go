package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// startMetricsStageFixture 建一条 account_sync 操作，并把连接能力写成
// 「目录可读 + 单篇指标可读」，让 catalog 之后真的能进入 metrics 阶段。
//
// 为什么要单独造这条链：DEV-PS105 之前 `probeXhsLoginIdentity` 把
// `perNoteMetrics` 硬写成 unknown，metrics 阶段在真实环境里从未执行过，
// 于是服务端这条分支一直没有任何测试覆盖。
func startMetricsStageFixture(t *testing.T, capabilities string) *platformRunFixture {
	t.Helper()
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:"+uuid.NewString())
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_connection SET capabilities=$2,auto_collect=false WHERE id=$1`,
		f.Connection, []byte(capabilities)); err != nil {
		t.Fatal(err)
	}
	status, response := f.signedSyncRequest(t, "platform.account.sync.request",
		"/api/v1/accounts/"+f.Account.ID.String()+"/platform-account-sync",
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("start sync: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	return f
}

// completePlatformV2CatalogStage 走完 profile → catalog 两个阶段，
// 返回写进镜像的两篇作品的外部编号。
func completePlatformV2CatalogStage(t *testing.T, f *platformRunFixture) (string, string) {
	t.Helper()
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
	first := "6a7c6caf00000000005033" + uuid.NewString()[:2]
	second := "6a7c6caf00000000005133" + uuid.NewString()[:2]
	publishedAt := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	items := make([]any, 0, 2)
	for _, externalID := range []string{first, second} {
		items = append(items, map[string]any{
			"external_id": externalID, "author_external_account_key": f.ExternalKey(),
			"remote_content_type": "image_note", "remote_status": "published", "title": "指标阶段样本",
			"summary": "简短摘要", "author_display": "巡检号", "published_at": publishedAt,
			"topics": []string{}, "tags": []string{},
			"field_states": map[string]string{"title": "present", "published_at": "present", "summary": "present"},
		})
	}
	submitPlatformV2Batch(t, f, catalog.ID, map[string]any{
		"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{"items": items, "enumeration_complete": false,
			"partition": "published", "consistency": "best_effort"},
	})
	submitPlatformV2Batch(t, f, catalog.ID, platformV2ControlBatch(catalog, 1, "complete", map[string]any{
		"enumeration_complete": true, "total_count": 2, "partition": "published", "consistency": "best_effort",
	}, "succeeded"))
	return first, second
}

// metricObservationRow 造一条 work 范围的指标观测行。
func metricObservationRow(externalKey, externalID string) map[string]any {
	asOf := time.Now().UTC().Truncate(time.Second)
	return map[string]any{
		"scope": "work", "external_account_key": externalKey, "external_id": externalID,
		"source": "xhs_browser", "temporal_kind": "cumulative", "observed_at": asOf, "as_of_at": asOf,
		"adapter_version": "fixture-1", "mapping_version": 1,
		"values":      map[string]any{"view_times": map[string]any{"value": 188, "precision": "exact", "unit": "unknown"}},
		"field_paths": map[string]string{"view_times": "fixture.note.view_count"},
	}
}

// ExternalKey 返回连接对外声明的平台账号键。
func (f *platformRunFixture) ExternalKey() string {
	var key string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT external_account_key FROM platform_connection WHERE id=$1`, f.Connection).Scan(&key); err != nil {
		return ""
	}
	return key
}

func operationSnapshot(t *testing.T, f *platformRunFixture) (status, stage, metricsState, metricsReason string) {
	t.Helper()
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status,stage,
		coalesce(coverage->'metrics'->>'state',''),coalesce(coverage->'metrics'->>'reason','')
		FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync'
		ORDER BY created_at DESC LIMIT 1`, f.Account.ID).Scan(&status, &stage, &metricsState, &metricsReason); err != nil {
		t.Fatal(err)
	}
	return status, stage, metricsState, metricsReason
}

// TestPlatformV2MetricsStageRunsWhenCapabilitySupported 验证：连接声明单篇指标可读后，
// catalog 完成会推进到 metrics 阶段，观测写入镜像并把 initial_metrics_state 置为 complete。
func TestPlatformV2MetricsStageRunsWhenCapabilitySupported(t *testing.T) {
	f := startMetricsStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"supported","noteContent":"unsupported"}`)
	first, second := completePlatformV2CatalogStage(t, f)

	if status, stage, state, reason := operationSnapshot(t, f); status != "queued" || stage != "metrics" || state != "not_started" || reason != "" {
		t.Fatalf("catalog completion must queue metrics stage: status=%s stage=%s metrics=%s reason=%s", status, stage, state, reason)
	}

	env.srv.schedulePlatformRuns(context.Background())
	metrics := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if metrics.Stage != "metrics" {
		t.Fatalf("expected metrics stage, got %q", metrics.Stage)
	}

	// 冻结目标必须来自镜像，而不是让客户端自己挑作品。
	var bindingRaw []byte
	if err := env.srv.db.QueryRow(context.Background(), `SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`,
		metrics.ID).Scan(&bindingRaw); err != nil {
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
		t.Fatalf("metrics run must freeze both mirrors as targets, got %d", len(binding.PlatformWorks))
	}

	key := f.ExternalKey()
	submitPlatformV2Batch(t, f, metrics.ID, map[string]any{
		"protocol_version": 2, "lease_generation": metrics.LeaseGeneration,
		"authorization_revision": metrics.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "metrics",
		"data": map[string]any{"observations": []any{
			metricObservationRow(key, first), metricObservationRow(key, second),
		}},
	})
	submitPlatformV2Batch(t, f, metrics.ID, platformV2ControlBatch(metrics, 1, "complete", nil, "succeeded"))

	var observations, metricsComplete int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM platform_metric_observation WHERE account_id=$1 AND external_id IN ($2,$3)),
		(SELECT count(*) FROM platform_work_mirror WHERE account_id=$1 AND initial_metrics_state='complete')`,
		f.Account.ID, first, second).Scan(&observations, &metricsComplete); err != nil {
		t.Fatal(err)
	}
	if observations != 2 || metricsComplete != 2 {
		t.Fatalf("metrics stage must write observations and mark mirrors: observations=%d mirrors=%d", observations, metricsComplete)
	}

	// content 能力是 unsupported，所以整条操作按设计只能是 partial；
	// 这里断言的是 metrics 段本身走完，而不是把 partial 当成失败。
	status, stage, state, reason := operationSnapshot(t, f)
	if status != "partial" || stage != "complete" || state != "complete" || reason != "" {
		t.Fatalf("metrics completion must close the stage: status=%s stage=%s metrics=%s reason=%s", status, stage, state, reason)
	}
}

// TestPlatformV2MetricsStageSkippedWhenCapabilityUnknown 验证：单篇指标能力没有核验时，
// metrics 阶段不能被调度，覆盖率要如实写 unsupported + metrics_capability_unverified。
func TestPlatformV2MetricsStageSkippedWhenCapabilityUnknown(t *testing.T) {
	f := startMetricsStageFixture(t, `{"adapterVersion":"fixture-1","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"unknown","noteContent":"unsupported"}`)
	completePlatformV2CatalogStage(t, f)

	status, stage, state, reason := operationSnapshot(t, f)
	if status != "partial" || stage != "complete" || state != "unsupported" || reason != "metrics_capability_unverified" {
		t.Fatalf("unverified metrics capability must close the operation honestly: status=%s stage=%s metrics=%s reason=%s",
			status, stage, state, reason)
	}
	var metricsRuns int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_run
		WHERE account_id=$1 AND operation_stage='metrics'`, f.Account.ID).Scan(&metricsRuns); err != nil {
		t.Fatal(err)
	}
	if metricsRuns != 0 {
		t.Fatalf("metrics stage must not be scheduled without verified capability, got %d run(s)", metricsRuns)
	}
}
