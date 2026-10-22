package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) createDraftFromPlatformMirror(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	mirrorID, err := pathID(r, "platformWorkId")
	if err != nil {
		return err
	}
	var in struct {
		ExpectedMirrorRevision  int64 `json:"expected_mirror_revision"`
		ExpectedContentRevision int   `json:"expected_content_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.ExpectedMirrorRevision < 1 || in.ExpectedContentRevision < 0 {
		return validation("请刷新平台作品详情后再创建草稿")
	}
	if account.Status != "active" {
		return stateInvalid("账号已停用，不能新建作品")
	}
	profile, err := s.loadProfile(r.Context(), account.ID)
	if err != nil {
		return err
	}
	wechatFields, _ := json.Marshal(profile.WechatDefaults)
	var workID uuid.UUID
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var accountStatus, accountPlatform, platform, remoteType, remoteStatus, title, bodyText, contentState string
		var mirrorRevision int64
		var contentRevision int
		var cover *string
		var mediaRefs, bodyStructure []byte
		if err := tx.QueryRow(r.Context(), `SELECT status,platform FROM platform_account
			WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, account.ID, ident(r.Context()).WorkspaceID).Scan(&accountStatus, &accountPlatform); err != nil {
			return errNotFound
		}
		if accountStatus != "active" {
			return stateInvalid("账号已停用，不能新建作品")
		}
		if err := tx.QueryRow(r.Context(), `SELECT platform,remote_content_type,remote_status,title,body_text,
			cover_ref,media_refs,body_structure,content_state,content_revision,revision
			FROM platform_work_mirror WHERE id=$1 AND workspace_id=$2 AND account_id=$3 FOR SHARE`,
			mirrorID, ident(r.Context()).WorkspaceID, account.ID).Scan(&platform, &remoteType, &remoteStatus, &title, &bodyText,
			&cover, &mediaRefs, &bodyStructure, &contentState, &contentRevision, &mirrorRevision); err != nil {
			return errNotFound
		}
		if platform != accountPlatform {
			return errNotFound
		}
		if mirrorRevision != in.ExpectedMirrorRevision || contentRevision != in.ExpectedContentRevision {
			return apiErr(http.StatusConflict, "platform_mirror_changed", "平台作品内容已更新，请刷新后再创建草稿")
		}
		if remoteStatus != "published" || contentState != "complete" || strings.TrimSpace(bodyText) == "" || !utf8.ValidString(bodyText) || len(bodyText) > 1<<20 {
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "正文不完整或无法安全转换为本地草稿")
		}
		if cover != nil && *cover != "" {
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "作品包含未能复制到本地草稿的封面或媒体")
		}
		var media []json.RawMessage
		if err := json.Unmarshal(mediaRefs, &media); err != nil || len(media) > 0 {
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "作品包含未能复制到本地草稿的媒体")
		}
		var blocks []platformV2ContentBlock
		if err := json.Unmarshal(bodyStructure, &blocks); err != nil {
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "作品排版无法安全转换为本地草稿")
		}
		for _, block := range blocks {
			if block.Type != "paragraph" {
				return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "作品排版或媒体无法无损转换为本地草稿")
			}
		}
		format := ""
		switch {
		case platform == "wechat_mp" && remoteType == "wechat_article":
			format = "long_article"
		case platform == "xhs" && remoteType == "image_note":
			format = "image_note"
		default:
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "该平台作品体裁不支持无损创建本地草稿")
		}
		resolvedFormat, formatErr := resolveCreationFormat(account, format, "")
		if formatErr != nil {
			return apiErr(http.StatusUnprocessableEntity, "platform_content_not_convertible", "当前账号类型不支持该平台作品体裁")
		}
		format = resolvedFormat
		var workTheme string
		if profile.DefaultTheme != "" {
			workTheme = profile.DefaultTheme
		} else {
			workTheme = "ink"
		}
		if err := tx.QueryRow(r.Context(), `INSERT INTO work
			(account_id,content_format,title,theme,wechat_fields,platform_source_mirror_id,
			 platform_source_content_revision,platform_source_mirror_revision)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, account.ID, format,
			truncateRunes(strings.TrimSpace(title), 64), workTheme, wechatFields, mirrorID, contentRevision, mirrorRevision).Scan(&workID); err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `INSERT INTO work_section(work_id,position,heading,content_md,origin)
			VALUES ($1,0,'',$2,'human')`, workID, bodyText); err != nil {
			return err
		}
		return s.auditTx(r.Context(), tx, "platform_mirror_draft_create", "work", workID.String(), "ok", map[string]any{
			"account_id": account.ID, "platform_source_mirror_id": mirrorID,
			"platform_source_content_revision": contentRevision, "platform_source_mirror_revision": mirrorRevision,
		})
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, workID)
}
