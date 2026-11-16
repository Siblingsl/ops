package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-S04 片1：v1 观测写入与终批结算从 submitPlatformResults 抽出。
// v2 路径仍由 submitPlatformResults 适配到 submitPlatformV2ResultBatchTx。
func (s *Server) submitPlatformV1ResultBatchTx(ctx context.Context, tx pgx.Tx,
	runID, connID, runWorkspace, runAcct uuid.UUID, platform string, autoAdopt bool, status string,
	existingResultRows int, existingResultBytes int64, existing []map[string]any, hash string,
	rawBody []byte, batch platformResultBatch) (platformReceipt, error) {
	if len(rawBody) > desktopPlatformV1ResultsBytes || existingResultRows+len(batch.Observations) > platformRunMaxRows ||
		existingResultBytes+int64(len(rawBody)) > int64(platformRunMaxBytes) {
		return platformReceipt{}, apiErr(http.StatusRequestEntityTooLarge, "platform_result_budget_exceeded", "本次 run 的指标结果超过行数或字节上限")
	}
	if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET budget_result_rows=budget_result_rows+$2,
		budget_result_bytes=budget_result_bytes+$3 WHERE id=$1`, runID, len(batch.Observations), len(rawBody)); err != nil {
		return platformReceipt{}, err
	}

	receipt := platformReceipt{BatchSeq: batch.BatchSeq, ReceiptID: uuid.New(), Rows: []map[string]any{}}
	// 记录第一条自动采用失败的原因，随回执回给客户端便于定位（不写观测内容）。
	// 失败条数单独计数：回执里的数量要能对上"有几条没入库"，不能恒为 1。
	var adoptFirstError error
	adoptFailures := 0
	for index, row := range batch.Observations {
		if row.RowNo != index {
			return platformReceipt{}, validation("观测 row_no 必须与数组位置一致")
		}
		scope := row.Scope
		matchState := observationMatchNotApplicable
		if scope == observationScopeWork {
			state, targetErr := s.checkRunTarget(ctx, tx, runID, row)
			if targetErr != nil {
				return platformReceipt{}, targetErr
			}
			matchState = state
			// 回填真实发布时间：`metric_day_offset` 靠它算节点天数。
			// 只在作品当前没有可信发布时间时才写，绝不覆盖用户手填的值。
			if row.PlatformPublishedAt != nil && row.ExternalID != nil {
				if err := backfillPublishedAt(ctx, tx, runAcct, platform, *row.ExternalID, *row.PlatformPublishedAt); err != nil {
					return platformReceipt{}, err
				}
			}
		}
		in := platformObservationInput{
			RunID: &runID, BatchSeq: &batch.BatchSeq, RowNo: &row.RowNo,
			WorkspaceID: runWorkspace, AccountID: runAcct, ExternalAccountKey: row.ExternalAccountKey,
			ExternalID: row.ExternalID, Scope: scope, Source: row.Source, TemporalKind: row.TemporalKind,
			ObservedAt: row.ObservedAt, AsOfAt: row.AsOfAt, WindowStart: row.WindowStart, WindowEnd: row.WindowEnd,
			Values: row.Values, FieldPaths: row.FieldPaths, AdapterVersion: row.AdapterVersion,
			MappingVersion: row.MappingVersion,
			// 不在这里指定 QualityState：由 insertPlatformObservation 按 §9.2 默认置
			// `needs_confirmation`。采集入站的观测是"待用户确认"的，不是已生效的读数。
			// 早期这里写死 `valid`，导致前端"确认这一条"按钮永远不显示。
			MatchState: matchState,
		}
		obsID, dup, err := insertPlatformObservation(ctx, tx, in)
		if err != nil {
			return platformReceipt{}, err
		}
		if dup {
			receipt.Duplicate++
			receipt.Rows = append(receipt.Rows, map[string]any{"row_no": row.RowNo, "state": "duplicate", "observation_id": obsID})
			continue
		}
		// auto_adopt 开启时立即投影为正式指标；关闭时只写观测，等用户逐条确认。
		//
		// 复用 confirmObservationTx 而**不是**另写一套：那是同一份校验
		// （质量状态、绑定、单位、精度、修订、superseded 替代），
		// 两侧共用才不会出现"手动确认能过、自动投影放过"的口径漂移。
		//
		// 必须用 savepoint 隔离：`confirmObservationTx` 里的校验失败可能伴随
		// **数据库错误**（唯一约束冲突等），届时整个事务进入 aborted 状态，
		// 后续语句全部失败——一条投影失败会让整批观测连同回执一起丢掉。
		// savepoint 只回滚这一条的投影副作用，观测行保持。
		rowState := "accepted"
		if autoAdopt {
			if adoptErr := s.adoptInSavepoint(ctx, tx, obsID, runWorkspace); adoptErr != nil {
				rowState = "adopted_failed"
				// 诊断：只记错误码与首行消息，不记观测内容。
				slog.Warn("平台采集：自动采用失败", "observation_id", obsID, "err", adoptErr)
				adoptFailures++
				adoptFirstError = adoptErr
			} else {
				rowState = "adopted"
			}
		}
		receipt.Accepted++
		receipt.Rows = append(receipt.Rows, map[string]any{
			"row_no": row.RowNo, "state": rowState, "observation_id": obsID,
		})
	}
	// 自动采用若有失败，把第一条原因放进回执：客户端能展示"采到了但没入库"，
	// 否则用户只看到 accepted，以为一切正常。条数按实际失败数累加，不是恒为 1。
	if adoptFailures > 0 {
		receipt.AdoptErrors = adoptFailures
		reason := adoptFirstError.Error()
		if adoptFailures > 1 {
			reason = fmt.Sprintf("%s（共 %d 条失败，其余见服务端日志）", reason, adoptFailures)
		}
		receipt.AdoptReason = reason
	}

	nextStatus := status
	if batch.FinalBatch {
		switch batch.RunStatus {
		case platformRunStatusSuccess:
			nextStatus = platformRunStatusSuccess
		case platformRunStatusPartial:
			nextStatus = platformRunStatusPartial
		case platformRunStatusFailed:
			nextStatus = platformRunStatusFailed
		case platformRunStatusCanceled:
			nextStatus = platformRunStatusCanceled
		default:
			return platformReceipt{}, validation("run_status 只能是 succeeded/partial/failed/canceled")
		}
		// stop_reason 必须先过枚举校验：适配器的"覆盖不完整原因"（page_repeated、
		// page_budget、collect_failed…）不在 CHECK 允许值内，直接写库会让整个终批
		// 事务回滚（观测全丢、run 卡住）。原始值转存 counters，供排查时对照。
		rawStopReason := ""
		if batch.StopReason != nil {
			rawStopReason = *batch.StopReason
		}
		stopReason := platformStopReason(batch.StopReason)
		if rawStopReason != "" && stopReason == nil {
			slog.Warn("平台采集：客户端上报的停止原因不在登记枚举内，按空值存库",
				"run_id", runID, "stop_reason", rawStopReason)
		}
		// coverage 是客户端对"读了多少、还剩多少、为什么停"的自述（20 文档 §11.3
		// 要求 partial 必须给出覆盖范围）。此前这个字段被解析后**完全丢弃**：服务端
		// 不落库、界面拿不到，于是 page_repeated / page_budget 这类真实原因只存在
		// 于客户端日志里，用户只看到"partial"而不知道为什么不完整（2026-10-22 实测：
		// 验收号 run 状态 partial，但库里查不到任何覆盖信息）。
		// 因此这里原样写进 counters.coverage，与 stop_reason_raw 同等对待。
		coverageJSON := ""
		if len(batch.Coverage) > 0 {
			if raw, err := json.Marshal(batch.Coverage); err == nil {
				coverageJSON = string(raw)
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status=$2, stop_reason=$3, error_code=$4,
			counters=CASE WHEN $5::text='' THEN counters
				ELSE counters || jsonb_build_object('stop_reason_raw',$5::text) END
				|| CASE WHEN $6::text='' THEN '{}'::jsonb
				ELSE jsonb_build_object('coverage',$6::jsonb) END,
			finished_at=now() WHERE id=$1`,
			runID, nextStatus, stopReason, batch.ErrorCode, rawStopReason, coverageJSON); err != nil {
			return platformReceipt{}, err
		}
		// run 终态按 §10.1.1 更新连接：成功清零，失败顺延冷却并累计失败次数。
		if nextStatus == platformRunStatusSuccess || nextStatus == platformRunStatusPartial {
			if _, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=0, cooldown_until=NULL,
				next_due_at=now() + interval '1 day', updated_at=now() WHERE id=$1`, connID); err != nil {
				return platformReceipt{}, err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE platform_connection SET failure_count=failure_count+1,
				cooldown_until=now() + interval '5 minutes', updated_at=now() WHERE id=$1`, connID); err != nil {
				return platformReceipt{}, err
			}
		}
		if err := s.applyRunFailureAction(ctx, tx, connID, batch.ErrorCode); err != nil {
			return platformReceipt{}, err
		}
	} else {
		_, err := tx.Exec(ctx, `UPDATE platform_sync_run SET status='running', lease_expires_at=now() + $2
			WHERE id=$1`, runID, platformLeaseTTL)
		if err != nil {
			return platformReceipt{}, err
		}
	}
	receipt.RunStatus = nextStatus

	entry := platformReceiptEntry(receipt, hash)
	existing = append(existing, entry)
	updated, err := json.Marshal(existing)
	if err != nil {
		return platformReceipt{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE platform_sync_run SET batch_receipts=$2 WHERE id=$1`, runID, updated); err != nil {
		return platformReceipt{}, err
	}
	return receipt, nil
}
