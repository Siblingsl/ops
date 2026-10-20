package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS08 定向测试：指标口径、字段级投影与统一读取入口（20 文档 §8.4、§8.5、§9）。
// 覆盖 PS-T17、T20、T24、T37、T38、T41、T45。

// seedObservation 直接写一条观测，返回其 ID。归属与校验走真实存储函数。
func seedObservation(t *testing.T, f *platformRunFixture, externalID string, source string, values map[string]any) uuid.UUID {
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
		MappingVersion: 1, QualityState: observationQualityValid, MatchState: observationMatchBound,
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

// metricTestCtx 给直接调用的服务层函数补上当前工作区身份（HTTP 路径由中间件注入）。
func metricTestCtx(f *platformRunFixture) context.Context {
	return context.WithValue(context.Background(), ctxMember, &identity{
		UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner",
	})
}

func adapterVersionFor(platform string) string {
	if platform == "xhs" {
		return "xhs-1"
	}
	return "wechat-mp-1"
}

// TestMetricProjectionFieldLevel 对应 PS-T20/T45：整节点替换，未观测字段写 NULL 并标 missing，
// 不把昨天的值与今天的值拼成一条完整数据。
func TestMetricProjectionFieldLevel(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "字段级投影样本", "6f0000000000000000000101")
	pub := env.srv.today().AddDate(0, 0, -1)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}

	first := seedObservation(t, f, "6f0000000000000000000101", "xhs_browser", map[string]any{
		"like_count":     map[string]any{"value": 5, "precision": "exact", "unit": "count"},
		"favorite_count": map[string]any{"value": 3, "precision": "exact", "unit": "count"},
	})
	m, err := env.srv.confirmObservation(metricTestCtx(f), first)
	if err != nil {
		t.Fatalf("确认观测应成功：%v", err)
	}
	if m.Likes == nil || *m.Likes != 5 || m.Favorites == nil || *m.Favorites != 3 {
		t.Fatalf("首次投影应写入点赞与收藏：%+v", m)
	}

	// 第二次只带点赞：收藏必须变成 NULL，而不是沿用昨天的 3。
	second := seedObservation(t, f, "6f0000000000000000000101", "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 7, "precision": "exact", "unit": "count"},
	})
	m2, err := env.srv.confirmObservation(metricTestCtx(f), second)
	if err != nil {
		t.Fatalf("第二次确认应成功：%v", err)
	}
	if m2.Likes == nil || *m2.Likes != 7 {
		t.Fatalf("点赞应更新为 7：%+v", m2)
	}
	if m2.Favorites != nil {
		t.Fatalf("本次未观测的收藏必须为 NULL，实际 %d", *m2.Favorites)
	}
	var meta map[string]any
	if err := json.Unmarshal(m2.MetricMeta, &meta); err != nil {
		t.Fatal(err)
	}
	missing, _ := meta["missing_fields"].([]any)
	found := false
	for _, item := range missing {
		if item == "favorite_count" {
			found = true
		}
	}
	if !found {
		t.Fatalf("缺失字段必须在 metric_meta 标 missing：%v", meta)
	}
	// 同一来源同一节点只应有一行（整节点替换，不是追加）。
	var rows int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM metric_snapshot
		WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("同一来源同一节点应只有一行：%d %v", rows, err)
	}
}

// TestMetricUnitAndCTRRules 对应 PS-T17：单位落库，CTR 只在 read_unit='times' 时计算。
func TestMetricUnitAndCTRRules(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture-self")
	wk := f.bindWork(t, "口径样本", "2247489001_1")
	pub := env.srv.today().AddDate(0, 0, -2)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}

	// 人数口径：reads 与 impressions 都有值，但 read_unit=users，CTR 必须为空且标口径不可比。
	usersObs := seedObservation(t, f, "2247489001_1", "wechat_browser", map[string]any{
		"read_users":  map[string]any{"value": 100, "precision": "exact", "unit": "users"},
		"impressions": map[string]any{"value": 1000, "precision": "exact", "unit": "times"},
	})
	m, err := env.srv.confirmObservation(metricTestCtx(f), usersObs)
	if err != nil {
		t.Fatal(err)
	}
	if m.ReadUnit != metricUnitUsers {
		t.Fatalf("read_unit 必须落库为 users，实际 %q", m.ReadUnit)
	}
	if m.CTR != nil {
		t.Fatalf("人数口径不得计算 CTR，实际 %v", *m.CTR)
	}
	if m.CTRUnavailable != "read_unit_not_times" {
		t.Fatalf("应标出口径不可比原因，实际 %q", m.CTRUnavailable)
	}

	// 次数口径：CTR 正常计算。
	timesObs := seedObservation(t, f, "2247489001_1", "wechat_browser", map[string]any{
		"read_times":  map[string]any{"value": 200, "precision": "exact", "unit": "times"},
		"impressions": map[string]any{"value": 1000, "precision": "exact", "unit": "times"},
	})
	_ = timesObs
	// read_times 在映射注册表里登记为 unknown 单位，只存观测、不投影 reads，因此这里直接构造次数口径行验证 CTR。
	ctx := context.Background()
	reads, imp := 200, int64(1000)
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO metric_snapshot
		(work_id, captured_at, source, day_offset, reads, read_unit, impressions)
		VALUES ($1,now(),'file',0,$2,'times',$3)`, wk.ID, reads, imp); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var got Metric
	if err := env.srv.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot
		WHERE work_id=$1 AND source='file'`, wk.ID).Scan(metricDest(&got)...); err != nil {
		t.Fatal(err)
	}
	got.CTR, got.CTRUnavailable = metricCTR(&got)
	if got.CTR == nil || got.CTRUnavailable != "" {
		t.Fatalf("次数口径应计算 CTR：%+v", got)
	}
	if *got.CTR != 0.2 {
		t.Fatalf("CTR 应为 0.2，实际 %v", *got.CTR)
	}
}

// TestMetricMappingRegistryRejectsUnknownFields 对应 PS-T24/T41：未登记字段、未知映射版本、
// 单位不符都拒绝，不把未知键写成 reads。
func TestMetricMappingRegistryRejectsUnknownFields(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	asOf := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	base := platformObservationInput{
		WorkspaceID: f.Workspace, AccountID: f.Account.ID, ExternalAccountKey: f.externalKey(),
		ExternalID: ptrString("6f0000000000000000000201"), Scope: observationScopeWork,
		Source: "xhs_browser", TemporalKind: observationTemporalCumulative,
		ObservedAt: asOf, AsOfAt: &asOf, AdapterVersion: "xhs-1", MappingVersion: 1,
	}

	unknown := base
	unknown.Values = map[string]json.RawMessage{
		"unregistered_metric": json.RawMessage(`{"value":1,"precision":"exact","unit":"count"}`),
	}
	unknown.FieldPaths = map[string]string{"unregistered_metric": "fixture.unknown"}
	if err := validateObservationMapping("xhs", "xhs-1", 1, unknown); err == nil {
		t.Fatal("未登记字段必须拒绝")
	}

	if err := validateObservationMapping("xhs", "xhs-1", 99, base); err == nil {
		t.Fatal("未知映射版本必须拒绝")
	}

	wrongUnit := base
	wrongUnit.Values = map[string]json.RawMessage{
		"like_count": json.RawMessage(`{"value":1,"precision":"exact","unit":"times"}`),
	}
	wrongUnit.FieldPaths = map[string]string{"like_count": "fixture.like"}
	if err := validateObservationMapping("xhs", "xhs-1", 1, wrongUnit); err == nil {
		t.Fatal("单位与映射不符必须拒绝")
	}

	noPath := base
	noPath.Values = map[string]json.RawMessage{
		"like_count": json.RawMessage(`{"value":1,"precision":"exact","unit":"count"}`),
	}
	if err := validateObservationMapping("xhs", "xhs-1", 1, noPath); err == nil {
		t.Fatal("缺少来源路径必须拒绝")
	}
}

// TestMetricOutOfRangeNotProjected 对应 §9.2：超出目标列范围的观测不投影，也不截断成别的值。
func TestMetricOutOfRangeNotProjected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "超限样本", "6f0000000000000000000301")
	pub := env.srv.today().AddDate(0, 0, -1)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}
	obsID := seedObservation(t, f, "6f0000000000000000000301", "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 3000000000, "precision": "exact", "unit": "count"},
	})
	_, err := env.srv.confirmObservation(metricTestCtx(f), obsID)
	if err == nil {
		t.Fatal("超出 int 列范围的数值必须拒绝投影")
	}
	ae, ok := platformAPIError(err)
	if !ok || ae.Code != "platform_value_out_of_range" {
		t.Fatalf("应返回 platform_value_out_of_range，实际 %v", err)
	}
	// 观测本身保留，不删除。
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("观测必须保留：%d %v", count, err)
	}
}

// TestMetricQualityHeldExcludedFromReads 对应 PS-T38：held/superseded 不进入统一读取入口，
// 也不能算作节点已覆盖。
func TestMetricQualityHeldExcludedFromReads(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "质量过滤样本", "6f0000000000000000000401")
	ctx := context.Background()
	pub := env.srv.today().AddDate(0, 0, -7)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}
	day := 7
	reads := 50
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot
		(work_id, captured_at, source, day_offset, reads, read_unit, quality_state)
		VALUES ($1,now(),'xhs_browser',$2,$3,'times','held')`, wk.ID, day, reads); err != nil {
		t.Fatal(err)
	}
	list, err := env.srv.metricNodePublic(ctx, wk.ID, &day)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("held 行不得出现在统一读取入口：%+v", list)
	}
	// 节点覆盖只计 approved。
	due, covered, err := env.srv.metricNodeCoverage(ctx, f.Account.ID, 30)
	if err != nil {
		t.Fatal(err)
	}
	if due == 0 {
		t.Fatalf("样本应至少有一个到期节点：due=%d", due)
	}
	if covered != 0 {
		t.Fatalf("held 行不应算作节点已覆盖：%d", covered)
	}

	// 置为 approved 后才进入读取入口。
	if _, err := env.srv.db.Exec(ctx, `UPDATE metric_snapshot SET quality_state='approved'
		WHERE work_id=$1`, wk.ID); err != nil {
		t.Fatal(err)
	}
	list, err = env.srv.metricNodePublic(ctx, wk.ID, &day)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Reads == nil || *list[0].Reads != 50 {
		t.Fatalf("approved 行应可读：%+v", list)
	}
}

// TestMetricObservationConfirmRequiresBinding 对应 §9.3：未精确绑定的观测不能确认投影。
func TestMetricObservationConfirmRequiresBinding(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	// 不绑定：外部编号不存在于作品表。
	obsID := seedObservation(t, f, "6f0000000000000000000501", "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 1, "precision": "exact", "unit": "count"},
	})
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err == nil {
		t.Fatal("未绑定作品的观测不得确认")
	} else if ae, ok := platformAPIError(err); !ok || ae.Code != "platform_result_conflict" {
		t.Fatalf("应返回 platform_result_conflict，实际 %v", err)
	}
	var rows int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("确认失败不得写入指标：%d %v", rows, err)
	}
}

// TestMetricObservationConfirmHTTP 走一次真实 HTTP 端点，确认接口形状与权限。
func TestMetricObservationConfirmHTTP(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "确认接口样本", "6f0000000000000000000601")
	pub := env.srv.today().AddDate(0, 0, -1)
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}
	obsID := seedObservation(t, f, "6f0000000000000000000601", "xhs_browser", map[string]any{
		"like_count": map[string]any{"value": 9, "precision": "exact", "unit": "count"},
	})
	var got Metric
	env.mustJSON(t, "POST", "/api/v1/metrics/observations/"+obsID.String()+"/confirm", nil, &got)
	if got.Likes == nil || *got.Likes != 9 {
		t.Fatalf("确认后应写入点赞：%+v", got)
	}
	// 观测列表可读且带质量状态。
	var list struct {
		Observations []map[string]any `json:"observations"`
	}
	env.mustJSON(t, "GET", "/api/v1/accounts/"+f.Account.ID.String()+"/metrics/observations", nil, &list)
	if len(list.Observations) == 0 {
		t.Fatal("观测列表应至少返回一条")
	}
	// 逐条确认：重复确认同一条不再产生第二行指标。
	env.mustJSON(t, "POST", "/api/v1/metrics/observations/"+obsID.String()+"/confirm", nil, nil)
	var rows int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1 AND source='xhs_browser'`, wk.ID).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("同一观测重复确认不应新增行：%d %v", rows, err)
	}
}

// TestMetricSourceRankCoversNewSources 对应 PS-T24：新增来源必须登记在排序里，
// 未登记来源在正式读取中被拒绝而不是排到最后。
func TestMetricSourceRankCoversNewSources(t *testing.T) {
	ctx := context.Background()
	for source, want := range map[string]int{
		"wechat_api": 0, "wechat_browser": 1, "xhs_browser": 1, "file": 2, "screenshot": 3, "paste": 4, "manual": 5,
	} {
		var got *int
		if err := env.srv.db.QueryRow(ctx, `SELECT metric_source_rank($1)`, source).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got == nil || *got != want {
			t.Fatalf("%s 的排序应为 %d，实际 %v", source, want, got)
		}
	}
	var known *bool
	if err := env.srv.db.QueryRow(ctx, `SELECT metric_source_supported('unknown_source')`).Scan(&known); err != nil {
		t.Fatal(err)
	}
	if known != nil && *known {
		t.Fatal("未登记来源不得被视为受支持")
	}
}

// TestMetricNodePublicReturnsUnits 对应 PS-T38：统一入口输出单位、实际日数与精确性标志。
func TestMetricNodePublicReturnsUnits(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:fixture-self")
	wk := f.bindWork(t, "统一入口样本", "6f0000000000000000000701")
	ctx := context.Background()
	pub := env.srv.today().AddDate(0, 0, -10)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET published_at=$2 WHERE id=$1`, wk.ID, pub.Add(20*time.Hour)); err != nil {
		t.Fatal(err)
	}
	// 只有 D3，没有 D7：读取 D7 时按 §9.5 回退到最接近且早于 D7 的记录，并标 node_exact=false。
	day := 3
	reads := 80
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO metric_snapshot
		(work_id, captured_at, source, day_offset, reads, read_unit, quality_state, as_of_at)
		VALUES ($1,now(),'xhs_browser',$2,$3,'unknown','approved',now())`, wk.ID, day, reads); err != nil {
		t.Fatal(err)
	}
	var row struct {
		Reads         *int
		ReadUnit      string
		ActualDay     int
		NodeExact     bool
		MissingFields []string
	}
	if err := env.srv.db.QueryRow(ctx, `SELECT reads, read_unit, actual_day_offset, node_exact, missing_fields
		FROM metric_node_public($1, 7) LIMIT 1`, wk.ID).Scan(
		&row.Reads, &row.ReadUnit, &row.ActualDay, &row.NodeExact, &row.MissingFields); err != nil {
		t.Fatal(err)
	}
	if row.ActualDay != 3 || row.NodeExact {
		t.Fatalf("D3 不能冒充精确 D7：actual=%d exact=%v", row.ActualDay, row.NodeExact)
	}
	if row.ReadUnit != "unknown" {
		t.Fatalf("单位必须原样输出：%q", row.ReadUnit)
	}
	// 未观测字段必须出现在 missing_fields 里。
	found := false
	for _, name := range row.MissingFields {
		if name == "likes" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing_fields 应包含未观测字段：%v", row.MissingFields)
	}
}
