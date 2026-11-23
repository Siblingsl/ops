package app

// REF41 I2：竞对作品半自动拆解。
// AI 只写 decompose_draft；structure/structure_hash/takeaways/not_borrowable 只在用户确认后更新。
// 同一 note 的初拆在进程内串行，模型调用不持有数据库行锁；落账用短事务复核并发。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const benchmarkDecomposeTaskType = "benchmark_decompose"

type benchmarkDecomposeDraft struct {
	Hook          string   `json:"hook"`
	Structure     []string `json:"structure"`
	Rhythm        string   `json:"rhythm"`
	Takeaways     []string `json:"takeaways"`
	NotBorrowable []string `json:"not_borrowable"`
	Confidence    float64  `json:"confidence"`
}

type benchmarkDecomposeResponse struct {
	Note   benchmarkNote `json:"note"`
	Reused bool          `json:"reused"`
}

func (s *Server) benchmarkDecomposePrompt(note benchmarkNote, platform string) string {
	metrics, _ := json.Marshal(note.MetricsSnapshot)
	current, _ := json.Marshal(note.Structure)
	takeaways, _ := json.Marshal(note.Takeaways)
	notBorrowable, _ := json.Marshal(note.NotBorrowable)
	return fmt.Sprintf(`只根据下面这条竞对笔记的原文摘要与现有信息做结构拆解，输出一个 JSON 对象，不要输出 JSON 以外的文字。

笔记标题：%s
原文摘要（用户提供，最多 4000 字）：%s
平台：%s
来源 URL：%s
指标快照：%s
当前手工结构（可能为空）：%s
现有可借鉴点（可能为空）：%s
现有不借鉴点（可能为空）：%s

输出字段与约束：
{
  "hook": "开头钩子，1..200 字",
  "structure": ["段落/结构要点，1..8 项，每项 1..200 字"],
  "rhythm": "节奏概括，1..200 字",
  "takeaways": ["可借鉴点，0..8 项，每项 1..200 字"],
  "not_borrowable": ["不可借鉴点，0..8 项，每项 1..200 字"],
  "confidence": 0.0
}

规则：
- 只拆原文摘要呈现的结构和方法，用自己的话概括，不复制原文句子，不生成正文、链接或操作建议。
- 不得编造播放量、粉丝数、互动数据；没有指标数据时 confidence 必须小于 0.5。
- 不要因为标题或指标少就补造不存在的段落。摘要信息不足时给出保守的结构假设，并降低 confidence。`,
		truncate(strings.TrimSpace(note.Title), 200), truncate(strings.TrimSpace(note.ContentSummary), 4000),
		platform, truncate(note.URL, 500),
		truncate(string(metrics), 1200), truncate(string(current), 1800),
		truncate(string(takeaways), 800), truncate(string(notBorrowable), 800))
}

func benchmarkDecomposeHasMetrics(note benchmarkNote) bool {
	for _, value := range note.MetricsSnapshot {
		if value == nil {
			continue
		}
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return true
			}
		case []any:
			if len(typed) > 0 {
				return true
			}
		case map[string]any:
			if len(typed) > 0 {
				return true
			}
		default:
			return true
		}
	}
	return false
}

func validateBenchmarkDecomposeText(label, value string, required bool, max int) (string, error) {
	value = strings.TrimSpace(value)
	if !required && value == "" {
		return "", nil
	}
	if value == "" {
		return "", validation(label + "不能为空")
	}
	if len([]rune(value)) > max {
		return "", validation(fmt.Sprintf("%s最多 %d 字", label, max))
	}
	return value, nil
}

func validateBenchmarkDecomposeItems(label string, items []string, max int) ([]string, error) {
	if len(items) > max {
		return nil, validation(fmt.Sprintf("%s最多 %d 项", label, max))
	}
	clean := make([]string, len(items))
	for index, item := range items {
		text, err := validateBenchmarkDecomposeText(fmt.Sprintf("%s第 %d 项", label, index+1), item, true, 200)
		if err != nil {
			return nil, err
		}
		clean[index] = text
	}
	return clean, nil
}

// validateBenchmarkDecomposeDraft 同时用于 AI 输出校验和用户确认前校验。
func validateBenchmarkDecomposeDraft(draft *benchmarkDecomposeDraft, hasMetrics bool) error {
	hook, err := validateBenchmarkDecomposeText("hook", draft.Hook, true, 200)
	if err != nil {
		return err
	}
	draft.Hook = hook
	rhythm, err := validateBenchmarkDecomposeText("rhythm", draft.Rhythm, true, 200)
	if err != nil {
		return err
	}
	draft.Rhythm = rhythm
	if len(draft.Structure) == 0 {
		return validation("structure 至少需要 1 项")
	}
	if draft.Structure, err = validateBenchmarkDecomposeItems("structure", draft.Structure, 8); err != nil {
		return err
	}
	if draft.Takeaways, err = validateBenchmarkDecomposeItems("takeaways", draft.Takeaways, 8); err != nil {
		return err
	}
	if draft.NotBorrowable, err = validateBenchmarkDecomposeItems("not_borrowable", draft.NotBorrowable, 8); err != nil {
		return err
	}
	if math.IsNaN(draft.Confidence) || math.IsInf(draft.Confidence, 0) || draft.Confidence < 0 || draft.Confidence > 1 {
		return validation("confidence 必须在 0..1 之间")
	}
	if !hasMetrics && draft.Confidence >= 0.5 {
		return validation("没有指标数据时 confidence 必须小于 0.5")
	}
	return nil
}

func benchmarkDraftFromMap(raw map[string]any) (benchmarkDecomposeDraft, error) {
	var draft benchmarkDecomposeDraft
	if len(raw) == 0 {
		return draft, nil
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return draft, err
	}
	if err := json.Unmarshal(payload, &draft); err != nil {
		return draft, validation("拆解草稿字段格式不正确")
	}
	return draft, nil
}

func benchmarkDraftMap(draft benchmarkDecomposeDraft) (map[string]any, []byte, error) {
	payload, err := json.Marshal(draft)
	if err != nil {
		return nil, nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, nil, err
	}
	return out, payload, nil
}

// benchmarkDecomposeLocks 只串行同一进程内同一 note 的初拆，避免两个并发请求各调一次模型；
// 这不是数据库锁，模型调用期间不持有 benchmark_note 行锁。跨进程仍可能各调一次，落账时
// 由第二段短事务复用先完成的草稿，不会写两份 draft。
var benchmarkDecomposeLocks sync.Map // map[uuid.UUID]*sync.Mutex

func lockBenchmarkDecompose(noteID uuid.UUID) func() {
	value, _ := benchmarkDecomposeLocks.LoadOrStore(noteID, &sync.Mutex{})
	lock := value.(*sync.Mutex)
	lock.Lock()
	return lock.Unlock
}

// beginBenchmarkDecompose 完成一次拆解；reused=true 表示返回已有 ai_draft，不重复调用模型。
// I2-D3：模型调用必须放在数据库事务与行锁之外，否则超过 idle_in_transaction_session_timeout
// 或断连时 failed 不落库，并会长时间阻塞同 note 的 confirm/discard/PATCH。
func (s *Server) beginBenchmarkDecompose(ctx context.Context, noteID uuid.UUID) (benchmarkNote, bool, error) {
	workspaceID := ident(ctx).WorkspaceID
	unlock := lockBenchmarkDecompose(noteID)
	defer unlock()

	// 第一段只读：校验归属/状态并取 AI 输入；这里不持锁、不开事务。
	note, err := scanBenchmarkNote(s.db.QueryRow(ctx, `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE id=$1 AND workspace_id=$2`, noteID, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return benchmarkNote{}, false, errNotFound
	}
	if err != nil {
		return benchmarkNote{}, false, err
	}
	if note.ArchivedAt != nil {
		return benchmarkNote{}, false, apiErr(409, "benchmark_archived", "已归档笔记只能先恢复再拆解")
	}
	if strings.TrimSpace(note.ContentSummary) == "" {
		return benchmarkNote{}, false, apiErr(422, "benchmark_content_required", "请先补充原文摘要（最多 4000 字），AI 初拆需要作品内容；只保存摘要，不保存全文")
	}
	if note.DecomposeState == "ai_draft" && note.DecomposeAICallID != nil && len(note.DecomposeDraft) > 0 {
		return note, true, nil
	}

	var platform string
	if err := s.db.QueryRow(ctx, `SELECT platform FROM benchmark_target WHERE id=$1 AND workspace_id=$2`,
		note.TargetID, workspaceID).Scan(&platform); err != nil {
		return benchmarkNote{}, false, err
	}

	// 模型调用在事务外；ai_call 由 runAIJSON 自行落账，不再随拆解事务回滚成孤儿。
	baseRevision, baseSummary := note.Revision, note.ContentSummary
	var draft benchmarkDecomposeDraft
	hasMetrics := benchmarkDecomposeHasMetrics(note)
	res, aiErr := s.runAIJSON(ctx, aiTask{
		Type: benchmarkDecomposeTaskType,
		User: s.benchmarkDecomposePrompt(note, platform),
		Bare: true,
	}, &draft, func() error { return validateBenchmarkDecomposeDraft(&draft, hasMetrics) })

	// 第二段短事务：只锁行做并发复核与落账，不再等模型。
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return benchmarkNote{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := scanBenchmarkNote(tx.QueryRow(ctx, `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, noteID, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return benchmarkNote{}, false, errNotFound
	}
	if err != nil {
		return benchmarkNote{}, false, err
	}
	if current.ArchivedAt != nil {
		return benchmarkNote{}, false, apiErr(409, "benchmark_archived", "已归档笔记只能先恢复再拆解")
	}
	if current.DecomposeState == "ai_draft" && current.DecomposeAICallID != nil && len(current.DecomposeDraft) > 0 {
		// 并发请求先完成：直接复用，避免把后一次 AI 结果覆盖到已生成的草稿上。
		if err := tx.Commit(ctx); err != nil {
			return benchmarkNote{}, false, err
		}
		return current, true, nil
	}
	if current.Revision != baseRevision || current.ContentSummary != baseSummary {
		return benchmarkNote{}, false, apiErr(409, "benchmark_decompose_conflict", "笔记内容在拆解期间已变化，请重新发起初拆")
	}
	if aiErr != nil {
		if _, updateErr := tx.Exec(ctx, `UPDATE benchmark_note
			SET decompose_state='failed',decompose_error=$3,
				decompose_draft='{}'::jsonb,decompose_ai_call_id=NULL,updated_at=now()
			WHERE id=$1 AND workspace_id=$2`, current.ID, workspaceID, truncate(aiErr.Error(), 200)); updateErr != nil {
			return benchmarkNote{}, false, updateErr
		}
		if err := tx.Commit(ctx); err != nil {
			return benchmarkNote{}, false, err
		}
		return current, false, aiErr
	}

	draftMap, _, err := benchmarkDraftMap(draft)
	if err != nil {
		return benchmarkNote{}, false, err
	}
	draftJSON, err := json.Marshal(draftMap)
	if err != nil {
		return benchmarkNote{}, false, err
	}
	updated, err := scanBenchmarkNote(tx.QueryRow(ctx, `UPDATE benchmark_note
		SET decompose_state='ai_draft',decompose_draft=$3::jsonb,decompose_ai_call_id=$4,
			decompose_error='',updated_at=now()
		WHERE id=$1 AND workspace_id=$2
		RETURNING `+benchmarkNoteCols, current.ID, workspaceID, string(draftJSON), res.CallID))
	if err != nil {
		return benchmarkNote{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return benchmarkNote{}, false, err
	}
	s.audit(ctx, "benchmark_decompose", "benchmark_note", current.ID.String(), "ok", nil)
	return updated, false, nil
}

func (s *Server) decomposeBenchmarkNote(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	note, reused, err := s.beginBenchmarkDecompose(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, benchmarkDecomposeResponse{Note: note, Reused: reused})
}

func (s *Server) confirmBenchmarkDecompose(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Draft *benchmarkDecomposeDraft `json:"draft"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	workspaceID := ident(ctx).WorkspaceID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	note, err := scanBenchmarkNote(tx.QueryRow(ctx, `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, id, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if note.ArchivedAt != nil {
		return apiErr(409, "benchmark_archived", "已归档笔记只能先恢复再编辑")
	}
	if note.DecomposeState == "confirmed" {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, note)
	}
	if note.DecomposeState != "ai_draft" {
		return apiErr(409, "decompose_not_ready", "当前没有待确认的拆解草稿")
	}
	draft, err := benchmarkDraftFromMap(note.DecomposeDraft)
	if err != nil {
		return err
	}
	if in.Draft != nil {
		draft = *in.Draft
	}
	if err := validateBenchmarkDecomposeDraft(&draft, benchmarkDecomposeHasMetrics(note)); err != nil {
		return err
	}
	draftMap, draftJSON, err := benchmarkDraftMap(draft)
	if err != nil {
		return err
	}
	structureJSON, err := json.Marshal(draftMap)
	if err != nil {
		return err
	}
	takeawaysJSON, err := json.Marshal(draft.Takeaways)
	if err != nil {
		return err
	}
	notBorrowableJSON, err := json.Marshal(draft.NotBorrowable)
	if err != nil {
		return err
	}
	structureHash := benchmarkContentHash(structureJSON)
	updated, err := scanBenchmarkNote(tx.QueryRow(ctx, `UPDATE benchmark_note
		SET structure=$3::jsonb,structure_hash=$4,takeaways=$5::jsonb,not_borrowable=$6::jsonb,
			decompose_state='confirmed',decompose_revision=decompose_revision+1,
			decompose_draft=$7::jsonb,decompose_error='',decompose_confirmed_at=now(),
			ai_call_id=COALESCE(decompose_ai_call_id,ai_call_id),revision=revision+1,updated_at=now()
		WHERE id=$1 AND workspace_id=$2
		RETURNING `+benchmarkNoteCols,
		note.ID, workspaceID, string(structureJSON), structureHash, string(takeawaysJSON),
		string(notBorrowableJSON), string(draftJSON)))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "benchmark_decompose_confirm", "benchmark_note", note.ID.String(), "ok", nil)
	return ok(w, updated)
}

func (s *Server) discardBenchmarkDecompose(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	workspaceID := ident(ctx).WorkspaceID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	note, err := scanBenchmarkNote(tx.QueryRow(ctx, `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, id, workspaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if note.ArchivedAt != nil {
		return apiErr(409, "benchmark_archived", "已归档笔记只能先恢复再编辑")
	}
	if note.DecomposeState == "confirmed" {
		return apiErr(409, "decompose_confirmed", "已确认的拆解不能丢弃；如需重做请重新发起 AI 初拆")
	}
	if note.DecomposeState == "none" {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, note)
	}
	updated, err := scanBenchmarkNote(tx.QueryRow(ctx, `UPDATE benchmark_note
		SET decompose_state='none',decompose_draft='{}'::jsonb,decompose_ai_call_id=NULL,
			decompose_error='',decompose_confirmed_at=NULL,updated_at=now()
		WHERE id=$1 AND workspace_id=$2
		RETURNING `+benchmarkNoteCols, note.ID, workspaceID))
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "benchmark_decompose_discard", "benchmark_note", note.ID.String(), "ok", nil)
	return ok(w, updated)
}

func (s *Server) batchBenchmarkDecompose(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	var in struct {
		NoteIDs []uuid.UUID `json:"note_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.NoteIDs) < 1 || len(in.NoteIDs) > 5 {
		return validation("批量拆解每次只能选择 1..5 条笔记")
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range in.NoteIDs {
		if seen[id] {
			return validation("note_ids 不能重复")
		}
		seen[id] = true
	}
	items := make([]map[string]any, 0, len(in.NoteIDs))
	for _, id := range in.NoteIDs {
		note, reused, err := s.beginBenchmarkDecompose(r.Context(), id)
		item := map[string]any{"note_id": id, "reused": reused}
		if note.ID != uuid.Nil {
			item["decompose_state"] = note.DecomposeState
		}
		if err != nil {
			item["error"] = truncate(err.Error(), 200)
		}
		items = append(items, item)
	}
	return ok(w, map[string]any{"items": items, "count": len(items)})
}
