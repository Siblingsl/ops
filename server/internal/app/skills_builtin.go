package app

import (
	"fmt"

	"github.com/google/uuid"
)

// DEV-SK1 / docs/23 第 13 节：内置技能静态注册表。
// 不入 skill 表；确定性 UUID = UUIDv5(固定命名空间, 完整 key)；正文与字段即第 13.1 节
// 的注册值，实施不得自拟或临时生成。修改正文 / 条件必须递增版本并更新测试。

// skillBuiltinNamespace 是第 13.1 节固定的 UUIDv5 命名空间。
var skillBuiltinNamespace = uuid.MustParse("5ee2a4a9-9633-4a48-b64c-587acbce98d0")

type builtinSkill struct {
	Key            string
	Fields         SkillFields
	Version        int64
}

// builtinSkills 为第 13.1 节的 8 个首版内置；数组经同一规范化（去重、UTF-8 字节序升序）。
var builtinSkills = []builtinSkill{
	{
		Key: "builtin:hook_opening", Version: 1,
		Fields: SkillFields{
			Name: "开头钩子写法", Summary: "用具体问题或已提供的场景展开开头",
			Triggers: "起草第一段或生成开头钩子时",
			Instructions: "先辨明目标读者要解决的问题。开头优先使用用户提供的具体场景、明确疑问或有依据的反差，再自然引出核心观点。缺少具体经历时使用中性问题，不编造亲身体验、数据或人物。避免空泛铺垫、夸张保证和与正文无关的悬念；服从任务要求的长度和结构。",
			TaskTypes: []string{"hook_suggest", "section_draft"},
		},
	},
	{
		Key: "builtin:title_formulas", Version: 1,
		Fields: SkillFields{
			Name: "标题公式", Summary: "围绕内容价值生成清楚具体的标题",
			Triggers: "生成标题候选时",
			Instructions: "先提取正文实际覆盖的对象、问题和价值，再用清楚自然的标题表达。按任务要求给出候选数量，可分别采用问题、方法或有依据的对比角度。数字、效果和结论必须能从输入找到依据；不凭空承诺收益，不杜撰排行榜，不用标题暗示正文没有的内容。保留指定输出字段，不额外输出解释。",
			TaskTypes: []string{"title"},
		},
	},
	{
		Key: "builtin:xhs_note_voice", Version: 1,
		Fields: SkillFields{
			Name: "小红书笔记语感", Summary: "用具体、易读的笔记表达传递信息",
			Triggers: "起草或修改小红书图文笔记时",
			Instructions: "先交代读者的问题，再按信息点组织笔记。使用自然短句与清楚分段，把抽象建议写成可理解的行动或判断条件。只用输入里真实提供的体验，不假扮亲历者；没有依据时不写购买效果和身份背书。表情、标签和口语化程度服从本次要求及账号设置，不机械堆叠。",
			Platforms: []string{"xhs"}, ContentFormats: []string{"image_note"},
		},
	},
	{
		Key: "builtin:wechat_argument", Version: 1,
		Fields: SkillFields{
			Name: "公众号论证展开", Summary: "让观点、依据与解释形成清楚论证",
			Triggers: "规划或起草公众号长图文时",
			Instructions: "围绕作者已提供的观点组织论证，区分观点、证据和解释。每段先完成一个论证任务，再用自然过渡连接上下段。案例和数据只取自授权素材；缺证据时明确标出待补内容，不用虚构故事补齐。考虑观点适用条件与可能的反例，但不替作者创造核心立场，不改变选定模板结构。",
			Platforms: []string{"wechat_mp"}, ContentFormats: []string{"long_article"},
			TaskTypes: []string{"outline", "section_draft"},
		},
	},
	{
		Key: "builtin:qa_deep_dive", Version: 1,
		Fields: SkillFields{
			Name: "问答体深答", Summary: "先直接回答，再解释依据与适用条件",
			Triggers: "规划或起草问答体文章时",
			Instructions: "针对题目先给与已有观点一致的直接回答，再解释理由、依据和适用边界。复杂问题可按子问题展开，但保持选定问答模板和任务字段。具体事实必须来自输入；缺少判断依据时说明还需要什么信息。避免为了显得完整而添加未提供的经历、引语或专业结论。",
			ContentFormats: []string{"qa_article"},
			TaskTypes:      []string{"outline", "section_draft"},
		},
	},
	{
		Key: "builtin:comic_pacing", Version: 1,
		Fields: SkillFields{
			Name: "漫画分镜节奏", Summary: "让分镜中的信息与动作衔接清楚",
			Triggers: "生成漫画分镜或单格文字时",
			Instructions: "先明确每格承担的信息或情绪变化，按已有剧情安排动作、对白与转场。保持人物设定、时间和空间连续，避免一格承载过多事件。对白只表达角色在当前情境下需要说的话，减少旁白重复画面信息。不改变任务规定的格数与字段，不擅自增添与用户设定冲突的情节。",
			ContentFormats: []string{"comic"},
			TaskTypes:      []string{"comic_panel_text", "comic_storyboard"},
		},
	},
	{
		Key: "builtin:factual_honesty", Version: 1,
		Fields: SkillFields{
			Name: "事实与引用表达", Summary: "在表达中区分已知事实、推测与待核实内容",
			Triggers: "创作中涉及事实、数字、案例或引用时",
			Instructions: "将输入中的已知事实与作者判断分开表达。数字、引语、人物和机构仅使用有来源的输入，不为流畅而补造细节。推测使用清楚的条件或不确定表述；缺少必要事实时采用任务允许的待核实提示，不编造出处。此写法只补充表达方式，不能替代系统事实检查或作者确认。",
		},
	},
	{
		Key: "builtin:natural_ending", Version: 1,
		Fields: SkillFields{
			Name: "自然结尾引导", Summary: "让结尾回应正文并给出适度下一步",
			Triggers: "修改结尾或通读检查收束段时",
			Instructions: "结尾回应开头的问题或正文已经论证的观点，避免加入新的关键事实。需要行动建议时，只提出与正文相关、范围适当的一步；不强行索要关注、制造焦虑或保证效果。任务若只要求检查建议，就说明收束问题与修改方向，不输出未经要求的整篇改写。",
			TaskTypes: []string{"read_through", "section_edit"},
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
	if len(builtinSkills) > 8 {
		return fmt.Errorf("首版内置技能不得超过 8 个")
	}
	return nil
}
