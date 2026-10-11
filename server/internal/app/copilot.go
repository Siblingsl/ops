package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AI 副驾驶（EX-E-01）：只针对当前段落或选中内容给建议；对话按作品保存；不提供写入正文的接口（HC-17）。

const copilotRules = `6. 你是作者的写作副驾驶，只能针对当前段落或选中内容给出分析和修改建议。
7. 如果作者要求你写整篇文章或一次写多段，回答"请逐段起草"，并给出建议的段落顺序，不输出整篇或多段正文。
8. 给出可替换的文字时，用「建议改为：」开头单独成段；需要增补内容时，用「建议补充：」开头单独成段。最多三条建议，每条只针对一处，不要混合使用其他标记。`

type CopilotMessage struct {
	ID           uuid.UUID  `json:"id"`
	Role         string     `json:"role"`
	Content      string     `json:"content"`
	ContextScope string     `json:"context_scope"`
	SectionID    *uuid.UUID `json:"section_id"`
	AICallID     *uuid.UUID `json:"ai_call_id"`
	CreatedAt    time.Time  `json:"created_at"`
}

func (s *Server) listCopilot(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, role, content, context_scope, section_id, ai_call_id, created_at FROM copilot_message
		WHERE work_id=$1 ORDER BY created_at, role DESC LIMIT 200`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []CopilotMessage{}
	for rows.Next() {
		var x CopilotMessage
		if err := rows.Scan(&x.ID, &x.Role, &x.Content, &x.ContextScope, &x.SectionID, &x.AICallID, &x.CreatedAt); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) clearCopilot(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM copilot_message WHERE work_id=$1`, m.ID); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// copilotWholeWork detects requests for a full article or several paragraphs at once.
func copilotWholeWork(q string) bool {
	for _, k := range []string{"整篇", "全文", "写完", "全部段落", "所有段落", "每一段都", "一次写", "写一篇", "完整文章", "整篇文章"} {
		if strings.Contains(q, k) {
			return true
		}
	}
	return false
}

func (s *Server) chatCopilot(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Message   string     `json:"message"`
		Scope     string     `json:"scope"`
		SectionID *uuid.UUID `json:"section_id"`
		Selection string     `json:"selection"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Message = strings.TrimSpace(in.Message)
	if in.Message == "" {
		return validation("请输入问题")
	}
	if runeLen(in.Message) > 1000 {
		return validation("问题不超过 1000 字")
	}
	scope := in.Scope
	if scope != "work" && scope != "selection" {
		scope = "section"
	}
	ctx := r.Context()
	work, err := s.workBrief(ctx, m)
	if err != nil {
		return err
	}
	var focus string
	var mids []uuid.UUID
	var sec *Section
	if in.SectionID != nil {
		x, sm, err := s.sectionMeta(ctx, *in.SectionID)
		if err != nil || sm.ID != m.ID {
			return validation("段落不属于这篇作品")
		}
		sec = x
		if mids, err = s.sectionMaterialIDs(ctx, m, sec); err != nil {
			return err
		}
	} else if mids, err = s.workMaterialIDs(ctx, m.ID); err != nil {
		return err
	}
	switch {
	case scope == "selection" && strings.TrimSpace(in.Selection) != "":
		focus = "## 当前上下文：选中的文字\n" + truncate(in.Selection, 1500)
	case scope == "work":
		secs, err := s.loadSections(ctx, nil, m.ID)
		if err != nil {
			return err
		}
		focus = "## 当前上下文：整篇（仅供分析，不要输出整篇正文）\n" + bodyDigest(secs, 2500)
	case sec != nil:
		focus = fmt.Sprintf("## 当前上下文：段落「%s」\n本段要点：%s\n%s", sec.Heading, sec.KeyPoint, truncate(nz(sec.ContentMD, "（本段还是空的）"), 1500))
	default:
		focus = "## 当前上下文：作品概况"
	}
	var hist strings.Builder
	rows, err := s.db.Query(ctx, `SELECT role, content FROM (SELECT role, content, created_at FROM copilot_message WHERE work_id=$1 ORDER BY created_at DESC LIMIT 6) t ORDER BY created_at`, m.ID)
	if err == nil {
		for rows.Next() {
			var role, c string
			if rows.Scan(&role, &c) == nil {
				who := map[string]string{"user": "作者", "assistant": "副驾驶"}[role]
				fmt.Fprintf(&hist, "%s：%s\n", who, truncate(c, 300))
			}
		}
		rows.Close()
	}
	whole := copilotWholeWork(in.Message)
	user := focus + "\n"
	if hist.Len() > 0 {
		user += "\n## 之前的对话\n" + hist.String()
	}
	user += "\n## 作者的问题\n" + in.Message
	if whole {
		user += "\n（作者在请求整篇或多段正文：按规则回答\"请逐段起草\"并给出段落顺序建议。）"
	}
	var uid *uuid.UUID
	if id := ident(ctx); id != nil {
		uid = &id.UserID
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO copilot_message (work_id, role, content, context_scope, section_id, created_by) VALUES ($1,'user',$2,$3,$4,$5)`,
		m.ID, in.Message, scope, in.SectionID, uid); err != nil {
		return err
	}
	t := aiTask{Type: "copilot_chat", Account: m.Account, WorkID: &m.ID, User: user, ExtraRules: copilotRules, Materials: mids, Work: work, SkipStyle: true}
	return s.streamAIJob(w, r, t, jobMeta{Label: "副驾驶回复", Link: "/works/" + m.ID.String()}, func(text string, res *aiResult) (any, error) {
		reply := strings.TrimSpace(text)
		if whole {
			reply = copilotRefusal(reply)
		}
		var id uuid.UUID
		err := s.db.QueryRow(context.WithoutCancel(ctx), `INSERT INTO copilot_message (work_id, role, content, context_scope, section_id, ai_call_id, created_by)
			VALUES ($1,'assistant',$2,$3,$4,$5,$6) RETURNING id`, m.ID, reply, scope, in.SectionID, res.CallID, uid).Scan(&id)
		if err != nil {
			return nil, err
		}
		return map[string]any{"message_id": id, "reply": reply, "suggestion": copilotSuggestion(reply), "suggestions": copilotSuggestions(reply)}, nil
	})
}

// copilotRefusal enforces HC-17 even if the model ignores its rules: no multi-paragraph body is kept.
func copilotRefusal(reply string) string {
	paras := 0
	for _, p := range strings.Split(reply, "\n") {
		if runeLen(strings.TrimSpace(p)) > 80 {
			paras++
		}
	}
	if strings.Contains(reply, "请逐段起草") && paras <= 1 && runeLen(reply) <= 600 {
		return reply
	}
	return "请逐段起草：副驾驶不输出整篇或多段正文。建议按大纲顺序逐段起草，每段写完后再让我帮你看论证和表达。"
}

// copilotSuggestions extracts up to three applyable suggestions (DEV-A104):
// 「建议改为：」replaces the section (or selection), 「建议补充：」appends at the end.
// Applying is always per suggestion through the compare card — never batched.
func copilotSuggestions(reply string) []copilotSuggestionItem {
	out := []copilotSuggestionItem{}
	for _, line := range strings.Split(reply, "\n") {
		line = strings.TrimSpace(line)
		var kind, prefix string
		switch {
		case strings.HasPrefix(line, "建议改为："):
			kind, prefix = "rewrite", "建议改为："
		case strings.HasPrefix(line, "建议补充："):
			kind, prefix = "append", "建议补充："
		default:
			continue
		}
		text := truncate(strings.TrimSpace(strings.TrimPrefix(line, prefix)), 800)
		if text == "" {
			continue
		}
		out = append(out, copilotSuggestionItem{Kind: kind, Text: text})
		if len(out) >= 3 {
			break
		}
	}
	return out
}

type copilotSuggestionItem struct {
	Kind string `json:"kind"` // rewrite | append
	Text string `json:"text"`
}
func copilotSuggestion(reply string) string {
	i := strings.Index(reply, "建议改为：")
	if i < 0 {
		return ""
	}
	rest := strings.TrimSpace(reply[i+len("建议改为："):])
	if j := strings.Index(rest, "\n\n"); j >= 0 {
		rest = rest[:j]
	}
	return truncate(strings.TrimSpace(rest), 800)
}
