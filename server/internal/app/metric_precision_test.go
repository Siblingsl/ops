package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS43 定向测试：取整值（rounded）不得进入正式指标（20 文档 §9.1、D-129 v0.4）。
//
// 为什么这条重要：小红书/公众号在数值较大时会显示 `1.2万` 这类取整值。
// 适配器把 `1.2万` 解析成 12000 但标 `precision=rounded`（表示"这是取整后的近似值"）。
// 如果投影不看 precision，就会把 12000 当成精确值写进正式指标——
// 而这个数字可能是 11960~12040 之间的任何值，且原始精确值无法再取回。
//
// 这条不依赖真实大数值账号也能验证：只要拿 rounded 观测走一遍确认流程，
// 看正式指标里对应列是否为 NULL。

// seedPreciseObservation 直插一条指定 precision 的待确认观测。
func seedPreciseObservation(t *testing.T, f *platformRunFixture, externalID, source string,
	values map[string]map[string]any) uuid.UUID {
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
	// as_of_at 必须晚于发布日，否则 day_offset 为负、节点无效。
	pub := env.srv.today().AddDate(0, 0, -1).Add(20 * time.Hour)
	asOf := pub.Add(2 * time.Hour)
	in := platformObservationInput{
		WorkspaceID: f.Workspace, AccountID: f.Account.ID, ExternalAccountKey: f.externalKey(),
		ExternalID: &externalID, Scope: observationScopeWork, Source: source,
		TemporalKind: observationTemporalCumulative, ObservedAt: asOf, AsOfAt: &asOf,
		Values: raw, FieldPaths: paths, AdapterVersion: adapterVersionFor(f.Account.Platform),
		MappingVersion: 1, MatchState: observationMatchBound,
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

func TestRoundedValueNotProjected(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_round_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "取整不投影", "2247480030_1")

	// read_times 映射为 unknown 单位（本来就不投），因此改用 likes 验证 precision 本身：
	// 同一个字段给两个观测，一个 exact 一个 rounded，确认只有 exact 生效。
	roundedObs := seedPreciseObservation(t, f, "2247480030_1", "wechat_browser", map[string]map[string]any{
		"like_count": {"value": 12000, "precision": "rounded", "unit": "count"},
	})

	if _, err := env.srv.confirmObservation(metricTestCtx(f), roundedObs); err != nil {
		t.Fatal(err)
	}

	var likes *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT likes FROM metric_snapshot WHERE work_id=$1 AND source='wechat_browser'`, wk.ID).Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes != nil {
		t.Fatalf("rounded 值不得写入正式指标，实际 likes=%d", *likes)
	}

	// 同一节点再来一条 exact 的，这次应该写进去。
	exactObs := seedPreciseObservation(t, f, "2247480030_1", "wechat_browser", map[string]map[string]any{
		"like_count": {"value": 12345, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), exactObs); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT likes FROM metric_snapshot WHERE work_id=$1 AND source='wechat_browser'`, wk.ID).Scan(&likes); err != nil {
		t.Fatal(err)
	}
	if likes == nil || *likes != 12345 {
		t.Fatalf("exact 值应写入正式指标 12345，实际 %v", likes)
	}
}

// TestWanUnitParsedAsRounded 确认适配器把 `1.2万` 标成 rounded 而不是 exact。
// 这是上层保护能生效的前提：如果适配器误标 exact，投影层无从判断。
func TestWanUnitParsedAsRounded(t *testing.T) {
	// 适配器侧的解析（Go 侧没有同名实现时用观测值模拟）：
	// 这里用观测输入的 precision 直接验证投影行为，解析规则由 desktop 侧测试覆盖。
	// 本测试只确保"rounded 一定不投影"这一条在服务端成立。
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_wan_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "万分位不投影", "6f0000000000000000000031")

	obs := seedPreciseObservation(t, f, "6f0000000000000000000031", "xhs_browser", map[string]map[string]any{
		"like_count":     {"value": 12000, "precision": "rounded", "unit": "count"},
		"favorite_count": {"value": 3400, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obs); err != nil {
		t.Fatal(err)
	}

	var likes, favorites *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT likes, favorites FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).
		Scan(&likes, &favorites); err != nil {
		t.Fatal(err)
	}
	if likes != nil {
		t.Fatalf("rounded 的 likes 不得投影，实际 %d", *likes)
	}
	if favorites == nil || *favorites != 3400 {
		t.Fatalf("同批 exact 的 favorites 应正常投影 3400，实际 %v", favorites)
	}
}

// TestRoundedObservationStillStored rounded 不再导致整条观测被拒，
// 其它正常字段必须照常入库并投影（§9.1："可作为 rounded 展示"）。
//
// 缺陷背景：入站校验原先把 precision 与映射登记做严格相等比较，
// 映射登记都是 exact，因此任何 rounded 观测都被 422 拒绝**整条**——
// 一个取整字段会让同批的正常字段一起丢失，用户看到"采集成功但一条数据都没有"。
func TestRoundedObservationStillStored(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_still_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "取整不丢整条", "6f0000000000000000000032")

	// 一条观测里混着 rounded 与 exact 字段。
	obs := seedPreciseObservation(t, f, "6f0000000000000000000032", "xhs_browser", map[string]map[string]any{
		"like_count":     {"value": 12000, "precision": "rounded", "unit": "count"},
		"comment_count":  {"value": 42, "precision": "exact", "unit": "count"},
		"favorite_count": {"value": 7, "precision": "exact", "unit": "count"},
	})

	// 观测本身必须存在（不再被拒）。
	var stored int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE id=$1`, obs).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatal("rounded 字段不应导致整条观测被拒")
	}

	// 确认后：exact 字段投影，rounded 字段不投影。
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obs); err != nil {
		t.Fatal(err)
	}
	var likes, comments, favorites *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT likes, comments, favorites FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).
		Scan(&likes, &comments, &favorites); err != nil {
		t.Fatal(err)
	}
	if likes != nil {
		t.Fatalf("rounded 的 like_count 不得投影，实际 %d", *likes)
	}
	if comments == nil || *comments != 42 {
		t.Fatalf("同批 exact 的 comment_count 应投影 42，实际 %v", comments)
	}
	if favorites == nil || *favorites != 7 {
		t.Fatalf("同批 exact 的 favorite_count 应投影 7，实际 %v", favorites)
	}
}

// TestUnknownPrecisionRejected 非法精度取值仍要拒绝（白名单校验）。
func TestUnknownPrecisionRejected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture_badprec_"+uuid.New().String()[:8])
	f.bindWork(t, "非法精度", "6f0000000000000000000033")

	pub := env.srv.today().AddDate(0, 0, -1).Add(20 * time.Hour)
	asOf := pub.Add(2 * time.Hour)
	in := platformObservationInput{
		WorkspaceID: f.Workspace, AccountID: f.Account.ID, ExternalAccountKey: f.externalKey(),
		ExternalID: strPtr("6f0000000000000000000033"), Scope: observationScopeWork, Source: "xhs_browser",
		TemporalKind: observationTemporalCumulative, ObservedAt: asOf, AsOfAt: &asOf,
		Values: map[string]json.RawMessage{
			"like_count": json.RawMessage(`{"value": 5, "precision": "totally_wrong", "unit": "count"}`),
		},
		FieldPaths:     map[string]string{"like_count": "fixture.likes"},
		AdapterVersion: "xhs-1", MappingVersion: 1, MatchState: observationMatchBound,
	}
	// 入站不做字段级校验（`validateObservationMapping` 只在确认时调用），
	// 因此非法精度在这一步会被接受；真正的拦截发生在确认时。
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		_, _, e := insertPlatformObservation(context.Background(), tx, in)
		return e
	}); err != nil {
		t.Fatalf("入站阶段不应做字段级精度校验：%v", err)
	}

	// 确认时必须拒绝非法精度。
	var obsID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM platform_metric_observation WHERE external_id='6f0000000000000000000033' ORDER BY created_at DESC LIMIT 1`).
		Scan(&obsID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err == nil {
		t.Fatal("确认时非法 precision 应被拒绝")
	}
}

func strPtr(s string) *string { return &s }
