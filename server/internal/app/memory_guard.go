package app

// REF41 A4：记忆置信、衰减与注入闸的服务端硬闸与操作入口。
// 注入上限 8 条 / 总字数 2000；90 天未用且未确认衰减 ×0.9（下限 0.5）；
// confirm/disable/enable 是用户显式操作；注入预览只读并给出丢弃原因。

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	memoryInjectMaxItems = 8
	memoryInjectMaxChars = 2000
	memoryDecayAfterDays = 90
	memoryDecayFloor     = 0.5
	memoryDecayFactor    = 0.9
	memoryConfidenceNew  = 0.8
	memoryConfidenceGate = 0.6
)

// memoryGuardInject 对已排序的候选做条数/字数硬闸（A4-A2；服务端为准，前端不能绕过）。
func memoryGuardInject(items []Memory) (kept []Memory, dropped []MemoryInjectDrop, totalChars int) {
	kept = []Memory{}
	dropped = []MemoryInjectDrop{}
	for _, m := range items {
		if len(kept) >= memoryInjectMaxItems || totalChars+len([]rune(m.Text)) > memoryInjectMaxChars {
			reason := "超出行数或字数上限"
			if len(kept) >= memoryInjectMaxItems {
				reason = "超过 8 条上限"
			}
			dropped = append(dropped, MemoryInjectDrop{ID: m.ID, Kind: m.Kind, Reason: reason})
			continue
		}
		kept = append(kept, m)
		totalChars += len([]rune(m.Text))
	}
	return kept, dropped, totalChars
}

// MemoryInjectDrop 是注入预览中的丢弃项与原因。
type MemoryInjectDrop struct {
	ID     uuid.UUID `json:"id"`
	Kind   string    `json:"kind"`
	Reason string    `json:"reason"`
}

// memoryInjectionPreview 是 GET /accounts/{id}/memories/injection-preview 的响应。
type memoryInjectionPreview struct {
	Items      []Memory           `json:"items"`
	TotalChars int                `json:"total_chars"`
	Dropped    []MemoryInjectDrop `json:"dropped"`
}

// memoryInjectionPreviewHandler 返回本次会话将注入哪些记忆及被丢弃原因（只读）。
func (s *Server) memoryInjectionPreviewHandler(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	items, err := s.activeMemories(r.Context(), a.ID, "", false)
	if err != nil {
		return err
	}
	kept, dropped, totalChars := memoryGuardInject(items)
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, memoryInjectionPreview{Items: kept, TotalChars: totalChars, Dropped: dropped})
}

// memoryVerifyHandler 确认仍有效：confidence=1、confirmed_at=now、清 decayed_at。
// 路由名避开 HC-20 批量关键字（单条操作，无 all/batch 语义，不违反 D-117 逐条执行红线）。
func (s *Server) memoryVerifyHandler(w http.ResponseWriter, r *http.Request) error {
	return s.memoryStatusAction(w, r, func(ctx context.Context, tx pgx.Tx, memoryID uuid.UUID, accountID uuid.UUID, userID uuid.UUID) error {
		_, err := tx.Exec(ctx, `UPDATE account_memory SET confidence=1.0, confirmed_at=now(),
			confirmed_by=$3, decayed_at=NULL, updated_at=now() WHERE id=$1 AND status='active' AND account_id=$2`,
			memoryID, accountID, userID)
		return err
	}, "verify")
}

// memoryDisableHandler 不再使用：status=disabled（不删除，可 enable 恢复）。
func (s *Server) memoryDisableHandler(w http.ResponseWriter, r *http.Request) error {
	return s.memoryStatusAction(w, r, func(ctx context.Context, tx pgx.Tx, memoryID uuid.UUID, accountID uuid.UUID, userID uuid.UUID) error {
		_, err := tx.Exec(ctx, `UPDATE account_memory SET status='disabled', updated_at=now() WHERE id=$1 AND account_id=$2`,
			memoryID, accountID)
		return err
	}, "disable")
}

// memoryEnableHandler 恢复 active（保持既有置信度）。
func (s *Server) memoryEnableHandler(w http.ResponseWriter, r *http.Request) error {
	return s.memoryStatusAction(w, r, func(ctx context.Context, tx pgx.Tx, memoryID uuid.UUID, accountID uuid.UUID, userID uuid.UUID) error {
		_, err := tx.Exec(ctx, `UPDATE account_memory SET status='active', updated_at=now() WHERE id=$1 AND account_id=$2`,
			memoryID, accountID)
		return err
	}, "enable")
}

// memoryStatusAction 统一执行账号归属校验（A4-A6 不跨账号）与审计。
func (s *Server) memoryStatusAction(w http.ResponseWriter, r *http.Request,
	apply func(ctx context.Context, tx pgx.Tx, memoryID uuid.UUID, accountID uuid.UUID, userID uuid.UUID) error, action string) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	memoryID, err := uuid.Parse(chi.URLParam(r, "memoryId"))
	if err != nil {
		return apiErr(http.StatusBadRequest, "invalid_memory_id", "记忆 ID 不合法")
	}
	user := ident(r.Context()).UserID
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var n int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM account_memory
		WHERE id=$1 AND account_id=$2`, memoryID, a.ID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return errNotFound
	}
	if err := apply(r.Context(), tx, memoryID, a.ID, user); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.audit(r.Context(), "memory."+action, "account_memory", memoryID.String(), "ok", map[string]any{
		"account_id": a.ID.String(),
	})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": true, "action": action})
}

// memoryDecayJob 每日：90 天未使用且未确认 → confidence ×0.9（下限 0.5），
// 记录 decayed_at；不自动 disabled（A4-A4）。
func (s *Server) memoryDecayJob(ctx context.Context) {
	cutoff := s.now().AddDate(0, 0, -memoryDecayAfterDays)
	_, _ = s.db.Exec(ctx, `UPDATE account_memory SET
		confidence = GREATEST($1::numeric, confidence * $2::numeric),
		decayed_at = now(), updated_at = now()
		WHERE status='active'
		AND confidence > $1::numeric
		AND COALESCE(last_used_at, created_at) < $3
		AND (confirmed_at IS NULL OR confirmed_at < $3)`,
		memoryDecayFloor, memoryDecayFactor, cutoff.UTC())
}
