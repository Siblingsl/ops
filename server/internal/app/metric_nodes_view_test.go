package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-PS42 定向测试：节点视图必须排除 held/superseded（20 文档 §8.4）。
//
// 缺陷背景：`metricNodesView` 的查询只按 rank 排序、**没有过滤 quality_state**。
// 结果：被人工更正排除的自动候选（标 held）仍以高 rank 胜出，
// 用户在复盘页看到的还是那条本应被排除的旧值。
//
// 实证：造 wechat_api(held, 200) + wechat_browser(approved, 300)，
// 修复前返回 wechat_api/200，修复后应返回 wechat_browser/300。

// seedMetricRow 直插一条指定来源与质量状态的快照。
func seedMetricRow(t *testing.T, workID uuid.UUID, source, quality string, reads int, dayOffset int) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, likes, captured_at, source, quality_state, read_unit, share_unit)
		VALUES ($1,$2,$3,0,now(),$4,$5,'unknown','unknown')`,
		workID, dayOffset, reads, source, quality); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`DELETE FROM metric_snapshot WHERE work_id=$1 AND source=$2`, workID, source)
	})
}

func TestMetricNodesViewExcludesHeld(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_view_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	ctx := context.Background()
	wk := drWork(t, f.Account, "节点视图排除", "published", &pub)

	// 高 rank（wechat_api=0）但被排除；低 rank（wechat_browser=1）才是正式值。
	seedMetricRow(t, wk.ID, "wechat_api", "held", 200, 7)
	seedMetricRow(t, wk.ID, "wechat_browser", "approved", 300, 7)

	view, err := env.srv.metricNodesView(ctx, wk.ID, &pub)
	if err != nil {
		t.Fatal(err)
	}
	nodes, ok := view["nodes"].([]metricNodeView)
	if !ok {
		t.Fatalf("nodes 类型异常：%T", view["nodes"])
	}
	var got *Metric
	for i := range nodes {
		if nodes[i].Node == 7 {
			got = nodes[i].Metric
			break
		}
	}
	if got == nil {
		t.Fatal("节点 7 应有取值")
	}
	if got.Source != "wechat_browser" {
		t.Fatalf("held 的来源不应胜出，实际选中 %s", got.Source)
	}
	if got.Reads == nil || *got.Reads != 300 {
		t.Fatalf("应取 approved 的读数 300，实际 %v", got.Reads)
	}
	if got.QualityState != "approved" {
		t.Fatalf("返回的质量状态应为 approved，实际 %s", got.QualityState)
	}
}

// TestMetricNodesViewExcludesSuperseded superseded 同样要排除。
func TestMetricNodesViewExcludesSuperseded(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_view2_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	ctx := context.Background()
	wk := drWork(t, f.Account, "节点视图排除2", "published", &pub)

	seedMetricRow(t, wk.ID, "wechat_api", "superseded", 111, 7)
	seedMetricRow(t, wk.ID, "file", "approved", 222, 7)

	view, err := env.srv.metricNodesView(ctx, wk.ID, &pub)
	if err != nil {
		t.Fatal(err)
	}
	nodes := view["nodes"].([]metricNodeView)
	for _, n := range nodes {
		if n.Node != 7 || n.Metric == nil {
			continue
		}
		if n.Metric.Source != "file" {
			t.Fatalf("superseded 的来源不应胜出，实际 %s", n.Metric.Source)
		}
		if n.Metric.Reads == nil || *n.Metric.Reads != 222 {
			t.Fatalf("应取 approved 的读数 222，实际 %v", n.Metric.Reads)
		}
		return
	}
	t.Fatal("节点 7 应有取值")
}

// TestMetricNodesViewPrefersHigherRankAmongApproved 同为 approved 时按 rank 选（既有行为回归）。
func TestMetricNodesViewPrefersHigherRankAmongApproved(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_view3_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -8)
	ctx := context.Background()
	wk := drWork(t, f.Account, "节点视图优先级", "published", &pub)

	seedMetricRow(t, wk.ID, "manual", "approved", 500, 7)
	seedMetricRow(t, wk.ID, "wechat_api", "approved", 600, 7)

	view, err := env.srv.metricNodesView(ctx, wk.ID, &pub)
	if err != nil {
		t.Fatal(err)
	}
	nodes := view["nodes"].([]metricNodeView)
	for _, n := range nodes {
		if n.Node != 7 || n.Metric == nil {
			continue
		}
		if n.Metric.Source != "wechat_api" {
			t.Fatalf("wechat_api 的 rank 更高，应胜出，实际 %s", n.Metric.Source)
		}
		if n.Metric.Reads == nil || *n.Metric.Reads != 600 {
			t.Fatalf("应取 wechat_api 的读数 600，实际 %v", n.Metric.Reads)
		}
		return
	}
	t.Fatal("节点 7 应有取值")
}

var _ = time.Now
