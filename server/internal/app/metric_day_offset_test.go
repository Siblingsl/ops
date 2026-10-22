package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestMetricDayOffsetMatchesDatabaseTrigger Go 侧 day_offset 口径必须与数据库触发器
// `metric_snapshot_fill_offset`（迁移 00024）一致。
//
// 缺陷背景（2026-10-22 定位）：触发器在 INSERT（day_offset 为 NULL 时）与所有 UPDATE 上
// 都会用 `metric_day_offset(captured_at, published_at)` 重算 day_offset，而 Go 侧
// `metricDayOffset` 用的是 `as_of_at`，且 offset<0 时返回 nil。两侧不一致时：
//   - Go 传 NULL，触发器却按 captured_at 落 0；
//   - 下次确认按 `day_offset IS NOT DISTINCT FROM NULL` 匹配不到那个 0 行；
//   - 改走 INSERT → 撞 metric_snapshot_node 唯一索引 → 500。
//
// 这条测试钉住"同一节点二次确认必须成功"，即上述链路的核心不变量。
func TestMetricDayOffsetMatchesDatabaseTrigger(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_offset_"+uuid.New().String()[:8])
	externalID := "6f0000000000000000000060"
	wk := f.bindWork(t, "日偏移口径一致", externalID)

	// 让 as_of_at 早于 published_at，触发原先返回 nil 的分支。
	// seedObservation 的 as_of_at 硬编码 2026-10-20 18:00+08。
	pub := time.Date(2026, 10, 25, 4, 0, 0, 0, time.FixedZone("CST", 8*3600))
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub); err != nil {
		t.Fatal(err)
	}

	first := seedObservation(t, f, externalID, "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 5, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), first); err != nil {
		t.Fatalf("第一次确认应成功：%v", err)
	}

	// Go 侧算出的偏移必须与库里落盘的一致（触发器不会覆盖成别的值）。
	var goOffset *int
	asOf := time.Date(2026, 10, 20, 18, 0, 0, 0, time.FixedZone("CST", 8*3600))
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		var e error
		goOffset, e = metricDayOffset(tx, context.Background(), wk.ID, asOf)
		return e
	}); err != nil {
		t.Fatal(err)
	}
	var stored *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT day_offset FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).
		Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if goOffset == nil || stored == nil || *goOffset != *stored {
		t.Fatalf("Go 侧偏移 %v 与库内 %v 不一致，二次确认必然匹配不到行",
			derefInt(goOffset), derefInt(stored))
	}

	// 同一节点再确认一次：必须走 UPDATE，而不是 INSERT 撞唯一索引。
	second := seedObservation(t, f, externalID, "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 7, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), second); err != nil {
		t.Fatalf("同节点二次确认应成功（缺陷复现点：metric_snapshot_node 唯一冲突）：%v", err)
	}

	// 仍然只有一行，且读数是第二次的值（整节点替换）。
	var rows int
	var likes *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("同一来源同一节点应只有一行，实际 %d", rows)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT likes FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes == nil || *likes != 7 {
		t.Fatalf("整节点替换后 likes 应为 7，实际 %v", derefInt(likes))
	}
}

func derefInt(v *int) any {
	if v == nil {
		return "NULL"
	}
	return *v
}
