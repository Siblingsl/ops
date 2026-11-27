package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestPlatformV2ClaimImmediatelySchedulesQueuedOperation(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-immediate-claim")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET
		capabilities=$2,auto_collect=false WHERE id=$1`, f.Connection,
		[]byte(`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}

	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", path,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("create account sync: %d %s", status, response)
	}
	var created struct {
		Operation struct {
			ID       uuid.UUID `json:"id"`
			Revision int64     `json:"revision"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(response, &created); err != nil {
		t.Fatal(err)
	}
	if created.Operation.Revision != 1 {
		t.Fatalf("create response revision must remain 1, got %d", created.Operation.Revision)
	}

	run := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if run.Stage != "profile" {
		t.Fatalf("claim must immediately schedule and return profile run, got %q", run.Stage)
	}
}

func TestPlatformV2NextClaimImmediatelySchedulesNextStage(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-immediate-next")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET
		capabilities=$2,auto_collect=false WHERE id=$1`, f.Connection,
		[]byte(`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}

	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", path,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("create account sync: %d %s", status, response)
	}

	profile := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if profile.Stage != "profile" {
		t.Fatalf("initial stage must be profile, got %q", profile.Stage)
	}
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "complete", nil, "succeeded"))

	var opStatus, opStage string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status, stage FROM platform_sync_operation
		WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1`, f.Account.ID).Scan(&opStatus, &opStage); err != nil {
		t.Fatalf("query operation after final batch: %v", err)
	}
	if opStatus != "queued" || opStage != "catalog" {
		t.Fatalf("operation after final batch = (%q, %q), want (queued, catalog)", opStatus, opStage)
	}

	var queuedRunCount int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_run
		WHERE account_id=$1 AND status='queued'`, f.Account.ID).Scan(&queuedRunCount); err != nil {
		t.Fatalf("count queued runs after final batch: %v", err)
	}
	if queuedRunCount != 0 {
		t.Fatalf("final batch must not pre-enqueue next stage run, got queuedRunCount=%d", queuedRunCount)
	}

	catalog := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if catalog.Stage != "catalog" {
		t.Fatalf("next claimed run stage = %q, want catalog", catalog.Stage)
	}
}
