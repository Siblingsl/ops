package app

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type cxReviewExperimentSelectionInput struct {
	Timezone              string `json:"timezone"`
	Platform              string `json:"platform"`
	ContentFormat         string `json:"content_format"`
	BaselineContentFormat string `json:"baseline_content_format"`
	ResultContentFormat   string `json:"result_content_format"`
	ReadUnit              string `json:"read_unit"`
	ShareUnit             string `json:"share_unit"`
}

type cxReviewExperimentInput struct {
	Hypothesis     string                           `json:"hypothesis"`
	Variable       string                           `json:"variable"`
	MetricKey      string                           `json:"metric_key"`
	Window         string                           `json:"window"`
	SelectionBasis cxReviewExperimentSelectionInput `json:"selection_basis"`
	BaselineFrom   string                           `json:"baseline_from"`
	BaselineTo     string                           `json:"baseline_to"`
	ResultFrom     string                           `json:"result_from"`
	ResultTo       string                           `json:"result_to"`
}

type cxReviewExperimentSelection struct {
	SchemaVersion         int    `json:"schema_version"`
	Timezone              string `json:"timezone"`
	Platform              string `json:"platform"`
	ContentFormat         string `json:"content_format,omitempty"`
	BaselineContentFormat string `json:"baseline_content_format,omitempty"`
	ResultContentFormat   string `json:"result_content_format,omitempty"`
	ReadUnit              string `json:"read_unit"`
	ShareUnit             string `json:"share_unit"`
	MetricKey             string `json:"metric_key"`
	Window                string `json:"window"`
	Sampling              string `json:"sampling"`
	Eligibility           string `json:"eligibility"`
}

type cxReviewExperiment struct {
	ID             uuid.UUID       `json:"id"`
	AccountID      uuid.UUID       `json:"account_id"`
	Hypothesis     string          `json:"hypothesis"`
	Variable       string          `json:"variable"`
	MetricKey      string          `json:"metric_key"`
	Window         string          `json:"window"`
	SelectionBasis json.RawMessage `json:"selection_basis"`
	BaselineFrom   string          `json:"baseline_from"`
	BaselineTo     string          `json:"baseline_to"`
	ResultFrom     string          `json:"result_from"`
	ResultTo       string          `json:"result_to"`
	Status         string          `json:"status"`
	Conclusion     *string         `json:"conclusion"`
	ResultSnapshot json.RawMessage `json:"result_snapshot"`
	Note           string          `json:"note"`
	Revision       int             `json:"revision"`
	CreatedAt      time.Time       `json:"created_at"`
	ConcludedAt    *time.Time      `json:"concluded_at"`
	Stale          bool            `json:"stale"`
}

type cxReviewExperimentInputDates struct {
	BaselineFrom time.Time
	BaselineTo   time.Time
	ResultFrom   time.Time
	ResultTo     time.Time
}

func validateCXReviewExperimentInput(account *Account, in cxReviewExperimentInput) (cxReviewExperimentSelection, cxReviewExperimentInputDates, *time.Location, error) {
	var selection cxReviewExperimentSelection
	var dates cxReviewExperimentInputDates
	if account == nil {
		return selection, dates, nil, validation("账号不可用")
	}
	in.Hypothesis = strings.TrimSpace(in.Hypothesis)
	if len([]rune(in.Hypothesis)) == 0 || len([]rune(in.Hypothesis)) > 1000 {
		return selection, dates, nil, validation("假设需填写 1 至 1000 个字符")
	}
	switch in.Variable {
	case "title", "cover", "topic", "format", "posting_time":
	default:
		return selection, dates, nil, validation("实验变量无效")
	}
	switch in.MetricKey {
	case "favorite_rate", "interaction_rate", "follow_rate":
	default:
		return selection, dates, nil, validation("指标口径无效")
	}
	if _, _, _, ok := cxReviewWindowRange(time.Now(), in.Window); !ok {
		return selection, dates, nil, validation("时间窗口必须是 T1、T3、T7 或 T30")
	}
	inputBasis := in.SelectionBasis
	if inputBasis.Platform != account.Platform {
		return selection, dates, nil, validation("实验平台必须与账号平台一致")
	}
	timezone := strings.TrimSpace(inputBasis.Timezone)
	if timezone == "" {
		timezone = "Asia/Shanghai"
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return selection, dates, nil, validation("账号时区无效")
	}
	if !cxReviewKnownReadUnit(inputBasis.ReadUnit) {
		return selection, dates, nil, validation("实验需要明确的阅读单位")
	}
	if !cxReviewKnownExperimentShareUnit(inputBasis.ShareUnit) {
		return selection, dates, nil, validation("实验分享单位无效")
	}
	contentFormat := strings.TrimSpace(inputBasis.ContentFormat)
	baselineFormat := strings.TrimSpace(inputBasis.BaselineContentFormat)
	resultFormat := strings.TrimSpace(inputBasis.ResultContentFormat)
	if in.Variable == "format" {
		if !validFormat(account.Platform, baselineFormat) || !validFormat(account.Platform, resultFormat) || baselineFormat == resultFormat {
			return selection, dates, nil, validation("形态实验需明确两个不同的同平台内容形态")
		}
	} else {
		if contentFormat == "" {
			contentFormat = account.ContentFormat
		}
		if !validFormat(account.Platform, contentFormat) {
			return selection, dates, nil, validation("实验作品形态与账号平台不匹配")
		}
		baselineFormat, resultFormat = contentFormat, contentFormat
	}
	if in.MetricKey == "interaction_rate" && inputBasis.ShareUnit != "times" && inputBasis.ShareUnit != metricUnitCount {
		return selection, dates, nil, validation("严格互动率实验需要次数或计数口径的分享数据")
	}
	parseDate := func(raw string) (time.Time, error) {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(raw))
		if err != nil {
			return time.Time{}, validation("实验日期必须是 YYYY-MM-DD")
		}
		return parsed, nil
	}
	if dates.BaselineFrom, err = parseDate(in.BaselineFrom); err != nil {
		return selection, dates, nil, err
	}
	if dates.BaselineTo, err = parseDate(in.BaselineTo); err != nil {
		return selection, dates, nil, err
	}
	if dates.ResultFrom, err = parseDate(in.ResultFrom); err != nil {
		return selection, dates, nil, err
	}
	if dates.ResultTo, err = parseDate(in.ResultTo); err != nil {
		return selection, dates, nil, err
	}
	if dates.BaselineFrom.After(dates.BaselineTo) || dates.ResultFrom.After(dates.ResultTo) || !dates.BaselineTo.Before(dates.ResultFrom) {
		return selection, dates, nil, validation("实验基线与结果日期范围必须先后分开且各自有效")
	}
	selection = cxReviewExperimentSelection{
		SchemaVersion: 1, Timezone: timezone, Platform: account.Platform,
		ContentFormat: contentFormat, BaselineContentFormat: baselineFormat, ResultContentFormat: resultFormat,
		ReadUnit: inputBasis.ReadUnit, ShareUnit: inputBasis.ShareUnit,
		MetricKey: in.MetricKey, Window: in.Window, Sampling: "retained_snapshots",
		Eligibility: "published_local_date;nearest_approved_supported_snapshot;same_unit;no_missing_numerator",
	}
	return selection, dates, location, nil
}

func cxReviewKnownExperimentShareUnit(unit string) bool {
	return unit == "users" || unit == "times" || unit == "count" || unit == "unknown"
}

type cxReviewExperimentSample struct {
	WorkID          uuid.UUID `json:"work_id"`
	WorkRevision    int       `json:"work_revision"`
	PublishRevision int       `json:"publish_revision"`
	PublishedAt     time.Time `json:"published_at"`
	MetricID        uuid.UUID `json:"metric_id"`
	MetricRevision  int       `json:"metric_revision"`
	Source          string    `json:"source"`
	CapturedAt      time.Time `json:"captured_at"`
	ReadUnit        string    `json:"read_unit"`
	ShareUnit       string    `json:"share_unit"`
	Value           float64   `json:"value"`
}

type cxReviewExperimentGroup struct {
	Samples       []cxReviewExperimentSample `json:"samples"`
	SampleSize    int                        `json:"sample_size"`
	ExcludedCount int                        `json:"excluded_count"`
	Median        *float64                   `json:"median"`
}

type cxReviewExperimentSnapshot struct {
	Interpretation   string                     `json:"interpretation"`
	Window           string                     `json:"window"`
	MetricKey        string                     `json:"metric_key"`
	ReadUnit         string                     `json:"read_unit"`
	ShareUnit        string                     `json:"share_unit"`
	Baseline         []cxReviewExperimentSample `json:"baseline"`
	Result           []cxReviewExperimentSample `json:"result"`
	BaselineMedian   *float64                   `json:"baseline_median"`
	ResultMedian     *float64                   `json:"result_median"`
	Delta            *float64                   `json:"median_delta"`
	BaselineCount    int                        `json:"baseline_sample_size"`
	ResultCount      int                        `json:"result_sample_size"`
	BaselineExcluded int                        `json:"baseline_excluded_count"`
	ResultExcluded   int                        `json:"result_excluded_count"`
}

type cxReviewExperimentDBRow struct {
	Experiment  cxReviewExperiment
	WorkspaceID uuid.UUID
	CreatedBy   *uuid.UUID
}

const cxReviewExperimentColumns = `id,account_id,hypothesis,variable,metric_key,"window",selection_basis,
	baseline_from,baseline_to,result_from,result_to,status,conclusion,result_snapshot,note,revision,created_at,concluded_at`

func scanCXReviewExperiment(row interface{ Scan(...any) error }) (cxReviewExperiment, error) {
	var experiment cxReviewExperiment
	var selection, snapshot []byte
	var baselineFrom, baselineTo, resultFrom, resultTo time.Time
	err := row.Scan(&experiment.ID, &experiment.AccountID, &experiment.Hypothesis, &experiment.Variable, &experiment.MetricKey, &experiment.Window,
		&selection, &baselineFrom, &baselineTo, &resultFrom, &resultTo,
		&experiment.Status, &experiment.Conclusion, &snapshot, &experiment.Note, &experiment.Revision, &experiment.CreatedAt, &experiment.ConcludedAt)
	if err != nil {
		return experiment, err
	}
	experiment.SelectionBasis = append(json.RawMessage(nil), selection...)
	experiment.ResultSnapshot = append(json.RawMessage(nil), snapshot...)
	experiment.BaselineFrom, experiment.BaselineTo = baselineFrom.Format("2006-01-02"), baselineTo.Format("2006-01-02")
	experiment.ResultFrom, experiment.ResultTo = resultFrom.Format("2006-01-02"), resultTo.Format("2006-01-02")
	return experiment, nil
}

func (s *Server) createCXReviewExperiment(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	var in cxReviewExperimentInput
	if err := decode(r, &in); err != nil {
		return err
	}
	selection, dates, _, err := validateCXReviewExperimentInput(account, in)
	if err != nil {
		return err
	}
	selectionJSON, err := json.Marshal(selection)
	if err != nil {
		return err
	}
	var experimentID uuid.UUID
	err = s.db.QueryRow(r.Context(), `INSERT INTO review_experiment(workspace_id,account_id,hypothesis,variable,metric_key,"window",
		selection_basis,baseline_from,baseline_to,result_from,result_to,created_by)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
		ident(r.Context()).WorkspaceID, account.ID, strings.TrimSpace(in.Hypothesis), in.Variable, in.MetricKey, in.Window,
		selectionJSON, dates.BaselineFrom, dates.BaselineTo, dates.ResultFrom, dates.ResultTo, ident(r.Context()).UserID).Scan(&experimentID)
	if err != nil {
		if pgErr, ok := err.(*pgconn.PgError); ok && pgErr.Code == "23505" && pgErr.ConstraintName == "review_experiment_one_running" {
			return apiErr(http.StatusConflict, "experiment_running", "该账号已有进行中的实验，请先结案或放弃")
		}
		return err
	}
	experiment, err := scanCXReviewExperiment(s.db.QueryRow(r.Context(), `SELECT `+cxReviewExperimentColumns+` FROM review_experiment WHERE id=$1`, experimentID))
	if err != nil {
		return err
	}
	return ok(w, experiment)
}

func (s *Server) listCXReviewExperiments(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	cursor, err := parseListCursor(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+cxReviewExperimentColumns+` FROM review_experiment
		WHERE account_id=$1 AND workspace_id=$2 AND ($3::timestamptz IS NULL OR (created_at,id)<($3,$4))
		ORDER BY created_at DESC,id DESC LIMIT 21`, account.ID, ident(r.Context()).WorkspaceID, cursorTime(cursor), cursorID(cursor))
	if err != nil {
		return err
	}
	items := []cxReviewExperiment{}
	for rows.Next() {
		item, err := scanCXReviewExperiment(rows)
		if err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var nextCursor *string
	if len(items) > 20 {
		last := items[19]
		value := encodeListCursor(last.CreatedAt, last.ID)
		nextCursor = &value
		items = items[:20]
	}
	for i := range items {
		if items[i].Status == "concluded" && len(items[i].ResultSnapshot) > 0 {
			items[i].Stale, err = s.cxReviewExperimentStale(r.Context(), items[i])
			if err != nil {
				return err
			}
		}
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func (s *Server) getCXReviewExperiment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	experiment, err := scanCXReviewExperiment(s.db.QueryRow(r.Context(), `SELECT `+cxReviewExperimentColumns+` FROM review_experiment
		WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID))
	if err != nil {
		return err
	}
	if experiment.Status == "concluded" && len(experiment.ResultSnapshot) > 0 {
		experiment.Stale, err = s.cxReviewExperimentStale(r.Context(), experiment)
		if err != nil {
			return err
		}
	}
	return ok(w, experiment)
}

func (s *Server) concludeCXReviewExperiment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision *int   `json:"base_revision"`
		Conclusion   string `json:"conclusion"`
		Note         string `json:"note"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision == nil || *in.BaseRevision < 1 {
		return validation("缺少实验版本号")
	}
	if in.Conclusion != "support" && in.Conclusion != "reject" && in.Conclusion != "inconclusive" {
		return validation("实验结论无效")
	}
	if len([]rune(strings.TrimSpace(in.Note))) > 2000 {
		return validation("实验备注不能超过 2000 个字符")
	}
	var accountID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT account_id FROM review_experiment WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID).Scan(&accountID); err != nil {
		return err
	}
	if _, err := s.account(r.Context(), accountID); err != nil {
		return err
	}
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	experiment, err := scanCXReviewExperiment(tx.QueryRow(r.Context(), `SELECT `+cxReviewExperimentColumns+` FROM review_experiment
		WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, id, ident(r.Context()).WorkspaceID))
	if err != nil {
		return err
	}
	if experiment.Revision != *in.BaseRevision {
		return apiErr(http.StatusConflict, "version_conflict", "实验记录已变化，请刷新后重试")
	}
	if experiment.Status != "running" {
		return apiErr(http.StatusConflict, "state_conflict", "只有进行中的实验可以结案")
	}
	snapshot, err := s.buildCXReviewExperimentSnapshot(r.Context(), tx, experiment)
	if err != nil {
		return err
	}
	if in.Conclusion != "inconclusive" && (snapshot.BaselineCount < 3 || snapshot.ResultCount < 3) {
		return apiErr(http.StatusUnprocessableEntity, "insufficient_samples", "基线组和结果组各需至少 3 个有效同口径样本；当前只能记录为样本不足")
	}
	resultJSON, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	conclusion := in.Conclusion
	command, err := tx.Exec(r.Context(), `UPDATE review_experiment SET status='concluded',conclusion=$3,result_snapshot=$4,
		note=$5,revision=revision+1,concluded_at=now() WHERE id=$1 AND workspace_id=$2 AND revision=$6 AND status='running'`,
		id, ident(r.Context()).WorkspaceID, conclusion, resultJSON, strings.TrimSpace(in.Note), *in.BaseRevision)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return apiErr(http.StatusConflict, "version_conflict", "实验记录已变化，请刷新后重试")
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return s.getCXReviewExperiment(w, r)
}

func (s *Server) abandonCXReviewExperiment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision *int   `json:"base_revision"`
		Reason       string `json:"reason"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	reason := strings.TrimSpace(in.Reason)
	if in.BaseRevision == nil || *in.BaseRevision < 1 || reason == "" || len([]rune(reason)) > 500 {
		return validation("放弃实验需要版本号及不超过 500 个字符的原因")
	}
	var accountID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT account_id FROM review_experiment WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID).Scan(&accountID); err != nil {
		return err
	}
	if _, err := s.account(r.Context(), accountID); err != nil {
		return err
	}
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	command, err := s.db.Exec(r.Context(), `UPDATE review_experiment SET status='abandoned',note=$4,revision=revision+1,concluded_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$3 AND status='running'`, id, ident(r.Context()).WorkspaceID, *in.BaseRevision, reason)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return apiErr(http.StatusConflict, "version_conflict", "实验记录已变化或已结束，请刷新后重试")
	}
	return s.getCXReviewExperiment(w, r)
}

func (s *Server) buildCXReviewExperimentSnapshot(ctx context.Context, q dbtx, experiment cxReviewExperiment) (cxReviewExperimentSnapshot, error) {
	var selection cxReviewExperimentSelection
	if err := json.Unmarshal(experiment.SelectionBasis, &selection); err != nil {
		return cxReviewExperimentSnapshot{}, err
	}
	location, err := time.LoadLocation(selection.Timezone)
	if err != nil {
		return cxReviewExperimentSnapshot{}, validation("实验时区已无效，请联系管理员")
	}
	baselineFrom, baselineTo, err := cxLocalDayRange(experiment.BaselineFrom, experiment.BaselineTo, location)
	if err != nil {
		return cxReviewExperimentSnapshot{}, err
	}
	resultFrom, resultTo, err := cxLocalDayRange(experiment.ResultFrom, experiment.ResultTo, location)
	if err != nil {
		return cxReviewExperimentSnapshot{}, err
	}
	baseline, baselineExcluded, err := s.cxReviewExperimentSamples(ctx, q, experiment.AccountID, selection.BaselineContentFormat, selection, baselineFrom, baselineTo)
	if err != nil {
		return cxReviewExperimentSnapshot{}, err
	}
	result, resultExcluded, err := s.cxReviewExperimentSamples(ctx, q, experiment.AccountID, selection.ResultContentFormat, selection, resultFrom, resultTo)
	if err != nil {
		return cxReviewExperimentSnapshot{}, err
	}
	valuesOf := func(samples []cxReviewExperimentSample) []float64 {
		values := make([]float64, 0, len(samples))
		for _, sample := range samples {
			values = append(values, sample.Value)
		}
		return values
	}
	baselineMedian, resultMedian := cxReviewMedian(valuesOf(baseline)), cxReviewMedian(valuesOf(result))
	var delta *float64
	if baselineMedian != nil && resultMedian != nil {
		value := *resultMedian - *baselineMedian
		delta = &value
	}
	return cxReviewExperimentSnapshot{Interpretation: "observational", Window: selection.Window, MetricKey: selection.MetricKey,
		ReadUnit: selection.ReadUnit, ShareUnit: selection.ShareUnit, Baseline: baseline, Result: result,
		BaselineMedian: baselineMedian, ResultMedian: resultMedian, Delta: delta, BaselineCount: len(baseline), ResultCount: len(result),
		BaselineExcluded: baselineExcluded, ResultExcluded: resultExcluded}, nil
}

func cxLocalDayRange(from, to string, location *time.Location) (time.Time, time.Time, error) {
	startDate, err := time.Parse("2006-01-02", from)
	if err != nil {
		return time.Time{}, time.Time{}, validation("实验日期快照无效")
	}
	endDate, err := time.Parse("2006-01-02", to)
	if err != nil {
		return time.Time{}, time.Time{}, validation("实验日期快照无效")
	}
	start := time.Date(startDate.Year(), startDate.Month(), startDate.Day(), 0, 0, 0, 0, location)
	end := time.Date(endDate.Year(), endDate.Month(), endDate.Day(), 0, 0, 0, 0, location).AddDate(0, 0, 1)
	return start.UTC(), end.UTC(), nil
}

func (s *Server) cxReviewExperimentSamples(ctx context.Context, q dbtx, accountID uuid.UUID, contentFormat string,
	selection cxReviewExperimentSelection, start, end time.Time) ([]cxReviewExperimentSample, int, error) {
	rows, err := q.Query(ctx, `SELECT w.id,w.title,w.content_format,w.published_at,w.revision,w.publish_revision,a.platform
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.account_id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL AND w.status='published'
		AND w.published_at >= $3 AND w.published_at < $4 AND w.content_format=$5
		ORDER BY w.published_at,w.id`, accountID, ident(ctx).WorkspaceID, start, end, contentFormat)
	if err != nil {
		return nil, 0, err
	}
	works := []cxReviewWorkSnapshot{}
	for rows.Next() {
		var work cxReviewWorkSnapshot
		if err := rows.Scan(&work.ID, &work.Title, &work.ContentFormat, &work.PublishedAt, &work.Revision, &work.PublishRevision, &work.Platform); err != nil {
			rows.Close()
			return nil, 0, err
		}
		works = append(works, work)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, 0, err
	}
	rows.Close()
	ids := make([]uuid.UUID, 0, len(works))
	for _, work := range works {
		ids = append(ids, work.ID)
	}
	metrics, err := loadCXReviewMetricsFrom(ctx, q, ids)
	if err != nil {
		return nil, 0, err
	}
	samples := []cxReviewExperimentSample{}
	for _, work := range works {
		work.Metrics = metrics[work.ID]
		metric, _, _ := selectCXReviewWindowMetric(work.Metrics, work.PublishedAt, selection.Window)
		if metric == nil || metric.ReadUnit != selection.ReadUnit {
			continue
		}
		if selection.MetricKey == "interaction_rate" && metric.ShareUnit != selection.ShareUnit {
			continue
		}
		ratio := cxReviewRatioByKey(cxReviewRatios(metric), selection.MetricKey)
		if ratio.Value == nil {
			continue
		}
		samples = append(samples, cxReviewExperimentSample{WorkID: work.ID, WorkRevision: work.Revision, PublishRevision: work.PublishRevision,
			PublishedAt: *work.PublishedAt, MetricID: metric.ID, MetricRevision: metric.Revision, Source: metric.Source, CapturedAt: metric.CapturedAt,
			ReadUnit: metric.ReadUnit, ShareUnit: metric.ShareUnit, Value: *ratio.Value})
	}
	sort.Slice(samples, func(i, j int) bool {
		if !samples[i].PublishedAt.Equal(samples[j].PublishedAt) {
			return samples[i].PublishedAt.Before(samples[j].PublishedAt)
		}
		return samples[i].WorkID.String() < samples[j].WorkID.String()
	})
	return samples, len(works) - len(samples), nil
}

func (s *Server) cxReviewExperimentStale(ctx context.Context, experiment cxReviewExperiment) (bool, error) {
	if len(experiment.ResultSnapshot) == 0 {
		return false, nil
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	current, err := s.buildCXReviewExperimentSnapshot(ctx, tx, experiment)
	if err != nil {
		return false, err
	}
	var previous cxReviewExperimentSnapshot
	if err := json.Unmarshal(experiment.ResultSnapshot, &previous); err != nil {
		return false, err
	}
	previousJSON, _ := json.Marshal(previous)
	currentJSON, _ := json.Marshal(current)
	return string(previousJSON) != string(currentJSON), nil
}
