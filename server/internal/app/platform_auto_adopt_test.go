package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-PS46 定向测试：auto_adopt 开关的真实行为（20 文档 §9.2、D-129）。
//
// 缺陷背景：入站路径原先**无条件只写观测**（注释写着"PS08 才接入投影"），
// 代码里没有任何地方检查 `auto_adopt`。也就是说把这个开关设成 true
// 也不会有任何自动投影发生——它是个空开关，第 4 项"验收通过后开启 auto_adopt"
// 即使验收过了也无效。
//
// 修复后：
//   - `auto_adopt=false`（默认）：只写观测，quality_state=needs_confirmation，不写快照；
//   - `auto_adopt=true`：观测写入后立即投影为正式指标，quality_state=valid。
//
// 投影复用 `confirmObservationTx`，因此单位/精度/绑定/替代等校验与手动确认完全一致。

// setAutoAdopt 直接改连接的 auto_adopt 开关。
func setAutoAdopt(t *testing.T, connectionID uuid.UUID, on bool) {
	t.Helper()
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_connection SET auto_adopt=$2, auto_collect=true, availability='ready',
			last_seen_at=now(), failure_count=0, cooldown_until=NULL WHERE id=$1`,
		connectionID, on); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(),
			`UPDATE platform_connection SET auto_adopt=false WHERE id=$1`, connectionID)
	})
}

// submitOne 组装并提交一个只含一条观测的终批，返回回执。
//
// 不能复用 f.resultBody：那里写的是 `adapter_version="fixture-1"` 与
// `view_times`（小红书字段），而映射表只认 `wechat-mp-1`/`xhs-1`。
// auto_adopt 走的是真实投影路径，版本必须与映射表一致。
func submitOne(t *testing.T, f *platformRunFixture, runID uuid.UUID, generation int64, externalID string) map[string]any {
	t.Helper()
	bindingRev, publishRev := workRevisions(t, f.workIDFor(t, externalID))
	// 公众号的真实适配器版本与字段。
	adapterVersion, field, unit := "wechat-mp-1", "like_count", "count"
	if f.Account.Platform == "xhs" {
		adapterVersion, field, unit = "xhs-1", "like_count", "count"
	}
	source := "wechat_browser"
	if f.Account.Platform == "xhs" {
		source = "xhs_browser"
	}
	body := map[string]any{
		"protocol_version":       desktopPlatformProtocolVersion,
		"lease_generation":       generation,
		"authorization_revision": connectionAuthRevision(t, f.Connection),
		"batch_seq":              0,
		"final_batch":            true,
		"run_status":             platformRunStatusSuccess,
		"coverage":               map[string]any{"pages_read": 1, "has_more": false},
		"observations": []map[string]any{{
			"row_no": 0, "scope": "work", "external_account_key": f.externalKey(),
			"external_id": externalID, "binding_revision": bindingRev, "publish_revision": publishRev,
			"source": source, "temporal_kind": "cumulative",
			"observed_at":     time.Now().UTC().Format(time.RFC3339),
			"as_of_at":        time.Now().UTC().Truncate(time.Second).Format(time.RFC3339),
			"adapter_version": adapterVersion, "mapping_version": 1,
			"values":      map[string]any{field: map[string]any{"value": 6, "precision": "exact", "unit": unit}},
			"field_paths": map[string]any{field: "fixture." + field},
		}},
	}
	raw, _ := json.Marshal(body)
	status, resp := f.submit(t, runID, raw)
	if status != 200 {
		t.Fatalf("提交失败：%d %s", status, resp)
	}
	var receipt map[string]any
	_ = json.Unmarshal(resp, &receipt)
	return receipt
}

// workIDFor 按外部编号取作品 ID。
func (f *platformRunFixture) workIDFor(t *testing.T, externalID string) uuid.UUID {
	t.Helper()
	column := "wechat_msgid"
	if f.Account.Platform == "xhs" {
		column = "xhs_note_id"
	}
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM work WHERE account_id=$1 AND `+column+`=$2 AND deleted_at IS NULL`, f.Account.ID, externalID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func metricRowsFor(t *testing.T, workID uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE work_id=$1 AND source='wechat_browser'`, workID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAutoAdoptOffWritesObservationOnly(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_adopt_off_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "自动采用关闭", "2247480040_1")
	setAutoAdopt(t, f.Connection, false)

	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	submitOne(t, f, runID, gen, "2247480040_1")

	// 观测已写入。
	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE external_id='2247480040_1'`,
	).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityNeedsConfirm {
		t.Fatalf("关闭时观测应为 %s，实际 %s", observationQualityNeedsConfirm, quality)
	}
	// 正式指标里不应有这条作品。
	if n := metricRowsFor(t, wk.ID); n != 0 {
		t.Fatalf("关闭时不应写正式指标，实际 %d 条", n)
	}
}

func TestAutoAdoptOnProjectsImmediately(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_adopt_on_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "自动采用开启", "2247480041_1")
	setAutoAdopt(t, f.Connection, true)

	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	// 前置断言：连接确实处于 auto_adopt=true，否则后续断言无意义。
	var autoAdopt bool
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT auto_adopt FROM platform_connection WHERE id=$1`, f.Connection).Scan(&autoAdopt); err != nil {
		t.Fatal(err)
	}
	if !autoAdopt {
		t.Fatal("前置条件：连接应为 auto_adopt=true")
	}
	submitOne(t, f, runID, gen, "2247480041_1")

	// 观测应转为 valid。
	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE external_id='2247480041_1'`,
	).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityValid {
		t.Fatalf("开启时观测应转为 %s，实际 %s", observationQualityValid, quality)
	}
	// 正式指标里应有这条作品，且能追溯到来源观测。
	var count int
	var hasObservation bool
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*), bool_and(observation_id IS NOT NULL) FROM metric_snapshot
		 WHERE work_id=$1 AND source='wechat_browser'`, wk.ID).Scan(&count, &hasObservation); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("开启时应写 1 条正式指标，实际 %d 条", count)
	}
	if !hasObservation {
		t.Fatal("正式指标必须能追溯到来源观测")
	}
}

// TestAutoAdoptReceiptCountsEveryFailedRow 回执里的 adopt_errors 表示"这一批有几条没入库"。
//
// 原实现恒写 1：两条一起失败时客户端以为只有一条有问题，影响面报小了。
// 这里让两条观测都用映射表里不存在的版本——观测能进库（原始记录有效），
// 投影那一步必然失败，正好用来验证计数。
func TestAutoAdoptReceiptCountsEveryFailedRow(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_adopt_multi_"+uuid.New().String()[:8])
	ids := []string{"2247480050_1", "2247480051_1"}
	for _, id := range ids {
		f.bindWork(t, "多条失败 "+id, id)
	}
	setAutoAdopt(t, f.Connection, true)

	env.srv.schedulePlatformRuns(context.Background())
	runID, gen, ok := f.claimWith(t)
	if !ok {
		t.Fatal("应能领到任务")
	}
	observations := make([]map[string]any, 0, len(ids))
	for i, id := range ids {
		bindingRev, publishRev := workRevisions(t, f.workIDFor(t, id))
		observations = append(observations, map[string]any{
			"row_no": i, "scope": "work", "external_account_key": f.externalKey(),
			"external_id": id, "binding_revision": bindingRev, "publish_revision": publishRev,
			"source": "wechat_browser", "temporal_kind": "cumulative",
			"observed_at":     time.Now().UTC().Format(time.RFC3339),
			"as_of_at":        time.Now().UTC().Truncate(time.Second).Format(time.RFC3339),
			"adapter_version": "wechat-mp-1", "mapping_version": 999,
			"values":      map[string]any{"like_count": map[string]any{"value": 6, "precision": "exact", "unit": "count"}},
			"field_paths": map[string]any{"like_count": "fixture.like_count"},
		})
	}
	body := map[string]any{
		"protocol_version":       desktopPlatformProtocolVersion,
		"lease_generation":       gen,
		"authorization_revision": connectionAuthRevision(t, f.Connection),
		"batch_seq":              0,
		"final_batch":            true,
		"run_status":             platformRunStatusSuccess,
		"coverage":               map[string]any{"pages_read": 1, "has_more": false},
		"observations":           observations,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	status, resp := f.submit(t, runID, raw)
	if status != http.StatusOK {
		t.Fatalf("提交失败：%d %s", status, resp)
	}
	var receipt map[string]any
	if err := json.Unmarshal(resp, &receipt); err != nil {
		t.Fatal(err)
	}
	got, _ := receipt["adopt_errors"].(float64)
	if int(got) != len(ids) {
		t.Fatalf("回执应报告 %d 条自动采用失败，实际 %v：%s", len(ids), receipt["adopt_errors"], resp)
	}
	if reason, _ := receipt["adopt_reason"].(string); reason == "" {
		t.Fatalf("应同时给出失败原因：%s", resp)
	}
	// 失败的是投影，原始观测必须留着（否则等于把采到的数据丢了）。
	var kept int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM platform_metric_observation WHERE run_id=$1 AND quality_state=$2`,
		runID, observationQualityNeedsConfirm).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != len(ids) {
		t.Fatalf("自动采用失败后观测应保持待确认，实际 %d 条", kept)
	}
}

// TestAutoAdoptStillHonorsUnitProtection 自动采用必须走与手动确认同一套校验，
// 单位 unknown 的字段照样不投影。
func TestAutoAdoptStillHonorsUnitProtection(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_adopt_unit_"+uuid.New().String()[:8])
	wk := f.bindWork(t, "自动采用仍守单位", "2247480042_1")
	setAutoAdopt(t, f.Connection, true)

	// 手工播种一条带 unknown 单位的待确认观测（绕开批次，直接验证投影侧的开关行为）。
	obs := seedPreciseObservation(t, f, "2247480042_1", "wechat_browser", map[string]map[string]any{
		"share_times": {"value": 9, "precision": "exact", "unit": "unknown"},
		"like_count":  {"value": 4, "precision": "exact", "unit": "count"},
	})
	// 通过自动采用路径投影。
	if err := env.srv.withTx(context.Background(), func(tx pgx.Tx) error {
		return env.srv.adoptInSavepoint(context.Background(), tx, obs, f.Workspace)
	}); err != nil {
		t.Fatal(err)
	}

	var shares, likes *int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT shares, likes FROM metric_snapshot WHERE work_id=$1 AND source='wechat_browser'`, wk.ID).
		Scan(&shares, &likes); err != nil {
		t.Fatal(err)
	}
	if shares != nil {
		t.Fatalf("单位 unknown 的 share_times 不得投影，实际 %d", *shares)
	}
	if likes == nil || *likes != 4 {
		t.Fatalf("count 单位的 like_count 应正常投影 4，实际 %v", likes)
	}
}
