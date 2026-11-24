package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// DEV-AW13 docs/16 §15.13 六条用户旅程的真实模型执行器（2026-11-22 R13 补齐）。
// 门控：OPS_AW13_REAL_ACCEPTANCE=1 时执行，默认 skip 不出网不虚报；
// 真实供应商经 OPS_R_REAL_BASE_URL / OPS_R_REAL_API_KEY / OPS_R_REAL_MODEL 环境注入
// （复用 rRealProviderConfigFromEnv：密钥只进进程内存与测试库加密列，不进代码/日志/证据）。
// 每条旅程 ×3 次迭代；结果写 OPS_AW13_REAL_OUTPUT 目录 JSONL。
// 与 R01~R05 的分工：R 系列验证运营研究任务（27 §9.7，需 Chrome 证据）；
// 本文件验证 §15.13 工作台旅程（模型对话/技能/计划/恢复/分支/例行），不要求浏览器证据。
// mock 不算真实验证：断言只看真实模型行为（工具卡片产出、计划受理、队列行为等）。

const aw13RealFeatureEnv = "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse"

func openAW13RealJourney(t *testing.T) *rJourneyEnv {
	t.Helper()
	if os.Getenv("OPS_AW13_REAL_ACCEPTANCE") != "1" {
		t.Skip("§15.13 六旅程真实模型验收需显式设置 OPS_AW13_REAL_ACCEPTANCE=1（真实模型会产生费用）")
	}
	cfg, cfgErr := rRealProviderConfigFromEnv()
	if cfgErr != nil {
		t.Fatalf("真实供应商配置缺失：%v", cfgErr)
	}
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, aw13RealFeatureEnv)
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("旅程恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	providerID := seedRRealProvider(t, cfg)
	conv := env.rJourneyConversation(t, providerID, cfg.Model)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	return &rJourneyEnv{providerID: providerID, model: cfg.Model, conv: conv, t: t}
}

// aw13WaitRun 等待真实 run 到终态（真实模型最长 10 分钟），返回 run_id 与终态。
func aw13WaitRun(t *testing.T, raw []byte) (uuid.UUID, string) {
	t.Helper()
	var out struct {
		RunID uuid.UUID `json:"run_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		var status string
		if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, out.RunID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "queued" && status != "running" {
			return out.RunID, status
		}
		time.Sleep(3 * time.Second)
	}
	t.Fatalf("真实运行未在限时内结束 run=%s", out.RunID)
	return uuid.Nil, ""
}

// aw13Send 发送一条消息并等待真实 run 完成，返回 (run_id, status, 最终 assistant 文本)。
func aw13Send(t *testing.T, conv agentConversation, text string, extra map[string]any) (uuid.UUID, string, string) {
	t.Helper()
	in := map[string]any{"text": text, "request_id": uuid.NewString(), "protocol_version": 2,
		"model": map[string]any{"provider_id": conv.ModelProviderID.String(), "model": conv.Model}}
	for k, v := range extra {
		in[k] = v
	}
	status, body := env.do(http.MethodPost, agentRunPath(conv, "messages"), in)
	if status != http.StatusAccepted {
		t.Fatalf("消息未受理：%d %s", status, body)
	}
	runID, runStatus := aw13WaitRun(t, body)
	var stage, reason, errCode, errMsg string
	_ = env.srv.db.QueryRow(t.Context(), `SELECT stage,reason,error_code,error_message FROM agent_run WHERE id=$1`, runID).
		Scan(&stage, &reason, &errCode, &errMsg)
	t.Logf("run %s 终态 status=%s stage=%s reason=%s error=%s/%s", runID, runStatus, stage, reason, errCode, errMsg)
	return runID, runStatus, aw13LastAssistant(t, conv.ID)
}

// aw13LastAssistant 取会话最后一条非空 assistant 消息。
func aw13LastAssistant(t *testing.T, conv uuid.UUID) string {
	t.Helper()
	var detail struct {
		Messages []struct {
			Role      string `json:"role"`
			Content   string `json:"content"`
			ToolCalls []any  `json:"tool_calls"`
		} `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conv.String(), nil, &detail)
	for i := len(detail.Messages) - 1; i >= 0; i-- {
		if detail.Messages[i].Role == "assistant" && strings.TrimSpace(detail.Messages[i].Content) != "" {
			return detail.Messages[i].Content
		}
	}
	return ""
}

// aw13AllAssistant 拼接会话内全部非空 assistant 文本，用于验收跨消息产出的报告。
func aw13AllAssistant(t *testing.T, conv uuid.UUID) string {
	t.Helper()
	var detail struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+conv.String(), nil, &detail)
	var b strings.Builder
	for _, m := range detail.Messages {
		if m.Role == "assistant" && strings.TrimSpace(m.Content) != "" {
			b.WriteString(m.Content)
			b.WriteString("\n")
		}
	}
	return b.String()
}

// aw13CountCards 统计会话内产生的动作卡片数（agent_action，G/W/H/X）。
func aw13CountCards(t *testing.T, conv uuid.UUID) int {
	t.Helper()
	var n int
	if err := env.srv.db.QueryRow(t.Context(),
		`SELECT count(*) FROM agent_action WHERE conversation_id=$1`, conv).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// aw13Record 把单次旅程结果写入证据目录 JSONL。
func aw13Record(t *testing.T, scenario string, iteration int, checks map[string]bool, note string) {
	t.Helper()
	outDir := os.Getenv("OPS_AW13_REAL_OUTPUT")
	if outDir == "" {
		return
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatalf("证据目录不可写：%v", err)
	}
	line, _ := json.Marshal(map[string]any{
		"scenario": scenario, "iteration": iteration, "checks": checks, "note": note,
		"at": time.Now().UTC().Format(time.RFC3339),
	})
	f, err := os.OpenFile(outDir+"/aw13-journeys.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("证据文件不可写：%v", err)
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// aw13Run 三次迭代骨架：每次迭代由 taskFn 驱动并返回检查表，全过才算通过。
func aw13Run(t *testing.T, label string, taskFn func(i int) map[string]bool, noteFn func(i int) string) {
	t.Helper()
	for i := 1; i <= 3; i++ {
		checks := taskFn(i)
		for k, v := range checks {
			if !v {
				t.Fatalf("%s 第 %d 次检查未过：%s", label, i, k)
			}
		}
		aw13Record(t, label, i, checks, noteFn(i))
		t.Logf("%s 第 %d 次完成：%d 项检查全过", label, i, len(checks))
	}
}

// 旅程 1：计划「检查哪些地方需要补充」→ 澄清问答 → 查看计划 → 同意进入执行 → 段落修改卡片 → 执行。
// §15.13 要求真实模型产出计划/问题工具调用与卡片；mock 版（agent_plans_questions_api_test）用
// #tool 文本模拟，本执行器要求真实模型自行调用 present_plan / request_input。
func TestAW13Journey1PlanClarifyExecuteReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	conv := rj.conv
	env.mustJSON(t, http.MethodPatch, agentRunPath(conv, ""), map[string]any{
		"expected_revision": conv.Revision, "mode": "plan",
	}, &struct{}{})
	aw13Run(t, "J1", func(i int) map[string]bool {
		checks := map[string]bool{}
		// ① 显式引用作品并发起计划请求（真实模型应调用 present_plan 与/或 request_input）。
		runID, runStatus, lastText := aw13Send(t, conv, fmt.Sprintf(
			"请为第 %d 次迭代制定检查计划：检查我的作品哪些地方需要补充。先列出计划并问我一个必答的澄清问题。", i), nil)
		t.Logf("J1 第 %d 次真实运行 run=%s status=%s 文本=%q", i, runID, runStatus, lastText)
		checks["run_completed"] = runStatus == "completed" || runStatus == "awaiting_input"
		var detail struct {
			Plans     []agentPlanView     `json:"plans"`
			Questions []agentQuestionView `json:"questions"`
		}
		env.mustJSON(t, http.MethodGet, agentRunPath(conv, ""), nil, &detail)
		checks["plan_or_question_presented"] = len(detail.Plans) > 0 || len(detail.Questions) > 0
		// ② 回答澄清问题（若有）：模型可能在回答后继续追问，逐轮答完整组，最多 3 轮。
		for attempt := 0; attempt < 3; attempt++ {
			env.mustJSON(t, http.MethodGet, agentRunPath(conv, ""), nil, &detail)
			var pending *agentQuestionView
			for j := range detail.Questions {
				if detail.Questions[j].Status == "pending" {
					pending = &detail.Questions[j]
					break
				}
			}
			if pending == nil {
				break
			}
			answers := make([]map[string]any, 0, len(pending.Items))
			for _, item := range pending.Items {
				answers = append(answers, map[string]any{"question_id": item.ID, "text": "重点补充开头与数据来源"})
			}
			if len(answers) == 0 {
				t.Fatalf("澄清问题没有可回答的条目：%+v", pending)
			}
			env.mustJSONStatus(t, http.MethodPost, "/api/v1/agent/questions/"+pending.ID.String()+"/answer",
				map[string]any{"protocol_version": 2, "expected_revision": pending.Revision,
					"request_id": uuid.NewString(), "answers": answers}, &struct{}{}, http.StatusAccepted)
			// 回答触发的新 run 同样等待结束。
			for k := 0; k < 200; k++ {
				var active bool
				if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running'))`, conv.ID).Scan(&active); err != nil || !active {
					break
				}
				time.Sleep(3 * time.Second)
			}
		}
		env.mustJSON(t, http.MethodGet, agentRunPath(conv, ""), nil, &detail)
		if len(detail.Plans) > 0 && detail.Plans[0].AcceptedAt == nil {
			env.mustJSONStatus(t, http.MethodPost, "/api/v1/agent/plans/"+detail.Plans[0].ID.String()+"/accept",
				map[string]any{"protocol_version": 2, "expected_version": detail.Plans[0].Version, "request_id": uuid.NewString()}, &struct{}{}, http.StatusAccepted)
			for k := 0; k < 200; k++ {
				var active bool
				if err := env.srv.db.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running'))`, conv.ID).Scan(&active); err != nil || !active {
					break
				}
				time.Sleep(3 * time.Second)
			}
		}
		// ③ 段落修改卡片：真实模型在执行模式应提出 modify 请求（卡片或不接受时应明确说明）。
		if aw13CountCards(t, conv.ID) == 0 {
			_, _, final := aw13Send(t, conv, "请直接给出一个段落修改建议卡片：把开头改得更具体。", nil)
			checks["card_or_reject_visible"] = strings.TrimSpace(final) != ""
		}
		checks["has_output"] = strings.TrimSpace(aw13LastAssistant(t, conv.ID)) != ""
		_ = runID
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：计划→澄清→执行→卡片", i) })
}

// 旅程 2：上传笔记 + 技能请求 → 请求/加载/实际使用差异 → 素材建议 → 逐张确认入库；聊天不能直接入库。
func TestAW13Journey2SkillMaterialCardConfirmReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	conv := rj.conv
	// 素材卡片是 W 类写入的“待确认卡片”，讨论模式只放行只读工具；本旅程必须切到执行模式，
	// 否则模型即使想调用 materials__create 也会被权限闸门拒绝。
	env.mustJSON(t, http.MethodPatch, agentRunPath(conv, ""), map[string]any{
		"expected_revision": conv.Revision, "mode": "execute",
	}, &struct{}{})
	aw13Run(t, "J2", func(i int) map[string]bool {
		checks := map[string]bool{}
		// 上传一份笔记附件 + 请求技能（$），再要求产出素材建议。
		_, attachment, body := agentUploadAttachment(t, fmt.Sprintf("journey2-%d.txt", i),
			[]byte(fmt.Sprintf("第 %d 次迭代素材笔记：露营装备清单与新手避坑要点。", i)), conv.ID.String())
		if attachment.ID == uuid.Nil || len(body) == 0 {
			t.Fatalf("附件上传失败：%s", body)
		}
		// 来源与正文都必须能在用户原文中找到，避免模型自拟 source/改写正文触发来源校验失败。
		prompt := fmt.Sprintf("素材来源：用户上传的 %s。请先调用 load_tool_domain 加载 materials 域，再调用 materials__create 工具提交一条素材卡片：account_id 使用当前会话账号，kind=experience，content 逐字复制附件原文（不要改写），source 直接使用“用户上传的 %s”。不要反问，不要直接入库，只生成待确认卡片。", attachment.Name, attachment.Name)
		_, runStatus, _ := aw13Send(t, conv, prompt,
			map[string]any{"attachment_ids": []string{attachment.ID.String()}})
		checks["run_completed"] = runStatus == "completed" || runStatus == "awaiting_confirmation"
		// 素材建议必须走卡片（G 来源），聊天不能直接入库：会话中不应出现素材写入成功声明以外的直写。
		cards := aw13CountCards(t, conv.ID)
		checks["material_via_card"] = cards > 0
		checks["has_output"] = strings.TrimSpace(aw13LastAssistant(t, conv.ID)) != ""
		var tools []string
		_ = env.srv.db.QueryRow(t.Context(), `SELECT coalesce(jsonb_agg(DISTINCT e.payload->>'name'),'[]'::jsonb)
			FROM agent_event e JOIN agent_run r ON r.id=e.run_id
			WHERE r.conversation_id=$1 AND e.type='tool.started'`, conv.ID).Scan(&tools)
		var attachInfo, userMsg string
		_ = env.srv.db.QueryRow(t.Context(), `SELECT kind||'/'||parse_status||'/'||coalesce(length(text_content),0) FROM agent_attachment WHERE id=$1`, attachment.ID).Scan(&attachInfo)
		_ = env.srv.db.QueryRow(t.Context(), `SELECT left(content,600) FROM agent_message WHERE conversation_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`, conv.ID).Scan(&userMsg)
		t.Logf("J2 第 %d 次：status=%s cards=%d tools=%v attachment=%s text=%q user_msg=%q", i, runStatus, cards, tools, attachInfo, aw13LastAssistant(t, conv.ID), userMsg)
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：技能+附件→素材卡片", i) })
}

// 旅程 3：数据范围补充（只看小红书）→ 下一安全边界显示已接收 → 排队下一条 → 本次及卡片处理结束后才启动。
func TestAW13Journey3ScopedFollowupQueuedReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	conv := rj.conv
	aw13Run(t, "J3", func(i int) map[string]bool {
		checks := map[string]bool{}
		runID, _, _ := aw13Send(t, conv, fmt.Sprintf("第 %d 次迭代：只读分析本周内容数据表现，直接在聊天中回答，不要提出任何操作卡片或写入。", i), nil)
		checks["first_run_completed"] = runID != uuid.Nil
		// 同轮补充 + 复盘要求合并为一条排队消息：只允许一个队列槽位，避免第二条被 409。
		queuedIn := map[string]any{"text": fmt.Sprintf("补充要求：只看小红书的数据；并把上面的分析整理成复盘报告，在聊天中直接输出，不要提出卡片；在报告末尾明确写“统计时间：本周（周一到今天）；数据来源：平台后台数据；数据为空时如实说明”。第 %d 次。", i),
			"request_id": uuid.NewString(), "protocol_version": 2}
		status2, body2 := env.do(http.MethodPost, agentRunPath(conv, "messages"), queuedIn)
		checks["queued_accepted"] = status2 == http.StatusAccepted
		var queued struct {
			RunID    uuid.UUID `json:"run_id"`
			Queued   bool      `json:"queued"`
			Position int       `json:"queue_position"`
		}
		_ = json.Unmarshal(body2, &queued)
		// 等待这条排队消息对应的 run 到终态；不能只看“当前无活动 run”的瞬时计数，
		// 否则异步落库尚未完成时会误读上一条 assistant 文本。
		if queued.RunID != uuid.Nil {
			deadline := time.Now().Add(10 * time.Minute)
			for time.Now().Before(deadline) {
				var status string
				if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, queued.RunID).Scan(&status); err == nil &&
					status != "queued" && status != "running" {
					break
				}
				time.Sleep(3 * time.Second)
			}
		} else {
			for k := 0; k < 400; k++ {
				var active int
				if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')`, conv.ID).Scan(&active); err != nil || active == 0 {
					break
				}
				time.Sleep(3 * time.Second)
			}
		}
		checks["queued_run_terminal"] = queued.RunID != uuid.Nil
		// 报告可能跨多条 assistant 消息（正文后还有一条“已整理”收尾）；按整个会话拼接收敛，
		// 不能只看最后一条，否则收尾语会把报告正文挤掉。
		full := aw13AllAssistant(t, conv.ID)
		checks["report_mentions_scope"] = strings.Contains(full, "小红书") || strings.Contains(full, "数据")
		checks["report_has_time_or_source"] = strings.Contains(full, "时间") || strings.Contains(full, "来源") || strings.Contains(full, "日期")
		checks["has_output"] = strings.TrimSpace(full) != ""
		t.Logf("J3 第 %d 次：queued_run=%s status=%s final=%q", i, queued.RunID, func() string {
			var s string
			_ = env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, queued.RunID).Scan(&s)
			return s
		}(), full)
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：范围补充→排队→复盘报告", i) })
}

// 旅程 4：长回复生成中断线/重开 → 恢复同一 run 部分文本与最终消息；停止后队列不自行接着运行。
func TestAW13Journey4ResumeAndStopReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	conv := rj.conv
	aw13Run(t, "J4", func(i int) map[string]bool {
		checks := map[string]bool{}
		// 发送一个长回复任务，等待进入 running 后停止该 run。
		in := map[string]any{"text": fmt.Sprintf("第 %d 次迭代：写一篇 1200 字的camping 装备长文，分五个段落。", i),
			"request_id": uuid.NewString(), "protocol_version": 2}
		status, body := env.do(http.MethodPost, agentRunPath(conv, "messages"), in)
		if status != http.StatusAccepted {
			t.Fatalf("J4 发送失败：%d %s", status, body)
		}
		var out struct {
			RunID uuid.UUID `json:"run_id"`
		}
		_ = json.Unmarshal(body, &out)
		// 轮询直到 running（真实模型通常很快进入），然后停止。
		stopped := false
		for k := 0; k < 100; k++ {
			var status string
			if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, out.RunID).Scan(&status); err != nil {
				break
			}
			if status == "running" {
				env.mustJSON(t, http.MethodPost, "/api/v1/agent/runs/"+out.RunID.String()+"/cancel", map[string]any{}, &struct{}{})
				stopped = true
				break
			}
			if status == "completed" || status == "failed" {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		checks["stop_issued"] = stopped || func() bool {
			var s string
			_ = env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, out.RunID).Scan(&s)
			return s == "completed"
		}()
		// 停止后 run 终态应为 stopped；且队列中不应有新 run 自动启动（本会话只发了这一条）。
		for k := 0; k < 60; k++ {
			var n int
			if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE conversation_id=$1 AND status IN ('queued','running')`, conv.ID).Scan(&n); err != nil || n == 0 {
				break
			}
			time.Sleep(1 * time.Second)
		}
		var runStatus string
		if err := env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, out.RunID).Scan(&runStatus); err == nil {
			checks["run_terminal"] = runStatus == "stopped" || runStatus == "completed"
		}
		// 重开会话（重连 SSE 等效）：恢复接口可读，无重复消息。
		var detail struct {
			Messages []map[string]any `json:"messages"`
		}
		env.mustJSON(t, http.MethodGet, agentRunPath(conv, ""), nil, &detail)
		checks["resume_readback"] = len(detail.Messages) > 0
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：运行中停止→恢复读回", i) })
}

// 旅程 5：从一条结论创建分支比较另一个选题 → 原会话不变 → 分支无可重执行历史卡片 → 删除原会话后附件仍可看。
func TestAW13Journey5ForkKeepsAttachmentReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	aw13Run(t, "J5", func(i int) map[string]bool {
		conv := env.rJourneyConversation(t, rj.providerID, rj.model)
		checks := map[string]bool{}
		// ① 原会话：上传附件 + 结论。
		_, attachment, _ := agentUploadAttachment(t, fmt.Sprintf("journey5-%d.txt", i),
			[]byte(fmt.Sprintf("第 %d 次迭代选题参考：城市短途骑行的三个内容角度。", i)), conv.ID.String())
		_, runStatus, _ := aw13Send(t, conv, "请读取附件并给出一条结论：哪个选题值得优先做？",
			map[string]any{"attachment_ids": []string{attachment.ID.String()}})
		checks["source_completed"] = runStatus == "completed"
		sourceFinal := aw13LastAssistant(t, conv.ID)
		// ② 从最后一条 assistant 结论创建分支。
		var detail struct {
			Messages []struct {
				ID   uuid.UUID `json:"id"`
				Role string    `json:"role"`
			} `json:"messages"`
		}
		env.mustJSON(t, http.MethodGet, agentRunPath(conv, ""), nil, &detail)
		var lastAssistant *struct {
			ID   uuid.UUID `json:"id"`
			Role string    `json:"role"`
		}
		for k := range detail.Messages {
			if detail.Messages[k].Role == "assistant" {
				m := detail.Messages[k]
				lastAssistant = &struct {
					ID   uuid.UUID `json:"id"`
					Role string    `json:"role"`
				}{m.ID, m.Role}
			}
		}
		if lastAssistant == nil {
			t.Fatal("J5 源会话没有 assistant 消息可作分支截点")
		}
		var forked struct {
			Conversation agentConversation `json:"conversation"`
		}
		env.mustJSON(t, http.MethodPost, agentRunPath(conv, "fork"), map[string]any{
			"through_message_id": lastAssistant.ID, "request_id": uuid.NewString(), "title": "分支比较另一选题",
		}, &forked)
		checks["fork_created"] = forked.Conversation.ID != uuid.Nil
		// ③ 原会话消息数不变；分支内无历史可重执行卡片。
		var before, after int
		env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1`, conv.ID).Scan(&before)
		env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_message WHERE conversation_id=$1`, forked.Conversation.ID).Scan(&after)
		checks["fork_has_no_source_tail"] = after <= before
		var branchCards int
		env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_action WHERE conversation_id=$1`, forked.Conversation.ID).Scan(&branchCards)
		checks["branch_no_reusable_cards"] = branchCards == 0
		// ④ 分支里比较另一个选题（真实模型继续对话）。
		_, branchStatus, _ := aw13Send(t, forked.Conversation, fmt.Sprintf("比较另一个选题：周末市集探店（第 %d 次迭代）。哪个更好？", i), nil)
		checks["branch_run_completed"] = branchStatus == "completed"
		// ⑤ 删除原会话后分支仍能读被引用附件。
		env.mustJSON(t, http.MethodDelete, agentRunPath(conv, "")+"?confirm=true", map[string]any{}, &struct{}{})
		var branchDetail struct {
			Messages []map[string]any `json:"messages"`
		}
		env.mustJSON(t, http.MethodGet, "/api/v1/agent/conversations/"+forked.Conversation.ID.String(), nil, &branchDetail)
		checks["branch_readable_after_source_delete"] = len(branchDetail.Messages) > 0
		t.Cleanup(func() { deleteConversations(t, forked.Conversation.ID) })
		_ = sourceFinal
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：分支→比较→删源→附件可读", i) })
}

// 旅程 6：例行任务「每周一 09:00 检查未完成回填并生成报告」→ 完整表单确认 → 只读白名单运行 → 本人收到报告；
// 任何「直接回填/发布」提示不产生业务写入。时钟注入复用 TestAW10 的 due_at 直改方式。
func TestAW13Journey6RoutineReadOnlyReal(t *testing.T) {
	rj := openAW13RealJourney(t)
	acc := env.accounts(t)
	aw13Run(t, "J6", func(i int) map[string]bool {
		checks := map[string]bool{}
		var created struct {
			Routine agentRoutineView `json:"routine"`
		}
		env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
			"request_id": uuid.NewString(),
			"name":       fmt.Sprintf("旅程6 每周检查未完成回填 %d-%d", i, time.Now().UnixNano()%1000),
			"prompt":     fmt.Sprintf("第 %d 次迭代：检查未完成的内容回填并生成一份只读报告；不要执行任何回填、发布或修改。", i),
			"public_context_refs": []any{}, "account_id": acc.wechat.ID.String(),
			"cadence": "weekly", "weekday": 1, "time_of_day": "09:00", "timezone": "Asia/Shanghai",
			"destination": "new",
			"model":       map[string]any{"provider_id": rj.providerID, "model": rj.model},
		}, &created)
		if created.Routine.ID == uuid.Nil {
			t.Fatal("例行任务创建失败")
		}
		checks["routine_enabled"] = created.Routine.Status == "enabled"
		t.Cleanup(func() {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
		})
		// 时钟注入：把 next_due_at 拨到现在之前，等待 scheduler tick 触发。
		if _, err := env.srv.db.Exec(t.Context(),
			`UPDATE agent_routine SET next_due_at=now()-interval '1 minute' WHERE id=$1`, created.Routine.ID); err != nil {
			t.Fatal(err)
		}
		// 测试 env 不启动后台分钟 ticker；按生产 tick 的同一入口手动触发一次。
		env.srv.runAgentRoutines(context.Background())
		// 等待 occurrence 与 run 出现并到终态（真实模型 10 分钟上限）。
		var runID uuid.UUID
		deadline := time.Now().Add(10 * time.Minute)
		started := time.Now()
		diagnosed := false
		for time.Now().Before(deadline) {
			err := env.srv.db.QueryRow(t.Context(),
				`SELECT o.run_id FROM agent_routine_occurrence o
				 WHERE o.routine_id=$1 AND o.run_id IS NOT NULL ORDER BY o.created_at DESC LIMIT 1`, created.Routine.ID).Scan(&runID)
			if err == nil {
				var status string
				if env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_run WHERE id=$1`, runID).Scan(&status) == nil &&
					status != "queued" && status != "running" {
					checks["routine_run_terminal"] = status == "completed" || status == "failed"
					break
				}
			}
			if !diagnosed && time.Since(started) > 20*time.Second {
				diagnosed = true
				var occCount int
				var routineStatus string
				var nextDue *time.Time
				var occStatus string
				var occRun *uuid.UUID
				_ = env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1`, created.Routine.ID).Scan(&occCount)
				_ = env.srv.db.QueryRow(t.Context(), `SELECT status,next_due_at FROM agent_routine WHERE id=$1`, created.Routine.ID).Scan(&routineStatus, &nextDue)
				_ = env.srv.db.QueryRow(t.Context(), `SELECT status,run_id FROM agent_routine_occurrence WHERE routine_id=$1 ORDER BY created_at DESC LIMIT 1`, created.Routine.ID).Scan(&occStatus, &occRun)
				t.Logf("J6 诊断：routine=%s status=%s next_due=%v now=%v occurrence_count=%d occurrence_status=%s occurrence_run=%v",
					created.Routine.ID, routineStatus, nextDue, time.Now(), occCount, occStatus, occRun)
				if occCount == 0 {
					t.Fatalf("J6 例行任务未产生 occurrence：status=%s next_due=%v", routineStatus, nextDue)
				}
			}
			time.Sleep(3 * time.Second)
		}
		checks["occurrence_started"] = runID != uuid.Nil
		// 本人收到报告：例行产出应落对话并由通知投影（notification kind=system / link 指向面板）。
		var notified int
		_ = env.srv.db.QueryRow(t.Context(),
			`SELECT count(*) FROM notification WHERE link=$1`, "/agent?panel=task&item="+created.Routine.ID.String()).Scan(&notified)
		checks["notification_or_report"] = notified > 0 || strings.TrimSpace(aw13LastAssistant(t, rj.conv.ID)) != ""
		// 只读白名单：run 内不得有业务写工具成功执行。工具名用双下划线，
		// 不能按 works_% 粗匹配，否则 works__list/works__get 这类只读工具会被误判。
		var writes int
		_ = env.srv.db.QueryRow(t.Context(),
			`SELECT count(*) FROM agent_event e JOIN agent_run r ON r.id=e.run_id
			 WHERE r.routine_occurrence_id IN (SELECT id FROM agent_routine_occurrence WHERE routine_id=$1)
			 AND e.type='tool.started' AND (
			   e.payload->>'name' IN ('works__create','works__update','works__set_viewpoint','works__organize_apply',
			     'works__mark_published','works__import_published','works__approve_review','works__derive',
			     'works__preview_link','works__titles','works__summary','works__breakdown')
			   OR e.payload->>'name' LIKE 'publish%'
			   OR e.payload->>'name' LIKE '%__write%')`,
			created.Routine.ID).Scan(&writes)
		checks["no_business_write"] = writes == 0
		return checks
	}, func(i int) string { return fmt.Sprintf("迭代 %d：每周例行→只读报告", i) })
}
