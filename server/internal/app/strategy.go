package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"ops/internal/ai"
)

// ---------- EX-Q-01 账号运营方案（11 文档第 4 节） ----------

type Pillar struct {
	Name     string   `json:"name"`
	Desc     string   `json:"desc"`
	Ratio    int      `json:"ratio"`
	Examples []string `json:"examples"`
}

// Cadence days use 1–7 for Monday–Sunday; per_week always equals len(days) after normalisation.
type Cadence struct {
	PerWeek int    `json:"per_week"`
	Days    []int  `json:"days"`
	Format  string `json:"format"`
}

type Benchmark struct {
	Name  string   `json:"name"`
	Note  string   `json:"note"`
	Links []string `json:"links"`
}

type StrategyFields struct {
	Niche           string         `json:"niche"`
	Audience        string         `json:"audience"`
	Differentiation string         `json:"differentiation"`
	Persona         string         `json:"persona"`
	Pillars         []Pillar       `json:"pillars"`
	Cadence         Cadence        `json:"cadence"`
	Stage           string         `json:"stage"`
	Goals           []string       `json:"goals"`
	Benchmarks      []Benchmark    `json:"benchmarks"`
	Keywords        []string       `json:"keywords"`
	Taboo           []string       `json:"taboo"`
	HotEnabled      *bool          `json:"hot_enabled"`
	BlockedWords    []string       `json:"blocked_words"`
	DailySettings   map[string]any `json:"daily_settings"`
}

type Strategy struct {
	ID      uuid.UUID `json:"id"`
	Version int       `json:"version"`
	Status  string    `json:"status"`
	StrategyFields
	AICallID  *uuid.UUID `json:"ai_call_id"`
	CreatedAt time.Time  `json:"created_at"`
}

var strategyStages = map[string]bool{"cold_start": true, "growth": true, "stable": true}

func limitList(in []string, n, runes int) []string {
	out := cleanList(in)
	if len(out) > n {
		out = out[:n]
	}
	for i := range out {
		out[i] = truncateRunes(out[i], runes)
	}
	return out
}

// rebalancePillars scales AI-proposed ratios to sum to exactly 100; the user can still edit them.
func rebalancePillars(ps []Pillar) {
	sum := 0
	for i := range ps {
		ps[i].Ratio = max(0, ps[i].Ratio)
		sum += ps[i].Ratio
	}
	if len(ps) == 0 || sum == 100 {
		return
	}
	total, top := 0, 0
	for i := range ps {
		if sum == 0 {
			ps[i].Ratio = 100 / len(ps)
		} else {
			ps[i].Ratio = ps[i].Ratio * 100 / sum
		}
		ps[i].Ratio = max(1, ps[i].Ratio)
		total += ps[i].Ratio
		if ps[i].Ratio > ps[top].Ratio {
			top = i
		}
	}
	ps[top].Ratio += 100 - total
}

func defaultDays(perWeek int) []int {
	switch {
	case perWeek <= 1:
		return []int{3}
	case perWeek == 2:
		return []int{2, 5}
	case perWeek == 3:
		return []int{1, 3, 5}
	case perWeek == 4:
		return []int{1, 2, 4, 6}
	case perWeek == 5:
		return []int{1, 2, 3, 4, 5}
	case perWeek == 6:
		return []int{1, 2, 3, 4, 5, 6}
	}
	return []int{1, 2, 3, 4, 5, 6, 7}
}

// normalize trims and validates the strategy for an account; pillar ratios must already sum to 100.
func (f *StrategyFields) normalize(a *Account) error {
	f.Niche = truncateRunes(strings.TrimSpace(f.Niche), 60)
	f.Audience = truncateRunes(strings.TrimSpace(f.Audience), 300)
	f.Differentiation = truncateRunes(strings.TrimSpace(f.Differentiation), 300)
	f.Persona = truncateRunes(strings.TrimSpace(f.Persona), 300)
	if f.Niche == "" {
		return validation("请填写赛道")
	}
	pillars := []Pillar{}
	seen := map[string]bool{}
	for _, p := range f.Pillars {
		p.Name = truncateRunes(strings.TrimSpace(p.Name), 20)
		if p.Name == "" || seen[p.Name] {
			continue
		}
		seen[p.Name] = true
		p.Desc = truncateRunes(strings.TrimSpace(p.Desc), 200)
		p.Examples = limitList(p.Examples, 5, 60)
		pillars = append(pillars, p)
	}
	f.Pillars = pillars
	if len(pillars) < 3 || len(pillars) > 5 {
		return validation("内容支柱需要 3–5 个（名称不能重复）")
	}
	sum := 0
	for _, p := range pillars {
		if p.Ratio < 1 || p.Ratio > 100 {
			return validation("支柱「" + p.Name + "」的占比需要在 1% 到 100% 之间")
		}
		sum += p.Ratio
	}
	if sum != 100 {
		return validation(fmt.Sprintf("支柱占比合计需要等于 100%%（当前 %d%%）", sum))
	}
	days := []int{}
	seenDay := map[int]bool{}
	for _, d := range f.Cadence.Days {
		if d >= 1 && d <= 7 && !seenDay[d] {
			seenDay[d] = true
			days = append(days, d)
		}
	}
	sort.Ints(days)
	if len(days) == 0 {
		days = defaultDays(max(1, min(7, f.Cadence.PerWeek)))
	}
	f.Cadence.Days = days
	f.Cadence.PerWeek = len(days)
	// D-048 第 5.6 节：账号类型创建后固定，方案的作品形态必须与之一致；
	// 空值按账号类型补齐，不一致的保存/启用/恢复请求明确拒绝（遗留版本需调整后再启用）。
	if f.Cadence.Format == "" {
		f.Cadence.Format = a.ContentFormat
	} else if f.Cadence.Format != a.ContentFormat {
		return validation(fmt.Sprintf("方案的作品形态（%s）与账号类型（%s）不一致。账号类型创建后固定，方案须沿用账号类型。", formatNames[f.Cadence.Format], formatNames[a.ContentFormat]))
	}
	if f.Stage == "" {
		f.Stage = "cold_start"
	}
	if !strategyStages[f.Stage] {
		return validation("阶段只能是起号、成长或稳定")
	}
	f.Goals = limitList(f.Goals, 5, 60)
	bms := []Benchmark{}
	for _, b := range f.Benchmarks {
		b.Name = truncateRunes(strings.TrimSpace(b.Name), 40)
		if b.Name == "" || len(bms) >= 10 {
			continue
		}
		b.Note = truncateRunes(strings.TrimSpace(b.Note), 200)
		links := []string{}
		for _, l := range cleanList(b.Links) {
			if (strings.HasPrefix(l, "https://") || strings.HasPrefix(l, "http://")) && len(l) <= 1024 && len(links) < 5 {
				links = append(links, l)
			}
		}
		b.Links = links
		bms = append(bms, b)
	}
	f.Benchmarks = bms
	f.Keywords = limitList(f.Keywords, 30, 20)
	f.Taboo = limitList(f.Taboo, 20, 40)
	f.BlockedWords = limitList(f.BlockedWords, 50, 20)
	if f.HotEnabled == nil {
		t := true
		f.HotEnabled = &t
	}
	if f.DailySettings == nil {
		f.DailySettings = map[string]any{}
	}
	defaults := DailySettings{Generate: "on_open", Hour: 7}
	b, _ := json.Marshal(f.DailySettings)
	if json.Unmarshal(b, &defaults) != nil {
		return validation("每日推荐参数格式不正确")
	}
	if e := validateDaily(defaults); e != nil {
		return e
	}
	return nil
}

const strategyCols = `id, version, status, niche, audience, differentiation, persona, pillars, cadence, stage, goals, benchmarks,
	keywords, taboo, hot_enabled, blocked_words, daily_settings, ai_call_id, created_at`

func scanStrategy(row interface{ Scan(...any) error }) (*Strategy, error) {
	var st Strategy
	var pillars, cadence, goals, bms, daily []byte
	var hot bool
	if err := row.Scan(&st.ID, &st.Version, &st.Status, &st.Niche, &st.Audience, &st.Differentiation, &st.Persona,
		&pillars, &cadence, &st.Stage, &goals, &bms, &st.Keywords, &st.Taboo, &hot, &st.BlockedWords, &daily,
		&st.AICallID, &st.CreatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(pillars, &st.Pillars)
	_ = json.Unmarshal(cadence, &st.Cadence)
	_ = json.Unmarshal(goals, &st.Goals)
	_ = json.Unmarshal(bms, &st.Benchmarks)
	_ = json.Unmarshal(daily, &st.DailySettings)
	st.HotEnabled = &hot
	for _, l := range []*[]string{&st.Goals, &st.Keywords, &st.Taboo, &st.BlockedWords} {
		if *l == nil {
			*l = []string{}
		}
	}
	if st.Pillars == nil {
		st.Pillars = []Pillar{}
	}
	if st.Benchmarks == nil {
		st.Benchmarks = []Benchmark{}
	}
	if st.Cadence.Days == nil {
		st.Cadence.Days = []int{}
	}
	return &st, nil
}

// activeStrategy returns the account's active strategy or nil when none is enabled yet.
func (s *Server) activeStrategy(ctx context.Context, accountID uuid.UUID) (*Strategy, error) {
	rows, err := s.db.Query(ctx, `SELECT `+strategyCols+` FROM account_strategy WHERE account_id=$1 AND status='active'`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanStrategy(rows)
}

func (s *Server) getStrategy(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	active, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT `+strategyCols+` FROM account_strategy WHERE account_id=$1 ORDER BY version DESC LIMIT 30`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	versions := []*Strategy{}
	for rows.Next() {
		st, err := scanStrategy(rows)
		if err != nil {
			return err
		}
		versions = append(versions, st)
	}
	return ok(w, map[string]any{"active": active, "versions": versions})
}

// saveStrategyVersion archives the current active version and enables f as a new version (方案版本历史).
func (s *Server) saveStrategyVersion(ctx context.Context, a *Account, f StrategyFields, aiCallID *uuid.UUID) (*Strategy, error) {
	pillars, _ := json.Marshal(f.Pillars)
	cadence, _ := json.Marshal(f.Cadence)
	goals, _ := json.Marshal(f.Goals)
	bms, _ := json.Marshal(f.Benchmarks)
	daily, _ := json.Marshal(f.DailySettings)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT id FROM platform_account WHERE id=$1 FOR UPDATE`, a.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE account_strategy SET status='archived' WHERE account_id=$1 AND status='active'`, a.ID); err != nil {
		return nil, err
	}
	st, err := scanStrategy(tx.QueryRow(ctx, `INSERT INTO account_strategy (account_id, version, status, niche, audience, differentiation, persona,
		pillars, cadence, stage, goals, benchmarks, keywords, taboo, hot_enabled, blocked_words, daily_settings, ai_call_id, created_by)
		VALUES ($1, (SELECT coalesce(max(version),0)+1 FROM account_strategy WHERE account_id=$1), 'active', $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		RETURNING `+strategyCols,
		a.ID, f.Niche, f.Audience, f.Differentiation, f.Persona, pillars, cadence, f.Stage, goals, bms, f.Keywords, f.Taboo,
		*f.HotEnabled, f.BlockedWords, daily, aiCallID, ident(ctx).UserID))
	if err != nil {
		return nil, err
	}
	links := []string{}
	for _, benchmark := range f.Benchmarks {
		links = append(links, referenceLinks(strings.Join(benchmark.Links, "\n"))...)
	}
	if _, err = s.queueReferences(ctx, tx, a.ID, links); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.audit(ctx, "strategy.activate", "account", a.ID.String(), "ok", map[string]any{"version": st.Version})
	if err := s.ensureSlots(ctx, a, st, true); err != nil {
		return nil, err
	}
	return st, nil
}

var profileSyncFields = map[string]bool{"audience": true, "persona": true, "blocked_words": true}

// syncStrategyProfile copies the confirmed fields into account_profile; banned words are merged, not replaced.
func (s *Server) syncStrategyProfile(ctx context.Context, a *Account, f StrategyFields, fields []string) ([]string, error) {
	if _, err := s.db.Exec(ctx, `INSERT INTO account_profile (account_id) VALUES ($1) ON CONFLICT DO NOTHING`, a.ID); err != nil {
		return nil, err
	}
	synced := []string{}
	for _, k := range cleanList(fields) {
		if !profileSyncFields[k] {
			continue
		}
		var err error
		switch k {
		case "audience":
			_, err = s.db.Exec(ctx, `UPDATE account_profile SET target_audience=$2, updated_at=now() WHERE account_id=$1`, a.ID, f.Audience)
		case "persona":
			_, err = s.db.Exec(ctx, `UPDATE account_profile SET persona_tone=$2, updated_at=now() WHERE account_id=$1`, a.ID, f.Persona)
		case "blocked_words":
			_, err = s.db.Exec(ctx, `UPDATE account_profile SET banned_words=(SELECT coalesce(array_agg(DISTINCT w), '{}') FROM unnest(banned_words || $2::text[]) w),
				updated_at=now() WHERE account_id=$1`, a.ID, f.BlockedWords)
		}
		if err != nil {
			return nil, err
		}
		synced = append(synced, k)
	}
	return synced, nil
}

// activateStrategy is the only write of the positioning wizard: the human clicks "启用方案" (UX-03).
func (s *Server) activateStrategy(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		StrategyFields
		SyncProfile []string   `json:"sync_profile"`
		AICallID    *uuid.UUID `json:"ai_call_id"`
		ChoiceIndex *int       `json:"choice_index"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	f := in.StrategyFields
	if err := f.normalize(a); err != nil {
		return err
	}
	ctx := r.Context()
	st, err := s.saveStrategyVersion(ctx, a, f, in.AICallID)
	if err != nil {
		return err
	}
	synced, err := s.syncStrategyProfile(ctx, a, f, in.SyncProfile)
	if err != nil {
		return err
	}
	if in.AICallID != nil {
		s.implicitFeedback(ctx, *in.AICallID, "accepted", in.ChoiceIndex, nil)
	}
	return ok(w, map[string]any{"strategy": st, "synced": synced})
}

func (s *Server) restoreStrategy(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	v, err := strconv.Atoi(chiParam(r, "v"))
	if err != nil {
		return errNotFound
	}
	ctx := r.Context()
	old, err := scanStrategy(s.db.QueryRow(ctx, `SELECT `+strategyCols+` FROM account_strategy WHERE account_id=$1 AND version=$2`, a.ID, v))
	if err != nil {
		return err
	}
	if old.Status == "active" {
		return stateInvalid("这个版本已经在使用中")
	}
	f := old.StrategyFields
	if err := f.normalize(a); err != nil {
		return err
	}
	st, err := s.saveStrategyVersion(ctx, a, f, old.AICallID)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"strategy": st, "restored_from": v})
}

// ---------- 起号向导：account_positioning（SSE，草稿不落库） ----------

type PositioningOption struct {
	StrategyFields
	FitReason string   `json:"fit_reason"`
	Risks     []string `json:"risks"`
}

// citesExperience requires the differentiation to reuse wording from the questionnaire's real experiences.
func citesExperience(diff, experiences string) bool {
	exp := terms(experiences)
	for t := range terms(diff) {
		if runeLen(t) >= 2 && exp[t] {
			return true
		}
	}
	return false
}

func validPositioning(a *Account, experiences string, opts *[]PositioningOption) error {
	out := []PositioningOption{}
	seen := map[string]bool{}
	for _, o := range *opts {
		rebalancePillars(o.Pillars)
		o.Stage = "cold_start"
		if o.normalize(a) != nil || !citesExperience(o.Differentiation, experiences) {
			continue
		}
		o.FitReason = truncateRunes(strings.TrimSpace(o.FitReason), 300)
		o.Risks = limitList(o.Risks, 5, 100)
		names := []string{}
		for _, pillar := range o.Pillars {
			names = append(names, pillar.Name)
		}
		key := strings.ToLower(o.Niche + "/" + o.Audience + "/" + strings.Join(names, "/"))
		if seen[key] || o.FitReason == "" {
			continue
		}
		seen[key] = true
		out = append(out, o)
		if len(out) == 3 {
			break
		}
	}
	if len(out) < 2 {
		return fmt.Errorf("需要 2–3 个符合要求的方案（支柱 3–5 个、差异化需引用问卷中的真实经历）")
	}
	*opts = out
	return nil
}

func (s *Server) strategyOptions(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Domain      string `json:"domain"`
		Experiences string `json:"experiences"`
		Audience    string `json:"audience"`
		WeeklyHours int    `json:"weekly_hours"`
		Format      string `json:"format"`
		Goal        string `json:"goal"`
		Samples     []struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		} `json:"samples"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Domain = truncateRunes(strings.TrimSpace(in.Domain), 100)
	in.Experiences = truncateRunes(strings.TrimSpace(in.Experiences), 2000)
	if in.Domain == "" {
		return validation("请填写想做的领域")
	}
	if in.Experiences == "" {
		return validation("请写下你有哪些真实经历或资源，AI 会据此找差异化，不会替你编造")
	}
	// D-048 第 5.6 节：起号问卷不再另选形态；请求与账号类型不一致时明确拒绝。
	format := in.Format
	if format == "" {
		format = a.ContentFormat
	} else if format != a.ContentFormat {
		return validation(fmt.Sprintf("这个账号的类型是%s，起号问卷不能再选择其他类型", formatNames[a.ContentFormat]))
	}
	var samples strings.Builder
	n, total := 0, 0
	for _, x := range in.Samples {
		c := strings.TrimSpace(x.Content)
		if c == "" || n >= 5 || total >= 6000 {
			continue
		}
		c = truncate(c, min(1500, 6000-total))
		n++
		total += runeLen(c)
		fmt.Fprintf(&samples, "### 作品 %d：%s\n%s\n\n", n, strings.TrimSpace(x.Title), c)
	}
	if n == 0 {
		samples.WriteString("（未提供）\n")
	}
	user := fmt.Sprintf(`## 问卷
领域：%s
真实经历与资源：%s
想吸引的读者：%s
每周可投入：%s
平台：%s；账号类型：%s（创建后固定，所有方案的 cadence.format 都必须是它）
目标：%s

## 过往作品（可为空）
%s
## 任务说明
给出 2–3 个可选的账号定位方案，方案之间要有实质区别（不同读者、不同切入点或不同内容支柱）。
1. 差异化（differentiation）必须引用问卷中写到的真实经历或资源原话，不得编造身份、头衔、经历或数据。
2. 每个方案 3–5 个内容支柱，占比（ratio）合计 100，每个支柱给 2–3 个示例选题。
3. 发布节奏结合每周可投入时间；days 用 1–7 表示周一到周日；format 只能是 %s。
4. keywords 是用于匹配热点的追踪关键词（5–10 个）；taboo 是建议不碰的话题。
5. fit_reason 说明为什么适合这个人；risks 列出主要风险。

## 输出格式
只输出 JSON：{"options":[{"niche":"赛道","audience":"目标读者","differentiation":"差异化","persona":"人设与语气","pillars":[{"name":"支柱","desc":"说明","ratio":30,"examples":["示例选题"]}],"cadence":{"per_week":3,"days":[1,3,5],"format":"%s"},"keywords":["关键词"],"taboo":["禁区"],"fit_reason":"适合理由","risks":["风险"]}]}`,
		in.Domain, in.Experiences, nz(strings.TrimSpace(in.Audience), "未填"), weeklyHours(in.WeeklyHours),
		platformNames[a.Platform], formatNames[format], nz(strings.TrimSpace(in.Goal), "未填"), samples.String(),
		a.ContentFormat, a.ContentFormat)
	t := aiTask{Type: "account_positioning", Account: a, User: user, JSON: true, SkipStyle: true, Refs: map[string]any{"samples": n}}
	if s.loadCrawl(r.Context()).Limits.Enabled {
		hot, err := s.positioningHot(r.Context(), in.Domain)
		if err != nil {
			return err
		}
		if len(hot) > 0 {
			b, _ := json.Marshal(hot)
			t.User += "\n## 近7天领域热点快照（仅公开标题与链接，不补充事件细节）\n" + string(b)
			t.Refs["hot_items"] = hot
		}
	}
	exp := in.Experiences
	return s.streamAIEphemeral(w, r, t,
		func(text string, _ *aiResult) (any, error) {
			var out struct {
				Options []PositioningOption `json:"options"`
			}
			if json.Unmarshal([]byte(ai.ExtractJSON(text)), &out) != nil || validPositioning(a, exp, &out.Options) != nil {
				out.Options = nil
				if _, err := s.runAIJSON(r.Context(), t, &out, func() error { return validPositioning(a, exp, &out.Options) }); err != nil {
					return nil, err
				}
			}
			return map[string]any{"options": out.Options}, nil
		})
}

// ---------- 方案调整：strategy_revise（逐条接受，接受后由前端调用"启用方案"保存为新版本） ----------

type StrategyChange struct {
	Field  string          `json:"field"`
	From   json.RawMessage `json:"from"`
	To     json.RawMessage `json:"to"`
	Reason string          `json:"reason"`
}

var revisableFields = map[string]string{"niche": "赛道", "audience": "目标读者", "differentiation": "差异化", "persona": "人设",
	"pillars": "内容支柱", "cadence": "发布节奏", "stage": "阶段", "goals": "目标", "keywords": "追踪关键词", "taboo": "禁区"}

// applyStrategyChange writes one suggested value into f (always into fresh values, f may share slices
// with the current version); the caller re-validates the whole strategy.
func applyStrategyChange(f *StrategyFields, field string, to json.RawMessage) error {
	var str string
	var list []string
	switch field {
	case "niche", "audience", "differentiation", "persona", "stage":
		if err := json.Unmarshal(to, &str); err != nil {
			return err
		}
		*map[string]*string{"niche": &f.Niche, "audience": &f.Audience, "differentiation": &f.Differentiation,
			"persona": &f.Persona, "stage": &f.Stage}[field] = str
	case "goals", "keywords", "taboo":
		if err := json.Unmarshal(to, &list); err != nil {
			return err
		}
		*map[string]*[]string{"goals": &f.Goals, "keywords": &f.Keywords, "taboo": &f.Taboo}[field] = list
	case "pillars":
		var ps []Pillar
		if err := json.Unmarshal(to, &ps); err != nil {
			return err
		}
		rebalancePillars(ps)
		f.Pillars = ps
	case "cadence":
		var c Cadence
		if err := json.Unmarshal(to, &c); err != nil {
			return err
		}
		f.Cadence = c
	default:
		return fmt.Errorf("未知字段 %s", field)
	}
	return nil
}

func strategyFieldJSON(f *StrategyFields, field string) json.RawMessage {
	var v any
	switch field {
	case "niche":
		v = f.Niche
	case "audience":
		v = f.Audience
	case "differentiation":
		v = f.Differentiation
	case "persona":
		v = f.Persona
	case "stage":
		v = f.Stage
	case "goals":
		v = f.Goals
	case "keywords":
		v = f.Keywords
	case "taboo":
		v = f.Taboo
	case "pillars":
		v = f.Pillars
	case "cadence":
		v = f.Cadence
	}
	b, _ := json.Marshal(v)
	return b
}

// validChanges keeps changes whose field is a strategy field and whose value yields a valid strategy;
// "from" is always taken from the current version, never from the model.
func validChanges(a *Account, cur StrategyFields, in []StrategyChange) []StrategyChange {
	out := []StrategyChange{}
	seen := map[string]bool{}
	for _, c := range in {
		if _, ok := revisableFields[c.Field]; !ok || seen[c.Field] {
			continue
		}
		f := cur
		if applyStrategyChange(&f, c.Field, c.To) != nil || f.normalize(a) != nil {
			continue
		}
		to := strategyFieldJSON(&f, c.Field)
		from := strategyFieldJSON(&cur, c.Field)
		if string(to) == string(from) {
			continue
		}
		seen[c.Field] = true
		out = append(out, StrategyChange{Field: c.Field, From: from, To: to, Reason: truncateRunes(strings.TrimSpace(c.Reason), 200)})
	}
	return out
}

func (s *Server) reviseStrategy(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Note string `json:"note"`
	}
	_ = decodeOptional(r, &in)
	ctx := r.Context()
	cur, err := s.activeStrategy(ctx, a.ID)
	if err != nil {
		return err
	}
	if cur == nil {
		return stateInvalid("还没有启用的运营方案，请先完成起号向导")
	}
	rows, err := s.db.Query(ctx, `SELECT w.title, coalesce(t.strategy_pillar,''), w.status, m.reads, m.likes, m.favorites, m.comments
		FROM work w LEFT JOIN topic t ON t.id=w.topic_id
		LEFT JOIN LATERAL (SELECT reads, likes, favorites, comments FROM metric_snapshot WHERE work_id=w.id ORDER BY captured_at DESC LIMIT 1) m ON true
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.title<>'' AND w.created_at > now() - interval '30 days'
		ORDER BY w.created_at DESC LIMIT 30`, a.ID)
	if err != nil {
		return err
	}
	var works strings.Builder
	n := 0
	for rows.Next() {
		var title, pillar, status string
		var reads, likes, favs, comments *int
		if rows.Scan(&title, &pillar, &status, &reads, &likes, &favs, &comments) != nil {
			continue
		}
		n++
		metric := "无数据"
		if reads != nil || likes != nil {
			metric = fmt.Sprintf("阅读 %d、点赞 %d、收藏 %d、评论 %d", deref(reads), deref(likes), deref(favs), deref(comments))
		}
		fmt.Fprintf(&works, "- %s（支柱：%s；状态：%s；%s）\n", title, nz(pillar, "未标注"), status, metric)
	}
	rows.Close()
	if n == 0 {
		works.WriteString("（近 30 天没有作品）\n")
	}
	stats, err := s.dailySourceStats(ctx, a.ID)
	if err != nil {
		return err
	}
	adoption, _ := json.Marshal(stats)
	fmt.Fprintf(&works, "\n近30天每日推荐来源与采用统计：%s\n", adoption)
	current, _ := json.Marshal(map[string]any{"niche": cur.Niche, "audience": cur.Audience, "differentiation": cur.Differentiation,
		"persona": cur.Persona, "pillars": cur.Pillars, "cadence": cur.Cadence, "stage": cur.Stage, "goals": cur.Goals,
		"keywords": cur.Keywords, "taboo": cur.Taboo})
	fields := []string{}
	for k, v := range revisableFields {
		fields = append(fields, k+"（"+v+"）")
	}
	sort.Strings(fields)
	user := fmt.Sprintf(`## 当前运营方案（第 %d 版）
%s

## 近 30 天作品与数据
%s
## 运营者补充说明
%s

## 任务说明
根据作品表现给出方案的修改建议，每条只改一个字段，并说明理由；没有把握的不要改。
可修改的字段：%s。pillars 需给出完整的支柱列表（3–5 个，占比合计 100）；cadence 需给出完整的节奏对象；keywords、taboo、goals 给出完整的新列表。
不得编造作品或数据；数据不足时只建议补充数据，不要硬改。

## 输出格式
只输出 JSON：{"changes":[{"field":"字段名","from":"原值","to":"新值","reason":"理由"}]}`,
		cur.Version, current, works.String(), nz(truncateRunes(strings.TrimSpace(in.Note), 500), "无"), strings.Join(fields, "、"))
	var out struct {
		Changes []StrategyChange `json:"changes"`
	}
	var changes []StrategyChange
	res, err := s.runAIJSON(ctx, aiTask{Type: "strategy_revise", Account: a, User: user, SkipStyle: true, Refs: map[string]any{"works": n}}, &out, func() error {
		changes = validChanges(a, cur.StrategyFields, out.Changes)
		if len(changes) == 0 && len(out.Changes) > 0 {
			return fmt.Errorf("修改建议都不合法")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"changes": changes, "current": cur, "ai_call_id": res.CallID})
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func weeklyHours(h int) string {
	if h <= 0 {
		return "未填"
	}
	return fmt.Sprintf("%d 小时", h)
}
