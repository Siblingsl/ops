package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) sectionMeta(ctx context.Context, id uuid.UUID) (*Section, *workMeta, error) {
	var workID uuid.UUID
	var sec Section
	err := s.db.QueryRow(ctx, `SELECT work_id, id, position, heading, key_point, content_md, ai_raw_md, origin, source_section_ids, material_ids, revision, updated_at
		FROM work_section WHERE id=$1`, id).Scan(&workID, &sec.ID, &sec.Position, &sec.Heading, &sec.KeyPoint, &sec.ContentMD, &sec.AIRawMD, &sec.Origin,
		&sec.SourceSectionIDs, &sec.MaterialIDs, &sec.Revision, &sec.UpdatedAt)
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
	ctx := r.Context()
	mids, err := s.workMaterialIDs(ctx, m.ID)
	if err != nil {
		return err
	}
	mats, names, err := s.materialsBlock(ctx, mids)
	if err != nil {
		return err
	}
	var angle string
	_ = s.db.QueryRow(ctx, `SELECT coalesce(t.angle,'') FROM work w LEFT JOIN topic t ON t.id=w.topic_id WHERE w.id=$1`, m.ID).Scan(&angle)
	user := fmt.Sprintf(`%s
## 作品
选题：%s
切入角度：%s
核心观点：%s

## 任务说明
围绕作者的核心观点，列出 4 到 8 个段落的大纲。每项给出小标题和本段要点；如果某段适合使用某条素材，在 material_ids 中填写该素材的 id（只能使用上面列出的素材 id）。

## 输出格式
只输出 JSON：{"items":[{"heading":"小标题","key_point":"本段要点","material_ids":[]}]}`,
		mats, m.Title, angle, m.Viewpoint)
	var out struct {
		Items []OutlineItem `json:"items"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "outline", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"materials": names}}, &out, func() error {
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

// saveOutline stores the outline; with confirm=true it records H-03 and creates section blocks.
func (s *Server) saveOutline(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Items   []OutlineItem `json:"items"`
		Confirm bool          `json:"confirm"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	var items []OutlineItem
	for _, it := range in.Items {
		it.Heading = strings.TrimSpace(it.Heading)
		if it.Heading == "" {
			continue
		}
		if it.MaterialIDs == nil {
			it.MaterialIDs = []string{}
		}
		items = append(items, it)
	}
	if in.Confirm && len(items) == 0 {
		return validation("大纲至少需要一项")
	}
	ctx := r.Context()
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if in.Confirm {
			var maxPos int
			if err := tx.QueryRow(ctx, `SELECT coalesce(max(position),-1) FROM work_section WHERE work_id=$1`, m.ID).Scan(&maxPos); err != nil {
				return err
			}
			for i := range items {
				mids := []uuid.UUID{}
				for _, id := range items[i].MaterialIDs {
					if u, err := uuid.Parse(id); err == nil {
						mids = append(mids, u)
					}
				}
				if items[i].SectionID != "" {
					if _, err := tx.Exec(ctx, `UPDATE work_section SET heading=$3, key_point=$4, material_ids=$5, updated_at=now() WHERE id=$1 AND work_id=$2`,
						items[i].SectionID, m.ID, items[i].Heading, items[i].KeyPoint, mids); err != nil {
						return err
					}
					continue
				}
				maxPos++
				var sid uuid.UUID
				if err := tx.QueryRow(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, material_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
					m.ID, maxPos, items[i].Heading, items[i].KeyPoint, mids).Scan(&sid); err != nil {
					return err
				}
				items[i].SectionID = sid.String()
			}
		}
		if items == nil {
			items = []OutlineItem{}
		}
		b, _ := json.Marshal(items)
		if in.Confirm {
			if _, err := tx.Exec(ctx, `UPDATE work SET outline=$2, outline_confirmed_at=coalesce(outline_confirmed_at, now()), updated_at=now() WHERE id=$1`, m.ID, b); err != nil {
				return err
			}
			return s.touchContent(ctx, tx, m.ID)
		}
		_, err := tx.Exec(ctx, `UPDATE work SET outline=$2, updated_at=now() WHERE id=$1`, m.ID, b)
		return err
	})
	if err != nil {
		return err
	}
	if in.Confirm {
		s.audit(ctx, "outline_confirm", "work", m.ID.String(), "ok", map[string]any{"items": len(items)})
	}
	return s.writeWork(w, r, m.ID)
}

func requireOutline(m *workMeta) error {
	if m.OutlineConfirmedAt == nil {
		return humanStep("H-03", "请先确认大纲，再起草段落")
	}
	return nil
}

func (s *Server) createSection(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if err := requireOutline(m); err != nil {
		return err
	}
	var in struct {
		Heading string `json:"heading"`
	}
	_ = decode(r, &in)
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := tx.Exec(r.Context(), `INSERT INTO work_section (work_id, position, heading)
			VALUES ($1, (SELECT coalesce(max(position),-1)+1 FROM work_section WHERE work_id=$1), $2)`, m.ID, strings.TrimSpace(in.Heading)); err != nil {
			return err
		}
		return s.touchContent(r.Context(), tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

func (s *Server) reorderSections(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		IDs []uuid.UUID `json:"ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		for i, id := range in.IDs {
			if _, err := tx.Exec(r.Context(), `UPDATE work_section SET position=$3 WHERE id=$1 AND work_id=$2`, id, m.ID, i); err != nil {
				return err
			}
		}
		return s.touchContent(r.Context(), tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

// updateSection saves a block with optimistic locking (05 文档 E-13).
func (s *Server) updateSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Heading      *string `json:"heading"`
		ContentMD    *string `json:"content_md"`
		BaseRevision int     `json:"base_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision != sec.Revision {
		return apiErr(409, "version_conflict", "这一段已在其他地方修改过").With(map[string]any{"server": sec})
	}
	ctx := r.Context()
	var out Section
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		origin := sec.Origin
		if in.ContentMD != nil && *in.ContentMD != sec.ContentMD && origin == "ai" {
			origin = "mixed"
		}
		if in.ContentMD != nil && sec.ContentMD == "" && origin == "human" {
			origin = "human"
		}
		if err := tx.QueryRow(ctx, `UPDATE work_section SET heading=coalesce($2,heading), content_md=coalesce($3,content_md), origin=$4,
			revision=revision+1, updated_at=now() WHERE id=$1
			RETURNING id, position, heading, key_point, content_md, origin, source_section_ids, material_ids, revision, updated_at`,
			sec.ID, in.Heading, in.ContentMD, origin).Scan(&out.ID, &out.Position, &out.Heading, &out.KeyPoint, &out.ContentMD, &out.Origin,
			&out.SourceSectionIDs, &out.MaterialIDs, &out.Revision, &out.UpdatedAt); err != nil {
			return err
		}
		if err := s.touchContent(ctx, tx, m.ID); err != nil {
			return err
		}
		return s.addVersion(ctx, tx, m.ID, "auto")
	})
	if err != nil {
		return err
	}
	var rev int
	var status string
	_ = s.db.QueryRow(ctx, `SELECT revision, status FROM work WHERE id=$1`, m.ID).Scan(&rev, &status)
	return ok(w, map[string]any{"section": out, "work_revision": rev, "work_status": status})
}

func (s *Server) deleteSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if err := s.addVersion(r.Context(), tx, m.ID, "manual"); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM work_section WHERE id=$1`, sec.ID); err != nil {
			return err
		}
		return s.touchContent(r.Context(), tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

func (s *Server) saveAIContent(ctx context.Context, sec *Section, m *workMeta, text string) (*Section, error) {
	var out Section
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `UPDATE work_section SET content_md=$2, ai_raw_md=$2, origin='ai', revision=revision+1, updated_at=now() WHERE id=$1
			RETURNING id, position, heading, key_point, content_md, origin, source_section_ids, material_ids, revision, updated_at`,
			sec.ID, strings.TrimSpace(text)).Scan(&out.ID, &out.Position, &out.Heading, &out.KeyPoint, &out.ContentMD, &out.Origin,
			&out.SourceSectionIDs, &out.MaterialIDs, &out.Revision, &out.UpdatedAt); err != nil {
			return err
		}
		if err := s.touchContent(ctx, tx, m.ID); err != nil {
			return err
		}
		return s.addVersion(ctx, tx, m.ID, "ai")
	})
	return &out, err
}

// draftSection drafts exactly one block (UX-05: no "draft all"). Requires H-02 and H-03.
func (s *Server) draftSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if strings.TrimSpace(m.Viewpoint) == "" {
		return humanStep("H-02", "请先写下你自己的核心观点")
	}
	if err := requireOutline(m); err != nil {
		return err
	}
	ctx := r.Context()
	outline, err := s.workOutline(ctx, m.ID)
	if err != nil {
		return err
	}
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
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
	mids := sec.MaterialIDs
	if len(mids) == 0 {
		if mids, err = s.workMaterialIDs(ctx, m.ID); err != nil {
			return err
		}
	}
	mats, names, err := s.materialsBlock(ctx, mids)
	if err != nil {
		return err
	}
	length := "300 到 600 字"
	if m.Account.Platform == "xhs" {
		length = "80 到 200 字，语气口语化，可以适度使用表情符号"
	}
	user := fmt.Sprintf(`%s
## 作品
标题：%s
核心观点：%s

## 已确认的大纲
%s
## 相邻段落
上一段：%s
下一段：%s

## 本段
本段小标题：%s
本段要点：%s

## 任务说明
只写本段正文，不要写本段小标题。长度约 %s。素材中没有的数据写成"【待核实：需要的内容】"。

## 输出格式
直接输出 Markdown 正文。`, mats, m.Title, m.Viewpoint, outlineText(outline), nz(prev, "（无）"), nz(next, "（无）"), sec.Heading, sec.KeyPoint, length)
	return s.streamAI(w, r, aiTask{Type: "section_draft", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"materials": names}},
		func(text string, _ *aiResult) (any, error) {
			return s.saveAIContent(context.WithoutCancel(ctx), sec, m, text)
		})
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
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	modes := map[string]string{"rewrite": "换一种说法改写，意思不变", "expand": "在不增加新事实的前提下扩写，补充解释和过渡", "shorten": "缩写到原来的一半左右，保留关键信息"}
	desc, okMode := modes[in.Mode]
	if !okMode {
		return validation("模式只能是改写、扩写或缩写")
	}
	if strings.TrimSpace(in.Selection) == "" {
		in.Selection = sec.ContentMD
	}
	if strings.TrimSpace(in.Selection) == "" {
		return validation("这一段还没有内容")
	}
	user := fmt.Sprintf(`## 上下文
本段小标题：%s
本段全文：
%s

## 任务说明
模式：%s
要求：%s
作者补充要求：%s
选中内容：%s

## 输出格式
只输出替换后的文字，不改动未选中的部分，不加任何说明。`, sec.Heading, truncate(sec.ContentMD, 1500), in.Mode, desc, nz(strings.TrimSpace(in.Instruction), "无"), in.Selection)
	return s.streamAI(w, r, aiTask{Type: "section_edit", Account: m.Account, WorkID: &m.ID, User: user}, nil)
}

func (s *Server) generateTitles(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	limit := "不超过 32 字"
	if m.Account.Platform == "xhs" {
		limit = "不超过 20 字，口语化，可以带一个表情符号"
	}
	user := fmt.Sprintf(`## 作品
核心观点：%s
正文摘要：
%s

## 任务说明
平台：%s。给出不少于 5 个标题候选，每个%s，风格各不相同；不使用标题党和夸大表达。

## 输出格式
只输出 JSON：{"titles":[{"text":"标题","style":"风格说明"}]}`, m.Viewpoint, bodyDigest(secs, 1500), platformNames[m.Account.Platform], limit)
	var out struct {
		Titles []struct {
			Text  string `json:"text"`
			Style string `json:"style"`
		} `json:"titles"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "title", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Titles) < 5 {
			return fmt.Errorf("标题少于 5 个")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"titles": out.Titles, "refs": res.Refs})
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

func deriveAllowed(src, dst *Account, srcFormat string) error {
	if src.Platform == dst.Platform {
		return validation("派生只能在不同平台之间进行（同平台派生容易造成同质内容）")
	}
	textual := map[string]bool{"long_article": true, "image_note": true}
	switch {
	case textual[srcFormat] && textual[dst.ContentFormat]:
		return nil
	case srcFormat == "comic" && dst.ContentFormat == "comic":
		return validation("漫画之间的派生将在后续版本提供")
	default:
		return validation("长图文、图文笔记与漫画之间不支持派生，请新建作品并引用同一选题")
	}
}

func (s *Server) deriveWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		TargetAccountID uuid.UUID `json:"target_account_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	dst, err := s.account(ctx, in.TargetAccountID)
	if err != nil {
		return err
	}
	if dst.Status != "active" {
		return validation("目标账号已停用")
	}
	var srcFormat string
	if err := s.db.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1`, m.ID).Scan(&srcFormat); err != nil {
		return err
	}
	if err := deriveAllowed(m.Account, dst, srcFormat); err != nil {
		return err
	}
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	if len(secs) == 0 {
		return validation("源作品还没有正文，无法派生")
	}
	var b strings.Builder
	for _, x := range secs {
		fmt.Fprintf(&b, "【源段落 id=%s】小标题：%s\n%s\n", x.ID, x.Heading, truncate(x.ContentMD, 1200))
	}
	direction := "把公众号长文压缩改写为小红书图文笔记：3 到 6 个要点段，每段短小，口语化"
	if dst.Platform == "wechat_mp" {
		direction = "把小红书笔记扩写为公众号长文：4 到 8 个段落，每段有小标题，展开论述"
	}
	var viewpoint string
	_ = s.db.QueryRow(ctx, `SELECT viewpoint FROM work WHERE id=$1`, m.ID).Scan(&viewpoint)
	user := fmt.Sprintf(`## 源作品
源平台：%s
目标平台：%s
源标题：%s
核心观点：%s

%s
## 任务说明
%s。规划目标作品的段落，并说明每个目标段落对应哪些源段落（source_section_ids 只能使用上面的 id）。给出目标平台的标题%s。

## 输出格式
只输出 JSON：{"title":"标题","sections":[{"source_section_ids":["id"],"key_point":"本段要点"}],"topics":["话题"]}`,
		platformNames[m.Account.Platform], platformNames[dst.Platform], m.Title, viewpoint, b.String(), direction,
		map[bool]string{true: "和 3 到 8 个话题", false: ""}[dst.Platform == "xhs"])
	var plan struct {
		Title    string `json:"title"`
		Sections []struct {
			SourceSectionIDs []string `json:"source_section_ids"`
			KeyPoint         string   `json:"key_point"`
		} `json:"sections"`
		Topics []string `json:"topics"`
	}
	valid := map[string]bool{}
	for _, x := range secs {
		valid[x.ID.String()] = true
	}
	if _, err := s.runAIJSON(ctx, aiTask{Type: "rewrite_plan", Account: dst, User: user}, &plan, func() error {
		if len(plan.Sections) == 0 {
			return fmt.Errorf("没有段落")
		}
		return nil
	}); err != nil {
		return err
	}
	var newID uuid.UUID
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		p, err := s.loadProfile(ctx, dst.ID)
		if err != nil {
			return err
		}
		wf, _ := json.Marshal(p.WechatDefaults)
		topics := []string{}
		if dst.Platform == "xhs" {
			topics = cleanList(plan.Topics)
		}
		var outline []OutlineItem
		if err := tx.QueryRow(ctx, `INSERT INTO work (account_id, topic_id, source_work_id, source_revision, content_format, title, viewpoint,
			outline_confirmed_at, theme, wechat_fields, topics)
			SELECT $1, topic_id, id, revision, $2, $3, viewpoint, now(), $4, $5, $6 FROM work WHERE id=$7 RETURNING id`,
			dst.ID, dst.ContentFormat, truncateRunes(plan.Title, 64), p.DefaultTheme, wf, topics, m.ID).Scan(&newID); err != nil {
			return err
		}
		for i, ps := range plan.Sections {
			ids := []uuid.UUID{}
			for _, sid := range ps.SourceSectionIDs {
				if valid[sid] {
					ids = append(ids, uuid.MustParse(sid))
				}
			}
			heading := ""
			if dst.Platform == "wechat_mp" {
				heading = truncateRunes(ps.KeyPoint, 24)
			}
			var sid uuid.UUID
			if err := tx.QueryRow(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, source_section_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
				newID, i, heading, ps.KeyPoint, ids).Scan(&sid); err != nil {
				return err
			}
			outline = append(outline, OutlineItem{Heading: nz(heading, truncateRunes(ps.KeyPoint, 24)), KeyPoint: ps.KeyPoint, MaterialIDs: []string{}, SectionID: sid.String()})
		}
		ob, _ := json.Marshal(outline)
		if _, err := tx.Exec(ctx, `UPDATE work SET outline=$2 WHERE id=$1`, newID, ob); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO work_material (work_id, material_id) SELECT $1, wm.material_id FROM work_material wm
			JOIN material mt ON mt.id=wm.material_id WHERE wm.work_id=$2 AND (mt.account_id IS NULL OR mt.account_id=$3)`, newID, m.ID, dst.ID)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "work_derive", "work", newID.String(), "ok", map[string]any{"source": m.ID.String()})
	return s.writeWork(w, r, newID)
}

// rewriteSection is step two of derivation; also used for "重新改写本段".
func (s *Server) rewriteSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if m.SourceWorkID == nil {
		return validation("这篇作品不是派生作品")
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id, heading, content_md FROM work_section WHERE work_id=$1 AND id = ANY($2) ORDER BY position`, *m.SourceWorkID, sec.SourceSectionIDs)
	if err != nil {
		return err
	}
	var b strings.Builder
	for rows.Next() {
		var id uuid.UUID
		var h, c string
		if err := rows.Scan(&id, &h, &c); err == nil {
			fmt.Fprintf(&b, "【源段落 id=%s】小标题：%s\n%s\n", id, h, truncate(c, 2000))
		}
	}
	rows.Close()
	var srcPlatform string
	_ = s.db.QueryRow(ctx, `SELECT a.platform FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1`, *m.SourceWorkID).Scan(&srcPlatform)
	format := "Markdown 正文，不写本段小标题，300 到 600 字"
	if m.Account.Platform == "xhs" {
		format = "纯文本，不使用 Markdown 标记，80 到 200 字，口语化，可以用表情符号"
	}
	user := fmt.Sprintf(`## 改写
源平台：%s
目标平台：%s
本段要点：%s

%s
## 任务说明
按目标账号的定位和风格，把上面的源段落改写为目标平台的一段内容。只保留源段落中的事实，不新增事实。

## 输出格式
%s。直接输出正文。`, platformNames[srcPlatform], platformNames[m.Account.Platform], sec.KeyPoint, nz(b.String(), "（源段落已删除）\n"), format)
	return s.streamAI(w, r, aiTask{Type: "section_rewrite", Account: m.Account, WorkID: &m.ID, User: user},
		func(text string, _ *aiResult) (any, error) {
			return s.saveAIContent(context.WithoutCancel(ctx), sec, m, text)
		})
}
