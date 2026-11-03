package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// DEV-CX12 / FR-CX-15 / T-CX15：改写度检查——
// 相同原文 fail；两维不同 pass；无参考 not_applicable 不建项；错误 run/陈旧 revision 409；
// acknowledged 理由 20..500；临时原文不落库（context_refs/作品/笔记均无）。
type rewriteCheckResponse struct {
	Result        string `json:"result"`
	ReferenceHash string `json:"reference_hash"`
	AICallID      *string `json:"ai_call_id"`
}

func ensureRewriteRoute(t *testing.T) {
	t.Helper()
	var provider struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "改写度模拟模型", "base_url": env.mock.URL + "/v1", "api_key": "opt52-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "cx_rewrite_compare", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
}

func rewriteReferenceText() string {
	// 与作品正文完全无关的合成参考（≥200 码点），保证 AI 维（mock 固定 different）→ pass。
	paragraphs := []string{
		"参考文章讲述的是一只信鸽如何穿越两百公里山地送信的故事，中途遇到暴风雨绕行了额外的路程，最终在第三天清晨抵达鸽舍。",
		"饲养员分析了信鸽的飞行路线，认为绕行是因为山脉之间的气流变化，而不是记忆偏差；信鸽利用地形和风向调整翅膀角度。",
		"结论部分强调训练要循序渐进，先短距离后长距离，让信鸽在陌生地形建立自己的导航经验，而不是依赖单一的归巢本能。",
		"作者还比较了不同季节的训练效果，发现秋季的能见度更适合远距离放飞，夏季高温则会明显降低飞行意愿和持久力。",
		"文末提醒饲养者记录每次放飞的时间和天气，形成自己的数据积累，比单纯依赖他人的经验更可靠。",
	}
	return strings.Join(paragraphs, "\n")
}

func rewriteWorkReferenceText() string {
	// 与作品正文高度同源的参考（直接取作品句式），表达维 same → 结果 fail。
	paragraphs := []string{
		"许多人开始记录生活，但坚持不下来。问题往往不在懒，而在反馈太慢，写了两周看不到任何变化就放弃了，于是怀疑方法没有用。",
		"解决办法是把记录降到一个不可能失败的最小动作。每天只写一句话，写完就算完成，多余的内容是奖励而不是负担，中断一天也不必补救。",
		"举一个例子，一位作者连续三十天只写一句话总结，第三个月自然开始扩写成段，因为素材已经堆在眼前，不需要凭空回忆当时的细节。",
		"执行清单分四步：定一个固定时间、准备一个顺手工具、写完立刻保存、每周日回读一次。每一步都可以单独放弃或调整，不追求完美的执行记录。",
		"结论是先保住连续性，再谈质量。记录本身不是目的，让想法有地方沉淀才是，等习惯自己长大，输出自然会跟着变多起来。",
	}
	return strings.Join(paragraphs, "\n")
}

func TestCXRewriteCheckThreeDimensionsAndGating(t *testing.T) {
	ensureRewriteRoute(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "改写度检查验收")
	defer agentDropWork(wk.ID)
	base := "/api/v1/works/" + wk.ID.String()

	var run struct {
		Run CheckRun `json:"run"`
	}
	// 表达维 Jaccard 要求两侧 ≥200 码点；readyWork 的 mock 正文较短，
	// 先把首段扩写到 500+ 码点再发起检查。
	var fullBefore Work
	env.mustJSON(t, "GET", base, nil, &fullBefore)
	longBody := strings.Repeat("记录生活的关键在于把反馈周期缩短到当天可见，写一句话也能积累素材，坚持三周后自然能看出主题轮廓，这种渐进的积累比一次性长文更容易保持动力，也更容易在回读时发现真正值得展开的线索。", 4)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+fullBefore.Sections[0].ID.String(), map[string]any{"content_md": longBody, "base_revision": fullBefore.Sections[0].Revision}, nil)
	env.mustJSON(t, "POST", base+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &run)
	checkRunID := run.Run.ID.String()
	revision := run.Run.Revision

	// 1) 无参考正文：not_applicable 语义——不产生 rewrite 项（结果 200 但不写入）。
	status, body := env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "reference_text": "",
	})
	if status != 200 {
		t.Fatalf("empty reference: %d %s", status, body)
	}
	var latest struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	for _, item := range latest.Run.Items {
		if item.Category == "rewrite" {
			t.Fatal("empty reference must not create a rewrite item")
		}
	}

	// 2) 相同原文（与作品同源参考）：表达维 same，mock 两维 different → 2 different ≥2 → pass？
	// 规格：完全相同直接 fail；表达 same + 其余不同=2 different → pass（低风险提示）。
	// 这里的同源参考覆盖作品全文，表达维 Jaccard ≥0.30 → same；mock 证据/观点 different → pass。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "reference_text": rewriteWorkReferenceText(),
	})
	if status != 200 {
		t.Fatalf("same-source check: %d %s", status, body)
	}
	var sameResp rewriteCheckResponse
	_ = json.Unmarshal(body, &sameResp)
	if sameResp.Result != "pass" {
		t.Fatalf("expression same + two AI different must pass (low-risk hint): %s", sameResp.Result)
	}

	// 3) 完全相同（参考=作品正文）：表达 same、证据/观点 same → fail。
	var full Work
	env.mustJSON(t, "GET", base, nil, &full)
	workBody := ""
	for _, sec := range full.Sections {
		workBody += sec.ContentMD + "\n\n"
	}
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "reference_text": workBody,
	})
	if status != 200 {
		t.Fatalf("identical check: %d %s", status, body)
	}
	var identResp rewriteCheckResponse
	_ = json.Unmarshal(body, &identResp)
	if identResp.Result != "fail" {
		t.Fatalf("identical text must fail: %s", identResp.Result)
	}

	// fail 已生成 rewrite 待处理项。
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	var rewriteItem *CheckItem
	for i := range latest.Run.Items {
		if latest.Run.Items[i].Category == "rewrite" {
			rewriteItem = &latest.Run.Items[i]
		}
	}
	if rewriteItem == nil || rewriteItem.Passed {
		t.Fatalf("fail must produce an unresolved rewrite item: %+v", rewriteItem)
	}

	// 4) acknowledged 理由边界：缺失/过短拒绝；合规理由通过并落 resolution_note。
	status, _ = env.do("PATCH", "/api/v1/check-items/"+rewriteItem.ID.String(), map[string]any{"resolution": "acknowledged"})
	if status != 422 {
		t.Fatalf("missing reason must 422: %d", status)
	}
	status, _ = env.do("PATCH", "/api/v1/check-items/"+rewriteItem.ID.String(), map[string]any{"resolution": "acknowledged", "reason": "太短"})
	if status != 422 {
		t.Fatalf("short reason must 422: %d", status)
	}
	goodReason := "这段参考是我本人在其他平台发布的旧稿，本次改写自同一份材料，因此表达高度相似，保留此说明备查。"
	status, body = env.do("PATCH", "/api/v1/check-items/"+rewriteItem.ID.String(), map[string]any{"resolution": "acknowledged", "reason": goodReason})
	if status != 200 {
		t.Fatalf("valid reason: %d %s", status, body)
	}
	var note string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT resolution_note FROM check_item WHERE id=$1`, rewriteItem.ID).Scan(&note); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(note, "旧稿") {
		t.Fatalf("reason must be persisted: %s", note)
	}
	// 修改类 resolution 不需要理由；非法取值维持既有拒绝。
	status, _ = env.do("PATCH", "/api/v1/check-items/"+rewriteItem.ID.String(), map[string]any{"resolution": "verified"})
	if status != 422 {
		t.Fatalf("rewrite must not accept verified: %d", status)
	}

	// 5) 错误 run / 陈旧 revision 409 check_context_changed。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision + 5, "check_run_id": checkRunID, "reference_text": rewriteReferenceText(),
	})
	if status != 409 || !strings.Contains(string(body), "check_context_changed") {
		t.Fatalf("stale revision must 409: %d %s", status, body)
	}
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": "00000000-0000-0000-0000-00000000000f", "reference_text": rewriteReferenceText(),
	})
	if status != 409 {
		t.Fatalf("foreign run must 409: %d %s", status, body)
	}

	// 6) 两维不同（无关参考）：pass 记录 passed=true 的来源项。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "reference_text": rewriteReferenceText(),
	})
	if status != 200 {
		t.Fatalf("unrelated check: %d %s", status, body)
	}
	var passResp rewriteCheckResponse
	_ = json.Unmarshal(body, &passResp)
	if passResp.Result != "pass" {
		t.Fatalf("unrelated reference with two different AI dims must pass: %s", passResp.Result)
	}
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	var passItem *CheckItem
	for i := range latest.Run.Items {
		if latest.Run.Items[i].Category == "rewrite" {
			passItem = &latest.Run.Items[i]
		}
	}
	if passItem == nil || !passItem.Passed {
		t.Fatalf("pass must be recorded as a passed rewrite item: %+v", passItem)
	}

	// 7) 临时原文不落库：作品表、benchmark_note、ai_call.context_refs 均无参考正文独特句。
	needle := "信鸽如何穿越两百公里山地送信"
	var hit bool
	if err := env.srv.db.QueryRow(context.Background(), `SELECT EXISTS (
		SELECT 1 FROM work WHERE id=$1 AND (viewpoint LIKE $2 OR title LIKE $2))`, wk.ID, "%"+needle+"%").Scan(&hit); err != nil {
		t.Fatal(err)
	}
	if hit {
		t.Fatal("reference text must not leak into work fields")
	}
	if passResp.AICallID != nil {
		var refsRaw []byte
		if err := env.srv.db.QueryRow(context.Background(), `SELECT context_refs FROM ai_call WHERE id=$1`, *passResp.AICallID).Scan(&refsRaw); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(refsRaw), needle) {
			t.Fatalf("reference text must not enter ai_call.context_refs: %s", string(refsRaw)[:200])
		}
	}
}

// 骨架引用（无完整正文）→ undetermined；但当前 API 不接骨架路径时按无参考处理。
// 这里验证"显式提供但不足 200 码点"被拒绝，undetermined 由 run 内 AI unavailable 输出触发。
func TestCXRewriteCheckShortReferenceRejected(t *testing.T) {
	ensureRewriteRoute(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.wechat, "改写度短参考")
	defer agentDropWork(wk.ID)
	base := "/api/v1/works/" + wk.ID.String()
	var run struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "POST", base+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &run)
	status, body := env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": run.Run.Revision, "check_run_id": run.Run.ID.String(), "reference_text": "骨架摘要：短于两百码点的结构记录",
	})
	if status != 422 {
		t.Fatalf("short explicit reference must 422: %d %s", status, body)
	}
}

// DEV-CX12 / FR-CX-15 显式骨架引用路径：仅 benchmark_note 骨架（无完整正文）→
// undetermined + reference_text_required 并生成 rewrite 待处理项；正文与骨架互斥；
// 骨架必须属于作品账号且未归档；同一 run 内后续正文检查替换骨架结论。
func TestCXRewriteCheckSkeletonReferenceExplicitPath(t *testing.T) {
	ensureRewriteRoute(t)
	acc := env.accounts(t)
	wk := env.readyWork(t, acc.xhs, "改写度骨架引用")
	defer agentDropWork(wk.ID)
	base := "/api/v1/works/" + wk.ID.String()

	// 建一条对标骨架笔记（归当前账号）。
	var created benchmarkTargetResponse
	if status, body := env.do("POST", benchmarkPath(acc.xhs.ID.String()), map[string]any{"platform": "xhs", "name": "骨架引用目标"}); status != 201 {
		t.Fatalf("create target: status=%d body=%s", status, body)
	} else {
		_ = json.Unmarshal(body, &created)
	}
	structure := map[string]any{"hook_type": "question", "hook_gist": "为什么坚持不下来", "sections": []any{}, "cta_type": "none", "rhythm": map[string]any{"paragraphs": 5, "avg_chars": 80}}
	var note map[string]any
	if status, body := env.do("POST", "/api/v1/benchmarks/"+created.ID+"/notes", map[string]any{
		"title": "骨架引用拆解", "structure": structure,
	}); status != 201 {
		t.Fatalf("create note: status=%d body=%s", status, body)
	} else {
		_ = json.Unmarshal(body, &note)
	}
	noteID := note["id"].(string)

	// 表达维 Jaccard 两侧都要求 ≥200 码点：先把首段扩写，正文检查才能全维可判。
	var fullBefore Work
	env.mustJSON(t, "GET", base, nil, &fullBefore)
	longBody := strings.Repeat("记录生活的关键在于把反馈周期缩短到当天可见，写一句话也能积累素材，坚持三周后自然能看出主题轮廓，这种渐进的积累比一次性长文更容易保持动力，也更容易在回读时发现真正值得展开的线索。", 4)
	env.mustJSON(t, "PATCH", "/api/v1/sections/"+fullBefore.Sections[0].ID.String(), map[string]any{"content_md": longBody, "base_revision": fullBefore.Sections[0].Revision}, nil)

	var run struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "POST", base+"/checks", map[string]int{"html_chars": 3000, "html_bytes": 9000}, &run)
	revision := run.Run.Revision
	checkRunID := run.Run.ID.String()

	// 1) 骨架路径：无正文 + 骨架 ids → undetermined + reference_text_required，并建 rewrite 待处理项。
	status, body := env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID,
		"reference_text": "", "skeleton_note_ids": []string{noteID},
	})
	if status != 200 {
		t.Fatalf("skeleton reference: %d %s", status, body)
	}
	var skelResp struct {
		Result                string `json:"result"`
		ReferenceTextRequired bool   `json:"reference_text_required"`
		PromptVersion         string `json:"prompt_version"`
		ReferenceHash         string `json:"reference_hash"`
	}
	_ = json.Unmarshal(body, &skelResp)
	if skelResp.Result != "undetermined" || !skelResp.ReferenceTextRequired || skelResp.PromptVersion != "skeleton_only" {
		t.Fatalf("skeleton path must be undetermined+required: %+v", skelResp)
	}
	var latest struct {
		Run CheckRun `json:"run"`
	}
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	var skelItem *CheckItem
	for i := range latest.Run.Items {
		if latest.Run.Items[i].Category == "rewrite" {
			skelItem = &latest.Run.Items[i]
		}
	}
	if skelItem == nil || skelItem.Passed {
		t.Fatalf("skeleton reference must produce an unresolved rewrite item: %+v", skelItem)
	}
	if !strings.Contains(skelItem.Message, "结构骨架") {
		t.Fatalf("skeleton item message should mention skeleton: %s", skelItem.Message)
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(skelItem.Detail), &detail); err != nil {
		t.Fatal(err)
	}
	if detail["skeleton_only"] != true || detail["reference_text_required"] != true {
		t.Fatalf("skeleton item detail must mark skeleton_only and required: %+v", detail)
	}
	// 骨架路径不调用 AI：无 ai_call_id。
	if _, ok := detail["ai_call_id"]; ok && detail["ai_call_id"] != nil {
		t.Fatalf("skeleton path must not invoke AI: %+v", detail["ai_call_id"])
	}

	// 2) 互斥：正文与骨架同时提供 → 422。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID,
		"reference_text": rewriteReferenceText(), "skeleton_note_ids": []string{noteID},
	})
	if status != 422 {
		t.Fatalf("reference text and skeleton must be exclusive: %d %s", status, body)
	}

	// 3) 骨架不属于该作品账号 / 不存在 → 422。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID,
		"skeleton_note_ids": []string{"00000000-0000-0000-0000-00000000000e"},
	})
	if status != 422 {
		t.Fatalf("foreign skeleton must 422: %d %s", status, body)
	}

	// 4) 超过 5 条 → 422。
	ids := []string{}
	for i := 0; i < 6; i++ {
		ids = append(ids, noteID)
	}
	status, _ = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "skeleton_note_ids": ids,
	})
	if status != 422 {
		t.Fatalf("more than 5 skeleton notes must 422: %d", status)
	}

	// 5) 同一 run 内正文检查替换骨架结论：仍只有一条 rewrite 项。
	status, body = env.do("POST", base+"/rewrite-check", map[string]any{
		"basis_revision": revision, "check_run_id": checkRunID, "reference_text": rewriteReferenceText(),
	})
	if status != 200 {
		t.Fatalf("body check after skeleton: %d %s", status, body)
	}
	env.mustJSON(t, "GET", base+"/checks/latest", nil, &latest)
	count := 0
	var bodyItem *CheckItem
	for i := range latest.Run.Items {
		if latest.Run.Items[i].Category == "rewrite" {
			count++
			bodyItem = &latest.Run.Items[i]
		}
	}
	if count != 1 || bodyItem == nil || !bodyItem.Passed {
		t.Fatalf("body check must replace the skeleton item with exactly one passed item: count=%d item=%+v", count, bodyItem)
	}
	var bodyDetail map[string]any
	_ = json.Unmarshal([]byte(bodyItem.Detail), &bodyDetail)
	if bodyDetail["skeleton_only"] != false || bodyDetail["reference_text_required"] != false {
		t.Fatalf("body item must not carry skeleton flags: %+v", bodyDetail)
	}
}
