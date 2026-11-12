package app

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DEV-CU P4-4（docs/36 §P4-4）：创建命令的幂等 / 冲突 / 确认闸门 / 预算 / generation CAS。
// 全部走真实 HTTP（agentGate 内 /tools/computer/commands），租约复用 W17 的
// 建租约 + 设备确认 helper。写类确认闸门按 fail-closed 口径（卡片机制未接线）。

func cu44Setup(t *testing.T) (conv agentConversation, grant computerGrantView) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv = w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	// C04 单租约互斥：组合跑时可能有前序用例残留的 active 租约，先清掉。
	for _, g := range w17ListGrants(t, conv) {
		var ack map[string]any
		env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+g.ID, map[string]any{}, &ack, http.StatusAccepted)
	}
	grant = w17CreateGrant(t, conv, "cu44:hwnd1", "记事本 - 无标题", "observe")
	return conv, grant
}

func cu44Create(t *testing.T, body map[string]any, wantStatus int) map[string]any {
	t.Helper()
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", body, &out, wantStatus)
	return out
}

func cu44Body(grant computerGrantView, conv agentConversation, action string, payload map[string]any) map[string]any {
	return map[string]any{
		"grant_id": grant.ID, "run_id": uuid.NewString(), "request_id": uuid.NewString(),
		"expected_generation": grant.Generation, "action": action, "payload": payload,
	}
}

// ① 幂等：同 (grant, request_id) 同载荷 → 返回原命令（同 id）；异载荷 → 409。
func TestComputerCommandIdempotent(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	requestID := uuid.NewString()
	body := map[string]any{
		"grant_id": grant.ID, "request_id": requestID, "expected_generation": grant.Generation,
		"action": "observe", "payload": map[string]any{"ref": "@sabc123:e1"},
	}
	first := cu44Create(t, body, http.StatusOK)
	firstID, _ := first["id"].(string)
	if firstID == "" || first["state"] != "queued" {
		t.Fatalf("首建应 queued：%v", first)
	}
	second := cu44Create(t, body, http.StatusOK)
	if second["id"] != firstID {
		t.Fatalf("同请求同载荷应返回原命令：%v vs %v", second["id"], firstID)
	}
	// 异载荷同编号 → 409 computer_approval_conflict
	conflict := map[string]any{
		"grant_id": grant.ID, "request_id": requestID, "expected_generation": grant.Generation,
		"action": "observe", "payload": map[string]any{"ref": "@sabc123:e2"},
	}
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", conflict, &out, http.StatusConflict)
}

// ② request_id 冲突：同 grant 同 request 异 input_hash → 409（已并入①，这里锁错误码语义）。
func TestComputerCommandRequestConflict(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	requestID := uuid.NewString()
	base := map[string]any{
		"grant_id": grant.ID, "request_id": requestID, "expected_generation": grant.Generation,
	}
	a := cloneJSONBody(base)
	a["action"], a["payload"] = "type", map[string]any{"ref": "@sabc123:e1", "text": "x"}
	b := cloneJSONBody(base)
	b["action"], b["payload"] = "type", map[string]any{"ref": "@sabc123:e1", "text": "y"}
	// 两条写类都先撞确认闸门（409），不落到幂等层——写类的 409 先于账本。
	outA := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", a, &outA, http.StatusConflict)
	outB := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", b, &outB, http.StatusConflict)
}

// ③ 确认闸门：写类缺 card_id/approval_hash → 409；带假 hash（fail-closed）→ 409。
func TestComputerCommandRequiresCard(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	// 缺卡
	noCard := cu44Body(grant, conv, "invoke", map[string]any{"ref": "@sabc123:e1"})
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", noCard, &out, http.StatusConflict)
	// 带假卡（fail-closed：卡片机制未接线，一律未确认）
	fake := cu44Body(grant, conv, "type", map[string]any{"ref": "@sabc123:e1", "text": "hi"})
	fake["card_id"] = uuid.NewString()
	fake["approval_hash"] = "deadbeef"
	out2 := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", fake, &out2, http.StatusConflict)
	// 读类不需要卡：observe 正常 queued
	read := cu44Body(grant, conv, "observe", map[string]any{"ref": "@sabc123:e1"})
	out3 := cu44Create(t, read, http.StatusOK)
	if out3["state"] != "queued" {
		t.Fatalf("读类不需要确认卡，应 queued：%v", out3)
	}
}

// ④ 预算：60/10min 窗口——同一 run 连发 60 条读类命令后，第 61 条 429。
func TestComputerCommandBudget(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	runID := uuid.NewString()
	for i := 0; i < 60; i++ {
		body := cu44Body(grant, conv, "observe", map[string]any{})
		body["run_id"] = runID
		cu44Create(t, body, http.StatusOK)
	}
	out := map[string]any{}
	over := cu44Body(grant, conv, "observe", map[string]any{})
	over["run_id"] = runID
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", over, &out, http.StatusTooManyRequests)
}

// ⑤ generation CAS：expected_generation 不匹配 → 409。
func TestComputerCommandGenerationCAS(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	body["expected_generation"] = grant.Generation + 1
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/tools/computer/commands", body, &out, http.StatusConflict)
}

// cloneJSONBody 浅拷贝 map（测试内派生请求体用）。
func cloneJSONBody(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}
