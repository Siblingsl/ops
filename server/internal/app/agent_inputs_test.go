package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAW08InputsPersistReplayAndCAS(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	me := env.me(t)
	runID := agentInsertRun(t, conversation.ID, uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID),
		uuid.MustParse(provider), "running", "message")
	attachmentStatus, attachment, attachmentBody := agentUploadAttachment(t, "待复核附件.txt", []byte("待复核资料"), conversation.ID.String())
	if attachmentStatus != http.StatusOK {
		t.Fatalf("upload queued attachment: %d %s", attachmentStatus, attachmentBody)
	}
	path := "/api/v1/agent/conversations/" + conversation.ID.String() + "/inputs"
	requestID := uuid.NewString()
	body := map[string]any{"request_id": requestID, "kind": "queue", "text": "整理为报告", "attachment_ids": []string{attachment.ID.String()}}
	status, data := env.do(http.MethodPost, path, body)
	if status != http.StatusAccepted {
		t.Fatalf("queue input: %d %s", status, data)
	}
	var input struct {
		ID        uuid.UUID `json:"id"`
		Revision  int64     `json:"revision"`
		Status    string    `json:"status"`
		ErrorCode string    `json:"error_code"`
	}
	if err := json.Unmarshal(data, &input); err != nil || input.ID == uuid.Nil || input.Revision != 2 ||
		input.Status != "pending" || input.ErrorCode != "agent_run_busy" {
		t.Fatalf("queue receipt should explain the current run blocker: %+v %v %s", input, err, data)
	}
	status, data = env.do(http.MethodPost, path, body)
	var replay struct {
		ID uuid.UUID `json:"id"`
	}
	if err := json.Unmarshal(data, &replay); status != http.StatusAccepted || err != nil || replay.ID != input.ID {
		t.Fatalf("same request should return original input: %d %s", status, data)
	}
	var detail struct {
		Inputs []agentInputView `json:"inputs"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String(), nil, &detail)
	if len(detail.Inputs) != 1 || len(detail.Inputs[0].Attachments) != 1 || detail.Inputs[0].Attachments[0].ID != attachment.ID ||
		!strings.Contains(detail.Inputs[0].Attachments[0].URL, "conversation_id="+conversation.ID.String()) {
		t.Fatalf("input detail must restore attachment metadata within its conversation: %+v", detail.Inputs)
	}
	env.expectErr(t, http.MethodPost, path, map[string]any{"request_id": requestID, "kind": "queue", "text": "不同内容"}, "agent_request_conflict")
	inputPath := "/api/v1/agent/inputs/" + input.ID.String()
	env.expectErr(t, http.MethodPatch, inputPath, map[string]any{"expected_revision": 1, "text": "过期编辑"}, "agent_revision_conflict")
	var updated struct {
		Revision int64  `json:"revision"`
		Text     string `json:"text"`
	}
	env.mustJSON(t, http.MethodPatch, inputPath, map[string]any{"expected_revision": input.Revision, "text": "只整理本周"}, &updated)
	if updated.Revision != input.Revision+1 || updated.Text != "只整理本周" {
		t.Fatalf("edit must advance revision: %+v", updated)
	}
	env.expectErr(t, http.MethodDelete, inputPath, map[string]any{"expected_revision": input.Revision}, "agent_revision_conflict")
	env.mustJSON(t, http.MethodDelete, inputPath, map[string]any{"expected_revision": updated.Revision}, nil)
	var state string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_input WHERE id=$1`, input.ID).Scan(&state); err != nil || state != "cancelled" {
		t.Fatalf("cancel must persist: %q %v", state, err)
	}
	_, _ = env.srv.db.Exec(t.Context(), `UPDATE agent_run SET status='stopped',stage='stopped',finished_at=now() WHERE id=$1`, runID)
}

func TestAW08SteerMustTargetActiveRunAndInputLimit(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	me := env.me(t)
	runID := agentInsertRun(t, conversation.ID, uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID),
		uuid.MustParse(provider), "running", "message")
	path := "/api/v1/agent/conversations/" + conversation.ID.String() + "/inputs"
	env.expectErr(t, http.MethodPost, path, map[string]any{"request_id": uuid.NewString(), "kind": "steer", "run_id": uuid.NewString(), "text": "范围"}, "agent_run_busy")
	for i := 0; i < 5; i++ {
		status, data := env.do(http.MethodPost, path, map[string]any{"request_id": uuid.NewString(), "kind": "steer", "run_id": runID.String(), "text": "只看小红书"})
		if status != http.StatusAccepted {
			t.Fatalf("input %d: %d %s", i, status, data)
		}
	}
	env.expectErr(t, http.MethodPost, path, map[string]any{"request_id": uuid.NewString(), "kind": "queue", "text": "第六条"}, "agent_input_limit")
	_, _ = env.srv.db.Exec(t.Context(), `UPDATE agent_run SET status='stopped',stage='stopped',finished_at=now() WHERE id=$1`, runID)
}

func TestAW08SteerConsumedOnceAtBoundaryAndLateInputNeedsReview(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "run_control,event_resume")
	ctx, st := aw06ToolRun(t)
	path := "/api/v1/agent/conversations/" + st.ConversationID.String() + "/inputs"
	post := func(text string) uuid.UUID {
		t.Helper()
		status, data := env.do(http.MethodPost, path, map[string]any{
			"request_id": uuid.NewString(), "kind": "steer", "run_id": st.RunID.String(), "text": text,
		})
		var v struct {
			ID uuid.UUID `json:"id"`
		}
		if err := json.Unmarshal(data, &v); status != http.StatusAccepted || err != nil || v.ID == uuid.Nil {
			t.Fatalf("submit steer: %d %s", status, data)
		}
		return v.ID
	}
	first := post("只分析小红书")
	if err := env.srv.agentConsumeSteers(ctx, st); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.agentConsumeSteers(ctx, st); err != nil {
		t.Fatal(err)
	}
	var status, text string
	var messages int
	if err := env.srv.db.QueryRow(ctx, `SELECT i.status,m.content,(SELECT count(*) FROM agent_message WHERE run_id=$2 AND role='user')
		FROM agent_input i JOIN agent_message m ON m.id=i.consumed_message_id WHERE i.id=$1`, first, st.RunID).Scan(&status, &text, &messages); err != nil || status != "consumed" || text != "只分析小红书" || messages != 1 {
		t.Fatalf("steer must be consumed once in same run: %s %s %d %v", status, text, messages, err)
	}
	late := post("改成公众号")
	env.srv.finishAgentRun(ctx, st, "completed", "", nil)
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM agent_input WHERE id=$1`, late).Scan(&status); err != nil || status != "needs_review" {
		t.Fatalf("unconsumed steer must need review after completion: %s %v", status, err)
	}
}
