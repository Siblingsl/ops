package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// DEV-PS54 定向测试：删除正式指标时必须把来源观测退回「待确认」（20 文档 §9.2）。
//
// 缺陷背景：`deleteMetric` 只删 `metric_snapshot`，不回退观测状态。
// 删除一条自动来源的指标后，对应观测仍是 `valid`（已确认），但正式指标已不存在。
// 用户看到"这条已经确认过了"，实际数据已经没了——状态与事实脱节。
//
// 本轮先是在自己的清理脚本里踩到同类问题：手工 `DELETE FROM metric_snapshot`
// 后留下 23 条 `valid` 观测没有任何快照。顺势检查产品代码，发现 `deleteMetric`
// 有完全相同的漏洞。

// seedValidObservationWithSnapshot 造一对「已确认观测 + 对应快照」。
func seedValidObservationWithSnapshot(t *testing.T, workID uuid.UUID, externalID string) (uuid.UUID, uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var accountID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT account_id FROM work WHERE id=$1`, workID).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	var obsID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO platform_metric_observation
		(workspace_id, account_id, external_account_key, external_id, scope, source, observed_at, as_of_at,
		 temporal_kind, values, field_paths, adapter_version, mapping_version, payload_hash,
		 quality_state, match_state)
		VALUES ($1,$2,'wechat_biz:fixture',$3,'work','wechat_browser',now(),now(),'cumulative',
		        '{"like_count":{"value":9,"precision":"exact","unit":"count"}}'::jsonb,
		        '{"like_count":"fixture.like"}'::jsonb,'wechat-mp-1',1,
		        encode(sha256(random()::text::bytea),'hex'),'valid','bound')
		RETURNING id`, workspaceID, accountID, externalID).Scan(&obsID); err != nil {
		t.Fatal(err)
	}
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO metric_snapshot
		(work_id, day_offset, likes, captured_at, source, quality_state, read_unit, share_unit, observation_id)
		VALUES ($1,7,9,now(),'wechat_browser','approved','unknown','unknown',$2) RETURNING id`,
		workID, obsID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM metric_snapshot WHERE work_id=$1`, workID)
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM platform_metric_observation WHERE id=$1`, obsID)
	})
	return metricID, obsID
}

// deleteMetricCall 走真实 handler 删一条指标。
func deleteMetricCall(t *testing.T, f *platformRunFixture, metricID uuid.UUID, revision int) (int, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodDelete,
		"/api/v1/metrics/"+metricID.String()+"?base_revision="+strconv.Itoa(revision), nil)
	ctx := context.WithValue(req.Context(), ctxMember, &identity{
		UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner",
	})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", metricID.String())
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	if err := env.srv.deleteMetric(rec, req); err != nil {
		return http.StatusInternalServerError, []byte(err.Error())
	}
	return rec.Code, rec.Body.Bytes()
}

func TestDeleteAutoMetricRevertsObservation(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_del_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	wk := drWork(t, f.Account, "删除回退观测", "published", &pub)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET wechat_msgid=$2, platform_binding_source='user_link' WHERE id=$1`,
		wk.ID, "2247480060_1"); err != nil {
		t.Fatal(err)
	}
	metricID, obsID := seedValidObservationWithSnapshot(t, wk.ID, "2247480060_1")

	status, resp := deleteMetricCall(t, f, metricID, 1)
	if status != http.StatusOK {
		t.Fatalf("删除应成功：%d %s", status, resp)
	}

	// 快照必须被删掉。
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE id=$1`, metricID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("快照应已删除")
	}

	// 观测必须退回待确认——否则它显示"已确认"但数据已不存在。
	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityNeedsConfirm {
		t.Fatalf("删除指标后观测应退回 %s，实际 %s", observationQualityNeedsConfirm, quality)
	}

	// 退回后应能重新确认，并重新写入快照（闭环）。
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("退回后应能重新确认：%v", err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("重新确认后应有 1 条快照，实际 %d", count)
	}
}

// TestDeleteManualMetricLeavesObservations 删人工来源指标不应影响任何观测。
func TestDeleteManualMetricLeavesObservations(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_delm_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	wk := drWork(t, f.Account, "删人工来源", "published", &pub)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET wechat_msgid=$2, platform_binding_source='user_link' WHERE id=$1`,
		wk.ID, "2247480061_1"); err != nil {
		t.Fatal(err)
	}
	// 一条独立的 valid 观测（不属于任何人工指标）。
	_, obsID := seedValidObservationWithSnapshot(t, wk.ID, "2247480061_1")
	// 把快照的 observation_id 清空，模拟人工来源。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE metric_snapshot SET source='manual', observation_id=NULL WHERE work_id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	var metricID uuid.UUID
	var revision int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id, revision FROM metric_snapshot WHERE work_id=$1`, wk.ID).Scan(&metricID, &revision); err != nil {
		t.Fatal(err)
	}

	// UPDATE 会自增 revision，必须用当前值而不是硬编码 1。
	status, resp := deleteMetricCall(t, f, metricID, revision)
	if status != http.StatusOK {
		t.Fatalf("删除应成功：%d %s", status, resp)
	}
	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityValid {
		t.Fatalf("删人工来源指标不应改动观测，实际状态变为 %s", quality)
	}
}

var _ = json.Marshal
var _ = bytes.NewReader

// TestPartialEditKeepsOtherFields PATCH 只改传入的字段，未传的必须保留原值。
//
// 缺陷背景：更新 SQL 早期是直接赋值（`reads=$3, likes=$5...`），
// 未传字段被写成 NULL。实测把 reads 从 500 改成 999 后，
// likes=50、comments=10、shares=5 全部丢失，接口还返回 200——
// 用户完全不会察觉自己的数据被清空了。
//
// 与 `upsertMetric` 的 `coalesce` 语义对齐后修复。
func TestPartialEditKeepsOtherFields(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_patch_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	wk := drWork(t, f.Account, "局部编辑保留其它字段", "published", &pub)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET wechat_msgid=$2, platform_binding_source='user_link' WHERE id=$1`,
		wk.ID, "2247480070_1"); err != nil {
		t.Fatal(err)
	}
	var metricID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, likes, comments, shares, captured_at, source, quality_state, read_unit, share_unit)
		VALUES ($1,7,500,50,10,5,now(),'manual','approved','times','times') RETURNING id`,
		wk.ID).Scan(&metricID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot WHERE work_id=$1`, wk.ID)
	})

	// 只传 reads。
	status, resp := patchMetric(t, f, metricID, map[string]any{"reads": 999, "base_revision": 1})
	if status != http.StatusOK {
		t.Fatalf("编辑应成功：%d %s", status, resp)
	}
	var reads, likes, comments, shares *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, likes, comments, shares FROM metric_snapshot WHERE id=$1`, metricID).
		Scan(&reads, &likes, &comments, &shares); err != nil {
		t.Fatal(err)
	}
	if reads == nil || *reads != 999 {
		t.Fatalf("reads 应改为 999，实际 %v", reads)
	}
	if likes == nil || *likes != 50 {
		t.Fatalf("未传的 likes 必须保留 50，实际 %v", likes)
	}
	if comments == nil || *comments != 10 {
		t.Fatalf("未传的 comments 必须保留 10，实际 %v", comments)
	}
	if shares == nil || *shares != 5 {
		t.Fatalf("未传的 shares 必须保留 5，实际 %v", shares)
	}
}
