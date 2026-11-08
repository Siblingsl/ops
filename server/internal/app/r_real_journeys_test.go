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

// DEV-AI27 R01~R05 运营任务真实旅程（27 文档 §9.7/§16.4）。
// 门控：OPS_R_REAL_ACCEPTANCE=1 时执行，默认 skip（不虚报；mock 通过不算真实验证）。
// 环境要求：本地 ops 库已配置支持工具调用的真实供应商（agent_chat 路由），
// API Key 只存本机模型配置库（不进代码/日志/测试数据/证据）。
// 通过标准（§16.4）：真实来源→可回查证据→报告（固定字段契约成立）→逐项采用；每场景 ≥3 次。
// 每个 R 场景的执行结果写入 OPS_R_REAL_OUTPUT 目录（JSONL，含请求耗时/用量/报告字段校验结果）。

type rJourneyEnv struct {
	providerID string
	conv       agentConversation
	t          *testing.T
}

func openRealRJourney(t *testing.T) *rJourneyEnv {
	t.Helper()
	if os.Getenv("OPS_R_REAL_ACCEPTANCE") != "1" {
		t.Skip("R 系列真实旅程需显式设置 OPS_R_REAL_ACCEPTANCE=1（真实模型会产生费用）")
	}
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv,
		"workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines,document_parse,chrome_connect,browser_workspace")
	if st, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); st != 200 {
		t.Fatalf("R 旅程恢复 owner 会话失败：%d %s", st, body)
	}
	env.csrf = env.me(t).CSRF
	// 真实供应商：取 agent_chat 路由且非模拟模型的供应商。
	providerID := os.Getenv("OPS_R_REAL_PROVIDER_ID")
	if providerID == "" {
		var id string
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT p.id::text FROM model_provider p JOIN model_route r ON r.provider_id=p.id
			 WHERE p.workspace_id=$1 AND p.status='active' AND p.execution_location='server'
			   AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'
			 ORDER BY p.created_at DESC LIMIT 1`,
			env.me(t).Workspace.ID).Scan(&id); err != nil {
			t.Fatal("未找到已配置的真实供应商（agent_chat 路由）；请先在模型配置页添加真实供应商并完成自检")
		}
		providerID = id
	}
	conv := env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	return &rJourneyEnv{providerID: providerID, conv: conv, t: t}
}

// runRJourney 发送任务文本并等待 run 完成，返回 assistant 最终文本与产生的 evidence 引用。
func (rj *rJourneyEnv) runRJourney(label, task string) (string, []map[string]any) {
	t := rj.t
	requestID := uuid.NewString()
	status, body := env.do("POST", "/api/v1/agent/conversations/"+rj.conv.ID.String()+"/messages", map[string]any{
		"request_id": requestID, "text": task, "protocol_version": 2,
		"model": map[string]any{"provider_id": rj.providerID, "model": ""},
	})
	if status != http.StatusAccepted {
		t.Fatalf("%s 发送失败：%d %s", label, status, body)
	}
	// 轮询 run 终态（真实模型最长 10 分钟）。
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		var detail struct {
			ActiveRun *struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			} `json:"active_run"`
		}
		env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+rj.conv.ID.String(), map[string]any{}, &detail)
		if detail.ActiveRun == nil {
			break
		}
		time.Sleep(3 * time.Second)
	}
	// 取 assistant 最终消息。
	var detail struct {
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
			RunID   string `json:"run_id"`
		} `json:"messages"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/conversations/"+rj.conv.ID.String(), map[string]any{}, &detail)
	final := ""
	for i := len(detail.Messages) - 1; i >= 0; i-- {
		if detail.Messages[i].Role == "assistant" && strings.TrimSpace(detail.Messages[i].Content) != "" {
			final = detail.Messages[i].Content
			break
		}
	}
	// 收集本会话浏览器证据（真实来源引用）。
	var evidence struct {
		Evidence []map[string]any `json:"evidence"`
	}
	env.mustJSON(t, "GET", "/api/v1/agent/browser/evidence?conversation_id="+rj.conv.ID.String(), map[string]any{}, &evidence)
	return final, evidence.Evidence
}

// recordRJourney 把单次旅程结果写入证据目录（JSONL）。
func recordRJourney(t *testing.T, scenario string, iteration int, finalText string, evidenceCount int, fieldChecks map[string]bool) {
	t.Helper()
	outDir := os.Getenv("OPS_R_REAL_OUTPUT")
	if outDir == "" {
		return
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatalf("证据目录不可写：%v", err)
	}
	record := map[string]any{
		"scenario": scenario, "iteration": iteration,
		"final_text_head": finalText, "final_text_len": len([]rune(finalText)),
		"evidence_count": evidenceCount, "field_checks": fieldChecks,
		"at": time.Now().UTC().Format(time.RFC3339),
	}
	line, _ := json.Marshal(record)
	f, err := os.OpenFile(outDir+"/r-journeys.jsonl", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("证据文件不可写：%v", err)
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

// assertRReportFields 校验 §9.7 报告固定字段在最终文本中的契约表现（complete 场景）。
func assertRReportFields(label, finalText string, required []string) map[string]bool {
	checks := map[string]bool{}
	for _, field := range required {
		checks[field] = strings.Contains(strings.ToLower(finalText), strings.ToLower(field))
	}
	return checks
}

// 通用：三次迭代的真实旅程骨架。
func (rj *rJourneyEnv) runThreeTimes(label string, taskFn func(i int) string, requiredFields []string) {
	t := rj.t
	for i := 1; i <= 3; i++ {
		final, evidence := rj.runRJourney(label, taskFn(i))
		if strings.TrimSpace(final) == "" {
			t.Fatalf("%s 第 %d 次无 assistant 输出", label, i)
		}
		checks := assertRReportFields(label, final, requiredFields)
		recordRJourney(t, label, i, final, len(evidence), checks)
		t.Logf("%s 第 %d 次完成：输出 %d 字，证据 %d 条", label, i, len([]rune(final)), len(evidence))
	}
}

// R01 竞品研究并整理素材（§9.7）：真实来源→对照→素材候选；逐张保存走原卡片（不自动入库）。
func TestR01CompetitorResearchReal(t *testing.T) {
	rj := openRealRJourney(t)
	rj.runThreeTimes("R01", func(i int) string {
		return fmt.Sprintf("请做一次竞品内容研究：选一个公开的内容平台账号或专栏（真实存在、可公开访问），"+
			"读取其最近 3 篇公开内容，比较主题选择、结构与表达方式、互动线索（第 %d 次迭代，请换一个此前未用过的来源）。"+
			"输出：①竞品对照（每条附来源 URL 与读取时间）；②可借鉴点与不可照搬项（分开列出）；"+
			"③每条结论标注来源片段。不要直接写入任何素材库。", i)
	}, []string{"来源", "http", "借鉴"})
}

// R02 本人后台账号分析（§9.7）：授权后台→读取→分析。需要用户已在 Chrome 登录后台并完成扩展授权。
func TestR02AccountAnalysisReal(t *testing.T) {
	rj := openRealRJourney(t)
	if os.Getenv("OPS_R_REAL_BACKDROP") != "1" {
		t.Skip("R02 需用户已在 Chrome 登录后台并授权标签（OPS_R_REAL_BACKDROP=1）")
	}
	rj.runThreeTimes("R02", func(i int) string {
		return fmt.Sprintf("请分析我当前授权的账号后台页面（第 %d 次迭代，请切换不同的时间范围）："+
			"读取可见的账号表现数据，核对图表与单位，输出：①账号表现（每条数字附页面来源与读取时间）；"+
			"②数据缺失项（如实标 missing，不补零）；③行动建议（不执行任何发布或修改）。", i)
	}, []string{"读取", "来源"})
}

// R03 网页资料改稿（§9.7）：读授权资料→区分事实/建议→新版本→对照→逐段理由→来源回链。
func TestR03RewriteFromWebReal(t *testing.T) {
	rj := openRealRJourney(t)
	rj.runThreeTimes("R03", func(i int) string {
		return fmt.Sprintf("请根据公开网页资料改写一篇短文（第 %d 次迭代，请换一个资料来源）："+
			"读取一篇真实公开网页，区分其中的事实与观点，产出新版本文稿：①差异对照表；②逐段修改理由；"+
			"③每处修改附来源回链。不执行任何作品写入。", i)
	}, []string{"来源", "对照"})
}

// R04 热门话题与作品分析（§9.7）：检索/榜单→记录排序与时点→明确页面可见样本。
func TestR04TopicAnalysisReal(t *testing.T) {
	rj := openRealRJourney(t)
	rj.runThreeTimes("R04", func(i int) string {
		return fmt.Sprintf("请做一次热门话题分析（第 %d 次迭代，请换一个领域或榜单来源）："+
			"基于真实可公开访问的榜单/检索页，记录实际排序与观察时点（页面可见样本，不代表全平台），"+
			"输出：①热点线索（每条附来源与时点）；②共性/差异；③时效与适用账号类型。", i)
	}, []string{"来源", "时点"})
}

// R05 商品与内容机会分析（§9.7）：商品/类目资料→卖点/人群→机会点；未读取的销量不估成事实。
func TestR05ProductOpportunityReal(t *testing.T) {
	rj := openRealRJourney(t)
	rj.runThreeTimes("R05", func(i int) string {
		return fmt.Sprintf("请做一次商品内容机会分析（第 %d 次迭代，请换一个商品或类目）："+
			"读取真实公开的商品页资料，比较卖点/价格/人群/内容角度，输出：①商品对照（价格/货币/观测时间）；"+
			"②证据与内容机会点；③未读取的销量/转化等数据如实标缺失，不得估算成事实。", i)
	}, []string{"价格", "证据"})
}
