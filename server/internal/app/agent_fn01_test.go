package app

import (
	"fmt"
	"testing"

	"github.com/google/uuid"
)

// FN-01（docs/38 §12）：列表投影补齐 pending_questions/account_name，
// “进行中 / 待我处理”筛选都必须同时覆盖待回答问题和待确认卡片。
func TestFN01ConversationProjectionAndTaskFilters(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	answered := env.agentRunConversation(t, pid)
	actioned := env.agentRunConversation(t, pid)
	defer deleteConversations(t, answered.ID, actioned.ID)
	env.mustJSON(t, "PATCH", "/api/v1/agent/conversations/"+answered.ID.String(), map[string]any{"title": "FN01 待回答"}, nil)
	env.mustJSON(t, "PATCH", "/api/v1/agent/conversations/"+actioned.ID.String(), map[string]any{"title": "FN01 待处理"}, nil)

	questions := map[string]any{"questions": []map[string]any{{
		"id": "scope", "title": "这次先做哪一部分？", "required": true,
		"options": []map[string]string{{"id": "a", "label": "标题"}, {"id": "b", "label": "正文"}},
	}}}
	env.sse(t, agentRunPath(answered, "messages"), map[string]any{
		"text": "先澄清范围\n#tool request_input " + fmt.Sprintf("%s", mustJSON(questions)),
	})
	env.sse(t, agentRunPath(actioned, "messages"), map[string]any{
		"text": agentLoadDomain("materials") + "\n#tool materials__create " +
			fmt.Sprintf(`{"account_id":%q,"kind":"opinion","content":"FN-01 待处理素材"}`, acc.wechat.ID.String()),
	})

	var list ag03ConversationList
	env.mustJSON(t, "GET", "/api/v1/agent/conversations?state=needs_action", nil, &list)
	rows := map[uuid.UUID]agentConversationListItem{}
	for _, item := range list.Items {
		rows[item.ID] = item
	}
	q := rows[answered.ID]
	if q.PendingQuestions != 1 || q.PendingActions != 0 || q.AccountName != "测试公众号" {
		t.Fatalf("待回答投影错误：%+v", q)
	}
	card := rows[actioned.ID]
	if card.PendingActions != 1 || card.PendingQuestions != 0 || card.AccountName != "测试公众号" {
		t.Fatalf("待处理卡片投影错误：%+v", card)
	}

	env.mustJSON(t, "GET", "/api/v1/agent/conversations?state=active", nil, &list)
	active := map[uuid.UUID]bool{}
	for _, item := range list.Items {
		active[item.ID] = true
	}
	if !active[answered.ID] || !active[actioned.ID] {
		t.Fatalf("进行中筛选应同时包含待回答与待处理卡片：%+v", list.Items)
	}

	// 过期问题不再计入投影，也不再进入“进行中 / 待我处理”。
	if _, err := env.srv.db.Exec(t.Context(),
		`UPDATE agent_question SET expires_at=now()-interval '1 second' WHERE conversation_id=$1 AND status='pending'`,
		answered.ID); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations?state=needs_action", nil, &list)
	if containsConversation(list.Items, answered.ID) {
		t.Fatalf("过期问题不应进入待我处理：%+v", list.Items)
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations", nil, &list)
	for _, item := range list.Items {
		if item.ID == answered.ID && item.PendingQuestions != 0 {
			t.Fatalf("过期问题不应计入 pending_questions：%+v", item)
		}
	}
}

func containsConversation(items []agentConversationListItem, id uuid.UUID) bool {
	for _, item := range items {
		if item.ID == id {
			return true
		}
	}
	return false
}
