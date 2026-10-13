package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ---------- EX-Q-02 内容大纲（11 文档第 4 节）：槽位由节奏规则生成，AI 只填建议，逐槽采用 ----------

const planWeeks = 4

type SlotSuggestion struct {
	Title     string     `json:"title"`
	Angle     string     `json:"angle"`
	Reason    string     `json:"reason"`
	HotItemID *uuid.UUID `json:"hot_item_id"`
	AICallID  *uuid.UUID `json:"ai_call_id"`
}

type PlanSlot struct {
	ID             uuid.UUID       `json:"id"`
	Date           string          `json:"date"`
	Pillar         string          `json:"pillar"`
	Format         string          `json:"format"`
	Status         string          `json:"status"`
	Suggestion     *SlotSuggestion `json:"suggestion"`
	TopicID        *uuid.UUID      `json:"topic_id"`
	TopicTitle     *string         `json:"topic_title"`
	TopicStatus    *string         `json:"topic_status"`
	WorkID         *uuid.UUID      `json:"work_id"`
	HotAlternative *HotMatch       `json:"hot_alternative,omitempty"`
}

const slotCols = `s.id, to_char(s.date,'YYYY-MM-DD'), s.pillar, s.format, s.status, s.suggestion, s.topic_id, t.title, t.status,
	(SELECT id FROM work WHERE topic_id=s.topic_id AND deleted_at IS NULL ORDER BY created_at LIMIT 1)`

const slotFrom = ` FROM account_plan_slot s LEFT JOIN topic t ON t.id=s.topic_id AND t.deleted_at IS NULL`

func scanSlot(row interface{ Scan(...any) error }) (*PlanSlot, error) {
	var sl PlanSlot
	var sug []byte
	if err := row.Scan(&sl.ID, &sl.Date, &sl.Pillar, &sl.Format, &sl.Status, &sug, &sl.TopicID, &sl.TopicTitle, &sl.TopicStatus, &sl.WorkID); err != nil {
		return nil, err
	}
	if len(sug) > 0 && string(sug) != "null" {
		sl.Suggestion = &SlotSuggestion{}
		_ = json.Unmarshal(sug, sl.Suggestion)
	}
	return &sl, nil
}

// assignPillars spreads pillars over n slots by ratio (smooth weighted round-robin);
// the same pillar never takes more than 2 slots in a row when another pillar exists.
func assignPillars(ps []Pillar, n int) []string {
	out := make([]string, 0, n)
	if len(ps) == 0 {
		return out
	}
	cur := make([]int, len(ps))
	total := 0
	for _, p := range ps {
		total += max(1, p.Ratio)
	}
	for len(out) < n {
		for i, p := range ps {
			cur[i] += max(1, p.Ratio)
		}
		best := -1
		for i := range ps {
			if len(out) >= 2 && out[len(out)-1] == ps[i].Name && out[len(out)-2] == ps[i].Name && len(ps) > 1 {
				continue
			}
			if best < 0 || cur[i] > cur[best] {
				best = i
			}
		}
		cur[best] -= total
		out = append(out, ps[best].Name)
	}
	return out
}

func isoWeekday(t time.Time) int {
	return (int(t.Weekday())+6)%7 + 1
}

// planWindow is Monday of the current week through 4 weeks later; slots are only generated from today on.
func (s *Server) planWindow() (time.Time, time.Time) {
	today := s.today()
	from := today.AddDate(0, 0, -(isoWeekday(today) - 1))
	return from, from.AddDate(0, 0, planWeeks*7-1)
}

// ensureSlots fills the cadence days from today to the end of the window. reset drops future
// slots that are not adopted, used when a new strategy version is enabled.
func (s *Server) ensureSlots(ctx context.Context, a *Account, st *Strategy, reset bool) error {
	today := s.today()
	_, end := s.planWindow()
	if reset {
		if _, err := s.db.Exec(ctx, `DELETE FROM account_plan_slot WHERE account_id=$1 AND date >= $2::date AND status<>'adopted'`,
			a.ID, today.Format("2006-01-02")); err != nil {
			return err
		}
	}
	if st == nil {
		return nil
	}
	days := map[int]bool{}
	for _, d := range st.Cadence.Days {
		days[d] = true
	}
	var dates []string
	for d := today; !d.After(end); d = d.AddDate(0, 0, 1) {
		if days[isoWeekday(d)] {
			dates = append(dates, d.Format("2006-01-02"))
		}
	}
	// D-048：槽位形态一律按账号类型生成；遗留方案版本的 cadence.format 不一致时以账号类型为准。
	format := a.ContentFormat
	for i, pillar := range assignPillars(st.Pillars, len(dates)) {
		if _, err := s.db.Exec(ctx, `INSERT INTO account_plan_slot (account_id, date, seq, pillar, format) VALUES ($1,$2::date,0,$3,$4)
			ON CONFLICT (account_id, date, seq) DO NOTHING`, a.ID, dates[i], pillar, format); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) getPlan(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	from, to := s.planWindow()
	q := r.URL.Query()
	if v, err := time.ParseInLocation("2006-01-02", q.Get("from"), s.loc); err == nil {
		from = v
		to = v.AddDate(0, 0, planWeeks*7-1)
	}
	if v, err := time.ParseInLocation("2006-01-02", q.Get("to"), s.loc); err == nil {
		to = v
	}
	if to.Before(from) || to.Sub(from) > 62*24*time.Hour {
		return validation("大纲范围最多 62 天")
	}
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	// 采用后又在选题池删除的槽位退回到建议或空状态，可以重新采用。
	if _, err := s.db.Exec(ctx, `UPDATE account_plan_slot s SET topic_id=NULL, status=CASE WHEN s.suggestion IS NULL THEN 'empty' ELSE 'suggested' END, updated_at=now()
		WHERE s.account_id=$1 AND s.status='adopted' AND (s.topic_id IS NULL OR EXISTS (SELECT 1 FROM topic t WHERE t.id=s.topic_id AND t.deleted_at IS NOT NULL))`, a.ID); err != nil {
		return err
	}
	if err := s.ensureSlots(ctx, a, st, false); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT `+slotCols+slotFrom+` WHERE s.account_id=$1 AND s.date BETWEEN $2::date AND $3::date ORDER BY s.date, s.seq`,
		a.ID, from.Format("2006-01-02"), to.Format("2006-01-02"))
	if err != nil {
		return err
	}
	defer rows.Close()
	slots := []*PlanSlot{}
	for rows.Next() {
		sl, err := scanSlot(rows)
		if err != nil {
			return err
		}
		slots = append(slots, sl)
	}
	rows.Close()
	matches, err := s.hotMatches(ctx, a, s.today().Format("2006-01-02"))
	if err != nil {
		return err
	}
	for _, m := range matches {
		if m.Relevance >= 85 && m.Status == "new" && !highRisk(m.Risk) {
			for _, sl := range slots {
				if sl.Date >= s.today().Format("2006-01-02") && sl.Date <= s.today().AddDate(0, 0, 3).Format("2006-01-02") && sl.Status != "adopted" {
					sl.HotAlternative = &m
				}
			}
			break
		}
	}
	return ok(w, map[string]any{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"), "today": s.today().Format("2006-01-02"),
		"has_strategy": st != nil, "slots": slots})
}

// pendingTopicTitles lists pool topics not yet written so the outline does not duplicate them.
func (s *Server) pendingTopicTitles(ctx context.Context, accountID uuid.UUID) []string {
	rows, err := s.db.Query(ctx, `SELECT title FROM topic t WHERE account_id=$1 AND deleted_at IS NULL AND status<>'dropped'
		AND NOT EXISTS (SELECT 1 FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL) ORDER BY created_at DESC LIMIT 30`, accountID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			out = append(out, t)
		}
	}
	return out
}

func strategyBrief(st *Strategy) string {
	var b strings.Builder
	fmt.Fprintf(&b, "赛道：%s\n目标读者：%s\n阶段：%s\n", st.Niche, nz(st.Audience, "未填"), map[string]string{"cold_start": "起号期", "growth": "成长期", "stable": "稳定期"}[st.Stage])
	b.WriteString("内容支柱：\n")
	for _, p := range st.Pillars {
		fmt.Fprintf(&b, "- %s（占比 %d%%）：%s\n", p.Name, p.Ratio, p.Desc)
	}
	if len(st.Taboo) > 0 {
		fmt.Fprintf(&b, "禁区：%s\n", strings.Join(st.Taboo, "、"))
	}
	return b.String()
}

type outlineSlot struct {
	Date      string  `json:"date"`
	Pillar    string  `json:"pillar"`
	Title     string  `json:"title"`
	Angle     string  `json:"angle"`
	Reason    string  `json:"reason"`
	HotItemID *string `json:"hot_item_id"`
}

// outlineSuggest runs strategy_outline for the given slots and returns one valid suggestion per slot date.
func (s *Server) outlineSuggest(ctx context.Context, a *Account, st *Strategy, slots []*PlanSlot, avoid []string) (map[string]SlotSuggestion, error) {
	var lines strings.Builder
	want := map[string]string{}
	for _, sl := range slots {
		fmt.Fprintf(&lines, "- 槽位 date=%s 支柱=%s\n", sl.Date, sl.Pillar)
		want[sl.Date] = sl.Pillar
	}
	hot := []HotMatch{}
	knownHot := map[string]uuid.UUID{}
	for day := 0; day < 7 && len(hot) < 10; day++ {
		matches, err := s.hotMatches(ctx, a, s.today().AddDate(0, 0, -day).Format("2006-01-02"))
		if err != nil {
			return nil, err
		}
		for _, m := range matches {
			if _, seen := knownHot[m.HotItem.ID.String()]; !seen && m.Status == "new" && !highRisk(m.Risk) && len(hot) < 10 {
				hot = append(hot, m)
				knownHot[m.HotItem.ID.String()] = m.HotItem.ID
			}
		}
	}
	hotJSON := externalBlock("热点", "plan", hot)
	recent := s.recentTitles(ctx, a.ID)
	pending := s.pendingTopicTitles(ctx, a.ID)
	user := fmt.Sprintf(`## 运营方案
%s
## 需要填写的槽位
%s
## 选题池中待写的选题（不要重复）
%s

## 最近的选题和作品标题（不要重复）
%s

## 任务说明
为每个槽位建议一个选题方向：标题、切入角度、推荐理由。选题必须属于槽位指定的支柱，贴合目标读者，避开禁区。
不要编造热点、数据或经历；hot_item_id 只能引用以下输入中的 id，没有适合的热点时填 null。
真实热点：%s
%s

## 输出格式
只输出 JSON：{"slots":[{"date":"YYYY-MM-DD","pillar":"支柱","title":"标题","angle":"切入角度","reason":"理由","hot_item_id":null}]}`,
		strategyBrief(st), lines.String(), bullets(pending), bullets(recent), hotJSON, avoidLine(avoid))
	var out struct {
		Slots []outlineSlot `json:"slots"`
	}
	known := append(append([]string{}, recent...), pending...)
	known = append(known, avoid...)
	result := map[string]SlotSuggestion{}
	res, err := s.runAIJSON(ctx, aiTask{Type: "strategy_outline", Account: a, User: user, SkipStyle: true, Tier: "economy",
		Refs: map[string]any{"slots": len(slots), "hot_items": hot}}, &out, func() error {
		result = map[string]SlotSuggestion{}
		for _, x := range out.Slots {
			title := truncateRunes(strings.TrimSpace(x.Title), 60)
			if want[x.Date] == "" || title == "" {
				continue
			}
			if x.Pillar != want[x.Date] {
				return fmt.Errorf("建议必须属于输入槽位的支柱")
			}
			var hotID *uuid.UUID
			if x.HotItemID != nil && *x.HotItemID != "" {
				id, ok := knownHot[*x.HotItemID]
				if !ok {
					return fmt.Errorf("热点依据必须来自输入中的真实热点")
				}
				hotID = &id
			}
			if _, dup := result[x.Date]; dup || tooSimilar(title, known) {
				continue
			}
			result[x.Date] = SlotSuggestion{Title: title, Angle: truncateRunes(strings.TrimSpace(x.Angle), 120),
				Reason: truncateRunes(strings.TrimSpace(x.Reason), 200), HotItemID: hotID}
		}
		if len(result) == 0 {
			return fmt.Errorf("没有可用的槽位建议")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for k, v := range result {
		v.AICallID = &res.CallID
		result[k] = v
	}
	return result, nil
}

func bullets(list []string) string {
	if len(list) == 0 {
		return "- （无）"
	}
	return "- " + strings.Join(list, "\n- ")
}

func avoidLine(avoid []string) string {
	if len(avoid) == 0 {
		return ""
	}
	return "\n不要再给出这些标题或相近的方向：" + strings.Join(avoid, "；") + "。"
}

func tooSimilar(title string, known []string) bool {
	tt := terms(title)
	for _, k := range known {
		if jaccard(tt, terms(k)) >= 0.7 {
			return true
		}
	}
	return false
}

// suggestPlan fills empty future slots with suggestions only; no topic is created (H-01).
func (s *Server) suggestPlan(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	if st == nil {
		return stateInvalid("还没有启用的运营方案，请先完成起号向导")
	}
	if err := s.ensureSlots(ctx, a, st, false); err != nil {
		return err
	}
	_, end := s.planWindow()
	rows, err := s.db.Query(ctx, `SELECT `+slotCols+slotFrom+` WHERE s.account_id=$1 AND s.status='empty' AND s.date BETWEEN $2::date AND $3::date
		ORDER BY s.date, s.seq LIMIT 28`, a.ID, s.today().Format("2006-01-02"), end.Format("2006-01-02"))
	if err != nil {
		return err
	}
	var empty []*PlanSlot
	for rows.Next() {
		sl, err := scanSlot(rows)
		if err != nil {
			rows.Close()
			return err
		}
		empty = append(empty, sl)
	}
	rows.Close()
	if len(empty) == 0 {
		return ok(w, map[string]any{"updated": 0, "empty": 0})
	}
	sugs, err := s.outlineSuggest(ctx, a, st, empty, nil)
	if err != nil {
		return err
	}
	n := 0
	for _, sl := range empty {
		sug, found := sugs[sl.Date]
		if !found {
			continue
		}
		b, _ := json.Marshal(sug)
		tag, err := s.db.Exec(ctx, `UPDATE account_plan_slot SET suggestion=$2, status='suggested', updated_at=now() WHERE id=$1 AND status='empty'`, sl.ID, b)
		if err != nil {
			return err
		}
		n += int(tag.RowsAffected())
	}
	return ok(w, map[string]any{"updated": n, "empty": len(empty)})
}

// slotFromPath loads a slot in the caller's workspace.
func (s *Server) slotFromPath(r *http.Request) (*PlanSlot, *Account, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, nil, err
	}
	ctx := r.Context()
	var accountID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT s.account_id FROM account_plan_slot s JOIN platform_account a ON a.id=s.account_id
		WHERE s.id=$1 AND a.workspace_id=$2`, id, ident(ctx).WorkspaceID).Scan(&accountID); err != nil {
		return nil, nil, err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return nil, nil, err
	}
	sl, err := scanSlot(s.db.QueryRow(ctx, `SELECT `+slotCols+slotFrom+` WHERE s.id=$1`, id))
	return sl, a, err
}

func (s *Server) writeSlot(w http.ResponseWriter, r *http.Request, id uuid.UUID, extra map[string]any) error {
	sl, err := scanSlot(s.db.QueryRow(r.Context(), `SELECT `+slotCols+slotFrom+` WHERE s.id=$1`, id))
	if err != nil {
		return err
	}
	if extra == nil {
		extra = map[string]any{}
	}
	extra["slot"] = sl
	return ok(w, extra)
}

// adoptSlot turns exactly one slot into a topic with the slot date as planned date (H-01, 不提供"全部采用").
func (s *Server) adoptSlot(w http.ResponseWriter, r *http.Request) error {
	sl, a, err := s.slotFromPath(r)
	if err != nil {
		return err
	}
	if sl.Status == "adopted" {
		return stateInvalid("这个槽位已经采用过了")
	}
	var in struct {
		Title *string `json:"title"`
		Angle *string `json:"angle"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	title, angle := "", ""
	if sl.Suggestion != nil {
		title, angle = sl.Suggestion.Title, sl.Suggestion.Angle
	}
	if in.Title != nil {
		title = *in.Title
	}
	if in.Angle != nil {
		angle = *in.Angle
	}
	title = truncateRunes(strings.TrimSpace(title), 100)
	if title == "" {
		return validation("请填写选题标题")
	}
	ctx := r.Context()
	// D-048 第 5.6 节：遗留槽位形态与账号类型不一致时明确提示，不静默转换。
	if sl.Format != "" && sl.Format != a.ContentFormat {
		return stateInvalid(fmt.Sprintf("这个槽位的形态（%s）与账号类型（%s）不一致，不能采用。请重新启用运营方案以重建大纲。", formatNames[sl.Format], formatNames[a.ContentFormat]))
	}
	similar, err := s.similarTitles(r, a.ID, title)
	if err != nil {
		return err
	}
	var hot *uuid.UUID
	if sl.Suggestion != nil {
		hot = sl.Suggestion.HotItemID
	}
	if hot != nil {
		if err := s.usableHot(ctx, a, *hot, 7); err != nil {
			return err
		}
	}
	var topicID uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO topic (account_id, title, angle, source, hot_item_id) VALUES ($1,$2,$3,'plan',$4) RETURNING id`,
		a.ID, title, strings.TrimSpace(angle), hot).Scan(&topicID); err != nil {
		return err
	}
	date, pillar, format := sl.Date, sl.Pillar, sl.Format
	if err := s.applyTopicFields(ctx, topicID, a.ID, topicFields{PlannedDate: &date, StrategyPillar: &pillar, Format: &format}); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `UPDATE account_plan_slot SET status='adopted', topic_id=$2, updated_at=now() WHERE id=$1 AND status<>'adopted'`, sl.ID, topicID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		_, _ = s.db.Exec(ctx, `UPDATE topic SET deleted_at=now() WHERE id=$1`, topicID)
		return stateInvalid("这个槽位已经采用过了")
	}
	if sl.Suggestion != nil && sl.Suggestion.AICallID != nil {
		outcome := "accepted"
		if title != sl.Suggestion.Title {
			outcome = "edited"
		}
		s.implicitFeedback(ctx, *sl.Suggestion.AICallID, outcome, nil, nil)
	}
	return s.writeSlot(w, r, sl.ID, map[string]any{"topic_id": topicID, "similar": similar})
}

// regenerateSlot replaces the suggestion of one slot ("换一个").
func (s *Server) regenerateSlot(w http.ResponseWriter, r *http.Request) error {
	sl, a, err := s.slotFromPath(r)
	if err != nil {
		return err
	}
	if sl.Status == "adopted" {
		return stateInvalid("已采用的槽位请到选题池修改")
	}
	ctx := r.Context()
	st, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	if st == nil {
		return stateInvalid("还没有启用的运营方案，请先完成起号向导")
	}
	var avoid []string
	if sl.Suggestion != nil {
		avoid = append(avoid, sl.Suggestion.Title)
	}
	sugs, err := s.outlineSuggest(ctx, a, st, []*PlanSlot{sl}, avoid)
	if err != nil {
		return err
	}
	sug, found := sugs[sl.Date]
	if !found {
		return apiErr(502, "ai_output_invalid", "模型没有给出新的建议，请再试一次。")
	}
	b, _ := json.Marshal(sug)
	if _, err := s.db.Exec(ctx, `UPDATE account_plan_slot SET suggestion=$2, status='suggested', updated_at=now() WHERE id=$1 AND status<>'adopted'`, sl.ID, b); err != nil {
		return err
	}
	if sl.Suggestion != nil && sl.Suggestion.AICallID != nil {
		s.implicitFeedback(ctx, *sl.Suggestion.AICallID, "regenerated", nil, nil)
	}
	return s.writeSlot(w, r, sl.ID, nil)
}

// clearSlot drops the suggestion and leaves the slot empty ("留空").
func (s *Server) clearSlot(w http.ResponseWriter, r *http.Request) error {
	sl, _, err := s.slotFromPath(r)
	if err != nil {
		return err
	}
	if sl.Status == "adopted" {
		return stateInvalid("已采用的槽位请到选题池修改")
	}
	ctx := r.Context()
	if _, err := s.db.Exec(ctx, `UPDATE account_plan_slot SET suggestion=NULL, status='empty', updated_at=now() WHERE id=$1 AND status<>'adopted'`, sl.ID); err != nil {
		return err
	}
	if sl.Suggestion != nil && sl.Suggestion.AICallID != nil {
		s.implicitFeedback(ctx, *sl.Suggestion.AICallID, "rejected", nil, nil)
	}
	return s.writeSlot(w, r, sl.ID, nil)
}
