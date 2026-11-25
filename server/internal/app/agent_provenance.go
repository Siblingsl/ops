package app

// 内容来源约束（16 文档第 4 节）。进入特定字段的文字必须能追溯到用户本人或受控的生成接口，
// 否则模型可以把自己写的文字直接存入观点、正文或素材，绕过 H-02 与 D-014。
//
// 校验在两个时机执行（第 4.4 节）：提出卡片时，以及执行卡片时对用户未修改的字段。

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"

	"ops/internal/domain/provenance"
)

const (
	agentSrcUser       = provenance.SrcUser
	agentSrcAttachment = provenance.SrcAttachment
	agentSrcG          = provenance.SrcG
	agentSrcO          = provenance.SrcO

	agentPurposeBusiness    = provenance.PurposeBusiness
	agentPurposeSkill       = provenance.PurposeSkill
	agentMinProvenanceChars = provenance.MinProvenanceChars
)

var (
	agentSkillDefTextFields       = provenance.SkillDefTextFields
	agentSkillDefSourceTools      = provenance.SkillDefSourceTools
	agentSkillExcludedSourceTools = provenance.SkillExcludedSourceTools
)

type agentSource = provenance.Source
type agentProvenanceHit = provenance.Hit

// agentSourceSet 是本对话的来源集合（第 4.4 节第 2 项）。
// 保持包内字段与测试可见性，校验逻辑委托给纯域 provenance.SourceSet。
type agentSourceSet struct {
	sources []agentSource
}

func (set *agentSourceSet) domain() *provenance.SourceSet {
	return &provenance.SourceSet{Sources: set.sources}
}

func (set *agentSourceSet) match(kinds []string, purpose, value string) (agentProvenanceHit, bool) {
	return set.domain().Match(kinds, purpose, value)
}

func (set *agentSourceSet) matchParagraphIndexes(kinds []string, purpose, norm string) map[int]bool {
	return set.domain().MatchParagraphIndexes(kinds, purpose, norm)
}

// agentCollectSources 收集本对话的候选来源：用户消息、文本附件、G 类工具结果、O 类 R 工具结果。
// 只取当前仍存在于 agent_message 中的消息——编辑消息会按第 6.7 节第 3 项截掉尾部，
// 因此表里剩下的消息就是第 4.4 节第 2 项所说的“未删除的消息”。
func (s *Server) agentCollectSources(ctx context.Context, convID uuid.UUID) (*agentSourceSet, error) {
	set := &agentSourceSet{}
	appendText := func(kind, text string, callID uuid.UUID) {
		if strings.TrimSpace(text) == "" {
			return
		}
		set.sources = append(set.sources, agentSource{Kind: kind, Purpose: agentPurposeBusiness,
			Text: text, AICallID: callID, Norms: []string{agentNormalize(text)}})
	}

	rows, err := s.db.Query(ctx, `SELECT content FROM agent_message
		WHERE conversation_id=$1 AND role='user' ORDER BY seq`, convID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			rows.Close()
			return nil, err
		}
		appendText(agentSrcUser, t, uuid.Nil)
	}
	rows.Close()

	rows, err = s.db.Query(ctx, `SELECT a.text_content FROM agent_attachment a JOIN agent_conversation c ON c.id=$1
		WHERE a.kind IN ('text','document') AND a.parse_status='ready' AND coalesce(a.text_content,'') <> ''
		AND a.workspace_id=c.workspace_id AND a.user_id=c.user_id
		AND (a.conversation_id=c.id OR EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=a.id AND r.conversation_id=c.id))`,
		convID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			rows.Close()
			return nil, err
		}
		appendText(agentSrcAttachment, t, uuid.Nil)
	}
	rows.Close()

	rows, err = s.db.Query(ctx, `SELECT tool_name, content, ai_call_id FROM agent_message
		WHERE conversation_id=$1 AND role='tool' ORDER BY seq`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			name   string
			body   string
			callID *uuid.UUID
		)
		if err := rows.Scan(&name, &body, &callID); err != nil {
			return nil, err
		}
		// DEV-SK3 / 8.3.2 节：load_skill、skills__list、get_context 的全部结果以及技能回执
		// 不进入任何内容来源集合，不能通过嵌套字符串再次被递归收集。
		if agentSkillExcludedSourceTools[name] {
			continue
		}
		kind := agentToolSourceKind(name)
		if kind == "" {
			continue
		}
		id := uuid.Nil
		if callID != nil {
			id = *callID
		}
		var texts []string
		purpose := agentPurposeBusiness
		if agentSkillDefSourceTools[name] {
			// 技能结果仅白名单提取四个定义文字字段，不采集错误、警告、元数据或原始 JSON 全文。
			purpose = agentPurposeSkill
			texts = agentSkillDefTexts(body)
		} else {
			texts = agentResultTexts(body)
		}
		if len(texts) == 0 {
			continue
		}
		// 同一个工具结果是一个来源，其内部每个文本字段是一个候选（第 4.4 节第 2 项）。
		set.sources = append(set.sources, agentSource{Kind: kind, Purpose: purpose, Tool: name,
			Text: body, AICallID: id, Norms: agentNormalizeAll(texts)})
	}
	return set, rows.Err()
}

// agentSkillDefTexts 从技能定义结果 JSON 中白名单提取四个文字字段值。
func agentSkillDefTexts(body string) []string {
	return provenance.SkillDefTexts(body)
}

// agentToolSourceKind 按第 4.2 节判定工具结果的类别：G 类工具与带 AI 的 W 工具 → G；
// R 工具返回的系统已有数据 → O；其余（纯 W、H、X、未知工具）不进来源集合。
func agentToolSourceKind(name string) string {
	t := agentTool(name)
	if t == nil {
		return ""
	}
	return provenance.ToolSourceKind(string(t.Kind), agentToolAICost(name))
}

// agentResultTexts 递归收集工具结果 JSON 里的全部字符串值（用户裁决：通用递归收集，
// 不逐工具声明输出路径）。键名与仅含结构信息的空值不计入。
func agentResultTexts(body string) []string {
	return provenance.ResultTexts(body)
}

// agentNormalizeAll 归一化一组文本。
func agentNormalizeAll(list []string) []string {
	return provenance.NormalizeAll(list)
}

// agentNormalize 归一化（第 4.4 节第 1 项）：Unicode NFKC；去掉所有空白字符；
// 全角与半角标点统一；Markdown 强调符号（*、_、`）去掉。大小写按文档口径保留原样。
func agentNormalize(s string) string {
	return provenance.Normalize(s)
}

// ---------- 字段校验（第 4.4 节第 3、4、5 项） ----------

// agentParamIsNumber 判断参数 schema 是否为数字类型（第 4.4 节第 5 项）。
func agentParamIsNumber(p ToolParam) bool {
	var sch struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(p.Schema, &sch); err != nil {
		return false
	}
	return sch.Type == "integer" || sch.Type == "number"
}

// agentDigitsOnly 去掉千分位逗号与小数点后的尾零差异，仅保留数字串（第 4.4 节第 5 项）。
func agentDigitsOnly(s string) string {
	return provenance.DigitsOnly(s)
}

// agentSourceAllowed 判断一个来源能否供某类字段（8.3.2 节）：技能文字字段只收 U 与
// skill_definition；业务字段不接受 skill_definition。
func agentSourceAllowed(src agentSource, kinds []string, purpose string) bool {
	return provenance.SourceAllowed(src, kinds, purpose)
}

// agentFieldPurpose 判定参数的供源目的：技能写工具的四个文字字段为 skill_definition。
func agentFieldPurpose(t *AgentTool, p ToolParam) string {
	if agentSkillDefSourceTools[t.Name] || t.Name == "skills__create" || t.Name == "skills__update" {
		if agentSkillDefTextFields[p.Name] {
			return agentPurposeSkill
		}
	}
	return agentPurposeBusiness
}

// agentKindAllowed 判断来源类别是否满足字段声明的类别组合（第 4.2 节）。
func agentKindAllowed(kinds []string, got string) bool {
	return provenance.KindAllowed(kinds, got)
}

// agentKindsOf 把 Source 串拆成类别集合；空或 F 表示不做来源校验。
func agentKindsOf(source string) []string {
	return provenance.KindsOf(source)
}

// agentSourceIsU 判断字段是否只允许用户来源（第 4.5 节：仅 U 类字段失败时清空并请用户亲填；
// 含 G 或 O 的组合字段（如 U/G/O、U/O、G/O）失败时按 G、O 类处理，直接拒绝创建卡片，HC-29）。
func agentSourceIsU(source string) bool {
	return provenance.SourceIsU(source)
}

// agentNeedsProvenance 判断参数是否需要来源校验。
func agentNeedsProvenance(source string) bool {
	return provenance.NeedsProvenance(source)
}

// agentParamValueText 把一个参数值摊平成待校验的文本片段。
// 数组按元素展开，数组元素为对象时递归取其字符串字段（第 4.3 节的 sections / items / panels）。
func agentParamValueTexts(v any) []string {
	return provenance.ParamValueTexts(v)
}

// agentNumberValueText 取数字参数值的文本形式（第 4.4 节第 5 项）。
func agentNumberValueText(v any) string {
	return provenance.NumberValueText(v)
}

// agentLinkAICall 取来源 AI 调用（第 4.4 节第 6 项）：调用时段内该工作区最新一条
// 非智能体自身的 ai_call。任务类型维度以“排除 agent_chat / agent_summary”代替——
// 目录条目没有声明 task_type，而各业务接口的任务类型由调用方参数决定，无法静态映射；
// 在 docs/90 的 D-117 下登记。
func (s *Server) agentLinkAICall(ctx context.Context, workspaceID uuid.UUID, from, to time.Time) uuid.UUID {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM ai_call
		WHERE workspace_id=$1 AND created_at >= $2 AND created_at <= $3
			AND task_type NOT IN ('agent_chat','agent_summary')
		ORDER BY created_at DESC LIMIT 1`, workspaceID, from, to).Scan(&id)
	if err != nil {
		return uuid.Nil
	}
	return id
}

// ---------- 提出与执行时的字段校验（第 4.4、4.5 节） ----------

// agentCheckParamValue 校验一个参数值的来源，返回未通过来源校验的文本片段。
// 数组按元素展开；元素为对象时把该对象的全部文字作为一个整体（第 4.4 节第 4 项的
// “同一段落组”口径）判定，避免把标题与正文拆成两个来源。
func agentCheckParamValue(set *agentSourceSet, tool *AgentTool, p ToolParam, v any) (ok bool, hit agentProvenanceHit, bad []string) {
	kinds := agentKindsOf(p.Source)
	purpose := agentFieldPurpose(tool, p)
	switch t := v.(type) {
	case []any:
		for _, e := range t {
			eok, ehit, ebad := agentCheckParamValue(set, tool, p, e)
			if !eok {
				bad = append(bad, ebad...)
			}
			if ehit.Kind == agentSrcG && ehit.AICallID != uuid.Nil {
				hit = ehit
			}
		}
		return len(bad) == 0, hit, bad
	case map[string]any:
		texts := []string{}
		for _, e := range t {
			texts = append(texts, agentParamValueTexts(e)...)
		}
		one, matched := set.match(kinds, purpose, strings.Join(texts, "\n\n"))
		if !matched {
			return false, hit, []string{truncate(strings.Join(texts, " "), 60)}
		}
		return true, one, nil
	case string:
		if strings.TrimSpace(t) == "" {
			return true, hit, nil
		}
		if agentParamIsNumber(p) {
			if agentDigitsMatched(set, kinds, agentDigitsOnly(t)) {
				return true, hit, nil
			}
			return false, hit, []string{t}
		}
		one, matched := set.match(kinds, purpose, t)
		if !matched {
			return false, hit, []string{truncate(t, 60)}
		}
		return true, one, nil
	}
	// 非文字值（布尔、数字字面量）只受接口自身校验。
	return true, hit, nil
}

// agentDigitsMatched 判断数字串是否在任一来源中原样出现（第 4.4 节第 5 项）。
// 允许千分位逗号差异：来源侧同样只保留数字后做包含判断。
func agentDigitsMatched(set *agentSourceSet, kinds []string, digits string) bool {
	return provenance.DigitsMatched(set.domain(), kinds, digits)
}

// agentProvenanceBlanked 返回 U 类字段校验失败时需要清空的字段名，
// G / O 类失败则返回拒绝创建卡片的字段名（第 4.5 节）。
func (s *Server) agentProvenanceBlanked(ctx context.Context, st *agentRunState, t *AgentTool,
	args map[string]any) (blanked, failed []string, hits map[string]agentProvenanceHit, err error) {
	hits = map[string]agentProvenanceHit{}
	var set *agentSourceSet
	ensure := func() error {
		if set == nil {
			var e error
			set, e = s.agentCollectSources(ctx, st.ConversationID)
			return e
		}
		return nil
	}
	for _, p := range t.Params {
		if !agentNeedsProvenance(p.Source) {
			continue
		}
		v, ok := args[p.Name]
		if !ok || v == nil {
			// U 类必填字段模型没给值：卡片照常创建，但必须由用户亲自填写（第 4.5 节）。
			if p.Required && agentSourceIsU(p.Source) {
				blanked = append(blanked, p.Name)
			}
			continue
		}
		// U 类字段显式传空串同样视为“模型没写”，不能当成通过来源校验后直接落库。
		if agentSourceIsU(p.Source) && agentIsBlankValue(v) {
			blanked = append(blanked, p.Name)
			continue
		}
		if err := ensure(); err != nil {
			return nil, nil, nil, err
		}
		good, hit, bad := agentCheckParamValue(set, t, p, v)
		if hit.Kind != "" {
			hits[p.Name] = hit
		}
		if good || len(bad) == 0 {
			continue
		}
		if agentSourceIsU(p.Source) {
			// 第 4.5 节 U 类：照常创建卡片，字段清空并标记“请亲自填写”。
			blanked = append(blanked, p.Name)
			continue
		}
		failed = append(failed, p.Name)
	}
	return blanked, failed, hits, nil
}
