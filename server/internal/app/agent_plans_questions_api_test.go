package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestAW07PlanQuestionLifecycleAndIdempotency(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	path := "/api/v1/agent/conversations/" + conversation.ID.String()
	var plannedMode agentConversation
	env.mustJSON(t, http.MethodPatch, path, map[string]any{"expected_revision": conversation.Revision, "mode": "plan"}, &plannedMode)

	planArgs := map[string]any{"summary": "核对近期内容并形成建议", "steps": []map[string]any{
		{"id": "read", "title": "读取近期内容", "target_ref": "当前账号", "acceptance": "引用已保存的读取结果"},
		{"id": "draft", "title": "形成建议", "acceptance": "产出待审阅操作卡片"},
	}}
	questionArgs := map[string]any{"questions": []map[string]any{{"id": "focus", "title": "优先关注什么？", "required": true,
		"options": []map[string]string{{"id": "reach", "label": "提升触达"}, {"id": "save", "label": "增加收藏"}}}}}
	message := fmt.Sprintf("先保存计划并询问目标\n#tool present_plan %s\n#tool request_input %s", mustJSON(planArgs), mustJSON(questionArgs))
	status, body := env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": message, "mode": "plan", "request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("plan/question run not accepted: %d %s", status, body)
	}
	runID := aw06WaitRun(t, body)
	var runStatus string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, runID).Scan(&runStatus); err != nil || runStatus != "awaiting_input" {
		t.Fatalf("request_input must finish the run awaiting input: %s %v", runStatus, err)
	}
	var detail struct {
		Plans     []agentPlanView     `json:"plans"`
		Questions []agentQuestionView `json:"questions"`
		Actions   []agentActionView   `json:"actions"`
	}
	env.mustJSON(t, http.MethodGet, path, nil, &detail)
	if len(detail.Plans) != 1 || detail.Plans[0].Version != 1 || len(detail.Plans[0].StepStates) != 2 ||
		len(detail.Questions) != 1 || detail.Questions[0].Status != "pending" || len(detail.Actions) != 0 {
		t.Fatalf("plan and question snapshot mismatch: %+v", detail)
	}
	planID, questionID := detail.Plans[0].ID, detail.Questions[0].ID
	answerRequest := map[string]any{"protocol_version": 2, "expected_revision": detail.Questions[0].Revision, "request_id": uuid.NewString(),
		"answers": []map[string]any{{"question_id": "focus", "choice_id": "reach"}}}
	answerPath := "/api/v1/agent/questions/" + questionID.String() + "/answer"
	status, acceptedAnswer := env.do(http.MethodPost, answerPath, answerRequest)
	if status != http.StatusAccepted {
		t.Fatalf("answer run not accepted: %d %s", status, acceptedAnswer)
	}
	answerRunID := aw06WaitRun(t, acceptedAnswer)
	status, replayedAnswer := env.do(http.MethodPost, answerPath, answerRequest)
	if status != http.StatusAccepted || aw06WaitRun(t, replayedAnswer) != answerRunID {
		t.Fatalf("same answer request must replay the original run: %d %s", status, replayedAnswer)
	}
	var savedAnswers []agentQuestionAnswer
	if err := env.srv.db.QueryRow(t.Context(), `SELECT answers FROM agent_question WHERE id=$1`, questionID).Scan(&savedAnswers); err != nil || len(savedAnswers) != 1 || savedAnswers[0].ChoiceID != "reach" {
		t.Fatalf("answer not atomically saved: %+v %v", savedAnswers, err)
	}

	acceptRequest := map[string]any{"protocol_version": 2, "expected_version": 1, "request_id": uuid.NewString()}
	acceptPath := "/api/v1/agent/plans/" + planID.String() + "/accept"
	status, acceptedPlan := env.do(http.MethodPost, acceptPath, acceptRequest)
	if status != http.StatusAccepted {
		t.Fatalf("accepted plan run not started: %d %s", status, acceptedPlan)
	}
	planRunID := aw06WaitRun(t, acceptedPlan)
	status, replayedPlan := env.do(http.MethodPost, acceptPath, acceptRequest)
	if status != http.StatusAccepted || aw06WaitRun(t, replayedPlan) != planRunID {
		t.Fatalf("same plan request must replay the original run: %d %s", status, replayedPlan)
	}
	var mode, trigger string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT mode,trigger FROM agent_run WHERE id=$1`, planRunID).Scan(&mode, &trigger); err != nil || mode != "execute" || trigger != "plan_accept" {
		t.Fatalf("plan acceptance must start an execute run: mode=%s trigger=%s err=%v", mode, trigger, err)
	}
	var planAccepted bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT accepted_at IS NOT NULL FROM agent_plan WHERE id=$1`, planID).Scan(&planAccepted); err != nil || !planAccepted {
		t.Fatalf("accepted_at not saved: %v %v", planAccepted, err)
	}

	newQuestion := map[string]any{"questions": []map[string]any{{"id": "replace", "title": "还要补充什么？", "required": true,
		"options": []map[string]string{{"id": "a", "label": "A"}, {"id": "b", "label": "B"}}}}}
	status, body = env.do(http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": fmt.Sprintf("再次澄清\n#tool request_input %s", mustJSON(newQuestion)), "request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("second question run not accepted: %d %s", status, body)
	}
	aw06WaitRun(t, body)
	env.expectErr(t, http.MethodPost, agentRunPath(conversation, "messages"), map[string]any{
		"text": "改为另一个任务", "request_id": uuid.NewString(), "protocol_version": 2,
	}, "agent_question_pending")
	var pendingQuestionID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id FROM agent_question WHERE conversation_id=$1 AND status='pending'`, conversation.ID).Scan(&pendingQuestionID); err != nil {
		t.Fatal(err)
	}
	replacementRequest := map[string]any{"text": "改为另一个任务", "request_id": uuid.NewString(), "protocol_version": 2,
		"supersede_question_id": pendingQuestionID}
	status, replacement := env.do(http.MethodPost, agentRunPath(conversation, "messages"), replacementRequest)
	if status != http.StatusAccepted {
		t.Fatalf("explicit question replacement not accepted: %d %s", status, replacement)
	}
	replacementRunID := aw06WaitRun(t, replacement)
	status, replayedReplacement := env.do(http.MethodPost, agentRunPath(conversation, "messages"), replacementRequest)
	if status != http.StatusAccepted || aw06WaitRun(t, replayedReplacement) != replacementRunID {
		t.Fatalf("same replacement request must replay original run: %d %s", status, replayedReplacement)
	}
	var questionStatus string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_question WHERE id=$1`, pendingQuestionID).Scan(&questionStatus); err != nil || questionStatus != "superseded" {
		t.Fatalf("explicit replacement must resolve the question: %s %v", questionStatus, err)
	}

	outsider := env.registerClient(t, "aw07-outsider-"+uuid.NewString()[:8], testPassword)
	defer outsider.restore(env)
	outsider.expectErr(t, http.MethodPost, "/api/v1/agent/plans/"+planID.String()+"/accept", acceptRequest, "not_found")
	outsider.expectErr(t, http.MethodPost, "/api/v1/agent/questions/"+questionID.String()+"/answer", answerRequest, "not_found")

	var raw json.RawMessage
	if err := env.srv.db.QueryRow(t.Context(), `SELECT config_snapshot FROM agent_run WHERE id=$1`, planRunID).Scan(&raw); err != nil || len(raw) == 0 {
		t.Fatalf("plan acceptance run snapshot missing: %s %v", raw, err)
	}
}

func TestAW07QuestionExpiryAndConcurrentAnswerCAS(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "event_resume,plans")
	provider := env.ensureToolModel(t)
	conversation := env.agentRunConversation(t, provider)
	defer deleteConversations(t, conversation.ID)
	path := agentRunPath(conversation, "messages")

	newQuestion := func(id string) uuid.UUID {
		t.Helper()
		args := map[string]any{"questions": []map[string]any{{"id": id, "title": "本次优先关注什么？", "required": true,
			"options": []map[string]string{{"id": "reach", "label": "提升触达"}, {"id": "save", "label": "增加收藏"}}}}}
		status, body := env.do(http.MethodPost, path, map[string]any{"text": "请提出一个澄清问题\n#tool request_input " + string(mustJSON(args)),
			"request_id": uuid.NewString(), "protocol_version": 2})
		if status != http.StatusAccepted {
			t.Fatalf("request_input run not accepted: %d %s", status, body)
		}
		aw06WaitRun(t, body)
		var detail struct {
			Questions []agentQuestionView `json:"questions"`
		}
		env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conversation.ID.String(), nil, &detail)
		for _, question := range detail.Questions {
			if question.Status == "pending" {
				return question.ID
			}
		}
		t.Fatal("request_input did not leave a pending question")
		return uuid.Nil
	}

	var planMode agentConversation
	env.mustJSON(t, http.MethodPatch, "/api/v1/agent/conversations/"+conversation.ID.String(),
		map[string]any{"expected_revision": conversation.Revision, "mode": "plan"}, &planMode)
	expiredID := newQuestion("expired")
	var revision int64
	if err := env.srv.db.QueryRow(t.Context(), `UPDATE agent_question SET expires_at=now()-interval '1 second'
		WHERE id=$1 RETURNING revision`, expiredID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	answerPath := "/api/v1/agent/questions/" + expiredID.String() + "/answer"
	expiredAnswer := map[string]any{"protocol_version": 2, "expected_revision": revision, "request_id": uuid.NewString(),
		"answers": []map[string]string{{"question_id": "expired", "choice_id": "reach"}}}
	env.expectErr(t, http.MethodPost, answerPath, expiredAnswer, "agent_revision_conflict")
	var status string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_question WHERE id=$1`, expiredID).Scan(&status); err != nil || status != "expired" {
		t.Fatalf("expired question must remain expired without starting a run: status=%s err=%v", status, err)
	}

	pendingID := newQuestion("concurrent")
	var pendingRevision int64
	if err := env.srv.db.QueryRow(t.Context(), `SELECT revision FROM agent_question WHERE id=$1`, pendingID).Scan(&pendingRevision); err != nil {
		t.Fatal(err)
	}
	concurrentPath := "/api/v1/agent/questions/" + pendingID.String() + "/answer"
	start := make(chan struct{})
	type result struct {
		status int
		body   []byte
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		request := map[string]any{"protocol_version": 2, "expected_revision": pendingRevision, "request_id": uuid.NewString(),
			"answers": []map[string]string{{"question_id": "concurrent", "choice_id": "reach"}}}
		go func() {
			<-start
			status, body := env.do(http.MethodPost, concurrentPath, request)
			results <- result{status: status, body: body}
		}()
	}
	close(start)
	accepted, rejected := 0, 0
	for i := 0; i < 2; i++ {
		response := <-results
		switch response.status {
		case http.StatusAccepted:
			accepted++
			aw06WaitRun(t, response.body)
		case http.StatusConflict:
			rejected++
		default:
			t.Fatalf("concurrent answer returned unexpected status %d: %s", response.status, response.body)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("two clients must produce one answer run and one CAS conflict: accepted=%d rejected=%d", accepted, rejected)
	}
	var answerRuns int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE conversation_id=$1 AND trigger='answer'`, conversation.ID).Scan(&answerRuns); err != nil || answerRuns != 1 {
		t.Fatalf("concurrent answer created %d runs, want 1: %v", answerRuns, err)
	}
}
