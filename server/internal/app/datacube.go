package app

import (
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/wechat"
)

// syncWechatMetrics pulls datacube article summary into metric_snapshot (FR-M11-05).
// Personal accounts often lack this API; errors are returned with readable WeChat codes.
func (s *Server) syncWechatMetrics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if a.Platform != "wechat_mp" {
		return validation("仅公众号账号支持数据接口同步")
	}
	var in struct {
		Date string `json:"date"` // YYYY-MM-DD，默认昨天
	}
	_ = decode(r, &in)
	day := strings.TrimSpace(in.Date)
	if day == "" {
		day = s.now().AddDate(0, 0, -1).Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return validation("日期格式应为 YYYY-MM-DD")
	}
	ctx := r.Context()
	token, err := s.accessToken(ctx, a.ID, false)
	if err != nil {
		return err
	}
	list, err := s.wx.DatacubeArticleSummary(ctx, token, day, day)
	if err != nil {
		if we, ok := err.(*wechat.Error); ok {
			if we.Code == 48001 || we.Code == 50002 {
				return apiErr(403, "wechat_capability", "当前公众号无权使用数据统计接口（通常需企业认证）。可继续手动录入或导入导出文件。")
			}
			return apiErr(502, "wechat_upstream", we.Readable())
		}
		return apiErr(502, "wechat_upstream", err.Error())
	}
	// Load published / pushed works for title match
	rows, err := s.db.Query(ctx, `SELECT id, title FROM work WHERE account_id=$1 AND deleted_at IS NULL
		AND status IN ('published','pushed') ORDER BY coalesce(published_at, updated_at) DESC LIMIT 200`, a.ID)
	if err != nil {
		return err
	}
	type wt struct {
		ID    uuid.UUID
		Title string
	}
	var works []wt
	for rows.Next() {
		var x wt
		if err := rows.Scan(&x.ID, &x.Title); err != nil {
			rows.Close()
			return err
		}
		works = append(works, x)
	}
	rows.Close()

	imported := 0
	unmatched := 0
	for _, row := range list {
		title := strings.TrimSpace(row.Title)
		var workID *uuid.UUID
		for _, wk := range works {
			if wk.Title == title || strings.Contains(wk.Title, title) || strings.Contains(title, wk.Title) {
				id := wk.ID
				workID = &id
				break
			}
		}
		if workID == nil {
			unmatched++
			continue
		}
		captured, _ := time.ParseInLocation("2006-01-02", day, s.loc)
		err := s.withTx(ctx, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO metric_snapshot (work_id, captured_at, reads, likes, wows, favorites, comments, shares, follows_gained, note)
				VALUES ($1,$2,$3,0,0,$4,0,$5,0,$6)`,
				*workID, captured, row.IntPageReadUser, row.AddToFavUser, row.ShareUser,
				"微信 datacube 同步 "+day)
			return err
		})
		if err != nil {
			return err
		}
		imported++
	}
	s.audit(ctx, "metrics_sync", "account", a.ID.String(), "ok", map[string]any{
		"date": day, "imported": imported, "unmatched": unmatched, "rows": len(list),
	})
	return ok(w, map[string]any{
		"date": day, "imported": imported, "unmatched": unmatched, "api_rows": len(list),
		"message": "已从微信数据接口同步；无法匹配标题的行未写入，可改用手动录入或 CSV 导入。",
	})
}
