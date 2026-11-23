package app

// REF41 A1：反谎报三闸。只检查最终回答（零工具调用分支）里的“已完成/已发布/已
// 写入”类声称是否对应本次 run 的成功执行证据；不检查中间推理与计划。
// 含“将/建议/计划/未/没有/失败”等否定或将来语气的句子不算声称（句子级豁免，
// 同一段落其他句子正常判定）；有对应 succeeded 证据不误伤。
// 模拟模型不 nudge（避免死循环），强制 demo 标记与演示前缀。

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// agentClaimPatterns 是六类“动词 + 完成态”声称模式（A1-A1 表驱动来源）。
// record 为 REF41 A3 增补：只有真实调用 report_capability_gap 并成功落库才算证据。
var agentClaimPatterns = map[string]*regexp.Regexp{
	"publish": regexp.MustCompile(`已发布|已经发布|发布成功|已推送|已群发|已提交审核`),
	"write":   regexp.MustCompile(`已创建|已写入|已保存|已更新|已删除|已导入|已上传`),
	"send":    regexp.MustCompile(`已发送|已通知|已发邮件|已发消息`),
	"execute": regexp.MustCompile(`已执行|已跑完`),
	"finish":  regexp.MustCompile(`已完成|已经完成`),
	"record":  regexp.MustCompile(`已记录能力缺口|已记录缺口|能力缺口已记录|已登记能力缺口`),
}

// agentClaimExempt 是否定/将来/计划语气，句子命中则不算声称（避免误伤正常描述）。
var agentClaimExempt = regexp.MustCompile(
	`将发布|将要|建议|可以|计划|打算|如需|下一步|尚未|未发布|未完成|未执行|未写入|没有发布|没有完成|没有写入|发布失败|写入失败|无法发布|无法完成|未记录|没有记录|无法记录|无法登记`)

// agentClaimsInText 返回文本命中的声称类别列表（去重）。豁免判定是句子级的：
// 含否定/将来语气的句子不算声称，同一段落其他句子仍正常判定。
func agentClaimsInText(text string) []string {
	claims := []string{}
	seen := map[string]bool{}
	for _, sentence := range splitAgentSentences(text) {
		if agentClaimExempt.MatchString(sentence) {
			continue
		}
		for kind, pattern := range agentClaimPatterns {
			if pattern.MatchString(sentence) && !seen[kind] {
				seen[kind] = true
				claims = append(claims, kind)
			}
		}
	}
	return claims
}

func splitAgentSentences(text string) []string {
	parts := strings.FieldsFunc(text, func(r rune) bool {
		return r == '。' || r == '！' || r == '？' || r == '\n' || r == ';' || r == '；' || r == '，' || r == ','
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// agentRunEvidenceCount 统计本次 run 的成功执行证据：
// succeeded 动作卡片，以及成功落库的 report_capability_gap 工具结果
// （A3 的本地元工具不生成 agent_action，但 recorded=true 是真实写入证据）。
// ai_call 只是模型调用，不构成“已发布/已写入”类声称的外部证据。
func (s *Server) agentRunEvidenceCount(ctx context.Context, runID uuid.UUID) (int, error) {
	var evidence int
	if err := s.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM agent_action WHERE run_id=$1 AND status='succeeded')
		+ (SELECT count(*) FROM agent_message WHERE run_id=$1 AND role='tool'
			AND tool_name='report_capability_gap' AND content::jsonb->>'recorded'='true')`,
		runID).Scan(&evidence); err != nil {
		return 0, err
	}
	return evidence, nil
}

// agentFabricationCheck 是最终回答的“声称—证据”检查结果（落 agent_run.final_check）。
type agentFabricationCheck struct {
	Claims   []string `json:"claims"`
	Evidence int      `json:"evidence"`
	Blocked  []string `json:"blocked"`
}

var agentClaimNames = map[string]string{
	"publish": "发布", "write": "写入", "send": "发送",
	"execute": "执行", "finish": "完成", "record": "记录能力缺口",
}

// agentRewriteFinalText 第二次拦截时的改写前缀；原文保留在 raw_final_text。
func agentRewriteFinalText(check agentFabricationCheck) string {
	blocked := make([]string, 0, len(check.Claims))
	for _, c := range check.Claims {
		if name, ok := agentClaimNames[c]; ok {
			blocked = append(blocked, name)
		} else {
			blocked = append(blocked, c)
		}
	}
	return "⚠️ 本次回答包含未执行的动作，已拦截：" + strings.Join(blocked, "、") +
		"。\n以下为建议/计划，不代表已完成。\n\n"
}

// agentNudgeSystemText 第一次无证据声称的纠正提示（要求继续，不直接拦截）。
func agentNudgeSystemText(claims []string) string {
	return "你声称完成了：" + strings.Join(claims, "、") +
		"，但本次运行没有对应的成功执行记录。请改为“尚未执行/建议…”，或调用工具完成并等待确认。"
}

// agentFinalizeTruth 对零工具调用的最终回答执行三闸；返回改写后文本与检查结果。
// simulated=true 时跳过 nudge（模拟工具可能假成功），强制 demo 前缀。
func (s *Server) agentFinalizeTruth(ctx context.Context, st *agentRunState, text string, simulated bool) (string, agentFabricationCheck) {
	check := agentFabricationCheck{Claims: agentClaimsInText(text)}
	if len(check.Claims) == 0 {
		return text, check
	}
	evidence, err := s.agentRunEvidenceCount(ctx, st.RunID)
	if err != nil {
		// 证据统计失败按“有证据”放行（误拦比漏拦危险），前端可由 final_check 观测。
		check.Evidence = -1
		return text, check
	}
	check.Evidence = evidence
	if simulated {
		// 模拟模型：不 nudge，强制 demo 前缀。
		check.Blocked = check.Claims
		return "（模拟模型演示，未真实执行）\n" + text, check
	}
	if evidence > 0 {
		// 有证据：不误伤。
		return text, check
	}
	if st.FabricationNudges == 0 {
		// 第一次：注入纠正提示，调用方继续循环。
		st.FabricationNudges++
		check.Blocked = check.Claims
		return agentNudgeSystemText(check.Claims), check
	}
	// 第二次仍无证据：改写前缀 + outcome=partial。
	check.Blocked = check.Claims
	return agentRewriteFinalText(check) + text, check
}

// agentTruthMarshal 序列化 final_check；空检查保持 object 形态。
func agentTruthMarshal(check agentFabricationCheck) []byte {
	raw, err := json.Marshal(check)
	if err != nil {
		return []byte("{}")
	}
	return raw
}
