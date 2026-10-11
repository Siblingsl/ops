package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 计划与节奏：作品计划字段、内容日历（只做计划，HC-16）、智能下一步、账号健康度、本周节奏、回填链接解析。

type postPushTodo struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Done  bool   `json:"done"`
}

type workPlanning struct {
	planned  *string
	target   *int
	review   *bool
	assignee *string
	reviewer *string
	todos    json.RawMessage
}

// memberID validates an optional workspace member id; "" clears the field.
func (s *Server) memberID(ctx context.Context, raw, label string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	u, err := uuid.Parse(raw)
	if err != nil {
		return nil, validation(label + "不存在")
	}
	var x uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT user_id FROM workspace_member WHERE user_id=$1 AND workspace_id=$2 AND status='active'`, u, ident(ctx).WorkspaceID).Scan(&x); err != nil {
		return nil, validation(label + "必须是本工作区成员")
	}
	return &u, nil
}

// applyWorkPlanning updates fields that never count as content changes (no revision bump, checks stay valid).
func (s *Server) applyWorkPlanning(ctx context.Context, m *workMeta, p workPlanning) error {
	planned, target, review, assignee, todos := p.planned, p.target, p.review, p.assignee, p.todos
	if planned != nil {
		var v any
		if *planned != "" {
			if _, err := time.Parse("2006-01-02", *planned); err != nil {
				return validation("计划发布日格式不正确")
			}
			v = *planned
		}
		if _, err := s.db.Exec(ctx, `UPDATE work SET planned_date=$2::date WHERE id=$1`, m.ID, v); err != nil {
			return err
		}
	}
	if target != nil {
		var v any
		if *target != 0 {
			if *target < 50 || *target > 100000 {
				return validation("目标字数在 50 到 100000 之间")
			}
			v = *target
		}
		if _, err := s.db.Exec(ctx, `UPDATE work SET target_chars=$2 WHERE id=$1`, m.ID, v); err != nil {
			return err
		}
	}
	if review != nil {
		if _, err := s.db.Exec(ctx, `UPDATE work SET review_required=$2,
			status = CASE WHEN $2 AND status='ready' AND reviewed_at IS NULL THEN 'reviewing' WHEN NOT $2 AND status='reviewing' THEN 'ready' ELSE status END
			WHERE id=$1`, m.ID, *review); err != nil {
			return err
		}
	}
	if assignee != nil {
		v, err := s.memberID(ctx, *assignee, "负责人")
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE work SET assignee_id=$2 WHERE id=$1`, m.ID, v); err != nil {
			return err
		}
		s.audit(ctx, "work_assign", "work", m.ID.String(), "ok", map[string]any{"assignee": v})
		if v != nil && *v != ident(ctx).UserID {
			s.notify(ctx, ident(ctx).WorkspaceID, *v, "assigned", "你被指派为"+titleOr(m.Title)+"的负责人", "", "/works/"+m.ID.String(), "")
		}
	}
	if p.reviewer != nil {
		v, err := s.memberID(ctx, *p.reviewer, "审阅人")
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE work SET reviewer_id=$2 WHERE id=$1`, m.ID, v); err != nil {
			return err
		}
		s.audit(ctx, "work_reviewer", "work", m.ID.String(), "ok", map[string]any{"reviewer": v})
		if v != nil && *v != ident(ctx).UserID {
			s.notify(ctx, ident(ctx).WorkspaceID, *v, "assigned", "你被指定为"+titleOr(m.Title)+"的审阅人", "检查完成后会通知你审阅", "/works/"+m.ID.String()+"/check", "")
		}
	}
	if len(todos) > 0 {
		var list []postPushTodo
		if err := json.Unmarshal(todos, &list); err != nil || len(list) > 20 {
			return validation("后台待办格式不正确")
		}
		for i := range list {
			list[i].Label = truncateRunes(strings.TrimSpace(list[i].Label), 60)
			if list[i].Key == "" {
				list[i].Key = strconv.Itoa(i)
			}
		}
		b, _ := json.Marshal(list)
		if _, err := s.db.Exec(ctx, `UPDATE work SET post_push_todos=$2 WHERE id=$1`, m.ID, b); err != nil {
			return err
		}
	}
	return nil
}

// setPostPushTodos ticks the back-office checklist; it is bookkeeping, so it stays allowed after the work is locked as published.
func (s *Server) setPostPushTodos(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Todos json.RawMessage `json:"todos"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Todos) == 0 {
		return validation("后台待办格式不正确")
	}
	if err := s.applyWorkPlanning(r.Context(), m, workPlanning{todos: in.Todos}); err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

// setTitleFavorites stores the starred title candidates (EX-E-07); it never changes the title itself.
func (s *Server) setTitleFavorites(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Items []struct {
			Text  string `json:"text"`
			Style string `json:"style"`
		} `json:"items"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	type fav struct {
		Text  string `json:"text"`
		Style string `json:"style"`
	}
	list := []fav{}
	seen := map[string]bool{}
	for _, x := range in.Items {
		t := truncateRunes(strings.TrimSpace(x.Text), 64)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		list = append(list, fav{t, truncateRunes(strings.TrimSpace(x.Style), 20)})
	}
	if len(list) > 20 {
		return validation("最多收藏 20 个标题候选")
	}
	b, _ := json.Marshal(list)
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET title_favorites=$2 WHERE id=$1`, m.ID, b); err != nil {
		return err
	}
	return ok(w, list)
}

type CalendarItem struct {
	Kind        string     `json:"kind"` // work | topic
	ID          uuid.UUID  `json:"id"`
	AccountID   uuid.UUID  `json:"account_id"`
	AccountName string     `json:"account_name"`
	Platform    string     `json:"platform"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	Date        string     `json:"date"`
	DateKind    string     `json:"date_kind"` // planned | published
	WorkID      *uuid.UUID `json:"work_id,omitempty"`
}

// calendar lists planned and published dates; it is planning only — nothing is ever published on a date (HC-16).
func (s *Server) calendar(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	q := r.URL.Query()
	from, err := time.ParseInLocation("2006-01-02", q.Get("from"), s.loc)
	if err != nil {
		from = truncDay(s.now().In(s.loc)).AddDate(0, 0, -7)
	}
	to, err := time.ParseInLocation("2006-01-02", q.Get("to"), s.loc)
	if err != nil {
		to = from.AddDate(0, 0, 42)
	}
	if to.Sub(from) > 200*24*time.Hour {
		return validation("日历范围最多 200 天")
	}
	ws := ident(ctx).WorkspaceID
	args := []any{ws, from.Format("2006-01-02"), to.Format("2006-01-02")}
	accFilter := ""
	if aid := q.Get("account_id"); aid != "" {
		u, err := uuid.Parse(aid)
		if err != nil {
			return validation("账号不存在")
		}
		args = append(args, u)
		accFilter = " AND a.id=$4"
	}
	list := []CalendarItem{}
	rows, err := s.db.Query(ctx, `SELECT w.id, a.id, a.name, a.platform, w.title, w.status,
		CASE WHEN w.published_at IS NOT NULL THEN to_char(w.published_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') ELSE to_char(w.planned_date,'YYYY-MM-DD') END,
		CASE WHEN w.published_at IS NOT NULL THEN 'published' ELSE 'planned' END
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE a.workspace_id=$1 AND w.deleted_at IS NULL`+accFilter+`
		AND ((w.published_at IS NOT NULL AND (w.published_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $2::date AND $3::date)
		  OR (w.published_at IS NULL AND w.planned_date BETWEEN $2::date AND $3::date))
		ORDER BY 7`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var x CalendarItem
		if err := rows.Scan(&x.ID, &x.AccountID, &x.AccountName, &x.Platform, &x.Title, &x.Status, &x.Date, &x.DateKind); err != nil {
			rows.Close()
			return err
		}
		x.Kind = "work"
		list = append(list, x)
	}
	rows.Close()
	trows, err := s.db.Query(ctx, `SELECT t.id, a.id, a.name, a.platform, t.title, t.status, to_char(t.planned_date,'YYYY-MM-DD')
		FROM topic t JOIN platform_account a ON a.id=t.account_id
		WHERE a.workspace_id=$1 AND t.deleted_at IS NULL AND t.status<>'dropped' AND t.planned_date BETWEEN $2::date AND $3::date`+accFilter+`
		AND NOT EXISTS (SELECT 1 FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL) ORDER BY t.planned_date`, args...)
	if err != nil {
		return err
	}
	for trows.Next() {
		var x CalendarItem
		if err := trows.Scan(&x.ID, &x.AccountID, &x.AccountName, &x.Platform, &x.Title, &x.Status, &x.Date); err != nil {
			trows.Close()
			return err
		}
		x.Kind, x.DateKind = "topic", "planned"
		list = append(list, x)
	}
	trows.Close()
	return ok(w, map[string]any{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "items": list})
}

func (s *Server) getNextActions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 3
	}
	limit = min(limit, 10)
	in := naInput{Now: s.now().In(s.loc), AccountID: a.ID, Platform: a.Platform, WriteEndingFirst: s.userPrefs(ctx).WriteEndingFirst,
		IsOwner: ident(ctx).Role == "owner"}
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.status, w.updated_at, w.published_at, w.planned_date, w.outline_confirmed_at IS NOT NULL,
		w.viewpoint<>'', `+nodeDueExpr(2, 3)+`,
		(SELECT count(*) FROM jsonb_array_elements(w.post_push_todos) e WHERE NOT coalesce((e->>'done')::boolean,false)),
		w.status IN ('pushed','packed','published'),
		(SELECT count(*) FROM check_item ci JOIN check_run cr ON cr.id=ci.check_run_id WHERE cr.work_id=w.id AND cr.revision=w.revision AND NOT ci.passed AND ci.resolution IS NULL),
		coalesce((SELECT array_agg(s.id ORDER BY s.position, s.created_at) FROM work_section s WHERE s.work_id=w.id AND s.deleted_at IS NULL AND btrim(s.content_md)=''), '{}')
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND (w.status<>'published' OR w.published_at > $2::timestamptz - interval '30 days'
			OR EXISTS (SELECT 1 FROM jsonb_array_elements(w.post_push_todos) e WHERE NOT coalesce((e->>'done')::boolean,false)))
		ORDER BY w.updated_at DESC LIMIT 100`, a.ID, s.now(), datacubeCovers(a))
	if err != nil {
		return err
	}
	for rows.Next() {
		var x naWork
		var planned *time.Time
		if err := rows.Scan(&x.ID, &x.Title, &x.Status, &x.UpdatedAt, &x.PublishedAt, &planned, &x.OutlineConfirmed, &x.Viewpoint, &x.DueNode,
			&x.OpenTodos, &x.PushedOrPacked, &x.PendingCheckItems, &x.EmptySections); err != nil {
			rows.Close()
			return err
		}
		if planned != nil {
			p := time.Date(planned.Year(), planned.Month(), planned.Day(), 0, 0, 0, 0, s.loc)
			x.PlannedDate = &p
		}
		if x.PublishedAt == nil && x.PushedOrPacked {
			t := x.UpdatedAt
			x.PublishedAt = &t
		}
		in.Works = append(in.Works, x)
	}
	rows.Close()
	var first *uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT count(*) OVER (), id FROM topic t WHERE account_id=$1 AND deleted_at IS NULL AND status='adopted'
		AND NOT EXISTS (SELECT 1 FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL) ORDER BY created_at LIMIT 1`, a.ID).Scan(&in.AdoptedNotStarted, &first)
	in.FirstAdoptedTopic = first
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM account_memory WHERE account_id=$1 AND status='suggested'`, a.ID).Scan(&in.PendingMemories)
	if daily, e := s.latestDaily(ctx, a, s.today().Format("2006-01-02")); e == nil && daily != nil {
		for _, x := range daily.Items {
			if x.Action == "" {
				in.PendingDaily++
			}
		}
	}
	var aiReady bool
	_ = s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM model_route r JOIN model_provider p ON p.id=r.provider_id
		WHERE r.workspace_id=$1 AND p.workspace_id=$1 AND r.task_type='default' AND p.status='active')`, ident(ctx).WorkspaceID).Scan(&aiReady)
	in.AIMissing = !aiReady
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM metric_unmatched WHERE account_id=$1 AND status='pending'`, a.ID).Scan(&in.Unmatched)
	_ = s.db.QueryRow(ctx, `SELECT greatest(coalesce(jsonb_array_length(content->'topic_suggestions'),0) - coalesce(cardinality(adopted),0), 0)
		FROM review_report WHERE account_id=$1 AND origin='weekly_draft' AND created_at > $2 ORDER BY created_at DESC LIMIT 1`,
		a.ID, s.now().AddDate(0, 0, -14)).Scan(&in.DraftPending)
	return ok(w, nextActions(in, limit))
}

type HealthItem struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Score int    `json:"score"`
	Max   int    `json:"max"`
	Hint  string `json:"hint"`
	Link  string `json:"link"`
}

// accountHealth answers "AI 对这个账号了解得够不够" with pure rules (EX-A-02).
func (s *Server) accountHealth(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	p, err := s.loadProfile(ctx, a.ID)
	if err != nil {
		return err
	}
	acc := "/a/" + a.ID.String()
	items := []HealthItem{}
	prof := 0
	var missing []string
	check := func(okField bool, name string) {
		if okField {
			prof += 6
		} else {
			missing = append(missing, name)
		}
	}
	check(len(p.PositioningTags) > 0, "定位标签")
	check(strings.TrimSpace(p.TargetAudience) != "", "目标读者")
	check(strings.TrimSpace(p.PersonaTone) != "", "人设与语气")
	check(len(p.BannedWords) > 0, "禁用词")
	check(strings.TrimSpace(p.StyleSummary) != "", "风格摘要")
	items = append(items, HealthItem{Key: "profile", Label: "档案完整度", Score: prof, Max: 30, Hint: hintMissing(missing), Link: acc + "/profile"})

	var samples, sampleChars int
	_ = s.db.QueryRow(ctx, `SELECT count(*), coalesce(sum(char_length(content_md)),0) FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL`, a.ID).Scan(&samples, &sampleChars)
	st := min(samples, 5)*3 + min(sampleChars, 5000)*10/5000
	items = append(items, HealthItem{Key: "style", Label: "风格样本", Score: st, Max: 25, Hint: hintIf(st < 25, "建议至少 5 篇、共 5000 字的样本"), Link: acc + "/profile?tab=samples"})

	var mats int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM material WHERE workspace_id=$1 AND deleted_at IS NULL AND (account_id=$2 OR account_id IS NULL)`, ident(ctx).WorkspaceID, a.ID).Scan(&mats)
	ms := min(mats, 20)
	items = append(items, HealthItem{Key: "materials", Label: "素材数量", Score: ms, Max: 20, Hint: hintIf(ms < 20, "素材是 AI 唯一的事实来源，建议至少 20 条"), Link: acc + "/materials"})

	var mems int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM account_memory WHERE account_id=$1 AND status='active'`, a.ID).Scan(&mems)
	mm := min(mems, 5) * 3
	items = append(items, HealthItem{Key: "memory", Label: "已确认的 AI 记忆", Score: mm, Max: 15, Hint: hintIf(mm < 15, "确认或添加几条写作偏好，AI 会更懂你"), Link: acc + "/profile?tab=memory"})

	due, covered, err := s.metricNodeCoverage(ctx, a.ID, 30)
	if err != nil {
		return err
	}
	md, mdHint := 0, "发布作品后按第 1、3、7 天录入数据，复盘和标题建议会更准"
	if due > 0 {
		md = covered * 10 / due
		mdHint = hintIf(md < 10, fmt.Sprintf("近 30 天已到期的数据节点 %d 个，已录 %d 个；补齐后复盘更准", due, covered))
	}
	items = append(items, HealthItem{Key: "metrics", Label: "近 30 天复盘数据", Score: md, Max: 10, Hint: mdHint, Link: acc + "/review"})

	ops, e := s.opsHealth(ctx, a.ID)
	if e != nil {
		return e
	}
	items = append(items, ops...)
	total := 0
	for _, it := range items {
		total += it.Score
	}
	return ok(w, map[string]any{"score": total * 100 / 120, "raw_score": total, "raw_max": 120, "items": items})
}

func hintMissing(m []string) string {
	if len(m) == 0 {
		return ""
	}
	return "还缺：" + strings.Join(m, "、")
}

func hintIf(c bool, s string) string {
	if c {
		return s
	}
	return ""
}

// accountRhythm is the 本周节奏 card: published / planned this week vs the past 4 weeks' average (EX-B-03).
func (s *Server) accountRhythm(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	now := s.now().In(s.loc)
	wd := (int(now.Weekday()) + 6) % 7
	weekStart := truncDay(now).AddDate(0, 0, -wd)
	var published, planned, past int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND coalesce(published_at, CASE WHEN status IN ('pushed','packed') THEN updated_at END) >= $2`,
		a.ID, weekStart).Scan(&published)
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND planned_date BETWEEN $2::date AND ($2::date + 6)`,
		a.ID, weekStart.Format("2006-01-02")).Scan(&planned)
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL
		AND coalesce(published_at, CASE WHEN status IN ('pushed','packed') THEN updated_at END) BETWEEN $2 AND $3`,
		a.ID, weekStart.AddDate(0, 0, -28), weekStart).Scan(&past)
	return ok(w, map[string]any{"week_start": weekStart.Format("2006-01-02"), "published": published, "planned": planned,
		"past_avg": float64(past) / 4})
}

type PublishLinkInfo struct {
	Platform    string     `json:"platform"`
	PublishedAt *time.Time `json:"published_at"`
	Note        string     `json:"note"`
}

// parsePublishLink recognises the platform and, when the link itself carries it, the publish time.
// It never fetches the link (EX-I-02).
func parsePublishLink(raw string) PublishLinkInfo {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return PublishLinkInfo{Note: "无法识别这个链接，请手动选择平台"}
	}
	host := strings.ToLower(u.Hostname())
	info := PublishLinkInfo{}
	switch {
	case host == "mp.weixin.qq.com":
		info.Platform = "wechat_mp"
		for _, k := range []string{"timestamp", "publish_time", "t"} {
			if v := u.Query().Get(k); v != "" {
				if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 1e9 && n < 1e10 {
					t := time.Unix(n, 0)
					info.PublishedAt = &t
					break
				}
			}
		}
	case host == "xiaohongshu.com" || strings.HasSuffix(host, ".xiaohongshu.com") || host == "xhslink.com" || strings.HasSuffix(host, ".xhslink.com"):
		info.Platform = "xhs"
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		id := parts[len(parts)-1]
		if len(id) == 24 {
			if n, err := strconv.ParseInt(id[:8], 16, 64); err == nil && n > 1e9 && n < 1e10 {
				t := time.Unix(n, 0)
				info.PublishedAt = &t
			}
		}
	default:
		info.Note = "不是公众号或小红书的链接，请手动选择平台"
		return info
	}
	if info.PublishedAt == nil {
		info.Note = "链接中没有发布时间，请手动填写"
	}
	return info
}

func (s *Server) parsePublishLinkHandler(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		URL string `json:"url"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	return ok(w, parsePublishLink(in.URL))
}
