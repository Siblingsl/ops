package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	cxBuildArtifactMaxBytes = 64 << 20
	cxBuildTotalMaxBytes    = 128 << 20
	cxBuildMaxArtifacts     = 64
	cxStableHTMLMaxBytes    = 8 << 20
)

func (s *Server) uploadCXBuildArtifact(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	workspaceID := ident(r.Context()).WorkspaceID
	r.Body = http.MaxBytesReader(w, r.Body, cxBuildArtifactMaxBytes+(1<<20))
	file, header, err := r.FormFile("file")
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return s.rejectCXBuildArtifact(r.Context(), workspaceID, buildID, http.StatusRequestEntityTooLarge, "artifact_too_large", "单个产物必须大于 0 且不超过 64 MiB")
		}
		return s.rejectCXBuildArtifact(r.Context(), workspaceID, buildID, http.StatusUnprocessableEntity, "artifact_invalid", "请选择有效产物文件")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, cxBuildArtifactMaxBytes+1))
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "产物文件无法读取")
	}
	if len(data) == 0 || len(data) > cxBuildArtifactMaxBytes {
		return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusRequestEntityTooLarge, "artifact_too_large", "单个产物必须大于 0 且不超过 64 MiB")
	}
	kind := strings.TrimSpace(r.FormValue("kind"))
	if !cxBuildArtifactKind(kind) {
		return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusUnprocessableEntity, "artifact_invalid", "产物类型无效")
	}
	requestedName := header.Filename
	if kind == "stable_html" {
		var sourceJSON []byte
		if err := s.db.QueryRow(r.Context(), `SELECT source_snapshot FROM work_build WHERE id=$1 AND workspace_id=$2 AND status='running'`, buildID, workspaceID).Scan(&sourceJSON); err != nil {
			return err
		}
		var snapshot struct {
			Work struct {
				Title    string `json:"title"`
				Revision int    `json:"revision"`
			} `json:"work"`
		}
		if err := json.Unmarshal(sourceJSON, &snapshot); err != nil || snapshot.Work.Revision < 1 {
			return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusConflict, "build_snapshot_invalid", "构建来源快照无法生成稳定版文件名")
		}
		requestedName = cxBuildStableArtifactName(snapshot.Work.Title, snapshot.Work.Revision)
	}
	name, err := cxBuildSafeArtifactName(requestedName)
	if err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) {
			return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, apiError.Status, apiError.Code, apiError.Message)
		}
		return err
	}
	mimeType, width, height, err := cxInspectBuildArtifact(kind, name, data)
	if err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) {
			return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, apiError.Status, apiError.Code, apiError.Message)
		}
		return err
	}
	if kind == "stable_html" && len(data) > cxStableHTMLMaxBytes {
		return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusUnprocessableEntity, "stable_html_too_large", "稳定版 HTML 超过 8 MiB")
	}
	hashBytes := sha256.Sum256(data)
	hash := hex.EncodeToString(hashBytes[:])
	if claimed := strings.TrimSpace(r.FormValue("sha256")); claimed != "" && claimed != hash {
		return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusUnprocessableEntity, "artifact_hash_mismatch", "上传摘要与服务端计算结果不一致")
	}
	if claimedWidth, claimedHeight, err := cxParseClaimedDimensions(r); err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) {
			return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, apiError.Status, apiError.Code, apiError.Message)
		}
		return err
	} else if (claimedWidth != nil || claimedHeight != nil) && (*claimedWidth != width || *claimedHeight != height) {
		return s.rejectCXBuildArtifact(ctx, workspaceID, buildID, http.StatusUnprocessableEntity, "artifact_dimension_mismatch", "上传尺寸与服务端解码结果不一致")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var status string
	var deadlineAt time.Time
	var accountStatus string
	var targets []string
	err = tx.QueryRow(ctx, `SELECT b.status,b.deadline_at,b.targets,a.status FROM work_build b
		JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL FOR UPDATE OF b`, buildID, workspaceID).
		Scan(&status, &deadlineAt, &targets, &accountStatus)
	if err != nil {
		return err
	}
	if accountStatus != "active" {
		return apiErr(http.StatusConflict, "account_inactive", "账号已停用，不能继续新的内容构建")
	}
	if status != "running" || !deadlineAt.After(s.now()) {
		if status == "running" {
			if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='build_timeout',finished_at=now()
				WHERE id=$1 AND status='running'`, buildID); err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return err
			}
		}
		return apiErr(http.StatusConflict, "build_not_running", "构建已结束、已取消或已超时")
	}
	if !cxBuildArtifactMatchesTarget(kind, targets) {
		if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='target_not_allowed',finished_at=now() WHERE id=$1`, buildID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "产物类型不属于本次构建目标，本次构建已失败")
	}
	var existing struct {
		ID    uuid.UUID
		Kind  string
		Hash  string
		Bytes int64
	}
	err = tx.QueryRow(ctx, `SELECT id,kind,sha256,bytes FROM work_build_artifact WHERE build_id=$1 AND workspace_id=$2 AND name=$3`, buildID, workspaceID, name).
		Scan(&existing.ID, &existing.Kind, &existing.Hash, &existing.Bytes)
	if err == nil {
		if existing.Kind == kind && existing.Hash == hash && existing.Bytes == int64(len(data)) {
			if err := tx.Commit(ctx); err != nil {
				return err
			}
			return ok(w, map[string]any{"artifact_id": existing.ID, "sha256": hash, "bytes": len(data)})
		}
		if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='artifact_conflict',finished_at=now()
			WHERE id=$1 AND status='running'`, buildID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusConflict, "artifact_conflict", "同名产物已存在但内容不同，本次构建已失败")
	}
	if err != pgx.ErrNoRows {
		return err
	}
	var fileCount int
	var totalBytes int64
	if err := tx.QueryRow(ctx, `SELECT count(*),coalesce(sum(bytes),0) FROM work_build_artifact WHERE build_id=$1`, buildID).Scan(&fileCount, &totalBytes); err != nil {
		return err
	}
	if fileCount >= cxBuildMaxArtifacts || totalBytes+int64(len(data)) > cxBuildTotalMaxBytes {
		if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='build_artifact_limit',finished_at=now() WHERE id=$1`, buildID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusRequestEntityTooLarge, "build_artifact_limit", "本次构建最多保存 64 个文件、总计 128 MiB；本次构建已失败")
	}
	artifactID := uuid.New()
	rel := cxBuildStoragePath(workspaceID, buildID, artifactID)
	if err := s.cxWriteArtifactFile(rel, data); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO work_build_artifact(id,workspace_id,build_id,kind,name,storage_path,mime,bytes,sha256,width,height)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, artifactID, workspaceID, buildID, kind, name, rel, mimeType, len(data), hash, cxNullablePositive(width), cxNullablePositive(height)); err != nil {
		_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel)))
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel)))
		return err
	}
	s.audit(ctx, "work_build_artifact_upload", "work_build", buildID.String(), "ok", map[string]any{"artifact_id": artifactID.String(), "kind": kind})
	return ok(w, map[string]any{"artifact_id": artifactID, "sha256": hash, "bytes": len(data)})
}

func cxBuildStableArtifactName(title string, revision int) string {
	var cleaned strings.Builder
	for _, char := range title {
		if strings.ContainsRune(`<>:"/\\|?*`, char) || unicode.IsControl(char) {
			cleaned.WriteRune('_')
		} else {
			cleaned.WriteRune(char)
		}
	}
	base := strings.TrimRight(strings.TrimSpace(cleaned.String()), ". ")
	if base == "" || base == "." || base == ".." {
		base = "untitled"
	}
	runes := []rune(base)
	if len(runes) > 80 {
		base = string(runes[:80])
	}
	reserved := map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}
	upper := strings.ToUpper(base)
	if reserved[upper] || (len(upper) == 4 && (strings.HasPrefix(upper, "COM") || strings.HasPrefix(upper, "LPT")) && upper[3] >= '1' && upper[3] <= '9') {
		base = "work-" + base
	}
	return fmt.Sprintf("%s-r%d-stable.html", base, revision)
}

func (s *Server) rejectCXBuildArtifact(ctx context.Context, workspaceID, buildID uuid.UUID, statusCode int, code, message string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var status string
	var deadlineAt time.Time
	var accountStatus string
	if err := tx.QueryRow(ctx, `SELECT b.status,b.deadline_at,a.status FROM work_build b
		JOIN work w ON w.id=b.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE b.id=$1 AND b.workspace_id=$2 AND a.workspace_id=$2 AND w.deleted_at IS NULL FOR UPDATE OF b`, buildID, workspaceID).
		Scan(&status, &deadlineAt, &accountStatus); err != nil {
		return err
	}
	if accountStatus != "active" {
		return apiErr(http.StatusConflict, "account_inactive", "账号已停用，不能继续新的内容构建")
	}
	if status != "running" {
		return apiErr(http.StatusConflict, "build_not_running", "构建已结束、已取消或已超时")
	}
	if !deadlineAt.After(s.now()) {
		if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code='build_timeout',finished_at=now() WHERE id=$1`, buildID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return apiErr(http.StatusConflict, "build_not_running", "构建已超时")
	}
	if _, err := tx.Exec(ctx, `UPDATE work_build SET status='failed',reusable=false,error_code=$2,finished_at=now() WHERE id=$1`, buildID, code); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return apiErr(statusCode, code, message)
}

func cxBuildArtifactKind(kind string) bool {
	switch kind {
	case "html", "stable_html", "png", "zip", "json", "csv":
		return true
	default:
		return false
	}
}

func cxBuildArtifactMatchesTarget(kind string, targets []string) bool {
	accepted := map[string]string{"stable_html": "stable_html", "png": "long_image", "zip": "xhs_cards"}
	if target, ok := accepted[kind]; ok {
		for _, selected := range targets {
			if selected == target {
				return true
			}
		}
		return false
	}
	if kind == "html" {
		return cxHasCXBuildTarget(targets, "wechat_html") || cxHasCXBuildTarget(targets, "stable_html") || cxHasCXBuildTarget(targets, "long_image")
	}
	return false
}

func cxHasCXBuildTarget(targets []string, target string) bool {
	for _, value := range targets {
		if value == target {
			return true
		}
	}
	return false
}

func cxBuildSafeArtifactName(value string) (string, error) {
	if !utf8.ValidString(value) || strings.ContainsAny(value, "\x00\r\n") {
		return "", apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "产物文件名无效")
	}
	name := strings.TrimSpace(path.Base(strings.ReplaceAll(value, "\\", "/")))
	if name == "" || name == "." || name == ".." || len([]rune(name)) > 120 {
		return "", apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "产物文件名无效或过长")
	}
	return name, nil
}

func cxInspectBuildArtifact(kind, name string, data []byte) (string, int, int, error) {
	extension := strings.ToLower(path.Ext(name))
	if kind == "html" || kind == "stable_html" {
		if extension != ".html" && extension != ".htm" || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 || bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "HTML 产物必须是 UTF-8 的 .html 文件")
		}
		return "text/html; charset=utf-8", 0, 0, nil
	}
	if kind == "png" {
		if extension != ".png" || len(data) < 8 || !bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")) {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "PNG 产物格式无效")
		}
		config, err := png.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 46_800_000 {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "long_image_invalid", "PNG 尺寸无法解码或超过像素预算")
		}
		if config.Width != 780 || config.Height > 60_000 {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "long_image_invalid", "长图必须为 780px 宽且高度不超过 60000px")
		}
		decoded, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "long_image_invalid", "PNG 图像数据无法完整解码")
		}
		bounds := decoded.Bounds()
		first := decoded.At(bounds.Min.X, bounds.Min.Y)
		firstR, firstG, firstB, firstA := first.RGBA()
		varies, visible := false, false
		for y := bounds.Min.Y; y < bounds.Max.Y && (!varies || !visible); y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				r, g, b, a := decoded.At(x, y).RGBA()
				if r != firstR || g != firstG || b != firstB || a != firstA {
					varies = true
				}
				if a > 0 {
					visible = true
				}
				if varies && visible {
					break
				}
			}
		}
		if !visible || !varies {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "long_image_invalid", "长图没有可辨识的非空图像内容")
		}
		return "image/png", config.Width, config.Height, nil
	}
	if kind == "zip" {
		if extension != ".zip" || len(data) < 4 || !bytes.Equal(data[:4], []byte("PK\x03\x04")) {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物格式无效")
		}
		// 上传阶段先挡穿越路径、重复条目与解压炸弹；像素与卡片对应关系由 complete 按冻结 options 复核。
		if err := cxValidateCardsZIPSafety(data); err != nil {
			return "", 0, 0, err
		}
		return "application/zip", 0, 0, nil
	}
	if kind == "json" {
		if extension != ".json" || !json.Valid(data) {
			return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "JSON 产物格式无效")
		}
		return "application/json", 0, 0, nil
	}
	if extension != ".csv" || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", 0, 0, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "CSV 产物格式无效")
	}
	return "text/csv; charset=utf-8", 0, 0, nil
}

func cxParseClaimedDimensions(r *http.Request) (*int, *int, error) {
	widthText, heightText := strings.TrimSpace(r.FormValue("width")), strings.TrimSpace(r.FormValue("height"))
	if widthText == "" && heightText == "" {
		return nil, nil, nil
	}
	width, widthErr := strconv.Atoi(widthText)
	height, heightErr := strconv.Atoi(heightText)
	if widthErr != nil || heightErr != nil || width < 1 || height < 1 {
		return nil, nil, apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "产物宽高必须同时为正整数")
	}
	return &width, &height, nil
}

func cxNullablePositive(value int) any {
	if value < 1 {
		return nil
	}
	return value
}

func (s *Server) cxWriteArtifactFile(rel string, data []byte) error {
	full := filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".build-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, full); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}
