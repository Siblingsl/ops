package app

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

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
	Title         string     `json:"title"`
	WorkID        *uuid.UUID `json:"work_id"`
	Matched       bool       `json:"matched"`
	MatchType     string     `json:"match_type"` // exact | fuzzy | none
	Similarity    float64    `json:"similarity"`
	Estimated     bool       `json:"estimated"`
	Reads         *int       `json:"reads"`
	Likes         *int       `json:"likes"`
	Wows          *int       `json:"wows"`
	Favorites     *int       `json:"favorites"`
	Comments      *int       `json:"comments"`
	Shares        *int       `json:"shares"`
	FollowsGained *int       `json:"follows_gained"`
	Error         string     `json:"error"`
	Raw           []string   `json:"raw,omitempty"`
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

// matchWork resolves a pasted title to a work of the account: exact first, then trgm fuzzy ≥ 0.4.
func (s *Server) matchWork(ctx context.Context, accountID uuid.UUID, title string) (*uuid.UUID, string, float64) {
	var id uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title=$2 ORDER BY updated_at DESC LIMIT 1`,
		accountID, title).Scan(&id); err == nil {
		return &id, "exact", 1
	}
	var best uuid.UUID
	var sim float64
	if err := s.db.QueryRow(ctx, `SELECT id, similarity(title,$2) FROM work WHERE account_id=$1 AND deleted_at IS NULL
		AND similarity(title,$2) >= 0.4 ORDER BY similarity(title,$2) DESC LIMIT 1`, accountID, title).Scan(&best, &sim); err != nil {
		return nil, "none", 0
	}
	return &best, "fuzzy", sim
}

// fillMetricRow parses the numeric columns of one row into the preview row.
func fillMetricRow(cells []string, colByKey map[string]int, row *metricPreviewRow) {
	for _, def := range metricColumnAliases {
		if def.Key == "title" {
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
func (s *Server) parseMetricText(ctx context.Context, accountID uuid.UUID, text string) []metricPreviewRow {
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
			if c == "标题" || strings.EqualFold(c, "title") {
				hasHeader = true
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
		fillMetricRow(cells, colByKey, &row)
		if title == "" {
			row.Error = "缺少标题列"
		} else if row.Error == "" {
			id, matchType, sim := s.matchWork(ctx, accountID, title)
			row.WorkID, row.MatchType, row.Similarity = id, matchType, sim
			row.Matched = id != nil
		}
		out = append(out, row)
	}
	return out
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
				Reads         *int   `json:"reads"`
				Likes         *int   `json:"likes"`
				Wows          *int   `json:"wows"`
				Favorites     *int   `json:"favorites"`
				Comments      *int   `json:"comments"`
				Shares        *int   `json:"shares"`
				FollowsGained *int   `json:"follows_gained"`
			} `json:"rows"`
		}
		if err := decode(r, &in); err != nil {
			return err
		}
		if in.Text != "" {
			return ok(w, map[string]any{"preview": s.parseMetricText(r.Context(), a.ID, in.Text),
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
				if err != nil {
					return validation(fmt.Sprintf("第 %d 行没有匹配的作品，请先为每行指定作品或删除该行", i+1))
				}
				var okID uuid.UUID
				if err := tx.QueryRow(r.Context(), `SELECT id FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, id, a.ID).Scan(&okID); err != nil {
					return validation(fmt.Sprintf("第 %d 行的作品不存在或不属于当前账号", i+1))
				}
				if _, _, err := upsertMetric(r.Context(), tx, metricWrite{WorkID: okID, CapturedAt: s.now(), Source: source,
					Reads: row.Reads, Likes: row.Likes, Wows: row.Wows, Favorites: row.Favorites, Comments: row.Comments,
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
	if _, hasTitle := colByKey["title"]; !hasTitle {
		return validation("CSV 需要「标题」列以便匹配作品")
	}
	preview := make([]metricPreviewRow, 0, len(records)-1)
	for _, rec := range records[1:] {
		i, hasTitle := colByKey["title"]
		if !hasTitle || i >= len(rec) {
			continue
		}
		title := strings.TrimSpace(rec[i])
		if title == "" {
			continue
		}
		row := metricPreviewRow{Title: title, Raw: rec}
		fillMetricRow(rec, colByKey, &row)
		if row.Error == "" {
			id, matchType, sim := s.matchWork(r.Context(), a.ID, title)
			row.WorkID, row.MatchType, row.Similarity = id, matchType, sim
			row.Matched = id != nil
		} else {
			row.MatchType = "none"
		}
		preview = append(preview, row)
	}
	return ok(w, map[string]any{"preview": preview, "message": "请人工确认匹配后，以 JSON 提交 rows 完成导入"})
}
