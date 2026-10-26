package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

type aw03Group struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type aw03ConversationList struct {
	Items []struct {
		ID                    uuid.UUID  `json:"id"`
		Title                 string     `json:"title"`
		GroupID               *uuid.UUID `json:"group_id"`
		ArchivedAt            *string    `json:"archived_at"`
		HasUnread             bool       `json:"has_unread"`
		MatchedMessageID      *uuid.UUID `json:"matched_message_id"`
		MatchedMessageSeq     *int64     `json:"matched_message_seq"`
		MatchedMessageSnippet string     `json:"matched_message_snippet"`
	} `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

func aw03Enable(t *testing.T) {
	t.Helper()
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "conversation_organize")
	env.ensureToolModel(t)
}

func aw03InsertMessage(t *testing.T, conversationID uuid.UUID, seq int, role, content string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_message
		(id,conversation_id,seq,role,content) VALUES ($1,$2,$3,$4,$5)`, id, conversationID, seq, role, content); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAW03ConversationGroupCRUDArchiveAndFeatureGate(t *testing.T) {
	t.Setenv("OPS_AGENT_WORKBENCH_FEATURES", "")
	env.ensureToolModel(t)
	status, raw := env.do(http.MethodGet, "/api/v1/agent/conversation-groups", nil)
	var unavailable apiError
	_ = json.Unmarshal(raw, &unavailable)
	if status != http.StatusConflict || unavailable.Error.Code != "agent_feature_unavailable" {
		t.Fatalf("groups while disabled = %d %s, want feature gate", status, raw)
	}

	aw03Enable(t)
	conversation := env.createConversation(t, map[string]any{"title": "分组和归档验收"})
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	var group aw03Group
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversation-groups", map[string]any{"name": "  选题复盘  "}, &group)
	if group.ID == uuid.Nil || group.Name != "选题复盘" {
		t.Fatalf("created group = %+v, want trimmed name", group)
	}

	var patched agentConversation
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision": conversation.Revision,
		"group_id":          group.ID.String(),
	}, &patched)
	if patched.Revision != conversation.Revision+1 {
		t.Fatalf("group assignment revision = %d, want %d", patched.Revision, conversation.Revision+1)
	}

	var grouped aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?group_id="+group.ID.String(), nil, &grouped)
	if len(grouped.Items) != 1 || grouped.Items[0].ID != conversation.ID || grouped.Items[0].GroupID == nil || *grouped.Items[0].GroupID != group.ID {
		t.Fatalf("group filter = %+v, want only assigned conversation", grouped.Items)
	}

	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversation-groups/"+group.ID.String(), map[string]any{"name": "月度复盘"}, &group)
	if group.Name != "月度复盘" {
		t.Fatalf("renamed group = %+v", group)
	}

	var archived agentConversation
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision": patched.Revision,
		"archived":          true,
	}, &archived)
	var active aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations", nil, &active)
	for _, item := range active.Items {
		if item.ID == conversation.ID {
			t.Fatal("archived conversation remained in default list")
		}
	}
	var archivedList aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?archived=true", nil, &archivedList)
	if len(archivedList.Items) != 1 || archivedList.Items[0].ID != conversation.ID || archivedList.Items[0].ArchivedAt == nil {
		t.Fatalf("archived filter = %+v", archivedList.Items)
	}

	env.mustJSON(t, http.MethodDelete, "/api/v1/agent/conversation-groups/"+group.ID.String(), nil, nil)
	var ungrouped aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?archived=true&group_id=none", nil, &ungrouped)
	if len(ungrouped.Items) != 1 || ungrouped.Items[0].ID != conversation.ID || ungrouped.Items[0].GroupID != nil {
		t.Fatalf("deleting group did not preserve and ungroup conversation: %+v", ungrouped.Items)
	}
}

func TestAW03GroupLimitAndPrivateScope(t *testing.T) {
	aw03Enable(t)
	for i := 1; i <= 20; i++ {
		var group aw03Group
		env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversation-groups", map[string]any{"name": "分组" + string(rune('A'+i))}, &group)
		t.Cleanup(func() {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation_group WHERE id=$1`, group.ID)
		})
	}
	env.expectErr(t, http.MethodPost, "/api/v1/agent/conversation-groups", map[string]any{"name": "第二十一组"}, "agent_group_limit_reached")
	me := env.me(t)
	workspaceID, _ := uuid.Parse(me.Workspace.ID)
	userID, _ := uuid.Parse(me.UserID)
	if _, err := env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation_group WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}

	conversation := env.createConversation(t, map[string]any{"title": "本人私有会话"})
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	var group aw03Group
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversation-groups", map[string]any{"name": "本人私有组"}, &group)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation_group WHERE id=$1`, group.ID)
	})

	guest := env.registerClient(t, "aw03-"+uuid.NewString()[:8], testPassword)
	defer guest.restore(env)
	var groups []aw03Group
	guest.mustJSON(t, http.MethodGet, "/api/v1/agent/conversation-groups", nil, &groups)
	for _, item := range groups {
		if item.ID == group.ID {
			t.Fatal("another user saw a private conversation group")
		}
	}
	guest.expectErr(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision": conversation.Revision,
		"group_id":          group.ID.String(),
	}, "not_found")
}

func TestAW03UnreadArchiveBlockersAndMessageSearch(t *testing.T) {
	aw03Enable(t)
	conversation := env.createConversation(t, map[string]any{"title": "搜助手消息"})
	t.Cleanup(func() { deleteConversations(t, conversation.ID) })
	userMessageID := aw03InsertMessage(t, conversation.ID, 1, "user", "需要查找的运营备注")
	assistantMessageID := aw03InsertMessage(t, conversation.ID, 2, "assistant", "助手命中词：秋季复盘结论")
	aw03InsertMessage(t, conversation.ID, 3, "tool", "sensitive-secret-tool-payload")
	newerSearchMessageID := aw03InsertMessage(t, conversation.ID, 4, "user", "运营补充说明")
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_conversation SET next_seq=5 WHERE id=$1`, conversation.ID); err != nil {
		t.Fatal(err)
	}

	var unread aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?state=unread", nil, &unread)
	foundUnread := false
	for _, item := range unread.Items {
		if item.ID == conversation.ID {
			foundUnread = item.HasUnread
		}
	}
	if !foundUnread {
		t.Fatal("new assistant response was not reported unread")
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conversation.ID.String()+"/read", map[string]any{"upto_message_seq": 1}, nil)
	var stillUnread aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?state=unread", nil, &stillUnread)
	for _, item := range stillUnread.Items {
		if item.ID == conversation.ID && !item.HasUnread {
			t.Fatal("reading through an older user message cleared a newer assistant result")
		}
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conversation.ID.String()+"/read", map[string]any{"upto_message_seq": 2}, nil)
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conversation.ID.String()+"/read", map[string]any{"unread": true}, nil)
	var forcedUnread aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?state=unread", nil, &forcedUnread)
	forced := false
	for _, item := range forcedUnread.Items {
		if item.ID == conversation.ID {
			forced = item.HasUnread
		}
	}
	if !forced {
		t.Fatal("manual mark-unread was not retained")
	}

	var globalSearch aw03ConversationList
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations?q="+urlQuery("秋季复盘"), nil, &globalSearch)
	var matched bool
	for _, item := range globalSearch.Items {
		if item.ID == conversation.ID && item.MatchedMessageID != nil && *item.MatchedMessageID == assistantMessageID && item.MatchedMessageSeq != nil && *item.MatchedMessageSeq == 2 && strings.Contains(item.MatchedMessageSnippet, "秋季复盘") {
			matched = true
		}
	}
	if !matched {
		t.Fatalf("global search did not return assistant hit metadata: %+v", globalSearch.Items)
	}

	var first struct {
		Items []struct {
			MessageID uuid.UUID `json:"message_id"`
			Seq       int64     `json:"seq"`
			Snippet   string    `json:"snippet"`
		} `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}
	searchURL := "/api/v1/agent/conversations/" + conversation.ID.String() + "/search?q=" + urlQuery("运营") + "&limit=1"
	env.mustJSON(t, http.MethodGet, searchURL, nil, &first)
	if len(first.Items) != 1 || first.Items[0].MessageID != newerSearchMessageID || first.NextCursor == nil {
		t.Fatalf("message search first page = %+v", first)
	}
	var second struct {
		Items []struct {
			MessageID uuid.UUID `json:"message_id"`
			Seq       int64     `json:"seq"`
			Snippet   string    `json:"snippet"`
		} `json:"items"`
		NextCursor *string `json:"next_cursor"`
	}
	env.mustJSON(t, http.MethodGet, searchURL+"&cursor="+*first.NextCursor, nil, &second)
	if len(second.Items) != 1 || second.Items[0].MessageID != userMessageID || second.Items[0].Seq != 1 {
		t.Fatalf("message search second page = %+v", second)
	}
	var hidden struct {
		Items []any `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String()+"/search?q=sensitive-secret-tool-payload", nil, &hidden)
	if len(hidden.Items) != 0 {
		t.Fatal("message search exposed a raw tool result")
	}

	me := env.me(t)
	workspaceID, _ := uuid.Parse(me.Workspace.ID)
	userID, _ := uuid.Parse(me.UserID)
	var currentRevision int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT revision FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&currentRevision); err != nil {
		t.Fatal(err)
	}
	activeRunID := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_run
		(id,conversation_id,workspace_id,user_id,session_id,trigger,status) VALUES ($1,$2,$3,$4,$5,'message','running')`,
		activeRunID, conversation.ID, workspaceID, userID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision": currentRevision,
		"archived":          true,
	}, "agent_run_busy")
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_run SET status='failed' WHERE id=$1`, activeRunID); err != nil {
		t.Fatal(err)
	}

	cardRunID := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_run
		(id,conversation_id,workspace_id,user_id,session_id,trigger,status) VALUES ($1,$2,$3,$4,$5,'message','completed')`,
		cardRunID, conversation.ID, workspaceID, userID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_action
		(conversation_id,run_id,batch_id,workspace_id,user_id,tool_call_id,tool_name,kind,target_type,target_id,target_key,status,params,expires_at)
		VALUES ($1,$2,$3,$4,$5,'call-1','review__fix','W','work','work-1','work:work-1','pending','{}',now()+interval '1 hour')`,
		conversation.ID, cardRunID, uuid.New(), workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	status, body := env.do(http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision": currentRevision,
		"archived":          true,
	})
	var archiveFailure apiError
	_ = json.Unmarshal(body, &archiveFailure)
	if status != http.StatusConflict || archiveFailure.Error.Code != "agent_archive_confirmation_required" {
		t.Fatalf("archive with pending card = %d %s, want confirmation-required", status, body)
	}
	var archived agentConversation
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(), map[string]any{
		"expected_revision":       currentRevision,
		"archived":                true,
		"confirm_pending_actions": true,
	}, &archived)
}

func urlQuery(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, " ", "+"), "#", "%23")
}
