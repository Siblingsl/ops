package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS40 定向测试：观测入库默认「待确认」，确认后才进正式指标（20 文档 §9.2）。
//
// 实测缺陷：观测入库时 `quality_state` 固定写 `valid`，而前端"确认这一条"按钮的
// 显示条件是 `quality_state === 'needs_confirmation'` —— 按钮永远不显示。
// 用户能看到观测，却没有任何办法把它确认进正式指标（`auto_adopt` 关闭时功能等于不可用）。
//
// `platform_gray.go` 的自动采用率统计里本来就有 `needs_confirmation` 计数，
// 说明设计上预期存在这个状态，只是入库路径漏了设置。

// seedPendingObservation 走真实入库路径，**不显式指定 QualityState**，
// 用于验证"默认值"本身。既有 seedObservation 会显式传 valid，测不到默认行为。
func seedPendingObservation(t *testing.T, f *platformRunFixture, externalID, source string, values map[string]any) uuid.UUID {
	t.Helper()
	raw := map[string]json.RawMessage{}
	paths := map[string]string{}
	for key, value := range values {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		raw[key] = b
		paths[key] = "fixture." + key
	}
	asOf := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	in := platformObservationInput{
		WorkspaceID: f.Workspace, AccountID: f.Account.ID, ExternalAccountKey: f.externalKey(),
		ExternalID: &externalID, Scope: observationScopeWork, Source: source,
		TemporalKind: observationTemporalCumulative, ObservedAt: asOf, AsOfAt: &asOf,
		Values: raw, FieldPaths: paths, AdapterVersion: adapterVersionFor(f.Account.Platform),
		MappingVersion: 1,
		// QualityState 留空：由入库路径决定默认值。
		MatchState: observationMatchBound,
	}
	var id uuid.UUID
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		var e error
		id, _, e = insertPlatformObservation(context.Background(), tx, in)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestObservationDefaultsToNeedsConfirmation(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_pending_"+uuid.New().String()[:8])
	f.bindWork(t, "默认待确认", "2247480011_1")

	obsID := seedPendingObservation(t, f, "2247480011_1", "wechat_browser", map[string]any{
		"like_count": map[string]any{"value": 3, "precision": "exact", "unit": "count"},
	})

	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	// 入库即待确认：这是"按钮能不能出现"的前提。
	if quality != observationQualityNeedsConfirm {
		t.Fatalf("观测入库应为 %s，实际 %s", observationQualityNeedsConfirm, quality)
	}

	// 待确认的观测不得进正式指标。
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("待确认观测不应写快照，实际 %d 条", count)
	}

	// 确认后才进正式指标，状态转 valid。
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityValid {
		t.Fatalf("确认后应为 %s，实际 %s", observationQualityValid, quality)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("确认后应有 1 条快照，实际 %d 条", count)
	}
}

// TestSupersededObservationCannotBeConfirmed 已被替代的旧观测不能再确认，
// 否则会把过时读数写回正式指标。
func TestSupersededObservationCannotBeConfirmed(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_super_"+uuid.New().String()[:8])
	f.bindWork(t, "已替代不可确认", "2247480012_1")

	obsID := seedObservation(t, f, "2247480012_1", "wechat_browser", map[string]any{
		"like_count": map[string]any{"value": 7, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_metric_observation SET quality_state=$2 WHERE id=$1`,
		obsID, observationQualitySuperseded); err != nil {
		t.Fatal(err)
	}

	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err == nil {
		t.Fatal("已被替代的观测不应允许确认")
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("被拒绝的确认不应写快照，实际 %d 条", count)
	}
}

// TestRejectedObservationCannotBeConfirmed 已被拒绝的观测同样不能确认（既有行为回归）。
func TestRejectedObservationCannotBeConfirmed(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_rej_"+uuid.New().String()[:8])
	f.bindWork(t, "已拒绝不可确认", "2247480013_1")

	obsID := seedObservation(t, f, "2247480013_1", "wechat_browser", map[string]any{
		"like_count": map[string]any{"value": 1, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_metric_observation SET quality_state=$2 WHERE id=$1`,
		obsID, observationQualityRejected); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err == nil {
		t.Fatal("已被拒绝的观测不应允许确认")
	}
}
