package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"ops/internal/ai"
)

func TestAW07DiscussAndPlanCannotProposeWriteCards(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	provider := env.ensureToolModel(t)
	for _, mode := range []string{"discuss", "plan"} {
		c := env.agentRunConversation(t, provider)
		defer deleteConversations(t, c.ID)
		text := "必须留在当前模式，不得创建记忆卡片\n" + agentLoadDomain("profile") + "\n" +
			fmt.Sprintf(`#tool memory__create {"accountId":"%s","text":"AW07模式硬过滤验证"}`, c.AccountID)
		status, body := env.do(http.MethodPost, agentRunPath(c, "messages"), map[string]any{
			"text": text, "mode": mode, "request_id": uuid.NewString(), "protocol_version": 2,
		})
		if status != http.StatusAccepted {
			t.Fatalf("模式消息未受理：%d %s", status, body)
		}
		runID := aw06WaitRun(t, body)
		var cards int
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_action WHERE run_id=$1`, runID).Scan(&cards); err != nil {
			t.Fatal(err)
		}
		if cards != 0 {
			t.Fatalf("%s 模式被模型猜工具名绕过，创建了%d张写卡片", mode, cards)
		}
	}
}

func TestAW07ModeGateCASAndSavedRunSnapshot(t *testing.T) {
	provider := env.ensureToolModel(t)
	c := env.agentRunConversation(t, provider)
	defer deleteConversations(t, c.ID)
	path := "/api/v1/agent/conversations/" + c.ID.String()
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	env.expectErr(t, http.MethodPatch, path, map[string]any{"expected_revision": c.Revision, "mode": "plan"}, "agent_feature_unavailable")
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	env.expectErr(t, http.MethodPatch, path, map[string]any{"mode": "plan"}, "validation_failed")
	env.expectErr(t, http.MethodPatch, path, map[string]any{"expected_revision": c.Revision, "mode": "arbitrary"}, "validation_failed")
	var updated agentConversation
	env.mustJSON(t, http.MethodPatch, path, map[string]any{"expected_revision": c.Revision, "mode": "plan"}, &updated)
	if updated.Mode != "plan" || updated.Revision != c.Revision+1 {
		t.Fatalf("模式未按CAS保存：%+v", updated)
	}
	env.expectErr(t, http.MethodPatch, path, map[string]any{"expected_revision": c.Revision, "mode": "execute"}, "agent_revision_conflict")
	request := map[string]any{"text": "#text 模式快照", "mode": "discuss", "request_id": uuid.NewString(), "protocol_version": 2}
	status, body := env.do(http.MethodPost, agentRunPath(c, "messages"), request)
	if status != http.StatusAccepted {
		t.Fatalf("模式消息未受理：%d %s", status, body)
	}
	runID := aw06WaitRun(t, body)
	var mode, origin string
	var raw []byte
	if err := env.srv.db.QueryRow(t.Context(), `SELECT mode,execution_origin,config_snapshot FROM agent_run WHERE id=$1`, runID).Scan(&mode, &origin, &raw); err != nil {
		t.Fatal(err)
	}
	var snapshot agentRunConfigSnapshot
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	if mode != "discuss" || origin != "interactive" || snapshot.Mode != mode || snapshot.Role != "owner" || snapshot.AccountID == nil || *snapshot.AccountID != *c.AccountID || snapshot.ActualModel == nil || snapshot.ActualModel.Channel != "server" || snapshot.ActualModel.Model != "mock-writer" {
		t.Fatalf("运行配置快照不完整：%s", raw)
	}
	request["mode"] = "execute"
	env.expectErr(t, http.MethodPost, agentRunPath(c, "messages"), request, "agent_request_conflict")
	var detail struct {
		Conversation agentConversation `json:"conversation"`
		LastRun      *agentActiveRun   `json:"last_run"`
	}
	env.mustJSON(t, http.MethodGet, path, nil, &detail)
	env.mustJSON(t, http.MethodPatch, path, map[string]any{"expected_revision": detail.Conversation.Revision, "mode": "execute"}, &updated)
	env.mustJSON(t, http.MethodGet, path, nil, &detail)
	if detail.LastRun == nil || detail.LastRun.ConfigSnapshot == nil || detail.LastRun.Mode != "discuss" || detail.LastRun.ConfigSnapshot.Mode != "discuss" || detail.Conversation.Mode != "execute" {
		t.Fatalf("修改下一轮模式不应改变已受理运行：%+v", detail)
	}
	for key, value := range map[string]any{"reasoning_effort": "high", "execution_origin": "routine", "config_snapshot": map[string]any{"mode": "execute"}} {
		code := "validation_failed"
		if key == "reasoning_effort" {
			code = "agent_model_unsupported"
		}
		env.expectErr(t, http.MethodPost, agentRunPath(c, "messages"), map[string]any{"text": "不接受伪造配置", key: value}, code)
	}
}

func TestAW07ViewerCannotForgeExecuteOrPlan(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	env.ensureToolModel(t)
	var invite inviteDTO
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &invite)
	viewer := env.registerClient(t, "aw07-viewer-"+uuid.NewString()[:8], testPassword)
	defer viewer.restore(env)
	viewer.mustJSON(t, http.MethodPost, "/api/v1/workspaces/join", map[string]any{"code": invite.Code, "switch": true}, nil)
	var me meInfo
	viewer.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	viewer.csrf = me.CSRF
	var c agentConversation
	viewer.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations", map[string]any{}, &c)
	defer deleteConversations(t, c.ID)
	if c.Mode != "discuss" {
		t.Fatalf("观察者必须展示讨论模式：%s", c.Mode)
	}
	for _, mode := range []string{"execute", "plan"} {
		viewer.expectErr(t, http.MethodPost, agentRunPath(c, "messages"), map[string]any{"text": "伪造模式", "mode": mode}, "forbidden")
		viewer.expectErr(t, http.MethodPatch, "/api/v1/agent/conversations/"+c.ID.String(), map[string]any{"expected_revision": c.Revision, "mode": mode}, "forbidden")
	}
	status, body := viewer.do(http.MethodPost, agentRunPath(c, "messages"), map[string]any{"text": "#text 观察者默认讨论", "request_id": uuid.NewString(), "protocol_version": 2})
	if status != http.StatusAccepted {
		t.Fatalf("观察者讨论未受理：%d %s", status, body)
	}
	runID := aw06WaitRun(t, body)
	var mode string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT mode FROM agent_run WHERE id=$1`, runID).Scan(&mode); err != nil || mode != "discuss" {
		t.Fatalf("观察者旧请求也必须固定讨论：mode=%s err=%v", mode, err)
	}
}

func TestAW07ModeFiltersDefinitionLookupAndDirectProposal(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	st.Mode = "plan"
	st.Domains = []string{"works", "writing", "profile"}
	tools := agentToolsFor(st, ident(ctx))
	if len(tools) == 0 {
		t.Fatal("计划模式应保留读取能力")
	}
	for _, tool := range tools {
		if entry := agentTool(tool.Function.Name); entry.Kind != toolR {
			t.Fatalf("只读模式暴露业务动作：%s", entry.Name)
		}
	}
	for _, name := range []string{"memory__create", "works__titles"} {
		if st.loadedTool(ident(ctx), name) != nil {
			t.Fatalf("猜名称绕过模式过滤：%s", name)
		}
	}
	if st.loadedTool(ident(ctx), "works__get") == nil {
		t.Fatal("只读工具应可用")
	}
	call := ai.ToolCall{ID: "direct_proposal"}
	call.Function.Name = "memory__create"
	if err := env.srv.agentPropose(ctx, st, ident(ctx), agentTool("memory__create"), call, map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
	var cards int
	if err := env.srv.db.QueryRow(ctx, `SELECT count(*) FROM agent_action WHERE run_id=$1`, st.RunID).Scan(&cards); err != nil || cards != 0 {
		t.Fatalf("直接提出入口不能绕过模式：cards=%d err=%v", cards, err)
	}
	st.ExecutionOrigin = "routine"
	if len(agentToolsFor(st, ident(ctx))) != 0 {
		t.Fatal("未实现的后台来源必须拒绝调用")
	}
	st.ExecutionOrigin, st.GoalID = "goal", nil
	if len(agentToolsFor(st, ident(ctx))) != 0 {
		t.Fatal("缺少目标ID的goal来源必须拒绝调用")
	}
	goalID := uuid.New()
	st.GoalID = &goalID
	if !agentRunToolAllowed(st, agentTool("works__get"), ident(ctx)) {
		t.Fatal("带目标ID的goal运行应复用当前角色的读取权限")
	}
	viewer := &identity{Role: "viewer"}
	st.Mode = "execute"
	if agentRunToolAllowed(st, agentTool("memory__create"), viewer) {
		t.Fatal("viewer不能靠execute扩大权限")
	}
}
