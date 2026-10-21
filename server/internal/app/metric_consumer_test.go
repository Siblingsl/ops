package app

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-PS22 定向测试：指标消费者迁移（20 文档 §8.4）。
//
// 规范要求：覆盖判断只计 `approved`，**不能把 held 算作已覆盖**——
// 否则待确认的数据会让节点提醒提前静默，用户再也不会被提醒去补这一天。

// metricRowFor 直接写一条指定质量状态的 metric_snapshot，返回其 ID。
// 同一 (work_id, source, day_offset) 有唯一约束，因此同节点改状态要先删旧行，
// 这正是真实路径（确认 held → 转 approved）的行为。
func metricRowFor(t *testing.T, workID uuid.UUID, dayOffset int, quality string) uuid.UUID {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot
		WHERE work_id=$1 AND source='manual' AND day_offset=$2`, workID, dayOffset); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO metric_snapshot
		(work_id, day_offset, reads, likes, captured_at, source, quality_state)
		VALUES ($1,$2,10,1,now(),'manual',$3) RETURNING id`,
		workID, dayOffset, quality).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM metric_snapshot WHERE work_id=$1`, workID)
	})
	return id
}

func TestMetricNodeDueIgnoresHeldQuality(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_due_"+uuid.New().String()[:8])
	// 昨天发布 → day_offset=1 → metric_node(1)=1。节点 0 不存在（metric_node 对 <1 返回 NULL）。
	pub := env.srv.today().AddDate(0, 0, -1)
	wk := drWork(t, f.Account, "覆盖判断测试", "published", &pub)

	// 先确认无数据时该作品是“待填”。$api 传 false 排除 API 覆盖。
	due := func() bool {
		var isDue bool
		if err := env.srv.db.QueryRow(context.Background(), `SELECT (SELECT `+nodeDueExpr(1, 2)+`
			FROM work w WHERE w.id=$3) IS NOT NULL`, env.srv.now(), false, wk.ID).Scan(&isDue); err != nil {
			t.Fatal(err)
		}
		return isDue
	}
	if !due() {
		t.Fatal("无数据时应判定为待填")
	}

	// 写一条 held 的同节点数据：**不算已覆盖**，仍应提醒。
	metricRowFor(t, wk.ID, 1, "held")
	if !due() {
		t.Fatal("held 不能算作已覆盖：待确认数据会让提醒提前静默")
	}

	// 改成 approved：这次才算覆盖，不再提醒。
	metricRowFor(t, wk.ID, 1, "approved")
	if due() {
		t.Fatal("approved 应算作已覆盖，不再提醒")
	}
}

// TestMetricReminderQueryOnlyCountsApproved 用源码契约检测提醒查询是否只计 approved。
//
// 提醒逻辑在 `metricRemindersJob` 的闭包里、没有可注入的接缝，无法用行为测试直接覆盖；
// 因此这里断言源码本身：覆盖判断必须带 `quality_state='approved'`。
// 变体一旦去掉该过滤（held 会被当成已填、提醒提前静默），本测试立即失败。
func TestMetricReminderQueryOnlyCountsApproved(t *testing.T) {
	src, err := os.ReadFile("insights.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	// 提醒查询里“已填节点”的判定必须限定 approved（锚定 ARRAY(SELECT DISTINCT ...) 那段）。
	if !strings.Contains(text, "ARRAY(SELECT DISTINCT metric_node(m.day_offset) FROM metric_snapshot m\n"+
		"\t\t\tWHERE m.work_id=w.id AND metric_node(m.day_offset) IS NOT NULL AND m.quality_state='approved')") {
		t.Fatal("节点提醒的覆盖判断必须只计 approved，否则 held 会让提醒提前静默")
	}
	// metricNodeDueSQL 同理（它被多处复用，去掉会连带影响节点任务）。
	if !strings.Contains(text, "AND NOT EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id "+
		"AND metric_node(m.day_offset)=cur.n AND m.quality_state='approved')") {
		t.Fatal("metricNodeDueSQL 的覆盖判断必须只计 approved")
	}
}

// TestMetricNodePublicExcludesHeld 确认唯一读取入口本身也排除 held（既有能力回归）。
func TestMetricNodePublicExcludesHeld(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_pub_"+uuid.New().String()[:8])
	pub := env.srv.today().AddDate(0, 0, -7)
	wk := drWork(t, f.Account, "统一入口测试", "published", &pub)

	metricRowFor(t, wk.ID, 7, "held")
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_node_public($1, 7)`, wk.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("metric_node_public 必须排除 held，实际返回 %d 条", n)
	}

	metricRowFor(t, wk.ID, 7, "approved")
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_node_public($1, 7)`, wk.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("approved 应能被统一入口读到")
	}
	// 统一入口必须输出单位字段，供消费者判断能否相加（§8.4）。
	var readUnit, shareUnit string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT read_unit, share_unit FROM metric_node_public($1, 7) LIMIT 1`, wk.ID).Scan(&readUnit, &shareUnit); err != nil {
		t.Fatal(err)
	}
	if readUnit == "" || shareUnit == "" {
		t.Fatalf("统一入口必须输出单位，实际 read=%q share=%q", readUnit, shareUnit)
	}
}

var _ = time.Now
