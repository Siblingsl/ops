package app

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type DailyItem struct {
	topicSuggestion
	Basis   []DailyBasis `json:"basis"`
	Primary bool         `json:"primary"`
	Action  string       `json:"action,omitempty"`
	TopicID *uuid.UUID   `json:"topic_id,omitempty"`
	WorkID  *uuid.UUID   `json:"work_id,omitempty"`
}
type Daily struct {
	ID          uuid.UUID   `json:"id"`
	Date        string      `json:"date"`
	Version     int         `json:"version"`
	Items       []DailyItem `json:"items"`
	AICallID    uuid.UUID   `json:"ai_call_id"`
	GeneratedAt time.Time   `json:"generated_at"`
	Trigger     string      `json:"trigger"`
}

func dailyCounts(strategy *Strategy, today time.Time) (int, int) {
	primary := 1
	day := int(today.Weekday())
	if day == 0 {
		day = 7
	}
	for _, d := range strategy.Cadence.Days {
		if d == day {
			primary = 2
		}
	}
	alternate := 2
	for key, target := range map[string]*int{"primary_count": &primary, "alternate_count": &alternate} {
		if n, ok := strategy.DailySettings[key].(float64); ok {
			*target = max(1, min(5, int(n)))
		}
	}
	return primary, alternate
}
func (s *Server) dailyAI(ctx context.Context, a *Account, strategy *Strategy, count, primary int, avoid []string) ([]DailyItem, *aiResult, error) {
	candidates, e := s.dailyCandidates(ctx, a, strategy)
	if e != nil {
		return nil, nil, e
	}
	if len(candidates) == 0 {
		return nil, nil, stateInvalid("请先启用运营方案并补齐内容支柱")
	}
	known := map[string]DailyCandidate{}
	for _, c := range candidates {
		known[basisKey(c.DailyBasis)] = c
	}
	b, _ := json.Marshal(candidates)
	sb, _ := json.Marshal(strategy.StrategyFields)
	var recent []string
	rows, e := s.db.Query(ctx, `SELECT title FROM work WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30`, a.ID)
	if e != nil {
		return nil, nil, e
	}
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			recent = append(recent, t)
		}
	}
	rows.Close()
	var out struct {
		Items []DailyItem `json:"items"`
	}
	user := fmt.Sprintf("推荐数量：%d\n主推数量：%d\n日期：%s\n方案：%s\n规则候选：%s\n近期标题（不要重复）：%s\n放弃标题（换个角度）：%s\n优先高权重；每条至少一个有效 basis，只能引用输入中的 type/id/name。不得编造用户经历、热点细节；输出 {items:[{title,angle,audience,hook,needed_materials:[],format,reason,basis:[{type,id,name}],primary}]}。", count, primary, s.today().Format("2006-01-02"), sb, b, strings.Join(recent, "、"), strings.Join(avoid, "、"))
	ai, e := s.runAIJSON(ctx, aiTask{Type: "daily_recommend", Account: a, Tier: "quality", SkipStyle: true, User: user, Refs: map[string]any{"candidate_count": len(candidates)}}, &out, func() error {
		if len(out.Items) != count {
			return fmt.Errorf("推荐数量必须为 %d", count)
		}
		seen := map[string]bool{}
		for i := range out.Items {
			x := &out.Items[i]
			if x.Title == "" || x.Angle == "" || x.Reason == "" || len(x.Basis) == 0 || seen[normalizeHot(x.Title)] {
				return fmt.Errorf("推荐需要标题、角度、理由与真实依据，且不能重复")
			}
			seen[normalizeHot(x.Title)] = true
			for _, old := range append(recent, avoid...) {
				if normalizeHot(old) == normalizeHot(x.Title) {
					return fmt.Errorf("推荐与近期标题或放弃标题重复")
				}
			}
			for j, basis := range x.Basis {
				c, ok := known[basisKey(basis)]
				if !ok {
					return fmt.Errorf("推荐依据不在输入候选中")
				}
				x.Basis[j] = c.DailyBasis
			}
			if !validFormat(a.Platform, x.Format) {
				x.Format = a.ContentFormat
			}
			x.NeededMaterials = limitList(x.NeededMaterials, 10, 100)
			x.Primary = i < primary
			x.Action = ""
			x.TopicID = nil
			x.WorkID = nil
			x.HotItemID = nil
			x.SourceURL = ""
		}
		return nil
	})
	return out.Items, ai, e
}

const dailyCols = `id,to_char(date,'YYYY-MM-DD'),version,items,ai_call_id,generated_at,trigger`

func scanDaily(row interface{ Scan(...any) error }) (*Daily, error) {
	var d Daily
	var b []byte
	e := row.Scan(&d.ID, &d.Date, &d.Version, &b, &d.AICallID, &d.GeneratedAt, &d.Trigger)
	if e == nil {
		e = json.Unmarshal(b, &d.Items)
	}
	return &d, e
}
func (s *Server) latestDaily(ctx context.Context, a *Account, date string) (*Daily, error) {
	d, e := scanDaily(s.db.QueryRow(ctx, `SELECT `+dailyCols+` FROM daily_recommendation WHERE account_id=$1 AND date=$2::date ORDER BY version DESC LIMIT 1`, a.ID, date))
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	rows, e := s.db.Query(ctx, `SELECT item_index,action,topic_id,work_id FROM daily_recommendation_action WHERE recommendation_id=$1 ORDER BY created_at`, d.ID)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var idx int
		var action string
		var tid, wid *uuid.UUID
		if rows.Scan(&idx, &action, &tid, &wid) == nil && idx < len(d.Items) && action != "replaced" {
			d.Items[idx].Action = action
			d.Items[idx].TopicID = tid
			d.Items[idx].WorkID = wid
		}
	}
	return d, nil
}
func (s *Server) generateDaily(ctx context.Context, a *Account, trigger string, force bool) (*Daily, error) {
	strategy, e := s.activeStrategy(ctx, a.ID)
	if e != nil {
		return nil, e
	}
	if strategy == nil {
		return nil, stateInvalid("请先启用运营方案")
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,423))`, a.ID.String()+s.today().Format("2006-01-02")); e != nil {
		return nil, e
	}
	current, e := s.latestDaily(ctx, a, s.today().Format("2006-01-02"))
	if e != nil {
		return nil, e
	}
	if current != nil && !force {
		return current, nil
	}
	if force {
		var count int
		_ = tx.QueryRow(ctx, `SELECT manual_count FROM account_daily_claim WHERE account_id=$1 AND date=$2`, a.ID, s.today()).Scan(&count)
		if count >= 3 {
			return nil, stateInvalid("今日重新生成已达 3 次上限")
		}
	}
	p, n := dailyCounts(strategy, s.today())
	items, ai, e := s.dailyAI(ctx, a, strategy, p+n, p, nil)
	if e != nil {
		return nil, e
	}
	b, _ := json.Marshal(items)
	v := 1
	if current != nil {
		v = current.Version + 1
	}
	d, e := scanDaily(tx.QueryRow(ctx, `INSERT INTO daily_recommendation(account_id,date,version,items,ai_call_id,generated_at,trigger) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+dailyCols, a.ID, s.today(), v, b, ai.CallID, s.now(), trigger))
	if e != nil {
		return nil, e
	}
	if force {
		_, e = tx.Exec(ctx, `INSERT INTO account_daily_claim(account_id,date,manual_count) VALUES($1,$2,1) ON CONFLICT(account_id,date) DO UPDATE SET manual_count=account_daily_claim.manual_count+1`, a.ID, s.today())
		if e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return d, nil
}
func (s *Server) getDaily(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	date := r.URL.Query().Get("date")
	if date == "" {
		date = s.today().Format("2006-01-02")
	}
	if _, e = time.Parse("2006-01-02", date); e != nil {
		return validation("日期格式不正确")
	}
	d, e := s.latestDaily(r.Context(), a, date)
	if e != nil {
		return e
	}
	return ok(w, map[string]any{"date": date, "recommendation": d, "preparing": false})
}
func (s *Server) regenerateDaily(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	var in struct{}
	if e = decodeOptional(r, &in); e != nil {
		return e
	}
	d, e := s.generateDaily(r.Context(), a, "manual", true)
	if e != nil {
		return e
	}
	return ok(w, d)
}
func (s *Server) dailyAction(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, e := pathID(r, "id")
	if e != nil {
		return e
	}
	idx, e := strconv.Atoi(chi.URLParam(r, "idx"))
	if e != nil || idx < 0 {
		return validation("推荐序号不正确")
	}
	var aid uuid.UUID
	e = s.db.QueryRow(ctx, `SELECT d.account_id FROM daily_recommendation d JOIN platform_account a ON a.id=d.account_id WHERE d.id=$1 AND a.workspace_id=$2 AND a.status='active'`, id, ident(ctx).WorkspaceID).Scan(&aid)
	if e != nil {
		return e
	}
	a, e := s.account(ctx, aid)
	if e != nil {
		return e
	}
	var in struct {
		Title        string `json:"title"`
		Angle        string `json:"angle"`
		PlannedToday bool   `json:"planned_today"`
	}
	if e = decodeOptional(r, &in); e != nil {
		return e
	}
	action := chi.URLParam(r, "action")
	if action != "adopt" && action != "start" && action != "replace" && action != "dismiss" {
		return errNotFound
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	d, e := scanDaily(tx.QueryRow(ctx, `SELECT `+dailyCols+` FROM daily_recommendation WHERE id=$1 FOR UPDATE`, id))
	if e != nil {
		return e
	}
	if idx >= len(d.Items) {
		return validation("推荐序号不正确")
	}
	item := d.Items[idx]
	var prior string
	var tid, wid *uuid.UUID
	e = tx.QueryRow(ctx, `SELECT action,topic_id,work_id FROM daily_recommendation_action WHERE recommendation_id=$1 AND item_index=$2 AND action<>'replaced' ORDER BY created_at DESC LIMIT 1`, id, idx).Scan(&prior, &tid, &wid)
	if e != nil && e != pgx.ErrNoRows {
		return e
	}
	if prior != "" && !(prior == "adopted" && action == "start") {
		return stateInvalid("这条推荐已经处理")
	}
	outcome := "accepted"
	storedAction := "adopted"
	if action == "replace" {
		strategy, e := s.activeStrategy(ctx, a.ID)
		if e != nil {
			return e
		}
		if strategy == nil {
			return stateInvalid("运营方案已停用")
		}
		avoid := []string{}
		for _, x := range d.Items {
			avoid = append(avoid, x.Title)
		}
		replacement, ai, e := s.dailyAI(ctx, a, strategy, 1, 0, avoid)
		if e != nil {
			return e
		}
		replacement[0].Primary = item.Primary
		d.Items[idx] = replacement[0]
		b, _ := json.Marshal(d.Items)
		_, e = tx.Exec(ctx, `UPDATE daily_recommendation SET items=$2,ai_call_id=$3 WHERE id=$1`, id, b, ai.CallID)
		if e != nil {
			return e
		}
		storedAction, outcome = "replaced", "regenerated"
	} else if action == "dismiss" {
		storedAction, outcome = "dismissed", "rejected"
	} else {
		if tid == nil {
			if in.Title != "" {
				item.Title = truncateRunes(in.Title, 100)
			}
			if in.Angle != "" {
				item.Angle = truncateRunes(in.Angle, 1000)
			}
			var planned any
			if in.PlannedToday {
				planned = s.today()
			}
			pillar := ""
			var hot *uuid.UUID
			for _, b := range item.Basis {
				if b.Type == "pillar" {
					pillar = b.Name
				}
				if b.Type == "hot" {
					u, e := uuid.Parse(b.ID)
					if e != nil {
						return validation("热点依据无效")
					}
					var risk []string
					if e = tx.QueryRow(ctx, `SELECT risk FROM account_hot_match WHERE account_id=$1 AND hot_item_id=$2 AND status='new' ORDER BY date DESC LIMIT 1`, a.ID, u).Scan(&risk); e != nil || highRisk(risk) {
						return stateInvalid("热点依据已失效或风险过高")
					}
					hot = &u
				}
			}
			var topic uuid.UUID
			e = tx.QueryRow(ctx, `INSERT INTO topic(account_id,title,angle,source,status,audience,hook,needed_materials,format,planned_date,strategy_pillar,hot_item_id) VALUES($1,$2,$3,'daily','adopted',$4,$5,$6,$7,$8,$9,$10) RETURNING id`, a.ID, item.Title, item.Angle, item.Audience, item.Hook, item.NeededMaterials, item.Format, planned, pillar, hot).Scan(&topic)
			if e != nil {
				return e
			}
			tid = &topic
		}
		if action == "start" {
			if prior == "adopted" {
				if e = tx.QueryRow(ctx, `SELECT title,angle,format FROM topic WHERE id=$1`, tid).Scan(&item.Title, &item.Angle, &item.Format); e != nil {
					return e
				}
			}
			storedAction = "started"
			p, e := s.loadProfile(ctx, a.ID)
			if e != nil {
				return e
			}
			wf, _ := json.Marshal(p.WechatDefaults)
			var work uuid.UUID
			e = tx.QueryRow(ctx, `INSERT INTO work(account_id,topic_id,content_format,title,theme,wechat_fields,viewpoint) VALUES($1,$2,$3,$4,$5,$6,'') RETURNING id`, a.ID, tid, item.Format, item.Title, p.DefaultTheme, wf).Scan(&work)
			if e != nil {
				return e
			}
			wid = &work
			for _, basis := range item.Basis {
				if basis.Type == "material" {
					mid, err := uuid.Parse(basis.ID)
					if err != nil {
						return validation("素材依据无效")
					}
					_, err = tx.Exec(ctx, `INSERT INTO work_material(work_id,material_id) SELECT $1,id FROM material WHERE id=$2 AND workspace_id=$3 AND deleted_at IS NULL ON CONFLICT DO NOTHING`, work, mid, ident(ctx).WorkspaceID)
					if err != nil {
						return err
					}
				}
			}
			_, e = tx.Exec(ctx, `UPDATE work SET planned_date=(SELECT planned_date FROM topic WHERE id=$2) WHERE id=$1`, work, tid)
			if e != nil {
				return e
			}
		}
	}
	_, e = tx.Exec(ctx, `INSERT INTO daily_recommendation_action(recommendation_id,item_index,action,topic_id,work_id,user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(recommendation_id,item_index,action) DO UPDATE SET created_at=excluded.created_at`, id, idx, storedAction, tid, wid, ident(ctx).UserID, s.now())
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	s.implicitFeedback(ctx, d.AICallID, outcome, &idx, nil)
	return ok(w, map[string]any{"topic_id": tid, "work_id": wid, "recommendation": d})
}
