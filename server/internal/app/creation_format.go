package app

import "strings"

// resolveCreationFormat is the shared rule for all new-work entry points.
// A source shape wins; an explicit conflicting request is rejected. Existing platforms
// remain locked to their account default, while Toutiao allows a per-work choice.
func resolveCreationFormat(a *Account, requested, source string) (string, error) {
	requested = strings.TrimSpace(requested)
	source = strings.TrimSpace(source)
	if source != "" && !validFormat(a.Platform, source) {
		return "", stateInvalid("来源内容形态已不受该平台支持，请先修改来源后重试")
	}
	if requested != "" && !validFormat(a.Platform, requested) {
		return "", validationFields("请选择有效的作品形态", map[string]string{"content_format": "该平台不支持这种内容形态"})
	}
	if source != "" {
		if requested != "" && requested != source {
			return "", validationFields("作品形态与来源不一致", map[string]string{"content_format": "请先修改来源形态，再创建作品"})
		}
		if a.Platform != "toutiao" && source != a.ContentFormat {
			return "", stateInvalid("来源内容形态与账号当前类型不一致，不能创建作品")
		}
		return source, nil
	}
	if requested == "" {
		return a.ContentFormat, nil
	}
	if a.Platform != "toutiao" && requested != a.ContentFormat {
		return "", validationFields("该平台的新作品必须使用账号当前类型", map[string]string{"content_format": "请使用账号当前类型"})
	}
	return requested, nil
}
