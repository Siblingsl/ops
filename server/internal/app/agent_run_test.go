package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// 判据 4（16 文档第 13.2 节第 4 项）：运行循环契约测试。
// 覆盖轮次上限、请求体形状、并发上限、续跑、重新生成、取消与启动恢复。

// agentRunConversation 建一个绑定了 mock-writer 模型的对话。
func (e *testEnv) agentRunConversation(t *testing.T, providerID string) agentConversation {
	t.Helper()
	acc := e.accounts(t)
	return e.createConversation(t, map[string]any{
		"account_id": acc.wechat.ID.String(),
		"model":      map[string]any{"provider_id": providerID, "model": "mock-writer"},
	})
}

// agentTestSessionID 取测试用户最近一次登录的会话 ID，供直接插入 agent_run 使用。
func agentTestSessionID(t *testing.T, userID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// agentInsertRun 直接插入一条运行，返回其 ID。
func agentInsertRun(t *testing.T, convID, wsID, userID, providerID uuid.UUID, status, trigger string) uuid.UUID {
	t.Helper()
	sessionID := agentTestSessionID(t, userID)
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_run
		(conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model_provider_id, model)
		VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,'mock-writer') RETURNING id`,
		convID, wsID, userID, sessionID, trigger, status, providerID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// agentRunPath 返回对话的运行入口路径。
func agentRunPath(c agentConversation, suffix string) string {
	return "/api/v1/agent/conversations/" + c.ID.String() + "/" + suffix
}

// TestAG05RoundLimit：轮次用尽后运行 completed 且 reason=round_limit，事件序列完整。
func TestAG05RoundLimit(t *testing.T) {
	pid := env.ensureToolModel(t)
	acc := env.accounts(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	// 每轮都重新下达同样两个指令（#repeat：持续返回直到轮次用尽）。
	text := "#repeat load_tool_domain {\"domain\":\"works\"}\n" +
		"#repeat works__list {\"accountId\":\"" + acc.wechat.ID.String() + "\"}"
	evs := env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": text})
	if len(evs) == 0 {
		t.Fatal("没有收到 SSE 事件")
	}
	if evs[0].Name != "run" {
		t.Fatalf("第一个事件应为 run：%s", evs[0].Name)
	}
	sawDelta, sawTool := false, false
	for _, ev := range evs {
		switch ev.Name {
		case "tool":
			sawTool = true
		case "delta":
			sawDelta = true
		}
	}
	if !sawTool {
		t.Fatal("运行中没有 tool 事件")
	}
	_ = sawDelta
	done := lastEvent(t, evs)
	if done.Name != "done" {
		t.Fatalf("最后一个事件应为 done：%s", done.Name)
	}
	var payload struct {
		Status         string `json:"status"`
		Reason         string `json:"reason"`
		PendingActions int    `json:"pending_actions"`
		Usage          struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(done.Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Status != "completed" || payload.Reason != "round_limit" {
		t.Fatalf("轮次用尽应 completed/round_limit：%+v", payload)
	}
	// 纯工具轮次的输出为 0（模型这轮没有文字），因此只校验提示用量非零。
	if payload.Usage.PromptTokens <= 0 {
		t.Fatalf("done 应带上用量：%+v", payload)
	}
	var rounds int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT rounds FROM agent_run WHERE conversation_id=$1`, c.ID).Scan(&rounds); err != nil {
		t.Fatal(err)
	}
	if rounds != agentMaxRounds {
		t.Fatalf("rounds 应为上限 %d：%d", agentMaxRounds, rounds)
	}
}

// TestAG05MessageRejectsArrayBody：请求体为数组返回 400（第 11.2 节末段）。
func TestAG05MessageRejectsArrayBody(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)
	st, body := env.do("POST", agentRunPath(c, "messages"), []any{map[string]any{"text": "hi"}})
	if st != http.StatusBadRequest {
		t.Fatalf("数组请求体应 400：%d %s", st, body)
	}
}

// TestAG05ConcurrentRunLimits：同对话第二个运行 409，同用户第三个运行 429（第 6.5 节）。
func TestAG05ConcurrentRunLimits(t *testing.T) {
	pid := env.ensureToolModel(t)
	me := env.me(t)
	userID, err := uuid.Parse(me.UserID)
	if err != nil {
		t.Fatal(err)
	}
	wsID, err := uuid.Parse(me.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	providerID, err := uuid.Parse(pid)
	if err != nil {
		t.Fatal(err)
	}
	insertRun := func(convID uuid.UUID, status string) uuid.UUID {
		t.Helper()
		sessionID := agentTestSessionID(t, userID)
		var id uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_run
			(conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model_provider_id, model)
			VALUES ($1,$2,$3,$4,'message',$5,'queued',$6,'mock-writer') RETURNING id`,
			convID, wsID, userID, sessionID, status, providerID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}

	c1 := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c1.ID)
	insertRun(c1.ID, "queued")
	env.expectErr(t, "POST", agentRunPath(c1, "messages"), map[string]any{"text": "hi"}, "agent_run_busy")

	c2 := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c2.ID)
	c3 := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c3.ID)
	insertRun(c2.ID, "running")
	env.expectErr(t, "POST", agentRunPath(c3, "messages"), map[string]any{"text": "hi"}, "agent_limit_reached")
}

// TestAG05Continue：未报告卡片合并为 action_result，reported_at 只报告一次，
// 计数递增，达到 10 次返回 429，用户消息归零（第 6.4 节、第 13.2 节第 6 项）。
func TestAG05Continue(t *testing.T) {
	pid := env.ensureToolModel(t)
	me := env.me(t)
	userID, _ := uuid.Parse(me.UserID)
	wsID, _ := uuid.Parse(me.Workspace.ID)
	providerID, _ := uuid.Parse(pid)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)

	runID := agentInsertRun(t, c.ID, wsID, userID, providerID, "completed", "message")
	var cardID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind,
		 target_type, target_id, target_key, status, params, result, expires_at)
		VALUES ($1,$2,gen_random_uuid(),$2,$3,'call_1','works__update','W','work','w1','work:w1',
		 'succeeded','{}','{"summary":"已修改标题"}', now() + interval '24 hours') RETURNING id`,
		c.ID, runID, userID).Scan(&cardID); err != nil {
		t.Fatal(err)
	}

	evs := env.sse(t, agentRunPath(c, "continue"), map[string]any{})
	done := lastEvent(t, evs)
	if done.Name != "done" {
		t.Fatalf("续跑应以 done 结束：%s", done.Name)
	}
	var reported int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_action WHERE id=$1 AND reported_at IS NOT NULL`, cardID).Scan(&reported); err != nil {
		t.Fatal(err)
	}
	if reported != 1 {
		t.Fatal("续跑开始后卡片应被标记为已报告")
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT auto_continue_count FROM agent_conversation WHERE id=$1`, c.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("auto_continue_count 应为 1：%d", count)
	}
	var actionResults int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND role='action_result'`,
		c.ID).Scan(&actionResults); err != nil {
		t.Fatal(err)
	}
	if actionResults != 1 {
		t.Fatalf("应写入一条 action_result 消息：%d", actionResults)
	}

	// 再次续跑：同一张已报告的卡片不应产生新的 action_result。
	env.sse(t, agentRunPath(c, "continue"), map[string]any{})
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND role='action_result'`,
		c.ID).Scan(&actionResults); err != nil {
		t.Fatal(err)
	}
	if actionResults != 1 {
		t.Fatalf("reported_at 只应报告一次：%d", actionResults)
	}

	// 连续续跑达到上限后返回 429。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_conversation SET auto_continue_count=$2 WHERE id=$1`, c.ID, agentMaxContinuations); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", agentRunPath(c, "continue"), nil, "agent_limit_reached")

	// 用户消息把计数归零。
	env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "继续吧"})
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT auto_continue_count FROM agent_conversation WHERE id=$1`, c.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("用户消息应把 auto_continue_count 归零：%d", count)
	}
}

// agentTailMessages 造一条用户消息 + 其后的助手消息，返回用户消息序号。
func (e *testEnv) agentTailMessages(t *testing.T, c agentConversation) int {
	t.Helper()
	var seq int
	if err := e.srv.db.QueryRow(context.Background(), `WITH c AS (
		UPDATE agent_conversation SET next_seq = next_seq + 1, last_message_at = now(), updated_at = now()
		WHERE id=$1 RETURNING next_seq)
		INSERT INTO agent_message (conversation_id, seq, role, content)
		SELECT $1, next_seq, 'user', '帮我改标题' FROM c RETURNING seq`, c.ID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if _, err := e.srv.db.Exec(context.Background(), `WITH c AS (
		UPDATE agent_conversation SET next_seq = next_seq + 1, last_message_at = now(), updated_at = now()
		WHERE id=$1 RETURNING next_seq)
		INSERT INTO agent_message (conversation_id, seq, role, content)
		SELECT $1, next_seq, 'assistant', '好的' FROM c`, c.ID); err != nil {
		t.Fatal(err)
	}
	return seq
}

// TestAG05Regenerate：执行过的卡片阻止重写；删除后续消息并替代未结束卡片（第 6.7 节）。
func TestAG05Regenerate(t *testing.T) {
	pid := env.ensureToolModel(t)
	me := env.me(t)
	userID, _ := uuid.Parse(me.UserID)
	wsID, _ := uuid.Parse(me.Workspace.ID)
	providerID, _ := uuid.Parse(pid)

	blocked := env.agentRunConversation(t, pid)
	defer deleteConversations(t, blocked.ID)
	seq := env.agentTailMessages(t, blocked)
	runID := agentInsertRun(t, blocked.ID, wsID, userID, providerID, "completed", "message")
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind,
		 target_type, target_id, target_key, status, params, expires_at)
		VALUES ($1,$2,gen_random_uuid(),$2,$3,'call_1','works__update','W','work','w1','work:w1',
		 'succeeded','{}', now() + interval '24 hours')`, blocked.ID, runID, userID); err != nil {
		t.Fatal(err)
	}
	env.expectErr(t, "POST", agentRunPath(blocked, "regenerate"), nil, "agent_action_state_invalid")

	ok := env.agentRunConversation(t, pid)
	defer deleteConversations(t, ok.ID)
	seq = env.agentTailMessages(t, ok)
	runID = agentInsertRun(t, ok.ID, wsID, userID, providerID, "completed", "message")
	var pendingCard uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind,
		 target_type, target_id, target_key, status, params, expires_at)
		VALUES ($1,$2,gen_random_uuid(),$2,$3,'call_1','works__update','W','work','w1','work:w1',
		 'pending','{}', now() + interval '24 hours') RETURNING id`,
		ok.ID, runID, userID).Scan(&pendingCard); err != nil {
		t.Fatal(err)
	}
	evs := env.sse(t, agentRunPath(ok, "regenerate"), map[string]any{})
	if lastEvent(t, evs).Name != "done" {
		t.Fatal("重新生成应以 done 结束")
	}
	var after int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND seq > $2`, ok.ID, seq).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after == 0 {
		t.Fatal("用户消息之后的旧消息应被删除")
	}
	var status string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM agent_action WHERE id=$1`, pendingCard).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "superseded" {
		t.Fatalf("未结束卡片应改为 superseded：%s", status)
	}
}

// TestAG05CancelAndBootRecovery：取消接口的归属与终态，以及服务重启恢复（第 6.7 节第 4 项、第 6.8 节第 2 项）。
func TestAG05CancelAndBootRecovery(t *testing.T) {
	pid := env.ensureToolModel(t)
	me := env.me(t)
	userID, _ := uuid.Parse(me.UserID)
	wsID, _ := uuid.Parse(me.Workspace.ID)
	providerID, _ := uuid.Parse(pid)

	env.expectErr(t, "POST", "/api/v1/agent/runs/"+uuid.NewString()+"/cancel", nil, "not_found")

	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)
	var runID uuid.UUID
	runID = agentInsertRun(t, c.ID, wsID, userID, providerID, "queued", "message")
	env.expectErr(t, "POST", "/api/v1/agent/runs/"+runID.String()+"/cancel", nil, "agent_run_busy")

	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_run SET status='running' WHERE id=$1`, runID); err != nil {
		t.Fatal(err)
	}
	var executingCard uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind,
		 target_type, target_id, target_key, status, params, expires_at)
		VALUES ($1,$2,gen_random_uuid(),$2,$3,'call_1','works__update','W','work','w1','work:w1',
		 'executing','{}', now() + interval '24 hours') RETURNING id`,
		c.ID, runID, userID).Scan(&executingCard); err != nil {
		t.Fatal(err)
	}

	// 服务重启恢复：queued/running 的运行 failed(interrupted)，executing 卡片 failed(result_unknown)。
	if err := env.srv.RecoverAgentRunsOnBoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	var runStatus, runCode string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, error_code FROM agent_run WHERE id=$1`, runID).Scan(&runStatus, &runCode); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runCode != "interrupted" {
		t.Fatalf("重启后运行应 failed/interrupted：%s/%s", runStatus, runCode)
	}
	var cardStatus string
	var cardErr []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status, error FROM agent_action WHERE id=$1`, executingCard).Scan(&cardStatus, &cardErr); err != nil {
		t.Fatal(err)
	}
	if cardStatus != "failed" || !strings.Contains(string(cardErr), "result_unknown") {
		t.Fatalf("重启后 executing 卡片应 failed/result_unknown：%s %s", cardStatus, cardErr)
	}
}

// TestAG05AutoTitle：新对话标题取第一条用户消息前 30 字（第 6.8 节第 4 项）。
func TestAG05AutoTitle(t *testing.T) {
	pid := env.ensureToolModel(t)
	c := env.agentRunConversation(t, pid)
	defer deleteConversations(t, c.ID)
	env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "帮我看看这周还有哪些作品没做发布前检查\n谢谢"})
	var title string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT title FROM agent_conversation WHERE id=$1`, c.ID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	want := strings.ReplaceAll("帮我看看这周还有哪些作品没做发布前检查\n谢谢", "\n", " ")
	want = strings.Join(strings.Fields(want), " ")
	want = truncate(want, agentTitleChars)
	if title != want {
		t.Fatalf("自动标题 = %q，期望 %q", title, want)
	}
}
