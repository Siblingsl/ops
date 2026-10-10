package app

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"net/http"
	"net/url"
	"ops/internal/ai"
	"ops/internal/crawl"
	"sort"
	"strings"
	"time"
)

type HotItem struct {
	ID         uuid.UUID       `json:"id"`
	SourceKey  string          `json:"source_key"`
	SourceName string          `json:"source_name"`
	Title      string          `json:"title"`
	URL        string          `json:"url"`
	Rank       int             `json:"rank"`
	Heat       string          `json:"heat"`
	Category   string          `json:"category"`
	Summary    string          `json:"summary"`
	Sources    []HotSourceRank `json:"sources"`
	ClusterID  *uuid.UUID      `json:"cluster_id"`
	FirstSeen  time.Time       `json:"first_seen_at"`
	LastSeen   time.Time       `json:"last_seen_at"`
}
type HotMatch struct {
	ID        uuid.UUID  `json:"id"`
	Date      string     `json:"date"`
	HotItem   HotItem    `json:"hot_item"`
	Relevance int        `json:"relevance"`
	Reason    string     `json:"reason"`
	Angle     string     `json:"angle"`
	Risk      []string   `json:"risk"`
	Status    string     `json:"status"`
	TopicID   *uuid.UUID `json:"topic_id"`
}

const hotCols = `h.id,h.source_key,src.name,h.title,h.url,h.rank,h.heat,h.category,h.summary,h.cluster_id,h.first_seen_at,h.last_seen_at`

func scanHot(row interface{ Scan(...any) error }) (HotItem, error) {
	var h HotItem
	err := row.Scan(&h.ID, &h.SourceKey, &h.SourceName, &h.Title, &h.URL, &h.Rank, &h.Heat, &h.Category, &h.Summary, &h.ClusterID, &h.FirstSeen, &h.LastSeen)
	return h, err
}
func (s *Server) listHotItems(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	since := s.now().Add(-24 * time.Hour)
	if from := r.URL.Query().Get("from"); from != "" {
		d, e := time.Parse("2006-01-02", from)
		if e != nil {
			return validation("日期格式不正确")
		}
		since = d
	}
	rows, err := s.db.Query(ctx, `SELECT `+hotCols+` FROM hot_item h JOIN crawl_source src ON src.key=h.source_key WHERE (src.workspace_id IS NULL OR src.workspace_id=$1) AND h.last_seen_at>=$2 AND ($3='' OR h.source_key=$3) AND ($4='' OR h.title ILIKE '%'||$4||'%') ORDER BY h.last_seen_at DESC,h.rank LIMIT 100`, ident(ctx).WorkspaceID, since, r.URL.Query().Get("source"), truncateRunes(r.URL.Query().Get("q"), 100))
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []HotItem{}
	for rows.Next() {
		h, e := scanHot(rows)
		if e != nil {
			return e
		}
		items = append(items, h)
	}
	return ok(w, items)
}
func riskForTitle(title string) []string {
	risk := []string{}
	for _, x := range []struct {
		tag   string
		words []string
	}{{"disaster", []string{"灾难", "地震", "灾害", "事故"}}, {"tragedy", []string{"伤亡", "死亡", "遇难"}}, {"politics", []string{"战争", "政变", "军事冲突"}}} {
		for _, word := range x.words {
			if strings.Contains(title, word) {
				risk = append(risk, x.tag)
				break
			}
		}
	}
	return risk
}
func highRisk(risk []string) bool {
	for _, x := range risk {
		if x == "disaster" || x == "tragedy" || x == "politics" {
			return true
		}
	}
	return false
}
func (s *Server) hotCandidates(ctx context.Context, a *Account, st *Strategy) ([]HotItem, error) {
	rows, err := s.db.Query(ctx, `SELECT `+hotCols+` FROM hot_item h JOIN crawl_source src ON src.key=h.source_key WHERE h.source_key=ANY($1::text[]) AND src.enabled AND (src.workspace_id IS NULL OR src.workspace_id=$2) AND h.last_seen_at>=$3 ORDER BY h.rank,h.last_seen_at DESC LIMIT 400`, s.workspaceHotSources(ctx), ident(ctx).WorkspaceID, s.now().Add(-24*time.Hour))
	if err != nil {
		return nil, err
	}
	type scored struct {
		h     HotItem
		score float64
	}
	list := []scored{}
	query := st.Niche + " " + strings.Join(st.Keywords, " ")
	for _, p := range st.Pillars {
		query += " " + p.Name + " " + p.Desc
	}
	for rows.Next() {
		h, e := scanHot(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		blocked := false
		for _, word := range append(append([]string{}, st.BlockedWords...), st.Taboo...) {
			if strings.TrimSpace(word) != "" && strings.Contains(h.Title+" "+h.Summary, word) {
				blocked = true
				break
			}
		}
		if blocked {
			continue
		}
		score := jaccard(terms(query), terms(h.Title+" "+h.Summary))
		for _, word := range st.Keywords {
			if strings.Contains(h.Title, word) {
				score += 0.3
			}
		}
		list = append(list, scored{h, score})
	}
	rows.Close()
	if rt, ok := s.embeddingRoute(ctx); ok && len(list) > 0 {
		cands := []*matCandidate{}
		for _, x := range list {
			cands = append(cands, &matCandidate{id: x.h.ID, content: x.h.Title})
		}
		vecs, e := s.ensureEmbeddings(ctx, rt, "hot", cands)
		if e == nil {
			qv, e := ai.Embed(ctx, s.aiHTTP, rt.baseURL, rt.apiKey, rt.model, []string{query})
			if e == nil && len(qv) > 0 {
				for i := range list {
					list[i].score += cosine(qv[0], vecs[list[i].h.ID])
				}
			}
		}
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].score > list[j].score })
	out := []HotItem{}
	clusters := map[uuid.UUID]bool{}
	for _, x := range list {
		if x.h.ClusterID != nil && clusters[*x.h.ClusterID] {
			continue
		}
		if x.h.ClusterID != nil {
			clusters[*x.h.ClusterID] = true
		}
		out = append(out, x.h)
		if len(out) >= 40 {
			break
		}
	}
	return out, nil
}
func (s *Server) matchHot(ctx context.Context, a *Account, force bool) error {
	c := s.loadCrawl(ctx)
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	if !c.Limits.Enabled || st == nil || st.HotEnabled == nil || !*st.HotEnabled {
		return stateInvalid("请先启用运营方案和热点采集")
	}
	cutoff := s.today()
	if force {
		cutoff = s.now().Add(-10 * time.Minute)
	}
	claimTime := s.now()
	tag, err := s.db.Exec(ctx, `INSERT INTO account_hot_refresh(account_id,refreshed_at) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET refreshed_at=excluded.refreshed_at WHERE account_hot_refresh.refreshed_at<$3`, a.ID, claimTime, cutoff)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if force {
			return stateInvalid("刷新冷却中，请在 10 分钟后重试")
		}
		return nil
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_, _ = s.db.Exec(context.WithoutCancel(ctx), `DELETE FROM account_hot_refresh WHERE account_id=$1 AND refreshed_at=$2`, a.ID, claimTime)
		}
	}()
	items, err := s.hotCandidates(ctx, a, st)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		succeeded = true
		return nil
	}
	input, _ := json.Marshal(items)
	var negative string
	rows, e := s.db.Query(ctx, `SELECT h.title FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id WHERE m.account_id=$1 AND m.status='dismissed' AND m.date>=$2 LIMIT 30`, a.ID, s.today().AddDate(0, 0, -14))
	if e == nil {
		for rows.Next() {
			var title string
			if rows.Scan(&title) == nil {
				negative += title + "\n"
			}
		}
		rows.Close()
	}
	user := fmt.Sprintf("## 运营方案\n%s\n## 候选热点（只引用输入 id，不补充细节）\n%s\n## 近14天不感兴趣\n%s\n只输出 JSON：{\"items\":[{\"hot_item_id\":\"\",\"relevance\":0,\"reason\":\"\",\"angle\":\"\",\"risk\":[]}]}。风险标签限定 disaster/tragedy/politics/unverified/commercial。不相关给低分。", strategyBrief(st), input, negative)
	var out struct {
		Items []struct {
			ID        uuid.UUID `json:"hot_item_id"`
			Relevance int       `json:"relevance"`
			Reason    string    `json:"reason"`
			Angle     string    `json:"angle"`
			Risk      []string  `json:"risk"`
		} `json:"items"`
	}
	known := map[uuid.UUID]HotItem{}
	for _, h := range items {
		known[h.ID] = h
	}
	refs := map[string]any{"hot_items": items}
	res, err := s.runAIJSON(ctx, aiTask{Type: "hot_relevance", Account: a, User: user, SkipStyle: true, Tier: "economy", Refs: refs}, &out, func() error {
		seen := map[uuid.UUID]bool{}
		for _, x := range out.Items {
			if _, ok := known[x.ID]; !ok || seen[x.ID] || x.Relevance < 0 || x.Relevance > 100 {
				return fmt.Errorf("热点 id 或相关度非法")
			}
			seen[x.ID] = true
			for _, r := range x.Risk {
				if r != "disaster" && r != "tragedy" && r != "politics" && r != "unverified" && r != "commercial" {
					return fmt.Errorf("未知风险标签")
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.SliceStable(out.Items, func(i, j int) bool { return out.Items[i].Relevance > out.Items[j].Relevance })
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `DELETE FROM account_hot_match WHERE account_id=$1 AND date=$2 AND status='new'`, a.ID, s.today())
	if err != nil {
		return err
	}
	count := 0
	for _, x := range out.Items {
		risk := cleanList(append(x.Risk, riskForTitle(known[x.ID].Title)...))
		if x.Relevance < 60 && !highRisk(risk) {
			continue
		}
		if count >= 15 {
			break
		}
		_, err = tx.Exec(ctx, `INSERT INTO account_hot_match(account_id,date,hot_item_id,relevance,reason,angle,risk,ai_call_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,date,hot_item_id) DO NOTHING`, a.ID, s.today(), x.ID, x.Relevance, truncateRunes(x.Reason, 500), truncateRunes(x.Angle, 500), risk, res.CallID)
		if err != nil {
			return err
		}
		count++
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	succeeded = true
	for _, candidate := range out.Items {
		if candidate.Relevance >= 75 {
			h := known[candidate.ID]
			u, e := url.Parse(h.URL)
			if e == nil && crawl.Sensitive(u.Hostname()) != "" {
				s.queueHotReference(ctx, h.ID)
			}
		}
	}
	return nil
}
func (s *Server) hotMatches(ctx context.Context, a *Account, date string) ([]HotMatch, error) {
	rows, err := s.db.Query(ctx, `SELECT m.id,to_char(m.date,'YYYY-MM-DD'),m.relevance,m.reason,m.angle,m.risk,m.status,m.topic_id,`+hotCols+` FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id JOIN crawl_source src ON src.key=h.source_key WHERE m.account_id=$1 AND m.date=$2::date AND m.status<>'dismissed' AND h.source_key=ANY($3::text[]) AND (src.workspace_id IS NULL OR src.workspace_id=$4) ORDER BY m.relevance DESC,h.rank`, a.ID, date, s.workspaceHotSources(ctx), ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []HotMatch{}
	for rows.Next() {
		var m HotMatch
		h := &m.HotItem
		err = rows.Scan(&m.ID, &m.Date, &m.Relevance, &m.Reason, &m.Angle, &m.Risk, &m.Status, &m.TopicID, &h.ID, &h.SourceKey, &h.SourceName, &h.Title, &h.URL, &h.Rank, &h.Heat, &h.Category, &h.Summary, &h.ClusterID, &h.FirstSeen, &h.LastSeen)
		if err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	rows.Close()
	for i := range list {
		list[i].HotItem.Sources = s.clusterSources(ctx, list[i].HotItem.ClusterID)
	}
	return list, rows.Err()
}
func (s *Server) getAccountHot(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	date := r.URL.Query().Get("date")
	if date == "" {
		date = s.today().Format("2006-01-02")
	}
	if _, e := time.Parse("2006-01-02", date); e != nil {
		return validation("日期格式不正确")
	}
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	enabled := s.loadCrawl(ctx).Limits.Enabled && st != nil && st.HotEnabled != nil && *st.HotEnabled
	var job *uuid.UUID
	preparing := false
	if date == s.today().Format("2006-01-02") {
		s.opsOpened(ctx, a)
		job, preparing, err = s.prepareOps(ctx, a, "on_open")
		if err != nil {
			return err
		}
	}
	items := []HotMatch{}
	if enabled {
		items, err = s.hotMatches(ctx, a, date)
		if err != nil {
			return err
		}
		visible := []HotMatch{}
		for _, item := range items {
			blocked := false
			for _, word := range append(append([]string{}, st.BlockedWords...), st.Taboo...) {
				if word != "" && strings.Contains(item.HotItem.Title+" "+item.HotItem.Summary, word) {
					blocked = true
					break
				}
			}
			if !blocked {
				visible = append(visible, item)
			}
		}
		items = visible
	}
	sources, err := s.crawlSources(ctx, nil, true)
	if err != nil {
		return err
	}
	paused := []string{}
	selected := s.workspaceHotSources(ctx)
	for _, src := range sources {
		if hotSourceSelected(selected, src.Key) && src.PausedUntil != nil && src.PausedUntil.After(s.now()) {
			paused = append(paused, src.Name)
		}
	}
	var updated *time.Time
	_ = s.db.QueryRow(ctx, `SELECT refreshed_at FROM account_hot_refresh WHERE account_id=$1`, a.ID).Scan(&updated)
	return ok(w, map[string]any{"date": date, "enabled": enabled, "items": items, "paused_sources": paused, "updated_at": updated, "preparing": preparing, "job_id": job})
}
func hotSourceSelected(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
func (s *Server) refreshAccountHot(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if err = s.matchHot(r.Context(), a, true); err != nil {
		return err
	}
	return s.getAccountHot(w, r)
}
func (s *Server) convertHotMatch(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var accountID uuid.UUID
	if err = s.db.QueryRow(ctx, `SELECT m.account_id FROM account_hot_match m JOIN platform_account a ON a.id=m.account_id WHERE m.id=$1 AND a.workspace_id=$2 AND a.status<>'deleted'`, id, ident(ctx).WorkspaceID).Scan(&accountID); err != nil {
		return err
	}
	var in struct {
		Title string `json:"title"`
		Angle string `json:"angle"`
	}
	if err = decode(r, &in); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var status, title, angle string
	var risk []string
	var hotID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT m.status,h.title,m.angle,m.risk,m.hot_item_id FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id WHERE m.id=$1 FOR UPDATE OF m`, id).Scan(&status, &title, &angle, &risk, &hotID); err != nil {
		return err
	}
	if status != "new" {
		return stateInvalid("这条热点已经处理")
	}
	if highRisk(risk) {
		return stateInvalid("不建议借高风险事件营销，不能转为选题")
	}
	if strings.TrimSpace(in.Title) != "" {
		title = strings.TrimSpace(in.Title)
	}
	if strings.TrimSpace(in.Angle) != "" {
		angle = strings.TrimSpace(in.Angle)
	}
	var topicID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO topic(account_id,title,angle,source,hot_item_id) VALUES($1,$2,$3,'hot',$4) RETURNING id`, accountID, truncateRunes(title, 100), truncateRunes(angle, 1000), hotID).Scan(&topicID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE account_hot_match SET status='converted',topic_id=$2 WHERE id=$1`, id, topicID)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, map[string]any{"topic_id": topicID})
}
func (s *Server) dismissHotMatch(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var call *uuid.UUID
	err = s.db.QueryRow(ctx, `UPDATE account_hot_match m SET status='dismissed' FROM platform_account a WHERE m.id=$1 AND a.id=m.account_id AND a.workspace_id=$2 AND a.status<>'deleted' AND m.status='new' RETURNING m.ai_call_id`, id, ident(ctx).WorkspaceID).Scan(&call)
	if err != nil {
		return err
	}
	if call != nil {
		s.implicitFeedback(ctx, *call, "rejected", nil, nil)
	}
	return ok(w, map[string]any{"ok": true})
}
