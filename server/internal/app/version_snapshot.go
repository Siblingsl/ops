package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"ops/internal/secure"
)

type versionSection struct {
	ID               uuid.UUID       `json:"id"`
	Position         int             `json:"position"`
	Heading          string          `json:"heading"`
	KeyPoint         string          `json:"key_point"`
	ContentMD        string          `json:"content_md"`
	AIRawMD          string          `json:"ai_raw_md"`
	Origin           string          `json:"origin"`
	SourceSectionIDs []uuid.UUID     `json:"source_section_ids"`
	MaterialIDs      []uuid.UUID     `json:"material_ids"`
	AICallID         *uuid.UUID      `json:"ai_call_id"`
	SourceRevisions  json.RawMessage `json:"source_revisions"`
}

type versionCard struct {
	ID           uuid.UUID  `json:"id"`
	SectionID    uuid.UUID  `json:"section_id"`
	Position     int        `json:"position"`
	ImageAssetID *uuid.UUID `json:"image_asset_id"`
}

type versionPanel struct {
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
	Bubbles      []Bubble    `json:"bubbles"`
}

type workVersionSnapshot struct {
	SchemaVersion int              `json:"schema_version"`
	ContentFormat string           `json:"content_format"`
	Title         string           `json:"title"`
	Summary       string           `json:"summary"`
	Viewpoint     string           `json:"viewpoint"`
	Outline       json.RawMessage  `json:"outline"`
	Sections      []versionSection `json:"sections"`
	Cards         []versionCard    `json:"cards"`
	Panels        []versionPanel   `json:"panels"`
	Theme         string           `json:"theme"`
	CoverAssetID  *uuid.UUID       `json:"cover_asset_id"`
	CoverCrops    json.RawMessage  `json:"cover_crops"`
	Topics        []string         `json:"topics"`
	Tags          []string         `json:"tags"`
	Assets        []uuid.UUID      `json:"assets"`
}

type versionRestorePreview struct {
	Supported                 bool     `json:"supported"`
	LegacyTextOnly            bool     `json:"legacy_text_only"`
	Reason                    string   `json:"reason,omitempty"`
	CurrentRevision           int      `json:"current_revision"`
	ChangedFields             []string `json:"changed_fields"`
	MissingDependencies       []string `json:"missing_dependencies"`
	RequiresH03               bool     `json:"requires_h03"`
	PreservedAdditionalAssets int      `json:"preserved_additional_assets"`
}

func (s *Server) snapshot(ctx context.Context, tx pgx.Tx, workID uuid.UUID) ([]byte, error) {
	var snap workVersionSnapshot
	var outline []byte
	var coverCrops []byte
	if err := tx.QueryRow(ctx, `SELECT content_format,title,summary,viewpoint,outline,theme,cover_asset_id,cover_crops,topics,tags
		FROM work WHERE id=$1`, workID).Scan(&snap.ContentFormat, &snap.Title, &snap.Summary, &snap.Viewpoint, &outline,
		&snap.Theme, &snap.CoverAssetID, &coverCrops, &snap.Topics, &snap.Tags); err != nil {
		return nil, err
	}
	snap.SchemaVersion = 2
	snap.Outline = json.RawMessage(outline)
	if len(snap.Outline) == 0 {
		snap.Outline = json.RawMessage("[]")
	}
	snap.CoverCrops = json.RawMessage(coverCrops)
	if len(snap.CoverCrops) == 0 {
		snap.CoverCrops = json.RawMessage("null")
	}
	if snap.Topics == nil {
		snap.Topics = []string{}
	}
	if snap.Tags == nil {
		snap.Tags = []string{}
	}
	sections, err := s.loadSections(ctx, tx, workID)
	if err != nil {
		return nil, err
	}
	for _, section := range sections {
		snap.Sections = append(snap.Sections, snapshotSection(section))
	}
	if snap.Sections == nil {
		snap.Sections = []versionSection{}
	}
	cards, err := s.loadCards(ctx, tx, workID)
	if err != nil {
		return nil, err
	}
	for _, card := range cards {
		snap.Cards = append(snap.Cards, versionCard{ID: card.ID, SectionID: card.SectionID, Position: card.Position, ImageAssetID: card.ImageAssetID})
	}
	if snap.Cards == nil {
		snap.Cards = []versionCard{}
	}
	snap.Panels, err = loadVersionPanels(ctx, tx, workID)
	if err != nil {
		return nil, err
	}
	if snap.Panels == nil {
		snap.Panels = []versionPanel{}
	}
	rows, err := tx.Query(ctx, `SELECT id FROM asset WHERE work_id=$1 ORDER BY position,created_at,id`, workID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		snap.Assets = append(snap.Assets, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if snap.Assets == nil {
		snap.Assets = []uuid.UUID{}
	}
	return json.Marshal(snap)
}

func snapshotSection(section Section) versionSection {
	if section.SourceSectionIDs == nil {
		section.SourceSectionIDs = []uuid.UUID{}
	}
	if section.MaterialIDs == nil {
		section.MaterialIDs = []uuid.UUID{}
	}
	if len(section.SourceRevisions) == 0 {
		section.SourceRevisions = json.RawMessage("{}")
	}
	return versionSection{ID: section.ID, Position: section.Position, Heading: section.Heading, KeyPoint: section.KeyPoint,
		ContentMD: section.ContentMD, AIRawMD: section.AIRawMD, Origin: section.Origin, SourceSectionIDs: section.SourceSectionIDs,
		MaterialIDs: section.MaterialIDs, AICallID: section.AICallID, SourceRevisions: section.SourceRevisions}
}

func loadVersionPanels(ctx context.Context, tx pgx.Tx, workID uuid.UUID) ([]versionPanel, error) {
	rows, err := tx.Query(ctx, `SELECT id,position,scene,character_ids,action,shot,narration,dialogue,image_prompt,asset_id,coalesce(bubbles,'[]')
		FROM comic_panel WHERE work_id=$1 ORDER BY position,created_at,id`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	panels := []versionPanel{}
	for rows.Next() {
		var panel versionPanel
		var bubbles []byte
		if err := rows.Scan(&panel.ID, &panel.Position, &panel.Scene, &panel.CharacterIDs, &panel.Action, &panel.Shot,
			&panel.Narration, &panel.Dialogue, &panel.ImagePrompt, &panel.AssetID, &bubbles); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(bubbles, &panel.Bubbles); err != nil {
			return nil, err
		}
		if panel.CharacterIDs == nil {
			panel.CharacterIDs = []uuid.UUID{}
		}
		if panel.Bubbles == nil {
			panel.Bubbles = []Bubble{}
		}
		panels = append(panels, panel)
	}
	return panels, rows.Err()
}

func decodeWorkVersionSnapshot(raw []byte, currentFormat string) (*workVersionSnapshot, bool, error) {
	var shape map[string]json.RawMessage
	if err := json.Unmarshal(raw, &shape); err != nil || shape == nil {
		return nil, false, fmt.Errorf("快照不是有效的作品对象")
	}
	if _, hasSchema := shape["schema_version"]; !hasSchema {
		if currentFormat != "long_article" {
			return nil, true, fmt.Errorf("旧快照只保存了长文文字，不能恢复到当前作品形态")
		}
		for _, key := range []string{"title", "summary", "viewpoint", "outline", "sections"} {
			if _, ok := shape[key]; !ok {
				return nil, true, fmt.Errorf("旧文字快照缺少 %s 字段", key)
			}
		}
		if !jsonArray(shape["outline"]) || !jsonArray(shape["sections"]) {
			return nil, true, fmt.Errorf("旧文字快照的大纲或段落结构不完整")
		}
		var legacy workVersionSnapshot
		if err := json.Unmarshal(raw, &legacy); err != nil {
			return nil, true, fmt.Errorf("旧文字快照结构无法读取")
		}
		legacy.Sections = make([]versionSection, 0)
		var oldSections []Section
		if err := json.Unmarshal(shape["sections"], &oldSections); err != nil {
			return nil, true, fmt.Errorf("旧文字快照段落结构无法读取")
		}
		for _, section := range oldSections {
			legacy.Sections = append(legacy.Sections, snapshotSection(section))
		}
		if err := validateVersionShape(&legacy, true); err != nil {
			return nil, true, err
		}
		return &legacy, true, nil
	}
	var schemaVersion int
	if err := json.Unmarshal(shape["schema_version"], &schemaVersion); err != nil || schemaVersion != 2 {
		return nil, false, fmt.Errorf("快照结构版本不受支持")
	}
	for _, key := range []string{"content_format", "title", "summary", "viewpoint", "outline", "sections", "cards", "panels", "theme", "cover_asset_id", "cover_crops", "topics", "tags", "assets"} {
		if _, ok := shape[key]; !ok {
			return nil, false, fmt.Errorf("快照缺少 %s 字段", key)
		}
	}
	for _, key := range []string{"outline", "sections", "cards", "panels", "topics", "tags", "assets"} {
		if !jsonArray(shape[key]) {
			return nil, false, fmt.Errorf("快照 %s 结构不完整", key)
		}
	}
	var snap workVersionSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, false, fmt.Errorf("快照结构无法读取")
	}
	if snap.ContentFormat != currentFormat {
		return nil, false, fmt.Errorf("快照作品形态与当前作品不一致")
	}
	if err := validateVersionShape(&snap, false); err != nil {
		return nil, false, err
	}
	return &snap, false, nil
}

func jsonArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '['
}

func validateVersionShape(snap *workVersionSnapshot, legacy bool) error {
	sectionIDs := make(map[uuid.UUID]struct{}, len(snap.Sections))
	for i := range snap.Sections {
		section := &snap.Sections[i]
		if section.ID == uuid.Nil {
			return fmt.Errorf("快照包含无效段落编号")
		}
		if _, exists := sectionIDs[section.ID]; exists {
			return fmt.Errorf("快照包含重复段落编号")
		}
		sectionIDs[section.ID] = struct{}{}
		if section.Origin == "" {
			section.Origin = "human"
		}
		if section.Origin != "ai" && section.Origin != "human" && section.Origin != "mixed" {
			return fmt.Errorf("快照包含无效段落来源")
		}
		if section.SourceSectionIDs == nil {
			section.SourceSectionIDs = []uuid.UUID{}
		}
		if section.MaterialIDs == nil {
			section.MaterialIDs = []uuid.UUID{}
		}
		if len(section.SourceRevisions) == 0 || !json.Valid(section.SourceRevisions) {
			section.SourceRevisions = json.RawMessage("{}")
		}
	}
	if !legacy {
		if snap.Topics == nil || snap.Tags == nil || snap.Cards == nil || snap.Panels == nil || snap.Assets == nil {
			return fmt.Errorf("快照数组字段不完整")
		}
		assetIDs := map[uuid.UUID]struct{}{}
		for _, id := range snap.Assets {
			if id == uuid.Nil {
				return fmt.Errorf("快照包含无效图片编号")
			}
			if _, exists := assetIDs[id]; exists {
				return fmt.Errorf("快照包含重复图片编号")
			}
			assetIDs[id] = struct{}{}
		}
		cardIDs, cardSections := map[uuid.UUID]struct{}{}, map[uuid.UUID]struct{}{}
		for _, card := range snap.Cards {
			if card.ID == uuid.Nil || card.SectionID == uuid.Nil {
				return fmt.Errorf("快照包含无效卡片关联")
			}
			if _, exists := sectionIDs[card.SectionID]; !exists {
				return fmt.Errorf("卡片关联到快照之外的段落")
			}
			if _, exists := cardIDs[card.ID]; exists {
				return fmt.Errorf("快照包含重复卡片编号")
			}
			if _, exists := cardSections[card.SectionID]; exists {
				return fmt.Errorf("快照包含重复卡片段落")
			}
			cardIDs[card.ID], cardSections[card.SectionID] = struct{}{}, struct{}{}
			if card.ImageAssetID != nil {
				if _, exists := assetIDs[*card.ImageAssetID]; !exists {
					return fmt.Errorf("卡片图片不在快照图片范围内")
				}
			}
		}
		panelIDs := map[uuid.UUID]struct{}{}
		for _, panel := range snap.Panels {
			if panel.ID == uuid.Nil {
				return fmt.Errorf("快照包含无效分格编号")
			}
			if _, exists := panelIDs[panel.ID]; exists {
				return fmt.Errorf("快照包含重复分格编号")
			}
			panelIDs[panel.ID] = struct{}{}
			if panel.AssetID != nil {
				if _, exists := assetIDs[*panel.AssetID]; !exists {
					return fmt.Errorf("分格图片不在快照图片范围内")
				}
			}
			if panel.CharacterIDs == nil {
				panel.CharacterIDs = []uuid.UUID{}
			}
			if panel.Bubbles == nil {
				panel.Bubbles = []Bubble{}
			}
		}
		if snap.CoverAssetID != nil {
			if _, exists := assetIDs[*snap.CoverAssetID]; !exists {
				return fmt.Errorf("封面图片不在快照图片范围内")
			}
		}
		if len(snap.Outline) == 0 || !json.Valid(snap.Outline) {
			return fmt.Errorf("快照大纲无效")
		}
		var outline []OutlineItem
		if err := json.Unmarshal(snap.Outline, &outline); err != nil {
			return fmt.Errorf("快照大纲结构无法读取")
		}
		for _, item := range outline {
			if item.SectionID != "" {
				id, err := uuid.Parse(item.SectionID)
				if err != nil {
					return fmt.Errorf("大纲包含无效段落关联")
				}
				if _, exists := sectionIDs[id]; !exists {
					return fmt.Errorf("大纲关联到快照之外的段落")
				}
			}
		}
	} else if len(snap.Outline) == 0 || !json.Valid(snap.Outline) {
		return fmt.Errorf("旧文字快照大纲无效")
	}
	return nil
}

func snapshotSections(sections []Section) []versionSection {
	out := make([]versionSection, 0, len(sections))
	for _, section := range sections {
		out = append(out, snapshotSection(section))
	}
	return out
}

func snapshotCards(cards []WorkCard) []versionCard {
	out := make([]versionCard, 0, len(cards))
	for _, card := range cards {
		out = append(out, versionCard{ID: card.ID, SectionID: card.SectionID, Position: card.Position, ImageAssetID: card.ImageAssetID})
	}
	return out
}

func versionChangedFields(current *Work, snap *workVersionSnapshot, legacy bool) []string {
	fields := []string{}
	add := func(label string, a, b any) {
		if !sameJSONValue(a, b) {
			fields = append(fields, label)
		}
	}
	add("标题", current.Title, snap.Title)
	add("摘要", current.Summary, snap.Summary)
	add("观点", current.Viewpoint, snap.Viewpoint)
	add("大纲", current.Outline, jsonOutline(snap.Outline))
	add("段落", snapshotSections(current.Sections), snap.Sections)
	if !legacy {
		add("卡片及图片引用", snapshotCards(current.Cards), snap.Cards)
		add("分格、气泡及角色引用", snapshotPanels(current.Panels), snap.Panels)
		add("图片顺序", assetOrder(current.Assets), snap.Assets)
		add("作品主题", current.Theme, snap.Theme)
		add("封面与裁剪", struct {
			ID    *uuid.UUID      `json:"id"`
			Crops json.RawMessage `json:"crops"`
		}{current.CoverAssetID, current.CoverCrops}, struct {
			ID    *uuid.UUID      `json:"id"`
			Crops json.RawMessage `json:"crops"`
		}{snap.CoverAssetID, snap.CoverCrops})
		add("话题", current.Topics, snap.Topics)
		add("标签", current.Tags, snap.Tags)
	}
	return fields
}

func jsonOutline(raw json.RawMessage) []OutlineItem {
	var outline []OutlineItem
	_ = json.Unmarshal(raw, &outline)
	if outline == nil {
		outline = []OutlineItem{}
	}
	return outline
}

func snapshotPanels(panels []ComicPanel) []versionPanel {
	out := make([]versionPanel, 0, len(panels))
	for _, panel := range panels {
		out = append(out, versionPanel{ID: panel.ID, Position: panel.Position, Scene: panel.Scene, CharacterIDs: panel.CharacterIDs,
			Action: panel.Action, Shot: panel.Shot, Narration: panel.Narration, Dialogue: panel.Dialogue, ImagePrompt: panel.ImagePrompt,
			AssetID: panel.AssetID, Bubbles: panel.Bubbles})
	}
	return out
}

func assetOrder(assets []Asset) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(assets))
	for _, asset := range assets {
		out = append(out, asset.ID)
	}
	return out
}

func sameJSONValue(a, b any) bool {
	left, errLeft := json.Marshal(a)
	right, errRight := json.Marshal(b)
	return errLeft == nil && errRight == nil && bytes.Equal(left, right)
}

func outlineEqual(a, b json.RawMessage) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	return reflect.DeepEqual(left, right)
}

func (s *Server) assessVersionRestore(ctx context.Context, workID, accountID uuid.UUID, raw []byte, current *Work) versionRestorePreview {
	preview := versionRestorePreview{CurrentRevision: current.Revision, ChangedFields: []string{}, MissingDependencies: []string{}}
	snap, legacy, err := decodeWorkVersionSnapshot(raw, current.ContentFormat)
	if err != nil {
		preview.Reason = err.Error()
		return preview
	}
	if legacy {
		var hasStructures bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM work_card WHERE work_id=$1) OR EXISTS(SELECT 1 FROM comic_panel WHERE work_id=$1)`, workID).Scan(&hasStructures); err != nil {
			preview.Reason = "读取当前结构失败"
			return preview
		}
		if hasStructures {
			preview.Reason = "旧文字快照不能覆盖当前卡片或漫画结构"
			return preview
		}
	}
	preview.LegacyTextOnly = legacy
	preview.ChangedFields = versionChangedFields(current, snap, legacy)
	preview.RequiresH03 = !outlineEqual(currentOutlineJSON(current), snap.Outline)
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		preview.Reason = "读取关联资源失败"
		return preview
	}
	defer tx.Rollback(ctx)
	missing, err := s.validateVersionDependencies(ctx, tx, workID, accountID, snap, legacy, false)
	if err != nil {
		preview.Reason = "验证关联资源失败"
		return preview
	}
	preview.MissingDependencies = missing
	if !legacy {
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM asset WHERE work_id=$1 AND NOT (id=ANY($2::uuid[]))`, workID, snap.Assets).Scan(&preview.PreservedAdditionalAssets); err != nil {
			preview.Reason = "读取快照后新增图片失败"
			return preview
		}
	}
	preview.Supported = len(missing) == 0
	if len(missing) > 0 {
		preview.Reason = "快照引用的图片、素材或角色已缺失或不再属于当前作品范围"
	}
	return preview
}

func currentOutlineJSON(current *Work) json.RawMessage {
	b, _ := json.Marshal(current.Outline)
	return b
}

func (s *Server) validateVersionDependencies(ctx context.Context, tx pgx.Tx, workID, accountID uuid.UUID, snap *workVersionSnapshot, legacy, lockAssets bool) ([]string, error) {
	missingSet := map[string]struct{}{}
	assetIDs := map[uuid.UUID]struct{}{}
	if !legacy {
		for _, id := range snap.Assets {
			assetIDs[id] = struct{}{}
		}
		for _, card := range snap.Cards {
			if card.ImageAssetID != nil {
				assetIDs[*card.ImageAssetID] = struct{}{}
			}
		}
		for _, panel := range snap.Panels {
			if panel.AssetID != nil {
				assetIDs[*panel.AssetID] = struct{}{}
			}
		}
		if snap.CoverAssetID != nil {
			assetIDs[*snap.CoverAssetID] = struct{}{}
		}
	}
	if len(assetIDs) > 0 {
		ids := make([]uuid.UUID, 0, len(assetIDs))
		for id := range assetIDs {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
		query := `SELECT id,storage_path,bytes,sha256 FROM asset WHERE work_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`
		if lockAssets {
			query += ` FOR KEY SHARE`
		}
		rows, err := tx.Query(ctx, query, workID, ids)
		if err != nil {
			return nil, err
		}
		found := map[uuid.UUID]struct{}{}
		for rows.Next() {
			var id uuid.UUID
			var path, hash string
			var byteCount int
			if err := rows.Scan(&id, &path, &byteCount, &hash); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = struct{}{}
			data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(path)))
			if err != nil || len(data) != byteCount || secure.SHA256Hex(data) != hash {
				missingSet[id.String()] = struct{}{}
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for _, id := range ids {
			if _, ok := found[id]; !ok {
				missingSet[id.String()] = struct{}{}
			}
		}
	}
	materialIDs := map[uuid.UUID]struct{}{}
	for _, section := range snap.Sections {
		for _, id := range section.MaterialIDs {
			materialIDs[id] = struct{}{}
		}
	}
	var outline []OutlineItem
	if err := json.Unmarshal(snap.Outline, &outline); err != nil {
		return nil, fmt.Errorf("快照大纲无法读取")
	}
	for _, item := range outline {
		for _, raw := range item.MaterialIDs {
			id, err := uuid.Parse(raw)
			if err != nil {
				missingSet["素材:"+raw] = struct{}{}
				continue
			}
			materialIDs[id] = struct{}{}
		}
	}
	if len(materialIDs) > 0 {
		ids := make([]uuid.UUID, 0, len(materialIDs))
		for id := range materialIDs {
			ids = append(ids, id)
		}
		rows, err := tx.Query(ctx, `SELECT id FROM material WHERE id=ANY($1::uuid[]) AND workspace_id=(SELECT workspace_id FROM platform_account WHERE id=$2)
			AND deleted_at IS NULL AND (account_id IS NULL OR account_id=$2)`, ids, accountID)
		if err != nil {
			return nil, err
		}
		found := map[uuid.UUID]struct{}{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for id := range materialIDs {
			if _, ok := found[id]; !ok {
				missingSet["素材:"+id.String()] = struct{}{}
			}
		}
	}
	characterIDs := map[uuid.UUID]struct{}{}
	if !legacy {
		for _, panel := range snap.Panels {
			for _, id := range panel.CharacterIDs {
				characterIDs[id] = struct{}{}
			}
		}
	}
	if len(characterIDs) > 0 {
		ids := make([]uuid.UUID, 0, len(characterIDs))
		for id := range characterIDs {
			ids = append(ids, id)
		}
		rows, err := tx.Query(ctx, `SELECT id FROM character_card WHERE account_id=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[])`, accountID, ids)
		if err != nil {
			return nil, err
		}
		found := map[uuid.UUID]struct{}{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
		for id := range characterIDs {
			if _, ok := found[id]; !ok {
				missingSet["角色:"+id.String()] = struct{}{}
			}
		}
	}
	missing := make([]string, 0, len(missingSet))
	for value := range missingSet {
		missing = append(missing, value)
	}
	sort.Strings(missing)
	return missing, nil
}

func versionRestoreUnsupported(reason string, missing []string) error {
	message := "此版本快照不完整或当前关联资源不可用，当前作品未修改。请检查预览中的缺失项。"
	if strings.TrimSpace(reason) != "" {
		message = reason + "；当前作品未修改。"
	}
	return apiErr(409, "version_restore_unsupported", message).With(map[string]any{"missing_dependencies": missing})
}

func (s *Server) restoreVersionSnapshot(ctx context.Context, tx pgx.Tx, workID uuid.UUID, snap *workVersionSnapshot, legacy bool) error {
	var currentOutline []byte
	if err := tx.QueryRow(ctx, `SELECT outline FROM work WHERE id=$1`, workID).Scan(&currentOutline); err != nil {
		return err
	}
	outlineChanged := !outlineEqual(currentOutline, snap.Outline)
	if legacy {
		if err := updateRestoredWorkText(ctx, tx, workID, snap, outlineChanged, false); err != nil {
			return err
		}
		return restoreVersionSections(ctx, tx, workID, snap.Sections)
	}
	if err := updateRestoredWorkText(ctx, tx, workID, snap, outlineChanged, true); err != nil {
		return err
	}
	if err := restoreVersionSections(ctx, tx, workID, snap.Sections); err != nil {
		return err
	}
	if err := restoreVersionCards(ctx, tx, workID, snap.Cards); err != nil {
		return err
	}
	if err := restoreVersionPanels(ctx, tx, workID, snap.Panels); err != nil {
		return err
	}
	if err := restoreVersionAssetOrder(ctx, tx, workID, snap.Assets); err != nil {
		return err
	}
	return nil
}

func updateRestoredWorkText(ctx context.Context, tx pgx.Tx, workID uuid.UUID, snap *workVersionSnapshot, outlineChanged, full bool) error {
	if full {
		_, err := tx.Exec(ctx, `UPDATE work SET title=$2,summary=$3,viewpoint=$4,outline=$5,theme=$6,cover_asset_id=$7,cover_crops=$8,
			topics=$9,tags=$10,outline_confirmed_at=CASE WHEN $11 THEN NULL ELSE outline_confirmed_at END
			WHERE id=$1`, workID, snap.Title, snap.Summary, snap.Viewpoint, snap.Outline, snap.Theme,
			snap.CoverAssetID, nullableJSON(snap.CoverCrops), snap.Topics, snap.Tags, outlineChanged)
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE work SET title=$2,summary=$3,viewpoint=$4,outline=$5,
		outline_confirmed_at=CASE WHEN $6 THEN NULL ELSE outline_confirmed_at END WHERE id=$1`,
		workID, snap.Title, snap.Summary, snap.Viewpoint, snap.Outline, outlineChanged)
	return err
}

func nullableJSON(raw json.RawMessage) any {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || len(raw) == 0 {
		return nil
	}
	return []byte(raw)
}

func restoreVersionSections(ctx context.Context, tx pgx.Tx, workID uuid.UUID, sections []versionSection) error {
	ids := make([]uuid.UUID, 0, len(sections))
	for _, section := range sections {
		ids = append(ids, section.ID)
	}
	if _, err := tx.Exec(ctx, `UPDATE work_section SET deleted_at=now(),revision=revision+1,updated_at=now()
		WHERE work_id=$1 AND deleted_at IS NULL AND NOT (id=ANY($2::uuid[]))`, workID, ids); err != nil {
		return err
	}
	for _, section := range sections {
		if section.SourceSectionIDs == nil {
			section.SourceSectionIDs = []uuid.UUID{}
		}
		if section.MaterialIDs == nil {
			section.MaterialIDs = []uuid.UUID{}
		}
		if len(section.SourceRevisions) == 0 {
			section.SourceRevisions = json.RawMessage("{}")
		}
		result, err := tx.Exec(ctx, `INSERT INTO work_section(id,work_id,position,heading,key_point,content_md,ai_raw_md,origin,source_section_ids,material_ids,ai_call_id,source_revisions)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
			ON CONFLICT(id) DO UPDATE SET position=EXCLUDED.position,heading=EXCLUDED.heading,key_point=EXCLUDED.key_point,
			content_md=EXCLUDED.content_md,ai_raw_md=EXCLUDED.ai_raw_md,origin=EXCLUDED.origin,source_section_ids=EXCLUDED.source_section_ids,
			material_ids=EXCLUDED.material_ids,ai_call_id=EXCLUDED.ai_call_id,source_revisions=EXCLUDED.source_revisions,
			revision=work_section.revision+1,updated_at=now(),deleted_at=NULL
			WHERE work_section.work_id=EXCLUDED.work_id`, section.ID, workID, section.Position, section.Heading, section.KeyPoint,
			section.ContentMD, section.AIRawMD, nz(section.Origin, "human"), section.SourceSectionIDs, section.MaterialIDs,
			section.AICallID, []byte(section.SourceRevisions))
		if err != nil {
			return err
		}
		if result.RowsAffected() == 0 {
			return versionRestoreUnsupported("段落编号不属于当前作品", []string{section.ID.String()})
		}
	}
	return nil
}

func restoreVersionCards(ctx context.Context, tx pgx.Tx, workID uuid.UUID, cards []versionCard) error {
	if _, err := tx.Exec(ctx, `DELETE FROM work_card WHERE work_id=$1`, workID); err != nil {
		return err
	}
	for _, card := range cards {
		if _, err := tx.Exec(ctx, `INSERT INTO work_card(id,work_id,section_id,position,image_asset_id) VALUES($1,$2,$3,$4,$5)`,
			card.ID, workID, card.SectionID, card.Position, card.ImageAssetID); err != nil {
			return err
		}
	}
	return nil
}

func restoreVersionPanels(ctx context.Context, tx pgx.Tx, workID uuid.UUID, panels []versionPanel) error {
	if _, err := tx.Exec(ctx, `DELETE FROM comic_panel WHERE work_id=$1`, workID); err != nil {
		return err
	}
	for _, panel := range panels {
		bubbles, err := json.Marshal(panel.Bubbles)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO comic_panel(id,work_id,position,scene,character_ids,action,shot,narration,dialogue,image_prompt,asset_id,bubbles)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, panel.ID, workID, panel.Position, panel.Scene, panel.CharacterIDs,
			panel.Action, panel.Shot, panel.Narration, panel.Dialogue, panel.ImagePrompt, panel.AssetID, bubbles); err != nil {
			return err
		}
	}
	return nil
}

func lockVersionSections(ctx context.Context, tx pgx.Tx, workID uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT id FROM work_section WHERE work_id=$1 ORDER BY id FOR UPDATE`, workID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
	}
	return rows.Err()
}

func restoreVersionAssetOrder(ctx context.Context, tx pgx.Tx, workID uuid.UUID, assetIDs []uuid.UUID) error {
	for position, id := range assetIDs {
		if _, err := tx.Exec(ctx, `UPDATE asset SET position=$3 WHERE id=$1 AND work_id=$2`, id, workID, position); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `WITH extra AS (
		SELECT id,row_number() OVER (ORDER BY position,created_at,id)::int-1 AS ordinal
		FROM asset WHERE work_id=$1 AND NOT (id=ANY($3::uuid[]))
	)
	UPDATE asset a SET position=$2+extra.ordinal FROM extra WHERE a.id=extra.id`, workID, len(assetIDs), assetIDs)
	return err
}
