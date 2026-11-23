package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func i4Ptr[T any](value T) *T { return &value }

func TestCXTopicSixRuleBoundariesAndMissing(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	tomorrow := now.Add(24 * time.Hour)
	full := scoreCXTopicSixRules(cxTopicScoreRuleInput{
		Platform: "xhs", Title: "写作新手如何搭建稳定计划", Angle: "从具体执行步骤说明", Format: "image_note",
		Tags: []string{"写作"}, MaterialCount: 5, CommentCount: 3, HasMetric: true, MetricComments: 10,
		Similarity90d: i4Ptr(0.44), SimilarityCandidate: "旧标题", PlannedDate: &tomorrow, Now: now,
	})
	if full.RuleMax != 120 || full.Threshold != 60 || full.Coverage != "complete" || len(full.Dimensions) != 6 {
		t.Fatalf("six-dimension rule result = %+v", full)
	}
	for _, key := range cxTopicScoreDimensionOrder {
		dimension, ok := full.Dimensions[key]
		if !ok || dimension.Score == nil || dimension.Max != 20 || dimension.State != "available" || dimension.Evidence == "" || dimension.Message == "" {
			t.Fatalf("dimension %s invalid: %+v", key, dimension)
		}
	}
	if *full.Dimensions["audience"].Score != 20 || *full.Dimensions["material"].Score != 20 || *full.Dimensions["differentiation"].Score != 20 || *full.Dimensions["timeliness"].Score != 20 {
		t.Fatalf("unexpected high scores: %+v", full.Dimensions)
	}

	for _, test := range []struct {
		name      string
		mutate    func(*cxTopicScoreRuleInput)
		key       string
		wantScore *int
		wantState string
	}{
		{"material zero", func(in *cxTopicScoreRuleInput) { in.MaterialCount = 0 }, "material", i4Ptr(0), "available"},
		{"material boundary", func(in *cxTopicScoreRuleInput) { in.MaterialCount = 4 }, "material", i4Ptr(16), "available"},
		{"similarity lower boundary", func(in *cxTopicScoreRuleInput) { in.Similarity90d = i4Ptr(0.45) }, "differentiation", i4Ptr(10), "available"},
		{"similarity upper boundary", func(in *cxTopicScoreRuleInput) { in.Similarity90d = i4Ptr(0.65) }, "differentiation", i4Ptr(0), "available"},
		{"missing audience", func(in *cxTopicScoreRuleInput) { in.Tags = nil }, "audience", nil, "missing"},
		{"missing differentiation", func(in *cxTopicScoreRuleInput) { in.Similarity90d = nil }, "differentiation", nil, "missing"},
		{"missing timeliness", func(in *cxTopicScoreRuleInput) { in.PlannedDate = nil }, "timeliness", nil, "missing"},
		{"missing demand", func(in *cxTopicScoreRuleInput) { in.CommentCount = 0; in.HasMetric = false }, "demand", nil, "missing"},
		{"missing deliverability", func(in *cxTopicScoreRuleInput) { in.Platform = "" }, "deliverability", nil, "missing"},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := fullInputForTest(now, tomorrow)
			test.mutate(&input)
			got := scoreCXTopicSixRules(input)
			dimension := got.Dimensions[test.key]
			if dimension.State != test.wantState {
				t.Fatalf("%s state = %s, want %s (%+v)", test.key, dimension.State, test.wantState, dimension)
			}
			if test.wantScore == nil {
				if dimension.Score != nil {
					t.Fatalf("%s must stay missing, got %+v", test.key, dimension)
				}
			} else if dimension.Score == nil || *dimension.Score != *test.wantScore {
				t.Fatalf("%s score = %+v, want %d", test.key, dimension, *test.wantScore)
			}
		})
	}
}

func fullInputForTest(now, tomorrow time.Time) cxTopicScoreRuleInput {
	return cxTopicScoreRuleInput{
		Platform: "xhs", Title: "写作新手如何搭建稳定计划", Angle: "从具体执行步骤说明", Format: "image_note",
		Tags: []string{"写作"}, MaterialCount: 5, CommentCount: 3, HasMetric: true, MetricComments: 10,
		Similarity90d: i4Ptr(0.44), SimilarityCandidate: "旧标题", PlannedDate: &tomorrow, Now: now,
	}
}

func TestCXTopicScoreAIRequiresSixDimensionsAndKeepsRuleScores(t *testing.T) {
	rule := scoreCXTopicSixRules(cxTopicScoreRuleInput{Platform: "xhs", Title: "写作新手如何搭建稳定计划", Angle: "从具体执行步骤说明",
		Format: "image_note", Tags: []string{"写作"}, MaterialCount: 5, Similarity90d: i4Ptr(0.5), PlannedDate: i4Ptr(time.Now().UTC().Add(24 * time.Hour))})
	valid := `{"dimensions":[
		{"key":"demand","score":0,"evidence":"没有评论数据","message":"补真实互动后再评"},
		{"key":"audience","score":20,"evidence":"标题命中写作","message":"已命中定位"},
		{"key":"material","score":20,"evidence":"素材5条","message":"可支撑基础写作"},
		{"key":"differentiation","score":18,"evidence":"与旧标题相似度0.50","message":"角度仍可更独特"},
		{"key":"timeliness","score":18,"evidence":"计划日期在7天内","message":"窗口合适"},
		{"key":"deliverability","score":20,"evidence":"xhs支持image_note","message":"格式可交付"}
	]}`
	var output cxTopicScoreAIOutput
	if err := json.Unmarshal([]byte(valid), &output); err != nil {
		t.Fatalf("valid output decode: %v", err)
	}
	if err := output.validate(rule); err != nil {
		t.Fatalf("valid output validate: %v", err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"key":"audience","score":20`, `"key":"audience","score":19`, 1),
		strings.Replace(valid, `"key":"material"`, `"key":"other"`, 1),
		strings.Replace(valid, `"score":18`, `"score":21`, 1),
		strings.Replace(valid, `"evidence":"素材5条"`, `"evidence":""`, 1),
	} {
		var invalid cxTopicScoreAIOutput
		if err := json.Unmarshal([]byte(raw), &invalid); err == nil && invalid.validate(rule) == nil {
			t.Fatalf("invalid output should be rejected: %s", raw)
		}
	}
}

func TestCXTopicScoreSkipsAIBelowThreshold(t *testing.T) {
	account := env.accounts(t).wechat
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET positioning_tags='{}' WHERE account_id=$1`, account.ID); err != nil {
		t.Fatal(err)
	}
	topic := createI4Topic(t, account, "一条低分选题", "没有定位、素材和时间信息", "", "")
	before := len(env.llm.Requests())
	var response cxTopicScoreResponse
	env.mustJSON(t, "POST", "/api/v1/topics/"+topic.ID.String()+"/score", map[string]string{"mode": "two_stage"}, &response)
	if !response.Result.AISkipped || response.Result.RuleScore >= 60 || response.Result.AIStatus != "skipped" || response.Result.AISkipReason != "规则分未达阈值，未调用 AI（省成本）" {
		t.Fatalf("low rule score must skip AI: %+v", response.Result)
	}
	if len(env.llm.Requests()) != before {
		t.Fatal("below-threshold score must not call the model")
	}
	if len(response.Result.Dimensions) != 6 || response.Result.Dimensions["audience"].State != "missing" || response.Result.Dimensions["timeliness"].State != "missing" {
		t.Fatalf("missing dimensions must be explicit: %+v", response.Result.Dimensions)
	}
}

func TestCXTopicScoreStoresAIResultWithoutChangingTopicState(t *testing.T) {
	account := env.accounts(t).wechat
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET positioning_tags=$1 WHERE account_id=$2`, []string{"写作"}, account.ID); err != nil {
		t.Fatal(err)
	}
	insertI4Materials(t, account.ID, 5)
	topic := createI4Topic(t, account, "写作新手如何搭建稳定计划", "从具体执行步骤说明", "long_article", time.Now().UTC().Add(24*time.Hour).Format("2006-01-02"))
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE topic SET score_fit=79,score_reason='existing score',scored_at=now() WHERE id=$1`, topic.ID); err != nil {
		t.Fatal(err)
	}
	basis, err := env.srv.cxTopicScoreInputSnapshot(context.Background(), ownerWS(t), topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	rule := scoreCXTopicSixRules(cxTopicScoreRuleInputFromBasis(basis))
	if rule.RuleScore < 60 {
		t.Fatalf("test setup must reach AI threshold: %+v", rule)
	}
	reply := i4ReplyForRule(rule, 18, 18)
	// 该请求 body 同样含 topic-score-input needle；用 scoped 队列避免
	// 与 Batch 用例的 scoped 回复互相错位（组跑时共享进程内 mock）。
	env.llm.PushRepliesFor("topic-score-input", reply)
	before := len(env.llm.Requests())
	var response cxTopicScoreResponse
	env.mustJSON(t, "POST", "/api/v1/topics/"+topic.ID.String()+"/score", map[string]string{"mode": "two_stage"}, &response)
	if response.ScoreID == uuid.Nil || response.Result.AIStatus != "complete" || response.Result.AIScore == nil || len(response.Result.AIDimensions) != 6 || response.Result.AIPartial {
		t.Fatalf("unexpected AI score: %+v", response.Result)
	}
	if response.Result.RuleScore < 60 || response.Result.RuleMax != 120 || response.Result.Threshold != 60 {
		t.Fatalf("rule total must be preserved: %+v", response.Result)
	}
	if response.Result.Dimensions["demand"].Score == nil && response.Result.Dimensions["demand"].State != "missing" {
		t.Fatalf("missing demand must remain missing: %+v", response.Result.Dimensions["demand"])
	}
	if len(env.llm.Requests())-before != 1 {
		t.Fatalf("expected one AI call, got %d", len(env.llm.Requests())-before)
	}
	var status, scoreReason string
	var scoreFit int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status,score_fit,score_reason FROM topic WHERE id=$1`, topic.ID).Scan(&status, &scoreFit, &scoreReason); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || scoreFit != 79 || scoreReason != "existing score" {
		t.Fatalf("score must not change topic status or topic_score: status=%s fit=%d reason=%s", status, scoreFit, scoreReason)
	}
	var storedRule, storedAI int
	var partial bool
	var version string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT rule_score,coalesce(ai_score,-1),ai_partial,rules_version FROM content_diagnosis WHERE id=$1`, response.ScoreID).Scan(&storedRule, &storedAI, &partial, &version); err != nil {
		t.Fatal(err)
	}
	if storedRule != response.Result.RuleScore || storedAI != *response.Result.AIScore || partial || version != cxTopicScoreVersion {
		t.Fatalf("stored score mismatch: rule=%d ai=%d partial=%v version=%s", storedRule, storedAI, partial, version)
	}
	var fetched cxTopicScoreResponse
	env.mustJSON(t, "GET", "/api/v1/topics/"+topic.ID.String()+"/score", nil, &fetched)
	if fetched.ScoreID != response.ScoreID || fetched.Stale {
		t.Fatalf("GET score = %+v", fetched)
	}
	var legacyDiagnoses struct {
		Items []cxTopicDiagnosisResponse `json:"items"`
	}
	env.mustJSON(t, "GET", "/api/v1/topics/"+topic.ID.String()+"/diagnoses", nil, &legacyDiagnoses)
	for _, item := range legacyDiagnoses.Items {
		if item.Result.RulesVersion == cxTopicScoreVersion {
			t.Fatalf("I4 score must not leak into legacy two-dimension diagnoses: %+v", item)
		}
	}
}

func TestCXTopicScoreAIFailureKeepsRuleScore(t *testing.T) {
	account := env.accounts(t).wechat
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET positioning_tags=$1 WHERE account_id=$2`, []string{"写作"}, account.ID); err != nil {
		t.Fatal(err)
	}
	insertI4Materials(t, account.ID, 5)
	topic := createI4Topic(t, account, "写作新手如何搭建稳定计划", "从具体执行步骤说明", "long_article", time.Now().UTC().Add(24*time.Hour).Format("2006-01-02"))
	basis, err := env.srv.cxTopicScoreInputSnapshot(context.Background(), ownerWS(t), topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	rule := scoreCXTopicSixRules(cxTopicScoreRuleInputFromBasis(basis))
	if rule.RuleScore < 60 {
		t.Fatalf("test setup must reach AI threshold: %+v", rule)
	}
	env.llm.PushRepliesFor("topic-score-input", "不是 JSON", "仍然不是 JSON")
	var response cxTopicScoreResponse
	env.mustJSON(t, "POST", "/api/v1/topics/"+topic.ID.String()+"/score", map[string]string{"mode": "two_stage"}, &response)
	if !response.Result.AIPartial || response.Result.AIErrorCode != "topic_score_ai_invalid" || response.Result.AIScore != nil || response.Result.RuleScore != rule.RuleScore {
		t.Fatalf("AI failure must preserve rule score and mark partial: %+v", response.Result)
	}
}

func TestCXTopicScoreBatchLimitAndTopTen(t *testing.T) {
	// 共享 mock LLM reply 队列是进程级的：组跑时前序用例 Push 后未消费完的
	// 回复会挤占本用例的 10 条排队回复，导致 AI 转 partial、AIEvaluated≠10。
	// 用例开头重置队列，确保 10 条回复按序命中本用例的前 10 条评分。
	env.llm.ResetReplies()
	account := env.accounts(t).wechat
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE account_profile SET positioning_tags='{}' WHERE account_id=$1`, account.ID); err != nil {
		t.Fatal(err)
	}
	insertI4Materials(t, account.ID, 5)
	ids := make([]uuid.UUID, 0, 12)
	for i := 0; i < 12; i++ {
		topic := createI4Topic(t, account, "批量六维评分选题", "从执行步骤说明", "long_article", time.Now().UTC().Add(24*time.Hour).Format("2006-01-02"))
		ids = append(ids, topic.ID)
	}
	// 动态生成与规则分一致的 reply：组跑时前序用例会污染共享表（素材数/定位标签/
	// 相似度候选），硬编码分数会与实际规则分 mismatch → validate 两次失败 →
	// topic_score_ai_invalid；i4ReplyForRule 按 basis 实际规则分生成，任意共享状态下成立。
	basis, err := env.srv.cxTopicScoreInputSnapshot(context.Background(), ownerWS(t), ids[0])
	if err != nil {
		t.Fatal(err)
	}
	rule := scoreCXTopicSixRules(cxTopicScoreRuleInputFromBasis(basis))
	reply := i4ReplyForRule(rule, 18, 18)
	// 组跑时后台 goroutine（前序用例异步任务）会与本用例的模型调用交错消费
	// 全局 reply 队列导致错位；改用按请求体路由的 scoped 队列，只有
	// cx_topic_diagnose 的请求（含 topic-score-input 数据块）才消费。
	for i := 0; i < 10; i++ {
		env.llm.PushRepliesFor("topic-score-input", reply)
	}
	var response cxTopicScoreBatchResponse
	env.mustJSON(t, "POST", "/api/v1/topics/score-batch", map[string]any{"ids": ids, "limit": 20}, &response)
	if response.Total != 12 || response.AIEvaluated != 10 || response.AISkipped != 2 {
		for i, item := range response.Items {
			if i >= 3 {
				break
			}
			t.Logf("batch item[%d] ai_status=%s ai_error=%s skip_reason=%s",
				i, item.Result.AIStatus, item.Result.AIErrorCode, item.Result.AISkipReason)
		}
		t.Fatalf("batch selection = %+v", response)
	}
	if len(response.Items) != 12 {
		t.Fatalf("batch items = %d", len(response.Items))
	}
	seen := map[uuid.UUID]bool{}
	for _, item := range response.Items {
		seen[item.TopicID] = true
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("batch dropped topic %s", id)
		}
	}
	var tooMany struct {
		IDs []uuid.UUID `json:"ids"`
	}
	for i := 0; i < 21; i++ {
		tooMany.IDs = append(tooMany.IDs, uuid.New())
	}
	env.expectErr(t, "POST", "/api/v1/topics/score-batch", tooMany, "topic_score_too_many")
}

func TestCXTopicScoreRecentWorkCountUsesTopicFormat(t *testing.T) {
	account := env.accounts(t).wechat
	topic := createI4Topic(t, account, "同类作品计数口径", "从执行步骤说明", "long_article", time.Now().UTC().Add(24*time.Hour).Format("2006-01-02"))
	var baseline int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work
		WHERE account_id=$1 AND deleted_at IS NULL AND updated_at > now() - interval '30 days'
		AND content_format=$2`, account.ID, "long_article").Scan(&baseline); err != nil {
		t.Fatal(err)
	}
	var inserted []uuid.UUID
	for _, format := range []string{"long_article", "long_article", "image_note"} {
		var id uuid.UUID
		if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO work (account_id,content_format,title)
			VALUES ($1,$2,'同类作品计数测试') RETURNING id`, account.ID, format).Scan(&id); err != nil {
			t.Fatal(err)
		}
		inserted = append(inserted, id)
	}
	t.Cleanup(func() {
		for _, id := range inserted {
			_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM work WHERE id=$1`, id)
		}
	})
	basis, err := env.srv.cxTopicScoreInputSnapshot(context.Background(), ownerWS(t), topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if basis.RecentWorkCount != baseline+2 {
		t.Fatalf("recent work count = %d, want %d (only long_article works)", basis.RecentWorkCount, baseline+2)
	}
}

func createI4Topic(t *testing.T, account Account, title, angle, format, planned string) Topic {
	t.Helper()
	body := map[string]any{"title": title, "angle": angle}
	if format != "" {
		body["format"] = format
	}
	if planned != "" {
		body["planned_date"] = planned
	}
	var created struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+account.ID.String()+"/topics", body, &created)
	return created.Topic
}

func insertI4Materials(t *testing.T, accountID uuid.UUID, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO material (workspace_id,account_id,kind,content)
			VALUES ($1,$2,'case',$3)`, ownerWS(t), accountID, "六维评分素材"); err != nil {
			t.Fatal(err)
		}
	}
}

func i4ReplyForRule(rule cxTopicScoreRuleResult, differentiation, timeliness int) string {
	dimensions := make([]cxTopicAIDimension, 0, 6)
	for _, key := range cxTopicScoreDimensionOrder {
		dimension := rule.Dimensions[key]
		score := 0
		evidence := "规则层缺少数据"
		message := "补数据后再评"
		if dimension.Score != nil {
			score = *dimension.Score
			evidence = dimension.Evidence
			message = dimension.Message
		}
		if key == "differentiation" {
			score = differentiation
			evidence = "近90天相似度与候选标题"
			message = "角度仍可更独特"
		}
		if key == "timeliness" {
			score = timeliness
			evidence = "计划日期在时效窗口"
			message = "越接近计划窗口分越高"
		}
		dimensions = append(dimensions, cxTopicAIDimension{Key: key, Score: score, Evidence: evidence, Message: message})
	}
	raw, _ := json.Marshal(cxTopicScoreAIOutput{Dimensions: dimensions})
	return string(raw)
}
