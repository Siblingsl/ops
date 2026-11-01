package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type publishStateInput struct {
	BaseVersion    int                `json:"base_version"`
	IdempotencyKey string             `json:"idempotency_key"`
	To             string             `json:"to"`
	SubmittedRef   *submittedRefInput `json:"submitted_ref"`
	ScheduledAt    *time.Time         `json:"scheduled_at"`
	Evidence       *scheduleEvidence  `json:"evidence"`
	Reason         string             `json:"reason"`
	MetricID       *uuid.UUID         `json:"metric_id"`
	MetricRevision *int               `json:"metric_revision"`
}

type submittedRefInput struct {
	HandoffNote string `json:"handoff_note"`
}

type scheduleEvidence struct {
	AssetID             *uuid.UUID `json:"asset_id"`
	ConfirmedScreenshot bool       `json:"confirmed_screenshot"`
	BackendURL          string     `json:"backend_url"`
}

type publishStateRow struct {
	State                    string
	Version                  int
	SubmittedRef             []byte
	ScheduledAt              *time.Time
	ScheduleEvidence         []byte
	RegisteredMetricID       *uuid.UUID
	RegisteredMetricRevision *int
	PublicationRevision      int
	Since                    time.Time
}

type publishStateEvent struct {
	ID           uuid.UUID       `json:"id"`
	EventKind    string          `json:"event_kind"`
	FromState    *string         `json:"from_state"`
	ToState      string          `json:"to_state"`
	StateVersion int             `json:"state_version"`
	Evidence     json.RawMessage `json:"evidence"`
	Note         string          `json:"note"`
	At           time.Time       `json:"at"`
}

func (s *Server) getPublishState(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var publication publicationState
	if err := s.db.QueryRow(ctx, `SELECT status,published_url,published_at,locked,revision,publish_revision,wechat_msgid
		FROM work WHERE id=$1 AND deleted_at IS NULL`, m.ID).Scan(&publication.Status, &publication.URL, &publication.PublishedAt,
		&publication.Locked, &publication.Revision, &publication.PublishRevision, &publication.WechatMsgID); err != nil {
		return err
	}
	state, err := loadPublishState(ctx, s.db, m.ID, false)
	if err != nil {
		return err
	}
	history, err := loadPublishStateHistory(ctx, s.db, m.ID)
	if err != nil {
		return err
	}
	stateName := any(nil)
	var version int
	var submittedRef, scheduleEvidence json.RawMessage
	var scheduledAt *time.Time
	var registration = map[string]any{"metric_id": nil, "revision": nil, "valid": false}
	if state != nil {
		stateName, version = state.State, state.Version
		if len(state.SubmittedRef) > 0 {
			submittedRef = state.SubmittedRef
		}
		if len(state.ScheduleEvidence) > 0 {
			scheduleEvidence = state.ScheduleEvidence
		}
		scheduledAt = state.ScheduledAt
		if state.State == "registered" {
			valid, err := registeredMetricValid(ctx, s.db, m.ID, state.RegisteredMetricID, state.RegisteredMetricRevision)
			if err != nil {
				return err
			}
			registration = map[string]any{"metric_id": state.RegisteredMetricID, "revision": state.RegisteredMetricRevision, "valid": valid}
			if !valid {
				if publication.Status == "published" {
					stateName = "public"
				} else {
					stateName = nil
				}
			}
		}
	} else if publication.Status == "published" {
		// Migration 00078 normally creates this projection; continue to derive public from work
		// if a partial/manual legacy fixture has not yet been migrated.
		stateName = "public"
	}
	publicationView := map[string]any{"url": nil, "at": nil, "publish_revision": publication.PublishRevision}
	if publication.Status == "published" {
		publicationView["url"] = publication.URL
		publicationView["at"] = publication.PublishedAt
	}
	return ok(w, map[string]any{
		"state": stateName, "version": version, "submitted_ref": submittedRef, "scheduled_at": scheduledAt,
		"schedule_evidence": scheduleEvidence, "publication": publicationView, "registration": registration, "history": history,
	})
}

func (s *Server) transitionPublishState(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Status != "active" {
		return apiErr(http.StatusConflict, "account_disabled", "账号已停用，不能更改发布进度")
	}
	var in publishStateInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseVersion < 0 || strings.TrimSpace(in.IdempotencyKey) == "" || runeLen(in.IdempotencyKey) > 128 {
		return validation("需要有效的 base_version 和 1 到 128 字的 idempotency_key")
	}
	if in.To == "public" {
		return apiErr(http.StatusUnprocessableEntity, "use_published_endpoint", "公开状态必须使用原发布回填入口")
	}
	if in.To != "submitted" && in.To != "scheduled" && in.To != "registered" {
		return apiErr(http.StatusUnprocessableEntity, "invalid_transition", "发布进度目标状态不正确")
	}
	if in.To != "submitted" && in.SubmittedRef != nil {
		return validation("submitted_ref 仅适用于 submitted 状态")
	}
	if in.To == "scheduled" {
		if in.ScheduledAt == nil || !in.ScheduledAt.After(s.now()) {
			return apiErr(http.StatusUnprocessableEntity, "scheduled_at_past", "预约时间必须晚于当前时间")
		}
		if in.Evidence == nil {
			return apiErr(http.StatusUnprocessableEntity, "scheduled_at_required", "预约需要截图资产或经校验的平台后台链接")
		}
	} else if in.ScheduledAt != nil || in.Evidence != nil {
		return validation("scheduled_at 和 evidence 仅适用于 scheduled 状态")
	}
	if in.To == "registered" {
		if in.MetricID == nil || *in.MetricID == uuid.Nil || in.MetricRevision == nil || *in.MetricRevision < 1 {
			return apiErr(http.StatusUnprocessableEntity, "metric_required", "登记基线需要正式指标编号和修订号")
		}
	} else if in.MetricID != nil || in.MetricRevision != nil {
		return validation("metric_id 和 metric_revision 仅适用于 registered 状态")
	}
	if in.To != "scheduled" && in.Evidence != nil {
		return validation("evidence 仅适用于 scheduled 状态")
	}
	if in.To != "scheduled" && in.ScheduledAt != nil {
		return validation("scheduled_at 仅适用于 scheduled 状态")
	}
	if in.To != "submitted" && in.Reason != "" {
		return validation("reason 仅适用于取消预约")
	}

	payload := in
	payload.BaseVersion = 0
	payload.IdempotencyKey = ""
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(rawPayload)
	requestHash := hex.EncodeToString(hash[:])
	actor := ident(r.Context())
	var submittedRefForPersist, evidenceForPersist []byte
	var prevalidatedToutiaoRevision *int
	if in.To == "submitted" && m.Account.Platform == "toutiao" {
		// Validate the generated pack before taking the write lock: its service opens a
		// separate read transaction. The locked revision below closes the race.
		var revision int
		err := s.db.QueryRow(r.Context(), `SELECT revision FROM work WHERE id=$1 AND status='packed' AND deleted_at IS NULL`, m.ID).Scan(&revision)
		if err == nil {
			if _, _, err := s.buildToutiaoPack(r.Context(), m.ID, revision, false); err != nil {
				return err
			}
			if err := s.verifyToutiaoPackBasis(r.Context(), m.ID, revision, "packed"); err != nil {
				return err
			}
			prevalidatedToutiaoRevision = &revision
		} else if err != pgx.ErrNoRows {
			return err
		}
	}
	var response map[string]any
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if err := s.requireLivePublishEditor(r.Context(), tx); err != nil {
			return err
		}
		var accountStatus, platform, workStatus string
		var revision, publishRevision int
		var draftMediaID *string
		if err := tx.QueryRow(r.Context(), `SELECT w.status,w.revision,w.publish_revision,w.wechat_draft_media_id,a.platform,a.status
			FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL FOR UPDATE OF w`, m.ID, actor.WorkspaceID).
			Scan(&workStatus, &revision, &publishRevision, &draftMediaID, &platform, &accountStatus); err != nil {
			return err
		}
		if accountStatus != "active" {
			return apiErr(http.StatusConflict, "account_disabled", "账号已停用，不能更改发布进度")
		}
		if prevalidatedToutiaoRevision != nil && (workStatus != "packed" || revision != *prevalidatedToutiaoRevision) {
			return apiErr(http.StatusConflict, "version_conflict", "头条发布包依据已变化，请重新读取并生成发布包").With(map[string]any{"server_revision": revision})
		}
		if in.To == "submitted" && platform == "toutiao" && workStatus == "packed" && prevalidatedToutiaoRevision == nil {
			return apiErr(http.StatusConflict, "version_conflict", "未能核验当前头条发布包，请重新读取后重试")
		}
		var oldHash string
		err := tx.QueryRow(r.Context(), `SELECT request_hash FROM work_publish_state_event WHERE work_id=$1 AND idempotency_key=$2`, m.ID, in.IdempotencyKey).Scan(&oldHash)
		if err == nil {
			if oldHash != requestHash {
				return apiErr(http.StatusConflict, "idempotency_conflict", "该幂等键已用于不同的发布进度请求")
			}
			return publishStateResponseTx(r.Context(), tx, m.ID, &response)
		}
		if err != pgx.ErrNoRows {
			return err
		}
		current, err := loadPublishState(r.Context(), tx, m.ID, true)
		if err != nil {
			return err
		}
		currentState, currentVersion := "", 0
		if current != nil {
			currentState, currentVersion = current.State, current.Version
		}
		if currentState == "registered" {
			if err := invalidateRegisteredPublishState(r.Context(), tx, m.ID, publishActorID(r.Context())); err != nil {
				return err
			}
			current, err = loadPublishState(r.Context(), tx, m.ID, true)
			if err != nil {
				return err
			}
			currentState, currentVersion = current.State, current.Version
		}
		if currentVersion != in.BaseVersion {
			return apiErr(http.StatusConflict, "version_conflict", "发布进度已变化，请重新读取后重试").With(map[string]any{"server_version": currentVersion})
		}
		if in.To == currentState {
			var previousHash string
			err := tx.QueryRow(r.Context(), `SELECT request_hash FROM work_publish_state_event WHERE work_id=$1 AND state_version=$2`, m.ID, currentVersion).Scan(&previousHash)
			if err == nil && previousHash == requestHash {
				return publishStateResponseTx(r.Context(), tx, m.ID, &response)
			}
			if err != nil && err != pgx.ErrNoRows {
				return err
			}
			return apiErr(http.StatusConflict, "invalid_transition", "该发布进度已记录；如需变更，请使用当前允许的下一步")
		}
		if !publishTransitionAllowed(currentState, in.To) {
			return apiErr(http.StatusUnprocessableEntity, "invalid_transition", "当前发布进度不能转换到目标状态")
		}
		if in.To == "submitted" {
			if currentState == "scheduled" {
				if in.SubmittedRef != nil {
					return validation("取消预约不接受新的 submitted_ref")
				}
				if strings.TrimSpace(in.Reason) == "" || runeLen(strings.TrimSpace(in.Reason)) > 500 {
					return validationFields("取消预约需要填写 1 到 500 字的原因", map[string]string{"reason": "请说明取消原因"})
				}
			} else {
				if in.SubmittedRef == nil || runeLen(strings.TrimSpace(in.SubmittedRef.HandoffNote)) == 0 || runeLen(strings.TrimSpace(in.SubmittedRef.HandoffNote)) > 500 {
					return validationFields("请填写 1 到 500 字的交接说明", map[string]string{"submitted_ref.handoff_note": "交接说明不能为空且不能超过 500 字"})
				}
				if strings.TrimSpace(in.Reason) != "" {
					return validation("初次交接不接受取消原因")
				}
			}
			if currentState == "" {
				ref, err := s.buildSubmittedRef(r.Context(), tx, m.ID, platform, workStatus, revision, draftMediaID, in.SubmittedRef)
				if err != nil {
					return err
				}
				submittedRefForPersist, err = json.Marshal(ref)
				if err != nil {
					return err
				}
			}
		} else if in.To == "scheduled" {
			if in.ScheduledAt == nil || !in.ScheduledAt.After(s.now()) {
				return apiErr(http.StatusUnprocessableEntity, "scheduled_at_past", "预约时间必须晚于当前时间")
			}
			if strings.TrimSpace(in.Reason) != "" {
				return validation("预约操作不接受 reason")
			}
			validatedEvidence, err := s.validateScheduleEvidence(r.Context(), tx, m.ID, actor.WorkspaceID, platform, *in.Evidence)
			if err != nil {
				return err
			}
			evidenceForPersist, err = json.Marshal(validatedEvidence)
			if err != nil {
				return err
			}
		} else if in.To == "registered" {
			if workStatus != "published" || publishRevision < 1 {
				return apiErr(http.StatusUnprocessableEntity, "invalid_transition", "只有已通过原发布入口登记的公开作品可以登记基线")
			}
			var metricRevision int
			var source, quality, readUnit, shareUnit string
			var sourceSupported bool
			var reads, likes, wows, favorites, comments, shares, follows *int
			var impressions *int64
			err := tx.QueryRow(r.Context(), `SELECT revision,source,quality_state,read_unit,share_unit,reads,likes,wows,favorites,comments,shares,follows_gained,impressions,metric_source_supported(source)
				FROM metric_snapshot WHERE id=$1 AND work_id=$2 FOR UPDATE`, *in.MetricID, m.ID).
				Scan(&metricRevision, &source, &quality, &readUnit, &shareUnit, &reads, &likes, &wows, &favorites, &comments, &shares, &follows, &impressions, &sourceSupported)
			if err == pgx.ErrNoRows {
				return apiErr(http.StatusUnprocessableEntity, "metric_required", "所选指标不属于本作品或已不存在")
			}
			if err != nil {
				return err
			}
			if metricRevision != *in.MetricRevision || !eligiblePublishMetric(sourceSupported, quality, readUnit, shareUnit, reads, likes, wows, favorites, comments, shares, follows, impressions) {
				return apiErr(http.StatusUnprocessableEntity, "metric_required", "所选指标不是当前合格的正式基线，请重新读取指标")
			}
		}

		from := any(nil)
		if currentState != "" {
			from = currentState
		}
		nextVersion := currentVersion + 1
		nextSubmitted := []byte(nil)
		var nextScheduleAt *time.Time
		var nextScheduleEvidence []byte
		var nextMetricID *uuid.UUID
		var nextMetricRevision *int
		if current != nil {
			nextSubmitted = current.SubmittedRef
		}
		switch in.To {
		case "submitted":
			if currentState == "" {
				nextSubmitted = submittedRefForPersist
			}
		case "scheduled":
			nextScheduleAt = in.ScheduledAt
			nextScheduleEvidence = evidenceForPersist
		case "registered":
			nextMetricID, nextMetricRevision = in.MetricID, in.MetricRevision
		}
		note := strings.TrimSpace(in.Reason)
		if in.To == "submitted" && currentState == "" {
			note = strings.TrimSpace(in.SubmittedRef.HandoffNote)
		}
		eventEvidence := map[string]any{}
		if currentState == "" && in.To == "submitted" {
			eventEvidence["submitted_ref"] = json.RawMessage(submittedRefForPersist)
		} else if in.To == "scheduled" {
			eventEvidence["scheduled_at"] = in.ScheduledAt
			eventEvidence["evidence"] = json.RawMessage(evidenceForPersist)
		} else if in.To == "registered" {
			eventEvidence["metric_id"] = in.MetricID
			eventEvidence["metric_revision"] = in.MetricRevision
		} else if currentState == "scheduled" && in.To == "submitted" {
			eventEvidence["reason"] = note
		}
		if current == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO work_publish_state(work_id,state,version,submitted_ref,scheduled_at,schedule_evidence,
				registered_metric_id,registered_metric_revision,publication_revision,since,updated_by)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10)`, m.ID, in.To, nextVersion, nextSubmitted, nextScheduleAt,
				nextScheduleEvidence, nextMetricID, nextMetricRevision, publishRevision, actor.UserID)
		} else {
			_, err = tx.Exec(r.Context(), `UPDATE work_publish_state SET state=$2,version=$3,submitted_ref=$4,scheduled_at=$5,schedule_evidence=$6,
				registered_metric_id=$7,registered_metric_revision=$8,since=now(),updated_by=$9 WHERE work_id=$1`, m.ID, in.To, nextVersion,
				nextSubmitted, nextScheduleAt, nextScheduleEvidence, nextMetricID, nextMetricRevision, actor.UserID)
		}
		if err != nil {
			return err
		}
		evidenceJSON, err := json.Marshal(eventEvidence)
		if err != nil {
			return err
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO work_publish_state_event(work_id,event_kind,from_state,to_state,state_version,evidence,note,
			idempotency_key,request_hash,actor) VALUES($1,'transition',$2,$3,$4,$5,$6,$7,$8,$9)`, m.ID, from, in.To, nextVersion,
			evidenceJSON, note, in.IdempotencyKey, requestHash, actor.UserID)
		if err != nil {
			return err
		}
		return publishStateResponseTx(r.Context(), tx, m.ID, &response)
	})
	if err != nil {
		return err
	}
	return ok(w, response)
}

// These are populated only after state and all transition-specific evidence have passed validation.
func publishTransitionAllowed(from, to string) bool {
	switch {
	case from == "" && to == "submitted":
		return true
	case from == "submitted" && to == "scheduled":
		return true
	case from == "scheduled" && to == "submitted":
		return true
	case from == "public" && to == "registered":
		return true
	default:
		return false
	}
}

type derivedSubmittedRef struct {
	Platform     string     `json:"platform"`
	Kind         string     `json:"kind"`
	HandoffNote  string     `json:"handoff_note"`
	WorkRevision int        `json:"work_revision"`
	ReceiptID    *uuid.UUID `json:"receipt_id,omitempty"`
	DraftMediaID string     `json:"draft_media_id,omitempty"`
	Format       string     `json:"format,omitempty"`
	RecordedAt   time.Time  `json:"recorded_at"`
}

func (s *Server) buildSubmittedRef(ctx context.Context, tx pgx.Tx, workID uuid.UUID, platform, status string, revision int,
	draftMediaID *string, in *submittedRefInput) (derivedSubmittedRef, error) {
	ref := derivedSubmittedRef{Platform: platform, WorkRevision: revision, HandoffNote: strings.TrimSpace(in.HandoffNote), RecordedAt: s.now()}
	switch platform {
	case "wechat_mp":
		if status != "pushed" || draftMediaID == nil || strings.TrimSpace(*draftMediaID) == "" {
			return ref, stateInvalid("公众号交接需要本作品当前有效的草稿回执")
		}
		var receiptID uuid.UUID
		var receipt string
		err := tx.QueryRow(ctx, `SELECT id,draft_media_id FROM push_record WHERE work_id=$1 AND status='ok'
			AND draft_media_id=$2 ORDER BY created_at DESC LIMIT 1`, workID, strings.TrimSpace(*draftMediaID)).Scan(&receiptID, &receipt)
		if err == pgx.ErrNoRows {
			return ref, stateInvalid("没有找到与当前草稿编号匹配的成功回执")
		}
		if err != nil {
			return ref, err
		}
		ref.Kind, ref.ReceiptID, ref.DraftMediaID = "wechat_draft_receipt", &receiptID, receipt
	case "xhs", "toutiao":
		if status != "packed" {
			return ref, stateInvalid("交接需要当前有效的发布包；生成发布包本身不代表已在平台提交")
		}
		if err := s.checkLatestMaterialBasis(ctx, tx, workID); err != nil {
			return ref, err
		}
		if platform == "xhs" {
			var format string
			if err := tx.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1`, workID).Scan(&format); err != nil {
				return ref, err
			}
			assets, err := readXhsPackAssets(ctx, tx, workID, format)
			if err != nil {
				return ref, err
			}
			for _, asset := range assets {
				if _, err := s.readVerifiedPackAsset(asset); err != nil {
					return ref, err
				}
			}
			ref.Format = format
		} else {
			if err := tx.QueryRow(ctx, `SELECT content_format FROM work WHERE id=$1`, workID).Scan(&ref.Format); err != nil {
				return ref, err
			}
		}
		ref.Kind = "current_pack_handoff"
	default:
		return ref, validation("该平台不支持记录交接")
	}
	return ref, nil
}

func (s *Server) validateScheduleEvidence(ctx context.Context, tx pgx.Tx, workID, workspaceID uuid.UUID, platform string,
	in scheduleEvidence) (map[string]any, error) {
	if in.AssetID != nil {
		if !in.ConfirmedScreenshot || strings.TrimSpace(in.BackendURL) != "" {
			return nil, validation("请选择单一预约凭证，并确认所选图片为平台预约截图")
		}
		var assetID, assetWorkID uuid.UUID
		var path, mime, sum string
		var size int
		err := tx.QueryRow(ctx, `SELECT x.id,coalesce(x.work_id,'00000000-0000-0000-0000-000000000000'::uuid),x.storage_path,x.mime,x.bytes,x.sha256
			FROM asset x
			LEFT JOIN work aw ON aw.id=x.work_id AND aw.deleted_at IS NULL
			LEFT JOIN platform_account aa ON aa.id=coalesce(aw.account_id,x.account_id)
			WHERE x.id=$1 AND x.workspace_id=$2 AND (aa.workspace_id=$2 OR (x.work_id IS NULL AND x.account_id IS NULL))`, *in.AssetID, workspaceID).
			Scan(&assetID, &assetWorkID, &path, &mime, &size, &sum)
		if err == pgx.ErrNoRows {
			return nil, apiErr(http.StatusUnprocessableEntity, "scheduled_at_required", "预约截图资产不属于当前工作区")
		}
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(mime, "image/") || path == "" || size < 1 || len(sum) != 64 {
			return nil, validation("预约凭证必须是有效图片资产")
		}
		data, err := os.ReadFile(assetDataPath(s, path))
		if err != nil || len(data) != size || sha256Hex(data) != sum {
			return nil, apiErr(http.StatusUnprocessableEntity, "scheduled_at_required", "预约截图文件缺失或校验失败，请重新上传")
		}
		return map[string]any{"kind": "screenshot_asset", "asset_id": assetID, "work_id": assetWorkID,
			"mime": mime, "sha256": sum, "confirmed_screenshot": true}, nil
	}
	if in.ConfirmedScreenshot || strings.TrimSpace(in.BackendURL) == "" {
		return nil, validation("请提供预约截图资产或平台后台链接")
	}
	validated, err := validatePlatformBackendURL(platform, strings.TrimSpace(in.BackendURL))
	if err != nil {
		return nil, err
	}
	return map[string]any{"kind": "platform_backend_url", "url": validated}, nil
}

func assetDataPath(s *Server, storagePath string) string {
	return filepath.Join(s.cfg.DataDir, filepath.FromSlash(storagePath))
}

func sha256Hex(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func validatePlatformBackendURL(platform, raw string) (string, error) {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Port() != "" && parsed.Port() != "443") {
		return "", validation("后台链接必须是无登录参数的 HTTPS 地址")
	}
	host := strings.ToLower(parsed.Hostname())
	allowed := map[string]map[string]bool{
		"wechat_mp": {"mp.weixin.qq.com": true},
		"xhs":       {"creator.xiaohongshu.com": true},
		"toutiao":   {"mp.toutiao.com": true, "creator.toutiao.com": true},
	}
	if !allowed[platform][host] {
		return "", validation("后台链接域名与作品平台不匹配")
	}
	return parsed.String(), nil
}

func loadPublishState(ctx context.Context, q dbtx, workID uuid.UUID, lock bool) (*publishStateRow, error) {
	query := `SELECT state,version,submitted_ref,scheduled_at,schedule_evidence,registered_metric_id,registered_metric_revision,publication_revision,since
		FROM work_publish_state WHERE work_id=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	var row publishStateRow
	err := q.QueryRow(ctx, query, workID).Scan(&row.State, &row.Version, &row.SubmittedRef, &row.ScheduledAt, &row.ScheduleEvidence,
		&row.RegisteredMetricID, &row.RegisteredMetricRevision, &row.PublicationRevision, &row.Since)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func loadPublishStateHistory(ctx context.Context, q dbtx, workID uuid.UUID) ([]publishStateEvent, error) {
	rows, err := q.Query(ctx, `SELECT id,event_kind,from_state,to_state,state_version,evidence,note,at
		FROM work_publish_state_event WHERE work_id=$1 ORDER BY state_version`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]publishStateEvent, 0)
	for rows.Next() {
		var item publishStateEvent
		if err := rows.Scan(&item.ID, &item.EventKind, &item.FromState, &item.ToState, &item.StateVersion, &item.Evidence, &item.Note, &item.At); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func publishStateResponseTx(ctx context.Context, tx pgx.Tx, workID uuid.UUID, out *map[string]any) error {
	var publication publicationState
	if err := tx.QueryRow(ctx, `SELECT status,published_url,published_at,locked,revision,publish_revision,wechat_msgid
		FROM work WHERE id=$1 AND deleted_at IS NULL`, workID).Scan(&publication.Status, &publication.URL, &publication.PublishedAt,
		&publication.Locked, &publication.Revision, &publication.PublishRevision, &publication.WechatMsgID); err != nil {
		return err
	}
	state, err := loadPublishState(ctx, tx, workID, false)
	if err != nil {
		return err
	}
	history, err := loadPublishStateHistory(ctx, tx, workID)
	if err != nil {
		return err
	}
	name := any(nil)
	version := 0
	var submitted, evidence json.RawMessage
	var scheduledAt *time.Time
	registration := map[string]any{"metric_id": nil, "revision": nil, "valid": false}
	if state != nil {
		name, version = state.State, state.Version
		submitted, evidence, scheduledAt = state.SubmittedRef, state.ScheduleEvidence, state.ScheduledAt
		if state.State == "registered" {
			valid, err := registeredMetricValid(ctx, tx, workID, state.RegisteredMetricID, state.RegisteredMetricRevision)
			if err != nil {
				return err
			}
			registration = map[string]any{"metric_id": state.RegisteredMetricID, "revision": state.RegisteredMetricRevision, "valid": valid}
			if !valid {
				if publication.Status == "published" {
					name = "public"
				} else {
					name = nil
				}
			}
		}
	} else if publication.Status == "published" {
		name = "public"
	}
	publicationView := map[string]any{"url": nil, "at": nil, "publish_revision": publication.PublishRevision}
	if publication.Status == "published" {
		publicationView["url"], publicationView["at"] = publication.URL, publication.PublishedAt
	}
	*out = map[string]any{"state": name, "version": version, "submitted_ref": submitted, "scheduled_at": scheduledAt,
		"schedule_evidence": evidence, "publication": publicationView, "registration": registration, "history": history}
	return nil
}

func registeredMetricValid(ctx context.Context, q dbtx, workID uuid.UUID, metricID *uuid.UUID, revision *int) (bool, error) {
	if metricID == nil || revision == nil {
		return false, nil
	}
	var currentRevision int
	var source, quality, readUnit, shareUnit string
	var sourceSupported bool
	var reads, likes, wows, favorites, comments, shares, follows *int
	var impressions *int64
	err := q.QueryRow(ctx, `SELECT revision,source,quality_state,read_unit,share_unit,reads,likes,wows,favorites,comments,shares,follows_gained,impressions,metric_source_supported(source)
		FROM metric_snapshot WHERE id=$1 AND work_id=$2`, *metricID, workID).
		Scan(&currentRevision, &source, &quality, &readUnit, &shareUnit, &reads, &likes, &wows, &favorites, &comments, &shares, &follows, &impressions, &sourceSupported)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return currentRevision == *revision && eligiblePublishMetric(sourceSupported, quality, readUnit, shareUnit, reads, likes, wows,
		favorites, comments, shares, follows, impressions), nil
}

func eligiblePublishMetric(sourceSupported bool, quality, readUnit, shareUnit string, reads, likes, wows, favorites, comments, shares, follows *int, impressions *int64) bool {
	if !sourceSupported || quality != "approved" {
		return false
	}
	return (reads != nil && readUnit != "unknown") || (shares != nil && shareUnit != "unknown") ||
		likes != nil || wows != nil || favorites != nil || comments != nil || follows != nil || impressions != nil
}

func publishStateEventInsert(ctx context.Context, tx pgx.Tx, workID uuid.UUID, kind string, fromState *string, toState string,
	version int, evidence any, note, key, requestHash string, actor *uuid.UUID) error {
	raw, err := json.Marshal(evidence)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO work_publish_state_event(work_id,event_kind,from_state,to_state,state_version,evidence,note,idempotency_key,request_hash,actor)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, workID, kind, fromState, toState, version, raw, note, key, requestHash, actor)
	return err
}

func publishActorID(ctx context.Context) *uuid.UUID {
	actor := ident(ctx)
	if actor == nil {
		return nil
	}
	return &actor.UserID
}

func (s *Server) requireLivePublishEditor(ctx context.Context, tx pgx.Tx) error {
	actor := ident(ctx)
	if actor == nil {
		return errUnauthorized
	}
	if actor.AdminOverride && actor.SystemAdmin {
		return nil
	}
	var role, status string
	err := tx.QueryRow(ctx, `SELECT role,status FROM workspace_member WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, actor.WorkspaceID, actor.UserID).Scan(&role, &status)
	if err == pgx.ErrNoRows {
		return errUnauthorized
	}
	if err != nil {
		return err
	}
	if status != "active" {
		return errUnauthorized
	}
	if role != "owner" && role != "editor" {
		return apiErr(http.StatusForbidden, "forbidden", "观察者仅可浏览，不能修改发布进度")
	}
	return nil
}

func invalidateRegisteredPublishMetric(ctx context.Context, tx pgx.Tx, metricID uuid.UUID, actor *uuid.UUID, forceDeleted bool) error {
	var workID uuid.UUID
	var state string
	var version int
	var storedRevision *int
	err := tx.QueryRow(ctx, `SELECT work_id,state,version,registered_metric_revision FROM work_publish_state
		WHERE state='registered' AND registered_metric_id=$1 FOR UPDATE`, metricID).Scan(&workID, &state, &version, &storedRevision)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	var currentRevision int
	var source, quality, readUnit, shareUnit string
	var sourceSupported bool
	var reads, likes, wows, favorites, comments, shares, follows *int
	var impressions *int64
	deleted := forceDeleted
	if !forceDeleted {
		err = tx.QueryRow(ctx, `SELECT revision,source,quality_state,read_unit,share_unit,reads,likes,wows,favorites,comments,shares,follows_gained,impressions,metric_source_supported(source)
			FROM metric_snapshot WHERE id=$1 AND work_id=$2`, metricID, workID).
			Scan(&currentRevision, &source, &quality, &readUnit, &shareUnit, &reads, &likes, &wows, &favorites, &comments, &shares, &follows, &impressions, &sourceSupported)
		deleted = err == pgx.ErrNoRows
		if err != nil && !deleted {
			return err
		}
	}
	if !deleted && storedRevision != nil && currentRevision == *storedRevision && eligiblePublishMetric(sourceSupported, quality, readUnit, shareUnit, reads, likes, wows, favorites, comments, shares, follows, impressions) {
		return nil
	}
	from := "registered"
	newVersion := version + 1
	metricRevisionText := "deleted"
	if !deleted {
		metricRevisionText = fmt.Sprint(currentRevision)
	}
	key := fmt.Sprintf("metric-invalidation:%s:%s", metricID, metricRevisionText)
	evidence := map[string]any{"metric_id": metricID, "registered_revision": storedRevision, "current_revision": nil, "quality_state": nil, "deleted": deleted}
	if !deleted {
		evidence["current_revision"], evidence["quality_state"] = currentRevision, quality
	}
	hash := sha256Hex([]byte(fmt.Sprintf("%s:%s:%d", metricID, metricRevisionText, newVersion)))
	if _, err := tx.Exec(ctx, `UPDATE work_publish_state SET state='public',version=$2,registered_metric_id=NULL,
		registered_metric_revision=NULL,since=now(),updated_by=$3 WHERE work_id=$1`, workID, newVersion, actor); err != nil {
		return err
	}
	return publishStateEventInsert(ctx, tx, workID, "invalidation", &from, "public", newVersion, evidence,
		"正式基线指标已更正、撤回或删除", key, hash, actor)
}

func invalidateRegisteredPublishState(ctx context.Context, tx pgx.Tx, workID uuid.UUID, actor *uuid.UUID) error {
	state, err := loadPublishState(ctx, tx, workID, true)
	if err != nil || state == nil || state.State != "registered" {
		return err
	}
	valid, err := registeredMetricValid(ctx, tx, workID, state.RegisteredMetricID, state.RegisteredMetricRevision)
	if err != nil || valid {
		return err
	}
	if state.RegisteredMetricID != nil {
		return invalidateRegisteredPublishMetric(ctx, tx, *state.RegisteredMetricID, actor, false)
	}
	newVersion := state.Version + 1
	key := fmt.Sprintf("metric-invalidation:missing:%d", newVersion)
	hash := sha256Hex([]byte(fmt.Sprintf("publish-registration-missing:%s:%d", workID, newVersion)))
	if _, err := tx.Exec(ctx, `UPDATE work_publish_state SET state='public',version=$2,registered_metric_id=NULL,
		registered_metric_revision=NULL,since=now(),updated_by=$3 WHERE work_id=$1`, workID, newVersion, actor); err != nil {
		return err
	}
	from := "registered"
	return publishStateEventInsert(ctx, tx, workID, "invalidation", &from, "public", newVersion,
		map[string]any{"metric_id": nil, "registered_revision": state.RegisteredMetricRevision, "deleted": true},
		"正式基线指标已删除", key, hash, actor)
}

func (s *Server) syncPublishStatePublic(ctx context.Context, tx pgx.Tx, workID uuid.UUID, publishRevision int, earlyReason string, actor *uuid.UUID) error {
	current, err := loadPublishState(ctx, tx, workID, true)
	if err != nil {
		return err
	}
	from := ""
	version := 0
	var submitted []byte
	if current != nil {
		from, version, submitted = current.State, current.Version, current.SubmittedRef
	}
	if current != nil && from == "registered" {
		return stateInvalid("已发布作品不能再次首次回填")
	}
	if from != "" && from != "submitted" && from != "scheduled" && from != "public" {
		return apiErr(http.StatusUnprocessableEntity, "invalid_transition", "当前发布进度不能登记公开事实")
	}
	version++
	if current == nil {
		if _, err := tx.Exec(ctx, `INSERT INTO work_publish_state(work_id,state,version,publication_revision,since,updated_by)
			VALUES($1,'public',$2,$3,now(),$4)`, workID, version, publishRevision, actor); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE work_publish_state SET state='public',version=$2,submitted_ref=$3,scheduled_at=NULL,
		schedule_evidence=NULL,registered_metric_id=NULL,registered_metric_revision=NULL,publication_revision=$4,since=now(),updated_by=$5
		WHERE work_id=$1`, workID, version, submitted, publishRevision, actor); err != nil {
		return err
	}
	evidence := map[string]any{"source": "published_endpoint"}
	if earlyReason != "" {
		evidence["early_public_reason"] = strings.TrimSpace(earlyReason)
	}
	var fromPtr *string
	if from != "" {
		fromPtr = &from
	}
	key := fmt.Sprintf("publication:%d", publishRevision)
	hash := sha256Hex([]byte(fmt.Sprintf("publication:%s:%d:%s", workID, publishRevision, strings.TrimSpace(earlyReason))))
	return publishStateEventInsert(ctx, tx, workID, "transition", fromPtr, "public", version, evidence,
		"通过既有发布回填入口登记", key, hash, actor)
}

func (s *Server) syncPublishStateCorrection(ctx context.Context, tx pgx.Tx, workID uuid.UUID, beforeRevision, afterRevision int, reason string, actor *uuid.UUID) error {
	current, err := loadPublishState(ctx, tx, workID, true)
	if err != nil {
		return err
	}
	from := ""
	version := 0
	var submitted []byte
	if current != nil {
		from, version, submitted = current.State, current.Version, current.SubmittedRef
	}
	if from != "" && from != "public" && from != "registered" {
		return stateInvalid("更正发布记录时台账状态不是公开")
	}
	version++
	if current == nil {
		if _, err := tx.Exec(ctx, `INSERT INTO work_publish_state(work_id,state,version,publication_revision,since,updated_by)
			VALUES($1,'public',$2,$3,now(),$4)`, workID, version, afterRevision, actor); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE work_publish_state SET state='public',version=$2,submitted_ref=$3,scheduled_at=NULL,
		schedule_evidence=NULL,registered_metric_id=NULL,registered_metric_revision=NULL,publication_revision=$4,since=now(),updated_by=$5
		WHERE work_id=$1`, workID, version, submitted, afterRevision, actor); err != nil {
		return err
	}
	evidence := map[string]any{"publish_revision_before": beforeRevision, "publish_revision_after": afterRevision}
	var fromPtr *string
	if from != "" {
		fromPtr = &from
	}
	key := fmt.Sprintf("correction:%d", afterRevision)
	hash := sha256Hex([]byte(fmt.Sprintf("publish-correction:%s:%d:%d:%s", workID, beforeRevision, afterRevision, strings.TrimSpace(reason))))
	_, err = tx.Exec(ctx, `INSERT INTO work_publish_state_event(work_id,event_kind,from_state,to_state,state_version,evidence,note,idempotency_key,request_hash,actor)
		VALUES($1,'correction',$2,'public',$3,$4,$5,$6,$7,$8)`, workID, fromPtr, version, mustJSON(evidence), strings.TrimSpace(reason), key, hash, actor)
	return err
}

func (s *Server) validateEarlyPublicReason(ctx context.Context, tx pgx.Tx, workID uuid.UUID, publishedAt time.Time, reason string) (string, error) {
	state, err := loadPublishState(ctx, tx, workID, true)
	if err != nil {
		return "", err
	}
	if state == nil || state.State != "scheduled" || state.ScheduledAt == nil || !publishedAt.Before(*state.ScheduledAt) {
		if strings.TrimSpace(reason) != "" {
			return "", validation("early_public_reason 仅适用于提前公开预约")
		}
		return "", nil
	}
	clean := strings.TrimSpace(reason)
	if runeLen(clean) < 1 || runeLen(clean) > 500 {
		return "", apiErr(http.StatusUnprocessableEntity, "early_public_reason_required", "预约时间尚未到达，提前回填公开需要填写 1 到 500 字说明")
	}
	return clean, nil
}

func backendURLMatchesPlatform(platform string, raw string) bool {
	_, err := validatePlatformBackendURL(platform, raw)
	return err == nil
}

func publishStateCurrentMatches(ctx context.Context, tx pgx.Tx, workID uuid.UUID, state string) (bool, error) {
	var current string
	err := tx.QueryRow(ctx, `SELECT state FROM work_publish_state WHERE work_id=$1`, workID).Scan(&current)
	if err == pgx.ErrNoRows {
		return state == "", nil
	}
	return current == state, err
}
