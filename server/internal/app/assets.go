package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"ops/internal/secure"
)

type Asset struct {
	ID          uuid.UUID `json:"id"`
	WorkID      uuid.UUID `json:"work_id"`
	Mime        string    `json:"mime"`
	Width       int       `json:"width"`
	Height      int       `json:"height"`
	Bytes       int       `json:"bytes"`
	Position    int       `json:"position"`
	AltText     string    `json:"alt_text"`
	URL         string    `json:"url"`
	AIGenerated bool      `json:"ai_generated"`
	CreatedAt   time.Time `json:"created_at"`
}

const (
	maxUploadBytes = 20 << 20
	maxStoredBytes = 1 << 20 // 公众号正文图不超过 1MB（F-007）
	maxDimension   = 2560
	maxImagePixels = 16_000_000
)

func (s *Server) loadAssets(ctx context.Context, workID uuid.UUID) ([]Asset, error) {
	rows, err := s.db.Query(ctx, `SELECT id, work_id, mime, width, height, bytes, position, alt_text, coalesce(ai_generated,false), created_at FROM asset WHERE work_id=$1 ORDER BY position, created_at`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Asset{}
	for rows.Next() {
		var a Asset
		if err := rows.Scan(&a.ID, &a.WorkID, &a.Mime, &a.Width, &a.Height, &a.Bytes, &a.Position, &a.AltText, &a.AIGenerated, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.URL = "/api/v1/assets/" + a.ID.String() + "/file"
		list = append(list, a)
	}
	return list, nil
}

func isHEIC(b []byte) bool {
	if len(b) < 12 || string(b[4:8]) != "ftyp" {
		return false
	}
	brand := string(b[8:12])
	return brand == "heic" || brand == "heix" || brand == "mif1" || brand == "msf1" || brand == "hevc"
}

func hasAlpha(img image.Image) bool {
	switch img.(type) {
	case *image.NRGBA, *image.RGBA, *image.NRGBA64, *image.RGBA64, *image.Paletted:
	default:
		return false
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y += 4 {
		for x := b.Min.X; x < b.Max.X; x += 4 {
			if _, _, _, a := img.At(x, y).RGBA(); a < 0xffff {
				return true
			}
		}
	}
	return false
}

func scale(img image.Image, factor float64) image.Image {
	b := img.Bounds()
	w, h := int(float64(b.Dx())*factor), int(float64(b.Dy())*factor)
	if w < 1 || h < 1 {
		return img
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	return dst
}

func flatten(img image.Image) image.Image {
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, image.White, image.Point{}, draw.Src)
	draw.Draw(dst, b, img, b.Min, draw.Over)
	return dst
}

func thumbnailStoragePath(storagePath string, width int, mime string) string {
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	return fmt.Sprintf("%s.thumb-%d%s", filepath.ToSlash(storagePath), width, ext)
}

func encodeThumbnail(img image.Image, width int, mime string) ([]byte, error) {
	b := img.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 {
		return nil, validation("图片尺寸无效")
	}
	w := min(width, b.Dx())
	h := max(1, int(float64(b.Dy())*float64(w)/float64(b.Dx())+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	var out bytes.Buffer
	if mime == "image/png" {
		if err := png.Encode(&out, dst); err != nil {
			return nil, err
		}
	} else if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 78}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func removeAssetFiles(dataDir, storagePath string) {
	base := filepath.Join(dataDir, filepath.FromSlash(storagePath))
	_ = os.Remove(base)
	for _, width := range []int{256, 512} {
		for _, ext := range []string{".jpg", ".png"} {
			_ = os.Remove(base + fmt.Sprintf(".thumb-%d%s", width, ext))
		}
	}
}

func (s *Server) writeAssetFiles(storagePath string, data []byte, mime string) error {
	path := filepath.Join(s.cfg.DataDir, filepath.FromSlash(storagePath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		removeAssetFiles(s.cfg.DataDir, storagePath)
		return err
	}
	for _, width := range []int{256, 512} {
		thumb, err := encodeThumbnail(img, width, mime)
		if err != nil {
			removeAssetFiles(s.cfg.DataDir, storagePath)
			return err
		}
		thumbPath := filepath.Join(s.cfg.DataDir, filepath.FromSlash(thumbnailStoragePath(storagePath, width, mime)))
		if err := os.WriteFile(thumbPath, thumb, 0o644); err != nil {
			removeAssetFiles(s.cfg.DataDir, storagePath)
			return err
		}
	}
	return nil
}

func (s *Server) assetThumbnail(a *assetRow, width int) ([]byte, error) {
	thumbPath := filepath.Join(s.cfg.DataDir, filepath.FromSlash(thumbnailStoragePath(a.StoragePath, width, a.Mime)))
	data, err := os.ReadFile(thumbPath)
	if err == nil {
		return data, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	original, err := s.assetBytes(a)
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(original))
	if err != nil {
		return nil, err
	}
	data, err = encodeThumbnail(img, width, a.Mime)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(thumbPath), 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(thumbPath), ".thumb-*")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	if err := os.Rename(tmpPath, thumbPath); err != nil {
		if _, statErr := os.Stat(thumbPath); statErr != nil {
			return nil, err
		}
	}
	return data, nil
}

// processImage converts any supported upload to jpg or png within 1MB (FR-M7-02).
func processImage(raw []byte) ([]byte, string, int, int, error) {
	if isHEIC(raw) {
		return nil, "", 0, 0, validation("暂不支持 HEIC 格式，请先在手机或电脑上转为 JPG 后再上传")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, "", 0, 0, validation("无法识别的图片格式，请上传 JPG、PNG、WebP 或 GIF")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		return nil, "", 0, 0, validation("图片像素数超过 1600 万，请缩小后再上传")
	}
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, "", 0, 0, validation("无法识别的图片格式，请上传 JPG、PNG、WebP 或 GIF")
	}
	b := img.Bounds()
	if max(b.Dx(), b.Dy()) > maxDimension {
		img = scale(img, float64(maxDimension)/float64(max(b.Dx(), b.Dy())))
	}
	if (format == "png" || format == "gif") && hasAlpha(img) {
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err == nil && buf.Len() <= maxStoredBytes {
			return buf.Bytes(), "image/png", img.Bounds().Dx(), img.Bounds().Dy(), nil
		}
	}
	if format == "jpeg" && len(raw) <= maxStoredBytes && img.Bounds() == b {
		return raw, "image/jpeg", b.Dx(), b.Dy(), nil
	}
	img = flatten(img)
	for attempt := 0; attempt < 12; attempt++ {
		// 先降质量再缩尺寸，尽量保住 1242×1656 等固定规格（EX-F-03）。
		for _, q := range []int{88, 78, 68, 58} {
			var buf bytes.Buffer
			if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
				return nil, "", 0, 0, err
			}
			if buf.Len() <= maxStoredBytes {
				return buf.Bytes(), "image/jpeg", img.Bounds().Dx(), img.Bounds().Dy(), nil
			}
		}
		img = scale(img, 0.8)
	}
	return nil, "", 0, 0, validation("图片压缩到 1MB 以内失败，请换一张图片")
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+1<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		return validation("请选择图片文件（单张不超过 20MB）")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxUploadBytes {
		return validation("图片超过 20MB")
	}
	data, mime, width, height, err := processImage(raw)
	if err != nil {
		return err
	}
	ctx := r.Context()
	id := uuid.New()
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	rel := filepath.Join("assets", m.ID.String(), id.String()+ext)
	if err := s.writeAssetFiles(filepath.ToSlash(rel), data, mime); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO asset (id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(position),-1)+1 FROM asset WHERE work_id=$4))`,
			id, ident(ctx).WorkspaceID, m.Account.ID, m.ID, filepath.ToSlash(rel), mime, width, height, len(data), secure.SHA256Hex(data)); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		removeAssetFiles(s.cfg.DataDir, filepath.ToSlash(rel))
		return err
	}
	list, err := s.loadAssets(ctx, m.ID)
	if err != nil {
		return err
	}
	for _, a := range list {
		if a.ID == id {
			return ok(w, a)
		}
	}
	return errNotFound
}

type assetRow struct {
	ID          uuid.UUID
	WorkID      uuid.NullUUID
	StoragePath string
	Mime        string
	SHA256      string
	AltText     string
}

func (s *Server) assetRow(ctx context.Context, id uuid.UUID) (*assetRow, error) {
	var a assetRow
	err := s.db.QueryRow(ctx, `SELECT id, work_id, storage_path, mime, sha256, alt_text FROM asset WHERE id=$1 AND workspace_id=$2`, id, ident(ctx).WorkspaceID).
		Scan(&a.ID, &a.WorkID, &a.StoragePath, &a.Mime, &a.SHA256, &a.AltText)
	return &a, err
}

func (s *Server) requireWorkAsset(a *assetRow) (uuid.UUID, error) {
	if a == nil || !a.WorkID.Valid {
		return uuid.Nil, validation("该图片不属于作品")
	}
	return a.WorkID.UUID, nil
}

func (s *Server) assetBytes(a *assetRow) ([]byte, error) {
	return os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(a.StoragePath)))
}

func (s *Server) assetFile(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	a, err := s.assetRow(r.Context(), id)
	if err != nil {
		return err
	}
	var data []byte
	mime := a.Mime
	switch r.URL.Query().Get("variant") {
	case "", "original":
		data, err = s.assetBytes(a)
	case "256":
		data, err = s.assetThumbnail(a, 256)
	case "512":
		data, err = s.assetThumbnail(a, 512)
	default:
		return validation("图片缩略图规格无效")
	}
	if err != nil {
		return errNotFound
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(data)
	return nil
}

func (s *Server) updateAsset(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	a, err := s.assetRow(ctx, id)
	if err != nil {
		return err
	}
	workID, err := s.requireWorkAsset(a)
	if err != nil {
		return err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Position *int    `json:"position"`
		AltText  *string `json:"alt_text"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Position == nil && in.AltText == nil {
		return validation("请提供图片顺序或替代文字")
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if in.AltText != nil {
			if _, err := tx.Exec(ctx, `UPDATE asset SET alt_text=$2 WHERE id=$1`, a.ID, strings.TrimSpace(*in.AltText)); err != nil {
				return err
			}
		}
		if in.Position != nil {
			rows, err := tx.Query(ctx, `SELECT id FROM asset WHERE work_id=$1 AND id<>$2 ORDER BY position, created_at`, workID, a.ID)
			if err != nil {
				return err
			}
			var ids []uuid.UUID
			for rows.Next() {
				var x uuid.UUID
				_ = rows.Scan(&x)
				ids = append(ids, x)
			}
			rows.Close()
			pos := min(max(*in.Position, 0), len(ids))
			ids = append(ids[:pos], append([]uuid.UUID{a.ID}, ids[pos:]...)...)
			for i, x := range ids {
				if _, err := tx.Exec(ctx, `UPDATE asset SET position=$2 WHERE id=$1`, x, i); err != nil {
					return err
				}
			}
		}
		return s.touchContent(ctx, tx, workID)
	})
	if err != nil {
		return err
	}
	list, err := s.loadAssets(ctx, workID)
	if err != nil {
		return err
	}
	return ok(w, list)
}

func (s *Server) suggestAssetAlt(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	a, err := s.assetRow(ctx, id)
	if err != nil {
		return err
	}
	workID, err := s.requireWorkAsset(a)
	if err != nil {
		return err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	data, err := s.assetBytes(a)
	if err != nil {
		return validation("读取原图失败")
	}
	result, err := s.runAI(ctx, aiTask{
		Type: "image_alt", Account: m.Account, WorkID: &workID, Bare: true, SkipStyle: true,
		User:   "请用中文写一句简洁、客观的图片替代文字，描述可见主体和必要情境。不要以“图片”开头，不推测图中不可见的信息，只输出替代文字。",
		Images: []string{"data:" + a.Mime + ";base64," + base64.StdEncoding.EncodeToString(data)},
	}, nil)
	if err != nil {
		return err
	}
	suggestion := strings.Trim(strings.TrimSpace(result.Text), "\"'“”‘’")
	if suggestion == "" {
		return apiErr(http.StatusBadGateway, "ai_empty_response", "图片替代文字建议为空，请重试")
	}
	return ok(w, map[string]string{"suggestion": suggestion})
}

func (s *Server) deleteAsset(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	a, err := s.assetRow(ctx, id)
	if err != nil {
		return err
	}
	workID, err := s.requireWorkAsset(a)
	if err != nil {
		return err
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE work SET cover_asset_id=NULL, cover_crops=NULL WHERE id=$1 AND cover_asset_id=$2`, workID, a.ID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM asset WHERE id=$1`, a.ID); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, workID)
	})
	if err != nil {
		return err
	}
	removeAssetFiles(s.cfg.DataDir, a.StoragePath)
	return ok(w, map[string]any{"ok": true})
}

func assetIDFromURL(u string) (uuid.UUID, bool) {
	var id string
	if _, err := fmt.Sscanf(u, "/api/v1/assets/%36s", &id); err != nil {
		return uuid.Nil, false
	}
	parsed, err := uuid.Parse(id)
	return parsed, err == nil
}

// cropAsset saves a cropped region as a new image (FR-M7-04). Relative coords are 0–1.
func (s *Server) cropAsset(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	src, err := s.assetRow(ctx, id)
	if err != nil {
		return err
	}
	if _, err := s.requireWorkAsset(src); err != nil {
		return err
	}
	m, err := s.workMeta(ctx, src.WorkID.UUID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		X1     float64 `json:"x1"`
		Y1     float64 `json:"y1"`
		X2     float64 `json:"x2"`
		Y2     float64 `json:"y2"`
		Aspect string  `json:"aspect"` // e.g. "3:4"
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.X2 <= in.X1 || in.Y2 <= in.Y1 || in.X1 < 0 || in.Y1 < 0 || in.X2 > 1 || in.Y2 > 1 {
		return validation("裁剪区域无效")
	}
	raw, err := s.assetBytes(src)
	if err != nil {
		return validation("读取原图失败")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return validation("无法解码原图")
	}
	b := img.Bounds()
	x0 := b.Min.X + int(float64(b.Dx())*in.X1)
	y0 := b.Min.Y + int(float64(b.Dy())*in.Y1)
	x1 := b.Min.X + int(float64(b.Dx())*in.X2)
	y1 := b.Min.Y + int(float64(b.Dy())*in.Y2)
	if x1-x0 < 8 || y1-y0 < 8 {
		return validation("裁剪区域太小")
	}
	cropped := image.NewRGBA(image.Rect(0, 0, x1-x0, y1-y0))
	draw.Draw(cropped, cropped.Bounds(), img, image.Pt(x0, y0), draw.Src)
	data, mime, width, height, err := processImage(mustEncodePNG(cropped))
	if err != nil {
		return err
	}
	newID := uuid.New()
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	rel := filepath.Join("assets", m.ID.String(), newID.String()+ext)
	if err := s.writeAssetFiles(filepath.ToSlash(rel), data, mime); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO asset (id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position, alt_text)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(position),-1)+1 FROM asset WHERE work_id=$4),$11)`,
			newID, ident(ctx).WorkspaceID, m.Account.ID, m.ID, filepath.ToSlash(rel), mime, width, height, len(data), secure.SHA256Hex(data), src.AltText); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		removeAssetFiles(s.cfg.DataDir, filepath.ToSlash(rel))
		return err
	}
	list, err := s.loadAssets(ctx, m.ID)
	if err != nil {
		return err
	}
	for _, a := range list {
		if a.ID == newID {
			return ok(w, a)
		}
	}
	return errNotFound
}

func mustEncodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
