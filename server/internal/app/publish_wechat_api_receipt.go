package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// recordWechatAPIDraftReceipt 在 filling→filled 的同一事务内，把公众号 API
// 真实草稿写入结果投影为作品草稿回执。方案 A：draft/add 成功且回读一致即视为
// “已提交草稿箱”，不调用 Submit，也不改变作品的公开发布状态。
func (s *Server) recordWechatAPIDraftReceipt(ctx context.Context, tx pgx.Tx, task *PublishTask, evidence map[string]any) error {
	if task == nil || task.Platform != "wechat_mp" || task.Mode != "api" {
		return nil
	}
	draftID := strings.TrimSpace(stringEvidence(evidence, "draft_media_id"))
	if draftID == "" {
		// 通用任务状态机允许手工登记 filled；没有草稿编号时不投影回执，
		// 由生产 runner 在调用前显式拒绝缺少草稿编号的公众号 API 结果。
		return nil
	}

	var workStatus string
	var accountID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT status, account_id FROM work
		WHERE id=$1 AND deleted_at IS NULL`, task.WorkID).Scan(&workStatus, &accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(404, "not_found", "作品不存在，不能登记草稿回执")
	}
	if err != nil {
		return err
	}
	if accountID != task.AccountID {
		return apiErr(409, "state_invalid", "发布任务与作品账号不一致，不能登记草稿回执")
	}
	if workStatus == "published" {
		// 已公开作品不允许被草稿回执回退为 pushed。
		return nil
	}

	contentHash := strings.TrimSpace(stringEvidence(evidence, "content_hash"))
	if _, err := tx.Exec(ctx, `UPDATE work SET status='pushed', wechat_draft_media_id=$2,
		wechat_draft_hash=NULLIF($3,''), updated_at=now()
		WHERE id=$1 AND deleted_at IS NULL AND status <> 'published'`,
		task.WorkID, draftID, contentHash); err != nil {
		return err
	}

	var existing int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_record
		WHERE work_id=$1 AND status='ok' AND draft_media_id=$2`,
		task.WorkID, draftID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}

	var todayCount, dailyLimit int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_record
		WHERE account_id=$1 AND status='ok' AND created_at >= $2`,
		task.AccountID, s.today()).Scan(&todayCount); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT daily_push_limit FROM platform_account WHERE id=$1`,
		task.AccountID).Scan(&dailyLimit); err != nil {
		return err
	}
	overLimit := todayCount >= dailyLimit
	_, err = tx.Exec(ctx, `INSERT INTO push_record(work_id, account_id, action, status, draft_media_id, over_limit)
		VALUES($1,$2,'add','ok',$3,$4)`, task.WorkID, task.AccountID, draftID, overLimit)
	return err
}

func stringEvidence(evidence map[string]any, key string) string {
	if evidence == nil {
		return ""
	}
	value, _ := evidence[key].(string)
	return value
}

// recordWechatAPIDraftSubmittedMilestone 在同一 filled 事务内登记作品 submitted
// 里程碑。方案 A 将“草稿写入成功 + 回读一致”视为已提交草稿箱，因此不调用
// Submit；仍保留 submitted_ref 的收据编号与草稿编号，供 UI 和后续状态机核验。
func (s *Server) recordWechatAPIDraftSubmittedMilestone(ctx context.Context, tx pgx.Tx, task *PublishTask, evidence map[string]any) error {
	if task == nil || task.Platform != "wechat_mp" || task.Mode != "api" {
		return nil
	}
	draftID := strings.TrimSpace(stringEvidence(evidence, "draft_media_id"))
	if draftID == "" {
		return nil
	}

	var workStatus string
	var revision int
	if err := tx.QueryRow(ctx, `SELECT status, revision FROM work
		WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, task.WorkID).Scan(&workStatus, &revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if workStatus != "pushed" {
		return nil
	}

	var existingState string
	var existingVersion int
	err := tx.QueryRow(ctx, `SELECT state, version FROM work_publish_state
		WHERE work_id=$1 FOR UPDATE`, task.WorkID).Scan(&existingState, &existingVersion)
	if err == nil {
		// 已有任何里程碑都不覆盖；用户手动登记或公开回填优先。
		return nil
	}
	if err != pgx.ErrNoRows {
		return err
	}

	var receiptID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM push_record
		WHERE work_id=$1 AND status='ok' AND draft_media_id=$2
		ORDER BY created_at DESC LIMIT 1`, task.WorkID, draftID).Scan(&receiptID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	ref := derivedSubmittedRef{
		Platform:     "wechat_mp",
		Kind:         "wechat_draft_receipt",
		HandoffNote:  "公众号 API 草稿已写入并回读一致，系统登记为已提交草稿箱",
		WorkRevision: revision,
		ReceiptID:    &receiptID,
		DraftMediaID: draftID,
		RecordedAt:   s.now(),
	}
	refJSON, err := json.Marshal(ref)
	if err != nil {
		return err
	}
	requestPayload := map[string]any{
		"to": "submitted", "from": nil, "submitted_ref": json.RawMessage(refJSON),
	}
	requestJSON, err := json.Marshal(requestPayload)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(requestJSON)
	requestHash := hex.EncodeToString(sum[:])
	note := strings.TrimSpace(ref.HandoffNote)
	idempotencyKey := "wechat-api-draft:submitted:" + task.ID.String()

	var nextVersion int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(state_version),0)+1 FROM work_publish_state_event
		WHERE work_id=$1`, task.WorkID).Scan(&nextVersion); err != nil {
		return err
	}
	if nextVersion < 1 {
		nextVersion = 1
	}
	eventEvidence, err := json.Marshal(map[string]any{"submitted_ref": json.RawMessage(refJSON)})
	if err != nil {
		return err
	}
	var actor *uuid.UUID
	if task.CreatedBy != nil && *task.CreatedBy != uuid.Nil {
		actor = task.CreatedBy
	}
	if _, err := tx.Exec(ctx, `INSERT INTO work_publish_state
		(work_id,state,version,submitted_ref,since,updated_by)
		VALUES($1,'submitted',$2,$3,now(),$4)`, task.WorkID, nextVersion, refJSON, actor); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO work_publish_state_event
		(work_id,event_kind,from_state,to_state,state_version,evidence,note,idempotency_key,request_hash,actor,at)
		VALUES($1,'transition',NULL,'submitted',$2,$3,$4,$5,$6,$7,$8)`,
		task.WorkID, nextVersion, eventEvidence, note, idempotencyKey, requestHash, actor, s.now())
	return err
}
