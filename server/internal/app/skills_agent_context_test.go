package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSkillToolHistoryPreservesWholeGroupOrder(t *testing.T) {
	providerID := env.ensureToolModel(t)
	for _, trimOld := range []bool{false, true} {
		name := "complete_history"
		if trimOld {
			name = "budget_trims_old_group"
		}
		t.Run(name, func(t *testing.T) {
			conv := env.agentRunConversation(t, providerID)
			t.Cleanup(func() { deleteConversations(t, conv.ID) })
			ctx := context.Background()
			insert := func(seq int, role, content string, calls any, callID string) {
				if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message (conversation_id,seq,role,content,tool_calls,tool_call_id,tool_name) VALUES ($1,$2,$3,$4,$5,$6,'get_context')`, conv.ID, seq, role, content, calls, callID); err != nil {
					t.Fatal(err)
				}
			}
			older := "旧请求"
			if trimOld {
				older = strings.Repeat("旧", agentWindowChars+1)
			}
			insert(1, "user", older, nil, "")
			insert(2, "assistant", "", []map[string]any{{"id": "call-a", "name": "get_context", "arguments": "{}"}, {"id": "call-b", "name": "get_context", "arguments": "{}"}}, "")
			insert(3, "tool", `{"ok":true,"part":"a"}`, nil, "call-a")
			insert(4, "tool", `{"ok":true,"part":"b"}`, nil, "call-b")
			insert(5, "assistant", "收到两项结果", nil, "")
			insert(6, "user", "继续", nil, "")
			st := &agentRunState{ConversationID: conv.ID, RunID: uuid.New(), WorkspaceID: ownerWS(t), UserID: uuidOf(ownerUserID(t))}
			messages, err := env.srv.agentMessageWindow(ctx, st, &identity{UserID: st.UserID, WorkspaceID: st.WorkspaceID, Role: "owner"})
			if err != nil {
				t.Fatal(err)
			}
			start := 1
			if trimOld {
				start = 0
			}
			if len(messages) != start+5 {
				t.Fatalf("message count %d", len(messages))
			}
			if messages[start].Role != "assistant" || len(messages[start].ToolCalls) != 2 || messages[start+1].Role != "tool" || messages[start+1].ToolCallID != "call-a" || messages[start+2].Role != "tool" || messages[start+2].ToolCallID != "call-b" || messages[start+3].Content != "收到两项结果" || messages[start+4].Content != "继续" {
				wire, _ := json.Marshal(messages)
				t.Fatalf("assistant call must precede both results in original order: %s", wire)
			}
		})
	}
}

func TestSkillLoadedInstructionsKeepCanonicalPriority(t *testing.T) {
	personal := &agentSkillCatalogItem{Def: &skillDef{ID: uuid.New(), Scope: "personal", Fields: SkillFields{Name: "个人标题", Instructions: "缓步读书"}}}
	public := &agentSkillCatalogItem{Def: &skillDef{ID: uuid.New(), Scope: "workspace", Fields: SkillFields{Name: "公共标题", Instructions: "疾速翻页"}}}
	c := &agentSkillContext{Items: []agentSkillCatalogItem{*personal, *public}, Loaded: []*agentSkillCatalogItem{public, personal}}
	text, chars := agentSkillLoadedText(c)
	if strings.Index(text, "缓步读书") > strings.Index(text, "疾速翻页") {
		t.Error("加载先后顺序不应改变统一解析器的个人优先顺序")
	}
	if !strings.Contains(skillSlotDeclaration, "排在前面的技能优先") || !strings.Contains(text, skillSlotDeclaration) || chars != runeLen(text) {
		t.Error("两入口必须使用明确的共用技能优先声明并计入预算")
	}
	if !strings.HasSuffix(text, "\n以上技能指令结束。"+skillSlotDeclaration+"\n") {
		t.Error("技能正文结束后必须重申固定优先边界")
	}
}
