package app

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 映射注册表与字段级投影（20 文档 §6.5、§8.4、§9.1、§9.4）。
//
// 首版注册表是代码常量，不新增数据库表；按 platform + adapter_version + mapping_version 冻结
// 允许的 scope、标准键、字段路径、单位与是否允许投影正式快照。客户端不能自定义路径，
// 也不能把未知键映射成 reads。

const (
	metricUnitUsers   = "users"
	metricUnitTimes   = "times"
	metricUnitCount   = "count"
	metricUnitUnknown = "unknown"

	metricQualityApproved   = "approved"
	metricQualityHeld       = "held"
	metricQualitySuperseded = "superseded"

	// 正式计数字段按列区分上限（§9.2）：int 列不得超过 2147483647，impressions 为 bigint。
	metricIntColumnMax    = math.MaxInt32
	metricBigintColumnMax = int64(1e12)
)

// metricFieldRule 描述一个标准键在某个平台/映射版本下的投影规则。
type metricFieldRule struct {
	Key string
	// Unit 是该键在平台上的口径；unknown 的字段只存观测，不投影正式 reads/shares。
	Unit string
	// Precision 为 exact 时才能自动采用；rounded/estimated 只能展示。
	Precision string
	// ProjectsTo 为空表示只存观测，不写 metric_snapshot。
	ProjectsTo string
}

type metricMapping struct {
	Platform       string
	AdapterVersion string
	MappingVersion int
	Scope          string
	Fields         map[string]metricFieldRule
}

// metricMappings 是首版只读注册表。新增平台字段必须新增 mapping_version 并保留旧版本只读。
var metricMappings = []metricMapping{
	{
		Platform: "xhs", AdapterVersion: "xhs-1", MappingVersion: 1, Scope: observationScopeWork,
		Fields: map[string]metricFieldRule{
			// view_times 单位未确认（§17.1.1）：只存观测，不投影 reads。
			"view_times":     {Key: "view_times", Unit: metricUnitUnknown, Precision: "exact"},
			"like_count":     {Key: "like_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "likes"},
			"favorite_count": {Key: "favorite_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "favorites"},
			"comment_count":  {Key: "comment_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "comments"},
			"share_times":    {Key: "share_times", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "shares"},
			"impressions":    {Key: "impressions", Unit: metricUnitTimes, Precision: "exact", ProjectsTo: "impressions"},
		},
	},
	{
		Platform: "wechat_mp", AdapterVersion: "wechat-mp-1", MappingVersion: 1, Scope: observationScopeWork,
		Fields: map[string]metricFieldRule{
			// read_num/share_num 单位未确认（§17.1.1）：只存观测。
			"read_times":    {Key: "read_times", Unit: metricUnitUnknown, Precision: "exact"},
			"read_users":    {Key: "read_users", Unit: metricUnitUsers, Precision: "exact", ProjectsTo: "reads"},
			"like_count":    {Key: "like_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "likes"},
			"comment_count": {Key: "comment_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "comments"},
			"wow_count":     {Key: "wow_count", Unit: metricUnitCount, Precision: "exact", ProjectsTo: "wows"},
			"share_users":   {Key: "share_users", Unit: metricUnitUsers, Precision: "exact", ProjectsTo: "shares"},
			"share_times":   {Key: "share_times", Unit: metricUnitTimes, Precision: "exact", ProjectsTo: "shares"},
			"impressions":   {Key: "impressions", Unit: metricUnitTimes, Precision: "exact", ProjectsTo: "impressions"},
		},
	},
}

func lookupMetricMapping(platform, adapterVersion string, mappingVersion int) (metricMapping, bool) {
	for _, m := range metricMappings {
		if m.Platform == platform && m.AdapterVersion == adapterVersion && m.MappingVersion == mappingVersion {
			return m, true
		}
	}
	return metricMapping{}, false
}

// validateObservationMapping 校验观测字段是否属于该映射版本（§6.5）：
// 标准键、单位、精度与字段路径都必须登记；未知键整条拒绝，不降级成 manual。
func validateObservationMapping(platform, adapterVersion string, mappingVersion int, in platformObservationInput) error {
	mapping, ok := lookupMetricMapping(platform, adapterVersion, mappingVersion)
	if !ok {
		return apiErr(422, "platform_mapping_unsupported", "适配器或映射版本不在支持范围内，请升级客户端")
	}
	if in.Scope != mapping.Scope {
		return validation("观测范围与映射版本登记的不一致")
	}
	keys := make([]string, 0, len(in.Values))
	for k := range in.Values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		rule, exists := mapping.Fields[key]
		if !exists {
			return validation("观测包含未登记的字段")
		}
		if path, ok := in.FieldPaths[key]; !ok || strings.TrimSpace(path) == "" {
			return validation("观测字段缺少来源路径")
		}
		raw := in.Values[key]
		var probe struct {
			Unit      string `json:"unit"`
			Precision string `json:"precision"`
			Value     *int64 `json:"value"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			return validation("观测字段格式不正确")
		}
		if probe.Unit != "" && probe.Unit != rule.Unit && probe.Unit != metricUnitUnknown {
			return validation("观测字段单位与映射登记不一致")
		}
		if probe.Precision != "" && probe.Precision != rule.Precision {
			return validation("观测字段精度与映射登记不一致")
		}
		_ = rule
	}
	return nil
}

// metricProjection 是一次字段级投影的结果：整节点快照，未观测字段写 NULL 并标 missing（§9.4）。
type metricProjection struct {
	WorkID      uuid.UUID
	Source      string
	DayOffset   *int
	CapturedAt  time.Time
	ObservedAt  time.Time
	AsOfAt      *time.Time
	Reads       *int
	ReadUnit    string
	Likes       *int
	Wows        *int
	Favorites   *int
	Comments    *int
	Shares      *int
	ShareUnit   string
	Impressions *int64
	Meta        map[string]any
	Missing     []string
}

// projectObservation 把一条已校验观测映射成正式快照。
// 只有 exact 且登记了目标列的字段才投影；单位未知的字段只留在观测里。
func projectObservation(platform, adapterVersion string, mappingVersion int, obs platformObservationInput) (metricProjection, error) {
	mapping, ok := lookupMetricMapping(platform, adapterVersion, mappingVersion)
	if !ok {
		return metricProjection{}, apiErr(422, "platform_mapping_unsupported", "适配器或映射版本不在支持范围内")
	}
	if obs.ExternalID == nil {
		return metricProjection{}, validation("作品观测缺少外部编号")
	}
	proj := metricProjection{
		Source: obs.Source, CapturedAt: obs.ObservedAt, ObservedAt: obs.ObservedAt, AsOfAt: obs.AsOfAt,
		ReadUnit: metricUnitUnknown, ShareUnit: metricUnitUnknown,
		Meta: map[string]any{
			"adapter_version": adapterVersion,
			"mapping_version": mappingVersion,
			"fields":          map[string]any{},
		},
	}
	fieldsMeta := proj.Meta["fields"].(map[string]any)
	// 整节点替换：先把所有登记字段标为 missing，观测里出现的再覆盖。
	for key, rule := range mapping.Fields {
		fieldsMeta[key] = map[string]any{"state": "missing"}
		_ = rule
	}
	keys := make([]string, 0, len(obs.Values))
	for k := range obs.Values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		rule, exists := mapping.Fields[key]
		if !exists {
			return metricProjection{}, validation("观测包含未登记的字段")
		}
		var probe struct {
			Value     *int64 `json:"value"`
			Precision string `json:"precision"`
			Unit      string `json:"unit"`
		}
		if err := json.Unmarshal(obs.Values[key], &probe); err != nil || probe.Value == nil {
			return metricProjection{}, validation("观测字段值无法解析")
		}
		value := *probe.Value
		if value < 0 || value > int64(1e12) {
			return metricProjection{}, apiErr(422, "platform_value_out_of_range", "观测数值超出允许范围")
		}
		fieldsMeta[key] = map[string]any{
			"state": "observed", "unit": rule.Unit, "precision": probe.Precision,
			"path": obs.FieldPaths[key],
		}
		// 只采用 exact 且登记了目标列的字段；rounded 只能展示。
		if probe.Precision != "exact" || rule.ProjectsTo == "" {
			continue
		}
		// 观测**自报单位为 unknown** 时一律不投影（§8.4、§9.1）。
		// 映射表里的 Unit 只是"若确实是这个单位就投到哪"，不能反过来当成
		// "适配器没确认单位也照投"——那会把口径未知的数字写进正式指标。
		// 实例：公众号适配器把 share_times 标为 unknown，早期实现仍按 times 投影成 shares。
		if probe.Unit == metricUnitUnknown {
			continue
		}
		if err := assignProjectedField(&proj, rule, value, obs.FieldPaths[key]); err != nil {
			return metricProjection{}, err
		}
	}
	for key, state := range fieldsMeta {
		if s, ok := state.(map[string]any); ok && s["state"] == "missing" {
			proj.Missing = append(proj.Missing, key)
		}
	}
	sort.Strings(proj.Missing)
	proj.Meta["missing_fields"] = proj.Missing
	return proj, nil
}

// assignProjectedField 按目标列校验上限后写入；超出列范围不投影，保留观测（§9.2）。
func assignProjectedField(proj *metricProjection, rule metricFieldRule, value int64, path string) error {
	switch rule.ProjectsTo {
	case "reads":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Reads = &v
		proj.ReadUnit = rule.Unit
	case "likes":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Likes = &v
	case "favorites":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Favorites = &v
	case "comments":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Comments = &v
	case "shares":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Shares = &v
		proj.ShareUnit = rule.Unit
	case "wows":
		v, err := intColumn(value, path)
		if err != nil {
			return err
		}
		proj.Wows = &v
	case "impressions":
		if value > metricBigintColumnMax {
			return apiErr(422, "platform_value_out_of_range", "展现数值超出允许范围")
		}
		proj.Impressions = &value
	}
	return nil
}

func intColumn(value int64, _ string) (int, error) {
	if value > metricIntColumnMax {
		return 0, apiErr(422, "platform_value_out_of_range", "数值超出目标列范围，未投影正式指标")
	}
	return int(value), nil
}

// replaceAutoMetric 是自动来源唯一的写入点：整节点替换，未观测字段写 NULL，
// 不沿用 coalesce 合并，避免把昨天的收藏量与今天的阅读量拼成一条“今天完整数据”（§9.4）。
func replaceAutoMetric(ctx context.Context, tx pgx.Tx, proj metricProjection) (Metric, error) {
	meta, err := json.Marshal(proj.Meta)
	if err != nil {
		return Metric{}, err
	}
	var existingID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM metric_snapshot
		WHERE work_id=$1 AND source=$2 AND day_offset IS NOT DISTINCT FROM $3
		FOR UPDATE`, proj.WorkID, proj.Source, proj.DayOffset).Scan(&existingID)
	switch {
	case err == nil:
		var m Metric
		m, err = scanMetric(tx.QueryRow(ctx, `UPDATE metric_snapshot SET
			captured_at=$2, reads=$3, read_unit=$4, likes=$5, wows=$6, favorites=$7, comments=$8,
			shares=$9, share_unit=$10, impressions=$11, observed_at=$12, as_of_at=$13,
			metric_meta=$14, quality_state='approved'
			WHERE id=$1 RETURNING `+metricCols,
			existingID, proj.CapturedAt, proj.Reads, proj.ReadUnit, proj.Likes, proj.Wows, proj.Favorites,
			proj.Comments, proj.Shares, proj.ShareUnit, proj.Impressions, proj.ObservedAt, proj.AsOfAt, meta))
		return m, err
	case errors.Is(err, pgx.ErrNoRows):
		var m Metric
		m, err = scanMetric(tx.QueryRow(ctx, `INSERT INTO metric_snapshot
			(work_id, captured_at, source, day_offset, reads, read_unit, likes, wows, favorites, comments,
			 shares, share_unit, impressions, observed_at, as_of_at, metric_meta, quality_state)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'approved')
			RETURNING `+metricCols,
			proj.WorkID, proj.CapturedAt, proj.Source, proj.DayOffset, proj.Reads, proj.ReadUnit, proj.Likes,
			proj.Wows, proj.Favorites, proj.Comments, proj.Shares, proj.ShareUnit, proj.Impressions,
			proj.ObservedAt, proj.AsOfAt, meta))
		return m, err
	default:
		return Metric{}, err
	}
}

// metricNodeD7Public 按 D7 语义批量读取多个作品的表现（§8.4 迁移用）。
//
// 与 metricNodePublic 的区别：保留 `work_metric_d7` 的**兜底**规则——没有 `day_offset<=7`
// 数据时会取 `>7` 的记录，而 `metric_node_public(work, 7)` 不会。这样迁移前后读数一致。
// 一次查询覆盖多个作品，避免逐个调用造成的 N+1。
func (s *Server) metricNodeD7Public(ctx context.Context, workIDs []uuid.UUID) ([]Metric, error) {
	if len(workIDs) == 0 {
		return []Metric{}, nil
	}
	rows, err := s.db.Query(ctx, `SELECT
		  metric_id, work_id, captured_at, reads, impressions, likes, wows, favorites, comments, shares,
		  follows_gained, ''::text, source, day_offset, null::text, 0,
		  coalesce(read_unit,'unknown'), coalesce(share_unit,'unknown'), coalesce(quality_state,'approved'),
		  observation_id, observed_at, as_of_at,
		  coalesce(metric_meta,'{}'::jsonb) || jsonb_build_object('missing_fields', to_jsonb(missing_fields))
		FROM metric_node_d7_public_all($1)
		ORDER BY work_id, metric_source_rank(source)`, workIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Metric{}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// metricKey 是"作品 + 指标"的稳定键，供批量结果建索引。
func metricKey(workID uuid.UUID, metricID uuid.UUID) string {
	return workID.String() + ":" + metricID.String()
}

// metricNodePublic 读取统一入口，供节点视图与绩效样本使用（§8.4）。
// 它调用数据库函数 metric_node_public()，与 SQL 侧共用同一套“排除 held/superseded、
// 只认 approved、按来源排序”的规则，避免两处实现口径漂移。
func (s *Server) metricNodePublic(ctx context.Context, workID uuid.UUID, node *int) ([]Metric, error) {
	var nodeArg any
	if node != nil {
		nodeArg = *node
	}
	// 函数返回的是投影后的列，按 metricCols 的顺序取同名字段。
	rows, err := s.db.Query(ctx, `SELECT
		  metric_id, $1::uuid, captured_at, reads, impressions, likes, wows, favorites, comments, shares,
		  follows_gained, ''::text, source, day_offset, null::text, 0,
		  coalesce(read_unit,'unknown'), coalesce(share_unit,'unknown'), coalesce(quality_state,'approved'),
		  observation_id, observed_at, as_of_at,
		  coalesce(metric_meta,'{}'::jsonb) || jsonb_build_object('missing_fields', to_jsonb(missing_fields))
		FROM metric_node_public($1, $2)
		ORDER BY metric_source_rank(source)`, workID, nodeArg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Metric{}
	for rows.Next() {
		m, err := scanMetric(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// confirmObservation 是 POST /metrics/observations/{id}/confirm 的核心：
// 逐条确认当前观测，重新校验归属与版本后投影，不联动其他行（§9.3、§11.2）。
func (s *Server) confirmObservation(ctx context.Context, observationID uuid.UUID) (Metric, error) {
	id := ident(ctx)
	var obs platformObservationInput
	var platform, adapterVersion string
	var mappingVersion int
	var qualityState, matchState string
	var runID *uuid.UUID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var externalID *string
		var valuesRaw, pathsRaw []byte
		var batchSeq, rowNo *int
		var asOf, windowStart, windowEnd *time.Time
		if err := tx.QueryRow(ctx, `SELECT o.run_id, o.batch_seq, o.row_no, o.workspace_id, o.account_id,
			  o.external_account_key, o.external_id, o.scope, o.source, o.observed_at, o.as_of_at,
			  o.window_start, o.window_end, o.temporal_kind, o.values, o.field_paths, o.adapter_version,
			  o.mapping_version, o.quality_state, o.match_state, a.platform
			FROM platform_metric_observation o
			JOIN platform_account a ON a.id=o.account_id
			WHERE o.id=$1 AND a.workspace_id=$2
			FOR UPDATE OF o`, observationID, id.WorkspaceID).Scan(
			&runID, &batchSeq, &rowNo, &obs.WorkspaceID, &obs.AccountID, &obs.ExternalAccountKey,
			&externalID, &obs.Scope, &obs.Source, &obs.ObservedAt, &asOf, &windowStart, &windowEnd,
			&obs.TemporalKind, &valuesRaw, &pathsRaw, &obs.AdapterVersion, &obs.MappingVersion,
			&qualityState, &matchState, &platform); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return errNotFound
			}
			return err
		}
		_ = runID
		_ = batchSeq
		_ = rowNo
		_ = windowStart
		_ = windowEnd
		obs.ExternalID = externalID
		obs.AsOfAt = asOf
		adapterVersion = obs.AdapterVersion
		mappingVersion = obs.MappingVersion
		if err := json.Unmarshal(valuesRaw, &obs.Values); err != nil {
			return err
		}
		if err := json.Unmarshal(pathsRaw, &obs.FieldPaths); err != nil {
			return err
		}
		if qualityState == observationQualityRejected {
			return apiErr(409, "platform_result_conflict", "该观测已被拒绝，不能确认")
		}
		// 已被更新观测替代的旧观测不能再确认：确认它等于把过时读数写回正式指标。
		if qualityState == observationQualitySuperseded {
			return apiErr(409, "platform_result_conflict", "该观测已被更新的观测替代，不能确认")
		}
		if matchState != observationMatchBound {
			return apiErr(409, "platform_result_conflict", "该观测尚未匹配到已绑定作品")
		}
		if err := validateObservationMapping(platform, adapterVersion, mappingVersion, obs); err != nil {
			return err
		}
		proj, err := projectObservation(platform, adapterVersion, mappingVersion, obs)
		if err != nil {
			return err
		}
		// 归属：外部编号必须已绑定到该账号下的一篇未删除作品。
		column := "wechat_msgid"
		if platform == "xhs" {
			column = "xhs_note_id"
		}
		var workID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM work WHERE account_id=$1 AND deleted_at IS NULL
			AND `+column+`=$2`, obs.AccountID, *obs.ExternalID).Scan(&workID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return apiErr(409, "platform_result_conflict", "观测对应的作品尚未精确绑定")
			}
			return err
		}
		proj.WorkID = workID
		if obs.AsOfAt != nil {
			day, err := metricDayOffset(tx, ctx, workID, *obs.AsOfAt)
			if err != nil {
				return err
			}
			proj.DayOffset = day
		}
		m, err := replaceAutoMetric(ctx, tx, proj)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_metric_observation
			SET quality_state=$2, match_state='bound' WHERE id=$1`, observationID, observationQualityValid); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE metric_snapshot SET observation_id=$2 WHERE id=$1`,
			m.ID, observationID); err != nil {
			return err
		}
		if err := s.auditTx(ctx, tx, "metric_observation_confirm", "platform_metric_observation",
			observationID.String(), "ok", map[string]any{
				"work_id": workID, "source": proj.Source, "missing_fields": proj.Missing,
				"adapter_version": adapterVersion, "mapping_version": mappingVersion,
			}); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return Metric{}, err
	}
	var m Metric
	if err := s.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE observation_id=$1`,
		observationID).Scan(metricDest(&m)...); err != nil {
		return Metric{}, err
	}
	m.CTR, m.CTRUnavailable = metricCTR(&m)
	return m, nil
}

// metricDayOffset 用发布日与统计截止时点算真实日数；发布日未知时返回 nil（不编造节点）。
func metricDayOffset(tx pgx.Tx, ctx context.Context, workID uuid.UUID, asOf time.Time) (*int, error) {
	var publishedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT published_at FROM work WHERE id=$1`, workID).Scan(&publishedAt); err != nil {
		return nil, err
	}
	if publishedAt == nil {
		return nil, nil
	}
	loc := time.FixedZone("CST", 8*3600)
	start := publishedAt.In(loc)
	day := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	end := asOf.In(loc)
	cut := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, loc)
	offset := int(cut.Sub(day).Hours()/24 + 0.5)
	if offset < 0 {
		return nil, nil
	}
	return &offset, nil
}

// confirmObservationHandler 是 POST /metrics/observations/{id}/confirm 的 HTTP 入口。
func (s *Server) confirmObservationHandler(w http.ResponseWriter, r *http.Request) error {
	observationID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	m, err := s.confirmObservation(r.Context(), observationID)
	if err != nil {
		return err
	}
	return ok(w, m)
}

// observationsView 返回某账号的最小观测列表（GET /accounts/{accountId}/metrics/observations）。
func (s *Server) listObservations(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT o.id, o.external_id, o.scope, o.source, o.observed_at,
		  o.as_of_at, o.quality_state, o.match_state, o.adapter_version, o.mapping_version,
		  o.values, o.field_paths
		FROM platform_metric_observation o
		WHERE o.account_id=$1
		ORDER BY o.observed_at DESC, o.id
		LIMIT 200`, accountID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var externalID *string
		var scope, source, qualityState, matchState, adapterVersion string
		var observedAt time.Time
		var asOfAt *time.Time
		var mappingVersion int
		var values, paths []byte
		if err := rows.Scan(&id, &externalID, &scope, &source, &observedAt, &asOfAt, &qualityState,
			&matchState, &adapterVersion, &mappingVersion, &values, &paths); err != nil {
			return err
		}
		list = append(list, map[string]any{
			"id": id, "external_id": externalID, "scope": scope, "source": source,
			"observed_at": observedAt, "as_of_at": asOfAt, "quality_state": qualityState,
			"match_state": matchState, "adapter_version": adapterVersion, "mapping_version": mappingVersion,
			"values": json.RawMessage(values), "field_paths": json.RawMessage(paths),
		})
	}
	return ok(w, map[string]any{"observations": list})
}
