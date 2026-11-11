package skills

import (
	"fmt"

	"github.com/google/uuid"
)

// DEV-SK1 / docs/23 第 13 节：内置技能静态注册表。
// 不入 skill 表；确定性 UUID = UUIDv5(固定命名空间, 完整 key)；正文与字段即第 13.1 节
// 的注册值，实施不得自拟或临时生成。修改正文 / 条件必须递增版本并更新测试。

// skillBuiltinNamespace 是第 13.1 节固定的 UUIDv5 命名空间。
var skillBuiltinNamespace = uuid.MustParse("5ee2a4a9-9633-4a48-b64c-587acbce98d0")

type Builtin struct {
	Key     string
	Fields  SkillFields
	Version int64
}

// 包内旧名（builtin 表与校验仍用）。
type builtinSkill = Builtin

// builtinSkills 为第 13.1 节当前已登记的内置；DEV-CX11 增量不改变既有 C0/C1 任务矩阵。
var builtinSkills = []builtinSkill{
	{
		Key: "builtin:hook_opening", Version: 1,
		Fields: SkillFields{
			Name: "开头钩子写法", Summary: "用具体问题或已提供的场景展开开头",
			Triggers:     "起草第一段或生成开头钩子时",
			Instructions: "先辨明目标读者要解决的问题。开头优先使用用户提供的具体场景、明确疑问或有依据的反差，再自然引出核心观点。缺少具体经历时使用中性问题，不编造亲身体验、数据或人物。避免空泛铺垫、夸张保证和与正文无关的悬念；服从任务要求的长度和结构。",
			TaskTypes:    []string{"hook_suggest", "section_draft"},
		},
	},
	{
		Key: "builtin:topic_screening", Version: 1,
		Fields: SkillFields{
			Name: "选题体检口径", Summary: "按对象、场景、问题与已有内容检查单条选题",
			Triggers:     "建议选题时",
			Instructions: "先判断选题是否同时具备对象、场景与具体问题，缺哪项就指出缺项，不替作者补造场景。检查核心词是否出现在选题描述前部，过长或过泛时给出更具体的替代表达。与已有选题或历史作品重复时明确指出重复对象。所有判断必须引用用户提供的原句片段作为依据；没有依据时说明还需要什么信息，不臆测读者反应。输出保持任务要求的字段，不追加无关分析。",
			TaskTypes:    []string{"topic_suggest"},
		},
	},
	{
		Key: "builtin:title_diagnosis", Version: 1,
		Fields: SkillFields{
			Name: "标题诊断口径", Summary: "定位标题的具体问题并提出有依据的改法",
			Triggers:     "生成标题候选时",
			Instructions: "逐条指出标题的具体问题，并给出可定位的片段，不用「不够吸引人」这类无依据评价。区分事实性问题（超长、绝对化用语）与表达问题（空泛、歧义、承诺过度）；事实性问题直接说明规则，表达问题给出改法。改写候选必须保留原文的真实信息，不添加未提供的数字、效果或身份背书。不输出任何规避平台识别的建议，不承诺点击率或收益。",
			TaskTypes:    []string{"title"},
		},
	},
	{
		Key: "builtin:title_formulas", Version: 1,
		Fields: SkillFields{
			Name: "标题公式", Summary: "围绕内容价值生成清楚具体的标题",
			Triggers:     "生成标题候选时",
			Instructions: "先提取正文实际覆盖的对象、问题和价值，再用清楚自然的标题表达。按任务要求给出候选数量，可分别采用问题、方法或有依据的对比角度。数字、效果和结论必须能从输入找到依据；不凭空承诺收益，不杜撰排行榜，不用标题暗示正文没有的内容。保留指定输出字段，不额外输出解释。",
			TaskTypes:    []string{"title"},
		},
	},
	{
		Key: "builtin:xhs_note_voice", Version: 1,
		Fields: SkillFields{
			Name: "小红书笔记语感", Summary: "用具体、易读的笔记表达传递信息",
			Triggers:     "起草或修改小红书图文笔记时",
			Instructions: "先交代读者的问题，再按信息点组织笔记。使用自然短句与清楚分段，把抽象建议写成可理解的行动或判断条件。只用输入里真实提供的体验，不假扮亲历者；没有依据时不写购买效果和身份背书。表情、标签和口语化程度服从本次要求及账号设置，不机械堆叠。",
			Platforms:    []string{"xhs"}, ContentFormats: []string{"image_note"},
		},
	},
	{
		Key: "builtin:wechat_argument", Version: 1,
		Fields: SkillFields{
			Name: "公众号论证展开", Summary: "让观点、依据与解释形成清楚论证",
			Triggers:     "规划或起草公众号长图文时",
			Instructions: "围绕作者已提供的观点组织论证，区分观点、证据和解释。每段先完成一个论证任务，再用自然过渡连接上下段。案例和数据只取自授权素材；缺证据时明确标出待补内容，不用虚构故事补齐。考虑观点适用条件与可能的反例，但不替作者创造核心立场，不改变选定模板结构。",
			Platforms:    []string{"wechat_mp"}, ContentFormats: []string{"long_article"},
			TaskTypes: []string{"outline", "section_draft"},
		},
	},
	{
		Key: "builtin:qa_deep_dive", Version: 1,
		Fields: SkillFields{
			Name: "问答体深答", Summary: "先直接回答，再解释依据与适用条件",
			Triggers:       "规划或起草问答体文章时",
			Instructions:   "针对题目先给与已有观点一致的直接回答，再解释理由、依据和适用边界。复杂问题可按子问题展开，但保持选定问答模板和任务字段。具体事实必须来自输入；缺少判断依据时说明还需要什么信息。避免为了显得完整而添加未提供的经历、引语或专业结论。",
			ContentFormats: []string{"qa_article"},
			TaskTypes:      []string{"outline", "section_draft"},
		},
	},
	{
		Key: "builtin:comic_pacing", Version: 1,
		Fields: SkillFields{
			Name: "漫画分镜节奏", Summary: "让分镜中的信息与动作衔接清楚",
			Triggers:       "生成漫画分镜或单格文字时",
			Instructions:   "先明确每格承担的信息或情绪变化，按已有剧情安排动作、对白与转场。保持人物设定、时间和空间连续，避免一格承载过多事件。对白只表达角色在当前情境下需要说的话，减少旁白重复画面信息。不改变任务规定的格数与字段，不擅自增添与用户设定冲突的情节。",
			ContentFormats: []string{"comic"},
			TaskTypes:      []string{"comic_panel_text", "comic_storyboard"},
		},
	},
	{
		Key: "builtin:structure_borrowing", Version: 1,
		Fields: SkillFields{
			Name: "结构借鉴边界", Summary: "结构借鉴边界",
			Triggers:     "规划大纲时",
			Instructions: "只提取结构层面信息：开头方式、段落角色顺序、节奏与结尾类型。概述每段功能时使用自己的措辞，不复述原文句子、不复用其独特比喻与案例细节。明确指出哪些手法依赖作者独有资源、不可复用。产出用于规划结构，不产出可直接替换原文的段落；不确定是否可复用时，标记为不可借鉴。",
			TaskTypes:    []string{"outline"},
		},
	},
	{
		Key: "builtin:cover_copy", Version: 1,
		Fields: SkillFields{
			Name: "封面短句写法", Summary: "封面短句写法",
			Triggers:       "生成配图建议中的封面短句时",
			Instructions:   "封面文案只表达一个信息点，优先使用具体对象或明确问题，控制在读者一眼能读完的长度。不使用未在正文出现的数字与结论，不制造与内容无关的悬念。需要多个版本时，各版本应在角度上不同，而不是同义改写。保持账号既有语气；没有账号语气信息时使用中性表达。",
			Platforms:      []string{"xhs"},
			ContentFormats: []string{"card_post", "image_note"},
			TaskTypes:      []string{"image_suggest"},
		},
	},
	{
		Key: "builtin:factual_honesty", Version: 1,
		Fields: SkillFields{
			Name: "事实与引用表达", Summary: "在表达中区分已知事实、推测与待核实内容",
			Triggers:     "创作中涉及事实、数字、案例或引用时",
			Instructions: "将输入中的已知事实与作者判断分开表达。数字、引语、人物和机构仅使用有来源的输入，不为流畅而补造细节。推测使用清楚的条件或不确定表述；缺少必要事实时采用任务允许的待核实提示，不编造出处。此写法只补充表达方式，不能替代系统事实检查或作者确认。",
		},
	},
	{
		Key: "builtin:natural_ending", Version: 1,
		Fields: SkillFields{
			Name: "自然结尾引导", Summary: "让结尾回应正文并给出适度下一步",
			Triggers:     "修改结尾或通读检查收束段时",
			Instructions: "结尾回应开头的问题或正文已经论证的观点，避免加入新的关键事实。需要行动建议时，只提出与正文相关、范围适当的一步；不强行索要关注、制造焦虑或保证效果。任务若只要求检查建议，就说明收束问题与修改方向，不输出未经要求的整篇改写。",
			TaskTypes:    []string{"read_through", "section_edit"},
		},
	},
}

// skillBuiltinUUID 按第 13.1 节从完整 key 推导确定性 UUID（全实例一致）。
func skillBuiltinUUID(key string) uuid.UUID {
	return uuid.NewSHA1(skillBuiltinNamespace, []byte(key))
}

func (b builtinSkill) UUID() uuid.UUID { return skillBuiltinUUID(b.Key) }

// skillBuiltinByKey 返回注册表中 key 对应的内置定义；未知 key 返回 nil（解析器给 builtin_retired）。
func skillBuiltinByKey(key string) *skillDef {
	for _, b := range builtinSkills {
		if b.Key == key {
			f := b.Fields
			f.Platforms = normalizeEnumArray(f.Platforms)
			f.ContentFormats = normalizeEnumArray(f.ContentFormats)
			f.TaskTypes = normalizeEnumArray(f.TaskTypes)
			f.Status = "active"
			f.TaskEnabled = true
			f.AgentEnabled = true
			id := b.UUID()
			return &skillDef{
				ID: id, Builtin: true, BuiltinKey: b.Key, Scope: "builtin",
				Fields: f, Revision: b.Version, Origin: "builtin", SourceKey: b.Key,
			}
		}
	}
	return nil
}

// skillBuiltinByID 按确定性 UUID 查内置定义。
func skillBuiltinByID(id uuid.UUID) *skillDef {
	for _, b := range builtinSkills {
		if b.UUID() == id {
			return skillBuiltinByKey(b.Key)
		}
	}
	return nil
}

// checkBuiltinRegistry 启动自检（第 5.1 节第 4 项）：key / UUID 唯一、版本有效、字段与任务合法、
// 完整正文可装入单技能预算；失败拒绝启动。
func checkBuiltinRegistry() error {
	seenKey := map[string]bool{}
	seenID := map[uuid.UUID]bool{}
	for _, b := range builtinSkills {
		if seenKey[b.Key] {
			return fmt.Errorf("内置技能 key 重复：%s", b.Key)
		}
		seenKey[b.Key] = true
		id := b.UUID()
		if seenID[id] {
			return fmt.Errorf("内置技能 UUID 冲突：%s", b.Key)
		}
		seenID[id] = true
		if b.Version < 1 {
			return fmt.Errorf("内置技能版本无效：%s", b.Key)
		}
		f := b.Fields
		f.Platforms = normalizeEnumArray(f.Platforms)
		f.ContentFormats = normalizeEnumArray(f.ContentFormats)
		f.TaskTypes = normalizeEnumArray(f.TaskTypes)
		f.Status = "active"
		f.TaskEnabled = true
		f.AgentEnabled = true
		if err := validateSkillFields(&f); err != nil {
			return fmt.Errorf("内置技能字段非法（%s）：%w", b.Key, err)
		}
		if runeLen(f.Instructions) > skillInstructionLimit {
			return fmt.Errorf("内置技能正文超出单技能预算：%s", b.Key)
		}
		for _, tt := range f.TaskTypes {
			if !skillTaskAllowed(tt) {
				return fmt.Errorf("内置技能任务不在允许清单（%s）：%s", b.Key, tt)
			}
		}
	}
	if len(builtinSkills) > 12 {
		return fmt.Errorf("D-156 内置技能总数不得超过 12 个")
	}
	return nil
}

// ---------- 导出别名（app 薄封装用） ----------

// Builtins 是内置注册表只读视图（切片头只读约定；勿原地改 Fields）。
var Builtins = builtinSkills

func BuiltinByKey(key string) *Def     { return skillBuiltinByKey(key) }
func BuiltinByID(id uuid.UUID) *Def    { return skillBuiltinByID(id) }
func BuiltinUUID(key string) uuid.UUID { return skillBuiltinUUID(key) }
func CheckBuiltinRegistry() error      { return checkBuiltinRegistry() }
