package app

import (
	"net/http"
)

// 只读汇总，不调用采集器；采纳按推荐项去重，不重复计入采用后开写。
type sourceHealthWindow struct {
	Runs        int      `json:"runs"`
	Successful  int      `json:"successful"`
	SuccessRate *float64 `json:"success_rate"`
	Items       int      `json:"items"`
	Matches     int      `json:"matches"`
	Converted   int      `json:"converted"`
	Adopted     int      `json:"adopted"`
}
type sourceHealthRow struct {
	Key    string             `json:"key"`
	Name   string             `json:"name"`
	Days7  sourceHealthWindow `json:"days_7"`
	Days30 sourceHealthWindow `json:"days_30"`
}

func (s *Server) adminCrawlHealth(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireSystemAdmin(r.Context()); err != nil {
		return err
	}
	now := s.now()
	// 每个窗口按事件发生时间统计。转选题缺少独立时间戳，按匹配创建时间统计。
	rows, err := s.db.Query(r.Context(), `
 SELECT src.key,src.name,period.days,
  (SELECT count(*) FROM crawl_run c WHERE c.source_key=src.key AND c.started_at >= period.since AND c.started_at <= $1 AND c.finished_at IS NOT NULL),
  (SELECT count(*) FROM crawl_run c WHERE c.source_key=src.key AND c.started_at >= period.since AND c.started_at <= $1 AND c.finished_at IS NOT NULL AND c.error='' AND c.http_status BETWEEN 200 AND 299),
  (SELECT coalesce(sum(c.items),0) FROM crawl_run c WHERE c.source_key=src.key AND c.started_at >= period.since AND c.started_at <= $1 AND c.finished_at IS NOT NULL),
  (SELECT count(*) FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id WHERE h.source_key=src.key AND m.created_at >= period.since AND m.created_at <= $1),
  (SELECT count(*) FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id WHERE h.source_key=src.key AND m.created_at >= period.since AND m.created_at <= $1 AND m.status='converted'),
  (SELECT count(DISTINCT (ra.recommendation_id,ra.item_index))
   FROM daily_recommendation_action ra JOIN daily_recommendation d ON d.id=ra.recommendation_id
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(d.items->ra.item_index->'basis','[]'::jsonb)) b
   JOIN hot_item h ON h.id::text=b->>'id'
   WHERE b->>'type'='hot' AND h.source_key=src.key AND ra.action IN ('adopted','started') AND ra.created_at >= period.since AND ra.created_at <= $1)
 FROM crawl_source src CROSS JOIN (VALUES (7,$2::timestamptz),(30,$3::timestamptz)) period(days,since)
 ORDER BY src.key,period.days`, now, now.AddDate(0, 0, -7), now.AddDate(0, 0, -30))
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []sourceHealthRow{}
	for rows.Next() {
		var key, name string
		var days int
		var stats sourceHealthWindow
		if err := rows.Scan(&key, &name, &days, &stats.Runs, &stats.Successful, &stats.Items, &stats.Matches, &stats.Converted, &stats.Adopted); err != nil {
			return err
		}
		if stats.Runs > 0 {
			rate := float64(stats.Successful) / float64(stats.Runs)
			stats.SuccessRate = &rate
		}
		if len(out) == 0 || out[len(out)-1].Key != key {
			out = append(out, sourceHealthRow{Key: key, Name: name})
		}
		row := &out[len(out)-1]
		if days == 7 {
			row.Days7 = stats
		} else {
			row.Days30 = stats
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"sources": out, "generated_at": now, "retention_days": s.loadCrawl(r.Context()).RetentionDays})
}
