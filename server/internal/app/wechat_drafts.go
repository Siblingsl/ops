// WeChat draft-box product routes (RC-01 / D-221).
//
// These routes expose the already-adopted Q-26 adapter methods to the product:
// batchget/count are read-only, delete is one media_id per request and requires
// an explicit confirm flag. There is deliberately no batch-delete endpoint:
// docs/04 H-05 and the project red line require per-item user action.
package app

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ops/internal/wechat"
)

const wechatDraftPageMax = 20

type wechatDraftItem struct {
	MediaID    string `json:"media_id"`
	UpdateTime int64  `json:"update_time"`
	UpdatedAt  string `json:"updated_at"`
	Title      string `json:"title"`
}

type wechatDraftList struct {
	TotalCount int               `json:"total_count"`
	Offset     int               `json:"offset"`
	Count      int               `json:"count"`
	Items      []wechatDraftItem `json:"items"`
}

// wechatDraftAccount resolves the account and enforces the platform/active preconditions
// shared by all three draft routes. Account scoping is done by accountFromPath.
func (s *Server) wechatDraftAccount(r *http.Request) (*Account, error) {
	a, err := s.accountFromPath(r)
	if err != nil {
		return nil, err
	}
	if a.Platform != "wechat_mp" {
		return nil, validation("只有公众号账号可以查看草稿箱")
	}
	if a.Status != "active" {
		return nil, validation("账号已停用，启用后才能操作草稿箱")
	}
	return a, nil
}

// listWechatDrafts GET /accounts/{accountId}/wechat/drafts?offset=&count=
// Read-only: no content is persisted, only the summary needed by the UI is returned.
func (s *Server) listWechatDrafts(w http.ResponseWriter, r *http.Request) error {
	a, err := s.wechatDraftAccount(r)
	if err != nil {
		return err
	}
	offset, err := wechatQueryInt(r, "offset", 0, 0, 100000)
	if err != nil {
		return err
	}
	count, err := wechatQueryInt(r, "count", 10, 1, wechatDraftPageMax)
	if err != nil {
		return err
	}
	token, err := s.accessToken(r.Context(), a.ID, false)
	if err != nil {
		return err
	}
	total, items, err := s.wx.DraftBatchGet(r.Context(), token, offset, count, false)
	if err != nil {
		return wechatDraftAPIError("读取草稿列表", err)
	}
	out := wechatDraftList{
		TotalCount: total,
		Offset:     offset,
		Count:      count,
		Items:      make([]wechatDraftItem, 0, len(items)),
	}
	for _, it := range items {
		out.Items = append(out.Items, wechatDraftItem{
			MediaID:    it.MediaID,
			UpdateTime: it.UpdateTime,
			UpdatedAt:  time.Unix(it.UpdateTime, 0).UTC().Format(time.RFC3339),
			Title:      it.Title,
		})
	}
	return ok(w, out)
}

// countWechatDrafts GET /accounts/{accountId}/wechat/drafts/count
func (s *Server) countWechatDrafts(w http.ResponseWriter, r *http.Request) error {
	a, err := s.wechatDraftAccount(r)
	if err != nil {
		return err
	}
	token, err := s.accessToken(r.Context(), a.ID, false)
	if err != nil {
		return err
	}
	total, err := s.wx.DraftCount(r.Context(), token)
	if err != nil {
		return wechatDraftAPIError("读取草稿总数", err)
	}
	return ok(w, map[string]any{"total_count": total})
}

// deleteWechatDraft DELETE /accounts/{accountId}/wechat/drafts/{mediaId}
// Body must be {"confirm":true}. Owner-only; exactly one media_id per call.
// The work row that references this media_id is flagged as maybe-published/deleted;
// the product never changes work.status automatically.
func (s *Server) deleteWechatDraft(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	a, err := s.wechatDraftAccount(r)
	if err != nil {
		return err
	}
	mediaID := strings.TrimSpace(r.PathValue("mediaId"))
	if mediaID == "" {
		return validation("缺少草稿 media_id")
	}
	var in struct {
		Confirm bool `json:"confirm"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if !in.Confirm {
		return apiErr(409, "confirm_required", "删除公众号草稿前必须逐张确认；本接口不提供批量删除。")
	}
	token, err := s.accessToken(r.Context(), a.ID, false)
	if err != nil {
		return err
	}
	if err := s.wx.DraftDelete(r.Context(), token, mediaID); err != nil {
		s.audit(r.Context(), "wechat_draft_delete", "platform_account", a.ID.String(), "failed",
			map[string]any{"media_id": mediaID, "error": wechatDraftErrorMessage(err)})
		return wechatDraftAPIError("删除草稿", err)
	}
	// The external delete is authoritative. A local flag write failure must be observable,
	// but must not turn a completed deletion into a user-visible failure.
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET draft_maybe_published=true, updated_at=now()
		WHERE account_id=$1 AND wechat_draft_media_id=$2 AND deleted_at IS NULL`, a.ID, mediaID); err != nil {
		s.observeFailure(r.Context(), slog.LevelWarn, "删除草稿后本地状态标记失败", observeFields{
			Action: "wechat_draft_delete", TargetType: "platform_account", TargetID: a.ID.String(),
			ErrorCode: "wechat_draft_flag_update_failed", Route: "/accounts/{accountId}/wechat/drafts/{mediaId}",
			Extras: map[string]any{"media_id": mediaID, "err": err.Error()},
		})
	}
	s.audit(r.Context(), "wechat_draft_delete", "platform_account", a.ID.String(), "ok",
		map[string]any{"media_id": mediaID})
	return ok(w, map[string]any{"ok": true, "media_id": mediaID, "message": "草稿已删除"})
}

func wechatQueryInt(r *http.Request, name string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, validationFields("参数不合法", map[string]string{name: fmt.Sprintf("需要在 %d 到 %d 之间", min, max)})
	}
	return n, nil
}

func wechatDraftAPIError(action string, err error) error {
	var we *wechat.Error
	if errors.As(err, &we) {
		return apiErr(502, "wechat_error", fmt.Sprintf("%s失败（errcode %d）：%s", action, we.Code, we.Readable()))
	}
	return err
}

func wechatDraftErrorMessage(err error) string {
	var we *wechat.Error
	if errors.As(err, &we) {
		return fmt.Sprintf("errcode %d: %s", we.Code, we.Msg)
	}
	return err.Error()
}
