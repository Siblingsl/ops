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
		Items        []OutlineItem `json:"items"`
		Confirm      bool          `json:"confirm"`
		BaseRevision *int          `json:"base_revision"`
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
	// NW-C2 / H-02：观点必须由作者写。确认大纲是起稿的门槛，不能在没有观点时绕过。
	if in.Confirm && strings.TrimSpace(m.Viewpoint) == "" {
		return humanStep("H-02", "请先写下你自己的核心观点，再确认大纲")
	}
	ctx := r.Context()
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkSections(ctx, tx, m); err != nil {
			return err
		}
		if err := s.checkWorkRevision(ctx, tx, m, in.BaseRevision); err != nil {
			return err
		}
		if in.Confirm {
			materialIDs := []uuid.UUID{}
			for _, item := range items {
				for _, rawID := range item.MaterialIDs {
					if id, err := uuid.Parse(rawID); err == nil {
						materialIDs = append(materialIDs, id)
					}
				}
			}
			if err := lockMaterialRowsForShare(ctx, tx, ident(ctx).WorkspaceID, m.Account.ID, materialIDs); err != nil {
				return err
			}
		}
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
					if _, err := tx.Exec(ctx, `UPDATE work_section SET heading=$3, key_point=$4, material_ids=$5, revision=revision+1, updated_at=now() WHERE id=$1 AND work_id=$2`,
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
		_, err := tx.Exec(ctx, `UPDATE work SET outline=$2, revision=revision+1, updated_at=now() WHERE id=$1`, m.ID, b)
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
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('card-order:' || $1::text,0))`, m.ID.String()); err != nil {
			return err
		}
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
		IDs          []uuid.UUID `json:"ids"`
		BaseRevision *int        `json:"base_revision"`
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
		if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('card-order:' || $1::text,0))`, m.ID.String()); err != nil {
			return err
		}
		if err := lockWorkSections(r.Context(), tx, m); err != nil {
			return err
		}
		if err := s.checkWorkRevision(r.Context(), tx, m, in.BaseRevision); err != nil {
			return err
		}
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
			Kind            string          `json:"kind"`
			AICallID        *uuid.UUID      `json:"ai_call_id"`
			SourceRevisions json.RawMessage `json:"source_revisions"`
		} `json:"applied"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	changed := false
	var out Section
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		current, err := scanSection(tx.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, sec.ID))
		if err != nil {
			return err
		}
		if in.BaseRevision != current.Revision {
			return apiErr(409, "version_conflict", "这一段已在其他地方修改过").With(map[string]any{"server": current})
		}
		sec = &current
		changed = in.ContentMD != nil && *in.ContentMD != sec.ContentMD
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
			if in.Applied.Kind == "draft" {
				origin, revOrigin = "ai", "ai"
				if _, err := tx.Exec(ctx, `UPDATE work_section SET ai_raw_md=$2,ai_call_id=$3,source_revisions=coalesce(nullif($4::jsonb,'null'::jsonb),source_revisions) WHERE id=$1`, sec.ID, *in.ContentMD, revCall, in.Applied.SourceRevisions); err != nil {
					return err
				}
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
	if changed && in.Applied != nil && in.Applied.Kind == "draft" && in.Applied.AICallID != nil {
		s.implicitFeedback(ctx, *in.Applied.AICallID, "accepted", nil, nil)
	}
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
func (s *Server) saveAIContent(ctx context.Context, sec *Section, m *workMeta, text string, res *aiResult, sourceRevisions json.RawMessage) (*Section, error) {
	var out Section
	var callID *uuid.UUID
	var refs map[string]any
	if res != nil {
		callID = &res.CallID
		refs = res.Refs
	}
	var prevCall *uuid.UUID
	var prevContent, prevRaw string
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		current, err := scanSection(tx.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, sec.ID))
		if err != nil {
			return err
		}
		if current.Revision != sec.Revision {
			return apiErr(409, "version_conflict", "这段在生成期间被修改过").With(map[string]any{"server": current, "candidate": strings.TrimSpace(text), "ai_call_id": callID, "source_revisions": sourceRevisions, "refs": refs})
		}
		prevCall, prevContent, prevRaw = current.AICallID, current.ContentMD, current.AIRawMD
		if _, err := tx.Exec(ctx, `UPDATE work_section SET content_md=$2, ai_raw_md=$2, origin='ai', ai_call_id=$3, source_revisions=coalesce($4,source_revisions), revision=revision+1, updated_at=now() WHERE id=$1`,
			sec.ID, strings.TrimSpace(text), callID, sourceRevisions); err != nil {
			return err
		}
		if err := s.addSectionRevision(ctx, tx, sec.ID, strings.TrimSpace(text), "ai", callID); err != nil {
			return err
		}
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
	} else if m.Account.Platform == "toutiao" && m.ContentFormat == "micro_post" {
		length = "简短表达本段要点，不需要凑足篇幅；长度建议仅用于控制简洁度，不代表平台上限"
	}
	typeRule := ""
	if fb := platformFormatBrief(m.Account.Platform, m.ContentFormat); fb != "" {
		typeRule = "\n类型要求：" + fb + "\n按这个类型的结构约定写本段。"
	}
	// DEV-416 / D-140：模板管结构与语气；type_note 只补这篇的个别要求。
	if m.TemplateID != nil {
		if tpl, err := s.findCreationTemplate(ctx, *m.TemplateID); err == nil {
			if tpl.Tone != "" {
				typeRule += "\n模板语气：" + tpl.Tone + "。"
			}
			if tpl.PromptAddon != "" {
				typeRule += "\n模板补充要求：" + tpl.PromptAddon
			}
		}
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
			out, err := s.saveAIContent(context.WithoutCancel(ctx), sec, m, fixed, res, nil)
			if err != nil {
				if ae, ok := err.(*APIError); ok && ae.Code == "version_conflict" {
					detail := ae.Detail.(map[string]any)
					if changed {
						detail["self_check"] = map[string]any{"fixes": fixes, "original": text}
					}
				}
				return nil, err
			}
			if !changed {
				return map[string]any{"section": out}, nil
			}
			return map[string]any{"section": out, "self_check": map[string]any{"fixes": fixes, "original": text}}, nil
		})
}
