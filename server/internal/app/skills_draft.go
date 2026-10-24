package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"ops/internal/ai"
)

// DEV-SK3 / docs/23 第 4.3、11.4 节：AI 辅助起草（skill_draft）。
// G 类受控生成：完整缓冲模型输出，完成 JSON、字段、长度、密钥校验后才返回单个草稿；
// 只发 stage / done / error，禁止正文 delta；不使用技能注入、不写共享 lastPacks、
// 不经共享 ai_job 保存结果；结构失败允许一次纠错，密钥命中直接失败。

// skillDraftContract 是固定任务说明（4.3 节）；工作区可编辑任务提示词不能改变
// 上述固定输出和安全契约。
const skillDraftContract = "只输出一个 DraftFields JSON 对象，不要输出其他文字。基于用户需求起草可复用的写作方法；不生成真实密钥、虚构事实、脚本或授权能力；instructions 正文最多1200字；platforms、content_formats、task_types、task_enabled、agent_enabled 必须与上面给定的完全一致，不得更改用户显式指定的条件和入口开关。"

// skillDraftFields 是 done 事件中的 DraftFields（11.1 节）。
type skillDraftFields struct {
	Name           string   `json:"name"`
	Summary        string   `json:"summary"`
	Triggers       string   `json:"triggers"`
	Instructions   string   `json:"instructions"`
	Platforms      []string `json:"platforms"`
	ContentFormats []string `json:"content_formats"`
	TaskTypes      []string `json:"task_types"`
	TaskEnabled    bool     `json:"task_enabled"`
	AgentEnabled   bool     `json:"agent_enabled"`
}

func (s *Server) draftSkill(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	idv := ident(r.Context())
	var in struct {
		Brief          string   `json:"brief"`
		SourceSkillID  string   `json:"source_skill_id"`
		SourceRevision *int64   `json:"source_revision"`
		Platforms      []string `json:"platforms"`
		ContentFormats []string `json:"content_formats"`
		TaskTypes      []string `json:"task_types"`
		TaskEnabled    *bool    `json:"task_enabled"`
		AgentEnabled   *bool    `json:"agent_enabled"`
	}
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	brief := strings.TrimSpace(in.Brief)
	if runeLen(brief) < 1 || runeLen(brief) > 2000 {
		return validationFields("brief 需要 1–2000 字", map[string]string{"brief": "invalid"})
	}
	secrets := s.agentSecretValues(ctx, idv.WorkspaceID)
	if agentContainsSecret(brief, secrets) {
		return apiErr(422, "skill_secret_detected", "需求内容疑似包含密钥，已拒绝处理（不会保存或回显原文）").With(map[string]string{"field": "brief"})
	}

	// 底稿：提供时须同时传 source_revision，服务端校验可读与修订相符（4.3 节）。
	var src *skillDefRow
	if in.SourceSkillID != "" {
		sid, err := uuid.Parse(in.SourceSkillID)
		if err != nil {
			return errNotFound
		}
		sr, err := s.skillVisibleDef(ctx, sid)
		if err != nil {
			return err
		}
		if in.SourceRevision == nil || *in.SourceRevision != sr.Def.Revision {
			return apiErr(409, "stale", "底稿修订已变化，请重新读取技能")
		}
		src = sr
	}

	// 最终条件 / 开关由服务端按请求及底稿确定（4.3 节）；模型只草拟四个文字字段。
	conds := skillDraftConditions{
		Platforms: in.Platforms, ContentFormats: in.ContentFormats, TaskTypes: in.TaskTypes,
		TaskEnabled: boolDefault(in.TaskEnabled, true), AgentEnabled: boolDefault(in.AgentEnabled, true),
	}
	if src != nil {
		conds = skillDraftConditions{
			Platforms:      firstNonNil(in.Platforms, src.Def.Fields.Platforms),
			ContentFormats: firstNonNil(in.ContentFormats, src.Def.Fields.ContentFormats),
			TaskTypes:      firstNonNil(in.TaskTypes, src.Def.Fields.TaskTypes),
			TaskEnabled:    boolDefault(in.TaskEnabled, src.Def.Fields.TaskEnabled),
			AgentEnabled:   boolDefault(in.AgentEnabled, src.Def.Fields.AgentEnabled),
		}
	}
	if err := validateSkillConditions(conds.Platforms, conds.ContentFormats, conds.TaskTypes,
		conds.TaskEnabled, conds.AgentEnabled); err != nil {
		return err
	}

	prompt := skillDraftPrompt(brief, src, conds)
	task := aiTask{Type: "skill_draft", User: prompt, JSON: true, Bare: true,
		ExtraRules: skillDraftContract}

	sse := newSSE(w)
	ctx = withSkillSnapshotHolder(ctx)
	release, err := s.waitAIWorker(ctx, func() {
		sse.send("stage", map[string]string{"stage": "queued"})
	})
	if err != nil {
		sse.send("error", asAPIError(ctx, err))
		return nil
	}
	defer release()
	sse.send("stage", map[string]string{"stage": "generating"})

	draft, res, derr := s.skillDraftGenerate(ctx, task, conds, secrets)
	if derr != nil {
		sse.send("error", asAPIError(ctx, derr))
		return nil
	}
	sse.send("stage", map[string]string{"stage": "validating"})
	// 读取底稿后到 done 前再核验底稿权限 / revision，变化返回 skill_context_changed（4.3 节）。
	if src != nil {
		sr2, err := s.skillVisibleDef(ctx, src.Def.ID)
		if err != nil || sr2.Def.Revision != src.Def.Revision {
			sse.send("error", asAPIError(ctx, skillContextChanged()))
			return nil
		}
	}
	sse.send("done", map[string]any{
		"draft": draft, "ai_call_id": res.CallID, "usage": res.Usage, "fallback_used": res.FallbackUsed,
	})
	return nil
}

type skillDraftConditions struct {
	Platforms      []string
	ContentFormats []string
	TaskTypes      []string
	TaskEnabled    bool
	AgentEnabled   bool
}

func firstNonNil(a, b []string) []string {
	if a != nil {
		return a
	}
	return b
}

// validateSkillConditions 校验草拟的适用条件与入口组合（枚举、两开关、平台组合）。
func validateSkillConditions(platforms, formats, tasks []string, taskOn, agentOn bool) error {
	if !taskOn && !agentOn {
		return validationFields("生成与智能体入口不能同时关闭", map[string]string{"task_enabled": "invalid", "agent_enabled": "invalid"})
	}
	f := SkillFields{Platforms: platforms, ContentFormats: formats, TaskTypes: tasks,
		TaskEnabled: taskOn, AgentEnabled: agentOn, Status: "active",
		Name: "占位", Summary: "占位", Triggers: "占位", Instructions: "占位"}
	return validateSkillFields(&f)
}

// skillDraftPrompt 构造草拟输入：已校验的 brief、底稿与合法枚举 / 条件（4.3 节）。
func skillDraftPrompt(brief string, src *skillDefRow, c skillDraftConditions) string {
	var b strings.Builder
	b.WriteString("为用户的以下需求起草一个可复用的写作技能底稿。\n\n用户需求：\n" + brief + "\n")
	if src != nil {
		b.WriteString("\n已提供的底稿（在此基础上改写）：\n名称：" + src.Def.Fields.Name +
			"\n用途：" + src.Def.Fields.Summary + "\n触发说明：" + src.Def.Fields.Triggers +
			"\n正文：\n" + src.Def.Fields.Instructions + "\n")
	}
	b.WriteString("\n本次确定的适用条件与入口（不得更改）：\n")
	b.WriteString("platforms=" + skillDraftArr(c.Platforms) + "\n")
	b.WriteString("content_formats=" + skillDraftArr(c.ContentFormats) + "\n")
	b.WriteString("task_types=" + skillDraftArr(c.TaskTypes) + "\n")
	b.WriteString("task_enabled=" + boolText(c.TaskEnabled) + "\n")
	b.WriteString("agent_enabled=" + boolText(c.AgentEnabled) + "\n\n")
	b.WriteString(skillDraftContract)
	return b.String()
}

func skillDraftArr(a []string) string {
	if len(a) == 0 {
		return "[]"
	}
	return "[" + strings.Join(a, ",") + "]"
}

func boolText(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// skillDraftGenerate 完整缓冲模型输出并做 JSON / 字段 / 长度 / 密钥校验；
// 结构失败允许一次纠错（复用同一技能上下文；skill_draft 本身不注入技能），
// 密钥命中直接失败、不把含密钥错误原文送进纠错请求。
func (s *Server) skillDraftGenerate(ctx context.Context, task aiTask, conds skillDraftConditions,
	secrets []string) (*skillDraftFields, *aiResult, error) {
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		res, err := s.runAI(ctx, task, nil)
		if err != nil {
			return nil, nil, err
		}
		// 整个生成原文在进入下一环节前检查密钥；命中直接失败。
		if agentContainsSecret(res.Text, secrets) {
			return nil, res, apiErr(422, "skill_secret_detected", "生成结果疑似包含密钥，已拒绝（不会保存或回显原文）")
		}
		var out skillDraftFields
		raw := skillDraftJSONText(res.Text)
		parseErr := json.Unmarshal([]byte(raw), &out)
		if parseErr == nil {
			parseErr = s.skillDraftValidate(&out, conds)
		}
		if parseErr == nil {
			return &out, res, nil
		}
		last = parseErr
		task.User += "\n\n上一次输出不符合要求：" + parseErr.Error() + "。只输出修正后的 JSON，条件与开关保持给定值。"
	}
	return nil, nil, apiErr(502, "ai_output_invalid", "草稿格式不正确（已纠错一次），请调整需求后重试").With(truncate(errText(last), 200))
}

// skillDraftValidate 校验四个文字字段与条件 / 开关一致（11.1 节 DraftFields）。
func (s *Server) skillDraftValidate(out *skillDraftFields, conds skillDraftConditions) error {
	f := SkillFields{
		Name: out.Name, Summary: out.Summary, Triggers: out.Triggers, Instructions: out.Instructions,
		Platforms: conds.Platforms, ContentFormats: conds.ContentFormats, TaskTypes: conds.TaskTypes,
		TaskEnabled: conds.TaskEnabled, AgentEnabled: conds.AgentEnabled, Status: "active",
	}
	if err := validateSkillFields(&f); err != nil {
		return errors.New("字段长度或内容不符合限制")
	}
	// 输出中条件 / 开关与服务端确定值不一致视为格式错误（4.3 节）。
	if !equalStringArr(normalizeEnumArray(out.Platforms), normalizeEnumArray(conds.Platforms)) ||
		!equalStringArr(normalizeEnumArray(out.ContentFormats), normalizeEnumArray(conds.ContentFormats)) ||
		!equalStringArr(normalizeEnumArray(out.TaskTypes), normalizeEnumArray(conds.TaskTypes)) ||
		out.TaskEnabled != conds.TaskEnabled || out.AgentEnabled != conds.AgentEnabled {
		return errors.New("适用条件或入口开关与给定值不一致")
	}
	// 模型输出的正文同样过密钥检测（按值与模式）。
	if agentSecretLikePattern(out.Name + out.Summary + out.Triggers + out.Instructions) {
		return errSkillDraftSecret
	}
	return nil
}

var errSkillDraftSecret = errors.New("生成结果包含疑似密钥")

func equalStringArr(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// aiExtractJSONText 提取模型输出中的 JSON（复用 runAIJSON 的补全口径）。
func skillDraftJSONText(text string) string {
	raw := ai.ExtractJSON(text)
	if json.Valid([]byte(raw)) {
		return raw
	}
	if completed := completeJSONBrackets(text); json.Valid([]byte(completed)) {
		return completed
	}
	return raw
}
