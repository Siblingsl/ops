package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func aw06MemoryCard(t *testing.T) (agentConversation, *agentActionView, string) {
	t.Helper()
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	note := "AW06单卡执行验证" + uuid.NewString()
	t.Cleanup(func() {
		deleteConversations(t, conversation.ID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM account_memory WHERE text=$1`, note)
	})
	text := note + "\n" + agentLoadDomain("profile") + "\n#tool memory__create " +
		fmt.Sprintf(`{"accountId":"%s","text":"%s"}`, env.accounts(t).wechat.ID, note)
	action := findActionEvent(t, env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": text}))
	if action == nil {
		t.Fatal("应提出单张记忆卡片")
	}
	return conversation, action, note
}

func aw06ActionEvents(t *testing.T, conversationID, actionID uuid.UUID) []map[string]any {
	t.Helper()
	rows, err := env.srv.db.Query(t.Context(), `SELECT payload FROM agent_event
		WHERE conversation_id=$1 AND type='action.updated' AND payload->>'action_id'=$2 ORDER BY event_seq`, conversationID, actionID.String())
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	events := []map[string]any{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var event map[string]any
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		for field := range event {
			if field != "action_id" && field != "status" && field != "revision" && field != "error_code" {
				t.Fatalf("卡片事件包含白名单之外的字段：%s", field)
			}
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

func TestAW06ActionLifecycleHasAtomicRevisions(t *testing.T) {
	conversation, action, _ := aw06MemoryCard(t)
	if action.Revision != 1 {
		t.Fatalf("新卡片修订应为1：%d", action.Revision)
	}
	env.sse(t, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
	events := aw06ActionEvents(t, conversation.ID, action.ID)
	if len(events) != 3 {
		t.Fatalf("创建/抢占/成功各产生一个事件：%+v", events)
	}
	for i, status := range []string{"pending", "executing", "succeeded"} {
		if events[i]["status"] != status || events[i]["revision"] != float64(i+1) {
			t.Fatalf("卡片状态与修订不一致：%+v", events)
		}
	}
	view, err := env.srv.agentActionByID(t.Context(), action.ID)
	if err != nil || view.Revision != 3 || view.Status != "succeeded" {
		t.Fatalf("快照应与最终事件一致：%+v %v", view, err)
	}
}

func TestAW06ActionEventFailureRollsBackStateAndCursor(t *testing.T) {
	conversation, action, _ := aw06MemoryCard(t)
	var before int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_event_seq FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	constraint := "aw06_event_guard_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	// 仅在本地隔离测试库制造事件写入失败，检验状态不能先成功提交。
	query := fmt.Sprintf(`ALTER TABLE agent_event ADD CONSTRAINT %s CHECK (NOT (
		type='action.updated' AND payload->>'action_id'='%s' AND payload->>'status'='rejected'))`, constraint, action.ID)
	if _, err := env.srv.db.Exec(t.Context(), query); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), "ALTER TABLE agent_event DROP CONSTRAINT "+constraint)
	})
	status, _ := env.do(http.MethodPost, agentActionPath(action.ID, "reject"), map[string]any{"reason": "测试事务回滚"})
	if status < 400 {
		t.Fatalf("事件保存失败不能报告卡片成功：%d", status)
	}
	view, err := env.srv.agentActionByID(t.Context(), action.ID)
	if err != nil || view.Status != "pending" || view.Revision != 1 {
		t.Fatalf("事件失败时状态/修订必须回滚：%+v %v", view, err)
	}
	var after int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_event_seq FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("失败事件不得消耗游标：before=%d after=%d err=%v", before, after, err)
	}
}

func TestAW06DoubleExecutionDispatchesOneBusinessWrite(t *testing.T) {
	conversation, action, note := aw06MemoryCard(t)
	tx, err := env.srv.db.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, conversation.ID); err != nil {
		t.Fatal(err)
	}
	statuses := [2]int{}
	var requests sync.WaitGroup
	for i := range statuses {
		requests.Add(1)
		go func(index int) {
			defer requests.Done()
			statuses[index], _ = env.do(http.MethodPost, agentActionPath(action.ID, "execute"), map[string]any{"confirm": true})
		}(i)
	}
	// 两端均读到pending后，在同一会话锁上竞争，随后只允许一端抢占。
	blocked := 0
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
			AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM agent_conversation%FOR UPDATE'`).Scan(&blocked); err != nil {
			tx.Rollback(t.Context())
			requests.Wait()
			t.Fatal(err)
		}
		if blocked >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	requests.Wait()
	if blocked < 2 {
		t.Fatal("未建立双端竞争条件")
	}
	if !(statuses[0] == 200 && statuses[1] == 409 || statuses[1] == 200 && statuses[0] == 409) {
		t.Fatalf("双端执行应一方成功、一方冲突：%v", statuses)
	}
	var written int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM account_memory WHERE text=$1`, note).Scan(&written); err != nil || written != 1 {
		t.Fatalf("业务写入必须只发生一次：count=%d err=%v", written, err)
	}
	if events := aw06ActionEvents(t, conversation.ID, action.ID); len(events) != 3 {
		t.Fatalf("失败抢占不得生成重复状态事件：%+v", events)
	}
}

func TestAW06SecretOnceIsAbsentFromSnapshotAndEventReplay(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	env.reauth(t)
	action := findActionEvent(t, env.sse(t, agentRunPath(conversation, "messages"), map[string]any{
		"text": agentLoadDomain("workspace") + "\n#tool workspace__create_invite {\"role\":\"editor\"}",
	}))
	if action == nil {
		t.Fatal("应提出创建邀请卡片")
	}
	request := map[string]any{"confirm": true, "request_id": uuid.NewString()}
	out := env.sse(t, agentActionPath(action.ID, "execute"), request)
	var result struct {
		SecretOnce map[string]string `json:"secret_once"`
	}
	if err := json.Unmarshal(lastEvent(t, out).Data, &result); err != nil || len(result.SecretOnce) == 0 {
		t.Fatalf("首次执行必须只向用户返回一次性值：%v", err)
	}
	_, snapshot := env.do(http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String(), nil)
	previousTimeout := env.client.Timeout
	env.client.Timeout = 250 * time.Millisecond
	status, replay := env.do(http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String()+"/events?after_event_seq=0", nil)
	env.client.Timeout = previousTimeout
	if status != http.StatusOK || !strings.Contains(string(replay), "event: action.updated") {
		t.Fatalf("应能重放普通卡片状态：%d", status)
	}
	for _, secret := range result.SecretOnce {
		if secret == "" {
			t.Fatal("一次性值不能为空")
		}
		if strings.Contains(string(snapshot), secret) || strings.Contains(string(replay), secret) || strings.Contains(string(replay), "secret_once") {
			t.Fatal("一次性值不得出现在详情快照或持久事件回放中")
		}
	}
	aw06ActionEvents(t, conversation.ID, action.ID)
	repeated := env.sse(t, agentActionPath(action.ID, "execute"), request)
	var repeatedResult struct {
		SecretOnce map[string]string `json:"secret_once"`
	}
	if err := json.Unmarshal(lastEvent(t, repeated).Data, &repeatedResult); err != nil || len(repeatedResult.SecretOnce) != 0 {
		t.Fatalf("相同请求只能返回已保存状态，不能重放一次性值：%v", err)
	}
}

func TestAW06ExecuteRequestReplayIsIdempotentAndPayloadBound(t *testing.T) {
	conversation, action, note := aw06MemoryCard(t)
	for _, invalid := range []string{"invalid", uuid.Nil.String()} {
		env.expectErr(t, http.MethodPost, agentActionPath(action.ID, "execute"),
			map[string]any{"confirm": true, "request_id": invalid}, "validation_failed")
	}
	requestID := uuid.NewString()
	request := map[string]any{"confirm": true, "request_id": requestID}
	env.sse(t, agentActionPath(action.ID, "execute"), request)
	repeated := env.sse(t, agentActionPath(action.ID, "execute"), request)
	if lastEvent(t, repeated).Name != "done" {
		t.Fatal("重复请求应返回原卡片的已保存状态")
	}
	var restored struct {
		Replayed    bool `json:"replayed"`
		CanContinue bool `json:"can_continue"`
	}
	if err := json.Unmarshal(lastEvent(t, repeated).Data, &restored); err != nil || !restored.Replayed || restored.CanContinue {
		t.Fatal("请求重放必须标记为恢复结果，不能再次触发自动续跑计费")
	}
	env.expectErr(t, http.MethodPost, agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": false, "request_id": requestID}, "agent_request_conflict")
	var written int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM account_memory WHERE text=$1`, note).Scan(&written); err != nil || written != 1 {
		t.Fatalf("请求重放不应再次写入：count=%d err=%v", written, err)
	}
	if events := aw06ActionEvents(t, conversation.ID, action.ID); len(events) != 3 {
		t.Fatalf("请求重放不得再次抢占卡片或产生事件：%+v", events)
	}
}

func TestAW06ExecuteRequestInProgressCannotRedispatch(t *testing.T) {
	_, action, note := aw06MemoryCard(t)
	tx, err := env.srv.db.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var first sync.WaitGroup
	defer func() { tx.Rollback(context.Background()); first.Wait() }()
	if _, err := tx.Exec(t.Context(), `LOCK TABLE account_memory IN SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	requestID := uuid.NewString()
	payload := map[string]any{"confirm": true, "request_id": requestID}
	firstStatus := 0
	first.Add(1)
	go func() {
		defer first.Done()
		firstStatus, _ = env.do(http.MethodPost, agentActionPath(action.ID, "execute"), payload)
	}()
	status := ""
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_action WHERE id=$1`, action.ID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == "executing" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if status != "executing" {
		t.Fatal("执行受理事实应先提交，不能随业务调用持有长事务")
	}
	env.expectErr(t, http.MethodPost, agentActionPath(action.ID, "execute"), payload, "agent_action_state_invalid")
	env.expectErr(t, http.MethodPost, agentActionPath(action.ID, "execute"),
		map[string]any{"confirm": false, "request_id": requestID}, "agent_request_conflict")
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	first.Wait()
	if firstStatus != http.StatusOK {
		t.Fatalf("首次执行应正常结束：%d", firstStatus)
	}
	var written int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM account_memory WHERE text=$1`, note).Scan(&written); err != nil || written != 1 {
		t.Fatalf("在途请求只能分发一次：count=%d err=%v", written, err)
	}
}
