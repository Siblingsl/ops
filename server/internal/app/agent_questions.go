package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

type agentQuestionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type agentQuestionItem struct {
	ID       string                `json:"id"`
	Title    string                `json:"title"`
	Required bool                  `json:"required"`
	Options  []agentQuestionOption `json:"options"`
}

type agentQuestionAnswer struct {
	QuestionID string `json:"question_id"`
	ChoiceID   string `json:"choice_id,omitempty"`
	Text       string `json:"text,omitempty"`
	Skip       bool   `json:"skip,omitempty"`
}

type agentQuestionView struct {
	ID        uuid.UUID             `json:"id"`
	RunID     uuid.UUID             `json:"run_id"`
	Revision  int64                 `json:"revision"`
	Items     []agentQuestionItem   `json:"items"`
	Answers   []agentQuestionAnswer `json:"answers"`
	Status    string                `json:"status"`
	ExpiresAt time.Time             `json:"expires_at"`
	CreatedAt time.Time             `json:"created_at"`
}

func agentValidateQuestionItems(items []agentQuestionItem) error {
	if len(items) < 1 || len(items) > 3 {
		return apiErr(422, "invalid_arguments", "每次最多提出3个澄清问题")
	}
	seen := map[string]bool{}
	for i := range items {
		items[i].ID, items[i].Title = strings.TrimSpace(items[i].ID), strings.TrimSpace(items[i].Title)
		if items[i].ID == "" || runeLen(items[i].ID) > 80 || seen[items[i].ID] ||
			runeLen(items[i].Title) == 0 || runeLen(items[i].Title) > 200 || len(items[i].Options) < 2 || len(items[i].Options) > 5 {
			return apiErr(422, "invalid_arguments", "问题编号须唯一，题目不超过200字，每题需有2～5个选项")
		}
		seen[items[i].ID] = true
		optionIDs := map[string]bool{}
		for j := range items[i].Options {
			option := &items[i].Options[j]
			option.ID, option.Label = strings.TrimSpace(option.ID), strings.TrimSpace(option.Label)
			if option.ID == "" || runeLen(option.ID) > 80 || optionIDs[option.ID] ||
				runeLen(option.Label) == 0 || runeLen(option.Label) > 200 {
				return apiErr(422, "invalid_arguments", "问题选项编号须唯一，选项文案为1～200字")
			}
			optionIDs[option.ID] = true
		}
	}
	return nil
}

func (s *Server) agentMetaRequestInput(ctx context.Context, st *agentRunState, call ai.ToolCall,
	args map[string]any, send func(string, any)) error {
	if st.ExecutionOrigin != "interactive" {
		return apiErr(403, "forbidden", "后台运行不能向用户发起澄清")
	}
	if err := s.agentExpireQuestions(ctx, st.ConversationID); err != nil {
		return err
	}
	var items []agentQuestionItem
	if err := agentDecodeToolArgument(args, "questions", &items); err != nil {
		return err
	}
	if err := agentValidateQuestionItems(items); err != nil {
		return err
	}
	requestHash, err := agentRequestPayloadHash(items)
	if err != nil {
		return err
	}
	ctx = context.WithoutCancel(ctx)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, st.ConversationID); err != nil {
		return err
	}
	var view agentQuestionView
	var rawItems []byte
	var savedHash string
	err = tx.QueryRow(ctx, `SELECT id,revision,items,answers,status,expires_at,created_at,request_hash
		FROM agent_question WHERE source_run_id=$1`, st.RunID).Scan(&view.ID, &view.Revision, &rawItems,
		&view.Answers, &view.Status, &view.ExpiresAt, &view.CreatedAt, &savedHash)
	if err == nil {
		if savedHash != requestHash {
			return apiErr(409, "agent_request_conflict", "本次运行已提交不同的澄清问题")
		}
		var alreadySaved bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_message WHERE conversation_id=$1 AND run_id=$2
			AND role='tool' AND tool_call_id=$3)`, st.ConversationID, st.RunID, call.ID).Scan(&alreadySaved); err != nil {
			return err
		}
		if !alreadySaved {
			payload, _ := json.Marshal(map[string]any{"ok": true, "question_id": view.ID, "status": "awaiting_input"})
			event, err := s.agentCommitToolOutcomeTx(ctx, tx, st, call,
				agentToolRecord{Raw: payload, Model: payload, Summary: "已向用户提出澄清问题"}, "done")
			if err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			if send != nil {
				send("tool", event)
			}
		} else if err := tx.Commit(ctx); err != nil {
			return err
		}
		st.AwaitingInput = true
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	var anotherPending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending')`,
		st.ConversationID).Scan(&anotherPending); err != nil {
		return err
	}
	if anotherPending {
		return apiErr(409, "agent_question_pending", "当前对话已有待回答的问题")
	}
	itemsJSON, _ := json.Marshal(items)
	view = agentQuestionView{ID: uuid.New(), RunID: st.RunID, Revision: 1, Items: items, Answers: []agentQuestionAnswer{},
		Status: "pending", ExpiresAt: time.Now().Add(24 * time.Hour)}
	if err := tx.QueryRow(ctx, `INSERT INTO agent_question
		(id,conversation_id,source_run_id,source_tool_call_id,request_hash,items,status,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,'pending',$7) RETURNING created_at`,
		view.ID, st.ConversationID, st.RunID, call.ID, requestHash, itemsJSON, view.ExpiresAt).Scan(&view.CreatedAt); err != nil {
		return err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "question.created", map[string]any{
		"question_id": view.ID, "revision": view.Revision, "expires_at": view.ExpiresAt,
	}, nil); err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"ok": true, "question_id": view.ID, "status": "awaiting_input"})
	event, err := s.agentCommitToolOutcomeTx(ctx, tx, st, call,
		agentToolRecord{Raw: payload, Model: payload, Summary: "已向用户提出澄清问题"}, "done")
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	st.AwaitingInput = true
	if send != nil {
		send("question", view)
		send("tool", event)
	}
	return nil
}

func (s *Server) agentExpireQuestions(ctx context.Context, conversationID uuid.UUID) error {
	var expired bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_question WHERE conversation_id=$1 AND status='pending' AND expires_at<=now())`, conversationID).Scan(&expired); err != nil || !expired {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, conversationID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `UPDATE agent_question SET status='expired',revision=revision+1,resolved_at=now()
		WHERE conversation_id=$1 AND status='pending' AND expires_at<=now() RETURNING id,source_run_id,revision`, conversationID)
	if err != nil {
		return err
	}
	type expiredQuestion struct {
		id, runID uuid.UUID
		revision  int64
	}
	updated := []expiredQuestion{}
	for rows.Next() {
		var item expiredQuestion
		if err := rows.Scan(&item.id, &item.runID, &item.revision); err != nil {
			rows.Close()
			return err
		}
		updated = append(updated, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range updated {
		if _, err := appendAgentEventTx(ctx, tx, conversationID, &item.runID, "question.resolved", map[string]any{
			"question_id": item.id, "revision": item.revision, "status": "expired",
		}, nil); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Server) agentLoadQuestions(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID) ([]agentQuestionView, error) {
	rows, err := tx.Query(ctx, `SELECT id,source_run_id,revision,items,answers,status,expires_at,created_at
		FROM agent_question WHERE conversation_id=$1 ORDER BY created_at DESC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	questions := []agentQuestionView{}
	for rows.Next() {
		var item agentQuestionView
		var itemsRaw, answersRaw []byte
		if err := rows.Scan(&item.ID, &item.RunID, &item.Revision, &itemsRaw, &answersRaw, &item.Status, &item.ExpiresAt, &item.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(itemsRaw, &item.Items); err != nil {
			return nil, err
		}
		item.Answers = []agentQuestionAnswer{}
		if err := json.Unmarshal(answersRaw, &item.Answers); err != nil {
			return nil, err
		}
		questions = append(questions, item)
	}
	return questions, rows.Err()
}

type agentQuestionAnswerRequest struct {
	ProtocolVersion  int                   `json:"protocol_version"`
	ExpectedRevision int64                 `json:"expected_revision"`
	RequestID        string                `json:"request_id"`
	Answers          []agentQuestionAnswer `json:"answers"`
}

func agentValidateQuestionAnswers(items []agentQuestionItem, answers []agentQuestionAnswer) ([]agentQuestionAnswer, string, error) {
	if len(answers) != len(items) {
		return nil, "", validation("必须一次回答整组澄清问题")
	}
	byID := make(map[string]agentQuestionItem, len(items))
	for _, item := range items {
		byID[item.ID] = item
	}
	seen := map[string]bool{}
	total := 0
	lines := []string{"澄清问题的回答："}
	for i := range answers {
		answer := &answers[i]
		answer.QuestionID = strings.TrimSpace(answer.QuestionID)
		answer.ChoiceID = strings.TrimSpace(answer.ChoiceID)
		answer.Text = strings.TrimSpace(answer.Text)
		item, ok := byID[answer.QuestionID]
		if !ok || seen[answer.QuestionID] {
			return nil, "", validation("回答的问题编号无效或重复")
		}
		seen[answer.QuestionID] = true
		if answer.Skip {
			if item.Required || answer.ChoiceID != "" || answer.Text != "" {
				return nil, "", validation("必答问题不能跳过，跳过时不能同时填写答案")
			}
			lines = append(lines, item.Title+"：已跳过")
			continue
		}
		if answer.ChoiceID != "" && answer.Text != "" || answer.ChoiceID == "" && answer.Text == "" {
			return nil, "", validation("每个问题请选择一个建议或填写自定义答案")
		}
		value := answer.Text
		if answer.ChoiceID != "" {
			found := false
			for _, option := range item.Options {
				if option.ID == answer.ChoiceID {
					value, found = option.Label, true
				}
			}
			if !found {
				return nil, "", validation("回答选项不属于该问题")
			}
		}
		if runeLen(value) > 2000 {
			return nil, "", validation("每个问题的回答不能超过2000字")
		}
		total += runeLen(item.Title) + runeLen(value)
		lines = append(lines, item.Title+"："+value)
	}
	if total > 2000 {
		return nil, "", validation("整组澄清回答不能超过2000字")
	}
	return answers, strings.Join(lines, "\n"), nil
}

func (s *Server) postAgentQuestionAnswer(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("plans"); err != nil {
		return err
	}
	if ident(r.Context()).Role == "viewer" {
		return apiErr(403, "forbidden", "观察者不能提交澄清答案")
	}
	questionID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil || questionID == uuid.Nil {
		return errNotFound
	}
	var req agentQuestionAnswerRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ProtocolVersion != 2 {
		return apiErr(422, "validation_failed", "澄清回答需要使用智能体协议版本2")
	}
	if err := requireAgentFeature("event_resume"); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil || req.ExpectedRevision < 1 {
		return validation("澄清回答需要有效的expected_revision和request_id")
	}
	var questionConversationID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT conversation_id FROM agent_question WHERE id=$1
		AND conversation_id IN (SELECT id FROM agent_conversation WHERE workspace_id=$2 AND user_id=$3)`,
		questionID, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID).Scan(&questionConversationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if err := s.agentExpireQuestions(r.Context(), questionConversationID); err != nil {
		return err
	}
	var itemsRaw []byte
	var revision int64
	var status string
	var expiresAt time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT items,revision,status,expires_at FROM agent_question WHERE id=$1`, questionID).
		Scan(&itemsRaw, &revision, &status, &expiresAt); err != nil {
		return err
	}
	var items []agentQuestionItem
	if err := json.Unmarshal(itemsRaw, &items); err != nil {
		return err
	}
	answers, text, err := agentValidateQuestionAnswers(items, req.Answers)
	if err != nil {
		return err
	}
	payload := map[string]any{"question_id": questionID, "expected_revision": req.ExpectedRevision, "answers": answers}
	protocol := &agentRunProtocolRequest{RequestID: requestID, Payload: payload}
	runID, after, found, err := s.existingAgentRunRequest(r.Context(), questionConversationID, "answer", protocol)
	if err != nil {
		return err
	}
	if found {
		messageID, err := agentRunMessageID(r.Context(), s.db, questionConversationID, runID)
		if err != nil {
			return err
		}
		writeAgentRunAccepted(w, questionConversationID, runID, messageID, after)
		return nil
	}
	if revision != req.ExpectedRevision || status != "pending" || !time.Now().Before(expiresAt) {
		return apiErr(409, "agent_revision_conflict", "澄清问题已变化、过期或已由另一端处理")
	}
	conv, err := s.agentConversationFor(r.Context(), questionConversationID)
	if err != nil {
		return err
	}
	selected := *conv
	prepared, err := s.agentPrepareRun(r.Context(), conv, &selected, "answer", protocol,
		func(tx pgx.Tx, c *agentConversation) (*uuid.UUID, bool, error) {
			var currentRevision int64
			var currentStatus string
			var raw []byte
			if err := tx.QueryRow(r.Context(), `SELECT revision,status,items,expires_at FROM agent_question
				WHERE id=$1 AND conversation_id=$2 FOR UPDATE`, questionID, c.ID).
				Scan(&currentRevision, &currentStatus, &raw, &expiresAt); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, false, errNotFound
				}
				return nil, false, err
			}
			if currentRevision != req.ExpectedRevision || currentStatus != "pending" || !time.Now().Before(expiresAt) {
				return nil, false, apiErr(409, "agent_revision_conflict", "澄清问题已变化、过期或已由另一端处理")
			}
			questionStatus := "answered"
			allSkipped := len(answers) > 0
			for _, answer := range answers {
				allSkipped = allSkipped && answer.Skip
			}
			if allSkipped {
				questionStatus = "skipped"
			}
			if _, err := tx.Exec(r.Context(), `UPDATE agent_question SET answers=$2,status=$3,revision=revision+1,
				answered_message_id=NULL,resolved_at=now() WHERE id=$1`, questionID, mustJSON(answers), questionStatus); err != nil {
				return nil, false, err
			}
			message, err := s.agentInsertRowTx(r.Context(), tx, c.ID, nil, "user", text, nil, "", "", nil)
			if err != nil {
				return nil, false, err
			}
			if _, err := tx.Exec(r.Context(), `UPDATE agent_question SET answered_message_id=$2 WHERE id=$1`, questionID, message.ID); err != nil {
				return nil, false, err
			}
			if _, err := appendAgentEventTx(r.Context(), tx, c.ID, nil, "question.resolved", map[string]any{
				"question_id": questionID, "revision": currentRevision + 1, "status": questionStatus,
			}, nil); err != nil {
				return nil, false, err
			}
			return &message.ID, false, nil
		})
	if err != nil {
		return err
	}
	if prepared.Replayed {
		return writeAgentPreparedReplay(w, questionConversationID, prepared)
	}
	return s.agentStreamPreparedRun(w, r, conv, protocol, prepared)
}
