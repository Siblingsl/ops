package app

import (
	"context"
	"github.com/google/uuid"
	"net/http"
	"time"
)

type HotSourceRank struct {
	Name string `json:"name"`
	Rank int    `json:"rank"`
	URL  string `json:"url"`
}
type HotRankPoint struct {
	At     time.Time `json:"at"`
	Rank   int       `json:"rank"`
	Source string    `json:"source"`
}
type HotWriting struct {
	Account string    `json:"account"`
	WorkID  uuid.UUID `json:"work_id"`
	Title   string    `json:"title"`
}
type HotTrend struct {
	ID      uuid.UUID       `json:"id"`
	Title   string          `json:"title"`
	First   time.Time       `json:"first_seen_at"`
	Last    time.Time       `json:"last_seen_at"`
	Sources []HotSourceRank `json:"sources"`
	Points  []HotRankPoint  `json:"points"`
	Writing []HotWriting    `json:"writing"`
}

func (s *Server) clusterSources(ctx context.Context, cluster *uuid.UUID) []HotSourceRank {
	list := []HotSourceRank{}
	if cluster == nil {
		return list
	}
	rows, e := s.db.Query(ctx, `SELECT src.name,h.rank,h.url FROM hot_item h JOIN crawl_source src ON src.key=h.source_key WHERE h.cluster_id=$1 AND src.enabled AND (src.workspace_id IS NULL OR src.workspace_id=$2) AND src.key=ANY($3) ORDER BY h.rank,src.name`, cluster, ident(ctx).WorkspaceID, s.workspaceHotSources(ctx))
	if e != nil {
		return list
	}
	defer rows.Close()
	for rows.Next() {
		var x HotSourceRank
		if rows.Scan(&x.Name, &x.Rank, &x.URL) == nil {
			list = append(list, x)
		}
	}
	return list
}
func (s *Server) getHotTrends(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	ctx := r.Context()
	list := []HotTrend{}
	st, e := s.activeStrategy(ctx, a.ID)
	if e != nil {
		return e
	}
	if !s.loadCrawl(ctx).Limits.Enabled || st == nil || st.HotEnabled == nil || !*st.HotEnabled {
		return ok(w, list)
	}
	rows, e := s.db.Query(ctx, `SELECT c.id,c.title,min(h.first_seen_at),max(h.last_seen_at) FROM hot_cluster c JOIN hot_item h ON h.cluster_id=c.id JOIN crawl_source src ON src.key=h.source_key WHERE src.enabled AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) word WHERE word<>'' AND (h.title||' '||h.summary) ILIKE '%'||word||'%') AND (src.workspace_id IS NULL OR src.workspace_id=$1) AND src.key=ANY($2) AND h.last_seen_at>$3 AND EXISTS(SELECT 1 FROM account_hot_match m WHERE m.account_id=$4 AND m.hot_item_id=h.id AND m.date>=$5::date AND m.status<>'dismissed') GROUP BY c.id ORDER BY max(h.last_seen_at) DESC LIMIT 30`, ident(ctx).WorkspaceID, s.workspaceHotSources(ctx), s.now().AddDate(0, 0, -7), a.ID, s.today().AddDate(0, 0, -7), append(append([]string{}, st.BlockedWords...), st.Taboo...))
	if e != nil {
		return e
	}
	for rows.Next() {
		x := HotTrend{Points: []HotRankPoint{}, Writing: []HotWriting{}}
		if e = rows.Scan(&x.ID, &x.Title, &x.First, &x.Last); e != nil {
			rows.Close()
			return e
		}
		list = append(list, x)
	}
	rows.Close()
	for i := range list {
		x := &list[i]
		x.Sources = s.clusterSources(ctx, &x.ID)
		pr, e := s.db.Query(ctx, `SELECT rh.observed_at,rh.rank,src.name FROM hot_rank_history rh JOIN hot_item h ON h.id=rh.hot_item_id JOIN crawl_source src ON src.key=h.source_key WHERE h.cluster_id=$1 AND src.enabled AND (src.workspace_id IS NULL OR src.workspace_id=$2) AND src.key=ANY($3) AND rh.observed_at>$4 ORDER BY rh.observed_at LIMIT 2000`, x.ID, ident(ctx).WorkspaceID, s.workspaceHotSources(ctx), s.now().AddDate(0, 0, -7))
		if e != nil {
			return e
		}
		for pr.Next() {
			var p HotRankPoint
			if pr.Scan(&p.At, &p.Rank, &p.Source) == nil {
				x.Points = append(x.Points, p)
			}
		}
		pr.Close()
		wr, e := s.db.Query(ctx, `SELECT DISTINCT a.name,w.id,w.title FROM work w JOIN platform_account a ON a.id=w.account_id JOIN topic t ON t.id=w.topic_id JOIN hot_item h ON h.id=t.hot_item_id WHERE h.cluster_id=$1 AND a.workspace_id=$2 AND a.id<>$3 AND w.deleted_at IS NULL AND w.status IN ('drafting','checking','reviewing','ready')`, x.ID, ident(ctx).WorkspaceID, a.ID)
		if e != nil {
			return e
		}
		for wr.Next() {
			var v HotWriting
			if wr.Scan(&v.Account, &v.WorkID, &v.Title) == nil {
				x.Writing = append(x.Writing, v)
			}
		}
		wr.Close()
	}
	return ok(w, list)
}
