package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-CX12 / FR-CX-15：改写度检查。只在用户显式提供本次临时完整参考正文时计算三维；
// 结论是学习参考风险提示，不是"通过即不存在抄袭/侵权"的证明。
// 临时原文不落库/不进日志/不进重放：只存哈希、脱敏结论、维度、版本与 ai_call_id。
const (
	rewriteMinRefCodePoints = 200
	rewriteJaccardSame      = 0.30
)

type cxRewriteDimension struct {
	Dimension string  `json:"dimension"`
	State     string  `json:"state"` // same/different/unavailable
	Evidence  *string `json:"evidence,omitempty"`
	Reference *string `json:"reference_evidence,omitempty"`
}

type cxRewriteCompareOutput struct {
	Expression   cxRewriteDimension   `json:"expression"`
	Evidence     cxRewriteDimension   `json:"evidence"`
	Viewpoint    cxRewriteDimension   `json:"viewpoint"`
	Notes        []string             `json:"notes,omitempty"`
}

type cxRewriteCheckResponse struct {
	Result        string               `json:"result"` // pass/fail/undetermined
	Dimensions    []cxRewriteDimension `json:"dimensions"`
	ReferenceHash string               `json:"reference_hash"`
	// ReferenceTextRequired 标记「仅参考了结构骨架」：结论 undetermined，需要粘贴完整
	// 参考正文复核（FR-CX-15：不把骨架的省略信息当作不同，也不据此给 pass）。
	ReferenceTextRequired bool       `json:"reference_text_required,omitempty"`
	AICallID              *uuid.UUID `json:"ai_call_id,omitempty"`
	Model                 string     `json:"model,omitempty"`
	PromptVersion         string     `json:"prompt_version"`
	CreatedAt             time.Time  `json:"created_at"`
}

// cxJaccardState 按规格实现表达维：NFKC+去标点/空白，4-gram 集合 Jaccard<0.30 different、
// >=0.30 same；少于 200 码点 unavailable。
func cxJaccardState(reference, work []rune) string {
	if len(reference) < rewriteMinRefCodePoints || len(work) < rewriteMinRefCodePoints {
		return "unavailable"
	}
	refGrams := cxGramSet(reference)
	workGrams := cxGramSet(work)
	if len(refGrams) == 0 || len(workGrams) == 0 {
		return "unavailable"
	}
	intersection := 0
	for gram := range workGrams {
		if _, hit := refGrams[gram]; hit {
			intersection++
		}
	}
	union := len(refGrams) + len(workGrams) - intersection
	if union == 0 {
		return "unavailable"
	}
	if float64(intersection)/float64(union) >= rewriteJaccardSame {
		return "same"
	}
	return "different"
}

func (d cxRewriteDimension) validate() error {
	if d.State != "same" && d.State != "different" && d.State != "unavailable" {
		return validation("三维状态只能是 same/different/unavailable")
	}
	if d.State != "unavailable" {
		if d.Evidence == nil || strings.TrimSpace(*d.Evidence) == "" {
			return validation("可判断的维度必须给出作品侧证据")
		}
		if len([]rune(*d.Evidence)) > 120 {
			return validation("维度证据最多 120 码点")
		}
		if d.Reference != nil && len([]rune(*d.Reference)) > 120 {
			return validation("参考侧证据最多 120 码点")
		}
	} else if d.Evidence != nil && len([]rune(*d.Evidence)) > 120 {
		return validation("维度证据最多 120 码点")
	}
	return nil
}

func (o *cxRewriteCompareOutput) validate() error {
	if err := o.Expression.validate(); err != nil {
		return err
	}
	if err := o.Evidence.validate(); err != nil {
		return err
	}
	if err := o.Viewpoint.validate(); err != nil {
		return err
	}
	for _, note := range o.Notes {
		if len([]rune(note)) > 200 {
			return validation("notes 每条最多 200 码点")
		}
	}
	return nil
}

// deriveRewriteResult 按规格汇总：任一 unavailable → undetermined；
// 全部可判断且 ≥2 different → pass；其余可判断 → fail。完全相同直接 fail。
func deriveRewriteResult(dims []cxRewriteDimension) string {
	unavailable := false
	different := 0
	for _, dim := range dims {
		if dim.State == "unavailable" {
			unavailable = true
		}
		if dim.State == "different" {
			different++
		}
	}
	if unavailable {
		return "undetermined"
	}
	if different >= 2 {
		return "pass"
	}
	return "fail"
}

// verifyDimensionEvidence 服务端检验 AI 给出的作品侧证据确实存在于当前作品正文。
func verifyDimensionEvidence(workText string, dims []cxRewriteDimension) error {
	for _, dim := range dims {
		if dim.State == "unavailable" || dim.Evidence == nil {
			continue
		}
		if !strings.Contains(workText, *dim.Evidence) {
			return validation("维度证据必须逐字来自当前作品正文")
		}
	}
	return nil
}

func (s *Server) rewriteCheck(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		BasisRevision   int      `json:"basis_revision"`
		CheckRunID      *string  `json:"check_run_id"`
		ReferenceText   string   `json:"reference_text"`
		SkeletonNoteIDs []string `json:"skeleton_note_ids"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	reference := []rune(strings.TrimSpace(in.ReferenceText))
	ctx := r.Context()
	// 参考正文可能为空（not_applicable 语义：不给普通作品制造必失败项），
	// 但显式提供时须满足最短长度。
	emptyRef := len(reference) == 0
	if !emptyRef && len(reference) < rewriteMinRefCodePoints {
		return validation("参考正文不足 200 码点，表达维度无法判断；请粘贴完整参考或留空")
	}
	// 完整正文与结构骨架是两种互斥的参考方式：给了正文就按正文计算三维。
	if !emptyRef && len(in.SkeletonNoteIDs) > 0 {
		return validation("完整参考正文与结构骨架只能二选一：粘贴正文即按正文计算，选骨架则不要粘贴正文")
	}

	// 当前 check_run 必须存在且与请求一致（run 已变/不存在 409 check_context_changed）。
	var runID uuid.UUID
	var runRevision int
	var runPlatform string
	if in.CheckRunID == nil || *in.CheckRunID == "" {
		return validation("需要当前检查 run 标识")
	}
	parsedRun, err := uuid.Parse(*in.CheckRunID)
	if err != nil {
		return validation("check_run_id 格式不正确")
	}
	err = s.db.QueryRow(ctx, `SELECT id, revision, target_platform FROM check_run WHERE id=$1 AND work_id=$2`,
		parsedRun, m.ID).Scan(&runID, &runRevision, &runPlatform)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "check_context_changed", "检查已重新开始或不存在，请刷新检查页后重试")
	}
	if err != nil {
		return err
	}
	if in.BasisRevision != runRevision {
		return apiErr(409, "check_context_changed", "作品内容在检查后又修改过，请重新检查")
	}
	// 骨架引用（仅 benchmark_note 骨架、无完整参考正文）→ undetermined + reference_text_required。
	// 显式路径：用户选择的对标骨架按账号校验存在且未归档，与大纲侧同一数据边界。
	skeletonRef := false
	if emptyRef && len(in.SkeletonNoteIDs) > 0 {
		if len(in.SkeletonNoteIDs) > 5 {
			return validation("骨架引用最多选择 5 条")
		}
		seen := map[uuid.UUID]bool{}
		for _, rawID := range in.SkeletonNoteIDs {
			noteID, err := uuid.Parse(strings.TrimSpace(rawID))
			if err != nil {
				return validation("骨架引用标识格式不正确")
			}
			if seen[noteID] {
				continue
			}
			seen[noteID] = true
			var exists bool
			if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM benchmark_note bn
				JOIN benchmark_target bt ON bt.id=bn.target_id
				WHERE bn.id=$1 AND bt.account_id=$2 AND bn.archived_at IS NULL)`,
				noteID, m.Account.ID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return validation("骨架引用不在当前账号范围内")
			}
		}
		skeletonRef = true
	}
	skeletonOnly := emptyRef

	// 作品正文快照（当前 revision）。
	wk, err := s.loadWork(ctx, m.ID)
	if err != nil {
		return err
	}
	if wk.Revision != runRevision || wk.Platform != runPlatform {
		return apiErr(409, "check_context_changed", "作品内容在检查后又修改过，请重新检查")
	}
	var body strings.Builder
	for _, section := range wk.Sections {
		body.WriteString(section.ContentMD)
		body.WriteString("\n\n")
	}
	workText := body.String()

	var output cxRewriteCompareOutput
	var aiCallID *uuid.UUID
	modelName := ""
	promptVersion := ""
	if !skeletonOnly {
		// AI 比对：表达维由服务端确定性计算，AI 只给案例/证据与核心观点两维。
		userPrompt := "比较下列两段文字。只输出 JSON：{\"expression\":{\"state\":\"same|different|unavailable\",\"evidence\":\"作品侧原句摘录≤120字\"}," +
			"\"evidence\":{\"state\":\"...\",\"evidence\":\"...\",\"reference_evidence\":\"参考侧原句摘录≤120字\"}," +
			"\"viewpoint\":{\"state\":\"...\",\"evidence\":\"...\"},\"notes\":[≤200字]}。" +
			"维度含义：expression=表达方式（服务端另有精确计算，你只需给作品侧最接近参考的句子）；evidence=案例与证据（事实、数字、故事是否相同）；viewpoint=核心观点。" +
			"state 判定：same=明显同源、different=确实不同、unavailable=无法判断。禁止编造；evidence 必须逐字摘自对应文本。\n\n" +
			"【作品正文】\n" + workText + "\n【参考正文】\n" + string(reference)
		aiResult, aiErr := s.runAIJSON(ctx, aiTask{Type: "cx_rewrite_compare", Account: m.Account, WorkID: &m.ID, User: userPrompt, Bare: true, SkipStyle: true},
			&output, output.validate)
		if aiErr != nil {
			return aiErr
		}
		aiCallID = &aiResult.CallID
		promptVersion = "cx-rewrite-1"
		// 服务端检验摘录存在（作品侧必须逐字在正文中）。
		if err := verifyDimensionEvidence(workText, []cxRewriteDimension{output.Expression, output.Evidence, output.Viewpoint}); err != nil {
			return err
		}
		if err := s.db.QueryRow(ctx, `SELECT model FROM ai_call WHERE id=$1 AND workspace_id=$2`, aiResult.CallID, ident(ctx).WorkspaceID).Scan(&modelName); err != nil {
			modelName = ""
		}
	}

	// 表达维：确定性 Jaccard 覆盖 AI 结论（不伪称规则分）。
	expressionState := "unavailable"
	if !skeletonOnly {
		expressionState = cxJaccardState(cxNormalizeText(string(reference)), cxNormalizeText(workText))
	}
	dims := []cxRewriteDimension{}
	if skeletonOnly {
		dims = append(dims,
			cxRewriteDimension{Dimension: "expression", State: "unavailable"},
			cxRewriteDimension{Dimension: "evidence", State: "unavailable"},
			cxRewriteDimension{Dimension: "viewpoint", State: "unavailable"})
	} else {
		dims = append(dims,
			cxRewriteDimension{Dimension: "expression", State: expressionState, Evidence: output.Expression.Evidence, Reference: output.Expression.Reference},
			output.Evidence,
			output.Viewpoint)
		for i := range dims {
			dims[i].Dimension = []string{"expression", "evidence", "viewpoint"}[i]
		}
	}

	// 完全相同直接 fail（表达 same + 其余 same）。
	result := deriveRewriteResult(dims)
	referenceHash := benchmarkContentHash([]byte(string(reference)))
	resp := cxRewriteCheckResponse{
		Result: result, Dimensions: dims, ReferenceHash: referenceHash,
		ReferenceTextRequired: skeletonRef,
		AICallID:              aiCallID, Model: modelName, PromptVersion: promptVersion, CreatedAt: time.Now(),
	}
	if skeletonOnly {
		resp.PromptVersion = "skeleton_only"
	}

	// 结果写为当前 run 的 rewrite 检查项：fail/undetermined 生成待处理项（passed=false）；
	// pass 也记录来源（passed=true），过期报告不能复用。
	// 无参考正文且无骨架（not_applicable）完全不建项，不给普通作品制造必失败项；
	// 显式骨架引用走 undetermined 待处理项（reference_text_required 提示补正文）。
	if skeletonOnly && !skeletonRef {
		s.audit(ctx, "rewrite_check", "check_run", runID.String(), "ok", map[string]any{"result": "not_applicable"})
		return ok(w, resp)
	}
	// fingerprint 不含参考哈希：同一 run 内骨架结论会被随后的正文结论替换，
	// 检查页对改写度始终只保留最新一条结论。
	fingerprint := fingerprint("rewrite", "reference", "")
	var itemID uuid.UUID
	passed := result == "pass"
	message := map[string]string{
		"pass":         "改写度：低风险（学习参考提示，不构成原创证明）",
		"fail":         "改写度：与参考正文明显同源，需要修改后重查",
		"undetermined": "改写度：无法判定，需要完整参考正文或人工复核",
	}[result]
	if skeletonRef {
		message = "改写度：仅参考结构骨架，无法判定；请粘贴完整参考正文复核"
	}
	detailBytes, _ := json.Marshal(map[string]any{"dimensions": dims, "reference_hash": resp.ReferenceHash,
		"ai_call_id": aiCallID, "model": modelName, "prompt_version": resp.PromptVersion,
		"skeleton_only": skeletonOnly, "reference_text_required": skeletonRef})
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		// 同一 run 内同 fingerprint 幂等：替换旧 rewrite 结论。
		if err := tx.QueryRow(ctx, `SELECT id FROM check_item WHERE check_run_id=$1 AND category='rewrite' AND fingerprint=$2`,
			runID, fingerprint).Scan(&itemID); err == nil {
			if _, err := tx.Exec(ctx, `DELETE FROM check_item WHERE id=$1`, itemID); err != nil {
				return err
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return tx.QueryRow(ctx, `INSERT INTO check_item (check_run_id, category, passed, fingerprint, matched_text, location, message, detail)
			VALUES ($1,'rewrite',$2,$3,'',$4,$5,$6) RETURNING id`,
			runID, passed, fingerprint, map[string]any{}, message, string(detailBytes)).Scan(&itemID)
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "rewrite_check", "check_item", itemID.String(), "ok", map[string]any{
		"work_id": m.ID.String(), "result": result, "reference_hash": resp.ReferenceHash,
		"skeleton_only": skeletonOnly, "reference_text_required": skeletonRef})
	return ok(w, resp)
}

// resolveCheckItemReason 扩展 PATCH /check-items/{id}：rewrite 类 acknowledged 需要 20..500 码点理由。
func validateRewriteReason(category, resolution string, reason *string) error {
	if category != "rewrite" {
		return nil
	}
	if resolution == "acknowledged" {
		if reason == nil {
			return validation("确认改写度风险需要填写理由")
		}
		n := len([]rune(strings.TrimSpace(*reason)))
		if n < 20 || n > 500 {
			return validation("理由须为 20..500 码点")
		}
	}
	if resolution == "modified" && reason != nil && len([]rune(strings.TrimSpace(*reason))) > 500 {
		return validation("理由最多 500 码点")
	}
	return nil
}
