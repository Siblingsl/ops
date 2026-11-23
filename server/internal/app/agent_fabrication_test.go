package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A1-A1：五类声称模式表驱动 + 否定/计划句不误伤（句子级豁免）。
func TestA1ClaimPatternsTableDriven(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"publish-claimed", "文章已发布到平台。", []string{"publish"}},
		{"publish-pushed", "内容已推送完毕。", []string{"publish"}},
		{"write-claimed", "数据已写入表格。", []string{"write"}},
		{"send-claimed", "邮件已发送。", []string{"send"}},
		{"execute-claimed", "脚本已执行完成。", []string{"execute"}},
		{"finish-claimed", "任务已完成。", []string{"finish"}},
		{"plan-not-claimed", "我将发布这篇文章，计划写入草稿。", nil},
		{"suggest-not-claimed", "建议发布前先检查一遍。", nil},
		{"negative-not-claimed", "文章尚未发布，没有写入任何内容。", nil},
		{"failure-not-claimed", "上次发布失败，本次可以重试。", nil},
		{"mixed", "封面已上传，但正文尚未写入。", []string{"write"}},
		{"clean", "这是今天的选题建议清单。", nil},
	}
	for _, tc := range cases {
		got := agentClaimsInText(tc.text)
		if len(got) != len(tc.want) {
			t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
		}
		wantSet := map[string]bool{}
		for _, w := range tc.want {
			wantSet[w] = true
		}
		for _, g := range got {
			if !wantSet[g] {
				t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
			}
		}
	}
}

// A1-A5：改写前缀与原文分离；nudge 文案要求改为未执行或调用工具。
func TestA1RewriteAndNudgeText(t *testing.T) {
	check := agentFabricationCheck{Claims: []string{"publish", "write"}, Evidence: 0}
	rewrite := agentRewriteFinalText(check)
	if !strings.Contains(rewrite, "未执行") || !strings.Contains(rewrite, "不代表已完成") {
		t.Fatalf("rewrite missing disclaimer: %s", rewrite)
	}
	if !strings.Contains(rewrite, "发布") || !strings.Contains(rewrite, "写入") {
		t.Fatalf("rewrite should list blocked claims: %s", rewrite)
	}
	nudge := agentNudgeSystemText([]string{"publish"})
	if !strings.Contains(nudge, "没有对应的成功执行记录") || !strings.Contains(nudge, "尚未执行") {
		t.Fatalf("nudge text wrong: %s", nudge)
	}
}

// a1WaitRunDone 轮询 run 终态（消息接口 202 异步；本地 mock 最长 30 秒），返回 run id。
func a1WaitRunDone(t *testing.T, convID uuid.UUID) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var detail struct {
			ActiveRun *struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"active_run"`
		}
		env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+convID.String(), map[string]any{}, &detail)
		if detail.ActiveRun == nil {
			var runID string
			if err := env.srv.db.QueryRow(context.Background(),
				`SELECT id FROM agent_run WHERE conversation_id=$1 ORDER BY started_at DESC LIMIT 1`,
				convID).Scan(&runID); err != nil {
				t.Fatal(err)
			}
			return runID
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("run not finished in 30s")
	return ""
}

// a1UseRealModelName 把默认供应商改名（nudge 三闸只对非模拟模型生效；模拟模型走
// demo 闸，见 docs/41 A1 方案第 3 节），测试结束恢复。
func a1UseRealModelName(t *testing.T) {
	t.Helper()
	// A2 后 mock provider 带 simulated=true 列：nudge 三闸只对非模拟模型生效，
	// 故同时改名并把 simulated 置 false，测试结束恢复两列。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE model_provider SET name='selfhost-writer', simulated=false WHERE name='本地模拟模型'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `UPDATE model_provider SET name='本地模拟模型', simulated=true WHERE name='selfhost-writer'`)
	})
}

// A1-A2/A1-A3：无证据第一次 nudge、第二次拦截 outcome=partial；改口后 completed。
// 通过 HTTP 全链路（mock LLM PushReplies 声称文本；消息接口 202，run 后台执行）。
func TestA1FabricationNudgeThenBlockOverHTTP(t *testing.T) {
	env.ensureToolModel(t)
	a1UseRealModelName(t)
	conv := env.createConversation(t, map[string]any{})
	cases := []struct {
		name         string
		replies      []string
		wantContains string
		wantNudges   int
		wantOutcome  string
	}{
		{
			// 第一轮声称 → nudge 继续；第二轮仍声称 → 拦截改写 + partial。
			name:         "nudge-then-block",
			replies:      []string{"文章已发布，任务已完成。", "文章已发布，任务已完成。"},
			wantContains: "不代表已完成",
			wantNudges:   1,
			wantOutcome:  "partial",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env.llm.PushReplies(tc.replies...)
			status, body := env.do("POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
				"request_id": uuid.NewString(), "text": "把文章发布到平台", "protocol_version": 2,
			})
			if status != 202 {
				t.Fatalf("send = %d %s", status, body)
			}
			runID := a1WaitRunDone(t, conv.ID)
			var nudges int
			var outcome, rawFinal string
			var finalCheck map[string]any
			if err := env.srv.db.QueryRow(context.Background(),
				`SELECT fabrication_nudges, outcome, raw_final_text, final_check FROM agent_run WHERE id=$1`,
				runID).Scan(&nudges, &outcome, &rawFinal, &finalCheck); err != nil {
				t.Fatal(err)
			}
			if nudges != tc.wantNudges {
				var dbgRaw string
				var dbgN int
				_ = env.srv.db.QueryRow(context.Background(),
					`SELECT raw_final_text, fabrication_nudges FROM agent_run WHERE id=$1`, runID).Scan(&dbgRaw, &dbgN)
				t.Fatalf("%s: nudges=%d want %d (dbg nudges=%d raw=%q)", tc.name, nudges, tc.wantNudges, dbgN, dbgRaw)
			}
			if outcome != tc.wantOutcome {
				t.Fatalf("%s: outcome=%s want %s", tc.name, outcome, tc.wantOutcome)
			}
			// 最终 assistant 消息内容包含改写声明（拦截用例）或纠正后文本（改口用例）。
			var finalContent string
			if err := env.srv.db.QueryRow(context.Background(),
				`SELECT content FROM agent_message WHERE run_id=$1 AND role='assistant' ORDER BY seq DESC LIMIT 1`,
				runID).Scan(&finalContent); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(finalContent, tc.wantContains) {
				t.Fatalf("%s: final message missing %q: %s", tc.name, tc.wantContains, finalContent)
			}
			// raw_final_text 保留原文（拦截用例里原文为“已发布”声称）。
			if tc.wantOutcome == "partial" && !strings.Contains(rawFinal, "已发布") {
				t.Fatalf("%s: raw_final_text should keep original claim: %q", tc.name, rawFinal)
			}
			// final_check 摘要含 blocked。
			if tc.wantOutcome == "partial" {
				blockedRaw, _ := finalCheck["blocked"].([]any)
				if len(blockedRaw) == 0 {
					t.Fatalf("%s: final_check.blocked empty: %v", tc.name, finalCheck)
				}
				// A1-A6 数据面：详情接口必须把可信度结果暴露给双端 Agent 页。
				status, body = env.do("GET", "/api/v1/agent/conversations/"+conv.ID.String(), nil)
				if status != 200 {
					t.Fatalf("%s: detail = %d %s", tc.name, status, body)
				}
				var detail struct {
					LastRun *struct {
						Outcome    string         `json:"outcome"`
						Demo       bool           `json:"demo"`
						FinalCheck map[string]any `json:"final_check"`
					} `json:"last_run"`
				}
				if err := json.Unmarshal(body, &detail); err != nil {
					t.Fatal(err)
				}
				if detail.LastRun == nil || detail.LastRun.Outcome != "partial" {
					t.Fatalf("%s: detail last_run outcome missing: %s", tc.name, body)
				}
				blockedAPI, _ := detail.LastRun.FinalCheck["blocked"].([]any)
				if len(blockedAPI) == 0 {
					t.Fatalf("%s: detail final_check.blocked empty: %s", tc.name, body)
				}
			}
		})
	}
}

// A1-A4：模拟模型声称 → demo=true、不加 nudge、回答带演示前缀、原文保留。
func TestA1SimulatedModelDemo(t *testing.T) {
	env.ensureToolModel(t)
	conv := env.createConversation(t, map[string]any{})
	env.llm.PushReplies("文章已发布，任务已完成。")
	status, body := env.do("POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
		"request_id": uuid.NewString(), "text": "把文章发布到平台", "protocol_version": 2,
	})
	if status != 202 {
		t.Fatalf("send = %d %s", status, body)
	}
	runID := a1WaitRunDone(t, conv.ID)
	var demo bool
	var nudges int
	var rawFinal string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT demo, fabrication_nudges, raw_final_text FROM agent_run WHERE id=$1`,
		runID).Scan(&demo, &nudges, &rawFinal); err != nil {
		t.Fatal(err)
	}
	if !demo {
		t.Fatalf("simulated model must set demo=true")
	}
	if nudges != 0 {
		t.Fatalf("simulated model must not nudge, got %d", nudges)
	}
	if !strings.Contains(rawFinal, "已发布") {
		t.Fatalf("raw_final_text should keep original: %q", rawFinal)
	}
	var finalContent string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT content FROM agent_message WHERE run_id=$1 AND role='assistant' ORDER BY seq DESC LIMIT 1`,
		runID).Scan(&finalContent); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(finalContent, "模拟模型演示") {
		t.Fatalf("final message missing demo banner: %s", finalContent)
	}
	// A1-A6 数据面：详情接口的 last_run 应带 demo=true，供双端渲染黄色 banner。
	status, body = env.do("GET", "/api/v1/agent/conversations/"+conv.ID.String(), nil)
	if status != 200 {
		t.Fatalf("detail = %d %s", status, body)
	}
	var detail struct {
		LastRun *struct {
			Outcome string `json:"outcome"`
			Demo    bool   `json:"demo"`
		} `json:"last_run"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.LastRun == nil || !detail.LastRun.Demo {
		t.Fatalf("detail last_run demo missing: %s", body)
	}
}

// A1-A3：有证据（succeeded action）时声称不拦截、不加 nudge（单元级：直接调
// agentFinalizeTruth，不经 mock 时序）。
func TestA1EvidencePreventsFalsePositive(t *testing.T) {
	env.ensureToolModel(t)
	a1UseRealModelName(t)
	conv := env.createConversation(t, map[string]any{})
	status, body := env.do("POST", "/api/v1/agent/conversations/"+conv.ID.String()+"/messages", map[string]any{
		"request_id": uuid.NewString(), "text": "触发一个空 run 以取得 run 记录", "protocol_version": 2,
	})
	if status != 202 {
		t.Fatalf("send = %d %s", status, body)
	}
	runID := a1WaitRunDone(t, conv.ID)
	runUUID := uuidFromString(runID)
	// 注入一条 succeeded 动作（等同工具已成功执行），证据计数变为 1。
	if _, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO agent_action (conversation_id, run_id, batch_id, workspace_id, user_id,
		 tool_call_id, tool_name, kind, target_type, target_id, target_key, status, params, expires_at)
		 SELECT c.id, r.id, gen_random_uuid(), r.workspace_id, r.user_id,
		 'call-a1', 'publish_work', 'W', 'work', r.workspace_id::text, 'work', 'succeeded', '{}'::jsonb,
		 now() + interval '10 minutes'
		 FROM agent_conversation c JOIN agent_run r ON r.id=$2
		 WHERE c.id=$1`, conv.ID, runUUID); err != nil {
		t.Fatal(err)
	}
	member := &identity{UserID: uuidFromString(env.me(t).UserID), WorkspaceID: ownerWS(t), Role: "owner"}
	st := &agentRunState{RunID: runUUID, ConversationID: conv.ID, WorkspaceID: member.WorkspaceID,
		UserID: member.UserID, ProviderName: "selfhost-writer"}
	final, check := env.srv.agentFinalizeTruth(context.Background(), st, "文章已发布，任务已完成。", false)
	if final != "文章已发布，任务已完成。" {
		t.Fatalf("evidence must not rewrite, got %q", final)
	}
	if check.Evidence != 1 {
		t.Fatalf("evidence = %d, want 1", check.Evidence)
	}
	if len(check.Blocked) != 0 {
		t.Fatalf("evidence run must not block: %v", check.Blocked)
	}
	// 对照：无证据（新建空 run 状态、未注入动作）→ 第二次拦截改写。
	st2 := &agentRunState{RunID: uuid.New(), ConversationID: conv.ID, WorkspaceID: member.WorkspaceID,
		UserID: member.UserID, ProviderName: "selfhost-writer", FabricationNudges: 1}
	final2, check2 := env.srv.agentFinalizeTruth(context.Background(), st2, "文章已发布。", false)
	if !strings.Contains(final2, "不代表已完成") {
		t.Fatalf("second attempt must rewrite, got %q", final2)
	}
	if check2.Evidence != 0 || len(check2.Blocked) == 0 {
		t.Fatalf("second check wrong: %+v", check2)
	}
	// 第一次（nudges=0）→ nudge 文本且 FabricationNudges 递增。
	st3 := &agentRunState{RunID: uuid.New(), ConversationID: conv.ID, WorkspaceID: member.WorkspaceID,
		UserID: member.UserID, ProviderName: "selfhost-writer"}
	final3, _ := env.srv.agentFinalizeTruth(context.Background(), st3, "文章已发布。", false)
	if !strings.HasPrefix(final3, "你声称完成了：") || st3.FabricationNudges != 1 {
		t.Fatalf("first attempt must nudge: %q nudges=%d", final3, st3.FabricationNudges)
	}
}

// uuidFromString 是测试辅助。
func uuidFromString(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}
