package app

import (
	"context"
	"encoding/csv"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---------- 粘贴/CSV 批量回填（DEV-U106，12 文档） ----------

// metricColumnAliases maps paste/CSV header names to metric keys; 标题 is required for matching.
var metricColumnAliases = []struct {
	Key   string
	Names []string
}{
	{"title", []string{"title", "标题", "题目"}},
	{"work_id", []string{"work_id", "作品ID", "作品编号"}},
	{"url", []string{"url", "链接", "作品链接"}},
	{"content_format", []string{"content_format", "形态", "作品形态"}},
	{"published_at", []string{"published_at", "发布时间"}},
	{"captured_at", []string{"captured_at", "统计时间", "采集时间"}},
	{"impressions", []string{"impressions", "展现量", "展现"}},
	{"reads", []string{"reads", "阅读", "观看", "浏览", "阅读数", "播放"}},
	{"likes", []string{"likes", "点赞", "赞"}},
	{"wows", []string{"wows", "在看"}},
	{"favorites", []string{"favorites", "收藏"}},
	{"comments", []string{"comments", "评论", "留言"}},
	{"shares", []string{"shares", "分享"}},
	{"follows_gained", []string{"follows_gained", "涨粉", "新增关注"}},
}

var metricSep = regexp.MustCompile(`\t+|\s{2,}|\|+`)

type metricPreviewRow struct {
	Title            string     `json:"title"`
	URL              string     `json:"url,omitempty"`
	ContentFormat    string     `json:"content_format,omitempty"`
	PublishedAt      string     `json:"published_at,omitempty"`
	CapturedAt       string     `json:"captured_at,omitempty"`
	WorkID           *uuid.UUID `json:"work_id"`
	Matched          bool       `json:"matched"`
	MatchType        string     `json:"match_type"` // exact | fuzzy | none
	Similarity       float64    `json:"similarity"`
	Estimated        bool       `json:"estimated"`
	Reads            *int       `json:"reads"`
	Impressions      *int64     `json:"impressions"`
	ImpressionsExact *string    `json:"impressions_exact,omitempty"`
	Likes            *int       `json:"likes"`
	Wows             *int       `json:"wows"`
	Favorites        *int       `json:"favorites"`
	Comments         *int       `json:"comments"`
	Shares           *int       `json:"shares"`
	FollowsGained    *int       `json:"follows_gained"`
	Error            string     `json:"error"`
	Raw              []string   `json:"raw,omitempty"`
}

// parseCount parses 1,234 / 10万+ / 1.2万 / 3亿; a trailing "+" marks a lower-bound estimate.
func parseCount(cell string) (int, bool, error) {
	t := strings.ReplaceAll(strings.TrimSpace(cell), ",", "")
	t = strings.ReplaceAll(t, "，", "")
	if t == "" {
		return 0, false, nil
	}
	estimated := strings.HasSuffix(t, "+")
	t = strings.TrimSuffix(t, "+")
	mult := 1
	switch {
	case strings.HasSuffix(t, "亿"):
		mult, t = 100000000, strings.TrimSuffix(t, "亿")
	case strings.HasSuffix(t, "万"):
		mult, t = 10000, strings.TrimSuffix(t, "万")
	}
	if t == "" {
		return 0, false, fmt.Errorf("「%s」不是数字", cell)
	}
	v, err := strconv.ParseFloat(t, 64)
	if err != nil || v < 0 {
		return 0, false, fmt.Errorf("「%s」不是数字", cell)
	}
	return int(v * float64(mult)), estimated, nil
}

func parseCount64(cell string) (int64, bool, error) {
	t := strings.ReplaceAll(strings.TrimSpace(cell), ",", "")
	t = strings.ReplaceAll(t, "，", "")
	if t == "" {
		return 0, false, nil
	}
	estimated := strings.HasSuffix(t, "+")
	t = strings.TrimSuffix(t, "+")
	multiplier := int64(1)
	switch {
	case strings.HasSuffix(t, "亿"):
		multiplier, t = 100000000, strings.TrimSuffix(t, "亿")
	case strings.HasSuffix(t, "万"):
		multiplier, t = 10000, strings.TrimSuffix(t, "万")
	}
	if t == "" {
		return 0, false, fmt.Errorf("「%s」不是数字", cell)
	}
	value, ok := new(big.Rat).SetString(t)
	if !ok || value.Sign() < 0 {
		return 0, false, fmt.Errorf("「%s」不是有效的展现量整数", cell)
	}
	value.Mul(value, new(big.Rat).SetInt64(multiplier))
	if !value.IsInt() || !value.Num().IsInt64() {
		return 0, false, fmt.Errorf("「%s」不是有效的展现量整数", cell)
	}
	return value.Num().Int64(), estimated, nil
}

// matchWork resolves a pasted title to a work of the account: exact first, then trgm fuzzy ≥ 0.4.
func (s *Server) matchWork(ctx context.Context, accountID uuid.UUID, title string, conservative bool) (*uuid.UUID, string, float64) {
	rows, err := s.db.Query(ctx, `SELECT id FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title=$2 ORDER BY updated_at DESC LIMIT 2`, accountID, title)
	if err == nil {
		ids := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, "none", 0
			}
			ids = append(ids, id)
		}
		rows.Close()
		if len(ids) == 1 {
			return &ids[0], "exact", 1
		}
		if len(ids) > 1 {
			if conservative {
				return nil, "none", 0
			}
			return &ids[0], "exact", 1
		}
	}
	fuzzy, err := s.db.Query(ctx, `SELECT id, similarity(title,$2) FROM work WHERE account_id=$1 AND deleted_at IS NULL
		AND similarity(title,$2) >= 0.4 ORDER BY similarity(title,$2) DESC, updated_at DESC LIMIT 2`, accountID, title)
	if err != nil {
		return nil, "none", 0
	}
	defer fuzzy.Close()
	var best uuid.UUID
	var similarity float64
	count := 0
	for fuzzy.Next() {
		var id uuid.UUID
		var score float64
		if err := fuzzy.Scan(&id, &score); err != nil {
			return nil, "none", 0
		}
		if count == 0 {
			best, similarity = id, score
		}
		count++
	}
	if count == 0 || (conservative && count > 1) {
		return nil, "none", similarity
	}
	return &best, "fuzzy", similarity
}

func samePublishedURL(left, right string) bool {
	parse := func(raw string) (string, bool) {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
			return "", false
		}
		u.Scheme = strings.ToLower(u.Scheme)
		u.Host = strings.ToLower(u.Host)
		u.Fragment = ""
		u.RawFragment = ""
		u.Path = strings.TrimRight(u.Path, "/")
		if u.Path == "" {
			u.Path = "/"
		}
		return u.String(), true
	}
	a, aok := parse(left)
	b, bok := parse(right)
	return aok && bok && a == b
}

func (s *Server) matchWorkURL(ctx context.Context, accountID uuid.UUID, rawURL string) *uuid.UUID {
	rows, err := s.db.Query(ctx, `SELECT id, published_url FROM work WHERE account_id=$1 AND deleted_at IS NULL AND published_url IS NOT NULL`, accountID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var match uuid.UUID
	count := 0
	for rows.Next() {
		var id uuid.UUID
		var saved string
		if err := rows.Scan(&id, &saved); err != nil {
			return nil
		}
		if samePublishedURL(rawURL, saved) {
			match = id
			count++
		}
	}
	if rows.Err() != nil || count != 1 {
		return nil
	}
	return &match
}

func (s *Server) matchMetricImportRow(ctx context.Context, accountID uuid.UUID, platform string, cells []string, colByKey map[string]int, row *metricPreviewRow) {
	if rawID := metricCell(cells, colByKey, "work_id"); rawID != "" {
		id, err := uuid.Parse(rawID)
		if err != nil {
			row.Error = "作品 ID 格式无效"
			return
		}
		var owned uuid.UUID
		if err := s.db.QueryRow(ctx, `SELECT id FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, id, accountID).Scan(&owned); err != nil {
			row.Error = "作品 ID 不属于当前账号"
			return
		}
		row.WorkID, row.MatchType, row.Matched = &owned, "exact", true
	}
	if row.WorkID == nil && row.Error == "" && row.URL != "" {
		row.WorkID = s.matchWorkURL(ctx, accountID, row.URL)
		if row.WorkID != nil {
			row.MatchType, row.Matched = "exact", true
		}
	}
	if row.WorkID == nil && row.Error == "" && row.Title != "" {
		id, kind, similarity := s.matchWork(ctx, accountID, row.Title, platform == "toutiao")
		row.WorkID, row.MatchType, row.Similarity, row.Matched = id, kind, similarity, id != nil
	}
	if platform == "toutiao" && row.WorkID != nil && row.ContentFormat != "" {
		var actualFormat string
		if err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, *row.WorkID, accountID).Scan(&actualFormat); err != nil || actualFormat != row.ContentFormat {
			row.WorkID, row.Matched, row.MatchType = nil, false, "none"
		}
	}
}

// fillMetricRow parses the numeric columns of one row into the preview row.
func fillMetricRow(cells []string, colByKey map[string]int, row *metricPreviewRow) {
	for _, def := range metricColumnAliases {
		if def.Key == "title" || def.Key == "work_id" || def.Key == "url" || def.Key == "content_format" || def.Key == "published_at" || def.Key == "captured_at" {
			continue
		}
		i, ok := colByKey[def.Key]
		if !ok || i >= len(cells) {
			continue
		}
		cell := strings.TrimSpace(cells[i])
		if cell == "" {
			continue
		}
		if def.Key == "impressions" {
			v, estimated, err := parseCount64(cell)
			if err != nil {
				row.Error = fmt.Sprintf("「%s」列无法解析：%s", def.Names[0], cell)
				continue
			}
			row.Impressions = &v
			exact := strconv.FormatInt(v, 10)
			row.ImpressionsExact = &exact
			row.Estimated = row.Estimated || estimated
			continue
		}
		v, estimated, err := parseCount(cell)
		if err != nil {
			row.Error = fmt.Sprintf("「%s」列无法解析：%s", def.Names[0], cell)
			continue
		}
		pv := v
		switch def.Key {
		case "reads":
			row.Reads = &pv
		case "likes":
			row.Likes = &pv
		case "wows":
			row.Wows = &pv
		case "favorites":
			row.Favorites = &pv
		case "comments":
			row.Comments = &pv
		case "shares":
			row.Shares = &pv
		case "follows_gained":
			row.FollowsGained = &pv
		}
		row.Estimated = row.Estimated || estimated
	}
}

// parseMetricText parses pasted table text: one work per line, columns split by tab, pipe, or 2+ spaces.
// A header line containing 标题 maps columns by alias; otherwise the default order is
// 标题,阅读,点赞,在看,收藏,评论,分享,涨粉.
func (s *Server) parseMetricText(ctx context.Context, accountID uuid.UUID, platform, text string) []metricPreviewRow {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	defaultOrder := []string{"reads", "likes", "wows", "favorites", "comments", "shares", "follows_gained"}
	colByKey := map[string]int{"title": 0}
	for i, k := range defaultOrder {
		colByKey[k] = i + 1
	}
	start := 0
	for i, ln := range lines {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		cells := make([]string, 0)
		for _, c := range metricSep.Split(ln, -1) {
			cells = append(cells, strings.TrimSpace(c))
		}
		hasHeader := false
		for _, c := range cells {
			for _, def := range metricColumnAliases {
				for _, name := range def.Names {
					if strings.EqualFold(c, name) && (def.Key == "title" || platform == "toutiao") {
						hasHeader = true
					}
				}
			}
		}
		if hasHeader {
			colByKey = map[string]int{}
			for i, c := range cells {
				for _, def := range metricColumnAliases {
					for _, name := range def.Names {
						if strings.EqualFold(c, name) {
							colByKey[def.Key] = i
						}
					}
				}
			}
			start = i + 1
		}
		break
	}
	out := []metricPreviewRow{}
	for i := start; i < len(lines); i++ {
		ln := strings.TrimSpace(lines[i])
		if ln == "" {
			continue
		}
		cells := make([]string, 0)
		for _, c := range metricSep.Split(ln, -1) {
			cells = append(cells, strings.TrimSpace(c))
		}
		row := metricPreviewRow{Raw: cells}
		title := ""
		if j, ok := colByKey["title"]; ok && j < len(cells) {
			title = cells[j]
		}
		row.Title = title
		row.URL = metricCell(cells, colByKey, "url")
		row.ContentFormat = metricCell(cells, colByKey, "content_format")
		row.PublishedAt = metricCell(cells, colByKey, "published_at")
		row.CapturedAt = metricCell(cells, colByKey, "captured_at")
		fillMetricRow(cells, colByKey, &row)
		s.matchMetricImportRow(ctx, accountID, platform, cells, colByKey, &row)
		if title == "" && platform != "toutiao" {
			row.Error = "缺少标题列"
		}
		out = append(out, row)
	}
	return out
}

func metricCell(cells []string, colByKey map[string]int, key string) string {
	if i, ok := colByKey[key]; ok && i >= 0 && i < len(cells) {
		return strings.TrimSpace(cells[i])
	}
	return ""
}

// importMetrics is the batch backfill entry (FR-M11-04, DEV-U106): paste text or CSV preview,
// then a JSON confirm with human-verified rows. Invalid rows are rejected with their line number.
func (s *Server) importMetrics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var in struct {
			Text   string `json:"text"`
			Source string `json:"source"` // paste | file
			Rows   []struct {
				Title         string `json:"title"`
				WorkID        string `json:"work_id"`
				URL           string `json:"url"`
				ContentFormat string `json:"content_format"`
				PublishedAt   string `json:"published_at"`
				CapturedAt    string `json:"captured_at"`
				Reads         *int   `json:"reads"`
				Likes         *int   `json:"likes"`
				Wows          *int   `json:"wows"`
				Favorites     *int   `json:"favorites"`
				Comments      *int   `json:"comments"`
				Shares        *int   `json:"shares"`
				FollowsGained *int   `json:"follows_gained"`
				Impressions   *int64 `json:"impressions"`
			} `json:"rows"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		if in.Text != "" {
			return ok(w, map[string]any{"preview": s.parseMetricText(r.Context(), a.ID, a.Platform, in.Text),
				"message": "请人工确认匹配后，以 JSON 提交 rows 完成导入"})
		}
		source := "paste"
		if in.Source == "file" {
			source = "file"
		}
		n := 0
		err = s.withTx(r.Context(), func(tx pgx.Tx) error {
			for i, row := range in.Rows {
				id, err := uuid.Parse(strings.TrimSpace(row.WorkID))
				if err != nil && strings.TrimSpace(row.WorkID) != "" {
					return validation(fmt.Sprintf("第 %d 行的作品 ID 格式无效", i+1))
				}
				if strings.TrimSpace(row.WorkID) == "" && strings.TrimSpace(row.Title) != "" {
					matched, kind, _ := s.matchWork(r.Context(), a.ID, strings.TrimSpace(row.Title), a.Platform == "toutiao")
					if matched != nil && kind == "exact" {
						id, err = *matched, nil
					}
				}
				if err != nil || id == uuid.Nil {
					return validation(fmt.Sprintf("第 %d 行没有匹配的作品，请先为每行指定作品或删除该行", i+1))
				}
				var platform, contentFormat, status string
				var publishedAt *time.Time
				var publishedURL *string
				if err := tx.QueryRow(r.Context(), `SELECT a.platform,w.content_format,w.published_at,w.published_url,w.status FROM work w JOIN platform_account a ON a.id=w.account_id
					WHERE w.id=$1 AND w.account_id=$2 AND w.deleted_at IS NULL`, id, a.ID).Scan(&platform, &contentFormat, &publishedAt, &publishedURL, &status); err != nil {
					return validation(fmt.Sprintf("第 %d 行的作品不存在或不属于当前账号", i+1))
				}
				if platform == "toutiao" && status != "pushed" && status != "packed" && status != "published" {
					return validation(fmt.Sprintf("第 %d 行的作品尚未准备发布，不能回填数据", i+1))
				}
				if row.ContentFormat != "" && row.ContentFormat != contentFormat {
					return validation(fmt.Sprintf("第 %d 行的形态与所选作品不一致", i+1))
				}
				if row.PublishedAt != "" {
					parsed, parseErr := time.Parse(time.RFC3339, row.PublishedAt)
					if parseErr != nil || publishedAt == nil || !parsed.Equal(*publishedAt) {
						return validation(fmt.Sprintf("第 %d 行的发布时间与所选作品不一致，请核对后再导入", i+1))
					}
				}
				if row.URL != "" && (publishedURL == nil || !samePublishedURL(row.URL, *publishedURL)) {
					return validation(fmt.Sprintf("第 %d 行的链接与所选作品不一致，请核对后再导入", i+1))
				}
				if row.Impressions != nil && platform != "toutiao" {
					return validation(fmt.Sprintf("第 %d 行的展现量仅适用于今日头条作品", i+1))
				}
				okID := id
				capturedAt := s.now()
				if row.CapturedAt != "" {
					capturedAt, err = time.Parse(time.RFC3339, row.CapturedAt)
					if err != nil {
						return validation(fmt.Sprintf("第 %d 行的采集时间格式无效", i+1))
					}
				}
				if _, _, err := s.upsertMetricWithAudit(r.Context(), tx, metricWrite{WorkID: okID, CapturedAt: capturedAt, Source: source,
					Reads: row.Reads, Impressions: row.Impressions, Likes: row.Likes, Wows: row.Wows, Favorites: row.Favorites, Comments: row.Comments,
					Shares: row.Shares, FollowsGained: row.FollowsGained}); err != nil {
					return err
				}
				n++
			}
			return nil
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return validation("没有可导入的行")
		}
		s.audit(r.Context(), "metrics_import", "account", a.ID.String(), "ok", map[string]any{"rows": n})
		return ok(w, map[string]any{"imported": n})
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		return validation("请上传 CSV 文件")
	}
	f, _, err := r.FormFile("file")
	if err != nil {
		return validation("请上传 CSV 文件")
	}
	defer f.Close()
	rd := csv.NewReader(f)
	rd.FieldsPerRecord = -1
	records, err := rd.ReadAll()
	if err != nil || len(records) < 2 {
		return validation("CSV 无法解析或没有数据行")
	}
	colByKey := map[string]int{}
	for i, h := range records[0] {
		h = strings.TrimSpace(h)
		for _, def := range metricColumnAliases {
			for _, name := range def.Names {
				if strings.EqualFold(h, name) {
					colByKey[def.Key] = i
				}
			}
		}
	}
	if _, hasTitle := colByKey["title"]; !hasTitle && a.Platform != "toutiao" {
		return validation("CSV 需要「标题」列以便匹配作品")
	}
	preview := make([]metricPreviewRow, 0, len(records)-1)
	for _, rec := range records[1:] {
		title := metricCell(rec, colByKey, "title")
		row := metricPreviewRow{Title: title, Raw: rec, URL: metricCell(rec, colByKey, "url"),
			ContentFormat: metricCell(rec, colByKey, "content_format"), PublishedAt: metricCell(rec, colByKey, "published_at"), CapturedAt: metricCell(rec, colByKey, "captured_at")}
		fillMetricRow(rec, colByKey, &row)
		if title == "" && a.Platform != "toutiao" {
			continue
		}
		s.matchMetricImportRow(r.Context(), a.ID, a.Platform, rec, colByKey, &row)
		if row.Error == "" && row.WorkID == nil && title == "" {
			row.Error = "请选择本账号中对应的作品"
		}
		preview = append(preview, row)
	}
	return ok(w, map[string]any{"preview": preview, "message": "请人工确认匹配后，以 JSON 提交 rows 完成导入"})
}
