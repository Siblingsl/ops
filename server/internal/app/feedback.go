package app

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// AI 反馈闭环（10 文档第 3.3 节）：每次 AI 输出的去向，一条 ai_call 对应一条 ai_feedback。

type feedbackInput struct {
	Outcome     *string  `json:"outcome"`
	ChoiceIndex *int     `json:"choice_index"`
	EditRatio   *float64 `json:"edit_ratio"`
	Rating      *int     `json:"rating"`
	ReasonTags  []string `json:"reason_tags"`
	Note        *string  `json:"note"`
}

var feedbackOutcomes = map[string]bool{"accepted": true, "rejected": true, "edited": true, "regenerated": true}
var feedbackReasons = map[string]bool{"太长": true, "太短": true, "跑题": true, "语气不对": true, "编造内容": true, "其他": true}

// recordFeedback upserts the outcome of one AI call; nil fields keep their stored value.
func (s *Server) recordFeedback(ctx context.Context, callID uuid.UUID, in feedbackInput) error {
	var task string
	var ws *uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT c.task_type, coalesce(c.workspace_id, a.workspace_id) FROM ai_call c LEFT JOIN platform_account a ON a.id=c.account_id WHERE c.id=$1`,
		callID).Scan(&task, &ws); err != nil {
		return err
	}
	if id := ident(ctx); id != nil && ws != nil && *ws != id.WorkspaceID {
		return errNotFound
	}
	var user *uuid.UUID
	if id := ident(ctx); id != nil && id.UserID != uuid.Nil {
		user = &id.UserID
	}
	var tags []string
	if in.ReasonTags != nil {
		tags = []string{}
		for _, t := range in.ReasonTags {
			if feedbackReasons[t] {
				tags = append(tags, t)
			}
		}
	}
	var note *string
	if in.Note != nil {
		n := truncate(strings.TrimSpace(*in.Note), 200)
		note = &n
	}
	_, err := s.db.Exec(context.WithoutCancel(ctx), `INSERT INTO ai_feedback (ai_call_id, workspace_id, task_type, outcome, choice_index, edit_ratio, rating, reason_tags, note, user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'{}'::text[]),coalesce($9,''),$10)
		ON CONFLICT (ai_call_id) DO UPDATE SET outcome=coalesce(excluded.outcome, ai_feedback.outcome),
			choice_index=coalesce($5, ai_feedback.choice_index), edit_ratio=coalesce($6, ai_feedback.edit_ratio),
			rating=coalesce($7, ai_feedback.rating), reason_tags=coalesce($8, ai_feedback.reason_tags), note=coalesce($9, ai_feedback.note),
			user_id=coalesce($10, ai_feedback.user_id), updated_at=now()`,
		callID, ws, task, in.Outcome, in.ChoiceIndex, in.EditRatio, in.Rating, tags, note, user)
	return err
}

func (s *Server) implicitFeedback(ctx context.Context, callID uuid.UUID, outcome string, choice *int, ratio *float64) {
	o := outcome
	if err := s.recordFeedback(ctx, callID, feedbackInput{Outcome: &o, ChoiceIndex: choice, EditRatio: ratio}); err != nil {
		slog.Warn("记录 AI 反馈失败", "err", err)
	}
}

func (s *Server) postFeedback(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in feedbackInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Outcome != nil && !feedbackOutcomes[*in.Outcome] {
		return validation("结果只能是接受、放弃、修改后使用或重新生成")
	}
	if in.Rating != nil && (*in.Rating < -1 || *in.Rating > 1) {
		return validation("评价只能是 👍 或 👎")
	}
	if in.ChoiceIndex != nil && (*in.ChoiceIndex < 0 || *in.ChoiceIndex > 20) {
		return validation("候选序号不正确")
	}
	if err := s.recordFeedback(r.Context(), id, in); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// sectionEditRatio is the share of characters changed from the AI raw draft of one section.
func sectionEditRatio(aiRaw, content string) float64 {
	a := []rune(aiRaw)
	if len(a) == 0 {
		return 0
	}
	r := float64(runeDistance(a, []rune(content))) / float64(len(a))
	if r > 1 {
		r = 1
	}
	return r
}
