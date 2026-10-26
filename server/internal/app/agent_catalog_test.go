package app

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// HC-28（16 文档第 13.1 节）：工具目录静态检查。
// 每个条目对应已注册路由；不存在发表、群发、定时、批量类名称或路径；不存在第 3.7 节黑名单路径；
// confirm、resolution 等系统专属字段不出现在任何工具定义中；全部 /api/v1 路由都已在附录 A 或附录 B 归类。
func TestHC28_AgentToolCatalog(t *testing.T) {
	routes := agentRouteList(env.srv.Router())
	if len(routes) < 200 {
		t.Fatalf("路由清单异常，只读到 %d 条", len(routes))
	}
	if err := validateAgentCatalog(routes); err != nil {
		t.Fatal(err)
	}
}

// 系统专属字段永远不出现在工具定义中，只能来自执行请求（16 文档第 3.5 节）。
func TestHC28_SystemFieldsNotInToolDefs(t *testing.T) {
	systemFields := map[string]bool{
		"confirm": true, "confirm_published": true,
		"overwrite_choice": true, "confirm_over_limit": true,
		"resolution": true, "revision": true, "html": true,
		"html_chars": true, "html_bytes": true,
		"switch": true, "prepare": true,
	}
	for _, tool := range agentCatalog() {
		for _, p := range tool.Params {
			if systemFields[p.Name] {
				t.Errorf("条目 %s 的参数 %s 是系统专属字段，不得出现在工具定义中", tool.Name, p.Name)
			}
		}
	}
}

// 禁用词与黑名单路径的显式断言（与 HC-05、HC-06 的命名约束一致）。
func TestHC28_NoPublishBatchOrBlacklistedPaths(t *testing.T) {
	for _, tool := range agentCatalog() {
		low := strings.ToLower(tool.Name)
		if tool.Name != "notifications__read_all" && agentNameHasWord(low, "all") {
			t.Errorf("条目 %s 名称含禁用词 all", tool.Name)
		}
		for _, tok := range []string{"batch", "schedule", "cron", "timer", "mass", "publish_now"} {
			if strings.Contains(low, tok) {
				t.Errorf("条目 %s 名称含禁用词 %s", tool.Name, tok)
			}
		}
		for _, p := range agentPathPrefixBlacklist {
			if strings.HasPrefix(tool.Path, p) {
				t.Errorf("条目 %s 命中路径前缀黑名单 %s", tool.Name, p)
			}
		}
	}
}

// 第 3.7 节第 8 条：附录 A 与附录 B 合起来覆盖 server.go 注册的全部 /api/v1 路由。
// 本清单是「已归类路由清单」：新增路由未归类时本测试失败，迫使开发者决定其类别。
func TestHC28_RouteClassificationComplete(t *testing.T) {
	classified := agentClassifiedRouteList()
	var missing []string
	for _, r := range agentRouteList(env.srv.Router()) {
		if _, ok := classified[r.Method+" "+r.Path]; !ok {
			missing = append(missing, r.Method+" "+r.Path)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("以下路由未在附录 A、附录 B 或元工具中归类（16 文档第 3.7 节第 8 条）：\n  %s",
			strings.Join(missing, "\n  "))
	}
}

// agentClassifiedRouteList 汇总全部已归类路由：附录 A 的条目、附录 B 的接口、第 3.3 节的元工具与公开接口。
func agentClassifiedRouteList() map[string]string {
	out := map[string]string{}
	for _, tool := range agentCatalog() {
		if tool.Path == "" {
			continue
		}
		out[tool.Method+" /api/v1"+tool.Path] = "附录 A：" + tool.Name
	}
	// 附录 B.1 只给链接。
	for _, r := range []string{
		"PUT /api/v1/accounts/{accountId}/wechat-credential",
		"POST /api/v1/model-providers",
		"POST /api/v1/model-providers/models",
		"PATCH /api/v1/model-providers/{id}",
		"DELETE /api/v1/model-providers/{id}",
		"PUT /api/v1/auth/password",
		"POST /api/v1/auth/reauth",
		"POST /api/v1/exports",
		"POST /api/v1/workspaces/{id}/switch",
		"POST /api/v1/workspaces/join",
		"POST /api/v1/workspaces/current/leave",
		"POST /api/v1/auth/logout",
		"POST /api/v1/admin/workspaces/{id}/enter",
		"POST /api/v1/admin/workspaces/exit",
		"PUT /api/v1/panels/{id}/bubbles",
		"POST /api/v1/sections/{id}/continue",
		"GET /api/v1/works/{id}/copilot",
		"POST /api/v1/works/{id}/copilot",
		"DELETE /api/v1/works/{id}/copilot",
		"GET /api/v1/assets/{id}/file",
		"GET /api/v1/works/{id}/xhs/pack.zip",
		"GET /api/v1/works/{id}/toutiao/pack.zip",
		// DEV-SK1 / 23 文档第 11 节：技能库与绑定配置页面入口；
		// DEV-SK3 将把 skills__* 管理工具列入附录 A（8.3 节），草拟接口随之登记。
		"GET /api/v1/skills",
		"POST /api/v1/skills",
		"POST /api/v1/skills/parse",
		"GET /api/v1/skills/{id}",
		"PUT /api/v1/skills/{id}",
		"DELETE /api/v1/skills/{id}",
		"GET /api/v1/skills/{id}/impact",
		"GET /api/v1/skills/{id}/export",
		"GET /api/v1/accounts/{accountId}/skill-bindings",
		"PUT /api/v1/accounts/{accountId}/skill-bindings/{audience}/{skillId}",
		"GET /api/v1/accounts/{accountId}/skill-context",
		"GET /api/v1/ai-calls/{id}/skill-context",
	} {
		out[r] = "附录 B.1：只给链接"
	}
	// 附录 B.2 不提供。
	for _, r := range []string{
		"GET /api/v1/accounts/{accountId}/data-preferences",
		"GET /api/v1/agent/bootstrap",
		"GET /api/v1/agent/conversations",
		"POST /api/v1/agent/conversations",
		"GET /api/v1/agent/conversations/{id}",
		"PATCH /api/v1/agent/conversations/{id}",
		"DELETE /api/v1/agent/conversations/{id}",
		"GET /api/v1/agent/settings",
		"PUT /api/v1/agent/settings",
		"POST /api/v1/agent/conversations/{id}/messages",
		"POST /api/v1/agent/conversations/{id}/continue",
		"POST /api/v1/agent/conversations/{id}/regenerate",
		"POST /api/v1/agent/conversations/{id}/messages/{messageId}/edit",
		"POST /api/v1/agent/runs/{id}/cancel",
		"POST /api/v1/agent/actions/{id}/execute",
		"POST /api/v1/agent/actions/{id}/reject",
		"POST /api/v1/agent/attachments",
		"GET /api/v1/agent/attachments/{id}/file",
		"DELETE /api/v1/agent/attachments/{id}",
		// DEV-AW03 私有会话组织、阅读标记与正文检索由工作台本人页面调用，不进入模型工具目录。
		"GET /api/v1/agent/conversation-groups",
		"POST /api/v1/agent/conversation-groups",
		"PATCH /api/v1/agent/conversation-groups/{id}",
		"DELETE /api/v1/agent/conversation-groups/{id}",
		"POST /api/v1/agent/conversations/{id}/read",
		"GET /api/v1/agent/conversations/{id}/search",
		// DEV-AW04/AW05 引用与产物接口由本人工作台调用，不进入模型工具目录。
		"GET /api/v1/agent/context-candidates",
		"POST /api/v1/agent/context-preview",
		"GET /api/v1/agent/conversations/{id}/artifacts",
		"GET /api/v1/agent/artifacts/{id}",
		"GET /api/v1/auth/me",
		"POST /api/v1/auth/renew",
		"GET /api/v1/notifications/stream",
		"POST /api/v1/ux-events",
		"POST /api/v1/client-errors",
		"GET /api/v1/works/{id}/presence",
		"POST /api/v1/works/{id}/presence",
		// CK-03/04/06：检查与审阅的人工决策入口，不向智能体开放。
		"POST /api/v1/works/{id}/checks/fact-retry",
		"POST /api/v1/works/{id}/review/return",
		"POST /api/v1/works/{id}/check/exit",
		"GET /api/v1/healthz",
		"GET /healthz",
		"GET /api/v1/auth/status",
		"GET /api/v1/desktop/capabilities",
		"POST /api/v1/desktop/challenges",
		"GET /api/v1/desktop/channel",
		"POST /api/v1/desktop/connections",
		"GET /api/v1/desktop/devices",
		"POST /api/v1/desktop/devices",
		"DELETE /api/v1/desktop/devices/{id}",
		"GET /api/v1/desktop/model-tests/{id}",
		"GET /api/v1/desktop/models",
		"POST /api/v1/desktop/models",
		"DELETE /api/v1/desktop/models/{id}",
		"PUT /api/v1/desktop/models/{id}",
		"POST /api/v1/desktop/models/{id}/test",
		"GET /api/v1/desktop/policy",
		"PUT /api/v1/desktop/policy",
		"GET /api/v1/desktop/routes",
		"PUT /api/v1/desktop/routes",
		// 适配器版本熔断的查看与恢复（20 文档 §12）：恢复要求发布更高 mapping_version
		// 并写审计，属超管运维动作，不能让智能体自行解除熔断。
		"GET /api/v1/admin/platform/breakers",
		"POST /api/v1/admin/platform/breakers/{id}/resolve",
		// D-129 平台采集：设备证明登记与工作区采集策略，同样不向智能体提供。
		"POST /api/v1/desktop/platform/devices",
		"GET /api/v1/platform-collection/policy",
		"PUT /api/v1/platform-collection/policy",
		"GET /api/v1/platform-collection/diagnostics",
		// D-129 平台连接与作品绑定：连接/授权/绑定只能由用户逐条操作，智能体不提供工具。
		"GET /api/v1/accounts/{accountId}/platform-connection",
		"DELETE /api/v1/accounts/{accountId}/platform-connection",
		"PATCH /api/v1/accounts/{accountId}/platform-connection",
		// D-133 平台账号同步与镜像：本人平台内容的读取、关联和建稿由用户在业务页面逐篇操作。
		"POST /api/v1/accounts/{accountId}/platform-account-sync",
		"POST /api/v1/accounts/{accountId}/platform-metrics-refresh",
		"GET /api/v1/accounts/{accountId}/platform-profile",
		"GET /api/v1/accounts/{accountId}/platform-sync-operations",
		"GET /api/v1/accounts/{accountId}/platform-sync-operations/{operationId}",
		"POST /api/v1/accounts/{accountId}/platform-sync-operations/{operationId}/actions",
		"GET /api/v1/accounts/{accountId}/platform-sync-operations/{operationId}/items",
		"GET /api/v1/accounts/{accountId}/platform-works",
		"GET /api/v1/accounts/{accountId}/platform-works/{platformWorkId}",
		"POST /api/v1/accounts/{accountId}/platform-works/{platformWorkId}/draft",
		"GET /api/v1/desktop/platform/connections/mine",
		"DELETE /api/v1/desktop/platform/connections/{id}",
		"PUT /api/v1/works/{id}/platform-binding",
		"DELETE /api/v1/works/{id}/platform-binding",
		// DEV-PS07 平台任务与入站：领取/续租/提交/回执只能由本机证明驱动，智能体不提供工具。
		"POST /api/v1/desktop/platform/connections",
		"POST /api/v1/desktop/platform/connections/{id}/verify",
		"POST /api/v1/desktop/platform/presence",
		"POST /api/v1/desktop/platform/runs/claim",
		"POST /api/v1/desktop/platform/runs/{id}/heartbeat",
		"POST /api/v1/desktop/platform/runs/{id}/results",
		"GET /api/v1/desktop/platform/runs/{id}/receipts/{seq}",
		"POST /api/v1/accounts/{accountId}/platform-sync",
		// DEV-PS08 观测查看与逐条确认：确认只作用于当前一条，智能体不提供批量工具。
		"GET /api/v1/accounts/{accountId}/metrics/observations",
		"POST /api/v1/metrics/observations/{id}/confirm",
		"POST /api/v1/auth/setup",
		"POST /api/v1/auth/register",
		"POST /api/v1/auth/login",
		"GET /api/v1/public-previews/{token}",
		"GET /api/v1/public-previews/{token}/assets/{assetId}",
		// DEV-416 / D-140：创作模板由用户在创建面板维护，内置模板只读；
		// 智能体不提供模板管理工具（避免模型替用户决定结构与语气）。
		"GET /api/v1/creation-templates",
		"POST /api/v1/creation-templates",
		"PUT /api/v1/creation-templates/{id}",
		"DELETE /api/v1/creation-templates/{id}",
		// TP-01：丢掉灵感可撤销，但入口在收件箱，智能体不提供批量整理工具。
		"POST /api/v1/inbox/{id}/restore",
	} {
		out[r] = "附录 B.2：不提供"
	}
	return out
}

// 目录结构不变量：领域、角色、类别、描述长度、命名唯一。
func TestAG04CatalogShape(t *testing.T) {
	knownDomain := map[string]bool{"": true}
	for _, d := range agentDomains {
		knownDomain[d.Name] = true
	}
	validRole := map[Role]bool{roleViewer: true, roleEditor: true, roleOwner: true, roleSystemAdmin: true}
	validKind := map[ToolKind]bool{toolR: true, toolG: true, toolW: true, toolH: true, toolX: true}
	counts := map[string]int{}
	for _, tool := range agentCatalog() {
		counts[tool.Domain]++
		if !knownDomain[tool.Domain] {
			t.Errorf("条目 %s 的领域 %q 不在第 3.3 节的领域表中", tool.Name, tool.Domain)
		}
		if !validRole[tool.MinRole] {
			t.Errorf("条目 %s 的最低角色 %q 无效", tool.Name, tool.MinRole)
		}
		if !validKind[tool.Kind] {
			t.Errorf("条目 %s 的类别 %q 无效", tool.Name, tool.Kind)
		}
		if n := runeLen(tool.Description); n == 0 || n > 200 {
			t.Errorf("条目 %s 的描述长度为 %d，应为 1 至 200", tool.Name, n)
		}
		if tool.ExecTimeout <= 0 {
			t.Errorf("条目 %s 缺少执行超时", tool.Name)
		}
	}
	// 附录 A 共 280 条，加第 3.3 节的 4 个元工具。
	if len(agentCatalog()) != 293 {
		t.Fatalf("目录条目数 %d，期望 293（附录 A 287 条 + 元工具 6 条）", len(agentCatalog()))
	}
	for _, d := range agentDomains {
		if counts[d.Name] == 0 {
			t.Errorf("领域 %s 没有任何条目", d.Name)
		}
	}
}

func TestToutiaoAgentCatalogUsesShapeAndServerFrozenPackageBasis(t *testing.T) {
	param := func(name string, tool *AgentTool) *ToolParam {
		for i := range tool.Params {
			if tool.Params[i].Name == name {
				return &tool.Params[i]
			}
		}
		return nil
	}
	assertEnum := func(t *testing.T, p *ToolParam, want ...string) {
		t.Helper()
		if p == nil {
			t.Fatal("missing tool parameter")
		}
		var schema struct {
			Enum []string `json:"enum"`
		}
		if err := json.Unmarshal(p.Schema, &schema); err != nil {
			t.Fatal(err)
		}
		for _, value := range want {
			if !slices.Contains(schema.Enum, value) {
				t.Errorf("enum %v is missing %q", schema.Enum, value)
			}
		}
	}
	account := agentTool("accounts__create")
	assertEnum(t, param("platform", account), "toutiao")
	assertEnum(t, param("content_format", account), "micro_post", "long_article")
	assertEnum(t, param("content_format", agentTool("works__create")), "micro_post", "long_article")
	assertEnum(t, param("target_content_format", agentTool("works__derive")), "micro_post", "long_article")

	create := agentTool("toutiao__create_pack")
	if create == nil || create.Kind != toolW || create.ProposePreview == nil || create.Project == nil {
		t.Fatal("Toutiao package creation must be a reviewed write with preview and safe projection")
	}
	basis := param("basis_revision", create)
	if basis == nil || basis.Required || basis.Source != "" {
		t.Fatalf("basis_revision must be optional and server-controlled, got %+v", basis)
	}
	get := agentTool("toutiao__get_pack")
	if get == nil || get.Kind != toolR || get.Path != "/works/{id}/toutiao/pack" {
		t.Fatal("Toutiao package view must be a read tool mapped to its platform route")
	}
	queryBasis := param("basis_revision", get)
	if queryBasis == nil || !queryBasis.Required || queryBasis.In != "query" {
		t.Fatalf("package view must require the basis revision query, got %+v", queryBasis)
	}
	share := agentTool("works__preview_link")
	shareBasis := param("basis_revision", share)
	if share.ProposePreview == nil || shareBasis == nil || shareBasis.Required || shareBasis.Source != "" {
		t.Fatal("分享卡片必须由服务端冻结修订号，不能取模型自造值")
	}
	for _, name := range []string{"metrics__create", "metrics__update", "metrics__confirm_screenshot_row"} {
		if param("impressions", agentTool(name)) == nil {
			t.Errorf("%s is missing impressions", name)
		}
	}
	if param("content_format", agentTool("reviews__create")) == nil || param("content_format", agentTool("review__top_works")) == nil {
		t.Fatal("Toutiao review tools must accept a content format")
	}

	projected, ok := projectToutiaoPack(200, []byte(`{"platform":"toutiao","content_format":"micro_post","basis_revision":7,"internal_title":"internal","body_text":"private-body","body_chars":12,"topics":["阅读"],"images":[{"file":"images/01.jpg","url":"/api/v1/private","asset_id":"asset","position":1}]}`)).(map[string]any)
	if !ok || projected["body_text"] != nil || !strings.Contains(agentChangeText(projected["images"]), "images/01.jpg") || strings.Contains(agentChangeText(projected["images"]), "private") {
		t.Fatalf("Toutiao package projection leaked text or protected image URL: %#v", projected)
	}
}

// 第 5.7 节的二次确认方式必须逐条对上。
func TestAG04SecondConfirmMatchesDoc(t *testing.T) {
	want := map[string]string{
		"accounts__delete":          "account_name",
		"workspace__remove_member":  "username",
		"workspace__transfer_owner": "username",
		"admin__patch_user":         "username",
		"admin__reset_password":     "username",
		"admin__revoke_sessions":    "username",
	}
	for _, tool := range agentCatalog() {
		if tool.Kind != toolX {
			continue
		}
		if tool.SecondConfirm == nil {
			t.Errorf("不可逆条目 %s 缺少二次确认", tool.Name)
			continue
		}
		if got := want[tool.Name]; got != tool.SecondConfirm.TypeName {
			t.Errorf("条目 %s 的二次确认类型为 %q，期望 %q", tool.Name, tool.SecondConfirm.TypeName, got)
		}
	}
	for name, typ := range want {
		tool := agentTool(name)
		if tool == nil {
			t.Errorf("目录缺少条目 %s", name)
			continue
		}
		if tool.SecondConfirm == nil || tool.SecondConfirm.TypeName != typ {
			t.Errorf("条目 %s 的二次确认类型不是 %q", name, typ)
		}
	}
}

// 人工确认点条目的 Gate 与类别。
func TestAG04GateEntries(t *testing.T) {
	want := map[string]string{
		"topics__create": "H-01", "hot__convert_match": "H-01", "daily__adopt_item": "H-01",
		"daily__start_item": "H-01", "plan__adopt_slot": "H-01", "inbox__convert_to_topic": "H-01",
		"works__set_viewpoint": "H-02",
		"outline__confirm":     "H-03", "storyboard__confirm": "H-03", "works__organize_apply": "H-03",
		"checks__resolve_item": "H-04", "checks__complete": "H-04",
		"wechat__push":          "H-05",
		"works__mark_published": "H-07", "works__import_published": "H-07",
		"reviews__adopt_suggestion": "H-08",
		"works__approve_review":     "H-09",
		"memory__confirm":           "HC-20", "reviews__remember_insight": "HC-20",
	}
	for name, gate := range want {
		tool := agentTool(name)
		if tool == nil {
			t.Errorf("目录缺少条目 %s", name)
			continue
		}
		if tool.Gate != gate {
			t.Errorf("条目 %s 的门槛为 %q，期望 %q", name, tool.Gate, gate)
		}
		if tool.Kind != toolH {
			t.Errorf("条目 %s 有门槛却不是 H（%s）", name, tool.Kind)
		}
	}
	for _, tool := range agentCatalog() {
		if tool.Gate != "" {
			if _, ok := want[tool.Name]; !ok {
				t.Errorf("条目 %s 带门槛 %s，但不在第 5.6 节的确认点表中", tool.Name, tool.Gate)
			}
		}
	}
}

// 附录 B.3：make_link 只拼接页面表中的路径。
func TestAG04MakeLink(t *testing.T) {
	acc := "11111111-1111-1111-1111-111111111111"
	wk := "22222222-2222-2222-2222-222222222222"
	conv := "33333333-3333-3333-3333-333333333333"
	cases := []struct {
		page string
		id   string // 附录 B.3：settings_* 的 id 为可选
		want string
	}{
		{"workbench", "", "/a/" + acc},
		{"inbox", "", "/a/" + acc + "/topics?tab=inbox"},
		{"work", "", "/works/" + wk},
		{"work_check_report", "", "/works/" + wk + "/check/report"},
		{"agent_conversation", "", "/agent/c/" + conv},
		{"images", "", "/images"},
		{"wechat_backend", "", "https://mp.weixin.qq.com/"},
		{"settings_agent", "", "/settings/agent"},
		{"settings_accounts", acc, "/settings/accounts?id=" + acc},
	}
	for _, c := range cases {
		got, err := agentBuildLink(c.page, acc, wk, conv, "", c.id)
		if err != nil {
			t.Fatalf("make_link %s：%v", c.page, err)
		}
		if got != c.want {
			t.Errorf("make_link %s = %q，期望 %q", c.page, got, c.want)
		}
	}
	got, err := agentBuildLink("search", "", "", "", "秋天的第一杯咖啡", "")
	if err != nil || !strings.HasPrefix(got, "/search?q=") {
		t.Fatalf("make_link search = %q, %v", got, err)
	}
	for _, bad := range []struct{ page, acc, wk, conv, q string }{
		{"", acc, wk, conv, ""},
		{"unknown_page", acc, wk, conv, ""},
		{"workbench", "not-a-uuid", wk, conv, ""},
		{"work", acc, "", conv, ""},
		{"search", acc, wk, conv, ""},
	} {
		if _, err := agentBuildLink(bad.page, bad.acc, bad.wk, bad.conv, bad.q, ""); err == nil {
			t.Errorf("make_link %q 应被拒绝", bad.page)
		}
	}
	if _, err := agentBuildLink("settings_not_a_page", "", "", "", "", ""); err == nil {
		t.Error("make_link 应拒绝页面表中没有的设置页")
	}
}

// 第 9.5 节：脱敏名单与按值匹配。
func TestAG04Redaction(t *testing.T) {
	raw := []byte(`{
		"name": "测试",
		"api_key": "sk-abcdefghijklmnopqrstuvwxyz",
		"key_mask": "sk-****wxyz",
		"app_secret": "wxsecretvalue",
		"temporary_password": "temp-pass-1234",
		"code": "INVITE-CODE-1",
		"nested": {"secret": "inner", "csrf_token": "abc"},
		"items": [{"access_token": "tok"}],
		"smtp": {"host": "smtp.example.com", "password": "p"},
		"error": {"code": "state_invalid", "message": "状态不对"},
		"key_version_enc": "v1"
	}`)
	out := agentRedactJSONBytes(raw, []string{"sk-abcdefghijklmnopqrstuvwxyz"})
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("脱敏结果不是 JSON：%v (%s)", err, out)
	}
	for _, k := range []string{"api_key", "key_mask", "app_secret", "temporary_password", "code", "smtp", "key_version_enc"} {
		if got[k] != agentHidden {
			t.Errorf("键 %s 未被脱敏：%v", k, got[k])
		}
	}
	nested, _ := got["nested"].(map[string]any)
	if nested["secret"] != agentHidden || nested["csrf_token"] != agentHidden {
		t.Errorf("嵌套对象未脱敏：%v", nested)
	}
	items, _ := got["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["access_token"] != agentHidden {
		t.Errorf("数组元素未脱敏：%v", items)
	}
	// 错误信封的 error.code 是错误码，模型需要它。
	errObj, _ := got["error"].(map[string]any)
	if errObj["code"] != "state_invalid" {
		t.Errorf("错误信封的 error.code 被误脱敏：%v", errObj)
	}
	// 按值匹配：明文出现在普通字段时也要替换。
	val := []byte(`{"note": "key is sk-abcdefghijklmnopqrstuvwxyz ok"}`)
	if strings.Contains(string(agentRedactJSONBytes(val, []string{"sk-abcdefghijklmnopqrstuvwxyz"})), "sk-abcdefghijklmnopqrstuvwxyz") {
		t.Error("按值匹配未生效")
	}
	// 疑似密钥检测（第 9.5 节第 5 项）。
	if !agentContainsSecret("这是我的密钥 sk-abcdefghijklmnopqrstuvwxyz", nil) {
		t.Error("sk- 规则未命中")
	}
	if !agentContainsSecret("api key 是 abcdefghijklmnopqrst", nil) {
		t.Error("关键词规则未命中")
	}
	if agentContainsSecret("今天的选题是秋天的第一杯咖啡", nil) {
		t.Error("普通文字被误判为密钥")
	}
	if !agentContainsSecret("原文是 secretvalue1234567890", []string{"secretvalue1234567890"}) {
		t.Error("按值匹配的密钥检测未命中")
	}
}

// 第 3.6 节：作品投影不返回完整正文，read_sections 按 section_ids 返回。
func TestAG04WorkProjection(t *testing.T) {
	body := []byte(`{
		"id": "11111111-1111-1111-1111-111111111111",
		"account_id": "22222222-2222-2222-2222-222222222222",
		"platform": "wechat_mp", "content_format": "long_article",
		"status": "drafting", "title": "标题", "summary": "", "revision": 3, "locked": false,
		"viewpoint": "  ", "outline_confirmed_at": null,
		"sections": [
			{"id": "s1", "heading": "第一节", "content_md": "` + strings.Repeat("正文", 500) + `"},
			{"id": "s2", "heading": "第二节", "content_md": "第二段正文"}
		],
		"assets": [{"id": "a1"}]
	}`)
	out := agentProjectWork(200, body)
	obj, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("投影结果类型异常：%T", out)
	}
	if obj["viewpoint_empty"] != true || obj["outline_confirmed"] != false {
		t.Errorf("观点或大纲状态投影不正确：%v %v", obj["viewpoint_empty"], obj["outline_confirmed"])
	}
	if obj["asset_count"] != 1 {
		t.Errorf("asset_count = %v", obj["asset_count"])
	}
	secs, _ := obj["sections"].([]any)
	if len(secs) != 2 {
		t.Fatalf("段落概要有 %d 条", len(secs))
	}
	first := secs[0].(map[string]any)
	if _, has := first["content_md"]; has {
		t.Error("作品详情投影不应包含完整正文")
	}
	if runeLen(agentStr(first["excerpt"])) != 200 {
		t.Errorf("摘要长度应为 200，实际 %d", runeLen(agentStr(first["excerpt"])))
	}

	full := agentProjectWorkSections(map[string]any{"section_ids": []any{"s2"}}, 200, body)
	fobj, _ := full.(map[string]any)
	fsecs, _ := fobj["sections"].([]any)
	if len(fsecs) != 1 {
		t.Fatalf("read_sections 返回 %d 段，期望 1 段", len(fsecs))
	}
	if agentStr(fsecs[0].(map[string]any)["content_md"]) != "第二段正文" {
		t.Errorf("read_sections 未返回完整正文：%v", fsecs[0])
	}
}

// 第 3.6 节第 2 项：投影结果超过 6000 字时截断并附标记。
func TestAG04ProjectionTruncation(t *testing.T) {
	long := map[string]any{"text": strings.Repeat("字", agentProjectionChars+100)}
	got := agentTruncateProjection(long)
	obj, ok := got.(map[string]any)
	if !ok || obj["truncated"] != true {
		t.Fatalf("截断标记缺失：%v", got)
	}
	if obj["hint"] == "" {
		t.Error("截断提示缺失")
	}
	short := agentTruncateProjection(map[string]any{"text": "短"})
	if _, ok := short.(map[string]any)["truncated"]; ok {
		t.Error("未超限的结果不应带截断标记")
	}
}

// 第 3.6 节第 4 项：错误结果统一为 {"ok":false,"status":..,"error":{code,message,detail}}。
func TestAG04ErrorEnvelope(t *testing.T) {
	body := []byte(`{"error":{"code":"human_step_required","message":"请先确认大纲","detail":{"checkpoint":"H-03"}}}`)
	var env map[string]any
	if err := json.Unmarshal(agentErrorEnvelope(409, body), &env); err != nil {
		t.Fatal(err)
	}
	if env["ok"] != false || env["status"] != float64(409) {
		t.Errorf("错误信封外层不正确：%v", env)
	}
	inner, _ := env["error"].(map[string]any)
	if inner["code"] != "human_step_required" || inner["message"] != "请先确认大纲" {
		t.Errorf("错误信封内层不正确：%v", inner)
	}
}
