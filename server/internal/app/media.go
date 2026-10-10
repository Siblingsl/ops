package app

import (
	"bytes"
	"image"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	xdraw "golang.org/x/image/draw"

	"ops/internal/secure"
)

// ---------- EX-G-03 封面智能裁剪：边缘能量 + 肤色 + 饱和度的注意力图，滑窗取最大 ----------

type CropBox struct {
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
	X2 float64 `json:"x2"`
	Y2 float64 `json:"y2"`
}

func parseAspect(s string) (float64, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, false
	}
	a, err1 := strconv.ParseFloat(parts[0], 64)
	b, err2 := strconv.ParseFloat(parts[1], 64)
	if err1 != nil || err2 != nil || a <= 0 || b <= 0 {
		return 0, false
	}
	return a / b, true
}

func isSkin(r, g, b float64) bool {
	// Kovac et al. RGB skin rule, on 0–255 values.
	return r > 95 && g > 40 && b > 20 && r > g && r > b && math.Max(r, math.Max(g, b))-math.Min(r, math.Min(g, b)) > 15 && math.Abs(r-g) > 15
}

// attentionMap returns per-pixel interest scores of a downscaled copy (max side 160).
func attentionMap(img image.Image) ([][]float64, int, int) {
	b := img.Bounds()
	scale := 160.0 / math.Max(float64(b.Dx()), float64(b.Dy()))
	if scale > 1 {
		scale = 1
	}
	w, h := max(1, int(float64(b.Dx())*scale)), max(1, int(float64(b.Dy())*scale))
	small := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.ApproxBiLinear.Scale(small, small.Bounds(), img, b, xdraw.Src, nil)
	lum := make([][]float64, h)
	score := make([][]float64, h)
	for y := 0; y < h; y++ {
		lum[y] = make([]float64, w)
		score[y] = make([]float64, w)
		for x := 0; x < w; x++ {
			c := small.RGBAAt(x, y)
			r, g, bb := float64(c.R), float64(c.G), float64(c.B)
			lum[y][x] = 0.299*r + 0.587*g + 0.114*bb
			mx, mn := math.Max(r, math.Max(g, bb)), math.Min(r, math.Min(g, bb))
			sat := 0.0
			if mx > 0 {
				sat = (mx - mn) / mx
			}
			score[y][x] = sat * 0.3
			if isSkin(r, g, bb) {
				score[y][x] += 2.0
			}
		}
	}
	for y := 1; y < h-1; y++ {
		for x := 1; x < w-1; x++ {
			gx := lum[y][x+1] - lum[y][x-1]
			gy := lum[y+1][x] - lum[y-1][x]
			score[y][x] += math.Sqrt(gx*gx+gy*gy) / 255
		}
	}
	return score, w, h
}

// smartCropBox finds the window of the given aspect (as large as possible) with the highest attention.
func smartCropBox(img image.Image, aspect float64) CropBox {
	score, w, h := attentionMap(img)
	integral := make([][]float64, h+1)
	for y := range integral {
		integral[y] = make([]float64, w+1)
	}
	for y := 1; y <= h; y++ {
		for x := 1; x <= w; x++ {
			integral[y][x] = score[y-1][x-1] + integral[y-1][x] + integral[y][x-1] - integral[y-1][x-1]
		}
	}
	sum := func(x0, y0, x1, y1 int) float64 {
		return integral[y1][x1] - integral[y0][x1] - integral[y1][x0] + integral[y0][x0]
	}
	cw, ch := w, int(math.Round(float64(w)/aspect))
	if ch > h {
		ch = h
		cw = int(math.Round(float64(h) * aspect))
	}
	cw, ch = max(1, min(cw, w)), max(1, min(ch, h))
	best, bx, by := -1.0, 0, 0
	for y := 0; y+ch <= h; y++ {
		for x := 0; x+cw <= w; x++ {
			v := sum(x, y, x+cw, y+ch)
			// Mild centre bias so flat images still crop to the middle.
			cx, cy := float64(x)+float64(cw)/2-float64(w)/2, float64(y)+float64(ch)/2-float64(h)/2
			v -= (math.Abs(cx) + math.Abs(cy)) * 0.001
			if v > best {
				best, bx, by = v, x, y
			}
		}
	}
	return CropBox{X1: float64(bx) / float64(w), Y1: float64(by) / float64(h), X2: float64(bx+cw) / float64(w), Y2: float64(by+ch) / float64(h)}
}

func (s *Server) smartCrop(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	a, err := s.assetRow(r.Context(), id)
	if err != nil {
		return err
	}
	raw, err := s.assetBytes(a)
	if err != nil {
		return validation("读取原图失败")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return validation("无法解码原图")
	}
	aspects := r.URL.Query().Get("aspects")
	if aspects == "" {
		aspects = "2.35:1,1:1"
	}
	out := map[string]CropBox{}
	for _, as := range strings.Split(aspects, ",") {
		if ratio, ok := parseAspect(as); ok && len(out) < 4 {
			out[strings.TrimSpace(as)] = smartCropBox(img, ratio)
		}
	}
	return ok(w, map[string]any{"crops": out})
}

// ---------- EX-G-04 图片库 ----------

type LibraryAsset struct {
	Asset
	AccountID   *uuid.UUID `json:"account_id"`
	AccountName string     `json:"account_name"`
	WorkTitle   string     `json:"work_title"`
}

func (s *Server) listLibrary(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	q := r.URL.Query()
	sql := `SELECT x.id, x.work_id, x.mime, x.width, x.height, x.bytes, x.position, coalesce(x.ai_generated,false), x.created_at,
		x.account_id, coalesce(a.name,''), coalesce(w.title,'')
		FROM asset x LEFT JOIN work w ON w.id=x.work_id LEFT JOIN platform_account a ON a.id=x.account_id
		WHERE x.workspace_id=$1 AND x.work_id IS NOT NULL AND (w.deleted_at IS NULL) AND x.origin_asset_id IS NULL`
	args := []any{ident(ctx).WorkspaceID}
	if v, err := uuid.Parse(q.Get("account_id")); err == nil {
		args = append(args, v)
		sql += ` AND x.account_id=$` + strconv.Itoa(len(args))
	}
	if v, err := uuid.Parse(q.Get("work_id")); err == nil {
		args = append(args, v)
		sql += ` AND x.work_id=$` + strconv.Itoa(len(args))
	}
	switch q.Get("ai") {
	case "1":
		sql += ` AND coalesce(x.ai_generated,false)`
	case "0":
		sql += ` AND NOT coalesce(x.ai_generated,false)`
	}
	rows, err := s.db.Query(ctx, sql+` ORDER BY x.created_at DESC LIMIT 300`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []LibraryAsset{}
	for rows.Next() {
		var x LibraryAsset
		if err := rows.Scan(&x.ID, &x.WorkID, &x.Mime, &x.Width, &x.Height, &x.Bytes, &x.Position, &x.AIGenerated, &x.CreatedAt,
			&x.AccountID, &x.AccountName, &x.WorkTitle); err != nil {
			return err
		}
		x.URL = "/api/v1/assets/" + x.ID.String() + "/file"
		list = append(list, x)
	}
	return ok(w, list)
}

// reuseAsset copies a library image into another work; the copy keeps origin_asset_id for traceability.
func (s *Server) reuseAsset(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		AssetID uuid.UUID `json:"asset_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	src, err := s.assetRow(ctx, in.AssetID)
	if err != nil {
		return err
	}
	data, err := s.assetBytes(src)
	if err != nil {
		return validation("原图文件不存在")
	}
	var width, height int
	var aiGen bool
	if err := s.db.QueryRow(ctx, `SELECT width, height, coalesce(ai_generated,false) FROM asset WHERE id=$1`, src.ID).Scan(&width, &height, &aiGen); err != nil {
		return err
	}
	newID := uuid.New()
	ext := filepath.Ext(src.StoragePath)
	rel := filepath.Join("assets", m.ID.String(), newID.String()+ext)
	abs := filepath.Join(s.cfg.DataDir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO asset (id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position, ai_generated, origin_asset_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(position),-1)+1 FROM asset WHERE work_id=$4),$11,$12)`,
			newID, ident(ctx).WorkspaceID, m.Account.ID, m.ID, filepath.ToSlash(rel), src.Mime, width, height, len(data), secure.SHA256Hex(data), aiGen, src.ID); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		_ = os.Remove(abs)
		return err
	}
	return ok(w, Asset{ID: newID, WorkID: m.ID, Mime: src.Mime, Width: width, Height: height, Bytes: len(data),
		URL: "/api/v1/assets/" + newID.String() + "/file", AIGenerated: aiGen, CreatedAt: time.Now()})
}
