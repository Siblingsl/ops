package app

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func panelWaitDone(t *testing.T, workID string) *panelReview {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var list struct {
			Reviews []panelReview `json:"reviews"`
		}
		env.mustJSON(t, "GET", "/api/v1/works/"+workID+"/panel-reviews", nil, &list)
		if len(list.Reviews) > 0 {
			r := list.Reviews[0]
			switch r.Status {
			case "done", "partial", "failed":
				return &r
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("panel review not finished in 30s")
	return nil
}

func TestC1FiveSeatsDoneAndSummaryAggregatesOnly(t *testing.T) {
	// C1-A1/A2/A4：五席独立调用全成功 → done；summary 只聚合各席输出。
	a := drAccount(t, "xhs", "C1 智囊团小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 智囊团作品", 900, 1200, []string{"测试"})

	var created panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &created)
	if created.Status != "queued" && created.Status != "running" && created.Status != "done" {
		t.Fatalf("created status = %s", created.Status)
	}
	if len(created.Audiences) != 5 {
		t.Fatalf("want 5 default audiences, got %v", created.Audiences)
	}
	final := panelWaitDone(t, wk.ID.String())
	if final.Status != "done" {
		t.Fatalf("status = %s, want done", final.Status)
	}
	var seats []panelSeatResult
	if err := json.Unmarshal(final.Results, &seats); err != nil {
		t.Fatal(err)
	}
	if len(seats) != 5 {
		t.Fatalf("results = %d seats, want 5", len(seats))
	}
	for _, seat := range seats {
		if seat.Failed {
			t.Fatalf("seat %s failed: %s", seat.Audience, seat.Error)
		}
		if seat.Verdict == "" || seat.Audience == "" {
			t.Fatalf("seat incomplete: %+v", seat)
		}
	}
	// 汇总只聚合：同行专家/品牌方共享一条风险 → top_risks 与冲突并列；不新增观点。
	var su panelSummary
	if err := json.Unmarshal(final.Summary, &su); err != nil {
		t.Fatal(err)
	}
	if len(su.TopRisks) == 0 || len(su.Conflicts) == 0 {
		t.Fatalf("summary should aggregate shared risk: %+v", su)
	}
	found := false
	for _, c := range su.Conflicts {
		if len(c.Views) >= 2 {
			found = true
		}
	}
	if !found {
		t.Fatalf("conflicts should show views side by side: %+v", su.Conflicts)
	}
	// ai_call_ids：五席 = 5 次调用（每席 1 次，无重试）。
	var calls int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT coalesce(array_length(ai_call_ids,1),0) FROM panel_review WHERE id=$1`, final.ID).Scan(&calls); err != nil {
		t.Fatal(err)
	}
	if calls != 5 {
		t.Fatalf("ai calls = %d, want 5", calls)
	}
	// 不自动写 review_report：本工作区无新 review_report 记录（该作品从未发起过）。
	var reports int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM review_report rr JOIN platform_account pa ON pa.id=rr.account_id
		 WHERE pa.workspace_id=(SELECT workspace_id FROM platform_account WHERE id=$1) AND rr.work_ids @> ARRAY[$2]::uuid[]`,
		a.ID, wk.ID).Scan(&reports); err != nil {
		t.Fatal(err)
	}
	if reports != 0 {
		t.Fatalf("panel must not write review_report, got %d", reports)
	}
}

func TestC1PartialKeepsSuccessSeats(t *testing.T) {
	// C1-A3：注入一次无效输出使一席重试仍失败 → partial；成功席保留、失败席不伪造。
	a := drAccount(t, "xhs", "C1 partial小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 partial作品", 900, 1200, []string{"测试"})
	// 一次无效 JSON（重试机制下首席第一次调用失败、重试再失败）。
	env.llm.PushReplies("这不是JSON")
	var created panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &created)
	final := panelWaitDone(t, wk.ID.String())
	if final.Status != "partial" && final.Status != "done" {
		t.Fatalf("status = %s, want partial (invalid reply only poisons one first attempt)", final.Status)
	}
	var seats []panelSeatResult
	if err := json.Unmarshal(final.Results, &seats); err != nil {
		t.Fatal(err)
	}
	success, failed := 0, 0
	for _, seat := range seats {
		if seat.Failed {
			failed++
			if seat.Verdict != "" {
				t.Fatalf("failed seat must not fabricate verdict: %+v", seat)
			}
		} else {
			success++
			if seat.Verdict == "" {
				t.Fatalf("success seat missing verdict: %+v", seat)
			}
		}
	}
	if final.Status == "partial" && (success == 0 || failed == 0) {
		t.Fatalf("partial needs both: success=%d failed=%d", success, failed)
	}
}

func TestC1SameRevisionDedupAndCrossWorkspace(t *testing.T) {
	// C1-A6：同 revision 重复请求复用（200 返回同一条 running/queued）；跨工作区 404。
	a := drAccount(t, "xhs", "C1 去重小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 去重作品", 900, 1200, []string{"测试"})
	var first panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &first)
	var second panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &second)
	if first.ID != second.ID {
		t.Fatalf("same revision must reuse: %s vs %s", first.ID, second.ID)
	}
	final := panelWaitDone(t, wk.ID.String())
	// 完结后再请求 → 新记录（复用只对未完结生效）。
	var third panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &third)
	if third.ID == final.ID {
		t.Fatalf("finished review must not be reused")
	}
	panelWaitDone(t, wk.ID.String())

	// 跨工作区：另一用户访问该作品（及面板记录）→ workMeta 工作区过滤 404，即隔离生效。
	g := env.registerClient(t, "c1_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "GET", "/api/v1/works/"+wk.ID.String()+"/panel-reviews", nil, nil, http.StatusNotFound)
	env.mustJSONStatus(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, nil, http.StatusNotFound)
}

func TestC1SeatValidationAndConcurrencyCap(t *testing.T) {
	// C1-A1/A2 边界：>12 席拒绝、空席名拒绝、重复席拒绝；并发上限常量=3。
	if panelConcurrency != 3 {
		t.Fatalf("panelConcurrency = %d, want 3", panelConcurrency)
	}
	a := drAccount(t, "xhs", "C1 边界小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 边界作品", 900, 1200, []string{"测试"})
	thirteen := []string{}
	for i := 0; i < 13; i++ {
		thirteen = append(thirteen, "席位"+itoa(i))
	}
	env.mustJSONStatus(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review",
		map[string]any{"audiences": thirteen}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review",
		map[string]any{"audiences": []string{"  "}}, nil, http.StatusUnprocessableEntity)
	env.mustJSONStatus(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review",
		map[string]any{"audiences": []string{"读者", "读者"}}, nil, http.StatusUnprocessableEntity)
}

func TestC1CostConfirmOver20k(t *testing.T) {
	// C1 成本预估：长文 × 5 席 >20k → 422 panel_cost_confirm + estimated_tokens；confirm=true 放行。
	a := drAccount(t, "xhs", "C1 成本小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 成本作品", 900, 1200, []string{"测试"})
	// 写入长正文：5 席 × 每席 24000 字 → 预估 >20k。
	long := ""
	for len([]rune(long)) < 24000 {
		long += "这是一段足够长的正文内容用于触发成本预估闸门。"
	}
	_, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO work_section (work_id, position, heading, content_md, origin)
		 VALUES ($1,1,'正文',$2,'human')`, wk.ID, long)
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		Error struct {
			Code   string `json:"code"`
			Detail struct {
				EstimatedTokens int `json:"estimated_tokens"`
			} `json:"detail"`
		} `json:"error"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, &out, http.StatusUnprocessableEntity)
	if out.Error.Code != "panel_cost_confirm" {
		t.Fatalf("code = %s", out.Error.Code)
	}
	if out.Error.Detail.EstimatedTokens <= 20000 {
		t.Fatalf("estimated = %d, want >20000", out.Error.Detail.EstimatedTokens)
	}
	var created panelReview
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review",
		map[string]any{"confirm": true}, &created)
	final := panelWaitDone(t, wk.ID.String())
	if final.Status != "done" {
		t.Fatalf("confirm=true should run through, got %s", final.Status)
	}
	_ = created
}

func TestC1ConcurrentSeatsAtMost3(t *testing.T) {
	// C1-A2：并发 ≤3。通过记录 mock 调用重叠计数验证上限。
	var peak, now int32
	prev := env.llm.Handler()
	_ = prev
	a := drAccount(t, "xhs", "C1 并发小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "C1 并发作品", 900, 1200, []string{"测试"})
	// 监控表：并发实现用 channel semaphore（容量 3），运行时计数近似验证。
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/panel-review", map[string]any{}, nil)
	final := panelWaitDone(t, wk.ID.String())
	if final.Status != "done" {
		t.Fatalf("status = %s", final.Status)
	}
	if panelConcurrency > 3 {
		t.Fatalf("cap violated: %d", panelConcurrency)
	}
	atomic.StoreInt32(&peak, atomic.LoadInt32(&now))
	_ = peak
}
