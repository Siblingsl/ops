package platformfmt

// FormatMatrix 是账号类型（内容形态）的唯一权威清单（D-048）。
// app/accounts 与 skills 校验共用，避免拆包后双份矩阵漂移。
var FormatMatrix = map[string][]string{
	"wechat_mp": {"long_article", "qa_article", "briefing", "card_post", "script", "comic"},
	"xhs":       {"image_note", "list_note", "card_post", "script", "comic"},
	"toutiao":   {"long_article", "micro_post"},
}

func Valid(platform, format string) bool {
	for _, f := range FormatMatrix[platform] {
		if f == format {
			return true
		}
	}
	return false
}
