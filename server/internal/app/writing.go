package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

func (s *Server) sectionMeta(ctx context.Context, id uuid.UUID) (*Section, *workMeta, error) {
	var workID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT work_id FROM work_section WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&workID); err != nil {
		return nil, nil, err
	}
	sec, err := scanSection(s.db.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1`, id))
	if err != nil {
		return nil, nil, err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return nil, nil, err
	}
	return &sec, m, nil
}

func (s *Server) sectionFromPath(r *http.Request) (*Section, *workMeta, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, nil, err
	}
	return s.sectionMeta(r.Context(), id)
}

func (s *Server) workMaterialIDs(ctx context.Context, workID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx, `SELECT material_id FROM work_material WHERE work_id=$1`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (s *Server) workOutline(ctx context.Context, workID uuid.UUID) ([]OutlineItem, error) {
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT outline FROM work WHERE id=$1`, workID).Scan(&raw); err != nil {
		return nil, err
	}
	var items []OutlineItem
	_ = json.Unmarshal(raw, &items)
	return items, nil
}

func outlineText(items []OutlineItem) string {
	var b strings.Builder
	for i, it := range items {
		fmt.Fprintf(&b, "%d. %s —— %s\n", i+1, it.Heading, it.KeyPoint)
	}
	return b.String()
}

// generateOutline requires the author's viewpoint first (H-02, HC-02). It returns items without saving.
func (s *Server) generateOutline(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if strings.TrimSpace(m.Viewpoint) == "" {
		return humanStep("H-02", "请先写下你自己的核心观点，再生成大纲")
	}
	var in struct {
		Template string `json:"template"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	mids, err := s.workMaterialIDs(ctx, m.ID)
	if err != nil {
		return err
	}
	mids = s.rankMaterials(ctx, mids, m.Viewpoint)
	work, err := s.workBrief(ctx, m)
	if err != nil {
		return err
	}
	structure := ""
	refs := map[string]any{}
	if in.Template != "" {
		tpl, err := s.findOutlineTemplate(ctx, in.Template)
		if err != nil {
			return err
		}
		structure = fmt.Sprintf("\n结构模板「%s」：%s。大纲必须按这个结构展开。", tpl.Name, tpl.Structure)
		refs["outline_template"] = tpl.Name
	} else if fb := formatBrief(m.ContentFormat); fb != "" {
		// D-048：新文字类型按作品自身的类型注入结构约定；用户选择了模板时以模板为准。
		structure = "\n结构要求：" + fb
		refs["format_brief"] = m.ContentFormat
	}
	user := fmt.Sprintf(`## 任务说明
围绕作者的核心观点，列出 4 到 8 个段落的大纲。每项给出小标题和本段要点；如果某段适合使用某条素材，在 material_ids 中填写该素材的 id（只能使用上面列出的素材 id）。%s

## 输出格式
只输出 JSON：{"items":[{"heading":"小标题","key_point":"本段要点","material_ids":[]}]}`, structure)
	var out struct {
		Items []OutlineItem `json:"items"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "outline", Account: m.Account, WorkID: &m.ID, User: user, Materials: mids, Work: work, Refs: refs}, &out, func() error {
		if len(out.Items) < 2 {
			return fmt.Errorf("大纲项太少")
		}
		return nil
	})
	if err != nil {
		return err
	}
	allowed := map[string]bool{}
	for _, id := range mids {
		allowed[id.String()] = true
	}
	for i := range out.Items {
		var keep []string
		for _, id := range out.Items[i].MaterialIDs {
			if allowed[id] {
				keep = append(keep, id)
			}
		}
		out.Items[i].MaterialIDs = keep
		if out.Items[i].MaterialIDs == nil {
			out.Items[i].MaterialIDs = []string{}
		}
	}
	if len(out.Items) > 8 {
		out.Items = out.Items[:8]
	}
	return ok(w, map[string]any{"items": out.Items, "refs": res.Refs, "ai_call_id": res.CallID})
}

// workBrief is the work slot: title, topic fields, viewpoint, confirmed outline and series neighbours.
func (s *Server) workBrief(ctx context.Context, m *workMeta) (string, error) {
	return s.workBriefForSection(ctx, m, nil)
}

func (s *Server) workBriefForSection(ctx context.Context, m *workMeta, sectionID *uuid.UUID) (string, error) {
	var angle, audience, hook string
	var seriesID, topicID *uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT coalesce(t.angle,''), coalesce(t.audience,''), coalesce(t.hook,''), t.series_id, t.id
		FROM work w LEFT JOIN topic t ON t.id=w.topic_id WHERE w.id=$1`, m.ID).Scan(&angle, &audience, &hook, &seriesID, &topicID)
	outline, err := s.workOutline(ctx, m.ID)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("## 作品\n")
	fmt.Fprintf(&b, "标题：%s\n", nz(m.Title, "（未定）"))
	if angle != "" {
		fmt.Fprintf(&b, "切入角度：%s\n", angle)
	}
	if audience != "" {
		fmt.Fprintf(&b, "目标读者：%s\n", audience)
	}
	if hook != "" {
		fmt.Fprintf(&b, "钩子：%s\n", hook)
	}
	fmt.Fprintf(&b, "核心观点：%s\n", m.Viewpoint)
	prefix := b.String()
	if m.OutlineConfirmedAt != nil && len(outline) > 0 {
		b.WriteString("\n## 已确认的大纲\n" + outlineText(outline))
	}
	main, series := b.String(), ""
	if seriesID != nil {
		series = s.seriesNeighbours(ctx, *seriesID, topicID)
	}
	if runeLen(main)+runeLen(series) > slotBudgets["work"] {
		series = ""
	}
	if runeLen(main) > slotBudgets["work"] && sectionID != nil && m.OutlineConfirmedAt != nil {
		b.Reset()
		b.WriteString(prefix + "\n## 已确认的大纲（其他段仅保留小标题）\n")
		for i, item := range outline {
			if item.SectionID == sectionID.String() {
				fmt.Fprintf(&b, "%d. %s —— %s\n", i+1, item.Heading, item.KeyPoint)
			} else {
				fmt.Fprintf(&b, "%d. %s\n", i+1, item.Heading)
			}
		}
		main = b.String()
	}
	return main + series, nil
}

// sectionContext returns the work slot and the neighbour paragraphs (trimmed first when over budget).
func (s *Server) sectionContext(ctx context.Context, m *workMeta, sec *Section) (string, string, error) {
	work, err := s.workBriefForSection(ctx, m, &sec.ID)
	if err != nil {
		return "", "", err
	}
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return "", "", err
	}
	var prev, next string
	for i, x := range secs {
		if x.ID == sec.ID {
			if i > 0 {
				prev = truncate(secs[i-1].ContentMD, 600)
			}
			if i+1 < len(secs) {
				next = truncate(secs[i+1].ContentMD, 600)
			}
		}
	}
	return work, fmt.Sprintf("## 相邻段落\n上一段：%s\n下一段：%s\n", nz(prev, "（无）"), nz(next, "（无）")), nil
}

// sectionMaterialIDs uses the section's bound materials, falling back to the work's (EX-E-05),
// most relevant to this section first.
func (s *Server) sectionMaterialIDs(ctx context.Context, m *workMeta, sec *Section) ([]uuid.UUID, error) {
	ids := sec.MaterialIDs
	if len(ids) == 0 {
		var err error
		if ids, err = s.workMaterialIDs(ctx, m.ID); err != nil {
			return nil, err
		}
	}
	return s.rankMaterials(ctx, ids, sec.Heading+" "+sec.KeyPoint+" "+truncate(sec.ContentMD, 300)), nil
}

func (s *Server) pickTier(ctx context.Context, requested string) string {
	if costTiers[requested] || requested == "standard" {
		return requested
	}
	return s.userPrefs(ctx).CostTier
}

// setSectionMaterials binds materials to one section ("用于本段", EX-D-03 / EX-E-05).
func (s *Server) setSectionMaterials(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		MaterialIDs []uuid.UUID `json:"material_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	ids := []uuid.UUID{}
	rows, err := s.db.Query(ctx, `SELECT id FROM material WHERE id = ANY($1) AND workspace_id=$2 AND deleted_at IS NULL AND (account_id IS NULL OR account_id=$3)`,
		in.MaterialIDs, ident(ctx).WorkspaceID, m.Account.ID)
	if err != nil {
		return err
	}
	okIDs := map[uuid.UUID]bool{}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			okIDs[id] = true
		}
	}
	rows.Close()
	for _, id := range in.MaterialIDs {
		if okIDs[id] {
			ids = append(ids, id)
			okIDs[id] = false
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE work_section SET material_ids=$2, updated_at=now() WHERE id=$1`, sec.ID, ids); err != nil {
		return err
	}
	for _, id := range ids {
		_, _ = s.db.Exec(ctx, `INSERT INTO work_material (work_id, material_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, m.ID, id)
	}
	return s.writeWork(w, r, m.ID)
}

// editSection returns replacement text for the selection; the client applies and saves it.
func (s *Server) editSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Mode        string `json:"mode"`
		Selection   string `json:"selection"`
		Instruction string `json:"instruction"`
		Variants    int    `json:"variants"`
		Tier        string `json:"tier"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	modes := map[string]string{"rewrite": "换一种说法改写，意思不变", "expand": "只用素材中的事实展开，补充解释和过渡；没有素材依据的具体事实写成【待核实：需要的内容】", "shorten": "缩写到原来的一半左右，保留关键信息"}
	desc, okMode := modes[in.Mode]
	if !okMode {
		return validation("模式只能是改写、扩写或缩写")
	}
	if in.Variants != 0 && in.Variants != 1 && in.Variants != 3 {
		return validation("候选数量只能是 1 或 3")
	}
	if strings.TrimSpace(in.Selection) == "" {
		in.Selection = sec.ContentMD
	}
	if strings.TrimSpace(in.Selection) == "" {
		return validation("这一段还没有内容")
	}
	ctx := r.Context()
	mids, err := s.sectionMaterialIDs(ctx, m, sec)
	if err != nil {
		return err
	}
	outline, err := s.workOutline(ctx, m.ID)
	if err != nil {
		return err
	}
	var work strings.Builder
	fmt.Fprintf(&work, "## 作品脉络\n核心观点：%s\n各段小标题：\n", m.Viewpoint)
	for i, item := range outline {
		fmt.Fprintf(&work, "%d. %s\n", i+1, item.Heading)
	}
	base := fmt.Sprintf(`## 上下文
本段小标题：%s
本段全文：
%s

## 任务说明
模式：%s
要求：%s
选中内容：%s
`, sec.Heading, truncate(sec.ContentMD, 1500), in.Mode, desc, in.Selection)
	t := aiTask{Type: "section_edit", Account: m.Account, WorkID: &m.ID, Instruction: in.Instruction, History: sec.Heading + " " + truncate(in.Selection, 200),
		Materials: mids, Work: work.String(), Tier: s.pickTier(ctx, in.Tier), Refs: map[string]any{"section_id": sec.ID}}
	if in.Variants == 3 {
		t.Refs["variants"] = 3
		t.User = base + `
给出 3 个风格明显不同的候选（例如更口语、更精炼、换个角度），每个都只替换选中内容。
候选数：3

## 输出格式
只输出 JSON：{"variants":[{"label":"风格","text":"替换后的文字"}]}`
		var out struct {
			Variants []variant `json:"variants"`
		}
		res, err := s.runAIJSON(ctx, t, &out, func() error { return validateVariants(out.Variants, 3) })
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"variants": out.Variants, "ai_call_id": res.CallID, "refs": res.Refs, "fallback_used": res.FallbackUsed})
	}
	t.User = base + `
## 输出格式
只输出替换后的文字，不改动未选中的部分，不加任何说明。`
	return s.streamAI(w, r, t, nil)
}

type variant struct {
	Label string `json:"label"`
	Text  string `json:"text"`
	Note  string `json:"note,omitempty"`
}

// validateVariants requires n non-empty candidates that differ from each other (similarity < 0.8).
func validateVariants(vs []variant, n int) error {
	if len(vs) < n {
		return fmt.Errorf("候选少于 %d 个", n)
	}
	for i := range vs {
		if strings.TrimSpace(vs[i].Text) == "" {
			return fmt.Errorf("候选为空")
		}
		for j := 0; j < i; j++ {
			if textSimilarity(vs[i].Text, vs[j].Text) >= 0.8 {
				return fmt.Errorf("候选过于相似")
			}
		}
	}
	return nil
}

// textSimilarity is 1 - normalised edit distance.
func textSimilarity(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	n := max(len(ra), len(rb))
	if n == 0 {
		return 1
	}
	return 1 - float64(runeDistance(ra, rb))/float64(n)
}

func (s *Server) generateTitles(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Base string `json:"base"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	maxLen := 32
	limit := "不超过 32 字"
	if m.Account.Platform == "xhs" {
		maxLen = 20
		limit = "不超过 20 字，口语化，可以带一个表情符号"
	}
	want := 5
	task := fmt.Sprintf("平台：%s。给出不少于 5 个标题候选，每个%s，风格各不相同；不使用标题党和夸大表达。", platformNames[m.Account.Platform], limit)
	if base := strings.TrimSpace(in.Base); base != "" {
		want = 3
		task = fmt.Sprintf("平台：%s。在保留原意的前提下，把这个标题再改写出 3 个不同写法，每个%s：%s", platformNames[m.Account.Platform], limit, truncate(base, 64))
	}
	user := fmt.Sprintf(`## 作品
核心观点：%s
正文摘要：
%s

## 任务说明
%s

## 输出格式
只输出 JSON：{"titles":[{"text":"标题","style":"风格说明"}]}`, m.Viewpoint, bodyDigest(secs, 1500), task)
	var out struct {
		Titles []struct {
			Text  string `json:"text"`
			Style string `json:"style"`
		} `json:"titles"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "title", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Titles) < want {
			return fmt.Errorf("标题少于 %d 个", want)
		}
		return nil
	})
	if err != nil {
		return err
	}
	strong := s.highPerformingTitleFeatures(ctx, m.Account.ID)
	type cand struct {
		Text       string   `json:"text"`
		Style      string   `json:"style"`
		Chars      int      `json:"chars"`
		OverLimit  bool     `json:"over_limit"`
		Features   []string `json:"features"`
		StrongHits []string `json:"strong_hits"`
	}
	list := []cand{}
	for _, t := range out.Titles {
		c := cand{Text: strings.TrimSpace(t.Text), Style: nz(strings.TrimSpace(t.Style), "其他"), Chars: runeLen(strings.TrimSpace(t.Text))}
		c.OverLimit = c.Chars > maxLen
		c.Features = titleFeatures(c.Text)
		c.StrongHits = []string{}
		for _, f := range c.Features {
			if strong[f] {
				c.StrongHits = append(c.StrongHits, f)
			}
		}
		list = append(list, c)
	}
	strongList := []string{}
	for f := range strong {
		strongList = append(strongList, f)
	}
	return ok(w, map[string]any{"titles": list, "refs": res.Refs, "ai_call_id": res.CallID, "max_chars": maxLen, "strong_features": strongList})
}

// titleFeatures are explainable traits only — never a predicted popularity number (EX-E-14).
func titleFeatures(t string) []string {
	f := []string{}
	if strings.ContainsAny(t, "0123456789一二三四五六七八九十百千万") {
		f = append(f, "含数字")
	}
	if strings.ContainsAny(t, "？?") || strings.Contains(t, "吗") || strings.Contains(t, "为什么") || strings.Contains(t, "怎么") {
		f = append(f, "提问式")
	}
	if strings.ContainsAny(t, "：:｜|") {
		f = append(f, "分隔结构")
	}
	if strings.Contains(t, "我") {
		f = append(f, "第一人称")
	}
	n := runeLen(t)
	switch {
	case n <= 14:
		f = append(f, "短标题")
	case n >= 24:
		f = append(f, "长标题")
	}
	return f
}

// highPerformingTitleFeatures returns traits shared by the account's top-read titles (needs ≥ 5 works with data).
func (s *Server) highPerformingTitleFeatures(ctx context.Context, accountID uuid.UUID) map[string]bool {
	rows, err := s.db.Query(ctx, `SELECT w.title, d.reads FROM work w JOIN work_metric_d7 d ON d.work_id=w.id
		WHERE w.account_id=$1 AND w.deleted_at IS NULL ORDER BY d.reads DESC NULLS LAST LIMIT 200`, accountID)
	out := map[string]bool{}
	if err != nil {
		return out
	}
	defer rows.Close()
	var titles []string
	for rows.Next() {
		var t string
		var reads *int
		if rows.Scan(&t, &reads) == nil {
			titles = append(titles, t)
		}
	}
	if len(titles) < 5 {
		return out
	}
	top := titles[:max(1, len(titles)*3/10)]
	count := func(list []string) map[string]float64 {
		c := map[string]float64{}
		for _, t := range list {
			for _, f := range titleFeatures(t) {
				c[f]++
			}
		}
		for k := range c {
			c[k] /= float64(len(list))
		}
		return c
	}
	topC, allC := count(top), count(titles)
	for f, share := range topC {
		if share >= 0.5 && share > allC[f]+0.1 {
			out[f] = true
		}
	}
	return out
}

func (s *Server) generateSummary(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	secs, err := s.loadSections(r.Context(), nil, m.ID)
	if err != nil {
		return err
	}
	user := fmt.Sprintf(`## 作品
标题：%s
正文：
%s

## 任务说明
写一段摘要，不超过 120 字，概括文章要点，吸引读者点开。

## 输出格式
只输出 JSON：{"summary":"摘要"}`, m.Title, bodyDigest(secs, 3000))
	var out struct {
		Summary string `json:"summary"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "summary", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if strings.TrimSpace(out.Summary) == "" {
			return fmt.Errorf("摘要为空")
		}
		return nil
	})
	if err != nil {
		return err
	}
	truncated := runeLen(out.Summary) > 120
	if truncated {
		out.Summary = truncateRunes(out.Summary, 120)
	}
	return ok(w, map[string]any{"summary": out.Summary, "truncated": truncated, "refs": res.Refs})
}

func bodyDigest(secs []Section, limit int) string {
	var b strings.Builder
	for _, x := range secs {
		if x.Heading != "" {
			b.WriteString("## " + x.Heading + "\n")
		}
		b.WriteString(x.ContentMD + "\n\n")
	}
	return truncate(b.String(), limit)
}

// ---------- 派生改写（FR-M5，06 文档第 5.8 节两步法） ----------
