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
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	platformV2AccountBatchRows = 25
	platformV2ContentBatchRows = 10
	platformV2MetricBatchRows  = 25
	platformV2AccountBatchMax  = 512 << 10
	platformV2ContentBatchMax  = 2 << 20
	platformV2MetricBatchMax   = 512 << 10
	platformV2ContentRunMax    = 8 << 20
	platformV2ContentItemMax   = 1 << 20
	platformV2URLMax           = 8 << 10
)

type platformV2AccountSnapshot struct {
	IdentityExternalAccountKey string            `json:"identity_external_account_key"`
	DisplayName                *string           `json:"display_name,omitempty"`
	PublicAccountID            *string           `json:"public_account_id,omitempty"`
	AvatarRef                  *string           `json:"avatar_ref,omitempty"`
	Bio                        *string           `json:"bio,omitempty"`
	VerifiedType               *string           `json:"verified_type,omitempty"`
	RemoteAccountType          *string           `json:"remote_account_type,omitempty"`
	SafeFields                 map[string]string `json:"safe_fields,omitempty"`
	FieldStates                map[string]string `json:"field_states"`
	ObservedAt                 time.Time         `json:"observed_at"`
}

type platformV2CatalogResult struct {
	Items               []platformV2CatalogItem `json:"items"`
	EnumerationComplete bool                    `json:"enumeration_complete"`
	TotalCount          *int                    `json:"total_count,omitempty"`
	Partition           string                  `json:"partition"`
	NextPage            *int                    `json:"next_page,omitempty"`
	LastExternalID      *string                 `json:"last_external_id,omitempty"`
	Consistency         string                  `json:"consistency"`
}

type platformV2CatalogItem struct {
	ExternalID               string              `json:"external_id"`
	AuthorExternalAccountKey string              `json:"author_external_account_key"`
	RemoteContentType        string              `json:"remote_content_type"`
	RemoteStatus             string              `json:"remote_status"`
	Title                    string              `json:"title"`
	Summary                  string              `json:"summary"`
	AuthorDisplay            string              `json:"author_display"`
	CanonicalURL             *string             `json:"canonical_url,omitempty"`
	PublishedAt              *time.Time          `json:"published_at,omitempty"`
	RemoteUpdatedAt          *time.Time          `json:"remote_updated_at,omitempty"`
	CoverRef                 *string             `json:"cover_ref,omitempty"`
	Topics                   []string            `json:"topics"`
	Tags                     []string            `json:"tags"`
	FieldStates              map[string]string   `json:"field_states"`
	InlineMetrics            []platformResultRow `json:"inline_metrics,omitempty"`
}

type platformV2ContentResult struct {
	Items []platformV2ContentItem `json:"items"`
}

type platformV2ContentItem struct {
	ExternalID               string                   `json:"external_id"`
	AuthorExternalAccountKey string                   `json:"author_external_account_key"`
	ContentRevision          int                      `json:"content_revision"`
	State                    string                   `json:"state"`
	Title                    *string                  `json:"title,omitempty"`
	BodyText                 *string                  `json:"body_text,omitempty"`
	BodyStructure            []platformV2ContentBlock `json:"body_structure"`
	Summary                  *string                  `json:"summary,omitempty"`
	AuthorDisplay            *string                  `json:"author_display,omitempty"`
	Topics                   []string                 `json:"topics"`
	Tags                     []string                 `json:"tags"`
	CoverRef                 *string                  `json:"cover_ref,omitempty"`
	MediaRefs                []platformV2MediaRef     `json:"media_refs"`
	FieldStates              map[string]string        `json:"field_states"`
	ObservedAt               time.Time                `json:"observed_at"`
	RemoteUpdatedAt          *time.Time               `json:"remote_updated_at,omitempty"`
}

type platformV2ContentBlock struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	MediaIndex *int   `json:"media_index,omitempty"`
	Level      int    `json:"level,omitempty"`
}

type platformV2MediaRef struct {
	Kind            string `json:"kind"`
	URL             string `json:"url"`
	Position        int    `json:"position"`
	Width           int    `json:"width,omitempty"`
	Height          int    `json:"height,omitempty"`
	DurationSeconds int    `json:"duration_seconds,omitempty"`
}

type platformV2MetricsResult struct {
	Observations []platformResultRow `json:"observations"`
}

type platformV2ControlResult struct {
	State               string    `json:"state"`
	Reason              string    `json:"reason,omitempty"`
	EnumerationComplete bool      `json:"enumeration_complete,omitempty"`
	TotalCount          *int      `json:"total_count,omitempty"`
	Partition           string    `json:"partition,omitempty"`
	NextPage            *int      `json:"next_page,omitempty"`
	LastExternalID      *string   `json:"last_external_id,omitempty"`
	Consistency         string    `json:"consistency,omitempty"`
	HasMoreTargets      bool      `json:"has_more_targets,omitempty"`
	ObservedAt          time.Time `json:"observed_at"`
}

var platformSafeAccountFields = map[string]bool{
	"account_category": true,
	"creator_level":    true,
}

var platformSafeURLQueryKey = regexp.MustCompile(`(?i)(token|sign|auth|ticket|secret|cookie|session|credential|key)`)
var platformSafeReasons = map[string]bool{
	"page_budget": true, "content_capability_unverified": true, "metrics_capability_unverified": true,
	"profile_capability_unverified": true, "catalog_inconsistent": true,
	"access_denied": true, "temporarily_unavailable": true, "author_identity_unverified": true,
	"content_size_exceeded": true, "target_not_in_bounded_window": true, "unsupported_type": true,
	"network_unavailable": true, "no_accessible_works": true, "platform_risk": true,
}

type platformV2WriteContext struct {
	RunID                    uuid.UUID
	OperationID              uuid.UUID
	WorkspaceID              uuid.UUID
	AccountID                uuid.UUID
	ConnectionID             uuid.UUID
	RequestedBy              uuid.UUID
	Platform                 string
	ExternalAccountKey       string
	AdapterVersion           string
	MappingVersion           int
	BrowserVersion           string
	Stage                    string
	OperationKind            string
	AutoAdopt                bool
	AllowCatalogInlineMetric bool
	BatchSeq                 int
	LeaseGeneration          int64
	AuthorizationRevision    int64
	RawBytes                 int
	ExistingResultRows       int
	ExistingResultBytes      int64
}

func (s *Server) submitPlatformV2ResultBatchTx(ctx context.Context, tx pgx.Tx,
	batch platformResultBatch, write platformV2WriteContext) (platformReceipt, error) {
	if batch.ProtocolVersion != 2 || write.OperationID == uuid.Nil || batch.ResultType == "" || len(batch.Data) == 0 {
		return platformReceipt{}, validation("v2 批次必须包含协议版本、operation 和类型化 data")
	}
	if batch.Coverage != nil || len(batch.Observations) != 0 {
		return platformReceipt{}, validation("v2 结果只能使用 result_type/data，不能混用 v1 observations/coverage")
	}
	if err := checkPlatformJSONDepth(batch.Data, 16); err != nil {
		return platformReceipt{}, validation("v2 结果嵌套超过上限")
	}
	maxBatchBytes, maxRows := platformV2BatchLimits(batch.ResultType)
	if maxBatchBytes == 0 {
		return platformReceipt{}, validation("result_type 不受支持")
	}
	if write.RawBytes > maxBatchBytes {
		return platformReceipt{}, apiErr(http.StatusRequestEntityTooLarge, "platform_result_too_large", "该类型的批次超过大小上限")
	}
	if batch.FinalBatch != (batch.ResultType == "control") {
		return platformReceipt{}, validation("只有 control 批次可以结束 v2 run")
	}
	if !batch.FinalBatch && batch.RunStatus != platformRunStatusSuccess {
		return platformReceipt{}, validation("非终批的 run_status 必须为 succeeded")
	}
	if batch.FinalBatch && batch.RunStatus != platformRunStatusSuccess && batch.RunStatus != platformRunStatusPartial &&
		batch.RunStatus != platformRunStatusFailed && batch.RunStatus != platformRunStatusCanceled {
		return platformReceipt{}, validation("终批 run_status 无效")
	}
	if batch.ErrorCode != nil && !validPlatformResultError(*batch.ErrorCode) {
		return platformReceipt{}, validation("error_code 不在固定错误目录中")
	}

	var opKind string
	if err := tx.QueryRow(ctx, `SELECT kind FROM platform_sync_operation WHERE id=$1 AND workspace_id=$2 AND account_id=$3
		AND connection_id=$4 AND status IN ('queued','running') FOR UPDATE`, write.OperationID, write.WorkspaceID,
		write.AccountID, write.ConnectionID).Scan(&opKind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return platformReceipt{}, apiErr(409, "platform_operation_stale", "同步操作已结束或授权已变化")
		}
		return platformReceipt{}, err
	}
	if opKind != write.OperationKind || !platformV2StageAllowed(opKind, write.Stage, batch.ResultType) {
		return platformReceipt{}, apiErr(409, "platform_result_conflict", "result_type 与冻结的任务阶段不匹配")
	}
	dataRows, err := platformV2ResultRowCount(batch.ResultType, batch.Data)
	if err != nil {
		return platformReceipt{}, err
	}
	if dataRows > maxRows || write.ExistingResultRows+dataRows > platformRunMaxRows {
		return platformReceipt{}, apiErr(http.StatusRequestEntityTooLarge, "platform_result_rows_exceeded", "该批次或 run 的结果行数超过上限")
	}
	maxRunBytes := platformRunMaxBytes
	if batch.ResultType == "work_content" {
		maxRunBytes = platformV2ContentRunMax
	}
	if write.ExistingResultBytes+int64(write.RawBytes) > int64(maxRunBytes) {
		return platformReceipt{}, apiErr(http.StatusRequestEntityTooLarge, "platform_result_bytes_exceeded", "本次 run 的结果字节数超过上限")
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET budget_result_rows=budget_result_rows+$2,
		budget_result_bytes=budget_result_bytes+$3 WHERE id=$1`, write.RunID, dataRows, write.RawBytes); err != nil {
		return platformReceipt{}, err
	}

	receipt := platformReceipt{BatchSeq: batch.BatchSeq, ReceiptID: uuid.New(), Rows: []map[string]any{}}
	var counters map[string]any
	var coverage map[string]any
	var checkpoint map[string]any
	var countersRaw, coverageRaw, checkpointRaw []byte
	if err := tx.QueryRow(ctx, `SELECT counters,coverage,checkpoint FROM platform_sync_operation WHERE id=$1`, write.OperationID).
		Scan(&countersRaw, &coverageRaw, &checkpointRaw); err != nil {
		return platformReceipt{}, err
	}
	if json.Unmarshal(countersRaw, &counters) != nil || counters == nil {
		counters = platformCountersAsAny(platformInitialCounters())
	}
	if json.Unmarshal(coverageRaw, &coverage) != nil || coverage == nil {
		coverage = platformInitialCoverage("unknown")
	}
	if json.Unmarshal(checkpointRaw, &checkpoint) != nil || checkpoint == nil {
		checkpoint = map[string]any{}
	}
	switch batch.ResultType {
	case "account_snapshot":
		var data platformV2AccountSnapshot
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return platformReceipt{}, err
		}
		if err := s.writePlatformAccountSnapshotTx(ctx, tx, write, data); err != nil {
			return platformReceipt{}, err
		}
		incrementPlatformCounter(counters, "changed", 1)
		receipt.Accepted = 1
		receipt.Rows = append(receipt.Rows, map[string]any{"row_no": 0, "state": "accepted"})
	case "work_catalog":
		var data platformV2CatalogResult
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return platformReceipt{}, err
		}
		if len(data.Items) > platformV2AccountBatchRows {
			return platformReceipt{}, validation("work_catalog 单批最多 25 条")
		}
		seenExternalIDs := map[string]bool{}
		for index, item := range data.Items {
			if seenExternalIDs[item.ExternalID] {
				receipt.Duplicate++
				receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "duplicate"})
				continue
			}
			seenExternalIDs[item.ExternalID] = true
			if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			created, changed, skipped, err := s.writePlatformCatalogItemTx(ctx, tx, write, item)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return platformReceipt{}, rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return platformReceipt{}, err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			if skipped {
				incrementPlatformCounter(counters, "skipped", 1)
				receipt.Rejected++
				receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "skipped", "error_code": "out_of_scope_or_unpublished"})
				continue
			}
			if created {
				receipt.MirrorsCreated++
				incrementPlatformCounter(counters, "created", 1)
				incrementPlatformCounter(counters, "discovered", 1)
			} else if changed {
				receipt.MirrorsUpdated++
				incrementPlatformCounter(counters, "changed", 1)
				incrementPlatformCounter(counters, "discovered", 1)
			} else {
				incrementPlatformCounter(counters, "unchanged", 1)
				incrementPlatformCounter(counters, "discovered", 1)
			}
			receipt.Accepted++
			receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "accepted"})
			for metricIndex, row := range item.InlineMetrics {
				if row.Scope != observationScopeWork || row.ExternalID == nil || *row.ExternalID != item.ExternalID ||
					row.ExternalAccountKey != write.ExternalAccountKey {
					return platformReceipt{}, apiErr(409, "platform_result_conflict", "目录 inline_metrics 必须归属同一作品和账号")
				}
				row.RowNo = len(data.Items) + index*platformV2MetricBatchRows + metricIndex
				if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
					return platformReceipt{}, err
				}
				write.AllowCatalogInlineMetric = true
				added, pending, adopted, err := s.writePlatformV2MetricTx(ctx, tx, write, row, batch.BatchSeq)
				write.AllowCatalogInlineMetric = false
				if err != nil {
					if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
						return platformReceipt{}, rollbackErr
					}
					if isPlatformV2RowValidation(err) {
						receipt.Rejected++
						incrementPlatformCounter(counters, "failed", 1)
						rowNo := len(data.Items) + index*platformV2MetricBatchRows + metricIndex
						receipt.Rows = append(receipt.Rows, map[string]any{"row_no": rowNo, "state": "rejected", "error_code": "invalid_metric"})
						continue
					}
					return platformReceipt{}, err
				}
				if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
					return platformReceipt{}, err
				}
				if added {
					receipt.MetricsObserved++
					receipt.Accepted++
					incrementPlatformCounter(counters, "metrics_observed", 1)
				}
				if pending {
					receipt.Pending++
					incrementPlatformCounter(counters, "pending_confirmation", 1)
				}
				if adopted {
					receipt.MetricsAdopted++
					incrementPlatformCounter(counters, "metrics_adopted", 1)
				}
				if added && write.AutoAdopt && row.Scope == observationScopeWork && row.BindingRevision != nil && pending && !adopted {
					receipt.AdoptErrors++
					receipt.AdoptReason = "projection_failed"
				}
				if !added {
					receipt.Duplicate++
				}
			}
		}
	case "work_content":
		var data platformV2ContentResult
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return platformReceipt{}, err
		}
		if len(data.Items) > platformV2ContentBatchRows {
			return platformReceipt{}, validation("work_content 单批最多 10 条")
		}
		for index, item := range data.Items {
			if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			received, state, err := s.writePlatformContentItemTx(ctx, tx, write, item)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return platformReceipt{}, rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return platformReceipt{}, err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			if received {
				receipt.ContentReceived++
				incrementPlatformCounter(counters, "content_received", 1)
			} else if state == "complete" {
				incrementPlatformCounter(counters, "unchanged", 1)
			} else if state == "duplicate" {
				receipt.Duplicate++
			} else if state == "stale" {
				receipt.Duplicate++
			}
			if state == "failed" || state == "denied" || state == "rejected" {
				incrementPlatformCounter(counters, "failed", 1)
			}
			if state != "rejected" && state != "duplicate" && state != "stale" {
				receipt.Accepted++
			}
			rowReceipt := map[string]any{"row_no": index, "state": state}
			if state == "failed" {
				rowReceipt["error_code"] = "content_size_exceeded"
			}
			receipt.Rows = append(receipt.Rows, rowReceipt)
		}
	case "metrics":
		var data platformV2MetricsResult
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return platformReceipt{}, err
		}
		if len(data.Observations) > platformV2MetricBatchRows {
			return platformReceipt{}, validation("metrics 单批最多 25 条")
		}
		for index, row := range data.Observations {
			row.RowNo = index
			if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			added, pending, adopted, err := s.writePlatformV2MetricTx(ctx, tx, write, row, batch.BatchSeq)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return platformReceipt{}, rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return platformReceipt{}, err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return platformReceipt{}, err
			}
			if added {
				receipt.MetricsObserved++
				incrementPlatformCounter(counters, "metrics_observed", 1)
				receipt.Accepted++
			} else {
				receipt.Duplicate++
			}
			if pending {
				receipt.Pending++
				incrementPlatformCounter(counters, "pending_confirmation", 1)
			}
			if adopted {
				receipt.MetricsAdopted++
				incrementPlatformCounter(counters, "metrics_adopted", 1)
			}
			if added && write.AutoAdopt && row.Scope == observationScopeWork && row.BindingRevision != nil && pending && !adopted {
				receipt.AdoptErrors++
				receipt.AdoptReason = "projection_failed"
			}
			receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": map[bool]string{true: "accepted", false: "duplicate"}[added]})
		}
	case "control":
		var data platformV2ControlResult
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return platformReceipt{}, err
		}
		if err := validatePlatformV2Control(data); err != nil {
			return platformReceipt{}, err
		}
		if err := s.finishPlatformV2StageTx(ctx, tx, write, data, counters, coverage, checkpoint, batch, &receipt); err != nil {
			return platformReceipt{}, err
		}
	}

	if err := s.savePlatformV2ProgressTx(ctx, tx, write.OperationID, counters, coverage, checkpoint); err != nil {
		return platformReceipt{}, err
	}
	if batch.FinalBatch {
		if err := s.finishPlatformV2RunTx(ctx, tx, write, batch); err != nil {
			return platformReceipt{}, err
		}
	}
	return receipt, nil
}

func platformV2BatchLimits(resultType string) (maxBytes, maxRows int) {
	switch resultType {
	case "account_snapshot":
		return platformV2AccountBatchMax, 1
	case "work_catalog":
		return platformV2AccountBatchMax, platformV2AccountBatchRows
	case "work_content":
		return platformV2ContentBatchMax, platformV2ContentBatchRows
	case "metrics":
		return platformV2MetricBatchMax, platformV2MetricBatchRows
	case "control":
		return platformV2AccountBatchMax, 0
	default:
		return 0, 0
	}
}

func isPlatformV2RowValidation(err error) bool {
	var api *APIError
	return errors.As(err, &api) && api.Status == http.StatusUnprocessableEntity
}

func rollbackPlatformV2Row(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT platform_v2_row`); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`)
	return err
}

func platformV2StageAllowed(kind, stage, resultType string) bool {
	switch kind {
	case "account_sync":
		switch stage {
		case "profile":
			return resultType == "account_snapshot" || resultType == "control"
		case "catalog":
			return resultType == "work_catalog" || resultType == "metrics" || resultType == "control"
		case "content":
			return resultType == "work_content" || resultType == "control"
		case "metrics":
			return resultType == "metrics" || resultType == "control"
		}
	case "metrics_refresh":
		return stage == "metrics" && (resultType == "metrics" || resultType == "control")
	}
	return false
}

func platformV2ResultRowCount(resultType string, raw json.RawMessage) (int, error) {
	switch resultType {
	case "account_snapshot":
		var data platformV2AccountSnapshot
		return 1, decodePlatformV2Data(raw, &data)
	case "work_catalog":
		var data platformV2CatalogResult
		err := decodePlatformV2Data(raw, &data)
		return len(data.Items), err
	case "work_content":
		var data platformV2ContentResult
		err := decodePlatformV2Data(raw, &data)
		return len(data.Items), err
	case "metrics":
		var data platformV2MetricsResult
		err := decodePlatformV2Data(raw, &data)
		return len(data.Observations), err
	case "control":
		var data platformV2ControlResult
		return 0, decodePlatformV2Data(raw, &data)
	default:
		return 0, validation("result_type 不受支持")
	}
}

func decodePlatformV2Data(raw json.RawMessage, out any) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return validation("v2 data 不能为空")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return validation("v2 data schema 无效")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return validation("v2 data 只能包含一个 JSON 值")
	}
	return nil
}

func checkPlatformJSONDepth(raw []byte, maxDepth int) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return err
	}
	var depth func(any, int) error
	depth = func(v any, current int) error {
		if current > maxDepth {
			return errors.New("JSON depth exceeded")
		}
		switch typed := v.(type) {
		case []any:
			for _, child := range typed {
				if err := depth(child, current+1); err != nil {
					return err
				}
			}
		case map[string]any:
			for _, child := range typed {
				if err := depth(child, current+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return depth(value, 0)
}

// platformResultErrorCodes 是 20 文档 §12 固定错误目录里允许随终批上报的码。
//
// 缺陷背景（2026-10-26）：这张表原来只有 12 个码，而设计文档的目录里还有
// platform_browser_launch_failed（浏览器起不来）、platform_profile_busy（会话被占用）、
// platform_capability_denied（该账号无此数据权限）等正式错误码。桌面端上报这些码时
// 整批被判 422「error_code 不在固定错误目录中」，run 不结束、只能等租约过期，
// 于是界面上永远看不到「为什么没采到」。
//
// 文档 §12 末段要求「实施时用一张服务端表固化」，这里就是那张表。
var platformResultErrorCodes = map[string]bool{
	// 请求/设备/连接层
	"platform_client_required":            true,
	"platform_protocol_unsupported":       true,
	"platform_collection_disabled":        true,
	"platform_consent_required":           true,
	"platform_not_holder":                 true,
	"platform_device_revoked":             true,
	"platform_login_required":             true,
	"platform_challenge_required":         true,
	"platform_identity_mismatch":          true,
	"platform_capability_denied":          true,
	"platform_schema_changed":             true,
	"platform_network_unavailable":        true,
	"platform_profile_busy":               true,
	"platform_storage_quota_exceeded":     true,
	"platform_duplicate_local_connection": true,
	"platform_budget_exhausted":           true,
	"platform_lease_stale":                true,
	"platform_authorization_changed":      true,
	"platform_result_conflict":            true,
	"platform_value_out_of_range":         true,
	"platform_historical_unavailable":     true,
	"platform_account_restricted":         true,
	"platform_proxy_intercepted":          true,
	"platform_browser_unsupported":        true,
	"platform_browser_launch_failed":      true,
	"platform_mapping_unsupported":        true,
	"platform_not_supported":              true,
	"platform_presence_stale":             true,
	// 批次/运行层
	"platform_rate_limited": true,
	"platform_timeout":      true,
}

func validPlatformResultError(code string) bool {
	return platformResultErrorCodes[code]
}

func validatePlatformV2Control(data platformV2ControlResult) error {
	switch data.State {
	case "complete", "partial", "unsupported", "denied", "unknown":
	default:
		return validation("control.state 无效")
	}
	if data.State != "complete" && (data.Reason == "" || !platformSafeReasons[data.Reason]) {
		return validation("control.reason 不在固定错误目录中")
	}
	if data.TotalCount != nil && (*data.TotalCount < 0 || *data.TotalCount > 1_000_000_000) {
		return validation("control.total_count 超出范围")
	}
	if data.NextPage != nil && (*data.NextPage < 1 || *data.NextPage > 1_000_000) {
		return validation("control.next_page 超出范围")
	}
	if data.LastExternalID != nil && !validPlatformExternalID(*data.LastExternalID) {
		return validation("control.last_external_id 无效")
	}
	if data.Partition != "" && data.Partition != "published" && data.Partition != "articles" && data.Partition != "notes" && data.Partition != "micro_posts" {
		return validation("control.partition 无效")
	}
	if data.Consistency != "" && data.Consistency != "strong" && data.Consistency != "best_effort" && data.Consistency != "unknown" {
		return validation("control.consistency 无效")
	}
	if data.State == "complete" && data.NextPage != nil {
		return validation("complete control 不能携带续读页")
	}
	if !data.ObservedAt.IsZero() && data.ObservedAt.After(time.Now().Add(24*time.Hour)) {
		return validation("control.observed_at 不能是未来时间")
	}
	return nil
}

func (s *Server) writePlatformAccountSnapshotTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext, data platformV2AccountSnapshot) error {
	if data.IdentityExternalAccountKey != write.ExternalAccountKey {
		return apiErr(409, "platform_identity_mismatch", "平台资料主体与已核验连接不一致")
	}
	if data.ObservedAt.IsZero() || data.ObservedAt.After(time.Now().Add(24*time.Hour)) {
		return validation("资料观测时间无效")
	}
	if data.SafeFields == nil {
		data.SafeFields = map[string]string{}
	}
	if data.FieldStates == nil {
		data.FieldStates = map[string]string{}
	}
	if len(data.SafeFields) > 20 || len(data.FieldStates) > 16 {
		return validation("资料字段数量超过上限")
	}
	for key, value := range data.SafeFields {
		if !platformSafeAccountFields[key] || !validPlatformText(value, 512) {
			return validation("safe_fields 包含未登记字段或无效文本")
		}
	}
	if err := validateFieldStates(data.FieldStates, map[string]bool{
		"display_name": true, "public_account_id": true, "avatar_ref": true, "bio": true,
		"verified_type": true, "remote_account_type": true,
	}); err != nil {
		return err
	}
	for field, value := range map[string]*string{
		"display_name": data.DisplayName, "public_account_id": data.PublicAccountID, "bio": data.Bio,
		"verified_type": data.VerifiedType, "remote_account_type": data.RemoteAccountType,
	} {
		if value != nil && !validPlatformText(*value, platformFieldLimit(field)) {
			return validation("平台资料文本字段超出上限")
		}
		if data.FieldStates[field] == "present" && value == nil {
			return validation("资料声明 present 但缺少字段值")
		}
	}
	if data.AvatarRef != nil {
		if !validPlatformPublicURL(write.Platform, *data.AvatarRef, true) {
			return validation("头像引用不是允许的公开 HTTPS 地址")
		}
	}
	for field := range data.FieldStates {
		if data.FieldStates[field] == "present" && field == "avatar_ref" && data.AvatarRef == nil {
			return validation("资料声明 present 但缺少头像引用")
		}
	}
	var existingExternalKey string
	err := tx.QueryRow(ctx, `SELECT external_account_key FROM platform_account_snapshot WHERE account_id=$1 FOR UPDATE`, write.AccountID).Scan(&existingExternalKey)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err == nil && existingExternalKey != write.ExternalAccountKey {
		return apiErr(409, "platform_identity_mismatch", "已有平台资料属于其他主体，拒绝覆盖")
	}
	fieldStatesJSON, _ := json.Marshal(data.FieldStates)
	safeFieldsJSON, _ := json.Marshal(data.SafeFields)
	_, err = tx.Exec(ctx, `INSERT INTO platform_account_snapshot
		(account_id,workspace_id,platform,external_account_key,connection_id,display_name,public_account_id,avatar_ref,bio,
		 verified_type,remote_account_type,safe_fields,field_states,observed_at,source_run_id,adapter_version,mapping_version)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
		ON CONFLICT (account_id) DO UPDATE SET
		 display_name=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'display_name'='present' THEN EXCLUDED.display_name ELSE platform_account_snapshot.display_name END,
		 public_account_id=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'public_account_id'='present' THEN EXCLUDED.public_account_id ELSE platform_account_snapshot.public_account_id END,
		 avatar_ref=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'avatar_ref'='present' THEN EXCLUDED.avatar_ref ELSE platform_account_snapshot.avatar_ref END,
		 bio=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'bio'='present' THEN EXCLUDED.bio ELSE platform_account_snapshot.bio END,
		 verified_type=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'verified_type'='present' THEN EXCLUDED.verified_type ELSE platform_account_snapshot.verified_type END,
		 remote_account_type=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at AND EXCLUDED.field_states->>'remote_account_type'='present' THEN EXCLUDED.remote_account_type ELSE platform_account_snapshot.remote_account_type END,
		 safe_fields=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN platform_account_snapshot.safe_fields || EXCLUDED.safe_fields ELSE platform_account_snapshot.safe_fields END,
		 field_states=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN platform_account_snapshot.field_states || EXCLUDED.field_states ELSE platform_account_snapshot.field_states END,
		 revision=platform_account_snapshot.revision+CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN 1 ELSE 0 END,
		 observed_at=GREATEST(platform_account_snapshot.observed_at,EXCLUDED.observed_at),
		 source_run_id=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN EXCLUDED.source_run_id ELSE platform_account_snapshot.source_run_id END,
		 adapter_version=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN EXCLUDED.adapter_version ELSE platform_account_snapshot.adapter_version END,
		 mapping_version=CASE WHEN EXCLUDED.observed_at>=platform_account_snapshot.observed_at THEN EXCLUDED.mapping_version ELSE platform_account_snapshot.mapping_version END,
		 updated_at=now()`, write.AccountID, write.WorkspaceID, write.Platform, write.ExternalAccountKey,
		write.ConnectionID, nullablePlatformText(data.DisplayName), nullablePlatformText(data.PublicAccountID),
		data.AvatarRef, nullablePlatformText(data.Bio), nullablePlatformText(data.VerifiedType),
		nullablePlatformText(data.RemoteAccountType), safeFieldsJSON, fieldStatesJSON, data.ObservedAt,
		write.RunID, write.AdapterVersion, write.MappingVersion)
	return err
}

func (s *Server) writePlatformCatalogItemTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext, item platformV2CatalogItem) (created, changed, skipped bool, err error) {
	if item.AuthorExternalAccountKey != write.ExternalAccountKey {
		return false, false, false, apiErr(409, "platform_identity_mismatch", "作品作者与已核验平台账号不一致")
	}
	if !validPlatformExternalID(item.ExternalID) || !validPlatformText(item.Title, 512) || !validPlatformText(item.Summary, 4096) ||
		!validPlatformText(item.AuthorDisplay, 512) || len(item.Topics) > 100 || len(item.Tags) > 100 {
		return false, false, false, validation("work_catalog 字段无效或超过上限")
	}
	if item.RemoteStatus != "published" && item.RemoteStatus != "draft" && item.RemoteStatus != "reviewing" &&
		item.RemoteStatus != "hidden" && item.RemoteStatus != "deleted" && item.RemoteStatus != "unknown" {
		return false, false, false, validation("remote_status 无效")
	}
	if item.FieldStates == nil {
		item.FieldStates = map[string]string{}
	}
	if item.FieldStates["topics"] == "present" && item.Topics == nil || item.FieldStates["tags"] == "present" && item.Tags == nil {
		return false, false, false, validation("catalog 声明 present 但缺少数组字段")
	}
	if item.Topics == nil {
		item.Topics = []string{}
	}
	if item.Tags == nil {
		item.Tags = []string{}
	}
	if item.RemoteStatus != "published" {
		return false, false, true, nil
	}
	if item.RemoteContentType != "unknown" && !validPlatformContentType(write.Platform, item.RemoteContentType) {
		item.RemoteContentType = "unknown"
	}
	for _, value := range append(append([]string{}, item.Topics...), item.Tags...) {
		if !validPlatformText(value, 256) {
			return false, false, false, validation("work_catalog 的话题或标签超过上限")
		}
	}
	if err := validateFieldStates(item.FieldStates, map[string]bool{
		"title": true, "summary": true, "canonical_url": true, "published_at": true,
		"remote_updated_at": true, "cover_ref": true, "topics": true, "tags": true,
	}); err != nil {
		return false, false, false, err
	}
	for field, value := range map[string]*string{
		"canonical_url": item.CanonicalURL, "cover_ref": item.CoverRef,
	} {
		if item.FieldStates[field] == "present" && value == nil {
			return false, false, false, validation("catalog 声明 present 但缺少字段值")
		}
	}
	if item.CanonicalURL != nil && !validPlatformPublicURL(write.Platform, *item.CanonicalURL, false) {
		item.CanonicalURL = nil
		item.FieldStates["canonical_url"] = "denied"
	}
	if item.CoverRef != nil && !validPlatformPublicURL(write.Platform, *item.CoverRef, true) {
		item.CoverRef = nil
		item.FieldStates["cover_ref"] = "denied"
	}
	if item.PublishedAt != nil && item.PublishedAt.After(time.Now().Add(24*time.Hour)) {
		return false, false, false, validation("published_at 不能是未来时间")
	}
	if item.RemoteUpdatedAt != nil && item.RemoteUpdatedAt.After(time.Now().Add(24*time.Hour)) {
		return false, false, false, validation("remote_updated_at 不能是未来时间")
	}
	var scopeRaw []byte
	if err := tx.QueryRow(ctx, `SELECT frozen_scope FROM platform_sync_operation WHERE id=$1`, write.OperationID).Scan(&scopeRaw); err != nil {
		return false, false, false, err
	}
	var scope map[string]any
	if err := json.Unmarshal(scopeRaw, &scope); err != nil {
		return false, false, false, err
	}
	if raw, ok := scope["scope_upper_bound"].(string); ok {
		if upper, parseErr := time.Parse(time.RFC3339Nano, raw); parseErr == nil && item.PublishedAt != nil && item.PublishedAt.After(upper) {
			return false, false, true, nil
		}
	}
	topics, _ := json.Marshal(item.Topics)
	tags, _ := json.Marshal(item.Tags)
	fieldCoverage, _ := json.Marshal(item.FieldStates)
	var exists bool
	var oldTitle, oldSummary, oldContentType, oldStatus, oldAuthorDisplay, oldContentState string
	var oldCanonicalURL, oldCoverRef *string
	var oldPublished, oldUpdated *time.Time
	var oldTopics, oldTags, oldCoverage []byte
	if err := tx.QueryRow(ctx, `SELECT title,summary,remote_content_type,remote_status,published_at,remote_updated_at,
		author_display,canonical_url,cover_ref,topics,tags,field_coverage,content_state
		FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND external_account_key=$4 AND external_id=$5 FOR UPDATE`,
		write.WorkspaceID, write.AccountID, write.Platform, write.ExternalAccountKey, item.ExternalID).Scan(
		&oldTitle, &oldSummary, &oldContentType, &oldStatus, &oldPublished, &oldUpdated,
		&oldAuthorDisplay, &oldCanonicalURL, &oldCoverRef, &oldTopics, &oldTags, &oldCoverage, &oldContentState); err == nil {
		exists = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, false, false, err
	}
	if exists {
		changed = oldTitle != item.Title || oldSummary != item.Summary || oldContentType != item.RemoteContentType || oldStatus != item.RemoteStatus ||
			oldAuthorDisplay != item.AuthorDisplay || derefString(oldCanonicalURL) != derefString(item.CanonicalURL) ||
			derefString(oldCoverRef) != derefString(item.CoverRef) || !sameTime(oldPublished, item.PublishedAt) || !sameTime(oldUpdated, item.RemoteUpdatedAt) ||
			!sameJSONStrings(oldTopics, item.Topics) || !sameJSONStrings(oldTags, item.Tags)
	}
	_, err = tx.Exec(ctx, `INSERT INTO platform_work_mirror
		(workspace_id,account_id,platform,external_account_key,external_id,remote_content_type,remote_status,title,summary,author_display,
		 canonical_url,published_at,remote_updated_at,cover_ref,topics,tags,field_coverage,content_state,content_error_code,
		 last_sync_operation_id,source_run_id,last_seen_at)
		VALUES($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
		ON CONFLICT(workspace_id,account_id,platform,external_id) DO UPDATE SET
		 remote_content_type=EXCLUDED.remote_content_type,remote_status=EXCLUDED.remote_status,title=EXCLUDED.title,summary=EXCLUDED.summary,
		 author_display=EXCLUDED.author_display,canonical_url=EXCLUDED.canonical_url,published_at=EXCLUDED.published_at,
		 remote_updated_at=EXCLUDED.remote_updated_at,cover_ref=EXCLUDED.cover_ref,topics=EXCLUDED.topics,tags=EXCLUDED.tags,
		 field_coverage=platform_work_mirror.field_coverage || EXCLUDED.field_coverage,
		 content_state=CASE WHEN platform_work_mirror.content_state='complete' AND
			(platform_work_mirror.title IS DISTINCT FROM EXCLUDED.title OR platform_work_mirror.remote_updated_at IS DISTINCT FROM EXCLUDED.remote_updated_at)
			THEN 'unknown' ELSE platform_work_mirror.content_state END,
		 last_sync_operation_id=EXCLUDED.last_sync_operation_id,source_run_id=EXCLUDED.source_run_id,last_seen_at=GREATEST(platform_work_mirror.last_seen_at,EXCLUDED.last_seen_at),
		 revision=platform_work_mirror.revision+CASE WHEN platform_work_mirror.title IS DISTINCT FROM EXCLUDED.title OR
		 platform_work_mirror.summary IS DISTINCT FROM EXCLUDED.summary OR platform_work_mirror.remote_content_type IS DISTINCT FROM EXCLUDED.remote_content_type OR
				platform_work_mirror.author_display IS DISTINCT FROM EXCLUDED.author_display OR platform_work_mirror.canonical_url IS DISTINCT FROM EXCLUDED.canonical_url OR
				platform_work_mirror.cover_ref IS DISTINCT FROM EXCLUDED.cover_ref OR platform_work_mirror.topics IS DISTINCT FROM EXCLUDED.topics OR
				platform_work_mirror.tags IS DISTINCT FROM EXCLUDED.tags OR platform_work_mirror.published_at IS DISTINCT FROM EXCLUDED.published_at OR
				platform_work_mirror.remote_updated_at IS DISTINCT FROM EXCLUDED.remote_updated_at THEN 1 ELSE 0 END,
		 updated_at=now()`, write.WorkspaceID, write.AccountID, write.Platform, write.ExternalAccountKey, item.ExternalID,
		item.RemoteContentType, item.Title, item.Summary, item.AuthorDisplay, nullablePlatformText(item.CanonicalURL), item.PublishedAt,
		item.RemoteUpdatedAt, item.CoverRef, topics, tags, fieldCoverage,
		map[bool]string{true: "unsupported", false: "not_requested"}[item.RemoteContentType == "unknown"],
		map[bool]string{true: "unsupported_type", false: ""}[item.RemoteContentType == "unknown"], write.OperationID, write.RunID)
	if err != nil {
		return false, false, false, err
	}
	if !exists {
		return true, false, false, nil
	}
	return false, changed, false, nil
}

func (s *Server) writePlatformContentItemTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext, item platformV2ContentItem) (bool, string, error) {
	if item.AuthorExternalAccountKey != write.ExternalAccountKey {
		return false, "rejected", apiErr(409, "platform_identity_mismatch", "正文作者与已核验平台账号不一致")
	}
	if !validPlatformExternalID(item.ExternalID) || !validPlatformContentState(item.State) || item.ObservedAt.IsZero() ||
		item.ObservedAt.After(time.Now().Add(24*time.Hour)) || len(item.Topics) > 100 || len(item.Tags) > 100 || len(item.MediaRefs) > 200 {
		return false, "rejected", validation("work_content 字段无效或超过上限")
	}
	for _, value := range append(append([]string{}, item.Topics...), item.Tags...) {
		if !validPlatformText(value, 256) {
			return false, "rejected", validation("work_content 的话题或标签超过上限")
		}
	}
	if item.Title != nil && !validPlatformText(*item.Title, 512) || item.BodyText != nil && !validPlatformText(*item.BodyText, 1<<20) ||
		item.Summary != nil && !validPlatformText(*item.Summary, 4096) || item.AuthorDisplay != nil && !validPlatformText(*item.AuthorDisplay, 512) {
		return false, "rejected", validation("work_content 文本无效或超过上限")
	}
	if err := validateFieldStates(item.FieldStates, map[string]bool{
		"title": true, "body_text": true, "body_structure": true, "summary": true,
		"author_display": true, "topics": true, "tags": true, "cover_ref": true, "media_refs": true,
		"remote_updated_at": true,
	}); err != nil {
		return false, "rejected", err
	}
	if item.FieldStates == nil {
		item.FieldStates = map[string]string{}
	}
	if item.FieldStates["topics"] == "present" && item.Topics == nil || item.FieldStates["tags"] == "present" && item.Tags == nil ||
		item.FieldStates["body_structure"] == "present" && item.BodyStructure == nil || item.FieldStates["media_refs"] == "present" && item.MediaRefs == nil {
		return false, "rejected", validation("work_content 声明 present 但缺少数组字段")
	}
	if item.Topics == nil {
		item.Topics = []string{}
	}
	if item.Tags == nil {
		item.Tags = []string{}
	}
	if item.BodyStructure == nil {
		item.BodyStructure = []platformV2ContentBlock{}
	}
	if item.MediaRefs == nil {
		item.MediaRefs = []platformV2MediaRef{}
	}
	if item.State == "complete" && (item.Title == nil || item.BodyText == nil || item.FieldStates["title"] != "present" || item.FieldStates["body_text"] != "present") {
		return false, "rejected", validation("complete 正文必须包含标题和正文")
	}
	for field, value := range map[string]*string{
		"title": item.Title, "body_text": item.BodyText, "summary": item.Summary,
		"author_display": item.AuthorDisplay, "cover_ref": item.CoverRef,
	} {
		if item.FieldStates[field] == "present" && value == nil {
			return false, "rejected", validation("work_content 声明 present 但缺少字段值")
		}
	}
	blocks := make([]platformV2ContentBlock, len(item.BodyStructure))
	for i, block := range item.BodyStructure {
		if !validPlatformContentBlock(block, len(item.MediaRefs)) {
			return false, "rejected", validation("body_structure 包含不支持的块")
		}
		blocks[i] = block
	}
	validMedia := make([]platformV2MediaRef, 0, len(item.MediaRefs))
	mediaDenied := false
	for _, media := range item.MediaRefs {
		if !validPlatformMediaRef(write.Platform, media) {
			mediaDenied = true
			continue
		}
		validMedia = append(validMedia, media)
	}
	if mediaDenied {
		item.FieldStates["media_refs"] = "denied"
	}
	if item.CoverRef != nil && !validPlatformPublicURL(write.Platform, *item.CoverRef, true) {
		item.CoverRef = nil
		item.FieldStates["cover_ref"] = "denied"
	}
	if item.RemoteUpdatedAt != nil && item.RemoteUpdatedAt.After(time.Now().Add(24*time.Hour)) {
		return false, "rejected", validation("remote_updated_at 不能是未来时间")
	}
	itemJSON, _ := json.Marshal(item)
	if len(itemJSON) > platformV2ContentItemMax {
		_, err := tx.Exec(ctx, `UPDATE platform_work_mirror SET content_state='failed',content_error_code='content_size_exceeded',
			field_coverage=field_coverage || $2,last_sync_operation_id=$3,source_run_id=$4,updated_at=now()
			WHERE workspace_id=$5 AND account_id=$6 AND platform=$7 AND external_account_key=$8 AND external_id=$9 AND remote_status='published'`,
			mustJSON(item.FieldStates), write.OperationID, write.RunID, write.WorkspaceID, write.AccountID, write.Platform, write.ExternalAccountKey, item.ExternalID)
		return false, "failed", err
	}
	var mirrorID uuid.UUID
	var oldHash *string
	var oldObserved *time.Time
	if err := tx.QueryRow(ctx, `SELECT id,content_hash,content_observed_at FROM platform_work_mirror
		WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND external_account_key=$4 AND external_id=$5 AND remote_status='published' FOR UPDATE`,
		write.WorkspaceID, write.AccountID, write.Platform, write.ExternalAccountKey, item.ExternalID).Scan(&mirrorID, &oldHash, &oldObserved); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, "rejected", apiErr(409, "platform_result_conflict", "正文目标不属于当前账号的已发布镜像")
		}
		return false, "rejected", err
	}
	frozenRevision := item.ContentRevision
	if err := platformV2RequireFrozenMirrorTarget(ctx, tx, write.RunID, mirrorID, item.ExternalID, write.ExternalAccountKey, &frozenRevision); err != nil {
		return false, "rejected", err
	}
	if oldObserved != nil && item.ObservedAt.Before(*oldObserved) {
		return false, "duplicate", nil
	}
	if item.State != "complete" {
		_, err := tx.Exec(ctx, `UPDATE platform_work_mirror SET content_state=$2,content_error_code=$3,field_coverage=$4,
			last_sync_operation_id=$5,source_run_id=$6,updated_at=now() WHERE id=$1`, mirrorID, item.State,
			contentErrorFromFieldStates(item.FieldStates), mustJSON(item.FieldStates), write.OperationID, write.RunID)
		return false, item.State, err
	}
	mediaJSON, _ := json.Marshal(validMedia)
	blocksJSON, _ := json.Marshal(blocks)
	topicsJSON, _ := json.Marshal(item.Topics)
	tagsJSON, _ := json.Marshal(item.Tags)
	coverageJSON, _ := json.Marshal(item.FieldStates)
	content := map[string]any{"title": item.Title, "body_text": item.BodyText, "body_structure": blocks,
		"summary": item.Summary, "author_display": item.AuthorDisplay, "topics": item.Topics, "tags": item.Tags,
		"cover_ref": item.CoverRef, "media_refs": validMedia, "remote_updated_at": item.RemoteUpdatedAt}
	canonical, err := json.Marshal(content)
	if err != nil {
		return false, "rejected", err
	}
	hash := sha256.Sum256(canonical)
	contentHash := hex.EncodeToString(hash[:])
	changed := oldHash == nil || *oldHash != contentHash
	if changed {
		_, err = tx.Exec(ctx, `UPDATE platform_work_mirror SET title=$2,body_text=$3,body_structure=$4,summary=$5,author_display=$6,
			topics=$7,tags=$8,cover_ref=$9,media_refs=$10,remote_updated_at=$11,content_hash=$12,
			content_revision=content_revision+1,revision=revision+1,content_state='complete',content_error_code=NULL,
			field_coverage=$13,content_observed_at=$14,last_sync_operation_id=$15,source_run_id=$16,updated_at=now()
			WHERE id=$1`, mirrorID, derefString(item.Title), derefString(item.BodyText), blocksJSON, derefString(item.Summary),
			derefString(item.AuthorDisplay), topicsJSON, tagsJSON, item.CoverRef, mediaJSON, item.RemoteUpdatedAt,
			contentHash, coverageJSON, item.ObservedAt, write.OperationID, write.RunID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE platform_work_mirror SET content_state='complete',content_error_code=NULL,
			field_coverage=$2,content_observed_at=GREATEST(content_observed_at,$3),last_sync_operation_id=$4,
			source_run_id=$5,updated_at=now() WHERE id=$1`, mirrorID, coverageJSON, item.ObservedAt, write.OperationID, write.RunID)
	}
	if err != nil {
		return false, "rejected", err
	}
	return changed, "complete", nil
}

func (s *Server) writePlatformV2MetricTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext,
	row platformResultRow, batchSeq int) (added, pending, adopted bool, err error) {
	if row.ExternalAccountKey != write.ExternalAccountKey {
		return false, false, false, apiErr(409, "platform_identity_mismatch", "指标观测主体与当前连接不一致")
	}
	if row.MappingVersion != write.MappingVersion || row.AdapterVersion != write.AdapterVersion {
		return false, false, false, apiErr(409, "platform_result_conflict", "指标映射版本与 run 冻结版本不一致")
	}
	var platformWorkID *uuid.UUID
	matchState := observationMatchNotApplicable
	if row.Scope == observationScopeWork {
		if row.ExternalID == nil || !validPlatformExternalID(*row.ExternalID) {
			return false, false, false, validation("作品指标缺少稳定外部编号")
		}
		bound, err := s.platformV2LocalBindingForExternalID(ctx, tx, write.RunID, *row.ExternalID, row.BindingRevision, row.PublishRevision)
		if err != nil {
			return false, false, false, err
		}
		var mirrorID uuid.UUID
		mirrorErr := tx.QueryRow(ctx, `SELECT id FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2 AND platform=$3
			AND external_account_key=$4 AND external_id=$5 AND remote_status='published'`, write.WorkspaceID, write.AccountID,
			write.Platform, write.ExternalAccountKey, *row.ExternalID).Scan(&mirrorID)
		if mirrorErr != nil && !errors.Is(mirrorErr, pgx.ErrNoRows) {
			return false, false, false, mirrorErr
		}
		if errors.Is(mirrorErr, pgx.ErrNoRows) {
			if !bound || write.AllowCatalogInlineMetric {
				return false, false, false, apiErr(409, "platform_result_conflict", "指标目标不属于冻结的账号作品")
			}
		} else {
			platformWorkID = &mirrorID
			if !write.AllowCatalogInlineMetric {
				if err := platformV2RequireFrozenMirrorTarget(ctx, tx, write.RunID, mirrorID, *row.ExternalID, write.ExternalAccountKey, nil); err != nil && !bound {
					return false, false, false, err
				}
			}
		}
		matchState = observationMatchUnmatched
		if bound {
			matchState = observationMatchBound
		}
	} else if row.Scope != observationScopeAccount {
		return false, false, false, validation("指标 scope 无效")
	} else if write.OperationKind == "metrics_refresh" {
		return false, false, false, apiErr(409, "platform_result_conflict", "指标刷新必须遵循冻结的作品目标")
	}
	rowNo := row.RowNo
	in := platformObservationInput{RunID: &write.RunID, BatchSeq: &batchSeq, RowNo: &rowNo,
		WorkspaceID: write.WorkspaceID, AccountID: write.AccountID, PlatformWorkID: platformWorkID,
		ExternalAccountKey: write.ExternalAccountKey, ExternalID: row.ExternalID, Scope: row.Scope, Source: row.Source,
		TemporalKind: row.TemporalKind, ObservedAt: row.ObservedAt, AsOfAt: row.AsOfAt, WindowStart: row.WindowStart,
		WindowEnd: row.WindowEnd, Values: row.Values, FieldPaths: row.FieldPaths, AdapterVersion: row.AdapterVersion,
		MappingVersion: row.MappingVersion, BrowserVersion: write.BrowserVersion, MatchState: matchState}
	obsID, duplicate, err := insertPlatformObservation(ctx, tx, in)
	if err != nil {
		return false, false, false, err
	}
	if duplicate {
		return false, false, false, nil
	}
	if row.Scope == observationScopeWork && matchState == observationMatchBound && row.ExternalID != nil {
		if row.PlatformPublishedAt != nil {
			if err := backfillPublishedAt(ctx, tx, write.AccountID, write.Platform, *row.ExternalID, *row.PlatformPublishedAt); err != nil {
				return false, false, false, err
			}
		}
		if write.AutoAdopt {
			if err := s.adoptInSavepoint(ctx, tx, obsID, write.WorkspaceID); err != nil {
				return true, true, false, nil
			}
			_, err = tx.Exec(ctx, `UPDATE platform_work_mirror SET initial_metrics_state='complete',updated_at=now() WHERE id=$1`, *platformWorkID)
			return true, false, err == nil, err
		}
	}
	if row.Scope == observationScopeWork && platformWorkID != nil {
		_, err := tx.Exec(ctx, `UPDATE platform_work_mirror SET initial_metrics_state='complete',updated_at=now() WHERE id=$1`, *platformWorkID)
		if err != nil {
			return false, false, false, err
		}
	}
	return true, true, false, nil
}

func (s *Server) platformV2LocalBindingForExternalID(ctx context.Context, tx pgx.Tx, runID uuid.UUID, externalID string,
	bindingRevision, publishRevision *int) (bool, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, runID).Scan(&raw); err != nil {
		return false, err
	}
	var snapshot struct {
		LocalBindings []struct {
			ExternalID      string `json:"external_id"`
			BindingRevision int    `json:"binding_revision"`
			PublishRevision int    `json:"publish_revision"`
		} `json:"local_bindings"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return false, err
	}
	for _, item := range snapshot.LocalBindings {
		if item.ExternalID != externalID {
			continue
		}
		if bindingRevision == nil || publishRevision == nil || *bindingRevision != item.BindingRevision || *publishRevision != item.PublishRevision {
			return false, apiErr(409, "platform_authorization_changed", "作品绑定或发布修订已变化")
		}
		return true, nil
	}
	if bindingRevision != nil || publishRevision != nil {
		return false, apiErr(409, "platform_result_conflict", "未冻结的作品不能上报本地绑定修订")
	}
	return false, nil
}

func platformV2RequireFrozenMirrorTarget(ctx context.Context, tx pgx.Tx, runID, mirrorID uuid.UUID, externalID, externalKey string,
	expectedRevision *int) error {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT binding_snapshot FROM platform_sync_run WHERE id=$1`, runID).Scan(&raw); err != nil {
		return err
	}
	var snapshot struct {
		PlatformWorks []struct {
			PlatformWorkID     uuid.UUID `json:"platform_work_id"`
			ExternalID         string    `json:"external_id"`
			ExternalAccountKey string    `json:"external_account_key"`
			ContentRevision    int       `json:"content_revision"`
		} `json:"platform_works"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	for _, target := range snapshot.PlatformWorks {
		if target.PlatformWorkID != mirrorID || target.ExternalID != externalID || target.ExternalAccountKey != externalKey {
			continue
		}
		if expectedRevision != nil && *expectedRevision != target.ContentRevision {
			return apiErr(409, "platform_result_conflict", "平台作品内容修订与冻结目标不一致")
		}
		var currentRevision int
		if err := tx.QueryRow(ctx, `SELECT content_revision FROM platform_work_mirror WHERE id=$1 AND external_id=$2
			AND external_account_key=$3`, mirrorID, externalID, externalKey).Scan(&currentRevision); err != nil {
			return err
		}
		if currentRevision != target.ContentRevision {
			return apiErr(409, "platform_result_conflict", "平台作品内容修订已变化，请重新领取目标")
		}
		return nil
	}
	return apiErr(409, "platform_result_conflict", "平台作品不在本次冻结目标中")
}

func (s *Server) finishPlatformV2StageTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext,
	data platformV2ControlResult, counters, coverage, checkpoint map[string]any,
	batch platformResultBatch, receipt *platformReceipt) error {
	if data.State == "complete" && batch.RunStatus != platformRunStatusSuccess {
		return validation("complete control 必须以 succeeded 结束 run")
	}
	if data.State != "complete" && batch.RunStatus == platformRunStatusSuccess && data.State != "unsupported" {
		return validation("partial/denied/unknown control 不能标成 succeeded")
	}
	stageCoverage, _ := coverage[write.Stage].(map[string]any)
	if stageCoverage == nil {
		stageCoverage = map[string]any{}
	}
	coverageState := data.State
	pendingTargets := false
	if write.Stage == "content" && data.State == "complete" {
		var pending int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2
			AND platform=$3 AND external_account_key=$4 AND last_sync_operation_id=$5 AND remote_status='published'
			AND content_state NOT IN ('complete','unsupported','denied')`, write.WorkspaceID, write.AccountID,
			write.Platform, write.ExternalAccountKey, write.OperationID).Scan(&pending); err != nil {
			return err
		}
		stageCoverage["pending"] = pending
		if pending > 0 {
			coverageState = "partial"
			pendingTargets = true
		}
	}
	if write.Stage == "metrics" && data.State == "complete" && write.OperationKind == "account_sync" {
		var pending int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2
			AND platform=$3 AND external_account_key=$4 AND last_sync_operation_id=$5 AND remote_status='published'
			AND initial_metrics_state NOT IN ('complete','unsupported','denied')`, write.WorkspaceID, write.AccountID,
			write.Platform, write.ExternalAccountKey, write.OperationID).Scan(&pending); err != nil {
			return err
		}
		stageCoverage["pending"] = pending
		if pending > 0 {
			coverageState = "partial"
			pendingTargets = true
		}
	}
	if write.OperationKind == "metrics_refresh" && data.State == "complete" {
		var scopeRaw []byte
		if err := tx.QueryRow(ctx, `SELECT frozen_scope FROM platform_sync_operation WHERE id=$1`, write.OperationID).Scan(&scopeRaw); err != nil {
			return err
		}
		var scope map[string]any
		if err := json.Unmarshal(scopeRaw, &scope); err != nil {
			return err
		}
		if scope["target_scope"] == "due_and_recent" {
			op := queuedPlatformOperation{ID: write.OperationID, WorkspaceID: write.WorkspaceID, AccountID: write.AccountID}
			local, mirrors, err := s.dueAndRecentPlatformRunTargets(ctx, tx, op, write.Platform, write.ExternalAccountKey, scope, time.Now())
			if err != nil {
				return err
			}
			pendingTargets = len(local)+len(mirrors) > 0
			if pendingTargets {
				coverageState = "partial"
			}
		}
	}
	stageCoverage["state"] = coverageState
	stageCoverage["reason"] = nullableString(data.Reason)
	if data.TotalCount != nil {
		stageCoverage["total_count"] = *data.TotalCount
	}
	if data.Consistency != "" {
		stageCoverage["consistency"] = data.Consistency
	}
	if data.Partition != "" {
		stageCoverage["partition"] = data.Partition
	}
	if data.NextPage != nil {
		checkpoint["partition"] = data.Partition
		checkpoint["next_page"] = *data.NextPage
	}
	if data.LastExternalID != nil {
		checkpoint["last_external_id"] = *data.LastExternalID
	}
	if data.Consistency != "" {
		checkpoint["consistency"] = data.Consistency
	}
	if write.Stage == "catalog" {
		if data.State == "complete" && !data.EnumerationComplete {
			return validation("catalog complete 必须确认枚举到末页")
		}
		if data.State == "complete" && data.TotalCount == nil {
			var enumerated int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2
				AND platform=$3 AND external_account_key=$4 AND last_sync_operation_id=$5 AND remote_status='published'`,
				write.WorkspaceID, write.AccountID, write.Platform, write.ExternalAccountKey, write.OperationID).Scan(&enumerated); err != nil {
				return err
			}
			data.TotalCount = &enumerated
		}
	}
	coverage[write.Stage] = stageCoverage
	if data.State == "partial" && (data.Reason == "target_not_in_bounded_window" || data.Reason == "catalog_inconsistent") {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='partial',stage='complete',pause_reason=NULL,
			last_error_code=$2,revision=revision+1,coverage=$3,counters=$4,checkpoint=$5,finished_at=now(),updated_at=now() WHERE id=$1`,
			write.OperationID, data.Reason, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
		return err
	}
	if pendingTargets {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='queued',stage=$2,next_allowed_at=NULL,
			pause_reason=NULL,revision=revision+1,coverage=$3,counters=$4,checkpoint=$5,updated_at=now() WHERE id=$1`,
			write.OperationID, write.Stage, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
		return err
	}
	if data.State == "complete" || data.State == "unsupported" || data.State == "denied" ||
		(write.Stage == "profile" && data.State == "unknown" && data.Reason == "profile_capability_unverified") {
		return s.advancePlatformV2OperationTx(ctx, tx, write, data, counters, coverage, checkpoint)
	}
	if batch.RunStatus == platformRunStatusFailed {
		if err := s.finishPlatformV2OperationFailureTx(ctx, tx, write, batch, counters, coverage, checkpoint, receipt); err != nil {
			return err
		}
		return nil
	}
	nextStatus := "queued"
	var nextAllowed any
	if data.Reason == "page_budget" || data.Reason == "network_unavailable" || data.Reason == "temporarily_unavailable" {
		// 查询数/作品尝试数由 worker 的下一次预算申请给出；页预算则可在日额度内续跑。
		if data.Reason != "page_budget" {
			nextStatus = "waiting_budget"
			nextAllowed = time.Now().Add(5 * time.Minute)
		}
	}
	_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status=$2,next_allowed_at=$3,pause_reason=CASE WHEN $2='waiting_budget' THEN 'budget' ELSE NULL END,
		revision=revision+1,coverage=$4,counters=$5,checkpoint=$6,updated_at=now() WHERE id=$1`, write.OperationID,
		nextStatus, nextAllowed, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
	return err
}

func (s *Server) advancePlatformV2OperationTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext,
	data platformV2ControlResult, counters, coverage, checkpoint map[string]any) error {
	nextStage := ""
	finalStatus := "partial"
	if write.OperationKind == "metrics_refresh" {
		if data.State == "complete" {
			finalStatus = "succeeded"
		}
	} else {
		switch write.Stage {
		case "profile":
			nextStage = "catalog"
		case "catalog":
			if platformSyncCapabilityStateForAccount(ctx, tx, write.ConnectionID, write.Platform, "content") == "supported" {
				nextStage = "content"
			} else {
				setCoverageState(coverage, "content", platformSyncCapabilityStateForAccount(ctx, tx, write.ConnectionID, write.Platform, "content"), "content_capability_unverified")
				if platformSyncCapabilityStateForAccount(ctx, tx, write.ConnectionID, write.Platform, "metrics") == "supported" {
					nextStage = "metrics"
				} else {
					setCoverageState(coverage, "metrics", "unsupported", "metrics_capability_unverified")
				}
			}
		case "content":
			if platformSyncCapabilityStateForAccount(ctx, tx, write.ConnectionID, write.Platform, "metrics") == "supported" {
				nextStage = "metrics"
			} else {
				setCoverageState(coverage, "metrics", "unsupported", "metrics_capability_unverified")
			}
		case "metrics":
		}
		if nextStage == "" && data.State == "complete" && allPlatformCoverageComplete(coverage) {
			finalStatus = "succeeded"
		}
	}
	if nextStage != "" {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='queued',stage=$2,next_allowed_at=NULL,pause_reason=NULL,
			revision=revision+1,coverage=$3,counters=$4,checkpoint=$5,updated_at=now() WHERE id=$1`,
			write.OperationID, nextStage, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status=$2,stage='complete',next_allowed_at=NULL,
		pause_reason=NULL,revision=revision+1,coverage=$3,counters=$4,checkpoint=$5,finished_at=now(),updated_at=now() WHERE id=$1`,
		write.OperationID, finalStatus, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
	return err
}

func (s *Server) finishPlatformV2OperationFailureTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext,
	batch platformResultBatch, counters, coverage, checkpoint map[string]any, receipt *platformReceipt) error {
	code := ""
	if batch.ErrorCode != nil {
		code = *batch.ErrorCode
	}
	if code == "platform_login_required" || code == "platform_challenge_required" {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_login',last_error_code=$2,
			revision=revision+1,updated_at=now(),coverage=$3,counters=$4,checkpoint=$5 WHERE id=$1`,
			write.OperationID, code, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
		return err
	}
	if code == "platform_rate_limited" || code == "platform_account_restricted" || code == "platform_identity_mismatch" {
		if err := pausePlatformSubjectForRiskTx(ctx, tx, write.Platform, write.ExternalAccountKey, write.OperationID, code); err != nil {
			return err
		}
		return nil
	}
	if code == "platform_network_unavailable" {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='waiting_budget',next_allowed_at=now()+interval '5 minutes',
			pause_reason='budget',last_error_code=$2,revision=revision+1,updated_at=now(),coverage=$3,counters=$4,checkpoint=$5 WHERE id=$1`,
			write.OperationID, code, mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
		return err
	}
	final := "failed"
	if counterValue(counters, "created")+counterValue(counters, "changed")+counterValue(counters, "content_received")+counterValue(counters, "metrics_observed") > 0 {
		final = "partial"
	}
	_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status=$2,stage='complete',pause_reason=NULL,last_error_code=$3,
		revision=revision+1,finished_at=now(),updated_at=now(),coverage=$4,counters=$5,checkpoint=$6 WHERE id=$1`,
		write.OperationID, final, nullableString(code), mustJSON(coverage), mustJSON(counters), mustJSON(checkpoint))
	return err
}

func (s *Server) finishPlatformV2RunTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext, batch platformResultBatch) error {
	nextStatus := batch.RunStatus
	// stop_reason 必须先过枚举校验，理由与 v1 终批（platform_sync.go 的
	// "stop_reason 必须先过枚举校验" 注释）完全相同：v2 客户端发上来的是
	// platformSafeReasons 里的词（network_unavailable、access_denied、
	// profile_capability_unverified、page_budget…），一个都不在
	// platform_sync_run_stop_reason_check 允许的七个值里。原样写库会抛 23514，
	// 整个终批事务回滚——观测与 catalog 全丢、run 卡在 running 直到租约过期。
	// 2026-10-26 实测：三条 account_sync run 全部 expired、counters={}、
	// budget_result_rows=0，就是这么来的。
	rawStopReason := ""
	if batch.StopReason != nil {
		rawStopReason = *batch.StopReason
	}
	stopReason := platformStopReason(batch.StopReason)
	if rawStopReason != "" && stopReason == nil {
		slog.Warn("平台采集 v2：客户端上报的停止原因不在登记枚举内，按空值存库",
			"run_id", write.RunID, "stop_reason", rawStopReason)
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status=$2,stop_reason=$3,error_code=$4,
		counters=CASE WHEN $5::text='' THEN counters
			ELSE counters || jsonb_build_object('stop_reason_raw',$5::text) END,
		finished_at=now()
		WHERE id=$1`, write.RunID, nextStatus, stopReason, batch.ErrorCode, rawStopReason); err != nil {
		return err
	}
	if nextStatus == platformRunStatusSuccess || nextStatus == platformRunStatusPartial {
		_, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=0,cooldown_until=NULL,
			next_due_at=now()+interval '1 day',updated_at=now() WHERE id=$1`, write.ConnectionID)
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=failure_count+1,cooldown_until=now()+interval '5 minutes',updated_at=now()
		WHERE id=$1`, write.ConnectionID); err != nil {
		return err
	}
	return s.applyRunFailureAction(ctx, tx, write.ConnectionID, batch.ErrorCode)
}

func pausePlatformSubjectForRiskTx(ctx context.Context, tx pgx.Tx, platform, externalKey string, currentOperationID uuid.UUID, code string) error {
	if _, err := tx.Exec(ctx, `UPDATE platform_connection SET auto_collect=false,state='paused',availability='restricted',
		authorization_revision=authorization_revision+1,updated_at=now() WHERE platform=$1 AND external_account_key=$2 AND state='active'`, platform, externalKey); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='paused',pause_reason='risk',last_error_code=$3,
		revision=revision+1,updated_at=now() WHERE platform=$1 AND id<>$2 AND status IN ('queued','running','waiting_budget','waiting_device','waiting_login')`,
		platform, currentOperationID, code); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET status='paused',pause_reason='risk',last_error_code=$2,
		revision=revision+1,updated_at=now() WHERE id=$1`, currentOperationID, code); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE platform_sync_run r SET status='canceled',cancel_requested_at=now(),finished_at=now()
		FROM platform_connection c WHERE c.id=r.connection_id AND c.platform=$1 AND c.external_account_key=$2
		AND r.status IN ('queued','leased','running')`, platform, externalKey)
	return err
}

func (s *Server) savePlatformV2ProgressTx(ctx context.Context, tx pgx.Tx, operationID uuid.UUID,
	counters, coverage, checkpoint map[string]any) error {
	_, err := tx.Exec(ctx, `UPDATE platform_sync_operation SET counters=$2,coverage=$3,checkpoint=$4,updated_at=now() WHERE id=$1`,
		operationID, mustJSON(counters), mustJSON(coverage), mustJSON(checkpoint))
	return err
}

func platformSyncCapabilityStateForAccount(ctx context.Context, tx pgx.Tx, connectionID uuid.UUID, platform, capability string) string {
	var raw []byte
	if tx.QueryRow(ctx, `SELECT capabilities FROM platform_connection WHERE id=$1`, connectionID).Scan(&raw) != nil {
		return "unknown"
	}
	return platformSyncCapabilityState(raw, platform, capability)
}

func setCoverageState(coverage map[string]any, stage, state, reason string) {
	entry, _ := coverage[stage].(map[string]any)
	if entry == nil {
		entry = map[string]any{"range": nil, "total_count": nil, "succeeded": 0, "failed": 0, "pending": 0}
	}
	entry["state"] = state
	entry["reason"] = reason
	coverage[stage] = entry
}

func allPlatformCoverageComplete(coverage map[string]any) bool {
	for _, stage := range []string{"profile", "catalog", "content", "metrics"} {
		entry, _ := coverage[stage].(map[string]any)
		if entry == nil || entry["state"] != "complete" {
			return false
		}
	}
	return true
}

func incrementPlatformCounter(counters map[string]any, key string, delta int) {
	counters[key] = counterValue(counters, key) + delta
}

func platformCountersAsAny(counters map[string]int) map[string]any {
	result := make(map[string]any, len(counters))
	for key, value := range counters {
		result[key] = value
	}
	return result
}

func counterValue(counters map[string]any, key string) int {
	switch value := counters[key].(type) {
	case float64:
		return int(value)
	case int:
		return value
	default:
		return 0
	}
}

func validateFieldStates(states map[string]string, allowed map[string]bool) error {
	if len(states) > len(allowed) {
		return validation("field_states 包含过多字段")
	}
	for field, state := range states {
		if !allowed[field] {
			return validation("field_states 包含未登记字段")
		}
		switch state {
		case "present", "unsupported", "denied", "not_requested", "failed", "unknown":
		default:
			return validation("field_states 状态无效")
		}
	}
	return nil
}

func validPlatformText(value string, maxBytes int) bool {
	if len(value) > maxBytes || !utf8.ValidString(value) || strings.IndexByte(value, 0) >= 0 {
		return false
	}
	for _, r := range value {
		if r < 0x20 && r != '\n' && r != '\r' && r != '\t' {
			return false
		}
	}
	return true
}

func platformFieldLimit(field string) int {
	switch field {
	case "bio":
		return 4096
	case "public_account_id":
		return 512
	default:
		return 512
	}
}

func validPlatformExternalID(value string) bool {
	return len(value) > 0 && len(value) <= 512 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsRune(value, 0)
}

func validPlatformContentType(platform, value string) bool {
	switch platform {
	case "xhs":
		return value == "image_note" || value == "video_note"
	case "wechat_mp":
		return value == "wechat_article"
	default:
		return false
	}
}

func validPlatformContentState(value string) bool {
	switch value {
	case "complete", "partial", "unsupported", "denied", "failed":
		return true
	default:
		return false
	}
}

func validPlatformContentBlock(block platformV2ContentBlock, mediaCount int) bool {
	if !validPlatformText(block.Text, 1<<20) {
		return false
	}
	switch block.Type {
	case "paragraph", "heading", "quote":
		if block.MediaIndex != nil || (block.Type == "heading" && block.Level != 1 && block.Level != 2 && block.Level != 3) {
			return false
		}
	case "image", "video":
		if block.MediaIndex == nil || *block.MediaIndex < 0 || *block.MediaIndex >= mediaCount || block.Text != "" {
			return false
		}
	default:
		return false
	}
	return true
}

func validPlatformMediaRef(platform string, media platformV2MediaRef) bool {
	if !validPlatformPublicURL(platform, media.URL, true) || media.Position < 0 || media.Position >= 200 {
		return false
	}
	switch media.Kind {
	case "cover", "image", "video", "audio":
	default:
		return false
	}
	if media.Width < 0 || media.Width > 20000 || media.Height < 0 || media.Height > 20000 || media.DurationSeconds < 0 || media.DurationSeconds > 24*60*60 {
		return false
	}
	return true
}

func validPlatformPublicURL(platform, raw string, media bool) bool {
	if len(raw) == 0 || len(raw) > platformV2URLMax || strings.TrimSpace(raw) != raw {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	if u.RawQuery != "" {
		for _, part := range strings.Split(u.RawQuery, "&") {
			key, _, _ := strings.Cut(part, "=")
			if decoded, decodeErr := url.QueryUnescape(key); decodeErr != nil || platformSafeURLQueryKey.MatchString(decoded) {
				return false
			}
		}
	}
	host := strings.ToLower(u.Hostname())
	switch platform {
	case "xhs":
		if host == "creator.xiaohongshu.com" {
			return true
		}
		return media && (host == "xhscdn.com" || strings.HasSuffix(host, ".xhscdn.com"))
	case "wechat_mp":
		if host == "mp.weixin.qq.com" {
			return true
		}
		return media && (host == "mmbiz.qpic.cn" || host == "wx.qlogo.cn")
	default:
		return false
	}
}

func nullablePlatformText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func sameJSONStrings(raw []byte, values []string) bool {
	var existing []string
	if json.Unmarshal(raw, &existing) != nil || len(existing) != len(values) {
		return false
	}
	for i := range existing {
		if existing[i] != values[i] {
			return false
		}
	}
	return true
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func contentErrorFromFieldStates(states map[string]string) any {
	for _, key := range []string{"body_text", "body_structure", "media_refs"} {
		if state := states[key]; state == "failed" || state == "denied" || state == "unsupported" {
			return state
		}
	}
	return nil
}

func platformV2OperationStageError(data platformV2ControlResult) error {
	if data.Reason != "" && !platformSafeReasons[data.Reason] {
		return fmt.Errorf("unknown platform control reason")
	}
	return nil
}

func (s *Server) platformV2AuditTx(ctx context.Context, tx pgx.Tx, write platformV2WriteContext, resultType string, rows int) error {
	return s.auditTx(ctx, tx, "platform_sync_v2_result", "platform_sync_operation", write.OperationID.String(), "ok",
		map[string]any{"run_id": write.RunID, "stage": write.Stage, "result_type": resultType, "rows": rows,
			"adapter_version": write.AdapterVersion, "mapping_version": write.MappingVersion})
}
