package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// 卡片提出阶段（16 文档第 5.2 节）。来源校验（第 4 节）与预览读取 / 指纹（第 5.2 节第 5 项、
// 第 5.3 节第 6 项）归属 DEV-AG06，这里以接缝形式接入。

// agentProposalResult 是来源校验的结果（第 4.5 节）。
type agentProposalResult struct {
	// Blanked 是 U 类字段校验失败、需要清空并请用户亲填的字段。
	Blanked []string
	// Failed 是 G / O 类字段校验失败、必须拒绝创建卡片的字段。
	Failed []string
	// Hits 是逐字段的来源命中，执行阶段据此注入 applied（第 4.4 节第 6 项）。
	Hits map[string]agentProvenanceHit
}

// agentProvenanceCheck 按第 4 节对工具参数做来源校验。DEV-AG05 曾以“全部通过”占位，
// 本任务（DEV-AG06）替换为真实算法：归一化后必须是本对话某一个候选来源的连续子串。
func (s *Server) agentProvenanceCheck(ctx context.Context, st *agentRunState, t *AgentTool,
	args map[string]any) (agentProposalResult, error) {
	blanked, failed, hits, err := s.agentProvenanceBlanked(ctx, st, t, args)
	if err != nil {
		return agentProposalResult{}, err
	}
	return agentProposalResult{Blanked: blanked, Failed: failed, Hits: hits}, nil
}

// agentPropose 处理一个 W / H / X 工具调用：校验后写 agent_action，不执行任何写入。
func (s *Server) agentPropose(ctx context.Context, st *agentRunState, id *identity, t *AgentTool,
	call ai.ToolCall, args map[string]any, send func(string, any)) error {
	// 第 5.5 节：单次运行卡片数上限。
	if st.ActionsProposed >= agentMaxCards {
		return s.agentToolLimit(ctx, st, call, "本次运行提出的卡片已达上限（"+agentItoa(agentMaxCards)+" 张），请先处理已有卡片", send)
	}
	// 第 3.4 节第 6 条：整体替换类先读当前完整值作为底稿，合并得到完整请求体。
	whole := agentIsWholeReplace(t)
	var before map[string]any
	if whole {
		if before = s.agentPreviewRead(ctx, st, t, args); before == nil {
			return s.agentToolError(ctx, st, call, "internal", "读取当前配置失败，暂时不能提出这张卡片", send)
		}
		args = agentWholeReplaceMerge(t, args, before)
	}
	targetType, targetKey, targetID, workID := s.agentActionTarget(ctx, st, t, args)

	// 第 5.5 节：同一用户、同一目标、同一工具最多一张未结束卡片。
	if clash, why := s.agentOpenCard(ctx, st, t, targetKey, workID); clash != uuid.Nil {
		return s.agentCardClash(ctx, st, call, clash, why, send)
	}

	// 第 5.2 节第 4 项：来源校验（第 4 节）。
	prov, err := s.agentProvenanceCheck(ctx, st, t, args)
	if err != nil {
		return err
	}
	if len(prov.Failed) > 0 {
		msg := "这些字段必须来自生成工具结果或用户原文：" + strings.Join(prov.Failed, "、") + "；可以先调用生成工具再提出卡片"
		payload, _ := json.Marshal(map[string]any{"ok": false,
			"error": map[string]any{"code": "content_provenance_failed", "message": msg}})
		return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: msg}, false, send)
	}
	// 第 5.6 节：H-03/H-04/H-05/H-09 等卡片需要条目专属的当前状态与额外差异；
	// 钩子同时把提出时的守卫值（如 base_revision）写入参数，随卡片冻结。
	var extraChanges []agentChange
	if t.ProposePreview != nil {
		changes, hookBefore, err := t.ProposePreview(ctx, s, st, t, args)
		if err != nil {
			return s.agentToolError(ctx, st, call, "internal", "读取当前状态失败，暂时不能提出这张卡片", send)
		}
		extraChanges = changes
		if hookBefore != nil {
			before = hookBefore
		}
	}
	frozen := agentFrozenArgs(args, prov.Blanked)

	// 第 5.2 节第 5 项：按 Preview 规则读“修改前”的值并生成逐字段差异；
	// 第 5.3 节第 6 项：指纹用于执行前判断对象是否已被改动。
	fingerprint := ""
	if !whole && len(t.Preview.Fields) > 0 {
		before = s.agentPreviewRead(ctx, st, t, args)
	}
	if t.Fingerprint || whole {
		fingerprint = agentFingerprint(agentFingerprintFields(t), before)
	}

	// 第 5.2 节第 6 项：写 agent_action（pending，24 小时过期）。
	preview := agentBuildPreview(t, targetType, targetID, st.AccountID, st.ExternalRead)
	preview.Changes = append(agentCardChanges(t, frozen, before, prov.Blanked), extraChanges...)
	previewJSON, _ := json.Marshal(preview)
	editable := agentEditableFields(t)
	blank := append([]string{}, prov.Blanked...)
	var actionID uuid.UUID
	err = s.db.QueryRow(ctx, `INSERT INTO agent_action
		(conversation_id, run_id, batch_id, workspace_id, user_id, tool_call_id, tool_name, kind, gate,
		 body_class, target_type, target_id, target_key, work_id, status, params, preview, fingerprint,
		 editable_fields, blank_fields, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,$18,$19,now() + interval '24 hours')
		RETURNING id`,
		st.ConversationID, st.RunID, st.BatchID, st.WorkspaceID, st.UserID, call.ID, t.Name, string(t.Kind), t.Gate,
		t.BodyClass, targetType, targetID, targetKey, workID, mustJSON(frozen), previewJSON, fingerprint,
		editable, blank).Scan(&actionID)
	if err != nil {
		return err
	}
	st.ActionsProposed++
	st.CardsThisRound++

	view, err := s.agentActionByID(ctx, actionID)
	if err != nil {
		return err
	}
	if send != nil {
		send("action", view)
	}

	// 第 5.2 节第 7 项：给该 tool_call 的工具结果。
	payload, _ := json.Marshal(map[string]any{
		"status":    "pending_user_confirmation",
		"action_id": actionID.String(),
		"summary":   preview.Title,
		"note":      "需要用户在卡片上确认，确认前不会执行。不要声称已经完成。",
	})
	return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: preview.Title}, true, send)
}

// agentOpenCard 返回已存在的未结束卡片与原因（第 5.5 节）。
func (s *Server) agentOpenCard(ctx context.Context, st *agentRunState, t *AgentTool,
	targetKey string, workID *uuid.UUID) (uuid.UUID, string) {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM agent_action
		WHERE user_id=$1 AND tool_name=$2 AND target_key=$3 AND status IN ('pending','executing','needs_input')
		LIMIT 1`, st.UserID, t.Name, targetKey).Scan(&id)
	if err == nil {
		return id, "同一对象已有进行中的同类卡片"
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ""
	}
	// 第 5.5 节：同一作品最多一张未结束的正文类卡片（跨对话）。
	if t.BodyClass && workID != nil {
		var bid uuid.UUID
		err = s.db.QueryRow(ctx, `SELECT id FROM agent_action
			WHERE user_id=$1 AND work_id=$2 AND body_class AND status IN ('pending','executing','needs_input')
			LIMIT 1`, st.UserID, workID).Scan(&bid)
		if err == nil {
			return bid, "同一作品已有一张未结束的正文类卡片"
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ""
		}
	}
	return uuid.Nil, ""
}

// agentCardClash 把冲突的已有卡片作为工具结果返回，不创建新卡片。
func (s *Server) agentCardClash(ctx context.Context, st *agentRunState, call ai.ToolCall,
	clash uuid.UUID, why string, send func(string, any)) error {
	msg := why + "（action_id=" + clash.String() + "），请等它处理完或改用其他对象"
	payload, _ := json.Marshal(map[string]any{
		"ok": true, "status": "already_pending", "action_id": clash.String(), "message": msg,
	})
	return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: msg}, true, send)
}

// agentActionTarget 计算卡片的目标（第 5.5 节唯一性键）。
// target_key = 目标类型 + ":" + 目标 ID；正文类卡片同时解析 work_id 以应用作品级唯一规则。
func (s *Server) agentActionTarget(ctx context.Context, st *agentRunState, t *AgentTool, args map[string]any) (typ, key, targetID string, workID *uuid.UUID) {
	typ = t.Target.Type
	if typ == "" {
		typ = "tool"
	}
	if t.Target.Param != "" {
		targetID = agentArgStr(args, t.Target.Param)
	}
	id := targetID
	if typ == "version" {
		// 版本恢复的目标参数是版本号，作品 ID 取自路径参数 id。
		if u, err := uuid.Parse(agentArgStr(args, "id")); err == nil {
			workID, id = &u, u.String()
		}
	} else if u, err := uuid.Parse(id); err == nil {
		switch typ {
		case "work":
			// 作品即目标对象：work_id 记录作品自身，正文类唯一规则（第 5.5 节）依赖它。
			workID = &u
		case "account", "series", "material", "topic":
			// 直接以参数 ID 为目标。
		default:
			workID = s.agentWorkIDOf(ctx, u)
		}
	}
	// DEV-SK3 / 23 文档第 8.4 节：技能卡片的复合 target_key，不同目标不误合并。
	if t.Name == "skills__create" {
		nameKey := strings.ToLower(strings.TrimSpace(agentArgStr(args, "name")))
		payload := map[string]any{
			"scope": agentArgStr(args, "scope"), "workspace_id": st.WorkspaceID,
			"account_id": nilIfEmptyStr(agentArgStr(args, "account_id")), "user_id": st.UserID, "name_key": nameKey,
		}
		sum := sha256.Sum256([]byte(skillCreateTargetCanon(payload)))
		key = "skill_create:" + hex.EncodeToString(sum[:])
		return typ, key, targetID, workID
	}
	if t.Name == "skills__set_binding" {
		key = "skill_binding:" + agentArgStr(args, "accountId") + ":" + agentArgStr(args, "audience") +
			":" + agentArgStr(args, "skillId")
		return typ, key, targetID, workID
	}
	if t.Name == "topics__create" {
		accountID := agentArgStr(args, "accountId")
		if parsed, err := uuid.Parse(accountID); err == nil {
			accountID = parsed.String()
		}
		candidate := strings.ToLower(strings.TrimSpace(agentArgStr(args, "title"))) + "\x00" +
			strings.ToLower(strings.TrimSpace(agentArgStr(args, "angle")))
		sum := sha256.Sum256([]byte(accountID + "\x00" + candidate))
		key = typ + ":" + hex.EncodeToString(sum[:])
	}
	if key == "" {
		key = typ + ":" + id
	}
	return typ, key, targetID, workID
}

// agentWorkIDOf 解析段落 / 分镜 / 版本 / 段落修订所属的作品。
func (s *Server) agentWorkIDOf(ctx context.Context, id uuid.UUID) *uuid.UUID {
	var out *uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT work_id FROM (
		SELECT id, work_id FROM work_section
		UNION ALL SELECT id, work_id FROM comic_panel
		UNION ALL SELECT id, work_id FROM work_version
		UNION ALL SELECT r.id, s.work_id FROM section_revision r JOIN work_section s ON s.id = r.section_id
	) t WHERE t.id=$1`, id).Scan(&out)
	return out
}

// agentFrozenArgs 冻结提出卡片时的参数；U 类字段校验失败的字段被清空（第 4.5 节）。
func agentFrozenArgs(args map[string]any, blanked []string) map[string]any {
	out := map[string]any{}
	for k, v := range args {
		out[k] = v
	}
	for _, k := range blanked {
		out[k] = ""
	}
	return out
}

// agentEditableFields 列出卡片上可由用户修改的字段（第 5.8 节第 5 项）。
func agentEditableFields(t *AgentTool) []string {
	out := []string{}
	for _, p := range t.Params {
		if p.Editable && p.In != "path" {
			out = append(out, p.Name)
		}
	}
	return out
}

// agentBuildPreview 组装卡片预览。Preview / Fingerprint 的完整实现归属 DEV-AG06；
// 这里写入卡片展示必需的最小结构（第 5.8 节、第 11.2 节）。
func agentBuildPreview(t *AgentTool, targetType, targetID string, accountID *uuid.UUID, external bool) agentCardPreview {
	name := agentTargetLabel(targetType)
	if targetID != "" {
		name += " " + truncate(targetID, 24)
	}
	pv := agentCardPreview{
		Title:      truncate(t.Description, 40) + " · " + name,
		TargetName: name,
		AICost:     agentToolAICost(t.Name),
		Changes:    []agentChange{},
		Notices:    []string{},
	}
	if link, err := agentTargetLink(targetType, targetID, accountID); err == nil {
		pv.Link = link
	}
	if external {
		pv.Notices = append(pv.Notices, "external_source")
	}
	if t.SecondConfirm != nil {
		pv.SecondConfirm = t.SecondConfirm
	}
	if t.Gate != "" {
		pv.Notices = append(pv.Notices, t.Gate)
	}
	return pv
}

// agentTargetLabel 返回目标类型的中文名，用于卡片标题。
func agentTargetLabel(typ string) string {
	switch typ {
	case "work":
		return "作品"
	case "section":
		return "段落"
	case "section_revision":
		return "段落版本"
	case "version":
		return "作品版本"
	case "account":
		return "账号"
	case "material":
		return "素材"
	case "topic":
		return "选题"
	case "series":
		return "系列"
	case "panel":
		return "漫画分格"
	case "outline_template":
		return "大纲模板"
	case "tool":
		return "系统设置"
	case "":
		return "对象"
	default:
		return typ
	}
}

// agentTargetLink 按目标生成站内链接（第 5.8 节第 3 项）。
func agentTargetLink(targetType, targetID string, accountID *uuid.UUID) (string, error) {
	acc := ""
	if accountID != nil {
		acc = accountID.String()
	}
	switch targetType {
	case "work", "section", "section_revision", "version", "outline":
		if _, err := uuid.Parse(targetID); err != nil {
			return "", errAgentLink
		}
		return agentBuildLink("work", acc, targetID, "", "", "")
	case "account":
		if _, err := uuid.Parse(targetID); err != nil {
			return "", errAgentLink
		}
		return agentBuildLink("workbench", targetID, "", "", "", "")
	case "topic", "series":
		if _, err := uuid.Parse(targetID); err != nil {
			return "", errAgentLink
		}
		return agentBuildLink("topics", acc, "", "", "", "")
	case "material":
		if _, err := uuid.Parse(targetID); err != nil {
			return "", errAgentLink
		}
		return agentBuildLink("materials", acc, "", "", "", "")
	}
	return "", errAgentLink
}

// agentAICostTools 是执行时会调用 AI 的写入（第 5.8 节第 7 项）。
// 附录 A 没有逐条标注，这里集中登记；修改需要与用量统计口径一起核对。
var agentAICostTools = map[string]bool{
	"sections__draft": true, "sections__rewrite": true, "sections__hooks": true,
	"works__titles": true, "works__summary": true, "works__read_through": true,
	"works__organize_apply": true, "outline__generate": true, "outline__review": true,
	"storyboard__generate": true, "panels__generate_text": true,
	"materials__extract": true, "materials__tag_suggest": true, "materials__retrieve": true,
	"references__paste": true, "assets__alt_suggest": true, "assets__smart_crop": true,
	"topics__suggest": true, "topics__hot_suggest": true, "topics__score": true,
	"series__suggest": true, "strategy__options": true, "strategy__revise": true,
	"checks__fix_suggest": true, "reviews__insight": true, "words__suggest": true,
	"characters__suggest": true, "profile__bootstrap": true, "style__summarize": true,
}

// agentToolAICost 判断写入是否会调用 AI。
func agentToolAICost(name string) bool { return agentAICostTools[name] }

// mustJSON 序列化失败时返回空对象，避免把请求写坏。
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// agentStartRun 创建一次运行（第 6.1 节第 1 项）并返回其内存状态。
func (s *Server) agentStartRun(ctx context.Context, trigger string, c *agentConversation,
	model agentModelRef) (*agentRunState, error) {
	st := &agentRunState{
		RunID:          uuid.New(),
		ConversationID: c.ID,
		WorkspaceID:    ident(ctx).WorkspaceID,
		UserID:         ident(ctx).UserID,
		SessionID:      ident(ctx).SessionID,
		Trigger:        trigger,
		AccountID:      c.AccountID,
		Model:          model,
		BatchID:        uuid.New(),
		Deadline:       time.Now().Add(agentRunSeconds * time.Second),
	}
	if err := s.db.QueryRow(ctx, `INSERT INTO agent_run
		(conversation_id, workspace_id, user_id, session_id, trigger, status, stage, model_provider_id, model)
		VALUES ($1,$2,$3,$4,$5,'queued','queued',$6,$7) RETURNING id`,
		c.ID, st.WorkspaceID, st.UserID, st.SessionID, trigger, model.ProviderID, model.Model).Scan(&st.RunID); err != nil {
		return nil, err
	}
	if err := s.db.QueryRow(ctx, `SELECT loaded_domains, summary FROM agent_conversation WHERE id=$1`, c.ID).
		Scan(&st.Domains, &st.Summary); err != nil {
		return nil, err
	}
	if len(st.Domains) > agentMaxDomains {
		st.Domains = st.Domains[len(st.Domains)-agentMaxDomains:]
	}
	return st, nil
}

// skillCreateTargetCanon 以规范编码序列化 create 目标键的输入（8.4 节 name_key 取 lower(name) 口径）。
func skillCreateTargetCanon(payload map[string]any) string {
	b, err := canonJSON(payload)
	if err != nil {
		raw, _ := json.Marshal(payload)
		return string(raw)
	}
	return b
}

func nilIfEmptyStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
