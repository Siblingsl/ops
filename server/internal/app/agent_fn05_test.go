package app

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// FN-05（38 文档）：目标证据与迭代——goal-runs 只读投影。
// 归属校验（本人/本工作区）、无 run 空列表、目标 run（trigger=goal）出现在列表中。
func TestFN05GoalRunsProjection(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)

	// 无目标：空列表（不是错误）。
	var empty struct {
		Runs []map[string]any `json:"runs"`
	}
	env.mustJSON(t, http.MethodGet, agentRunPath(conversation, "goal-runs"), nil, &empty)
	if len(empty.Runs) != 0 {
		t.Fatalf("无目标应返回空列表：%+v", empty.Runs)
	}

	// 创建目标后发一条消息：agentStartRunTx 对非 compact/routine 触发都会绑定 active goal
	// （goal_id 落库），所以消息触发的 run 也进入迭代视图。
	request := map[string]any{
		"request_id": uuid.NewString(), "objective": "核对本周运营数据并形成建议",
		"criteria":         []map[string]any{{"text": "列出需要关注的内容", "requires_confirmation": false}},
		"account_id":       conversation.AccountID.String(),
		"model":            map[string]any{"provider_id": providerID, "model": "mock-writer"},
		"allow_background": false, "run_budget": 10, "seconds_budget": 1800,
	}
	var created struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, agentRunPath(conversation, "goal"), request, &created)
	if created.Goal.ID == uuid.Nil {
		t.Fatal("目标应创建成功")
	}
	var posted map[string]any
	env.mustJSONStatus(t, http.MethodPost, agentRunPath(conversation, "messages"),
		map[string]any{"text": "核对本周数据", "request_id": uuid.NewString(), "protocol_version": 2}, &posted, http.StatusAccepted)

	env.mustJSON(t, http.MethodGet, agentRunPath(conversation, "goal-runs"), nil, &empty)
	if len(empty.Runs) != 1 {
		t.Fatalf("绑定 goal 的 run 应出现在投影中：%+v", empty.Runs)
	}
	if empty.Runs[0]["status"] == "" || empty.Runs[0]["started_at"] == "" {
		t.Fatalf("投影缺时间/状态：%+v", empty.Runs[0])
	}
	for _, key := range []string{"prompt", "tool_params", "path"} {
		if _, ok := empty.Runs[0][key]; ok {
			t.Fatalf("投影泄露 %s：%+v", key, empty.Runs[0])
		}
	}

	// 跨工作区成员看不到该投影内容（对话归属隔离 → 404）。
	stranger := env.registerClient(t, "fn05-stranger-"+uuid.NewString()[:8], testPassword)
	var sme meInfo
	stranger.mustJSON(t, "GET", "/api/v1/auth/me", nil, &sme)
	stranger.csrf = sme.CSRF
	if st, _ := stranger.do("GET", agentRunPath(conversation, "goal-runs"), nil); st != 404 {
		t.Fatalf("跨工作区读取应 404，得到 %d", st)
	}
	stranger.restore(env)
}
