package app

// REF41 P6：adopt / mark / submit 人工兜底。adopt 是"这条已经在平台发过了，只
// 登记"；mark 是"平台认不出/链接抓错时手工纠正状态"；submit-now 只在 filled 且
// 桌面在线时给桌面一个一次性提交意图，桌面校验"恰好一个匹配的已填页面"后点
// 一次。三个动作都写事件与幂等；published 只走既有 /works/{id}/published
// （handlePublished），这里不新增第二条 published 写入口。
//
// adopt/mark 的任务投影仍走 transitionPublishTask，其 requirePublishMilestone
// 守卫要求发布里程碑已由既有发布进度服务登记——人工兜底不绕过里程碑纪律。

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	publishManualNoteMax      = 500
	publishSubmitIntentWindow = 10 * time.Minute
)

// publishManualIdempotencyKey 提取并校验 Idempotency-Key（P6-A4）。
func publishManualIdempotencyKey(r *http.Request) (string, error) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		return "", validation("缺少 Idempotency-Key")
	}
	if len(key) > 120 {
		return "", validation("Idempotency-Key 过长")
	}
	return key, nil
}

func publishManualNote(note string) (string, error) {
	text := strings.TrimSpace(note)
	if text == "" || runeLen(text) > publishManualNoteMax {
		return "", validationFields("请填写 1 到 500 字的操作说明", map[string]string{"note": "说明不能为空且不超过 500 字"})
	}
	return text, nil
}

func boolPtr(v bool) *bool { return &v }

func stringOrEmpty(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// publishTaskAdopt：不填写，直接登记为 submitted。事件 kind=adopt、evidence.source=user，
// 不伪造填写历史（filled_at 保持空）。
func (s *Server) publishTaskAdopt(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	idempotencyKey, err := publishManualIdempotencyKey(r)
	if err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		URL         string     `json:"url"`
		PublishedAt *time.Time `json:"published_at"`
		Note        string     `json:"note"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	note, err := publishManualNote(in.Note)
	if err != nil {
		return err
	}
	urlText := strings.TrimSpace(in.URL)
	if urlText == "" {
		return validation("adopt 必须填写平台链接")
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if task.State == "published" || task.State == "submitted" {
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"task": task, "adopted": false, "reason": "already_recorded"})
	}
	evidence := map[string]any{
		"source":      "user",
		"note":        note,
		"url":         urlText,
		"adopted_at":  s.now().UTC().Format(time.RFC3339Nano),
		"idempotency": idempotencyKey,
	}
	if in.PublishedAt != nil {
		evidence["published_at"] = in.PublishedAt.UTC().Format(time.RFC3339Nano)
	}
	out, err := s.transitionPublishTask(r.Context(), task, publishTaskTransitionInput{
		To: "submitted", ExpectedVersion: task.StateVersion, IdempotencyKey: idempotencyKey,
		Evidence: evidence,
	}, false)
	if err != nil {
		// 并发 adopt 已把任务置 submitted：按幂等成功返回原状态。
		current, loadErr := s.loadPublishTaskByID(r.Context(), taskID)
		if loadErr == nil && current.State == "submitted" {
			w.Header().Set("Cache-Control", "no-store")
			return ok(w, map[string]any{"task": current, "adopted": false, "reason": "already_submitted"})
		}
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"task": out, "adopted": true})
}

// publishTaskMark：把任务从非终态向前纠正为 submitted/scheduled/published。
// published 只允许补链接并走既有 handlePublished；不允许 published → submitted 逆向。
func (s *Server) publishTaskMark(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	idempotencyKey, err := publishManualIdempotencyKey(r)
	if err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		To          string     `json:"to"`
		URL         string     `json:"url"`
		ScheduledAt *time.Time `json:"scheduled_at"`
		Note        string     `json:"note"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	note, err := publishManualNote(in.Note)
	if err != nil {
		return err
	}
	to := strings.TrimSpace(in.To)
	switch to {
	case "submitted", "scheduled", "published":
	default:
		return validation("mark 目标只能是 submitted/scheduled/published")
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if task.State == "published" && to != "published" {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "已发布任务只能补链接，不能逆向纠正")
	}
	evidence := map[string]any{
		"source":      "user",
		"note":        note,
		"mark_to":     to,
		"marked_at":   s.now().UTC().Format(time.RFC3339Nano),
		"idempotency": idempotencyKey,
	}
	if urlText := strings.TrimSpace(in.URL); urlText != "" {
		evidence["url"] = urlText
	}
	if in.ScheduledAt != nil {
		evidence["scheduled_at"] = in.ScheduledAt.UTC().Format(time.RFC3339Nano)
	}

	if to == "published" {
		// 唯一 published 写入口仍是既有 /works/{id}/published（handlePublished）。
		// correction 需要 base_publish_revision；尚无发布记录时走 initial 回填。
		var status string
		var rev int
		err := s.db.QueryRow(r.Context(), `SELECT status, publish_revision FROM work w WHERE w.id=$1 AND w.deleted_at IS NULL`, task.WorkID).Scan(&status, &rev)
		if err != nil {
			return err
		}
		var urlPtr *string
		if u := strings.TrimSpace(in.URL); u != "" {
			urlPtr = &u
		}
		// 只有已发布作品可以走 correction 更正；未发布过的作品走 initial 首次回填。
		if status != "published" || rev < 1 {
			return s.handlePublished(w, r, task.WorkID, publishInput{Mode: "initial", URL: urlPtr})
		}
		return s.handlePublished(w, r, task.WorkID, publishInput{
			Mode: "correction", Reason: note, ConfirmPublished: boolPtr(true),
			URL: urlPtr, BasePublishRevision: &rev,
		})
	}
	out, err := s.transitionPublishTask(r.Context(), task, publishTaskTransitionInput{
		To: to, ExpectedVersion: task.StateVersion, IdempotencyKey: idempotencyKey,
		Evidence: evidence, PlatformScheduleAt: in.ScheduledAt,
	}, false)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"task": out, "marked": true})
}

// publishTaskSubmitNow：filled 且桌面通道时写一次性 submit_intent，桌面通过既有
// claim 领取；10 分钟窗口内幂等，重复调用不产生第二次提交意图。
func (s *Server) publishTaskSubmitNow(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	idempotencyKey, err := publishManualIdempotencyKey(r)
	if err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if task.State == "submitted" {
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"task": task, "intent": nil, "reason": "already_submitted"})
	}
	if task.State != "filled" {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有已填入后台（filled）的任务可以立即提交")
	}
	if task.Mode != "desktop" {
		return apiErr(http.StatusConflict, "publish_submit_channel_invalid", "submit-now 只适用于桌面通道；公众号草稿与纯手动通道不适用")
	}
	now := s.now()
	evidence := task.Evidence
	if evidence == nil {
		evidence = map[string]any{}
	}
	if prev, present := evidence["submit_intent"].(map[string]any); present {
		if state, _ := prev["state"].(string); state == "queued" || state == "claimed" {
			if req, err := time.Parse(time.RFC3339Nano, stringOrEmpty(prev["requested_at"])); err == nil && now.Sub(req) < publishSubmitIntentWindow {
				w.Header().Set("Cache-Control", "no-store")
				return ok(w, map[string]any{"task": task, "intent": prev, "reason": "intent_active"})
			}
		}
	}
	evidence["submit_intent"] = map[string]any{
		"state": "queued", "requested_at": now.UTC().Format(time.RFC3339Nano), "idempotency_key": idempotencyKey,
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE publish_task SET evidence=$2, state_version=state_version+1, updated_at=now()
		WHERE id=$1 AND state='filled'`, task.ID, jsonArg(evidence)); err != nil {
		return err
	}
	updated, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "publish.submit_now", "publish_task", taskID.String(), "queued", map[string]any{"idempotency_key": idempotencyKey})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"task": updated, "intent": evidence["submit_intent"], "reason": "intent_queued"})
}
