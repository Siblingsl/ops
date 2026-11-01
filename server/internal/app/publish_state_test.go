package app

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
)

type cxPublishStateView struct {
	State        *string `json:"state"`
	Version      int     `json:"version"`
	SubmittedRef struct {
		Kind        string `json:"kind"`
		HandoffNote string `json:"handoff_note"`
	} `json:"submitted_ref"`
	ScheduledAt  *time.Time `json:"scheduled_at"`
	Registration struct {
		MetricID *uuid.UUID `json:"metric_id"`
		Revision *int       `json:"revision"`
		Valid    bool       `json:"valid"`
	} `json:"registration"`
	Publication struct {
		URL             *string    `json:"url"`
		At              *time.Time `json:"at"`
		PublishRevision int        `json:"publish_revision"`
	} `json:"publication"`
	History []struct {
		EventKind    string  `json:"event_kind"`
		FromState    *string `json:"from_state"`
		ToState      string  `json:"to_state"`
		StateVersion int     `json:"state_version"`
	} `json:"history"`
}

func cxPublishStatePath(workID uuid.UUID) string {
	return "/api/v1/works/" + workID.String() + "/publish-state"
}

func TestCXPublishStateTransitionsAndIdempotency(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "wechat_mp", "发布台账交接预约号")
	wk := drWork(t, a, "发布台账交接预约作品", "pushed", nil)
	const draftID = "cx-publish-state-draft"
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET wechat_draft_media_id=$2 WHERE id=$1`, wk.ID, draftID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO push_record(work_id,account_id,action,status,draft_media_id)
		VALUES($1,$2,'add','ok',$3)`, wk.ID, a.ID, draftID); err != nil {
		t.Fatal(err)
	}
	path := cxPublishStatePath(wk.ID)
	var initial cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &initial)
	if initial.State != nil || initial.Version != 0 || len(initial.History) != 0 {
		t.Fatalf("未交接作品必须没有台账行：%+v", initial)
	}

	first := map[string]any{"base_version": 0, "idempotency_key": uuid.NewString(), "to": "submitted",
		"submitted_ref": map[string]any{"handoff_note": "已在公众号后台核对草稿并交给发布人"}}
	var submitted cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", first, &submitted)
	if submitted.State == nil || *submitted.State != "submitted" || submitted.Version != 1 ||
		submitted.SubmittedRef.Kind != "wechat_draft_receipt" || submitted.SubmittedRef.HandoffNote == "" {
		t.Fatalf("公众号交接必须引用当前成功草稿回执：%+v", submitted)
	}
	var replay cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", first, &replay)
	if replay.Version != 1 || len(replay.History) != 1 {
		t.Fatalf("相同幂等请求不得重复追加事件：%+v", replay)
	}
	differentPayload := map[string]any{"base_version": 0, "idempotency_key": first["idempotency_key"], "to": "submitted",
		"submitted_ref": map[string]any{"handoff_note": "不同的交接说明"}}
	env.expectErr(t, "POST", path+"/transition", differentPayload, "idempotency_conflict")
	env.expectErr(t, "POST", path+"/transition", map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "public"}, "use_published_endpoint")
	var matrixMetricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,likes,quality_state)
		VALUES($1,now(),'manual',0,1,'approved') RETURNING id`, wk.ID).Scan(&matrixMetricID); err != nil {
		t.Fatal(err)
	}
	var matrixRevision int
	if err := env.srv.db.QueryRow(ctx, `SELECT revision FROM metric_snapshot WHERE id=$1`, matrixMetricID).Scan(&matrixRevision); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", path+"/transition", map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "registered",
		"metric_id": matrixMetricID, "metric_revision": matrixRevision}, "invalid_transition")

	// Same target and same payload is idempotent even under a fresh key.
	sameState := map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "submitted",
		"submitted_ref": map[string]any{"handoff_note": "已在公众号后台核对草稿并交给发布人"}}
	env.mustJSON(t, "POST", path+"/transition", sameState, &replay)
	if replay.Version != 1 || len(replay.History) != 1 {
		t.Fatalf("相同目标与相同内容必须幂等：%+v", replay)
	}

	scheduledAt := env.srv.now().Add(time.Hour).UTC()
	env.expectErr(t, "POST", path+"/transition", map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "scheduled",
		"scheduled_at": scheduledAt, "evidence": map[string]any{"backend_url": "https://evil.example/"}}, "validation_failed")
	schedule := map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "scheduled",
		"scheduled_at": scheduledAt, "evidence": map[string]any{"backend_url": "https://mp.weixin.qq.com/cgi-bin/draft"}}
	var scheduled cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", schedule, &scheduled)
	if scheduled.State == nil || *scheduled.State != "scheduled" || scheduled.Version != 2 || scheduled.ScheduledAt == nil {
		t.Fatalf("预约状态或时间未保存：%+v", scheduled)
	}
	cancel := map[string]any{"base_version": 2, "idempotency_key": uuid.NewString(), "to": "submitted", "reason": "平台临时取消预约"}
	var cancelled cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", cancel, &cancelled)
	if cancelled.State == nil || *cancelled.State != "submitted" || cancelled.Version != 3 || cancelled.ScheduledAt != nil || len(cancelled.History) != 3 {
		t.Fatalf("取消预约必须回到 submitted 并清除预约投影：%+v", cancelled)
	}

	earlySchedule := map[string]any{"base_version": 3, "idempotency_key": uuid.NewString(), "to": "scheduled",
		"scheduled_at": env.srv.now().Add(time.Hour), "evidence": map[string]any{"backend_url": "https://mp.weixin.qq.com/cgi-bin/draft"}}
	env.mustJSON(t, "POST", path+"/transition", earlySchedule, &scheduled)
	earlyPublishedAt := env.srv.now().Add(-time.Minute)
	earlyPublishBody := map[string]any{"url": "https://mp.weixin.qq.com/s/cx-early-public", "published_at": earlyPublishedAt}
	env.expectErr(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", earlyPublishBody, "early_public_reason_required")
	earlyPublishBody["early_public_reason"] = "平台审核已完成并确认作品提前公开"
	var earlyPublished Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", earlyPublishBody, &earlyPublished)
	var earlyPublicState cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &earlyPublicState)
	if earlyPublicState.State == nil || *earlyPublicState.State != "public" || earlyPublicState.Version != 5 || earlyPublicState.History[len(earlyPublicState.History)-1].ToState != "public" {
		t.Fatalf("预约前公开须通过原回填并形成 public：%+v", earlyPublicState)
	}
	var eventEvidence string
	if err := env.srv.db.QueryRow(ctx, `SELECT evidence->>'early_public_reason' FROM work_publish_state_event WHERE work_id=$1 AND state_version=$2`, wk.ID, earlyPublicState.Version).Scan(&eventEvidence); err != nil {
		t.Fatal(err)
	}
	if eventEvidence != "平台审核已完成并确认作品提前公开" {
		t.Fatalf("提前公开原因未进入事件记录：%q", eventEvidence)
	}

	// Public is written only by the legacy publication route and creates null->public atomically.
	xhs := drAccount(t, "xhs", "发布台账原发布入口号")
	publicWork := drWork(t, xhs, "原发布入口作品", "packed", nil)
	publicAt := env.srv.now().Add(-time.Minute)
	var published Work
	env.mustJSON(t, "POST", "/api/v1/works/"+publicWork.ID.String()+"/published", map[string]any{
		"url": "https://www.xiaohongshu.com/explore/ledger-test", "published_at": publicAt,
	}, &published)
	var publicState cxPublishStateView
	env.mustJSON(t, "GET", cxPublishStatePath(publicWork.ID), nil, &publicState)
	if publicState.State == nil || *publicState.State != "public" || publicState.Version != 1 || len(publicState.History) != 1 ||
		publicState.History[0].FromState != nil || publicState.History[0].ToState != "public" {
		t.Fatalf("原发布入口应原子生成 null->public：%+v", publicState)
	}
}

func TestCXPublishStateFormalRegistrationInvalidationAndCorrection(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "xhs", "发布台账基线号")
	wk := drWork(t, a, "发布台账正式指标作品", "packed", nil)
	publishedAt := env.srv.now().Add(-2 * time.Hour)
	var published Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]any{
		"url": "https://www.xiaohongshu.com/explore/cx-ledger", "published_at": publishedAt,
	}, &published)
	path := cxPublishStatePath(wk.ID)

	var unknownUnitID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,reads,read_unit,quality_state)
		VALUES($1,$2,'paste',0,100,'unknown','approved') RETURNING id`, wk.ID, publishedAt.Add(time.Hour)).Scan(&unknownUnitID); err != nil {
		t.Fatal(err)
	}
	var unknownRevision int
	if err := env.srv.db.QueryRow(ctx, `SELECT revision FROM metric_snapshot WHERE id=$1`, unknownUnitID).Scan(&unknownRevision); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", path+"/transition", map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "registered",
		"metric_id": unknownUnitID, "metric_revision": unknownRevision}, "metric_required")

	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,likes,quality_state)
		VALUES($1,$2,'manual',0,5,'approved') RETURNING id`, wk.ID, publishedAt.Add(time.Hour)).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	var metricRevision int
	if err := env.srv.db.QueryRow(ctx, `SELECT revision FROM metric_snapshot WHERE id=$1`, metricID).Scan(&metricRevision); err != nil {
		t.Fatal(err)
	}
	register := map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "registered", "metric_id": metricID, "metric_revision": metricRevision}
	var registered cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", register, &registered)
	if registered.State == nil || *registered.State != "registered" || registered.Version != 2 || !registered.Registration.Valid {
		t.Fatalf("正式指标登记应成功：%+v", registered)
	}

	// The existing metric edit API owns correction semantics and atomically invalidates this baseline.
	var edited Metric
	env.mustJSON(t, "PATCH", "/api/v1/metrics/"+metricID.String(), map[string]any{"base_revision": metricRevision, "likes": 8}, &edited)
	var afterEdit cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &afterEdit)
	if afterEdit.State == nil || *afterEdit.State != "public" || afterEdit.Version != 3 || afterEdit.Registration.Valid || len(afterEdit.History) != 3 || afterEdit.History[2].EventKind != "invalidation" {
		t.Fatalf("指标修订必须追加失效事件并回到 public：%+v", afterEdit)
	}

	// Register the current revision and use the original correction flow; its event must be atomic.
	register["base_version"] = afterEdit.Version
	register["idempotency_key"] = uuid.NewString()
	register["metric_revision"] = edited.Revision
	env.mustJSON(t, "POST", path+"/transition", register, &registered)
	newURL := "https://www.xiaohongshu.com/explore/cx-ledger-corrected"
	var revision int
	if err := env.srv.db.QueryRow(ctx, `SELECT publish_revision FROM work WHERE id=$1`, wk.ID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	correction := map[string]any{"mode": "correction", "base_publish_revision": revision, "reason": "核对本人作品页面后修正链接", "confirm_published": true, "url": newURL}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", correction, &published)
	var afterCorrection cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &afterCorrection)
	if afterCorrection.State == nil || *afterCorrection.State != "public" || afterCorrection.Version != registered.Version+1 ||
		afterCorrection.Registration.Valid || afterCorrection.History[len(afterCorrection.History)-1].EventKind != "correction" {
		t.Fatalf("更正发布记录必须同步失效注册并保留 correction 事件：%+v", afterCorrection)
	}

	// Deletion also invalidates in the same transaction before ON DELETE SET NULL can erase the reference.
	register["base_version"] = afterCorrection.Version
	register["idempotency_key"] = uuid.NewString()
	env.mustJSON(t, "POST", path+"/transition", register, &registered)
	deletePath := fmt.Sprintf("/api/v1/metrics/%s?base_revision=%d", metricID, edited.Revision)
	status, _ := env.do("DELETE", deletePath, nil)
	if status != 200 {
		t.Fatalf("delete metric: status=%d", status)
	}
	var afterDelete cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &afterDelete)
	if afterDelete.State == nil || *afterDelete.State != "public" || afterDelete.Registration.Valid || afterDelete.History[len(afterDelete.History)-1].EventKind != "invalidation" {
		t.Fatalf("删除基线必须回到 public 并留失效事件：%+v", afterDelete)
	}
}

func TestCXPublishStateConcurrentRegistrationCompareAndSwap(t *testing.T) {
	ctx := context.Background()
	a := drAccount(t, "xhs", "发布台账并发号")
	wk := drWork(t, a, "发布台账并发登记作品", "packed", nil)
	var published Work
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/published", map[string]any{
		"url": "https://www.xiaohongshu.com/explore/cx-ledger-cas", "published_at": env.srv.now().Add(-time.Hour),
	}, &published)
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot(work_id,captured_at,source,day_offset,likes,quality_state)
		VALUES($1,now(),'manual',0,1,'approved') RETURNING id`, wk.ID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	var metricRevision int
	if err := env.srv.db.QueryRow(ctx, `SELECT revision FROM metric_snapshot WHERE id=$1`, metricID).Scan(&metricRevision); err != nil {
		t.Fatal(err)
	}
	path := cxPublishStatePath(wk.ID) + "/transition"
	start := make(chan struct{})
	statuses := make(chan int, 2)
	for range 2 {
		go func() {
			<-start
			status, _ := env.do("POST", path, map[string]any{"base_version": 1, "idempotency_key": uuid.NewString(), "to": "registered",
				"metric_id": metricID, "metric_revision": metricRevision})
			statuses <- status
		}()
	}
	close(start)
	succeeded, conflicted := 0, 0
	for range 2 {
		switch status := <-statuses; status {
		case 200:
			succeeded++
		case 409:
			conflicted++
		default:
			t.Fatalf("并发登记返回未预期状态：%d", status)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("相同base_version的并发请求必须只成功一次：success=%d conflict=%d", succeeded, conflicted)
	}
	var state string
	var version int
	if err := env.srv.db.QueryRow(ctx, `SELECT state,version FROM work_publish_state WHERE work_id=$1`, wk.ID).Scan(&state, &version); err != nil {
		t.Fatal(err)
	}
	if state != "registered" || version != 2 {
		t.Fatalf("并发请求必须只写入一次状态和事件：state=%s version=%d", state, version)
	}
}
