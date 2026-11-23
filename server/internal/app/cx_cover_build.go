package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"image/png"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// DEV-CX10：cover_images 构建输入与 ZIP 校验链（24 §5.2 FR-CX-09）。
//
// 多比例封面是同一作品的一次只读构建：沿用原图与 cover_crops 坐标，不覆盖 asset 字节、
// 不新建派生 asset、不改 cover_crops；公众号推送继续传 cover_crops，导出只是 build artifact。
// 预设以平台+像素标识，两种 1:1（383×383 与 1080×1080）各自独立，不共用尺寸或文件名。

const cxCoverTemplateVersion = "ops.cover-images/v1"

// cxOfficeTemplateVersion 是 C3 PPTX/DOCX 确定性导出的渲染器模板版本。
const cxOfficeTemplateVersion = "office-render-v1"

const (
	cxCoverZipMaxEntries    = 8
	cxCoverZipMaxEntryBytes = 12 << 20
	cxCoverZipMaxTotalBytes = 48 << 20
)

// cxCoverCopyRules 是 C2 封面文案规则：主/副标题 rune 上限、语气、必须/禁止元素、
// 换行建议。首版为代码常量并单测锁定（docs/41 C2-A1）；规则只约束封面文案，
// 不改正文标题；后续可迁 DB 配置。
type cxCoverCopyRules struct {
	TitleMax      int      `json:"title_max"`
	SubtitleMax   int      `json:"subtitle_max"`
	Tone          string   `json:"tone"`
	Required      []string `json:"required"`
	Forbidden     []string `json:"forbidden"`
	LineBreakHint string   `json:"line_break_hint"`
}

// cxCoverPresetSpec 是设计规定的封面预设；尺寸是本期设计像素而非平台硬要求，
// 两种 1:1 必须以平台前缀区分（wechat_square 383×383 / xhs_square 1080×1080）。
type cxCoverPresetSpec struct {
	ID        string
	Platform  string
	Width     int
	Height    int
	CopyRules cxCoverCopyRules
}

var cxCoverPresets = []cxCoverPresetSpec{
	{ID: "wechat_235", Platform: "wechat_mp", Width: 900, Height: 383, CopyRules: cxCoverCopyRules{
		TitleMax: 10, SubtitleMax: 16, Tone: "信息/稳重",
		Required:  []string{},
		Forbidden: []string{"！", "？", "震惊", "必看"},
		LineBreakHint: "主标题一行；副标题可两行，第二行不超过 8 字",
	}},
	{ID: "wechat_square", Platform: "wechat_mp", Width: 383, Height: 383, CopyRules: cxCoverCopyRules{
		TitleMax: 10, SubtitleMax: 16, Tone: "信息/稳重",
		Required:  []string{},
		Forbidden: []string{"！", "？", "震惊", "必看"},
		LineBreakHint: "小图空间有限，主标题尽量 ≤8 字保证缩略可读",
	}},
	{ID: "xhs_34", Platform: "xhs", Width: 1080, Height: 1440, CopyRules: cxCoverCopyRules{
		TitleMax: 12, SubtitleMax: 18, Tone: "具体/口语",
		Required:  []string{"人群或结果"},
		Forbidden: []string{"震惊", "必看"},
		LineBreakHint: "主标题最多两行，每行 ≤6 字；副标题一行",
	}},
	{ID: "xhs_square", Platform: "xhs", Width: 1080, Height: 1080, CopyRules: cxCoverCopyRules{
		TitleMax: 12, SubtitleMax: 18, Tone: "具体/口语",
		Required:  []string{"人群或结果"},
		Forbidden: []string{"震惊", "必看"},
		LineBreakHint: "主标题最多两行，每行 ≤6 字；副标题一行",
	}},
	{ID: "xhs_916", Platform: "xhs", Width: 1080, Height: 1920, CopyRules: cxCoverCopyRules{
		TitleMax: 12, SubtitleMax: 18, Tone: "具体/口语",
		Required:  []string{"人群或结果"},
		Forbidden: []string{"震惊", "必看"},
		LineBreakHint: "主标题最多两行，每行 ≤6 字；副标题一行",
	}},
}

func cxCoverPreset(id string) (cxCoverPresetSpec, bool) {
	for _, preset := range cxCoverPresets {
		if preset.ID == id {
			return preset, true
		}
	}
	return cxCoverPresetSpec{}, false
}

// cxBuildCoverOptions 是 cover_images 唯一已登记的 options schema；
// C2 增加文案字段，逐 preset 校验后才进冻结参数。
type cxBuildCoverOptions struct {
	Presets  []string `json:"presets"`
	Title    string   `json:"title"`
	Subtitle string   `json:"subtitle"`
}

func (o *cxBuildCoverOptions) UnmarshalJSON(raw []byte) error {
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	if err := cxRequireJSONFields(raw, "presets"); err != nil {
		return err
	}
	type plain cxBuildCoverOptions
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*o = cxBuildCoverOptions(value)
	return nil
}

// cxCoverPresetsCanonical 把用户选择的预设固定为设计顺序：params_hash 只由集合决定，
// 与客户端提交顺序无关。非法或重复预设按 FR-CX-09 返回 invalid_ratio。
func cxCoverPresetsCanonical(ids []string) ([]string, error) {
	if len(ids) == 0 || len(ids) > len(cxCoverPresets) {
		return nil, validationFields("封面构建必须选择 1..5 个预设", map[string]string{"presets": "invalid"})
	}
	selected := make(map[string]bool, len(ids))
	for _, id := range ids {
		if _, ok := cxCoverPreset(id); !ok {
			return nil, validationFields("封面预设无效", map[string]string{"presets": "invalid_ratio"})
		}
		if selected[id] {
			return nil, validationFields("封面预设不能重复", map[string]string{"presets": "invalid_ratio"})
		}
		selected[id] = true
	}
	ordered := make([]string, 0, len(ids))
	for _, preset := range cxCoverPresets {
		if selected[preset.ID] {
			ordered = append(ordered, preset.ID)
		}
	}
	return ordered, nil
}

// cxCoverBuildOptionValue 规范化为 canonical JSON 可编码值；C2：逐 preset
// 校验文案（超长/禁用词/空标题 422），失败不产生冻结参数。
func cxCoverBuildOptionValue(options cxBuildCoverOptions) (map[string]any, error) {
	ordered, err := cxCoverPresetsCanonical(options.Presets)
	if err != nil {
		return nil, err
	}
	// C2-N3：文案校验只作用于新构建提交的文案（title/subtitle 至少一个非空）；
	// 旧客户端/无文案请求不回溯校验，保持既有构建行为不变。
	hasCopy := strings.TrimSpace(options.Title) != "" || strings.TrimSpace(options.Subtitle) != ""
	values := make([]any, 0, len(ordered))
	for _, id := range ordered {
		preset, _ := cxCoverPreset(id)
		if hasCopy {
			if err := cxValidateCoverCopy(preset, cxCoverCopyInput{Title: options.Title, Subtitle: options.Subtitle}); err != nil {
				return nil, err
			}
		}
		values = append(values, id)
	}
	value := map[string]any{"presets": values}
	if t := strings.TrimSpace(options.Title); t != "" {
		value["title"] = t
	}
	if sub := strings.TrimSpace(options.Subtitle); sub != "" {
		value["subtitle"] = sub
	}
	return value, nil
}

// cxValidateCoverBuildAgainstSnapshot 以冻结来源复核封面构建前提：
// 预设必须属于作品平台（默认仅当前平台合法预设），且作品确实选定了封面。
func cxValidateCoverBuildAgainstSnapshot(options cxBuildCoverOptions, platform string, snapshot map[string]any) error {
	for _, id := range options.Presets {
		preset, ok := cxCoverPreset(id)
		if !ok || preset.Platform != platform {
			return apiErr(http.StatusUnprocessableEntity, "invalid_ratio", "封面预设不适用于当前作品平台")
		}
	}
	work, ok := snapshot["work"].(map[string]any)
	if !ok {
		return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照缺少作品信息")
	}
	if cxString(work["cover_asset_id"]) == "" {
		return apiErr(http.StatusUnprocessableEntity, "cover_missing", "请先在图片卡选择封面，再生成多比例封面")
	}
	return nil
}

// cxCoverFileName 与两端渲染器一致：cover-{preset}-{w}x{h}.png，平台+像素防重名。
func cxCoverFileName(preset cxCoverPresetSpec) string {
	return "cover-" + preset.ID + "-" + strconv.Itoa(preset.Width) + "x" + strconv.Itoa(preset.Height) + ".png"
}

// cxValidateCoverZIP 逐条目验证封面交付包；任何一项不符整组失败（24 §FR-CX-09）。
func cxValidateCoverZIP(data []byte, options cxBuildCoverOptions) ([]cxCardsZIPEntry, *APIError) {
	ordered, err := cxCoverPresetsCanonical(options.Presets)
	if err != nil {
		return nil, apiErr(http.StatusConflict, "build_input_mismatch", "冻结的封面构建参数无法解析")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_invalid", "封面交付包不是可解析的 ZIP")
	}
	if len(reader.File) > cxCoverZipMaxEntries {
		return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_invalid", "封面交付包条目数超过上限")
	}
	expected := make([]string, 0, len(ordered))
	expectedSizes := make([][2]int, 0, len(ordered))
	for _, id := range ordered {
		preset, _ := cxCoverPreset(id)
		expected = append(expected, cxCoverFileName(preset))
		expectedSizes = append(expectedSizes, [2]int{preset.Width, preset.Height})
	}
	if len(reader.File) != len(expected) {
		return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_entry_mismatch", "封面交付包条目数与所选预设不一致")
	}
	seen := map[string]bool{}
	entries := make([]cxCardsZIPEntry, 0, len(reader.File))
	var total int64
	for index, file := range reader.File {
		name := file.Name
		if file.FileInfo().IsDir() || strings.ContainsAny(name, "\x00\r\n") || path.Base(name) != name || strings.HasPrefix(name, ".") {
			return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_unsafe_entry", "封面交付包包含不安全的条目路径")
		}
		if seen[name] {
			return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_unsafe_entry", "封面交付包包含重复条目")
		}
		seen[name] = true
		if name != expected[index] {
			return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_entry_mismatch", "封面交付包条目名称或顺序与所选预设不一致").With(map[string]any{
				"expected": expected[index], "actual": name, "position": index + 1,
			})
		}
		if file.UncompressedSize64 > cxCoverZipMaxEntryBytes {
			return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_invalid", "封面交付包单个条目超过大小上限")
		}
		total += int64(file.UncompressedSize64)
		if total > cxCoverZipMaxTotalBytes {
			return nil, apiErr(http.StatusUnprocessableEntity, "cover_zip_invalid", "封面交付包解压总量超过上限")
		}
		entry, apiErrValue := cxInspectZIPEntryPNG(file, name, expectedSizes[index][0], expectedSizes[index][1], cxCoverPNGCodes, "封面")
		if apiErrValue != nil {
			return nil, apiErrValue
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// cxPNGEntryCodes 区分组图与封面在 PNG 条目校验里的错误码，避免用组图前缀报封面的错。
type cxPNGEntryCodes struct {
	Unreadable string
	Invalid    string
}

var (
	cxCardsPNGCodes = cxPNGEntryCodes{Unreadable: "cards_zip_invalid", Invalid: "cards_image_invalid"}
	cxCoverPNGCodes = cxPNGEntryCodes{Unreadable: "cover_zip_invalid", Invalid: "cover_image_invalid"}
)

// cxInspectZIPEntryPNG 校验 zip 条目是精确尺寸、可完整解码且非空白的 PNG。
// subject 只用于错误文案（"组图卡片"/"封面"）。
func cxInspectZIPEntryPNG(file *zip.File, name string, width, height int, codes cxPNGEntryCodes, subject string) (cxCardsZIPEntry, *APIError) {
	stream, err := file.Open()
	if err != nil {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Unreadable, subject+"交付包条目无法读取")
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, cxCardsZipMaxEntryBytes+1))
	if err != nil || int64(len(data)) > cxCardsZipMaxEntryBytes {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Unreadable, subject+"交付包条目无法完整读取")
	}
	if !strings.HasSuffix(strings.ToLower(name), ".png") || len(data) < 8 || !bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")) {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Invalid, subject+"交付包只接受 PNG 条目")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != width || config.Height != height {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Invalid, subject+"像素与所选规格不一致").With(map[string]any{
			"expected_width": width, "expected_height": height,
		})
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Invalid, subject+"PNG 无法完整解码")
	}
	bounds := decoded.Bounds()
	first := decoded.At(bounds.Min.X, bounds.Min.Y)
	firstR, firstG, firstB, firstA := first.RGBA()
	varies, visible := false, false
	for y := bounds.Min.Y; y < bounds.Max.Y && (!varies || !visible); y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, a := decoded.At(x, y).RGBA()
			if r != firstR || g != firstG || b != firstB || a != firstA {
				varies = true
			}
			if a > 0 {
				visible = true
			}
			if varies && visible {
				break
			}
		}
	}
	if !visible || !varies {
		return cxCardsZIPEntry{}, apiErr(http.StatusUnprocessableEntity, codes.Invalid, subject+"没有可辨识的图像内容")
	}
	return cxCardsZIPEntry{Name: name, Width: config.Width, Height: config.Height, Bytes: int64(len(data)), SHA256: cxSHA256(data)}, nil
}

// cxBuildCoverOptionsFromParams 从冻结 params 取回封面 options，供 complete 复核。
func cxBuildCoverOptionsFromParams(raw []byte) (cxBuildCoverOptions, error) {
	var params struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return cxBuildCoverOptions{}, err
	}
	if len(params.Options) == 0 {
		return cxBuildCoverOptions{}, errors.New("构建参数缺少 options")
	}
	var options cxBuildCoverOptions
	if err := json.Unmarshal(params.Options, &options); err != nil {
		return cxBuildCoverOptions{}, err
	}
	return options, nil
}

// cxCoverAssetInSnapshot 确认封面资产在冻结快照里（创建时已由来源快照强制存在）。
func cxCoverAssetInSnapshot(snapshot map[string]any) bool {
	work, ok := snapshot["work"].(map[string]any)
	if !ok {
		return false
	}
	coverID := cxString(work["cover_asset_id"])
	if coverID == "" {
		return false
	}
	parsed, err := uuid.Parse(coverID)
	return err == nil && parsed != uuid.Nil && cxBuildHasAsset(snapshotAssets(snapshot), parsed)
}

func snapshotAssets(snapshot map[string]any) []any {
	assets, _ := snapshot["assets"].([]any)
	return assets
}

// cxCoverCopyInput 是封面构建的文案输入：去空白后按 rune 计数（C2-A3）。
type cxCoverCopyInput struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
}

// cxValidateCoverCopy 校验单个 preset 的封面文案：
// 空标题 → cover_copy_required；超长 → cover_copy_too_long；禁用词 → cover_copy_forbidden。
// 失败返回 422 + {preset, field, max, actual}，生成前调用，不写产物（C2-A2）。
func cxValidateCoverCopy(preset cxCoverPresetSpec, in cxCoverCopyInput) error {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return apiErr(http.StatusUnprocessableEntity, "cover_copy_required", "封面主标题不能为空").With(
			map[string]any{"preset": preset.ID, "field": "title"})
	}
	if n := utf8.RuneCountInString(title); n > preset.CopyRules.TitleMax {
		return apiErr(http.StatusUnprocessableEntity, "cover_copy_too_long",
			"主标题超长：上限 "+strconv.Itoa(preset.CopyRules.TitleMax)+" 字").With(
			map[string]any{"preset": preset.ID, "field": "title", "max": preset.CopyRules.TitleMax, "actual": n})
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(in.Subtitle)); n > preset.CopyRules.SubtitleMax {
		return apiErr(http.StatusUnprocessableEntity, "cover_copy_too_long",
			"副标题超长：上限 "+strconv.Itoa(preset.CopyRules.SubtitleMax)+" 字").With(
			map[string]any{"preset": preset.ID, "field": "subtitle", "max": preset.CopyRules.SubtitleMax, "actual": n})
	}
	for _, word := range preset.CopyRules.Forbidden {
		if strings.Contains(title, word) || strings.Contains(in.Subtitle, word) {
			return apiErr(http.StatusUnprocessableEntity, "cover_copy_forbidden",
				"封面文案包含禁用词："+word).With(
				map[string]any{"preset": preset.ID, "field": "title", "forbidden": word})
		}
	}
	return nil
}

// coverPresetsHandler GET /cover-presets：返回预设与文案规则（C2-A4）。
func (s *Server) coverPresetsHandler(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	type presetOut struct {
		Key       string            `json:"key"`
		Platform  string            `json:"platform"`
		Width     int               `json:"width"`
		Height    int               `json:"height"`
		CopyRules cxCoverCopyRules  `json:"copy_rules"`
	}
	list := make([]presetOut, 0, len(cxCoverPresets))
	for _, preset := range cxCoverPresets {
		list = append(list, presetOut{Key: preset.ID, Platform: preset.Platform,
			Width: preset.Width, Height: preset.Height, CopyRules: preset.CopyRules})
	}
	writeJSON(w, http.StatusOK, map[string]any{"presets": list})
	return nil
}
