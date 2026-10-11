package app

import (
	"context"
	"testing"
)

type followerList struct {
	Days []FollowerDay `json:"days"`
	API  bool          `json:"api"`
}

// DEV-DR09（14 文档 4.2 第 5 条）：公众号按天只读同步新增/取消关注与粉丝总数，写入 account_metric_daily；
// 没有接口的账号可逐日手动补录；同一天接口数据优先。
func TestDR09Followers(t *testing.T) {
	ctx := context.Background()
	a := drWechatAccount(t, "粉丝数据验收号")
	base := "/api/v1/accounts/" + a.ID.String()
	env.mustJSON(t, "POST", base+"/wechat-credential/test", nil, nil)

	yesterday := env.srv.today().AddDate(0, 0, -1)
	manualDay := yesterday.Format("2006-01-02")
	env.mustJSON(t, "POST", base+"/followers", map[string]any{"date": manualDay, "new_follow": 1, "cancel_follow": 0, "cumulate": 1}, nil)

	var res struct {
		Result  datacubeResult `json:"result"`
		Message string         `json:"message"`
	}
	env.mustJSON(t, "POST", base+"/metrics/sync-wechat", nil, &res)
	if res.Result.FollowerDays != 7 {
		t.Fatalf("expected 7 follower days, got %+v (%s)", res.Result, res.Message)
	}
	var stored int
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_metric_daily WHERE account_id=$1 AND source='wechat_api'`, a.ID).Scan(&stored)
	if stored != 7 {
		t.Fatalf("wechat_api rows: %d", stored)
	}

	var list followerList
	env.mustJSON(t, "GET", base+"/followers?days=10", nil, &list)
	if !list.API || len(list.Days) != 7 {
		t.Fatalf("list: api=%v days=%d", list.API, len(list.Days))
	}
	top := list.Days[0]
	if top.Date != manualDay || top.Source != "wechat_api" {
		t.Fatalf("interface data wins over manual for the same day: %+v", top)
	}
	wantNew := 10 + yesterday.Day() + 5
	if top.NewFollow == nil || *top.NewFollow != wantNew || top.CancelFollow == nil || *top.CancelFollow != 3 {
		t.Fatalf("summary sources are summed per day: %+v", top)
	}
	if top.Net == nil || *top.Net != wantNew-3 {
		t.Fatalf("net follow: %+v", top.Net)
	}
	if top.Cumulate == nil || *top.Cumulate != 5000+10*yesterday.YearDay() {
		t.Fatalf("cumulate: %+v", top.Cumulate)
	}

	env.mustJSON(t, "POST", base+"/metrics/sync-wechat", nil, &res)
	_ = env.srv.db.QueryRow(ctx, `SELECT count(*) FROM account_metric_daily WHERE account_id=$1 AND source='wechat_api'`, a.ID).Scan(&stored)
	if stored != 7 {
		t.Fatalf("re-sync must upsert, not duplicate: %d", stored)
	}

	future := env.srv.today().AddDate(0, 0, 1).Format("2006-01-02")
	env.expectErr(t, "POST", base+"/followers", map[string]any{"date": future, "new_follow": 1}, "validation_failed")
	env.expectErr(t, "POST", base+"/followers", map[string]any{"date": manualDay}, "validation_failed")
	env.expectErr(t, "POST", base+"/followers", map[string]any{"date": manualDay, "cancel_follow": -1}, "validation_failed")
	env.expectErr(t, "POST", base+"/followers", map[string]any{"date": "10/01", "cumulate": 1}, "validation_failed")
	env.expectErr(t, "POST", base+"/followers", []any{map[string]any{"date": manualDay, "cumulate": 1}}, "validation_failed")

	x := drAccount(t, "xhs", "粉丝补录小红书号")
	xb := "/api/v1/accounts/" + x.ID.String()
	day := env.srv.today().AddDate(0, 0, -2).Format("2006-01-02")
	env.mustJSON(t, "POST", xb+"/followers", map[string]any{"date": day, "new_follow": 12, "cancel_follow": 2, "cumulate": 340}, nil)
	env.mustJSON(t, "POST", xb+"/followers", map[string]any{"date": day, "new_follow": 15, "cancel_follow": 2, "cumulate": 343}, nil)
	var xl followerList
	env.mustJSON(t, "GET", xb+"/followers", nil, &xl)
	if xl.API || len(xl.Days) != 1 {
		t.Fatalf("xhs list: %+v", xl)
	}
	if d := xl.Days[0]; d.Source != "manual" || *d.NewFollow != 15 || *d.Net != 13 || *d.Cumulate != 343 {
		t.Fatalf("manual entry overwrites the same day: %+v", d)
	}
}

// Follower permission problems must not fail the article sync.
func TestDR09FollowerFailureIsNonFatal(t *testing.T) {
	a := drWechatAccount(t, "粉丝失败不阻断号")
	base := "/api/v1/accounts/" + a.ID.String()
	env.mustJSON(t, "POST", base+"/wechat-credential/test", nil, nil)
	env.mockWX.SetUserDatacubeError(48001)
	defer env.mockWX.SetUserDatacubeError(0)
	var res struct {
		Result  datacubeResult `json:"result"`
		Message string         `json:"message"`
	}
	env.mustJSON(t, "POST", base+"/metrics/sync-wechat", nil, &res)
	if res.Result.FollowerDays != 0 || res.Result.FollowerError == "" {
		t.Fatalf("follower failure should be reported, not fatal: %+v", res.Result)
	}
	var acc Account
	env.mustJSON(t, "GET", base, nil, &acc)
	if acc.DatacubeState != "ok" {
		t.Fatalf("article datacube state must stay ok: %q", acc.DatacubeState)
	}
}
