package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Metric struct {
	ID            uuid.UUID `json:"id"`
	WorkID        uuid.UUID `json:"work_id"`
	CapturedAt    time.Time `json:"captured_at"`
	Reads         *int      `json:"reads"`
	Likes         *int      `json:"likes"`
	Wows          *int      `json:"wows"`
	Favorites     *int      `json:"favorites"`
	Comments      *int      `json:"comments"`
	Shares        *int      `json:"shares"`
	FollowsGained *int      `json:"follows_gained"`
	Note          string    `json:"note"`
	Source        string    `json:"source"`
	DayOffset     *int      `json:"day_offset"`
	ExternalID    *string   `json:"external_id"`
}

const metricCols = `id, work_id, captured_at, reads, likes, wows, favorites, comments, shares, follows_gained, note, source, day_offset, external_id`

func metricDest(m *Metric) []any {
	return []any{&m.ID, &m.WorkID, &m.CapturedAt, &m.Reads, &m.Likes, &m.Wows, &m.Favorites, &m.Comments, &m.Shares, &m.FollowsGained, &m.Note, &m.Source, &m.DayOffset, &m.ExternalID}
}

func scanMetric(row interface{ Scan(...any) error }) (Metric, error) {
	var m Metric
	err := row.Scan(metricDest(&m)...)
	return m, err
}

type BoardRow struct {
	ID          uuid.UUID  `json:"id"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	PublishedAt *time.Time `json:"published_at"`
	D7          *Metric    `json:"d7"`
	Nodes       []int32    `json:"nodes"`
	Points      int        `json:"points"`
}

func (s *Server) board(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.status, w.published_at, (SELECT count(*) FROM metric_snapshot WHERE work_id=w.id),
		ARRAY(SELECT DISTINCT metric_node(day_offset) FROM metric_snapshot WHERE work_id=w.id AND metric_node(day_offset) IS NOT NULL ORDER BY 1)
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.status IN ('pushed','packed','published')
		ORDER BY coalesce(w.published_at, w.updated_at) DESC LIMIT 200`, a.ID)
	if err != nil {
		return err
	}
	list := []BoardRow{}
	for rows.Next() {
		var b BoardRow
		if err := rows.Scan(&b.ID, &b.Title, &b.Status, &b.PublishedAt, &b.Points, &b.Nodes); err != nil {
			rows.Close()
			return err
		}
		list = append(list, b)
	}
	rows.Close()
	for i := range list {
		if list[i].Points == 0 {
			continue
		}
		m, err := scanMetric(s.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE id=(SELECT metric_id FROM work_metric_d7 WHERE work_id=$1)`, list[i].ID))
		if err == nil {
			list[i].D7 = &m
		}
	}
	return ok(w, list)
}

func (s *Server) listMetrics(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("view") == "nodes" {
		var publishedAt *time.Time
		if err := s.db.QueryRow(r.Context(), `SELECT published_at FROM work WHERE id=$1`, m.ID).Scan(&publishedAt); err != nil {
			return err
		}
		out, err := s.metricNodesView(r.Context(), m.ID, publishedAt)
		if err != nil {
			return err
		}
		return ok(w, out)
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+metricCols+` FROM metric_snapshot WHERE work_id=$1 ORDER BY day_offset NULLS LAST, captured_at`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Metric{}
	for rows.Next() {
		x, err := scanMetric(rows)
		if err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

type metricInput struct {
	CapturedAt    *time.Time `json:"captured_at"`
	Reads         *int       `json:"reads"`
	Likes         *int       `json:"likes"`
	Wows          *int       `json:"wows"`
	Favorites     *int       `json:"favorites"`
	Comments      *int       `json:"comments"`
	Shares        *int       `json:"shares"`
	FollowsGained *int       `json:"follows_gained"`
	Note          string     `json:"note"`
}

func (in *metricInput) validate() error {
	for _, v := range []*int{in.Reads, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained} {
		if v != nil && *v < 0 {
			return validation("数据不能为负数")
		}
	}
	if in.Reads == nil && in.Likes == nil && in.Wows == nil && in.Favorites == nil && in.Comments == nil && in.Shares == nil && in.FollowsGained == nil {
		return validation("至少填写一项数据")
	}
	return nil
}

func (s *Server) createMetric(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Status != "pushed" && m.Status != "packed" && m.Status != "published" {
		return stateInvalid("作品发布后才能录入数据")
	}
	var in metricInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	at := s.now()
	if in.CapturedAt != nil {
		at = *in.CapturedAt
	}
	x, merged, err := upsertMetric(r.Context(), s.db, metricWrite{WorkID: m.ID, CapturedAt: at, Source: "manual",
		Reads: in.Reads, Likes: in.Likes, Wows: in.Wows, Favorites: in.Favorites, Comments: in.Comments, Shares: in.Shares,
		FollowsGained: in.FollowsGained, Note: strings.TrimSpace(in.Note)})
	if err != nil {
		return err
	}
	return ok(w, struct {
		Metric
		Merged bool `json:"merged"`
	}{x, merged})
}

func (s *Server) metricOwned(r *http.Request) (uuid.UUID, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return uuid.Nil, err
	}
	var workID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT work_id FROM metric_snapshot WHERE id=$1`, id).Scan(&workID); err != nil {
		return uuid.Nil, err
	}
	if _, err := s.workMeta(r.Context(), workID); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

func (s *Server) updateMetric(w http.ResponseWriter, r *http.Request) error {
	id, err := s.metricOwned(r)
	if err != nil {
		return err
	}
	var in metricInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.validate(); err != nil {
		return err
	}
	x, err := scanMetric(s.db.QueryRow(r.Context(), `UPDATE metric_snapshot SET captured_at=coalesce($2, captured_at), reads=$3, likes=$4, wows=$5, favorites=$6,
		comments=$7, shares=$8, follows_gained=$9, note=$10 WHERE id=$1 RETURNING `+metricCols, id, in.CapturedAt, in.Reads, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained, strings.TrimSpace(in.Note)))
	if isUniqueViolation(err) {
		return validation("这篇作品在该发布天数已经有一条同来源的数据，请直接编辑那一条")
	}
	if err != nil {
		return err
	}
	return ok(w, x)
}

func (s *Server) deleteMetric(w http.ResponseWriter, r *http.Request) error {
	id, err := s.metricOwned(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM metric_snapshot WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

type ReviewContent struct {
	Conclusions      []string `json:"conclusions"`
	TopicSuggestions []struct {
		Title  string `json:"title"`
		Angle  string `json:"angle"`
		Reason string `json:"reason"`
	} `json:"topic_suggestions"`
	WritingInsights []string `json:"writing_insights"`
}

type ReviewReport struct {
	ID         uuid.UUID     `json:"id"`
	WorkIDs    []uuid.UUID   `json:"work_ids"`
	Content    ReviewContent `json:"content"`
	Adopted    []int32       `json:"adopted"`
	Remembered []int32       `json:"remembered"`
	Ignored    []int32       `json:"ignored"`
	Origin     string        `json:"origin"` // manual | weekly_draft
	CreatedAt  time.Time     `json:"created_at"`
}

// createReview only produces suggestions; nothing is written to the topic pool (H-08, HC-08).
func (s *Server) createReview(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		WorkIDs    []uuid.UUID `json:"work_ids"`
		Recent     int         `json:"recent"`
		Background bool        `json:"background"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if in.Background {
		jobID, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "review_analysis", Label: "AI 复盘 · " + a.Name, AccountID: &a.ID,
			Link: "/a/" + a.ID.String() + "/review"}, func(jctx context.Context) (any, error) {
			rep, err := s.buildReview(jctx, a, in.WorkIDs, in.Recent)
			if err != nil {
				return nil, err
			}
			return map[string]any{"report_id": rep.ID}, nil
		})
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"job_id": jobID})
	}
	rep, err := s.buildReview(ctx, a, in.WorkIDs, in.Recent)
	if err != nil {
		return err
	}
	return ok(w, rep)
}

func (s *Server) buildReview(ctx context.Context, a *Account, workIDs []uuid.UUID, recent int) (*ReviewReport, error) {
	return s.buildReviewAs(ctx, a, workIDs, recent, "manual", "")
}

// buildReviewAs records who started the review (origin) and may force a cost tier (weekly drafts run on economy).
func (s *Server) buildReviewAs(ctx context.Context, a *Account, workIDs []uuid.UUID, recent int, origin, tier string) (*ReviewReport, error) {
	ids := workIDs
	if len(ids) == 0 {
		n := recent
		if n <= 0 || n > 30 {
			n = 10
		}
		rows, err := s.db.Query(ctx, `SELECT w.id FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL
			AND EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id) ORDER BY coalesce(w.published_at, w.updated_at) DESC LIMIT $2`, a.ID, n)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			_ = rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}
	if len(ids) == 0 {
		return nil, validation("还没有录入过数据的作品，请先在看板中录入数据")
	}
	var b strings.Builder
	var used []uuid.UUID
	for _, id := range ids {
		var title, status string
		var publishedAt *time.Time
		if err := s.db.QueryRow(ctx, `SELECT title, status, published_at FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, id, a.ID).
			Scan(&title, &status, &publishedAt); err != nil {
			continue
		}
		used = append(used, id)
		fmt.Fprintf(&b, "### 《%s》", title)
		if publishedAt != nil {
			fmt.Fprintf(&b, "（发布于 %s）", publishedAt.In(s.loc).Format("2006-01-02 15:04"))
		}
		b.WriteString("\n")
		rows, err := s.db.Query(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE work_id=$1 ORDER BY day_offset NULLS LAST, captured_at`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			m, err := scanMetric(rows)
			if err != nil {
				break
			}
			fmt.Fprintf(&b, "- %s（%s 采集）：%s\n", dayOffsetLabel(m.DayOffset), m.CapturedAt.In(s.loc).Format("01-02"), metricLine(m))
		}
		rows.Close()
	}
	if len(used) == 0 {
		return nil, validation("所选作品不存在")
	}
	user := "## 作品及数据\n" + b.String() + `
## 任务说明
根据以上作品数据做复盘：作品之间比较时以"第 7 天数据"为准（没有第 7 天的按最接近的天数，并说明），不要拿不同天数的数字直接比较。总结哪些做法有效、哪些无效（结论要基于数据，不要编造），并给出不少于 3 条下一步的选题建议。另外给出写作层面的结论（如标题、开头、结构上的规律），每条一句可执行的规则，没有依据时可以为空。

## 输出格式
只输出 JSON：{"conclusions":["结论"],"topic_suggestions":[{"title":"选题标题","angle":"切入角度","reason":"依据"}],"writing_insights":["写作层面的规律"]}`
	var out ReviewContent
	res, err := s.runAIJSON(ctx, aiTask{Type: "review_analysis", Account: a, User: user, SkipStyle: true, Tier: tier, Refs: map[string]any{"works": len(used), "origin": origin}}, &out, func() error {
		if len(out.TopicSuggestions) < 3 {
			return fmt.Errorf("建议少于 3 条")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	content, _ := json.Marshal(out)
	var rep ReviewReport
	if err := s.db.QueryRow(ctx, `INSERT INTO review_report (account_id, work_ids, content, ai_call_id, origin) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
		a.ID, used, content, res.CallID, origin).Scan(&rep.ID, &rep.CreatedAt); err != nil {
		return nil, err
	}
	rep.Origin = origin
	if out.WritingInsights == nil {
		out.WritingInsights = []string{}
	}
	rep.WorkIDs, rep.Content, rep.Adopted, rep.Remembered, rep.Ignored = used, out, []int32{}, []int32{}, []int32{}
	return &rep, nil
}

// rememberInsight turns one writing insight into an active memory (EX-J-03); the click is the human confirmation.
func (s *Server) rememberInsight(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var remembered []int32
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, remembered FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &remembered); err != nil {
		return err
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.WritingInsights) {
		return validation("结论不存在")
	}
	for _, x := range remembered {
		if int(x) == idx {
			return stateInvalid("这条结论已经记住了")
		}
	}
	text := truncate(strings.TrimSpace(rc.WritingInsights[idx]), 200)
	uid := ident(ctx).UserID
	var memID uuid.UUID
	err = s.withTx(ctx, func(q pgx.Tx) error {
		ev, _ := json.Marshal(map[string]any{"review_report_id": id, "index": idx})
		if err := q.QueryRow(ctx, `INSERT INTO account_memory (account_id, kind, scope, text, status, source, evidence, created_by, confirmed_by, confirmed_at)
			VALUES ($1,$2,'all',$3,'active','review',$4,$5,$5,now()) RETURNING id`, accountID, guessMemoryKind(text), text, ev, uid).Scan(&memID); err != nil {
			return err
		}
		_, err := q.Exec(ctx, `UPDATE review_report SET remembered = array_append(remembered, $2) WHERE id=$1`, id, idx)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "memory_confirm", "account_memory", memID.String(), "ok", map[string]any{"source": "review"})
	return ok(w, map[string]any{"memory_id": memID})
}

// ignoreInsight hides one writing insight for good and counts it as a rejected AI output.
func (s *Server) ignoreInsight(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var callID *uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, ai_call_id FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &callID); err != nil {
		return err
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.WritingInsights) {
		return validation("结论不存在")
	}
	if _, err := s.db.Exec(ctx, `UPDATE review_report SET ignored = array_append(ignored, $2) WHERE id=$1 AND NOT ($2 = ANY(ignored)) AND NOT ($2 = ANY(remembered))`, id, idx); err != nil {
		return err
	}
	if callID != nil {
		reason := "其他"
		note := "忽略写作结论：" + truncate(rc.WritingInsights[idx], 80)
		o := "rejected"
		if err := s.recordFeedback(ctx, *callID, feedbackInput{Outcome: &o, ReasonTags: []string{reason}, Note: &note}); err != nil {
			slog.Warn("记录 AI 反馈失败", "err", err)
		}
	}
	return ok(w, map[string]any{"ok": true})
}

func metricLine(m Metric) string {
	var parts []string
	add := func(label string, v *int) {
		if v != nil {
			parts = append(parts, fmt.Sprintf("%s %d", label, *v))
		}
	}
	add("阅读", m.Reads)
	add("点赞", m.Likes)
	add("在看", m.Wows)
	add("收藏", m.Favorites)
	add("评论", m.Comments)
	add("分享", m.Shares)
	add("涨粉", m.FollowsGained)
	if m.Note != "" {
		parts = append(parts, "备注："+m.Note)
	}
	return strings.Join(parts, "，")
}

func (s *Server) listReviews(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, work_ids, content, adopted, remembered, ignored, origin, created_at FROM review_report WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []ReviewReport{}
	for rows.Next() {
		var rep ReviewReport
		var content []byte
		if err := rows.Scan(&rep.ID, &rep.WorkIDs, &content, &rep.Adopted, &rep.Remembered, &rep.Ignored, &rep.Origin, &rep.CreatedAt); err != nil {
			return err
		}
		_ = json.Unmarshal(content, &rep.Content)
		if rep.Content.WritingInsights == nil {
			rep.Content.WritingInsights = []string{}
		}
		list = append(list, rep)
	}
	return ok(w, list)
}

// adoptSuggestion moves exactly one suggestion into the topic pool (H-08).
func (s *Server) adoptSuggestion(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var adopted []int32
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, adopted FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &adopted); err != nil {
		return err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.TopicSuggestions) {
		return validation("建议不存在")
	}
	for _, x := range adopted {
		if int(x) == idx {
			return stateInvalid("这条建议已经采纳过了")
		}
	}
	sug := rc.TopicSuggestions[idx]
	var topicID uuid.UUID
	err = s.withTx(ctx, func(q pgx.Tx) error {
		if err := q.QueryRow(ctx, `INSERT INTO topic (account_id, title, angle, source, review_report_id) VALUES ($1,$2,$3,'review',$4) RETURNING id`,
			a.ID, truncateRunes(sug.Title, 64), sug.Angle, id).Scan(&topicID); err != nil {
			return err
		}
		_, err := q.Exec(ctx, `UPDATE review_report SET adopted = array_append(adopted, $2) WHERE id=$1`, id, idx)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "review_adopt", "topic", topicID.String(), "ok", map[string]any{"report": id.String(), "index": idx})
	var callID *uuid.UUID
	if s.db.QueryRow(ctx, `SELECT ai_call_id FROM review_report WHERE id=$1`, id).Scan(&callID) == nil && callID != nil {
		s.implicitFeedback(ctx, *callID, "accepted", &idx, nil)
	}
	return ok(w, map[string]any{"topic_id": topicID})
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	counts := map[string]int{}
	var countsRaw, limitRaw []byte
	var pendingTopics, todayPush, tokensToday, samples int
	var aiReady, profileReady bool
	err = s.db.QueryRow(ctx, `WITH status_counts AS (
		SELECT status, count(*) AS n FROM work WHERE account_id=$1 AND deleted_at IS NULL GROUP BY status
	) SELECT
		coalesce((SELECT jsonb_object_agg(status,n) FROM status_counts),'{}'::jsonb),
		(SELECT count(*) FROM topic WHERE account_id=$1 AND status='pending' AND deleted_at IS NULL),
		(SELECT count(*) FROM push_record WHERE account_id=$1 AND status='ok' AND created_at >= $3),
		(SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM ai_call WHERE workspace_id=$2 AND created_at >= $3),
		EXISTS(SELECT 1 FROM model_route r JOIN model_provider p ON p.id=r.provider_id
			WHERE r.workspace_id=$2 AND p.workspace_id=$2 AND r.task_type='default' AND p.status='active'),
		(SELECT count(*) FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL),
		EXISTS(SELECT 1 FROM account_profile WHERE account_id=$1 AND
			(cardinality(positioning_tags)>0 OR target_audience<>'' OR persona_tone<>'')),
		coalesce((SELECT value FROM app_setting WHERE workspace_id=$2 AND key='ai_limit'),
			'{"enabled":false,"daily_tokens":2000000}'::jsonb)`, a.ID, ident(ctx).WorkspaceID, s.today()).Scan(
		&countsRaw, &pendingTopics, &todayPush, &tokensToday, &aiReady, &samples, &profileReady, &limitRaw)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(countsRaw, &counts); err != nil {
		return err
	}
	limit := aiLimit{DailyTokens: 2000000}
	_ = json.Unmarshal(limitRaw, &limit)
	type todo struct {
		WorkID uuid.UUID `json:"work_id"`
		Title  string    `json:"title"`
		Status string    `json:"status"`
		Kind   string    `json:"kind"`
		Hint   string    `json:"hint"`
		At     time.Time `json:"at"`
		Node   *int      `json:"node,omitempty"`
	}
	todos := []todo{}
	due := nodeDueExpr(2, 3)
	trows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.status, w.updated_at, `+due+`
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND (w.status <> 'published' OR `+due+` IS NOT NULL)
		ORDER BY w.updated_at DESC LIMIT 30`, a.ID, s.now(), datacubeCovers(a))
	if err != nil {
		return err
	}
	for trows.Next() {
		var t todo
		if err := trows.Scan(&t.WorkID, &t.Title, &t.Status, &t.At, &t.Node); err != nil {
			trows.Close()
			return err
		}
		switch t.Status {
		case "drafting":
			t.Kind, t.Hint = "write", "继续写作"
		case "checking":
			t.Kind, t.Hint = "check", "发布前检查待确认"
		case "ready":
			if a.Platform == "wechat_mp" {
				t.Kind, t.Hint = "push", "已通过检查，可写入草稿箱"
			} else {
				t.Kind, t.Hint = "pack", "已通过检查，可生成发布包"
			}
		case "pushed", "packed":
			t.Kind, t.Hint = "publish", "在平台发布后回来标记已发布"
		case "published":
			if t.Node == nil {
				continue
			}
			t.Kind, t.Hint = "metric", fmt.Sprintf("录入第 %d 天数据", *t.Node)
		}
		todos = append(todos, t)
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"account":        a,
		"counts":         counts,
		"todos":          todos,
		"pending_topics": pendingTopics,
		"today_push":     todayPush,
		"daily_limit":    a.DailyPushLimit,
		"tokens_today":   tokensToday,
		"ai_limit":       limit,
		"setup": map[string]bool{
			"ai":         aiReady,
			"profile":    profileReady,
			"samples":    samples > 0,
			"credential": a.Platform != "wechat_mp" || (a.Credential != nil && a.Credential.State == "ok"),
		},
	})
}
