package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type cxVisualPlanResponse struct {
	DiagnosisID   uuid.UUID                `json:"diagnosis_id"`
	WorkID        uuid.UUID                `json:"work_id"`
	InputHash     string                   `json:"input_hash"`
	Template      string                   `json:"template"`
	Ratio         string                   `json:"ratio"`
	DNAVersion    *int64                   `json:"dna_version"`
	VisualDNA     *cxVisualPlanDNASnapshot `json:"visual_dna"`
	SectionIDs    []uuid.UUID              `json:"section_ids"`
	AssetIDs      []uuid.UUID              `json:"asset_ids"`
	Cards         []cxVisualPlanCard       `json:"cards"`
	Coverage      cxVisualPlanCoverage     `json:"coverage"`
	MissingAssets []string                 `json:"missing_assets"`
	Warnings      []string                 `json:"warnings"`
	CXBasis       cxBasisReceipt           `json:"cx_basis"`
	PlanComplete  bool                     `json:"plan_complete"`
	AICallID      *uuid.UUID               `json:"ai_call_id,omitempty"`
	TaskType      string                   `json:"task_type"`
	Model         string                   `json:"model"`
	PromptVersion string                   `json:"prompt_version"`
	Stale         bool                     `json:"stale"`
	Reused        bool                     `json:"reused"`
	CreatedAt     time.Time                `json:"created_at"`
	Revision      int                      `json:"result_revision"`
}

type cxVisualPlanStored struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	AccountID     uuid.UUID
	WorkID        uuid.UUID
	InputHash     string
	ContextHash   string
	Result        cxVisualPlanResult
	AICallID      *uuid.UUID
	Model         string
	PromptVersion string
	CreatedAt     time.Time
	Revision      int
}

type cxVisualPlanQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

type cxVisualPlanEditRequest struct {
	ExpectedRevision int                    `json:"expected_revision"`
	Cards            []cxVisualPlanEditCard `json:"cards"`
}

type cxVisualPlanEditCard struct {
	CardID     string          `json:"card_id"`
	Type       string          `json:"type"`
	SectionIDs []uuid.UUID     `json:"section_ids"`
	Headline   string          `json:"headline"`
	Body       json.RawMessage `json:"body"`
	AssetIDs   []uuid.UUID     `json:"asset_ids"`
	SourceRefs []string        `json:"source_refs"`
	Confirmed  bool            `json:"confirmed"`
}

func (c *cxVisualPlanEditCard) UnmarshalJSON(raw []byte) error {
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	if err := cxRequireJSONFields(raw, "card_id", "type", "section_ids", "headline", "body", "asset_ids", "source_refs", "confirmed"); err != nil {
		return err
	}
	type plain cxVisualPlanEditCard
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*c = cxVisualPlanEditCard(value)
	return nil
}

func decodeCXVisualPlanEditRequest(r *http.Request) (cxVisualPlanEditRequest, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err != nil {
		return cxVisualPlanEditRequest{}, validation("组图计划编辑请求格式不正确")
	}
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return cxVisualPlanEditRequest{}, validation("组图计划编辑请求不能包含重复字段")
	}
	if err := cxRequireJSONFields(raw, "expected_revision", "cards"); err != nil {
		return cxVisualPlanEditRequest{}, validation("组图计划编辑请求缺少必要字段")
	}
	var input cxVisualPlanEditRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, validation("组图计划编辑请求字段无效")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return input, validation("请求只能包含一个 JSON 对象")
	}
	if input.ExpectedRevision < 1 || input.Cards == nil || len(input.Cards) == 0 || len(input.Cards) > 9 {
		return input, validationFields("请保留 1..9 张卡片并提交有效的报告版本", map[string]string{"cards": "invalid"})
	}
	return input, nil
}

func decodeCXVisualPlanRequest(r *http.Request) (cxVisualPlanRequest, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<16))
	if err != nil {
		return cxVisualPlanRequest{}, validation("组图计划请求格式不正确")
	}
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return cxVisualPlanRequest{}, validation("组图计划请求不能包含重复字段")
	}
	if err := cxRequireJSONFields(raw, "basis_revision", "section_ids", "asset_ids", "template", "ratio", "dna_version"); err != nil {
		return cxVisualPlanRequest{}, validation("组图计划请求缺少必要字段")
	}
	var input cxVisualPlanRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return input, validation("组图计划请求字段无效")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return input, validation("请求只能包含一个 JSON 对象")
	}
	if input.BasisRevision < 1 {
		return input, validationFields("作品版本无效，请刷新后重试", map[string]string{"basis_revision": "invalid"})
	}
	if input.Template != "editorial" && input.Template != "swiss" {
		return input, validationFields("组图模板无效", map[string]string{"template": "invalid"})
	}
	if input.Ratio != "1:1" && input.Ratio != "3:4" && input.Ratio != "9:16" {
		return input, validationFields("组图比例无效", map[string]string{"ratio": "invalid"})
	}
	if input.DNAVersion != nil && *input.DNAVersion < 1 {
		return input, validationFields("视觉 DNA 版本无效", map[string]string{"dna_version": "invalid"})
	}
	if input.SectionIDs == nil || len(input.SectionIDs) == 0 || len(input.SectionIDs) > 7 {
		return input, validationFields("请选择 1..7 个当前作品段落", map[string]string{"section_ids": "invalid"})
	}
	if input.AssetIDs == nil || len(input.AssetIDs) > 20 {
		return input, validationFields("本次最多选择 20 张当前作品图片", map[string]string{"asset_ids": "invalid"})
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range input.SectionIDs {
		if id == uuid.Nil || seen[id] {
			return input, validationFields("段落选择不能包含空 ID 或重复项", map[string]string{"section_ids": "invalid"})
		}
		seen[id] = true
	}
	seen = map[uuid.UUID]bool{}
	for _, id := range input.AssetIDs {
		if id == uuid.Nil || seen[id] {
			return input, validationFields("图片选择不能包含空 ID 或重复项", map[string]string{"asset_ids": "invalid"})
		}
		seen[id] = true
	}
	if input.Nonce != "" {
		nonce, err := uuid.Parse(input.Nonce)
		if err != nil || nonce == uuid.Nil {
			return input, validationFields("重新生成标识无效", map[string]string{"nonce": "invalid"})
		}
		input.Nonce = nonce.String()
	}
	return input, nil
}

func (s *Server) readCXVisualPlanBasis(ctx context.Context, q cxVisualPlanQueryer, workspaceID, workID uuid.UUID, input cxVisualPlanRequest, lock bool) (cxVisualPlanBasis, error) {
	basis := cxVisualPlanBasis{WorkspaceID: workspaceID, WorkID: workID, Template: input.Template, Ratio: input.Ratio,
		DNAVersion: input.DNAVersion, Sections: []cxVisualPlanSection{}, Assets: []cxVisualPlanAsset{}}
	workQuery := `SELECT w.account_id,a.platform,w.revision,w.updated_at FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`
	if lock {
		workQuery += ` FOR UPDATE OF w`
	}
	if err := q.QueryRow(ctx, workQuery, workID, workspaceID).Scan(&basis.AccountID, &basis.Platform, &basis.Revision, &basis.UpdatedAt); err != nil {
		return cxVisualPlanBasis{}, err
	}
	if basis.Platform != "xhs" {
		return cxVisualPlanBasis{}, validation("AI 社交组图计划仅适用于小红书作品")
	}
	if input.BasisRevision != 0 && basis.Revision != input.BasisRevision {
		return cxVisualPlanBasis{}, apiErr(http.StatusConflict, "version_conflict", "作品内容已变化，请刷新后重新生成组图计划")
	}
	var dnaHashInput *struct {
		Version    int64  `json:"version"`
		TokensHash string `json:"tokens_hash"`
	}
	if input.DNAVersion != nil {
		var raw []byte
		var tokensHash string
		var createdAt time.Time
		err := q.QueryRow(ctx, `SELECT tokens,tokens_hash,created_at FROM account_visual_dna WHERE account_id=$1 AND version=$2`, basis.AccountID, *input.DNAVersion).
			Scan(&raw, &tokensHash, &createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return cxVisualPlanBasis{}, apiErr(http.StatusConflict, "visual_dna_unavailable", "所选视觉 DNA 版本不存在，请刷新账号视觉 DNA 后重试")
		}
		if err != nil {
			return cxVisualPlanBasis{}, err
		}
		tokens, err := decodeCXDNATokens(raw)
		if err != nil {
			return cxVisualPlanBasis{}, apiErr(http.StatusInternalServerError, "visual_dna_invalid_history", "所选视觉 DNA 历史版本无法验证")
		}
		verifiedHash, err := cxVisualDNATokensHash(tokens)
		if err != nil || verifiedHash != tokensHash {
			return cxVisualPlanBasis{}, apiErr(http.StatusInternalServerError, "visual_dna_invalid_history", "所选视觉 DNA 历史摘要无法验证")
		}
		createdAt = createdAt.UTC()
		basis.VisualDNA = &cxVisualPlanDNASnapshot{Version: *input.DNAVersion, TokensHash: tokensHash, Tokens: tokens, CreatedAt: createdAt}
		dnaHashInput = &struct {
			Version    int64  `json:"version"`
			TokensHash string `json:"tokens_hash"`
		}{Version: *input.DNAVersion, TokensHash: tokensHash}
	}
	sectionRows, err := q.Query(ctx, `SELECT id,revision,position,heading,key_point,content_md,updated_at FROM work_section
		WHERE work_id=$1 AND deleted_at IS NULL AND id=ANY($2::uuid[]) ORDER BY position,created_at`+func() string {
		if lock {
			return ` FOR UPDATE`
		}
		return ""
	}(), workID, input.SectionIDs)
	if err != nil {
		return cxVisualPlanBasis{}, err
	}
	selected := map[uuid.UUID]bool{}
	for _, id := range input.SectionIDs {
		selected[id] = true
	}
	totalRunes := 0
	for sectionRows.Next() {
		var item cxVisualPlanSection
		if err := sectionRows.Scan(&item.ID, &item.Revision, &item.Position, &item.Heading, &item.KeyPoint, &item.Content, &item.UpdatedAt); err != nil {
			sectionRows.Close()
			return cxVisualPlanBasis{}, err
		}
		item.UpdatedAt = item.UpdatedAt.UTC()
		basis.Sections = append(basis.Sections, item)
		delete(selected, item.ID)
		totalRunes += len([]rune(item.Heading)) + len([]rune(item.KeyPoint)) + len([]rune(item.Content))
	}
	if err := sectionRows.Err(); err != nil {
		sectionRows.Close()
		return cxVisualPlanBasis{}, err
	}
	sectionRows.Close()
	if len(selected) != 0 {
		return cxVisualPlanBasis{}, errNotFound
	}
	if totalRunes > 20000 {
		return cxVisualPlanBasis{}, validationFields("所选段落超过本次 AI 上下文范围，请减少段落或先缩短正文", map[string]string{"section_ids": "context_too_large"})
	}
	if len(input.AssetIDs) > 0 {
		assetRows, err := q.Query(ctx, `SELECT id,position,mime,width,height,alt_text,sha256,created_at FROM asset
			WHERE work_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[]) ORDER BY position,created_at`+func() string {
			if lock {
				return ` FOR SHARE`
			}
			return ""
		}(), workID, workspaceID, input.AssetIDs)
		if err != nil {
			return cxVisualPlanBasis{}, err
		}
		wanted := map[uuid.UUID]bool{}
		for _, id := range input.AssetIDs {
			wanted[id] = true
		}
		for assetRows.Next() {
			var item cxVisualPlanAsset
			if err := assetRows.Scan(&item.ID, &item.Position, &item.MIME, &item.Width, &item.Height, &item.AltText, &item.SHA256, &item.CreatedAt); err != nil {
				assetRows.Close()
				return cxVisualPlanBasis{}, err
			}
			item.CreatedAt = item.CreatedAt.UTC()
			basis.Assets = append(basis.Assets, item)
			delete(wanted, item.ID)
		}
		if err := assetRows.Err(); err != nil {
			assetRows.Close()
			return cxVisualPlanBasis{}, err
		}
		assetRows.Close()
		if len(wanted) != 0 {
			return cxVisualPlanBasis{}, errNotFound
		}
	}
	basis.UpdatedAt = basis.UpdatedAt.UTC()
	workRevision := int64(basis.Revision)
	sources := make([]cxBasisSource, 0, 1+len(basis.Sections)+len(basis.Assets)+1)
	for _, section := range basis.Sections {
		revision := int64(section.Revision)
		updated := section.UpdatedAt
		sources = append(sources, cxBasisSource{Ref: "section:" + section.ID.String(), Kind: "work_section", ID: section.ID.String(), Revision: &revision,
			AsOfAt: &updated, UpdatedAt: &updated, State: "observed", Purpose: "user_selected_visual_plan_section"})
	}
	for _, asset := range basis.Assets {
		created := asset.CreatedAt
		sources = append(sources, cxBasisSource{Ref: "asset:" + asset.ID.String(), Kind: "work_asset", ID: asset.ID.String(), AsOfAt: &created, CapturedAt: &created,
			State: "observed", Purpose: "user_selected_visual_plan_asset_metadata"})
	}
	var dnaRef *string
	if basis.VisualDNA != nil {
		revision := basis.VisualDNA.Version
		created := basis.VisualDNA.CreatedAt
		ref := fmt.Sprintf("visual_dna:%s:%d", basis.AccountID, basis.VisualDNA.Version)
		dnaRef = &ref
		sources = append(sources, cxBasisSource{Ref: ref, Kind: "visual_dna", ID: basis.AccountID.String(), Revision: &revision,
			AsOfAt: &created, UpdatedAt: &created, CapturedAt: &created, State: "observed", Purpose: "user_selected_visual_dna_version"})
	}
	omitted := []cxBasisOmission{{Ref: "positioning", Reason: "本次组图计划不读取账号定位。"}}
	if basis.VisualDNA == nil {
		omitted = append(omitted, cxBasisOmission{Ref: "visual_dna", Reason: "用户选择不使用账号视觉 DNA，按普通模板规划。"})
	}
	basis.Receipt = cxBasisReceipt{SchemaVersion: 1, AccountID: basis.AccountID, WorkRevision: &workRevision,
		DNARef: dnaRef, Sources: sources, Omitted: omitted, Coverage: "selected_work_sections", AssembledAt: time.Now().UTC()}
	hashInput := struct {
		WorkID    uuid.UUID                 `json:"work_id"`
		AccountID uuid.UUID                 `json:"account_id"`
		Revision  int                       `json:"work_revision"`
		Template  string                    `json:"template"`
		Ratio     string                    `json:"ratio"`
		Sections  []cxVisualPlanSection     `json:"sections"`
		Assets    []cxVisualPlanAssetDigest `json:"assets"`
		DNA       *struct {
			Version    int64  `json:"version"`
			TokensHash string `json:"tokens_hash"`
		} `json:"visual_dna"`
	}{basis.WorkID, basis.AccountID, basis.Revision, basis.Template, basis.Ratio, basis.Sections, cxVisualPlanAssetDigests(basis.Assets), dnaHashInput}
	basis.InputHash, err = cxJSONHash(hashInput)
	if err != nil {
		return cxVisualPlanBasis{}, err
	}
	basis.Receipt.InputHash = basis.InputHash
	return basis, nil
}

type cxVisualPlanAssetDigest struct {
	ID        uuid.UUID `json:"id"`
	SHA256    string    `json:"sha256"`
	Position  int       `json:"position"`
	MIME      string    `json:"mime"`
	Width     int       `json:"width"`
	Height    int       `json:"height"`
	AltText   string    `json:"alt_text"`
	CreatedAt time.Time `json:"created_at"`
}

func cxVisualPlanAssetDigests(assets []cxVisualPlanAsset) []cxVisualPlanAssetDigest {
	digests := make([]cxVisualPlanAssetDigest, 0, len(assets))
	for _, asset := range assets {
		digests = append(digests, cxVisualPlanAssetDigest{ID: asset.ID, SHA256: asset.SHA256, Position: asset.Position, MIME: asset.MIME,
			Width: asset.Width, Height: asset.Height, AltText: asset.AltText, CreatedAt: asset.CreatedAt})
	}
	return digests
}

func (s *Server) cxVisualPlanInputSnapshot(ctx context.Context, workspaceID, workID uuid.UUID, input cxVisualPlanRequest) (cxVisualPlanBasis, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return cxVisualPlanBasis{}, err
	}
	defer tx.Rollback(ctx)
	basis, err := s.readCXVisualPlanBasis(ctx, tx, workspaceID, workID, input, false)
	if err != nil {
		return cxVisualPlanBasis{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return cxVisualPlanBasis{}, err
	}
	return basis, nil
}

func (s *Server) cxVisualPlanContextSnapshot(ctx context.Context, nonce string) (*cxAccountAnalysisContextSnapshot, error) {
	modelRoute, err := s.resolveRouteTier(ctx, "cx_visual_plan", "")
	if err != nil {
		return nil, err
	}
	taskInstruction, instructionVersion := s.loadTaskInstruction(ctx, "cx_visual_plan")
	if instructionVersion == 0 {
		instructionVersion = 1
	}
	if taskInstruction == "" {
		taskInstruction = cxVisualPlanDefaultPrompt
	}
	promptVersion := fmt.Sprintf("%s/task-instruction-v%d", cxVisualPlanVersion, instructionVersion)
	promptHash, err := cxJSONHash(taskInstruction)
	if err != nil {
		return nil, err
	}
	contextHash, err := cxJSONHash(cxAccountAnalysisContextRef{TaskType: "cx_visual_plan", PromptVersion: promptVersion, PromptHash: promptHash,
		Primary: cxRouteReference(modelRoute), Fallback: cxRouteFallbackReference(modelRoute), Nonce: nonce})
	if err != nil {
		return nil, err
	}
	return &cxAccountAnalysisContextSnapshot{Route: modelRoute, TaskInstruction: taskInstruction, InstructionVersion: instructionVersion,
		PromptVersion: promptVersion, ContextHash: contextHash}, nil
}

func (s *Server) suggestCXVisualPlan(w http.ResponseWriter, r *http.Request) error {
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	input, err := decodeCXVisualPlanRequest(r)
	if err != nil {
		return err
	}
	meta, err := s.workMeta(r.Context(), workID)
	if err != nil {
		return err
	}
	actor, err := s.cxAuthorizeAccountAnalysis(r.Context(), meta.Account.ID)
	if err != nil {
		return err
	}
	basis, err := s.cxVisualPlanInputSnapshot(r.Context(), actor.WorkspaceID, workID, input)
	if err != nil {
		return err
	}
	contextSnapshot, err := s.cxVisualPlanContextSnapshot(r.Context(), input.Nonce)
	if err != nil {
		return err
	}
	lockKey, err := cxJSONHash(struct {
		WorkspaceID uuid.UUID `json:"workspace_id"`
		WorkID      uuid.UUID `json:"work_id"`
		ActorID     uuid.UUID `json:"actor_id"`
		TaskType    string    `json:"task_type"`
		InputHash   string    `json:"input_hash"`
		ContextHash string    `json:"context_hash"`
	}{actor.WorkspaceID, workID, actor.UserID, "cx_visual_plan", basis.InputHash, contextSnapshot.ContextHash})
	if err != nil {
		return err
	}
	if stored, findErr := s.findCXVisualPlan(r.Context(), actor.WorkspaceID, workID, actor.UserID, basis.InputHash, contextSnapshot.ContextHash); findErr == nil {
		if err := s.cxRevalidateVisualPlan(r.Context(), actor, basis, input); err != nil {
			return err
		}
		storedResult := cxVisualPlanResponseFromStored(stored, true)
		storedResult.Stale, err = s.cxVisualPlanStale(r.Context(), actor.WorkspaceID, workID, stored.Result)
		if err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, storedResult)
	} else if !errors.Is(findErr, pgx.ErrNoRows) {
		return findErr
	}
	if !s.tryLockAccountAnalysisInProcess(lockKey) {
		w.Header().Set("Retry-After", "2")
		return apiErr(http.StatusConflict, "ai_task_in_progress", "相同作品依据正在生成组图计划，请稍后再查看历史")
	}
	defer s.unlockAccountAnalysisInProcess(lockKey)
	releaseWorker, err := s.waitAIWorker(r.Context(), func() {})
	if err != nil {
		return err
	}
	defer releaseWorker()
	lockConn, locked, err := s.lockAccountAnalysisRequest(r.Context(), lockKey)
	if err != nil {
		return err
	}
	if !locked {
		lockConn.Release()
		w.Header().Set("Retry-After", "2")
		return apiErr(http.StatusConflict, "ai_task_in_progress", "相同作品依据正在生成组图计划，请稍后再查看历史")
	}
	defer releaseAccountAnalysisRequestLock(lockConn, lockKey)
	if stored, findErr := s.findCXVisualPlan(r.Context(), actor.WorkspaceID, workID, actor.UserID, basis.InputHash, contextSnapshot.ContextHash); findErr == nil {
		if err := s.cxRevalidateVisualPlan(r.Context(), actor, basis, input); err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, cxVisualPlanResponseFromStored(stored, true))
	} else if !errors.Is(findErr, pgx.ErrNoRows) {
		return findErr
	}
	if err := s.cxRevalidateVisualPlan(r.Context(), actor, basis, input); err != nil {
		return err
	}
	sections := make(map[uuid.UUID]cxVisualPlanSection, len(basis.Sections))
	for _, section := range basis.Sections {
		sections[section.ID] = section
	}
	assets := make(map[uuid.UUID]bool, len(basis.Assets))
	for _, asset := range basis.Assets {
		assets[asset.ID] = true
	}
	userPrompt, err := cxVisualPlanPrompt(basis)
	if err != nil {
		return err
	}
	account := &Account{ID: basis.AccountID, Status: "active"}
	var output cxVisualPlanAIOutput
	aiResult, err := s.runAIJSON(r.Context(), aiTask{Type: "cx_visual_plan", Account: account, WorkID: &workID,
		User: userPrompt, ExtraRules: cxVisualPlanSystemRules, Bare: true, Route: contextSnapshot.Route,
		TaskPrompt: &taskPromptSnapshot{Content: contextSnapshot.TaskInstruction, Version: contextSnapshot.InstructionVersion},
		Refs:       map[string]any{"work_revision": basis.Revision, "input_hash": basis.InputHash, "prompt_template_version": contextSnapshot.InstructionVersion}},
		&output, func() error { return output.validate(sections, assets) })
	if err != nil {
		if r.Context().Err() != nil {
			return r.Context().Err()
		}
		return err
	}
	if err := r.Context().Err(); err != nil {
		return err
	}
	if err := s.cxRevalidateVisualPlan(r.Context(), actor, basis, input); err != nil {
		return err
	}
	result, err := output.validateAndSummarize(sections, assets)
	if err != nil {
		return err
	}
	result.Template, result.Ratio, result.DNAVersion, result.VisualDNA = basis.Template, basis.Ratio, basis.DNAVersion, basis.VisualDNA
	result.CXBasis = basis.Receipt
	result.SourceSections = append([]cxVisualPlanSection{}, basis.Sections...)
	result.SourceAssets = append([]cxVisualPlanAsset{}, basis.Assets...)
	result.OriginalCards = cxCloneVisualPlanCards(result.Cards)
	result.SectionIDs = make([]uuid.UUID, 0, len(basis.Sections))
	for _, section := range basis.Sections {
		result.SectionIDs = append(result.SectionIDs, section.ID)
	}
	result.AssetIDs = make([]uuid.UUID, 0, len(basis.Assets))
	for _, asset := range basis.Assets {
		result.AssetIDs = append(result.AssetIDs, asset.ID)
	}
	var model string
	if err := s.db.QueryRow(r.Context(), `SELECT model FROM ai_call WHERE id=$1 AND workspace_id=$2 AND task_type='cx_visual_plan' AND status='ok'`, aiResult.CallID, actor.WorkspaceID).Scan(&model); err != nil {
		return err
	}
	callID := aiResult.CallID
	diagnosisID, createdAt, revision, err := s.persistCXVisualPlan(r.Context(), actor, basis, contextSnapshot.ContextHash, model, contextSnapshot.PromptVersion, &callID, result)
	if err != nil {
		return err
	}
	stored := cxVisualPlanStored{ID: diagnosisID, WorkspaceID: actor.WorkspaceID, AccountID: basis.AccountID, WorkID: workID, InputHash: basis.InputHash,
		ContextHash: contextSnapshot.ContextHash, Result: result, AICallID: &callID, Model: model, PromptVersion: contextSnapshot.PromptVersion, CreatedAt: createdAt, Revision: revision}
	s.audit(r.Context(), "visual_plan_create", "content_diagnosis", diagnosisID.String(), "ok", map[string]any{"work_id": workID.String(),
		"input_hash": basis.InputHash, "ai_call_id": callID.String(), "card_count": len(result.Cards), "plan_complete": result.PlanComplete})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, cxVisualPlanResponseFromStored(stored, false))
}

func cxCloneVisualPlanCards(cards []cxVisualPlanCard) []cxVisualPlanCard {
	cloned := make([]cxVisualPlanCard, 0, len(cards))
	for _, card := range cards {
		card.SectionIDs = append([]uuid.UUID{}, card.SectionIDs...)
		card.AssetIDs = append([]uuid.UUID{}, card.AssetIDs...)
		card.SourceRefs = append([]string{}, card.SourceRefs...)
		card.Body = append(json.RawMessage{}, card.Body...)
		cloned = append(cloned, card)
	}
	return cloned
}

func cxVisualPlanPrompt(basis cxVisualPlanBasis) (string, error) {
	sections := make([]map[string]any, 0, len(basis.Sections))
	for _, item := range basis.Sections {
		sections = append(sections, map[string]any{"id": item.ID, "source_ref": "section:" + item.ID.String(), "revision": item.Revision,
			"heading": item.Heading, "key_point": item.KeyPoint, "content_md": item.Content})
	}
	assets := make([]map[string]any, 0, len(basis.Assets))
	for _, item := range basis.Assets {
		assets = append(assets, map[string]any{"id": item.ID, "source_ref": "asset:" + item.ID.String(), "mime": item.MIME,
			"width": item.Width, "height": item.Height, "alt_text": item.AltText, "position": item.Position})
	}
	var visualDNA any
	if basis.VisualDNA != nil {
		// The logo is an account image reference for a later renderer. The model
		// receives neither its identifier nor image bytes and must not claim to
		// have seen it.
		tokens := basis.VisualDNA.Tokens
		tokens.LogoAssetID = nil
		visualDNA = map[string]any{"version": basis.VisualDNA.Version, "tokens_hash": basis.VisualDNA.TokensHash, "tokens": tokens,
			"logo_note": "账号 Logo 只作为后续渲染引用，本次模型未收到图片或其资产标识。"}
	}
	input := map[string]any{"work_revision": basis.Revision, "sections": sections, "selected_asset_metadata": assets,
		"template": basis.Template, "ratio": basis.Ratio, "visual_dna": visualDNA}
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	return "任务：为用户选中的作品段落拟定可编辑社交组图卡片计划。只使用本次列出的内容和来源引用。\n<<<用户选中的作品数据 JSON>>\n" + string(encoded) + "\n<<<结束>>\n仅按接口 schema 输出 JSON。", nil
}

func (s *Server) cxRevalidateVisualPlan(ctx context.Context, actor *identity, basis cxVisualPlanBasis, input cxVisualPlanRequest) error {
	if _, err := s.cxAuthorizeAccountAnalysis(ctx, basis.AccountID); err != nil {
		return err
	}
	current, err := s.cxVisualPlanInputSnapshot(ctx, actor.WorkspaceID, basis.WorkID, input)
	if err != nil {
		var apiError *APIError
		if errors.Is(err, pgx.ErrNoRows) || errors.As(err, &apiError) && apiError.Status == http.StatusNotFound {
			return apiErr(http.StatusConflict, "version_conflict", "组图计划依据已变化或失效，请刷新后重试")
		}
		return err
	}
	if current.InputHash != basis.InputHash || current.Revision != basis.Revision {
		return apiErr(http.StatusConflict, "version_conflict", "组图计划依据已变化，请刷新后重试")
	}
	return ctx.Err()
}

func (s *Server) persistCXVisualPlan(ctx context.Context, actor *identity, basis cxVisualPlanBasis, contextHash, model, promptVersion string, aiCallID *uuid.UUID, result cxVisualPlanResult) (uuid.UUID, time.Time, int, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := s.cxAuthorizeAccountAnalysisInTx(ctx, tx, actor, basis.AccountID); err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	input := cxVisualPlanRequest{BasisRevision: basis.Revision, SectionIDs: make([]uuid.UUID, 0, len(basis.Sections)), AssetIDs: make([]uuid.UUID, 0, len(basis.Assets)),
		Template: basis.Template, Ratio: basis.Ratio, DNAVersion: basis.DNAVersion}
	for _, section := range basis.Sections {
		input.SectionIDs = append(input.SectionIDs, section.ID)
	}
	for _, asset := range basis.Assets {
		input.AssetIDs = append(input.AssetIDs, asset.ID)
	}
	current, err := s.readCXVisualPlanBasis(ctx, tx, actor.WorkspaceID, basis.WorkID, input, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, time.Time{}, 0, apiErr(http.StatusConflict, "version_conflict", "作品已变化，组图计划未保存；请刷新后重试")
	}
	if err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	if current.AccountID != basis.AccountID || current.InputHash != basis.InputHash || current.Revision != basis.Revision {
		return uuid.Nil, time.Time{}, 0, apiErr(http.StatusConflict, "version_conflict", "作品依据已变化，组图计划未保存；请刷新后重试")
	}
	if err := ctx.Err(); err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	var id uuid.UUID
	var createdAt time.Time
	err = tx.QueryRow(ctx, `INSERT INTO content_diagnosis (workspace_id,account_id,work_id,kind,basis_revision,input_hash,context_hash,input_scope,
		result,rules_version,model,prompt_version,ai_call_id,created_by)
		VALUES ($1,$2,$3,'visual_plan',$4,$5,$6,'saved',$7,$8,$9,$10,$11,$12) RETURNING id,created_at`,
		actor.WorkspaceID, basis.AccountID, basis.WorkID, basis.Revision, basis.InputHash, contextHash, encoded, cxVisualPlanVersion, model, promptVersion, aiCallID, actor.UserID).Scan(&id, &createdAt)
	if err != nil {
		return uuid.Nil, time.Time{}, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "40001" {
			return uuid.Nil, time.Time{}, 0, apiErr(http.StatusConflict, "version_conflict", "作品依据正在变化，组图计划未保存；请刷新后重试")
		}
		return uuid.Nil, time.Time{}, 0, err
	}
	return id, createdAt.UTC(), 1, nil
}

func (s *Server) findCXVisualPlan(ctx context.Context, workspaceID, workID, actorID uuid.UUID, inputHash, contextHash string) (cxVisualPlanStored, error) {
	return scanCXVisualPlan(s.db.QueryRow(ctx, `SELECT id,workspace_id,account_id,work_id,input_hash,context_hash,result,ai_call_id,model,prompt_version,created_at,result_revision
		FROM content_diagnosis WHERE workspace_id=$1 AND work_id=$2 AND created_by=$3 AND kind='visual_plan' AND input_hash=$4 AND context_hash=$5
		ORDER BY created_at DESC,id DESC LIMIT 1`, workspaceID, workID, actorID, inputHash, contextHash))
}

func scanCXVisualPlan(row interface{ Scan(...any) error }) (cxVisualPlanStored, error) {
	var stored cxVisualPlanStored
	var raw []byte
	if err := row.Scan(&stored.ID, &stored.WorkspaceID, &stored.AccountID, &stored.WorkID, &stored.InputHash, &stored.ContextHash,
		&raw, &stored.AICallID, &stored.Model, &stored.PromptVersion, &stored.CreatedAt, &stored.Revision); err != nil {
		return cxVisualPlanStored{}, err
	}
	if err := json.Unmarshal(raw, &stored.Result); err != nil {
		return cxVisualPlanStored{}, err
	}
	if stored.Result.CXBasis.AccountID != stored.AccountID || stored.Result.CXBasis.WorkRevision == nil || len(stored.Result.SectionIDs) == 0 {
		return cxVisualPlanStored{}, errors.New("组图计划报告与作品来源范围不一致")
	}
	if stored.Result.DNAVersion == nil {
		if stored.Result.VisualDNA != nil || stored.Result.CXBasis.DNARef != nil {
			return cxVisualPlanStored{}, errors.New("组图计划的视觉 DNA 版本快照不一致")
		}
	} else {
		dna := stored.Result.VisualDNA
		wantRef := fmt.Sprintf("visual_dna:%s:%d", stored.AccountID, *stored.Result.DNAVersion)
		if dna == nil || dna.Version != *stored.Result.DNAVersion || stored.Result.CXBasis.DNARef == nil || *stored.Result.CXBasis.DNARef != wantRef {
			return cxVisualPlanStored{}, errors.New("组图计划缺少所选视觉 DNA 版本快照")
		}
		if err := dna.Tokens.validate(); err != nil {
			return cxVisualPlanStored{}, errors.New("组图计划的视觉 DNA 令牌无法验证")
		}
		hash, err := cxVisualDNATokensHash(dna.Tokens)
		if err != nil || hash != dna.TokensHash {
			return cxVisualPlanStored{}, errors.New("组图计划的视觉 DNA 摘要无法验证")
		}
	}
	return stored, nil
}

func cxVisualPlanResponseFromStored(stored cxVisualPlanStored, reused bool) cxVisualPlanResponse {
	return cxVisualPlanResponse{DiagnosisID: stored.ID, WorkID: stored.WorkID, InputHash: stored.InputHash, Template: stored.Result.Template,
		Ratio: stored.Result.Ratio, DNAVersion: stored.Result.DNAVersion, VisualDNA: stored.Result.VisualDNA, SectionIDs: append([]uuid.UUID{}, stored.Result.SectionIDs...),
		AssetIDs: append([]uuid.UUID{}, stored.Result.AssetIDs...), Cards: cxCloneVisualPlanCards(stored.Result.Cards), Coverage: stored.Result.Coverage,
		MissingAssets: append([]string{}, stored.Result.MissingAssets...), Warnings: append([]string{}, stored.Result.Warnings...), CXBasis: stored.Result.CXBasis,
		PlanComplete: stored.Result.PlanComplete, AICallID: stored.AICallID,
		TaskType: "cx_visual_plan", Model: stored.Model, PromptVersion: stored.PromptVersion, Reused: reused, CreatedAt: stored.CreatedAt.UTC(), Revision: stored.Revision}
}

func (s *Server) listCXVisualPlanDiagnoses(w http.ResponseWriter, r *http.Request) error {
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	meta, err := s.workMeta(r.Context(), workID)
	if err != nil {
		return err
	}
	actor, err := s.cxAuthorizeAccountAnalysisRead(r.Context(), meta.Account.ID)
	if err != nil {
		return err
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	const limit = 20
	rows, err := s.db.Query(r.Context(), `SELECT id,workspace_id,account_id,work_id,input_hash,context_hash,result,ai_call_id,model,prompt_version,created_at,result_revision
		FROM content_diagnosis WHERE workspace_id=$1 AND work_id=$2 AND kind='visual_plan' AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4))
		ORDER BY created_at DESC,id DESC LIMIT $5`, actor.WorkspaceID, workID, cursorTime(cursor), cursorID(cursor), limit+1)
	if err != nil {
		return err
	}
	items := []cxVisualPlanResponse{}
	for rows.Next() {
		stored, err := scanCXVisualPlan(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, cxVisualPlanResponseFromStored(stored, false))
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var nextCursor *string
	if len(items) > limit {
		last := items[limit-1]
		value := encodeListCursor(last.CreatedAt, last.DiagnosisID)
		nextCursor = &value
		items = items[:limit]
	}
	for i := range items {
		items[i].Stale, err = s.cxVisualPlanStale(r.Context(), actor.WorkspaceID, workID, cxVisualPlanResult{Template: items[i].Template,
			Ratio: items[i].Ratio, DNAVersion: items[i].DNAVersion, SectionIDs: items[i].SectionIDs, AssetIDs: items[i].AssetIDs, CXBasis: items[i].CXBasis})
		if err != nil {
			return err
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func (s *Server) getCXVisualPlanDiagnosis(w http.ResponseWriter, r *http.Request) error {
	diagnosisID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	actor, err := s.cxAuthorizeAccountAnalysisReader(r.Context())
	if err != nil {
		return err
	}
	stored, err := scanCXVisualPlan(s.db.QueryRow(r.Context(), `SELECT id,workspace_id,account_id,work_id,input_hash,context_hash,result,ai_call_id,model,prompt_version,created_at,result_revision
		FROM content_diagnosis WHERE id=$1 AND workspace_id=$2 AND kind='visual_plan'`, diagnosisID, actor.WorkspaceID))
	if err != nil {
		return err
	}
	if _, err := s.cxAuthorizeAccountAnalysisRead(r.Context(), stored.AccountID); err != nil {
		return err
	}
	response := cxVisualPlanResponseFromStored(stored, false)
	response.Stale, err = s.cxVisualPlanStale(r.Context(), actor.WorkspaceID, stored.WorkID, stored.Result)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, response)
}

func (s *Server) cxVisualPlanStale(ctx context.Context, workspaceID, workID uuid.UUID, result cxVisualPlanResult) (bool, error) {
	if result.CXBasis.WorkRevision == nil || result.Template == "" || result.Ratio == "" {
		return true, nil
	}
	input := cxVisualPlanRequest{SectionIDs: result.SectionIDs, AssetIDs: result.AssetIDs, Template: result.Template, Ratio: result.Ratio, DNAVersion: result.DNAVersion}
	basis, err := s.cxVisualPlanInputSnapshot(ctx, workspaceID, workID, input)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		var apiErr *APIError
		if errors.Is(err, pgx.ErrNoRows) || errors.As(err, &apiErr) && (apiErr.Status == http.StatusConflict || apiErr.Status == http.StatusNotFound) {
			return true, nil
		}
		return false, err
	}
	return basis.InputHash != result.CXBasis.InputHash, nil
}

func cxApplyVisualPlanEdit(previous cxVisualPlanResult, input cxVisualPlanEditRequest) (cxVisualPlanResult, error) {
	sections := make(map[uuid.UUID]cxVisualPlanSection, len(previous.SourceSections))
	for _, section := range previous.SourceSections {
		sections[section.ID] = section
	}
	if len(sections) != len(previous.SectionIDs) {
		return cxVisualPlanResult{}, errors.New("组图计划缺少所选段落快照，不能安全编辑")
	}
	assets := make(map[uuid.UUID]bool, len(previous.AssetIDs))
	for _, id := range previous.AssetIDs {
		assets[id] = true
	}
	originalIDs := make(map[string]bool, len(previous.OriginalCards))
	originalByID := make(map[string]cxVisualPlanCard, len(previous.OriginalCards))
	for _, card := range previous.OriginalCards {
		originalIDs[card.CardID] = true
		originalByID[card.CardID] = card
	}
	currentByID := make(map[string]cxVisualPlanCard, len(previous.Cards))
	for _, card := range previous.Cards {
		currentByID[card.CardID] = card
	}
	confirmationChanges := 0
	output := cxVisualPlanAIOutput{Cards: make([]cxVisualPlanAICard, 0, len(input.Cards)), MissingAssets: append([]string{}, previous.MissingAssets...),
		Warnings: append([]string{}, previous.Warnings...), UncoveredSections: []uuid.UUID{}}
	seenCards := map[string]bool{}
	covered := map[uuid.UUID]bool{}
	for _, card := range input.Cards {
		if card.CardID == "" || !originalIDs[card.CardID] || seenCards[card.CardID] {
			return cxVisualPlanResult{}, validation("组图计划包含未知或重复卡片 ID")
		}
		current, exists := currentByID[card.CardID]
		if !exists {
			return cxVisualPlanResult{}, validation("组图计划包含不存在的当前卡片")
		}
		if card.Confirmed != current.Confirmed {
			confirmationChanges++
			if confirmationChanges > 1 {
				return cxVisualPlanResult{}, validation("每次只能确认或撤销一张组图卡片")
			}
		}
		seenCards[card.CardID] = true
		output.Cards = append(output.Cards, cxVisualPlanAICard{Type: card.Type, SectionIDs: card.SectionIDs, Headline: card.Headline,
			Body: card.Body, AssetIDs: card.AssetIDs, SourceRefs: card.SourceRefs})
		for _, id := range card.SectionIDs {
			covered[id] = true
		}
	}
	for _, id := range previous.SectionIDs {
		if !covered[id] {
			output.UncoveredSections = append(output.UncoveredSections, id)
		}
	}
	validated, err := output.validateAndSummarize(sections, assets)
	if err != nil {
		return cxVisualPlanResult{}, validation("组图计划的来源或内容不符合要求")
	}
	for index := range validated.Cards {
		inputCard := input.Cards[index]
		card := &validated.Cards[index]
		card.CardID = inputCard.CardID
		card.Confirmed = inputCard.Confirmed
		card.Edited = !cxVisualPlanCardsEqual(*card, originalByID[inputCard.CardID])
	}
	validated.Template, validated.Ratio, validated.DNAVersion, validated.VisualDNA = previous.Template, previous.Ratio, previous.DNAVersion, previous.VisualDNA
	validated.SectionIDs = append([]uuid.UUID{}, previous.SectionIDs...)
	validated.AssetIDs = append([]uuid.UUID{}, previous.AssetIDs...)
	validated.SourceSections = append([]cxVisualPlanSection{}, previous.SourceSections...)
	validated.SourceAssets = append([]cxVisualPlanAsset{}, previous.SourceAssets...)
	validated.OriginalCards = cxCloneVisualPlanCards(previous.OriginalCards)
	validated.CXBasis = previous.CXBasis
	return validated, nil
}

func cxVisualPlanCardsEqual(a, b cxVisualPlanCard) bool {
	if a.CardID != b.CardID || a.Type != b.Type || a.Headline != b.Headline || len(a.SectionIDs) != len(b.SectionIDs) || len(a.AssetIDs) != len(b.AssetIDs) || len(a.SourceRefs) != len(b.SourceRefs) {
		return false
	}
	var aBody, bBody bytes.Buffer
	if json.Compact(&aBody, a.Body) != nil || json.Compact(&bBody, b.Body) != nil || aBody.String() != bBody.String() {
		return false
	}
	for i := range a.SectionIDs {
		if a.SectionIDs[i] != b.SectionIDs[i] {
			return false
		}
	}
	for i := range a.AssetIDs {
		if a.AssetIDs[i] != b.AssetIDs[i] {
			return false
		}
	}
	for i := range a.SourceRefs {
		if a.SourceRefs[i] != b.SourceRefs[i] {
			return false
		}
	}
	return true
}

func (s *Server) patchCXVisualPlanDiagnosis(w http.ResponseWriter, r *http.Request) error {
	diagnosisID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	input, err := decodeCXVisualPlanEditRequest(r)
	if err != nil {
		return err
	}
	actor, err := s.cxAuthorizeAccountAnalysisReader(r.Context())
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	stored, err := scanCXVisualPlan(tx.QueryRow(r.Context(), `SELECT id,workspace_id,account_id,work_id,input_hash,context_hash,result,ai_call_id,model,prompt_version,created_at,result_revision
		FROM content_diagnosis WHERE id=$1 AND workspace_id=$2 AND kind='visual_plan' FOR UPDATE`, diagnosisID, actor.WorkspaceID))
	if err != nil {
		return err
	}
	actor, err = s.cxAuthorizeAccountAnalysisInTx(r.Context(), tx, actor, stored.AccountID)
	if err != nil {
		return err
	}
	if stored.Revision != input.ExpectedRevision {
		return apiErr(http.StatusConflict, "version_conflict", "组图计划已被其他编辑更新；请重新读取并比较后再保存")
	}
	updated, err := cxApplyVisualPlanEdit(stored.Result, input)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(updated)
	if err != nil {
		return err
	}
	var revision int
	if err := tx.QueryRow(r.Context(), `UPDATE content_diagnosis SET result=$3,result_revision=result_revision+1
		WHERE id=$1 AND workspace_id=$2 AND kind='visual_plan' AND result_revision=$4 RETURNING result_revision`,
		diagnosisID, actor.WorkspaceID, encoded, input.ExpectedRevision).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusConflict, "version_conflict", "组图计划已被其他编辑更新；请重新读取并比较后再保存")
		}
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "40001" {
			return apiErr(http.StatusConflict, "version_conflict", "组图计划依据正在变化，编辑未保存；请重试")
		}
		return err
	}
	stored.Result, stored.Revision = updated, revision
	response := cxVisualPlanResponseFromStored(stored, false)
	response.Stale, err = s.cxVisualPlanStale(r.Context(), actor.WorkspaceID, stored.WorkID, updated)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "visual_plan_edit", "content_diagnosis", diagnosisID.String(), "ok", map[string]any{"result_revision": revision,
		"confirmed_cards": cxCountConfirmedVisualCards(updated.Cards), "edited_cards": cxCountEditedVisualCards(updated.Cards)})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, response)
}

func cxCountConfirmedVisualCards(cards []cxVisualPlanCard) int {
	count := 0
	for _, card := range cards {
		if card.Confirmed {
			count++
		}
	}
	return count
}

func cxCountEditedVisualCards(cards []cxVisualPlanCard) int {
	count := 0
	for _, card := range cards {
		if card.Edited {
			count++
		}
	}
	return count
}
