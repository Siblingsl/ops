package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---------- 数据截图识别（DEV-DR05，14 文档 4.4） ----------

const (
	maxMetricShots   = 9
	metricUploadDays = 7
)

var metricShotKeys = []string{"impressions", "reads", "likes", "wows", "favorites", "comments", "shares", "follows_gained"}

var metricShotLabels = map[string]string{
	"reads": "阅读/观看", "likes": "点赞", "wows": "在看", "favorites": "收藏",
	"comments": "评论/留言", "shares": "分享", "follows_gained": "涨粉/新增关注",
	"impressions": "展现量",
}

type metricShotRow struct {
	Index               int        `json:"index"`
	Title               string     `json:"title"`
	ContentFormat       string     `json:"content_format,omitempty"`
	PublishedHint       string     `json:"published_hint"`
	DayHint             string     `json:"day_hint"`
	IntervalHint        bool       `json:"interval_hint"`
	AccountFollowerHint bool       `json:"account_follower_hint"`
	WorkID              *uuid.UUID `json:"work_id"`
	MatchType           string     `json:"match_type"` // exact | fuzzy | hint | none
	Similarity          float64    `json:"similarity"`
	Reads               *int       `json:"reads"`
	Impressions         *int64     `json:"impressions"`
	ImpressionsExact    *string    `json:"impressions_exact,omitempty"`
	Likes               *int       `json:"likes"`
	Wows                *int       `json:"wows"`
	Favorites           *int       `json:"favorites"`
	Comments            *int       `json:"comments"`
	Shares              *int       `json:"shares"`
	FollowsGained       *int       `json:"follows_gained"`
	Estimated           bool       `json:"estimated"`
	RawText             string     `json:"raw_text"`
	Dropped             []string   `json:"dropped"`
	Status              string     `json:"status"` // pending | confirmed
	MetricID            *uuid.UUID `json:"metric_id,omitempty"`
}

func (r *metricShotRow) field(key string) **int {
	switch key {
	case "reads":
		return &r.Reads
	case "likes":
		return &r.Likes
	case "wows":
		return &r.Wows
	case "favorites":
		return &r.Favorites
	case "comments":
		return &r.Comments
	case "shares":
		return &r.Shares
	case "follows_gained":
		return &r.FollowsGained
	}
	return nil
}

func (r *metricShotRow) field64(key string) **int64 {
	if key == "impressions" {
		return &r.Impressions
	}
	return nil
}

type metricShotOut struct {
	Rows []struct {
		Title         string                     `json:"title"`
		WorkID        string                     `json:"work_id"`
		ContentFormat string                     `json:"content_format"`
		PublishedAt   string                     `json:"published_at"`
		DayHint       string                     `json:"day_hint"`
		Metrics       map[string]json.RawMessage `json:"metrics"`
		RawText       string                     `json:"raw_text"`
	} `json:"rows"`
}

var shotNumberRe = regexp.MustCompile(`\d+(?:\.\d+)?[万亿]?\+?`)

var metricIntervalRe = regexp.MustCompile(`(?i)(昨日|昨天|前日|本周|上周|本月|上月|近\s*[0-9一二三四五六七八九十]+\s*(天|日|周|月)|最近\s*[0-9一二三四五六七八九十]+\s*(天|日|周|月)|过去.{0,5}[0-9一二三四五六七八九十]+\s*(天|日|周|月)|近七日|近一周|过去一周)`)
var metricDateHintRe = regexp.MustCompile(`([0-9]{4})[-/.年]([0-9]{1,2})[-/.月]([0-9]{1,2})日?`)

func metricPublishedDateHint(value string) (time.Time, bool) {
	match := metricDateHintRe.FindStringSubmatch(strings.TrimSpace(value))
	if len(match) != 4 {
		return time.Time{}, false
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	day, _ := strconv.Atoi(match[3])
	date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if date.Year() != year || int(date.Month()) != month || date.Day() != day {
		return time.Time{}, false
	}
	return date, true
}

var accountFollowerMetricRe = regexp.MustCompile(`账号.{0,6}(净粉丝|净增|新增粉丝)|粉丝净(增|增长|变化)|净增粉丝|净粉丝`)

var shotNormalizer = strings.NewReplacer(",", "", "，", "", " ", "", "\u00a0", "", "w", "万", "W", "万")

// rawNumbers is every count that literally appears in the screenshot text, after unit conversion.
func rawNumbers(raw string) map[int]bool {
	t := shotNormalizer.Replace(raw)
	out := map[int]bool{}
	for _, tok := range shotNumberRe.FindAllString(t, -1) {
		if v, _, err := parseCount(tok); err == nil {
			out[v] = true
		}
	}
	return out
}

func rawNumbers64(raw string) map[int64]bool {
	t := shotNormalizer.Replace(raw)
	out := map[int64]bool{}
	for _, tok := range shotNumberRe.FindAllString(t, -1) {
		if v, _, err := parseCount64(tok); err == nil {
			out[v] = true
		}
	}
	return out
}

func hasMetricIntervalHint(hints ...string) bool {
	for _, hint := range hints {
		if metricIntervalRe.MatchString(strings.TrimSpace(hint)) {
			return true
		}
	}
	return false
}

// shotValue turns a model value ("1.2万", "1,234", 1234) into a count; units are converted here, not by the model.
func shotValue(raw json.RawMessage) (int, bool, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		var f float64
		if err := json.Unmarshal(raw, &f); err != nil {
			return 0, false, false
		}
		s = strconv.FormatFloat(f, 'f', -1, 64)
	}
	s = shotNormalizer.Replace(s)
	if s == "" {
		return 0, false, false
	}
	v, estimated, err := parseCount(s)
	if err != nil {
		return 0, false, false
	}
	return v, estimated, true
}

func shotValue64(raw json.RawMessage) (int64, bool, bool) {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		var number json.Number
		if err := json.Unmarshal(raw, &number); err != nil {
			return 0, false, false
		}
		s = number.String()
	}
	s = shotNormalizer.Replace(s)
	if s == "" {
		return 0, false, false
	}
	v, estimated, err := parseCount64(s)
	if err != nil {
		return 0, false, false
	}
	return v, estimated, true
}

func metricShotPrompt(platform string, works []recentWork) string {
	var b strings.Builder
	b.WriteString("## 本账号近期的作品（帮助对应截图里的作品，标题以截图为准）\n")
	if len(works) == 0 {
		b.WriteString("（暂无）\n")
	}
	for _, w := range works {
		fmt.Fprintf(&b, "- 《%s》 work_id=%s，形态=%s", w.Title, w.ID, w.ContentFormat)
		if w.PublishedAt != nil {
			fmt.Fprintf(&b, " 发布于 %s", w.PublishedAt.Format("2006-01-02"))
		}
		b.WriteString("\n")
	}
	fields := "reads=阅读，likes=点赞，wows=在看，shares=分享，comments=留言，follows_gained=新增关注"
	if platform == "xhs" {
		fields = "reads=观看/浏览，likes=点赞，favorites=收藏，comments=评论，shares=分享，follows_gained=涨粉"
	} else if platform == "toutiao" {
		fields = "impressions=展现量，reads=阅读，likes=点赞，favorites=收藏，comments=评论，shares=转发，follows_gained=单篇新增关注"
	}
	fmt.Fprintf(&b, `
## 任务说明
识别%s数据截图中的作品数据。截图可能是单篇数据页、作品列表页或内容分析页，一张截图可以有多篇作品，每篇输出一行。
只识别这些数据字段：%s。私信、收益、粉丝画像等其他信息一律忽略。
数字按截图原样输出字符串（如 "1.2万"、"10万+"、"1,234"），不要换算单位、不要估算；看不清或截图里没有的字段不要输出。
title 填截图里的作品标题，看不到填空字符串；work_id 仅当标题与候选作品明确对应时，从上方候选列表原样选择，否则填空字符串；不得编造 ID。content_format 仅在头条账号填写 long_article 或 micro_post，并与候选作品形态一致；不能判断时填空。published_at 填截图上的发布日期，没有填空；day_hint 填截图上的统计时间说明（如"截至今日"、"发布后 7 天"、"近 7 天"），没有填空。
raw_text 逐字抄录截图中与这一行有关的文字和数字，用于核对。
近 N 天／昨日／本周等区间统计不是累计值，必须原样反映在 day_hint 或 raw_text；不要把它改写成"截至今日"。

## 输出格式
只输出 JSON：{"rows":[{"title":"","work_id":"","content_format":"long_article","published_at":"","day_hint":"","metrics":{"reads":"1.2万","likes":"30"},"raw_text":"截图中的原始文字"}]}`, platformNames[platform], fields)
	return b.String()
}

type recentWork struct {
	ID            uuid.UUID
	Title         string
	ContentFormat string
	PublishedAt   *time.Time
}

func (s *Server) recentWorksForShots(ctx context.Context, accountID uuid.UUID) ([]recentWork, error) {
	rows, err := s.db.Query(ctx, `SELECT id,title,content_format,published_at FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>''
		AND status IN ('published','pushed') AND coalesce(published_at, updated_at) > $2 ORDER BY coalesce(published_at, updated_at) DESC LIMIT 40`,
		accountID, s.now().AddDate(0, 0, -30))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []recentWork
	for rows.Next() {
		var w recentWork
		if err := rows.Scan(&w.ID, &w.Title, &w.ContentFormat, &w.PublishedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Server) metricUploadDir(id uuid.UUID) string {
	return filepath.Join(s.cfg.DataDir, "metric_uploads", id.String())
}

// recognizeMetricScreenshots uploads 1–9 screenshots and returns rows to confirm; nothing is written to metrics.
func (s *Server) recognizeMetricScreenshots(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	r.Body = http.MaxBytesReader(w, r.Body, maxMetricShots*maxUploadBytes+1<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return validation("请上传 1–9 张截图（单张不超过 20MB）")
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		return validation("请至少选择 1 张截图")
	}
	if len(files) > maxMetricShots {
		return validation(fmt.Sprintf("一次最多识别 %d 张截图", maxMetricShots))
	}
	var hint *uuid.UUID
	if v := strings.TrimSpace(r.FormValue("work_id")); v != "" {
		id, err := uuid.Parse(v)
		if err != nil {
			return validation("作品参数无效")
		}
		var okID uuid.UUID
		if err := s.db.QueryRow(ctx, `SELECT id FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, id, a.ID).Scan(&okID); err != nil {
			return validation("作品不存在或不属于当前账号")
		}
		hint = &okID
	}

	id := uuid.New()
	dir := s.metricUploadDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	type stored struct {
		Path string `json:"path"`
		Mime string `json:"mime"`
	}
	var saved []stored
	var images []string
	for i, fh := range files {
		f, err := fh.Open()
		if err != nil {
			cleanup()
			return validation("截图读取失败，请重新选择")
		}
		raw, err := io.ReadAll(io.LimitReader(f, maxUploadBytes+1))
		f.Close()
		if err != nil {
			cleanup()
			return err
		}
		if len(raw) > maxUploadBytes {
			cleanup()
			return validation(fmt.Sprintf("第 %d 张截图超过 20MB", i+1))
		}
		data, mime, _, _, err := processImage(raw)
		if err != nil {
			cleanup()
			return validation(fmt.Sprintf("第 %d 张不是可识别的图片（支持 PNG、JPEG）", i+1))
		}
		ext := ".jpg"
		if mime == "image/png" {
			ext = ".png"
		}
		rel := filepath.Join("metric_uploads", id.String(), strconv.Itoa(i)+ext)
		if err := os.WriteFile(filepath.Join(s.cfg.DataDir, rel), data, 0o644); err != nil {
			cleanup()
			return err
		}
		saved = append(saved, stored{Path: filepath.ToSlash(rel), Mime: mime})
		images = append(images, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(data))
	}

	works, err := s.recentWorksForShots(ctx, a.ID)
	if err != nil {
		cleanup()
		return err
	}
	var out metricShotOut
	res, err := s.runAIJSON(ctx, aiTask{Type: "metric_screenshot", Account: a, Bare: true, User: metricShotPrompt(a.Platform, works), Images: images}, &out, nil)
	if err != nil {
		cleanup()
		return err
	}
	rows := make([]metricShotRow, 0, len(out.Rows))
	for _, m := range out.Rows {
		row := metricShotRow{Index: len(rows), Title: strings.TrimSpace(m.Title), PublishedHint: strings.TrimSpace(m.PublishedAt),
			DayHint: strings.TrimSpace(m.DayHint), RawText: strings.TrimSpace(m.RawText), Status: "pending", Dropped: []string{}, MatchType: "none"}
		row.IntervalHint = hasMetricIntervalHint(row.DayHint, row.RawText)
		row.AccountFollowerHint = a.Platform == "toutiao" && accountFollowerMetricRe.MatchString(row.RawText)
		if a.Platform == "toutiao" && validFormat(a.Platform, strings.TrimSpace(m.ContentFormat)) {
			row.ContentFormat = strings.TrimSpace(m.ContentFormat)
		}
		seen := rawNumbers(row.RawText)
		seen64 := rawNumbers64(row.RawText)
		found := false
		for _, k := range metricShotKeys {
			if k == "follows_gained" && row.AccountFollowerHint {
				row.Dropped = append(row.Dropped, "账号净粉丝不能作为单篇新增关注")
				continue
			}
			v, ok := m.Metrics[k]
			if !ok {
				continue
			}
			if k == "impressions" {
				n, estimated, valid := shotValue64(v)
				if !valid {
					continue
				}
				if !seen64[n] {
					row.Dropped = append(row.Dropped, metricShotLabels[k])
					continue
				}
				pv := n
				*row.field64(k) = &pv
				exact := strconv.FormatInt(n, 10)
				row.ImpressionsExact = &exact
				row.Estimated = row.Estimated || estimated
				found = true
				continue
			}
			n, estimated, valid := shotValue(v)
			if !valid {
				continue
			}
			if !seen[n] {
				row.Dropped = append(row.Dropped, metricShotLabels[k])
				continue
			}
			pv := n
			*row.field(k) = &pv
			row.Estimated = row.Estimated || estimated
			found = true
		}
		if !found && len(row.Dropped) == 0 {
			continue
		}
		if candidate, err := uuid.Parse(strings.TrimSpace(m.WorkID)); err == nil {
			var owned uuid.UUID
			var format string
			if s.db.QueryRow(ctx, `SELECT id,content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL AND status IN ('pushed','packed','published')`, candidate, a.ID).Scan(&owned, &format) == nil &&
				(a.Platform != "toutiao" || (row.ContentFormat != "" && row.ContentFormat == format)) {
				row.WorkID, row.MatchType = &owned, "exact"
			}
		}
		if row.WorkID == nil && row.Title != "" && (a.Platform != "toutiao" || row.ContentFormat != "") {
			wid, mt, sim := s.matchWork(ctx, a.ID, row.Title, a.Platform == "toutiao")
			if wid != nil && a.Platform == "toutiao" {
				var format string
				if s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, *wid, a.ID).Scan(&format) != nil || format != row.ContentFormat {
					wid, mt = nil, "none"
				}
			}
			row.WorkID, row.MatchType, row.Similarity = wid, mt, sim
		}
		rows = append(rows, row)
	}
	if hint != nil && len(rows) == 1 && rows[0].WorkID == nil && rows[0].Title == "" {
		rows[0].WorkID, rows[0].MatchType = hint, "hint"
		if a.Platform == "toutiao" {
			_ = s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, *hint, a.ID).Scan(&rows[0].ContentFormat)
		}
	}
	filesJSON, _ := json.Marshal(saved)
	rowsJSON, _ := json.Marshal(rows)
	if _, err := s.db.Exec(ctx, `INSERT INTO metric_upload (id, workspace_id, account_id, files, rows, ai_call_id, created_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, id, ident(ctx).WorkspaceID, a.ID, filesJSON, rowsJSON, res.CallID, ident(ctx).UserID, s.now()); err != nil {
		cleanup()
		return err
	}
	s.audit(ctx, "metrics_screenshot", "account", a.ID.String(), "ok", map[string]any{"images": len(saved), "rows": len(rows)})
	return ok(w, map[string]any{"id": id, "rows": rows, "images": len(saved), "ai_call_id": res.CallID,
		"expires_at": s.now().AddDate(0, 0, metricUploadDays)})
}

// confirmMetricScreenshotRow writes one human-checked row (values from the request, source=screenshot).
func (s *Server) confirmMetricScreenshotRow(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx, err := strconv.Atoi(chiParam(r, "idx"))
	if err != nil || idx < 0 {
		return validation("行号无效")
	}
	var in struct {
		WorkID              uuid.UUID `json:"work_id"`
		CumulativeConfirmed bool      `json:"cumulative_confirmed"`
		metricInput
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var out Metric
	var merged bool
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var accountID uuid.UUID
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT account_id, rows FROM metric_upload WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
			id, ident(ctx).WorkspaceID).Scan(&accountID, &raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return apiErr(404, "not_found", "识别结果不存在或已过期（截图保留 7 天），请重新上传")
			}
			return err
		}
		account, err := s.account(ctx, accountID)
		if err != nil {
			return err
		}
		if err := in.validate(account.Platform); err != nil {
			return err
		}
		var rows []metricShotRow
		if err := json.Unmarshal(raw, &rows); err != nil {
			return err
		}
		if idx >= len(rows) {
			return validation("行号无效")
		}
		if rows[idx].Status == "confirmed" {
			return stateInvalid("这一行已经导入过了")
		}
		if account.Platform == "toutiao" && rows[idx].IntervalHint && !in.CumulativeConfirmed {
			return validation("截图显示的是区间数据。请先对照后台将数值改为截至采集时间的累计值，并勾选确认后再导入")
		}
		if account.Platform == "toutiao" && (rows[idx].AccountFollowerHint || accountFollowerMetricRe.MatchString(rows[idx].RawText)) && in.FollowsGained != nil {
			return validation("截图中的账号净粉丝不能作为单篇作品新增关注，请留空后再导入")
		}
		var okID uuid.UUID
		var contentFormat string
		var publishedAt time.Time
		if err := tx.QueryRow(ctx, `SELECT id,content_format,coalesce(published_at,'0001-01-01'::timestamptz) FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
			AND status IN ('pushed','packed','published')`, in.WorkID, accountID).Scan(&okID, &contentFormat, &publishedAt); err != nil {
			return validation("请为这一行选择本账号已发布的作品")
		}
		if hintedDate, ok := metricPublishedDateHint(rows[idx].PublishedHint); ok && publishedAt.Year() > 1 &&
			hintedDate.Format("2006-01-02") != publishedAt.In(s.loc).Format("2006-01-02") {
			return validation("截图中的发布日期与所选作品不一致，请核对作品后再导入")
		}
		if account.Platform == "toutiao" && rows[idx].ContentFormat != "" && rows[idx].ContentFormat != contentFormat {
			return validation("所选作品形态与截图识别结果不一致，请核对后再导入")
		}
		at := s.now()
		if in.CapturedAt != nil {
			at = *in.CapturedAt
		}
		m, mg, err := s.upsertMetricWithAudit(ctx, tx, metricWrite{WorkID: okID, CapturedAt: at, Source: "screenshot",
			Reads: in.Reads, Impressions: in.Impressions, Likes: in.Likes, Wows: in.Wows, Favorites: in.Favorites, Comments: in.Comments, Shares: in.Shares,
			FollowsGained: in.FollowsGained, Note: strings.TrimSpace(in.Note)})
		if err != nil {
			return err
		}
		out, merged = m, mg
		rows[idx].Status, rows[idx].WorkID, rows[idx].MetricID = "confirmed", &okID, &m.ID
		b, _ := json.Marshal(rows)
		_, err = tx.Exec(ctx, `UPDATE metric_upload SET rows=$2 WHERE id=$1`, id, b)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "metrics_screenshot_confirm", "work", in.WorkID.String(), "ok", map[string]any{"upload": id, "row": idx, "merged": merged})
	return ok(w, struct {
		Metric
		Merged bool `json:"merged"`
	}{out, merged})
}

// purgeMetricUploads deletes screenshots and their recognition results after 7 days.
func (s *Server) purgeMetricUploads(ctx context.Context) {
	rows, err := s.db.Query(ctx, `DELETE FROM metric_upload WHERE created_at < $1 RETURNING id`, s.now().AddDate(0, 0, -metricUploadDays))
	if err != nil {
		slog.Error("清理数据截图失败", "err", err)
		return
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if err := os.RemoveAll(s.metricUploadDir(id)); err != nil {
			slog.Warn("删除数据截图文件失败", "upload", id, "err", err)
		}
	}
}
