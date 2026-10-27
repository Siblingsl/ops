package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// 上下文组装（16 文档第 6.2、6.3 节）。
const (
	agentSummaryChars     = 2000  // 第 6.2 节第 3 项
	agentAttachmentChars  = 20000 // 第 6.2 节第 5 项
	agentActionResultHead = "以下是用户在操作卡片上的处理结果（系统生成，不是用户的话）"
)

type agentRawMessage struct {
	Seq         int
	Role        string
	Content     string
	ToolCalls   []byte
	ToolCallID  string
	ToolName    string
	Attachments []uuid.UUID
	RunID       *uuid.UUID
	ContextRefs []agentResolvedContext
}

// agentBuildMessages 按第 6.2 节的顺序组装发送给模型的消息列表。
func (s *Server) agentBuildMessages(ctx context.Context, st *agentRunState, id *identity) ([]ai.Message, error) {
	out := []ai.Message{}
	out = append(out, ai.Message{Role: "system", Content: agentSystemRules})
	mode := agentEffectiveMode(st.Mode, id.Role)
	if mode != "execute" {
		out = append(out, ai.Message{Role: "system", Content: "当前模式：" + mode + "。只读取、分析与形成建议；不得执行业务动作或提出写入卡片。"})
	}
	env, err := s.agentEnvBlock(ctx, st)
	if err != nil {
		return nil, err
	}
	out = append(out, ai.Message{Role: "system", Content: env})
	// DEV-SK3 / 23 文档第 8.2 节：服务端把获准的技能正文放入专门的「用户已配置技能」system
	// 补充区；每轮完整重建，历史窗口淘汰回执不丢失正文。普通工具结果、目录、附件仍仅作资料。
	if zone, chars := agentSkillLoadedText(agentSkillActive(st.RunID)); chars > 0 {
		out = append(out, ai.Message{Role: "system", Content: zone})
	}
	if strings.TrimSpace(st.Summary) != "" {
		out = append(out, ai.Message{Role: "system", Content: "对话摘要（更早的历史，仅供参考）：\n" + truncate(st.Summary, agentSummaryChars)})
	}
	fixed, fixedChars, err := s.agentFixedContextMessages(ctx, st)
	if err != nil {
		return nil, err
	}
	out = append(out, fixed...)
	window, err := s.agentMessageWindow(ctx, st, id, agentWindowChars-fixedChars)
	if err != nil {
		return nil, err
	}
	return append(out, window...), nil
}

// agentMessageWindow 从最新消息向前装入完整消息，直到预算用尽（第 6.2 节第 4 项）。
// 助手消息与其全部工具结果成组：要么一起装入，要么一起不装入（第 6.2 节第 3 项）。
func (s *Server) agentMessageWindow(ctx context.Context, st *agentRunState, id *identity, budgets ...int) ([]ai.Message, error) {
	budget := agentWindowChars
	if len(budgets) > 0 {
		budget = budgets[0]
	}
	rows, err := s.db.Query(ctx, `SELECT seq, role, content, tool_calls, tool_call_id, tool_name, attachment_ids, run_id, context_refs
		FROM agent_message WHERE conversation_id=$1 ORDER BY seq ASC`, st.ConversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []agentRawMessage{}
	for rows.Next() {
		var m agentRawMessage
		var runID *uuid.UUID
		var refsRaw []byte
		if err := rows.Scan(&m.Seq, &m.Role, &m.Content, &m.ToolCalls, &m.ToolCallID, &m.ToolName, &m.Attachments, &runID, &refsRaw); err != nil {
			return nil, err
		}
		m.RunID = runID
		if m.Role == "user" && runID != nil && *runID == st.RunID {
			var refs []agentContextReference
			if err := json.Unmarshal(refsRaw, &refs); err != nil {
				return nil, err
			}
			for _, ref := range refs {
				if ref.Scope != "turn" {
					continue
				}
				item, err := s.agentResolveContextReferenceInConversation(ctx, ref, st.AccountID, &st.ConversationID)
				if err != nil {
					return nil, err
				}
				item.Scope = "turn"
				m.ContextRefs = append(m.ContextRefs, *item)
			}
		}
		all = append(all, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 分组：一条带 tool_calls 的助手消息 + 紧随其后的全部 role=tool 结果。
	groups := [][]agentRawMessage{}
	for _, m := range all {
		if m.Role == "tool" && len(groups) > 0 {
			groups[len(groups)-1] = append(groups[len(groups)-1], m)
			continue
		}
		groups = append(groups, []agentRawMessage{m})
	}

	first := len(groups)
	for i := len(groups) - 1; i >= 0; i-- {
		need := 0
		for _, m := range groups[i] {
			need += agentMessageCost(m)
		}
		if need > budget {
			for _, m := range groups[i] {
				if m.RunID != nil && *m.RunID == st.RunID && len(m.ContextRefs) > 0 {
					return nil, apiErr(422, "context_budget_exceeded", "本轮显式引用与对话内容超过上下文容量，请减少引用或整理对话")
				}
			}
			break
		}
		budget -= need
		first = i
	}
	// 按组保留原时间顺序；不能反转组内 assistant 调用和对应 tool 结果。
	kept := []agentRawMessage{}
	for _, group := range groups[first:] {
		kept = append(kept, group...)
	}

	out := []ai.Message{}
	for _, m := range kept {
		msg, err := s.agentMessageForModel(ctx, st, id, m)
		if err != nil {
			return nil, err
		}
		if msg != nil {
			out = append(out, *msg)
		}
	}
	return out, nil
}

// agentMessageCost 计算一条消息在窗口预算中占用的长度（第 6.2 节第 1 项）。
func agentMessageCost(m agentRawMessage) int {
	if m.Role == "tool" {
		return runeLen(truncate(m.Content, agentProjectionChars))
	}
	cost := runeLen(m.Content)
	for _, ref := range m.ContextRefs {
		cost += runeLen(ref.Content)
	}
	return cost
}

// agentMessageForModel 把一条已保存的消息转成发给模型的 ai.Message。
func (s *Server) agentMessageForModel(ctx context.Context, st *agentRunState, id *identity,
	m agentRawMessage) (*ai.Message, error) {
	switch m.Role {
	case "user":
		msg := ai.Message{Role: "user", Content: m.Content}
		if err := s.agentAttachToMessage(ctx, st, &msg, m); err != nil {
			return nil, err
		}
		if err := s.agentAppendResolvedContext(ctx, st, &msg, m.ContextRefs); err != nil {
			return nil, err
		}
		return &msg, nil
	case "tool":
		return &ai.Message{
			Role: "tool", Content: truncate(m.Content, agentProjectionChars),
			ToolCallID: m.ToolCallID, Name: m.ToolName,
		}, nil
	case "action_result":
		// 第 6.2 节第 2 项：以用户角色发送，开头声明这是系统生成的处理结果。
		return &ai.Message{Role: "user", Content: agentActionResultHead + "\n" + agentDataBlock("操作结果", m.Content)}, nil
	case "system_note":
		return &ai.Message{Role: "assistant", Content: m.Content}, nil
	default:
		msg := ai.Message{Role: "assistant", Content: m.Content}
		if len(m.ToolCalls) > 0 && string(m.ToolCalls) != "null" {
			var calls []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}
			if err := json.Unmarshal(m.ToolCalls, &calls); err == nil {
				for _, c := range calls {
					call := ai.ToolCall{ID: c.ID, Type: "function"}
					call.Function.Name = c.Name
					call.Function.Arguments = c.Arguments
					msg.ToolCalls = append(msg.ToolCalls, call)
				}
			}
		}
		return &msg, nil
	}
}

// agentDataBlock 把一段 JSON 或纯文字包成 D-081 数据块。
func agentDataBlock(kind, body string) string {
	if json.Valid([]byte(strings.TrimSpace(body))) {
		return externalBlock(kind, kind, json.RawMessage(strings.TrimSpace(body)))
	}
	return externalBlock(kind, kind, body)
}

func (s *Server) agentFixedContextMessages(ctx context.Context, st *agentRunState) ([]ai.Message, int, error) {
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT fixed_context_refs FROM agent_conversation WHERE id=$1`, st.ConversationID).Scan(&raw); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	refs := []agentContextReference{}
	if err := json.Unmarshal(raw, &refs); err != nil {
		return nil, 0, err
	}
	if len(refs) == 0 {
		return nil, 0, nil
	}
	if len(refs) > 12 {
		return nil, 0, apiErr(422, "agent_context_unavailable", "对话固定引用超过允许数量，请先移除多余引用")
	}
	resolved := make([]agentResolvedContext, 0, len(refs))
	chars := 0
	for _, ref := range refs {
		item, err := s.agentResolveContextReferenceInConversation(ctx, ref, st.AccountID, &st.ConversationID)
		if err != nil {
			return nil, 0, err
		}
		item.Scope = "conversation"
		chars += runeLen(item.Content)
		resolved = append(resolved, *item)
	}
	if chars > agentWindowChars {
		return nil, 0, apiErr(422, "context_budget_exceeded", "对话固定引用超过上下文容量，请减少引用后重试")
	}
	msg := ai.Message{Role: "user"}
	if err := s.agentAppendResolvedContext(ctx, st, &msg, resolved); err != nil {
		return nil, 0, err
	}
	return []ai.Message{msg}, chars, nil
}

func (s *Server) agentAppendResolvedContext(ctx context.Context, st *agentRunState, msg *ai.Message,
	refs []agentResolvedContext) error {
	blocks := []string{}
	for _, ref := range refs {
		source := ref.Type + " " + ref.ID.String() + " · " + ref.Name + " · " + ref.Scope
		if ref.Type == "image" {
			if st.Vision && len(msg.Images) < agentMaxImagesToModel {
				a, err := s.assetRow(ctx, ref.ID)
				if err != nil {
					return apiErr(422, "agent_context_unavailable", "所选图片已失效，请重新选择")
				}
				data, err := s.assetBytes(a)
				if err != nil {
					return apiErr(422, "agent_context_unavailable", "所选图片文件不可读取，请重新选择")
				}
				msg.Images = append(msg.Images, "data:"+a.Mime+";base64,"+base64.StdEncoding.EncodeToString(data))
				blocks = append(blocks, "图片来源："+source)
			} else if !st.Vision {
				blocks = append(blocks, "图片来源："+source+"（当前模型不能分析图片内容）")
			} else {
				blocks = append(blocks, "图片来源："+source+"（本条消息图片数已达上限）")
			}
			continue
		}
		blocks = append(blocks, "来源："+source+"\n"+ref.Content)
	}
	if len(blocks) > 0 {
		if strings.TrimSpace(msg.Content) != "" {
			msg.Content += "\n\n"
		}
		msg.Content += agentDataBlock("引用资料", strings.Join(blocks, "\n\n"))
	}
	return nil
}

// agentAttachToMessage 把附件附到用户消息上（第 6.2 节第 4、5 项）。
// 图片只在“附带该图片的用户消息所触发的运行”中以多模态发送；之后的运行替换为文字占位。
// 文本附件全文以数据块附在消息后，单个最多 20000 字。
func (s *Server) agentAttachToMessage(ctx context.Context, st *agentRunState, msg *ai.Message,
	m agentRawMessage) error {
	if len(m.Attachments) == 0 {
		return nil
	}
	own := m.RunID != nil && *m.RunID == st.RunID
	texts := []string{}
	for _, id := range m.Attachments {
		a, err := s.agentAttachmentOf(ctx, id, st.ConversationID)
		if err != nil {
			return err
		}
		if a == nil {
			continue
		}
		switch a.Kind {
		case "image":
			if own && st.Vision && len(msg.Images) < agentMaxImagesToModel {
				if url, err := s.agentAttachmentDataURL(a); err == nil && url != "" {
					msg.Images = append(msg.Images, url)
					continue
				}
			}
			texts = append(texts, "[图片 "+a.ID.String()+"，已在先前发送]")
		case "text":
			// 第 6.2 节第 5 项：单个附件最多 20000 字，超出截断并注明。
			content := a.TextContent
			if runeLen(content) > agentAttachmentChars {
				content = truncate(content, agentAttachmentChars) + "\n（文本附件过长，已截断；全文仍可用于来源校验与工具输入）"
			}
			texts = append(texts, "文本附件 "+a.Name+"：\n"+content)
		}
	}
	if len(texts) > 0 {
		msg.Content += "\n\n" + agentDataBlock("附件", strings.Join(texts, "\n\n"))
	}
	return nil
}

// agentAttachmentRow 是上下文组装需要的附件字段。
type agentAttachmentRow struct {
	ID          uuid.UUID
	Kind        string
	Name        string
	Mime        string
	StoragePath string
	TextContent string
}

// agentAttachmentOf 读取一个属于本人的附件；不属于本人时返回 nil。
func (s *Server) agentAttachmentOf(ctx context.Context, id, conversationID uuid.UUID) (*agentAttachmentRow, error) {
	var a agentAttachmentRow
	err := s.db.QueryRow(ctx, `SELECT id, kind, name, mime, storage_path, coalesce(text_content,'')
		FROM agent_attachment WHERE id=$1 AND workspace_id=$2 AND user_id=$3
		AND EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=agent_attachment.id AND r.conversation_id=$4)`,
		id, ident(ctx).WorkspaceID, ident(ctx).UserID, conversationID).
		Scan(&a.ID, &a.Kind, &a.Name, &a.Mime, &a.StoragePath, &a.TextContent)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &a, nil
}

// agentAttachmentDataURL 把图片附件读成 data URL（第 6.2 节第 4 项、第 8.3 节第 1 项）：
// 优先使用 model 变体（长边 1568 的 JPEG）；历史文件缺少变体时回退原图。
func (s *Server) agentAttachmentDataURL(a *agentAttachmentRow) (string, error) {
	raw, err := os.ReadFile(s.agentAttachmentFile(agentAttachmentVariantPath(a.StoragePath, "model")))
	mime := "image/jpeg"
	if err != nil {
		raw, err = os.ReadFile(s.agentAttachmentFile(a.StoragePath))
		if err != nil {
			return "", err
		}
		mime = a.Mime
		if strings.TrimSpace(mime) == "" {
			mime = "image/png"
		}
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}
