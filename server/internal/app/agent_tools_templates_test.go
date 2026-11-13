package app

import "testing"

// CF-TPL-06（18 §3.7）：模板工具登记、领域归属与写入类别。
func TestAgentTemplateToolsRegistered(t *testing.T) {
	list := agentTool("templates__list")
	if list == nil || list.Kind != toolR || list.Domain != "templates" || list.Path != "/creation-templates" {
		t.Fatalf("templates__list 登记不正确：%+v", list)
	}
	if list.MinRole != roleViewer {
		t.Fatalf("templates__list 应为 viewer 可读：%+v", list.MinRole)
	}
	save := agentTool("templates__save")
	if save == nil || save.Kind != toolW || save.Domain != "templates" || save.Path != "/creation-templates" || save.Method != "POST" {
		t.Fatalf("templates__save 登记不正确：%+v", save)
	}
	if save.MinRole != roleEditor || !save.Mutating() {
		t.Fatalf("templates__save 应为 editor 写入并走写卡片：%+v", save)
	}
	param := func(tool *AgentTool, name string) *ToolParam {
		for i := range tool.Params {
			if tool.Params[i].Name == name {
				return &tool.Params[i]
			}
		}
		return nil
	}
	if param(save, "structure") == nil || param(save, "content_format") == nil || param(save, "name") == nil {
		t.Fatalf("templates__save 缺少必要参数：%+v", save.Params)
	}
	if p := param(list, "content_format"); p == nil || p.In != "query" {
		t.Fatalf("templates__list 的 content_format 应为 query 参数：%+v", p)
	}
}
