package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// ---------- EX-A-01 智能建档（SSE，草稿不落库） ----------

type BootstrapDraft struct {
	PositioningTags    []string          `json:"positioning_tags"`
	TargetAudience     string            `json:"target_audience"`
	PersonaTone        string            `json:"persona_tone"`
	BannedWordsSuggest []string          `json:"banned_words_suggest"`
	StyleSummary       string            `json:"style_summary"`
	Evidence           map[string]string `json:"evidence"`
}

func (s *Server) profileBootstrap(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Samples []struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		} `json:"samples"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	var b strings.Builder
	n, total := 0, 0
	for _, x := range in.Samples {
		c := strings.TrimSpace(x.Content)
		if c == "" {
			continue
		}
		c = truncate(c, 1500)
		if total+runeLen(c) > 8000 {
			c = truncate(c, 8000-total)
		}
		if c == "" {
			break
		}
		n++
		total += runeLen(c)
		fmt.Fprintf(&b, "### 样本 %d：%s\n%s\n\n", n, strings.TrimSpace(x.Title), c)
		if n >= 10 {
			break
		}
	}
	if n == 0 {
		return validation("请至少粘贴一篇过往作品")
	}
	user := fmt.Sprintf(`## 账号
平台：%s；内容形态：%s

## 过往作品样本
%s
## 任务说明
只依据以上样本推断这个账号的定位档案。无法判断的字段留空，并在 evidence 中说明原因；不得编造作者身份、经历或头衔。

## 输出格式
只输出 JSON：{"positioning_tags":["标签"],"target_audience":"目标读者","persona_tone":"人设与语气","banned_words_suggest":["建议禁用词"],"style_summary":"风格摘要","evidence":{"字段名":"依据"}}`,
		platformNames[a.Platform], formatNames[a.ContentFormat], b.String())
	t := aiTask{Type: "profile_bootstrap", User: user, JSON: true, Refs: map[string]any{"samples": n}}
	return s.streamAIEphemeral(w, r, t,
		func(text string, _ *aiResult) (any, error) {
			var d BootstrapDraft
			if json.Unmarshal([]byte(ai.ExtractJSON(text)), &d) != nil || validBootstrap(&d) != nil {
				// 06 文档第 5.8 节：JSON 任务校验失败重试一次（重试不再流式输出）。
				d = BootstrapDraft{}
				if _, err := s.runAIJSON(r.Context(), t, &d, func() error { return validBootstrap(&d) }); err != nil {
					return nil, err
				}
			}
			return d, nil
		})
}

// validBootstrap normalises the draft and rejects one with no usable field.
func validBootstrap(d *BootstrapDraft) error {
	d.PositioningTags = cleanList(d.PositioningTags)
	if len(d.PositioningTags) > 8 {
		d.PositioningTags = d.PositioningTags[:8]
	}
	d.BannedWordsSuggest = cleanList(d.BannedWordsSuggest)
	d.TargetAudience = strings.TrimSpace(d.TargetAudience)
	d.PersonaTone = strings.TrimSpace(d.PersonaTone)
	d.StyleSummary = strings.TrimSpace(d.StyleSummary)
	if d.Evidence == nil {
		d.Evidence = map[string]string{}
	}
	if len(d.PositioningTags) == 0 && d.TargetAudience == "" && d.PersonaTone == "" && d.StyleSummary == "" {
		return fmt.Errorf("建档结果没有任何可用字段")
	}
	return nil
}

// ---------- EX-D-01 素材提炼（候选不落库） ----------

type MaterialCandidate struct {
	Kind       string   `json:"kind"`
	Content    string   `json:"content"`
	SourceHint string   `json:"source_hint"`
	Tags       []string `json:"tags"`
}

var digitRun = regexp.MustCompile(`\d+(?:[.,]\d+)*%?`)

// keepFaithfulNumbers drops data candidates whose numbers do not appear verbatim in the source text.
func keepFaithfulNumbers(items []MaterialCandidate, source string) []MaterialCandidate {
	norm := strings.ReplaceAll(source, ",", "")
	out := make([]MaterialCandidate, 0, len(items))
	for _, it := range items {
		it.Content = strings.TrimSpace(it.Content)
		if it.Content == "" || !materialKinds[it.Kind] {
			continue
		}
		faithful := true
		for _, num := range digitRun.FindAllString(it.Content, -1) {
			if !strings.Contains(source, num) && !strings.Contains(norm, strings.ReplaceAll(num, ",", "")) {
				faithful = false
				break
			}
		}
		if !faithful {
			if it.Kind == "data" {
				continue
			}
		}
		it.Tags = cleanList(it.Tags)
		if len(it.Tags) > 5 {
			it.Tags = it.Tags[:5]
		}
		out = append(out, it)
	}
	return out
}

func splitChunks(text string, size int) []string {
	rs := []rune(text)
	var out []string
	for start := 0; start < len(rs); {
		end := min(start+size, len(rs))
		if end < len(rs) {
			for k := end; k > start+size/2; k-- {
				if rs[k-1] == '\n' || rs[k-1] == '。' {
					end = k
					break
				}
			}
		}
		out = append(out, string(rs[start:end]))
		start = end
	}
	return out
}

func (s *Server) extractMaterialsFrom(ctx context.Context, a *Account, text string) ([]MaterialCandidate, *uuid.UUID, error) {
	var all []MaterialCandidate
	var lastCall *uuid.UUID
	for _, chunk := range splitChunks(text, 6000) {
		user := `## 原文
` + chunk + `

## 任务说明
从原文中拆出可复用的原子素材，类型只能是 experience（亲身经历）、opinion（观点）、case（案例）、data（数据）。
只摘录原文中有的信息，不改写事实；数据类必须保留原文中的数字和出处；每条素材独立成意，不超过 300 字；每条最多 5 个标签。

## 输出格式
只输出 JSON：{"items":[{"kind":"experience|opinion|case|data","content":"素材内容","source_hint":"出处线索","tags":["标签"]}]}`
		var out struct {
			Items []MaterialCandidate `json:"items"`
		}
		res, err := s.runAIJSON(ctx, aiTask{Type: "material_extract", Account: a, User: user, SkipStyle: true}, &out, nil)
		if err != nil {
			return nil, nil, err
		}
		lastCall = &res.CallID
		all = append(all, keepFaithfulNumbers(out.Items, chunk)...)
	}
	return all, lastCall, nil
}

func (s *Server) extractMaterials(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		AccountID *uuid.UUID `json:"account_id"`
		Text      string     `json:"text"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	text := strings.TrimSpace(in.Text)
	if text == "" {
		return validation("请粘贴要提炼的文本")
	}
	if runeLen(text) > 20000 {
		return validation("文本最多 2 万字，请分段提炼")
	}
	var a *Account
	if in.AccountID != nil {
		acc, err := s.account(ctx, *in.AccountID)
		if err != nil {
			return err
		}
		a = acc
	}
	if runeLen(text) <= 6000 {
		items, callID, err := s.extractMaterialsFrom(ctx, a, text)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"items": items, "ai_call_id": callID})
	}
	spec := jobSpec{TaskType: "material_extract", Label: "素材提炼", Link: "/materials?extract=1"}
	if a != nil {
		spec.AccountID = &a.ID
		spec.Link = "/a/" + a.ID.String() + "/materials?extract=1"
	}
	jobID, err := s.startBackgroundJob(ctx, spec, func(jctx context.Context) (any, error) {
		items, callID, err := s.extractMaterialsFrom(jctx, a, text)
		if err != nil {
			return nil, err
		}
		res := map[string]any{"items": items}
		if callID != nil {
			res["ai_call_id"] = *callID
		}
		return res, nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"job_id": jobID})
}

// ---------- EX-D-02 类型与标签建议（规则 + 轻量 AI） ----------

func guessMaterialKind(text string) string {
	switch {
	case digitRun.MatchString(text) && (strings.ContainsAny(text, "%％") || containsAny(text, "数据", "统计", "调查", "报告", "万", "亿", "同比", "占比")):
		return "data"
	case containsAny(text, "我当时", "那年", "我曾", "我在", "我们公司", "亲身", "经历"):
		return "experience"
	case containsAny(text, "案例", "比如", "例如", "公司", "品牌", "某某"):
		return "case"
	default:
		return "opinion"
	}
}

func containsAny(s string, subs ...string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

func (s *Server) workspaceMaterialTags(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT t, count(*) FROM material, unnest(tags) t WHERE workspace_id=$1 AND deleted_at IS NULL
		GROUP BY t ORDER BY count(*) DESC LIMIT $2`, ident(ctx).WorkspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		var n int
		if rows.Scan(&t, &n) == nil {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *Server) materialTagSuggest(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Content string `json:"content"`
		AI      *bool  `json:"ai"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	text := strings.TrimSpace(in.Content)
	if text == "" {
		return validation("请先填写素材内容")
	}
	existing, err := s.workspaceMaterialTags(ctx, 200)
	if err != nil {
		return err
	}
	kind := guessMaterialKind(text)
	tags := []string{}
	for _, t := range existing {
		if strings.Contains(text, t) && len(tags) < 5 {
			tags = append(tags, t)
		}
	}
	resp := map[string]any{"kind": kind, "tags": tags, "source": "rule"}
	if in.AI != nil && !*in.AI {
		return ok(w, resp)
	}
	known := existing
	if len(known) > 60 {
		known = known[:60]
	}
	user := `## 素材
` + truncate(text, 1500) + `

## 已有标签（优先复用）
` + strings.Join(known, "、") + `

## 任务说明
判断素材类型（experience 经历 / opinion 观点 / case 案例 / data 数据），并给出不超过 5 个标签，优先复用已有标签。

## 输出格式
只输出 JSON：{"kind":"类型","tags":["标签"]}`
	var out struct {
		Kind string   `json:"kind"`
		Tags []string `json:"tags"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "material_tag", User: user, Tier: "economy"}, &out, nil)
	if err != nil {
		slog.Debug("素材标签 AI 建议失败，返回规则结果", "err", err)
		return ok(w, resp)
	}
	if materialKinds[out.Kind] {
		resp["kind"] = out.Kind
	}
	merged := cleanList(append(tags, out.Tags...))
	if len(merged) > 5 {
		merged = merged[:5]
	}
	resp["tags"], resp["source"], resp["ai_call_id"] = merged, "ai", res.CallID
	return ok(w, resp)
}

// ---------- EX-D-05 相似素材合并（逐组） ----------

func (s *Server) materialDuplicates(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	accountID, err := uuid.Parse(r.URL.Query().Get("account_id"))
	if err != nil {
		return validation("缺少 account_id")
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, b.id, similarity(a.content, b.content) FROM material a JOIN material b
		ON a.id < b.id AND a.workspace_id=b.workspace_id AND b.deleted_at IS NULL AND (b.account_id=$2 OR b.account_id IS NULL)
		WHERE a.workspace_id=$1 AND a.deleted_at IS NULL AND (a.account_id=$2 OR a.account_id IS NULL)
		AND a.content % b.content AND similarity(a.content, b.content) >= 0.7 LIMIT 200`, ident(ctx).WorkspaceID, accountID)
	if err != nil {
		return err
	}
	parent := map[uuid.UUID]uuid.UUID{}
	var find func(uuid.UUID) uuid.UUID
	find = func(x uuid.UUID) uuid.UUID {
		if p, ok := parent[x]; ok && p != x {
			r := find(p)
			parent[x] = r
			return r
		}
		parent[x] = x
		return x
	}
	for rows.Next() {
		var a, b uuid.UUID
		var sim float64
		if rows.Scan(&a, &b, &sim) == nil {
			ra, rb := find(a), find(b)
			if ra != rb {
				parent[rb] = ra
			}
		}
	}
	rows.Close()
	groups := map[uuid.UUID][]uuid.UUID{}
	for id := range parent {
		root := find(id)
		groups[root] = append(groups[root], id)
	}
	out := [][]Material{}
	for _, ids := range groups {
		if len(ids) < 2 {
			continue
		}
		mrows, err := s.db.Query(ctx, `SELECT `+materialCols+` FROM material m WHERE m.id = ANY($1) ORDER BY m.created_at`, ids)
		if err != nil {
			return err
		}
		var g []Material
		for mrows.Next() {
			if m, err := scanMaterial(mrows); err == nil {
				g = append(g, m)
			}
		}
		mrows.Close()
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i][0].CreatedAt.After(out[j][0].CreatedAt) })
	return ok(w, out)
}

func (s *Server) mergeMaterials(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		KeepID  uuid.UUID   `json:"keep_id"`
		DropIDs []uuid.UUID `json:"drop_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if len(in.DropIDs) == 0 || len(in.DropIDs) > 10 {
		return validation("请选择要合并的一组素材")
	}
	if err := s.ownedMaterial(ctx, in.KeepID); err != nil {
		return err
	}
	for _, id := range in.DropIDs {
		if id == in.KeepID {
			return validation("保留的素材不能同时被合并")
		}
		if err := s.ownedMaterial(ctx, id); err != nil {
			return err
		}
	}
	err := s.withTx(ctx, func(q pgx.Tx) error {
		if _, err := q.Exec(ctx, `INSERT INTO work_material (work_id, material_id) SELECT work_id, $1 FROM work_material WHERE material_id = ANY($2)
			ON CONFLICT DO NOTHING`, in.KeepID, in.DropIDs); err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `DELETE FROM work_material WHERE material_id = ANY($1)`, in.DropIDs); err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `UPDATE work_section SET material_ids = array_append(array(SELECT x FROM unnest(material_ids) x WHERE x <> ALL($2)), $1)
			WHERE material_ids && $2`, in.KeepID, in.DropIDs); err != nil {
			return err
		}
		_, err := q.Exec(ctx, `UPDATE material SET deleted_at=now() WHERE id = ANY($1)`, in.DropIDs)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "material_merge", "material", in.KeepID.String(), "ok", map[string]any{"dropped": len(in.DropIDs)})
	return ok(w, map[string]any{"ok": true})
}

// ---------- EX-C-03 灵感收件箱（逐条转换） ----------

type InboxItem struct {
	ID         uuid.UUID       `json:"id"`
	AccountID  *uuid.UUID      `json:"account_id"`
	Content    string          `json:"content"`
	Source     string          `json:"source"`
	Suggestion json.RawMessage `json:"suggestion"`
	Status     string          `json:"status"`
	CreatedAt  time.Time       `json:"created_at"`
}

const inboxCols = `id, account_id, content, source, suggestion, status, created_at`

func scanInbox(row pgx.Row) (InboxItem, error) {
	var x InboxItem
	var sug []byte
	err := row.Scan(&x.ID, &x.AccountID, &x.Content, &x.Source, &sug, &x.Status, &x.CreatedAt)
	if len(sug) > 0 {
		x.Suggestion = sug
	}
	return x, err
}

func (s *Server) listInbox(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "new"
	}
	rows, err := s.db.Query(ctx, `SELECT `+inboxCols+` FROM inbox_item WHERE workspace_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 200`,
		ident(ctx).WorkspaceID, status)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []InboxItem{}
	for rows.Next() {
		x, err := scanInbox(rows)
		if err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) createInbox(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		AccountID *uuid.UUID `json:"account_id"`
		Content   string     `json:"content"`
		Source    string     `json:"source"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		return validation("请写下灵感内容")
	}
	if runeLen(in.Content) > 2000 {
		return validation("灵感最多 2000 字")
	}
	switch in.Source {
	case "quick", "share", "palette", "mobile":
	default:
		in.Source = "quick"
	}
	if in.AccountID != nil {
		if _, err := s.account(ctx, *in.AccountID); err != nil {
			return err
		}
	}
	x, err := scanInbox(s.db.QueryRow(ctx, `INSERT INTO inbox_item (workspace_id, account_id, content, source, created_by) VALUES ($1,$2,$3,$4,$5)
		RETURNING `+inboxCols, ident(ctx).WorkspaceID, in.AccountID, in.Content, in.Source, ident(ctx).UserID))
	if err != nil {
		return err
	}
	return ok(w, x)
}

func (s *Server) ownedInbox(ctx context.Context, id uuid.UUID) (*InboxItem, error) {
	x, err := scanInbox(s.db.QueryRow(ctx, `SELECT `+inboxCols+` FROM inbox_item WHERE id=$1 AND workspace_id=$2`, id, ident(ctx).WorkspaceID))
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func (s *Server) deleteInbox(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.ownedInbox(ctx, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE inbox_item SET status='dismissed', updated_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

type inboxSuggestion struct {
	As       string   `json:"as"`
	Title    string   `json:"title"`
	Angle    string   `json:"angle"`
	Audience string   `json:"audience"`
	Kind     string   `json:"kind"`
	Tags     []string `json:"tags"`
	Reason   string   `json:"reason"`
}

func (s *Server) triageInboxItem(ctx context.Context, x *InboxItem) (*inboxSuggestion, error) {
	var a *Account
	if x.AccountID != nil {
		a, _ = s.account(ctx, *x.AccountID)
	}
	user := `## 灵感
` + x.Content + `

## 任务说明
判断这条灵感更适合作为"选题"（topic）还是"素材"（material）。只建议归类，不改写原意。
选题需补全 title（不超过 30 字）、angle、audience；素材需给出 kind（experience/opinion/case/data）和不超过 5 个 tags。

## 输出格式
只输出 JSON：{"as":"topic|material","title":"","angle":"","audience":"","kind":"","tags":[],"reason":"一句话理由"}`
	var out inboxSuggestion
	_, err := s.runAIJSON(ctx, aiTask{Type: "inbox_triage", Account: a, User: user, SkipStyle: true, Tier: "economy"}, &out, func() error {
		if out.As != "topic" && out.As != "material" {
			return fmt.Errorf("归类无效")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if out.As == "material" && !materialKinds[out.Kind] {
		out.Kind = guessMaterialKind(x.Content)
	}
	b, _ := json.Marshal(out)
	_, _ = s.db.Exec(ctx, `UPDATE inbox_item SET suggestion=$2, updated_at=now() WHERE id=$1`, x.ID, b)
	return &out, nil
}

func (s *Server) triageInbox(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	x, err := s.ownedInbox(ctx, id)
	if err != nil {
		return err
	}
	sug, err := s.triageInboxItem(ctx, x)
	if err != nil {
		return err
	}
	return ok(w, sug)
}

// convertInbox turns exactly one inbox item into a topic or a material.
func (s *Server) convertInbox(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	x, err := s.ownedInbox(ctx, id)
	if err != nil {
		return err
	}
	if x.Status != "new" {
		return stateInvalid("这条灵感已经处理过了")
	}
	var in struct {
		To        string     `json:"to"`
		AccountID *uuid.UUID `json:"account_id"`
		Title     string     `json:"title"`
		Angle     string     `json:"angle"`
		Audience  string     `json:"audience"`
		Kind      string     `json:"kind"`
		Content   string     `json:"content"`
		Tags      []string   `json:"tags"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	accountID := in.AccountID
	if accountID == nil {
		accountID = x.AccountID
	}
	var newID uuid.UUID
	switch in.To {
	case "topic":
		if accountID == nil {
			return validation("请选择要放入哪个账号的选题池")
		}
		a, err := s.account(ctx, *accountID)
		if err != nil {
			return err
		}
		title := strings.TrimSpace(nz(in.Title, x.Content))
		err = s.withTx(ctx, func(q pgx.Tx) error {
			if err := q.QueryRow(ctx, `INSERT INTO topic (account_id, title, angle, audience, source) VALUES ($1,$2,$3,$4,'inbox') RETURNING id`,
				a.ID, truncateRunes(title, 64), strings.TrimSpace(in.Angle), strings.TrimSpace(in.Audience)).Scan(&newID); err != nil {
				return err
			}
			_, err := q.Exec(ctx, `UPDATE inbox_item SET status='converted', updated_at=now() WHERE id=$1`, id)
			return err
		})
		if err != nil {
			return err
		}
	case "material":
		mi := materialInput{AccountID: accountID, Kind: in.Kind, Content: nz(in.Content, x.Content), Tags: in.Tags, Source: "灵感收件箱"}
		if mi.Kind == "" {
			mi.Kind = guessMaterialKind(mi.Content)
		}
		if err := s.validMaterial(ctx, &mi); err != nil {
			return err
		}
		err = s.withTx(ctx, func(q pgx.Tx) error {
			if err := q.QueryRow(ctx, `INSERT INTO material (workspace_id, account_id, kind, content, source, tags) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
				ident(ctx).WorkspaceID, mi.AccountID, mi.Kind, mi.Content, mi.Source, cleanList(mi.Tags)).Scan(&newID); err != nil {
				return err
			}
			_, err := q.Exec(ctx, `UPDATE inbox_item SET status='converted', updated_at=now() WHERE id=$1`, id)
			return err
		})
		if err != nil {
			return err
		}
	default:
		return validation("只能转为选题或素材")
	}
	return ok(w, map[string]any{"id": newID, "to": in.To})
}

// inboxTriageDaily fills suggestions for new items once a day; it never converts anything.
func (s *Server) inboxTriageDaily(ctx context.Context) {
	day := s.today().Format("2006-01-02")
	rows, err := s.db.Query(ctx, `SELECT workspace_id, id FROM inbox_item WHERE status='new' AND suggestion IS NULL ORDER BY created_at LIMIT 100`)
	if err != nil {
		return
	}
	type pair struct{ ws, id uuid.UUID }
	var list []pair
	for rows.Next() {
		var p pair
		if rows.Scan(&p.ws, &p.id) == nil {
			list = append(list, p)
		}
	}
	rows.Close()
	for _, p := range list {
		if !s.markOnce(ctx, "inbox:"+p.id.String()+":"+day) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: p.ws})
		x, err := s.ownedInbox(jctx, p.id)
		if err != nil {
			continue
		}
		if _, err := s.triageInboxItem(jctx, x); err != nil {
			slog.Debug("收件箱整理失败", "err", err)
		}
	}
}

// ---------- EX-F-02 话题标签推荐 ----------

func (s *Server) workTagSuggest(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	type tagSug struct {
		Text   string `json:"text"`
		Reason string `json:"reason"`
		Source string `json:"source"`
	}
	history := []tagSug{}
	rows, err := s.db.Query(ctx, `SELECT t, count(*), coalesce(avg(mx.reads),0)::int FROM work w, unnest(w.topics) t
		LEFT JOIN LATERAL (SELECT max(reads) reads FROM metric_snapshot ms WHERE ms.work_id=w.id) mx ON true
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.id <> $2 GROUP BY t ORDER BY 3 DESC, 2 DESC LIMIT 10`, m.Account.ID, m.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t string
		var n, reads int
		if rows.Scan(&t, &n, &reads) == nil {
			reason := fmt.Sprintf("本账号用过 %d 次", n)
			if reads > 0 {
				reason += fmt.Sprintf("，相关作品平均阅读 %d", reads)
			}
			history = append(history, tagSug{Text: t, Reason: reason, Source: "history"})
		}
	}
	rows.Close()
	body, _ := s.workPlainText(ctx, m.ID)
	resp := map[string]any{"history": history, "ai": []tagSug{}}
	if strings.TrimSpace(body) == "" && m.Title == "" {
		return ok(w, resp)
	}
	user := "## 作品\n标题：" + m.Title + "\n" + truncate(body, 3000) + `

## 任务说明
根据正文建议不超过 10 个小红书话题标签（以 # 开头），每个给一句理由。不要声称任何热度或流量数据。

## 输出格式
只输出 JSON：{"tags":[{"text":"#话题","reason":"理由"}]}`
	var out struct {
		Tags []tagSug `json:"tags"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "tag_suggest", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true, Tier: "economy"}, &out, nil)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	aiTags := []tagSug{}
	for _, t := range out.Tags {
		t.Text = strings.TrimSpace(t.Text)
		if t.Text == "" || seen[t.Text] {
			continue
		}
		if !strings.HasPrefix(t.Text, "#") {
			t.Text = "#" + t.Text
		}
		seen[t.Text] = true
		t.Source = "ai"
		aiTags = append(aiTags, t)
		if len(aiTags) >= 10 {
			break
		}
	}
	resp["ai"], resp["ai_call_id"] = aiTags, res.CallID
	return ok(w, resp)
}

func (s *Server) workPlainText(ctx context.Context, workID uuid.UUID) (string, error) {
	rows, err := s.db.Query(ctx, `SELECT heading, content_md FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position`, workID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var h, c string
		if rows.Scan(&h, &c) == nil {
			if h != "" {
				b.WriteString(h + "\n")
			}
			b.WriteString(c + "\n\n")
		}
	}
	return b.String(), nil
}
