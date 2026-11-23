package app

// REF41 C3：PPTX/DOCX 确定性导出。
// - 渲染由服务端执行（office 渲染器），产物上传走既有 /builds/{id}/artifacts；
//   上传时解包复核 AIGC 元数据（docProps/custom.xml AIGC=true、DOCX 页脚声明），
//   缺失即拒绝（AIGC 标识合规要求，不可由用户关闭）。
// - 确定性口径（同输入同哈希）由 office 渲染器保证：固定 ZIP 时间戳/顺序；
//   同一 work revision + 参数 → 同一文件哈希；office_hash 写入 manifest。
// - 失败：校验不过 → 422 artifact_invalid（无半成品 artifact，上传事务拒绝）；
//   complete 阶段产物文件摘要与登记不一致 → artifact_hash_mismatch；
//   manifest.office_hash 在 complete 时由已校验产物摘要生成，不另设独立来源。

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// cxOfficeRenderTimeout 是独立 Node 渲染进程的硬超时；测试可临时缩短以覆盖超时分支。
var cxOfficeRenderTimeout = 30 * time.Second

// officeAIGCFlagRe 匹配 docProps/custom.xml 中的 AIGC 布尔属性（值为 true）。
var officeAIGCFlagRe = regexp.MustCompile(`(?is)<property[^>]*name="AIGC"[^>]*>\s*<vt:bool>\s*true\s*</vt:bool>\s*</property>`)

// Office 容器不能沿用组图包的 12 条目上限：一个最小 PPTX 也有 20+ 个 OOXML 部件，
// 固定模板还会包含 notes/theme/layout 等标准部件。这里单独设定宽松但有界的预算。
const (
	cxOfficeZipMaxEntries    = 256
	cxOfficeZipMaxEntryBytes = 64 << 20
	cxOfficeZipMaxTotalBytes = 512 << 20
)

// officeFooterRe 匹配 DOCX 页脚部件中的 AIGC 声明文本。
var officeFooterRe = regexp.MustCompile(`(?s)AI\s*生成内容`)

// cxValidateOfficeArtifact 解包 Office 产物复核 AIGC 合规标记：
// - PPTX/DOCX：docProps/custom.xml 必须含 AIGC=true 属性；
// - DOCX：word/footer*.xml 必须含"AI 生成内容"页脚文本；
// - docProps/core.xml 的 description 含"由 OPS 生成"。
// 失败返回 422，上传事务拒绝 → 不留半成品 artifact（C3-A3/C3-A4）。
func cxValidateOfficeArtifact(kind string, data []byte) error {
	r, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物无法解包")
	}
	read := func(name string) ([]byte, bool) {
		for _, f := range r.File {
			if f.Name == name {
				rc, err := f.Open()
				if err != nil {
					return nil, false
				}
				defer rc.Close()
				b, err := io.ReadAll(rc)
				if err != nil {
					return nil, false
				}
				return b, true
			}
		}
		return nil, false
	}
	custom, ok := read("docProps/custom.xml")
	if !ok {
		return apiErr(http.StatusUnprocessableEntity, "office_aigc_missing", "Office 产物缺少 docProps/custom.xml（AIGC 标识）")
	}
	if !officeAIGCFlagRe.Match(custom) {
		return apiErr(http.StatusUnprocessableEntity, "office_aigc_missing", "Office 产物缺少 AIGC=true 文档属性（合规要求，不可关闭）")
	}
	core, ok := read("docProps/core.xml")
	if !ok || !strings.Contains(string(core), "由 OPS 生成") {
		return apiErr(http.StatusUnprocessableEntity, "office_aigc_missing", "Office 产物核心属性缺少“由 OPS 生成”声明")
	}
	if kind == "docx" {
		found := false
		for _, f := range r.File {
			if strings.HasPrefix(f.Name, "word/footer") && strings.HasSuffix(f.Name, ".xml") {
				rc, err := f.Open()
				if err != nil {
					continue
				}
				b, err := io.ReadAll(rc)
				rc.Close()
				if err == nil && officeFooterRe.Match(b) {
					found = true
					break
				}
			}
		}
		if !found {
			return apiErr(http.StatusUnprocessableEntity, "office_aigc_missing", "DOCX 页脚缺少“AI 生成内容”声明")
		}
	}
	return nil
}

// cxValidateOfficeZIPSafety 是 Office 容器专用的 ZIP 安全检查：
// 与组图 ZIP 不同，OOXML 必须允许一级目录条目（docProps/、word/ 等），
// 但仍拒绝穿越路径（..）、绝对路径、NUL、重复条目与解压炸弹。
func cxValidateOfficeZIPSafety(data []byte) *APIError {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物不是可解析的压缩包")
	}
	if len(reader.File) == 0 || len(reader.File) > cxOfficeZipMaxEntries {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物条目数超出允许范围")
	}
	var total int64
	seen := map[string]bool{}
	for _, file := range reader.File {
		name := file.Name
		if file.FileInfo().IsDir() {
			continue
		}
		if strings.ContainsAny(name, "\x00\r\n") || strings.Contains(name, "..") ||
			strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || seen[name] {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物包含不安全的条目路径")
		}
		seen[name] = true
		if file.UncompressedSize64 > cxOfficeZipMaxEntryBytes {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物单个条目超过大小上限")
		}
		total += int64(file.UncompressedSize64)
		if total > cxOfficeZipMaxTotalBytes {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "Office 产物解压总量超过上限")
		}
	}
	return nil
}

// cxOfficeRenderInput 是构建面板触发服务端 Node 渲染的请求体。
type cxOfficeRenderInput struct {
	Target string `json:"target"`
}

type cxOfficeRenderResponse struct {
	ArtifactID uuid.UUID `json:"artifact_id"`
	Name       string    `json:"name"`
	SHA256     string    `json:"sha256"`
	Bytes      int64     `json:"bytes"`
}

type cxOfficeRenderRequest struct {
	Target   string              `json:"target"`
	Template string              `json:"template"`
	Title    string              `json:"title"`
	Subtitle string              `json:"subtitle"`
	Sections []any               `json:"sections"`
	Body     string              `json:"body"`
	Cover    *cxOfficeCoverImage `json:"cover,omitempty"`
	Meta     map[string]any      `json:"meta"`
}

// cxOfficeCoverImage 是封面主图的冻结输入：字节以 base64 传入渲染器，
// 由渲染器按固定模板位置等比嵌入；哈希用于校验资产未被替换。
type cxOfficeCoverImage struct {
	DataBase64 string `json:"data_base64"`
	MIME       string `json:"mime"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SHA256     string `json:"sha256,omitempty"`
}

// renderCXBuildOffice 调用独立 Node 渲染器生成 Office 产物并直接落库。
// 客户端只传 target，不传文件字节；渲染器缺失/失败时构建标 failed，且不写任何 artifact。
func (s *Server) renderCXBuildOffice(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	buildID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var input cxOfficeRenderInput
	if err := decodeCXBuildJSON(w, r, &input); err != nil {
		return err
	}
	input.Target = strings.TrimSpace(input.Target)
	if input.Target != "pptx" && input.Target != "docx" {
		return validationFields("Office 目标必须是 pptx 或 docx", map[string]string{"target": "仅支持 pptx/docx"})
	}
	ctx := r.Context()
	workspaceID := ident(ctx).WorkspaceID
	var (
		workID     uuid.UUID
		status     string
		deadlineAt time.Time
		targets    []string
		sourceJSON []byte
	)
	if err := s.db.QueryRow(ctx, `SELECT work_id,status,deadline_at,targets,source_snapshot
		FROM work_build WHERE id=$1 AND workspace_id=$2`, buildID, workspaceID).
		Scan(&workID, &status, &deadlineAt, &targets, &sourceJSON); err != nil {
		return err
	}
	if status != "running" {
		return apiErr(http.StatusConflict, "build_not_running", "构建已结束、已取消或已超时")
	}
	if !deadlineAt.After(s.now()) {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "build_timeout", nil,
			http.StatusConflict, "build_not_running", "构建已超时")
	}
	if !cxBuildArtifactMatchesTarget(input.Target, targets) {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "target_not_allowed", nil,
			http.StatusUnprocessableEntity, "target_not_allowed", "产物类型不属于本次构建目标，本次构建已失败")
	}
	var snapshot struct {
		Work struct {
			ID           string     `json:"id"`
			Revision     int        `json:"revision"`
			Title        string     `json:"title"`
			Summary      string     `json:"summary"`
			Viewpoint    string     `json:"viewpoint"`
			CoverAssetID *uuid.UUID `json:"cover_asset_id"`
		} `json:"work"`
		Sections []any `json:"sections"`
	}
	if err := json.Unmarshal(sourceJSON, &snapshot); err != nil || snapshot.Work.Revision < 1 {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "build_snapshot_invalid", nil,
			http.StatusConflict, "build_snapshot_invalid", "构建来源快照无法生成 Office 文件名")
	}
	cover, coverErr := s.cxOfficeCoverForBuild(ctx, workspaceID, workID, snapshot.Work.CoverAssetID)
	if coverErr != nil {
		var api *APIError
		if errors.As(coverErr, &api) {
			return s.cxFailOfficeBuild(ctx, workspaceID, buildID, api.Code, nil,
				api.Status, api.Code, api.Message)
		}
		return coverErr
	}
	rendererDir, nodePath, err := s.cxOfficeRenderer()
	if err != nil {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_renderer_unavailable", nil,
			http.StatusServiceUnavailable, "office_renderer_unavailable", "Office 渲染器未安装，构建已失败")
	}
	subtitle := strings.TrimSpace(snapshot.Work.Summary)
	if subtitle == "" {
		subtitle = strings.TrimSpace(snapshot.Work.Viewpoint)
	}
	if subtitle == "" {
		subtitle = "由 OPS 生成"
	}
	renderRequest := cxOfficeRenderRequest{
		Target:   input.Target,
		Template: map[string]string{"pptx": "deck-v1", "docx": "doc-v1"}[input.Target],
		Title:    snapshot.Work.Title,
		Subtitle: subtitle,
		Sections: snapshot.Sections,
		Body:     cxOfficeBodyFromSections(snapshot.Sections),
		Cover:    cover,
		Meta: map[string]any{
			"work_id": snapshot.Work.ID, "revision": snapshot.Work.Revision, "aigc": true,
		},
	}
	payload, err := json.Marshal(renderRequest)
	if err != nil {
		return err
	}
	fileName := cxOfficeFileName(snapshot.Work.Title, snapshot.Work.Revision, input.Target)
	tempDir, err := os.MkdirTemp("", "ops-office-render-*")
	if err != nil {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_render_failed", nil,
			http.StatusInternalServerError, "office_render_failed", "Office 渲染临时目录创建失败")
	}
	defer os.RemoveAll(tempDir)
	outPath := filepath.Join(tempDir, fileName)
	renderCtx, cancel := context.WithTimeout(ctx, cxOfficeRenderTimeout)
	defer cancel()
	cmd := exec.CommandContext(renderCtx, nodePath, filepath.Join(rendererDir, "render.mjs"), "--out", outPath)
	cmd.Dir = rendererDir
	cmd.Stdin = bytes.NewReader(payload)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := "Office 渲染器执行失败，构建已失败"
		if errors.Is(renderCtx.Err(), context.DeadlineExceeded) {
			message = "Office 渲染器执行超时，构建已失败"
		}
		detail := cxOfficeErrorDetail(stderr.String())
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_render_failed", detail,
			http.StatusInternalServerError, "office_render_failed", message)
	}
	info, err := os.Stat(outPath)
	if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > cxBuildArtifactMaxBytes {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_render_failed", nil,
			http.StatusInternalServerError, "office_render_failed", "Office 渲染器没有生成有效产物")
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_render_failed", nil,
			http.StatusInternalServerError, "office_render_failed", "Office 渲染产物无法读取")
	}
	mimeType, _, _, err := cxInspectBuildArtifact(input.Target, fileName, data)
	if err != nil {
		detail := map[string]any{"renderer_stderr": cxOfficeErrorDetail(stderr.String())}
		return s.cxFailOfficeBuild(ctx, workspaceID, buildID, "office_render_failed", detail,
			http.StatusUnprocessableEntity, "office_render_failed", "Office 渲染器输出未通过 AIGC/格式校验")
	}
	response, err := s.cxInsertOfficeArtifact(ctx, workspaceID, buildID, input.Target, fileName, mimeType, data)
	if err != nil {
		return err
	}
	return ok(w, response)
}

// cxOfficeCoverForBuild 读取构建快照绑定的封面主图。封面是可选输入：
// 没有封面时正常导出；有封面但资产缺失/被替换/格式不支持时让构建明确失败，
// 不静默退回无封面产物（否则同一 build 的输出会随文件状态漂移）。
func (s *Server) cxOfficeCoverForBuild(ctx context.Context, workspaceID, workID uuid.UUID, assetID *uuid.UUID) (*cxOfficeCoverImage, error) {
	if assetID == nil || *assetID == uuid.Nil {
		return nil, nil
	}
	var storagePath, mime, sha string
	var width, height int
	err := s.db.QueryRow(ctx, `SELECT storage_path,mime,sha256,width,height FROM asset
		WHERE id=$1 AND workspace_id=$2 AND work_id=$3`, *assetID, workspaceID, workID).
		Scan(&storagePath, &mime, &sha, &width, &height)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiErr(http.StatusConflict, "asset_unavailable", "作品封面素材已不可用，暂不能导出 Office")
	}
	if err != nil {
		return nil, err
	}
	switch mime {
	case "image/png", "image/jpeg", "image/jpg", "image/gif":
	default:
		return nil, apiErr(http.StatusUnprocessableEntity, "cover_image_unsupported", "封面主图仅支持 PNG/JPEG/GIF")
	}
	data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(storagePath)))
	if err != nil {
		return nil, apiErr(http.StatusConflict, "asset_unavailable", "作品封面素材文件不可读，暂不能导出 Office")
	}
	if len(data) > 24<<20 {
		return nil, apiErr(http.StatusUnprocessableEntity, "cover_image_too_large", "封面主图超过 24 MiB，暂不能导出 Office")
	}
	actual := cxSHA256(data)
	if sha != "" && actual != sha {
		return nil, apiErr(http.StatusConflict, "asset_hash_mismatch", "作品封面素材哈希不一致，暂不能导出 Office")
	}
	return &cxOfficeCoverImage{
		DataBase64: base64.StdEncoding.EncodeToString(data),
		MIME:       mime,
		Width:      width,
		Height:     height,
		SHA256:     actual,
	}, nil
}

// cxOfficeRenderer 解析渲染器目录与 node 可执行文件；任一缺失都返回明确错误。
func (s *Server) cxOfficeRenderer() (string, string, error) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return "", "", err
	}
	if configured := strings.TrimSpace(s.cfg.OfficeRenderDir); configured != "" {
		dir, absErr := filepath.Abs(configured)
		if absErr != nil {
			return "", "", absErr
		}
		if _, statErr := os.Stat(filepath.Join(dir, "render.mjs")); statErr != nil {
			return "", "", statErr
		}
		return dir, nodePath, nil
	}
	candidates := []string{
		"tools/office-render",
		"../tools/office-render",
		"../../tools/office-render",
		"../../../tools/office-render",
	}
	for _, candidate := range candidates {
		dir, absErr := filepath.Abs(candidate)
		if absErr != nil {
			continue
		}
		if _, statErr := os.Stat(filepath.Join(dir, "render.mjs")); statErr == nil {
			return dir, nodePath, nil
		}
	}
	return "", "", os.ErrNotExist
}

func (s *Server) cxFailOfficeBuild(ctx context.Context, workspaceID, buildID uuid.UUID, code string, detail any,
	status int, apiCode, message string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err := cxFailBuild(ctx, tx, buildID, code, detail); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return apiErr(status, apiCode, message).With(detail)
}

func cxOfficeErrorDetail(stderr string) string {
	text := strings.TrimSpace(stderr)
	if len([]rune(text)) > 500 {
		text = string([]rune(text)[:500])
	}
	return text
}

var (
	cxOfficeCodeFenceRe = regexp.MustCompile("(?s)```.*?```")
	cxOfficeLinkRe      = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	cxOfficeMarkdownRe  = strings.NewReplacer("#", " ", ">", " ", "*", " ", "_", " ", "`", " ", "~", " ", "-", " ")
)

// cxOfficeBodyFromSections 与客户端固定模板口径一致：只取纯文本、空格连接。
func cxOfficeBodyFromSections(sections []any) string {
	parts := make([]string, 0, len(sections))
	for _, value := range sections {
		section, ok := value.(map[string]any)
		if !ok {
			continue
		}
		heading := strings.TrimSpace(cxString(section["heading"]))
		content := cxString(section["content_md"])
		content = cxOfficeCodeFenceRe.ReplaceAllString(content, " ")
		content = cxOfficeLinkRe.ReplaceAllString(content, "$1")
		content = cxOfficeMarkdownRe.Replace(content)
		content = strings.Join(strings.Fields(content), " ")
		if heading != "" {
			parts = append(parts, heading+"："+content)
		} else if content != "" {
			parts = append(parts, content)
		}
	}
	return strings.Join(parts, " ")
}

// cxOfficeFileName 对应规格 {work-slug}-{revision}.{kind}：保留中文、最长 48 字符。
func cxOfficeFileName(title string, revision int, kind string) string {
	var builder strings.Builder
	lastDash := false
	for _, char := range strings.ToLower(strings.TrimSpace(title)) {
		if unicode.IsLetter(char) || unicode.IsNumber(char) {
			builder.WriteRune(char)
			lastDash = false
		} else if builder.Len() > 0 && !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	slug := strings.Trim(builder.String(), "-")
	runes := []rune(slug)
	if len(runes) > 48 {
		slug = string(runes[:48])
	}
	if slug == "" {
		slug = "work"
	}
	return fmt.Sprintf("%s-%d.%s", slug, revision, kind)
}

// cxInsertOfficeArtifact 在构建运行中把服务端渲染产物写入存储与数据库。
// 同 build 不允许通过重试覆盖旧产物；同名同哈希重试幂等返回。
func (s *Server) cxInsertOfficeArtifact(ctx context.Context, workspaceID, buildID uuid.UUID, kind, name, mimeType string, data []byte) (cxOfficeRenderResponse, error) {
	var response cxOfficeRenderResponse
	hash := cxSHA256(data)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return response, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var status string
	var deadlineAt time.Time
	var targets []string
	if err := tx.QueryRow(ctx, `SELECT status,deadline_at,targets FROM work_build
		WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, buildID, workspaceID).
		Scan(&status, &deadlineAt, &targets); err != nil {
		return response, err
	}
	if status != "running" {
		return response, apiErr(http.StatusConflict, "build_not_running", "构建已结束、已取消或已超时")
	}
	if !deadlineAt.After(s.now()) {
		if err := cxFailBuild(ctx, tx, buildID, "build_timeout", nil); err != nil {
			return response, err
		}
		if err := tx.Commit(ctx); err != nil {
			return response, err
		}
		return response, apiErr(http.StatusConflict, "build_not_running", "构建已超时")
	}
	if !cxBuildArtifactMatchesTarget(kind, targets) {
		if err := cxFailBuild(ctx, tx, buildID, "target_not_allowed", nil); err != nil {
			return response, err
		}
		if err := tx.Commit(ctx); err != nil {
			return response, err
		}
		return response, apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "产物类型不属于本次构建目标，本次构建已失败")
	}
	var existing struct {
		ID    uuid.UUID
		Kind  string
		Hash  string
		Bytes int64
	}
	err = tx.QueryRow(ctx, `SELECT id,kind,sha256,bytes FROM work_build_artifact
		WHERE build_id=$1 AND workspace_id=$2 AND name=$3`, buildID, workspaceID, name).
		Scan(&existing.ID, &existing.Kind, &existing.Hash, &existing.Bytes)
	if err == nil {
		if existing.Kind == kind && existing.Hash == hash && existing.Bytes == int64(len(data)) {
			if err := tx.Commit(ctx); err != nil {
				return response, err
			}
			return cxOfficeRenderResponse{ArtifactID: existing.ID, Name: name, SHA256: hash, Bytes: int64(len(data))}, nil
		}
		if err := cxFailBuild(ctx, tx, buildID, "artifact_conflict", nil); err != nil {
			return response, err
		}
		if err := tx.Commit(ctx); err != nil {
			return response, err
		}
		return response, apiErr(http.StatusConflict, "artifact_conflict", "同名产物已存在但内容不同，本次构建已失败")
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return response, err
	}
	var fileCount int
	var totalBytes int64
	if err := tx.QueryRow(ctx, `SELECT count(*),coalesce(sum(bytes),0) FROM work_build_artifact WHERE build_id=$1`, buildID).
		Scan(&fileCount, &totalBytes); err != nil {
		return response, err
	}
	if fileCount >= cxBuildMaxArtifacts || totalBytes+int64(len(data)) > cxBuildTotalMaxBytes {
		if err := cxFailBuild(ctx, tx, buildID, "build_artifact_limit", nil); err != nil {
			return response, err
		}
		if err := tx.Commit(ctx); err != nil {
			return response, err
		}
		return response, apiErr(http.StatusRequestEntityTooLarge, "build_artifact_limit", "本次构建最多保存 64 个文件、总计 128 MiB；本次构建已失败")
	}
	artifactID := uuid.New()
	rel := cxBuildStoragePath(workspaceID, buildID, artifactID)
	if err := s.cxWriteArtifactFile(rel, data); err != nil {
		return response, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO work_build_artifact(id,workspace_id,build_id,kind,name,storage_path,mime,bytes,sha256,width,height)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, artifactID, workspaceID, buildID, kind, name, rel, mimeType, len(data), hash, nil, nil); err != nil {
		_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel)))
		return response, err
	}
	if err := tx.Commit(ctx); err != nil {
		_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(rel)))
		return response, err
	}
	s.audit(ctx, "work_build_artifact_render", "work_build", buildID.String(), "ok", map[string]any{"artifact_id": artifactID.String(), "kind": kind})
	return cxOfficeRenderResponse{ArtifactID: artifactID, Name: name, SHA256: hash, Bytes: int64(len(data))}, nil
}
