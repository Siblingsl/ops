package app

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Server) duplicateWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.Status != "active" {
		return stateInvalid("账号已停用，不能复制作品")
	}
	ctx := r.Context()
	src, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	profile, err := s.loadProfile(ctx, m.Account.ID)
	if err != nil {
		return err
	}
	newID := uuid.New()
	assets := map[uuid.UUID]uuid.UUID{}
	paths := map[uuid.UUID]string{}
	committed := false
	defer func() {
		if !committed {
			for _, path := range paths {
				_ = os.Remove(filepath.Join(s.cfg.DataDir, filepath.FromSlash(path)))
			}
			_ = os.Remove(filepath.Join(s.cfg.DataDir, "assets", newID.String()))
		}
	}()
	for _, a := range src.Assets {
		row, err := s.assetRow(ctx, a.ID)
		if err != nil {
			return err
		}
		data, err := s.assetBytes(row)
		if err != nil {
			return validation("原图文件不存在，无法复制作品")
		}
		id := uuid.New()
		rel := filepath.Join("assets", newID.String(), id.String()+filepath.Ext(row.StoragePath))
		abs := filepath.Join(s.cfg.DataDir, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return err
		}
		paths[a.ID] = filepath.ToSlash(rel)
		if err := os.WriteFile(abs, data, 0o644); err != nil {
			return err
		}
		assets[a.ID] = id
	}
	replacements := []string{}
	for old, id := range assets {
		replacements = append(replacements, "/assets/"+old.String()+"/file", "/assets/"+id.String()+"/file")
	}
	images := strings.NewReplacer(replacements...)
	sections := map[uuid.UUID]uuid.UUID{}
	for _, sec := range src.Sections {
		sections[sec.ID] = uuid.New()
	}
	for i := range src.Outline {
		old, _ := uuid.Parse(src.Outline[i].SectionID)
		if id, exists := sections[old]; exists {
			src.Outline[i].SectionID = id.String()
		}
	}
	outline, _ := json.Marshal(src.Outline)
	wf, _ := json.Marshal(profile.WechatDefaults)
	var cover *uuid.UUID
	if src.CoverAssetID != nil {
		if id, exists := assets[*src.CoverAssetID]; exists {
			cover = &id
		}
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, src.ID)
		if err != nil {
			return err
		}
		for rows.Next() {
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		var revision int
		if err := tx.QueryRow(ctx, `SELECT revision FROM work WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, src.ID).Scan(&revision); err != nil {
			return err
		}
		if revision != src.Revision {
			return apiErr(409, "version_conflict", "原作品在复制期间被修改，请重试")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO work(id,account_id,content_format,title,viewpoint,outline,theme,cover_asset_id,cover_crops,wechat_fields,review_required,reviewer_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, newID, src.AccountID, src.ContentFormat,
			truncateRunes(src.Title, 60)+"（副本）", src.Viewpoint, outline, src.Theme, cover, src.CoverCrops, wf, src.ReviewRequired, src.ReviewerID); err != nil {
			return err
		}
		for old, id := range assets {
			if _, err := tx.Exec(ctx, `INSERT INTO asset(id,workspace_id,account_id,work_id,storage_path,mime,width,height,bytes,sha256,position,ai_generated,origin_asset_id)
				SELECT $1,workspace_id,account_id,$2,$3,mime,width,height,bytes,sha256,position,ai_generated,id FROM asset WHERE id=$4`,
				id, newID, paths[old], old); err != nil {
				return err
			}
		}
		for _, sec := range src.Sections {
			if _, err := tx.Exec(ctx, `INSERT INTO work_section(id,work_id,position,heading,key_point,content_md,ai_raw_md,origin,material_ids,ai_call_id)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, sections[sec.ID], newID, sec.Position, sec.Heading, sec.KeyPoint,
				images.Replace(sec.ContentMD), images.Replace(sec.AIRawMD), sec.Origin, sec.MaterialIDs, sec.AICallID); err != nil {
				return err
			}
		}
		for _, p := range src.Panels {
			var asset *uuid.UUID
			if p.AssetID != nil {
				if id, exists := assets[*p.AssetID]; exists {
					asset = &id
				}
			}
			bubbles, _ := json.Marshal(p.Bubbles)
			if _, err := tx.Exec(ctx, `INSERT INTO comic_panel(work_id,position,scene,character_ids,action,shot,narration,dialogue,image_prompt,asset_id,bubbles)
				VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, newID, p.Position, p.Scene, p.CharacterIDs, p.Action, p.Shot, p.Narration, p.Dialogue, p.ImagePrompt, asset, bubbles); err != nil {
				return err
			}
		}
		for _, c := range src.Cards {
			var asset *uuid.UUID
			if c.ImageAssetID != nil {
				if id, exists := assets[*c.ImageAssetID]; exists {
					asset = &id
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO work_card(work_id,section_id,position,image_asset_id) VALUES($1,$2,$3,$4)`, newID, sections[c.SectionID], c.Position, asset); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `INSERT INTO work_material(work_id,material_id) SELECT $1,material_id FROM work_material WHERE work_id=$2`, newID, src.ID)
		return err
	})
	if err != nil {
		return err
	}
	committed = true
	s.audit(ctx, "work_create", "work", newID.String(), "ok", map[string]any{"copied_from": src.ID})
	return s.writeWork(w, r, newID)
}
