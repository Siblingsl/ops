package app

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type pushReservation struct {
	ID        uuid.UUID
	Count     int
	OverLimit bool
}

func (s *Server) reserveWechatPush(ctx context.Context, m *workMeta, wk *Work, in pushInput, action string) (pushReservation, error) {
	var record pushReservation
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return record, err
	}
	defer tx.Rollback(ctx)
	var status string
	var revision int
	var draftID *string
	if err := tx.QueryRow(ctx, `SELECT status, revision, wechat_draft_media_id FROM work WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, m.ID).Scan(&status, &revision, &draftID); err != nil {
		return record, err
	}
	var running bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM push_record WHERE work_id=$1 AND status='running' AND created_at >= $2)`, m.ID, s.now().Add(-10*time.Minute)).Scan(&running); err != nil {
		return record, err
	}
	if running {
		return record, apiErr(409, "wechat_push_running", "正在写入，请稍候")
	}
	if status == "reviewing" {
		return record, humanStep("H-09", "这篇作品需要审阅，审阅通过后才能写入草稿")
	}
	if status != "ready" && status != "pushed" {
		return record, humanStep("H-04", "发布前检查还没有全部确认，不能写入草稿")
	}
	if in.Revision != revision {
		return record, stateInvalid("内容在检查后又修改过，请重新检查")
	}
	if err := s.checkLatestMaterialBasis(ctx, tx, m.ID); err != nil {
		return record, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_record WHERE account_id=$1 AND status='ok' AND created_at >= $2`, m.Account.ID, s.today()).Scan(&record.Count); err != nil {
		return record, err
	}
	record.OverLimit = record.Count >= m.Account.DailyPushLimit
	if record.OverLimit && !in.ConfirmOverLimit {
		return record, apiErr(409, "push_limit_reached", fmt.Sprintf("今天已写入草稿 %d 次，达到上限 %d 次。频繁写入可能被平台视为批量发布（3.27.2），确认仍要继续吗？", record.Count, m.Account.DailyPushLimit)).
			With(map[string]int{"today_count": record.Count, "daily_limit": m.Account.DailyPushLimit})
	}
	if err := tx.QueryRow(ctx, `INSERT INTO push_record(work_id, account_id, action, status, over_limit) VALUES($1,$2,$3,'running',$4) RETURNING id`, m.ID, m.Account.ID, action, record.OverLimit).Scan(&record.ID); err != nil {
		return record, err
	}
	if err := tx.Commit(ctx); err != nil {
		return record, err
	}
	wk.WechatDraftMediaID = draftID
	return record, nil
}
