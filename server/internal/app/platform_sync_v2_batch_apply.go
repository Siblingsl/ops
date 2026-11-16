package app

import (
	"context"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-S04 片1：从 submitPlatformV2ResultBatchTx 抽出「形状校验」与「按类型写入」。
// 行为与拆分前逐字节等价；编排仍在 submitPlatformV2ResultBatchTx。
func validatePlatformV2ResultBatchShape(batch platformResultBatch, write platformV2WriteContext) error {
	if batch.ProtocolVersion != 2 || write.OperationID == uuid.Nil || batch.ResultType == "" || len(batch.Data) == 0 {
		return validation("v2 批次必须包含协议版本、operation 和类型化 data")
	}
	if batch.Coverage != nil || len(batch.Observations) != 0 {
		return validation("v2 结果只能使用 result_type/data，不能混用 v1 observations/coverage")
	}
	if err := checkPlatformJSONDepth(batch.Data, 16); err != nil {
		return validation("v2 结果嵌套超过上限")
	}
	maxBatchBytes, _ := platformV2BatchLimits(batch.ResultType)
	if maxBatchBytes == 0 {
		return validation("result_type 不受支持")
	}
	if write.RawBytes > maxBatchBytes {
		return apiErr(http.StatusRequestEntityTooLarge, "platform_result_too_large", "该类型的批次超过大小上限")
	}
	if batch.FinalBatch != (batch.ResultType == "control") {
		return validation("只有 control 批次可以结束 v2 run")
	}
	if !batch.FinalBatch && batch.RunStatus != platformRunStatusSuccess {
		return validation("非终批的 run_status 必须为 succeeded")
	}
	if batch.FinalBatch && batch.RunStatus != platformRunStatusSuccess && batch.RunStatus != platformRunStatusPartial &&
		batch.RunStatus != platformRunStatusFailed && batch.RunStatus != platformRunStatusCanceled {
		return validation("终批 run_status 无效")
	}
	if batch.ErrorCode != nil && !validPlatformResultError(*batch.ErrorCode) {
		return validation("error_code 不在固定错误目录中")
	}
	return nil
}

func (s *Server) applyPlatformV2ResultDataTx(ctx context.Context, tx pgx.Tx, batch platformResultBatch, write platformV2WriteContext,
	receipt *platformReceipt, counters, coverage, checkpoint map[string]any) error {
	switch batch.ResultType {
	case "account_snapshot":
		var data platformV2AccountSnapshot
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return err
		}
		if err := s.writePlatformAccountSnapshotTx(ctx, tx, write, data); err != nil {
			return err
		}
		incrementPlatformCounter(counters, "changed", 1)
		receipt.Accepted = 1
		receipt.Rows = append(receipt.Rows, map[string]any{"row_no": 0, "state": "accepted"})
	case "work_catalog":
		var data platformV2CatalogResult
		if err := decodePlatformV2Data(batch.Data, &data); err != nil {
			return err
		}
		if len(data.Items) > platformV2AccountBatchRows {
			return validation("work_catalog 单批最多 25 条")
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
				return err
			}
			created, changed, skipped, err := s.writePlatformCatalogItemTx(ctx, tx, write, item)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return err
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
					return apiErr(409, "platform_result_conflict", "目录 inline_metrics 必须归属同一作品和账号")
				}
				row.RowNo = len(data.Items) + index*platformV2MetricBatchRows + metricIndex
				if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
					return err
				}
				write.AllowCatalogInlineMetric = true
				added, pending, adopted, err := s.writePlatformV2MetricTx(ctx, tx, write, row, batch.BatchSeq)
				write.AllowCatalogInlineMetric = false
				if err != nil {
					if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
						return rollbackErr
					}
					if isPlatformV2RowValidation(err) {
						receipt.Rejected++
						incrementPlatformCounter(counters, "failed", 1)
						rowNo := len(data.Items) + index*platformV2MetricBatchRows + metricIndex
						receipt.Rows = append(receipt.Rows, map[string]any{"row_no": rowNo, "state": "rejected", "error_code": "invalid_metric"})
						continue
					}
					return err
				}
				if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
					return err
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
			return err
		}
		if len(data.Items) > platformV2ContentBatchRows {
			return validation("work_content 单批最多 10 条")
		}
		for index, item := range data.Items {
			if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
				return err
			}
			received, state, err := s.writePlatformContentItemTx(ctx, tx, write, item)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return err
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
			return err
		}
		if len(data.Observations) > platformV2MetricBatchRows {
			return validation("metrics 单批最多 25 条")
		}
		for index, row := range data.Observations {
			row.RowNo = index
			if _, err := tx.Exec(ctx, `SAVEPOINT platform_v2_row`); err != nil {
				return err
			}
			added, pending, adopted, err := s.writePlatformV2MetricTx(ctx, tx, write, row, batch.BatchSeq)
			if err != nil {
				if rollbackErr := rollbackPlatformV2Row(ctx, tx); rollbackErr != nil {
					return rollbackErr
				}
				if isPlatformV2RowValidation(err) {
					receipt.Rejected++
					incrementPlatformCounter(counters, "failed", 1)
					receipt.Rows = append(receipt.Rows, map[string]any{"row_no": index, "state": "rejected", "error_code": "invalid_row"})
					continue
				}
				return err
			}
			if _, err := tx.Exec(ctx, `RELEASE SAVEPOINT platform_v2_row`); err != nil {
				return err
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
			return err
		}
		if err := validatePlatformV2Control(data); err != nil {
			return err
		}
		if err := s.finishPlatformV2StageTx(ctx, tx, write, data, counters, coverage, checkpoint, batch, receipt); err != nil {
			return err
		}
	}
	return nil
}
