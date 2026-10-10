package app

import (
	"bytes"
	"context"
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
	URL         string    `json:"url"`
	AIGenerated bool      `json:"ai_generated"`
	CreatedAt   time.Time `json:"created_at"`
}

const (
	maxUploadBytes = 20 << 20
	maxStoredBytes = 1 << 20 // 公众号正文图不超过 1MB（F-007）
	maxDimension   = 2560
)

func (s *Server) loadAssets(ctx context.Context, workID uuid.UUID) ([]Asset, error) {
	rows, err := s.db.Query(ctx, `SELECT id, work_id, mime, width, height, bytes, position, coalesce(ai_generated,false), created_at FROM asset WHERE work_id=$1 ORDER BY position, created_at`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Asset{}
	for rows.Next() {
		var a Asset
		if err := rows.Scan(&a.ID, &a.WorkID, &a.Mime, &a.Width, &a.Height, &a.Bytes, &a.Position, &a.AIGenerated, &a.CreatedAt); err != nil {
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

// processImage converts any supported upload to jpg or png within 1MB (FR-M7-02).
func processImage(raw []byte) ([]byte, string, int, int, error) {
	if isHEIC(raw) {
		return nil, "", 0, 0, validation("暂不支持 HEIC 格式，请先在手机或电脑上转为 JPG 后再上传")
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
	abs := filepath.Join(s.cfg.DataDir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
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
		_ = os.Remove(abs)
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
}

func (s *Server) assetRow(ctx context.Context, id uuid.UUID) (*assetRow, error) {
	var a assetRow
	err := s.db.QueryRow(ctx, `SELECT id, work_id, storage_path, mime, sha256 FROM asset WHERE id=$1 AND workspace_id=$2`, id, ident(ctx).WorkspaceID).
		Scan(&a.ID, &a.WorkID, &a.StoragePath, &a.Mime, &a.SHA256)
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
	data, err := s.assetBytes(a)
	if err != nil {
		return errNotFound
	}
	w.Header().Set("Content-Type", a.Mime)
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
		Position int `json:"position"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
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
		pos := min(max(in.Position, 0), len(ids))
		ids = append(ids[:pos], append([]uuid.UUID{a.ID}, ids[pos:]...)...)
		for i, x := range ids {
			if _, err := tx.Exec(ctx, `UPDATE asset SET position=$2 WHERE id=$1`, x, i); err != nil {
				return err
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
	_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(a.StoragePath)))
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
	abs := filepath.Join(s.cfg.DataDir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO asset (id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(position),-1)+1 FROM asset WHERE work_id=$4))`,
			newID, ident(ctx).WorkspaceID, m.Account.ID, m.ID, filepath.ToSlash(rel), mime, width, height, len(data), secure.SHA256Hex(data)); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		_ = os.Remove(abs)
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
