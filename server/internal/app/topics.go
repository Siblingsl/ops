package app

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Topic struct {
	ID              uuid.UUID  `json:"id"`
	AccountID       uuid.UUID  `json:"account_id"`
	Title           string     `json:"title"`
	Angle           string     `json:"angle"`
	Source          string     `json:"source"`
	Status          string     `json:"status"`
	WorkID          *uuid.UUID `json:"work_id"`
	CreatedAt       time.Time  `json:"created_at"`
	Audience        string     `json:"audience"`
	Hook            string     `json:"hook"`
	NeededMaterials []string   `json:"needed_materials"`
	Format          string     `json:"format"`
	PlannedDate     *string    `json:"planned_date"`
	SeriesID        *uuid.UUID `json:"series_id"`
	ScoreFit        *int       `json:"score_fit"`
	ScoreReason     string     `json:"score_reason"`
	ScoreMaterial   int        `json:"score_material"`
	ScoreNovelty    int        `json:"score_novelty"`
	Pinned          bool       `json:"pinned"`
	StrategyPillar  *string    `json:"strategy_pillar"`
	HotItemID       *uuid.UUID `json:"hot_item_id"`
}

const topicCols = `t.id, t.account_id, t.title, t.angle, t.source, t.status,
	(SELECT id FROM work WHERE topic_id=t.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1), t.created_at,
	t.audience, t.hook, t.needed_materials, t.format, to_char(t.planned_date,'YYYY-MM-DD'), t.series_id, t.score_fit, t.score_reason, t.pinned_at IS NOT NULL,
	t.strategy_pillar, t.hot_item_id`

func scanTopic(row interface{ Scan(...any) error }) (Topic, error) {
	var t Topic
	err := row.Scan(&t.ID, &t.AccountID, &t.Title, &t.Angle, &t.Source, &t.Status, &t.WorkID, &t.CreatedAt,
		&t.Audience, &t.Hook, &t.NeededMaterials, &t.Format, &t.PlannedDate, &t.SeriesID, &t.ScoreFit, &t.ScoreReason, &t.Pinned,
		&t.StrategyPillar, &t.HotItemID)
	if t.NeededMaterials == nil {
		t.NeededMaterials = []string{}
	}
	return t, err
}

// D-048 第 5.7 节：账号类型创建后固定，选题的预计形态只能是空或账号类型；
// 历史选题的其他形态值保留展示（列表有"形态与账号类型不匹配"提示），但开写会被拦截。
func validateTopicFormat(a *Account, f *topicFields) error {
	if f.Format != nil && *f.Format != "" && *f.Format != a.ContentFormat {
		return validation(fmt.Sprintf("这个账号的类型是%s，选题预计形态只能是账号类型或留空", formatNames[a.ContentFormat]))
	}
	return nil
}

func (s *Server) listTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.account_id=$1 AND t.deleted_at IS NULL ORDER BY t.pinned_at DESC NULLS LAST, t.created_at DESC`, a.ID)
	if err != nil {
		return err
	}
	list := []Topic{}
	for rows.Next() {
		t, err := scanTopic(rows)
		if err != nil {
			rows.Close()
			return err
		}
		list = append(list, t)
	}
	rows.Close()
	if r.URL.Query().Get("scores") == "1" || r.URL.Query().Get("sort") == "score" {
		s.ruleTopicScores(ctx, a, list)
	}
	if r.URL.Query().Get("sort") == "score" {
		sortTopicsByScore(list)
	}
	return ok(w, list)
}

// ruleTopicScores fills 素材充足度 and 新颖度 for pending topics (EX-C-02); 契合度 comes from topic_score.
func (s *Server) ruleTopicScores(ctx context.Context, a *Account, list []Topic) {
	var titles []string
	rows, err := s.db.Query(ctx, `SELECT title FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'' ORDER BY created_at DESC LIMIT 300`, a.ID)
	if err == nil {
		for rows.Next() {
			var t string
			if rows.Scan(&t) == nil {
				titles = append(titles, t)
			}
		}
		rows.Close()
	}
	for i := range list {
		if list[i].Status != "pending" {
			continue
		}
		q := strings.Join([]string{list[i].Title, list[i].Angle, strings.Join(list[i].NeededMaterials, " ")}, " ")
		hits, _, err := s.retrieveMaterials(ctx, a, q, nil, 10)
		if err == nil {
			var sum float64
			for _, h := range hits {
				sum += h.Score
			}
			list[i].ScoreMaterial = min(100, int(sum*40))
		}
		maxSim := 0.0
		qt := terms(list[i].Title)
		for _, t := range titles {
			if sim := jaccard(qt, terms(t)); sim > maxSim {
				maxSim = sim
			}
		}
		list[i].ScoreNovelty = int((1 - maxSim) * 100)
	}
}

func jaccard(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inter := 0
	for t := range a {
		if b[t] {
			inter++
		}
	}
	return float64(inter) / float64(len(a)+len(b)-inter)
}

// similarTitles returns earlier topics or works of the account whose titles look alike (FR-M3-04 提示，不阻止).
func (s *Server) similarTitles(r *http.Request, accountID uuid.UUID, title string) ([]string, error) {
	rows, err := s.db.Query(r.Context(), `SELECT title FROM (
		SELECT title FROM topic WHERE account_id=$1 AND deleted_at IS NULL
		UNION SELECT title FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'') x
		WHERE similarity(title, $2) > 0.35 ORDER BY similarity(title, $2) DESC LIMIT 3`, accountID, title)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

type topicFields struct {
	Audience        *string  `json:"audience"`
	Hook            *string  `json:"hook"`
	NeededMaterials []string `json:"needed_materials"`
	Format          *string  `json:"format"`
	PlannedDate     *string  `json:"planned_date"`
	SeriesID        *string  `json:"series_id"`
	ScoreFit        *int     `json:"score_fit"`
	Pinned          *bool    `json:"pinned"`
	StrategyPillar  *string  `json:"strategy_pillar"`
}

func (f *topicFields) validate() error {
	if f.PlannedDate != nil && *f.PlannedDate != "" {
		if _, err := time.Parse("2006-01-02", *f.PlannedDate); err != nil {
			return validation("计划发布日格式不正确")
		}
	}
	if f.ScoreFit != nil && (*f.ScoreFit < 0 || *f.ScoreFit > 100) {
		return validation("契合度在 0 到 100 之间")
	}
	return nil
}

func (s *Server) applyTopicFields(ctx context.Context, id, accountID uuid.UUID, f topicFields) error {
	var planned any = nil
	setPlanned := f.PlannedDate != nil
	if setPlanned && *f.PlannedDate != "" {
		planned = *f.PlannedDate
	}
	var needed []string
	if f.NeededMaterials != nil {
		needed = cleanList(f.NeededMaterials)
		if needed == nil {
			needed = []string{}
		}
	}
	var series any = nil
	setSeries := f.SeriesID != nil
	if setSeries && *f.SeriesID != "" {
		sid, err := uuid.Parse(*f.SeriesID)
		if err != nil {
			return validation("系列不存在")
		}
		var x uuid.UUID
		if err := s.db.QueryRow(ctx, `SELECT id FROM topic_series WHERE id=$1 AND account_id=$2`, sid, accountID).Scan(&x); err != nil {
			return validation("系列不存在")
		}
		series = sid
	}
	trim := func(p *string, n int) *string {
		if p == nil {
			return nil
		}
		v := truncateRunes(strings.TrimSpace(*p), n)
		return &v
	}
	_, err := s.db.Exec(ctx, `UPDATE topic SET audience=coalesce($2,audience), hook=coalesce($3,hook), needed_materials=coalesce($4,needed_materials),
		format=coalesce($5,format), planned_date=CASE WHEN $6 THEN $7::date ELSE planned_date END,
		series_id=CASE WHEN $8 THEN $9::uuid ELSE series_id END,
		score_fit=coalesce($10,score_fit), score_reason=CASE WHEN $10::int IS NULL THEN score_reason ELSE '手动调整' END,
		pinned_at=CASE WHEN $11::bool IS NULL THEN pinned_at WHEN $11::bool THEN coalesce(pinned_at, now()) END,
		strategy_pillar=coalesce(nullif($12,''),strategy_pillar), updated_at=now() WHERE id=$1`,
		id, trim(f.Audience, 100), trim(f.Hook, 200), needed, f.Format, setPlanned, planned, setSeries, series, f.ScoreFit, f.Pinned,
		trim(f.StrategyPillar, 40))
	return err
}

// createTopic is the only way a topic enters the pool: one item per request (H-01).
func (s *Server) createTopic(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Title       string     `json:"title"`
		Angle       string     `json:"angle"`
		Source      string     `json:"source"`
		AICallID    *uuid.UUID `json:"ai_call_id"`
		ChoiceIndex *int       `json:"choice_index"`
		HotItemID   *uuid.UUID `json:"hot_item_id"`
		topicFields
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return validation("请填写选题标题")
	}
	if err := in.topicFields.validate(); err != nil {
		return err
	}
	if err := validateTopicFormat(a, &in.topicFields); err != nil {
		return err
	}
	switch in.Source {
	case "ai", "review", "hot", "plan", "daily":
	default:
		in.Source = "manual"
	}
	similar, err := s.similarTitles(r, a.ID, in.Title)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if in.HotItemID != nil {
		if in.Source != "hot" {
			return validation("热点关联仅用于热点选题")
		}
		if err := s.usableHot(ctx, a, *in.HotItemID, 1); err != nil {
			return err
		}
	}
	var id uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO topic (account_id, title, angle, source,hot_item_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		a.ID, in.Title, strings.TrimSpace(in.Angle), in.Source, in.HotItemID).Scan(&id); err != nil {
		return err
	}
	if err := s.applyTopicFields(ctx, id, a.ID, in.topicFields); err != nil {
		return err
	}
	if in.AICallID != nil {
		s.implicitFeedback(ctx, *in.AICallID, "accepted", in.ChoiceIndex, nil)
	}
	t, err := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, id))
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"topic": t, "similar": similar})
}

// topicSuggestOutput builds the JSON contract for topic suggestions. D-048 第 5.4 节：
// 选题建议的形态只能是账号类型——账号类型创建后固定，其他形态的选题永远无法开写。
func topicSuggestOutput(a *Account, hot bool) string {
	if hot {
		return fmt.Sprintf(`只输出 JSON：{"topics":[{"title":"选题标题","angle":"切入角度","reason":"推荐理由","timeliness":"时效提示","audience":"目标读者","hook":"钩子","needed_materials":[],"format":"%s","hot_item_id":null,"source_url":""}]}`, a.ContentFormat)
	}
	return fmt.Sprintf(`只输出 JSON：{"topics":[{"title":"选题标题","angle":"一句话切入角度","reason":"推荐理由","audience":"目标读者","hook":"开头抓人的点","needed_materials":["需要的素材"],"format":"%s"}]}`, a.ContentFormat)
}

type topicSuggestion struct {
	HotItemID       *uuid.UUID `json:"hot_item_id,omitempty"`
	SourceURL       string     `json:"source_url,omitempty"`
	Title           string     `json:"title"`
	Angle           string     `json:"angle"`
	Reason          string     `json:"reason"`
	Timeliness      string     `json:"timeliness,omitempty"`
	Audience        string     `json:"audience"`
	Hook            string     `json:"hook"`
	NeededMaterials []string   `json:"needed_materials"`
	Format          string     `json:"format"`
}

func normalizeSuggestions(list []topicSuggestion, a *Account) {
	for i := range list {
		if list[i].Format == "" {
			list[i].Format = a.ContentFormat
		}
		if list[i].NeededMaterials == nil {
			list[i].NeededMaterials = []string{}
		}
	}
}

func (s *Server) recentTitles(ctx context.Context, accountID uuid.UUID) []string {
	rows, err := s.db.Query(ctx, `SELECT title FROM (SELECT title, created_at FROM topic WHERE account_id=$1 AND deleted_at IS NULL
		UNION ALL SELECT title, created_at FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'') x ORDER BY created_at DESC LIMIT 20`, accountID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var recent []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			recent = append(recent, t)
		}
	}
	return recent
}

// suggestTopics only returns suggestions; nothing is written to the pool (H-01, HC-01).
func (s *Server) suggestTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Direction string `json:"direction"`
	}
	_ = decodeOptional(r, &in)
	user := fmt.Sprintf(`## 选题需求
方向关键词：%s
账号类型：%s（每个选题必须适合这种类型的表达方式）
最近的选题和作品标题（避免重复）：
%s

## 任务说明
为这个账号提出不少于 6 个选题建议。每个选题给出标题、切入角度、推荐理由、目标读者、钩子、需要的素材和预计形态。选题要贴合账号定位和目标读者，与最近的选题不重复；不要追逐无法核实的热点。

## 输出格式
%s`, strings.TrimSpace(in.Direction), a.ContentFormat, "- "+strings.Join(s.recentTitles(r.Context(), a.ID), "\n- "), topicSuggestOutput(a, false))
	var out struct {
		Topics []topicSuggestion `json:"topics"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "topic_suggest", Account: a, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Topics) < 5 {
			return fmt.Errorf("选题少于 5 条")
		}
		for i := range out.Topics {
			if out.Topics[i].Format == "" {
				out.Topics[i].Format = a.ContentFormat
			} else if out.Topics[i].Format != a.ContentFormat {
				return fmt.Errorf("选题的预计形态必须为 %s（账号类型），不能输出其他类型", a.ContentFormat)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	normalizeSuggestions(out.Topics, a)
	return ok(w, map[string]any{"suggestions": out.Topics, "refs": res.Refs, "ai_call_id": res.CallID})
}

// suggestHotTopics returns timely topic ideas from compliant sources only (FR-M3-05 / D-016).
// Does not scrape platform hotlists; optional user-pasted public excerpts may ground suggestions.
// Nothing is written to the pool (H-01).
func (s *Server) suggestHotTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Direction string `json:"direction"`
		Context   string `json:"context"` // 用户粘贴的公开资讯摘要，可选
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctxText := strings.TrimSpace(in.Context)
	ctxText = truncateRunes(ctxText, 4000)
	if ctxText != "" {
		ctxText = externalBlock("资讯摘要", "pasted", cleanExternalText(ctxText))
	}
	known := map[uuid.UUID]HotItem{}
	strategy, strategyErr := s.activeStrategy(r.Context(), a.ID)
	if strategyErr != nil {
		return strategyErr
	}
	if s.loadCrawl(r.Context()).Limits.Enabled && strategy != nil && strategy.HotEnabled != nil && *strategy.HotEnabled {
		matches, e := s.hotMatches(r.Context(), a, s.today().Format("2006-01-02"))
		if e != nil {
			return e
		}
		input := []HotItem{}
		for _, m := range matches {
			if !highRisk(m.Risk) && m.Relevance >= 60 {
				input = append(input, m.HotItem)
				known[m.HotItem.ID] = m.HotItem
			}
			if len(input) >= 10 {
				break
			}
		}
		if len(input) > 0 {
			ctxText += "\n## 以下真实热点（已匹配，带 id 和链接）\n" + externalBlock("热点", "matched", input)
		}
	}
	if ctxText == "" {
		ctxText = "（用户未粘贴资讯摘要；仅基于账号定位与公开常识给出时效性选题角度，不要编造具体新闻链接或未核实的事件细节。）"
	}
	user := fmt.Sprintf(`## 热点选题需求（合规来源）
方向关键词：%s
账号类型：%s（每个选题必须适合这种类型的表达方式）
用户粘贴的公开资讯摘要（可为空）：
%s

最近的选题和作品标题（避免重复）：
%s

## 任务说明
结合账号定位，提出不少于 6 个「有时效感」的选题建议。合规约束：
1. 只能使用输入中的真实热点或用户粘贴摘要，不得编造热点。引用真实热点必须给出输入 hot_item_id 和 source_url。
2. 若用户粘贴了资讯摘要，优先据此提炼角度；未粘贴时用公开常识与季节性话题，并在理由中说明「待用户核实时效」。
3. 不要编造具体报道链接、媒体名下的假新闻或无法核实的数据。
4. 每个选题给出标题、切入角度、推荐理由，以及可选的时效提示（如「本周热点」「常青但当下有讨论」）。

## 输出格式
%s`,
		strings.TrimSpace(in.Direction), a.ContentFormat, ctxText, "- "+strings.Join(s.recentTitles(r.Context(), a.ID), "\n- "), topicSuggestOutput(a, true))
	var out struct {
		Topics []topicSuggestion `json:"topics"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "topic_hot_suggest", Account: a, User: user, SkipStyle: true, Refs: map[string]any{"hot_items": known}}, &out, func() error {
		if len(out.Topics) < 5 {
			return fmt.Errorf("热点选题少于 5 条")
		}
		for i := range out.Topics {
			item := &out.Topics[i]
			if item.HotItemID != nil {
				h, ok := known[*item.HotItemID]
				if !ok {
					return fmt.Errorf("引用了不存在或高风险的热点 id")
				}
				item.SourceURL = h.URL
			} else {
				item.SourceURL = ""
			}
			if item.Format == "" {
				item.Format = a.ContentFormat
			} else if item.Format != a.ContentFormat {
				return fmt.Errorf("选题的预计形态必须为 %s（账号类型），不能输出其他类型", a.ContentFormat)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	normalizeSuggestions(out.Topics, a)
	return ok(w, map[string]any{"suggestions": out.Topics, "refs": res.Refs, "ai_call_id": res.CallID})
}

func (s *Server) updateTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	accountID, err := s.ownedAccountRow(ctx, "topic", id)
	if err != nil {
		return err
	}
	var in struct {
		Title  *string `json:"title"`
		Angle  *string `json:"angle"`
		Status *string `json:"status"`
		topicFields
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Status != nil && *in.Status != "pending" && *in.Status != "adopted" && *in.Status != "dropped" {
		return validation("状态只能是待定、已采用或已放弃")
	}
	if err := in.topicFields.validate(); err != nil {
		return err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	// 编辑允许把历史不匹配形态改为账号类型或留空；原值原样保存（不改类型）也兼容。
	if in.Format != nil && *in.Format != "" && *in.Format != a.ContentFormat {
		var cur string
		_ = s.db.QueryRow(ctx, `SELECT coalesce(format,'') FROM topic WHERE id=$1`, id).Scan(&cur)
		if *in.Format != cur {
			return validation(fmt.Sprintf("这个账号的类型是%s，选题预计形态只能是账号类型或留空", formatNames[a.ContentFormat]))
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE topic SET title=coalesce($2,title), angle=coalesce($3,angle), status=coalesce($4,status), updated_at=now() WHERE id=$1`,
		id, in.Title, in.Angle, in.Status); err != nil {
		return err
	}
	if err := s.applyTopicFields(ctx, id, accountID, in.topicFields); err != nil {
		return err
	}
	t, err := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, id))
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true, "topic": t})
}

func (s *Server) deleteTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "topic", id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE topic SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// startWorkFromTopic creates the work; the angle is only a placeholder hint (H-02: the viewpoint is written by the author),
// and materials matching "需要的素材" are preselected (EX-C-01).
func (s *Server) startWorkFromTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	accountID, err := s.ownedAccountRow(ctx, "topic", id)
	if err != nil {
		return err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	// D-048 第 5.5 节：跨类型选题不能开写；历史不匹配选题明确提示，由人决定改形态或放弃。
	var tformat string
	if err := s.db.QueryRow(ctx, `SELECT coalesce(format,'') FROM topic WHERE id=$1`, id).Scan(&tformat); err != nil {
		return err
	}
	if tformat != "" && tformat != a.ContentFormat {
		return stateInvalid(fmt.Sprintf("这个选题的预计形态是%s，与账号类型（%s）不一致，不能开写。请在编辑选题卡中改为账号类型，或放弃这条选题。", formatNames[tformat], formatNames[a.ContentFormat]))
	}
	var title, angle string
	var needed []string
	var planned *string
	if err := s.db.QueryRow(ctx, `UPDATE topic SET status='adopted', updated_at=now() WHERE id=$1 RETURNING title, angle, needed_materials, to_char(planned_date,'YYYY-MM-DD')`,
		id).Scan(&title, &angle, &needed, &planned); err != nil {
		return err
	}
	workID, err := s.insertWork(ctx, a, &id, title, angle)
	if err != nil {
		return err
	}
	if planned != nil {
		_, _ = s.db.Exec(ctx, `UPDATE work SET planned_date=$2::date WHERE id=$1`, workID, *planned)
	}
	preselected := []uuid.UUID{}
	seen := map[string]bool{}
	for _, q := range append(needed, title+" "+angle) {
		if strings.TrimSpace(q) == "" {
			continue
		}
		hits, _, err := s.retrieveMaterials(ctx, a, q, nil, 3)
		if err != nil {
			continue
		}
		for _, h := range hits {
			if h.Score < 0.35 || seen[h.ID] || len(preselected) >= 8 {
				continue
			}
			seen[h.ID] = true
			if u, err := uuid.Parse(h.ID); err == nil {
				preselected = append(preselected, u)
			}
		}
	}
	for _, mid := range preselected {
		_, _ = s.db.Exec(ctx, `INSERT INTO work_material (work_id, material_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, workID, mid)
	}
	return s.writeWork(w, r, workID)
}

// scoreTopics runs topic_score for up to 20 unscored pending topics in the task center (EX-C-02). It never changes status.
func (s *Server) scoreTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id, title, angle FROM topic WHERE account_id=$1 AND deleted_at IS NULL AND status='pending'
		AND (scored_at IS NULL OR scored_at < updated_at) ORDER BY created_at DESC LIMIT 20`, a.ID)
	if err != nil {
		return err
	}
	type tp struct {
		id           uuid.UUID
		title, angle string
	}
	var list []tp
	for rows.Next() {
		var x tp
		if rows.Scan(&x.id, &x.title, &x.angle) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	if len(list) == 0 {
		return ok(w, map[string]any{"job_id": nil, "count": 0})
	}
	jobID, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "topic_score", Label: fmt.Sprintf("选题评分（%d 个）", len(list)), Link: "/a/" + a.ID.String() + "/topics", AccountID: &a.ID},
		func(jctx context.Context) (any, error) {
			var b strings.Builder
			valid := map[string]bool{}
			for _, x := range list {
				fmt.Fprintf(&b, "- [选题 id=%s] %s（角度：%s）\n", x.id, x.title, nz(x.angle, "未填"))
				valid[x.id.String()] = true
			}
			user := `## 待评分的选题
` + b.String() + `
## 任务说明
只评估每个选题与账号定位档案的契合度（0–100），并给出一句理由。不评估其他方面。

## 输出格式
只输出 JSON：{"scores":[{"topic_id":"id","fit":80,"reason":"理由"}]}`
			var out struct {
				Scores []struct {
					TopicID string `json:"topic_id"`
					Fit     int    `json:"fit"`
					Reason  string `json:"reason"`
				} `json:"scores"`
			}
			res, err := s.runAIJSON(jctx, aiTask{Type: "topic_score", Account: a, User: user, SkipStyle: true, Tier: "economy"}, &out, func() error {
				if len(out.Scores) == 0 {
					return fmt.Errorf("没有评分")
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
			n := 0
			for _, sc := range out.Scores {
				if !valid[sc.TopicID] {
					continue
				}
				fit := max(0, min(100, sc.Fit))
				if _, err := s.db.Exec(jctx, `UPDATE topic SET score_fit=$2, score_reason=$3, scored_at=now() WHERE id=$1`, sc.TopicID, fit, truncate(sc.Reason, 200)); err == nil {
					n++
				}
			}
			return map[string]any{"scored": n, "ai_call_id": res.CallID}, nil
		})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"job_id": jobID, "count": len(list)})
}

// sortTopicsByScore is used by clients that ask for the combined ranking (契合 0.5 + 素材 0.3 + 新颖 0.2).
func sortTopicsByScore(list []Topic) {
	score := func(t Topic) float64 {
		fit := 50.0
		if t.ScoreFit != nil {
			fit = float64(*t.ScoreFit)
		}
		return 0.5*fit + 0.3*float64(t.ScoreMaterial) + 0.2*float64(t.ScoreNovelty)
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		return score(list[i]) > score(list[j])
	})
}
