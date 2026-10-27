package app

// DEV-AG07 附件（16 文档第 8 节）：上传、存储、图片处理、文本解析、文件读取、删除与工具装载。
// 文件存于 DataDir/agent/{workspace_id}/{user_id}/{attachment_id}（第 8.2 节第 2 项）；
// 图片另存 .model.jpg（长边 1568、质量 85，用于发送给模型）与 .thumb.jpg（长边 256，用于界面）。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 图片变体的长边上限（第 8.2 节第 2 项）。
const (
	agentModelImageSide = 1568
	agentThumbImageSide = 256
)

// agentAttachmentVariantPath 返回变体文件的相对路径；original 返回 storage_path 本身。
func agentAttachmentVariantPath(storagePath, variant string) string {
	switch variant {
	case "model":
		return storagePath + ".model.jpg"
	case "thumb":
		return storagePath + ".thumb.jpg"
	}
	return storagePath
}

// agentAttachmentAllPaths 返回附件原图与全部变体路径，供删除与清理使用。
func agentAttachmentAllPaths(storagePath string) []string {
	return []string{storagePath,
		agentAttachmentVariantPath(storagePath, "model"),
		agentAttachmentVariantPath(storagePath, "thumb")}
}

func (s *Server) agentReferenceMessageAttachmentsTx(ctx context.Context, tx pgx.Tx, conversationID, messageID uuid.UUID,
	attachmentIDs []uuid.UUID) error {
	for _, attachmentID := range attachmentIDs {
		var referenced, currentRef, inheritedRef bool
		var ownerConversation *uuid.UUID
		err := tx.QueryRow(ctx, `SELECT a.referenced,a.conversation_id,
			EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=a.id AND r.conversation_id=$4),
			EXISTS(SELECT 1 FROM agent_attachment_ref r JOIN agent_message m ON m.id=r.message_id
				WHERE r.attachment_id=a.id AND r.conversation_id=$4 AND m.source_message_id IS NOT NULL)
			FROM agent_attachment a WHERE a.id=$1 AND a.workspace_id=$2 AND a.user_id=$3 FOR UPDATE`,
			attachmentID, ident(ctx).WorkspaceID, ident(ctx).UserID, conversationID).
			Scan(&referenced, &ownerConversation, &currentRef, &inheritedRef)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(422, "agent_attachment_invalid", "附件已失效或已被发送，请重新选择")
		}
		if err != nil {
			return err
		}
		if currentRef {
			if inheritedRef {
				continue
			}
			return apiErr(422, "agent_attachment_invalid", "附件已失效或已被发送，请重新选择")
		}
		if ownerConversation != nil && *ownerConversation != conversationID {
			return apiErr(422, "agent_attachment_invalid", "附件不属于当前对话")
		}
		if referenced && (ownerConversation == nil || *ownerConversation != conversationID) {
			return apiErr(422, "agent_attachment_invalid", "附件不属于当前对话")
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_attachment SET referenced=true,conversation_id=coalesce(conversation_id,$2) WHERE id=$1`,
			attachmentID, conversationID); err != nil {
			return err
		}
	}
	for _, attachmentID := range attachmentIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_attachment_ref(attachment_id,conversation_id,workspace_id,user_id,message_id)
			VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
			attachmentID, conversationID, ident(ctx).WorkspaceID, ident(ctx).UserID, messageID); err != nil {
			return err
		}
	}
	return nil
}

// agentTextAttachmentName 按扩展名判定文本附件（第 8.1 节：.txt、.md）。
func agentTextAttachmentName(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return ext == ".txt" || ext == ".md"
}

// agentCleanAttachmentText 校验 UTF-8 并去除 Unicode 控制字符（保留换行与制表符，D-081）。
func agentCleanAttachmentText(raw []byte) (string, error) {
	text := strings.TrimPrefix(string(raw), "\uFEFF")
	if !utf8.ValidString(text) {
		return "", apiErr(422, "agent_attachment_invalid", "文本附件必须是 UTF-8 编码的 txt 或 md")
	}
	var b strings.Builder
	b.Grow(len(text))
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\t' && r != '\r' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), nil
}

// agentProcessAttachmentImage 校验并重编码图片（存储前去除 EXIF，第 8.1 节）。
// 像素上限沿用 D-102 的解码前检查；JPEG 保持 JPEG，其余格式（PNG/WebP/GIF 首帧）统一转 PNG。
func agentProcessAttachmentImage(raw []byte) ([]byte, string, int, int, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, "", 0, 0, apiErr(422, "agent_attachment_invalid", "无法识别的图片格式，仅支持 JPEG、PNG、WebP、GIF")
	}
	switch format {
	case "jpeg", "png", "webp", "gif":
	default:
		return nil, "", 0, 0, apiErr(422, "agent_attachment_invalid", "无法识别的图片格式，仅支持 JPEG、PNG、WebP、GIF")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxImagePixels {
		return nil, "", 0, 0, apiErr(422, "agent_attachment_invalid", "图片像素数超过 1600 万，请缩小后再上传")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", 0, 0, apiErr(422, "agent_attachment_invalid", "无法识别的图片格式，仅支持 JPEG、PNG、WebP、GIF")
	}
	bounds := img.Bounds()
	var buf bytes.Buffer
	mime := "image/png"
	if format == "jpeg" {
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 92}); err != nil {
			return nil, "", 0, 0, err
		}
		mime = "image/jpeg"
	} else if err := png.Encode(&buf, img); err != nil {
		return nil, "", 0, 0, err
	}
	return buf.Bytes(), mime, bounds.Dx(), bounds.Dy(), nil
}

// agentScaleToSide 等比缩放到长边不超过 maxSide（不放大）。
func agentScaleToSide(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	long := max(b.Dx(), b.Dy())
	if long <= maxSide {
		return img
	}
	return scale(img, float64(maxSide)/float64(long))
}

// agentEncodeJPEGVariant 把图片编码为 JPEG（透明通道压平为白底）。
func agentEncodeJPEGVariant(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, flatten(img), &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// agentWriteAttachmentFile 写入附件文件：先写临时文件再改名，保证读取方看不到半成品。
func (s *Server) agentWriteAttachmentFile(rel string, data []byte) error {
	full := s.agentAttachmentFile(rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".att-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
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

// ---------- 上传（第 8.2 节第 1 项） ----------

func (s *Server) postAgentAttachment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, agentImageBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		return apiErr(422, "agent_attachment_invalid", "请选择要上传的文件（图片不超过 20MB，文本不超过 1MB）")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, agentImageBytes+1))
	if err != nil {
		return err
	}
	name := filepath.Base(strings.TrimSpace(header.Filename))
	if name == "" || name == "." || name == string(filepath.Separator) {
		name = "附件"
	}
	name = truncate(name, 120)

	// 可选 conversation_id：上传不要求先有对话（第 8.2 节第 1 项）。
	var convID *uuid.UUID
	if v := strings.TrimSpace(r.FormValue("conversation_id")); v != "" {
		parsed, err := uuid.Parse(v)
		if err != nil {
			return apiErr(422, "agent_attachment_invalid", "conversation_id 无效")
		}
		if _, err := s.agentConversationFor(ctx, parsed); err != nil {
			return err
		}
		convID = &parsed
	}

	// 判定类型并处理内容。
	var (
		kind        string
		stored      []byte
		mime        string
		width       int
		height      int
		textContent string
	)
	if agentTextAttachmentName(name) {
		if len(raw) > agentTextBytes {
			return apiErr(422, "agent_attachment_invalid", "文本附件超过 1MB")
		}
		cleaned, err := agentCleanAttachmentText(raw)
		if err != nil {
			return err
		}
		// 第 9.5 节、E-28：文本附件疑似包含密钥时拒绝，内容不保存。
		if agentContainsSecret(cleaned, s.agentSecretValues(ctx, id.WorkspaceID)) {
			return apiErr(422, "validation_failed", "消息中疑似包含密钥或密码，请到设置页填写，不要发给智能体")
		}
		kind = "text"
		textContent = cleaned
		stored = []byte(cleaned)
		mime = "text/plain"
		if strings.EqualFold(filepath.Ext(name), ".md") {
			mime = "text/markdown"
		}
	} else {
		if len(raw) > agentImageBytes {
			return apiErr(422, "agent_attachment_invalid", "图片超过 20MB")
		}
		data, m, w, h, err := agentProcessAttachmentImage(raw)
		if err != nil {
			return err
		}
		kind, stored, mime, width, height = "image", data, m, w, h
	}

	// 落盘：原图 + 图片变体（第 8.2 节第 2 项）。
	attID := uuid.New()
	rel := "agent/" + id.WorkspaceID.String() + "/" + id.UserID.String() + "/" + attID.String()
	if err := s.agentWriteAttachmentFile(rel, stored); err != nil {
		return err
	}
	if kind == "image" {
		img, _, err := image.Decode(bytes.NewReader(stored))
		if err != nil {
			s.removeAgentFiles([]string{rel})
			return err
		}
		modelBytes, err := agentEncodeJPEGVariant(agentScaleToSide(img, agentModelImageSide), 85)
		if err == nil {
			err = s.agentWriteAttachmentFile(agentAttachmentVariantPath(rel, "model"), modelBytes)
		}
		if err != nil {
			s.removeAgentFiles([]string{rel})
			return err
		}
		thumbBytes, err := agentEncodeJPEGVariant(agentScaleToSide(img, agentThumbImageSide), 80)
		if err == nil {
			err = s.agentWriteAttachmentFile(agentAttachmentVariantPath(rel, "thumb"), thumbBytes)
		}
		if err != nil {
			s.removeAgentFiles(agentAttachmentAllPaths(rel))
			return err
		}
	}

	// 入库（第 8.2 节第 3 项：文本全文同时存入 text_content）。
	sum := sha256.Sum256(stored)
	var widthArg, heightArg, textArg any
	if kind == "image" {
		widthArg, heightArg = width, height
	} else {
		textArg = textContent
	}
	var createdAt time.Time
	if err := s.db.QueryRow(ctx, `INSERT INTO agent_attachment
		(workspace_id, user_id, conversation_id, kind, name, mime, bytes, width, height, sha256, storage_path, text_content)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, created_at`,
		id.WorkspaceID, id.UserID, convID, kind, name, mime, len(stored),
		widthArg, heightArg, hex.EncodeToString(sum[:]), rel, textArg).Scan(&attID, &createdAt); err != nil {
		s.removeAgentFiles(agentAttachmentAllPaths(rel))
		return err
	}

	view := agentAttachmentView{ID: attID, Kind: kind, Name: name, Mime: mime, Bytes: len(stored),
		URL: "/api/v1/agent/attachments/" + attID.String() + "/file"}
	if convID != nil {
		view.URL += "?conversation_id=" + convID.String()
	}
	if kind == "image" {
		w, h := width, height
		view.Width, view.Height = &w, &h
	}
	return ok(w, view)
}

// ---------- 读取（第 8.2 节第 5 项） ----------

func (s *Server) getAgentAttachmentFile(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	variant := strings.TrimSpace(r.URL.Query().Get("variant"))
	switch variant {
	case "", "original":
		variant = "original"
	case "model", "thumb":
	default:
		return apiErr(422, "validation_failed", "附件规格无效")
	}
	var (
		kind        string
		mime        string
		storagePath string
	)
	requestedConversation := uuid.Nil
	if raw := strings.TrimSpace(r.URL.Query().Get("conversation_id")); raw != "" {
		requestedConversation, err = uuid.Parse(raw)
		if err != nil || requestedConversation == uuid.Nil {
			return errNotFound
		}
	}
	var conversationArg any
	if requestedConversation != uuid.Nil {
		conversationArg = requestedConversation
	}
	// 已发送附件必须经本人当前对话引用访问；未引用上传仍可供本人的输入台预览。
	if err := s.db.QueryRow(ctx, `SELECT kind, mime, storage_path FROM agent_attachment
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3
		AND ((referenced=false AND ($4::uuid IS NULL OR conversation_id IS NULL OR conversation_id=$4))
			OR ($4::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM agent_attachment_ref r
				WHERE r.attachment_id=agent_attachment.id AND r.conversation_id=$4)))`,
		id, ident(ctx).WorkspaceID, ident(ctx).UserID, conversationArg).Scan(&kind, &mime, &storagePath); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if kind != "image" && variant != "original" {
		return errNotFound
	}
	data, err := os.ReadFile(s.agentAttachmentFile(agentAttachmentVariantPath(storagePath, variant)))
	if err != nil {
		return errNotFound
	}
	if variant != "original" {
		mime = "image/jpeg"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(data)
	return nil
}

// ---------- 删除（第 11.1 节：删除未发送的附件） ----------

func (s *Server) deleteAgentAttachment(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		return errNotFound
	}
	var (
		referenced  bool
		storagePath string
	)
	if err := s.db.QueryRow(ctx, `SELECT referenced, storage_path FROM agent_attachment
		WHERE id=$1 AND user_id=$2`, id, ident(ctx).UserID).Scan(&referenced, &storagePath); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if referenced {
		return apiErr(422, "agent_attachment_invalid", "附件已发送，不能删除")
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM agent_attachment WHERE id=$1 AND referenced=false`, id); err != nil {
		return err
	}
	s.removeAgentFiles(agentAttachmentAllPaths(storagePath))
	return ok(w, map[string]any{"ok": true})
}

// ---------- 工具装载（第 8.4 节） ----------

// agentAttachmentUploadFiles 把条目中 multipart 参数的值（附件 ID，第 8.4 节）装载为分发用的文件。
// 附件必须属于本人且属于本对话（conversation_id 为空视为可用的未发送附件）；模型接触不到文件路径。
func (s *Server) agentAttachmentUploadFiles(ctx context.Context, t *AgentTool, args map[string]any,
	convID uuid.UUID) ([]agentUploadFile, error) {
	var out []agentUploadFile
	for _, p := range t.Params {
		if p.In != "multipart" {
			continue
		}
		raw, ok := args[p.Name]
		if !ok || raw == nil {
			continue
		}
		values := []any{raw}
		if arr, isArr := raw.([]any); isArr {
			values = arr
		}
		for _, item := range values {
			text, _ := item.(string)
			attID, err := uuid.Parse(strings.TrimSpace(text))
			if err != nil {
				return nil, apiErr(422, "agent_attachment_invalid", "附件不存在或不属于本对话")
			}
			var (
				kind        string
				name        string
				storagePath string
			)
			if err := s.db.QueryRow(ctx, `SELECT kind, name, storage_path FROM agent_attachment
				WHERE id=$1 AND workspace_id=$2 AND user_id=$3
				AND ((referenced=false AND (conversation_id IS NULL OR conversation_id=$4)) OR EXISTS(
					SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=agent_attachment.id AND r.conversation_id=$4))`,
				attID, ident(ctx).WorkspaceID, ident(ctx).UserID, convID).Scan(&kind, &name, &storagePath); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, apiErr(422, "agent_attachment_invalid", "附件不存在或不属于本对话")
				}
				return nil, err
			}
			if kind != "image" {
				return nil, apiErr(422, "agent_attachment_invalid", "该工具只接受图片附件")
			}
			data, err := os.ReadFile(s.agentAttachmentFile(storagePath))
			if err != nil {
				return nil, apiErr(422, "agent_attachment_invalid", "附件文件不存在")
			}
			field := p.Field
			if field == "" {
				field = p.Name
			}
			out = append(out, agentUploadFile{Field: field, Filename: name, Content: data})
		}
	}
	return out, nil
}
