package app

// AG06 卡片守卫回归（§13.2 第 5 项）：同一作品最多一张未结束的正文类卡片（第 5.5 节，跨对话）。

import (
	"context"
	"strings"
	"testing"
)

// TestAG06BodyClassOnePendingCardPerWork：同一作品最多一张未结束的正文类卡片（第 5.5 节）。
func TestAG06BodyClassOnePendingCardPerWork(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "正文类唯一观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 第一张正文类卡片：大纲确认（H-03，BodyClass）。
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool outline__confirm {\"id\":\"" + wk.ID.String() + "\"}"})
	first := findActionEvent(t, evs)
	if first == nil {
		t.Fatal("应提出大纲确认卡片")
	}

	// 同一作品再提另一张正文类卡片（删除段落）→ 被「同一作品最多一张」拦下，不创建。
	sec := wk.Sections[0]
	evs2 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool sections__delete {\"id\":\"" + sec.ID.String() + "\"}"})
	if second := findActionEvent(t, evs2); second != nil {
		t.Fatalf("正文类唯一规则应拦下第二张卡片：%+v", second)
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT content FROM agent_message WHERE conversation_id=$1 AND role='tool' ORDER BY seq DESC LIMIT 1`, c.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored, "already_pending") || !strings.Contains(stored, first.ID.String()) {
		t.Fatalf("工具结果应给出已有卡片的 action_id：%s", stored)
	}

	// 处理掉第一张后，段落删除卡片可以提出。
	if st, body := env.do("POST", agentActionPath(first.ID, "reject"), map[string]any{}); st != 200 {
		t.Fatalf("拒绝应成功：%d %s", st, body)
	}
	evs3 := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("writing") + "\n#tool sections__delete {\"id\":\"" + sec.ID.String() + "\"}"})
	third := findActionEvent(t, evs3)
	if third == nil {
		t.Fatal("首张卡片处理后应能提出新的正文类卡片")
	}
	if third.ToolName != "sections__delete" {
		t.Fatalf("新卡片应为段落删除：%s", third.ToolName)
	}
}
