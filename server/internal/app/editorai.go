package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 编辑器内的 AI 辅助：开头 / 结尾 / 金句候选（EX-E-08）、行内续写（EX-E-02）、段落历史（EX-E-12）。

var hookKinds = map[string]struct{ label, styles string }{
	"opening": {"开头候选", "提问式、场景式、数据式（没有素材数据时用【待核实】占位）"},
	"ending":  {"结尾候选", "总结式、行动号召式、回扣开头式"},
	"quote":   {"金句候选", "可作为小标题或加粗句的短句，三种不同角度"},
}

func (s *Server) suggestHooks(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Kind      string `json:"kind"`
		Selection string `json:"selection"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	kind, okKind := hookKinds[in.Kind]
	if !okKind {
		return validation("候选类型只能是开头、结尾或金句")
	}
	ctx := r.Context()
	if in.Kind == "quote" && strings.TrimSpace(in.Selection) == "" {
		return validation("请先选中要提炼的文字")
	}
	work, neighbors, err := s.sectionContext(ctx, m, sec)
	if err != nil {
		return err
	}
	mids, err := s.sectionMaterialIDs(ctx, m, sec)
	if err != nil {
		return err
	}
	src := sec.ContentMD
	if in.Kind == "quote" {
		src = in.Selection
	}
	user := fmt.Sprintf(`## 本段
本段小标题：%s
本段要点：%s
现有内容：
%s

## 任务说明
给出 3 个%s，风格分别为：%s。三个候选风格互不相同；只使用素材中的事实。
候选数：3

## 输出格式
只输出 JSON：{"variants":[{"label":"风格","text":"候选文字"}]}`, sec.Heading, sec.KeyPoint, truncate(nz(src, "（空）"), 1500), kind.label, kind.styles)
	var out struct {
		Variants []variant `json:"variants"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "hook_suggest", Account: m.Account, WorkID: &m.ID, User: user, Materials: mids, Work: work, Neighbors: neighbors},
		&out, func() error { return validateVariants(out.Variants, 3) })
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"variants": out.Variants[:3], "ai_call_id": res.CallID, "refs": res.Refs})
}

// continueSection proposes one sentence (≤ 60 字) after the cursor; only on explicit key press (EX-E-02).
func (s *Server) continueSection(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Before string `json:"before"`
		After  string `json:"after"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.Before) == "" {
		return validation("先写几个字，再让 AI 接半句")
	}
	ctx := r.Context()
	mids, err := s.sectionMaterialIDs(ctx, m, sec)
	if err != nil {
		return err
	}
	user := fmt.Sprintf(`## 本段
本段小标题：%s
本段要点：%s
光标前：%s
光标后：%s

## 任务说明
接着光标前的内容只写一句话（不超过 60 字），与光标后的内容自然衔接。不编造数据和经历。

## 输出格式
直接输出这一句话，不加引号和说明。`, sec.Heading, sec.KeyPoint, lastRunes(in.Before, 800), truncate(in.After, 300))
	return s.streamAIJob(w, r, aiTask{Type: "section_continue", Account: m.Account, WorkID: &m.ID, User: user, Materials: mids, SkipStyle: true, Tier: "economy"},
		jobMeta{Ephemeral: true}, func(text string, _ *aiResult) (any, error) {
			return map[string]string{"sentence": oneSentence(text, 60)}, nil
		})
}

func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// oneSentence keeps the first sentence and caps it at n runes.
func oneSentence(s string, n int) string {
	s = strings.TrimSpace(strings.Trim(strings.TrimSpace(s), "\"“”"))
	r := []rune(s)
	for i, c := range r {
		if strings.ContainsRune("。！？!?\n", c) {
			r = r[:i+1]
			break
		}
	}
	if len(r) > n {
		r = r[:n]
	}
	return strings.TrimSpace(string(r))
}

type SectionRevision struct {
	ID        uuid.UUID  `json:"id"`
	ContentMD string     `json:"content_md"`
	Origin    string     `json:"origin"`
	AICallID  *uuid.UUID `json:"ai_call_id"`
	CreatedBy *string    `json:"created_by"`
	CreatedAt time.Time  `json:"created_at"`
}

func (s *Server) listSectionRevisions(w http.ResponseWriter, r *http.Request) error {
	sec, _, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT sr.id, sr.content_md, sr.origin, sr.ai_call_id, u.username, sr.created_at FROM section_revision sr
		LEFT JOIN app_user u ON u.id=sr.created_by WHERE sr.section_id=$1 ORDER BY sr.created_at DESC LIMIT 10`, sec.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []SectionRevision{}
	for rows.Next() {
		var x SectionRevision
		if err := rows.Scan(&x.ID, &x.ContentMD, &x.Origin, &x.AICallID, &x.CreatedBy, &x.CreatedAt); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

// restoreSectionRevision rolls back one section only; other sections and the work history are untouched.
func (s *Server) restoreSectionRevision(w http.ResponseWriter, r *http.Request) error {
	sec, m, err := s.sectionFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	rid, err := pathID(r, "rid")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var in struct {
		BaseRevision *int `json:"base_revision"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	var content, origin string
	if err := s.db.QueryRow(ctx, `SELECT content_md, origin FROM section_revision WHERE id=$1 AND section_id=$2`, rid, sec.ID).Scan(&content, &origin); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		current, err := scanSection(tx.QueryRow(ctx, `SELECT `+sectionCols+` FROM work_section WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, sec.ID))
		if err != nil {
			return err
		}
		base := sec.Revision
		if in.BaseRevision != nil {
			base = *in.BaseRevision
		}
		if current.Revision != base {
			return apiErr(409, "version_conflict", "这一段已在其他地方修改过").With(map[string]any{"server": current})
		}
		if (origin == "ai" && content != current.AIRawMD) || (origin != "ai" && origin != "human") {
			origin = "mixed"
		}
		if err := s.addVersion(ctx, tx, m.ID, "manual"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE work_section SET content_md=$2, origin=$3, revision=revision+1, updated_at=now() WHERE id=$1`, sec.ID, content, origin); err != nil {
			return err
		}
		if err := s.addSectionRevision(ctx, tx, sec.ID, content, origin, nil); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

// purgeDeletedSections removes sections soft-deleted more than 30 days ago.
func (s *Server) purgeDeletedSections(ctx context.Context) {
	_, _ = s.db.Exec(ctx, `DELETE FROM work_section WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`)
}
