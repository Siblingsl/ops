package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

type CheckItem struct {
	ID          uuid.UUID      `json:"id"`
	Category    string         `json:"category"`
	Passed      bool           `json:"passed"`
	MatchedText string         `json:"matched_text"`
	Location    map[string]any `json:"location"`
	Message     string         `json:"message"`
	Detail      string         `json:"detail"`
	Resolution  *string        `json:"resolution"`
	ResolvedAt  *time.Time     `json:"resolved_at"`
	fingerprint string
}

type CheckRun struct {
	ID             uuid.UUID   `json:"id"`
	Revision       int         `json:"revision"`
	TargetPlatform string      `json:"target_platform"`
	FactStatus     string      `json:"fact_status"`
	CompletedAt    *time.Time  `json:"completed_at"`
	CreatedAt      time.Time   `json:"created_at"`
	Stale          bool        `json:"stale"`
	Items          []CheckItem `json:"items"`
	Total          int         `json:"total"`
	Confirmed      int         `json:"confirmed"`
	Blocking       int         `json:"blocking"`
}

var allowedResolutions = map[string][]string{
	"sensitive":     {"modified", "kept"},
	"fact":          {"verified", "modified"},
	"ai_disclosure": {"acknowledged"},
	"similarity":    {"acknowledged", "modified"},
	"ad_law":        {"acknowledged", "modified"},
}

var pendingMarker = regexp.MustCompile(`【待核实[^】]*】`)

func sentenceAround(text string, idx, n int) string {
	runes := []rune(text)
	start := len([]rune(text[:idx]))
	end := start + len([]rune(text[idx:idx+n]))
	isStop := func(r rune) bool { return r == '。' || r == '！' || r == '？' || r == '\n' || r == '!' || r == '?' }
	for start > 0 && !isStop(runes[start-1]) {
		start--
	}
	for end < len(runes) && !isStop(runes[end]) {
		end++
	}
	if end < len(runes) {
		end++
	}
	return strings.TrimSpace(string(runes[start:end]))
}

func fingerprint(category, matched, sentence string) string {
	return secure.SHA256Hex([]byte(category + "|" + matched + "|" + sentence))[:32]
}

type textField struct {
	Name      string
	SectionID *uuid.UUID
	Label     string
	Text      string
}

func workFields(w *Work) []textField {
	f := []textField{{Name: "title", Label: "标题", Text: w.Title}}
	if w.Summary != "" {
		f = append(f, textField{Name: "summary", Label: "摘要", Text: w.Summary})
	}
	for i := range w.Sections {
		sec := w.Sections[i]
		label := fmt.Sprintf("第 %d 段", i+1)
		if sec.Heading != "" {
			f = append(f, textField{Name: "heading", SectionID: &w.Sections[i].ID, Label: label + "小标题", Text: sec.Heading})
		}
		f = append(f, textField{Name: "section", SectionID: &w.Sections[i].ID, Label: label, Text: sec.ContentMD})
	}
	for i := range w.Panels {
		p := w.Panels[i]
		label := fmt.Sprintf("第 %d 格", p.Position)
		id := p.ID
		if p.Narration != "" {
			f = append(f, textField{Name: "narration", SectionID: &id, Label: label + "旁白", Text: p.Narration})
		}
		if p.Dialogue != "" {
			f = append(f, textField{Name: "dialogue", SectionID: &id, Label: label + "对白", Text: p.Dialogue})
		}
	}
	return f
}

func loc(f textField) map[string]any {
	m := map[string]any{"field": f.Name, "label": f.Label}
	if f.SectionID != nil {
		m["section_id"] = f.SectionID.String()
	}
	return m
}

func formatItem(rule string, passed bool, msg, detail string, location map[string]any) CheckItem {
	if location == nil {
		location = map[string]any{}
	}
	return CheckItem{Category: "format", Passed: passed, Message: msg, Detail: detail, Location: location, fingerprint: "format|" + rule}
}

func (s *Server) buildRuleItems(ctx context.Context, w *Work, htmlChars, htmlBytes int) ([]CheckItem, error) {
	var items []CheckItem
	add := func(it CheckItem) { items = append(items, it) }
	title := runeLen(w.Title)
	comic := w.ContentFormat == "comic"
	if w.Platform == "wechat_mp" {
		add(formatItem("title", title > 0 && title <= 32, fmt.Sprintf("标题 %d / 32 字", title), "公众号标题不能为空且不超过 32 字", map[string]any{"field": "title"}))
		if !comic {
			add(formatItem("summary", runeLen(w.Summary) <= 120, fmt.Sprintf("摘要 %d / 120 字", runeLen(w.Summary)), "摘要不超过 120 字；留空时微信会抓取正文前 54 字", map[string]any{"field": "summary"}))
			add(formatItem("author", runeLen(w.WechatFields.Author) <= 16, fmt.Sprintf("作者 %d / 16 字", runeLen(w.WechatFields.Author)), "", nil))
			add(formatItem("source_url", len(w.WechatFields.SourceURL) <= 1024, "阅读原文链接长度", "不超过 1KB", nil))
			add(formatItem("cover", w.CoverAssetID != nil && len(w.CoverCrops) > 0, "封面与裁剪区域", "需要设置封面，并确认 2.35:1 和 1:1 两个裁剪区域", map[string]any{"field": "cover"}))
			if htmlChars > 0 {
				add(formatItem("html", htmlChars < 20000 && htmlBytes < 1<<20, fmt.Sprintf("排版后 HTML %d / 20000 字符，%.0f KB / 1024 KB", htmlChars, float64(htmlBytes)/1024),
					"超出时请删减内容或减少样式", nil))
			}
		}
	} else {
		add(formatItem("title", title > 0, fmt.Sprintf("标题 %d 字", title), "标题不能为空；字数上限待核实（V-012）", map[string]any{"field": "title"}))
		if !comic {
			n := len(w.Assets)
			add(formatItem("images", n >= 1 && n <= 18, fmt.Sprintf("图片 %d 张（需要 1–18 张）", n), "小红书图文笔记至少 1 张图片", map[string]any{"field": "images"}))
		}
	}
	oversize := 0
	for _, a := range w.Assets {
		if a.Bytes > maxStoredBytes {
			oversize++
		}
	}
	add(formatItem("image_size", oversize == 0, fmt.Sprintf("图片 %d 张，均不超过 1MB", len(w.Assets)), "", nil))
	if comic {
		missingImg, missingText := 0, 0
		for _, p := range w.Panels {
			if p.AssetID == nil {
				missingImg++
			}
			if strings.TrimSpace(p.Narration) == "" && strings.TrimSpace(p.Dialogue) == "" {
				missingText++
			}
		}
		maxImg := 20
		if w.Platform == "xhs" {
			maxImg = 18
		}
		n := len(w.Panels) - missingImg
		add(formatItem("panels", len(w.Panels) >= 2 && missingText == 0, fmt.Sprintf("分镜 %d 格，%d 格无旁白/对白", len(w.Panels), missingText), "请先确认分镜并补齐逐格文案", map[string]any{"field": "panels"}))
		add(formatItem("panel_images", missingImg == 0 && n >= 1 && n <= maxImg, fmt.Sprintf("回传图片 %d / %d 格（上限 %d）", n, len(w.Panels), maxImg), "每一格都需要回传图片后才能发布", map[string]any{"field": "images"}))
	} else {
		empty := 0
		for _, sec := range w.Sections {
			if strings.TrimSpace(sec.ContentMD) == "" {
				empty++
			}
		}
		add(formatItem("sections", len(w.Sections) > 0 && empty == 0, fmt.Sprintf("正文 %d 段，%d 段为空", len(w.Sections), empty), "每一段都需要有内容，空段可以删除", nil))
	}
	for _, f := range workFields(w) {
		for _, mm := range pendingMarker.FindAllStringIndex(f.Text, -1) {
			add(formatItem("pending|"+f.Label+"|"+f.Text[mm[0]:mm[1]], false, "残留待核实标记："+f.Text[mm[0]:mm[1]],
				"请补充真实信息或删除这句话", loc(f)))
			items[len(items)-1].MatchedText = f.Text[mm[0]:mm[1]]
		}
	}

	// 敏感词：基础词库 + 自定义词库 + 账号禁用词（Aho-Corasick 级别的规模用逐词查找即可）。
	type word struct{ w, source string }
	var words []word
	rows, err := s.db.Query(ctx, `SELECT word, source FROM sensitive_word WHERE workspace_id=$1`, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x word
		if err := rows.Scan(&x.w, &x.source); err == nil {
			words = append(words, x)
		}
	}
	rows.Close()
	p, err := s.loadProfile(ctx, w.AccountID)
	if err != nil {
		return nil, err
	}
	for _, b := range p.BannedWords {
		words = append(words, word{b, "account"})
	}
	sourceLabel := map[string]string{"base": "通用词库", "custom": "自定义词库", "account": "账号禁用词"}
	hits := 0
	for _, f := range workFields(w) {
		for _, wd := range words {
			if wd.w == "" {
				continue
			}
			off := 0
			for hits < 60 {
				i := strings.Index(f.Text[off:], wd.w)
				if i < 0 {
					break
				}
				i += off
				sent := sentenceAround(f.Text, i, len(wd.w))
				items = append(items, CheckItem{Category: "sensitive", MatchedText: wd.w, Location: loc(f),
					Message: fmt.Sprintf("「%s」命中%s", wd.w, sourceLabel[wd.source]), Detail: sent, fingerprint: fingerprint("sensitive", wd.w, sent)})
				hits++
				off = i + len(wd.w)
			}
		}
	}
	disclosure := "发布时在公众号文末或后台声明内容使用了 AI 辅助"
	if w.Platform == "xhs" {
		disclosure = "发布时在「笔记内容声明」中勾选「笔记含 AI 合成内容」"
	}
	items = append(items, CheckItem{Category: "ai_disclosure", Message: "AI 声明", Detail: disclosure, Location: map[string]any{}, fingerprint: "ai_disclosure|" + w.Platform})

	// FR-M9-07 广告法极限词（提示项，需确认）
	adWords := []string{"最", "第一", "唯一", "首个", "顶级", "极致", "绝对", "100%", "永久", "国家级", "世界级"}
	adHits := 0
	for _, f := range workFields(w) {
		for _, wd := range adWords {
			if adHits >= 20 {
				break
			}
			off := 0
			for adHits < 20 {
				i := strings.Index(f.Text[off:], wd)
				if i < 0 {
					break
				}
				i += off
				sent := sentenceAround(f.Text, i, len(wd))
				items = append(items, CheckItem{Category: "ad_law", MatchedText: wd, Location: loc(f),
					Message: fmt.Sprintf("广告法极限词「%s」", wd), Detail: "建议改为可核实的表述，或删去绝对化用词。原文：" + sent,
					fingerprint: fingerprint("ad_law", wd, sent)})
				adHits++
				off = i + len([]byte(wd))
			}
		}
	}

	// FR-M9-06 同质化提示：与本账号其他作品标题/正文相似度
	if sim, err := s.similarWorks(ctx, w); err == nil {
		for _, title := range sim {
			items = append(items, CheckItem{Category: "similarity", Message: "与历史作品相似：「" + title + "」",
				Detail: "仅作自查提示，不阻止发布。可改标题/角度或确认已知悉。", Location: map[string]any{"field": "title"},
				fingerprint: fingerprint("similarity", title, w.Title)})
		}
	}
	return items, nil
}

func (s *Server) similarWorks(ctx context.Context, w *Work) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT title FROM work WHERE account_id=$1 AND id<>$2 AND deleted_at IS NULL AND title<>''
		AND similarity(title, $3) > 0.4 ORDER BY similarity(title, $3) DESC LIMIT 3`, w.AccountID, w.ID, w.Title)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil && t != w.Title {
			out = append(out, t)
		}
	}
	return out, nil
}

func (s *Server) insertItems(ctx context.Context, tx pgx.Tx, workID, runID uuid.UUID, items []CheckItem) error {
	prev := map[string]string{}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (ci.fingerprint) ci.fingerprint, ci.resolution FROM check_item ci
		JOIN check_run cr ON cr.id=ci.check_run_id WHERE cr.work_id=$1 AND ci.resolution IS NOT NULL AND ci.category<>'format'
		ORDER BY ci.fingerprint, ci.resolved_at DESC`, workID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var fp, res string
		if err := rows.Scan(&fp, &res); err == nil {
			prev[fp] = res
		}
	}
	rows.Close()
	for _, it := range items {
		var res *string
		var resolvedAt *time.Time
		if r, ok := prev[it.fingerprint]; ok && it.Category != "format" {
			res = &r
			now := s.now()
			resolvedAt = &now
		}
		locJSON, _ := json.Marshal(it.Location)
		if _, err := tx.Exec(ctx, `INSERT INTO check_item (check_run_id, category, passed, fingerprint, matched_text, location, message, detail, resolution, resolved_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, runID, it.Category, it.Passed, it.fingerprint, it.MatchedText, locJSON, it.Message, it.Detail, res, resolvedAt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) startCheck(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Status == "published" {
		return stateInvalid("作品已发布，不需要再检查")
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		HTMLChars int `json:"html_chars"`
		HTMLBytes int `json:"html_bytes"`
	}
	_ = decode(r, &in)
	ctx := r.Context()
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	items, err := s.buildRuleItems(ctx, wk, in.HTMLChars, in.HTMLBytes)
	if err != nil {
		return err
	}
	_, routeErr := s.resolveRoute(ctx, "fact_flag")
	factStatus := "pending"
	if routeErr != nil {
		factStatus = "failed"
		items = append(items, CheckItem{Category: "fact", Message: "AI 事实核查不可用（未配置模型）",
			Detail: "请人工通读全文，逐一核实其中的数据、引语、时间和绝对化表达", Location: map[string]any{}, fingerprint: fingerprint("fact", "manual", wk.ID.String()+fmt.Sprint(wk.Revision))})
	}
	var runID uuid.UUID
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if err := s.addVersion(ctx, tx, m.ID, "check"); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO check_run (work_id, revision, target_platform, fact_status) VALUES ($1,$2,$3,$4) RETURNING id`,
			m.ID, wk.Revision, wk.Platform, factStatus).Scan(&runID); err != nil {
			return err
		}
		if err := s.insertItems(ctx, tx, m.ID, runID, items); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE work SET status='checking', updated_at=now() WHERE id=$1 AND status<>'published'`, m.ID)
		return err
	})
	if err != nil {
		return err
	}
	if factStatus == "pending" {
		bg := context.WithValue(context.Background(), ctxMember, ident(ctx))
		go s.runFactCheck(bg, wk, m.Account, runID)
	}
	return s.writeLatestCheck(w, r, m.ID)
}

// runFactCheck asks the model for verbatim quotes and locates them server-side (06 文档第 5.8 节).
func (s *Server) runFactCheck(ctx context.Context, wk *Work, a *Account, runID uuid.UUID) {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	var b strings.Builder
	for _, sec := range wk.Sections {
		fmt.Fprintf(&b, "【段落 id=%s】%s\n%s\n", sec.ID, sec.Heading, sec.ContentMD)
	}
	user := fmt.Sprintf(`## 待核查的文章
标题：%s

%s
## 任务说明
找出文中需要人工核实的句子：具体数据、引语、时间、人物或机构，以及"最、第一、绝对"等绝对化断言。quote 必须是原文中逐字摘录的完整句子，不要改写；section_id 填句子所在段落的 id。不要判断真假，只标出需要核实的地方。

## 输出格式
只输出 JSON：{"items":[{"section_id":"段落 id","quote":"原文句子","claim_type":"data|quote|absolute|time|entity","reason":"为什么需要核实"}]}`, wk.Title, b.String())
	var out struct {
		Items []struct {
			SectionID string `json:"section_id"`
			Quote     string `json:"quote"`
			ClaimType string `json:"claim_type"`
			Reason    string `json:"reason"`
		} `json:"items"`
	}
	_, err := s.runAIJSON(ctx, aiTask{Type: "fact_flag", Account: a, WorkID: &wk.ID, User: user, SkipStyle: true}, &out, nil)
	claimLabel := map[string]string{"data": "数据", "quote": "引语", "absolute": "绝对化断言", "time": "时间", "entity": "人物或机构"}
	var items []CheckItem
	status := "done"
	if err != nil {
		status = "failed"
		msg := err.Error()
		if ae, ok := err.(*APIError); ok {
			msg = ae.Message
		}
		items = append(items, CheckItem{Category: "fact", Message: "AI 事实核查失败", Detail: msg + "。请人工通读全文，逐一核实数据、引语和绝对化表达。",
			Location: map[string]any{}, fingerprint: fingerprint("fact", "manual", runID.String())})
	}
	sections := map[string]Section{}
	for _, sec := range wk.Sections {
		sections[sec.ID.String()] = sec
	}
	strip := func(s string) string {
		return strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) {
				return -1
			}
			return r
		}, s)
	}
	for _, it := range out.Items {
		quote := strings.TrimSpace(it.Quote)
		if quote == "" {
			continue
		}
		location := map[string]any{"found": false}
		sec, okSec := sections[it.SectionID]
		candidates := wk.Sections
		if okSec {
			candidates = []Section{sec}
		}
		for i, c := range candidates {
			if strings.Contains(c.ContentMD, quote) || strings.Contains(strip(c.ContentMD), strip(quote)) {
				location = map[string]any{"found": true, "field": "section", "section_id": c.ID.String(), "label": fmt.Sprintf("段落「%s」", nz(c.Heading, fmt.Sprint(i+1)))}
				break
			}
		}
		items = append(items, CheckItem{Category: "fact", MatchedText: quote, Location: location,
			Message: "需要核实的" + nz(claimLabel[it.ClaimType], "内容"), Detail: it.Reason, fingerprint: fingerprint("fact", quote, quote)})
	}
	err = s.withTx(context.WithoutCancel(ctx), func(tx pgx.Tx) error {
		if err := s.insertItems(ctx, tx, wk.ID, runID, items); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE check_run SET fact_status=$2 WHERE id=$1`, runID, status)
		return err
	})
	if err != nil {
		slog.Error("保存事实核查结果失败", "err", err)
	}
}

func (s *Server) loadLatestCheck(ctx context.Context, workID uuid.UUID) (*CheckRun, error) {
	var run CheckRun
	err := s.db.QueryRow(ctx, `SELECT id, revision, target_platform, fact_status, completed_at, created_at FROM check_run WHERE work_id=$1 ORDER BY created_at DESC LIMIT 1`, workID).
		Scan(&run.ID, &run.Revision, &run.TargetPlatform, &run.FactStatus, &run.CompletedAt, &run.CreatedAt)
	if err != nil {
		return nil, err
	}
	var rev int
	if err := s.db.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1`, workID).Scan(&rev); err != nil {
		return nil, err
	}
	run.Stale = rev != run.Revision
	rows, err := s.db.Query(ctx, `SELECT id, category, passed, matched_text, location, message, detail, resolution, resolved_at FROM check_item
		WHERE check_run_id=$1 ORDER BY CASE category WHEN 'format' THEN 0 WHEN 'sensitive' THEN 1 WHEN 'fact' THEN 2 ELSE 3 END, created_at`, run.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	run.Items = []CheckItem{}
	for rows.Next() {
		var it CheckItem
		var locJSON []byte
		if err := rows.Scan(&it.ID, &it.Category, &it.Passed, &it.MatchedText, &locJSON, &it.Message, &it.Detail, &it.Resolution, &it.ResolvedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(locJSON, &it.Location)
		run.Items = append(run.Items, it)
		if it.Category == "format" {
			if it.Passed {
				continue
			}
			run.Blocking++
			continue
		}
		run.Total++
		if it.Resolution != nil {
			run.Confirmed++
		}
	}
	return &run, nil
}

func (s *Server) writeLatestCheck(w http.ResponseWriter, r *http.Request, workID uuid.UUID) error {
	run, err := s.loadLatestCheck(r.Context(), workID)
	if err == pgx.ErrNoRows {
		return ok(w, map[string]any{"run": nil})
	}
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"run": run})
}

func (s *Server) latestCheck(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	return s.writeLatestCheck(w, r, m.ID)
}

// resolveCheckItem sets one item at a time; there is no bulk endpoint (H-04, HC-04).
func (s *Server) resolveCheckItem(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var workID, runID uuid.UUID
	var category string
	if err := s.db.QueryRow(ctx, `SELECT cr.work_id, cr.id, ci.category FROM check_item ci JOIN check_run cr ON cr.id=ci.check_run_id WHERE ci.id=$1`, id).
		Scan(&workID, &runID, &category); err != nil {
		return err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	latest, err := s.loadLatestCheck(ctx, m.ID)
	if err != nil {
		return err
	}
	if latest.ID != runID {
		return stateInvalid("这是旧的检查结果，请刷新")
	}
	var in struct {
		Resolution *string `json:"resolution"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Resolution != nil {
		allowed := false
		for _, a := range allowedResolutions[category] {
			if a == *in.Resolution {
				allowed = true
			}
		}
		if !allowed {
			return validation("这一项不能这样处理（格式问题必须修改后重新检查）")
		}
	}
	var resolvedAt *time.Time
	if in.Resolution != nil {
		t := s.now()
		resolvedAt = &t
	}
	if _, err := s.db.Exec(ctx, `UPDATE check_item SET resolution=$2, resolved_at=$3 WHERE id=$1`, id, in.Resolution, resolvedAt); err != nil {
		return err
	}
	s.audit(ctx, "check_resolve", "check_item", id.String(), "ok", map[string]any{"work_id": m.ID.String(), "resolution": in.Resolution})
	return s.writeLatestCheck(w, r, m.ID)
}

func (s *Server) completeCheck(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	run, err := s.loadLatestCheck(ctx, m.ID)
	if err == pgx.ErrNoRows {
		return humanStep("H-04", "请先发起发布前检查")
	}
	if err != nil {
		return err
	}
	if run.Stale {
		return stateInvalid("内容在检查后又修改过，请重新检查")
	}
	if run.FactStatus == "pending" {
		return stateInvalid("事实核查还在进行，请稍等")
	}
	if run.Blocking > 0 {
		return humanStep("H-04", fmt.Sprintf("还有 %d 项格式问题需要修改", run.Blocking))
	}
	if run.Confirmed < run.Total {
		return humanStep("H-04", fmt.Sprintf("还有 %d 项需要逐项确认", run.Total-run.Confirmed))
	}
	if _, err := s.db.Exec(ctx, `UPDATE check_run SET completed_at=now() WHERE id=$1`, run.ID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE work SET status='ready', updated_at=now() WHERE id=$1 AND status IN ('checking','drafting')`, m.ID); err != nil {
		return err
	}
	s.audit(ctx, "check_complete", "work", m.ID.String(), "ok", map[string]any{"items": run.Total})
	return s.writeWork(w, r, m.ID)
}
