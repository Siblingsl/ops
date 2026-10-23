package app

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func startSyncPipelineFixture(t *testing.T) *platformRunFixture {
	t.Helper()
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:"+uuid.NewString())
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2,auto_collect=false WHERE id=$1`,
		f.Connection, []byte(`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", "/api/v1/accounts/"+f.Account.ID.String()+"/platform-account-sync",
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("start sync: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	return f
}

func TestPlatformSyncPipelineRecoveryUsesCurrentStageAttempts(t *testing.T) {
	f := startSyncPipelineFixture(t)
	ctx := context.Background()
	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET lease_expires_at=now()-interval '1 minute' WHERE id=$1`, profile.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.schedulePlatformRuns(ctx)
	profile = claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "unknown", nil, "partial"))
	// Simulate the next daily window without lifting the production three-run budget.
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET created_at=created_at-interval '1 day' WHERE account_id=$1`, f.Account.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.schedulePlatformRuns(ctx)
	catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if catalog.Stage != "catalog" {
		t.Fatalf("expected catalog stage, got %s", catalog.Stage)
	}
	// A historical orphan at catalog must not inherit the profile's second attempt.
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET status='expired',finished_at=now() WHERE id=$1`, catalog.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.recoverStalePlatformOperations(ctx, env.srv.now(), nil)
	env.srv.schedulePlatformRuns(ctx)
	retry := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	var attempt int
	if err := env.srv.db.QueryRow(ctx, `SELECT attempt FROM platform_sync_run WHERE id=$1`, retry.ID).Scan(&attempt); err != nil {
		t.Fatal(err)
	}
	if retry.Stage != "catalog" || attempt != 2 {
		t.Fatalf("current stage must retain its retry: stage=%s attempt=%d", retry.Stage, attempt)
	}
}

func TestPlatformSyncPipelineCheckpointResetsExpiryAttempts(t *testing.T) {
	f := startSyncPipelineFixture(t)
	ctx := context.Background()
	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "unknown", nil, "partial"))
	for page := 1; page <= 3; page++ {
		env.srv.schedulePlatformRuns(ctx)
		catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
		var attempt int
		if err := env.srv.db.QueryRow(ctx, `SELECT attempt FROM platform_sync_run WHERE id=$1`, catalog.ID).Scan(&attempt); err != nil {
			t.Fatal(err)
		}
		if attempt != 1 {
			t.Fatalf("successful checkpoint %d must not consume expiry retries: attempt=%d", page, attempt)
		}
		submitPlatformV2Batch(t, f, catalog.ID, platformV2ControlBatch(catalog, 0, "partial", map[string]any{
			"reason": "page_budget", "partition": "notes", "next_page": page * 3, "consistency": "best_effort",
		}, "partial"))
		if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET created_at=created_at-interval '1 day' WHERE account_id=$1`, f.Account.ID); err != nil {
			t.Fatal(err)
		}
	}
	env.srv.schedulePlatformRuns(ctx)
	catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET lease_expires_at=$2 WHERE id=$1`, catalog.ID, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	env.srv.schedulePlatformRuns(ctx)
	retry := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	var attempt, nextPage int
	if err := env.srv.db.QueryRow(ctx, `SELECT attempt,(query_scope->'checkpoint'->>'next_page')::int FROM platform_sync_run WHERE id=$1`, retry.ID).Scan(&attempt, &nextPage); err != nil {
		t.Fatal(err)
	}
	if attempt != 2 || nextPage != 9 {
		t.Fatalf("retry must preserve latest checkpoint: attempt=%d next_page=%d", attempt, nextPage)
	}
}

func TestPlatformSyncPipelineCatalogReceiptToMirrorReadback(t *testing.T) {
	f := startSyncPipelineFixture(t)
	ctx := context.Background()
	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "unknown", nil, "partial"))
	env.srv.schedulePlatformRuns(ctx)
	catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	var externalKey string
	if err := env.srv.db.QueryRow(ctx, `SELECT external_account_key FROM platform_connection WHERE id=$1`, f.Connection).Scan(&externalKey); err != nil {
		t.Fatal(err)
	}
	externalID := "6f0000000000000000000123"
	observedAt := time.Now().UTC().Truncate(time.Second)
	data := map[string]any{"items": []any{map[string]any{
		"external_id": externalID, "author_external_account_key": externalKey,
		"remote_content_type": "image_note", "remote_status": "published", "title": "分批同步的隔离作品",
		"published_at": observedAt.Add(-24 * time.Hour), "topics": []string{}, "tags": []string{},
		"field_states": map[string]string{"title": "present", "published_at": "present"},
		"inline_metrics": []any{map[string]any{"scope": "work", "external_account_key": externalKey, "external_id": externalID,
			"source": "xhs_browser", "temporal_kind": "cumulative", "observed_at": observedAt, "as_of_at": observedAt,
			"adapter_version": "fixture-1", "mapping_version": 1,
			"values":      map[string]any{"like_count": map[string]any{"value": 0, "precision": "exact", "unit": "count"}},
			"field_paths": map[string]string{"like_count": "fixture.note.likes"}}},
	}}, "partition": "notes", "enumeration_complete": false, "consistency": "best_effort"}
	batch := map[string]any{"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog", "data": data}
	raw, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	resultPath := "/api/v1/desktop/platform/runs/" + catalog.ID.String() + "/results"
	status, first := f.signedPlatform(t, "platform.run.result", http.MethodPost, resultPath, raw)
	if status != http.StatusOK {
		t.Fatalf("catalog result: %d %s", status, first)
	}
	status, duplicate := f.signedPlatform(t, "platform.run.result", http.MethodPost, resultPath, raw)
	if status != http.StatusOK || string(first) != string(duplicate) {
		t.Fatalf("duplicate batch must return same receipt: %d first=%s duplicate=%s", status, first, duplicate)
	}
	status, recovered := f.signedPlatform(t, "platform.run.receipt", http.MethodGet,
		"/api/v1/desktop/platform/runs/"+catalog.ID.String()+"/receipts/0", []byte(`{}`))
	var firstJSON, recoveredJSON platformReceipt
	if err := json.Unmarshal(first, &firstJSON); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(recovered, &recoveredJSON); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || !reflect.DeepEqual(firstJSON, recoveredJSON) {
		t.Fatalf("lost response must be recoverable by receipt: %d %s", status, recovered)
	}
	submitPlatformV2Batch(t, f, catalog.ID, platformV2ControlBatch(catalog, 1, "partial", map[string]any{
		"reason": "page_budget", "partition": "notes", "next_page": 3, "consistency": "best_effort",
	}, "partial"))
	base := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-works"
	status, response := env.do(http.MethodGet, base+"?limit=20", nil)
	if status != http.StatusOK || !strings.Contains(string(response), "分批同步的隔离作品") || strings.Contains(string(response), `"body_text"`) {
		t.Fatalf("checkpointed mirror must be visible before terminal status without full body: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(ctx)
	next := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	submitPlatformV2Batch(t, f, next.ID, platformV2ControlBatch(next, 0, "complete", map[string]any{
		"enumeration_complete": true, "total_count": 1, "partition": "notes", "consistency": "best_effort",
	}, "succeeded"))
	status, recovered = f.signedPlatform(t, "platform.run.receipt", http.MethodGet,
		"/api/v1/desktop/platform/runs/"+next.ID.String()+"/receipts/0", []byte(`{}`))
	if status != http.StatusOK || !strings.Contains(string(recovered), `"run_status":"succeeded"`) {
		t.Fatalf("terminal run receipt must remain readable: %d %s", status, recovered)
	}
	var mirrors, observations, localWorks int
	if err := env.srv.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM platform_work_mirror WHERE account_id=$1),
		(SELECT count(*) FROM platform_metric_observation WHERE account_id=$1),
		(SELECT count(*) FROM work WHERE account_id=$1)`, f.Account.ID).Scan(&mirrors, &observations, &localWorks); err != nil {
		t.Fatal(err)
	}
	if mirrors != 1 || observations != 1 || localWorks != 0 {
		t.Fatalf("no duplicate mirror/metric or implicit local creation: mirrors=%d observations=%d works=%d", mirrors, observations, localWorks)
	}
	var metricZero int
	if err := env.srv.db.QueryRow(ctx, `SELECT (values->'like_count'->>'value')::int FROM platform_metric_observation WHERE account_id=$1`, f.Account.ID).Scan(&metricZero); err != nil || metricZero != 0 {
		t.Fatalf("an actual zero metric must remain zero: value=%d err=%v", metricZero, err)
	}
	var operationState string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync'`, f.Account.ID).Scan(&operationState); err != nil || operationState != "partial" {
		t.Fatalf("unknown profile/content must not claim complete sync: status=%s err=%v", operationState, err)
	}
	var mirrorID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT id FROM platform_work_mirror WHERE account_id=$1`, f.Account.ID).Scan(&mirrorID); err != nil {
		t.Fatal(err)
	}
	status, response = env.do(http.MethodGet, base+"/"+mirrorID.String(), nil)
	if status != http.StatusOK || !strings.Contains(string(response), externalID) || !strings.Contains(string(response), `"content_state":"not_requested"`) {
		t.Fatalf("mirror detail must preserve unknown content instead of fabricating completion: %d %s", status, response)
	}
}
