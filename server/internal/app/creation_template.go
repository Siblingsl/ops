package app

// DEV-416 / D-124 / D-140：创作模板。
// 一个"模板"同时决定结构、语气、段落区间和提示词补充；原 outline-templates 作为内置结构模板并入，
// 不再有第二套"模板"概念（D-140 决策 4）。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

type CreationTemplate struct {
	ID           uuid.UUID       `json:"id"`
	ContentFormat string         `json:"content_format"`
	Name         string          `json:"name"`
	Builtin      bool            `json:"builtin"`
	Structure    []TemplateStep  `json:"structure"`
	PromptAddon  string          `json:"prompt_addon"`
	SectionMin   int             `json:"section_min"`
	SectionMax   int             `json:"section_max"`
	Tone         string          `json:"tone"`
	UpdatedAt    string          `json:"updated_at,omitempty"`
}

// TemplateStep is one outline slot of a template.
type TemplateStep struct {
	Heading  string `json:"heading"`
	KeyPoint string `json:"key_point"`
	Role     string `json:"role,omitempty"`
}

func templateSteps(headings ...string) []TemplateStep {
	out := make([]TemplateStep, 0, len(headings))
	for _, h := range headings {
		out = append(out, TemplateStep{Heading: h})
	}
	return out
}

// builtinCreationTemplates 每类不超过 2 个（D-124），避免模板长成第二套封闭枚举。
func builtinCreationTemplates() []CreationTemplate {
	return []CreationTemplate{
		{ContentFormat: "long_article", Name: "观点文", Builtin: true, SectionMin: 3, SectionMax: 6, Tone: "克制、具体",
			Structure: templateSteps("提出观点", "论据一", "论据二", "回应可能的反对意见", "回到观点"),
			PromptAddon: "论点先行，每个论据给出具体场景或数据；不要写成口号合集。"},
		{ContentFormat: "long_article", Name: "教程文", Builtin: true, SectionMin: 4, SectionMax: 8, Tone: "清楚、可执行",
			Structure: templateSteps("要解决什么问题", "准备工作", "步骤一", "步骤二", "常见问题", "小结"),
			PromptAddon: "每一步都要能被读者照着做；缺少数据时留【待核实】，不要编造。"},
		{ContentFormat: "qa_article", Name: "单问深答", Builtin: true, SectionMin: 3, SectionMax: 5, Tone: "直接、有依据",
			Structure: templateSteps("先把问题问清楚", "常见但不对的答案", "真正的原因", "可以怎么做"),
			PromptAddon: "只回答一个问题，不扩展到无关话题。"},
		{ContentFormat: "image_note", Name: "攻略笔记", Builtin: true, SectionMin: 3, SectionMax: 7, Tone: "口语、亲近",
			Structure: templateSteps("为什么值得看", "具体做法", "踩过的坑", "一句话总结"),
			PromptAddon: "每段短，便于配图；不要长段落。"},
		{ContentFormat: "card_post", Name: "知识卡片", Builtin: true, SectionMin: 3, SectionMax: 6, Tone: "精炼",
			Structure: templateSteps("一个结论", "为什么", "怎么做", "一句话记住"),
			PromptAddon: "每张卡片一个意思，句子尽量短。"},
	}
}

func (t CreationTemplate) structureText() string {
	parts := make([]string, 0, len(t.Structure))
	for _, s := range t.Structure {
		if strings.TrimSpace(s.Heading) != "" {
			parts = append(parts, strings.TrimSpace(s.Heading))
		}
	}
	return strings.Join(parts, " → ")
}

// findCreationTemplate resolves builtin or workspace template by id.
func (s *Server) findCreationTemplate(ctx context.Context, id uuid.UUID) (*CreationTemplate, error) {
	for _, t := range builtinCreationTemplates() {
		if templateStableID(t) == id {
			copy := t
			copy.ID = id
			return &copy, nil
		}
	}
	var t CreationTemplate
	var raw []byte
	var updated string
	err := s.db.QueryRow(ctx, `SELECT id, content_format, name, builtin, structure, prompt_addon, section_min, section_max, tone, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM creation_template WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, id, ident(ctx).WorkspaceID).
		Scan(&t.ID, &t.ContentFormat, &t.Name, &t.Builtin, &raw, &t.PromptAddon, &t.SectionMin, &t.SectionMax, &t.Tone, &updated)
	if err != nil {
		return nil, validation("模板不存在或已删除")
	}
	_ = json.Unmarshal(raw, &t.Structure)
	t.UpdatedAt = updated
	return &t, nil
}

// templateStableID gives builtin templates a deterministic uuid so they need no rows in the table.
func templateStableID(t CreationTemplate) uuid.UUID {
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte("creation_template:"+t.ContentFormat+":"+t.Name))
}

func (s *Server) listCreationTemplates(w http.ResponseWriter, r *http.Request) error {
	format := strings.TrimSpace(r.URL.Query().Get("content_format"))
	out := []CreationTemplate{}
	for _, t := range builtinCreationTemplates() {
		if format != "" && t.ContentFormat != format {
			continue
		}
		t.ID = templateStableID(t)
		out = append(out, t)
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, content_format, name, builtin, structure, prompt_addon, section_min, section_max, tone, to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF')
		FROM creation_template WHERE workspace_id=$1 AND deleted_at IS NULL AND ($2='' OR content_format=$2) ORDER BY created_at`, ident(r.Context()).WorkspaceID, format)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var t CreationTemplate
		var raw []byte
		var updated string
		if err := rows.Scan(&t.ID, &t.ContentFormat, &t.Name, &t.Builtin, &raw, &t.PromptAddon, &t.SectionMin, &t.SectionMax, &t.Tone, &updated); err != nil {
			return err
		}
		_ = json.Unmarshal(raw, &t.Structure)
		t.UpdatedAt = updated
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, out)
}

func validateCreationTemplate(t *CreationTemplate) error {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" || runeLen(t.Name) > 20 {
		return validation("模板名称需要 1 到 20 个字")
	}
	if len(t.Structure) < 1 || len(t.Structure) > 20 {
		return validation("模板结构需要 1 到 20 项")
	}
	if t.SectionMin < 0 || t.SectionMax < 0 || (t.SectionMax > 0 && t.SectionMin > t.SectionMax) {
		return validation("段落区间不正确")
	}
	if runeLen(t.PromptAddon) > 500 {
		return validation("提示词补充不能超过 500 字")
	}
	if runeLen(t.Tone) > 40 {
		return validation("语气说明不能超过 40 字")
	}
	return nil
}

func (s *Server) createCreationTemplate(w http.ResponseWriter, r *http.Request) error {
	var in CreationTemplate
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := validateCreationTemplate(&in); err != nil {
		return err
	}
	// 模板归属的形态必须是某个平台支持的形态；不按当前账号类型限制，模板是工作区级的。
	if !formatKnown(in.ContentFormat) {
		return validationFields("模板类型无效", map[string]string{"content_format": "请选择有效的作品形态"})
	}
	raw, _ := json.Marshal(in.Structure)
	var id uuid.UUID
	if err := s.db.QueryRow(r.Context(), `INSERT INTO creation_template (workspace_id, content_format, name, structure, prompt_addon, section_min, section_max, tone)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
		ident(r.Context()).WorkspaceID, in.ContentFormat, in.Name, raw, strings.TrimSpace(in.PromptAddon), in.SectionMin, in.SectionMax, strings.TrimSpace(in.Tone)).Scan(&id); err != nil {
		return err
	}
	s.audit(r.Context(), "creation_template_create", "creation_template", id.String(), "ok", map[string]any{"format": in.ContentFormat})
	t, err := s.findCreationTemplate(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, t)
}

func (s *Server) updateCreationTemplate(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	for _, t := range builtinCreationTemplates() {
		if templateStableID(t) == id {
			return validation("内置模板不可修改，可另存为")
		}
	}
	var in CreationTemplate
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := validateCreationTemplate(&in); err != nil {
		return err
	}
	raw, _ := json.Marshal(in.Structure)
	tag, err := s.db.Exec(r.Context(), `UPDATE creation_template SET name=$3, structure=$4, prompt_addon=$5, section_min=$6, section_max=$7, tone=$8, updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT builtin`,
		id, ident(r.Context()).WorkspaceID, in.Name, raw, strings.TrimSpace(in.PromptAddon), in.SectionMin, in.SectionMax, strings.TrimSpace(in.Tone))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "creation_template_update", "creation_template", id.String(), "ok", nil)
	t, err := s.findCreationTemplate(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, t)
}

func (s *Server) deleteCreationTemplate(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	for _, t := range builtinCreationTemplates() {
		if templateStableID(t) == id {
			return validation("内置模板不可删除")
		}
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE creation_template SET deleted_at=now() WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL AND NOT builtin`,
		id, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "creation_template_delete", "creation_template", id.String(), "ok", nil)
	return ok(w, map[string]bool{"deleted": true})
}

// formatKnown reports whether any platform supports this content format.
func formatKnown(format string) bool {
	for _, list := range formatMatrix {
		for _, f := range list {
			if f == format {
				return true
			}
		}
	}
	return false
}

// templatePrompt renders the AI injection for outline generation.
func templatePrompt(t *CreationTemplate) string {
	if t == nil {
		return ""
	}
	var b strings.Builder
	if s := t.structureText(); s != "" {
		fmt.Fprintf(&b, "\n结构模板「%s」：%s。大纲必须按这个结构展开。", t.Name, s)
	}
	if t.Tone != "" {
		fmt.Fprintf(&b, "\n语气要求：%s。", t.Tone)
	}
	if t.SectionMin > 0 && t.SectionMax > 0 {
		fmt.Fprintf(&b, "\n段落数建议 %d 到 %d 个。", t.SectionMin, t.SectionMax)
	}
	if t.PromptAddon != "" {
		fmt.Fprintf(&b, "\n补充要求：%s", t.PromptAddon)
	}
	return b.String()
}
