package app

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
)

// 实时轻量检查（EX-E-09）与表达体检（EX-E-10）。都不阻止输入、不自动替换。

type LintHit struct {
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Word       string `json:"word"`
	Category   string `json:"category"`
	Reason     string `json:"reason"`
	Suggestion string `json:"suggestion"`
}

var quotedTerm = regexp.MustCompile(`[「“"‘']([^」”"’']{1,12})[」”"’']`)

// memoryAvoidWords extracts quoted words from active "avoid" / "wording" memories, e.g. 不要用「赋能」.
func (s *Server) memoryAvoidWords(ctx context.Context, accountID uuid.UUID) []string {
	rows, err := s.db.Query(ctx, `SELECT text FROM account_memory WHERE account_id=$1 AND status='active' AND kind IN ('avoid','wording')`, accountID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) != nil {
			continue
		}
		if !strings.ContainsAny(t, "不别避") {
			continue
		}
		for _, m := range quotedTerm.FindAllStringSubmatch(t, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

// lintText finds word hits with rune offsets; the same lists as buildRuleItems so results agree.
func lintText(text string, words []checkWord, avoid []string) []LintHit {
	hits := []LintHit{}
	byteToRune := func(b int) int { return runeLen(text[:b]) }
	find := func(word, category, reason, suggestion string) {
		if word == "" {
			return
		}
		off := 0
		for len(hits) < 200 {
			i := strings.Index(text[off:], word)
			if i < 0 {
				return
			}
			i += off
			hits = append(hits, LintHit{Start: byteToRune(i), End: byteToRune(i + len(word)), Word: word, Category: category, Reason: reason, Suggestion: suggestion})
			off = i + len(word)
		}
	}
	for _, w := range words {
		find(w.w, "sensitive", "命中"+sourceLabel[w.source], "删除或换一种说法")
	}
	for _, w := range adWords {
		find(w, "ad_law", "广告法极限词", "改为可核实的表述，或删去绝对化用词")
	}
	for _, w := range avoid {
		find(w, "memory", sourceLabel["memory"], "按你确认过的偏好换一种说法")
	}
	for _, mm := range pendingMarker.FindAllStringIndex(text, -1) {
		hits = append(hits, LintHit{Start: byteToRune(mm[0]), End: byteToRune(mm[1]), Word: text[mm[0]:mm[1]], Category: "pending",
			Reason: "待核实占位", Suggestion: "补充真实信息、用素材替换或删掉这句"})
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Start < hits[j].Start })
	return hits
}

func (s *Server) lintWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Text  string   `json:"text"`
		Texts []string `json:"texts"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	words, err := s.checkWords(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	avoid := s.memoryAvoidWords(ctx, m.Account.ID)
	if in.Texts != nil {
		out := make([][]LintHit, len(in.Texts))
		for i, t := range in.Texts {
			out[i] = lintText(truncate(t, 20000), words, avoid)
		}
		return ok(w, map[string]any{"results": out})
	}
	return ok(w, map[string]any{"hits": lintText(truncate(in.Text, 20000), words, avoid)})
}

type PolishIssue struct {
	SectionID string `json:"section_id"`
	Rule      string `json:"rule"`
	Message   string `json:"message"`
	Excerpt   string `json:"excerpt"`
	Source    string `json:"source"` // rule | ai
}

func splitSentences(text string) []string {
	var out []string
	var cur []rune
	for _, r := range text {
		cur = append(cur, r)
		if strings.ContainsRune("。！？!?；;\n", r) {
			if s := strings.TrimSpace(string(cur)); s != "" {
				out = append(out, s)
			}
			cur = cur[:0]
		}
	}
	if s := strings.TrimSpace(string(cur)); s != "" {
		out = append(out, s)
	}
	return out
}

func splitParagraphs(text string) []string {
	var out []string
	for _, p := range strings.Split(text, "\n") {
		if strings.TrimSpace(p) != "" {
			out = append(out, strings.TrimSpace(p))
		}
	}
	return out
}

func hanOnly(s string) []rune {
	var out []rune
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			out = append(out, r)
		}
	}
	return out
}

// polishRules is the deterministic part of 表达体检: readability only, never "AI 检测" (NFR-10).
func polishRules(sectionID, text string, catchphrases []string) []PolishIssue {
	issues := []PolishIssue{}
	add := func(rule, msg, excerpt string) {
		issues = append(issues, PolishIssue{SectionID: sectionID, Rule: rule, Message: msg, Excerpt: truncate(excerpt, 80), Source: "rule"})
	}
	sentences := splitSentences(text)
	for _, s := range sentences {
		if n := runeLen(strings.TrimRight(s, "。！？!?；;\n")); n > 50 {
			add("long_sentence", fmt.Sprintf("这句有 %d 字，读起来有点长，可以拆成两句", n), s)
		}
	}
	for _, p := range splitParagraphs(text) {
		if n := runeLen(p); n > 300 {
			add("long_paragraph", fmt.Sprintf("这个自然段有 %d 字，手机上阅读压力较大，可以分段", n), p)
		}
		if c := strings.Count(p, "被"); c >= 3 {
			add("passive", fmt.Sprintf("这一段用了 %d 次「被」，被动句偏多，可以改成主动表达", c), p)
		}
	}
	han := hanOnly(text)
	reported := map[string]bool{}
	for start := 0; start < len(han); start += 100 {
		end := min(len(han), start+300)
		counts := map[string]int{}
		for i := start; i+1 < end; i++ {
			counts[string(han[i:i+2])]++
		}
		var words []string
		for w, c := range counts {
			if c >= 4 && !stopTerms[w] && !reported[w] {
				words = append(words, w)
			}
		}
		sort.Strings(words)
		for _, w := range words {
			reported[w] = true
			add("repeat", fmt.Sprintf("「%s」在 300 字内出现了 %d 次，可以换个说法", w, counts[w]), w)
		}
		if end == len(han) {
			break
		}
	}
	run := 1
	for i := 1; i < len(sentences); i++ {
		a, b := []rune(sentences[i-1]), []rune(sentences[i])
		if len(a) >= 2 && len(b) >= 2 && string(a[:2]) == string(b[:2]) {
			run++
			if run == 3 {
				add("same_opening", fmt.Sprintf("连续 3 句都以「%s」开头，句式有点单调", string(b[:2])), sentences[i])
			}
		} else {
			run = 1
		}
	}
	for _, c := range catchphrases {
		if n := strings.Count(text, c); n >= 2 {
			add("catchphrase", fmt.Sprintf("口头禅「%s」出现了 %d 次", c, n), c)
		}
	}
	return issues
}

func (s *Server) polishCheck(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		SectionID *uuid.UUID `json:"section_id"`
		AI        bool       `json:"ai"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	if in.SectionID != nil {
		var picked []Section
		for _, x := range secs {
			if x.ID == *in.SectionID {
				picked = append(picked, x)
			}
		}
		if len(picked) == 0 {
			return validation("段落不属于这篇作品")
		}
		secs = picked
	}
	catch := s.memoryAvoidWords(ctx, m.Account.ID)
	var ignored []string
	_ = s.db.QueryRow(ctx, `SELECT polish_ignored FROM work WHERE id=$1`, m.ID).Scan(&ignored)
	skip := map[string]bool{}
	for _, k := range ignored {
		skip[k] = true
	}
	keep := func(list []PolishIssue) []PolishIssue {
		out := []PolishIssue{}
		for _, i := range list {
			if !skip[i.key()] {
				out = append(out, i)
			}
		}
		return out
	}
	issues := []PolishIssue{}
	for _, x := range secs {
		issues = append(issues, polishRules(x.ID.String(), x.ContentMD, catch)...)
	}
	issues = keep(issues)
	if !in.AI {
		return ok(w, map[string]any{"issues": issues, "ignored": len(ignored)})
	}
	run := func(jctx context.Context) (map[string]any, error) {
		var b strings.Builder
		valid := map[string]bool{}
		for _, x := range secs {
			if strings.TrimSpace(x.ContentMD) == "" {
				continue
			}
			fmt.Fprintf(&b, "【段落 id=%s】%s\n%s\n\n", x.ID, x.Heading, truncate(x.ContentMD, 2000))
			valid[x.ID.String()] = true
		}
		if b.Len() == 0 {
			return map[string]any{"issues": issues}, nil
		}
		user := `## 待体检的内容
` + truncate(b.String(), 6000) + `
## 任务说明
只从读者的角度指出可读性与逻辑问题：逻辑跳跃、论据不足、读者可能看不懂的术语。每条引用原文中的一句（逐字摘录），给出建议。不要评价文风是否像某种写作者，不涉及任何"检测"。

## 输出格式
只输出 JSON：{"issues":[{"section_id":"段落 id","quote":"原文句子","problem":"问题","suggestion":"建议"}]}`
		var out struct {
			Issues []struct {
				SectionID  string `json:"section_id"`
				Quote      string `json:"quote"`
				Problem    string `json:"problem"`
				Suggestion string `json:"suggestion"`
			} `json:"issues"`
		}
		res, err := s.runAIJSON(jctx, aiTask{Type: "polish_check", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, nil)
		if err != nil {
			return nil, err
		}
		all := append([]PolishIssue{}, issues...)
		for _, it := range out.Issues {
			if !valid[it.SectionID] {
				continue
			}
			all = append(all, PolishIssue{SectionID: it.SectionID, Rule: "ai", Message: it.Problem + "：" + it.Suggestion, Excerpt: truncate(it.Quote, 80), Source: "ai"})
		}
		return map[string]any{"issues": keep(all), "ai_call_id": res.CallID}, nil
	}
	if in.SectionID != nil {
		res, err := run(ctx)
		if err != nil {
			return err
		}
		return ok(w, res)
	}
	jobID, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "polish_check", Label: "整篇表达体检" + titleOr(m.Title), Link: "/works/" + m.ID.String(),
		AccountID: &m.Account.ID, WorkID: &m.ID}, func(jctx context.Context) (any, error) { return run(jctx) })
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"issues": issues, "job_id": jobID, "ignored": len(ignored)})
}

// key identifies one issue across re-runs so an ignore sticks until the sentence changes.
func (i PolishIssue) key() string { return i.SectionID + "|" + i.Rule + "|" + i.Excerpt }

// ignorePolish remembers (or with clear=true forgets all) ignored 表达体检 issues for the work.
func (s *Server) ignorePolish(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Key   string `json:"key"`
		Clear bool   `json:"clear"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if in.Clear {
		_, err := s.db.Exec(ctx, `UPDATE work SET polish_ignored='{}' WHERE id=$1`, m.ID)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"ignored": 0})
	}
	if strings.TrimSpace(in.Key) == "" || runeLen(in.Key) > 200 {
		return validation("缺少要忽略的问题")
	}
	var n int
	if err := s.db.QueryRow(ctx, `UPDATE work SET polish_ignored=(
		SELECT coalesce(array_agg(k ORDER BY ord), '{}') FROM (
			SELECT k, ord FROM unnest(array_remove(polish_ignored, $2) || $2::text) WITH ORDINALITY AS t(k, ord)
			ORDER BY ord DESC LIMIT 300) last)
		WHERE id=$1 RETURNING cardinality(polish_ignored)`, m.ID, in.Key).Scan(&n); err != nil {
		return err
	}
	return ok(w, map[string]any{"ignored": n})
}
