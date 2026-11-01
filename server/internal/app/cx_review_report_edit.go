package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func cxReviewContentRevision(content ReviewContent) string {
	encoded, _ := json.Marshal(content)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (s *Server) editCXReviewReport(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision string        `json:"base_revision"`
		Content      ReviewContent `json:"content"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if strings.TrimSpace(in.BaseRevision) == "" {
		return validation("缺少复盘报告版本号")
	}
	var accountID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT rr.account_id FROM review_report rr JOIN platform_account a ON a.id=rr.account_id
		WHERE rr.id=$1 AND a.workspace_id=$2`, id, ident(r.Context()).WorkspaceID).Scan(&accountID); err != nil {
		return err
	}
	if _, err := s.account(r.Context(), accountID); err != nil {
		return err
	}
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var currentRaw []byte
	var report ReviewReport
	if err := tx.QueryRow(r.Context(), `SELECT rr.content,rr.work_ids,rr.adopted,rr.remembered,rr.ignored,rr.origin,rr.created_at
		FROM review_report rr JOIN platform_account a ON a.id=rr.account_id
		WHERE rr.id=$1 AND rr.account_id=$2 AND a.workspace_id=$3 FOR UPDATE`,
		id, accountID, ident(r.Context()).WorkspaceID).
		Scan(&currentRaw, &report.WorkIDs, &report.Adopted, &report.Remembered, &report.Ignored, &report.Origin, &report.CreatedAt); err != nil {
		return err
	}
	if err := json.Unmarshal(currentRaw, &report.Content); err != nil {
		return err
	}
	normalizeCXReviewContent(&report.Content)
	report.ContentRevision = cxReviewContentRevision(report.Content)
	if report.ContentRevision != in.BaseRevision {
		return apiErr(http.StatusConflict, "version_conflict", "复盘报告已变化，请刷新后重试")
	}
	if report.Content.AnalysisV2 != nil {
		// Provenance is immutable after generation; users may edit the analysis text,
		// but the stored input basis and source scope stay server-authored.
		in.Content.CXBasis = report.Content.CXBasis
	}
	if err := validateCXReviewContentEdit(report.Content, &in.Content); err != nil {
		return validation(err.Error())
	}
	encoded, err := json.Marshal(in.Content)
	if err != nil {
		return err
	}
	command, err := tx.Exec(r.Context(), `UPDATE review_report SET content=$2 WHERE id=$1 AND content=$3`, id, encoded, currentRaw)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return apiErr(http.StatusConflict, "version_conflict", "复盘报告已变化，请刷新后重试")
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	report.ID, report.Content = id, in.Content
	report.ContentRevision = cxReviewContentRevision(report.Content)
	s.audit(r.Context(), "review_edit", "review_report", id.String(), "ok", map[string]any{"content_revision": report.ContentRevision})
	return ok(w, report)
}

func normalizeCXReviewContent(content *ReviewContent) {
	if content.Conclusions == nil {
		content.Conclusions = []string{}
	}
	if content.TopicSuggestions == nil {
		content.TopicSuggestions = []ReviewTopicSuggestion{}
	}
	if content.WritingInsights == nil {
		content.WritingInsights = []string{}
	}
}

func validateCXReviewContentEdit(current ReviewContent, next *ReviewContent) error {
	if next.ContentFormat != current.ContentFormat || len(next.Conclusions) != len(current.Conclusions) ||
		len(next.TopicSuggestions) != len(current.TopicSuggestions) || len(next.WritingInsights) != len(current.WritingInsights) {
		return errors.New("编辑不得改变内容形态或原有数组的数量和索引")
	}
	if next.Conclusions == nil || next.TopicSuggestions == nil || next.WritingInsights == nil {
		return errors.New("结论、选题建议和写作结论必须保留为数组")
	}
	for _, suggestion := range next.TopicSuggestions {
		if len([]rune(strings.TrimSpace(suggestion.Title))) == 0 || len([]rune(suggestion.Title)) > 64 ||
			len([]rune(suggestion.Angle)) > 300 || len([]rune(suggestion.Reason)) > 300 {
			return errors.New("选题标题需为 1 至 64 个字符，角度和依据不能超过 300 个字符")
		}
	}
	if current.AnalysisV2 == nil {
		if next.AnalysisV2 != nil || len(next.CXBasis) != 0 {
			return errors.New("旧版复盘不能新增未经验证的来源结构")
		}
		return nil
	}
	if next.AnalysisV2 == nil || len(current.CXBasis) == 0 {
		return errors.New("增强版复盘必须保留来源依据和 analysis_v2")
	}
	var basis cxReviewAIBasis
	if err := json.Unmarshal(current.CXBasis, &basis); err != nil {
		return err
	}
	allowed := make(map[string]bool, len(basis.SourceRefs))
	for _, ref := range basis.SourceRefs {
		allowed[ref] = true
	}
	out := cxReviewV2Output{Conclusions: next.Conclusions, TopicSuggestions: next.TopicSuggestions, WritingInsights: next.WritingInsights, AnalysisV2: next.AnalysisV2}
	return validateCXReviewV2Output(&out, allowed)
}
