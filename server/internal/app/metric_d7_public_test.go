package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-PS28 定向测试：D7 语义的统一读取入口（20 文档 §8.4）。
//
// 迁移 `work_metric_d7` 的 8 个消费点前，必须先证明新入口与旧视图**读数一致**，
// 否则"迁移"会悄悄改变现有报表。

// seedNode 给作品写一条指定节点与读数的 approved 指标。
// 注意：`(work_id, source, day_offset)` 是 DEFERRABLE 唯一约束，
// `ON CONFLICT` 不支持它，因此用先删后插。
func seedNode(t *testing.T, workID uuid.UUID, dayOffset int, reads int) {
	t.Helper()
	captured := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot
		WHERE work_id=$1 AND source='manual' AND day_offset=$2`, workID, dayOffset); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, captured_at, source, quality_state)
		VALUES ($1,$2,$3,$4,'manual','approved')`,
		workID, dayOffset, reads, captured); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot WHERE work_id=$1`, workID)
	})
}

// nodeD7Comparison 同时读旧视图与新函数，返回两者结果用于比对。
func nodeD7Comparison(t *testing.T, workID uuid.UUID) (viewReads *int, viewOffset *int, fnReads *int, fnOffset *int) {
	t.Helper()
	// 旧视图：没有行时用 NULL 表示"无值"。
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, day_offset FROM work_metric_d7 WHERE work_id=$1`, workID).
		Scan(&viewReads, &viewOffset); err != nil {
		viewReads, viewOffset = nil, nil
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT reads, day_offset FROM metric_node_d7_public($1)`, workID).
		Scan(&fnReads, &fnOffset); err != nil {
		fnReads, fnOffset = nil, nil
	}
	return
}

func TestMetricNodeD7PublicMatchesView(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_d7_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -20)
	wk := drWork(t, f.Account, "D7 语义对比", "published", &pub)

	assertSame := func(scenario string) {
		t.Helper()
		vr, vo, fr, fo := nodeD7Comparison(t, wk.ID)
		if (vr == nil) != (fr == nil) {
			t.Fatalf("%s：有值性不一致（视图=%v 函数=%v）", scenario, vr, fr)
		}
		if vr != nil && (*vr != *fr || *vo != *fo) {
			t.Fatalf("%s：读数不一致（视图=%d@%d 函数=%d@%d）", scenario, *vr, *vo, *fr, *fo)
		}
	}

	// 场景 1：只有 >7 的数据——d7 会兜底，新函数必须同样兜底。
	seedNode(t, wk.ID, 15, 777)
	assertSame("只有 day_offset=15")

	// 场景 2：1/3/7/15——应取 7（<=7 中最大）。
	seedNode(t, wk.ID, 1, 100)
	seedNode(t, wk.ID, 3, 300)
	seedNode(t, wk.ID, 7, 700)
	assertSame("1,3,7,15")

	// 场景 3：只有 1/3——应取 3。
	if _, err := env.srv.db.Exec(context.Background(),
		`DELETE FROM metric_snapshot WHERE work_id=$1 AND day_offset IN (7,15)`, wk.ID); err != nil {
		t.Fatal(err)
	}
	assertSame("只有 1,3")
}

// TestMetricNodeD7PublicDoesNotLeakHeld 确认新入口同样排除 held。
func TestMetricNodeD7PublicDoesNotLeakHeld(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_d7h_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -10)
	wk := drWork(t, f.Account, "D7 质量过滤", "published", &pub)

	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, captured_at, source, quality_state)
		VALUES ($1,7,999,now(),'manual','held')`, wk.ID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot WHERE work_id=$1`, wk.ID)
	})

	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_node_d7_public($1)`, wk.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("新入口必须排除 held，实际返回 %d 条", n)
	}
}

// TestMetricNodeD7PublicAllBatches 确认批量版本与逐个调用结果一致。
func TestMetricNodeD7PublicAllBatches(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_d7b_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -10)
	first := drWork(t, f.Account, "批量 A", "published", &pub)
	second := drWork(t, f.Account, "批量 B", "published", &pub)
	seedNode(t, first.ID, 7, 11)
	seedNode(t, second.ID, 3, 22)

	var batched int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_node_d7_public_all(ARRAY[$1,$2]::uuid[])`,
		first.ID, second.ID).Scan(&batched); err != nil {
		t.Fatal(err)
	}
	var single int
	for _, id := range []uuid.UUID{first.ID, second.ID} {
		var c int
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT count(*) FROM metric_node_d7_public($1)`, id).Scan(&c); err != nil {
			t.Fatal(err)
		}
		single += c
	}
	if batched != single {
		t.Fatalf("批量与逐个结果不一致：批量=%d 逐个=%d", batched, single)
	}
	// 空数组不应报错。
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_node_d7_public_all(ARRAY[]::uuid[])`).Scan(&batched); err != nil {
		t.Fatal(err)
	}
	if batched != 0 {
		t.Fatalf("空输入应返回 0 行，实际 %d", batched)
	}
}
