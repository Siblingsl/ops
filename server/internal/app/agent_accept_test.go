package app

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAW06RejectedRunDoesNotSaveInput(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	provider := env.ensureToolModel(t)
	me := env.me(t)
	for _, protocol := range []int{1, 2} {
		conversation := env.agentRunConversation(t, provider)
		defer deleteConversations(t, conversation.ID)
		agentInsertRun(t, conversation.ID, uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID),
			uuid.MustParse(provider), "running", "message")
		env.expectErr(t, http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
			"text": "忙碌时不能留下消息", "request_id": uuid.NewString(), "protocol_version": protocol,
		}, "agent_run_busy")
		var messages, requests int
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conversation.ID).Scan(&messages); err != nil {
			t.Fatal(err)
		}
		if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_request WHERE operation=$1`, "conversation.message:"+conversation.ID.String()).Scan(&requests); err != nil {
			t.Fatal(err)
		}
		if messages != 0 || requests != 0 {
			t.Fatalf("被拒绝的v%d请求留下消息/回执：messages=%d requests=%d", protocol, messages, requests)
		}
	}
}

func TestAW06UserQuotaIsAtomicAcrossWorkspaces(t *testing.T) {
	provider := env.ensureToolModel(t)
	me := env.me(t)
	userID := uuid.MustParse(me.UserID)
	ctx := context.WithValue(t.Context(), ctxMember, &identity{UserID: userID,
		WorkspaceID: uuid.MustParse(me.Workspace.ID), SessionID: agentTestSessionID(t, userID), Role: "owner"})
	conversations := make([]agentConversation, 3)
	for i := range conversations {
		conversations[i] = env.agentRunConversation(t, provider)
		defer deleteConversations(t, conversations[i].ID)
	}
	// 同一用户在另一个工作区已有一次运行，也必须占用该用户的名额。
	agentInsertRun(t, conversations[0].ID, uuid.New(), userID, uuid.MustParse(provider), "queued", "message")
	var wg sync.WaitGroup
	errors := make([]error, 2)
	for i := range errors {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := &conversations[i+1]
			_, errors[i] = env.srv.agentPrepareRun(ctx, c, c, "message", nil, func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
				message, err := env.srv.agentInsertRowTx(ctx, tx, c.ID, nil, "user", "争用最后一个并发名额", nil, "", "", nil)
				if err != nil {
					return nil, false, err
				}
				return &message.ID, false, nil
			})
		}(i)
	}
	wg.Wait()
	accepted := 0
	for _, err := range errors {
		if err == nil {
			accepted++
			continue
		}
		if ae := asAPIError(ctx, err); ae.Code != "agent_limit_reached" {
			t.Fatalf("并发失败原因不正确：%v", err)
		}
	}
	if accepted != 1 {
		t.Fatalf("只剩一个名额却受理了%d个请求：%v", accepted, errors)
	}
	var runs, messages, linked int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE user_id=$1 AND status IN ('queued','running')`, userID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*),count(run_id) FROM agent_message WHERE conversation_id=ANY($1)`,
		[]uuid.UUID{conversations[1].ID, conversations[2].ID}).Scan(&messages, &linked); err != nil {
		t.Fatal(err)
	}
	if runs != 2 || messages != 1 || linked != 1 {
		t.Fatalf("名额/消息/关联不一致：runs=%d messages=%d linked=%d", runs, messages, linked)
	}
}

func TestAW06AcceptanceFailureRollsBackCardReportAndCounter(t *testing.T) {
	conversation, action, _ := aw06MemoryCard(t)
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_action SET status='rejected' WHERE id=$1`, action.ID); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conversation.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	constraint := "aw06_accept_" + uuid.New().String()[:8]
	if _, err := env.srv.db.Exec(t.Context(), "ALTER TABLE agent_event ADD CONSTRAINT "+constraint+
		" CHECK (conversation_id <> '"+conversation.ID.String()+"'::uuid OR type <> 'run.started') NOT VALID"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), "ALTER TABLE agent_event DROP CONSTRAINT "+constraint)
	})
	status, _ := env.do(http.MethodPost, agentRunPath(conversation, "continue"), map[string]any{})
	if status < 400 {
		t.Fatalf("受理事务失败却宣布成功：%d", status)
	}
	var reported bool
	var counter, after int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT reported_at IS NOT NULL FROM agent_action WHERE id=$1`, action.ID).Scan(&reported); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT auto_continue_count,(SELECT count(*) FROM agent_message WHERE conversation_id=$1) FROM agent_conversation WHERE id=$1`, conversation.ID).Scan(&counter, &after); err != nil {
		t.Fatal(err)
	}
	if reported || counter != 0 || after != before {
		t.Fatalf("受理失败未回滚：reported=%v counter=%d messages=%d->%d", reported, counter, before, after)
	}
}

func TestAW06ConversationConfigurationCannotBypassPendingOrRunningState(t *testing.T) {
	c, _, _ := aw06MemoryCard(t)
	accounts := env.accounts(t)
	path := "/api/v1/agent/conversations/" + c.ID.String()
	env.expectErr(t, http.MethodPatch, path, map[string]any{"account_id": accounts.xhs.ID}, "agent_action_state_invalid")
	env.expectErr(t, http.MethodPost, agentRunPath(c, "messages"), map[string]any{
		"text": "不能通过发送时覆盖账号绕过卡片", "account_id": accounts.xhs.ID,
	}, "agent_action_state_invalid")
	me := env.me(t)
	agentInsertRun(t, c.ID, uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID), *c.ModelProviderID, "queued", "message")
	env.expectErr(t, http.MethodPatch, path, map[string]any{"model": map[string]any{
		"provider_id": c.ModelProviderID, "model": c.Model,
	}}, "agent_run_busy")
	var persisted uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT account_id FROM agent_conversation WHERE id=$1`, c.ID).Scan(&persisted); err != nil || persisted != accounts.wechat.ID {
		t.Fatalf("被拒绝的配置切换仍写入：%v %v", persisted, err)
	}
}

func aw06WaitRun(t *testing.T, raw []byte) uuid.UUID {
	t.Helper()
	var out struct {
		RunID uuid.UUID `json:"run_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	// 等待原 mock 运行完成，避免后续验收与该运行并行。
	for i := 0; i < 300; i++ {
		var active bool
		if err := env.srv.db.QueryRow(t.Context(), `SELECT status IN ('queued','running') FROM agent_run WHERE id=$1`, out.RunID).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if !active {
			return out.RunID
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("mock 运行未在限时内结束")
	return uuid.Nil
}

func TestAW06AttachmentMessageReplayUsesSavedReceipt(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	status, attachment, body := agentUploadAttachment(t, "receipt.txt", []byte("仅用于请求去重验证"), conversation.ID.String())
	if status != http.StatusOK {
		t.Fatalf("上传失败：%d %s", status, body)
	}
	request := map[string]any{"text": "阅读附件", "attachment_ids": []string{attachment.ID.String()},
		"request_id": uuid.NewString(), "protocol_version": 2}
	status, body = env.do(http.MethodPost, agentRunPath(conversation, "messages"), request)
	if status != http.StatusAccepted {
		t.Fatalf("首条消息未受理：%d %s", status, body)
	}
	status, body = env.do(http.MethodPost, agentRunPath(conversation, "messages"), request)
	if status != http.StatusAccepted {
		t.Fatalf("已引用附件不能阻止回执重放：%d %s", status, body)
	}
	aw06WaitRun(t, body)
}

func TestAW06ContextReplayDoesNotReloadChangedSource(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,context_refs")
	provider := env.ensureToolModel(t)
	c := env.agentRunConversation(t, provider)
	defer deleteConversations(t, c.ID)
	var materialID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO material(workspace_id,account_id,kind,content,source)
		VALUES($1,$2,'case','首次发送的资料','手工') RETURNING id`, ownerWS(t), c.AccountID).Scan(&materialID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = env.srv.db.Exec(context.Background(), `DELETE FROM material WHERE id=$1`, materialID) })
	request := map[string]any{"text": "阅读已选资料", "request_id": uuid.NewString(), "protocol_version": 2,
		"context_refs": []map[string]any{{"type": "material", "id": materialID}}}
	status, body := env.do(http.MethodPost, agentRunPath(c, "messages"), request)
	if status != http.StatusAccepted {
		t.Fatalf("首次受理失败：%d %s", status, body)
	}
	original := aw06WaitRun(t, body)
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE material SET deleted_at=now() WHERE id=$1`, materialID); err != nil {
		t.Fatal(err)
	}
	status, body = env.do(http.MethodPost, agentRunPath(c, "messages"), request)
	if status != http.StatusAccepted || aw06WaitRun(t, body) != original {
		t.Fatalf("资料撤回不能改变已受理回执：%d %s", status, body)
	}
	request["text"] = "不同内容"
	env.expectErr(t, http.MethodPost, agentRunPath(c, "messages"), request, "agent_request_conflict")
}

func TestAW06RewriteReplaysOriginalRunAfterNewMessage(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume")
	provider := env.ensureToolModel(t)
	for _, trigger := range []string{"regenerate", "edit"} {
		c := env.agentRunConversation(t, provider)
		defer deleteConversations(t, c.ID)
		env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "原消息"})
		last, err := agentLastUserMessageWith(t.Context(), env.srv.db, c.ID)
		if err != nil {
			t.Fatal(err)
		}
		path := agentRunPath(c, trigger)
		request := map[string]any{"request_id": uuid.NewString(), "protocol_version": 2}
		if trigger == "edit" {
			path = agentRunPath(c, "messages/"+last.ID.String()+"/edit")
			request["text"] = "修改后的消息"
		}
		status, body := env.do(http.MethodPost, path, request)
		if status != http.StatusAccepted {
			t.Fatalf("%s 首次受理：%d %s", trigger, status, body)
		}
		original := aw06WaitRun(t, body)
		env.sse(t, agentRunPath(c, "messages"), map[string]any{"text": "后续消息"})
		status, body = env.do(http.MethodPost, path, request)
		if status != http.StatusAccepted || aw06WaitRun(t, body) != original {
			t.Fatalf("%s 重放不能重写新消息：%d %s", trigger, status, body)
		}
	}
}
