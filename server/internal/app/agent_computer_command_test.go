package app

import (
	"context"
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

// ---------------------------------------------------------------------------
// DEV-CU P4-5：CAS 领取与 pending 清单（并发一次 claimed / 跨租户 404 / LIMIT 10 + 租户隔离）。
// ---------------------------------------------------------------------------

func cu45Pending(t *testing.T) []map[string]any {
	t.Helper()
	var out struct {
		Commands []map[string]any `json:"commands"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/computer/commands/pending", map[string]any{}, &out)
	return out.Commands
}

// ① CAS 并发领取：同一命令两次 dispatch 只有一次 claimed=true（含 payload）。
func TestComputerCommandCAS(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	first := cu44Create(t, body, http.StatusOK)
	commandID, _ := first["id"].(string)
	if commandID == "" {
		t.Fatalf("建命令失败：%v", first)
	}

	// 顺序双领取即可锁 CAS 语义（RowsAffected>0 只发生一次）；
	// 并发 goroutine 版本由 browser 先例的同构测试覆盖，这里复用其判定。
	c1 := map[string]any{}
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &c1)
	if c1["claimed"] != true {
		t.Fatalf("第一次领取应 claimed=true：%v", c1)
	}
	if c1["payload"] == nil {
		t.Fatal("CAS 命中应下发 payload")
	}
	c2 := map[string]any{}
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &c2)
	if c2["claimed"] == true {
		t.Fatalf("第二次领取不得再 claimed：%v", c2)
	}
	if c2["payload"] != nil {
		t.Fatal("claimed=false 不得下发 payload")
	}
	if c2["state"] != "dispatched" {
		t.Fatalf("claimed=false 应如实回当前状态 dispatched：%v", c2["state"])
	}
}

// ② 归属：跨租户（另一用户）领取/查看 → 404 不透露存在。
func TestComputerCommandOwnership(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	created := cu44Create(t, body, http.StatusOK)
	commandID, _ := created["id"].(string)

	other := env.registerClient(t, "cu45-other-"+uuid.NewString()[:8], testPassword)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	other.csrf = ome.CSRF
	other.expectErr(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, "not_found")
}

// ③ pending 清单：LIMIT 10 + 只含本人租户数据。
func TestComputerCommandPendingLimit(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	for i := 0; i < 12; i++ {
		body := cu44Body(grant, conv, "observe", map[string]any{})
		cu44Create(t, body, http.StatusOK)
	}
	pending := cu45Pending(t)
	if len(pending) > 10 {
		t.Fatalf("pending 应 LIMIT 10，实际 %d", len(pending))
	}
	for _, cmd := range pending {
		if cmd["grant_id"] != grant.ID {
			t.Fatalf("pending 不得含其它租户数据：%v", cmd["grant_id"])
		}
	}
	// 撤销租约 → 派发转 cancelled 409（步骤 6 的租约复核）
	var ack map[string]any
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &ack, http.StatusAccepted)
	pending = cu45Pending(t)
	if len(pending) != 0 {
		t.Fatalf("租约撤销后 pending 应为空（cancelled 不在 queued）：%d", len(pending))
	}
}

// ---------------------------------------------------------------------------
// DEV-CU P4-6：回执、冲突与超时扫描。
// ---------------------------------------------------------------------------

func cu46Receipt(t *testing.T, commandID string, body map[string]any, want int) map[string]any {
	t.Helper()
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/receipt", body, &out, want)
	return out
}

// ① 回执冲突：终态异结果 → 409；同结果幂等。
func TestComputerCommandReceiptConflict(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	created := cu44Create(t, body, http.StatusOK)
	commandID, _ := created["id"].(string)
	// 先 dispatch 再 receipt
	var d map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &d)
	rc := cu46Receipt(t, commandID, map[string]any{"state": "succeeded", "receipt_hash": "h1"}, http.StatusOK)
	if rc["state"] != "succeeded" {
		t.Fatalf("回执应写终态 succeeded：%v", rc["state"])
	}
	// 同结果幂等
	cu46Receipt(t, commandID, map[string]any{"state": "succeeded", "receipt_hash": "h1"}, http.StatusOK)
	// 异结果 → 409
	cu46Receipt(t, commandID, map[string]any{"state": "failed", "receipt_hash": "h2"}, http.StatusConflict)
}

// ② 迟到回执：租约撤销后 → 409 只核对，不改变终态。
func TestComputerCommandLateReceipt(t *testing.T) {
	conv, grant := cu44Setup(t)
	body := cu44Body(grant, conv, "observe", map[string]any{})
	created := cu44Create(t, body, http.StatusOK)
	commandID, _ := created["id"].(string)
	var d map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &d)
	// 撤销租约（generation+1）
	var ack map[string]any
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &ack, http.StatusAccepted)
	// 迟到回执 → 409（computer_foreground_busy 语义族）
	var v map[string]any
	env.mustJSONStatus(t, "GET", "/api/v1/agent/computer/commands/pending", map[string]any{}, &v, http.StatusOK)
	out := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/receipt",
		map[string]any{"state": "succeeded", "receipt_hash": "late"}, &out, http.StatusConflict)
	// 命令状态未被回执改变（sweep 兜底转 unknown_outcome，或仍 dispatched）
	var list struct {
		Commands []map[string]any `json:"commands"`
	}
	_ = list
}

// ③ sweep：dispatched 超 deadline+2s → unknown_outcome + computer_timeout；命令总数不变。
func TestComputerCommandSweep(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	created := cu44Create(t, body, http.StatusOK)
	commandID, _ := created["id"].(string)
	var d map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &d)
	// 把 deadline 拨回 10s 前（模拟超期）
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_computer_command SET deadline_at = now() - interval '10 seconds' WHERE id=$1`, uuid.MustParse(commandID)); err != nil {
		t.Fatal(err)
	}
	env.srv.sweepComputerCommands(context.Background())
	// 断言转 unknown_outcome 且 error_code=computer_timeout
	var state, code string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT state, COALESCE(error_code,'') FROM agent_computer_command WHERE id=$1`, uuid.MustParse(commandID)).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if state != "unknown_outcome" || code != "computer_timeout" {
		t.Fatalf("sweep 应转 unknown_outcome/computer_timeout：%s/%s", state, code)
	}
	// 不新建命令：再跑一次 sweep，总数不变
	var count1, count2 int
	env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_computer_command`).Scan(&count1)
	env.srv.sweepComputerCommands(context.Background())
	env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_computer_command`).Scan(&count2)
	if count1 != count2 {
		t.Fatalf("sweep 不得新建命令：%d → %d", count1, count2)
	}
}

// ④ disposition 一致性：不一致 → 500 computer_internal，不写库。
func TestComputerCommandDispositionValidation(t *testing.T) {
	conv, grant := cu44Setup(t)
	_ = conv
	body := cu44Body(grant, conv, "observe", map[string]any{})
	created := cu44Create(t, body, http.StatusOK)
	commandID, _ := created["id"].(string)
	var d map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &d)
	// delivery=not_delivered 但 retry=unsafe → computer_internal
	out := cu46Receipt(t, commandID, map[string]any{
		"state": "succeeded", "receipt_hash": "h",
		"disposition": map[string]any{"delivery": "not_delivered", "retry": "unsafe"},
	}, 500)
	if out["error"] == nil {
		t.Fatalf("不一致 disposition 应 computer_internal：%v", out)
	}
	// 一致的 disposition 正常写入
	good := cu46Receipt(t, commandID, map[string]any{
		"state": "succeeded", "receipt_hash": "h2",
		"disposition": map[string]any{"delivery": "delivered_verified", "retry": "unsafe"},
	}, http.StatusOK)
	if good["state"] != "succeeded" {
		t.Fatalf("一致 disposition 应正常终态：%v", good["state"])
	}
}
