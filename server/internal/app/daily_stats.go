package app

import (
	"context"
	"github.com/google/uuid"
	"net/http"
)

type DailySourceStat struct {
	Type         string   `json:"type"`
	Total        int      `json:"total"`
	Adopted      int      `json:"adopted"`
	Rate         float64  `json:"rate"`
	Week1        int      `json:"week1"`
	Week1Adopted int      `json:"week1_adopted"`
	Week2        int      `json:"week2"`
	Week2Adopted int      `json:"week2_adopted"`
	Published    int      `json:"published"`
	AvgReads     *float64 `json:"avg_reads"`
	AvgLikes     *float64 `json:"avg_likes"`
	Reduced      bool     `json:"reduced"`
}
type DailyPerformance struct {
	Recommended bool     `json:"recommended"`
	Works       int      `json:"works"`
	AvgReads    *float64 `json:"avg_reads"`
	AvgLikes    *float64 `json:"avg_likes"`
}
type DailyStats struct {
	Total       int                `json:"total"`
	Adopted     int                `json:"adopted"`
	Rate        float64            `json:"rate"`
	Sources     []DailySourceStat  `json:"sources"`
	Performance []DailyPerformance `json:"performance"`
}

func lowTwoWeeks(n1, a1, n2, a2 int) bool { return n1 > 0 && n2 > 0 && a1*10 < n1 && a2*10 < n2 }
func (s *Server) dailySourceStats(ctx context.Context, account uuid.UUID) ([]DailySourceStat, error) {
	rows, e := s.db.Query(ctx, `WITH cards AS (
 SELECT d.id,d.date,x.ordinality-1 idx,x.value FROM daily_recommendation d CROSS JOIN LATERAL jsonb_array_elements(d.items) WITH ORDINALITY x WHERE d.account_id=$1 AND d.date>=$2::date-29
 ), grouped AS(SELECT DISTINCT c.id,c.idx,c.date,b->>'type' typ,EXISTS(SELECT 1 FROM daily_recommendation_action a WHERE a.recommendation_id=c.id AND a.item_index=c.idx AND a.action IN ('adopted','started')) adopted FROM cards c CROSS JOIN LATERAL jsonb_array_elements(c.value->'basis') b)
 SELECT typ,count(*),count(*) FILTER(WHERE adopted),count(*) FILTER(WHERE date>=$2::date-6),count(*) FILTER(WHERE date>=$2::date-6 AND adopted),count(*) FILTER(WHERE date>=$2::date-13 AND date<$2::date-6),count(*) FILTER(WHERE date>=$2::date-13 AND date<$2::date-6 AND adopted) FROM grouped GROUP BY typ ORDER BY typ`, account, s.today())
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	list := []DailySourceStat{}
	for rows.Next() {
		var x DailySourceStat
		if e = rows.Scan(&x.Type, &x.Total, &x.Adopted, &x.Week1, &x.Week1Adopted, &x.Week2, &x.Week2Adopted); e != nil {
			return nil, e
		}
		if x.Total > 0 {
			x.Rate = float64(x.Adopted) / float64(x.Total)
		}
		x.Reduced = lowTwoWeeks(x.Week1, x.Week1Adopted, x.Week2, x.Week2Adopted)
		list = append(list, x)
	}
	return list, rows.Err()
}
func (s *Server) getDailyStats(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	ctx := r.Context()
	sources, e := s.dailySourceStats(ctx, a.ID)
	if e != nil {
		return e
	}
	for i := range sources {
		x := &sources[i]
		e = s.db.QueryRow(ctx, `SELECT count(DISTINCT w.id),avg(m.reads)::float8,avg(m.likes)::float8 FROM work w LEFT JOIN LATERAL(SELECT reads,likes FROM metric_snapshot WHERE work_id=w.id ORDER BY captured_at DESC LIMIT 1)m ON true WHERE w.account_id=$1 AND w.status IN ('published') AND w.deleted_at IS NULL AND w.published_at>$2 AND EXISTS(SELECT 1 FROM daily_recommendation_action act JOIN daily_recommendation d ON d.id=act.recommendation_id CROSS JOIN LATERAL jsonb_array_elements(d.items->act.item_index->'basis') b WHERE act.topic_id=w.topic_id AND b->>'type'=$3 AND act.action IN ('adopted','started'))`, a.ID, s.today().AddDate(0, 0, -30), x.Type).Scan(&x.Published, &x.AvgReads, &x.AvgLikes)
		if e != nil {
			return e
		}
	}
	out := DailyStats{Sources: sources, Performance: []DailyPerformance{}}
	e = s.db.QueryRow(ctx, `SELECT coalesce(sum(jsonb_array_length(items)),0)::int,(SELECT count(DISTINCT (act.recommendation_id,act.item_index)) FROM daily_recommendation_action act JOIN daily_recommendation d ON d.id=act.recommendation_id WHERE d.account_id=$1 AND d.date>=$2::date-29 AND act.action IN ('adopted','started')) FROM daily_recommendation WHERE account_id=$1 AND date>=$2::date-29`, a.ID, s.today()).Scan(&out.Total, &out.Adopted)
	if e != nil {
		return e
	}
	if out.Total > 0 {
		out.Rate = float64(out.Adopted) / float64(out.Total)
	}
	rows, e := s.db.Query(ctx, `SELECT EXISTS(SELECT 1 FROM daily_recommendation_action a WHERE a.topic_id=w.topic_id AND a.action IN ('adopted','started')) recommended,count(*),avg(m.reads)::float8,avg(m.likes)::float8 FROM work w LEFT JOIN LATERAL(SELECT reads,likes FROM metric_snapshot WHERE work_id=w.id ORDER BY captured_at DESC LIMIT 1)m ON true WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.status IN ('published') AND w.published_at>$2 GROUP BY recommended ORDER BY recommended DESC`, a.ID, s.today().AddDate(0, 0, -30))
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var x DailyPerformance
		if e = rows.Scan(&x.Recommended, &x.Works, &x.AvgReads, &x.AvgLikes); e != nil {
			return e
		}
		out.Performance = append(out.Performance, x)
	}
	return ok(w, out)
}
