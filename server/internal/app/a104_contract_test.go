package app

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestA104StructuredTargetReasonAndDelete(t *testing.T) {
	sec := &Section{ID: uuid.New(), ContentMD: "先说结论。重复解释。"}
	raw := `{"reply":"删去重复句更紧凑。","suggestions":[{"kind":"delete","target":"selection","original":"重复解释。","reason":"这句重复前面的结论"},{"kind":"append","text":"补一条实际经历。","reason":"提供论据"},{"kind":"rewrite","target":"section","text":"结论和例子。","reason":"先结论后例子"}]}`
	reply, list := parseCopilotResponse(raw, sec, "")
	if reply != "删去重复句更紧凑。" || len(list) != 3 {
		t.Fatalf("%s %+v", reply, list)
	}
	if list[0].Kind != "delete" || list[0].Original != "重复解释。" || list[0].SectionID == nil || *list[0].SectionID != sec.ID || list[0].Reason == "" {
		t.Fatalf("删除缺少锚点或理由: %+v", list[0])
	}
	if list[2].Original != sec.ContentMD {
		t.Fatal("整段修改缺少内容快照")
	}
	_, noTarget := parseCopilotResponse(raw, nil, "")
	if len(noTarget) != 0 {
		t.Fatal("无目标不得生成可应用动作")
	}
	_, invalid := parseCopilotResponse(`{"reply":"分析","suggestions":[{"kind":"delete","target":"selection","original":"其他段的文字","reason":"删除"},{"kind":"publish","text":"内容","reason":"发表"},{"kind":"rewrite","text":"内容"}]}`, sec, "")
	if len(invalid) != 0 {
		t.Fatalf("未拒绝非法或无理由的建议: %+v", invalid)
	}
	sec.ContentMD = "重复。重复。"
	_, ambiguous := parseCopilotResponse(`{"reply":"分析","suggestions":[{"kind":"delete","target":"selection","original":"重复。","reason":"删一处"}]}`, sec, "")
	if len(ambiguous) != 0 {
		t.Fatal("重复锚点不能猜测删除位置")
	}
}

func TestA104ActionsPersistWithoutApplying(t *testing.T) {
	f := env.accounts(t)
	wk := env.draftedWork(t, f.xhs, "结构化副驾驶")
	id := wk.ID.String()
	sec := wk.Sections[0]
	ev := lastEvent(t, env.sse(t, "/api/v1/works/"+id+"/copilot", map[string]any{"message": "这一段可以怎么改？", "scope": "section", "section_id": sec.ID}))
	if ev.Name != "done" {
		t.Fatalf("%s %s", ev.Name, ev.Data)
	}
	var result struct {
		Result struct {
			Suggestions []copilotSuggestionItem `json:"suggestions"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(ev.Data), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Result.Suggestions) != 3 || result.Result.Suggestions[2].Kind != "delete" {
		t.Fatalf("缺少删除动作: %s", ev.Data)
	}
	var messages []CopilotMessage
	env.mustJSON(t, "GET", "/api/v1/works/"+id+"/copilot", nil, &messages)
	last := messages[len(messages)-1]
	if len(last.Suggestions) != 3 || last.Suggestions[2].Reason == "" || *last.Suggestions[2].SectionID != sec.ID {
		t.Fatalf("建议未保存: %+v", last)
	}
	var after Work
	env.mustJSON(t, "GET", "/api/v1/works/"+id, nil, &after)
	if after.Revision != wk.Revision || after.Sections[0].ContentMD != sec.ContentMD {
		t.Fatal("副驾驶自动应用了建议")
	}
}
