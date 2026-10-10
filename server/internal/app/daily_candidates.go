package app

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"sort"
	"strings"
)

type DailyBasis struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
	URL  string `json:"url,omitempty"`
}
type DailyCandidate struct {
	DailyBasis
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Weight int    `json:"weight"`
}

func dailyWeight(stage, kind string) int {
	cold := stage == "cold_start"
	switch kind {
	case "slot":
		return 100
	case "pillar":
		if cold {
			return 90
		}
		return 60
	case "hot", "review":
		if cold {
			return 35
		}
		return 85
	default:
		return 60
	}
}
func basisKey(x DailyBasis) string { return x.Type + ":" + x.ID + ":" + x.Name }
func (s *Server) dailyCandidates(ctx context.Context, a *Account, strategy *Strategy) ([]DailyCandidate, error) {
	list := []DailyCandidate{}
	today := s.today()
	ws := ident(ctx).WorkspaceID
	rows, e := s.db.Query(ctx, `SELECT p.id,t.title,t.angle FROM account_plan_slot p JOIN topic t ON t.id=p.topic_id WHERE p.account_id=$1 AND p.date BETWEEN $2::date AND $2::date+3 AND p.status='adopted' AND t.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM work WHERE topic_id=t.id AND deleted_at IS NULL) ORDER BY p.date LIMIT 8`, a.ID, today)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id uuid.UUID
		var title, detail string
		if rows.Scan(&id, &title, &detail) == nil {
			list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "slot", ID: id.String(), URL: "/a/" + a.ID.String() + "/calendar"}, Title: title, Detail: detail, Weight: dailyWeight(strategy.Stage, "slot")})
		}
	}
	rows.Close()
	for _, p := range strategy.Pillars {
		var n int
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM topic WHERE account_id=$1 AND strategy_pillar=$2 AND created_at>$3 AND deleted_at IS NULL`, a.ID, p.Name, today.AddDate(0, 0, -14)).Scan(&n)
		list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "pillar", Name: p.Name, URL: "/a/" + a.ID.String() + "/ops"}, Title: p.Name, Detail: p.Desc, Weight: dailyWeight(strategy.Stage, "pillar") - min(n, 20)})
	}
	if s.loadCrawl(ctx).Limits.Enabled && strategy.HotEnabled != nil && *strategy.HotEnabled {
		matches, e := s.hotMatches(ctx, a, today.Format("2006-01-02"))
		if e != nil {
			return nil, e
		}
		for _, m := range matches {
			if m.Relevance < 75 || highRisk(m.Risk) || m.Status != "new" {
				continue
			}
			blocked := false
			for _, word := range append(strategy.Taboo, strategy.BlockedWords...) {
				if strings.Contains(strings.ToLower(m.HotItem.Title), strings.ToLower(word)) {
					blocked = true
				}
			}
			if blocked {
				continue
			}
			list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "hot", ID: m.HotItem.ID.String(), URL: m.HotItem.URL}, Title: m.HotItem.Title, Detail: m.Angle, Weight: dailyWeight(strategy.Stage, "hot") + m.Relevance/10})
		}
	}
	rows, e = s.db.Query(ctx, `SELECT m.id,m.content FROM material m WHERE m.workspace_id=$1 AND (m.account_id=$2 OR m.account_id IS NULL) AND m.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM work_material WHERE material_id=m.id) AND NOT EXISTS(SELECT 1 FROM work_section WHERE m.id=ANY(material_ids) AND deleted_at IS NULL) ORDER BY m.created_at DESC LIMIT 30`, ws, a.ID)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id uuid.UUID
		var content string
		if rows.Scan(&id, &content) == nil {
			for _, p := range strategy.Pillars {
				if jaccard(terms(content), terms(p.Name+" "+p.Desc)) > 0 || strings.Contains(content, p.Name) {
					list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "material", ID: id.String(), URL: "/a/" + a.ID.String() + "/materials"}, Title: truncateRunes(content, 60), Detail: truncateRunes(content, 500), Weight: dailyWeight(strategy.Stage, "material")})
					break
				}
			}
		}
	}
	rows.Close()
	rows, e = s.db.Query(ctx, `SELECT r.id,r.content FROM review_report r WHERE r.account_id=$1 AND cardinality(r.adopted)>0 AND r.created_at>$2 ORDER BY coalesce((SELECT max(m.reads) FROM metric_snapshot m WHERE m.work_id=ANY(r.work_ids)),0) DESC,r.created_at DESC LIMIT 5`, a.ID, today.AddDate(0, 0, -30))
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id uuid.UUID
		var b []byte
		if rows.Scan(&id, &b) == nil {
			var content map[string]any
			_ = json.Unmarshal(b, &content)
			list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "review", ID: id.String(), URL: "/a/" + a.ID.String() + "/review"}, Title: "近期复盘已采纳结论", Detail: truncateRunes(string(b), 1200), Weight: dailyWeight(strategy.Stage, "review")})
		}
	}
	rows.Close()
	rows, e = s.db.Query(ctx, `SELECT id,title,angle,coalesce(score_fit,0) FROM topic t WHERE account_id=$1 AND deleted_at IS NULL AND status IN ('pending','adopted') AND NOT EXISTS(SELECT 1 FROM work WHERE topic_id=t.id AND deleted_at IS NULL) ORDER BY score_fit DESC NULLS LAST,created_at DESC LIMIT 10`, a.ID)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id uuid.UUID
		var title, detail string
		var score int
		if rows.Scan(&id, &title, &detail, &score) == nil {
			list = append(list, DailyCandidate{DailyBasis: DailyBasis{Type: "topic", ID: id.String(), URL: "/a/" + a.ID.String() + "/topics"}, Title: title, Detail: detail, Weight: dailyWeight(strategy.Stage, "topic") + score/10})
		}
	}
	rows.Close()
	sort.SliceStable(list, func(i, j int) bool { return list[i].Weight > list[j].Weight })
	if len(list) > 40 {
		list = list[:40]
	}
	return list, nil
}
