package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAW06EventResumeFeatureGate(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "")
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	env.expectErr(t, "GET", "/api/v1/agent/conversations/"+conversation.ID.String()+"/events", nil,
		"agent_feature_unavailable")
	env.expectErr(t, "GET", "/api/v1/agent/conversations/"+uuid.NewString()+"/events", nil, "not_found")
}

func TestAW06V2RejectsMissingOrZeroRequestIDBeforeSaving(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	for _, requestID := range []string{"", uuid.Nil.String()} {
		env.expectErr(t, http.MethodPost, agentRunPath(conversation, "messages"),
			map[string]any{"text": "不应保存", "protocol_version": 2, "request_id": requestID}, "validation_failed")
	}
	var messages int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conversation.ID).Scan(&messages); err != nil || messages != 0 {
		t.Fatalf("无幂等编号的v2请求不能创建消息：messages=%d err=%v", messages, err)
	}
}

func TestAW06PartialSnapshotAndBootRecoveryArePersistent(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	me := env.me(t)
	runID := agentInsertRun(t, conversation.ID, uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID),
		uuid.MustParse(providerID), "running", "message")
	st := &agentRunState{RunID: runID, ConversationID: conversation.ID, MessageKey: runID.String() + ":1"}
	if err := env.srv.persistAgentDelta(t.Context(), st, "服务端保存的未完成内容"); err != nil {
		t.Fatal(err)
	}
	var detail struct {
		LastEventSeq int64           `json:"last_event_seq"`
		ActiveRun    *agentActiveRun `json:"active_run"`
		LastRun      *agentActiveRun `json:"last_run"`
		Partial      struct {
			RunID      uuid.UUID `json:"run_id"`
			MessageKey string    `json:"message_key"`
			Text       string    `json:"text"`
			Complete   bool      `json:"complete"`
		} `json:"partial_output"`
	}
	path := "/api/v1/agent/conversations/" + conversation.ID.String()
	env.mustJSON(t, http.MethodGet, path, nil, &detail)
	if detail.ActiveRun == nil || detail.Partial.RunID != runID || detail.Partial.MessageKey != st.MessageKey || detail.Partial.Text == "" || detail.Partial.Complete {
		t.Fatalf("活动运行快照缺少持久partial：%+v", detail)
	}
	before := detail.LastEventSeq
	if err := env.srv.RecoverAgentRunsOnBoot(t.Context()); err != nil {
		t.Fatal(err)
	}
	env.mustJSON(t, http.MethodGet, path, nil, &detail)
	if detail.ActiveRun != nil || detail.LastRun == nil || detail.LastRun.ErrorCode != "interrupted" || detail.Partial.Text == "" || detail.LastEventSeq <= before {
		t.Fatalf("重启后应保留未完成文本并推进终态事件：%+v", detail)
	}
	if err := env.srv.RecoverAgentRunsOnBoot(t.Context()); err != nil {
		t.Fatal(err)
	}
	var endings int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_event WHERE run_id=$1 AND type='run.ended'`, runID).Scan(&endings); err != nil || endings != 1 {
		t.Fatalf("恢复重放不能重复结束事件：count=%d err=%v", endings, err)
	}
}

func TestAW06PersistedDeltaRacesStopWithoutDeadlock(t *testing.T) {
	_, st := aw06ToolRun(t)
	env.srv.registerAgentRun(st.RunID, func() {})
	defer env.srv.unregisterAgentRun(st.RunID)
	path := "/api/v1/agent/runs/" + st.RunID.String() + "/cancel"
	for i := 0; i < 12; i++ {
		start := make(chan struct{})
		deltaDone := make(chan error, 1)
		stopDone := make(chan int, 1)
		go func() {
			<-start
			deltaDone <- env.srv.persistAgentDelta(context.Background(), st, fmt.Sprintf("增量-%d", i))
		}()
		go func() {
			<-start
			status, _ := env.do(http.MethodPost, path, map[string]any{})
			stopDone <- status
		}()
		close(start)
		select {
		case err := <-deltaDone:
			if err != nil {
				t.Fatalf("第%d轮持久化流式增量失败：%v", i, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("第%d轮流式增量与停止发生死锁", i)
		}
		select {
		case status := <-stopDone:
			if status != http.StatusOK {
				t.Fatalf("第%d轮停止失败：%d", i, status)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("第%d轮停止未完成", i)
		}
	}
}

func TestAW06SnapshotReaderDoesNotCrossEventBoundary(t *testing.T) {
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	tx, err := env.srv.db.BeginTx(t.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	var cursor int64
	if err := tx.QueryRow(t.Context(), `SELECT next_event_seq FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&cursor); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.agentInsertRow(t.Context(), conversation.ID, nil, "assistant", "快照之后提交的消息", nil, "", "", nil); err != nil {
		t.Fatal(err)
	}
	messages, _, err := env.srv.agentMessages(t.Context(), tx, conversation.ID, 0)
	if err != nil || len(messages) != 0 {
		t.Fatalf("旧快照不能包含游标之后提交的消息：%+v err=%v", messages, err)
	}
	var latest int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_event_seq FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&latest); err != nil || latest <= cursor {
		t.Fatalf("新消息必须已有可续接事件：cursor=%d latest=%d err=%v", cursor, latest, err)
	}
}

func TestAW06CancelCannotCrossWorkspaceForSameUser(t *testing.T) {
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	me := env.me(t)
	runID := agentInsertRun(t, conversation.ID, uuid.New(), uuid.MustParse(me.UserID), uuid.MustParse(providerID), "running", "message")
	runCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	env.srv.registerAgentRun(runID, cancel)
	defer env.srv.unregisterAgentRun(runID)
	env.expectErr(t, http.MethodPost, "/api/v1/agent/runs/"+runID.String()+"/cancel", nil, "not_found")
	if runCtx.Err() != nil {
		t.Fatal("跨工作区请求取消了运行")
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_run SET workspace_id=$2 WHERE id=$1`, runID, uuid.MustParse(me.Workspace.ID)); err != nil {
		t.Fatal(err)
	}
	status, body := env.do(http.MethodPost, "/api/v1/agent/runs/"+runID.String()+"/cancel", nil)
	if status != http.StatusOK || runCtx.Err() == nil {
		t.Fatalf("本人当前工作区停止应取消运行：%d %s", status, body)
	}
}

func TestAW06EventBaselineCursorAndPrivateReplay(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,conversation_organize")
	conversation := env.createConversation(t, map[string]any{})
	defer deleteConversations(t, conversation.ID)
	var next, read, floor int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_event_seq,read_upto_event_seq,event_retention_floor
		FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&next, &read, &floor); err != nil {
		t.Fatal(err)
	}
	if next != 1 || read != 1 || floor != 0 {
		t.Fatalf("新会话快照基线不正确：next=%d read=%d floor=%d", next, read, floor)
	}

	previousTimeout := env.client.Timeout
	env.client.Timeout = 250000000
	status, body := env.do(http.MethodGet, fmt.Sprintf("/api/v1/agent/conversations/%s/events?after_event_seq=0", conversation.ID), nil)
	env.client.Timeout = previousTimeout
	if status != http.StatusOK || !strings.Contains(string(body), "id: 1\nevent: conversation.updated") {
		t.Fatalf("事件接口未重放快照基线：%d %s", status, body)
	}

	status, body = env.do(http.MethodGet, fmt.Sprintf("/api/v1/agent/conversations/%s/events?after_event_seq=2", conversation.ID), nil)
	if status != http.StatusUnprocessableEntity || apiCode(body) != "validation_failed" {
		t.Fatalf("超前游标必须返回422：%d %s", status, body)
	}
	deltaSeq, err := env.srv.appendAgentEvent(t.Context(), conversation.ID, nil, "message.delta",
		map[string]any{"message_key": "retention-check", "chunk_index": 1, "text": "expired"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_event SET expires_at=now()-interval '1 second'
		WHERE conversation_id=$1 AND event_seq=$2`, conversation.ID, deltaSeq); err != nil {
		t.Fatal(err)
	}
	status, body = env.do(http.MethodGet, fmt.Sprintf("/api/v1/agent/conversations/%s/events?after_event_seq=%d", conversation.ID, deltaSeq-1), nil)
	if status != http.StatusGone || apiCode(body) != "agent_event_cursor_expired" {
		t.Fatalf("过期游标必须返回410：%d %s", status, body)
	}
	floor = 0
	var expiredCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT event_retention_floor FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&floor); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_event WHERE conversation_id=$1 AND event_seq=$2`, conversation.ID, deltaSeq).Scan(&expiredCount); err != nil {
		t.Fatal(err)
	}
	if floor != deltaSeq || expiredCount != 0 {
		t.Fatalf("清理过期增量后应推进游标水位：floor=%d delta_count=%d", floor, expiredCount)
	}

	guest := env.registerClient(t, "aw06guest", "aw06-guest-password")
	defer guest.restore(env)
	guestStatus, guestBody := guest.do(http.MethodGet,
		fmt.Sprintf("/api/v1/agent/conversations/%s/events?after_event_seq=1", conversation.ID), nil)
	if guestStatus != http.StatusNotFound || apiCode(guestBody) != "not_found" {
		t.Fatalf("他人不能读取私有事件：%d %s", guestStatus, guestBody)
	}
}

func TestAW06LegacySSEPublishesPersistentEvents(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	events := env.sse(t, agentRunPath(conversation, "messages"), map[string]any{"text": "AW06 持久事件兼容"})
	if len(events) < 2 || events[0].Name != "run" || lastEvent(t, events).Name != "done" {
		t.Fatalf("旧 SSE 事件投影发生变化：%+v", events)
	}
	var eventCount int
	var started, ended, saved int
	var minSeq, maxSeq int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),min(event_seq),max(event_seq),
		count(*) FILTER (WHERE type='run.started'),count(*) FILTER (WHERE type='run.ended'),
		count(*) FILTER (WHERE type='message.saved') FROM agent_event WHERE conversation_id=$1`, conversation.ID).
		Scan(&eventCount, &minSeq, &maxSeq, &started, &ended, &saved); err != nil {
		t.Fatal(err)
	}
	if eventCount < 5 || minSeq != 1 || maxSeq != int64(eventCount) || started != 1 || ended != 1 || saved < 2 {
		t.Fatalf("v1 运行事件未持久化或序号不连续：count=%d seq=%d..%d started=%d ended=%d saved=%d",
			eventCount, minSeq, maxSeq, started, ended, saved)
	}
}

func TestAW06V2MessageAcceptanceReplayAndEventSubscription(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,conversation_organize")
	providerID := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, providerID)
	defer deleteConversations(t, conversation.ID)
	requestID := uuid.NewString()
	payload := map[string]any{"text": "AW06 v2 同一运行恢复", "request_id": requestID, "protocol_version": 2}
	path := agentRunPath(conversation, "messages")
	status, raw := env.do(http.MethodPost, path, payload)
	if status != http.StatusAccepted {
		t.Fatalf("v2消息应返回202：%d %s", status, raw)
	}
	var first struct {
		RunID        string `json:"run_id"`
		MessageID    string `json:"message_id"`
		EventsURL    string `json:"events_url"`
		LastEventSeq int64  `json:"last_event_seq"`
	}
	if err := json.Unmarshal(raw, &first); err != nil {
		t.Fatal(err)
	}
	if first.RunID == "" || first.MessageID == "" || first.EventsURL == "" || first.LastEventSeq < 2 {
		t.Fatalf("v2受理回执不完整：%s", raw)
	}

	// 同一请求重放返回原 run/message；同一 request_id 不同正文必须冲突。
	status, raw = env.do(http.MethodPost, path, payload)
	if status != http.StatusAccepted {
		t.Fatalf("重复v2请求应返回原202：%d %s", status, raw)
	}
	var replay struct {
		RunID     string `json:"run_id"`
		MessageID string `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &replay); err != nil || replay.RunID != first.RunID || replay.MessageID != first.MessageID {
		t.Fatalf("重放未返回原资源：%s (%v)", raw, err)
	}
	changed := map[string]any{"text": "不同正文", "request_id": requestID, "protocol_version": 2}
	status, raw = env.do(http.MethodPost, path, changed)
	if status != http.StatusConflict || apiCode(raw) != "agent_request_conflict" {
		t.Fatalf("复用请求编号发送不同正文必须409：%d %s", status, raw)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var runStatus string
		if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, first.RunID).Scan(&runStatus); err == nil &&
			(runStatus == "completed" || runStatus == "failed" || runStatus == "stopped" || runStatus == "awaiting_confirmation") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	var runCount, messageCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE request_id=$1`, requestID).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1 AND role='user'`, conversation.ID).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 1 || messageCount != 1 {
		t.Fatalf("v2重复请求创建了额外资源：runs=%d messages=%d", runCount, messageCount)
	}

	previousTimeout := env.client.Timeout
	env.client.Timeout = 250 * time.Millisecond
	status, raw = env.do(http.MethodGet, first.EventsURL, nil)
	env.client.Timeout = previousTimeout
	if status != http.StatusOK || !strings.Contains(string(raw), "event: run.started") ||
		!strings.Contains(string(raw), "event: run.ended") || !strings.Contains(string(raw), "id: ") {
		t.Fatalf("v2事件订阅未重放同一运行：%d %s", status, raw)
	}

	var lastEventSeq int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT next_event_seq FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&lastEventSeq); err != nil {
		t.Fatal(err)
	}
	var read struct {
		ReadUptoEventSeq int64 `json:"read_upto_event_seq"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/conversations/"+conversation.ID.String()+"/read",
		map[string]any{"upto_event_seq": lastEventSeq}, &read)
	if read.ReadUptoEventSeq != lastEventSeq {
		t.Fatalf("事件阅读水位未返回：got=%d want=%d", read.ReadUptoEventSeq, lastEventSeq)
	}
}
