package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	seen := map[uuid.UUID]bool{}
	for _, id := range in.IDs {
		if seen[id] {
			return validation("排序不能包含重复段落")
		}
		seen[id] = true
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var total, matched int
		if err := tx.QueryRow(r.Context(), `SELECT count(*), count(*) FILTER(WHERE id=ANY($2::uuid[])) FROM work_section WHERE work_id=$1 AND deleted_at IS NULL`, m.ID, in.IDs).Scan(&total, &matched); err != nil {
			return err
		}
		if total != len(in.IDs) || matched != total {
			return validation("请提供本作品全部有效段落，不能遗漏或包含其他作品段落")
		}
		for i, id := range in.IDs {
			if _, err := tx.Exec(r.Context(), `UPDATE work_section SET position=$3 WHERE id=$1 AND work_id=$2 AND deleted_at IS NULL`, id, m.ID, i); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(r.Context(), `UPDATE work_card c SET position=s.position,updated_at=now() FROM work_section s WHERE c.section_id=s.id AND c.work_id=$1 AND s.deleted_at IS NULL`, m.ID); err != nil {
			return err
		}
		// 已确认大纲按段落事实顺序同步，保留全部文案和素材引用。
		if _, err := tx.Exec(r.Context(), `UPDATE work SET outline=coalesce((SELECT jsonb_agg(item ORDER BY s.position NULLS LAST,idx) FROM jsonb_array_elements(outline) WITH ORDINALITY o(item,idx) LEFT JOIN work_section s ON s.id::text=item->>'section_id' AND s.work_id=$1 AND s.deleted_at IS NULL),'[]'::jsonb) WHERE id=$1 AND outline_confirmed_at IS NOT NULL`, m.ID); err != nil {
			return err
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
		// Applied marks that this save includes AI text the user accepted in the editor (改写替换 / 续写).
		Applied *struct {
			Kind     string     `json:"kind"`
			AICallID *uuid.UUID `json:"ai_call_id"`
		} `json:"applied"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision != sec.Revision {
		return apiErr(409, "version_conflict", "这一段已在其他地方修改过").With(map[string]any{"server": sec})
	}
	ctx := r.Context()
	changed := in.ContentMD != nil && *in.ContentMD != sec.ContentMD
	var out Section
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		origin := sec.Origin
		if changed && origin == "ai" {
			origin = "mixed"
		}
		revOrigin, revCall := origin, (*uuid.UUID)(nil)
		if changed && in.Applied != nil {
			origin = "mixed"
			revOrigin, revCall = "mixed", in.Applied.AICallID
			if in.Applied.Kind == "rewrite" {
				revOrigin = "rewrite"
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE work_section SET heading=coalesce($2,heading), content_md=coalesce($3,content_md), origin=$4,
			revision=revision+1, updated_at=now() WHERE id=$1`, sec.ID, in.Heading, in.ContentMD, origin); err != nil {
			return err
		}
		if changed {
			if err := s.addSectionRevision(ctx, tx, sec.ID, *in.ContentMD, revOrigin, revCall); err != nil {
				return err
			}
		}
		var err error
		if out, err = scanSection(tx.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1`, sec.ID)); err != nil {
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
	if in.ContentMD != nil && sec.AICallID != nil && strings.TrimSpace(sec.AIRawMD) != "" && *in.ContentMD != sec.ContentMD {
		ratio := sectionEditRatio(sec.AIRawMD, *in.ContentMD)
		outcome := "accepted"
		if ratio > 0.02 {
			outcome = "edited"
		}
		s.implicitFeedback(ctx, *sec.AICallID, outcome, nil, &ratio)
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
		if _, err := tx.Exec(r.Context(), `UPDATE work_section SET deleted_at=now() WHERE id=$1`, sec.ID); err != nil {
			return err
		}
		return s.touchContent(r.Context(), tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

// restoreSection undoes a section delete at its original position (4.3 撤销体系).
func (s *Server) restoreSection(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var workID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT work_id FROM work_section WHERE id=$1 AND deleted_at IS NOT NULL`, id).Scan(&workID); err != nil {
		return err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE work_section SET deleted_at=NULL, updated_at=now() WHERE id=$1`, id); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

// addSectionRevision records one section change (EX-E-12): identical content is skipped and only the latest 30 are kept.
func (s *Server) addSectionRevision(ctx context.Context, tx pgx.Tx, sectionID uuid.UUID, content, origin string, callID *uuid.UUID) error {
	var last string
	err := tx.QueryRow(ctx, `SELECT content_md FROM section_revision WHERE section_id=$1 ORDER BY created_at DESC LIMIT 1`, sectionID).Scan(&last)
	if err == nil && last == content {
		return nil
	}
	var user *uuid.UUID
	if id := ident(ctx); id != nil && id.UserID != uuid.Nil {
		user = &id.UserID
	}
	if _, err := tx.Exec(ctx, `INSERT INTO section_revision (section_id, content_md, origin, ai_call_id, created_by) VALUES ($1,$2,$3,$4,$5)`,
		sectionID, content, origin, callID, user); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM section_revision WHERE section_id=$1 AND id NOT IN
		(SELECT id FROM section_revision WHERE section_id=$1 ORDER BY created_at DESC LIMIT 30)`, sectionID)
	return err
}

// saveAIContent writes an AI draft into an empty or regenerated section; the previous untouched draft counts as regenerated.
func (s *Server) saveAIContent(ctx context.Context, sec *Section, m *workMeta, text string, res *aiResult) (*Section, error) {
	var out Section
	var callID *uuid.UUID
	if res != nil {
		callID = &res.CallID
	}
	var prevCall *uuid.UUID
	var prevContent, prevRaw string
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT ai_call_id, content_md, ai_raw_md FROM work_section WHERE id=$1 FOR UPDATE`, sec.ID).Scan(&prevCall, &prevContent, &prevRaw); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE work_section SET content_md=$2, ai_raw_md=$2, origin='ai', ai_call_id=$3, revision=revision+1, updated_at=now() WHERE id=$1`,
			sec.ID, strings.TrimSpace(text), callID); err != nil {
			return err
		}
		if err := s.addSectionRevision(ctx, tx, sec.ID, strings.TrimSpace(text), "ai", callID); err != nil {
			return err
		}
		var err error
		if out, err = scanSection(tx.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1`, sec.ID)); err != nil {
			return err
		}
		if err := s.touchContent(ctx, tx, m.ID); err != nil {
			return err
		}
		return s.addVersion(ctx, tx, m.ID, "ai")
	})
	if err != nil {
		return nil, err
	}
	if prevCall != nil && strings.TrimSpace(prevContent) != "" {
		if prevContent == prevRaw {
			s.implicitFeedback(ctx, *prevCall, "regenerated", nil, nil)
		}
	}
	if callID != nil {
		s.implicitFeedback(ctx, *callID, "accepted", nil, nil)
	}
	return &out, nil
}

// draftSection drafts exactly one block (UX-05: no "draft all"). Requires H-02 and H-03.
// Optional JSON body: {"instruction":"..."} — one-shot author direction for this draft only.
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
	var in struct {
		Instruction string `json:"instruction"`
		Tier        string `json:"tier"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	work, neighbors, err := s.sectionContext(ctx, m, sec)
	if err != nil {
		return err
	}
	mids, err := s.sectionMaterialIDs(ctx, m, sec)
	if err != nil {
		return err
	}
	length := "300 到 600 字"
	if m.Account.Platform == "xhs" {
		length = "80 到 200 字，语气口语化，可以适度使用表情符号"
	}
	typeRule := ""
	if fb := formatBrief(m.ContentFormat); fb != "" {
		typeRule = "\n类型要求：" + fb + "\n按这个类型的结构约定写本段。"
	}
	user := fmt.Sprintf(`## 本段
本段小标题：%s
本段要点：%s

## 任务说明
只写本段正文，不要写本段小标题。长度约 %s。素材中没有的数据写成"【待核实：需要的内容】"。%s

## 输出格式
直接输出 Markdown 正文。`, sec.Heading, sec.KeyPoint, length, typeRule)
	t := aiTask{Type: "section_draft", Account: m.Account, WorkID: &m.ID, User: user, Materials: mids, Work: work, Neighbors: neighbors,
		History: sec.Heading + " " + sec.KeyPoint, Instruction: in.Instruction, Tier: s.pickTier(ctx, in.Tier), Refs: map[string]any{"section_id": sec.ID}}
	label := "起草「" + truncate(nz(sec.Heading, sec.KeyPoint), 16) + "」"
	return s.streamAIJob(w, r, t, jobMeta{SectionID: &sec.ID, Label: label, Link: "/works/" + m.ID.String() + "#section-" + sec.ID.String()},
		func(text string, res *aiResult) (any, error) {
			// DEV-A105：起草自检前置——绝对化用语等机械问题在初稿上直接修正并透明标注。
			fixed, fixes, changed := selfCheckDraft(text)
			out, err := s.saveAIContent(context.WithoutCancel(ctx), sec, m, fixed, res)
			if err != nil {
				return nil, err
			}
			if !changed {
				return map[string]any{"section": out}, nil
			}
			return map[string]any{"section": out, "self_check": map[string]any{"fixes": fixes, "original": text}}, nil
		})
}

// workBrief is the work slot: title, topic fields, viewpoint, confirmed outline and series neighbours.
func (s *Server) workBrief(ctx context.Context, m *workMeta) (string, error) {
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
	if m.OutlineConfirmedAt != nil && len(outline) > 0 {
		b.WriteString("\n## 已确认的大纲\n" + outlineText(outline))
	}
	if seriesID != nil {
		b.WriteString(s.seriesNeighbours(ctx, *seriesID, topicID))
	}
	return b.String(), nil
}

// sectionContext returns the work slot and the neighbour paragraphs (trimmed first when over budget).
func (s *Server) sectionContext(ctx context.Context, m *workMeta, sec *Section) (string, string, error) {
	work, err := s.workBrief(ctx, m)
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
	modes := map[string]string{"rewrite": "换一种说法改写，意思不变", "expand": "在不增加新事实的前提下扩写，补充解释和过渡", "shorten": "缩写到原来的一半左右，保留关键信息"}
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
		Tier: s.pickTier(ctx, in.Tier), Refs: map[string]any{"section_id": sec.ID}}
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
	rows, err := s.db.Query(ctx, `SELECT w.title, (SELECT max(reads) FROM metric_snapshot m WHERE m.work_id=w.id) AS reads FROM work w
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id) ORDER BY reads DESC NULLS LAST LIMIT 200`, accountID)
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

func deriveAllowed(src, dst *Account, srcFormat string) error {
	if src.Platform == dst.Platform {
		return validation("派生只能在不同平台之间进行（同平台派生容易造成同质内容）")
	}
	// D-048 第 5.9 节：首批只保留既有两条转换路径（长图文↔图文笔记、漫画↔漫画），
	// 新类型（问答体/简报/清单/卡片/脚本）没有已实现的转换，派生入口一律禁用。
	textual := map[string]bool{"long_article": true, "image_note": true}
	switch {
	case textual[srcFormat] && textual[dst.ContentFormat]:
		return nil
	case srcFormat == "comic" && dst.ContentFormat == "comic":
		return nil
	default:
		return validation("这两种类型之间不支持派生（当前仅支持 长图文↔图文笔记、漫画↔漫画），请新建作品并引用同一选题")
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
	if srcFormat == "comic" {
		return s.deriveComicWork(w, r, m, dst)
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
	revOf := map[string]int{}
	for _, x := range secs {
		valid[x.ID.String()] = true
		revOf[x.ID.String()] = x.Revision
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
			atMs, err := s.dbNowMillis(ctx, tx)
			if err != nil {
				return err
			}
			revs := map[string]int{revsAtKey: atMs}
			for _, sid := range ps.SourceSectionIDs {
				if valid[sid] {
					ids = append(ids, uuid.MustParse(sid))
					revs[sid] = revOf[sid]
				}
			}
			heading := ""
			if dst.Platform == "wechat_mp" {
				heading = truncateRunes(ps.KeyPoint, 24)
			}
			rb, _ := json.Marshal(revs)
			var sid uuid.UUID
			if err := tx.QueryRow(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, source_section_ids, source_revisions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
				newID, i, heading, ps.KeyPoint, ids, rb).Scan(&sid); err != nil {
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
	rows, err := s.db.Query(ctx, `SELECT id, heading, content_md, revision FROM work_section WHERE work_id=$1 AND id = ANY($2) AND deleted_at IS NULL ORDER BY position`,
		*m.SourceWorkID, sec.SourceSectionIDs)
	if err != nil {
		return err
	}
	var b strings.Builder
	atMs, err := s.dbNowMillis(ctx, nil)
	if err != nil {
		return err
	}
	srcRevs := map[string]int{revsAtKey: atMs}
	for rows.Next() {
		var id uuid.UUID
		var h, c string
		var rev int
		if err := rows.Scan(&id, &h, &c, &rev); err == nil {
			fmt.Fprintf(&b, "【源段落 id=%s】小标题：%s\n%s\n", id, h, truncate(c, 2000))
			srcRevs[id.String()] = rev
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
	return s.streamAIJob(w, r, aiTask{Type: "section_rewrite", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"section_id": sec.ID}},
		jobMeta{SectionID: &sec.ID, Label: "改写「" + truncate(nz(sec.Heading, sec.KeyPoint), 16) + "」", Link: "/works/" + m.ID.String() + "/derive"},
		func(text string, res *aiResult) (any, error) {
			bg := context.WithoutCancel(ctx)
			rb, _ := json.Marshal(srcRevs)
			if _, err := s.db.Exec(bg, `UPDATE work_section SET source_revisions=$2 WHERE id=$1`, sec.ID, rb); err != nil {
				return nil, err
			}
			return s.saveAIContent(bg, sec, m, text, res)
		})
}

type FamilyMember struct {
	ID        uuid.UUID  `json:"id"`
	SourceID  *uuid.UUID `json:"source_id"`
	Title     string     `json:"title"`
	Status    string     `json:"status"`
	Platform  string     `json:"platform"`
	Account   string     `json:"account"`
	Depth     int        `json:"depth"`
	NeedsSync bool       `json:"needs_sync"`
}

// workFamily walks up to the root work and lists every derived descendant (EX-F-04), within the workspace.
func (s *Server) workFamily(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	var root uuid.UUID
	if err := s.db.QueryRow(ctx, `WITH RECURSIVE up AS (
			SELECT w.id, w.source_work_id, 0 AS d FROM work w WHERE w.id=$1
			UNION ALL
			SELECT p.id, p.source_work_id, up.d+1 FROM work p JOIN up ON p.id=up.source_work_id
			JOIN platform_account a ON a.id=p.account_id
			WHERE p.deleted_at IS NULL AND a.workspace_id=$2 AND up.d < 20)
		SELECT id FROM up ORDER BY d DESC LIMIT 1`, m.ID, ws).Scan(&root); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `WITH RECURSIVE down AS (
			SELECT w.id, 0 AS d FROM work w WHERE w.id=$1
			UNION ALL
			SELECT c.id, down.d+1 FROM work c JOIN down ON c.source_work_id=down.id WHERE c.deleted_at IS NULL AND down.d < 20)
		SELECT w.id, w.source_work_id, w.title, w.status, a.platform, a.name, down.d,
			coalesce(sw.deleted_at IS NULL AND w.source_revision > 0 AND sw.revision > w.source_revision, false)
		FROM down JOIN work w ON w.id=down.id JOIN platform_account a ON a.id=w.account_id
		LEFT JOIN work sw ON sw.id=w.source_work_id
		WHERE a.workspace_id=$2 ORDER BY down.d, w.created_at`, root, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []FamilyMember{}
	for rows.Next() {
		var x FamilyMember
		if err := rows.Scan(&x.ID, &x.SourceID, &x.Title, &x.Status, &x.Platform, &x.Account, &x.Depth, &x.NeedsSync); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

// revsAtKey stores, inside source_revisions, the unix milliseconds of the derive / rewrite the revisions belong to.
const revsAtKey = "@at"

// sourceDiff returns, per derived section, whether its source sections changed since the last rewrite (EX-F-01).
// dbNowMillis reads the database clock. source_revisions 的基线与 section_revision.created_at
// 必须同一时钟：应用时钟与数据库时钟（容器）存在毫秒级漂移时，用应用时间做基线会让
// sectionContentAt 把编辑后的内容当成派生时的旧内容（源稿对照出现误报）。
func (s *Server) dbNowMillis(ctx context.Context, q pgx.Tx) (int, error) {
	var ms int64
	var err error
	if q != nil {
		err = q.QueryRow(ctx, `SELECT (extract(epoch from now())*1000)::bigint`).Scan(&ms)
	} else {
		err = s.db.QueryRow(ctx, `SELECT (extract(epoch from now())*1000)::bigint`).Scan(&ms)
	}
	return int(ms), err
}

func (s *Server) sourceDiff(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.SourceWorkID == nil {
		return validation("这篇作品不是派生作品")
	}
	ctx := r.Context()
	secs, err := s.loadSections(ctx, nil, m.ID)
	if err != nil {
		return err
	}
	src, err := s.loadSections(ctx, nil, *m.SourceWorkID)
	if err != nil {
		return err
	}
	byID := map[string]Section{}
	for _, x := range src {
		byID[x.ID.String()] = x
	}
	type srcChange struct {
		SourceID   string `json:"source_id"`
		Heading    string `json:"heading"`
		Changed    bool   `json:"changed"`
		Deleted    bool   `json:"deleted"`
		OldContent string `json:"old_content"`
		NewContent string `json:"new_content"`
	}
	type item struct {
		SectionID string      `json:"section_id"`
		Changed   bool        `json:"changed"`
		Sources   []srcChange `json:"sources"`
	}
	out := []item{}
	for _, x := range secs {
		var revs map[string]int
		_ = json.Unmarshal(x.SourceRevisions, &revs)
		// 基线时间：派生 / 改写当时记录的时间；旧数据没有记录时退回到本段最后修改时间。
		baseline := x.UpdatedAt
		if at, okAt := revs[revsAtKey]; okAt {
			baseline = time.UnixMilli(int64(at))
		}
		it := item{SectionID: x.ID.String(), Sources: []srcChange{}}
		for _, sid := range x.SourceSectionIDs {
			cur, okSrc := byID[sid.String()]
			c := srcChange{SourceID: sid.String()}
			if !okSrc {
				c.Deleted, c.Changed = true, true
			} else {
				c.Heading = cur.Heading
				c.NewContent = cur.ContentMD
				old, had := revs[sid.String()]
				if (had && cur.Revision > old) || (!had && cur.UpdatedAt.After(baseline)) {
					c.Changed = true
					c.OldContent = s.sectionContentAt(ctx, sid, baseline)
				}
			}
			if c.Changed {
				it.Changed = true
			}
			it.Sources = append(it.Sources, c)
		}
		out = append(out, it)
	}
	return ok(w, out)
}

// sectionContentAt is the source section's content as of the derived section's last rewrite (from section history).
func (s *Server) sectionContentAt(ctx context.Context, sectionID uuid.UUID, at time.Time) string {
	var c string
	if err := s.db.QueryRow(ctx, `SELECT content_md FROM section_revision WHERE section_id=$1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`,
		sectionID, at).Scan(&c); err != nil {
		return ""
	}
	return c
}
