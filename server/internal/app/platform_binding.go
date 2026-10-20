package app

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 平台绑定：把一篇 OPS 作品固定到平台上一个稳定外部编号（20 文档 §7）。
// 微信沿用 work.wechat_msgid，小红书用 work.xhs_note_id；不新增可独立写入的通用键。
// 绑定只接受精确编号，不接受标题/封面相似度——后者只进 metric_unmatched 待逐条确认。

const (
	bindingSourceUserLink      = "user_link"
	bindingSourceUserConfirm   = "user_confirm"
	bindingSourceOfficialExact = "official_exact"
	bindingSourceLegacyTitle   = "legacy_title"
)

var (
	// 公众号文章编号 <appmsgid>_<itemidx>（D-129 v0.4 实测确定），不接受发表记录的内部 msgid。
	wechatArticleIDPattern = regexp.MustCompile(`^[0-9]{1,32}_[1-9][0-9]{0,2}$`)
	// 小红书 note_id 为 24 位十六进制。
	xhsNoteIDPattern = regexp.MustCompile(`^[0-9a-f]{24}$`)
)

// WorkPlatformBinding 是作品详情里暴露的平台绑定派生字段（20 文档 §7.1）。
// ExternalID 按平台从 wechat_msgid/xhs_note_id 派生，不另存一份可独立写入的通用编号。
type WorkPlatformBinding struct {
	ExternalID            *string    `json:"external_id"`
	MetricBindingRevision int        `json:"metric_binding_revision"`
	MetricBindingAt       *time.Time `json:"metric_binding_confirmed_at"`
	PlatformBindingSource *string    `json:"platform_binding_source"`
	PlatformBindingAt     *time.Time `json:"platform_binding_verified_at"`
}

type platformBindingState struct {
	WorkID            uuid.UUID
	Status            string
	Deleted           bool
	PublishRevision   int
	BindingRevision   int
	WechatMsgID       *string
	XhsNoteID         *string
	BindingSource     *string
	BindingVerifiedAt *time.Time
}

// loadPlatformBinding 读取绑定相关字段。调用方必须先确认作品在当前工作区内。
func loadPlatformBinding(ctx context.Context, tx pgx.Tx, workID uuid.UUID, lock bool) (platformBindingState, error) {
	query := `SELECT id, status, deleted_at IS NOT NULL, publish_revision, metric_binding_revision,
		wechat_msgid, xhs_note_id, platform_binding_source, platform_binding_verified_at
		FROM work WHERE id=$1`
	if lock {
		query += ` FOR UPDATE`
	}
	var b platformBindingState
	err := tx.QueryRow(ctx, query, workID).Scan(&b.WorkID, &b.Status, &b.Deleted, &b.PublishRevision,
		&b.BindingRevision, &b.WechatMsgID, &b.XhsNoteID, &b.BindingSource, &b.BindingVerifiedAt)
	return b, err
}

// normalizeExternalID 校验编号形态并返回可持久化的值。不同平台的编号空间不互通，
// 因此按平台分别校验，未知平台一律拒绝而不是“按文本存着”。
func normalizeExternalID(platform, externalID string) (string, error) {
	id := strings.TrimSpace(strings.ToLower(externalID))
	switch platform {
	case "wechat_mp":
		if !wechatArticleIDPattern.MatchString(id) {
			return "", validation("公众号文章编号应为 <appmsgid>_<itemidx> 形式")
		}
		return id, nil
	case "xhs":
		if !xhsNoteIDPattern.MatchString(id) {
			return "", validation("小红书笔记编号应为 24 位十六进制")
		}
		return id, nil
	default:
		return "", apiErr(422, "platform_not_supported", "该平台暂不支持作品绑定")
	}
}

// setPlatformBinding 是单篇绑定唯一的写入点：建立与改绑都走这里，并同时比较
// metric_binding_revision 与 publish_revision，避免期间发生过发布更正或他人改绑。
func setPlatformBinding(ctx context.Context, tx pgx.Tx, workID uuid.UUID, platform, externalID string, expectBinding, expectPublish int, source string, actor uuid.UUID) (int, error) {
	current, err := loadPlatformBinding(ctx, tx, workID, true)
	if err != nil {
		return 0, err
	}
	if current.Deleted {
		return 0, errNotFound
	}
	if current.BindingRevision != expectBinding || current.PublishRevision != expectPublish {
		return 0, apiErr(409, "platform_binding_changed", "作品绑定或发布信息已变化，请刷新后重试")
	}
	// 同一平台作品已绑定到另一篇作品时明确返回冲突对象，不静默覆盖。
	var other uuid.UUID
	var otherTitle string
	err = tx.QueryRow(ctx, `SELECT id, title FROM work WHERE account_id=(SELECT account_id FROM work WHERE id=$1)
		AND deleted_at IS NULL AND id<>$1 AND `+platformExternalColumn(platform)+`=$2 LIMIT 1`,
		workID, externalID).Scan(&other, &otherTitle)
	if err == nil {
		return 0, apiErr(409, "platform_binding_conflict", "该平台作品已绑定到另一篇作品").
			With(map[string]any{"work_id": other, "title": otherTitle})
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	var revision int
	err = tx.QueryRow(ctx, `UPDATE work SET `+platformExternalColumn(platform)+`=$2,
		platform_binding_source=$3, platform_binding_verified_at=now(),
		metric_binding_revision=metric_binding_revision+1,
		metric_binding_confirmed_at=now(), metric_binding_confirmed_by=$4, updated_at=now()
		WHERE id=$1 RETURNING metric_binding_revision`,
		workID, externalID, source, actor).Scan(&revision)
	return revision, err
}

func platformExternalColumn(platform string) string {
	if platform == "xhs" {
		return "xhs_note_id"
	}
	return "wechat_msgid"
}

// clearPlatformBinding 解除绑定：只清编号与来源，不删任何历史指标，
// 已采用的指标保留自己的 source/as_of_at 供追溯（20 文档 §7.2）。
func (s *Server) clearPlatformBinding(ctx context.Context, tx pgx.Tx, workID uuid.UUID, platform string, expectBinding, expectPublish int) (int, error) {
	current, err := loadPlatformBinding(ctx, tx, workID, true)
	if err != nil {
		return 0, err
	}
	if current.BindingRevision != expectBinding || current.PublishRevision != expectPublish {
		return 0, apiErr(409, "platform_binding_changed", "作品绑定或发布信息已变化，请刷新后重试")
	}
	var revision int
	err = tx.QueryRow(ctx, `UPDATE work SET `+platformExternalColumn(platform)+`=NULL,
		platform_binding_source=NULL, platform_binding_verified_at=NULL,
		metric_binding_revision=metric_binding_revision+1, updated_at=now()
		WHERE id=$1 RETURNING metric_binding_revision`, workID).Scan(&revision)
	return revision, err
}

// putPlatformBinding 处理 PUT /works/{id}/platform-binding：一次只确认一篇作品。
func (s *Server) putPlatformBinding(w http.ResponseWriter, r *http.Request) error {
	workID, platform, err := s.platformBindingTarget(r)
	if err != nil {
		return err
	}
	var in struct {
		ExternalID        string `json:"external_id"`
		MetricBindingRev  int    `json:"metric_binding_revision"`
		PublishRevision   int    `json:"publish_revision"`
		BindingSourceText string `json:"binding_source"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	externalID, err := normalizeExternalID(platform, in.ExternalID)
	if err != nil {
		return err
	}
	source, err := normalizeBindingSource(in.BindingSourceText)
	if err != nil {
		return err
	}
	var revision int
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var e error
		revision, e = setPlatformBinding(r.Context(), tx, workID, platform, externalID,
			in.MetricBindingRev, in.PublishRevision, source, ident(r.Context()).UserID)
		if e != nil {
			return e
		}
		return s.auditTx(r.Context(), tx, "platform_binding_set", "work", workID.String(), "ok", map[string]any{
			"platform": platform, "external_id": externalID, "binding_source": source,
			"metric_binding_revision": revision, "publish_revision": in.PublishRevision,
		})
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"work_id": workID, "external_id": externalID,
		"binding_source": source, "metric_binding_revision": revision})
}

// deletePlatformBinding 处理 DELETE /works/{id}/platform-binding。
func (s *Server) deletePlatformBinding(w http.ResponseWriter, r *http.Request) error {
	workID, platform, err := s.platformBindingTarget(r)
	if err != nil {
		return err
	}
	var in struct {
		MetricBindingRev int `json:"metric_binding_revision"`
		PublishRevision  int `json:"publish_revision"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	var revision int
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var e error
		revision, e = s.clearPlatformBinding(r.Context(), tx, workID, platform,
			in.MetricBindingRev, in.PublishRevision)
		if e != nil {
			return e
		}
		return s.auditTx(r.Context(), tx, "platform_binding_clear", "work", workID.String(), "ok", map[string]any{
			"platform": platform, "metric_binding_revision": revision,
		})
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"work_id": workID, "metric_binding_revision": revision})
}

// platformBindingTarget 解析作品、确认它属于当前工作区，并确认平台可绑定。
func (s *Server) platformBindingTarget(r *http.Request) (uuid.UUID, string, error) {
	workID, err := pathID(r, "id")
	if err != nil {
		return uuid.Nil, "", err
	}
	var platform string
	err = s.db.QueryRow(r.Context(), `SELECT a.platform FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, ident(r.Context()).WorkspaceID).Scan(&platform)
	if err != nil {
		return uuid.Nil, "", errNotFound
	}
	if platform != "wechat_mp" && platform != "xhs" {
		return uuid.Nil, "", apiErr(422, "platform_not_supported", "该平台暂不支持作品绑定")
	}
	return workID, platform, nil
}

func normalizeBindingSource(value string) (string, error) {
	switch strings.TrimSpace(value) {
	case bindingSourceUserLink, bindingSourceUserConfirm:
		return strings.TrimSpace(value), nil
	case "":
		// 用户手工粘贴/核对的编号默认为 user_confirm；legacy_title 只由迁移与标题路径产生。
		return bindingSourceUserConfirm, nil
	default:
		return "", validation("绑定来源只能为 user_link 或 user_confirm")
	}
}
