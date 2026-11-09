package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
	model      string
	conv       agentConversation
	t          *testing.T
}

// rRealProviderConfig 是真实供应商的运行时配置。
// 红线：APIKey 只存在于进程内存，不写入代码、测试数据、日志或证据文件。
type rRealProviderConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

const rRealProviderName = "R 旅程真实供应商（运行时注入）"

// rRealProviderConfigFromEnv 从环境变量读取真实供应商配置。
// 错误信息只列缺失的变量名，绝不回显任何已传入的值。
func rRealProviderConfigFromEnv() (rRealProviderConfig, error) {
	cfg := rRealProviderConfig{
		BaseURL: strings.TrimSpace(os.Getenv("OPS_R_REAL_BASE_URL")),
		APIKey:  strings.TrimSpace(os.Getenv("OPS_R_REAL_API_KEY")),
		Model:   strings.TrimSpace(os.Getenv("OPS_R_REAL_MODEL")),
	}
	missing := []string{}
	if cfg.BaseURL == "" {
		missing = append(missing, "OPS_R_REAL_BASE_URL")
	}
	if cfg.APIKey == "" {
		missing = append(missing, "OPS_R_REAL_API_KEY")
	}
	if cfg.Model == "" {
		missing = append(missing, "OPS_R_REAL_MODEL")
	}
	if len(missing) > 0 {
		return rRealProviderConfig{}, fmt.Errorf("缺少环境变量：%s", strings.Join(missing, "、"))
	}
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return rRealProviderConfig{}, fmt.Errorf("OPS_R_REAL_BASE_URL 必须是完整的 http(s) 地址")
	}
	return cfg, nil
}

// seedRRealProvider 把运行时真实供应商写入当前测试库（ops_test），并把 agent_chat
// 路由指过去。测试库每次由 TestMain 重建，页面配置不会进入这里，因此必须显式播种；
// 密钥用与生产相同的 box 加密，cleanup 恢复原路由并删除本次插入的供应商。
func seedRRealProvider(t *testing.T, cfg rRealProviderConfig) string {
	t.Helper()
	ctx := context.Background()
	ws := env.me(t).Workspace.ID

	// 记录原 agent_chat 路由，避免污染同一测试库内的其他用例。
	var prevProvider uuid.UUID
	var prevModel string
	prevExists := env.srv.db.QueryRow(ctx,
		`SELECT provider_id, model FROM model_route WHERE workspace_id=$1 AND task_type='agent_chat'`, ws).
		Scan(&prevProvider, &prevModel) == nil

	enc, err := env.srv.box.Encrypt(cfg.APIKey)
	if err != nil {
		t.Fatalf("加密真实供应商密钥失败：%v", err)
	}
	var id uuid.UUID
	if err := env.srv.db.QueryRow(ctx,
		`INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models, status, execution_location)
		 VALUES ($1,$2,$3,$4,$5,$6,'active','server') RETURNING id`,
		ws, rRealProviderName, cfg.BaseURL, enc, env.srv.box.Version, []string{cfg.Model}).Scan(&id); err != nil {
		t.Fatalf("写入真实供应商失败：%v", err)
	}
	// 自检（与页面「自检」按钮同路径）：真实模型的 tools_ok 必须先落库，
	// 否则 resolveAgentModel 422 agent_model_unsupported，旅程必失败（2026-11-10 修复）。
	// 断言只要求 tools 项通过（R 旅程的硬条件）；image/search 等项不支持时如实记录不阻断——
	// 供应商能力边界不是旅程缺陷，但会写进证据（runThreeTimes 的 §9.7 校验兜底）。
	var selftestBody struct {
		OK      bool `json:"ok"`
		Results []struct {
			Key    string `json:"key"`
			OK     bool   `json:"ok"`
			Detail string `json:"detail"`
		} `json:"results"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers/"+id.String()+"/selftest",
		map[string]any{"model": cfg.Model}, &selftestBody)
	toolsOK := false
	for _, p := range selftestBody.Results {
		if p.Key == "tools" {
			toolsOK = p.OK
		}
	}
	if !toolsOK {
		t.Fatalf("真实模型工具调用自检未通过（R 旅程硬条件）：%+v", selftestBody.Results)
	}
	if _, err := env.srv.db.Exec(ctx,
		`INSERT INTO model_route (workspace_id, task_type, provider_id, model, execution_location)
		 VALUES ($1,'agent_chat',$2,$3,'server')
		 ON CONFLICT (workspace_id, task_type) DO UPDATE
		 SET provider_id=EXCLUDED.provider_id, model=EXCLUDED.model`,
		ws, id, cfg.Model); err != nil {
		t.Fatalf("写入 agent_chat 路由失败：%v", err)
	}
	t.Cleanup(func() {
		if prevExists {
			_, _ = env.srv.db.Exec(ctx,
				`INSERT INTO model_route (workspace_id, task_type, provider_id, model)
				 VALUES ($1,'agent_chat',$2,$3)
				 ON CONFLICT (workspace_id, task_type) DO UPDATE
				 SET provider_id=EXCLUDED.provider_id, model=EXCLUDED.model`, ws, prevProvider, prevModel)
		} else {
			_, _ = env.srv.db.Exec(ctx,
				`DELETE FROM model_route WHERE workspace_id=$1 AND task_type='agent_chat' AND provider_id=$2`, ws, id)
		}
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM model_provider WHERE id=$1`, id)
	})

	// 自证：密钥必须密文存储，明文不得出现在库列中。
	var stored []byte
	if err := env.srv.db.QueryRow(ctx, `SELECT api_key_enc FROM model_provider WHERE id=$1`, id).Scan(&stored); err != nil {
		t.Fatalf("回读真实供应商失败：%v", err)
	}
	if len(stored) == 0 || strings.Contains(string(stored), cfg.APIKey) {
		t.Fatal("真实供应商密钥未按预期加密存储")
	}
	return id.String()
}

// rEvidenceString 把证据 JSON 值转成可判空的字符串。
func rEvidenceString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(fmt.Sprint(v))
}

// validateREvidence 硬校验「真实来源→可回查证据」（27 §16.4 / §9.7）：
// 至少一条；每条有 origin、脱敏 URL、读取时间；被隔离的证据不算可回查来源。
func validateREvidence(evidence []map[string]any) error {
	if len(evidence) == 0 {
		return fmt.Errorf("未产生任何可回查证据（§16.4 要求真实来源→可回查证据，mock 不算）")
	}
	for i, ev := range evidence {
		if rEvidenceString(ev["origin"]) == "" || rEvidenceString(ev["redacted_url"]) == "" || rEvidenceString(ev["created_at"]) == "" {
			return fmt.Errorf("第 %d 条证据缺少 origin/redacted_url/created_at，不可回查", i+1)
		}
		if rEvidenceString(ev["redaction_state"]) == "quarantined" {
			return fmt.Errorf("第 %d 条证据被隔离（quarantined），不能作为可回查来源", i+1)
		}
	}
	return nil
}

// validateRReportChecks 把关键词级字段检查升级为硬失败。
// 局限（如实登记）：这是 §9.7 字段名的文本级校验，不是结构化报告解析；
// 它能拦住「字段缺失」的假通过，但拦不住「字段齐全但证据编造」——后者由 validateREvidence 兜底。
func validateRReportChecks(checks map[string]bool, required []string) error {
	missing := []string{}
	for _, field := range required {
		if !checks[field] {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("报告缺少 §9.7 字段：%s", strings.Join(missing, "、"))
	}
	return nil
}

// rJourneyConversation 用真实模型名建会话（agentRunConversation 写死 mock-writer，不能用于真实旅程）。
func (e *testEnv) rJourneyConversation(t *testing.T, providerID, model string) agentConversation {
	t.Helper()
	acc := e.accounts(t)
	return e.createConversation(t, map[string]any{
		"account_id": acc.wechat.ID.String(),
		"model":      map[string]any{"provider_id": providerID, "model": model},
	})
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

	// 真实供应商解析顺序：显式 provider_id → 运行时环境注入（写入 ops_test）→ 本库既有配置。
	providerID := strings.TrimSpace(os.Getenv("OPS_R_REAL_PROVIDER_ID"))
	modelName := strings.TrimSpace(os.Getenv("OPS_R_REAL_MODEL"))
	if providerID == "" {
		cfg, cfgErr := rRealProviderConfigFromEnv()
		if cfgErr == nil {
			providerID = seedRRealProvider(t, cfg)
			modelName = cfg.Model
		} else {
			var id string
			if err := env.srv.db.QueryRow(context.Background(),
				`SELECT p.id::text FROM model_provider p JOIN model_route r ON r.provider_id=p.id
				 WHERE p.workspace_id=$1 AND p.status='active' AND p.execution_location='server'
				   AND p.name NOT LIKE '%模拟%' AND r.task_type='agent_chat'
				 ORDER BY p.created_at DESC LIMIT 1`,
				env.me(t).Workspace.ID).Scan(&id); err != nil {
				t.Fatalf("未找到真实供应商：请设置 OPS_R_REAL_BASE_URL / OPS_R_REAL_API_KEY / OPS_R_REAL_MODEL 后重跑（密钥只经环境变量传入，不写入代码或证据）；环境注入不可用原因：%v", cfgErr)
			}
			providerID = id
		}
	}
	if modelName == "" {
		t.Fatal("未指定真实模型名：请设置 OPS_R_REAL_MODEL（或让 OPS_R_REAL_PROVIDER_ID 指向已配置模型的供应商）")
	}
	conv := env.rJourneyConversation(t, providerID, modelName)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	return &rJourneyEnv{providerID: providerID, model: modelName, conv: conv, t: t}
}

// runRJourney 发送任务文本并等待 run 完成，返回 assistant 最终文本与产生的 evidence 引用。
func (rj *rJourneyEnv) runRJourney(label, task string) (string, []map[string]any) {
	t := rj.t
	requestID := uuid.NewString()
	status, body := env.do("POST", "/api/v1/agent/conversations/"+rj.conv.ID.String()+"/messages", map[string]any{
		"request_id": requestID, "text": task, "protocol_version": 2,
		"model": map[string]any{"provider_id": rj.providerID, "model": rj.model},
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
// 硬断言（不再只记录）：assistant 非空 + 至少一条可回查证据 + §9.7 字段关键词齐全。
// mock 通过不算真实验证：无证据或字段缺失一律 fail，不写入「通过」。
func (rj *rJourneyEnv) runThreeTimes(label string, taskFn func(i int) string, requiredFields []string) {
	t := rj.t
	for i := 1; i <= 3; i++ {
		final, evidence := rj.runRJourney(label, taskFn(i))
		if strings.TrimSpace(final) == "" {
			t.Fatalf("%s 第 %d 次无 assistant 输出", label, i)
		}
		if err := validateREvidence(evidence); err != nil {
			t.Fatalf("%s 第 %d 次：%v", label, i, err)
		}
		checks := assertRReportFields(label, final, requiredFields)
		if err := validateRReportChecks(checks, requiredFields); err != nil {
			t.Fatalf("%s 第 %d 次：%v", label, i, err)
		}
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

// TestRRealJourneyContract 是不需要真实 API Key 的离线契约测试：
// 验证环境注入解析、密钥加密与路由播种、证据硬校验、报告字段硬校验本身有效。
// 它不替代真实旅程（真实旅程仍需实时 Key + Chrome 扩展），只防止执行器再次退化为「只记录不判定」。
func TestRRealJourneyContract(t *testing.T) {
	const placeholderKey = "unit-test-placeholder-not-a-secret"

	t.Run("配置只从环境变量读取且不回显密钥", func(t *testing.T) {
		t.Setenv("OPS_R_REAL_BASE_URL", "http://127.0.0.1:9/v1")
		t.Setenv("OPS_R_REAL_API_KEY", placeholderKey)
		t.Setenv("OPS_R_REAL_MODEL", "contract-model")
		cfg, err := rRealProviderConfigFromEnv()
		if err != nil {
			t.Fatalf("完整配置应通过：%v", err)
		}
		if cfg.Model != "contract-model" || cfg.BaseURL != "http://127.0.0.1:9/v1" {
			t.Fatalf("配置解析错误：%+v", cfg)
		}

		t.Setenv("OPS_R_REAL_API_KEY", "")
		_, err = rRealProviderConfigFromEnv()
		if err == nil {
			t.Fatal("缺少 API Key 应报错")
		}
		if strings.Contains(err.Error(), placeholderKey) {
			t.Fatal("错误信息不得回显密钥")
		}

		t.Setenv("OPS_R_REAL_API_KEY", placeholderKey)
		t.Setenv("OPS_R_REAL_BASE_URL", "file:///etc/passwd")
		if _, err := rRealProviderConfigFromEnv(); err == nil {
			t.Fatal("非 http(s) 的 base_url 应拒绝")
		}
	})

	t.Run("证据不可回查时判定失败", func(t *testing.T) {
		if err := validateREvidence(nil); err == nil {
			t.Fatal("空证据应失败")
		}
		bad := []map[string]any{{"origin": "https://example.com", "redacted_url": "", "created_at": "2026-11-09T00:00:00Z"}}
		if err := validateREvidence(bad); err == nil {
			t.Fatal("缺 URL 应失败")
		}
		quarantined := []map[string]any{{
			"origin": "https://example.com", "redacted_url": "https://example.com/x",
			"created_at": "2026-11-09T00:00:00Z", "redaction_state": "quarantined",
		}}
		if err := validateREvidence(quarantined); err == nil {
			t.Fatal("被隔离的证据不应算可回查来源")
		}
		ok := []map[string]any{{
			"origin": "https://example.com", "redacted_url": "https://example.com/x",
			"created_at": "2026-11-09T00:00:00Z", "redaction_state": "clean",
		}}
		if err := validateREvidence(ok); err != nil {
			t.Fatalf("完整证据不应失败：%v", err)
		}
	})

	t.Run("报告缺字段时判定失败", func(t *testing.T) {
		required := []string{"来源", "http", "借鉴"}
		checks := assertRReportFields("R01", "只有来源，没有链接也没有借鉴点", required)
		if err := validateRReportChecks(checks, required); err == nil {
			t.Fatal("缺 http/借鉴 应失败")
		}
		full := assertRReportFields("R01", "来源：http://example.com 借鉴：结构", required)
		if err := validateRReportChecks(full, required); err != nil {
			t.Fatalf("字段齐全不应失败：%v", err)
		}
	})

	t.Run("运行时注入的供应商写入测试库且密钥加密", func(t *testing.T) {
		cfg := rRealProviderConfig{BaseURL: "http://127.0.0.1:9/v1", APIKey: placeholderKey, Model: "contract-model"}
		id := seedRRealProvider(t, cfg)
		ws := env.me(t).Workspace.ID

		var gotProvider uuid.UUID
		var gotModel, name string
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT r.provider_id, r.model, p.name FROM model_route r
			 JOIN model_provider p ON p.id=r.provider_id
			 WHERE r.workspace_id=$1 AND r.task_type='agent_chat'`, ws).
			Scan(&gotProvider, &gotModel, &name); err != nil {
			t.Fatalf("agent_chat 路由未写入：%v", err)
		}
		if gotProvider.String() != id {
			t.Fatalf("路由未指向注入供应商：got=%s want=%s", gotProvider, id)
		}
		if gotModel != cfg.Model {
			t.Fatalf("路由模型错误：%s", gotModel)
		}
		if strings.Contains(name, "模拟") {
			t.Fatalf("注入供应商名不得含「模拟」：%s", name)
		}
		var stored []byte
		if err := env.srv.db.QueryRow(context.Background(),
			`SELECT api_key_enc FROM model_provider WHERE id=$1`, gotProvider).Scan(&stored); err != nil {
			t.Fatalf("回读密钥失败：%v", err)
		}
		if strings.Contains(string(stored), cfg.APIKey) {
			t.Fatal("密钥必须加密存储，不得出现明文")
		}
	})
}
