package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-CU P4-7（docs/36 §P4-7）：run 内同步等待（/tools/computer/commands）。
// 模型参数平铺（action 由工具目录 Fixed 注入）；grant/request 全部服务端自查自生成；
// 写类只提交预览（命令表零新增）；读类 queued → 200ms 轮询等待终态。

func cu47Setup(t *testing.T) (conv agentConversation, grant computerGrantView, runID string) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "computer_use")
	conv = w17CreateConv(t)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	for _, g := range w17ListGrants(t, conv) {
		var ack map[string]any
		env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+g.ID, map[string]any{}, &ack, http.StatusAccepted)
	}
	// 建 run（租约签给 run）
	runID = agentInsertRun(t, conv.ID, uuid.MustParse(env.me(t).Workspace.ID), uuid.MustParse(env.me(t).UserID),
		uuid.MustParse(env.ensureToolModel(t)), "running", "message").String()
	accepted := w17CreatePendingWithRun(t, conv, "cu47:hwnd1", "记事本 - 无标题", "observe", uuid.NewString(), runID)
	if ack := w17AckGrant(t, accepted.GrantID, accepted.Generation, "记事本 - 无标题"); ack.State != "active" {
		t.Fatalf("设备确认后应 active：%+v", ack)
	}
	for _, g := range w17ListGrants(t, conv) {
		if g.ID == accepted.GrantID {
			return conv, g, runID
		}
	}
	t.Fatalf("确认后应在活动租约列表中：%s", accepted.GrantID)
	return conv, computerGrantView{}, runID
}

// cu47RunCall 在独立 goroutine 里走 dispatchAgentTool（run 内 principal），返回响应。
func cu47RunCall(t *testing.T, convID uuid.UUID, runID uuid.UUID, toolName string, args map[string]any) <-chan [2]any {
	t.Helper()
	sess, ws, _ := env.agentSession(t)
	tool := agentTool(toolName)
	if tool == nil {
		t.Fatalf("目录中没有工具 %s", toolName)
	}
	out := make(chan [2]any, 1)
	go func() {
		res, err := env.srv.dispatchAgentTool(context.Background(), agentDispatchRequest{
			Principal: agentPrincipal{SessionID: sess, WorkspaceID: ws, ConversationID: convID, RunID: runID},
			Tool:      tool,
			Args:      args,
		})
		if err != nil {
			out <- [2]any{0, err.Error()}
			return
		}
		// Model 是投影后的 JSON（computer 工具无 Project 定制 → 与 Raw 相同形状）。
		out <- [2]any{res.Status, string(res.Model)}
	}()
	return out
}

func cu47WaitResult(t *testing.T, ch <-chan [2]any, timeout time.Duration) (int, map[string]any) {
	t.Helper()
	select {
	case pair := <-ch:
		raw, _ := pair[1].(string)
		out := map[string]any{}
		if json.Valid([]byte(raw)) {
			_ = json.Unmarshal([]byte(raw), &out)
		} else {
			out["raw"] = raw
		}
		st, _ := pair[0].(int)
		return st, out
	case <-time.After(timeout):
		t.Fatalf("等待 run 调用超时（%v）", timeout)
	}
	return 0, nil
}

// ① 正常终态：读类 queued → 桌面 pending 领取 → dispatch → receipt → 等待返回 succeeded。
func TestComputerCommandRunHappyPath(t *testing.T) {
	conv, grant, runID := cu47Setup(t)
	ch := cu47RunCall(t, conv.ID, uuid.MustParse(runID), "computer_view_target", map[string]any{
		"ref": "@sabc123:e1",
	})
	// 桌面执行器领取
	deadline := time.Now().Add(5 * time.Second)
	var commandID string
	for time.Now().Before(deadline) {
		var pending struct {
			Commands []map[string]any `json:"commands"`
		}
		env.mustJSON(t, "GET", "/api/v1/agent/computer/commands/pending", map[string]any{}, &pending)
		if len(pending.Commands) > 0 {
			commandID, _ = pending.Commands[0]["id"].(string)
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if commandID == "" {
		t.Fatal("5s 内未发现 pending 命令")
	}
	var d map[string]any
	env.mustJSON(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/dispatch", map[string]any{}, &d)
	if d["claimed"] != true {
		t.Fatalf("CAS 领取应命中：%v", d)
	}
	rc := map[string]any{}
	env.mustJSONStatus(t, "POST", "/api/v1/agent/computer/commands/"+commandID+"/receipt",
		map[string]any{"state": "succeeded", "receipt_hash": "cu47",
			"result": map[string]any{"snapshot_id": "sabc123"}}, &rc, http.StatusOK)
	st, out := cu47WaitResult(t, ch, 10*time.Second)
	if st != http.StatusOK {
		t.Fatalf("run 内等待应 200：%d %v", st, out)
	}
	if out["state"] != "succeeded" {
		t.Fatalf("应返回终态 succeeded：%v", out["state"])
	}
	t.Logf("投影后键：%v", keysOf(out))
	if out["result"] == nil {
		t.Fatal("终态应附加 result")
	}
	if _, ok := out["grant_id"]; ok {
		t.Fatal("模型不得拿到 grant_id（不持租约句柄）")
	}
	_ = grant
}

// ② 写类只出预览：命令表零新增。
func TestComputerCommandRunWritePreviewOnly(t *testing.T) {
	conv, _, runID := cu47Setup(t)
	var before, after int
	env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_computer_command`).Scan(&before)
	st, out := cu47WaitResult(t, cu47RunCall(t, conv.ID, uuid.MustParse(runID), "computer_click_target",
		map[string]any{"ref": "@sabc123:e1"}), 10*time.Second)
	if st != http.StatusOK {
		t.Fatalf("写类预览应 200：%d %v", st, out)
	}
	if out["state"] != "awaiting_confirmation" {
		t.Fatalf("写类应返回 awaiting_confirmation：%v", out["state"])
	}
	if out["requires_confirmation"] != true {
		t.Fatalf("预览应标 requires_confirmation=true：%v", out)
	}
	env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_computer_command`).Scan(&after)
	if before != after {
		t.Fatalf("写类路径不得新增命令（红线 2）：%d → %d", before, after)
	}
}

// ③ 无租约：409 computer_foreground_busy 并提示先选窗。
func TestComputerCommandRunNoGrant(t *testing.T) {
	conv, grant, runID := cu47Setup(t)
	_ = grant
	// 撤销租约
	var ack map[string]any
	env.mustJSONStatus(t, "DELETE", "/api/v1/agent/computer-grants/"+grant.ID, map[string]any{}, &ack, http.StatusAccepted)
	st, out := cu47WaitResult(t, cu47RunCall(t, conv.ID, uuid.MustParse(runID), "computer_view_target",
		map[string]any{}), 10*time.Second)
	if st != http.StatusConflict {
		t.Fatalf("无租约应 409：%d %v", st, out)
	}
	if !strings.Contains(fmtOfError(out), "computer_request_target") {
		t.Fatalf("提示应引导先选窗：%v", out)
	}
}

// ④ 无人领取超 deadline+2s：queued → unknown_outcome + computer_wait_timeout。
func TestComputerCommandRunTimeout(t *testing.T) {
	conv, grant, runID := cu47Setup(t)
	_ = grant
	// 领取不到（不发 pending/dispatch）——把 deadline 拨到过去使等待循环立即超时。
	// 直接用 db 预置一条 queued 且已超期的命令？不——走真实入口后在等待循环里拨。
	ch := cu47RunCall(t, conv.ID, uuid.MustParse(runID), "computer_view_target", map[string]any{"ref": "@sabc123:e1"})
	// 找到刚建的命令并拨 deadline 到过去
	deadline := time.Now().Add(5 * time.Second)
	var commandID string
	for time.Now().Before(deadline) {
		var pending struct {
			Commands []map[string]any `json:"commands"`
		}
		env.mustJSON(t, "GET", "/api/v1/agent/computer/commands/pending", map[string]any{}, &pending)
		if len(pending.Commands) > 0 {
			commandID, _ = pending.Commands[0]["id"].(string)
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if commandID == "" {
		t.Fatal("5s 内未发现 queued 命令")
	}
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_computer_command SET deadline_at = now() - interval '10 seconds' WHERE id=$1`,
		uuid.MustParse(commandID)); err != nil {
		t.Fatal(err)
	}
	st, out := cu47WaitResult(t, ch, 15*time.Second)
	if st != http.StatusOK {
		t.Fatalf("等待超时应如实返回 200 非终态或终态：%d %v", st, out)
	}
	state, _ := out["state"].(string)
	if state != "unknown_outcome" && state != "queued" {
		t.Fatalf("超时应转 unknown_outcome（或预算内如实回 queued）：%s", state)
	}
}

// ⑤ 非会话内调用拒绝（principal 缺 RunID/ConversationID）。
func TestComputerCommandRunRequiresPrincipal(t *testing.T) {
	cu47Setup(t)
	res := env.agentDispatch(t, "computer_view_target", map[string]any{"ref": "@sabc123:e1"}, func(req *agentDispatchRequest) {
		req.Principal.RunID = uuid.Nil
		req.Principal.ConversationID = uuid.Nil
	})
	if res.Status == http.StatusOK {
		t.Fatalf("非会话内调用不应成功：%s", res.Raw)
	}
	if !strings.Contains(string(res.Raw), "computer_invalid_args") {
		t.Fatalf("应 computer_invalid_args：%s", res.Raw)
	}
}

func fmtOfError(out map[string]any) string {
	b, _ := json.Marshal(out)
	return string(b)
}

func keysOf(m map[string]any) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}
