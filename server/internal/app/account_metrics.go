package app

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ---------- 账号级每日粉丝数据（DEV-DR09，14 文档 4.2 第 5 条） ----------

const followerLookbackDays = 7

// syncFollowers reads the last 7 days of follows, unfollows and totals (two read-only datacube calls).
func (s *Server) syncFollowers(ctx context.Context, a *Account, token string) (int, error) {
	end := s.today().AddDate(0, 0, -1)
	begin := end.AddDate(0, 0, -(followerLookbackDays - 1))
	b, e := begin.Format("2006-01-02"), end.Format("2006-01-02")
	sum, err := s.wx.DatacubeUserSummary(ctx, token, b, e)
	if err != nil {
		return 0, err
	}
	cum, err := s.wx.DatacubeUserCumulate(ctx, token, b, e)
	if err != nil {
		return 0, err
	}
	type day struct{ newF, cancel, total *int }
	days := map[string]*day{}
	get := func(d string) *day {
		if days[d] == nil {
			days[d] = &day{}
		}
		return days[d]
	}
	add := func(p **int, v int) {
		if *p == nil {
			*p = new(int)
		}
		**p += v
	}
	for _, x := range sum {
		d := get(x.RefDate)
		add(&d.newF, x.NewUser)
		add(&d.cancel, x.CancelUser)
	}
	for _, x := range cum {
		v := x.CumulateUser
		get(x.RefDate).total = &v
	}
	n := 0
	for date, d := range days {
		if _, err := time.Parse("2006-01-02", date); err != nil {
			continue
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO account_metric_daily (account_id, date, source, new_follow, cancel_follow, cumulate)
			VALUES ($1,$2,'wechat_api',$3,$4,$5) ON CONFLICT (account_id, date, source) DO UPDATE SET
			new_follow=coalesce(EXCLUDED.new_follow, account_metric_daily.new_follow), cancel_follow=coalesce(EXCLUDED.cancel_follow, account_metric_daily.cancel_follow),
			cumulate=coalesce(EXCLUDED.cumulate, account_metric_daily.cumulate), updated_at=now()`,
			a.ID, date, d.newF, d.cancel, d.total); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

type FollowerDay struct {
	Date         string `json:"date"`
	Source       string `json:"source"`
	NewFollow    *int   `json:"new_follow"`
	CancelFollow *int   `json:"cancel_follow"`
	Net          *int   `json:"net"`
	Cumulate     *int   `json:"cumulate"`
}

// listFollowers returns one row per day (interface data wins over a manual entry for the same day).
func (s *Server) listFollowers(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 90 {
		days = 30
	}
	rows, err := s.db.Query(r.Context(), `SELECT DISTINCT ON (date) to_char(date,'YYYY-MM-DD'), source, new_follow, cancel_follow, cumulate
		FROM account_metric_daily WHERE account_id=$1 AND date >= $2 ORDER BY date DESC, (source='wechat_api') DESC`,
		a.ID, s.today().AddDate(0, 0, -days))
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []FollowerDay{}
	for rows.Next() {
		var x FollowerDay
		if err := rows.Scan(&x.Date, &x.Source, &x.NewFollow, &x.CancelFollow, &x.Cumulate); err != nil {
			return err
		}
		if x.NewFollow != nil && x.CancelFollow != nil {
			v := *x.NewFollow - *x.CancelFollow
			x.Net = &v
		}
		list = append(list, x)
	}
	return ok(w, map[string]any{"days": list, "api": a.Platform == "wechat_mp" && a.DatacubeState == "ok"})
}

// recordFollowers stores one manually entered day (single object; for accounts without the interface).
func (s *Server) recordFollowers(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Date         string `json:"date"`
		NewFollow    *int   `json:"new_follow"`
		CancelFollow *int   `json:"cancel_follow"`
		Cumulate     *int   `json:"cumulate"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	day, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(in.Date), s.loc)
	if err != nil {
		return validation("日期格式应为 2026-10-01")
	}
	if day.After(s.today()) {
		return validation("不能录入未来日期的粉丝数据")
	}
	if in.NewFollow == nil && in.CancelFollow == nil && in.Cumulate == nil {
		return validation("至少填写一项：新增关注、取消关注或粉丝总数")
	}
	for _, v := range []*int{in.NewFollow, in.CancelFollow, in.Cumulate} {
		if v != nil && *v < 0 {
			return validation("数据不能为负数")
		}
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO account_metric_daily (account_id, date, source, new_follow, cancel_follow, cumulate)
		VALUES ($1,$2,'manual',$3,$4,$5) ON CONFLICT (account_id, date, source) DO UPDATE SET
		new_follow=EXCLUDED.new_follow, cancel_follow=EXCLUDED.cancel_follow, cumulate=EXCLUDED.cumulate, updated_at=now()`,
		a.ID, day.Format("2006-01-02"), in.NewFollow, in.CancelFollow, in.Cumulate); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}
