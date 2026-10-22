package app

// H-03/H-04/H-05/H-09 卡片的专属预览与执行期补齐（16 文档第 5.6 节）：
// ProposePreview 在提出卡片时读取当前状态、冻结守卫值并生成额外差异；
// EnrichExecute 在执行前重新读取当前状态，把分发所需的完整参数写入请求。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// agentHookRead 是钩子按指定路径经分发器读取当前状态。
func agentHookRead(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any, path string) (map[string]any, error) {
	body, ok := s.agentPreviewAt(ctx, st, t, args, path)
	if !ok {
		return nil, apiErr(502, "ai_upstream_error", "读取当前状态失败，请稍后重试")
	}
	return body, nil
}

// agentArgString 取字符串参数。
func agentArgString(args map[string]any, name string) string {
	v, _ := args[name].(string)
	return strings.TrimSpace(v)
}

// agentOutlineText 把大纲条目渲染成卡片文本。
func agentOutlineText(v any) string {
	items, _ := v.([]any)
	lines := []string{}
	for i, raw := range items {
		obj, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		heading, _ := obj["heading"].(string)
		keyPoint, _ := obj["key_point"].(string)
		line := fmt.Sprintf("%d. %s", i+1, heading)
		if strings.TrimSpace(keyPoint) != "" {
			line += "（" + keyPoint + "）"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// agentRevisionOf 取对象里的整型 revision。
func agentRevisionOf(body map[string]any) (int, bool) {
	if v, ok := body["revision"].(float64); ok {
		return int(v), true
	}
	return 0, false
}

// previewOutlineSave 冻结提出时的作品修订号；底稿给出当前大纲，供逐字段差异使用。
func previewOutlineSave(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	if rev, ok := agentRevisionOf(body); ok {
		args["base_revision"] = rev
	}
	return nil, map[string]any{"items": body["outline"]}, nil
}

// previewOutlineConfirm 冻结修订号并展示完整大纲（第 5.6 节 H-03）。
func previewOutlineConfirm(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	if rev, ok := agentRevisionOf(body); ok {
		args["base_revision"] = rev
	}
	text := agentOutlineText(body["outline"])
	return []agentChange{{Field: "items", Label: "大纲", Before: text, After: text}}, body, nil
}

// enrichOutlineConfirm 执行时读取当前大纲写入请求体（第 5.6 节 H-03）。
func enrichOutlineConfirm(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) error {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return err
	}
	args["items"] = body["outline"]
	return nil
}

// previewStoryboardConfirm 展示完整分镜；返回的对象作为指纹来源（第 5.6 节 H-03）。
func previewStoryboardConfirm(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	text := agentChangeText(body["panels"])
	return []agentChange{{Field: "panels", Label: "分镜", Before: text, After: text}}, body, nil
}

// enrichStoryboardConfirm 执行时读取当前分镜写入请求体（第 5.6 节 H-03）。
func enrichStoryboardConfirm(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) error {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return err
	}
	args["panels"] = body["panels"]
	return nil
}

// previewOrganizeApply 展示整理结果全文（第 5.6 节 H-03）。
func previewOrganizeApply(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	markdown, err := s.agentToolResultText(ctx, st.ConversationID, agentArgString(args, "source_tool_call_id"))
	if err != nil {
		return nil, nil, err
	}
	return []agentChange{{Field: "items", Label: "整理结果", Before: markdown, After: markdown}}, nil, nil
}

// enrichOrganizeApply 执行时从工具结果读取 markdown（第 5.6 节 H-03）。
func enrichOrganizeApply(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) error {
	markdown, err := s.agentToolResultText(ctx, st.ConversationID, agentArgString(args, "source_tool_call_id"))
	if err != nil {
		return err
	}
	args["markdown"] = markdown
	return nil
}

// agentToolResultText 读取本对话中某个工具调用的结果全文。
// SSE 工具的结果是 done 事件 JSON（第 11.4 节），其中的 text 才是全文。
func (s *Server) agentToolResultText(ctx context.Context, convID uuid.UUID, toolCallID string) (string, error) {
	if toolCallID == "" {
		return "", apiErr(422, "validation_failed", "缺少整理结果的工具调用 ID")
	}
	var content string
	err := s.db.QueryRow(ctx, `SELECT content FROM agent_message
		WHERE conversation_id=$1 AND role='tool' AND tool_call_id=$2 ORDER BY seq DESC LIMIT 1`,
		convID, toolCallID).Scan(&content)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", apiErr(422, "validation_failed", "找不到该工具调用的结果，请重新整理")
	}
	if err != nil {
		return "", err
	}
	var payload struct {
		Text string `json:"text"`
	}
	if json.Unmarshal([]byte(content), &payload) == nil && payload.Text != "" {
		return payload.Text, nil
	}
	return content, nil
}

// previewSectionUpdate 冻结提出时的段落修订号（附录 A.5 sections__update）。
func previewSectionUpdate(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	id, err := uuid.Parse(agentArgString(args, "id"))
	if err != nil {
		return nil, nil, nil
	}
	var rev int
	err = s.db.QueryRow(ctx, `SELECT revision FROM work_section WHERE id=$1`, id).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	args["base_revision"] = rev
	return nil, nil, nil
}

// agentCheckItemWork 由检查项定位所属作品。
func (s *Server) agentCheckItemWork(ctx context.Context, itemID uuid.UUID) (uuid.UUID, error) {
	var workID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT r.work_id FROM check_item i JOIN check_run r ON r.id=i.check_run_id
		WHERE i.id=$1`, itemID).Scan(&workID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, apiErr(422, "validation_failed", "检查项不存在，请重新发起检查")
	}
	return workID, err
}

// agentFindCheckItem 在 checks/latest 的响应里定位一个检查项。
func agentFindCheckItem(body map[string]any, itemID uuid.UUID) map[string]any {
	run, _ := body["run"].(map[string]any)
	if run == nil {
		return nil
	}
	items, _ := run["items"].([]any)
	for _, raw := range items {
		obj, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := obj["id"].(string); id == itemID.String() {
			return obj
		}
	}
	return nil
}

// agentCheckCounts 统计检查项通过与总数。
func agentCheckCounts(run map[string]any) (int, int) {
	passed, total := 0, 0
	if items, ok := run["items"].([]any); ok {
		for _, raw := range items {
			obj, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			total++
			if b, _ := obj["passed"].(bool); b {
				passed++
			}
		}
	}
	if v, ok := run["total"].(float64); ok && int(v) > total {
		total = int(v)
	}
	return passed, total
}

// previewResolveItem 读取检查项详情：类别、命中文字与建议（第 5.6 节 H-04）。
func previewResolveItem(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	itemID, err := uuid.Parse(agentArgString(args, "id"))
	if err != nil {
		return nil, nil, apiErr(422, "validation_failed", "检查项不存在")
	}
	workID, err := s.agentCheckItemWork(ctx, itemID)
	if err != nil {
		return nil, nil, err
	}
	body, err := agentHookRead(ctx, s, st, t, map[string]any{"id": workID.String()}, "/works/{id}/checks/latest")
	if err != nil {
		return nil, nil, err
	}
	item := agentFindCheckItem(body, itemID)
	if item == nil {
		return nil, nil, apiErr(422, "validation_failed", "检查项不存在，请重新发起检查")
	}
	text := func(k string) string {
		v, _ := item[k].(string)
		return v
	}
	return []agentChange{
		{Field: "category", Label: "类别", Before: text("category"), After: text("category")},
		{Field: "matched_text", Label: "命中文字", Before: text("matched_text"), After: text("matched_text")},
		{Field: "message", Label: "建议", Before: text("message"), After: text("message")},
	}, nil, nil
}

// previewCompleteCheck 读取检查进度：通过数与总数（第 5.6 节 H-04）。
func previewCompleteCheck(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}/checks/latest")
	if err != nil {
		return nil, nil, err
	}
	run, _ := body["run"].(map[string]any)
	if run == nil {
		return nil, nil, apiErr(422, "validation_failed", "还没有检查记录，请先发起检查")
	}
	passed, total := agentCheckCounts(run)
	return []agentChange{
		{Field: "passed", Label: "已通过", Before: agentItoa(passed), After: agentItoa(passed)},
		{Field: "total", Label: "检查项总数", Before: agentItoa(total), After: agentItoa(total)},
	}, nil, nil
}

// previewPush 读取推送预览并冻结推送设置默认值（第 5.6 节 H-05）。
func previewPush(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}/wechat/push-preview")
	if err != nil {
		return nil, nil, err
	}
	if fields, ok := body["fields"].(map[string]any); ok && len(fields) > 0 {
		args["fields"] = fields
	}
	text := func(k string) string {
		v, _ := body[k].(string)
		return v
	}
	num := func(k string) string {
		v, _ := body[k].(float64)
		return agentItoa(int(v))
	}
	cover := "未设置"
	if body["cover_asset"] != nil && text("cover_asset") != "" {
		cover = "已设置"
	}
	draft := "新建草稿"
	if text("mode") == "overwrite" {
		draft = "覆盖已有草稿"
	}
	images := num("asset_count")
	if cf := text("content_format"); cf == "comic" || cf == "card_post" {
		images = num("panel_images")
	}
	today := num("today_count") + " / " + num("daily_limit")
	return []agentChange{
		{Field: "title", Label: "标题", Before: text("title"), After: text("title")},
		{Field: "summary", Label: "摘要", Before: text("summary"), After: text("summary")},
		{Field: "cover", Label: "封面", Before: cover, After: cover},
		{Field: "images", Label: "图片数", Before: images, After: images},
		{Field: "today", Label: "今日已推送", Before: today, After: today},
		{Field: "draft", Label: "已有草稿", Before: draft, After: draft},
	}, nil, nil
}

// previewApproveReview 读取最近检查摘要（第 5.6 节 H-09；作品链接由 Target 提供）。
func previewApproveReview(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}/checks/latest")
	if err != nil {
		return nil, nil, err
	}
	summary := "还没有检查记录"
	if run, ok := body["run"].(map[string]any); ok && run != nil {
		passed, total := agentCheckCounts(run)
		summary = fmt.Sprintf("最近检查：通过 %d / %d 项", passed, total)
		if at, _ := run["completed_at"].(string); at != "" {
			summary += "，完成于 " + at
		}
	}
	return []agentChange{{Field: "check_summary", Label: "最近检查摘要", Before: summary, After: summary}}, nil, nil
}

// previewShareLink freezes the revision shown when the user confirms sharing.
func previewShareLink(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	revision, ok := agentRevisionOf(body)
	if !ok || revision < 1 {
		return nil, nil, validation("无法读取分享作品的修订号")
	}
	args["basis_revision"] = revision
	return []agentChange{{Field: "basis_revision", Label: "分享修订", Before: "当前版本", After: agentItoa(revision)}}, nil, nil
}

// previewToutiaoPack takes the package basis revision from the authorized work record,
// never from model-authored input. The create endpoint verifies it again on execution.
func previewToutiaoPack(ctx context.Context, s *Server, st *agentRunState, t *AgentTool,
	args map[string]any) ([]agentChange, map[string]any, error) {
	body, err := agentHookRead(ctx, s, st, t, args, "/works/{id}")
	if err != nil {
		return nil, nil, err
	}
	platform, _ := body["platform"].(string)
	format, _ := body["content_format"].(string)
	revision, ok := agentRevisionOf(body)
	if platform != "toutiao" || !validFormat(platform, format) || !ok || revision < 1 {
		return nil, nil, apiErr(422, "validation_failed", "该作品无法准备头条发布包")
	}
	args["basis_revision"] = revision
	formatLabel := "头条文章"
	if format == "micro_post" {
		formatLabel = "微头条"
	}
	return []agentChange{
		{Field: "content_format", Label: "内容形态", Before: formatLabel, After: formatLabel},
		{Field: "basis_revision", Label: "依据修订", Before: "当前版本", After: agentItoa(revision)},
	}, nil, nil
}
