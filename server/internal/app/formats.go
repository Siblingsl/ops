package app

// D-048 第 9 节：每个新增类型必须有真实工作流。文字类新类型（qa_article/briefing/
// list_note/script）复用段落工作流，由 formatBriefs 在大纲与起草提示词中注入类型专属的
// 结构约定，使产出物形态与类型说明一致；检查与输出路径沿用文字作品既有能力。
// card_post（图文卡片）的卡片与生图工作流见 card.go。
var formatBriefs = map[string]string{
	"qa_article": "问答体长图文：大纲按「核心问题 → 追问拆解 → 直接回答 → 展开论据与例子 → 小结行动」组织；小标题可以写成读者会问的问题；每段先给结论再解释。",
	"briefing":   "资讯简报：大纲按「一句话导语 → 若干条目（每条一个小标题与要点）→ 来源与核实提示」组织；总篇幅比长图文短，条目并列、信息密度高、句子精炼。",
	"list_note":  "清单/合集笔记：大纲按「钩子导语 → 编号清单项（每项一句结论加一句理由）→ 收尾行动建议」组织；条目并列、可直接照做，语言口语化。",
	"script":     "口播/短视频脚本：大纲按镜头组织，每段是一个镜头，小标题用「镜1：场景」格式；每段正文先写口播词，再用【画面】一行标注画面提示。产出物是脚本文档，不生成视频。",
	"card_post":  "图文卡片：大纲即卡片清单，每项是一张卡片；小标题是卡片标题（8 字以内），本段要点是卡片正文（两三行以内、可直接照做或收藏）；确认大纲后逐卡生成配图。",
	"micro_post": "微头条：用一个清晰观点串起 1 到 3 个短段落；先写本人观察或结论，再补事实和理由；不扩写成长文章，不编造经历。",
}

func formatBrief(format string) string { return formatBriefs[format] }

func platformFormatBrief(platform, format string) string {
	if platform == "toutiao" {
		switch format {
		case "long_article":
			return "今日头条文章：围绕一个明确主题展开，开头尽早给出核心信息，正文按段落和小标题组织论述；不要套用公众号摘要、作者栏或封面规则。"
		case "micro_post":
			return formatBrief(format)
		}
	}
	return formatBrief(format)
}
