package app

import (
	"context"
	"strings"
	"testing"
)

// TestAG06RetryablePushRunningReturnsPending：推送接口返回可重试错误时卡片回到 pending 并记录 last_error（第 5.1 节第 2 项）。
func TestAG06RetryablePushRunningReturnsPending(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "重试回退观点")
	defer agentDropWork(wk.ID)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": agentLoadDomain("publish") + "\n#tool wechat__push {\"id\":\"" + wk.ID.String() + "\"}"})
	action := findActionEvent(t, evs)
	if action == nil {
		t.Fatal("应提出 wechat__push 卡片")
	}

	// 预置一条「写入中」推送记录：推送接口会返回 409 wechat_push_running（可重试错误）。
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO push_record (work_id, account_id, action, status, over_limit) VALUES ($1,$2,'add','running',false)`,
		wk.ID, acc.wechat.ID); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM push_record WHERE work_id=$1 AND status='running'`, wk.ID)
	}()

	var rev int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT revision FROM work WHERE id=$1`, wk.ID).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	exec := map[string]any{"confirm": true, "gate_ack": true, "second_confirm": true,
		"client_payload": map[string]any{"revision": rev}}
	out := env.sse(t, agentActionPath(action.ID, "execute"), exec)
	if done := lastEvent(t, out); done.Name != "done" {
		t.Fatalf("最后一个事件应为 done：%s", done.Name)
	}

	// 卡片回到 pending 并保存 last_error（不是 failed，可再次点击）。
	var status string
	var lastErr []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, coalesce(last_error,'{}') FROM agent_action WHERE id=$1`, action.ID).Scan(&status, &lastErr); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("可重试错误后卡片应回到 pending：%s", status)
	}
	if !strings.Contains(string(lastErr), "wechat_push_running") {
		t.Fatalf("last_error 应记录 wechat_push_running：%s", lastErr)
	}

	// 再次执行仍被允许（不会被「已经处理过」拦下），并再次回到 pending。
	out2 := env.sse(t, agentActionPath(action.ID, "execute"), exec)
	if done := lastEvent(t, out2); done.Name != "done" {
		t.Fatalf("第二次执行的最后一个事件应为 done：%s", done.Name)
	}
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_action WHERE id=$1`, action.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("再次执行后仍应为 pending：%s", status)
	}
}
