package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// comicDialogueMax is the bubble-friendly dialogue length hint (05 文档 P-07).
const comicDialogueMax = 30

type CharacterCard struct {
	ID          uuid.UUID  `json:"id"`
	AccountID   uuid.UUID  `json:"account_id"`
	Name        string     `json:"name"`
	Appearance  string     `json:"appearance"`
	Personality string     `json:"personality"`
	Catchphrase string     `json:"catchphrase"`
	RefAssetID  *uuid.UUID `json:"ref_asset_id"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type ComicPanel struct {
	ID           uuid.UUID   `json:"id"`
	Position     int         `json:"position"`
	Scene        string      `json:"scene"`
	CharacterIDs []uuid.UUID `json:"character_ids"`
	Action       string      `json:"action"`
	Shot         string      `json:"shot"`
	Narration    string      `json:"narration"`
	Dialogue     string      `json:"dialogue"`
	ImagePrompt  string      `json:"image_prompt"`
	AssetID      *uuid.UUID  `json:"asset_id"`
	CreatedAt    time.Time   `json:"created_at"`
	UpdatedAt    time.Time   `json:"updated_at"`
}

func (s *Server) requireComicAccount(a *Account) error {
	if a.ContentFormat != "comic" {
		return validation("只有内容形态为「漫画」的账号可以使用角色设定卡和漫画工作流")
	}
	return nil
}

func (s *Server) scanCharacter(row pgx.Row) (CharacterCard, error) {
	var x CharacterCard
	err := row.Scan(&x.ID, &x.AccountID, &x.Name, &x.Appearance, &x.Personality, &x.Catchphrase, &x.RefAssetID, &x.CreatedAt, &x.UpdatedAt)
	return x, err
}

func (s *Server) listCharacters(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if err := s.requireComicAccount(a); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, account_id, name, appearance, personality, catchphrase, ref_asset_id, created_at, updated_at
		FROM character_card WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []CharacterCard{}
	for rows.Next() {
		x, err := s.scanCharacter(rows)
		if err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) createCharacter(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if err := s.requireComicAccount(a); err != nil {
		return err
	}
	var in struct {
		Name        string     `json:"name"`
		Appearance  string     `json:"appearance"`
		Personality string     `json:"personality"`
		Catchphrase string     `json:"catchphrase"`
		RefAssetID  *uuid.UUID `json:"ref_asset_id"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return validation("请填写角色名称")
	}
	x, err := s.scanCharacter(s.db.QueryRow(r.Context(), `INSERT INTO character_card (account_id, name, appearance, personality, catchphrase, ref_asset_id)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, account_id, name, appearance, personality, catchphrase, ref_asset_id, created_at, updated_at`,
		a.ID, in.Name, strings.TrimSpace(in.Appearance), strings.TrimSpace(in.Personality), strings.TrimSpace(in.Catchphrase), in.RefAssetID))
	if err != nil {
		return err
	}
	s.audit(r.Context(), "character_create", "character_card", x.ID.String(), "ok", nil)
	return ok(w, x)
}

func (s *Server) updateCharacter(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	accountID, err := s.ownedAccountRow(r.Context(), "character_card", id)
	if err != nil {
		return err
	}
	a, err := s.account(r.Context(), accountID)
	if err != nil {
		return err
	}
	if err := s.requireComicAccount(a); err != nil {
		return err
	}
	var in struct {
		Name        *string    `json:"name"`
		Appearance  *string    `json:"appearance"`
		Personality *string    `json:"personality"`
		Catchphrase *string    `json:"catchphrase"`
		RefAssetID  *uuid.UUID `json:"ref_asset_id"`
		ClearRef    bool       `json:"clear_ref"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	cur, err := s.scanCharacter(s.db.QueryRow(r.Context(), `SELECT id, account_id, name, appearance, personality, catchphrase, ref_asset_id, created_at, updated_at
		FROM character_card WHERE id=$1 AND deleted_at IS NULL`, id))
	if err != nil {
		return err
	}
	if in.Name != nil {
		cur.Name = strings.TrimSpace(*in.Name)
		if cur.Name == "" {
			return validation("请填写角色名称")
		}
	}
	if in.Appearance != nil {
		cur.Appearance = strings.TrimSpace(*in.Appearance)
	}
	if in.Personality != nil {
		cur.Personality = strings.TrimSpace(*in.Personality)
	}
	if in.Catchphrase != nil {
		cur.Catchphrase = strings.TrimSpace(*in.Catchphrase)
	}
	if in.ClearRef {
		cur.RefAssetID = nil
	} else if in.RefAssetID != nil {
		cur.RefAssetID = in.RefAssetID
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE character_card SET name=$2, appearance=$3, personality=$4, catchphrase=$5, ref_asset_id=$6, updated_at=now() WHERE id=$1`,
		id, cur.Name, cur.Appearance, cur.Personality, cur.Catchphrase, cur.RefAssetID); err != nil {
		return err
	}
	return ok(w, cur)
}

func (s *Server) deleteCharacter(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "character_card", id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE character_card SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	s.audit(r.Context(), "character_delete", "character_card", id.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) loadPanels(ctx context.Context, workID uuid.UUID) ([]ComicPanel, error) {
	rows, err := s.db.Query(ctx, `SELECT id, position, scene, character_ids, action, shot, narration, dialogue, image_prompt, asset_id, created_at, updated_at
		FROM comic_panel WHERE work_id=$1 ORDER BY position, created_at`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []ComicPanel{}
	for rows.Next() {
		var p ComicPanel
		if err := rows.Scan(&p.ID, &p.Position, &p.Scene, &p.CharacterIDs, &p.Action, &p.Shot, &p.Narration, &p.Dialogue, &p.ImagePrompt, &p.AssetID, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		if p.CharacterIDs == nil {
			p.CharacterIDs = []uuid.UUID{}
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

func (s *Server) loadCharactersByIDs(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID) ([]CharacterCard, error) {
	if len(ids) == 0 {
		return []CharacterCard{}, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, account_id, name, appearance, personality, catchphrase, ref_asset_id, created_at, updated_at
		FROM character_card WHERE account_id=$1 AND deleted_at IS NULL AND id = ANY($2) ORDER BY created_at`, accountID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []CharacterCard{}
	for rows.Next() {
		x, err := s.scanCharacter(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, x)
	}
	return list, nil
}

func characterBlock(cards []CharacterCard) string {
	var b strings.Builder
	b.WriteString("## 角色设定卡\n")
	if len(cards) == 0 {
		b.WriteString("（未选择角色）\n")
		return b.String()
	}
	for _, c := range cards {
		fmt.Fprintf(&b, "- id=%s 名称：%s\n  外貌：%s\n  性格：%s\n  口头禅：%s\n",
			c.ID, c.Name, emptyDash(c.Appearance), emptyDash(c.Personality), emptyDash(c.Catchphrase))
	}
	return b.String()
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "（未填写）"
	}
	return s
}

func filterCharacterIDs(allowed map[uuid.UUID]bool, ids []uuid.UUID) []uuid.UUID {
	out := []uuid.UUID{}
	for _, id := range ids {
		if allowed[id] {
			out = append(out, id)
		}
	}
	return out
}

func appearanceSuffix(cards []CharacterCard, ids []uuid.UUID) string {
	byID := map[uuid.UUID]CharacterCard{}
	for _, c := range cards {
		byID[c.ID] = c
	}
	var parts []string
	for _, id := range ids {
		if c, ok := byID[id]; ok && strings.TrimSpace(c.Appearance) != "" {
			parts = append(parts, fmt.Sprintf("%s：%s", c.Name, c.Appearance))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "角色外貌：" + strings.Join(parts, "；")
}

func ensureImagePrompt(prompt string, cards []CharacterCard, ids []uuid.UUID) string {
	prompt = strings.TrimSpace(prompt)
	suffix := appearanceSuffix(cards, ids)
	if suffix == "" {
		return prompt
	}
	if strings.Contains(prompt, "角色外貌：") {
		return prompt
	}
	if prompt == "" {
		return suffix
	}
	return prompt + "\n" + suffix
}

// generateStoryboard requires viewpoint (H-02). It returns panels without persisting.
func (s *Server) generateStoryboard(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if m.Account.ContentFormat != "comic" {
		return validation("只有漫画作品可以生成分镜")
	}
	if strings.TrimSpace(m.Viewpoint) == "" {
		return humanStep("H-02", "请先写下你自己的核心观点，再生成分镜")
	}
	var in struct {
		PanelCount   int         `json:"panel_count"`
		CharacterIDs []uuid.UUID `json:"character_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.PanelCount < 2 || in.PanelCount > 20 {
		return validation("格数需要在 2 到 20 之间")
	}
	ctx := r.Context()
	cards, err := s.loadCharactersByIDs(ctx, m.Account.ID, in.CharacterIDs)
	if err != nil {
		return err
	}
	if len(cards) != len(uniqueUUIDs(in.CharacterIDs)) {
		return validation("所选角色不存在或不属于当前账号")
	}
	allowed := map[uuid.UUID]bool{}
	for _, c := range cards {
		allowed[c.ID] = true
	}
	var angle string
	_ = s.db.QueryRow(ctx, `SELECT coalesce(t.angle,'') FROM work w LEFT JOIN topic t ON t.id=w.topic_id WHERE w.id=$1`, m.ID).Scan(&angle)
	user := fmt.Sprintf(`%s
## 作品
标题：%s
选题切入角度：%s
核心观点：%s
格数：%d

## 任务说明
围绕作者的核心观点，生成恰好 %d 格漫画分镜。每格包含场景、出场角色 id（只能使用上面角色卡中的 id）、动作、镜头、旁白和对白。
对白用于气泡，尽量不超过 %d 个字。

## 输出格式
只输出 JSON：{"panels":[{"scene":"","character_ids":[],"action":"","shot":"","narration":"","dialogue":""}]}`,
		characterBlock(cards), m.Title, angle, m.Viewpoint, in.PanelCount, in.PanelCount, comicDialogueMax)
	var out struct {
		Panels []struct {
			Scene        string   `json:"scene"`
			CharacterIDs []string `json:"character_ids"`
			Action       string   `json:"action"`
			Shot         string   `json:"shot"`
			Narration    string   `json:"narration"`
			Dialogue     string   `json:"dialogue"`
		} `json:"panels"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "comic_storyboard", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"characters": len(cards), "panel_count": in.PanelCount}}, &out, func() error {
		if len(out.Panels) != in.PanelCount {
			return fmt.Errorf("格数应为 %d，实际 %d", in.PanelCount, len(out.Panels))
		}
		return nil
	})
	if err != nil {
		return err
	}
	panels := make([]map[string]any, 0, len(out.Panels))
	for i, p := range out.Panels {
		ids := []uuid.UUID{}
		for _, s := range p.CharacterIDs {
			if id, err := uuid.Parse(s); err == nil && allowed[id] {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 && len(in.CharacterIDs) > 0 {
			ids = append(ids, in.CharacterIDs[0])
		}
		panels = append(panels, map[string]any{
			"position":      i + 1,
			"scene":         strings.TrimSpace(p.Scene),
			"character_ids": ids,
			"action":        strings.TrimSpace(p.Action),
			"shot":          strings.TrimSpace(p.Shot),
			"narration":     strings.TrimSpace(p.Narration),
			"dialogue":      truncateRunes(strings.TrimSpace(p.Dialogue), comicDialogueMax),
		})
	}
	return ok(w, map[string]any{"panels": panels, "refs": res.Refs})
}

func uniqueUUIDs(ids []uuid.UUID) []uuid.UUID {
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// saveStoryboard persists panels; confirm=true sets outline_confirmed_at (H-03 确认分镜).
func (s *Server) saveStoryboard(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if m.Account.ContentFormat != "comic" {
		return validation("只有漫画作品可以保存分镜")
	}
	var in struct {
		Panels  []ComicPanel `json:"panels"`
		Confirm bool         `json:"confirm"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Panels) < 2 || len(in.Panels) > 20 {
		return validation("格数需要在 2 到 20 之间")
	}
	ctx := r.Context()
	var allIDs []uuid.UUID
	for _, p := range in.Panels {
		allIDs = append(allIDs, p.CharacterIDs...)
	}
	cards, err := s.loadCharactersByIDs(ctx, m.Account.ID, uniqueUUIDs(allIDs))
	if err != nil {
		return err
	}
	allowed := map[uuid.UUID]bool{}
	for _, c := range cards {
		allowed[c.ID] = true
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM comic_panel WHERE work_id=$1`, m.ID); err != nil {
			return err
		}
		for i, p := range in.Panels {
			ids := filterCharacterIDs(allowed, p.CharacterIDs)
			if ids == nil {
				ids = []uuid.UUID{}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO comic_panel (work_id, position, scene, character_ids, action, shot, narration, dialogue, image_prompt, asset_id)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
				m.ID, i+1, strings.TrimSpace(p.Scene), ids, strings.TrimSpace(p.Action), strings.TrimSpace(p.Shot),
				strings.TrimSpace(p.Narration), truncateRunes(strings.TrimSpace(p.Dialogue), comicDialogueMax*2),
				strings.TrimSpace(p.ImagePrompt), p.AssetID); err != nil {
				return err
			}
		}
		if in.Confirm {
			if _, err := tx.Exec(ctx, `UPDATE work SET outline_confirmed_at=coalesce(outline_confirmed_at, now()), updated_at=now() WHERE id=$1`, m.ID); err != nil {
				return err
			}
		} else if m.OutlineConfirmedAt != nil {
			// Replacing storyboard after confirm clears confirmation so panel text must be regenerated intentionally.
			if _, err := tx.Exec(ctx, `UPDATE work SET outline_confirmed_at=NULL, updated_at=now() WHERE id=$1`, m.ID); err != nil {
				return err
			}
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	if in.Confirm {
		s.audit(ctx, "storyboard_confirm", "work", m.ID.String(), "ok", map[string]any{"panels": len(in.Panels)})
	}
	return s.writeWork(w, r, m.ID)
}

func (s *Server) panelFromPath(r *http.Request) (*ComicPanel, *workMeta, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, nil, err
	}
	var p ComicPanel
	var workID uuid.UUID
	err = s.db.QueryRow(r.Context(), `SELECT work_id, id, position, scene, character_ids, action, shot, narration, dialogue, image_prompt, asset_id, created_at, updated_at
		FROM comic_panel WHERE id=$1`, id).Scan(&workID, &p.ID, &p.Position, &p.Scene, &p.CharacterIDs, &p.Action, &p.Shot, &p.Narration, &p.Dialogue, &p.ImagePrompt, &p.AssetID, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, nil, err
	}
	if p.CharacterIDs == nil {
		p.CharacterIDs = []uuid.UUID{}
	}
	m, err := s.workMeta(r.Context(), workID)
	if err != nil {
		return nil, nil, err
	}
	return &p, m, nil
}

func (s *Server) generatePanelText(w http.ResponseWriter, r *http.Request) error {
	p, m, err := s.panelFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	if m.Account.ContentFormat != "comic" {
		return validation("只有漫画作品可以生成逐格文案")
	}
	if m.OutlineConfirmedAt == nil {
		return humanStep("H-03", "请先确认分镜，再生成逐格文案")
	}
	ctx := r.Context()
	cards, err := s.loadCharactersByIDs(ctx, m.Account.ID, p.CharacterIDs)
	if err != nil {
		return err
	}
	user := fmt.Sprintf(`%s
## 本格分镜
格号：%d
场景：%s
动作：%s
镜头：%s
现有旁白：%s
现有对白：%s

## 任务说明
为这一格生成旁白、对白和绘图提示词。对白不超过 %d 字。image_prompt 用中文描述画面，并包含出场角色的外貌特征。

## 输出格式
只输出 JSON：{"narration":"","dialogue":"","image_prompt":""}`,
		characterBlock(cards), p.Position, p.Scene, p.Action, p.Shot, p.Narration, p.Dialogue, comicDialogueMax)
	var out struct {
		Narration   string `json:"narration"`
		Dialogue    string `json:"dialogue"`
		ImagePrompt string `json:"image_prompt"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "comic_panel_text", Account: m.Account, WorkID: &m.ID, User: user, Refs: map[string]any{"panel": p.Position}}, &out, nil)
	if err != nil {
		return err
	}
	out.Narration = strings.TrimSpace(out.Narration)
	out.Dialogue = truncateRunes(strings.TrimSpace(out.Dialogue), comicDialogueMax)
	out.ImagePrompt = ensureImagePrompt(out.ImagePrompt, cards, p.CharacterIDs)
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE comic_panel SET narration=$2, dialogue=$3, image_prompt=$4, updated_at=now() WHERE id=$1`,
			p.ID, out.Narration, out.Dialogue, out.ImagePrompt); err != nil {
			return err
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"narration": out.Narration, "dialogue": out.Dialogue, "image_prompt": out.ImagePrompt, "refs": res.Refs})
}

func (s *Server) updatePanel(w http.ResponseWriter, r *http.Request) error {
	p, m, err := s.panelFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Scene        *string     `json:"scene"`
		CharacterIDs []uuid.UUID `json:"character_ids"`
		Action       *string     `json:"action"`
		Shot         *string     `json:"shot"`
		Narration    *string     `json:"narration"`
		Dialogue     *string     `json:"dialogue"`
		ImagePrompt  *string     `json:"image_prompt"`
		AssetID      *uuid.UUID  `json:"asset_id"`
		ClearAsset   bool        `json:"clear_asset"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if in.Scene != nil {
		p.Scene = strings.TrimSpace(*in.Scene)
	}
	if in.Action != nil {
		p.Action = strings.TrimSpace(*in.Action)
	}
	if in.Shot != nil {
		p.Shot = strings.TrimSpace(*in.Shot)
	}
	if in.Narration != nil {
		p.Narration = strings.TrimSpace(*in.Narration)
	}
	if in.Dialogue != nil {
		p.Dialogue = strings.TrimSpace(*in.Dialogue)
	}
	if in.ImagePrompt != nil {
		p.ImagePrompt = strings.TrimSpace(*in.ImagePrompt)
	}
	if in.CharacterIDs != nil {
		cards, err := s.loadCharactersByIDs(ctx, m.Account.ID, in.CharacterIDs)
		if err != nil {
			return err
		}
		allowed := map[uuid.UUID]bool{}
		for _, c := range cards {
			allowed[c.ID] = true
		}
		p.CharacterIDs = filterCharacterIDs(allowed, in.CharacterIDs)
	}
	if in.ClearAsset {
		p.AssetID = nil
	} else if in.AssetID != nil {
		var okAsset bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM asset WHERE id=$1 AND work_id=$2)`, *in.AssetID, m.ID).Scan(&okAsset); err != nil {
			return err
		}
		if !okAsset {
			return validation("图片不属于该作品")
		}
		p.AssetID = in.AssetID
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE comic_panel SET scene=$2, character_ids=$3, action=$4, shot=$5, narration=$6, dialogue=$7, image_prompt=$8, asset_id=$9, updated_at=now() WHERE id=$1`,
			p.ID, p.Scene, p.CharacterIDs, p.Action, p.Shot, p.Narration, p.Dialogue, p.ImagePrompt, p.AssetID); err != nil {
			return err
		}
		if p.AssetID != nil {
			if _, err := tx.Exec(ctx, `UPDATE asset SET position=$2 WHERE id=$1`, *p.AssetID, p.Position); err != nil {
				return err
			}
		}
		return s.touchContent(ctx, tx, m.ID)
	})
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}
