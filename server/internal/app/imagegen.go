package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"

	"ops/internal/ai"
	"ops/internal/secure"
)

type Bubble struct {
	Text string  `json:"text"`
	X    float64 `json:"x"` // 0–1 relative
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
}

// applyAIWatermark draws a visible "AI 生成" mark (FR-M7-06).
func applyAIWatermark(img image.Image) image.Image {
	b := img.Bounds()
	dst := image.NewRGBA(b)
	draw.Draw(dst, b, img, b.Min, draw.Src)
	label := "AI 生成"
	pad := 8
	// Approximate width using basicfont (7px per glyph for ASCII; CJK may be wider — keep padding generous).
	boxW := len([]rune(label))*12 + pad*2
	boxH := 22
	x0 := b.Max.X - boxW - 10
	y0 := b.Max.Y - boxH - 10
	if x0 < b.Min.X {
		x0 = b.Min.X + 4
	}
	if y0 < b.Min.Y {
		y0 = b.Min.Y + 4
	}
	bg := image.NewUniform(color.NRGBA{0, 0, 0, 140})
	draw.Draw(dst, image.Rect(x0, y0, x0+boxW, y0+boxH), bg, image.Point{}, draw.Over)
	d := &font.Drawer{
		Dst:  dst,
		Src:  image.NewUniform(color.NRGBA{255, 255, 255, 230}),
		Face: basicfont.Face7x13,
		Dot:  fixed.P(x0+pad, y0+boxH-6),
	}
	d.DrawString(label)
	return dst
}

func (s *Server) storeProcessedAsset(ctx context.Context, workID, accountID uuid.UUID, data []byte, mime string, width, height int, aiGen bool) (Asset, error) {
	id := uuid.New()
	ext := ".jpg"
	if mime == "image/png" {
		ext = ".png"
	}
	rel := filepath.Join("assets", workID.String(), id.String()+ext)
	if err := s.writeAssetFiles(filepath.ToSlash(rel), data, mime); err != nil {
		return Asset{}, err
	}
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO asset (id, workspace_id, account_id, work_id, storage_path, mime, width, height, bytes, sha256, position, ai_generated)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT coalesce(max(position),-1)+1 FROM asset WHERE work_id=$4),$11)`,
			id, ident(ctx).WorkspaceID, accountID, workID, filepath.ToSlash(rel), mime, width, height, len(data), secure.SHA256Hex(data), aiGen); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, workID)
	})
	if err != nil {
		removeAssetFiles(s.cfg.DataDir, filepath.ToSlash(rel))
		return Asset{}, err
	}
	return Asset{
		ID: id, WorkID: workID, Mime: mime, Width: width, Height: height, Bytes: len(data),
		URL: "/api/v1/assets/" + id.String() + "/file", AIGenerated: aiGen, CreatedAt: time.Now(),
	}, nil
}

func (s *Server) runImageGen(ctx context.Context, account *Account, workID *uuid.UUID, prompt, size string) (Asset, error) {
	if err := s.checkLimit(ctx); err != nil {
		return Asset{}, err
	}
	rt, err := s.resolveRoute(ctx, "image_gen")
	if err != nil {
		return Asset{}, err
	}
	start := time.Now()
	imgRes, callErr := ai.GenerateImage(ctx, s.aiHTTP, ai.ImageRequest{
		BaseURL: rt.BaseURL, APIKey: rt.APIKey, Model: rt.Model, Prompt: prompt, Size: size,
	})
	status, errText := "ok", ""
	if callErr != nil {
		status, errText = "failed", callErr.Error()
	}
	refsJSON, _ := json.Marshal(map[string]any{"prompt_chars": len([]rune(prompt))})
	var accountID *uuid.UUID
	if account != nil {
		accountID = &account.ID
	}
	var callID uuid.UUID
	_ = s.db.QueryRow(context.WithoutCancel(ctx), `INSERT INTO ai_call (workspace_id, account_id, work_id, task_type, provider, model, context_refs,
		prompt_tokens, completion_tokens, latency_ms, status, error) VALUES ($1,$2,$3,'image_gen',$4,$5,$6,0,0,$7,$8,$9) RETURNING id`,
		ident(ctx).WorkspaceID, accountID, workID, rt.ProviderName, rt.Model, refsJSON, time.Since(start).Milliseconds(), status, truncate(errText, 500)).Scan(&callID)
	if callErr != nil {
		return Asset{}, apiErr(502, "ai_upstream_error", "文生图失败："+truncate(callErr.Error(), 300))
	}
	decoded, _, err := image.Decode(bytes.NewReader(imgRes.Bytes))
	if err != nil {
		return Asset{}, apiErr(502, "ai_output_invalid", "文生图返回的不是有效图片")
	}
	marked := applyAIWatermark(decoded)
	var buf bytes.Buffer
	if err := png.Encode(&buf, marked); err != nil {
		return Asset{}, err
	}
	data, mime, w, h, err := processImage(buf.Bytes())
	if err != nil {
		return Asset{}, err
	}
	if workID == nil {
		return Asset{}, validation("缺少作品")
	}
	a, err := s.storeProcessedAsset(ctx, *workID, account.ID, data, mime, w, h, true)
	if err != nil {
		return Asset{}, err
	}
	_ = callID
	return a, nil
}

// generateWorkImage creates an AI image for a work from a prompt (FR-M7-05) and applies AI mark (FR-M7-06).
func (s *Server) generateWorkImage(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Prompt     string `json:"prompt"`
		Size       string `json:"size"`
		Background bool   `json:"background"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return validation("请填写绘图提示词")
	}
	if !strings.Contains(prompt, "AI") && !strings.Contains(strings.ToLower(prompt), "ai") {
		prompt = prompt + "。画面风格清晰，适合内容配图。"
	}
	if in.Background {
		jobID, err := s.startBackgroundJob(r.Context(), jobSpec{TaskType: "image_gen", Label: "AI 出图" + titleOr(m.Title), Link: "/works/" + m.ID.String(),
			AccountID: &m.Account.ID, WorkID: &m.ID}, func(jctx context.Context) (any, error) {
			asset, err := s.runImageGen(jctx, m.Account, &m.ID, prompt, in.Size)
			if err != nil {
				return nil, err
			}
			s.audit(jctx, "image_gen", "asset", asset.ID.String(), "ok", map[string]any{"work_id": m.ID.String()})
			return asset, nil
		})
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"job_id": jobID})
	}
	asset, err := s.runImageGen(r.Context(), m.Account, &m.ID, prompt, in.Size)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "image_gen", "asset", asset.ID.String(), "ok", map[string]any{"work_id": m.ID.String()})
	return ok(w, asset)
}

// generatePanelImage uses panel prompt + character cards for consistency (FR-M8-05).
func (s *Server) generatePanelImage(w http.ResponseWriter, r *http.Request) error {
	panelID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var workID uuid.UUID
	var prompt, scene, action, shot string
	var charIDs []uuid.UUID
	err = s.db.QueryRow(ctx, `SELECT work_id, image_prompt, scene, action, shot, character_ids FROM comic_panel WHERE id=$1`, panelID).
		Scan(&workID, &prompt, &scene, &action, &shot, &charIDs)
	if err != nil {
		return errNotFound
	}
	m, err := s.workMeta(ctx, workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Prompt string `json:"prompt"`
		Size   string `json:"size"`
	}
	_ = decode(r, &in)
	if strings.TrimSpace(in.Prompt) != "" {
		prompt = strings.TrimSpace(in.Prompt)
	}
	if prompt == "" {
		prompt = fmt.Sprintf("漫画分格：场景 %s；动作 %s；镜头 %s", scene, action, shot)
	}
	var appearances []string
	if len(charIDs) > 0 {
		rows, err := s.db.Query(ctx, `SELECT name, appearance, ref_asset_id FROM character_card WHERE id = ANY($1) AND account_id=$2`, charIDs, m.Account.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var name, app string
			var ref uuid.NullUUID
			if err := rows.Scan(&name, &app, &ref); err == nil {
				line := name + "：" + app
				if ref.Valid {
					line += "（创作者已提供参考图，外貌必须与参考图及上述描述一致）"
				}
				appearances = append(appearances, line)
			}
		}
		rows.Close()
	}
	full := prompt
	if len(appearances) > 0 {
		full = "角色一致性要求（必须保持外貌一致）：\n- " + strings.Join(appearances, "\n- ") + "\n\n画面：" + prompt
	}
	full += "。漫画分镜风格，干净线稿，角色外貌跨图一致。"
	asset, err := s.runImageGen(ctx, m.Account, &m.ID, full, in.Size)
	if err != nil {
		return err
	}
	var narr, dial string
	_ = s.db.QueryRow(ctx, `SELECT narration, dialogue FROM comic_panel WHERE id=$1`, panelID).Scan(&narr, &dial)
	bs := layoutBubbles(narr, dial)
	bj, _ := json.Marshal(bs)
	if _, err := s.db.Exec(ctx, `UPDATE comic_panel SET asset_id=$2, bubbles=$3, updated_at=now() WHERE id=$1`, panelID, asset.ID, bj); err != nil {
		return err
	}
	s.audit(ctx, "panel_image_gen", "comic_panel", panelID.String(), "ok", map[string]any{"asset_id": asset.ID.String()})
	return ok(w, map[string]any{"asset": asset, "bubbles": bs})
}

func layoutBubbles(narration, dialogue string) []Bubble {
	var out []Bubble
	if t := strings.TrimSpace(narration); t != "" {
		out = append(out, Bubble{Text: t, X: 0.05, Y: 0.05, W: 0.9, H: 0.18})
	}
	if t := strings.TrimSpace(dialogue); t != "" {
		out = append(out, Bubble{Text: t, X: 0.1, Y: 0.65, W: 0.8, H: 0.28})
	}
	return out
}

func (s *Server) putPanelBubbles(w http.ResponseWriter, r *http.Request) error {
	panelID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var workID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT work_id FROM comic_panel WHERE id=$1`, panelID).Scan(&workID); err != nil {
		return errNotFound
	}
	m, err := s.workMeta(r.Context(), workID)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Bubbles []Bubble `json:"bubbles"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Bubbles == nil {
		in.Bubbles = []Bubble{}
	}
	b, _ := json.Marshal(in.Bubbles)
	if _, err := s.db.Exec(r.Context(), `UPDATE comic_panel SET bubbles=$2, updated_at=now() WHERE id=$1`, panelID, b); err != nil {
		return err
	}
	return ok(w, map[string]any{"bubbles": in.Bubbles})
}
