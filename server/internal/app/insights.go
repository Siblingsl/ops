package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

// 复盘 v2（10 文档模块 J）：归因、拆解、周报、录入提醒。统计全部基于本账号已有数据，不预测爆款。

type perfSample struct {
	WorkID       uuid.UUID
	Title        string
	PublishedAt  time.Time
	Reads        int
	Interactions int
	Chars        int
	Topics       []string
}

func (s *Server) perfSamples(ctx context.Context, accountID uuid.UUID) ([]perfSample, error) {
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, coalesce(w.published_at, w.updated_at), w.topics,
		d.reads, coalesce(d.interactions,0),
		(SELECT coalesce(sum(char_length(content_md)),0) FROM work_section ws WHERE ws.work_id=w.id AND ws.deleted_at IS NULL)
		FROM work w JOIN work_metric_d7 d ON d.work_id=w.id
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND d.reads IS NOT NULL
		ORDER BY 3 DESC LIMIT 500`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []perfSample
	for rows.Next() {
		var p perfSample
		if err := rows.Scan(&p.WorkID, &p.Title, &p.PublishedAt, &p.Topics, &p.Reads, &p.Interactions, &p.Chars); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

type AttrGroup struct {
	Value           string  `json:"value"`
	N               int     `json:"n"`
	AvgReads        float64 `json:"avg_reads"`
	AvgInteractions float64 `json:"avg_interactions"`
}

type AttrFeature struct {
	Feature string      `json:"feature"`
	Label   string      `json:"label"`
	Groups  []AttrGroup `json:"groups"`
}

func titleHasDigit(t string) bool {
	for _, r := range t {
		if unicode.IsDigit(r) || strings.ContainsRune("一二三四五六七八九十百千万", r) {
			return true
		}
	}
	return false
}

func hourBucket(h int) string {
	switch {
	case h < 6:
		return "凌晨（0–6 点）"
	case h < 11:
		return "上午（6–11 点）"
	case h < 14:
		return "中午（11–14 点）"
	case h < 18:
		return "下午（14–18 点）"
	default:
		return "晚上（18–24 点）"
	}
}

var weekdayNames = []string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}

// attributionStats groups samples by simple features; groups are compared, nothing is modelled.
func attributionStats(samples []perfSample, loc *time.Location) []AttrFeature {
	type acc struct{ n, reads, inter int }
	features := []struct {
		key, label string
		values     func(p perfSample) []string
	}{
		{"title_len", "标题长度", func(p perfSample) []string {
			n := runeLen(p.Title)
			switch {
			case n <= 15:
				return []string{"15 字以内"}
			case n <= 25:
				return []string{"16–25 字"}
			default:
				return []string{"25 字以上"}
			}
		}},
		{"title_digit", "标题含数字", func(p perfSample) []string {
			return []string{map[bool]string{true: "含数字", false: "不含数字"}[titleHasDigit(p.Title)]}
		}},
		{"title_question", "标题是提问", func(p perfSample) []string {
			q := strings.ContainsAny(p.Title, "?？") || containsAny(p.Title, "吗", "怎么", "为什么", "如何")
			return []string{map[bool]string{true: "提问式", false: "陈述式"}[q]}
		}},
		{"weekday", "发布星期", func(p perfSample) []string { return []string{weekdayNames[p.PublishedAt.In(loc).Weekday()]} }},
		{"hour", "发布时段", func(p perfSample) []string { return []string{hourBucket(p.PublishedAt.In(loc).Hour())} }},
		{"length", "正文长度", func(p perfSample) []string {
			switch {
			case p.Chars < 1000:
				return []string{"1000 字以内"}
			case p.Chars <= 2500:
				return []string{"1000–2500 字"}
			default:
				return []string{"2500 字以上"}
			}
		}},
		{"topic", "话题标签", func(p perfSample) []string { return p.Topics }},
	}
	out := []AttrFeature{}
	for _, f := range features {
		m := map[string]*acc{}
		for _, p := range samples {
			for _, v := range f.values(p) {
				if v == "" {
					continue
				}
				a := m[v]
				if a == nil {
					a = &acc{}
					m[v] = a
				}
				a.n++
				a.reads += p.Reads
				a.inter += p.Interactions
			}
		}
		groups := []AttrGroup{}
		for v, a := range m {
			groups = append(groups, AttrGroup{Value: v, N: a.n, AvgReads: float64(a.reads) / float64(a.n), AvgInteractions: float64(a.inter) / float64(a.n)})
		}
		sort.Slice(groups, func(i, j int) bool { return groups[i].AvgReads > groups[j].AvgReads })
		if f.key == "topic" && len(groups) > 8 {
			groups = groups[:8]
		}
		if len(groups) > 0 {
			out = append(out, AttrFeature{Feature: f.key, Label: f.label, Groups: groups})
		}
	}
	return out
}

const minAttributionSamples = 10

// numbersNotIn lists numbers in text that never appear in source (10 文档第 8 节"数字只能来自输入").
// Percentages and numbers above 10 must match verbatim; small counting words like "3 个亮点" are allowed.
func numbersNotIn(text, source string) []string {
	have := map[string]bool{}
	for _, m := range digitRun.FindAllString(strings.ReplaceAll(source, ",", ""), -1) {
		have[m] = true
		have[strings.TrimSuffix(m, "%")] = true
	}
	var bad []string
	for _, m := range digitRun.FindAllString(strings.ReplaceAll(text, ",", ""), -1) {
		if have[m] {
			continue
		}
		if !strings.ContainsAny(m, ".%") {
			if n, err := strconv.Atoi(m); err == nil && n <= 10 {
				continue
			}
		}
		bad = append(bad, m)
	}
	return bad
}

func (s *Server) attribution(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	samples, err := s.perfSamples(ctx, a.ID)
	if err != nil {
		return err
	}
	if len(samples) < minAttributionSamples {
		return ok(w, map[string]any{"enough": false, "samples": len(samples), "need": minAttributionSamples,
			"message": fmt.Sprintf("数据还不够：已有 %d 篇作品录入了数据，至少需要 %d 篇", len(samples), minAttributionSamples), "features": []AttrFeature{}})
	}
	feats := attributionStats(samples, s.loc)
	// DEV-A102：把样本量达标的分组对比沉淀为"读者数据偏好"，供生成端注入（DEV-A103）。
	if err := s.saveDataPreferences(ctx, a.ID, deriveDataPreferences(feats)); err != nil {
		return err
	}
	var b strings.Builder
	for _, f := range feats {
		fmt.Fprintf(&b, "### %s\n", f.Label)
		for _, g := range f.Groups {
			fmt.Fprintf(&b, "- %s：%d 篇，平均阅读 %.0f，平均互动 %.0f\n", g.Value, g.N, g.AvgReads, g.AvgInteractions)
		}
	}
	user := fmt.Sprintf(`## 本账号作品分组统计（共 %d 篇）
%s
## 任务说明
把以上分组统计翻译成 3–5 条可读结论。每条必须写明依据的样本量；某组样本少于 3 篇时只能说"倾向"，不能下结论。不要预测未来数据，不要编造统计中没有的数字。

## 输出格式
只输出 JSON：{"conclusions":[{"text":"结论","confidence":"样本量与置信度说明"}]}`, len(samples), b.String())
	var out struct {
		Conclusions []struct {
			Text       string `json:"text"`
			Confidence string `json:"confidence"`
		} `json:"conclusions"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "review_attribution", Account: a, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Conclusions) == 0 {
			return fmt.Errorf("没有结论")
		}
		for _, c := range out.Conclusions {
			if strings.TrimSpace(c.Text) == "" || !strings.ContainsAny(c.Confidence, "0123456789") {
				return fmt.Errorf("结论缺少样本量说明")
			}
			if bad := numbersNotIn(c.Text+" "+c.Confidence, user); len(bad) > 0 {
				return fmt.Errorf("结论里出现了统计中没有的数字：%s", strings.Join(bad, "、"))
			}
		}
		return nil
	})
	if err != nil {
		return ok(w, map[string]any{"enough": true, "samples": len(samples), "features": feats, "conclusions": []any{}, "ai_error": errText(err)})
	}
	if len(out.Conclusions) > 5 {
		out.Conclusions = out.Conclusions[:5]
	}
	return ok(w, map[string]any{"enough": true, "samples": len(samples), "features": feats, "conclusions": out.Conclusions, "ai_call_id": res.CallID})
}

// topWorks returns the account's own best performers (top 10%, at least one) that may be broken down.
func (s *Server) topWorks(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	samples, err := s.topSamples(r.Context(), a.ID)
	if err != nil {
		return err
	}
	type top struct {
		WorkID       uuid.UUID `json:"work_id"`
		Title        string    `json:"title"`
		Reads        int       `json:"reads"`
		Interactions int       `json:"interactions"`
	}
	list := []top{}
	for _, p := range samples {
		list = append(list, top{p.WorkID, p.Title, p.Reads, p.Interactions})
	}
	return ok(w, list)
}

// topSamples is the top 10% (at least one) of the account's works by reads + 5×interactions.
func (s *Server) topSamples(ctx context.Context, accountID uuid.UUID) ([]perfSample, error) {
	samples, err := s.perfSamples(ctx, accountID)
	if err != nil || len(samples) == 0 {
		return nil, err
	}
	sort.Slice(samples, func(i, j int) bool {
		return samples[i].Reads+samples[i].Interactions*5 > samples[j].Reads+samples[j].Interactions*5
	})
	return samples[:max(1, len(samples)/10)], nil
}

type Breakdown struct {
	Structure       []string `json:"structure"`
	Opening         string   `json:"opening"`
	TitleFeatures   []string `json:"title_features"`
	Angle           string   `json:"angle"`
	ReusableRules   []string `json:"reusable_rules"`
	OutlineTemplate []struct {
		Heading  string `json:"heading"`
		KeyPoint string `json:"key_point"`
	} `json:"outline_template"`
}

// breakdownWork only analyses the account's own pushed / published works (EX-J-04).
func (s *Server) breakdownWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	switch m.Status {
	case "pushed", "packed", "published":
	default:
		return stateInvalid("只能拆解本账号已发布的作品")
	}
	top, err := s.topSamples(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	inTop := false
	for _, p := range top {
		inTop = inTop || p.WorkID == m.ID
	}
	if !inTop {
		return stateInvalid("只能拆解本账号表现排名前 10% 的作品")
	}
	body, err := s.workPlainText(ctx, m.ID)
	if err != nil {
		return err
	}
	var metrics string
	var reads, inter int
	var day *int
	if s.db.QueryRow(ctx, `SELECT coalesce(reads,0), coalesce(interactions,0), day_offset FROM work_metric_d7 WHERE work_id=$1`, m.ID).
		Scan(&reads, &inter, &day) == nil && (reads > 0 || inter > 0) {
		metrics = fmt.Sprintf("阅读 %d，互动 %d（%s）", reads, inter, dayOffsetLabel(day))
	}
	user := fmt.Sprintf(`## 本账号的作品
标题：%s
数据：%s

%s
## 任务说明
拆解这篇作品为什么有效：结构（按段概括）、开头方式、标题特征、选题角度，并提炼 2–4 条以后可复用的写作规则，以及一份可复用的大纲模板（小标题 + 要点，不含本文具体内容）。

## 输出格式
只输出 JSON：{"structure":["段落作用"],"opening":"开头方式","title_features":["特征"],"angle":"选题角度","reusable_rules":["规则"],"outline_template":[{"heading":"小标题","key_point":"要点"}]}`,
		m.Title, nz(metrics, "未录入"), truncate(body, 6000))
	var out Breakdown
	res, err := s.runAIJSON(ctx, aiTask{Type: "work_breakdown", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Structure) == 0 {
			return fmt.Errorf("没有结构")
		}
		return nil
	})
	if err != nil {
		return err
	}
	out.ReusableRules = cleanList(out.ReusableRules)
	out.TitleFeatures = cleanList(out.TitleFeatures)
	return ok(w, map[string]any{"breakdown": out, "ai_call_id": res.CallID})
}

// ---------- EX-B-03 周报 ----------

type WeeklyDigest struct {
	ID        uuid.UUID       `json:"id"`
	WeekStart string          `json:"week_start"`
	Stats     json.RawMessage `json:"stats"`
	Content   json.RawMessage `json:"content"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *Server) listDigests(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, to_char(week_start,'YYYY-MM-DD'), stats, content, created_at FROM weekly_digest
		WHERE account_id=$1 ORDER BY week_start DESC LIMIT 26`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []WeeklyDigest{}
	for rows.Next() {
		var d WeeklyDigest
		if err := rows.Scan(&d.ID, &d.WeekStart, &d.Stats, &d.Content, &d.CreatedAt); err != nil {
			return err
		}
		list = append(list, d)
	}
	return ok(w, list)
}

func weekStart(t time.Time) time.Time {
	d := truncDay(t)
	off := (int(d.Weekday()) + 6) % 7
	return d.AddDate(0, 0, -off)
}

type digestStats struct {
	Published    int      `json:"published"`
	Planned      int      `json:"planned"`
	Reads        int      `json:"reads"`
	Interactions int      `json:"interactions"`
	AvgPublished float64  `json:"avg_published_4w"`
	Titles       []string `json:"titles"`
}

func (s *Server) digestStats(ctx context.Context, accountID uuid.UUID, from, to time.Time) (digestStats, error) {
	var st digestStats
	rows, err := s.db.Query(ctx, `SELECT w.title, coalesce(d.reads,0), coalesce(d.interactions,0) FROM work w
		LEFT JOIN work_metric_d7 d ON d.work_id=w.id
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.published_at >= $2 AND w.published_at < $3 ORDER BY w.published_at`, accountID, from, to)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var t string
		var rd, in int
		if rows.Scan(&t, &rd, &in) == nil {
			st.Published++
			st.Reads += rd
			st.Interactions += in
			st.Titles = append(st.Titles, t)
		}
	}
	rows.Close()
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND planned_date >= $2::date AND planned_date < $3::date`,
		accountID, from, to).Scan(&st.Planned)
	var prev int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND published_at >= $2 AND published_at < $3`,
		accountID, from.AddDate(0, 0, -28), from).Scan(&prev)
	st.AvgPublished = float64(prev) / 4
	return st, nil
}

// weeklyDigestJob generates last week's digest on Mondays; weeks without published works are skipped.
func (s *Server) weeklyDigestJob(ctx context.Context) {
	now := s.now().In(s.loc)
	if now.Weekday() != time.Monday {
		return
	}
	to := weekStart(now)
	from := to.AddDate(0, 0, -7)
	rows, err := s.db.Query(ctx, `SELECT DISTINCT a.id, a.workspace_id FROM platform_account a JOIN work w ON w.account_id=a.id
		WHERE a.status='active' AND NOT a.is_demo AND w.published_at >= $1 AND w.published_at < $2 AND w.deleted_at IS NULL`, from, to)
	if err != nil {
		return
	}
	type acc struct{ id, ws uuid.UUID }
	var list []acc
	for rows.Next() {
		var x acc
		if rows.Scan(&x.id, &x.ws) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, x := range list {
		if !s.markOnce(ctx, "digest:"+x.id.String()+":"+from.Format("2006-01-02")) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
		if err := s.generateDigest(jctx, x.id, from, to); err != nil {
			slog.Warn("生成周报失败", "account", x.id, "err", err)
		}
	}
}

func (s *Server) generateDigest(ctx context.Context, accountID uuid.UUID, from, to time.Time) error {
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	st, err := s.digestStats(ctx, a.ID, from, to)
	if err != nil || st.Published == 0 {
		return err
	}
	data := fmt.Sprintf(`## 上周数据（%s 至 %s）
发布 %d 篇（过去 4 周平均每周 %.1f 篇），计划 %d 篇；阅读合计 %d，互动合计 %d。
作品：%s
`, from.Format("01-02"), to.AddDate(0, 0, -1).Format("01-02"), st.Published, st.AvgPublished, st.Planned, st.Reads, st.Interactions,
		strings.Join(st.Titles, "；"))
	user := data + `
## 任务说明
用一段话总结上周，列出 1–3 个亮点和 1–3 个本周关注点。所有数字只能来自上面的数据。

## 输出格式
只输出 JSON：{"summary":"","highlights":[""],"next_focus":[""]}`
	var out struct {
		Summary    string   `json:"summary"`
		Highlights []string `json:"highlights"`
		NextFocus  []string `json:"next_focus"`
	}
	var callID *uuid.UUID
	if res, err := s.runAIJSON(ctx, aiTask{Type: "weekly_digest", Account: a, User: user, SkipStyle: true, Tier: "economy"}, &out, func() error {
		if strings.TrimSpace(out.Summary) == "" {
			return fmt.Errorf("周报没有总结")
		}
		all := out.Summary + " " + strings.Join(out.Highlights, " ") + " " + strings.Join(out.NextFocus, " ")
		if bad := numbersNotIn(all, data); len(bad) > 0 {
			return fmt.Errorf("周报里出现了输入数据中没有的数字：%s", strings.Join(bad, "、"))
		}
		return nil
	}); err == nil {
		callID = &res.CallID
	} else {
		out.Summary = fmt.Sprintf("上周发布 %d 篇，阅读合计 %d。", st.Published, st.Reads)
	}
	stats, _ := json.Marshal(st)
	content, _ := json.Marshal(out)
	if _, err := s.db.Exec(ctx, `INSERT INTO weekly_digest (account_id, week_start, stats, content, ai_call_id) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (account_id, week_start) DO NOTHING`, a.ID, from, stats, content, callID); err != nil {
		return err
	}
	s.notifyWorkspace(ctx, ident(ctx).WorkspaceID, []string{"owner", "editor"}, "digest", a.Name+" 上周周报已生成", truncate(out.Summary, 80),
		"/a/"+a.ID.String()+"/review?tab=digest", "digest:"+a.ID.String()+":"+from.Format("2006-01-02"))
	return nil
}

// ---------- EX-J-01 录入提醒（第 1、3、7 天） ----------

var metricReminderDays = []int{1, 3, 7}

func (s *Server) metricRemindersJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.account_id, a.workspace_id, a.name, w.published_at,
		(SELECT max(captured_at) FROM metric_snapshot m WHERE m.work_id=w.id)
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE a.status='active' AND w.deleted_at IS NULL AND w.published_at IS NOT NULL AND w.published_at > now() - interval '9 days'`)
	if err != nil {
		return
	}
	type item struct {
		id, account, ws uuid.UUID
		title, name     string
		published       time.Time
		last            *time.Time
	}
	var list []item
	for rows.Next() {
		var x item
		if rows.Scan(&x.id, &x.title, &x.account, &x.ws, &x.name, &x.published, &x.last) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	now := s.now()
	for _, x := range list {
		for _, d := range metricReminderDays {
			due := x.published.Add(time.Duration(d) * 24 * time.Hour)
			if now.Before(due) || now.After(due.Add(48*time.Hour)) || (x.last != nil && !x.last.Before(due)) {
				continue
			}
			jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
			s.notifyWorkspace(jctx, x.ws, []string{"owner", "editor"}, "metric", fmt.Sprintf("《%s》发布已满 %d 天，录入数据", x.title, d), x.name,
				"/a/"+x.account.String()+"/review?work="+x.id.String(), fmt.Sprintf("metric:%s:%d", x.id, d))
		}
	}
}
