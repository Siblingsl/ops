package app

// REF41 A2：模拟模型标记与 demo 边界。model_provider.simulated=true 的供应商在
// 生产环境拒绝解析（model_simulated_production，不自动回退避免静默换模型）；
// 开发环境允许但强制 demo=true。demo 下只允许读/生成类工具，notify*/publish*/
// feishu* 及真实外部写入工具返回 demo_blocked 预览，不落库、不发外部。

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// agentDemoBlockedTools 是 demo 运行下禁止真实执行的工具名前缀（docs/41 A2：
// “notify*、publish*、feishu* 及真实外部写入”——站内内容操作（outline/storyboard/
// organize/wechat 草稿等）不在阻断面；真实平台写入与出站通知才是外部副作用）。
var agentDemoBlockedTools = []string{"notify", "publish_work", "publish_now", "feishu", "send_email", "platform_"}

// agentSimulatedOf 读 provider 的 simulated 标记。
func (s *Server) agentSimulatedOf(ctx context.Context, providerID string) (bool, error) {
	var simulated bool
	if err := s.db.QueryRow(ctx, `SELECT simulated FROM model_provider WHERE id=$1`,
		providerID).Scan(&simulated); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	return simulated, nil
}

// agentDemoBlocked 判断工具是否属于 demo 下禁止真实执行的外部写入面。
func agentDemoBlocked(toolName string) bool {
	name := strings.ToLower(toolName)
	for _, prefix := range agentDemoBlockedTools {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// agentDemoBlockedResult 是 demo 下被阻断工具的统一预览结果文案。
func agentDemoBlockedResult(toolName string) string {
	return "demo_blocked：模拟模型演示不产生真实外部副作用（" + toolName + " 未执行）。请接入真实模型后重试。"
}

// agentCheckSimulatedProvider 在解析模型路由时执行 A2-A1 闸：
// simulated 供应商生产环境直接拒绝；开发环境放行并由调用方写 demo。
func (s *Server) agentCheckSimulatedProvider(ctx context.Context, providerID string) (bool, error) {
	simulated, err := s.agentSimulatedOf(ctx, providerID)
	if err != nil {
		return false, err
	}
	if simulated && !s.cfg.Dev {
		return false, apiErr(422, "model_simulated_production",
			"模拟模型不能在生产环境使用，请管理员更换真实模型供应商")
	}
	return simulated, nil
}

// agentWrapUp 是轮次用尽收尾的三段结构（A2-A3）。
type agentWrapUp struct {
	Done       []string `json:"done"`
	Pending    []string `json:"pending"`
	NeedUser   []string `json:"need_user"`
	NextAction string   `json:"next_actions"`
}

// agentBuildWrapUp 从 agent_plan_step_state / agent_action / agent_question 汇总
// 收尾三段；不调用模型、不编造（无数据时如实说明）。
func (s *Server) agentBuildWrapUp(ctx context.Context, runID string) agentWrapUp {
	out := agentWrapUp{}
	// 计划步骤（最近一次 current 计划）。
	rows, err := s.db.Query(ctx, `SELECT p.steps, s.status, s.step_id
		FROM agent_plan p JOIN agent_plan_step_state s ON s.plan_id=p.id
		WHERE p.source_run_id=$1 AND p.status='current'`, runID)
	if err == nil {
		stepsByPlan := map[string][]agentPlanStepMeta{}
		statuses := map[string]string{}
		for rows.Next() {
			var stepsRaw []byte
			var status, stepID string
			if rows.Scan(&stepsRaw, &status, &stepID) == nil {
				statuses[stepID] = status
				var metas []agentPlanStepMeta
				if jsonUnmarshalSteps(stepsRaw, &metas) == nil {
					stepsByPlan["current"] = metas
				}
			}
		}
		rows.Close()
		for _, meta := range stepsByPlan["current"] {
			status := statuses[meta.Title]
			title := truncate(meta.Title, 80)
			switch status {
			case "completed":
				out.Done = append(out.Done, title)
			case "failed", "skipped", "pending", "in_progress", "waiting_user":
				out.Pending = append(out.Pending, title+"（"+status+"）")
			}
		}
	}
	// 动作卡片：succeeded 计入已完成，needs_input/pending 计入待确认。
	var succeeded, needsInput, pending int
	_ = s.db.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status='succeeded'),
		count(*) FILTER (WHERE status='needs_input'),
		count(*) FILTER (WHERE status IN ('pending','executing'))
		FROM agent_action WHERE run_id=$1`, runID).Scan(&succeeded, &needsInput, &pending)
	if succeeded > 0 {
		out.Done = append(out.Done, itoaCount(succeeded)+" 张操作卡片已成功执行")
	}
	if needsInput > 0 {
		out.NeedUser = append(out.NeedUser, itoaCount(needsInput)+" 张操作卡片等待你确认")
	}
	if pending > 0 {
		out.Pending = append(out.Pending, itoaCount(pending)+" 张操作卡片尚未处理")
	}
	// 未回答的问题。
	var questions int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM agent_question
		WHERE source_run_id=$1 AND status='pending'`, runID).Scan(&questions)
	if questions > 0 {
		out.NeedUser = append(out.NeedUser, itoaCount(questions)+" 个问题等待你回答")
	}
	// 下一步建议（模板拼接，不自由发挥）。
	switch {
	case len(out.NeedUser) > 0:
		out.NextAction = "请先处理待确认项，然后点“继续”接着跑。"
	case len(out.Pending) > 0:
		out.NextAction = "可点“继续”接着跑，或缩小任务范围分次完成。"
	default:
		out.NextAction = "本轮轮次已用尽；建议缩小任务范围后重试。"
	}
	return out
}

// agentWrapUpText 把三段收尾渲染为不超过 20 行的模板文本。
func agentWrapUpText(w agentWrapUp) string {
	var b strings.Builder
	b.WriteString("⏸ 本轮轮次已用尽，任务部分完成（未调用模型，以下为已记录的执行状态）。\n")
	b.WriteString("已完成：\n")
	if len(w.Done) == 0 {
		b.WriteString("- （无已记录的完成项）\n")
	}
	for _, item := range w.Done {
		b.WriteString("- " + item + "\n")
	}
	b.WriteString("未完成：\n")
	if len(w.Pending) == 0 {
		b.WriteString("- （无未完成步骤）\n")
	}
	for _, item := range w.Pending {
		b.WriteString("- " + item + "\n")
	}
	b.WriteString("需要你确认：\n")
	if len(w.NeedUser) == 0 {
		b.WriteString("- （无）\n")
	}
	for _, item := range w.NeedUser {
		b.WriteString("- " + item + "\n")
	}
	b.WriteString("建议：" + w.NextAction)
	return b.String()
}

// agentTruthWithWrapUp 把 A2 收尾三段并入 final_check，供 Agent 页抽屉直接读取；
// 不新增列，A1 的 claims/evidence/blocked 结构保持兼容。
func agentTruthWithWrapUp(raw []byte, wrap agentWrapUp) []byte {
	doc := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
			doc = map[string]any{}
		}
	}
	doc["wrap_up"] = wrap
	out, err := json.Marshal(doc)
	if err != nil {
		return []byte("{}")
	}
	return out
}

// jsonUnmarshalSteps 解析 agent_plan.steps jsonb（title 列表）。
func jsonUnmarshalSteps(raw []byte, out *[]agentPlanStepMeta) error {
	return json.Unmarshal(raw, out)
}

type agentPlanStepMeta struct {
	Title string `json:"title"`
}

func itoaCount(n int) string {
	return strconv.Itoa(n)
}
