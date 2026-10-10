package app

import (
	"context"
	"github.com/google/uuid"
)

func opsHealthScores(active bool, pillars, mapped, total, published, perWeek int) (int, int) {
	clarity, cadence := 0, 0
	if active {
		clarity = 3
		if pillars >= 3 && pillars <= 5 {
			clarity += 2
		}
		if total > 0 {
			clarity += min(5, mapped*5/total)
		}
		if perWeek > 0 {
			cadence = min(10, published*10/(perWeek*4))
		}
	}
	return clarity, cadence
}
func (s *Server) opsHealth(ctx context.Context, account uuid.UUID) ([]HealthItem, error) {
	st, e := s.activeStrategy(ctx, account)
	if e != nil {
		return nil, e
	}
	pillars, perWeek := 0, 0
	if st != nil {
		pillars = len(st.Pillars)
		perWeek = st.Cadence.PerWeek
	}
	var mapped, total, published int
	e = s.db.QueryRow(ctx, `SELECT count(*) FILTER(WHERE t.strategy_pillar<>''),count(*) FROM work w LEFT JOIN topic t ON t.id=w.topic_id WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.created_at>$2`, account, s.today().AddDate(0, 0, -30)).Scan(&mapped, &total)
	if e != nil {
		return nil, e
	}
	e = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND status='published' AND published_at>$2`, account, s.today().AddDate(0, 0, -28)).Scan(&published)
	if e != nil {
		return nil, e
	}
	clarity, cadence := opsHealthScores(st != nil, pillars, mapped, total, published, perWeek)
	link := "/a/" + account.String() + "/ops"
	return []HealthItem{{Key: "positioning", Label: "定位清晰度", Score: clarity, Max: 10, Hint: hintIf(clarity < 10, "启用 3–5 个内容支柱，并把近 30 天作品归入支柱"), Link: link}, {Key: "cadence", Label: "节奏达成", Score: cadence, Max: 10, Hint: hintIf(cadence < 10, "按方案节奏完成近 4 周内容；实际发布后回填记录"), Link: link}}, nil
}
