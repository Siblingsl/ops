package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// DEV-PS47 定向测试：人工更正自动来源数据时必须保留平台原值（20 文档 §9.3）。
//
// 缺陷背景：`PATCH /metrics/{id}` 对**自动来源**（wechat_browser/xhs_browser）
// 的行做原地 UPDATE。实测把 reads 从 500 改成 999 后：
//   - 平台原值 500 永久丢失，再也无法与平台对账；
//   - 同批其它字段（likes=50）被清空，因为 PATCH 是全量覆盖；
//   - 下次采集按 (work, source, day_offset) 覆盖回来，用户的更正白做。
//
// §9.3 原文："平台来源快照不能通过原指标编辑接口原地改成另一组'平台原值'。
// 人工更正创建或更新同节点的 manual 快照，写 corrects_observation_id（不是
// observation_id），将被排除的自动候选设为 held，并保留原观测。"

// seedAutoMetric 直插一条自动来源的快照，返回 (metricID, observationID)。
func seedAutoMetric(t *testing.T, workID uuid.UUID, reads, likes int, dayOffset int) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	// 先造一条观测，让 corrects_observation_id 有指向。
	var obsID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_metric_observation
		(workspace_id, account_id, external_account_key, external_id, scope, source, observed_at, as_of_at,
		 temporal_kind, values, field_paths, adapter_version, mapping_version, payload_hash,
		 quality_state, match_state)
		SELECT w.workspace_id_of_account, w.account_id, 'wechat_biz:fixture', w.wechat_msgid, 'work', 'wechat_browser',
		       now(), now(), 'cumulative', '{}'::jsonb, '{}'::jsonb, 'wechat-mp-1', 1,
		       encode(sha256(random()::text::bytea), 'hex'), 'needs_confirmation', 'bound'
		FROM (SELECT a.workspace_id AS workspace_id_of_account, w2.account_id, w2.wechat_msgid
		      FROM work w2 JOIN platform_account a ON a.id=w2.account_id WHERE w2.id=$1) w
		RETURNING id`, workID).Scan(&obsID); err != nil {
		t.Fatal(err)
	}
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, likes, captured_at, source, quality_state, read_unit, share_unit, observation_id)
		VALUES ($1,$2,$3,$4,now(),'wechat_browser','approved','times','unknown',$5) RETURNING id`,
		workID, dayOffset, reads, likes, obsID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM metric_snapshot WHERE work_id=$1`, workID)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM platform_metric_observation WHERE id=$1`, obsID)
	})
	return metricID, obsID
}

// patchMetric 走真实 HTTP 路由提交一次更正。
func patchMetric(t *testing.T, f *platformRunFixture, metricID uuid.UUID, body map[string]any) (int, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/metrics/"+metricID.String(), bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	// 身份走 ctxMember 注入（与既有测试一致，HTTP 路径由中间件负责，这里跳过中间件）；
	// 路径参数走 chi 的路由上下文，否则 pathID 取不到 id。
	ctx := context.WithValue(req.Context(), ctxMember, &identity{
		UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner",
	})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", metricID.String())
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	if err := env.srv.updateMetric(rec, req); err != nil {
		// 让调用方按状态码判断；这里把错误编码成响应形态。
		rec.Code = 0
		rec.Body = bytes.NewBufferString(err.Error())
	}
	if rec.Code == 0 {
		return http.StatusInternalServerError, rec.Body.Bytes()
	}
	return rec.Code, rec.Body.Bytes()
}

func TestEditAutoMetricHoldsOriginalAndWritesManual(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_hold_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	wk := drWork(t, f.Account, "人工更正自动来源", "published", &pub)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET wechat_msgid=$2, platform_binding_source='user_link' WHERE id=$1`,
		wk.ID, "2247480050_1"); err != nil {
		t.Fatal(err)
	}
	metricID, obsID := seedAutoMetric(t, wk.ID, 500, 50, 7)

	status, resp := patchMetric(t, f, metricID, map[string]any{
		"reads": 999, "base_revision": 1,
	})
	if status != http.StatusOK {
		t.Fatalf("更正应成功：%d %s", status, resp)
	}

	// 原自动行：必须保留原值且转为 held。
	var autoReads, autoLikes int
	var autoState string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, likes, quality_state FROM metric_snapshot WHERE id=$1`, metricID).
		Scan(&autoReads, &autoLikes, &autoState); err != nil {
		t.Fatal(err)
	}
	if autoState != "held" {
		t.Fatalf("原自动行应转为 held，实际 %s", autoState)
	}
	if autoReads != 500 {
		t.Fatalf("平台原值必须保留 500，实际 %d", autoReads)
	}
	if autoLikes != 50 {
		t.Fatalf("平台原值 likes 必须保留 50，实际 %d", autoLikes)
	}

	// 同节点必须出现 manual 行承载人工值。
	var manualReads int
	var manualState string
	var corrects *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, quality_state, corrects_observation_id FROM metric_snapshot
		 WHERE work_id=$1 AND source='manual'`, wk.ID).Scan(&manualReads, &manualState, &corrects); err != nil {
		t.Fatal(err)
	}
	if manualReads != 999 {
		t.Fatalf("manual 行应为人工值 999，实际 %d", manualReads)
	}
	if manualState != "approved" {
		t.Fatalf("manual 行应为 approved，实际 %s", manualState)
	}
	// corrects_observation_id 指向被更正的观测，而不是 observation_id。
	if corrects == nil || *corrects != obsID {
		t.Fatalf("corrects_observation_id 应指向被更正的观测 %s，实际 %v", obsID, corrects)
	}
	var manualFromObservation bool
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT observation_id IS NOT NULL FROM metric_snapshot WHERE work_id=$1 AND source='manual'`, wk.ID).
		Scan(&manualFromObservation); err != nil {
		t.Fatal(err)
	}
	if manualFromObservation {
		t.Fatal("manual 行的 observation_id 必须为空——否则会被误认为人工值来自平台")
	}
}

// TestEditManualMetricStillInPlace manual 来源仍走原地改（既有行为不能变）。
func TestEditManualMetricStillInPlace(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_manual_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	wk := drWork(t, f.Account, "编辑人工来源", "published", &pub)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET wechat_msgid=$2, platform_binding_source='user_link' WHERE id=$1`,
		wk.ID, "2247480051_1"); err != nil {
		t.Fatal(err)
	}
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`INSERT INTO metric_snapshot (work_id, day_offset, reads, likes, captured_at, source, quality_state, read_unit, share_unit)
		 VALUES ($1,7,100,10,now(),'manual','approved','unknown','unknown') RETURNING id`, wk.ID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot WHERE work_id=$1`, wk.ID)
	})

	status, resp := patchMetric(t, f, metricID, map[string]any{"reads": 777, "base_revision": 1})
	if status != http.StatusOK {
		t.Fatalf("编辑人工来源应成功：%d %s", status, resp)
	}
	// 仍是同一行、仍是 manual。
	var reads int
	var source string
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1`, wk.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("人工来源就地改，不应新增行，实际 %d 行", count)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, source FROM metric_snapshot WHERE id=$1`, metricID).Scan(&reads, &source); err != nil {
		t.Fatal(err)
	}
	if reads != 777 || source != "manual" {
		t.Fatalf("应为 manual/777，实际 %s/%d", source, reads)
	}
}
