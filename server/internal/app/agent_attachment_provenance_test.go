package app

import (
	"encoding/json"
	"testing"
)

// 判据（第 4.4 节第 4 项、E2E-28）：文本附件与用户消息包含同一段文字时，
// 段落匹配按「存在单一来源覆盖全部段落」判定，不能因命中顺序误判为跨来源拼接。
// 场景还原：模拟模型的指令把参数值（md 全文）嵌在用户消息里，
// 段 1（标题行）同时命中用户消息与附件，段 2 只命中附件——应取交集（附件）并通过。
func TestAG07TextAttachmentParagraphProvenance(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "附件段落来源")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 两个附件均不带 conversation_id（模拟界面先上传、后发送）。
	code, img, body := agentUploadAttachment(t, "shot.png", testPNG(900, 500), "")
	if code != 200 {
		t.Fatalf("图片上传失败：%d %s", code, body)
	}
	markdown := "# 实践记录\n\n每次先完成一个小步骤，再记录自己的体会。\n这是上传文件中的原始内容。"
	code2, txt, body2 := agentUploadAttachment(t, "notes.md", []byte(markdown), "")
	if code2 != 200 {
		t.Fatalf("文本上传失败：%d %s", code2, body2)
	}

	text := "把我上传的图片保存到指定作品，把md全文保存为一条经验素材。都先给卡片，等我逐张执行。\n" +
		agentLoadDomain("visual") + "\n" +
		"#tool assets__upload {\"id\":\"" + wk.ID.String() + "\",\"attachment_id\":\"" + img.ID.String() + "\"}\n" +
		agentLoadDomain("materials") + "\n" +
		"#tool materials__create {\"account_id\":\"" + acc.wechat.ID.String() + "\",\"kind\":\"experience\",\"content\":" + agentJSONString(markdown) + "}"

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": text,
		"attachment_ids": []string{img.ID.String(), txt.ID.String()}})

	tools := map[string]int{}
	for _, ev := range evs {
		if ev.Name != "action" {
			continue
		}
		var payload struct {
			ToolName string `json:"tool_name"`
			Status   string `json:"status"`
		}
		if err := json.Unmarshal(ev.Data, &payload); err != nil {
			t.Fatal(err)
		}
		tools[payload.ToolName]++
		if payload.Status != "pending" {
			t.Fatalf("卡片应为 pending：%+v", payload)
		}
	}
	if tools["assets__upload"] != 1 || tools["materials__create"] != 1 {
		t.Fatalf("应提出两张卡片（图片 + 素材）：%v", tools)
	}
}

// agentJSONString 把字符串编码为 JSON 字面量（含引号），模拟模型指令中的参数写法。
func agentJSONString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
