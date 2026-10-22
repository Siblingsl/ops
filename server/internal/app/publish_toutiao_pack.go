package app

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/secure"
)

const toutiaoTodos = `[{"key":"upload","label":"在头条发布页上传文字和配图，并预览排版","done":false},{"key":"ai","label":"按真实创作情况核对 AI 内容声明","done":false},{"key":"original","label":"核实原创资格；系统检查通过不代表符合声明条件","done":false},{"key":"first","label":"首发默认不选；核对站外发布历史和平台要求","done":false},{"key":"backfill","label":"发布后回到这里回填实际链接与发布时间","done":false}]`

type toutiaoPackUse struct {
	SectionID string `json:"section_id"`
	Ordinal   int    `json:"ordinal"`
	Alt       string `json:"alt"`
}

type toutiaoPackImage struct {
	AssetID     uuid.UUID        `json:"asset_id"`
	File        string           `json:"file"`
	URL         string           `json:"url"`
	Position    int              `json:"position,omitempty"`
	Mime        string           `json:"mime"`
	AIGenerated bool             `json:"ai_generated"`
	AltText     string           `json:"alt_text"`
	Uses        []toutiaoPackUse `json:"uses,omitempty"`
}

type toutiaoPackView struct {
	WorkID        uuid.UUID          `json:"work_id"`
	Platform      string             `json:"platform"`
	ContentFormat string             `json:"content_format"`
	BasisRevision int                `json:"basis_revision"`
	InternalTitle string             `json:"internal_title"`
	PublishTitle  *string            `json:"publish_title"`
	BodyText      string             `json:"body_text"`
	BodyChars     int                `json:"body_chars"`
	Topics        []string           `json:"topics"`
	Instructions  string             `json:"instructions"`
	Images        []toutiaoPackImage `json:"images"`
	Warnings      []string           `json:"warnings"`
}

type toutiaoPackAsset struct {
	ID          uuid.UUID
	StoragePath string
	Mime        string
	Bytes       int64
	SHA256      string
	Position    int
	AIGenerated bool
	AltText     string
	File        string
	Uses        []toutiaoPackUse
}

type toutiaoPackSection struct {
	ID      uuid.UUID
	Heading string
	Content string
}

type toutiaoPackFile struct {
	Name string `json:"name"`
	SHA  string `json:"sha256"`
	Size int    `json:"bytes"`
}

type toutiaoPackManifest struct {
	SchemaVersion int                    `json:"schema_version"`
	Platform      string                 `json:"platform"`
	ContentFormat string                 `json:"content_format"`
	WorkID        uuid.UUID              `json:"work_id"`
	BasisRevision int                    `json:"basis_revision"`
	GeneratedAt   time.Time              `json:"generated_at"`
	InternalTitle string                 `json:"internal_title"`
	PublishTitle  *string                `json:"publish_title"`
	BodyFile      string                 `json:"body_file"`
	TopicsFile    string                 `json:"topics_file"`
	Images        []toutiaoManifestImage `json:"images"`
	Files         []toutiaoPackFile      `json:"files"`
}

type toutiaoManifestImage struct {
	AssetID     uuid.UUID        `json:"asset_id"`
	File        string           `json:"file"`
	Position    int              `json:"position,omitempty"`
	Mime        string           `json:"mime"`
	AIGenerated bool             `json:"ai_generated"`
	Uses        []toutiaoPackUse `json:"uses,omitempty"`
}

type toutiaoPackBuild struct {
	View  toutiaoPackView
	Files map[string][]byte
}

type toutiaoPackSource struct {
	Status                 string
	Format                 string
	Revision               int
	Title                  string
	Topics                 []string
	Sections               []toutiaoPackSection
	Assets                 []toutiaoPackAsset
	OtherPlatformPublished bool
}

var toutiaoImageMarkdown = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
var toutiaoLinkMarkdown = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
var toutiaoHTMLTag = regexp.MustCompile(`<[^>]*>`)
var toutiaoTableRow = regexp.MustCompile(`^\s*\|.*\|\s*$`)
var toutiaoCodeFence = regexp.MustCompile("^\\s*(```|~~~)")
var toutiaoMarkdownHeading = regexp.MustCompile(`^#{1,6}\s+`)
var toutiaoMarkdownNumber = regexp.MustCompile(`^(\d+)[.)]\s+`)
var toutiaoMarkdownEmphasis = regexp.MustCompile(`(\*\*)(.+?)\*\*|(__)(.+?)__|(\*)([^*]+?)\*|(_)([^_]+?)_`)
var toutiaoMarkdownStrike = regexp.MustCompile(`~~(.+?)~~`)
var toutiaoMarkdownCode = regexp.MustCompile("`([^`]+)`")
var toutiaoTableSeparator = regexp.MustCompile(`^:?-{2,}:?$`)

func (s *Server) toutiaoPackCreate(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		BasisRevision *int `json:"basis_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BasisRevision == nil || *in.BasisRevision < 1 {
		return validation("必须提供有效的作品修订号 basis_revision")
	}
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	build, source, err := s.buildToutiaoPack(r.Context(), id, *in.BasisRevision, true)
	if err != nil {
		return err
	}
	if source.Status == "ready" {
		err = s.withTx(r.Context(), func(tx pgx.Tx) error {
			var revision int
			var status string
			if err := tx.QueryRow(r.Context(), `SELECT revision,status FROM work WHERE id=$1 AND deleted_at IS NULL AND account_id IN
				(SELECT id FROM platform_account WHERE workspace_id=$2 AND platform='toutiao') FOR UPDATE`, id, ident(r.Context()).WorkspaceID).Scan(&revision, &status); err != nil {
				return err
			}
			if revision != *in.BasisRevision {
				return packVersionConflict(revision)
			}
			if status == "reviewing" {
				return humanStep("H-09", "这篇作品需要审阅，审阅通过后才能生成发布包")
			}
			if status != "ready" && status != "packed" && status != "published" {
				return humanStep("H-04", "发布前检查还没有全部确认，不能生成发布包")
			}
			if err := s.checkLatestMaterialBasis(r.Context(), tx, id); err != nil {
				return err
			}
			if status == "ready" {
				_, err := tx.Exec(r.Context(), `UPDATE work SET status='packed', updated_at=now(),
					post_push_todos=CASE WHEN post_push_todos='[]'::jsonb THEN $2::jsonb ELSE post_push_todos END WHERE id=$1`, id, toutiaoTodos)
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if err := s.verifyToutiaoPackBasis(r.Context(), id, *in.BasisRevision, source.Status); err != nil {
		return err
	}
	build.View.BasisRevision = *in.BasisRevision
	w.Header().Set("X-OPS-Basis-Revision", strconv.Itoa(*in.BasisRevision))
	s.audit(r.Context(), "toutiao_pack", "work", id.String(), "ok", nil)
	return ok(w, build.View)
}

func (s *Server) toutiaoPackGet(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	basis, err := requiredToutiaoPackBasis(r)
	if err != nil {
		return err
	}
	build, source, err := s.buildToutiaoPack(r.Context(), id, basis, false)
	if err != nil {
		return err
	}
	if err := s.verifyToutiaoPackBasis(r.Context(), id, basis, source.Status); err != nil {
		return err
	}
	return ok(w, build.View)
}

func (s *Server) toutiaoPackZip(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	basis, err := requiredToutiaoPackBasis(r)
	if err != nil {
		return err
	}
	build, source, err := s.buildToutiaoPack(r.Context(), id, basis, false)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp("", "ops-toutiao-*.zip")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := writeToutiaoPackZip(tmp, build.Files); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := s.verifyToutiaoPackBasis(r.Context(), id, basis, source.Status); err != nil {
		return err
	}
	file, err := os.Open(tmpPath)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="toutiao-`+time.Now().Format("20060102-1504")+`.zip"`)
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	w.Header().Set("X-OPS-Basis-Revision", strconv.Itoa(basis))
	_, err = io.Copy(w, file)
	return err
}

func requiredToutiaoPackBasis(r *http.Request) (int, error) {
	value := r.URL.Query().Get("basis_revision")
	if value == "" {
		return 0, validation("必须提供作品修订号 basis_revision")
	}
	revision, err := strconv.Atoi(value)
	if err != nil || revision < 1 {
		return 0, validation("作品修订号无效")
	}
	return revision, nil
}

func (s *Server) buildToutiaoPack(ctx context.Context, workID uuid.UUID, basis int, allowReady bool) (*toutiaoPackBuild, *toutiaoPackSource, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	source := &toutiaoPackSource{}
	var platform string
	err = tx.QueryRow(ctx, `SELECT w.status,w.content_format,w.revision,w.title,w.topics,a.platform
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND w.deleted_at IS NULL AND a.workspace_id=$2 FOR SHARE OF w`, workID, ident(ctx).WorkspaceID).
		Scan(&source.Status, &source.Format, &source.Revision, &source.Title, &source.Topics, &platform)
	if err != nil {
		return nil, nil, err
	}
	if platform != "toutiao" {
		return nil, nil, validation("只有今日头条作品可以使用头条发布包")
	}
	if source.Format != "long_article" && source.Format != "micro_post" {
		return nil, nil, validation("头条发布包不支持当前作品形态")
	}
	if source.Revision != basis {
		return nil, nil, packVersionConflict(source.Revision)
	}
	if source.Status != "packed" && source.Status != "published" && !(allowReady && source.Status == "ready") {
		if source.Status == "reviewing" {
			return nil, nil, humanStep("H-09", "这篇作品需要审阅，审阅通过后才能生成发布包")
		}
		return nil, nil, humanStep("H-04", "发布前检查还没有全部确认，不能生成发布包")
	}
	if err := s.checkLatestMaterialBasis(ctx, tx, workID); err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id,heading,content_md FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position,created_at,id`, workID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var section toutiaoPackSection
		if err := rows.Scan(&section.ID, &section.Heading, &section.Content); err != nil {
			rows.Close()
			return nil, nil, err
		}
		source.Sections = append(source.Sections, section)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if source.Sections == nil {
		source.Sections = []toutiaoPackSection{}
	}
	if source.Topics == nil {
		source.Topics = []string{}
	}
	wanted, err := toutiaoPackAssetUses(source)
	if err != nil {
		return nil, nil, err
	}
	if source.Format == "micro_post" {
		rows, err = tx.Query(ctx, `SELECT id,storage_path,mime,bytes,sha256,position,coalesce(ai_generated,false),coalesce(alt_text,'')
			FROM asset WHERE work_id=$1 ORDER BY position,id`, workID)
	} else if len(wanted) > 0 {
		ids := make([]uuid.UUID, 0, len(wanted))
		for id := range wanted {
			ids = append(ids, id)
		}
		rows, err = tx.Query(ctx, `SELECT id,storage_path,mime,bytes,sha256,position,coalesce(ai_generated,false),coalesce(alt_text,'')
			FROM asset WHERE work_id=$1 AND id=ANY($2) ORDER BY position,id`, workID, ids)
	} else {
		rows = nil
	}
	if err != nil {
		return nil, nil, err
	}
	if rows != nil {
		for rows.Next() {
			var asset toutiaoPackAsset
			if err := rows.Scan(&asset.ID, &asset.StoragePath, &asset.Mime, &asset.Bytes, &asset.SHA256, &asset.Position, &asset.AIGenerated, &asset.AltText); err != nil {
				rows.Close()
				return nil, nil, err
			}
			if asset.StoragePath == "" || asset.Bytes < 1 || len(asset.SHA256) != 64 || (asset.Mime != "image/jpeg" && asset.Mime != "image/png") {
				rows.Close()
				return nil, nil, stateInvalid("发布包所需图片信息不完整，请重新上传图片")
			}
			if uses, ok := wanted[asset.ID]; ok {
				asset.Uses = uses
			}
			source.Assets = append(source.Assets, asset)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	if source.Format == "long_article" && len(wanted) != len(source.Assets) {
		return nil, nil, stateInvalid("文章引用了缺失、外链或不属于本作品的图片；请在图片库中重新选择")
	}
	if err := tx.QueryRow(ctx, toutiaoOtherPlatformPublishedSQL, workID).Scan(&source.OtherPlatformPublished); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return assembleToutiaoPack(s, workID, source)
}

const toutiaoOtherPlatformPublishedSQL = `WITH RECURSIVE family(id) AS (
	SELECT $1::uuid
	UNION
	SELECT related.id
	FROM family f
	JOIN LATERAL (
		SELECT w.source_work_id AS id FROM work w WHERE w.id=f.id AND w.source_work_id IS NOT NULL
		UNION
		SELECT child.id FROM work child WHERE child.source_work_id=f.id
	) related ON related.id IS NOT NULL
)
SELECT EXISTS(SELECT 1 FROM work w JOIN platform_account a ON a.id=w.account_id JOIN family f ON f.id=w.id
	WHERE w.status='published' AND a.platform<>'toutiao' AND w.deleted_at IS NULL)`

func toutiaoPackAssetUses(source *toutiaoPackSource) (map[uuid.UUID][]toutiaoPackUse, error) {
	uses := map[uuid.UUID][]toutiaoPackUse{}
	if source.Format != "long_article" {
		return uses, nil
	}
	for _, section := range source.Sections {
		ordinal := 0
		for _, match := range toutiaoImageMarkdown.FindAllStringSubmatch(section.Content, -1) {
			ordinal++
			assetID, ok := assetIDFromURL(strings.TrimSpace(match[2]))
			if !ok {
				return nil, stateInvalid("文章含有尚未保存到本作品图片库的图片；请先上传或选择图片")
			}
			uses[assetID] = append(uses[assetID], toutiaoPackUse{SectionID: section.ID.String(), Ordinal: ordinal, Alt: match[1]})
		}
	}
	return uses, nil
}

func assembleToutiaoPack(s *Server, workID uuid.UUID, source *toutiaoPackSource) (*toutiaoPackBuild, *toutiaoPackSource, error) {
	if source.Format == "long_article" {
		sectionOrder := map[uuid.UUID]int{}
		for i, section := range source.Sections {
			sectionOrder[section.ID] = i
		}
		sort.SliceStable(source.Assets, func(i, j int) bool {
			left, right := source.Assets[i], source.Assets[j]
			leftSection, leftOrdinal := toutiaoFirstUse(left.Uses, sectionOrder)
			rightSection, rightOrdinal := toutiaoFirstUse(right.Uses, sectionOrder)
			if leftSection != rightSection {
				return leftSection < rightSection
			}
			if leftOrdinal != rightOrdinal {
				return leftOrdinal < rightOrdinal
			}
			return left.ID.String() < right.ID.String()
		})
	}
	assetsByID := map[uuid.UUID]*toutiaoPackAsset{}
	for i := range source.Assets {
		asset := &source.Assets[i]
		ext := ".jpg"
		if asset.Mime == "image/png" {
			ext = ".png"
		}
		asset.File = fmt.Sprintf("images/%02d%s", i+1, ext)
		assetsByID[asset.ID] = asset
	}
	body := toutiaoPackBody(source)
	if strings.TrimSpace(body) == "" {
		return nil, nil, stateInvalid("发布包正文不能为空")
	}
	view := toutiaoPackView{
		WorkID: workID, Platform: "toutiao", ContentFormat: source.Format, BasisRevision: source.Revision,
		InternalTitle: source.Title, BodyText: body, BodyChars: runeLen(body), Topics: append([]string{}, source.Topics...),
		Instructions: toutiaoInstructions(source.Format), Images: []toutiaoPackImage{}, Warnings: []string{"头条平台篇幅和图片上限待实测，请以发布页为准。", "发布前按真实创作情况核对 AI 内容声明；系统不会代替平台声明。", "首发默认不选；系统中没有其他发布记录也不能证明符合首发条件。", "发布前请核实原创资格；系统检查通过不代表符合平台声明条件。"},
	}
	if source.Format == "long_article" {
		title := source.Title
		view.PublishTitle = &title
	}
	if source.OtherPlatformPublished {
		view.Warnings = append(view.Warnings, "作品家族已有其他平台发布记录，请勿直接声明头条首发。")
	}
	if toutiaoHasLossyBlocks(source) {
		view.Warnings = append(view.Warnings, "代码块或表格已降为可读文本；请在头条发布预览中核对格式。")
	}
	files := map[string][]byte{"body.txt": []byte(body), "topics.txt": []byte(toutiaoTopicsText(source.Topics)), "发布说明.txt": []byte(toutiaoInstructions(source.Format))}
	if source.Format == "long_article" {
		files["title.txt"] = []byte(source.Title)
		files["article.html"] = []byte(toutiaoArticleHTML(source, assetsByID))
	}
	imageMaps := []map[string]any{}
	for _, asset := range source.Assets {
		data, err := s.readToutiaoPackAsset(asset)
		if err != nil {
			return nil, nil, err
		}
		files[asset.File] = data
		image := toutiaoPackImage{AssetID: asset.ID, File: asset.File, URL: "/api/v1/assets/" + asset.ID.String() + "/file", Position: asset.Position, Mime: asset.Mime, AIGenerated: asset.AIGenerated, AltText: asset.AltText}
		if source.Format == "long_article" {
			image.Uses = append([]toutiaoPackUse{}, asset.Uses...)
			uses := make([]map[string]any, 0, len(asset.Uses))
			for _, use := range asset.Uses {
				uses = append(uses, map[string]any{"section_id": use.SectionID, "ordinal": use.Ordinal, "alt": use.Alt})
			}
			imageMaps = append(imageMaps, map[string]any{"asset_id": asset.ID, "file": asset.File, "uses": uses})
		} else {
			imageMaps = append(imageMaps, map[string]any{"asset_id": asset.ID, "file": asset.File, "position": asset.Position})
		}
		view.Images = append(view.Images, image)
	}
	imageMapJSON, err := json.MarshalIndent(imageMaps, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	files["image-map.json"] = append(imageMapJSON, '\n')
	manifest := toutiaoPackManifest{
		SchemaVersion: 1, Platform: "toutiao", ContentFormat: source.Format, WorkID: workID, BasisRevision: source.Revision,
		GeneratedAt: time.Now().In(time.FixedZone("Asia/Shanghai", 8*60*60)), InternalTitle: source.Title,
		PublishTitle: view.PublishTitle, BodyFile: "body.txt", TopicsFile: "topics.txt", Images: toutiaoManifestImages(view.Images),
	}
	for name, data := range files {
		manifest.Files = append(manifest.Files, toutiaoPackFile{Name: name, SHA: secure.SHA256Hex(data), Size: len(data)})
	}
	sort.Slice(manifest.Files, func(i, j int) bool { return manifest.Files[i].Name < manifest.Files[j].Name })
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	files["manifest.json"] = append(manifestJSON, '\n')
	return &toutiaoPackBuild{View: view, Files: files}, source, nil
}

func toutiaoManifestImages(images []toutiaoPackImage) []toutiaoManifestImage {
	result := make([]toutiaoManifestImage, 0, len(images))
	for _, image := range images {
		result = append(result, toutiaoManifestImage{
			AssetID: image.AssetID, File: image.File, Position: image.Position, Mime: image.Mime,
			AIGenerated: image.AIGenerated, Uses: image.Uses,
		})
	}
	return result
}

func toutiaoPackBody(source *toutiaoPackSource) string {
	parts := []string{}
	for _, section := range source.Sections {
		if source.Format == "long_article" && strings.TrimSpace(section.Heading) != "" {
			parts = append(parts, strings.TrimSpace(section.Heading))
		}
		text := toutiaoMarkdownPlain(section.Content)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

func toutiaoFirstUse(uses []toutiaoPackUse, sectionOrder map[uuid.UUID]int) (int, int) {
	if len(uses) == 0 {
		return int(^uint(0) >> 1), int(^uint(0) >> 1)
	}
	sectionID, _ := uuid.Parse(uses[0].SectionID)
	return sectionOrder[sectionID], uses[0].Ordinal
}

func toutiaoHasLossyBlocks(source *toutiaoPackSource) bool {
	for _, section := range source.Sections {
		for _, line := range strings.Split(strings.ReplaceAll(section.Content, "\r\n", "\n"), "\n") {
			if toutiaoTableRow.MatchString(line) || toutiaoCodeFence.MatchString(line) {
				return true
			}
		}
	}
	return false
}

func toutiaoMarkdownPlain(markdown string) string {
	markdown = toutiaoImageMarkdown.ReplaceAllString(markdown, "")
	markdown = toutiaoLinkMarkdown.ReplaceAllString(markdown, "$1")
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	for i, line := range lines {
		line = toutiaoHTMLTag.ReplaceAllString(line, "")
		line = strings.TrimSpace(line)
		if toutiaoTableRow.MatchString(line) {
			cells := strings.Split(strings.Trim(strings.TrimSpace(line), "|"), "|")
			for j := range cells {
				cells[j] = strings.TrimSpace(cells[j])
			}
			if len(cells) > 0 && toutiaoTableSeparator.MatchString(cells[0]) {
				lines[i] = ""
				continue
			}
			line = strings.Join(cells, " / ")
		}
		line = toutiaoMarkdownHeading.ReplaceAllString(line, "")
		line = strings.TrimPrefix(line, "> ")
		line = strings.TrimPrefix(line, "- ")
		line = strings.TrimPrefix(line, "+ ")
		line = strings.TrimPrefix(line, "* ")
		line = toutiaoMarkdownNumber.ReplaceAllString(line, "$1. ")
		line = toutiaoMarkdownEmphasis.ReplaceAllString(line, "$2$4$6$8")
		line = toutiaoMarkdownStrike.ReplaceAllString(line, "$1")
		line = toutiaoMarkdownCode.ReplaceAllString(line, "$1")
		lines[i] = html.UnescapeString(line)
	}
	return strings.TrimSpace(regexp.MustCompile(`\n{3,}`).ReplaceAllString(strings.Join(lines, "\n"), "\n\n"))
}

func toutiaoTopicsText(topics []string) string {
	seen := map[string]bool{}
	lines := []string{}
	for _, topic := range topics {
		topic = strings.TrimSpace(strings.TrimPrefix(topic, "#"))
		if topic == "" || seen[topic] {
			continue
		}
		seen[topic] = true
		lines = append(lines, "#"+topic)
	}
	return strings.Join(lines, "\n")
}

func toutiaoArticleHTML(source *toutiaoPackSource, assets map[uuid.UUID]*toutiaoPackAsset) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>")
	b.WriteString(html.EscapeString(source.Title))
	b.WriteString("</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;line-height:1.8;color:#222}img{max-width:100%;height:auto}blockquote{border-left:3px solid #bbb;margin:1em 0;padding-left:1em;color:#555}</style></head><body><h1>")
	b.WriteString(html.EscapeString(source.Title))
	b.WriteString("</h1>")
	for _, section := range source.Sections {
		if heading := strings.TrimSpace(section.Heading); heading != "" {
			b.WriteString("<h2>")
			b.WriteString(html.EscapeString(heading))
			b.WriteString("</h2>")
		}
		lines := strings.Split(strings.ReplaceAll(section.Content, "\r\n", "\n"), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || toutiaoCodeFence.MatchString(line) {
				continue
			}
			if toutiaoTableRow.MatchString(line) {
				plain := toutiaoMarkdownPlain(line)
				if plain != "" {
					b.WriteString("<p>")
					b.WriteString(html.EscapeString(plain))
					b.WriteString("</p>")
				}
			} else if strings.HasPrefix(line, "### ") || strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# ") {
				line = strings.TrimLeft(line, "# ")
				b.WriteString("<h3>")
				b.WriteString(toutiaoInlineHTML(line, assets))
				b.WriteString("</h3>")
			} else if strings.HasPrefix(line, "> ") {
				b.WriteString("<blockquote>")
				b.WriteString(toutiaoInlineHTML(strings.TrimPrefix(line, "> "), assets))
				b.WriteString("</blockquote>")
			} else if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") || strings.HasPrefix(line, "+ ") {
				b.WriteString("<p>• ")
				b.WriteString(toutiaoInlineHTML(line[2:], assets))
				b.WriteString("</p>")
			} else {
				b.WriteString("<p>")
				b.WriteString(toutiaoInlineHTML(line, assets))
				b.WriteString("</p>")
			}
		}
	}
	b.WriteString("</body></html>")
	return b.String()
}

func toutiaoInlineHTML(line string, assets map[uuid.UUID]*toutiaoPackAsset) string {
	var out strings.Builder
	last := 0
	for _, match := range toutiaoImageMarkdown.FindAllStringSubmatchIndex(line, -1) {
		out.WriteString(toutiaoInlineText(line[last:match[0]]))
		alt := line[match[2]:match[3]]
		assetID, ok := assetIDFromURL(strings.TrimSpace(line[match[4]:match[5]]))
		if ok {
			if asset := assets[assetID]; asset != nil {
				out.WriteString(`<img src="` + html.EscapeString(asset.File) + `" alt="` + html.EscapeString(alt) + `">`)
			}
		}
		last = match[1]
	}
	out.WriteString(toutiaoInlineText(line[last:]))
	return out.String()
}

func toutiaoInlineText(line string) string {
	line = html.EscapeString(line)
	line = toutiaoLinkMarkdown.ReplaceAllStringFunc(line, func(value string) string {
		match := toutiaoLinkMarkdown.FindStringSubmatch(value)
		u, err := url.Parse(html.UnescapeString(match[2]))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return html.EscapeString(match[1])
		}
		return `<a href="` + html.EscapeString(u.String()) + `" rel="noopener noreferrer">` + html.EscapeString(match[1]) + `</a>`
	})
	line = regexp.MustCompile(`\*\*(.+?)\*\*`).ReplaceAllString(line, "<strong>$1</strong>")
	line = regexp.MustCompile("`([^`]+)`").ReplaceAllString(line, "<code>$1</code>")
	return line
}

func toutiaoInstructions(format string) string {
	if format == "micro_post" {
		return "今日头条微头条手动发布步骤\n1. 登录今日头条创作后台并选择发布微头条。\n2. 复制 body.txt；按 image-map.json 的顺序逐张上传 images/ 中的图片。\n3. 在平台话题选择器中核对并添加 topics.txt 中的话题。\n4. 预览正文、表情和图片，按真实情况处理 AI 声明；首发默认不选并核实原创资格。\n5. 由你本人发布；审核中或状态不明时不要猜测发布时间。\n6. 回到系统人工填写已发布链接和实际发布时间。\n\n系统没有登录或代发，也不验证平台发布状态。\n"
	}
	return "今日头条文章手动发布步骤\n1. 登录今日头条创作后台并选择发布文章。\n2. 将 title.txt 作为发布标题，复制 body.txt；解压后用 article.html 参照基础格式和图片位置。\n3. 按 image-map.json 的段落位置逐张上传 images/ 中的图片；在平台预览中手动调整排版和封面。\n4. 核对 topics.txt；按真实情况处理 AI 声明，首发默认不选并核实原创资格。\n5. 由你本人发布；审核中或状态不明时不要猜测发布时间。\n6. 回到系统人工填写已发布链接和实际发布时间。\n\nHTML 仅供离线参照，不代表平台支持导入 HTML；受保护的系统图片不能直接粘贴。\n"
}

func (s *Server) readToutiaoPackAsset(asset toutiaoPackAsset) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(s.cfg.DataDir, filepath.FromSlash(asset.StoragePath)))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, stateInvalid("发布包图片文件缺失，请重新上传图片")
		}
		return nil, fmt.Errorf("read Toutiao pack image: %w", err)
	}
	if int64(len(data)) != asset.Bytes || secure.SHA256Hex(data) != asset.SHA256 {
		return nil, stateInvalid("发布包图片校验失败，请重新上传图片")
	}
	return data, nil
}

func writeToutiaoZipEntry(w *zip.Writer, name string, data []byte) error {
	if filepath.IsAbs(name) || strings.Contains(name, "..") || strings.Contains(name, "\\") {
		return validation("发布包文件名无效")
	}
	f, err := w.Create(name)
	if err != nil {
		return err
	}
	n, err := f.Write(data)
	if err != nil {
		return err
	}
	if n != len(data) {
		return io.ErrShortWrite
	}
	return nil
}

func writeToutiaoPackZip(dst io.Writer, files map[string][]byte) error {
	writer := zip.NewWriter(dst)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := writeToutiaoZipEntry(writer, name, files[name]); err != nil {
			_ = writer.Close()
			return err
		}
	}
	return writer.Close()
}

func (s *Server) verifyToutiaoPackBasis(ctx context.Context, workID uuid.UUID, basis int, initialStatus string) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var revision int
	var status, platform string
	if err := tx.QueryRow(ctx, `SELECT w.revision,w.status,a.platform FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND w.deleted_at IS NULL AND a.workspace_id=$2 FOR SHARE OF w`, workID, ident(ctx).WorkspaceID).Scan(&revision, &status, &platform); err != nil {
		return err
	}
	if platform != "toutiao" || revision != basis {
		return packVersionConflict(revision)
	}
	if status != "packed" && status != "published" {
		if initialStatus == "ready" && status == "ready" {
			return packVersionConflict(revision)
		}
		return stateInvalid("作品状态已变化，请重新生成发布包")
	}
	if err := s.checkLatestMaterialBasis(ctx, tx, workID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
