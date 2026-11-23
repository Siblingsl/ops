package app

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

// REF41 A8-A2：四种状态下的成本计算；缺失价格不估算，模拟模型固定 0。
func TestA8AgentRunCostCalculation(t *testing.T) {
	i100 := int64(1000000)
	i200 := int64(2000000)
	zero := int64(0)
	neg := int64(-1)
	cases := []struct {
		name         string
		prompt       int
		completion   int
		input        *int64
		output       *int64
		simulated    bool
		currency     string
		want         *int64
		wantCurrency string
	}{
		{"priced", 1000, 500, &i100, &i200, false, "CNY", ptrInt64(2000000), "CNY"},
		{"missing input", 1000, 500, nil, &i200, false, "CNY", nil, "CNY"},
		{"missing output", 1000, 500, &i100, nil, false, "USD", nil, "USD"},
		{"zero prices", 1000, 500, &zero, &zero, false, "CNY", ptrInt64(0), "CNY"},
		{"negative prices treated unpriced", 1000, 500, &neg, &i100, false, "CNY", nil, "CNY"},
		{"simulated wins over missing price", 1000, 500, nil, nil, true, "", ptrInt64(0), "CNY"},
		{"rounding", 1, 0, ptrInt64(500), &zero, false, "CNY", ptrInt64(1), "CNY"},
		{"empty currency defaults CNY", 10, 10, &i100, &i100, false, "", ptrInt64(20000), "CNY"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, currency := agentRunCost(tc.prompt, tc.completion, tc.input, tc.output, tc.simulated, tc.currency)
			if tc.want == nil {
				if got != nil {
					t.Fatalf("cost = %d, want nil", *got)
				}
			} else if got == nil || *got != *tc.want {
				t.Fatalf("cost = %v, want %d", got, *tc.want)
			}
			if currency != tc.wantCurrency {
				t.Fatalf("currency = %q, want %q", currency, tc.wantCurrency)
			}
		})
	}
}

func ptrInt64(v int64) *int64 { return &v }

// REF41 A8-A2/A8-A4：run 结束时按当时价格落库；之后改价不回溯已有 run。
func TestA8RunCostPersistedAndHistoricalPriceStable(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	provider := env.ensureToolModel(t)
	providerID := uuid.MustParse(provider)
	if _, err := env.srv.db.Exec(ctx, `UPDATE model_provider SET input_price_micros_per_1k=1000000,
		output_price_micros_per_1k=2000000, price_currency='CNY', simulated=false WHERE id=$1`, providerID); err != nil {
		t.Fatal(err)
	}
	defer env.srv.db.Exec(context.Background(), `UPDATE model_provider SET input_price_micros_per_1k=NULL,
		output_price_micros_per_1k=NULL, price_currency='CNY', simulated=false WHERE id=$1`, providerID)

	st.Model = agentModelRef{ProviderID: providerID, Model: "mock-writer"}
	st.PromptTokens, st.CompletionTokens = 1000, 500
	env.srv.finishAgentRun(ctx, st, "completed", "", nil)
	var first *int64
	var currency string
	if err := env.srv.db.QueryRow(ctx, `SELECT cost_micros, cost_currency FROM agent_run WHERE id=$1`, st.RunID).
		Scan(&first, &currency); err != nil {
		t.Fatal(err)
	}
	if first == nil || *first != 2000000 || currency != "CNY" {
		t.Fatalf("first run cost=%v currency=%s, want 2000000 CNY", first, currency)
	}

	// 改价后旧 run 不变；新 run 用新价。
	if _, err := env.srv.db.Exec(ctx, `UPDATE model_provider SET input_price_micros_per_1k=2000000,
		output_price_micros_per_1k=2000000 WHERE id=$1`, providerID); err != nil {
		t.Fatal(err)
	}
	var firstAfter *int64
	if err := env.srv.db.QueryRow(ctx, `SELECT cost_micros FROM agent_run WHERE id=$1`, st.RunID).Scan(&firstAfter); err != nil {
		t.Fatal(err)
	}
	if firstAfter == nil || *firstAfter != 2000000 {
		t.Fatalf("historical run cost changed: %v", firstAfter)
	}

	st2 := *st
	st2.RunID = agentInsertRun(t, st.ConversationID, st.WorkspaceID, st.UserID, providerID, "running", "message")
	st2.PromptTokens, st2.CompletionTokens = 1000, 500
	env.srv.finishAgentRun(ctx, &st2, "completed", "", nil)
	var second *int64
	if err := env.srv.db.QueryRow(ctx, `SELECT cost_micros FROM agent_run WHERE id=$1`, st2.RunID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if second == nil || *second != 3000000 {
		t.Fatalf("second run cost=%v, want 3000000", second)
	}
}

// REF41 A8-A5：按币种汇总、未定价计数；不把不同币种直接相加。
func TestA8AgentCostUsageSummarizesCurrenciesAndUnpriced(t *testing.T) {
	ctx, st := aw06ToolRun(t)
	model := "a8-cost-model-" + uuid.NewString()
	for _, run := range []struct {
		currency string
		cost     *int64
		started  time.Time
	}{
		{"CNY", ptrInt64(100000), time.Now().Add(-2 * time.Hour)},
		{"USD", ptrInt64(200000), time.Now().Add(-time.Hour)},
		{"CNY", nil, time.Now().Add(-30 * time.Minute)},
	} {
		id := agentInsertRun(t, st.ConversationID, st.WorkspaceID, st.UserID, uuid.Nil, "completed", "message")
		if _, err := env.srv.db.Exec(ctx, `UPDATE agent_run SET status='completed', model=$2,
			prompt_tokens=100, completion_tokens=50, cost_micros=$3, cost_currency=$4, started_at=$5
			WHERE id=$1`, id, model, run.cost, run.currency, run.started); err != nil {
			t.Fatal(err)
		}
	}
	// 让 A8 用例的最后一个 priced run 成为 last_run；aw06 的原始 run 保持未定价。
	if _, err := env.srv.db.Exec(ctx, `UPDATE agent_run SET model=$2, status='completed',
		prompt_tokens=200, completion_tokens=100, cost_micros=300000, cost_currency='CNY',
		started_at=$3 WHERE id=$1`, st.RunID, model, time.Now()); err != nil {
		t.Fatal(err)
	}

	var resp struct {
		Rows         []agentCostRow           `json:"rows"`
		Runs         int                      `json:"runs"`
		PromptTokens int64                    `json:"prompt_tokens"`
		Completion   int64                    `json:"completion_tokens"`
		CostMicros   *int64                   `json:"cost_micros"`
		Currency     string                   `json:"currency"`
		Unpriced     int                      `json:"unpriced_runs"`
		Currencies   []agentCostCurrencyTotal `json:"currencies"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/usage/agent-cost?group_by=day&model="+model, nil, &resp)
	if resp.Runs != 4 || resp.Unpriced != 1 {
		t.Fatalf("runs=%d unpriced=%d, want 4/1", resp.Runs, resp.Unpriced)
	}
	if resp.Currency != "MIXED" || resp.CostMicros != nil {
		t.Fatalf("mixed currency must not expose scalar cost: currency=%s cost=%v", resp.Currency, resp.CostMicros)
	}
	if len(resp.Currencies) != 2 {
		t.Fatalf("currencies=%d, want 2", len(resp.Currencies))
	}
	for _, c := range resp.Currencies {
		switch c.Currency {
		case "CNY":
			if c.CostMicros == nil || *c.CostMicros != 400000 {
				t.Fatalf("CNY cost=%v, want 400000", c.CostMicros)
			}
		case "USD":
			if c.CostMicros == nil || *c.CostMicros != 200000 || c.UnpricedRuns != 0 {
				t.Fatalf("USD cost=%v unpriced=%d", c.CostMicros, c.UnpricedRuns)
			}
		default:
			t.Fatalf("unexpected currency %s", c.Currency)
		}
	}

	var detail struct {
		LastRun *agentActiveRun `json:"last_run"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+st.ConversationID.String(), nil, &detail)
	if detail.LastRun == nil || detail.LastRun.CostMicros == nil || *detail.LastRun.CostMicros != 300000 ||
		detail.LastRun.CostCurrency != "CNY" || detail.LastRun.PromptTokens != 200 {
		t.Fatalf("last_run cost fields not exposed: %+v", detail.LastRun)
	}

	var runCost struct {
		CostMicros *int64 `json:"cost_micros"`
		Unpriced   bool   `json:"unpriced"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent-runs/"+st.RunID.String()+"/cost", nil, &runCost)
	if runCost.CostMicros == nil || *runCost.CostMicros != 300000 || runCost.Unpriced {
		t.Fatalf("run cost endpoint: %+v", runCost)
	}
}

// REF41 A8-A1：provider 新价格字段可通过 API 创建与更新。
func TestA8ProviderPriceFieldsPersist(t *testing.T) {
	var created struct {
		Provider
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/model-providers", map[string]any{
		"name": "A8 价格字段验证 " + uuid.NewString(), "base_url": "http://127.0.0.1:8091/v1",
		"api_key": "local-e2e-key", "models": []string{"mock-writer"},
		"input_price_micros_per_1k": 500000, "output_price_micros_per_1k": 750000, "price_currency": "usd",
	}, &created)
	defer env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE id=$1`, created.ID)
	if created.InputPriceMicros == nil || *created.InputPriceMicros != 500000 ||
		created.OutputPriceMicros == nil || *created.OutputPriceMicros != 750000 ||
		created.PriceCurrency != "USD" {
		t.Fatalf("created provider price fields: %+v", created.Provider)
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/model-providers/"+created.ID.String(), map[string]any{
		"input_price_micros_per_1k": 250000, "price_currency": "CNY",
	}, &created)
	if created.InputPriceMicros == nil || *created.InputPriceMicros != 250000 || created.PriceCurrency != "CNY" {
		t.Fatalf("updated provider price fields: %+v", created.Provider)
	}
}
