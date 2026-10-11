package app

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// humanEditRatio returns 0–1 share of characters that differ from the AI raw draft (FR-M4-07).
func humanEditRatio(sections []Section) *float64 {
	var aiLen, diff int
	for _, sec := range sections {
		if strings.TrimSpace(sec.AIRawMD) == "" {
			continue
		}
		ai := []rune(sec.AIRawMD)
		cur := []rune(sec.ContentMD)
		aiLen += len(ai)
		diff += runeDistance(ai, cur)
	}
	if aiLen == 0 {
		return nil
	}
	r := float64(diff) / float64(aiLen)
	if r > 1 {
		r = 1
	}
	return &r
}

func runeDistance(a, b []rune) int {
	// Bounded Levenshtein on runes (cap length for cost).
	if len(a) > 4000 {
		a = a[:4000]
	}
	if len(b) > 4000 {
		b = b[:4000]
	}
	if len(a) == 0 {
		return len(b)
	}
	if len(b) == 0 {
		return len(a)
	}
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func (s *Server) suggestImages(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if strings.TrimSpace(sec.ContentMD) == "" {
		return validation("请先写好本段正文，再生成配图建议")
	}
	user := fmt.Sprintf(`## 段落
小标题：%s
正文：
%s

## 任务说明
为本段给出 2 到 4 条配图建议，每条含画面描述和中文文生图提示词（供外部工具或公众号官方 AI 配图使用）。

## 输出格式
只输出 JSON：{"suggestions":[{"description":"","prompt":""}]}`, sec.Heading, sec.ContentMD)
	var out struct {
		Suggestions []struct {
			Description string `json:"description"`
			Prompt      string `json:"prompt"`
		} `json:"suggestions"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "image_suggest", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Suggestions) < 1 {
			return fmt.Errorf("没有建议")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"suggestions": out.Suggestions, "refs": res.Refs})
}

func (s *Server) suggestXHSPages(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "xhs" {
		return validation("分页文案建议仅适用于小红书作品")
	}
	ctx := r.Context()
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	var body strings.Builder
	for _, sec := range wk.Sections {
		fmt.Fprintf(&body, "## %s\n%s\n\n", sec.Heading, sec.ContentMD)
	}
	user := fmt.Sprintf(`## 作品
标题：%s
正文：
%s
## 任务说明
把笔记拆成若干图片页文案：第 1 页为封面页（短标题+钩子），其后为要点页。每页正文适合竖图排版，尽量短。

## 输出格式
只输出 JSON：{"pages":[{"title":"","body":""}]}`, wk.Title, body.String())
	var out struct {
		Pages []struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		} `json:"pages"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "image_suggest", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Pages) < 2 {
			return fmt.Errorf("页数太少")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"pages": out.Pages, "refs": res.Refs})
}

func (s *Server) styleSummary(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT title, content_md FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`, a.ID)
	if err != nil {
		return err
	}
	var b strings.Builder
	n := 0
	for rows.Next() {
		var title, content string
		if err := rows.Scan(&title, &content); err != nil {
			rows.Close()
			return err
		}
		n++
		fmt.Fprintf(&b, "《%s》\n%s\n\n", title, truncateRunes(content, 800))
	}
	rows.Close()
	if n == 0 {
		return validation("请先添加风格样本，再生成风格摘要")
	}
	user := fmt.Sprintf(`## 风格样本（%d 篇）
%s
## 任务说明
提炼 300 到 600 字的风格描述：语气、句式、结构、常用表达。只描述风格，不复述样本中的事实。`, n, b.String())
	return s.streamAI(w, r, aiTask{Type: "style_summary", Account: a, User: user, SkipStyle: true, Refs: map[string]any{"style_samples": n}}, nil)
}

func (s *Server) organizeNotes(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Notes string `json:"notes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Notes = strings.TrimSpace(in.Notes)
	if in.Notes == "" {
		return validation("请粘贴要点或口述转写文字")
	}
	user := fmt.Sprintf(`## 作者提供的要点
%s

## 任务说明
只整理和组织作者已提供的内容，写成带小标题的初稿 Markdown。不扩充作者未提供的事实；缺数据处用【待核实：…】。

直接输出 Markdown。`, in.Notes)
	return s.streamAI(w, r, aiTask{Type: "organize_notes", Account: m.Account, WorkID: &m.ID, User: user}, nil)
}

// applyOrganizedNotes turns streamed Markdown (## headings) into confirmed outline + section drafts (FR-M4-08).
func (s *Server) applyOrganizedNotes(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Markdown string `json:"markdown"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	parts := parseMDSections(in.Markdown)
	if len(parts) == 0 {
		return validation("没有识别到带小标题的段落，请检查 Markdown")
	}
	ctx := r.Context()
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM work_section WHERE work_id=$1`, m.ID); err != nil {
			return err
		}
		outline := make([]OutlineItem, 0, len(parts))
		for i, p := range parts {
			var sid uuid.UUID
			if err := tx.QueryRow(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, content_md, ai_raw_md, origin)
				VALUES ($1,$2,$3,$4,$5,$5,'ai') RETURNING id`, m.ID, i, p.Heading, p.Heading, p.Body).Scan(&sid); err != nil {
				return err
			}
			outline = append(outline, OutlineItem{Heading: p.Heading, KeyPoint: p.Heading, MaterialIDs: []string{}, SectionID: sid.String()})
		}
		ob, _ := json.Marshal(outline)
		if _, err := tx.Exec(ctx, `UPDATE work SET outline=$2, outline_confirmed_at=coalesce(outline_confirmed_at, now()), updated_at=now() WHERE id=$1`, m.ID, ob); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "organize_notes_apply", "work", m.ID.String(), "ok", map[string]any{"sections": len(parts)})
	return s.writeWork(w, r, m.ID)
}

type mdPart struct{ Heading, Body string }

func parseMDSections(md string) []mdPart {
	md = strings.TrimSpace(md)
	if md == "" {
		return nil
	}
	lines := strings.Split(md, "\n")
	var out []mdPart
	var cur *mdPart
	flush := func() {
		if cur == nil {
			return
		}
		cur.Body = strings.TrimSpace(cur.Body)
		if cur.Heading != "" || cur.Body != "" {
			if cur.Heading == "" {
				cur.Heading = "正文"
			}
			out = append(out, *cur)
		}
		cur = nil
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			flush()
			cur = &mdPart{Heading: strings.TrimSpace(strings.TrimPrefix(line, "## "))}
			continue
		}
		if cur == nil {
			cur = &mdPart{}
		}
		if cur.Body != "" {
			cur.Body += "\n"
		}
		cur.Body += line
	}
	flush()
	return out
}

func (s *Server) syncDraftStatus(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Platform != "wechat_mp" {
		return validation("只有公众号作品可以同步草稿状态")
	}
	ctx := r.Context()
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	if wk.WechatDraftMediaID == nil || *wk.WechatDraftMediaID == "" {
		return validation("还没有写入过草稿")
	}
	missing, err := s.draftMissing(ctx, m.Account.ID, *wk.WechatDraftMediaID)
	if err != nil {
		return err
	}
	if missing {
		_, _ = s.db.Exec(ctx, `UPDATE work SET draft_maybe_published=true, updated_at=now() WHERE id=$1`, m.ID)
		return ok(w, map[string]any{"maybe_published": true, "message": "草稿已不在草稿箱，可能已经发表或被删除。请确认后回填已发布，系统不会自动改状态。"})
	}
	_, _ = s.db.Exec(ctx, `UPDATE work SET draft_maybe_published=false, updated_at=now() WHERE id=$1`, m.ID)
	return ok(w, map[string]any{"maybe_published": false, "message": "草稿仍在草稿箱中"})
}

func (s *Server) draftMissing(ctx context.Context, accountID uuid.UUID, mediaID string) (bool, error) {
	token, err := s.accessToken(ctx, accountID, false)
	if err != nil {
		return false, err
	}
	ids, total, err := s.wx.DraftBatchGet(ctx, token, 0, 20)
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		if id == mediaID {
			return false, nil
		}
	}
	// Scan further pages if needed (cap 100).
	for offset := 20; offset < total && offset < 100; offset += 20 {
		more, _, err := s.wx.DraftBatchGet(ctx, token, offset, 20)
		if err != nil {
			return false, err
		}
		for _, id := range more {
			if id == mediaID {
				return false, nil
			}
		}
	}
	return true, nil
}

func (s *Server) syncDraftsJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT w.id, w.account_id, w.wechat_draft_media_id FROM work w
		JOIN platform_account a ON a.id=w.account_id
		WHERE w.status='pushed' AND w.wechat_draft_media_id IS NOT NULL AND w.deleted_at IS NULL AND a.platform='wechat_mp'`)
	if err != nil {
		return
	}
	type row struct {
		id, account uuid.UUID
		media       string
	}
	var list []row
	for rows.Next() {
		var r row
		var media *string
		if err := rows.Scan(&r.id, &r.account, &media); err == nil && media != nil {
			r.media = *media
			list = append(list, r)
		}
	}
	rows.Close()
	for _, r := range list {
		missing, err := s.draftMissing(ctx, r.account, r.media)
		if err != nil {
			continue
		}
		if missing {
			_, _ = s.db.Exec(ctx, `UPDATE work SET draft_maybe_published=true WHERE id=$1`, r.id)
		}
	}
}

type PromptTemplate struct {
	TaskType string    `json:"task_type"`
	Label    string    `json:"label"`
	Version  int       `json:"version"`
	Content  string    `json:"content"`
	Active   bool      `json:"active"`
	UpdatedAt time.Time `json:"updated_at"`
}

var editablePromptTasks = []struct{ Type, Label, Default string }{
	{"topic_suggest", "选题建议", "围绕账号定位给出选题建议。"},
	{"outline", "大纲生成", "围绕核心观点生成大纲。"},
	{"section_draft", "分段起稿", "按大纲起草本段，不编造事实。"},
	{"section_edit", "改写扩写缩写", "按模式改写选中内容。"},
	{"comic_storyboard", "漫画分镜", "生成分镜脚本。"},
	{"image_suggest", "配图建议", "给出配图描述与中文提示词。"},
	{"organize_notes", "要点整理", "只整理作者提供的要点。"},
	{"style_summary", "风格摘要", "提炼风格描述。"},
	{"review_analysis", "AI 复盘", "总结规律并建议选题。"},
	{"account_positioning", "账号运营方案", "根据真实经历提出可执行的定位方案，不虚构资源或承诺增长。"},
	{"strategy_revise", "运营方案调整", "结合运营反馈逐条提出调整理由，由作者决定是否接受。"},
	{"strategy_outline", "内容大纲建议", "按内容支柱与节奏建议选题，只引用提供的事实和经历。"},
	{"hot_relevance", "热点相关度", "只评估输入热点，标注风险，不编造事件细节。"},
	{"daily_recommend", "每日推荐", "按规则候选优先级推荐，每条给出真实依据，不重复近期选题。"},
	{"reference_analyze", "参考方法提炼", "只总结标题、结构、角度等方法，不复述原文句子。"},
}

func (s *Server) listPromptTemplates(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `SELECT DISTINCT ON (task_type) task_type, coalesce(label,''), version, content, active, coalesce(updated_at, created_at)
		FROM prompt_template WHERE workspace_id=$1 OR workspace_id IS NULL
		ORDER BY task_type, (workspace_id=$1) DESC, version DESC`, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	byType := map[string]PromptTemplate{}
	for rows.Next() {
		var t PromptTemplate
		if err := rows.Scan(&t.TaskType, &t.Label, &t.Version, &t.Content, &t.Active, &t.UpdatedAt); err != nil {
			return err
		}
		byType[t.TaskType] = t
	}
	list := []PromptTemplate{}
	for _, def := range editablePromptTasks {
		if t, ok := byType[def.Type]; ok {
			if t.Label == "" {
				t.Label = def.Label
			}
			list = append(list, t)
			continue
		}
		list = append(list, PromptTemplate{TaskType: def.Type, Label: def.Label, Version: 1, Content: def.Default, Active: true, UpdatedAt: time.Now()})
	}
	return ok(w, list)
}

func (s *Server) putPromptTemplate(w http.ResponseWriter, r *http.Request) error {
	task := chiParam(r, "taskType")
	var def *struct{ Type, Label, Default string }
	for i := range editablePromptTasks {
		if editablePromptTasks[i].Type == task {
			def = &editablePromptTasks[i]
			break
		}
	}
	if def == nil {
		return validation("未知的任务类型")
	}
	var in struct {
		Content string `json:"content"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		return validation("请填写任务指令")
	}
	if strings.Contains(in.Content, "系统规则") || utf8.RuneCountInString(in.Content) > 8000 {
		return validation("只能编辑任务指令部分，且不超过 8000 字")
	}
	ws := ident(r.Context()).WorkspaceID
	var ver int
	_ = s.db.QueryRow(r.Context(), `SELECT coalesce(max(version),0)+1 FROM prompt_template WHERE workspace_id=$1 AND task_type=$2`, ws, task).Scan(&ver)
	if ver < 1 {
		ver = 1
	}
	_, err := s.db.Exec(r.Context(), `INSERT INTO prompt_template (workspace_id, task_type, version, content, active, label, updated_at)
		VALUES ($1,$2,$3,$4,true,$5,now())`, ws, task, ver, in.Content, def.Label)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "prompt_template_update", "prompt_template", task, "ok", map[string]any{"version": ver})
	return ok(w, PromptTemplate{TaskType: task, Label: def.Label, Version: ver, Content: in.Content, Active: true, UpdatedAt: time.Now()})
}

func (s *Server) exportData(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireReauth(r.Context()); err != nil {
		return err
	}
	var in struct {
		Kind      string `json:"kind"` // works | materials | reviews
		AccountID string `json:"account_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	ctx := r.Context()
	switch in.Kind {
	case "materials":
		rows, err := s.db.Query(ctx, `SELECT coalesce(a.name,'共享'), m.kind, m.content, m.source, m.created_at FROM material m
			LEFT JOIN platform_account a ON a.id=m.account_id WHERE m.workspace_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at`, ws)
		if err != nil {
			return err
		}
		defer rows.Close()
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="materials.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"账号", "类型", "内容", "来源", "创建时间"})
		for rows.Next() {
			var acc, kind, content, source string
			var at time.Time
			if err := rows.Scan(&acc, &kind, &content, &source, &at); err == nil {
				_ = cw.Write([]string{acc, kind, content, source, at.Format(time.RFC3339)})
			}
		}
		cw.Flush()
		return nil
	case "reviews":
		rows, err := s.db.Query(ctx, `SELECT a.name, r.content, r.created_at FROM review_report r JOIN platform_account a ON a.id=r.account_id
			WHERE a.workspace_id=$1 ORDER BY r.created_at DESC`, ws)
		if err != nil {
			return err
		}
		defer rows.Close()
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="reviews.md"`)
		for rows.Next() {
			var name, content string
			var at time.Time
			if err := rows.Scan(&name, &content, &at); err == nil {
				fmt.Fprintf(w, "# %s · %s\n\n%s\n\n---\n\n", name, at.Format("2006-01-02"), content)
			}
		}
		return nil
	default: // works
		q := `SELECT a.name, w.title, w.status, w.content_format, w.viewpoint, w.published_url, w.updated_at FROM work w
			JOIN platform_account a ON a.id=w.account_id WHERE a.workspace_id=$1 AND w.deleted_at IS NULL`
		args := []any{ws}
		if in.AccountID != "" {
			id, err := uuid.Parse(in.AccountID)
			if err != nil {
				return validation("账号 ID 无效")
			}
			q += ` AND w.account_id=$2`
			args = append(args, id)
		}
		q += ` ORDER BY w.updated_at DESC`
		rows, err := s.db.Query(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="works.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"账号", "标题", "状态", "形态", "观点", "发布链接", "更新时间"})
		for rows.Next() {
			var name, title, status, format, viewpoint string
			var url *string
			var at time.Time
			if err := rows.Scan(&name, &title, &status, &format, &viewpoint, &url, &at); err == nil {
				u := ""
				if url != nil {
					u = *url
				}
				_ = cw.Write([]string{name, title, status, format, viewpoint, u, at.Format(time.RFC3339)})
			}
		}
		cw.Flush()
		return nil
	}
}
