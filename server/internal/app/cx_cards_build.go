package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// DEV-CX09：xhs_cards 构建输入与 ZIP 校验链（24 §5.2 FR-CX-08、§E.4）。
//
// options.cards 是用户逐卡确认计划后的采用结果，结构与 cards/preview 返回的规范卡片一致，
// 因此 preview 的 params_hash 可直接用于创建与完成构建。服务端不信任客户端 zip：
// 逐条目校验名称/顺序/尺寸/哈希/解码，拒绝目录、穿越路径、非 PNG 与超预算条目。

const (
	cxCardsZipMaxEntries    = 12
	cxCardsZipMaxEntryBytes = 12 << 20
	cxCardsZipMaxTotalBytes = 128 << 20
)

// cxBuildCardsOptions 是 xhs_cards 唯一已登记的 options schema。
type cxBuildCardsOptions struct {
	Template        string               `json:"template"`
	Ratio           string               `json:"ratio"`
	DNAVersion      *int64               `json:"dna_version"`
	Cards           []cxCardsBuildOption `json:"cards"`
	TemplateVersion string               `json:"template_version"`
	VisualPlan      json.RawMessage      `json:"visual_plan,omitempty"`
}

func (o *cxBuildCardsOptions) UnmarshalJSON(raw []byte) error {
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	if err := cxRequireJSONFields(raw, "template", "ratio", "dna_version", "cards", "template_version"); err != nil {
		return err
	}
	type plain cxBuildCardsOptions
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*o = cxBuildCardsOptions(value)
	return nil
}

// cxCardsRatioSize 返回设计规定的精确像素；比例之外不接受任何尺寸。
func cxCardsRatioSize(ratio string) (int, int, bool) {
	switch ratio {
	case "1:1":
		return 1080, 1080, true
	case "3:4":
		return 1080, 1440, true
	case "9:16":
		return 1080, 1920, true
	default:
		return 0, 0, false
	}
}

// cxCardsBuildOptionValue 把已校验的 options 规范化为 canonical JSON 可编码的值。
func cxCardsBuildOptionValue(options cxBuildCardsOptions) (map[string]any, error) {
	dnaVersion := any(nil)
	if options.DNAVersion != nil {
		dnaVersion = *options.DNAVersion
	}
	cardsValue, err := cxCardsCanonicalValue(options.Cards)
	if err != nil {
		return nil, err
	}
	value := map[string]any{
		"template": options.Template, "ratio": options.Ratio, "dna_version": dnaVersion,
		"cards": cardsValue, "template_version": options.TemplateVersion,
	}
	planRef, ok, err := parseCXCardsPlanRef(options.VisualPlan)
	if err != nil {
		return nil, err
	}
	if ok {
		value["visual_plan"] = planRef.value()
	}
	return value, nil
}

// cxCardsPlanRef 是用户采用计划报告的冻结引用，字段与 cards/preview 返回的 visual_plan 完全一致。
type cxCardsPlanRef struct {
	DiagnosisID    uuid.UUID
	InputHash      string
	ResultRevision int
}

// value 返回与预览 options 同形的 canonical 值：UUID 小写、修订为整数。
func (r cxCardsPlanRef) value() map[string]any {
	return map[string]any{"diagnosis_id": r.DiagnosisID.String(), "input_hash": r.InputHash, "result_revision": r.ResultRevision}
}

// parseCXCardsPlanRef 严格解析可选计划引用；缺省或 null 表示手工计划，不带引用。
// 只接受预览回传的三个字段，避免任意 JSON 混入冻结参数。
func parseCXCardsPlanRef(raw json.RawMessage) (cxCardsPlanRef, bool, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return cxCardsPlanRef{}, false, nil
	}
	if err := cxRejectDuplicateJSONKeys(trimmed); err != nil {
		return cxCardsPlanRef{}, false, validationFields("计划引用不能包含重复字段", map[string]string{"visual_plan": "invalid"})
	}
	if err := cxRequireJSONFields(trimmed, "diagnosis_id", "input_hash", "result_revision"); err != nil {
		return cxCardsPlanRef{}, false, validationFields("计划引用缺少必要字段", map[string]string{"visual_plan": "invalid"})
	}
	var decoded struct {
		DiagnosisID    string `json:"diagnosis_id"`
		InputHash      string `json:"input_hash"`
		ResultRevision int    `json:"result_revision"`
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return cxCardsPlanRef{}, false, validationFields("计划引用字段无效", map[string]string{"visual_plan": "invalid"})
	}
	id, err := uuid.Parse(decoded.DiagnosisID)
	if err != nil || id == uuid.Nil {
		return cxCardsPlanRef{}, false, validationFields("计划引用标识无效", map[string]string{"visual_plan": "invalid_id"})
	}
	if !cxCardsIsDigest(decoded.InputHash) {
		return cxCardsPlanRef{}, false, validationFields("计划引用摘要无效", map[string]string{"visual_plan": "invalid_hash"})
	}
	if decoded.ResultRevision < 1 {
		return cxCardsPlanRef{}, false, validationFields("计划引用版本无效", map[string]string{"visual_plan": "invalid_revision"})
	}
	return cxCardsPlanRef{DiagnosisID: id, InputHash: decoded.InputHash, ResultRevision: decoded.ResultRevision}, true, nil
}

// cxCardsIsDigest 只接受 64 位小写十六进制 SHA-256。
func cxCardsIsDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if c < '0' || (c > '9' && c < 'a') || c > 'f' {
			return false
		}
	}
	return true
}

// cxValidateCardsBuildOptions 在服务端重新执行一次卡片计划校验，不接受客户端自证。
func cxValidateCardsBuildOptions(options cxBuildCardsOptions) error {
	if options.Template != "editorial" && options.Template != "swiss" {
		return validationFields("组图模板无效", map[string]string{"template": "invalid"})
	}
	if _, _, ok := cxCardsRatioSize(options.Ratio); !ok {
		return validationFields("组图比例无效", map[string]string{"ratio": "invalid"})
	}
	if options.TemplateVersion != cxCardsTemplateVersion {
		return apiErr(http.StatusConflict, "renderer_version_mismatch", "当前服务端未登记此组图模板版本")
	}
	if options.DNAVersion != nil && *options.DNAVersion < 1 {
		return validationFields("视觉 DNA 版本无效", map[string]string{"dna_version": "invalid"})
	}
	if len(options.Cards) < 3 || len(options.Cards) > 9 {
		return validationFields("组图构建须包含 3..9 张卡片", map[string]string{"cards": "invalid"})
	}
	if _, _, err := parseCXCardsPlanRef(options.VisualPlan); err != nil {
		return err
	}
	seen := map[string]bool{}
	for index, card := range options.Cards {
		if strings.TrimSpace(card.CardID) == "" || utf8.RuneCountInString(card.CardID) > 64 || seen[card.CardID] {
			return validationFields("卡片 ID 必须非空、唯一且不超过 64 个码点", map[string]string{"cards": "invalid_id"})
		}
		seen[card.CardID] = true
		if index > 0 && card.Type == "cover" || index < len(options.Cards)-1 && card.Type == "end" {
			return validationFields("封面卡和结尾卡必须分别位于首尾", map[string]string{"cards": "invalid_order"})
		}
	}
	return nil
}

// cxCardsExpectedFileNames 按渲染器的固定规则推导 zip 条目名与顺序：
// 01-cover.png / 02-point-1.png / 03-quote-1.png / 04-compare-1.png / 05-end.png。
func cxCardsExpectedFileNames(cards []cxCardsBuildOption) []string {
	names := make([]string, 0, len(cards))
	ordinals := map[string]int{}
	for index, card := range cards {
		ordinal := 0
		if card.Type != "cover" && card.Type != "end" {
			ordinals[card.Type]++
			ordinal = ordinals[card.Type]
		}
		names = append(names, cxCardsFileName(card.Type, index, ordinal))
	}
	return names
}

// cxCardsFileName 与两端渲染器的文件名规则一致：两位序号 + 类型（内容卡带同类型序号）。
func cxCardsFileName(cardType string, index, ordinal int) string {
	part := cardType
	switch cardType {
	case "cover", "end":
	default:
		part = cardType + "-" + strconv.Itoa(ordinal)
	}
	prefix := strconv.Itoa(index + 1)
	if len(prefix) < 2 {
		prefix = "0" + prefix
	}
	return prefix + "-" + part + ".png"
}

// cxCardsZIPEntry 是校验通过的 zip 条目摘要，写入 validation 供 manifest 引用。
type cxCardsZIPEntry struct {
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// cxValidateCardsZIP 逐条目验证 xhs_cards 交付包，任何一项不符整组失败。
func cxValidateCardsZIP(data []byte, options cxBuildCardsOptions) ([]cxCardsZIPEntry, *APIError) {
	width, height, ok := cxCardsRatioSize(options.Ratio)
	if !ok {
		return nil, apiErr(http.StatusUnprocessableEntity, "cards_ratio_invalid", "组图比例无效")
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_invalid", "组图交付包不是可解析的 ZIP")
	}
	expected := cxCardsExpectedFileNames(options.Cards)
	if len(reader.File) != len(expected) {
		return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_entry_mismatch", "组图交付包条目数与卡片计划不一致")
	}
	if len(reader.File) > cxCardsZipMaxEntries {
		return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_invalid", "组图交付包条目数超过上限")
	}
	seen := map[string]bool{}
	entries := make([]cxCardsZIPEntry, 0, len(reader.File))
	var total int64
	for index, file := range reader.File {
		name := file.Name
		if file.FileInfo().IsDir() || strings.ContainsAny(name, "\x00\r\n") || path.Base(name) != name || strings.HasPrefix(name, ".") {
			return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_unsafe_entry", "组图交付包包含不安全的条目路径")
		}
		if seen[name] {
			return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_unsafe_entry", "组图交付包包含重复条目")
		}
		seen[name] = true
		if name != expected[index] {
			return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_entry_mismatch", "组图交付包条目名称或顺序与卡片计划不一致").With(map[string]any{
				"expected": expected[index], "actual": name, "position": index + 1,
			})
		}
		if file.UncompressedSize64 > cxCardsZipMaxEntryBytes {
			return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_invalid", "组图交付包单个条目超过大小上限")
		}
		total += int64(file.UncompressedSize64)
		if total > cxCardsZipMaxTotalBytes {
			return nil, apiErr(http.StatusUnprocessableEntity, "cards_zip_invalid", "组图交付包解压总量超过上限")
		}
		entry, err := cxInspectCardsPNG(file, name, width, height)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func cxInspectCardsPNG(file *zip.File, name string, width, height int) (cxCardsZIPEntry, *APIError) {
	return cxInspectZIPEntryPNG(file, name, width, height, cxCardsPNGCodes, "组图卡片")
}

// cxValidateCardsZIPSafety 是上传阶段的基础检查：不信任扩展名，先挡穿越路径与解压炸弹。
// 像素与卡片对应关系在 complete 阶段按冻结 options 复核。
func cxValidateCardsZIPSafety(data []byte) *APIError {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物不是可解析的压缩包")
	}
	if len(reader.File) == 0 || len(reader.File) > cxCardsZipMaxEntries {
		return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物条目数超出允许范围")
	}
	var total int64
	seen := map[string]bool{}
	for _, file := range reader.File {
		name := file.Name
		if file.FileInfo().IsDir() || strings.ContainsAny(name, "\x00\r\n") || path.Base(name) != name || strings.HasPrefix(name, ".") {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物包含不安全的条目路径")
		}
		if seen[name] {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物包含重复条目")
		}
		seen[name] = true
		if file.UncompressedSize64 > cxCardsZipMaxEntryBytes {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物单个条目超过大小上限")
		}
		total += int64(file.UncompressedSize64)
		if total > cxCardsZipMaxTotalBytes {
			return apiErr(http.StatusUnprocessableEntity, "artifact_invalid", "ZIP 产物解压总量超过上限")
		}
	}
	return nil
}

// cxValidateCardsBuildAgainstSnapshot 用冻结来源重跑同一套卡片计划校验：
// 段落/图片归属、引用逐字、对比两侧依据、封面首尾与总数，全部以快照为准。
// 要点卡的标题与正文必须已是预览规范化后的值，否则 params_hash 会与用户看到的计划不一致。
func cxValidateCardsBuildAgainstSnapshot(cards []cxCardsBuildOption, snapshot map[string]any) error {
	sectionsRaw, ok := snapshot["sections"].([]any)
	if !ok {
		return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照缺少段落")
	}
	sectionMap := make(map[uuid.UUID]cxVisualPlanSection, len(sectionsRaw))
	for _, raw := range sectionsRaw {
		values, ok := raw.(map[string]any)
		if !ok {
			return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照段落格式无效")
		}
		id, err := uuid.Parse(cxString(values["id"]))
		if err != nil {
			return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照段落标识无效")
		}
		sectionMap[id] = cxVisualPlanSection{ID: id, Position: cxInt(values["position"]),
			Heading: cxString(values["heading"]), Content: cxString(values["content_md"])}
	}
	assetsRaw, ok := snapshot["assets"].([]any)
	if !ok {
		return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照缺少素材")
	}
	assetSet := make(map[uuid.UUID]bool, len(assetsRaw))
	for _, raw := range assetsRaw {
		values, ok := raw.(map[string]any)
		if !ok {
			return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照素材格式无效")
		}
		id, err := uuid.Parse(cxString(values["id"]))
		if err != nil {
			return apiErr(http.StatusConflict, "build_snapshot_invalid", "构建来源快照素材标识无效")
		}
		assetSet[id] = true
	}
	output := cxVisualPlanAIOutput{Cards: make([]cxVisualPlanAICard, 0, len(cards)), UncoveredSections: []uuid.UUID{}, MissingAssets: []string{}, Warnings: []string{}}
	referencedSections := map[uuid.UUID]cxVisualPlanSection{}
	referencedAssets := map[uuid.UUID]bool{}
	for _, card := range cards {
		for _, id := range card.SectionIDs {
			section, ok := sectionMap[id]
			if !ok {
				return apiErr(http.StatusUnprocessableEntity, "visual_plan_invalid", "组图卡片引用了不属于本作品的段落")
			}
			referencedSections[id] = section
		}
		for _, id := range card.AssetIDs {
			if !assetSet[id] {
				return apiErr(http.StatusUnprocessableEntity, "visual_plan_invalid", "组图卡片引用了不属于本作品的图片")
			}
			referencedAssets[id] = true
		}
		output.Cards = append(output.Cards, cxVisualPlanAICard{Type: card.Type, SectionIDs: card.SectionIDs, Headline: card.Headline,
			Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs})
	}
	// 构建输入是完整计划：validator 只应看到卡片实际引用的来源，作品其余段落不参与"未覆盖"判定。
	canonical := cxVisualPlanAIOutput{Cards: append([]cxVisualPlanAICard{}, output.Cards...)}
	if err := cxCardsCanonicalizePoints(&canonical, referencedSections); err != nil {
		return validation("要点卡必须绑定有标题和正文的当前作品段落")
	}
	for index := range output.Cards {
		if output.Cards[index].Headline != canonical.Cards[index].Headline || !bytes.Equal(output.Cards[index].Body, canonical.Cards[index].Body) {
			return apiErr(http.StatusUnprocessableEntity, "cards_not_canonicalized", "要点卡文案与规范化结果不一致，请重新预览构建参数后再创建构建")
		}
	}
	result, err := cxCardsValidateOutput(output, referencedSections, referencedAssets)
	if err != nil || !result.PlanComplete || len(result.Cards) != len(cards) {
		return apiErr(http.StatusUnprocessableEntity, "visual_plan_invalid", "组图卡片未通过当前来源校验，请重新确认计划")
	}
	return nil
}

// cxBuildCardsOptionsFromSnapshot 从冻结 params 取回本次构建的 options，供 complete 复核。
func cxBuildCardsOptionsFromParams(raw []byte) (cxBuildCardsOptions, error) {
	var params struct {
		Options json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return cxBuildCardsOptions{}, err
	}
	if len(params.Options) == 0 {
		return cxBuildCardsOptions{}, errors.New("构建参数缺少 options")
	}
	var options cxBuildCardsOptions
	if err := json.Unmarshal(params.Options, &options); err != nil {
		return cxBuildCardsOptions{}, err
	}
	return options, nil
}
