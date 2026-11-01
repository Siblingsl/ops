package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxbuildvalidate"
	"ops/internal/cxcanonicaljson"
	"ops/internal/cxrendercontract"
)

type cxBuildArtifact struct {
	ID          uuid.UUID
	Kind        string
	Name        string
	StoragePath string
	MIME        string
	Bytes       int64
	SHA256      string
	Width       *int
	Height      *int
	Data        []byte
}

type cxBuildArtifactSubmission struct {
	ArtifactID string `json:"artifact_id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
}

type cxBuildRendererReceipt struct {
	Client                  string                   `json:"client"`
	ApplicationVersion      string                   `json:"application_version"`
	RendererContractVersion string                   `json:"renderer_contract_version"`
	ChromiumVersion         string                   `json:"chromium_version"`
	FontFamily              string                   `json:"font_family"`
	DeviceScaleFactor       float64                  `json:"device_scale_factor"`
	ViewportWidth           int                      `json:"viewport_width"`
	ViewportHeight          int                      `json:"viewport_height"`
	LongImage               *cxBuildLongImageReceipt `json:"long_image,omitempty"`
}

type cxBuildLongImageReceipt struct {
	SourceHash           string    `json:"source_hash"`
	CaptureEngine        string    `json:"capture_engine"`
	CaptureEngineVersion string    `json:"capture_engine_version"`
	HeightCSS            int       `json:"height_css"`
	DPR                  int       `json:"dpr"`
	Segments             int       `json:"segments"`
	ViewportWidth        int       `json:"viewport_width"`
	ViewportHeight       int       `json:"viewport_height"`
	CheckScope           string    `json:"check_scope"`
	CapturedAt           time.Time `json:"captured_at"`
	FontFamily           string    `json:"font_family"`
}

type cxBuildCompleteInput struct {
	SourceHash      string                      `json:"source_hash"`
	ParamsHash      string                      `json:"params_hash"`
	Artifacts       []cxBuildArtifactSubmission `json:"artifacts"`
	RendererReceipt cxBuildRendererReceipt      `json:"renderer_receipt"`
}

func (s *Server) completeCXBuildValidated(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var input cxBuildCompleteInput
	if err := decodeCXBuildJSON(w, r, &input); err != nil {
		return err
	}
	if !cxValidBuildRendererReceipt(input.RendererReceipt) || len(input.Artifacts) > cxBuildMaxArtifacts {
		return validation("完成构建请求缺少有效的渲染回执或产物列表")
	}
	ctx := r.Context()
	workspaceID := ident(ctx).WorkspaceID
	var workID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT work_id FROM work_build WHERE id=$1 AND workspace_id=$2`, buildID, workspaceID).Scan(&workID); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	currentSnapshot, revision, _, _, err := cxBuildSourceSnapshot(ctx, tx, workspaceID, workID, 0, true)
	if err != nil {
		return err
	}
	var accountStatus string
	if err := tx.QueryRow(ctx, `SELECT a.status FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1 AND a.workspace_id=$2`, workID, workspaceID).Scan(&accountStatus); err != nil {
		return err
	}
	if accountStatus != "active" {
		return apiErr(http.StatusConflict, "account_inactive", "账号已停用，不能完成新的内容构建")
	}
	var status string
	var deadline time.Time
	var targets []string
	var sourceHash, paramsHash string
	var sourceJSON []byte
	err = tx.QueryRow(ctx, `SELECT status,deadline_at,targets,source_hash,params_hash,source_snapshot
		FROM work_build WHERE id=$1 AND workspace_id=$2 AND work_id=$3 FOR UPDATE`, buildID, workspaceID, workID).
		Scan(&status, &deadline, &targets, &sourceHash, &paramsHash, &sourceJSON)
	if err != nil {
		return err
	}
	if status != "running" {
		return apiErr(http.StatusConflict, "build_not_running", "构建已结束、已取消或已超时")
	}
	if input.SourceHash != sourceHash || input.ParamsHash != paramsHash || input.RendererReceipt.RendererContractVersion != cxrendercontract.WechatHTMLV1 {
		return cxFailAndCommit(ctx, tx, buildID, apiErr(http.StatusConflict, "build_input_mismatch", "完成请求与已冻结的构建输入不一致"))
	}
	hasLongImage := cxHasCXBuildTarget(targets, "long_image")
	if hasLongImage != (input.RendererReceipt.LongImage != nil) ||
		(hasLongImage && !cxValidBuildLongImageReceipt(input.RendererReceipt.LongImage, sourceHash)) {
		return apiErr(http.StatusUnprocessableEntity, "renderer_receipt_invalid", "长图构建回执与冻结来源或分段预算不一致")
	}
	if !deadline.After(s.now()) {
		if err := cxFailBuild(ctx, tx, buildID, "build_timeout", nil); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusConflict, "build_not_running", "构建已超时")
	}
	currentHash, err := cxcanonicaljson.Hash(currentSnapshot)
	if err != nil {
		return err
	}
	if currentHash != sourceHash {
		detail := map[string]any{"basis_revision": revision}
		if err := cxFailBuild(ctx, tx, buildID, "build_stale", detail); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusConflict, "build_stale", "构建输入在渲染期间已变化，请创建新构建").With(detail)
	}
	snapshotValue, err := cxcanonicaljson.Parse(sourceJSON)
	if err != nil {
		return err
	}
	snapshot, snapshotOK := snapshotValue.(map[string]any)
	if !snapshotOK {
		return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照无法解析")
	}
	artifacts, err := cxReadBuildArtifacts(ctx, tx, s.cfg.DataDir, buildID, workspaceID)
	if err != nil {
		var validationErr *cxBuildValidationError
		if errors.As(err, &validationErr) {
			if saveErr := cxFailBuild(ctx, tx, buildID, validationErr.Code, validationErr.Detail); saveErr != nil {
				return saveErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return commitErr
			}
			return apiErr(validationErr.Status, validationErr.Code, validationErr.Message).With(validationErr.Detail)
		}
		return err
	}
	selectedArtifacts, selectionError := cxSelectBuildOutputs(targets, artifacts, input.Artifacts)
	if selectionError != nil {
		return cxFailAndCommit(ctx, tx, buildID, selectionError)
	}
	sections, allAssets, work, err := cxBuildSnapshotInputs(snapshot)
	if err != nil {
		return cxFailAndCommit(ctx, tx, buildID, apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照缺少必需字段"))
	}
	imageIDs, err := cxbuildvalidate.ReferencedImageIDs(sections)
	if err != nil {
		return cxFailAndCommit(ctx, tx, buildID, apiErr(http.StatusUnprocessableEntity, "html_invalid", "冻结正文中的图片引用无法校验"))
	}
	imageLocations := cxImageReferenceLocations(sections)
	if containsUnmanagedImage(imageIDs) {
		return cxFailAndCommit(ctx, tx, buildID, apiErr(http.StatusUnprocessableEntity, "unmanaged_image", "正文包含未纳入本作品的图片").With(imageLocations[""]))
	}
	verifiedAssets, err := s.cxLoadFrozenAssets(ctx, tx, workspaceID, workID, work.accountID, allAssets, imageIDs, imageLocations)
	if err != nil {
		var validationErr *cxBuildValidationError
		if errors.As(err, &validationErr) {
			return cxFailAndCommit(ctx, tx, buildID, apiErr(validationErr.Status, validationErr.Code, validationErr.Message).With(validationErr.Detail))
		}
		return err
	}
	for id, asset := range allAssets {
		if verified, ok := verifiedAssets[id]; ok {
			allAssets[id] = verified
		} else {
			allAssets[id] = asset
		}
	}
	base, baseCount := cxSingleArtifact(artifacts, "html")
	stable, stableCount := cxSingleArtifact(artifacts, "stable_html")
	needHTML := cxTargetSelected(targets, "wechat_html") || cxTargetSelected(targets, "stable_html") || cxTargetSelected(targets, "long_image")
	if (needHTML && baseCount != 1) || (cxTargetSelected(targets, "stable_html") && stableCount != 1) || (cxTargetSelected(targets, "long_image") && len(cxArtifactsOfKind(artifacts, "png")) == 0) {
		return cxFailAndCommit(ctx, tx, buildID, apiErr(http.StatusUnprocessableEntity, "build_artifacts_missing", "本次构建缺少一个或多个目标产物"))
	}
	validation := map[string]any{"validator_version": cxbuildvalidate.ValidatorVersion, "image_evidence": []any{}, "unused_asset_ids": []string{}}
	imageEvidence := []cxbuildvalidate.ImageEvidence{}
	if needHTML {
		report, validationErr := cxbuildvalidate.ValidateWechatHTML(base.Data, sections, allAssets, false)
		if validationErr != nil {
			return cxFailAndCommit(ctx, tx, buildID, cxValidationAPIError(validationErr))
		}
		imageEvidence = report.ImageEvidence
		validation["image_evidence"] = imageEvidence
		validation["unused_asset_ids"] = report.UnusedAssetIDs
	}
	if cxTargetSelected(targets, "stable_html") {
		workValues, _ := snapshot["work"].(map[string]any)
		report, validationErr := cxbuildvalidate.ValidateWechatHTML(stable.Data, sections, allAssets, true, cxString(workValues["title"]))
		if validationErr != nil {
			return cxFailAndCommit(ctx, tx, buildID, cxValidationAPIError(validationErr))
		}
		_ = report // The base HTML supplies source evidence; the stable copy must match it independently.
	}
	csvData, err := cxBuildEvidenceCSV(imageEvidence)
	if err != nil {
		return err
	}
	csvArtifact := cxBuildArtifact{Kind: "csv", Name: "evidence.csv", MIME: "text/csv; charset=utf-8", Data: csvData,
		Bytes: int64(len(csvData)), SHA256: cxSHA256(csvData)}
	privacyArtifacts := append(append([]cxBuildArtifact(nil), artifacts...), csvArtifact)
	privacy, ready := cxScanBuildArtifacts(snapshot, sections, privacyArtifacts)
	validation["privacy"] = privacy
	if !ready {
		detail := map[string]any{"validation": validation}
		if err := cxFailBuild(ctx, tx, buildID, "scanner_unverified", detail); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusServiceUnavailable, "scanner_unverified", "隐私扫描器尚未达到文档规定的发布条件，构建未完成").With(detail)
	}
	rendererReceipt := map[string]any{"source": "client_reported", "client": input.RendererReceipt.Client,
		"application_version": input.RendererReceipt.ApplicationVersion, "renderer_contract_version": input.RendererReceipt.RendererContractVersion,
		"chromium_version": input.RendererReceipt.ChromiumVersion, "font_family": input.RendererReceipt.FontFamily,
		"device_scale_factor": input.RendererReceipt.DeviceScaleFactor, "viewport_width": input.RendererReceipt.ViewportWidth,
		"viewport_height": input.RendererReceipt.ViewportHeight}
	if input.RendererReceipt.LongImage != nil {
		rendererReceipt["long_image"] = input.RendererReceipt.LongImage
	}
	manifest := map[string]any{
		"schema": "ops.build-manifest/v1", "build_id": buildID.String(), "work_id": workID.String(),
		"source_hash": sourceHash, "basis_revision": revision, "targets": targets,
		"validator_version": cxbuildvalidate.ValidatorVersion, "privacy_report_hash": privacy["report_hash"],
		"image_evidence": validation["image_evidence"], "unused_asset_ids": validation["unused_asset_ids"],
		"artifacts": cxBuildManifestArtifacts(selectedArtifacts), "coverage": privacy["coverage"],
		"evidence_csv":     map[string]any{"name": "evidence.csv", "mime": csvArtifact.MIME, "bytes": csvArtifact.Bytes, "sha256": csvArtifact.SHA256},
		"syntax_report":    cxBuildSyntaxReport(snapshot, revision),
		"privacy_report":   privacy,
		"renderer_receipt": rendererReceipt,
	}
	manifestBytes, err := cxcanonicaljson.Marshal(manifest)
	if err != nil {
		return err
	}
	manifestHash := sha256.Sum256(manifestBytes)
	manifestSHA := hex.EncodeToString(manifestHash[:])
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	var expires time.Time
	if err := tx.QueryRow(ctx, `UPDATE work_build SET status='built',manifest=$2::jsonb,manifest_sha256=$3,
		error_code=NULL,error_detail=$4::jsonb,finished_at=now(),expires_at=now()+interval '7 days'
		WHERE id=$1 AND status='running' RETURNING expires_at`, buildID, string(manifestJSON), manifestSHA, cxMustJSON(map[string]any{"validation": validation})).Scan(&expires); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "work_build_complete", "work_build", buildID.String(), "ok", map[string]any{"manifest_sha256": manifestSHA})
	return ok(w, map[string]any{"status": "built", "manifest": manifest, "manifest_sha256": manifestSHA, "expires_at": expires})
}

func cxValidBuildRendererReceipt(receipt cxBuildRendererReceipt) bool {
	return (receipt.Client == "desktop" || receipt.Client == "web") &&
		cxBoundedReceiptText(receipt.ApplicationVersion, 64) &&
		cxBoundedReceiptText(receipt.RendererContractVersion, 64) &&
		cxBoundedReceiptText(receipt.ChromiumVersion, 128) &&
		cxBoundedReceiptText(receipt.FontFamily, 256) &&
		receipt.DeviceScaleFactor >= 0.5 && receipt.DeviceScaleFactor <= 4 &&
		receipt.ViewportWidth >= 1 && receipt.ViewportWidth <= 8192 &&
		receipt.ViewportHeight >= 1 && receipt.ViewportHeight <= 8192
}

func cxValidBuildLongImageReceipt(receipt *cxBuildLongImageReceipt, sourceHash string) bool {
	if receipt == nil || receipt.SourceHash != sourceHash || receipt.CaptureEngine != "chromium-cdp" ||
		!cxBoundedReceiptText(receipt.CaptureEngineVersion, 128) ||
		receipt.HeightCSS < 1 || receipt.HeightCSS > 30_000 || receipt.DPR != 2 ||
		receipt.Segments < (receipt.HeightCSS*receipt.DPR+15_999)/16_000 ||
		receipt.Segments > (receipt.HeightCSS*receipt.DPR+7_999)/8_000 ||
		receipt.ViewportWidth != 390 || receipt.ViewportHeight != 844 ||
		receipt.CheckScope != "font_ready,image_decode,layout_stable_2_frames,segment_png_decode,final_png_dimensions,non_uniform_pixels" ||
		receipt.CapturedAt.IsZero() ||
		!cxBoundedReceiptText(receipt.FontFamily, 256) {
		return false
	}
	return true
}

func cxBoundedReceiptText(value string, max int) bool {
	return value != "" && len([]rune(value)) <= max && !strings.ContainsAny(value, "\x00\r\n")
}

func cxSelectBuildOutputs(targets []string, artifacts []cxBuildArtifact, submitted []cxBuildArtifactSubmission) ([]cxBuildArtifact, *APIError) {
	selected := make([]cxBuildArtifact, 0, len(targets))
	byKind := make(map[string][]cxBuildArtifact)
	for _, artifact := range artifacts {
		byKind[artifact.Kind] = append(byKind[artifact.Kind], artifact)
	}
	expectedKinds := make([]string, 0, len(targets))
	for _, target := range targets {
		switch target {
		case "wechat_html":
			expectedKinds = append(expectedKinds, "html")
		case "stable_html":
			expectedKinds = append(expectedKinds, "stable_html")
		case "long_image":
			expectedKinds = append(expectedKinds, "png")
		case "xhs_cards":
			expectedKinds = append(expectedKinds, "zip")
		case "cover_images":
			return nil, apiErr(http.StatusConflict, "build_target_not_ready", "封面产物尚未达到构建校验条件")
		default:
			return nil, apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "构建目标无效")
		}
	}
	if len(submitted) != len(expectedKinds) {
		return nil, apiErr(http.StatusUnprocessableEntity, "artifact_set_mismatch", "完成请求必须精确列出所选目标的全部可交付产物")
	}
	used := make(map[uuid.UUID]bool, len(submitted))
	for i, kind := range expectedKinds {
		if len(byKind[kind]) != 1 {
			return nil, apiErr(http.StatusUnprocessableEntity, "build_artifacts_missing", "所选目标缺少唯一可交付产物")
		}
		artifact := byKind[kind][0]
		id, err := uuid.Parse(submitted[i].ArtifactID)
		if err != nil || id != artifact.ID || submitted[i].Kind != artifact.Kind || submitted[i].Name != artifact.Name || used[id] {
			return nil, apiErr(http.StatusUnprocessableEntity, "artifact_set_mismatch", "完成请求中的产物标识与已上传文件不一致")
		}
		used[id] = true
		selected = append(selected, artifact)
	}
	return selected, nil
}

type cxBuildValidationError struct {
	Status  int
	Code    string
	Message string
	Detail  any
}

func (e *cxBuildValidationError) Error() string { return e.Code + ": " + e.Message }

func cxReadBuildArtifacts(ctx context.Context, tx pgx.Tx, dataDir string, buildID, workspaceID uuid.UUID) ([]cxBuildArtifact, error) {
	rows, err := tx.Query(ctx, `SELECT id,kind,name,storage_path,mime,bytes,sha256,width,height
		FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2 ORDER BY kind,name,id`, buildID, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []cxBuildArtifact{}
	for rows.Next() {
		var artifact cxBuildArtifact
		if err := rows.Scan(&artifact.ID, &artifact.Kind, &artifact.Name, &artifact.StoragePath, &artifact.MIME, &artifact.Bytes,
			&artifact.SHA256, &artifact.Width, &artifact.Height); err != nil {
			return nil, err
		}
		if artifact.StoragePath != cxBuildStoragePath(workspaceID, buildID, artifact.ID) {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "artifact_invalid", Message: "产物存储索引无效"}
		}
		fullPath, err := cxSafeDataPath(dataDir, artifact.StoragePath)
		if err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "artifact_invalid", Message: "产物存储位置无效"}
		}
		info, err := os.Lstat(fullPath)
		if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.Bytes || artifact.Bytes < 1 || artifact.Bytes > cxBuildArtifactMaxBytes {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "artifact_missing", Message: "一个或多个产物文件缺失或大小不符"}
		}
		artifact.Data, err = os.ReadFile(fullPath)
		if err != nil || int64(len(artifact.Data)) != artifact.Bytes || cxSHA256(artifact.Data) != artifact.SHA256 {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "artifact_hash_mismatch", Message: "一个或多个产物文件摘要校验失败"}
		}
		mimeType, width, height, inspectErr := cxInspectBuildArtifact(artifact.Kind, artifact.Name, artifact.Data)
		if inspectErr != nil || mimeType != artifact.MIME || (artifact.Width != nil && width != *artifact.Width) || (artifact.Height != nil && height != *artifact.Height) {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "artifact_invalid", Message: "产物格式或服务端解码尺寸不一致"}
		}
		out = append(out, artifact)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) cxLoadFrozenAssets(ctx context.Context, tx pgx.Tx, workspaceID, workID, accountID uuid.UUID, snapshots map[string]cxbuildvalidate.Asset, references []string, locations map[string]map[string]any) (map[string]cxbuildvalidate.Asset, error) {
	verified := map[string]cxbuildvalidate.Asset{}
	for _, rawID := range references {
		if rawID == "" {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "unmanaged_image", Message: "正文图片不是本作品的托管素材"}
		}
		if _, exists := verified[rawID]; exists {
			continue
		}
		frozen, exists := snapshots[rawID]
		if !exists {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片不在构建来源快照中", Detail: cxImageErrorDetail(locations, rawID)}
		}
		assetID, err := uuid.Parse(rawID)
		if err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片标识无效", Detail: cxImageErrorDetail(locations, rawID)}
		}
		var actual struct {
			WorkID      uuid.NullUUID
			StoragePath string
			MIME        string
			SHA256      string
			Width       int
			Height      int
			Bytes       int
			Position    int
			AltText     string
		}
		if err := tx.QueryRow(ctx, `SELECT work_id,storage_path,mime,sha256,width,height,bytes,position,alt_text FROM asset
			WHERE id=$1 AND workspace_id=$2 AND account_id=$3`, assetID, workspaceID, accountID).Scan(
			&actual.WorkID, &actual.StoragePath, &actual.MIME, &actual.SHA256, &actual.Width, &actual.Height, &actual.Bytes, &actual.Position, &actual.AltText); err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片已不可用", Detail: cxImageErrorDetail(locations, rawID)}
		}
		var actualWorkID *uuid.UUID
		if actual.WorkID.Valid {
			value := actual.WorkID.UUID
			actualWorkID = &value
		}
		if actualWorkID == nil || *actualWorkID != workID || !cxAssetSnapshotMatches(frozen, actualWorkID, actual.MIME, actual.SHA256, actual.Width, actual.Height, actual.Bytes, actual.Position, actual.AltText) {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片与本作品的冻结记录不一致", Detail: cxImageErrorDetail(locations, rawID)}
		}
		if !cxSafeAssetStoragePath(actual.StoragePath, workID, assetID, actual.MIME) {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片存储索引无效", Detail: cxImageErrorDetail(locations, rawID)}
		}
		fullPath, err := cxSafeDataPath(s.cfg.DataDir, actual.StoragePath)
		if err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片存储位置无效", Detail: cxImageErrorDetail(locations, rawID)}
		}
		data, err := os.ReadFile(fullPath)
		if err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片文件缺失", Detail: cxImageErrorDetail(locations, rawID)}
		}
		frozen.Data = data
		if err := cxbuildvalidate.ValidateFrozenAsset(frozen); err != nil {
			return nil, &cxBuildValidationError{Status: http.StatusUnprocessableEntity, Code: "image_missing", Message: "引用图片字节与冻结哈希或尺寸不一致", Detail: cxImageErrorDetail(locations, rawID)}
		}
		verified[rawID] = frozen
	}
	return verified, nil
}

func cxBuildSnapshotInputs(snapshot map[string]any) ([]cxbuildvalidate.Section, map[string]cxbuildvalidate.Asset, struct {
	accountID uuid.UUID
	coverID   *uuid.UUID
}, error) {
	var workInfo struct {
		accountID uuid.UUID
		coverID   *uuid.UUID
	}
	workValues, ok := snapshot["work"].(map[string]any)
	if !ok {
		return nil, nil, workInfo, fmt.Errorf("work snapshot missing")
	}
	accountID, err := uuid.Parse(cxString(workValues["account_id"]))
	if err != nil {
		return nil, nil, workInfo, err
	}
	workInfo.accountID = accountID
	if rawCover := cxString(workValues["cover_asset_id"]); rawCover != "" {
		coverID, err := uuid.Parse(rawCover)
		if err != nil {
			return nil, nil, workInfo, err
		}
		workInfo.coverID = &coverID
	}
	sectionsRaw, ok := snapshot["sections"].([]any)
	if !ok {
		return nil, nil, workInfo, fmt.Errorf("sections snapshot missing")
	}
	sections := make([]cxbuildvalidate.Section, 0, len(sectionsRaw))
	for _, raw := range sectionsRaw {
		values, ok := raw.(map[string]any)
		if !ok {
			return nil, nil, workInfo, fmt.Errorf("section snapshot malformed")
		}
		sections = append(sections, cxbuildvalidate.Section{ID: cxString(values["id"]), Position: cxInt(values["position"]), Heading: cxString(values["heading"]), ContentMD: cxString(values["content_md"])})
	}
	assetsRaw, ok := snapshot["assets"].([]any)
	if !ok {
		return nil, nil, workInfo, fmt.Errorf("assets snapshot missing")
	}
	assets := make(map[string]cxbuildvalidate.Asset, len(assetsRaw))
	for _, raw := range assetsRaw {
		values, ok := raw.(map[string]any)
		if !ok {
			return nil, nil, workInfo, fmt.Errorf("asset snapshot malformed")
		}
		id := cxString(values["id"])
		var assetWorkID *string
		if rawWorkID := cxString(values["work_id"]); rawWorkID != "" {
			assetWorkID = &rawWorkID
		}
		assets[id] = cxbuildvalidate.Asset{
			ID: id, WorkID: assetWorkID, SHA256: cxString(values["sha256"]), MIME: cxString(values["mime"]), Width: cxInt(values["width"]),
			Height: cxInt(values["height"]), Bytes: int64(cxInt(values["bytes"])), Position: cxInt(values["position"]),
			AltText: cxString(values["alt_text"]), IsCover: workInfo.coverID != nil && id == workInfo.coverID.String(),
		}
	}
	return sections, assets, workInfo, nil
}

func cxAssetSnapshotMatches(asset cxbuildvalidate.Asset, workID *uuid.UUID, mime, hash string, width, height, size, position int, alt string) bool {
	if workID == nil || asset.WorkID == nil {
		return false
	}
	return *asset.WorkID == workID.String() && asset.MIME == mime && asset.SHA256 == hash && asset.Width == width && asset.Height == height && asset.Bytes == int64(size) && asset.Position == position && asset.AltText == alt
}

func cxSafeAssetStoragePath(storagePath string, workID, assetID uuid.UUID, mime string) bool {
	extension := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime]
	if extension == "" {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(storagePath)))
	expected := "assets/" + workID.String() + "/" + assetID.String() + extension
	if mime == "image/jpeg" {
		return clean == expected || clean == "assets/"+workID.String()+"/"+assetID.String()+".jpeg"
	}
	return clean == expected
}

func cxSafeDataPath(dataDir, relative string) (string, error) {
	base, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		return "", err
	}
	full := filepath.Join(base, filepath.FromSlash(relative))
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("path outside data directory")
	}
	return resolved, nil
}

func cxTargetSelected(targets []string, target string) bool {
	for _, selected := range targets {
		if selected == target {
			return true
		}
	}
	return false
}

func cxSingleArtifact(artifacts []cxBuildArtifact, kind string) (cxBuildArtifact, int) {
	var found cxBuildArtifact
	count := 0
	for _, artifact := range artifacts {
		if artifact.Kind == kind {
			found = artifact
			count++
		}
	}
	return found, count
}

func cxArtifactsOfKind(artifacts []cxBuildArtifact, kind string) []cxBuildArtifact {
	out := []cxBuildArtifact{}
	for _, artifact := range artifacts {
		if artifact.Kind == kind {
			out = append(out, artifact)
		}
	}
	return out
}

func cxBuildManifestArtifacts(artifacts []cxBuildArtifact) []map[string]any {
	out := make([]map[string]any, 0, len(artifacts))
	for _, artifact := range artifacts {
		out = append(out, map[string]any{"id": artifact.ID.String(), "kind": artifact.Kind, "name": artifact.Name,
			"mime": artifact.MIME, "bytes": artifact.Bytes, "sha256": artifact.SHA256, "width": artifact.Width, "height": artifact.Height})
	}
	return out
}

func cxValidationAPIError(err error) *APIError {
	var validationErr *cxbuildvalidate.ValidationError
	if !errors.As(err, &validationErr) {
		return apiErr(http.StatusUnprocessableEntity, "html_invalid", "HTML 结构与冻结来源无法匹配")
	}
	status := http.StatusUnprocessableEntity
	detail := map[string]any{}
	if validationErr.SectionID != "" {
		detail["section_id"] = validationErr.SectionID
	}
	if validationErr.Occurrence > 0 {
		detail["occurrence"] = validationErr.Occurrence
	}
	if validationErr.AssetID != "" {
		detail["asset_id"] = validationErr.AssetID
	}
	return apiErr(status, validationErr.Code, validationErr.Message).With(detail)
}

func cxFailBuild(ctx context.Context, tx pgx.Tx, buildID uuid.UUID, code string, detail any) error {
	var raw any
	if detail != nil {
		encoded, err := json.Marshal(detail)
		if err != nil {
			return err
		}
		raw = string(encoded)
	}
	_, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code=$2,error_detail=$3::jsonb,finished_at=now()
		WHERE id=$1 AND status='running'`, buildID, code, raw)
	return err
}

func cxFailAndCommit(ctx context.Context, tx pgx.Tx, buildID uuid.UUID, apiError *APIError) error {
	if err := cxFailBuild(ctx, tx, buildID, apiError.Code, apiError.Detail); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return apiError
}

func cxSHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func cxString(value any) string {
	text, _ := value.(string)
	return text
}

func cxInt(value any) int {
	switch number := value.(type) {
	case json.Number:
		parsed, _ := number.Int64()
		return int(parsed)
	case int:
		return number
	case int64:
		return int(number)
	default:
		return 0
	}
}

func containsUnmanagedImage(ids []string) bool {
	for _, id := range ids {
		if id == "" {
			return true
		}
	}
	return false
}

func cxImageReferenceLocations(sections []cxbuildvalidate.Section) map[string]map[string]any {
	locations := map[string]map[string]any{}
	for _, section := range sections {
		refs, err := cxbuildvalidate.ReferencedImageIDs([]cxbuildvalidate.Section{section})
		if err != nil {
			continue
		}
		for occurrence, id := range refs {
			if _, exists := locations[id]; !exists {
				locations[id] = map[string]any{"section_id": section.ID, "occurrence": occurrence + 1}
				if id != "" {
					locations[id]["asset_id"] = id
				}
			}
		}
	}
	return locations
}

func cxImageErrorDetail(locations map[string]map[string]any, assetID string) map[string]any {
	if detail, ok := locations[assetID]; ok {
		return detail
	}
	return map[string]any{"asset_id": assetID}
}

func cxMustJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
