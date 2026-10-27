package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// 本文件的测试要走到「用户点确认、观测投影成正式指标」这一步，因此适配器版本必须
// 与 metric_projection.go 里登记的真实映射一致（`xhs-1`）。共用夹具用的
// `fixture-1` 不在映射表里，确认时会被 422 `platform_mapping_unsupported` 挡下。
const catalogBindingAdapter = "xhs-1"

// startCatalogFixtureXhs1 建一条 account_sync 操作并把断点停在 catalog 领单状态。
//
// 与 startCatalogStageFixture 的区别只有适配器版本；不能直接复用那个夹具，
// 因为 run 的冻结适配器版本来自 claim 时的 `adapter_versions`，
// 与观测行里的 `adapter_version` 必须逐字相等，否则整批 409
// 「指标映射版本与 run 冻结版本不一致」。
func startCatalogFixtureXhs1(t *testing.T, capabilities string) (*platformRunFixture, platformV2TestRun) {
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
	profile := claimPlatformV2Run(t, f, "account_sync", catalogBindingAdapter)
	if profile.Stage != "profile" {
		t.Fatalf("initial stage must be profile, got %q", profile.Stage)
	}
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "complete", nil, "succeeded"))
	env.srv.schedulePlatformRuns(context.Background())
	catalog := claimPlatformV2Run(t, f, "account_sync", catalogBindingAdapter)
	if catalog.Stage != "catalog" {
		t.Fatalf("profile completion must schedule catalog, got %q", catalog.Stage)
	}
	return f, catalog
}

// TestPlatformV2CatalogFreezesLocalBindings 验证：catalog 阶段也要冻结本地绑定。
//
// 为什么这条必须钉住：目录响应顺带取得的 inline_metrics 会在同一批里写成观测，
// 而观测能不能被用户确认成正式指标，取决于 `platformV2LocalBindingForExternalID`
// 能不能在 `binding_snapshot.local_bindings` 里找到这一篇（metric_projection.go 的
// `confirmObservationTx` 只认 `match_state='bound'`）。
//
// 2026-10-27 的真实事故：catalog 阶段两个数组都是空的，小红书 39 篇作品全部导入成功，
// 但 39 条观测都是 `match_state=unmatched`，在作品库里逐条点确认一律 409
// 「该观测尚未匹配到已绑定作品」——数据在，却一步也用不了。
func TestPlatformV2CatalogFreezesLocalBindings(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:"+uuid.NewString())
	bound := "6a7c6caf00000000006133" + uuid.NewString()[:2]
	unbound := "6a7c6caf00000000006233" + uuid.NewString()[:2]
	// 绑定必须发生在 run 创建之前：冻结快照是建 run 时算出来的。
	wk := f.bindWork(t, "已绑定样本", bound)

	withPlatformSyncFeatureEnabled(t, "account_sync", "xhs", true)
	preparePlatformSyncConnection(t, f)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_connection SET capabilities=$2,auto_collect=false WHERE id=$1`,
		f.Connection, []byte(`{"adapterVersion":"`+catalogBindingAdapter+`","mappingVersion":1,`+
			`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"supported","noteContent":"unsupported"}`)); err != nil {
		t.Fatal(err)
	}
	status, response := f.signedSyncRequest(t, "platform.account.sync.request",
		"/api/v1/accounts/"+f.Account.ID.String()+"/platform-account-sync",
		platformAccountSyncBody(t, f.Connection, "incremental"), uuid.NewString())
	if status != http.StatusAccepted {
		t.Fatalf("start sync: %d %s", status, response)
	}
	env.srv.schedulePlatformRuns(context.Background())
	profile := claimPlatformV2Run(t, f, "account_sync", catalogBindingAdapter)
	submitPlatformV2Batch(t, f, profile.ID, platformV2ControlBatch(profile, 0, "complete", nil, "succeeded"))
	env.srv.schedulePlatformRuns(context.Background())
	catalog := claimPlatformV2Run(t, f, "account_sync", catalogBindingAdapter)
	if catalog.Stage != "catalog" {
		t.Fatalf("profile completion must schedule catalog, got %q", catalog.Stage)
	}

	snapshot := readRunBindingSnapshot(t, catalog.ID)
	if len(snapshot.LocalBindings) != 1 || snapshot.LocalBindings[0].ExternalID != bound {
		t.Fatalf("catalog 阶段必须冻结已精确绑定的作品：%+v", snapshot.LocalBindings)
	}
	// 未绑定的平台作品不进冻结列表：文档 §2208 的口径是「未绑定镜像不生成正式指标」。
	for _, item := range snapshot.LocalBindings {
		if item.ExternalID == unbound {
			t.Fatalf("未绑定的平台作品不应被冻结成本地绑定")
		}
	}

	publishedAt := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	asOf := time.Now().UTC().Truncate(time.Second)
	metric := func(externalID string, withRevisions bool) map[string]any {
		row := map[string]any{
			"scope": "work", "external_account_key": f.ExternalKey(), "external_id": externalID,
			"source": "xhs_browser", "temporal_kind": "cumulative", "observed_at": asOf, "as_of_at": asOf,
			"adapter_version": catalogBindingAdapter, "mapping_version": 1,
			"values":      map[string]any{"view_times": map[string]any{"value": 210, "precision": "exact", "unit": "unknown"}},
			"field_paths": map[string]string{"view_times": "fixture.note.view_count"},
		}
		if withRevisions {
			// 冻结快照里的修订必须原样带回，否则服务端按「未冻结的作品不能上报本地绑定修订」拒绝。
			var bindingRev, publishRev int
			if err := env.srv.db.QueryRow(context.Background(),
				`SELECT metric_binding_revision, coalesce(publish_revision,1) FROM work WHERE id=$1`, wk.ID).
				Scan(&bindingRev, &publishRev); err != nil {
				t.Fatal(err)
			}
			row["binding_revision"] = bindingRev
			row["publish_revision"] = publishRev
		}
		return row
	}
	item := func(externalID string, withRevisions bool) map[string]any {
		return map[string]any{
			"external_id": externalID, "author_external_account_key": f.ExternalKey(),
			"remote_content_type": "image_note", "remote_status": "published", "title": "目录绑定样本",
			"summary": "简短摘要", "author_display": "巡检号", "published_at": publishedAt,
			"topics": []string{}, "tags": []string{},
			"field_states":   map[string]string{"title": "present", "published_at": "present", "summary": "present"},
			"inline_metrics": []any{metric(externalID, withRevisions)},
		}
	}
	submitPlatformV2Batch(t, f, catalog.ID, map[string]any{
		"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{
			"items":                []any{item(bound, true), item(unbound, false)},
			"enumeration_complete": false, "partition": "published", "consistency": "best_effort",
		},
	})

	matchOf := func(externalID string) (string, uuid.UUID) {
		t.Helper()
		var matchState string
		var observationID uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `SELECT match_state,id FROM platform_metric_observation
			WHERE account_id=$1 AND external_id=$2`, f.Account.ID, externalID).Scan(&matchState, &observationID); err != nil {
			t.Fatalf("observation for %s: %v", externalID, err)
		}
		return matchState, observationID
	}

	if state, _ := matchOf(bound); state != observationMatchBound {
		t.Fatalf("已冻结的本地绑定必须让观测可确认，got %q", state)
	}
	if state, _ := matchOf(unbound); state != observationMatchUnmatched {
		t.Fatalf("未绑定的平台作品不应被当成已绑定，got %q", state)
	}

	// 真正走一次确认：这正是用户在作品库里点「确认」时走的那条路径。
	_, observationID := matchOf(bound)
	env.mustJSON(t, "POST", "/api/v1/metrics/observations/"+observationID.String()+"/confirm", nil, nil)
	var rows int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).Scan(&rows); err != nil || rows == 0 {
		t.Fatalf("确认后应写入正式指标：rows=%d err=%v", rows, err)
	}

	submitPlatformV2Batch(t, f, catalog.ID, platformV2ControlBatch(catalog, 1, "complete", map[string]any{
		"enumeration_complete": true, "total_count": 2, "partition": "published", "consistency": "best_effort",
	}, "succeeded"))
}

// TestPlatformV2CatalogRejectsRevisionForUnfrozenWork 验证：catalog 阶段给未冻结的作品
// 带上绑定修订时整批被拒，而不是悄悄写成 unmatched。
//
// 这一条钉的是客户端的契约：目录行只有在 `local_bindings` 里能找到时才允许带修订，
// 服务端不会「带不上就算了」，否则冻结快照与上报内容会静默不一致。
func TestPlatformV2CatalogRejectsRevisionForUnfrozenWork(t *testing.T) {
	f, catalog := startCatalogFixtureXhs1(t, `{"adapterVersion":"`+catalogBindingAdapter+`","mappingVersion":1,`+
		`"browserVersion":"155.0.0.0","workList":"supported","perNoteMetrics":"supported","noteContent":"unsupported"}`)
	unfrozen := "6a7c6caf00000000006333" + uuid.NewString()[:2]
	asOf := time.Now().UTC().Truncate(time.Second)
	status, response := submitV2BatchRaw(t, f, catalog.ID, map[string]any{
		"protocol_version": 2, "lease_generation": catalog.LeaseGeneration,
		"authorization_revision": catalog.AuthorizationRevision, "batch_seq": 0, "final_batch": false,
		"run_status": "succeeded", "result_type": "work_catalog",
		"data": map[string]any{
			"items": []any{map[string]any{
				"external_id": unfrozen, "author_external_account_key": f.ExternalKey(),
				"remote_content_type": "image_note", "remote_status": "published", "title": "未冻结修订样本",
				"summary": "简短摘要", "author_display": "巡检号",
				"published_at": time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second),
				"topics":       []string{}, "tags": []string{},
				"field_states": map[string]string{"title": "present", "published_at": "present", "summary": "present"},
				"inline_metrics": []any{map[string]any{
					"scope": "work", "external_account_key": f.ExternalKey(), "external_id": unfrozen,
					"binding_revision": 1, "publish_revision": 1,
					"source": "xhs_browser", "temporal_kind": "cumulative", "observed_at": asOf, "as_of_at": asOf,
					"adapter_version": catalogBindingAdapter, "mapping_version": 1,
					"values":      map[string]any{"view_times": map[string]any{"value": 5, "precision": "exact", "unit": "unknown"}},
					"field_paths": map[string]string{"view_times": "fixture.note.view_count"},
				}},
			}},
			"enumeration_complete": false, "partition": "published", "consistency": "best_effort",
		},
	})
	if status != 409 || apiCode(response) != "platform_result_conflict" {
		t.Fatalf("未冻结作品带修订必须整批被拒：%d %s", status, response)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM platform_metric_observation
		WHERE account_id=$1 AND external_id=$2`, f.Account.ID, unfrozen).Scan(&count); err != nil || count != 0 {
		t.Fatalf("被拒的批次不应留下观测：count=%d err=%v", count, err)
	}
}
