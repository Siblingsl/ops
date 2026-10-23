package app

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPlatformAccountSyncProofOperationsArePathBound(t *testing.T) {
	accountID := uuid.NewString()
	for _, tc := range []struct {
		operation string
		path      string
	}{
		{"platform.account.sync.request", "/api/v1/accounts/" + accountID + "/platform-account-sync"},
		{"platform.metrics.refresh.request", "/api/v1/accounts/" + accountID + "/platform-metrics-refresh"},
	} {
		if !desktopOperationPathAllowed(tc.operation, http.MethodPost, tc.path) {
			t.Fatalf("operation %s must allow its exact business endpoint", tc.operation)
		}
		if desktopOperationPathAllowed(tc.operation, http.MethodPost, tc.path+"/extra") ||
			desktopOperationPathAllowed(tc.operation, http.MethodGet, tc.path) {
			t.Fatalf("operation %s accepted a different method or path", tc.operation)
		}
	}
}

func TestPlatformAccountSyncRequiresVerifiedCatalogCapability(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	body := platformAccountSyncBody(t, f.Connection, "incremental")
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", path, body, uuid.NewString())
	if status != http.StatusUnprocessableEntity || apiCode(response) != "capability_unverified" {
		t.Fatalf("unverified work-list capability must be rejected: %d %s", status, response)
	}
	var operations int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_operation WHERE account_id=$1`, f.Account.ID).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if operations != 0 {
		t.Fatalf("capability rejection created %d operations", operations)
	}
}

func TestPlatformAccountSyncIdempotencyAndActiveOperationReuse(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"adapter_version":"fixture-1","mapping_version":1,"browser_version":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	body := platformAccountSyncBody(t, f.Connection, "incremental")
	key := uuid.NewString()
	status, first := f.signedSyncRequest(t, "platform.account.sync.request", path, body, key)
	if status != http.StatusAccepted || apiCode(first) != "" {
		t.Fatalf("first sync request should be accepted: %d %s", status, first)
	}
	var initial struct {
		Status    string `json:"status"`
		Operation struct {
			ID            uuid.UUID `json:"id"`
			EffectiveMode string    `json:"effective_mode"`
			Status        string    `json:"status"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(first, &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Status != "queued" || initial.Operation.ID == uuid.Nil || initial.Operation.EffectiveMode != "initial" || initial.Operation.Status != "queued" {
		t.Fatalf("first request must resolve to one initial operation: %s", first)
	}

	status, replay := f.signedSyncRequest(t, "platform.account.sync.request", path, body, key)
	if status != http.StatusAccepted {
		t.Fatalf("same key replay status: %d %s", status, replay)
	}
	var replayed struct {
		Operation struct {
			ID uuid.UUID `json:"id"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(replay, &replayed); err != nil || replayed.Operation.ID != initial.Operation.ID {
		t.Fatalf("same key must return the stored operation: %s err=%v", replay, err)
	}

	status, conflict := f.signedSyncRequest(t, "platform.account.sync.request", path,
		platformAccountSyncBody(t, f.Connection, "full_reconcile"), key)
	if status != http.StatusConflict || apiCode(conflict) != "idempotency_conflict" {
		t.Fatalf("same key with different request must conflict: %d %s", status, conflict)
	}

	status, existing := f.signedSyncRequest(t, "platform.account.sync.request", path, body, uuid.NewString())
	if status != http.StatusOK {
		t.Fatalf("compatible active request should reuse the operation: %d %s", status, existing)
	}
	var reused struct {
		Status    string `json:"status"`
		Operation struct {
			ID uuid.UUID `json:"id"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(existing, &reused); err != nil || reused.Status != "existing" || reused.Operation.ID != initial.Operation.ID {
		t.Fatalf("new key should reuse the compatible active operation: %s err=%v", existing, err)
	}
}

func TestPlatformAccountSyncExpiredV2RunRetriesSameStage(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-expired-sync")
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
		t.Fatalf("account sync request: %d %s", status, response)
	}
	ctx := context.Background()
	env.srv.schedulePlatformRuns(ctx)
	first := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if first.Stage != "profile" {
		t.Fatalf("first account sync stage = %q, want profile", first.Stage)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET lease_expires_at=now()-interval '1 minute' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}

	env.srv.schedulePlatformRuns(ctx)

	var operationStatus string
	var operationStage string
	if err := env.srv.db.QueryRow(ctx, `SELECT status,stage FROM platform_sync_operation
		WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1`, f.Account.ID).
		Scan(&operationStatus, &operationStage); err != nil {
		t.Fatal(err)
	}
	if operationStatus != "queued" || operationStage != first.Stage {
		t.Fatalf("expired v2 work must requeue its same operation stage: status=%s stage=%s", operationStatus, operationStage)
	}
	var retry struct {
		ID         uuid.UUID
		Attempt    int
		Protocol   int
		Stage      string
		DeadlineAt time.Time
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT id,attempt,wire_protocol_version,operation_stage,deadline_at
		FROM platform_sync_run WHERE operation_id=(SELECT id FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1)
		AND status='queued'`, f.Account.ID).Scan(&retry.ID, &retry.Attempt, &retry.Protocol, &retry.Stage, &retry.DeadlineAt); err != nil {
		t.Fatalf("v2 retry should be queued: %v", err)
	}
	if retry.ID == first.ID || retry.Attempt != 2 || retry.Protocol != 2 || retry.Stage != first.Stage || !retry.DeadlineAt.After(env.srv.now()) {
		t.Fatalf("retry must preserve operation protocol/stage and receive a fresh deadline: %+v", retry)
	}
	second := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET lease_expires_at=now()-interval '1 minute' WHERE id=$1`, second.ID); err != nil {
		t.Fatal(err)
	}
	env.srv.schedulePlatformRuns(ctx)
	var exhaustedStatus, exhaustedStage string
	if err := env.srv.db.QueryRow(ctx, `SELECT status,stage FROM platform_sync_operation
		WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1`, f.Account.ID).
		Scan(&exhaustedStatus, &exhaustedStage); err != nil {
		t.Fatal(err)
	}
	if exhaustedStatus != "failed" || exhaustedStage != "complete" {
		t.Fatalf("retry exhaustion must terminate instead of leaving a stuck operation: status=%s stage=%s", exhaustedStatus, exhaustedStage)
	}
}

func TestPlatformAccountSyncRecoversLegacyOrphanRetry(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-legacy-sync")
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
		t.Fatalf("account sync request: %d %s", status, response)
	}
	ctx := context.Background()
	env.srv.schedulePlatformRuns(ctx)
	first := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if _, err := env.srv.db.Exec(ctx, `UPDATE platform_sync_run SET status='expired',finished_at=now() WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	// Recreate the persisted shape from the broken retry path: an expired v1 run
	// with the operation id only inside query_scope, while the operation stays running.
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO platform_sync_run
		(connection_id,workspace_id,account_id,trigger,task_kind,status,query_scope,authorization_revision,
		workspace_authorization_revision,adapter_version,mapping_version,browser_version,binding_snapshot,deadline_at,
		attempt,wire_protocol_version,operation_stage)
		SELECT connection_id,workspace_id,account_id,trigger,task_kind,'expired',query_scope,authorization_revision,
		workspace_authorization_revision,adapter_version,mapping_version,browser_version,binding_snapshot,now()-interval '5 minutes',
		2,1,'' FROM platform_sync_run WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}

	status, response = f.signedSyncRequest(t, "platform.account.sync.request", path,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusOK {
		t.Fatalf("retry request for existing sync: %d %s", status, response)
	}

	var recoveredStatus, recoveredStage string
	if err := env.srv.db.QueryRow(ctx, `SELECT status,stage FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1`, f.Account.ID).Scan(&recoveredStatus, &recoveredStage); err != nil {
		t.Fatal(err)
	}
	if recoveredStatus != "queued" || recoveredStage != first.Stage {
		t.Fatalf("legacy stuck operation should resume from the saved stage: status=%s stage=%s", recoveredStatus, recoveredStage)
	}
	var retry struct {
		ID       uuid.UUID
		Attempt  int
		Protocol int
		Stage    string
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT id,attempt,wire_protocol_version,operation_stage
		FROM platform_sync_run WHERE operation_id=(SELECT id FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1)
		AND status='queued'`, f.Account.ID).Scan(&retry.ID, &retry.Attempt, &retry.Protocol, &retry.Stage); err != nil {
		t.Fatalf("legacy stuck operation should be recovered into a v2 retry: %v", err)
	}
	if retry.ID == first.ID || retry.Attempt != 2 || retry.Protocol != 2 || retry.Stage != first.Stage {
		t.Fatalf("legacy orphan recovery must restore the same v2 stage: %+v", retry)
	}
}

func TestPlatformMetricsRefreshNoTargetsDoesNotQueueRun(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	withPlatformSyncFeatureEnabled(t, "metrics_refresh", "xhs", true)
	preparePlatformSyncConnection(t, f)
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-metrics-refresh"
	body, err := json.Marshal(map[string]any{
		"target_scope": "due_and_recent", "platform_work_ids": []string{}, "work_ids": []string{},
		"expected_connection_revision": connectionAuthRevision(t, f.Connection),
	})
	if err != nil {
		t.Fatal(err)
	}
	status, response := f.signedSyncRequest(t, "platform.metrics.refresh.request", path, body, uuid.NewString())
	if status != http.StatusOK || apiCode(response) != "" {
		t.Fatalf("empty metric target set must return no_targets: %d %s", status, response)
	}
	var out struct {
		Status  string `json:"status"`
		Targets int    `json:"target_count"`
	}
	if err := json.Unmarshal(response, &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "no_targets" || out.Targets != 0 {
		t.Fatalf("empty metric target response: %s", response)
	}
	var runs int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_run WHERE connection_id=$1`, f.Connection).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 0 {
		t.Fatalf("no-target refresh queued %d platform runs", runs)
	}
	var operations int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_sync_operation
		WHERE account_id=$1 AND kind='metrics_refresh' AND status='succeeded'`, f.Account.ID).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if operations != 1 {
		t.Fatalf("no-target request must persist a successful operation receipt, got %d", operations)
	}
}

func TestPlatformAccountSyncRequiresDesktopAndExposesOperationProgress(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}
	basePath := "/api/v1/accounts/" + f.Account.ID.String()
	path := basePath + "/platform-account-sync"
	body := platformAccountSyncBody(t, f.Connection, "incremental")
	status, response := env.do(http.MethodPost, path, json.RawMessage(body))
	if status != http.StatusForbidden || apiCode(response) != "desktop_required" {
		t.Fatalf("web request must require the local desktop proof: %d %s", status, response)
	}
	status, response = f.signedSyncRequest(t, "platform.account.sync.request", path, body, uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("desktop request status: %d %s", status, response)
	}
	var created struct {
		Operation struct {
			ID uuid.UUID `json:"id"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(response, &created); err != nil || created.Operation.ID == uuid.Nil {
		t.Fatalf("operation id missing: %s err=%v", response, err)
	}
	var detail map[string]any
	status, response = env.do(http.MethodGet, basePath+"/platform-sync-operations/"+created.Operation.ID.String(), nil)
	if status != http.StatusOK {
		t.Fatalf("operation detail: %d %s", status, response)
	}
	if err := json.Unmarshal(response, &detail); err != nil {
		t.Fatal(err)
	}
	if detail["operation"] == nil {
		t.Fatalf("operation detail missing: %s", response)
	}
	status, response = env.do(http.MethodGet, basePath+"/platform-sync-operations", nil)
	if status != http.StatusOK {
		t.Fatalf("operation list: %d %s", status, response)
	}
	if !json.Valid(response) {
		t.Fatalf("invalid operation list: %s", response)
	}
}

func TestPlatformSyncOperationPauseResumeCancelAndRevision(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}
	createPath := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", createPath, platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("create: %d %s", status, response)
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
	actionPath := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-sync-operations/" + created.Operation.ID.String() + "/actions"
	postAction := func(action string, revision int64) (int, []byte) {
		body, _ := json.Marshal(map[string]any{"action": action, "expected_operation_revision": revision})
		return env.do(http.MethodPost, actionPath, json.RawMessage(body))
	}
	status, response = postAction("pause", 1)
	if status != http.StatusOK {
		t.Fatalf("pause: %d %s", status, response)
	}
	status, response = postAction("cancel", 1)
	if status != http.StatusConflict || apiCode(response) != "operation_revision_conflict" {
		t.Fatalf("stale revision: %d %s", status, response)
	}
	resumeBody, _ := json.Marshal(map[string]any{"action": "resume", "expected_operation_revision": 2})
	status, response = f.signedSyncRequest(t, "platform.sync.operation.resume", actionPath, resumeBody, uuid.NewString())
	if status != http.StatusOK {
		t.Fatalf("resume: %d %s", status, response)
	}
	status, response = postAction("cancel", 3)
	if status != http.StatusOK {
		t.Fatalf("cancel: %d %s", status, response)
	}
	status, response = postAction("cancel", 3)
	if status != http.StatusOK {
		t.Fatalf("repeat cancel: %d %s", status, response)
	}
}

func TestPlatformSnapshotAndWorkMirrorReadEndpointsAreScoped(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-sync-self")
	preparePlatformSyncConnection(t, f)
	var mirrorID uuid.UUID
	err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_work_mirror
		(workspace_id,account_id,platform,external_account_key,external_id,remote_content_type,remote_status,
		title,body_text,body_structure,summary,topics,tags,cover_ref,media_refs,published_at,content_state,
		field_coverage,content_observed_at)
		VALUES ($1,$2,'xhs',$3,'6a7c6caf00000000005033660','image_note','published','镜像标题','平台正文',
		'[]','摘要','[]','[]','https://example.test/cover.jpg','[]',now(),'complete',
		'{"title":"complete","body":"complete"}',now()) RETURNING id`,
		f.Workspace, f.Account.ID, "xhs_user_id:fixture-sync-self").Scan(&mirrorID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_account_snapshot
		(account_id,workspace_id,platform,external_account_key,connection_id,display_name,safe_fields,field_states,observed_at)
		VALUES ($1,$2,'xhs','xhs_user_id:fixture-sync-self',$3,'测试昵称','{}','{"display_name":"available"}',now())`,
		f.Account.ID, f.Workspace, f.Connection); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/accounts/" + f.Account.ID.String()
	status, response := env.do(http.MethodGet, base+"/platform-profile", nil)
	if status != http.StatusOK || !json.Valid(response) {
		t.Fatalf("profile: %d %s", status, response)
	}
	var profile struct {
		Snapshot map[string]any `json:"snapshot"`
	}
	if err := json.Unmarshal(response, &profile); err != nil || profile.Snapshot["display_name"] != "测试昵称" {
		t.Fatalf("profile snapshot: %s err=%v", response, err)
	}
	status, response = env.do(http.MethodGet, base+"/platform-works?limit=20", nil)
	if status != http.StatusOK {
		t.Fatalf("mirror list: %d %s", status, response)
	}
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(response, &list); err != nil || len(list.Items) != 1 {
		t.Fatalf("mirror list: %s err=%v", response, err)
	}
	if _, ok := list.Items[0]["body_text"]; ok {
		t.Fatalf("list must not return full content: %s", response)
	}
	status, response = env.do(http.MethodGet, base+"/platform-works/"+mirrorID.String(), nil)
	if status != http.StatusOK {
		t.Fatalf("mirror detail: %d %s", status, response)
	}
	var detail struct {
		Work map[string]any `json:"work"`
	}
	if err := json.Unmarshal(response, &detail); err != nil || detail.Work["body_text"] != "平台正文" {
		t.Fatalf("mirror detail: %s err=%v", response, err)
	}
}

func TestCreateDraftFromPlatformMirrorPreservesSourceAndRejectsLossyContent(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-draft-self")
	preparePlatformSyncConnection(t, f)
	var mirrorID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_work_mirror
		(workspace_id,account_id,platform,external_account_key,external_id,remote_content_type,remote_status,title,body_text,
		 body_structure,media_refs,content_state,content_revision,revision,field_coverage)
		VALUES ($1,$2,'xhs','xhs_user_id:fixture-draft-self','6a7c6caf00000000005033661','image_note','published',
		 '同步来源标题','同步来源正文','[]','[]','complete',2,4,'{"body_text":"complete","body_structure":"complete","media_refs":"complete"}')
		RETURNING id`, f.Workspace, f.Account.ID).Scan(&mirrorID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-works/" + mirrorID.String() + "/draft"
	var created Work
	env.mustJSON(t, http.MethodPost, path, map[string]any{
		"expected_mirror_revision": int64(4), "expected_content_revision": 2,
	}, &created)
	if created.Status != "drafting" || created.ContentFormat != "image_note" || created.PublishedAt != nil || created.ExternalID != nil {
		t.Fatalf("platform mirror draft must remain a local unbound draft: %+v", created)
	}
	if created.PlatformSourceMirrorID == nil || *created.PlatformSourceMirrorID != mirrorID ||
		created.PlatformSourceContentRevision == nil || *created.PlatformSourceContentRevision != 2 ||
		created.PlatformSourceMirrorRevision == nil || *created.PlatformSourceMirrorRevision != 4 {
		t.Fatalf("draft must retain the source mirror and both frozen revisions: %+v", created)
	}
	if len(created.Sections) != 1 || created.Sections[0].ContentMD != "同步来源正文" {
		t.Fatalf("draft body was not copied from the selected mirror: %+v", created.Sections)
	}

	// A stale detail view cannot create a draft from a newer source revision.
	env.expectErr(t, http.MethodPost, path, map[string]any{
		"expected_mirror_revision": int64(3), "expected_content_revision": 2,
	}, "platform_mirror_changed")

	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_work_mirror SET cover_ref='https://sns-img.example.test/cover.jpg',revision=5 WHERE id=$1`, mirrorID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, http.MethodPost, path, map[string]any{
		"expected_mirror_revision": int64(5), "expected_content_revision": 2,
	}, "platform_content_not_convertible")
}

func TestPlatformAccountSyncV2WritesSnapshotCatalogInlineMetricsAndCompletesPartial(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-v2-self")
	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET capabilities=$2 WHERE id=$1`, f.Connection,
		[]byte(`{"adapterVersion":"fixture-1","mappingVersion":1,"browserVersion":"155.0.0.0","workList":"supported"}`)); err != nil {
		t.Fatal(err)
	}

	createPath := "/api/v1/accounts/" + f.Account.ID.String() + "/platform-account-sync"
	status, response := f.signedSyncRequest(t, "platform.account.sync.request", createPath,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("create account sync: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	firstRun := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if firstRun.Stage != "profile" {
		t.Fatalf("initial operation should start at profile, got %q", firstRun.Stage)
	}
	profile := map[string]any{
		"protocol_version": 2, "lease_generation": firstRun.LeaseGeneration,
		"authorization_revision": firstRun.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "account_snapshot",
		"data": map[string]any{
			"identity_external_account_key": "xhs_user_id:fixture-v2-self", "display_name": "巡检号",
			"field_states": map[string]string{"display_name": "present", "bio": "unknown"},
			"observed_at":  time.Now().UTC().Format(time.RFC3339Nano),
		},
	}
	submitPlatformV2Batch(t, f, firstRun.ID, profile)
	submitPlatformV2Batch(t, f, firstRun.ID, platformV2ControlBatch(firstRun, 1, "complete", nil, "succeeded"))
	var displayName string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT display_name FROM platform_account_snapshot WHERE account_id=$1`, f.Account.ID).Scan(&displayName); err != nil || displayName != "巡检号" {
		t.Fatalf("account snapshot not written: display_name=%q err=%v", displayName, err)
	}

	env.srv.schedulePlatformRuns(context.Background())
	catalogRun := claimPlatformV2Run(t, f, "account_sync", "fixture-1")
	if catalogRun.Stage != "catalog" {
		t.Fatalf("profile completion should schedule catalog, got %q", catalogRun.Stage)
	}
	externalID := "6a7c6caf00000000005033660"
	publishedAt := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	metricAsOf := time.Now().UTC().Truncate(time.Second)
	catalog := map[string]any{
		"protocol_version": 2, "lease_generation": catalogRun.LeaseGeneration,
		"authorization_revision": catalogRun.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{
			"items": []any{map[string]any{
				"external_id": externalID, "author_external_account_key": "xhs_user_id:fixture-v2-self",
				"remote_content_type": "image_note", "remote_status": "published", "title": "本人已发布作品",
				"summary": "简短摘要", "author_display": "巡检号", "published_at": publishedAt,
				"topics": []string{}, "tags": []string{},
				"field_states": map[string]string{"title": "present", "published_at": "present", "summary": "present"},
				"inline_metrics": []any{map[string]any{
					"scope": "work", "external_account_key": "xhs_user_id:fixture-v2-self", "external_id": externalID,
					"source": "xhs_browser", "temporal_kind": "cumulative", "observed_at": metricAsOf,
					"as_of_at": metricAsOf, "adapter_version": "fixture-1", "mapping_version": 1,
					"values":      map[string]any{"view_times": map[string]any{"value": 177, "precision": "exact", "unit": "unknown"}},
					"field_paths": map[string]string{"view_times": "fixture.note.view_count"},
				}},
			}},
			"enumeration_complete": false, "partition": "published", "consistency": "best_effort",
		},
	}
	submitPlatformV2Batch(t, f, catalogRun.ID, catalog)
	control := platformV2ControlBatch(catalogRun, 1, "complete", map[string]any{
		"enumeration_complete": true, "total_count": 1, "partition": "published", "consistency": "best_effort",
	}, "succeeded")
	submitPlatformV2Batch(t, f, catalogRun.ID, control)
	var mirrorID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT id FROM platform_work_mirror WHERE account_id=$1 AND external_id=$2`,
		f.Account.ID, externalID).Scan(&mirrorID); err != nil {
		t.Fatalf("catalog mirror not written: %v", err)
	}
	var observationCount, correctlyLinked int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*),count(*) FILTER (WHERE platform_work_id=$2)
		FROM platform_metric_observation WHERE account_id=$1`, f.Account.ID, mirrorID).Scan(&observationCount, &correctlyLinked); err != nil || observationCount != 1 || correctlyLinked != 1 {
		t.Fatalf("inline metric must use shared observation writer and server-derived mirror id: count=%d linked=%d err=%v", observationCount, correctlyLinked, err)
	}
	var opStatus, opStage, catalogCoverage string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status,stage,coverage->'catalog'->>'state'
		FROM platform_sync_operation WHERE account_id=$1 AND kind='account_sync' ORDER BY created_at DESC LIMIT 1`, f.Account.ID).
		Scan(&opStatus, &opStage, &catalogCoverage); err != nil {
		t.Fatal(err)
	}
	if opStatus != "partial" || opStage != "complete" || catalogCoverage != "complete" {
		t.Fatalf("catalog can complete while unverified content/metrics leave overall operation partial: status=%s stage=%s catalog=%s", opStatus, opStage, catalogCoverage)
	}

	status, response = f.signedSyncRequest(t, "platform.account.sync.request", createPath,
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("incremental sync after a complete catalog should be accepted: %d %s", status, response)
	}
	var next struct {
		Operation struct {
			EffectiveMode string `json:"effective_mode"`
		} `json:"operation"`
	}
	if err := json.Unmarshal(response, &next); err != nil || next.Operation.EffectiveMode != "incremental" {
		t.Fatalf("complete catalog must be the baseline even when later stages are partial: mode=%q response=%s err=%v",
			next.Operation.EffectiveMode, response, err)
	}
}

type platformV2TestRun struct {
	ID                    uuid.UUID
	LeaseGeneration       int64
	AuthorizationRevision int64
	Stage                 string
}

func claimPlatformV2Run(t *testing.T, f *platformRunFixture, taskKind, adapterVersion string) platformV2TestRun {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"protocol_versions": []int{2}, "task_kinds": []string{taskKind},
		"result_types":     []string{"account_snapshot", "work_catalog", "work_content", "metrics", "control"},
		"adapter_versions": map[string]string{"xhs": adapterVersion}, "mapping_versions": map[string]int{"xhs": 1},
	})
	status, response := f.signedPlatform(t, "platform.run.claim", http.MethodPost, "/api/v1/desktop/platform/runs/claim", body)
	if status != http.StatusOK {
		t.Fatalf("v2 claim: %d %s", status, response)
	}
	var out struct {
		Run *struct {
			ID                    uuid.UUID `json:"id"`
			LeaseGeneration       int64     `json:"lease_generation"`
			AuthorizationRevision int64     `json:"authorization_revision"`
			OperationStage        string    `json:"operation_stage"`
		} `json:"run"`
	}
	if err := json.Unmarshal(response, &out); err != nil || out.Run == nil || out.Run.ID == uuid.Nil {
		t.Fatalf("v2 claim missing run: %s err=%v", response, err)
	}
	return platformV2TestRun{ID: out.Run.ID, LeaseGeneration: out.Run.LeaseGeneration,
		AuthorizationRevision: out.Run.AuthorizationRevision, Stage: out.Run.OperationStage}
}

func submitPlatformV2Batch(t *testing.T, f *platformRunFixture, runID uuid.UUID, body map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/desktop/platform/runs/" + runID.String() + "/results"
	status, response := f.signedPlatform(t, "platform.run.result", http.MethodPost, path, raw)
	if status != http.StatusOK {
		t.Fatalf("v2 result: %d %s", status, response)
	}
}

func platformV2ControlBatch(run platformV2TestRun, batchSeq int, state string, extra map[string]any, runStatus string) map[string]any {
	data := map[string]any{"state": state, "observed_at": time.Now().UTC().Format(time.RFC3339Nano)}
	if state != "complete" {
		data["reason"] = "profile_capability_unverified"
	}
	for key, value := range extra {
		data[key] = value
	}
	return map[string]any{
		"protocol_version": 2, "lease_generation": run.LeaseGeneration,
		"authorization_revision": run.AuthorizationRevision, "batch_seq": batchSeq, "final_batch": true,
		"run_status": runStatus, "result_type": "control", "data": data,
	}
}

func preparePlatformSyncConnection(t *testing.T, f *platformRunFixture) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE platform_connection SET
		platform_consent_version=1,consented_at=now(),last_seen_at=now() WHERE id=$1`, f.Connection); err != nil {
		t.Fatal(err)
	}
}

func withPlatformSyncFeatureEnabled(t *testing.T, feature, platform string, enabled bool) {
	t.Helper()
	key := "platform_" + feature + "." + platform + ".enabled"
	previous, err := env.srv.systemBool(context.Background(), key, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.srv.putSystemBool(context.Background(), key, enabled); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = env.srv.putSystemBool(context.Background(), key, previous) })
}

func platformAccountSyncBody(t *testing.T, connectionID uuid.UUID, mode string) []byte {
	t.Helper()
	var revision int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT authorization_revision FROM platform_connection WHERE id=$1`, connectionID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{"mode": mode, "expected_connection_revision": revision})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func (f *platformRunFixture) signedSyncRequest(t *testing.T, operation, path string, body []byte, key string) (int, []byte) {
	t.Helper()
	bodyHash := sha256.Sum256(body)
	_, challengeBody := env.do("POST", "/api/v1/desktop/challenges", map[string]any{
		"device_id": f.DeviceID, "operation": operation, "method": http.MethodPost,
		"path": path, "body_sha256": fmt.Sprintf("%x", bodyHash[:]),
	})
	var challenge struct {
		ID      string `json:"challenge_id"`
		Payload string `json:"signature_payload"`
	}
	if err := json.Unmarshal(challengeBody, &challenge); err != nil || challenge.ID == "" || challenge.Payload == "" {
		t.Fatalf("challenge %s %s: %s err=%v", operation, path, challengeBody, err)
	}
	signaturePayload, err := base64.StdEncoding.DecodeString(challenge.Payload)
	if err != nil {
		t.Fatal(err)
	}
	return xpDoRaw(t, env.client, env.csrf, http.MethodPost, path, body, map[string]string{
		"Idempotency-Key":         key,
		"X-OPS-Desktop-Device":    f.DeviceID.String(),
		"X-OPS-Desktop-Challenge": challenge.ID,
		"X-OPS-Desktop-Signature": base64.StdEncoding.EncodeToString(ed25519.Sign(f.PrivateKey, signaturePayload)),
	})
}

func apiCode(response []byte) string {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(response, &body)
	return body.Error.Code
}
