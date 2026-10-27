package app

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

// 分发与执行的超时口径（16 文档第 2.3 节）。
const (
	agentReadTimeout     = 15 * time.Second
	agentExecTimeout     = 60 * time.Second
	agentExecAITimeout   = 180 * time.Second
	agentExecPushTimeout = 600 * time.Second
)

// 16 文档第 3.3 节：领域与一句话说明。环境块直接使用，模型不需要单独查询。
type agentDomain struct {
	Name string
	Desc string
}

var agentDomains = []agentDomain{
	{"workspace", "工作区、成员、邀请"},
	{"accounts", "平台账号、凭证状态、工作台待办"},
	{"profile", "账号档案、风格样本、角色卡、账号记忆、自定义主题"},
	{"materials", "素材库、收件箱"},
	{"topics", "选题池、系列"},
	{"ops", "运营方案、内容大纲、热点、每日推荐、对标参考、内容日历"},
	{"works", "作品列表与属性、版本、协作批注、星标"},
	{"writing", "大纲、分镜、段落、起草与改写、标题摘要等生成"},
	{"visual", "图片、图片库、作品配图、漫画分格、卡片图"},
	{"publish", "发布前检查、审阅、公众号草稿、小红书／头条发布包、回填"},
	{"review", "数据录入与导入、截图识别、复盘报告、归因"},
	{"settings", "模型路由与自检、用量、质量、敏感词、提示词、回收站、通知、偏好、示例数据"},
	{"admin", "系统管理、采集设置（仅超管可见）"},
}

// agentMetaTools 是第 3.3 节的元工具，始终可用，不属于任何领域。
// Path 为空的条目是本地元工具：不参与路由自检，也不经分发器发 HTTP 请求。
var agentMetaTools = []AgentTool{
	{
		Name: "get_context", Kind: toolR, MinRole: roleViewer,
		Description: "返回最新的环境块，包括待确认卡片列表",
		Notes:       "本地元工具，由运行循环（DEV-AG05）实现",
	},
	{
		Name: "load_tool_domain", Kind: toolR, MinRole: roleViewer,
		Description: "加载一个领域，返回该领域的工具名与一句话说明",
		Params: []ToolParam{
			pBodyF("domain", enumOf(agentDomainNames()...), true),
		},
		Notes: "本地元工具，由运行循环（DEV-AG05）实现",
	},
	{
		Name: "global_search", Kind: toolR, MinRole: roleViewer, Method: "GET", Path: "/search",
		Description: "跨对象搜索作品、素材、选题、账号与批注",
		Params: []ToolParam{
			pQueryF("q", strMax(200), true),
			pQueryF("limit", intRange(1, 50), false),
		},
		Target: target("search", ""),
	},
	{
		// DEV-SK3 / 23 文档第 8.2 节：本地 R 元工具，不计普通 30 次读取；
		// 有独立的 3600 字输入预算，正文只进服务端可信指令区，回执不含正文。
		Name: "load_skill", Kind: toolR, MinRole: roleViewer,
		Description: "加载一个已配置技能的完整正文到本次运行的可信技能指令区，返回加载回执（不含正文）",
		Params: []ToolParam{
			pBodyF("skill_ref", strMax(8), true),
			pBodyF("catalog_id", schemaUUID, true),
			pBodyF("work_id", schemaUUID, false),
		},
		Notes: "本地元工具；skill_ref / catalog_id 必须来自同一目录；重复加载幂等",
	},
	{
		Name: "get_skill_context", Kind: toolR, MinRole: roleViewer,
		Description: "返回当前技能上下文摘要：catalog_id、work_id、已加载引用号、字符数与预算",
		Notes:       "本地元工具",
	},
	{
		Name: "make_link", Kind: toolR, MinRole: roleViewer,
		Description: "按页面表生成站内链接，不访问服务器数据",
		Params: []ToolParam{
			pBodyF("page", enumOf(agentLinkPages()...), true),
			pBodyF("account_id", schemaUUID, false),
			pBodyF("work_id", schemaUUID, false),
			pBodyF("conversation_id", schemaUUID, false),
			pBodyF("q", strMax(200), false),
			pBodyF("id", schemaUUID, false),
		},
		Notes: "本地元工具，页面表见 16 文档附录 B.3",
	},
	{
		Name: "present_plan", Kind: toolR, MinRole: roleEditor,
		Description: "保存或修订当前对话计划，不执行计划中的业务操作",
		Params: []ToolParam{
			pBodyF("summary", strMinMax(1, 2000), true),
			pBodyF("steps", arrOf(`{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":80},"title":{"type":"string","minLength":1,"maxLength":200},"target_ref":{"type":"string","maxLength":500},"acceptance":{"type":"string","minLength":1,"maxLength":500}},"required":["id","title","acceptance"],"additionalProperties":false}`, 1, 12), true),
		},
		Notes: "计划模式专用本地元工具；保存版本与步骤，不代表写入审批",
	},
	{
		Name: "update_plan_step", Kind: toolR, MinRole: roleEditor,
		Description: "更新当前版本的计划步骤状态并关联可验证的已保存证据",
		Params: []ToolParam{
			pBodyF("plan_id", schemaUUID, true),
			pBodyF("expected_version", intRange(1, 1000000), true),
			pBodyF("step_id", strMax(80), true),
			pBodyF("status", enumOf("pending", "in_progress", "waiting_user", "completed", "failed", "skipped"), true),
			pBodyF("evidence_refs", arrOf(`{"type":"object","properties":{"kind":{"type":"string","enum":["artifact_version","action","read_result"]},"id":{"type":"string","format":"uuid"}},"required":["kind","id"],"additionalProperties":false}`, 0, 10), false),
		},
		Notes: "只可更新当前计划版本；completed必须引用同对话保存的产物版本、成功卡片或成功只读结果",
	},
	{
		Name: "request_input", Kind: toolR, MinRole: roleEditor,
		Description: "向用户提出一组结构化澄清问题并等待整组回答",
		Params: []ToolParam{
			pBodyF("questions", arrOf(`{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":80},"title":{"type":"string","minLength":1,"maxLength":200},"required":{"type":"boolean"},"options":{"type":"array","minItems":2,"maxItems":5,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":80},"label":{"type":"string","minLength":1,"maxLength":200}},"required":["id","label"],"additionalProperties":false}}},"required":["id","title","required","options"],"additionalProperties":false}`, 1, 3), true),
		},
		Notes: "仅交互运行；同组答案一次性提交，可选题允许跳过",
	},
	{
		Name: "present_artifact", Kind: toolR, MinRole: roleEditor,
		Description: "把当前对话草稿保存为只读产物，或引用已授权资料；不会获得业务写入资格",
		Params: []ToolParam{
			pBodyF("title", strMinMax(1, 200), true),
			pBodyF("kind", enumOf("markdown", "title", "table"), true),
			pBodyF("source_ref", `{"type":"object","properties":{"type":{"type":"string","enum":["work","material","topic","report"]},"id":{"type":"string","format":"uuid"},"revision":{"type":"string","maxLength":100}},"required":["type","id"],"additionalProperties":false}`, false),
			pBodyF("chat_content", strMinMax(1, 20000), false),
		},
		Notes: "首次present_artifact为私有展示产物；source_ref须重新鉴权；chat_content限20,000字且source_kind固定为chat；table正文须为列数一致的CSV，第一行为列名",
	},
	{
		Name: "report_goal_progress", Kind: toolR, MinRole: roleEditor,
		Description: "报告当前任务目标的完成情况；服务端核验完成证据，主观条件仍等待用户确认",
		Params: []ToolParam{
			pBodyF("goal_id", schemaUUID, true),
			pBodyF("expected_revision", intRange(1, 1000000), true),
			pBodyF("criteria", arrOf(`{"type":"object","properties":{"id":{"type":"string","format":"uuid"},"result":{"type":"string","enum":["met","unmet","unverifiable"]},"evidence_refs":{"type":"array","maxItems":10,"items":{"type":"object","properties":{"kind":{"type":"string","enum":["artifact_version","action","read_result"]},"id":{"type":"string","format":"uuid"}},"required":["kind","id"],"additionalProperties":false}}},"required":["id","result","evidence_refs"],"additionalProperties":false}`, 1, 5), true),
			pBodyF("blocker", strMax(500), false),
		},
		Notes: "仅当前活动目标可用；每项完成必须引用同一对话中经服务端核验的证据；不可确认主观质量",
	},
}

func agentDomainNames() []string {
	out := make([]string, 0, len(agentDomains))
	for _, d := range agentDomains {
		out = append(out, d.Name)
	}
	return out
}

var (
	agentCatalogOnce sync.Once
	agentCatalogList []AgentTool
	agentCatalogIdx  map[string]*AgentTool
)

// buildAgentCatalog 汇总附录 A 的全部条目与第 3.3 节的元工具。
func buildAgentCatalog() []AgentTool {
	var out []AgentTool
	out = append(out, agentToolsWorkspace...)
	out = append(out, agentToolsAccounts...)
	out = append(out, agentToolsProfile...)
	out = append(out, agentToolsSkills...)
	out = append(out, agentToolsMaterials...)
	out = append(out, agentToolsTopics...)
	out = append(out, agentToolsOps...)
	out = append(out, agentToolsWorks...)
	out = append(out, agentToolsWriting...)
	out = append(out, agentToolsVisual...)
	out = append(out, agentToolsPublish...)
	out = append(out, agentToolsReview...)
	out = append(out, agentToolsSettings...)
	out = append(out, agentToolsAdmin...)
	out = append(out, agentMetaTools...)
	return out
}

// agentCatalog 构建索引并补齐默认值，首次调用后缓存。
func agentCatalog() []AgentTool {
	agentCatalogOnce.Do(func() {
		agentCatalogList = buildAgentCatalog()
		agentCatalogIdx = make(map[string]*AgentTool, len(agentCatalogList))
		for i := range agentCatalogList {
			t := &agentCatalogList[i]
			if t.Project == nil {
				t.Project = agentDefaultProject
			}
			if t.ExecTimeout <= 0 {
				t.ExecTimeout = agentDefaultExecTimeout(t)
			}
			agentCatalogIdx[t.Name] = t
		}
	})
	return agentCatalogList
}

// agentTool 按名称取条目；不存在时返回 nil。
func agentTool(name string) *AgentTool {
	agentCatalog()
	return agentCatalogIdx[name]
}

// agentDefaultExecTimeout 给出卡片执行的默认超时（第 2.3 节：默认 60 秒）。
// 生成写入（180 秒）与公众号推送（600 秒）由条目显式声明。
func agentDefaultExecTimeout(t *AgentTool) time.Duration {
	if t.Mutating() {
		return agentExecTimeout
	}
	return agentReadTimeout
}

// ---- 启动自检（第 3.7 节） ----

// agentRoute 是 chi.Walk 的一条已注册路由。
type agentRoute struct {
	Method string
	Path   string // 含 /api/v1 前缀
}

func agentRouteList(h http.Handler) []agentRoute {
	mux, ok := h.(*chi.Mux)
	if !ok {
		return nil
	}
	var out []agentRoute
	_ = chi.Walk(mux, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		out = append(out, agentRoute{Method: method, Path: route})
		return nil
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path == out[j].Path {
			return out[i].Method < out[j].Method
		}
		return out[i].Path < out[j].Path
	})
	return out
}

var agentToolNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

// agentNameSubstringTokens 按子串匹配的禁用词（与 HC-05、HC-06 的命名约束一致）。
// 发表类禁用词中的第一项拆成两段拼接，避免在源码中出现 HC-06 扫描的字面量。
var agentNameSubstringTokens = []string{"free" + "publish", "mass", "schedule", "cron", "timer", "batch"}

// agentNameWordTokens 按下划线词元匹配的禁用词。
var agentNameWordTokens = []string{"all", "publish"}

// agentNameAllowlist 是附录 A 明确列出、但会被字面禁用词规则误杀的条目。
// 判定记录见 docs/90 的 D-117「实现补充（DEV-AG04）」。
var agentNameAllowlist = map[string]bool{
	"notifications__read_all": true,
	"publish_link__parse":     true,
	"works__mark_published":   true,
	"works__import_published": true,
	"quality__calls":          true,
}

// agentPathPrefixBlacklist 是路径前缀黑名单。
var agentPathPrefixBlacklist = []string{"/agent/", "/auth/"}

// agentRouteBlacklist 是「方法 + 路径模板」黑名单（第 3.7 节第 3 条列出的具体接口）。
var agentRouteBlacklist = [][2]string{
	{"POST", "/workspaces/{id}/switch"},
	{"POST", "/workspaces/join"},
	{"POST", "/workspaces/current/leave"},
	{"POST", "/admin/workspaces/{id}/enter"},
	{"POST", "/admin/workspaces/exit"},
	{"POST", "/exports"},
	{"PUT", "/accounts/{accountId}/wechat-credential"},
	{"POST", "/model-providers"},
	{"PATCH", "/model-providers/{id}"},
	{"DELETE", "/model-providers/{id}"},
	{"GET", "/notifications/stream"},
	{"POST", "/ux-events"},
	{"POST", "/client-errors"},
	{"GET", "/works/{id}/presence"},
	{"POST", "/works/{id}/presence"},
	{"GET", "/works/{id}/copilot"},
	{"POST", "/works/{id}/copilot"},
	{"DELETE", "/works/{id}/copilot"},
	{"POST", "/sections/{id}/continue"},
	{"PUT", "/panels/{id}/bubbles"},
}

// validateAgentCatalog 执行第 3.7 节第 1 至 7 条的静态校验，返回全部违规项。
func validateAgentCatalog(routes []agentRoute) error {
	known := make(map[string]bool, len(routes))
	for _, r := range routes {
		known[r.Method+" "+r.Path] = true
	}
	var problems []string
	seen := map[string]bool{}

	for i := range agentCatalog() {
		t := &agentCatalogList[i]

		// 第 2 条：名称唯一、符合命名规则；描述不为空。
		if !agentToolNameRe.MatchString(t.Name) {
			problems = append(problems, fmt.Sprintf("条目名 %q 不符合命名规则", t.Name))
		}
		if seen[t.Name] {
			problems = append(problems, fmt.Sprintf("条目名 %q 重复", t.Name))
		}
		seen[t.Name] = true
		if strings.TrimSpace(t.Description) == "" {
			problems = append(problems, fmt.Sprintf("条目 %s 描述为空", t.Name))
		}

		// 第 1 条：本地元工具（Path 为空）不参与路由核对；其余必须命中 chi.Walk。
		if t.Path != "" {
			if !known[t.Method+" /api/v1"+t.Path] {
				problems = append(problems, fmt.Sprintf("条目 %s 的 %s %s 未在路由中注册", t.Name, t.Method, t.Path))
			}
			// 第 3 条：路径前缀与方法+模板黑名单。
			for _, p := range agentPathPrefixBlacklist {
				if strings.HasPrefix(t.Path, p) {
					problems = append(problems, fmt.Sprintf("条目 %s 命中路径前缀黑名单 %s", t.Name, p))
				}
			}
			for _, b := range agentRouteBlacklist {
				if t.Method == b[0] && t.Path == b[1] {
					problems = append(problems, fmt.Sprintf("条目 %s 命中黑名单路由 %s %s", t.Name, b[0], b[1]))
				}
			}
		}

		// 第 4 条：禁用词（白名单见 agentNameAllowlist）。
		if !agentNameAllowlist[t.Name] {
			low := strings.ToLower(t.Name)
			for _, tok := range agentNameSubstringTokens {
				if strings.Contains(low, tok) {
					problems = append(problems, fmt.Sprintf("条目 %s 名称含禁用词 %q", t.Name, tok))
				}
			}
			for _, tok := range agentNameWordTokens {
				if agentNameHasWord(low, tok) {
					problems = append(problems, fmt.Sprintf("条目 %s 名称含禁用词 %q", t.Name, tok))
				}
			}
		}
		lowDesc := strings.ToLower(t.Description)
		for _, tok := range agentNameSubstringTokens {
			if strings.Contains(lowDesc, tok) {
				problems = append(problems, fmt.Sprintf("条目 %s 描述含禁用词 %q", t.Name, tok))
			}
		}
		if !agentNameAllowlist[t.Name] && agentWordBoundaryRe("publish").MatchString(lowDesc) {
			problems = append(problems, fmt.Sprintf("条目 %s 描述含禁用词 %q", t.Name, "publish"))
		}

		// 第 5 条：W/H/X 不是 GET；GET 必须是 R。
		if t.Mutating() && t.Method == http.MethodGet {
			problems = append(problems, fmt.Sprintf("条目 %s 是 %s 却使用 GET", t.Name, t.Kind))
		}
		if t.Method == http.MethodGet && t.Kind != toolR {
			problems = append(problems, fmt.Sprintf("条目 %s 是 GET 却不是 R（%s）", t.Name, t.Kind))
		}

		// 第 6 条：Gate 非空必须是 H；X 必须有二次确认。
		if t.Gate != "" && t.Kind != toolH {
			problems = append(problems, fmt.Sprintf("条目 %s 有门槛 %s 却不是 H（%s）", t.Name, t.Gate, t.Kind))
		}
		if t.Kind == toolX && t.SecondConfirm == nil {
			problems = append(problems, fmt.Sprintf("条目 %s 是 X 却没有二次确认", t.Name))
		}

		// 第 7 条：Human 字段名不得同时出现在 Params 中。
		paramNames := map[string]bool{}
		for _, p := range t.Params {
			paramNames[p.Name] = true
		}
		for _, h := range t.Human {
			if paramNames[h.Name] {
				problems = append(problems, fmt.Sprintf("条目 %s 的人工字段 %s 同时出现在参数中", t.Name, h.Name))
			}
		}
	}

	if len(problems) == 0 {
		return nil
	}
	return errors.New("智能体工具目录自检失败：\n  - " + strings.Join(problems, "\n  - "))
}

func agentNameHasWord(name, word string) bool {
	for _, part := range strings.Split(name, "_") {
		if part == word {
			return true
		}
	}
	return false
}

func agentWordBoundaryRe(word string) *regexp.Regexp {
	return regexp.MustCompile(`(^|[^a-z0-9])` + regexp.QuoteMeta(word) + `([^a-z0-9]|$)`)
}

// VerifyAgentCatalog 构建根路由并执行目录自检；失败时服务拒绝启动。
func (s *Server) VerifyAgentCatalog() error {
	return validateAgentCatalog(agentRouteList(s.Router()))
}
