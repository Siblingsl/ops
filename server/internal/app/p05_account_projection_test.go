package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// P0-5（docs/37）：账号观测投影 account_metric_daily 定向测试。
// 规则（docs/20 §9.3）：followers_total→cumulate（保留 as_of_at）；
// new/cancel/net_follow_users 仅单日 interval 可投影；unknown/rounded 只存观测。

// seedAccountObservation 走真实入库路径构造一条 scope=account 观测（match_state=not_applicable）。
func seedAccountObservation(t *testing.T, f *platformRunFixture, temporalKind string,
	values map[string]any, observedAt time.Time, windowStart, windowEnd *time.Time) uuid.UUID {
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
	asOf := observedAt
	in := platformObservationInput{
		WorkspaceID: f.Workspace, AccountID: f.Account.ID, ExternalAccountKey: f.externalKey(),
		Scope: observationScopeAccount, Source: "xhs_browser",
		TemporalKind: temporalKind, ObservedAt: observedAt, AsOfAt: &asOf,
		WindowStart: windowStart, WindowEnd: windowEnd,
		Values: raw, FieldPaths: paths, AdapterVersion: adapterVersionFor(f.Account.Platform),
		MappingVersion: 1, MatchState: observationMatchNotApplicable,
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

func accountDailyRow(t *testing.T, accountID uuid.UUID, source string) (newF, cancelF, cum, netF *int, observationID *uuid.UUID) {
	t.Helper()
	var newRaw, cancelRaw, cumRaw, netRaw *int
	var obsRaw *uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT new_follow, cancel_follow, cumulate, net_follow, observation_id FROM account_metric_daily
		WHERE account_id=$1 AND source=$2 LIMIT 1`, accountID, source).
		Scan(&newRaw, &cancelRaw, &cumRaw, &netRaw, &obsRaw); err != nil {
		t.Fatalf("account_metric_daily 行不存在：%v", err)
	}
	return newRaw, cancelRaw, cumRaw, netRaw, obsRaw
}

func TestP05AccountObservationProjectsFollowersTotal(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p05total_"+uuid.New().String()[:8])
	now := env.srv.now()
	obsID := seedAccountObservation(t, f, observationTemporalCumulative, map[string]any{
		"followers_total": map[string]any{"value": 1234, "precision": "exact", "unit": "users"},
	}, now, nil, nil)

	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("账号观测确认应成功：%v", err)
	}
	_, _, cum, _, obsRef := accountDailyRow(t, f.Account.ID, "xhs_browser")
	if cum == nil || *cum != 1234 {
		t.Fatalf("followers_total 应投影 cumulate=1234：got %v", cum)
	}
	if obsRef == nil || *obsRef != obsID {
		t.Fatalf("observation_id 应回写：%v vs %s", obsRef, obsID)
	}
	// 不写作品快照。
	var snapCount int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM metric_snapshot WHERE observation_id=$1`, obsID).Scan(&snapCount); err != nil {
		t.Fatal(err)
	}
	if snapCount != 0 {
		t.Fatalf("账号观测不得写 metric_snapshot：count=%d", snapCount)
	}
	// 观测状态转 valid。
	var quality string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT quality_state FROM platform_metric_observation WHERE id=$1`, obsID).Scan(&quality); err != nil {
		t.Fatal(err)
	}
	if quality != observationQualityValid {
		t.Fatalf("确认后应 valid：%s", quality)
	}
}

func TestP05AccountObservationSingleDayIntervalProjectsNetFollow(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p05net_"+uuid.New().String()[:8])
	now := env.srv.now()
	// 用 CST 正午起止避免时区边界歧义（服务端按 Asia/Shanghai 判单日）。
	cst := time.FixedZone("CST", 8*3600)
	start := time.Date(now.In(cst).Year(), now.In(cst).Month(), now.In(cst).Day(), 8, 0, 0, 0, cst)
	end := start.Add(10 * time.Hour)
	obsID := seedAccountObservation(t, f, observationTemporalInterval, map[string]any{
		"net_follow_users": map[string]any{"value": -7, "precision": "exact", "unit": "users"},
	}, now, &start, &end)

	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("单日区间确认应成功：%v", err)
	}
	newF, _, _, netF, _ := accountDailyRow(t, f.Account.ID, "xhs_browser")
	if netF == nil || *netF != -7 {
		t.Fatalf("net_follow_users 应投影 net_follow=-7：got %v", netF)
	}
	if newF != nil {
		t.Fatalf("净增不反推 new_follow：%v", newF)
	}
}

func TestP05AccountObservationMultiDayIntervalNotProjected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p05multi_"+uuid.New().String()[:8])
	now := env.srv.now()
	cst2 := time.FixedZone("CST", 8*3600)
	start := time.Date(now.In(cst2).Year(), now.In(cst2).Month(), now.In(cst2).Day(), 8, 0, 0, 0, cst2)
	end := start.AddDate(0, 0, 6).Add(10 * time.Hour)
	obsID := seedAccountObservation(t, f, observationTemporalInterval, map[string]any{
		"net_follow_users": map[string]any{"value": 30, "precision": "exact", "unit": "users"},
	}, now, &start, &end)

	// 近 7 日净增不拆成 7 条、也不能投影成某一天（docs/20 §8.2）：
	// 确认成功（观测确认本身有效），但不落 account_metric_daily。
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("确认不应报错：%v", err)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM account_metric_daily WHERE account_id=$1`, f.Account.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("跨日区间不得投影：count=%d", count)
	}
}

func TestP05AccountObservationUnknownUnitNotProjected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p05unk_"+uuid.New().String()[:8])
	now := env.srv.now()
	obsID := seedAccountObservation(t, f, observationTemporalCumulative, map[string]any{
		"followers_total": map[string]any{"value": 500, "precision": "exact", "unit": "unknown"},
	}, now, nil, nil)
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err != nil {
		t.Fatalf("确认应成功（只存观测）：%v", err)
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM account_metric_daily WHERE account_id=$1`, f.Account.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("单位 unknown 的粉丝总数不得投影：count=%d", count)
	}
}

func TestP05AccountObservationUnregisteredKeyRejected(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p05bad_"+uuid.New().String()[:8])
	now := env.srv.now()
	obsID := seedAccountObservation(t, f, observationTemporalCumulative, map[string]any{
		"like_count": map[string]any{"value": 3, "precision": "exact", "unit": "count"},
	}, now, nil, nil)
	// 作品键进了账号观测：映射拒绝（validateAccountObservationMapping）。
	if _, err := env.srv.confirmObservation(metricTestCtx(f), obsID); err == nil {
		t.Fatal("未登记键应被拒绝")
	}
}
