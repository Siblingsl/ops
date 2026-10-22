package app

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type publishInput struct {
	URL                 *string    `json:"url"`
	PublishedAt         *time.Time `json:"published_at"`
	Mode                string     `json:"mode"`
	BasePublishRevision *int       `json:"base_publish_revision"`
	Reason              string     `json:"reason"`
	ConfirmPublished    *bool      `json:"confirm_published"`
}

type publicationState struct {
	Status          string
	URL             *string
	PublishedAt     *time.Time
	Locked          bool
	Revision        int
	PublishRevision int
	WechatMsgID     *string
}

type publishMetricChange struct {
	Before Metric
	After  *int
}

type publishMetricImpact struct {
	ID              uuid.UUID `json:"id"`
	Source          string    `json:"source"`
	CapturedAt      time.Time `json:"captured_at"`
	BeforeDayOffset *int      `json:"before_day_offset"`
	AfterDayOffset  *int      `json:"after_day_offset"`
}

type publishCorrectionPreview struct {
	Mode            string                `json:"mode"`
	PublishRevision int                   `json:"publish_revision"`
	Before          publishValues         `json:"before"`
	After           publishValues         `json:"after"`
	ChangedFields   []string              `json:"changed_fields"`
	Changed         bool                  `json:"changed"`
	Metrics         []publishMetricImpact `json:"metrics"`
}

type publishValues struct {
	URL         *string    `json:"url"`
	PublishedAt *time.Time `json:"published_at"`
}

func previewMarkPublished(ctx context.Context, s *Server, st *agentRunState, t *AgentTool, args map[string]any) ([]agentChange, map[string]any, error) {
	if agentArgString(args, "mode") != "correction" {
		return nil, nil, nil
	}
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	id, err := uuid.Parse(agentArgString(args, "id"))
	if err != nil {
		return nil, nil, validation("作品编号不正确")
	}
	reason := agentArgString(args, "reason")
	if reason == "" || runeLen(reason) > 500 {
		return nil, nil, validation("请填写 1 到 500 字的更正原因")
	}
	input := publishInput{Mode: "correction", Reason: reason}
	if raw, ok := args["url"].(string); ok {
		input.URL = &raw
	}
	if raw := agentArgString(args, "published_at"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return nil, nil, validation("发布时间格式不正确")
		}
		input.PublishedAt = &parsed
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	current, err := loadPublicationState(ctx, tx, id, false)
	if err != nil {
		return nil, nil, err
	}
	if current.Status != "published" {
		return nil, nil, stateInvalid("只有已发布作品可以更正发布记录")
	}
	input.BasePublishRevision = &current.PublishRevision
	args["base_publish_revision"] = current.PublishRevision
	nextURL, nextAt := correctionValues(current, input)
	if err := validatePublishedValues(derefString(nextURL), nextAt, s.now()); err != nil {
		return nil, nil, err
	}
	nextMsgID := correctionMsgID(current, nextURL)
	metricChanges, _, err := s.planPublishMetricChanges(ctx, tx, id, current, nextAt, nextMsgID, false)
	if err != nil {
		return nil, nil, err
	}
	dateText := func(at *time.Time) string {
		if at == nil {
			return "未填写"
		}
		return at.In(s.loc).Format("2006-01-02 15:04")
	}
	urlText := func(value *string) string {
		if value == nil || *value == "" {
			return "未填写"
		}
		return *value
	}
	changes := []agentChange{
		{Field: "url", Label: "发布链接", Before: urlText(current.URL), After: urlText(nextURL)},
		{Field: "published_at", Label: "发布时间", Before: dateText(current.PublishedAt), After: dateText(nextAt)},
		{Field: "reason", Label: "更正原因", Before: "", After: reason},
	}
	offsetText := func(offset *int) string {
		if offset == nil {
			return "未知节点"
		}
		return fmt.Sprintf("第 %d 天", *offset)
	}
	for _, change := range metricChanges {
		changes = append(changes, agentChange{Field: "metric_node_" + change.Before.ID.String(), Label: "数据节点（" + change.Before.Source + "）",
			Before: dateText(&change.Before.CapturedAt) + " · " + offsetText(change.Before.DayOffset),
			After:  dateText(&change.Before.CapturedAt) + " · " + offsetText(change.After)})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return changes, body, nil
}

func (s *Server) handlePublished(w http.ResponseWriter, r *http.Request, workID uuid.UUID, in publishInput) error {
	if in.Mode != "" && in.Mode != "initial" && in.Mode != "correction" {
		return validation("回填模式不正确")
	}
	if in.Mode == "correction" {
		if r.URL.Query().Get("preview") == "true" {
			return s.previewPublishCorrection(w, r, workID, in)
		}
		if r.URL.Query().Get("preview") != "" {
			return validation("preview 参数只能是 true")
		}
		if in.BasePublishRevision == nil || *in.BasePublishRevision < 1 {
			return validationFields("更正发布记录需要当前发布修订号", map[string]string{"base_publish_revision": "请重新读取作品后重试"})
		}
		if strings.TrimSpace(in.Reason) == "" || runeLen(strings.TrimSpace(in.Reason)) > 500 {
			return validationFields("请填写 1 到 500 字的更正原因", map[string]string{"reason": "更正原因不能为空且不能超过 500 字"})
		}
		if in.ConfirmPublished == nil || !*in.ConfirmPublished {
			return humanStep("H-07", "请明确确认更正系统中的发布记录；不会修改平台实际内容")
		}
		return s.commitPublishCorrection(w, r, workID, in)
	}
	if r.URL.Query().Get("preview") != "" {
		return validation("preview 仅支持 mode=correction")
	}
	return s.markInitialOrLegacyReplay(w, r, workID, in)
}

func (s *Server) markInitialOrLegacyReplay(w http.ResponseWriter, r *http.Request, workID uuid.UUID, in publishInput) error {
	urlText := ""
	if in.URL != nil {
		urlText = strings.TrimSpace(*in.URL)
	}
	if err := validatePublishedValues(urlText, in.PublishedAt, s.now()); err != nil {
		return err
	}
	err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		current, err := loadPublicationState(r.Context(), tx, workID, true)
		if err != nil {
			return err
		}
		if current.Status == "published" {
			// Old clients may repeat the values they saw. Missing values are not interpreted as
			// a request to clear a link or replace an unknown date with the current time.
			nextURL, nextAt := current.URL, current.PublishedAt
			if in.URL != nil {
				nextURL = nullablePublishedURL(urlText)
			}
			if in.PublishedAt != nil {
				nextAt = in.PublishedAt
			}
			if !sameString(nextURL, current.URL) || !sameTime(nextAt, current.PublishedAt) {
				return apiErr(409, "publish_correction_required", "发布记录已存在。请重新读取后使用“更正发布记录”，填写原因并确认。")
			}
			return nil
		}
		if current.Status != "pushed" && current.Status != "packed" {
			return stateInvalid("作品还没有进入草稿箱或生成发布包")
		}
		at := s.now()
		if in.PublishedAt != nil {
			at = *in.PublishedAt
		}
		if err := s.setWorkPublished(r.Context(), tx, workID, urlText, &at); err != nil {
			return err
		}
		nextMsgID := current.WechatMsgID
		if parsed := parseWechatMsgID(urlText); parsed != "" {
			nextMsgID = &parsed
		}
		changes, _, err := s.planPublishMetricChanges(r.Context(), tx, workID, current, &at, nextMsgID, true)
		if err != nil {
			return err
		}
		if err := s.applyPublishMetricChanges(r.Context(), tx, changes); err != nil {
			return err
		}
		var publishRevision int
		if err := tx.QueryRow(r.Context(), `SELECT publish_revision FROM work WHERE id=$1`, workID).Scan(&publishRevision); err != nil {
			return err
		}
		return s.auditTx(r.Context(), tx, "mark_published", "work", workID.String(), "ok", map[string]any{
			"url": urlText, "published_at": at.Format(time.RFC3339Nano), "publish_revision": publishRevision,
		})
	})
	if isUniqueViolation(err) {
		return apiErr(409, "publish_metric_node_conflict", "发布时间会使多条数据落在同一来源的同一统计节点，原记录未更改。")
	}
	if err != nil {
		return err
	}
	return s.writeWork(w, r, workID)
}

func (s *Server) previewPublishCorrection(w http.ResponseWriter, r *http.Request, workID uuid.UUID, in publishInput) error {
	if in.BasePublishRevision == nil || *in.BasePublishRevision < 1 {
		return validationFields("更正发布记录需要当前发布修订号", map[string]string{"base_publish_revision": "请重新读取作品后重试"})
	}
	if strings.TrimSpace(in.Reason) == "" || runeLen(strings.TrimSpace(in.Reason)) > 500 {
		return validationFields("请填写 1 到 500 字的更正原因", map[string]string{"reason": "更正原因不能为空且不能超过 500 字"})
	}
	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, err := loadPublicationState(ctx, tx, workID, false)
	if err != nil {
		return err
	}
	if current.Status != "published" {
		return stateInvalid("只有已发布作品可以更正发布记录")
	}
	if current.PublishRevision != *in.BasePublishRevision {
		return publishRevisionConflict(current.PublishRevision)
	}
	nextURL, nextAt := correctionValues(current, in)
	if err := validatePublishedValues(derefString(nextURL), nextAt, s.now()); err != nil {
		return err
	}
	nextMsgID := correctionMsgID(current, nextURL)
	changes, _, err := s.planPublishMetricChanges(ctx, tx, workID, current, nextAt, nextMsgID, false)
	if err != nil {
		return err
	}
	preview := makePublishCorrectionPreview(current, nextURL, nextAt, changes)
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return ok(w, preview)
}

func (s *Server) commitPublishCorrection(w http.ResponseWriter, r *http.Request, workID uuid.UUID, in publishInput) error {
	reason := strings.TrimSpace(in.Reason)
	err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		current, err := loadPublicationState(r.Context(), tx, workID, true)
		if err != nil {
			return err
		}
		if current.Status != "published" {
			return stateInvalid("只有已发布作品可以更正发布记录")
		}
		if current.PublishRevision != *in.BasePublishRevision {
			return publishRevisionConflict(current.PublishRevision)
		}
		nextURL, nextAt := correctionValues(current, in)
		if err := validatePublishedValues(derefString(nextURL), nextAt, s.now()); err != nil {
			return err
		}
		changedFields := make([]string, 0, 2)
		if !sameString(current.URL, nextURL) {
			changedFields = append(changedFields, "url")
		}
		if !sameTime(current.PublishedAt, nextAt) {
			changedFields = append(changedFields, "published_at")
		}
		if len(changedFields) == 0 {
			return nil
		}
		sort.Strings(changedFields)
		nextMsgID := correctionMsgID(current, nextURL)
		changes, _, err := s.planPublishMetricChanges(r.Context(), tx, workID, current, nextAt, nextMsgID, true)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `UPDATE work SET published_url=$2, published_at=$3, wechat_msgid=$4, updated_at=now() WHERE id=$1`,
			workID, nextURL, nextAt, nextMsgID); err != nil {
			return err
		}
		if err := s.applyPublishMetricChanges(r.Context(), tx, changes); err != nil {
			return err
		}
		var publishRevision int
		if err := tx.QueryRow(r.Context(), `SELECT publish_revision FROM work WHERE id=$1`, workID).Scan(&publishRevision); err != nil {
			return err
		}
		return s.auditTx(r.Context(), tx, "publish_metadata_corrected", "work", workID.String(), "ok", map[string]any{
			"reason":         reason,
			"before":         map[string]any{"url": current.URL, "published_at": auditTime(current.PublishedAt), "wechat_msgid": current.WechatMsgID},
			"after":          map[string]any{"url": nextURL, "published_at": auditTime(nextAt), "wechat_msgid": nextMsgID},
			"changed_fields": changedFields, "metric_offsets_changed": len(changes),
			"publish_revision_before": current.PublishRevision, "publish_revision_after": publishRevision,
		})
	})
	if isUniqueViolation(err) {
		return apiErr(409, "publish_metric_node_conflict", "发布时间会使多条数据落在同一来源的同一统计节点，原发布记录和数据节点均未更改。")
	}
	if err != nil {
		return err
	}
	return s.writeWork(w, r, workID)
}

func loadPublicationState(ctx context.Context, tx pgx.Tx, workID uuid.UUID, lock bool) (publicationState, error) {
	query := `SELECT status, published_url, published_at, locked, revision, publish_revision, wechat_msgid
		FROM work WHERE id=$1 AND deleted_at IS NULL`
	if lock {
		query += ` FOR UPDATE`
	}
	var state publicationState
	err := tx.QueryRow(ctx, query, workID).Scan(&state.Status, &state.URL, &state.PublishedAt,
		&state.Locked, &state.Revision, &state.PublishRevision, &state.WechatMsgID)
	return state, err
}

func correctionValues(current publicationState, in publishInput) (*string, *time.Time) {
	urlValue := current.URL
	if in.URL != nil {
		urlValue = nullablePublishedURL(strings.TrimSpace(*in.URL))
	}
	publishedAt := current.PublishedAt
	if in.PublishedAt != nil {
		publishedAt = in.PublishedAt
	}
	return urlValue, publishedAt
}

func correctionMsgID(current publicationState, nextURL *string) *string {
	if sameString(current.URL, nextURL) {
		return current.WechatMsgID
	}
	if nextURL == nil {
		return nil
	}
	parsed := parseWechatMsgID(*nextURL)
	if parsed == "" {
		return nil
	}
	return &parsed
}

func validatePublishedValues(rawURL string, publishedAt *time.Time, now time.Time) error {
	if len(rawURL) > 1024 {
		return validationFields("发布链接不能超过 1024 字符", map[string]string{"url": "链接过长"})
	}
	if rawURL != "" {
		parsed, err := url.ParseRequestURI(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil {
			return validationFields("发布链接无效或包含账号凭证", map[string]string{"url": "请输入有效的 http/https 链接，不要包含用户名或密码"})
		}
	}
	if publishedAt != nil && publishedAt.After(now) {
		return validationFields("发布时间不能晚于当前时间", map[string]string{"published_at": "请选择当前时间或更早时间"})
	}
	return nil
}

func (s *Server) planPublishMetricChanges(ctx context.Context, tx pgx.Tx, workID uuid.UUID, current publicationState, nextAt *time.Time, nextMsgID *string, lock bool) ([]publishMetricChange, []publishMetricImpact, error) {
	if sameTime(current.PublishedAt, nextAt) {
		return nil, nil, nil
	}
	query := `SELECT ` + metricCols + ` FROM metric_snapshot WHERE work_id=$1 ORDER BY captured_at,id`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := tx.Query(ctx, query, workID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	changes := make([]publishMetricChange, 0)
	impacts := make([]publishMetricImpact, 0)
	seen := make(map[string]uuid.UUID)
	for rows.Next() {
		before, err := scanMetric(rows)
		if err != nil {
			return nil, nil, err
		}
		if before.Source == "wechat_api" {
			if before.ExternalID == nil || strings.TrimSpace(*before.ExternalID) == "" || nextMsgID == nil || *before.ExternalID != *nextMsgID {
				return nil, nil, unknownMetricBasis(before)
			}
			if current.Status == "published" && current.PublishedAt == nil {
				return nil, nil, unknownMetricBasis(before)
			}
			if current.PublishedAt != nil {
				if current.WechatMsgID == nil || *before.ExternalID != *current.WechatMsgID {
					return nil, nil, unknownMetricBasis(before)
				}
				oldOffset := publicationDayOffset(before.CapturedAt, current.PublishedAt, s.loc)
				if before.DayOffset == nil || *before.DayOffset != oldOffset {
					return nil, nil, unknownMetricBasis(before)
				}
			}
		}
		var target *int
		if nextAt != nil {
			offset := publicationDayOffset(before.CapturedAt, nextAt, s.loc)
			if offset < 0 {
				return nil, nil, apiErr(409, "publish_metric_negative_offset", fmt.Sprintf("数据记录 %s 的统计日早于拟更正发布时间，原记录未更改。", before.ID))
			}
			target = &offset
		}
		if target != nil {
			key := fmt.Sprintf("%s:%d", before.Source, *target)
			if prior, ok := seen[key]; ok {
				return nil, nil, apiErr(409, "publish_metric_node_conflict", fmt.Sprintf("数据记录 %s 与 %s 会落在同来源同节点，原记录未更改。", prior, before.ID)).With(map[string]any{
					"metric_ids": []string{prior.String(), before.ID.String()}, "source": before.Source, "day_offset": *target,
				})
			}
			seen[key] = before.ID
		}
		if sameInt(before.DayOffset, target) {
			continue
		}
		changes = append(changes, publishMetricChange{Before: before, After: target})
		impacts = append(impacts, publishMetricImpact{ID: before.ID, Source: before.Source, CapturedAt: before.CapturedAt,
			BeforeDayOffset: before.DayOffset, AfterDayOffset: target})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return changes, impacts, nil
}

func (s *Server) applyPublishMetricChanges(ctx context.Context, tx pgx.Tx, changes []publishMetricChange) error {
	if len(changes) > 0 {
		if _, err := tx.Exec(ctx, `SET CONSTRAINTS metric_snapshot_node DEFERRED`); err != nil {
			return err
		}
	}
	for _, change := range changes {
		after, err := scanMetric(tx.QueryRow(ctx, `UPDATE metric_snapshot SET day_offset=$2 WHERE id=$1 RETURNING `+metricCols,
			change.Before.ID, change.After))
		if err != nil {
			return err
		}
		if err := s.auditMetricMutation(ctx, tx, "metric_offset_recomputed", &change.Before, &after, false); err != nil {
			return err
		}
	}
	return nil
}

func makePublishCorrectionPreview(current publicationState, nextURL *string, nextAt *time.Time, changes []publishMetricChange) publishCorrectionPreview {
	fields := make([]string, 0, 2)
	if !sameString(current.URL, nextURL) {
		fields = append(fields, "url")
	}
	if !sameTime(current.PublishedAt, nextAt) {
		fields = append(fields, "published_at")
	}
	sort.Strings(fields)
	metrics := make([]publishMetricImpact, 0, len(changes))
	for _, change := range changes {
		metrics = append(metrics, publishMetricImpact{ID: change.Before.ID, Source: change.Before.Source,
			CapturedAt: change.Before.CapturedAt, BeforeDayOffset: change.Before.DayOffset, AfterDayOffset: change.After})
	}
	return publishCorrectionPreview{Mode: "correction", PublishRevision: current.PublishRevision,
		Before: publishValues{URL: current.URL, PublishedAt: current.PublishedAt},
		After:  publishValues{URL: nextURL, PublishedAt: nextAt}, ChangedFields: fields,
		Changed: len(fields) > 0, Metrics: metrics}
}

func unknownMetricBasis(metric Metric) error {
	return apiErr(409, "publish_metric_basis_unknown", fmt.Sprintf("微信接口数据 %s 缺少可验证的原统计日期或文章依据；请取消日期更正，或仅更正链接。", metric.ID)).With(map[string]any{
		"metric_id": metric.ID.String(), "source": metric.Source,
	})
}

func publishRevisionConflict(current int) error {
	return apiErr(409, "publish_revision_conflict", "发布记录已被其他成员更正。请重新读取并比较当前值后再提交。").With(map[string]any{
		"current_publish_revision": current,
	})
}

func publicationDayOffset(capturedAt time.Time, publishedAt *time.Time, loc *time.Location) int {
	captured := capturedAt.In(loc)
	published := publishedAt.In(loc)
	cDate := time.Date(captured.Year(), captured.Month(), captured.Day(), 0, 0, 0, 0, time.UTC)
	pDate := time.Date(published.Year(), published.Month(), published.Day(), 0, 0, 0, 0, time.UTC)
	return int(cDate.Sub(pDate) / (24 * time.Hour))
}

func nullablePublishedURL(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func auditTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func sameString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

func sameInt(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
