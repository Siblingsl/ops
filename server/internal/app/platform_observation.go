package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 平台观测（20 文档 §8.1/§8.3）：外部最小事实与回溯依据，不是第二套指标表。
// 正式指标在 PS08 完成统一读取入口前不从这里投影，因此本文件只负责“存得对、去得重、可追溯”。

const (
	observationScopeAccount = "account"
	observationScopeWork    = "work"

	observationTemporalCumulative   = "cumulative"
	observationTemporalInterval     = "interval"
	observationTemporalCurrentTotal = "current_total"

	observationQualityValid           = "valid"
	observationQualityNeedsConfirm    = "needs_confirmation"
	observationQualityRejected        = "rejected"
	observationQualitySuperseded      = "superseded"
	observationMatchNotApplicable     = "not_applicable"
	observationMatchBound             = "bound"
	observationMatchUnmatched         = "unmatched"
	observationMatchIgnored           = "ignored"
	platformObservationPayloadVersion = "v1"
)

// platformObservationInput 是一条待写入观测的规范化输入。服务端从请求体构造它，
// 归属（workspace/account）由调用方从账号行读取，不信任客户端声明。
type platformObservationInput struct {
	RunID               *uuid.UUID
	BatchSeq            *int
	RowNo               *int
	WorkspaceID         uuid.UUID
	AccountID           uuid.UUID
	ExternalAccountKey  string
	ExternalID          *string
	Scope               string
	Source              string
	TemporalKind        string
	ObservedAt          time.Time
	AsOfAt              *time.Time
	WindowStart         *time.Time
	WindowEnd           *time.Time
	Values              map[string]json.RawMessage
	FieldPaths          map[string]string
	AdapterVersion      string
	MappingVersion      int
	BrowserVersion      string
	QualityState        string
	MatchState          string
	SupersedesID        *uuid.UUID
	SkipPayloadHashCalc bool
}

// canonicalObservationValue 把 JSON 值规范化为「整数/定点」文本，保证同一数字的不同写法
// （1 / 1.0 / 1e0）得到同一个哈希；非数值类型原样按规范 JSON 处理。
func canonicalObservationValue(raw json.RawMessage) (string, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", err
	}
	return canonicalJSON(v)
}

func canonicalJSON(v any) (string, error) {
	switch typed := v.(type) {
	case nil:
		return "null", nil
	case bool:
		if typed {
			return "true", nil
		}
		return "false", nil
	case json.Number:
		return canonicalNumber(typed.String())
	case string:
		b, err := json.Marshal(typed)
		return string(b), err
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			s, err := canonicalJSON(item)
			if err != nil {
				return "", err
			}
			parts = append(parts, s)
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for k := range typed {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			kb, err := json.Marshal(k)
			if err != nil {
				return "", err
			}
			s, err := canonicalJSON(typed[k])
			if err != nil {
				return "", err
			}
			parts = append(parts, string(kb)+":"+s)
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	default:
		b, err := json.Marshal(typed)
		return string(b), err
	}
}

// canonicalNumber 把 1、1.0、1e0 统一成 "1"，避免同一数值因写法不同而绕过去重。
func canonicalNumber(s string) (string, error) {
	if !strings.ContainsAny(s, ".eE") {
		return s, nil
	}
	// 定点：去掉尾随 0；无法精确表示时保留原串（宁可少去重，也不把不同数值合并）。
	neg := strings.HasPrefix(s, "-")
	body := strings.TrimPrefix(s, "-")
	if strings.ContainsAny(body, "eE") {
		return s, nil
	}
	body = strings.TrimRight(strings.TrimRight(body, "0"), ".")
	if body == "" {
		body = "0"
	}
	if neg {
		return "-" + body, nil
	}
	return body, nil
}

// observationPayloadHash 按 §8.1 计算内容指纹：键排序、时间统一为 UTC 秒、数值规范化；
// **不含** observed_at、row_no、batch_seq 与客户端版本串，否则同一数据的重复读取永远去不了重。
func observationPayloadHash(in platformObservationInput) (string, error) {
	type valuePart struct {
		Key   string `json:"k"`
		Value string `json:"v"`
	}
	keys := make([]string, 0, len(in.Values))
	for k := range in.Values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	values := make([]valuePart, 0, len(keys))
	for _, k := range keys {
		v, err := canonicalObservationValue(in.Values[k])
		if err != nil {
			return "", err
		}
		values = append(values, valuePart{Key: k, Value: v})
	}
	payload := struct {
		Version            string      `json:"version"`
		Scope              string      `json:"scope"`
		ExternalAccountKey string      `json:"external_account_key"`
		ExternalID         string      `json:"external_id"`
		TemporalKind       string      `json:"temporal_kind"`
		AsOfAt             string      `json:"as_of_at"`
		WindowStart        string      `json:"window_start"`
		WindowEnd          string      `json:"window_end"`
		Values             []valuePart `json:"values"`
		MappingVersion     int         `json:"mapping_version"`
	}{
		Version:            platformObservationPayloadVersion,
		Scope:              in.Scope,
		ExternalAccountKey: in.ExternalAccountKey,
		TemporalKind:       in.TemporalKind,
		AsOfAt:             utcSecond(in.AsOfAt),
		WindowStart:        utcSecond(in.WindowStart),
		WindowEnd:          utcSecond(in.WindowEnd),
		Values:             values,
		MappingVersion:     in.MappingVersion,
	}
	if in.ExternalID != nil {
		payload.ExternalID = *in.ExternalID
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func utcSecond(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Truncate(time.Second).Format(time.RFC3339)
}

// validatePlatformObservation 校验归属与时间语义。结构或归属错误整行拒绝，
// 不把未知来源降级成 manual（20 文档 §9.4）。
func validatePlatformObservation(in *platformObservationInput) error {
	if in.Scope != observationScopeAccount && in.Scope != observationScopeWork {
		return validation("观测范围只能是 account 或 work")
	}
	switch in.Source {
	case "wechat_browser", "xhs_browser", "file", "screenshot", "paste", "manual":
	default:
		return validation("观测来源不受支持")
	}
	if in.Scope == observationScopeWork && (in.ExternalID == nil || strings.TrimSpace(*in.ExternalID) == "") {
		return validation("作品观测缺少外部编号")
	}
	if in.Scope == observationScopeAccount && in.MatchState != observationMatchNotApplicable {
		return validation("账号观测不参与作品匹配")
	}
	if !strings.Contains(in.ExternalAccountKey, ":") || strings.TrimSpace(in.ExternalAccountKey) == "" {
		return validation("外部账号标识必须带身份种类")
	}
	switch in.TemporalKind {
	case observationTemporalCumulative:
		if in.AsOfAt == nil {
			return validation("累计观测必须带统计截止时点")
		}
	case observationTemporalInterval:
		if in.WindowStart == nil || in.WindowEnd == nil || in.WindowStart.After(*in.WindowEnd) {
			return validation("区间观测必须带有效的起止时间")
		}
	case observationTemporalCurrentTotal:
	default:
		return validation("观测时间语义不受支持")
	}
	if in.MappingVersion <= 0 {
		return validation("映射版本无效")
	}
	if len(in.Values) == 0 {
		return validation("观测没有字段")
	}
	if in.QualityState == "" {
		// 采集到的观测默认是"待确认"，不是"valid"（§9.2：待确认观测不写快照）。
		// 早期实现默认写 `valid`，结果是前端"确认这一条"按钮的条件
		// （`quality_state === 'needs_confirmation'`）永远不成立——用户看得到观测，
		// 却没有任何办法把它确认进正式指标（`auto_adopt` 关闭时功能等于不可用）。
		// `platform_gray.go` 的自动采用率统计里本来就有 `needs_confirmation` 计数，
		// 说明设计上预期存在这个状态，只是入库路径漏了设置。
		in.QualityState = observationQualityNeedsConfirm
	}
	if in.MatchState == "" {
		in.MatchState = observationMatchNotApplicable
	}
	return nil
}

// insertPlatformObservation 写入一条观测。同一 run 内的重复行（同 row_no 或同内容换批重发）
// 返回已有行的 id 且不新增记录，由调用方在回执里标 duplicate。
func insertPlatformObservation(ctx context.Context, tx pgx.Tx, in platformObservationInput) (uuid.UUID, bool, error) {
	if err := validatePlatformObservation(&in); err != nil {
		return uuid.Nil, false, err
	}
	hash := ""
	if !in.SkipPayloadHashCalc {
		h, err := observationPayloadHash(in)
		if err != nil {
			return uuid.Nil, false, err
		}
		hash = h
	}
	values, err := json.Marshal(in.Values)
	if err != nil {
		return uuid.Nil, false, err
	}
	paths, err := json.Marshal(in.FieldPaths)
	if err != nil {
		return uuid.Nil, false, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO platform_metric_observation (
			supersedes_id, run_id, batch_seq, row_no, workspace_id, account_id, external_account_key,
			external_id, scope, source, observed_at, as_of_at, window_start, window_end, temporal_kind,
			values, field_paths, adapter_version, mapping_version, browser_version, payload_hash,
			quality_state, match_state)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
		ON CONFLICT DO NOTHING
		RETURNING id`,
		in.SupersedesID, in.RunID, in.BatchSeq, in.RowNo, in.WorkspaceID, in.AccountID, in.ExternalAccountKey,
		in.ExternalID, in.Scope, in.Source, in.ObservedAt, in.AsOfAt, in.WindowStart, in.WindowEnd, in.TemporalKind,
		values, paths, in.AdapterVersion, in.MappingVersion, in.BrowserVersion, hash,
		in.QualityState, in.MatchState).Scan(&id)
	if err == nil {
		return id, false, nil
	}
	// ON CONFLICT DO NOTHING 命中任一唯一索引时不会返回行，表现为 ErrNoRows；
	// 串行化冲突则是唯一约束错误。两者都意味着“这条内容已经在库里”。
	if !errors.Is(err, pgx.ErrNoRows) && !isUniqueViolation(err) {
		return uuid.Nil, false, err
	}
	// 命中 (run_id,batch_seq,row_no) 或 (run_id,payload_hash,…) 或离线内容去重：返回已有行。
	existingID, findErr := findExistingObservation(ctx, tx, in, hash)
	if findErr != nil {
		return uuid.Nil, false, findErr
	}
	return existingID, true, nil
}

func findExistingObservation(ctx context.Context, tx pgx.Tx, in platformObservationInput, hash string) (uuid.UUID, error) {
	externalID := ""
	if in.ExternalID != nil {
		externalID = *in.ExternalID
	}
	var id uuid.UUID
	var err error
	if in.RunID != nil {
		err = tx.QueryRow(ctx, `SELECT id FROM platform_metric_observation
			WHERE run_id=$1 AND payload_hash=$2 AND scope=$3 AND coalesce(external_id,'')=$4
			  AND as_of_at IS NOT DISTINCT FROM $5 LIMIT 1`,
			*in.RunID, hash, in.Scope, externalID, in.AsOfAt).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, err
		}
	}
	err = tx.QueryRow(ctx, `SELECT id FROM platform_metric_observation
		WHERE run_id IS NULL AND payload_hash=$1 AND scope=$2 AND coalesce(external_id,'')=$3
		  AND as_of_at IS NOT DISTINCT FROM $4 LIMIT 1`,
		hash, in.Scope, externalID, in.AsOfAt).Scan(&id)
	if err == nil {
		return id, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// 命中了唯一约束却查不到：同一 (run, batch_seq, row_no) 上已有不同内容，属于冲突。
		return uuid.Nil, apiErr(409, "platform_result_conflict", "同一批次位置已提交过不同内容")
	}
	return uuid.Nil, err
}

// markObservationSuperseded 在被新观测替代时把旧行标 superseded，不改旧数值（§8.3）。
func markObservationSuperseded(ctx context.Context, tx pgx.Tx, oldID uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE platform_metric_observation SET quality_state=$2
		WHERE id=$1 AND quality_state<>$2`, oldID, observationQualitySuperseded)
	return err
}
