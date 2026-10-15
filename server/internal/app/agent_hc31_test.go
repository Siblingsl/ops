package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestHC31ViewerToolDefinitionsAreReadOnly(t *testing.T) {
	domains := make([]string, 0, len(agentDomains))
	for _, domain := range agentDomains {
		domains = append(domains, domain.Name)
	}
	viewer := &identity{Role: "viewer", UserID: uuid.New(), WorkspaceID: uuid.New()}
	tools := agentToolsFor(&agentRunState{Domains: domains}, viewer)
	if len(tools) == 0 {
		t.Fatal("观察者应至少看到查询工具")
	}
	for _, definition := range tools {
		tool := agentTool(definition.Function.Name)
		if tool == nil {
			t.Fatalf("未知工具定义：%s", definition.Function.Name)
		}
		if tool.Kind != toolR || tool.Method != "" && tool.Method != "GET" {
			t.Errorf("观察者不应看到写入或 POST 工具：%s (%s %s)", tool.Name, tool.Kind, tool.Method)
		}
	}
}

func TestHC31OwnerCannotAccessMemberAgentRecords(t *testing.T) {
	owner := env.me(t)
	workspaceID := uuid.MustParse(owner.Workspace.ID)

	var invite inviteDTO
	env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": "editor", "max_uses": 1, "days": 1}, &invite)
	member := env.registerClient(t, "hc31-member-"+uuid.NewString()[:8], testPassword)
	member.mustJSON(t, "POST", "/api/v1/workspaces/join", map[string]any{"code": invite.Code, "switch": true}, nil)
	var memberMe meInfo
	member.mustJSON(t, "GET", "/api/v1/auth/me", nil, &memberMe)
	member.csrf = memberMe.CSRF
	memberID := uuid.MustParse(memberMe.UserID)
	memberWorkspaceID := uuid.MustParse(memberMe.Workspace.ID)
	if memberWorkspaceID != workspaceID {
		t.Fatalf("成员应切换到邀请工作区：%s != %s", memberWorkspaceID, workspaceID)
	}
	memberConv := member.createConversationAs(t)
	t.Cleanup(func() { deleteConversations(t, memberConv.ID) })

	ctx := context.Background()
	messageID := uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_message (id,conversation_id,seq,role,content)
		VALUES ($1,$2,1,'user','成员的私有消息')`, messageID, memberConv.ID); err != nil {
		t.Fatal(err)
	}
	var runID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO agent_run
		(conversation_id,workspace_id,user_id,session_id,trigger,status)
		VALUES ($1,$2,$3,$4,'message','completed') RETURNING id`,
		memberConv.ID, workspaceID, memberID, uuid.New()).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	actionID, targetID := uuid.New(), uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO agent_action
		(id,conversation_id,run_id,batch_id,workspace_id,user_id,tool_call_id,tool_name,kind,target_type,target_id,target_key,status,params,preview,expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,'hc31-action','topics__create','W','topic',$7,$8,'pending','{}','{}',now()+interval '1 hour')`,
		actionID, memberConv.ID, runID, uuid.New(), workspaceID, memberID, targetID.String(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	member.mustJSON(t, "GET", "/api/v1/agent/conversations/"+memberConv.ID.String(), nil, nil)
	member.restore(env)
	env.expectErr(t, "GET", "/api/v1/agent/conversations/"+memberConv.ID.String(), nil, "not_found")
	env.expectErr(t, "POST", "/api/v1/agent/conversations/"+memberConv.ID.String()+"/messages/"+messageID.String()+"/edit", map[string]any{"text": "越权"}, "not_found")
	env.expectErr(t, "POST", "/api/v1/agent/actions/"+actionID.String()+"/reject", nil, "not_found")
	env.expectErr(t, "POST", "/api/v1/agent/actions/"+actionID.String()+"/execute", map[string]any{}, "not_found")
	var status string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM agent_action WHERE id=$1`, actionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("未授权访问不能改变成员卡片状态：%s", status)
	}
}

func (g *guestClient) createConversationAs(t *testing.T) agentConversation {
	t.Helper()
	var conv agentConversation
	g.mustJSON(t, "POST", "/api/v1/agent/conversations", map[string]any{}, &conv)
	return conv
}
