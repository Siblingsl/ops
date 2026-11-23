package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
)

const publishValidatorVersion = "p1.0"

type PublishManifestFields struct {
	Title          string         `json:"title"`
	BodyMD         string         `json:"body_md"`
	BodyText       string         `json:"body_text"`
	Tags           []string       `json:"tags"`
	CoverAssetID   *uuid.UUID     `json:"cover_asset_id"`
	PlatformFields map[string]any `json:"platform_fields"`
	ScheduleAt     *time.Time     `json:"schedule_at"`
	SkipReason     string         `json:"skip_reason"`
}

type PublishManifestAsset struct {
	AssetID uuid.UUID `json:"asset_id"`
	Role    string    `json:"role"`
	SHA256  string    `json:"sha256"`
	Width   int       `json:"width"`
	Height  int       `json:"height"`
}

type PublishManifestSource struct {
	WorkRevision           int `json:"work_revision"`
	PublishRevision        int `json:"publish_revision"`
	AccountProfileRevision int `json:"account_profile_revision"`
}

type PublishManifestPayload struct {
	SchemaVersion int                    `json:"schema_version"`
	Platform      string                 `json:"platform"`
	Fields        PublishManifestFields  `json:"fields"`
	Assets        []PublishManifestAsset `json:"assets"`
	Source        PublishManifestSource  `json:"source"`
}

type PublishManifest struct {
	ID               uuid.UUID              `json:"id"`
	WorkspaceID      uuid.UUID              `json:"workspace_id"`
	AccountID        uuid.UUID              `json:"account_id"`
	WorkID           uuid.UUID              `json:"work_id"`
	Platform         string                 `json:"platform"`
	Revision         int                    `json:"revision"`
	SchemaVersion    int                    `json:"schema_version"`
	ContentHash      string                 `json:"content_hash"`
	Payload          PublishManifestPayload `json:"payload"`
	Validation       PublishValidation      `json:"validation"`
	ValidationState  string                 `json:"validation_state"`
	ValidatedAt      *time.Time             `json:"validated_at"`
	ValidatorVersion string                 `json:"validator_version"`
	CreatedBy        *uuid.UUID             `json:"created_by,omitempty"`
	CreatedAt        time.Time              `json:"created_at"`
	UpdatedAt        time.Time              `json:"updated_at"`
}

const publishManifestCols = `m.id, m.workspace_id, m.account_id, m.work_id, m.platform, m.revision,
	m.schema_version, m.content_hash, m.payload, m.validation, m.validation_state,
	m.validated_at, m.validator_version, m.created_by, m.created_at, m.updated_at`

func (s *Server) loadPublishManifest(ctx context.Context, workID uuid.UUID, platform string) (*PublishManifest, error) {
	var m PublishManifest
	var payload, validation []byte
	err := s.db.QueryRow(ctx, `SELECT `+publishManifestCols+` FROM publish_manifest m
		JOIN work w ON w.id=m.work_id JOIN platform_account a ON a.id=m.account_id
		WHERE m.work_id=$1 AND m.platform=$2 AND m.workspace_id=$3
		  AND a.workspace_id=$3 AND w.account_id=m.account_id AND w.deleted_at IS NULL`,
		workID, platform, ident(ctx).WorkspaceID).Scan(
		&m.ID, &m.WorkspaceID, &m.AccountID, &m.WorkID, &m.Platform, &m.Revision,
		&m.SchemaVersion, &m.ContentHash, &payload, &validation, &m.ValidationState,
		&m.ValidatedAt, &m.ValidatorVersion, &m.CreatedBy, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(payload, &m.Payload); err != nil {
		return nil, fmt.Errorf("manifest payload 解析失败: %w", err)
	}
	if err := json.Unmarshal(validation, &m.Validation); err != nil {
		return nil, fmt.Errorf("manifest validation 解析失败: %w", err)
	}
	if m.Payload.Assets == nil {
		m.Payload.Assets = []PublishManifestAsset{}
	}
	if m.Payload.Fields.Tags == nil {
		m.Payload.Fields.Tags = []string{}
	}
	if m.Payload.Fields.PlatformFields == nil {
		m.Payload.Fields.PlatformFields = map[string]any{}
	}
	if m.Validation.Checks == nil {
		m.Validation.Checks = []PublishCheck{}
	}
	return &m, nil
}

func (s *Server) listPublishManifests(ctx context.Context, workID uuid.UUID) ([]PublishManifest, error) {
	rows, err := s.db.Query(ctx, `SELECT `+publishManifestCols+` FROM publish_manifest m
		JOIN work w ON w.id=m.work_id JOIN platform_account a ON a.id=m.account_id
		WHERE m.work_id=$1 AND m.workspace_id=$2
		  AND a.workspace_id=$2 AND w.account_id=m.account_id AND w.deleted_at IS NULL
		ORDER BY m.platform`, workID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]PublishManifest, 0, 3)
	for rows.Next() {
		var m PublishManifest
		var payload, validation []byte
		if err := rows.Scan(&m.ID, &m.WorkspaceID, &m.AccountID, &m.WorkID, &m.Platform, &m.Revision,
			&m.SchemaVersion, &m.ContentHash, &payload, &validation, &m.ValidationState,
			&m.ValidatedAt, &m.ValidatorVersion, &m.CreatedBy, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(payload, &m.Payload); err != nil {
			return nil, fmt.Errorf("manifest payload 解析失败: %w", err)
		}
		if err := json.Unmarshal(validation, &m.Validation); err != nil {
			return nil, fmt.Errorf("manifest validation 解析失败: %w", err)
		}
		if m.Payload.Assets == nil {
			m.Payload.Assets = []PublishManifestAsset{}
		}
		if m.Payload.Fields.Tags == nil {
			m.Payload.Fields.Tags = []string{}
		}
		if m.Payload.Fields.PlatformFields == nil {
			m.Payload.Fields.PlatformFields = map[string]any{}
		}
		if m.Validation.Checks == nil {
			m.Validation.Checks = []PublishCheck{}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Server) publishWorkRevision(ctx context.Context, workID uuid.UUID) (int, int, error) {
	var revision, publishRevision int
	err := s.db.QueryRow(ctx, `SELECT w.revision, w.publish_revision FROM work w
		JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`,
		workID, ident(ctx).WorkspaceID).Scan(&revision, &publishRevision)
	return revision, publishRevision, err
}

// effectivePublishManifestState computes stale on read; no cron or timer is
// involved, so a saved valid manifest cannot pretend to be current after an edit.
func (s *Server) effectivePublishManifestState(ctx context.Context, m *PublishManifest) (string, error) {
	if m.ValidationState == "stale" {
		return "stale", nil
	}
	revision, publishRevision, err := s.publishWorkRevision(ctx, m.WorkID)
	if err != nil {
		return "", err
	}
	if m.Payload.Source.WorkRevision != revision || m.Payload.Source.PublishRevision != publishRevision {
		return "stale", nil
	}
	if m.ValidationState == "invalid" || publishValidationState(m.Validation) == "invalid" {
		return "invalid", nil
	}
	if m.ValidationState == "pending" {
		return "pending", nil
	}
	return "valid", nil
}

func (s *Server) withEffectiveManifestState(ctx context.Context, m *PublishManifest) error {
	state, err := s.effectivePublishManifestState(ctx, m)
	if err != nil {
		return err
	}
	m.ValidationState = state
	return nil
}

func (s *Server) publishPlatformFromPath(r *http.Request) (string, error) {
	platform := chiParam(r, "platform")
	if !publishPlatformSupported(platform) {
		return "", apiErr(http.StatusUnprocessableEntity, "publish_platform_invalid", "暂不支持该发布平台")
	}
	return platform, nil
}

func (s *Server) publishManifestWork(r *http.Request) (*Work, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, err
	}
	return s.loadWork(r.Context(), id)
}

func (s *Server) buildPublishPayload(ctx context.Context, w *Work, platform string) (PublishManifestPayload, error) {
	profile, err := s.loadProfile(ctx, w.AccountID)
	if err != nil {
		return PublishManifestPayload{}, err
	}
	tags := append([]string{}, w.Tags...)
	if platform == "toutiao" {
		tags = append([]string{}, w.Topics...)
	}
	platformFields := map[string]any{"content_format": w.ContentFormat}
	if platform == "wechat_mp" {
		author := strings.TrimSpace(w.WechatFields.Author)
		if author == "" {
			author = strings.TrimSpace(profile.WechatDefaults.Author)
		}
		platformFields["summary"] = w.Summary
		platformFields["author"] = author
		platformFields["open_comment"] = w.WechatFields.OpenComment
		platformFields["fans_only_comment"] = w.WechatFields.FansOnlyComment
		platformFields["source_url"] = w.WechatFields.SourceURL
	}

	var body strings.Builder
	for _, section := range w.Sections {
		if heading := strings.TrimSpace(section.Heading); heading != "" {
			fmt.Fprintf(&body, "## %s\n\n", heading)
		}
		if text := strings.TrimSpace(section.ContentMD); text != "" {
			body.WriteString(text)
			body.WriteString("\n\n")
		}
	}
	bodyMD := strings.TrimSpace(body.String())
	bodyText := toutiaoMarkdownPlain(bodyMD)
	// 公众号保留 Markdown 快照；实际 HTML 仍由现有前端渲染链在推送时生成。
	if platform != "wechat_mp" {
		bodyMD = bodyText
	}

	assets, err := s.publishManifestAssets(ctx, w, platform)
	if err != nil {
		return PublishManifestPayload{}, err
	}
	return PublishManifestPayload{
		SchemaVersion: 1,
		Platform:      platform,
		Fields: PublishManifestFields{
			Title:          w.Title,
			BodyMD:         bodyMD,
			BodyText:       bodyText,
			Tags:           publishCleanTags(tags),
			CoverAssetID:   w.CoverAssetID,
			PlatformFields: platformFields,
			ScheduleAt:     nil,
			SkipReason:     "",
		},
		Assets: assets,
		Source: PublishManifestSource{
			WorkRevision:    w.Revision,
			PublishRevision: w.PublishRevision,
			// account_profile 当前没有 revision 列；0 表示 OPS 现有档案没有独立版本号。
			AccountProfileRevision: 0,
		},
	}, nil
}

func (s *Server) publishManifestAssets(ctx context.Context, w *Work, platform string) ([]PublishManifestAsset, error) {
	rows, err := s.db.Query(ctx, `SELECT id, sha256, width, height FROM asset
		WHERE work_id=$1 AND workspace_id=$2 AND mime LIKE 'image/%'
		ORDER BY position, created_at`, w.ID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	assets := make([]PublishManifestAsset, 0, len(w.Assets))
	for rows.Next() {
		var asset PublishManifestAsset
		if err := rows.Scan(&asset.AssetID, &asset.SHA256, &asset.Width, &asset.Height); err != nil {
			return nil, err
		}
		asset.Role = "inline"
		if w.CoverAssetID != nil && *w.CoverAssetID == asset.AssetID {
			asset.Role = "cover"
		}
		assets = append(assets, asset)
	}
	return assets, rows.Err()
}

func (s *Server) publishManifestValidation(ctx context.Context, accountID uuid.UUID, platform string, payload PublishManifestPayload, opts publishValidationOptions) (PublishValidation, error) {
	words, err := s.checkWords(ctx, accountID)
	if err != nil {
		return PublishValidation{}, err
	}
	banned := make([]string, 0, len(words))
	for _, word := range words {
		banned = append(banned, word.w)
	}
	return validatePublishManifest(platform, payload, publishValidationContext{BannedWords: banned, Options: opts}), nil
}

func (s *Server) createOrRebuildPublishManifest(w http.ResponseWriter, r *http.Request) error {
	platform, err := s.publishPlatformFromPath(r)
	if err != nil {
		return err
	}
	wk, err := s.publishManifestWork(r)
	if err != nil {
		return err
	}
	payload, err := s.buildPublishPayload(r.Context(), wk, platform)
	if err != nil {
		return err
	}
	validation, err := s.publishManifestValidation(r.Context(), wk.AccountID, platform, payload, publishValidationOptions{Now: s.now()})
	if err != nil {
		return err
	}
	hash, err := cxcanonicaljson.Hash(payload)
	if err != nil {
		return err
	}
	state := publishValidationState(validation)
	validationJSON, err := json.Marshal(validation)
	if err != nil {
		return err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	var current PublishManifest
	var currentPayload, currentValidation []byte
	err = tx.QueryRow(ctx, `SELECT `+publishManifestCols+` FROM publish_manifest m
		WHERE m.work_id=$1 AND m.platform=$2 AND m.workspace_id=$3 AND m.account_id=$4 FOR UPDATE`,
		wk.ID, platform, ident(ctx).WorkspaceID, wk.AccountID).Scan(
		&current.ID, &current.WorkspaceID, &current.AccountID, &current.WorkID, &current.Platform, &current.Revision,
		&current.SchemaVersion, &current.ContentHash, &currentPayload, &currentValidation, &current.ValidationState,
		&current.ValidatedAt, &current.ValidatorVersion, &current.CreatedBy, &current.CreatedAt, &current.UpdatedAt)
	if err == nil {
		// 重建先把当前行冻结进 revision 历史，再更新当前行；历史不删除。
		_, err = tx.Exec(ctx, `INSERT INTO publish_manifest_revision
			(manifest_id, revision, content_hash, payload, validation, validator_version, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,now())`,
			current.ID, current.Revision, current.ContentHash, currentPayload, currentValidation, current.ValidatorVersion)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE publish_manifest SET revision=revision+1, schema_version=1,
			content_hash=$2, payload=$3, validation=$4, validation_state=$5, validated_at=now(),
			validator_version=$6, updated_at=now() WHERE id=$1`,
			current.ID, hash, payloadJSON, validationJSON, state, publishValidatorVersion)
		if err != nil {
			return err
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO publish_manifest
			(workspace_id, account_id, work_id, platform, revision, schema_version, content_hash,
			 payload, validation, validation_state, validated_at, validator_version, created_by)
			VALUES ($1,$2,$3,$4,1,1,$5,$6,$7,$8,now(),$9,$10) RETURNING id`,
			ident(ctx).WorkspaceID, wk.AccountID, wk.ID, platform, hash, payloadJSON, validationJSON, state,
			publishValidatorVersion, ident(ctx).UserID).Scan(&current.ID)
		if err != nil {
			return err
		}
	} else {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.writePublishManifest(w, r, wk.ID, platform)
}

func (s *Server) getPublishManifest(w http.ResponseWriter, r *http.Request) error {
	platform, err := s.publishPlatformFromPath(r)
	if err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	m, err := s.loadPublishManifest(r.Context(), workID, platform)
	if err != nil {
		return err
	}
	if err := s.withEffectiveManifestState(r.Context(), m); err != nil {
		return err
	}
	return ok(w, m)
}

func (s *Server) listPublishManifestsHandler(w http.ResponseWriter, r *http.Request) error {
	if _, err := s.publishManifestWork(r); err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	items, err := s.listPublishManifests(r.Context(), workID)
	if err != nil {
		return err
	}
	for i := range items {
		if err := s.withEffectiveManifestState(r.Context(), &items[i]); err != nil {
			return err
		}
	}
	return ok(w, items)
}

func (s *Server) validatePublishManifestHandler(w http.ResponseWriter, r *http.Request) error {
	platform, err := s.publishPlatformFromPath(r)
	if err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	m, err := s.loadPublishManifest(r.Context(), workID, platform)
	if err != nil {
		return err
	}
	state, err := s.effectivePublishManifestState(r.Context(), m)
	if err != nil {
		return err
	}
	if state == "stale" {
		return apiErr(http.StatusConflict, "publish_manifest_stale", "作品已改稿或发布版本已变化，请先重新生成 manifest")
	}
	validation, err := s.publishManifestValidation(r.Context(), m.AccountID, platform, m.Payload, publishValidationOptions{Now: s.now()})
	if err != nil {
		return err
	}
	validationJSON, err := json.Marshal(validation)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(r.Context(), `UPDATE publish_manifest SET validation=$2, validation_state=$3,
		validated_at=now(), validator_version=$4, updated_at=now() WHERE id=$1`,
		m.ID, validationJSON, publishValidationState(validation), publishValidatorVersion)
	if err != nil {
		return err
	}
	return s.writePublishManifest(w, r, workID, platform)
}

func (s *Server) patchPublishManifest(w http.ResponseWriter, r *http.Request) error {
	platform, err := s.publishPlatformFromPath(r)
	if err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := decode(r, &raw); err != nil {
		return err
	}
	m, err := s.loadPublishManifest(r.Context(), workID, platform)
	if err != nil {
		return err
	}
	for key := range raw {
		switch key {
		case "platform_fields", "schedule_at", "skip_reason":
		default:
			return apiErr(http.StatusUnprocessableEntity, "publish_manifest_content_readonly",
				"标题/正文/标签/封面等内容字段只读，请修改作品后重新生成 manifest")
		}
	}
	if raw["platform_fields"] != nil {
		var fields map[string]any
		if err := json.Unmarshal(raw["platform_fields"], &fields); err != nil || fields == nil {
			return validation("platform_fields 必须是对象")
		}
		m.Payload.Fields.PlatformFields = fields
	}
	if raw["schedule_at"] != nil {
		var schedule *time.Time
		if string(raw["schedule_at"]) != "null" {
			var value time.Time
			if err := json.Unmarshal(raw["schedule_at"], &value); err != nil {
				return validation("schedule_at 必须是 RFC3339 时间或 null")
			}
			schedule = &value
		}
		m.Payload.Fields.ScheduleAt = schedule
	}
	if raw["skip_reason"] != nil {
		var reason string
		if err := json.Unmarshal(raw["skip_reason"], &reason); err != nil {
			return validation("skip_reason 必须是字符串")
		}
		if runeLen(reason) > 200 {
			return validation("跳过原因不能超过 200 字")
		}
		m.Payload.Fields.SkipReason = reason
	}
	// PATCH 修改平台扩展字段/定时/跳过原因，也递增 revision 并写 history。
	return s.updatePublishManifestRow(w, r, workID, platform, m, true)
}

func (s *Server) updatePublishManifestRow(w http.ResponseWriter, r *http.Request, workID uuid.UUID, platform string, m *PublishManifest, bumpRevision bool) error {
	if m.Payload.Fields.Tags == nil {
		m.Payload.Fields.Tags = []string{}
	}
	if m.Payload.Fields.PlatformFields == nil {
		m.Payload.Fields.PlatformFields = map[string]any{}
	}
	if m.Payload.Assets == nil {
		m.Payload.Assets = []PublishManifestAsset{}
	}
	m.Payload.Platform = platform
	m.Payload.SchemaVersion = 1
	validation, err := s.publishManifestValidation(r.Context(), m.AccountID, platform, m.Payload, publishValidationOptions{Now: s.now()})
	if err != nil {
		return err
	}
	state := publishValidationState(validation)
	hash, err := cxcanonicaljson.Hash(m.Payload)
	if err != nil {
		return err
	}
	validationJSON, err := json.Marshal(validation)
	if err != nil {
		return err
	}
	payloadJSON, err := json.Marshal(m.Payload)
	if err != nil {
		return err
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if bumpRevision {
		var oldHash string
		var oldPayload, oldValidation []byte
		var oldRevision int
		var oldValidator string
		if err := tx.QueryRow(ctx, `SELECT revision, content_hash, payload, validation, validator_version
			FROM publish_manifest WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, m.ID, ident(ctx).WorkspaceID).
			Scan(&oldRevision, &oldHash, &oldPayload, &oldValidation, &oldValidator); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO publish_manifest_revision
			(manifest_id, revision, content_hash, payload, validation, validator_version, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,now())`,
			m.ID, oldRevision, oldHash, oldPayload, oldValidation, oldValidator); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE publish_manifest SET revision=revision+1, content_hash=$2,
			payload=$3, validation=$4, validation_state=$5, validated_at=now(),
			validator_version=$6, updated_at=now() WHERE id=$1`,
			m.ID, hash, payloadJSON, validationJSON, state, publishValidatorVersion)
	} else {
		_, err = tx.Exec(ctx, `UPDATE publish_manifest SET content_hash=$2, payload=$3, validation=$4,
			validation_state=$5, validated_at=now(), validator_version=$6, updated_at=now() WHERE id=$1`,
			m.ID, hash, payloadJSON, validationJSON, state, publishValidatorVersion)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.writePublishManifest(w, r, workID, platform)
}

func (s *Server) writePublishManifest(w http.ResponseWriter, r *http.Request, workID uuid.UUID, platform string) error {
	m, err := s.loadPublishManifest(r.Context(), workID, platform)
	if err != nil {
		return err
	}
	if err := s.withEffectiveManifestState(r.Context(), m); err != nil {
		return err
	}
	return ok(w, m)
}
