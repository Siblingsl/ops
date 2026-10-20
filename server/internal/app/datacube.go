package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/wechat"
)

// ---------- 公众号数据接口同步（FR-M11-05；DEV-DR03，14 文档 4.2） ----------
// 只读 datacube/getarticletotal；不调用发表、群发或"已发表列表"接口（HC-06）。

const datacubeLookbackDays = 7

var digitsOnly = regexp.MustCompile(`^[0-9]+$`)

// parseWechatMsgID extracts "mid_idx" from a long article link; short links (/s/xxxx) have none.
func parseWechatMsgID(link string) string {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || !strings.HasSuffix(u.Hostname(), "mp.weixin.qq.com") {
		return ""
	}
	q := u.Query()
	mid, idx := q.Get("mid"), q.Get("idx")
	if !digitsOnly.MatchString(mid) || !digitsOnly.MatchString(idx) {
		return ""
	}
	return mid + "_" + idx
}

// normTitle drops spaces and punctuation so "标题！" and "标题 !" compare equal; nothing else is fuzzy.
func normTitle(t string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(t) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func datacubeDenied(err error) bool {
	var we *wechat.Error
	return errors.As(err, &we) && (we.Code == 48001 || we.Code == 50002)
}

func (s *Server) setDatacubeState(ctx context.Context, accountID uuid.UUID, state string) {
	_, _ = s.db.Exec(ctx, `UPDATE platform_account SET datacube_state=$2, datacube_checked_at=now() WHERE id=$1`, accountID, state)
}

// probeDatacube tries one read-only datacube call after a credential test and records the result.
func (s *Server) probeDatacube(ctx context.Context, accountID uuid.UUID, token string) string {
	_, err := s.wx.DatacubeArticleTotal(ctx, token, s.today().AddDate(0, 0, -1).Format("2006-01-02"))
	state := "ok"
	switch {
	case err == nil:
	case datacubeDenied(err):
		state = "no_permission"
	default:
		state = "unknown"
	}
	s.setDatacubeState(ctx, accountID, state)
	return state
}

type datacubeResult struct {
	Days      int `json:"days"`
	Articles  int `json:"articles"`
	Matched   int `json:"matched"`
	Written   int `json:"written"`
	Unmatched int `json:"unmatched"`
	Ignored   int `json:"ignored"`
	// FollowerDays is how many days of account follower data were stored; FollowerError explains a skip.
	FollowerDays  int    `json:"follower_days"`
	FollowerError string `json:"follower_error,omitempty"`
}

// syncDatacube looks back 7 days, one request per send date, and writes cumulative snapshots.
func (s *Server) syncDatacube(ctx context.Context, a *Account) (*datacubeResult, error) {
	token, err := s.accessToken(ctx, a.ID, false)
	if err != nil {
		return nil, err
	}
	res := &datacubeResult{}
	today := s.today()
	for i := 1; i <= datacubeLookbackDays; i++ {
		day := today.AddDate(0, 0, -i).Format("2006-01-02")
		list, err := s.wx.DatacubeArticleTotal(ctx, token, day)
		if err != nil {
			if datacubeDenied(err) {
				s.setDatacubeState(ctx, a.ID, "no_permission")
			}
			return res, err
		}
		res.Days++
		for _, art := range list {
			res.Articles++
			if err := s.applyArticleTotal(ctx, a, art, res); err != nil {
				return res, err
			}
		}
	}
	s.setDatacubeState(ctx, a.ID, "ok")
	if n, err := s.syncFollowers(ctx, a, token); err != nil {
		res.FollowerError = errText(datacubeErr(err))
	} else {
		res.FollowerDays = n
	}
	return res, nil
}

func (s *Server) applyArticleTotal(ctx context.Context, a *Account, art wechat.ArticleTotal, res *datacubeResult) error {
	msgid := strings.TrimSpace(art.MsgID)
	if msgid == "" {
		return nil
	}
	refDate, err := time.ParseInLocation("2006-01-02", art.RefDate, s.loc)
	if err != nil {
		return nil
	}
	var status string
	var assigned *uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT status, work_id FROM metric_unmatched WHERE account_id=$1 AND external_id=$2`, a.ID, msgid).Scan(&status, &assigned)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if status == "ignored" {
		res.Ignored++
		return nil
	}
	workID := assigned
	reason := "none"
	if workID == nil {
		workID, reason, err = s.matchArticle(ctx, a.ID, msgid, art.Title, refDate)
		if err != nil {
			return err
		}
	}
	if workID == nil {
		details, _ := json.Marshal(art.Details)
		if _, err := s.db.Exec(ctx, `INSERT INTO metric_unmatched (account_id, external_id, title, ref_date, details, reason)
			VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id, external_id) DO UPDATE SET
			title=EXCLUDED.title, details=EXCLUDED.details, reason=EXCLUDED.reason, updated_at=now() WHERE metric_unmatched.status='pending'`,
			a.ID, msgid, art.Title, refDate, details, reason); err != nil {
			return err
		}
		res.Unmatched++
		return nil
	}
	res.Matched++
	n, err := s.writeArticleDetails(ctx, *workID, msgid, refDate, art.Details)
	res.Written += n
	return err
}

// matchArticle: exact msgid first. Title matching no longer binds automatically (D-129 / 20 文档 §7.2):
// a normalized-title hit only proves similarity, not ownership, so it is reported as legacy_title and
// left for one-by-one human confirmation; writing wechat_msgid here would make every later browser
// sync treat a guess as a verified binding.
func (s *Server) matchArticle(ctx context.Context, accountID uuid.UUID, msgid, title string, refDate time.Time) (*uuid.UUID, string, error) {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND wechat_msgid=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`, accountID, msgid).Scan(&id)
	if err == nil {
		return &id, "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, "", err
	}
	rows, err := s.db.Query(ctx, `SELECT id, title FROM work WHERE account_id=$1 AND deleted_at IS NULL AND wechat_msgid IS NULL
		AND published_at IS NOT NULL AND abs((published_at AT TIME ZONE 'Asia/Shanghai')::date - $2::date) <= 1`, accountID, refDate.Format("2006-01-02"))
	if err != nil {
		return nil, "", err
	}
	want := normTitle(title)
	hits := 0
	for rows.Next() {
		var wid uuid.UUID
		var wt string
		if rows.Scan(&wid, &wt) == nil && want != "" && normTitle(wt) == want {
			hits++
		}
	}
	rows.Close()
	if hits == 0 {
		return nil, "none", nil
	}
	if hits == 1 {
		return nil, "legacy_title", nil
	}
	return nil, "ambiguous", nil
}

// writeArticleDetails stores each cumulative day as one wechat_api node (day = stat_date - ref_date).
func (s *Server) writeArticleDetails(ctx context.Context, workID uuid.UUID, msgid string, refDate time.Time, details []wechat.ArticleTotalDetail) (int, error) {
	n := 0
	for _, d := range details {
		stat, err := time.ParseInLocation("2006-01-02", d.StatDate, s.loc)
		if err != nil {
			continue
		}
		day := int(stat.Sub(refDate).Hours()/24 + 0.5)
		if day < 0 {
			continue
		}
		reads, favs, shares := d.IntPageReadUser, d.AddToFavUser, d.ShareUser
		ext := msgid
		err = s.withTx(ctx, func(tx pgx.Tx) error {
			_, _, err := s.upsertMetricWithAudit(ctx, tx, metricWrite{WorkID: workID, CapturedAt: stat.Add(23*time.Hour + 59*time.Minute),
				Source: "wechat_api", DayOffset: &day, ExternalID: &ext, Reads: &reads, Favorites: &favs, Shares: &shares})
			return err
		})
		if err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func datacubeErr(err error) error {
	var we *wechat.Error
	if errors.As(err, &we) {
		if datacubeDenied(err) {
			return apiErr(403, "wechat_capability", "当前公众号无权使用数据统计接口（通常需要微信认证）。请改用截图识别或手动录入。")
		}
		return apiErr(502, "wechat_upstream", we.Readable())
	}
	return err
}

func (s *Server) syncWechatMetrics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.Platform != "wechat_mp" {
		return validation("仅公众号账号支持数据接口同步")
	}
	ctx := r.Context()
	res, err := s.syncDatacube(ctx, a)
	if err != nil {
		return datacubeErr(err)
	}
	s.audit(ctx, "metrics_sync", "account", a.ID.String(), "ok", map[string]any{
		"days": res.Days, "articles": res.Articles, "matched": res.Matched, "unmatched": res.Unmatched,
	})
	msg := fmt.Sprintf("已同步最近 %d 天群发的 %d 篇文章，对上作品 %d 篇", res.Days, res.Articles, res.Matched)
	if res.Unmatched > 0 {
		msg += fmt.Sprintf("；%d 篇没对上，请在\"待匹配\"里逐条指定", res.Unmatched)
	}
	if res.FollowerDays > 0 {
		msg += fmt.Sprintf("；账号粉丝数据 %d 天", res.FollowerDays)
	} else if res.FollowerError != "" {
		msg += "；粉丝数据没有同步：" + res.FollowerError
	}
	return ok(w, map[string]any{"result": res, "message": msg})
}

const (
	wechatDailyHour     = 10
	wechatDailyMaxFails = 3
)

// wechatMetricsDaily runs one read-only datacube sync per permitted WeChat account per day after 10:00
// (DEV-DR06，14 文档 4.2 第 4 条). No permission, or 3 failed days in a row, turns it off with a notice.
func (s *Server) wechatMetricsDaily(ctx context.Context) {
	if s.now().In(s.loc).Hour() < wechatDailyHour {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, a.workspace_id FROM platform_account a JOIN wechat_credential c ON c.account_id=a.id
		WHERE a.platform='wechat_mp' AND a.status='active' AND NOT a.is_demo AND a.datacube_state='ok' AND a.metrics_wechat_auto AND c.last_check_ok`)
	if err != nil {
		return
	}
	type acc struct{ id, ws uuid.UUID }
	var list []acc
	for rows.Next() {
		var x acc
		if rows.Scan(&x.id, &x.ws) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	day := s.today().Format("2006-01-02")
	for _, x := range list {
		if !s.markOnce(ctx, "wechat-metrics:"+x.id.String()+":"+day) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
		a, err := s.account(jctx, x.id)
		if err != nil {
			continue
		}
		s.wechatMetricsOnce(jctx, a)
	}
}

func (s *Server) wechatMetricsOnce(ctx context.Context, a *Account) {
	ws := ident(ctx).WorkspaceID
	link := "/a/" + a.ID.String() + "/review"
	res, err := s.syncDatacube(ctx, a)
	if err == nil {
		_, _ = s.db.Exec(ctx, `UPDATE platform_account SET metrics_wechat_fails=0, metrics_wechat_last_at=$2 WHERE id=$1`, a.ID, s.now())
		s.audit(ctx, "metrics_sync_daily", "account", a.ID.String(), "ok", map[string]any{"articles": res.Articles, "matched": res.Matched, "unmatched": res.Unmatched})
		if res.Unmatched > 0 {
			s.notifyWorkspace(ctx, ws, []string{"owner", "editor"}, "metric", fmt.Sprintf("公众号数据已同步，%d 篇文章没对上作品", res.Unmatched), a.Name,
				link, "wechat-unmatched:"+a.ID.String()+":"+s.today().Format("2006-01-02"))
		}
		return
	}
	var fails int
	if qerr := s.db.QueryRow(ctx, `UPDATE platform_account SET metrics_wechat_fails=metrics_wechat_fails+1 WHERE id=$1 RETURNING metrics_wechat_fails`, a.ID).Scan(&fails); qerr != nil {
		return
	}
	s.audit(ctx, "metrics_sync_daily", "account", a.ID.String(), "failed", map[string]any{"error": truncate(err.Error(), 200), "fails": fails})
	var note string
	switch {
	case datacubeDenied(err):
		note = "公众号没有数据统计接口权限，已关闭每日同步"
	case fails >= wechatDailyMaxFails:
		note = fmt.Sprintf("连续 %d 天同步失败（%s），已关闭每日同步", fails, truncate(errText(datacubeErr(err)), 60))
	default:
		return
	}
	_, _ = s.db.Exec(ctx, `UPDATE platform_account SET metrics_wechat_auto=false, metrics_wechat_note=$2 WHERE id=$1`, a.ID, note)
	s.notifyWorkspace(ctx, ws, []string{"owner", "editor"}, "metric", "公众号数据每日同步已关闭", a.Name+"："+note+"。可在账号设置里重新打开，期间请用截图识别或手动录入。",
		link, "wechat-auto-off:"+a.ID.String()+":"+s.today().Format("2006-01-02"))
}

type unmatchedRow struct {
	ID         uuid.UUID `json:"id"`
	ExternalID string    `json:"external_id"`
	Title      string    `json:"title"`
	RefDate    string    `json:"ref_date"`
	Reason     string    `json:"reason"`
	Days       int       `json:"days"`
	Reads      *int      `json:"reads"`
}

func (s *Server) listUnmatchedMetrics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, external_id, title, to_char(ref_date,'YYYY-MM-DD'), reason, jsonb_array_length(details),
		(details->-1->>'int_page_read_user')::int FROM metric_unmatched WHERE account_id=$1 AND status='pending' ORDER BY ref_date DESC, title LIMIT 100`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []unmatchedRow{}
	for rows.Next() {
		var x unmatchedRow
		if err := rows.Scan(&x.ID, &x.ExternalID, &x.Title, &x.RefDate, &x.Reason, &x.Days, &x.Reads); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

// unmatchedOwned loads one pending row in the caller's workspace.
func (s *Server) unmatchedOwned(r *http.Request) (uuid.UUID, *Account, string, time.Time, []byte, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return uuid.Nil, nil, "", time.Time{}, nil, err
	}
	var accountID uuid.UUID
	var ext, status string
	var ref time.Time
	var details []byte
	if err := s.db.QueryRow(r.Context(), `SELECT account_id, external_id, status, ref_date, details FROM metric_unmatched WHERE id=$1`, id).
		Scan(&accountID, &ext, &status, &ref, &details); err != nil {
		return uuid.Nil, nil, "", time.Time{}, nil, err
	}
	a, err := s.account(r.Context(), accountID)
	if err != nil {
		return uuid.Nil, nil, "", time.Time{}, nil, err
	}
	if status != "pending" {
		return uuid.Nil, nil, "", time.Time{}, nil, stateInvalid("这条数据已经处理过了")
	}
	refDate := time.Date(ref.Year(), ref.Month(), ref.Day(), 0, 0, 0, 0, s.loc)
	return id, a, ext, refDate, details, nil
}

// assignUnmatchedMetric binds one pending article to one work chosen by a person (one row per call).
func (s *Server) assignUnmatchedMetric(w http.ResponseWriter, r *http.Request) error {
	id, a, ext, refDate, raw, err := s.unmatchedOwned(r)
	if err != nil {
		return err
	}
	var in struct {
		WorkID uuid.UUID `json:"work_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var okID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, in.WorkID, a.ID).Scan(&okID); err != nil {
		return validation("作品不存在或不属于当前账号")
	}
	var other uuid.UUID
	if s.db.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND wechat_msgid=$2 AND id<>$3 AND deleted_at IS NULL LIMIT 1`, a.ID, ext, okID).Scan(&other) == nil {
		return stateInvalid("这篇文章已经对应到另一篇作品")
	}
	var details []wechat.ArticleTotalDetail
	_ = json.Unmarshal(raw, &details)
	n, err := s.writeArticleDetails(ctx, okID, ext, refDate, details)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE work SET wechat_msgid=$2 WHERE id=$1 AND wechat_msgid IS NULL`, okID, ext); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE metric_unmatched SET status='assigned', work_id=$2, updated_at=now() WHERE id=$1`, id, okID); err != nil {
		return err
	}
	s.audit(ctx, "metrics_assign", "work", okID.String(), "ok", map[string]any{"external_id": ext, "written": n})
	return ok(w, map[string]any{"written": n})
}

// ignoreUnmatchedMetric drops one pending article (e.g. not made in this tool); later syncs skip it.
func (s *Server) ignoreUnmatchedMetric(w http.ResponseWriter, r *http.Request) error {
	id, _, _, _, _, err := s.unmatchedOwned(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE metric_unmatched SET status='ignored', updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}
