package app

// REF41 A8：单 run 成本账的 HTTP 接口。
//
// GET /usage/agent-cost 按工作区与时间范围汇总 agent_run 的 token 与成本；
// GET /agent-runs/{id}/cost 返回单 run 的 token 与成本。金额按币种分开汇总，
// 不把 CNY 与 USD 直接相加；未定价 run 以 unpriced_runs 计数返回。

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type agentCostRow struct {
	Key              string `json:"key"`
	Currency         string `json:"currency"`
	Runs             int    `json:"runs"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CostMicros       *int64 `json:"cost_micros"`
	UnpricedRuns     int    `json:"unpriced_runs"`
}

type agentCostCurrencyTotal struct {
	Currency         string `json:"currency"`
	Runs             int    `json:"runs"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	CostMicros       *int64 `json:"cost_micros"`
	UnpricedRuns     int    `json:"unpriced_runs"`
}

func addMicros(dst **int64, value *int64) {
	if value == nil {
		return
	}
	if *dst == nil {
		zero := int64(0)
		*dst = &zero
	}
	**dst = **dst + *value
}

func (s *Server) agentCostUsage(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	to := s.today().AddDate(0, 0, 1)
	from := to.AddDate(0, 0, -30)
	if raw := q.Get("from"); raw != "" {
		v, err := time.ParseInLocation("2006-01-02", raw, s.loc)
		if err != nil {
			return validation("from 日期格式应为 YYYY-MM-DD")
		}
		from = v
	}
	if raw := q.Get("to"); raw != "" {
		v, err := time.ParseInLocation("2006-01-02", raw, s.loc)
		if err != nil {
			return validation("to 日期格式应为 YYYY-MM-DD")
		}
		to = v.AddDate(0, 0, 1)
	}
	if !to.After(from) {
		return validation("to 不能早于 from")
	}
	groups := map[string]string{
		"day":       `to_char(r.started_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`,
		"model":     `coalesce(p.name, '（未知供应商）') || ' / ' || r.model`,
		"origin":    `r.execution_origin`,
		"role":      `coalesce(nullif(r.config_snapshot->>'role', ''), '未知角色')`,
		"workspace": `r.workspace_id::text`,
		"run":       `r.id::text`,
	}
	g := q.Get("group_by")
	if g == "" {
		g = "day"
	}
	expr, okG := groups[g]
	if !okG {
		return validation("group_by 只支持 day、model、origin、role、workspace、run")
	}

	role := q.Get("role")
	if role == "" {
		role = q.Get("role_id")
	}
	where := `r.workspace_id=$1 AND r.started_at >= $2 AND r.started_at < $3`
	args := []any{ident(r.Context()).WorkspaceID, from, to}
	if role != "" {
		args = append(args, role)
		where += ` AND coalesce(nullif(r.config_snapshot->>'role', ''), '未知角色')=$4`
	}
	if model := q.Get("model"); model != "" {
		args = append(args, model)
		where += ` AND r.model=$` + strconv.Itoa(len(args))
	}
	if origin := q.Get("origin"); origin != "" {
		args = append(args, origin)
		where += ` AND r.execution_origin=$` + strconv.Itoa(len(args))
	}

	rows, err := s.db.Query(r.Context(), `SELECT `+expr+` AS k, r.cost_currency, count(*),
		coalesce(sum(r.prompt_tokens),0), coalesce(sum(r.completion_tokens),0),
		sum(r.cost_micros)::bigint, count(*) FILTER (WHERE r.cost_micros IS NULL)
		FROM agent_run r LEFT JOIN model_provider p ON p.id=r.model_provider_id
		WHERE `+where+`
		GROUP BY k, r.cost_currency ORDER BY k, r.cost_currency`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	list := []agentCostRow{}
	byCurrency := map[string]*agentCostCurrencyTotal{}
	var totalRuns int
	var totalPrompt, totalCompletion int64
	var totalUnpriced int
	for rows.Next() {
		var x agentCostRow
		if err := rows.Scan(&x.Key, &x.Currency, &x.Runs, &x.PromptTokens, &x.CompletionTokens,
			&x.CostMicros, &x.UnpricedRuns); err != nil {
			return err
		}
		if g == "run" && len(x.Key) > 8 {
			// 表格用短 ID 展示；完整 ID 仍在单 run 接口可取。
			x.Key = x.Key[:8]
		}
		list = append(list, x)
		totalRuns += x.Runs
		totalPrompt += x.PromptTokens
		totalCompletion += x.CompletionTokens
		totalUnpriced += x.UnpricedRuns
		curr := byCurrency[x.Currency]
		if curr == nil {
			curr = &agentCostCurrencyTotal{Currency: x.Currency}
			byCurrency[x.Currency] = curr
		}
		curr.Runs += x.Runs
		curr.PromptTokens += x.PromptTokens
		curr.CompletionTokens += x.CompletionTokens
		curr.UnpricedRuns += x.UnpricedRuns
		addMicros(&curr.CostMicros, x.CostMicros)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	currencies := make([]agentCostCurrencyTotal, 0, len(byCurrency))
	keys := make([]string, 0, len(byCurrency))
	for k := range byCurrency {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		currencies = append(currencies, *byCurrency[k])
	}
	currency := "CNY"
	var totalCost *int64
	switch len(currencies) {
	case 0:
		// 无运行时保留 CNY，金额为 null；前端显示“未配置价格”而不是 0。
	case 1:
		currency = currencies[0].Currency
		totalCost = currencies[0].CostMicros
	default:
		currency = "MIXED"
	}
	return ok(w, map[string]any{
		"rows":              list,
		"runs":              totalRuns,
		"prompt_tokens":     totalPrompt,
		"completion_tokens": totalCompletion,
		"cost_micros":       totalCost,
		"currency":          currency,
		"unpriced_runs":     totalUnpriced,
		"currencies":        currencies,
		"group_by":          g,
		"from":              from.Format("2006-01-02"),
		"to":                to.AddDate(0, 0, -1).Format("2006-01-02"),
	})
}

func (s *Server) getAgentRunCost(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var prompt, completion int
	var cost *int64
	var currency, status, model string
	var startedAt time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT prompt_tokens, completion_tokens, cost_micros, cost_currency,
		status, model, started_at FROM agent_run WHERE id=$1 AND workspace_id=$2`,
		id, ident(r.Context()).WorkspaceID).Scan(&prompt, &completion, &cost, &currency, &status, &model, &startedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	return ok(w, map[string]any{
		"id":                id.String(),
		"prompt_tokens":     prompt,
		"completion_tokens": completion,
		"cost_micros":       cost,
		"currency":          currency,
		"unpriced":          cost == nil,
		"status":            status,
		"model":             model,
		"started_at":        startedAt,
	})
}
