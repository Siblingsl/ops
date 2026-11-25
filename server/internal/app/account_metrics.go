package app

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---------- 账号级每日粉丝数据（DEV-DR09 / REF41 I6） ----------

const followerLookbackDays = 7

// I6-A2：同一天同账号同平台按来源优先级合并。wechat_api/desktop_live 高于 manual，
// manual 高于 desktop_backfill/import；历史 wechat_browser/xhs_browser 仍视为平台实时来源。
const followerSourcePrioritySQL = `(CASE source
	WHEN 'wechat_api' THEN 5
	WHEN 'desktop_live' THEN 5
	WHEN 'wechat_browser' THEN 4
	WHEN 'xhs_browser' THEN 4
	WHEN 'manual' THEN 3
	WHEN 'desktop_backfill' THEN 2
	WHEN 'import' THEN 1
	ELSE 0 END)`

// syncFollowers reads the last 7 days of follows, unfollows and totals (two read-only datacube calls).
func (s *Server) syncFollowers(ctx context.Context, a *Account, token string) (int, error) {
	// 示例账号绝不写入 account_metric_daily。
	if a.IsDemo {
		return 0, demoAccountMetricError()
	}
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
		if _, err := s.db.Exec(ctx, `INSERT INTO account_metric_daily
			(account_id, date, source, new_follow, cancel_follow, cumulate, collected_at, evidence)
			VALUES ($1,$2,'wechat_api',$3,$4,$5,now(),'{"provider":"wechat_datacube"}'::jsonb)
			ON CONFLICT (account_id, date, source) DO UPDATE SET
			new_follow=coalesce(EXCLUDED.new_follow, account_metric_daily.new_follow),
			cancel_follow=coalesce(EXCLUDED.cancel_follow, account_metric_daily.cancel_follow),
			cumulate=coalesce(EXCLUDED.cumulate, account_metric_daily.cumulate),
			collected_at=now(), updated_at=now()`,
			a.ID, date, d.newF, d.cancel, d.total); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

type FollowerDay struct {
	Date         string     `json:"date"`
	Source       string     `json:"source"`
	NewFollow    *int       `json:"new_follow"`
	CancelFollow *int       `json:"cancel_follow"`
	Net          *int       `json:"net"`
	Cumulate     *int       `json:"cumulate"`
	CollectedAt  *time.Time `json:"collected_at,omitempty"`
}

// listFollowers returns one row per day. A higher-priority source wins over a manual
// entry for the same day; legacy rows keep their existing browser source.
func (s *Server) listFollowers(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 90 {
		days = 30
	}
	rows, err := s.db.Query(r.Context(), `SELECT date, source, new_follow, cancel_follow, cumulate, collected_at
		FROM (
			SELECT DISTINCT ON (date) date, source, new_follow, cancel_follow, cumulate, collected_at,
				preferred, updated_at
			FROM account_metric_daily
			WHERE account_id=$1 AND date >= $2
			ORDER BY date DESC, `+followerSourcePrioritySQL+` DESC, preferred DESC, updated_at DESC
		) picked
		ORDER BY date DESC`,
		a.ID, s.today().AddDate(0, 0, -days+1))
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []FollowerDay{}
	for rows.Next() {
		var x FollowerDay
		var day time.Time
		if err := rows.Scan(&day, &x.Source, &x.NewFollow, &x.CancelFollow, &x.Cumulate, &x.CollectedAt); err != nil {
			return err
		}
		x.Date = day.Format("2006-01-02")
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
	// 示例账号不记录真实账号统计数据（服务端硬闸门）。
	if a.IsDemo {
		return demoAccountMetricError()
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
	if _, err := s.db.Exec(r.Context(), `INSERT INTO account_metric_daily
		(account_id, date, source, new_follow, cancel_follow, cumulate, collected_at, evidence)
		VALUES ($1,$2,'manual',$3,$4,$5,now(),'{"input":"manual"}'::jsonb)
		ON CONFLICT (account_id, date, source) DO UPDATE SET
		new_follow=EXCLUDED.new_follow, cancel_follow=EXCLUDED.cancel_follow,
		cumulate=EXCLUDED.cumulate, collected_at=now(), updated_at=now()`,
		a.ID, day.Format("2006-01-02"), in.NewFollow, in.CancelFollow, in.Cumulate); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// importFollowers 接收 UTF-8 CSV（列：date,count 或 日期,粉丝数），只写当前仍缺失的日期，
// 已有任意来源的日期一律跳过并回报，不覆盖高优先级数据（I6 目标行为 2/3）。
func (s *Server) importFollowers(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.IsDemo {
		return demoAccountMetricError()
	}
	var in struct {
		CSV string `json:"csv"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.CSV) > 200_000 {
		return validation("CSV 不能超过 200000 字节")
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(in.CSV, "\ufeff")))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return validation("CSV 格式损坏，请检查引号与逗号")
	}
	if len(records) == 0 {
		return validation("CSV 不能为空")
	}
	start := 0
	if len(records[0]) > 0 {
		header := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(records[0][0], "\ufeff")))
		if header == "date" || header == "日期" {
			start = 1
		}
	}
	if len(records)-start == 0 {
		return validation("CSV 至少需要一行日期与粉丝数")
	}
	if len(records)-start > 90 {
		return validation("CSV 最多导入 90 天")
	}
	type importRow struct {
		date  string
		count int
	}
	rows := make([]importRow, 0, len(records)-start)
	seen := make(map[string]bool, len(records)-start)
	for index, record := range records[start:] {
		line := start + index + 1
		if len(record) != 2 {
			return validation("CSV 第 " + strconv.Itoa(line) + " 行必须是 date,count 两列")
		}
		day, err := s.parseFollowerDay(record[0])
		if err != nil {
			return validation("CSV 第 " + strconv.Itoa(line) + " 行日期格式应为 2026-10-01")
		}
		if day.After(s.today()) {
			return validation("不能导入未来日期的粉丝数据")
		}
		count, err := strconv.Atoi(strings.TrimSpace(record[1]))
		if err != nil || count < 0 {
			return validation("CSV 第 " + strconv.Itoa(line) + " 行粉丝数必须是非负整数")
		}
		key := day.Format("2006-01-02")
		if seen[key] {
			return validation("CSV 日期不能重复：" + key)
		}
		seen[key] = true
		rows = append(rows, importRow{date: key, count: count})
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	imported := 0
	skipped := make([]string, 0, len(rows))
	for _, row := range rows {
		var inserted int
		err := tx.QueryRow(r.Context(), `INSERT INTO account_metric_daily
			(account_id, date, source, cumulate, collected_at, evidence)
			SELECT $1,$2::date,'import',$3,now(),'{"input":"csv"}'::jsonb
			WHERE NOT EXISTS (
				SELECT 1 FROM account_metric_daily WHERE account_id=$1 AND date=$2::date
			)
			ON CONFLICT (account_id, date, source) DO NOTHING
			RETURNING 1`, a.ID, row.date, row.count).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			skipped = append(skipped, row.date)
			continue
		}
		if err != nil {
			return err
		}
		imported++
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]any{"imported": imported, "skipped_dates": skipped, "parsed": len(rows)})
}

type followerPlatformSummary struct {
	Platform    string        `json:"platform"`
	AccountID   string        `json:"account_id"`
	AccountName string        `json:"account_name"`
	Latest      *int          `json:"latest"`
	Source      string        `json:"source"`
	CollectedAt *time.Time    `json:"collected_at,omitempty"`
	Series      []FollowerDay `json:"series"`
	Gaps        []string      `json:"gaps"`
}

type followerSummary struct {
	Days             int                       `json:"days"`
	Platforms        []followerPlatformSummary `json:"platforms"`
	Total            *int                      `json:"total"`
	CoveredPlatforms int                       `json:"covered_platforms"`
	TotalPlatforms   int                       `json:"total_platforms"`
	MissingPlatforms []string                  `json:"missing_platforms"`
}

// followerSummary returns a cross-platform snapshot for the caller's workspace. Each
// platform contributes at most one latest total so duplicate accounts do not double count.
func (s *Server) followerSummary(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	_ = a // 确认账号属于当前工作区；汇总本身按工作区取全部活跃账号。
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 || days > 90 {
		days = 30
	}
	rows, err := s.db.Query(r.Context(), `SELECT DISTINCT ON (a.platform)
			a.id, a.name, a.platform, picked.cumulate, picked.source, picked.collected_at
		FROM platform_account a
		LEFT JOIN LATERAL (
			SELECT date, cumulate, source, collected_at, preferred, updated_at
			FROM account_metric_daily
			WHERE account_id=a.id AND cumulate IS NOT NULL
			ORDER BY date DESC, `+followerSourcePrioritySQL+` DESC, preferred DESC, updated_at DESC
			LIMIT 1
		) picked ON true
		WHERE a.workspace_id=$1 AND a.status='active'
		ORDER BY a.platform, picked.date DESC NULLS LAST, a.created_at`,
		ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	type pickedPlatform struct {
		id, name, platform, source string
		latest                     *int
		collected                  *time.Time
	}
	var picks []pickedPlatform
	for rows.Next() {
		var p pickedPlatform
		var id uuid.UUID
		var source *string
		var collected *time.Time
		if err := rows.Scan(&id, &p.name, &p.platform, &p.latest, &source, &collected); err != nil {
			rows.Close()
			return err
		}
		p.id = id.String()
		if source != nil {
			p.source = *source
		}
		p.collected = collected
		picks = append(picks, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	from := s.today().AddDate(0, 0, -days+1)
	result := followerSummary{Days: days, Platforms: []followerPlatformSummary{}, MissingPlatforms: []string{}}
	var total int
	covered := 0
	for _, p := range picks {
		series, err := s.followerSeries(r.Context(), uuid.MustParse(p.id), from, s.today())
		if err != nil {
			return err
		}
		gaps, err := s.followerMissingDates(r.Context(), uuid.MustParse(p.id), from, s.today())
		if err != nil {
			return err
		}
		row := followerPlatformSummary{
			Platform: p.platform, AccountID: p.id, AccountName: p.name, Latest: p.latest,
			Source: p.source, CollectedAt: p.collected, Series: series, Gaps: gaps,
		}
		if p.latest != nil {
			covered++
			total += *p.latest
		} else {
			result.MissingPlatforms = append(result.MissingPlatforms, p.platform)
		}
		result.Platforms = append(result.Platforms, row)
	}
	result.TotalPlatforms = len(picks)
	result.CoveredPlatforms = covered
	if covered > 0 {
		result.Total = &total
	}
	return ok(w, result)
}

// followerCoverage lists dates in [from,to] with no row at all for one account.
func (s *Server) followerCoverage(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	from, err := s.parseFollowerDay(r.URL.Query().Get("from"))
	if err != nil {
		return err
	}
	to, err := s.parseFollowerDay(r.URL.Query().Get("to"))
	if err != nil {
		return err
	}
	from, to, err = s.followerRange(from, to)
	if err != nil {
		return err
	}
	missing, err := s.followerMissingDates(r.Context(), a.ID, from, to)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "missing": missing,
	})
}

// backfillFollowers writes one or more missing dates in one request. It never overwrites
// any existing source; a conflict returns 409 before any row is written.
func (s *Server) backfillFollowers(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.IsDemo {
		return demoAccountMetricError()
	}
	var in struct {
		Platform string `json:"platform"`
		From     string `json:"from"`
		To       string `json:"to"`
		Values   []struct {
			Date  string `json:"date"`
			Count *int   `json:"count"`
		} `json:"values"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Platform) == "" || strings.TrimSpace(in.Platform) != a.Platform {
		return validation("platform 必须与账号平台一致")
	}
	if len(in.Values) == 0 || len(in.Values) > 90 {
		return validation("回填日期须为 1 至 90 条")
	}
	if strings.TrimSpace(in.From) == "" || strings.TrimSpace(in.To) == "" {
		return validation("from/to 必填")
	}
	from, err := s.parseFollowerDay(in.From)
	if err != nil {
		return err
	}
	to, err := s.parseFollowerDay(in.To)
	if err != nil {
		return err
	}
	from, to, err = s.followerRange(from, to)
	if err != nil {
		return err
	}
	if from.IsZero() || to.IsZero() {
		return validation("from/to 必填")
	}
	if to.Sub(from) > 89*24*time.Hour {
		return validation("回填区间不能超过 90 天")
	}
	seen := make(map[string]bool, len(in.Values))
	type item struct {
		date  time.Time
		count int
	}
	items := make([]item, 0, len(in.Values))
	for _, v := range in.Values {
		day, err := s.parseFollowerDay(v.Date)
		if err != nil {
			return validation("回填日期格式应为 2026-10-01")
		}
		if day.Before(from) || day.After(to) {
			return validation("回填日期必须落在 from/to 区间内")
		}
		if day.After(s.today()) {
			return validation("不能回填未来日期的粉丝数据")
		}
		if seen[day.Format("2006-01-02")] {
			return validation("回填日期不能重复")
		}
		seen[day.Format("2006-01-02")] = true
		if v.Count == nil || *v.Count < 0 {
			return validation("每条回填必须提供非负的 count")
		}
		items = append(items, item{date: day, count: *v.Count})
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var conflicts []string
	for _, it := range items {
		var exists bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(
			SELECT 1 FROM account_metric_daily WHERE account_id=$1 AND date=$2)`, a.ID, it.date).Scan(&exists); err != nil {
			return err
		}
		if exists {
			conflicts = append(conflicts, it.date.Format("2006-01-02"))
		}
	}
	if len(conflicts) > 0 {
		return apiErr(http.StatusConflict, "follower_backfill_conflict", "以下日期已有粉丝数据，未写入任何回填").With(map[string]any{"conflicts": conflicts})
	}
	evidence, _ := json.Marshal(map[string]string{
		"platform": in.Platform,
		"from":     from.Format("2006-01-02"),
		"to":       to.Format("2006-01-02"),
	})
	for _, it := range items {
		res, err := tx.Exec(r.Context(), `INSERT INTO account_metric_daily
			(account_id, date, source, cumulate, collected_at, evidence)
			VALUES ($1,$2,'desktop_backfill',$3,now(),$4) ON CONFLICT (account_id, date, source) DO NOTHING`,
			a.ID, it.date, it.count, evidence)
		if err != nil {
			return err
		}
		if res.RowsAffected() == 0 {
			return apiErr(http.StatusConflict, "follower_backfill_conflict", "回填日期已有同级或更高优先级数据").With(map[string]any{"conflicts": []string{it.date.Format("2006-01-02")}})
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]any{"inserted": len(items)})
}

func (s *Server) parseFollowerDay(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	day, err := time.ParseInLocation("2006-01-02", raw, s.loc)
	if err != nil {
		return time.Time{}, validation("日期格式应为 2026-10-01")
	}
	return day, nil
}

func (s *Server) followerRange(from, to time.Time) (time.Time, time.Time, error) {
	if from.IsZero() {
		from = s.today().AddDate(0, 0, -29)
	}
	if to.IsZero() {
		to = s.today()
	}
	if from.After(to) {
		return time.Time{}, time.Time{}, validation("from 不能晚于 to")
	}
	if to.After(s.today()) {
		return time.Time{}, time.Time{}, validation("不能查询未来日期")
	}
	if to.Sub(from) > 89*24*time.Hour {
		return time.Time{}, time.Time{}, validation("区间不能超过 90 天")
	}
	return from, to, nil
}

func (s *Server) followerSeries(ctx context.Context, accountID uuid.UUID, from, to time.Time) ([]FollowerDay, error) {
	rows, err := s.db.Query(ctx, `SELECT date, source, new_follow, cancel_follow, cumulate, collected_at
		FROM (
			SELECT DISTINCT ON (date) date, source, new_follow, cancel_follow, cumulate, collected_at,
				preferred, updated_at
			FROM account_metric_daily
			WHERE account_id=$1 AND date >= $2 AND date <= $3
			ORDER BY date DESC, `+followerSourcePrioritySQL+` DESC, preferred DESC, updated_at DESC
		) picked
		ORDER BY date ASC`, accountID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byDate := map[string]FollowerDay{}
	for rows.Next() {
		var x FollowerDay
		var day time.Time
		if err := rows.Scan(&day, &x.Source, &x.NewFollow, &x.CancelFollow, &x.Cumulate, &x.CollectedAt); err != nil {
			return nil, err
		}
		x.Date = day.Format("2006-01-02")
		if x.NewFollow != nil && x.CancelFollow != nil {
			v := *x.NewFollow - *x.CancelFollow
			x.Net = &v
		}
		byDate[x.Date] = x
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	list := make([]FollowerDay, 0, int(to.Sub(from).Hours()/24)+1)
	for day := from; !day.After(to); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		if x, ok := byDate[date]; ok {
			list = append(list, x)
		} else {
			list = append(list, FollowerDay{Date: date})
		}
	}
	return list, nil
}

func (s *Server) followerMissingDates(ctx context.Context, accountID uuid.UUID, from, to time.Time) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT DISTINCT to_char(date,'YYYY-MM-DD')
		FROM account_metric_daily WHERE account_id=$1 AND date >= $2 AND date <= $3`, accountID, from, to)
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for rows.Next() {
		var date string
		if err := rows.Scan(&date); err != nil {
			rows.Close()
			return nil, err
		}
		existing[date] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	var missing []string
	for day := from; !day.After(to); day = day.AddDate(0, 0, 1) {
		if !existing[day.Format("2006-01-02")] {
			missing = append(missing, day.Format("2006-01-02"))
		}
	}
	if missing == nil {
		missing = []string{}
	}
	return missing, nil
}
