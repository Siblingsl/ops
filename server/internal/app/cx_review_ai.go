package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const cxReviewAnalysisV2PromptVersion = "cx-review-v2-1"

type CXReviewAnalysisV2 struct {
	SchemaVersion int                          `json:"schema_version"`
	Observations  []cxReviewObservation        `json:"observations"`
	Hypotheses    []cxReviewHypothesis         `json:"hypotheses"`
	Experiments   []cxReviewExperimentProposal `json:"experiments"`
	Limitations   []cxReviewLimitation         `json:"limitations"`
}

type cxReviewObservation struct {
	Finding    string   `json:"finding"`
	SourceRefs []string `json:"source_refs"`
}

type cxReviewHypothesis struct {
	Explanation     string   `json:"explanation"`
	SourceRefs      []string `json:"source_refs"`
	Counterevidence []string `json:"counterevidence"`
	Confounders     []string `json:"confounders"`
}

type cxReviewExperimentProposal struct {
	Hypothesis        string `json:"hypothesis"`
	Variable          string `json:"variable"`
	MetricKey         string `json:"metric_key"`
	Window            string `json:"window"`
	SelectionProposal string `json:"selection_proposal"`
}

type cxReviewLimitation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type cxReviewV2Output struct {
	Conclusions      []string                `json:"conclusions"`
	TopicSuggestions []ReviewTopicSuggestion `json:"topic_suggestions"`
	WritingInsights  []string                `json:"writing_insights"`
	AnalysisV2       *CXReviewAnalysisV2     `json:"analysis_v2"`
}

func (o *cxReviewV2Output) UnmarshalJSON(raw []byte) error {
	if err := cxRejectDuplicateJSONKeys(raw); err != nil {
		return err
	}
	type plain cxReviewV2Output
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("复盘 v2 输出包含多个 JSON 值")
		}
		return err
	}
	*o = cxReviewV2Output(value)
	return nil
}

type cxReviewFollowerFact struct {
	SourceRef string `json:"source_ref"`
	Date      string `json:"date"`
	Source    string `json:"source"`
	Cumulate  int    `json:"cumulate"`
	Unit      string `json:"unit"`
}

type cxReviewSourceFact struct {
	SourceRef  string         `json:"source_ref"`
	Kind       string         `json:"kind"`
	WorkID     *uuid.UUID     `json:"work_id,omitempty"`
	MetricID   *uuid.UUID     `json:"metric_id,omitempty"`
	Revision   int            `json:"revision,omitempty"`
	CapturedAt *time.Time     `json:"captured_at,omitempty"`
	Fields     map[string]any `json:"fields"`
}

type cxReviewAIWorkBasis struct {
	WorkID           uuid.UUID            `json:"work_id"`
	SourceRef        string               `json:"source_ref"`
	Title            string               `json:"title"`
	Summary          string               `json:"summary"`
	Viewpoint        string               `json:"viewpoint"`
	Topics           []string             `json:"topics"`
	CoverAssetID     *uuid.UUID           `json:"cover_asset_id"`
	CoverImageLoaded bool                 `json:"cover_image_loaded"`
	ContentFormat    string               `json:"content_format"`
	Status           string               `json:"status"`
	WorkRevision     int                  `json:"work_revision"`
	PublishRevision  int                  `json:"publish_revision"`
	PublishedAt      *time.Time           `json:"published_at"`
	Windows          []cxReviewWindowView `json:"windows"`
}

type cxReviewAIBasis struct {
	SchemaVersion         int                   `json:"schema_version"`
	AnalysisVersion       int                   `json:"analysis_version"`
	PromptVersion         string                `json:"prompt_version"`
	TaskType              string                `json:"task_type"`
	AssembledAt           time.Time             `json:"assembled_at"`
	ContextHash           string                `json:"context_hash"`
	Sampling              string                `json:"sampling"`
	Platform              string                `json:"platform"`
	ContentFormat         string                `json:"content_format"`
	Selection             map[string]any        `json:"selection"`
	WorkIDs               []uuid.UUID           `json:"work_ids"`
	Works                 []cxReviewAIWorkBasis `json:"works"`
	Followers             *cxReviewFollowerFact `json:"followers,omitempty"`
	SourceRefs            []string              `json:"source_refs"`
	Sources               []cxReviewSourceFact  `json:"sources"`
	Missing               []cxReviewLimitation  `json:"missing"`
	AICallID              *uuid.UUID            `json:"ai_call_id,omitempty"`
	Model                 string                `json:"model,omitempty"`
	PromptTemplateVersion int                   `json:"prompt_template_version,omitempty"`
}

func validateCXReviewV2Output(output *cxReviewV2Output, allowed map[string]bool) error {
	if output.AnalysisV2 == nil || output.AnalysisV2.SchemaVersion != 1 {
		return errors.New("analysis_v2.schema_version 必须为 1")
	}
	if output.Conclusions == nil || output.TopicSuggestions == nil || output.WritingInsights == nil {
		return errors.New("旧版 conclusions、topic_suggestions、writing_insights 字段必须保留为数组")
	}
	if len(output.TopicSuggestions) < 3 {
		return errors.New("选题建议少于 3 条")
	}
	analysis := output.AnalysisV2
	if len(analysis.Observations) > 10 || len(analysis.Hypotheses) > 10 || len(analysis.Experiments) > 10 || len(analysis.Limitations) > 10 {
		return errors.New("analysis_v2 每个数组最多 10 项")
	}
	for _, observation := range analysis.Observations {
		if !cxReviewTextWithin(observation.Finding, 300) || !cxReviewValidSourceRefs(observation.SourceRefs, allowed, true) {
			return errors.New("observation 需包含不超过 300 字的事实及本次来源引用")
		}
	}
	for _, hypothesis := range analysis.Hypotheses {
		if !cxReviewTextWithin(hypothesis.Explanation, 300) || !cxReviewValidSourceRefs(hypothesis.SourceRefs, allowed, true) ||
			!cxReviewTextsWithin(hypothesis.Counterevidence, 5, 200) || !cxReviewTextsWithin(hypothesis.Confounders, 5, 200) {
			return errors.New("hypothesis 的说明、来源、反例或混杂因素不符合 schema")
		}
	}
	for _, experiment := range analysis.Experiments {
		if !cxReviewTextWithin(experiment.Hypothesis, 300) || !cxReviewTextWithin(experiment.SelectionProposal, 300) ||
			!cxReviewExperimentVariable(experiment.Variable) || !cxReviewMetricKey(experiment.MetricKey) || !cxReviewWindowKey(experiment.Window) {
			return errors.New("experiment 建议包含无效变量、口径、窗口或超长文本")
		}
	}
	for _, limitation := range analysis.Limitations {
		if !cxReviewLimitationCode(limitation.Code) || !cxReviewTextWithin(limitation.Message, 200) {
			return errors.New("limitation 的代码或说明不符合 schema")
		}
	}
	return nil
}

func cxReviewTextWithin(text string, maximum int) bool {
	return len([]rune(strings.TrimSpace(text))) > 0 && len([]rune(text)) <= maximum
}

func cxReviewTextsWithin(items []string, maximumCount, maximumLength int) bool {
	if len(items) > maximumCount {
		return false
	}
	for _, item := range items {
		if !cxReviewTextWithin(item, maximumLength) {
			return false
		}
	}
	return true
}

func cxReviewValidSourceRefs(refs []string, allowed map[string]bool, requireOne bool) bool {
	if len(refs) > 10 || (requireOne && len(refs) == 0) {
		return false
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		if !allowed[ref] || seen[ref] {
			return false
		}
		seen[ref] = true
	}
	return true
}

func cxReviewExperimentVariable(value string) bool {
	return value == "title" || value == "cover" || value == "topic" || value == "format" || value == "posting_time"
}

func cxReviewMetricKey(value string) bool {
	return value == "favorite_rate" || value == "interaction_rate" || value == "follow_rate"
}

func cxReviewWindowKey(value string) bool {
	_, _, _, ok := cxReviewWindowRange(time.Now(), value)
	return ok
}

func cxReviewLimitationCode(value string) bool {
	return value == "low_sample" || value == "missing_metric" || value == "unit_unknown" || value == "partial_content" || value == "other"
}

func (s *Server) buildReviewV2(ctx context.Context, account *Account, requested []uuid.UUID, recent int, contentFormat, origin, tier string) (*ReviewReport, error) {
	if account.Platform == "toutiao" {
		if contentFormat != "long_article" && contentFormat != "micro_post" {
			return nil, validation("请选择文章或微头条后再生成复盘")
		}
	} else {
		if contentFormat == "" {
			contentFormat = account.ContentFormat
		}
		if contentFormat != account.ContentFormat {
			return nil, validation("该账号不支持所选复盘形态")
		}
	}
	if len(requested) > 30 {
		return nil, validation("一次复盘最多选择 30 篇作品")
	}
	works, err := s.cxReviewV2SelectedWorks(ctx, account, requested, recent, contentFormat)
	if err != nil {
		return nil, err
	}
	workIDs := make([]uuid.UUID, 0, len(works))
	for _, work := range works {
		workIDs = append(workIDs, work.ID)
	}
	basis, allowed, err := s.cxReviewBuildAIBasis(ctx, account, works, contentFormat)
	if err != nil {
		return nil, err
	}
	basisJSON, err := json.Marshal(basis)
	if err != nil {
		return nil, err
	}
	prompt := `根据以下本人账号作品与正式指标快照进行复盘。必须将“观察事实”与“可能解释”分开；所有事实及解释的 source_refs 只能逐字取自输入 cx_basis.source_refs。不得将相关性称为因果关系，不得从缺失数据推算，不得把未知或空值当零；只给有限范围的探索建议。封面仅提供资产标识，没有加载图片，不能评价封面视觉。

analysis_v2.observations 只写可由引用支持的事实。analysis_v2.hypotheses 必须包含反例和混杂因素。小样本也要保留可执行的探索建议，并在 limitations 标注 low_sample/missing_metric/unit_unknown/partial_content。experiment 只是建议草案，用户之后需逐项创建人工实验。

保留旧版 conclusions、topic_suggestions、writing_insights 三个数组；topic_suggestions 至少 3 条，以保留旧版逐项采用链。每条选题建议不得写入选题池。严格使用以下 JSON schema，字段不能增删：{"conclusions":["..."],"topic_suggestions":[{"title":"...","angle":"...","reason":"..."}],"writing_insights":["..."],"analysis_v2":{"schema_version":1,"observations":[{"finding":"...","source_refs":["..."]}],"hypotheses":[{"explanation":"...","source_refs":["..."],"counterevidence":["..."],"confounders":["..."]}],"experiments":[{"hypothesis":"...","variable":"title|cover|topic|format|posting_time","metric_key":"favorite_rate|interaction_rate|follow_rate","window":"T1|T3|T7|T30","selection_proposal":"..."}],"limitations":[{"code":"low_sample|missing_metric|unit_unknown|partial_content|other","message":"..."}]}}

本次输入：
` + string(basisJSON)
	var output cxReviewV2Output
	refs := map[string]any{"origin": origin, "content_format": contentFormat, "analysis_version": 2, "cx_prompt_version": cxReviewAnalysisV2PromptVersion,
		"works": len(workIDs), "context_hash": basis.ContextHash}
	accountCopy := *account
	res, err := s.runAIJSON(ctx, aiTask{Type: "review_analysis", Account: &accountCopy, User: prompt, SkipStyle: true, Tier: tier, Refs: refs}, &output, func() error {
		return validateCXReviewV2Output(&output, allowed)
	})
	if err != nil {
		return nil, err
	}
	latestWorks, err := s.cxReviewV2SelectedWorks(ctx, account, requested, recent, contentFormat)
	if err != nil {
		return nil, err
	}
	latestBasis, _, err := s.cxReviewBuildAIBasis(ctx, account, latestWorks, contentFormat)
	if err != nil {
		return nil, err
	}
	if err := cxReviewAIContextDiff(basis.ContextHash, latestBasis.ContextHash); err != nil {
		return nil, err
	}
	cxReviewMergeServerLimitations(&output.AnalysisV2.Limitations, basis.Missing)
	basis.AICallID = &res.CallID
	basis.Model, _ = res.Refs["model"].(string)
	basis.PromptTemplateVersion, _ = res.Refs["prompt_version"].(int)
	basis.AssembledAt = time.Now().UTC()
	basisJSON, err = json.Marshal(basis)
	if err != nil {
		return nil, err
	}
	content := ReviewContent{ContentFormat: contentFormat, Conclusions: output.Conclusions, TopicSuggestions: output.TopicSuggestions,
		WritingInsights: output.WritingInsights, CXBasis: basisJSON, AnalysisV2: output.AnalysisV2}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		return nil, err
	}
	var report ReviewReport
	err = s.db.QueryRow(context.WithoutCancel(ctx), `INSERT INTO review_report (account_id,work_ids,content,ai_call_id,origin)
		VALUES($1,$2,$3,$4,$5) RETURNING id,created_at`, account.ID, workIDs, contentJSON, res.CallID, origin).Scan(&report.ID, &report.CreatedAt)
	if err != nil {
		return nil, err
	}
	report.Origin, report.WorkIDs, report.Content = origin, workIDs, content
	report.Adopted, report.Remembered, report.Ignored = []int32{}, []int32{}, []int32{}
	report.ContentRevision = cxReviewContentRevision(report.Content)
	return &report, nil
}

func (s *Server) cxReviewV2SelectedWorks(ctx context.Context, account *Account, requested []uuid.UUID, recent int, contentFormat string) ([]cxReviewWorkSnapshot, error) {
	ids := requested
	if len(ids) == 0 {
		if recent <= 0 || recent > 30 {
			recent = 10
		}
		rows, err := s.db.Query(ctx, `SELECT w.id FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.account_id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL AND w.status='published' AND ($3='' OR w.content_format=$3)
			ORDER BY coalesce(w.published_at,w.updated_at) DESC,w.id DESC LIMIT $4`, account.ID, ident(ctx).WorkspaceID, contentFormat, recent)
		if err != nil {
			return nil, err
		}
		ids = []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	seen := map[uuid.UUID]bool{}
	works := make([]cxReviewWorkSnapshot, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			return nil, validation("所选作品不能重复")
		}
		seen[id] = true
		work, err := s.cxReviewWorkSnapshot(ctx, account.ID, id)
		if err != nil {
			return nil, err
		}
		if contentFormat != "" && work.ContentFormat != contentFormat {
			return nil, validation("所选作品中包含其他形态，请按形态分开复盘")
		}
		works = append(works, work)
	}
	return works, nil
}

func (s *Server) cxReviewBuildAIBasis(ctx context.Context, account *Account, works []cxReviewWorkSnapshot, contentFormat string) (cxReviewAIBasis, map[string]bool, error) {
	basis := cxReviewAIBasis{SchemaVersion: 1, AnalysisVersion: 2, PromptVersion: cxReviewAnalysisV2PromptVersion,
		TaskType: "review_analysis", AssembledAt: time.Now().UTC(), Sampling: "retained_snapshots", Platform: account.Platform,
		ContentFormat: contentFormat, Selection: map[string]any{"work_scope": "explicit_or_recent_published", "metric_quality": "approved",
			"metric_source": "metric_source_supported", "window_rule": "nearest_target_then_earlier_then_metric_source_order_then_id",
			"ratio_precision": "unrounded", "baseline_limit": 10, "baseline_minimum_per_ratio": 5, "content_scope": "title_summary_viewpoint_topics_metadata_only"},
		WorkIDs: []uuid.UUID{}, Works: []cxReviewAIWorkBasis{}, SourceRefs: []string{}, Sources: []cxReviewSourceFact{}, Missing: []cxReviewLimitation{}}
	allowed := map[string]bool{}
	for _, work := range works {
		basis.WorkIDs = append(basis.WorkIDs, work.ID)
		workRef := fmt.Sprintf("work:%s:revision:%d", work.ID, work.Revision)
		allowed[workRef] = true
		basis.SourceRefs = append(basis.SourceRefs, workRef)
		basis.Sources = append(basis.Sources, cxReviewSourceFact{SourceRef: workRef, Kind: "work_content_metadata", WorkID: &work.ID,
			Revision: work.Revision, Fields: map[string]any{"title": work.Title, "summary": work.Summary, "viewpoint": work.Viewpoint,
				"topics": work.Topics, "cover_asset_id": work.CoverAssetID, "content_format": work.ContentFormat,
				"status": work.Status, "published_at": work.PublishedAt, "publish_revision": work.PublishRevision}})
		workBasis := cxReviewAIWorkBasis{WorkID: work.ID, SourceRef: workRef, Title: work.Title, Summary: work.Summary, Viewpoint: work.Viewpoint,
			Topics: append([]string(nil), work.Topics...), CoverAssetID: work.CoverAssetID, CoverImageLoaded: false, ContentFormat: work.ContentFormat,
			Status: work.Status, WorkRevision: work.Revision, PublishRevision: work.PublishRevision, PublishedAt: work.PublishedAt,
			Windows: []cxReviewWindowView{}}
		var prior []cxReviewWorkSnapshot
		var err error
		if work.PublishedAt != nil {
			prior, err = s.cxReviewPriorWorks(ctx, account.ID, *work.PublishedAt, work.ContentFormat, 10)
			if err != nil {
				return basis, nil, err
			}
		}
		validRatios, missingWindows, unknownUnits := 0, 0, 0
		lowSampleBaseline := false
		for _, definition := range cxReviewWindows {
			picked, retained, reasons := selectCXReviewWindowMetric(work.Metrics, work.PublishedAt, definition.Key)
			view := cxReviewWindowView{Window: definition.Key, MetricRef: cxReviewMetricReference(picked), Ratios: cxReviewRatios(picked),
				MissingReasons: append([]string(nil), reasons...), Baseline: map[string]cxReviewBaselineStat{},
				Coverage: cxReviewWindowCoverage{RetainedSnapshots: retained, FormalSnapshots: cxReviewFormalCount(work.Metrics, work.PublishedAt, definition.Key)}}
			if work.PublishedAt != nil {
				start, end, target, _ := cxReviewWindowRange(*work.PublishedAt, definition.Key)
				view.Range, view.TargetAt = &cxReviewWindowRangeView{From: start, To: end}, &target
			}
			if picked != nil {
				if !cxReviewKnownReadUnit(picked.ReadUnit) {
					unknownUnits++
				}
				metricRef := fmt.Sprintf("metric:%s:revision:%d", picked.ID, picked.Revision)
				allowed[metricRef] = true
				basis.SourceRefs = append(basis.SourceRefs, metricRef)
				metricID := picked.ID
				basis.Sources = append(basis.Sources, cxReviewSourceFact{SourceRef: metricRef, Kind: "approved_metric_snapshot", WorkID: &work.ID,
					MetricID: &metricID, Revision: picked.Revision, CapturedAt: &picked.CapturedAt,
					Fields: map[string]any{"source": picked.Source, "quality": picked.QualityState, "read_unit": picked.ReadUnit, "share_unit": picked.ShareUnit,
						"reads": picked.Reads, "likes": picked.Likes, "wows": picked.Wows, "favorites": picked.Favorites,
						"comments": picked.Comments, "shares": picked.Shares, "follows_gained": picked.FollowsGained}})
				for _, ratio := range []cxReviewRatio{view.Ratios.FavoriteRate, view.Ratios.FollowRate, view.Ratios.InteractionRate} {
					if ratio.Value != nil {
						validRatios++
					} else {
						view.MissingReasons = append(view.MissingReasons, ratio.MissingReasons...)
					}
				}
			} else {
				missingWindows++
			}
			view.MissingReasons = cxSortedUnique(view.MissingReasons)
			for _, key := range []string{"favorite_rate", "follow_rate", "interaction_rate"} {
				view.Baseline[key] = cxReviewBaseline(work, definition.Key, picked, key, prior)
				if view.Baseline[key].SampleSize < 5 {
					lowSampleBaseline = true
				}
				for _, sample := range view.Baseline[key].Samples {
					workRef := fmt.Sprintf("work:%s:revision:%d", sample.WorkID, sample.WorkRevision)
					metricRef := fmt.Sprintf("metric:%s:revision:%d", sample.MetricRef.ID, sample.MetricRef.Revision)
					allowed[workRef], allowed[metricRef] = true, true
					basis.SourceRefs = append(basis.SourceRefs, workRef, metricRef)
				}
			}
			workBasis.Windows = append(workBasis.Windows, view)
		}
		basis.Works = append(basis.Works, workBasis)
		if validRatios == 0 {
			basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "missing_metric", Message: "所选作品没有可用于效果比较的正式窗口指标"})
		}
		if missingWindows > 0 {
			basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "missing_metric", Message: fmt.Sprintf("%d 个窗口缺少可用的正式指标", missingWindows)})
		}
		if unknownUnits > 0 {
			basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "unit_unknown", Message: "部分阅读指标单位未知，未作为正式分母"})
		}
		if lowSampleBaseline {
			basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "low_sample", Message: "部分窗口或口径的同账号基准少于 5 篇有效作品，不展示基准中位数"})
		}
	}
	if len(works) < 5 {
		basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "low_sample", Message: fmt.Sprintf("本次选择 %d 篇作品；不足以形成稳定的同口径基准", len(works))})
	}
	if len(works) == 0 {
		basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "missing_metric", Message: "本次没有选定已保存作品，不能陈述作品表现事实"})
	}
	basis.Missing = cxReviewUniqueLimitations(basis.Missing)
	followers, err := s.cxReviewLatestFollower(ctx, account.ID)
	if err != nil {
		return basis, nil, err
	}
	basis.Followers = followers
	if basis.Followers != nil {
		allowed[basis.Followers.SourceRef] = true
		basis.SourceRefs = append(basis.SourceRefs, basis.Followers.SourceRef)
		basis.Sources = append(basis.Sources, cxReviewSourceFact{SourceRef: basis.Followers.SourceRef, Kind: "account_follower_snapshot",
			Fields: map[string]any{"date": basis.Followers.Date, "source": basis.Followers.Source, "cumulate": basis.Followers.Cumulate, "unit": basis.Followers.Unit}})
	} else {
		basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "other", Message: "没有可用的账号粉丝总数快照"})
	}
	basis.SourceRefs = cxSortedUnique(basis.SourceRefs)
	sort.Slice(basis.Sources, func(i, j int) bool { return basis.Sources[i].SourceRef < basis.Sources[j].SourceRef })
	if len(works) > 0 {
		basis.Missing = append(basis.Missing, cxReviewLimitation{Code: "partial_content", Message: "本次内容依据仅含标题、主题标签和已保存摘要字段，不含全文或封面图像"})
	}
	basis.Missing = cxReviewUniqueLimitations(basis.Missing)
	basis.ContextHash = cxReviewBasisHash(basis)
	return basis, allowed, nil
}

func (s *Server) cxReviewLatestFollower(ctx context.Context, accountID uuid.UUID) (*cxReviewFollowerFact, error) {
	var fact cxReviewFollowerFact
	err := s.db.QueryRow(ctx, `SELECT date::text,source,cumulate FROM account_metric_daily
		WHERE account_id=$1 AND cumulate IS NOT NULL ORDER BY date DESC,CASE source WHEN 'wechat_api' THEN 0 ELSE 1 END LIMIT 1`, accountID).
		Scan(&fact.Date, &fact.Source, &fact.Cumulate)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	fact.SourceRef = fmt.Sprintf("followers:%s:%s:%s", accountID, fact.Date, fact.Source)
	fact.Unit = "users"
	return &fact, nil
}

func cxReviewBasisHash(basis cxReviewAIBasis) string {
	basis.ContextHash = ""
	basis.AssembledAt = time.Time{}
	basis.AICallID = nil
	basis.Model = ""
	basis.PromptTemplateVersion = 0
	raw, _ := json.Marshal(basis)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func cxReviewMergeServerLimitations(current *[]cxReviewLimitation, required []cxReviewLimitation) {
	merged := cxReviewUniqueLimitations(append(append([]cxReviewLimitation{}, required...), (*current)...))
	if len(merged) > 10 {
		merged = merged[:10]
	}
	*current = merged
}

func cxReviewUniqueLimitations(values []cxReviewLimitation) []cxReviewLimitation {
	seen := map[string]bool{}
	out := []cxReviewLimitation{}
	for _, value := range values {
		key := value.Code + "\x00" + value.Message
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, value)
	}
	return out
}

func cxReviewAIContextDiff(before, after string) error {
	if before != after {
		return apiErr(http.StatusConflict, "version_conflict", "复盘依据已变化，请刷新后重试")
	}
	return nil
}
