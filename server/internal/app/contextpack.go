package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Slot budgets in characters for context assembler v2 (10 文档第 3.1 节).
var slotBudgets = map[string]int{
	"profile": 800, "memory": 1200, "task_instruction": 1500, "style": 4000,
	"materials": 4000, "history": 2000, "work": 3000, "user_instruction": 300,
	"strategy": 1200, "data_prefs": 500,
}

var slotLabels = map[string]string{
	"rules": "系统规则", "profile": "定位档案", "memory": "AI 记忆", "task_instruction": "工作区提示词",
	"style": "风格参考", "references": "对标方法", "materials": "素材", "history": "历史作品写法", "work": "作品内容", "user_instruction": "临时指令",
	"strategy": "运营方案",
}

type SlotItem struct {
	ID    string `json:"id,omitempty"`
	Label string `json:"label"`
	Chars int    `json:"chars"`
	Used  bool   `json:"used"`
}

type Slot struct {
	Name      string     `json:"name"`
	Label     string     `json:"label"`
	Chars     int        `json:"chars"`
	Budget    int        `json:"budget"`
	Truncated bool       `json:"truncated"`
	Items     []SlotItem `json:"items"`
}

// ContextPack is the assembled prompt plus a per-slot record of what went in (UX-10).
type ContextPack struct {
	System      string
	User        string
	Slots       []Slot
	MemoryIDs   []uuid.UUID
	DataPrefIDs []uuid.UUID
	Legacy      map[string]any
	Instruction string
	// UserRest is the user message without the editable task-instruction block (prompt regression snapshots).
	UserRest string
}

func (p *ContextPack) add(sl Slot) {
	sl.Label = slotLabels[sl.Name]
	if sl.Budget == 0 {
		sl.Budget = slotBudgets[sl.Name]
	}
	if sl.Items == nil {
		sl.Items = []SlotItem{}
	}
	p.Slots = append(p.Slots, sl)
}

// refs is what ai_call.context_refs stores and what the client renders: ids and sizes, never full text.
func (p *ContextPack) refs() map[string]any {
	out := map[string]any{}
	for k, v := range p.Legacy {
		out[k] = v
	}
	out["slots"] = p.Slots
	out["memories"] = len(p.MemoryIDs)
	if len(p.DataPrefIDs) > 0 {
		out["data_pref_ids"] = p.DataPrefIDs
	}
	if p.Instruction != "" {
		out["user_instruction"] = p.Instruction
	}
	return out
}

func profileText(a *Account, p *Profile) string {
	var b strings.Builder
	fmt.Fprintf(&b, "平台：%s；账号类型：%s；账号名：%s\n", platformNames[a.Platform], formatNames[a.ContentFormat], a.Name)
	// D-048 第 9 节：类型补充说明只影响提示词与定位文案，不扩展能力。
	if strings.TrimSpace(a.TypeNote) != "" {
		fmt.Fprintf(&b, "类型补充说明（只影响表达方式，不改创作流程）：%s\n", strings.TrimSpace(a.TypeNote))
	}
	if len(p.PositioningTags) > 0 {
		fmt.Fprintf(&b, "定位标签：%s\n", strings.Join(p.PositioningTags, "、"))
	}
	if p.TargetAudience != "" {
		fmt.Fprintf(&b, "目标读者：%s\n", p.TargetAudience)
	}
	if p.PersonaTone != "" {
		fmt.Fprintf(&b, "人设与语气：%s\n", p.PersonaTone)
	}
	if len(p.BannedWords) > 0 {
		fmt.Fprintf(&b, "禁用词（不得出现）：%s\n", strings.Join(p.BannedWords, "、"))
	}
	return b.String()
}

// buildContext fills the slots in priority order, trimming the trimmable ones to budget.
func (s *Server) buildContext(ctx context.Context, t aiTask) (*ContextPack, error) {
	p := &ContextPack{Legacy: map[string]any{}}
	var sys, usr strings.Builder

	rules := systemRules
	if t.ExtraRules != "" {
		rules += "\n" + t.ExtraRules
	}
	sys.WriteString(rules)
	p.add(Slot{Name: "rules", Chars: runeLen(rules)})

	if t.Account != nil {
		prof, err := s.loadProfile(ctx, t.Account.ID)
		if err != nil {
			return nil, err
		}
		pt := profileText(t.Account, prof)
		sys.WriteString("\n\n## 账号定位档案\n" + pt)
		p.add(Slot{Name: "profile", Chars: runeLen(pt)})
		p.Legacy["profile"] = true
		strategy, err := s.activeStrategy(ctx, t.Account.ID)
		if err != nil {
			return nil, err
		}
		if strategy != nil {
			brief := strategyBrief(strategy) + "差异化：" + strategy.Differentiation + "\n人设：" + strategy.Persona + "\n屏蔽词：" + strings.Join(strategy.BlockedWords, "、")
			text := truncateRunes(brief, slotBudgets["strategy"])
			sys.WriteString("\n\n## 当前运营方案\n" + text)
			p.add(Slot{Name: "strategy", Chars: runeLen(text), Truncated: runeLen(brief) > runeLen(text), Items: []SlotItem{{ID: strategy.ID.String(), Label: fmt.Sprintf("运营方案第 %d 版", strategy.Version), Chars: runeLen(text), Used: true}}})
		}

		scope := t.MemoryScope
		if scope == "" {
			scope = taskMemoryScope(t.Type)
		}
		mems, err := s.activeMemories(ctx, t.Account.ID, scope)
		if err != nil {
			return nil, err
		}
		if len(mems) > 0 {
			sl := Slot{Name: "memory", Budget: slotBudgets["memory"]}
			var mb strings.Builder
			for _, m := range mems {
				line := "- " + m.Text + "\n"
				used := sl.Chars+runeLen(line) <= sl.Budget
				if used {
					mb.WriteString(line)
					sl.Chars += runeLen(line)
					p.MemoryIDs = append(p.MemoryIDs, m.ID)
				} else {
					sl.Truncated = true
				}
				sl.Items = append(sl.Items, SlotItem{ID: m.ID.String(), Label: truncate(m.Text, 40), Chars: runeLen(m.Text), Used: used})
			}
			if mb.Len() > 0 {
				sys.WriteString("\n## 作者确认过的写作偏好（必须遵守）\n" + mb.String())
			}
			p.add(sl)
		}

		// DEV-A103：读者数据偏好（来自本账号数据归因的规则结论）只注入指定任务。
		if dataPrefTasks[t.Type] {
			prefs, err := s.loadDataPreferences(ctx, t.Account.ID)
			if err != nil {
				return nil, err
			}
			if len(prefs) > 0 {
				sl := Slot{Name: "data_prefs", Budget: slotBudgets["data_prefs"]}
				var pb strings.Builder
				for _, pref := range prefs {
					line := "- " + pref.Conclusion
					if pref.Basis != "" {
						line += "（依据：" + pref.Basis + "）"
					}
					line += "\n"
					used := sl.Chars+runeLen(line) <= sl.Budget
					if used {
						pb.WriteString(line)
						sl.Chars += runeLen(line)
						p.DataPrefIDs = append(p.DataPrefIDs, pref.ID)
					} else {
						sl.Truncated = true
					}
					sl.Items = append(sl.Items, SlotItem{ID: pref.ID.String(), Label: truncate(pref.Conclusion, 40), Chars: runeLen(line), Used: used})
				}
				if pb.Len() > 0 {
					sys.WriteString("\n## 读者数据偏好（来自本账号已录入数据的归因，供参考，不作为事实依据）\n" + pb.String())
				}
				p.add(sl)
			}
		}

		if !t.SkipStyle {
			text, sl, n, err := s.styleSlot(ctx, t.Account.ID, prof.StyleSummary)
			if err != nil {
				return nil, err
			}
			if text != "" {
				sys.WriteString("\n## 风格参考\n" + text)
			}
			p.add(sl)
			p.Legacy["style_samples"] = n
			p.Legacy["style_summary"] = prof.StyleSummary != ""
		}
	}

	if t.Account != nil && (strings.HasPrefix(t.Type, "section_") || t.Type == "outline") {
		text, items := s.referenceMethods(ctx, t.Account.ID)
		if text != "" {
			usr.WriteString("## 参考结构（只借鉴方法，不复用事实或原句）\n" + text)
			p.add(Slot{Name: "references", Budget: 1200, Chars: runeLen(text), Items: items})
		}
	}
	restStart := 0
	if instr, ver := s.loadTaskInstruction(ctx, t.Type); instr != "" {
		used := []rune(instr)
		sl := Slot{Name: "task_instruction", Chars: len(used)}
		usr.WriteString(instructionBlock(instr))
		restStart = usr.Len()
		sl.Items = []SlotItem{{ID: t.Type, Label: fmt.Sprintf("%s v%d", t.Type, ver), Chars: len(used), Used: true}}
		p.add(sl)
		p.Legacy["prompt_template"] = t.Type
		p.Legacy["prompt_template_version"] = ver
	}

	if len(t.Materials) > 0 {
		text, sl, names, err := s.materialsSlot(ctx, t.Materials)
		if err != nil {
			return nil, err
		}
		if text != "" {
			usr.WriteString(text + "\n")
		}
		p.add(sl)
		p.Legacy["materials"] = names
	}

	if t.History != "" && t.Account != nil && s.userPrefs(ctx).UseHistory {
		hits, err := s.retrieveHistory(ctx, t.Account, t.History, t.WorkID, 2)
		if err == nil && len(hits) > 0 {
			sl := Slot{Name: "history", Budget: slotBudgets["history"]}
			var hb strings.Builder
			for _, h := range hits {
				block := fmt.Sprintf("《%s》%s：\n%s\n\n", h.Title, h.Heading, h.Excerpt)
				used := sl.Chars+runeLen(block) <= sl.Budget
				if used {
					hb.WriteString(block)
					sl.Chars += runeLen(block)
				} else {
					sl.Truncated = true
				}
				sl.Items = append(sl.Items, SlotItem{ID: h.ID, Label: "《" + h.Title + "》" + h.Heading, Chars: runeLen(h.Excerpt), Used: used})
			}
			if hb.Len() > 0 {
				usr.WriteString("## 本账号以前写过的相似段落（只参考结构和语气，不复用其中的事实）\n" + hb.String())
			}
			p.add(sl)
		}
	}

	if t.Work != "" || t.Neighbors != "" {
		budget := slotBudgets["work"]
		main, neigh := t.Work, t.Neighbors
		sl := Slot{Name: "work", Budget: budget}
		if runeLen(main)+runeLen(neigh) > budget {
			sl.Truncated = true
			// truncate appends "…", so leave one rune for it.
			room := budget - runeLen(main) - 1
			if room <= 0 {
				neigh = ""
			} else {
				neigh = truncate(neigh, room)
			}
			if runeLen(main) > budget {
				main = truncate(main, budget-1)
			}
		}
		sl.Chars = runeLen(main) + runeLen(neigh)
		if main != "" {
			sl.Items = append(sl.Items, SlotItem{Label: "观点与大纲", Chars: runeLen(main), Used: true})
		}
		if t.Neighbors != "" {
			sl.Items = append(sl.Items, SlotItem{Label: "相邻段落", Chars: runeLen(neigh), Used: neigh != ""})
		}
		usr.WriteString(main)
		if neigh != "" {
			usr.WriteString("\n" + neigh)
		}
		usr.WriteString("\n")
		p.add(sl)
	}

	if instr := strings.TrimSpace(t.Instruction); instr != "" {
		budget := slotBudgets["user_instruction"]
		sl := Slot{Name: "user_instruction", Chars: runeLen(instr)}
		if runeLen(instr) > budget {
			instr = truncate(instr, budget-1)
			sl.Truncated = true
		}
		usr.WriteString("## 作者本次的补充要求\n作者补充要求：" + instr + "\n\n")
		sl.Items = []SlotItem{{Label: truncate(instr, 40), Chars: runeLen(instr), Used: true}}
		p.add(sl)
		p.Instruction = instr
	}

	usr.WriteString(t.User)
	usr.WriteString("\n\n任务：" + t.Type)
	p.System, p.User = sys.String(), usr.String()
	p.UserRest = p.User[restStart:]
	return p, nil
}

func instructionBlock(instr string) string {
	if strings.TrimSpace(instr) == "" {
		return ""
	}
	return "## 任务指令\n" + strings.TrimSpace(instr) + "\n\n"
}

func (s *Server) styleSlot(ctx context.Context, accountID uuid.UUID, summary string) (string, Slot, int, error) {
	sl := Slot{Name: "style", Budget: slotBudgets["style"]}
	if strings.TrimSpace(summary) != "" {
		text := "风格摘要：\n" + truncate(summary, sl.Budget)
		sl.Chars = runeLen(text)
		sl.Items = []SlotItem{{Label: "风格摘要", Chars: runeLen(summary), Used: true}}
		return text, sl, 0, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, title, content_md FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 10`, accountID)
	if err != nil {
		return "", sl, 0, err
	}
	defer rows.Close()
	var b strings.Builder
	n := 0
	for rows.Next() {
		var id uuid.UUID
		var title, content string
		if err := rows.Scan(&id, &title, &content); err != nil {
			return "", sl, 0, err
		}
		excerpt := truncateRunes(content, 800)
		used := sl.Chars+runeLen(excerpt) <= sl.Budget
		if used {
			fmt.Fprintf(&b, "《%s》片段：\n%s\n\n", title, excerpt)
			sl.Chars += runeLen(excerpt)
			n++
		} else {
			sl.Truncated = true
		}
		sl.Items = append(sl.Items, SlotItem{ID: id.String(), Label: "《" + title + "》", Chars: runeLen(content), Used: used})
	}
	if n == 0 {
		return "", sl, 0, rows.Err()
	}
	return "风格样本（只模仿语气、句式和结构，不复用其中的事实）：\n" + b.String(), sl, n, rows.Err()
}

var materialKindNames = map[string]string{"experience": "经历", "opinion": "观点", "case": "案例", "data": "数据"}

// materialsSlot keeps the caller's order (most relevant first) and drops what exceeds the budget.
func (s *Server) materialsSlot(ctx context.Context, ids []uuid.UUID) (string, Slot, []string, error) {
	sl := Slot{Name: "materials", Budget: slotBudgets["materials"]}
	rows, err := s.db.Query(ctx, `SELECT id, kind, content, source FROM material WHERE id = ANY($1) AND workspace_id=$2 AND deleted_at IS NULL`,
		ids, ident(ctx).WorkspaceID)
	if err != nil {
		return "", sl, nil, err
	}
	type mat struct{ kind, content, source string }
	found := map[uuid.UUID]mat{}
	for rows.Next() {
		var id uuid.UUID
		var m mat
		if err := rows.Scan(&id, &m.kind, &m.content, &m.source); err != nil {
			rows.Close()
			return "", sl, nil, err
		}
		found[id] = m
	}
	rows.Close()
	var b strings.Builder
	names := []string{}
	seen := map[uuid.UUID]bool{}
	for _, id := range ids {
		m, ok := found[id]
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		line := fmt.Sprintf("- [素材 id=%s][%s] %s", id, materialKindNames[m.kind], m.content)
		if m.source != "" {
			line += "（来源：" + m.source + "）"
		}
		line += "\n"
		used := sl.Chars+runeLen(line) <= sl.Budget
		if used {
			b.WriteString(line)
			sl.Chars += runeLen(line)
			names = append(names, truncate(m.content, 16))
		} else {
			sl.Truncated = true
		}
		sl.Items = append(sl.Items, SlotItem{ID: id.String(), Label: truncate(m.content, 40), Chars: runeLen(m.content), Used: used})
	}
	if b.Len() == 0 {
		return "", sl, names, nil
	}
	return "## 作者提供的素材（唯一的事实来源）\n" + b.String(), sl, names, nil
}
