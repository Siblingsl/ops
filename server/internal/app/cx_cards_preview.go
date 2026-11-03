package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
	"ops/internal/markdownsyntax"
)

const cxCardsTemplateVersion = "ops.xhs-cards/v1"

type cxCardsPreviewInput struct {
	BasisRevision          int                  `json:"basis_revision"`
	Template               string               `json:"template"`
	Ratio                  string               `json:"ratio"`
	DNAVersion             *int64               `json:"dna_version,omitempty"`
	Cards                  []cxCardsBuildOption `json:"cards,omitempty"`
	VisualPlanID           *uuid.UUID           `json:"visual_plan_id,omitempty"`
	ExpectedResultRevision *int                 `json:"expected_result_revision,omitempty"`
}

type cxCardsBuildOption struct {
	CardID     string          `json:"card_id"`
	Type       string          `json:"type"`
	SectionIDs []uuid.UUID     `json:"section_ids"`
	Headline   string          `json:"headline"`
	Body       json.RawMessage `json:"body"`
	AssetIDs   []uuid.UUID     `json:"asset_ids"`
	SourceRefs []string        `json:"source_refs"`
}

func (c *cxCardsBuildOption) UnmarshalJSON(raw []byte) error {
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	if err := cxRequireJSONFields(raw, "card_id", "type", "section_ids", "headline", "body", "asset_ids", "source_refs"); err != nil {
		return err
	}
	type plain cxCardsBuildOption
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*c = cxCardsBuildOption(value)
	return nil
}

type cxCardsPreviewResponse struct {
	SourceHash      string               `json:"source_hash"`
	ParamsHash      string               `json:"params_hash"`
	BasisRevision   int                  `json:"basis_revision"`
	Template        string               `json:"template"`
	Ratio           string               `json:"ratio"`
	DNAVersion      *int64               `json:"dna_version"`
	TemplateVersion string               `json:"template_version"`
	Cards           []cxCardsBuildOption `json:"cards"`
	// VisualPlan 是 AI 计划预览采用报告的冻结引用；创建构建时必须原样回传，
	// 否则 params_hash 会与用户看到的预览不一致，构建产物不可追溯。
	VisualPlan map[string]any `json:"visual_plan,omitempty"`
	Warnings   []string       `json:"warnings"`
}

func decodeCXCardsPreviewInput(r *http.Request) (cxCardsPreviewInput, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err != nil {
		return cxCardsPreviewInput{}, validation("组图构建预览请求格式不正确")
	}
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return cxCardsPreviewInput{}, validation("组图构建预览请求不能包含重复字段")
	}
	if err := cxRequireJSONFields(raw, "basis_revision", "template", "ratio"); err != nil {
		return cxCardsPreviewInput{}, validation("组图构建预览请求缺少必要字段")
	}
	var input cxCardsPreviewInput
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, validation("组图构建预览请求字段无效")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return input, validation("请求只能包含一个 JSON 对象")
	}
	if input.BasisRevision < 1 {
		return input, validationFields("请提供当前作品修订", map[string]string{"basis_revision": "invalid"})
	}
	if input.Template != "editorial" && input.Template != "swiss" || input.Ratio != "1:1" && input.Ratio != "3:4" && input.Ratio != "9:16" {
		return input, validationFields("组图模板或比例无效", map[string]string{"template": "invalid", "ratio": "invalid"})
	}
	if input.DNAVersion != nil && *input.DNAVersion < 1 {
		return input, validationFields("视觉 DNA 版本无效", map[string]string{"dna_version": "invalid"})
	}
	hasVisualPlan := input.VisualPlanID != nil || input.ExpectedResultRevision != nil
	if (input.VisualPlanID == nil) != (input.ExpectedResultRevision == nil) {
		return input, validationFields("计划引用必须同时提供 ID 和报告修订", map[string]string{"visual_plan_id": "required_with_revision", "expected_result_revision": "required_with_id"})
	}
	if hasVisualPlan {
		if input.VisualPlanID == nil || *input.VisualPlanID == uuid.Nil || input.ExpectedResultRevision == nil || *input.ExpectedResultRevision < 1 || input.Cards != nil {
			return input, validationFields("AI 计划预览须提供有效报告版本，且不能同时提交卡片", map[string]string{"visual_plan_id": "invalid", "cards": "mutually_exclusive"})
		}
	} else if input.Cards == nil || len(input.Cards) < 3 || len(input.Cards) > 9 {
		return input, validationFields("手工组图计划须提交 3..9 张卡片", map[string]string{"cards": "invalid"})
	}
	seen := map[string]bool{}
	for index, card := range input.Cards {
		if strings.TrimSpace(card.CardID) == "" || utf8.RuneCountInString(card.CardID) > 64 || seen[card.CardID] {
			return input, validationFields("卡片 ID 必须非空、唯一且不超过 64 个码点", map[string]string{"cards": "invalid_id"})
		}
		seen[card.CardID] = true
		if index > 0 && card.Type == "cover" || index < len(input.Cards)-1 && card.Type == "end" {
			return input, validationFields("封面卡和结尾卡必须分别位于首尾", map[string]string{"cards": "invalid_order"})
		}
	}
	return input, nil
}

func (s *Server) previewCXCards(w http.ResponseWriter, r *http.Request) error {
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	input, err := decodeCXCardsPreviewInput(r)
	if err != nil {
		return err
	}
	actor, err := s.cxAuthorizeAccountAnalysisReader(r.Context())
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(r.Context()))
	var (
		basis      cxVisualPlanBasis
		planResult cxVisualPlanResult
		planRef    map[string]any
		warnings   []string
	)
	if input.VisualPlanID != nil {
		stored, err := scanCXVisualPlan(tx.QueryRow(r.Context(), `SELECT id,workspace_id,account_id,work_id,input_hash,context_hash,result,ai_call_id,model,prompt_version,created_at,result_revision
			FROM content_diagnosis WHERE id=$1 AND workspace_id=$2 AND work_id=$3 AND kind='visual_plan'`, *input.VisualPlanID, actor.WorkspaceID, workID))
		if err != nil {
			return err
		}
		actor, err = s.cxAuthorizeAccountAnalysisInTx(r.Context(), tx, actor, stored.AccountID)
		if err != nil {
			return err
		}
		if stored.Revision != *input.ExpectedResultRevision {
			return apiErr(http.StatusConflict, "version_conflict", "组图计划已被更新，请重新读取并逐卡确认后重试")
		}
		if stored.Result.Template != input.Template || stored.Result.Ratio != input.Ratio || input.DNAVersion != nil && (stored.Result.DNAVersion == nil || *stored.Result.DNAVersion != *input.DNAVersion) {
			return apiErr(http.StatusConflict, "visual_plan_options_conflict", "预览模板、比例或视觉 DNA 与已确认计划不一致")
		}
		if !stored.Result.PlanComplete || len(stored.Result.Cards) < 3 || len(stored.Result.Cards) > 9 || len(stored.Result.MissingAssets) != 0 {
			return apiErr(http.StatusConflict, "visual_plan_incomplete", "部分计划或缺少素材的计划不能进入组图构建预览")
		}
		for _, card := range stored.Result.Cards {
			if !card.Confirmed {
				return apiErr(http.StatusConflict, "human_step_required", "请先逐张确认组图计划中的每一张卡片")
			}
		}
		visualInput := cxVisualPlanRequest{BasisRevision: input.BasisRevision, SectionIDs: stored.Result.SectionIDs, AssetIDs: stored.Result.AssetIDs,
			Template: stored.Result.Template, Ratio: stored.Result.Ratio, DNAVersion: stored.Result.DNAVersion}
		basis, err = s.readCXVisualPlanBasis(r.Context(), tx, actor.WorkspaceID, workID, visualInput, false)
		if err != nil {
			return err
		}
		if basis.InputHash != stored.Result.CXBasis.InputHash {
			return apiErr(http.StatusConflict, "visual_plan_stale", "组图计划依据已变化，请重新生成后逐卡确认")
		}
		planResult = stored.Result
		planRef = map[string]any{"diagnosis_id": stored.ID.String(), "input_hash": stored.InputHash, "result_revision": stored.Revision}
		warnings = append([]string{}, stored.Result.Warnings...)
	} else {
		var accountID uuid.UUID
		if err := tx.QueryRow(r.Context(), `SELECT w.account_id FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, actor.WorkspaceID).Scan(&accountID); err != nil {
			return err
		}
		actor, err = s.cxAuthorizeAccountAnalysisInTx(r.Context(), tx, actor, accountID)
		if err != nil {
			return err
		}
		sectionIDs, assetIDs := cxCardsPreviewSourceIDs(input.Cards)
		if len(sectionIDs) == 0 || len(sectionIDs) > 7 || len(assetIDs) > 20 {
			return validationFields("手工计划最多引用 7 个段落和 20 张图片", map[string]string{"cards": "source_limit"})
		}
		basis, err = s.readCXVisualPlanBasis(r.Context(), tx, actor.WorkspaceID, workID, cxVisualPlanRequest{BasisRevision: input.BasisRevision,
			SectionIDs: sectionIDs, AssetIDs: assetIDs, Template: input.Template, Ratio: input.Ratio, DNAVersion: input.DNAVersion}, false)
		if err != nil {
			return err
		}
		sections := make(map[uuid.UUID]cxVisualPlanSection, len(basis.Sections))
		for _, section := range basis.Sections {
			sections[section.ID] = section
		}
		output := cxVisualPlanAIOutput{Cards: make([]cxVisualPlanAICard, 0, len(input.Cards)), UncoveredSections: []uuid.UUID{}, MissingAssets: []string{}, Warnings: []string{}}
		for _, card := range input.Cards {
			output.Cards = append(output.Cards, cxVisualPlanAICard{Type: card.Type, SectionIDs: card.SectionIDs, Headline: card.Headline,
				Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs})
		}
		if err := cxCardsCanonicalizePoints(&output, sections); err != nil {
			return validation("要点卡必须绑定有标题和正文的当前作品段落")
		}
		assets := make(map[uuid.UUID]bool, len(basis.Assets))
		for _, asset := range basis.Assets {
			assets[asset.ID] = true
		}
		planResult, err = cxCardsValidateOutput(output, sections, assets)
		if err != nil || !planResult.PlanComplete || len(planResult.Cards) != len(input.Cards) {
			return validation("手工组图卡片未通过完整来源校验")
		}
		for index := range planResult.Cards {
			planResult.Cards[index].CardID = input.Cards[index].CardID
		}
		planResult.Template, planResult.Ratio, planResult.DNAVersion, planResult.VisualDNA = input.Template, input.Ratio, basis.DNAVersion, basis.VisualDNA
		planResult.CXBasis = basis.Receipt
		planResult.SectionIDs, planResult.AssetIDs = sectionIDs, assetIDs
		planResult.SourceSections, planResult.SourceAssets = append([]cxVisualPlanSection{}, basis.Sections...), append([]cxVisualPlanAsset{}, basis.Assets...)
		warnings = []string{}
	}
	sections := make(map[uuid.UUID]cxVisualPlanSection, len(basis.Sections))
	for _, section := range basis.Sections {
		sections[section.ID] = section
	}
	assets := make(map[uuid.UUID]bool, len(basis.Assets))
	for _, asset := range basis.Assets {
		assets[asset.ID] = true
	}
	output := cxCardsVisualPlanOutput(planResult)
	if err := cxCardsCanonicalizePoints(&output, sections); err != nil {
		return apiErr(http.StatusConflict, "visual_plan_invalid", "要点卡缺少可安全转换的当前段落内容")
	}
	validated, err := cxCardsValidateOutput(output, sections, assets)
	if err != nil || !validated.PlanComplete || len(validated.Cards) != len(planResult.Cards) {
		return apiErr(http.StatusConflict, "visual_plan_invalid", "组图计划无法通过构建输入校验，请检查计划后重新确认")
	}
	for _, card := range output.Cards {
		if card.Type == "point" {
			warnings = append(warnings, "要点卡的构建标题取自来源段落标题，正文取自该段落前 60 个 Unicode 码点；完整正文仍保留在来源快照中。")
			break
		}
	}
	cards := make([]cxCardsBuildOption, 0, len(validated.Cards))
	for index, card := range validated.Cards {
		card.CardID = planResult.Cards[index].CardID
		cards = append(cards, cxCardsBuildOption{CardID: card.CardID, Type: card.Type, SectionIDs: card.SectionIDs, Headline: card.Headline,
			Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs})
	}
	snapshot, revision, platform, contentFormat, err := cxBuildSourceSnapshot(r.Context(), tx, actor.WorkspaceID, workID, input.BasisRevision, false, nil)
	if err != nil {
		return err
	}
	if !cxTargetAllowed(platform, contentFormat, "xhs_cards") {
		return apiErr(http.StatusUnprocessableEntity, "target_not_allowed", "所选作品形态不能生成小红书组图")
	}
	dnaSnapshot, err := cxCardsCanonicalValue(basis.VisualDNA)
	if err != nil {
		return err
	}
	snapshot["visual_dna"] = dnaSnapshot
	sourceHash, err := cxcanonicaljson.Hash(snapshot)
	if err != nil {
		return err
	}
	dnaVersion := any(nil)
	if basis.DNAVersion != nil {
		dnaVersion = *basis.DNAVersion
	}
	cardsValue, err := cxCardsCanonicalValue(cards)
	if err != nil {
		return err
	}
	options := map[string]any{"template": input.Template, "ratio": input.Ratio, "dna_version": dnaVersion,
		"cards": cardsValue, "template_version": cxCardsTemplateVersion}
	if planRef != nil {
		options["visual_plan"] = planRef
	}
	params := map[string]any{"targets": []any{"xhs_cards"}, "options": options,
		"renderer_contract_version": cxCardsTemplateVersion, "rules_version": markdownsyntax.RulesVersion}
	paramsHash, err := cxcanonicaljson.Hash(params)
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, cxCardsPreviewResponse{SourceHash: sourceHash, ParamsHash: paramsHash, BasisRevision: revision, Template: input.Template,
		Ratio: input.Ratio, DNAVersion: basis.DNAVersion, TemplateVersion: cxCardsTemplateVersion, Cards: cards,
		VisualPlan: planRef, Warnings: warnings})
}

func cxCardsPreviewSourceIDs(cards []cxCardsBuildOption) ([]uuid.UUID, []uuid.UUID) {
	sections, assets := []uuid.UUID{}, []uuid.UUID{}
	seenSections, seenAssets := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}
	for _, card := range cards {
		for _, id := range card.SectionIDs {
			if !seenSections[id] {
				seenSections[id] = true
				sections = append(sections, id)
			}
		}
		for _, id := range card.AssetIDs {
			if !seenAssets[id] {
				seenAssets[id] = true
				assets = append(assets, id)
			}
		}
	}
	return sections, assets
}

func cxCardsVisualPlanOutput(result cxVisualPlanResult) cxVisualPlanAIOutput {
	output := cxVisualPlanAIOutput{Cards: make([]cxVisualPlanAICard, 0, len(result.Cards)),
		UncoveredSections: append([]uuid.UUID{}, result.Coverage.UncoveredSections...), MissingAssets: append([]string{}, result.MissingAssets...), Warnings: append([]string{}, result.Warnings...)}
	for _, card := range result.Cards {
		output.Cards = append(output.Cards, cxVisualPlanAICard{Type: card.Type, SectionIDs: card.SectionIDs, Headline: card.Headline,
			Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs})
	}
	return output
}

func cxCardsValidateOutput(output cxVisualPlanAIOutput, sections map[uuid.UUID]cxVisualPlanSection, assets map[uuid.UUID]bool) (cxVisualPlanResult, error) {
	return output.validateAndSummarize(sections, assets)
}

func cxCardsCanonicalizePoints(output *cxVisualPlanAIOutput, sections map[uuid.UUID]cxVisualPlanSection) error {
	for index, card := range output.Cards {
		if card.Type != "point" || len(card.SectionIDs) != 1 {
			continue
		}
		section, ok := sections[card.SectionIDs[0]]
		if !ok || strings.TrimSpace(section.Heading) == "" || strings.TrimSpace(section.Content) == "" {
			return errors.New("要点卡来源段落缺少标题或正文")
		}
		runes := []rune(section.Content)
		if len(runes) > 60 {
			runes = runes[:60]
		}
		body, err := json.Marshal(string(runes))
		if err != nil {
			return err
		}
		output.Cards[index].Headline = section.Heading
		output.Cards[index].Body = body
	}
	return nil
}

func cxCardsCanonicalValue(value any) (any, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return cxcanonicaljson.Parse(raw)
}
