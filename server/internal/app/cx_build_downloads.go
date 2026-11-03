package app

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
)

type cxPrivacyAckInput struct {
	ReportHash string   `json:"report_hash"`
	FindingIDs []string `json:"finding_ids"`
}

type cxPrivacyAckRecord struct {
	UserID       string    `json:"user_id"`
	ReportHash   string    `json:"report_hash"`
	FindingIDs   []string  `json:"finding_ids"`
	Acknowledged time.Time `json:"acknowledged_at"`
}

func cxValidationDetailJSON(errorDetail []byte) json.RawMessage {
	var value map[string]json.RawMessage
	if len(errorDetail) == 0 || json.Unmarshal(errorDetail, &value) != nil {
		return nil
	}
	return value["validation"]
}

func cxBuildDownloadGate(status string, expires *time.Time, manifest json.RawMessage, manifestSHA *string, validation json.RawMessage, acknowledgements []byte, userID uuid.UUID, role string, now time.Time) map[string]any {
	deny := func(reason string) map[string]any { return map[string]any{"allowed": false, "reason": reason} }
	if status != "built" {
		return deny("build_not_complete")
	}
	if expires == nil || !expires.After(now) {
		return deny("build_expired")
	}
	if manifestSHA == nil || !cxBuildManifestHashValid(manifest, *manifestSHA) {
		return deny("manifest_invalid")
	}
	privacy, reportOK := cxBuildPrivacyReport(validation)
	if !reportOK || !privacy.ScannerOK || !privacy.PolicyReady {
		return deny("scanner_unverified")
	}
	if privacy.Errors > 0 || privacy.Level == "block" {
		return deny("privacy_block")
	}
	if privacy.Warnings == 0 {
		return map[string]any{"allowed": true, "reason": "clear", "report_hash": privacy.ReportHash}
	}
	warningIDs, complete := cxBuildWarningIDs(privacy)
	if !complete {
		return deny("privacy_findings_truncated")
	}
	if cxPrivacyAckExists(acknowledgements, userID, privacy.ReportHash, warningIDs) {
		return map[string]any{"allowed": true, "reason": "acknowledged", "report_hash": privacy.ReportHash}
	}
	if role == "viewer" {
		return deny("viewer_ack_unavailable")
	}
	return map[string]any{"allowed": false, "reason": "privacy_ack_required", "report_hash": privacy.ReportHash}
}

func cxBuildManifestHashValid(raw json.RawMessage, expected string) bool {
	if len(raw) == 0 || expected == "" {
		return false
	}
	value, err := cxcanonicaljson.Parse(raw)
	if err != nil {
		return false
	}
	actual, err := cxcanonicaljson.Hash(value)
	return err == nil && actual == expected
}

func cxBuildPrivacyReport(validation json.RawMessage) (cxPrivacyReport, bool) {
	var envelope struct {
		Privacy cxPrivacyReport `json:"privacy"`
	}
	if len(validation) == 0 || json.Unmarshal(validation, &envelope) != nil || envelope.Privacy.ReportHash == "" {
		return cxPrivacyReport{}, false
	}
	return envelope.Privacy, true
}

func cxBuildWarningIDs(report cxPrivacyReport) ([]string, bool) {
	ids := []string{}
	for _, finding := range report.Findings {
		if finding.Severity == "warn" {
			ids = append(ids, finding.ID)
		}
	}
	if report.Truncated || len(ids) != report.Warnings {
		return nil, false
	}
	sort.Strings(ids)
	return ids, true
}

func cxPrivacyAckExists(raw []byte, userID uuid.UUID, reportHash string, warningIDs []string) bool {
	var records []cxPrivacyAckRecord
	if len(raw) == 0 || json.Unmarshal(raw, &records) != nil {
		return false
	}
	for _, record := range records {
		if record.UserID != userID.String() || record.ReportHash != reportHash {
			continue
		}
		ids := append([]string(nil), record.FindingIDs...)
		sort.Strings(ids)
		return equalStringSlices(ids, warningIDs)
	}
	return false
}

func (s *Server) ackCXBuildPrivacy(w http.ResponseWriter, r *http.Request) error {
	// Q-CX-04 拍板（90 D-165，2026-11-03）：owner/editor/viewer 都可以写**本人**知悉回执。
	// 鉴权依赖会话中间件（ident 已限定当前工作区）；回执只绑定当前 report_hash 并
	// 记录到构建的 acknowledgements，不改变构建状态、不赋任何业务写权限；
	// 构建 built 与否仍由 complete 链路决定。
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var input cxPrivacyAckInput
	if err := decodeCXBuildJSON(w, r, &input); err != nil {
		return err
	}
	if input.ReportHash == "" || len(input.FindingIDs) == 0 || len(input.FindingIDs) > cxPrivacyMaxFindings {
		return validation("请提交当前报告哈希和完整 WARN 项列表")
	}
	input.FindingIDs = append([]string(nil), input.FindingIDs...)
	sort.Strings(input.FindingIDs)
	for i, id := range input.FindingIDs {
		if id == "" || (i > 0 && input.FindingIDs[i-1] == id) {
			return validation("WARN 项列表无效或包含重复项")
		}
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var status string
	var expires *time.Time
	var manifest, errorDetail, acknowledgements []byte
	var manifestSHA *string
	var accountStatus string
	if err := tx.QueryRow(ctx, `SELECT b.status,b.expires_at,b.manifest,b.manifest_sha256,b.error_detail,b.acknowledgements,a.status
		FROM work_build b JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL FOR UPDATE OF b`, buildID, ident(ctx).WorkspaceID).
		Scan(&status, &expires, &manifest, &manifestSHA, &errorDetail, &acknowledgements, &accountStatus); err != nil {
		return err
	}
	if accountStatus != "active" {
		return apiErr(http.StatusConflict, "account_inactive", "账号已停用，不能确认新的隐私提醒")
	}
	if status != "built" || expires == nil || !expires.After(s.now()) {
		return apiErr(http.StatusConflict, "build_not_complete", "只有未过期的已完成构建才能确认隐私提醒")
	}
	if !cxBuildManifestHashValid(manifest, valueOrEmpty(manifestSHA)) {
		return apiErr(http.StatusConflict, "manifest_invalid", "构建清单校验失败，不能确认隐私提醒")
	}
	validation := cxValidationDetailJSON(errorDetail)
	privacy, reportOK := cxBuildPrivacyReport(validation)
	if !reportOK || !privacy.ScannerOK || !privacy.PolicyReady {
		return apiErr(http.StatusServiceUnavailable, "scanner_unverified", "隐私扫描器尚未达到确认条件")
	}
	if privacy.Errors > 0 || privacy.Level == "block" {
		return apiErr(http.StatusConflict, "privacy_block", "存在不可确认放行的隐私错误")
	}
	warningIDs, complete := cxBuildWarningIDs(privacy)
	if !complete {
		return apiErr(http.StatusConflict, "privacy_findings_truncated", "WARN 项超出可确认范围，下载保持关闭")
	}
	if len(warningIDs) == 0 {
		return apiErr(http.StatusConflict, "privacy_ack_not_required", "当前报告没有需要确认的 WARN 项")
	}
	if input.ReportHash != privacy.ReportHash {
		return apiErr(http.StatusConflict, "privacy_report_stale", "隐私报告已变化，请刷新后重新核对")
	}
	if !equalStringSlices(input.FindingIDs, warningIDs) {
		return apiErr(http.StatusUnprocessableEntity, "privacy_ack_incomplete", "必须逐项确认当前报告中的全部 WARN 项")
	}
	if cxPrivacyAckExists(acknowledgements, ident(ctx).UserID, privacy.ReportHash, warningIDs) {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ok(w, map[string]any{"acknowledged": true, "reused": true, "report_hash": privacy.ReportHash})
	}
	record := cxPrivacyAckRecord{UserID: ident(ctx).UserID.String(), ReportHash: privacy.ReportHash,
		FindingIDs: warningIDs, Acknowledged: s.now().UTC()}
	encoded, err := json.Marshal([]cxPrivacyAckRecord{record})
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE work_build SET acknowledgements=acknowledgements || $2::jsonb WHERE id=$1`, buildID, string(encoded)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "work_build_privacy_ack", "work_build", buildID.String(), "ok", map[string]any{"report_hash": privacy.ReportHash, "finding_count": len(warningIDs)})
	return ok(w, map[string]any{"acknowledged": true, "reused": false, "report_hash": privacy.ReportHash})
}

func (s *Server) downloadCXBuildArtifact(w http.ResponseWriter, r *http.Request) error {
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	artifactID, err := pathID(r, "artifactID")
	if err != nil {
		return err
	}
	build, gate, err := s.cxLoadDownloadBuild(r.Context(), buildID)
	if err != nil {
		return err
	}
	if !gateAllowed(gate) {
		return cxDownloadGateError(gate)
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(r.Context()))
	artifacts, err := cxReadBuildArtifacts(r.Context(), tx, s.cfg.DataDir, buildID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return apiErr(http.StatusConflict, "artifact_unavailable", "一个或多个构建产物无法通过完整性校验")
	}
	var selected *cxBuildArtifact
	for i := range artifacts {
		if artifacts[i].ID == artifactID {
			selected = &artifacts[i]
			break
		}
	}
	if selected == nil || !cxManifestContainsArtifact(build.Manifest, *selected) {
		return errNotFound
	}
	return cxWriteBuildDownload(w, selected.Name, selected.MIME, selected.Data)
}

func (s *Server) downloadCXBuildEvidenceCSV(w http.ResponseWriter, r *http.Request) error {
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	build, gate, err := s.cxLoadDownloadBuild(r.Context(), buildID)
	if err != nil {
		return err
	}
	if !gateAllowed(gate) {
		return cxDownloadGateError(gate)
	}
	evidence, err := cxManifestEvidence(build.Manifest)
	if err != nil {
		return apiErr(http.StatusConflict, "manifest_invalid", "构建清单中的图片证据无法读取")
	}
	data, err := cxBuildEvidenceCSV(evidence)
	if err != nil {
		return err
	}
	var manifest struct {
		EvidenceCSV struct {
			Name   string `json:"name"`
			MIME   string `json:"mime"`
			Bytes  int64  `json:"bytes"`
			SHA256 string `json:"sha256"`
		} `json:"evidence_csv"`
	}
	if err := json.Unmarshal(build.Manifest, &manifest); err != nil || manifest.EvidenceCSV.Name != "evidence.csv" || manifest.EvidenceCSV.MIME != "text/csv; charset=utf-8" || manifest.EvidenceCSV.Bytes != int64(len(data)) || manifest.EvidenceCSV.SHA256 != cxSHA256(data) {
		return apiErr(http.StatusConflict, "artifact_hash_mismatch", "图片证据 CSV 与不可变构建清单不一致")
	}
	return cxWriteBuildDownload(w, manifest.EvidenceCSV.Name, manifest.EvidenceCSV.MIME, data)
}

func (s *Server) downloadCXBuildManifest(w http.ResponseWriter, r *http.Request) error {
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	build, gate, err := s.cxLoadDownloadBuild(r.Context(), buildID)
	if err != nil {
		return err
	}
	if !gateAllowed(gate) {
		return cxDownloadGateError(gate)
	}
	value, err := cxcanonicaljson.Parse(build.Manifest)
	if err != nil {
		return apiErr(http.StatusConflict, "manifest_invalid", "构建清单无法校验")
	}
	data, err := cxcanonicaljson.Marshal(value)
	if err != nil || cxSHA256(data) != valueOrEmpty(build.ManifestSHA) {
		return apiErr(http.StatusConflict, "manifest_invalid", "构建清单摘要校验失败")
	}
	return cxWriteBuildDownload(w, "manifest.json", "application/json; charset=utf-8", data)
}

type cxDownloadBuild struct {
	Status       string
	ExpiresAt    *time.Time
	Manifest     json.RawMessage
	ManifestSHA  *string
	Validation   json.RawMessage
	Acknowledges []byte
}

func (s *Server) cxLoadDownloadBuild(ctx context.Context, buildID uuid.UUID) (cxDownloadBuild, map[string]any, error) {
	var build cxDownloadBuild
	var errorDetail []byte
	if err := s.db.QueryRow(ctx, `SELECT b.status,b.expires_at,b.manifest,b.manifest_sha256,b.error_detail,b.acknowledgements
		FROM work_build b JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, buildID, ident(ctx).WorkspaceID).
		Scan(&build.Status, &build.ExpiresAt, &build.Manifest, &build.ManifestSHA, &errorDetail, &build.Acknowledges); err != nil {
		return build, nil, err
	}
	build.Validation = cxValidationDetailJSON(errorDetail)
	gate := cxBuildDownloadGate(build.Status, build.ExpiresAt, build.Manifest, build.ManifestSHA, build.Validation, build.Acknowledges, ident(ctx).UserID, ident(ctx).Role, s.now())
	return build, gate, nil
}

func cxManifestContainsArtifact(manifest json.RawMessage, artifact cxBuildArtifact) bool {
	var value struct {
		Artifacts []struct {
			ID     string `json:"id"`
			Kind   string `json:"kind"`
			Name   string `json:"name"`
			MIME   string `json:"mime"`
			Bytes  int64  `json:"bytes"`
			SHA256 string `json:"sha256"`
		} `json:"artifacts"`
	}
	if json.Unmarshal(manifest, &value) != nil {
		return false
	}
	for _, item := range value.Artifacts {
		if item.ID == artifact.ID.String() && item.Kind == artifact.Kind && item.Name == artifact.Name && item.MIME == artifact.MIME && item.Bytes == artifact.Bytes && item.SHA256 == artifact.SHA256 {
			return true
		}
	}
	return false
}

func cxDownloadGateError(gate map[string]any) error {
	reason, _ := gate["reason"].(string)
	message := map[string]string{
		"build_not_complete":         "构建尚未完成，暂不能下载",
		"build_expired":              "构建产物已过期",
		"manifest_invalid":           "构建清单校验失败",
		"scanner_unverified":         "隐私扫描器尚未通过发布校验",
		"privacy_block":              "构建包含不可确认放行的隐私错误",
		"privacy_findings_truncated": "WARN 项超出可确认范围，下载保持关闭",
		"viewer_ack_unavailable":     "当前工作区角色尚未获准写入 WARN 知悉回执",
		"privacy_ack_required":       "请先逐项确认当前隐私报告的 WARN 项",
	}[reason]
	if message == "" {
		message = "下载门禁未通过"
	}
	return apiErr(http.StatusConflict, reason, message).With(gate)
}

func gateAllowed(gate map[string]any) bool {
	allowed, _ := gate["allowed"].(bool)
	return allowed
}

func cxWriteBuildDownload(w http.ResponseWriter, name, contentType string, data []byte) error {
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	if disposition == "" {
		return apiErr(http.StatusConflict, "artifact_invalid", "下载文件名无效")
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-SHA256", cxSHA256(data))
	w.WriteHeader(http.StatusOK)
	_, err := w.Write(data)
	return err
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
