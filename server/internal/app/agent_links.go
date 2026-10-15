package app

import (
	"errors"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

// 16 文档附录 B.3：make_link 页面表。智能体只拼接这里列出的站内路径。
type agentLinkPage struct {
	Key  string
	Path string // 可含 {accountId}、{workId}、{conversationId}、{q}、{id}
}

var agentLinkPageTable = []agentLinkPage{
	{"workbench", "/a/{accountId}"},
	{"topics", "/a/{accountId}/topics"},
	{"inbox", "/a/{accountId}/topics?tab=inbox"},
	{"ops", "/a/{accountId}/ops"},
	{"calendar", "/a/{accountId}/calendar"},
	{"works", "/a/{accountId}/works"},
	{"materials", "/a/{accountId}/materials"},
	{"review", "/a/{accountId}/review"},
	{"profile", "/a/{accountId}/profile"},
	{"images", "/images"},
	{"search", "/search?q={q}"},
	{"work", "/works/{workId}"},
	{"work_compare", "/works/{workId}/compare"},
	{"work_preview", "/works/{workId}/preview"},
	{"work_check", "/works/{workId}/check"},
	{"work_check_report", "/works/{workId}/check/report"},
	{"work_push", "/works/{workId}/push"},
	{"work_pack", "/works/{workId}/pack"},
	{"agent_conversation", "/agent/c/{conversationId}"},
	{"wechat_backend", "https://mp.weixin.qq.com/"},
}

// agentSettingsLinkPages 是附录 B.3 中 settings_* 的 page 取值。
var agentSettingsLinkPages = []string{
	"preferences", "accounts", "members", "models", "words", "usage", "quality",
	"logs", "trash", "prompts", "export", "security", "hot-sources", "daily", "agent",
	"admin", "crawl",
}

// agentLinkPages 返回 make_link 允许的全部页面键。
func agentLinkPages() []string {
	out := make([]string, 0, len(agentLinkPageTable)+len(agentSettingsLinkPages))
	for _, p := range agentLinkPageTable {
		out = append(out, p.Key)
	}
	for _, p := range agentSettingsLinkPages {
		out = append(out, "settings_"+p)
	}
	return out
}

var errAgentLink = errors.New("该页面不在页面表中，或缺少必要参数")

// agentBuildLink 按页面表拼接站内链接。参数必须是 UUID 或枚举值。
func agentBuildLink(page string, accountID, workID, conversationID, q, id string) (string, error) {
	if page == "" {
		return "", errAgentLink
	}
	path := ""
	if strings.HasPrefix(page, "settings_") {
		name := strings.TrimPrefix(page, "settings_")
		ok := false
		for _, p := range agentSettingsLinkPages {
			if p == name {
				ok = true
				break
			}
		}
		if !ok {
			return "", errAgentLink
		}
		path = "/settings/" + name
		if id != "" {
			path += "?id=" + url.QueryEscape(id)
		}
		return path, nil
	}
	for _, p := range agentLinkPageTable {
		if p.Key == page {
			path = p.Path
			break
		}
	}
	if path == "" {
		return "", errAgentLink
	}
	if strings.Contains(path, "{accountId}") {
		if !agentValidUUID(accountID) {
			return "", errAgentLink
		}
		path = strings.ReplaceAll(path, "{accountId}", accountID)
	}
	if strings.Contains(path, "{workId}") {
		if !agentValidUUID(workID) {
			return "", errAgentLink
		}
		path = strings.ReplaceAll(path, "{workId}", workID)
	}
	if strings.Contains(path, "{conversationId}") {
		if !agentValidUUID(conversationID) {
			return "", errAgentLink
		}
		path = strings.ReplaceAll(path, "{conversationId}", conversationID)
	}
	if strings.Contains(path, "{q}") {
		if strings.TrimSpace(q) == "" {
			return "", errAgentLink
		}
		path = strings.ReplaceAll(path, "{q}", url.QueryEscape(q))
	}
	if strings.Contains(path, "{id}") {
		path = strings.ReplaceAll(path, "{id}", url.QueryEscape(id))
	}
	return path, nil
}

func agentValidUUID(s string) bool {
	_, err := uuid.Parse(strings.TrimSpace(s))
	return err == nil
}
