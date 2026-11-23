package app

// REF41 A8：单 run 成本账。
//
// 价格以“微分（micros）/ 千 token”存储：1 元 = 1,000,000 micros。
// 成本只在 run 结束时按当时 provider 价格计算并写入 agent_run.cost_micros；
// 历史 run 不回溯。价格缺失时写 NULL，不用 0 代替“未定价”；模拟模型固定 0。
// 成本字段只用于展示与汇总，不参与 run 状态、预算闸门或失败判定。

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// agentRunCost 计算一次 run 的成本（micros）。任一单价缺失即为未定价（nil）；
// 模拟模型即使没有价格也返回 0。币种跟随 provider；空值回退 CNY。
func agentRunCost(promptTokens, completionTokens int, inputPriceMicros, outputPriceMicros *int64,
	simulated bool, currency string) (*int64, string) {
	curr := normalizePriceCurrency(currency)
	if simulated {
		zero := int64(0)
		return &zero, curr
	}
	if inputPriceMicros == nil || outputPriceMicros == nil ||
		*inputPriceMicros < 0 || *outputPriceMicros < 0 {
		return nil, curr
	}
	if promptTokens < 0 {
		promptTokens = 0
	}
	if completionTokens < 0 {
		completionTokens = 0
	}
	micros := int64(math.Round(
		float64(promptTokens)*float64(*inputPriceMicros)/1000 +
			float64(completionTokens)*float64(*outputPriceMicros)/1000,
	))
	if micros < 0 {
		micros = 0
	}
	return &micros, curr
}

func normalizePriceCurrency(currency string) string {
	curr := strings.ToUpper(strings.TrimSpace(currency))
	if curr == "" {
		return "CNY"
	}
	return curr
}

// agentRunCostForRunTx 读取 provider 当前价格并计算成本。查不到 provider 或
// 读取失败时不阻断 run 收尾，按未定价返回，并留下可观测日志。
func (s *Server) agentRunCostForRunTx(ctx context.Context, tx pgx.Tx, st *agentRunState) (*int64, string) {
	providerID := st.Model.ProviderID
	if st.RuntimeModel != nil && st.RuntimeModel.ProviderID != uuid.Nil {
		providerID = st.RuntimeModel.ProviderID
	}
	if providerID == uuid.Nil {
		return nil, "CNY"
	}
	var input, output *int64
	var currency string
	var simulated bool
	err := tx.QueryRow(ctx, `SELECT input_price_micros_per_1k, output_price_micros_per_1k, price_currency, simulated
		FROM model_provider WHERE id=$1 AND workspace_id=$2`, providerID, st.WorkspaceID).
		Scan(&input, &output, &currency, &simulated)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.WarnContext(ctx, "agent run cost provider lookup failed", "run_id", st.RunID, "error", err)
		}
		return nil, "CNY"
	}
	return agentRunCost(st.PromptTokens, st.CompletionTokens, input, output, simulated, currency)
}
