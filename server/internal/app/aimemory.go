package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AI 记忆（10 文档第 3.2 节、EX-K-01）：只有人确认过的（active）记忆才会进入上下文（HC-20）。

type Memory struct {
	ID          uuid.UUID       `json:"id"`
	AccountID   uuid.UUID       `json:"account_id"`
	Kind        string          `json:"kind"`
	Scope       string          `json:"scope"`
	Text        string          `json:"text"`
	Status      string          `json:"status"`
	Source      string          `json:"source"`
	Evidence    json.RawMessage `json:"evidence"`
	UseCount    int             `json:"use_count"`
	LastUsedAt  *time.Time      `json:"last_used_at"`
	ConfirmedAt *time.Time      `json:"confirmed_at"`
	CreatedAt   time.Time       `json:"created_at"`
}

const memoryCols = `id, account_id, kind, scope, text, status, source, evidence, use_count, last_used_at, confirmed_at, created_at`

func scanMemory(row interface{ Scan(...any) error }) (Memory, error) {
	var m Memory
	err := row.Scan(&m.ID, &m.AccountID, &m.Kind, &m.Scope, &m.Text, &m.Status, &m.Source, &m.Evidence, &m.UseCount, &m.LastUsedAt, &m.ConfirmedAt, &m.CreatedAt)
	return m, err
}

var memoryKinds = map[string]bool{"tone": true, "structure": true, "wording": true, "avoid": true, "fact": true}
var memoryScopes = map[string]bool{"all": true, "draft": true, "title": true, "topic": true}

// taskMemoryScope maps a task type to the memory scope that applies to it.
func taskMemoryScope(taskType string) string {
	switch taskType {
	case "title":
		return "title"
	case "topic_suggest", "topic_hot_suggest", "topic_score", "inbox_triage", "daily_recommend":
		return "topic"
	case "section_draft", "section_edit", "section_rewrite", "section_continue", "hook_suggest", "copilot_chat", "fix_suggest", "organize_notes", "outline", "outline_review", "summary", "rewrite_plan":
		return "draft"
	}
	return ""
}

func (s *Server) activeMemories(ctx context.Context, accountID uuid.UUID, scope string, factsOnly bool) ([]Memory, error) {
	rows, err := s.db.Query(ctx, `SELECT `+memoryCols+` FROM account_memory WHERE account_id=$1 AND status='active'
		AND (($3 AND kind='fact') OR (NOT $3 AND (scope='all' OR scope=$2))) ORDER BY (kind='avoid') DESC, use_count DESC, created_at`, accountID, scope, factsOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Memory
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Server) listMemories(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+memoryCols+` FROM account_memory WHERE account_id=$1
		ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Memory{}
	for rows.Next() {
		m, err := scanMemory(rows)
		if err != nil {
			return err
		}
		list = append(list, m)
	}
	return ok(w, list)
}

// createMemory adds a rule the author wrote themselves, so it is active at once.
func (s *Server) createMemory(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Kind   string `json:"kind"`
		Scope  string `json:"scope"`
		Text   string `json:"text"`
		Source string `json:"source"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	switch in.Source {
	case "review", "breakdown":
	default:
		in.Source = "manual"
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" || runeLen(in.Text) > 200 {
		return validation("记忆需要 1 到 200 字")
	}
	if !memoryKinds[in.Kind] {
		in.Kind = "wording"
	}
	if !memoryScopes[in.Scope] {
		in.Scope = "all"
	}
	uid := ident(r.Context()).UserID
	m, err := scanMemory(s.db.QueryRow(r.Context(), `INSERT INTO account_memory (account_id, kind, scope, text, status, source, created_by, confirmed_by, confirmed_at)
		VALUES ($1,$2,$3,$4,'active',$6,$5,$5,now()) RETURNING `+memoryCols, a.ID, in.Kind, in.Scope, in.Text, uid, in.Source))
	if err != nil {
		return err
	}
	s.audit(r.Context(), "memory_create", "account_memory", m.ID.String(), "ok", nil)
	return ok(w, m)
}

func (s *Server) ownedMemory(r *http.Request) (*Memory, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, err
	}
	m, err := scanMemory(s.db.QueryRow(r.Context(), `SELECT `+prefixCols(memoryCols, "m.")+` FROM account_memory m
		JOIN platform_account a ON a.id=m.account_id WHERE m.id=$1 AND a.workspace_id=$2`, id, ident(r.Context()).WorkspaceID))
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// patchMemory edits or changes the status of exactly one memory; confirming = status active.
func (s *Server) patchMemory(w http.ResponseWriter, r *http.Request) error {
	m, err := s.ownedMemory(r)
	if err != nil {
		return err
	}
	var in struct {
		Kind   *string `json:"kind"`
		Scope  *string `json:"scope"`
		Text   *string `json:"text"`
		Status *string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Kind != nil && !memoryKinds[*in.Kind] {
		return validation("记忆类型不正确")
	}
	if in.Scope != nil && !memoryScopes[*in.Scope] {
		return validation("作用范围不正确")
	}
	if in.Text != nil {
		t := strings.TrimSpace(*in.Text)
		if t == "" || runeLen(t) > 200 {
			return validation("记忆需要 1 到 200 字")
		}
		in.Text = &t
	}
	if in.Status != nil && *in.Status != "active" && *in.Status != "disabled" && *in.Status != "suggested" {
		return validation("状态只能是生效、停用或待确认")
	}
	ctx := r.Context()
	confirm := in.Status != nil && *in.Status == "active" && m.Status != "active"
	var confirmedBy *uuid.UUID
	if confirm {
		u := ident(ctx).UserID
		confirmedBy = &u
	}
	out, err := scanMemory(s.db.QueryRow(ctx, `UPDATE account_memory SET kind=coalesce($2,kind), scope=coalesce($3,scope), text=coalesce($4,text),
		status=coalesce($5,status), confirmed_by=coalesce($6,confirmed_by), confirmed_at=CASE WHEN $6::uuid IS NOT NULL THEN now() ELSE confirmed_at END,
		updated_at=now() WHERE id=$1 RETURNING `+memoryCols, m.ID, in.Kind, in.Scope, in.Text, in.Status, confirmedBy))
	if err != nil {
		return err
	}
	if confirm {
		s.audit(ctx, "memory_confirm", "account_memory", m.ID.String(), "ok", nil)
	}
	return ok(w, out)
}

func (s *Server) deleteMemory(w http.ResponseWriter, r *http.Request) error {
	m, err := s.ownedMemory(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `DELETE FROM account_memory WHERE id=$1`, m.ID); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// suggestMemory inserts a suggested memory unless a similar one already exists (any status).
func (s *Server) suggestMemory(ctx context.Context, accountID uuid.UUID, kind, scope, text, source string, evidence map[string]any) (bool, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return false, nil
	}
	var dup bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM account_memory WHERE account_id=$1 AND (text=$2 OR similarity(text,$2) >= 0.6))`,
		accountID, text).Scan(&dup); err != nil || dup {
		return false, err
	}
	if !memoryKinds[kind] {
		kind = "wording"
	}
	if !memoryScopes[scope] {
		scope = "all"
	}
	ev, _ := json.Marshal(evidence)
	var createdBy *uuid.UUID
	if id := ident(ctx); id != nil && id.UserID != uuid.Nil {
		createdBy = &id.UserID
	}
	_, err := s.db.Exec(ctx, `INSERT INTO account_memory (account_id, kind, scope, text, status, source, evidence, created_by)
		VALUES ($1,$2,$3,$4,'suggested',$5,$6,$7)`, accountID, kind, scope, truncateRunes(text, 200), source, ev, createdBy)
	return err == nil, err
}

func guessMemoryKind(text string) string {
	for _, w := range []string{"不要", "别", "避免", "少用", "不用", "禁止"} {
		if strings.Contains(text, w) {
			return "avoid"
		}
	}
	for _, w := range []string{"口语", "严谨", "语气", "亲切", "幽默"} {
		if strings.Contains(text, w) {
			return "tone"
		}
	}
	return "wording"
}

// learnFromInstruction turns an instruction used three or more times into a suggested memory.
func (s *Server) learnFromInstruction(ctx context.Context, a *Account, instr string) {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM ai_call WHERE account_id=$1 AND status='ok' AND created_at > now() - interval '90 days'
		AND context_refs ? 'user_instruction' AND (context_refs->>'user_instruction' = $2 OR similarity(context_refs->>'user_instruction', $2) >= 0.6)`,
		a.ID, instr).Scan(&n); err != nil || n < 3 {
		return
	}
	added, err := s.suggestMemory(ctx, a.ID, guessMemoryKind(instr), "draft", instr, "instruction",
		map[string]any{"count": n, "note": fmt.Sprintf("你在 %d 次生成中都提出了这条要求", n)})
	if err != nil {
		slog.Warn("生成记忆建议失败", "err", err)
		return
	}
	if added {
		if id := ident(ctx); id != nil {
			s.notify(ctx, id.WorkspaceID, id.UserID, "memory", "AI 学到了 1 条新偏好，去确认", "「"+truncate(instr, 30)+"」", "/a/"+a.ID.String()+"/profile?tab=memory", "")
		}
	}
}

// ---------- 记忆提炼（DEV-V331）：采纳差异与放弃记录 ----------

type distillPair struct {
	AI, Final string
}

func (s *Server) distillInputs(ctx context.Context, accountID uuid.UUID, since time.Time) ([]distillPair, []string, []string, error) {
	rows, err := s.db.Query(ctx, `SELECT s.ai_raw_md, s.content_md FROM work_section s JOIN work w ON w.id=s.work_id
		WHERE w.account_id=$1 AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND s.ai_raw_md<>'' AND s.content_md<>s.ai_raw_md AND s.updated_at > $2
		ORDER BY s.updated_at DESC LIMIT 40`, accountID, since)
	if err != nil {
		return nil, nil, nil, err
	}
	var pairs []distillPair
	for rows.Next() {
		var p distillPair
		if rows.Scan(&p.AI, &p.Final) != nil {
			continue
		}
		ai := []rune(p.AI)
		if len(ai) == 0 {
			continue
		}
		if float64(runeDistance(ai, []rune(p.Final)))/float64(len(ai)) >= 0.3 {
			pairs = append(pairs, p)
		}
	}
	rows.Close()
	frows, err := s.db.Query(ctx, `SELECT f.reason_tags, f.note, c.task_type FROM ai_feedback f JOIN ai_call c ON c.id=f.ai_call_id
		WHERE c.account_id=$1 AND (f.outcome='rejected' OR f.rating=-1) AND f.updated_at > $2 ORDER BY f.updated_at DESC LIMIT 40`, accountID, since)
	if err != nil {
		return nil, nil, nil, err
	}
	var rejections []string
	for frows.Next() {
		var tags []string
		var note, task string
		if frows.Scan(&tags, &note, &task) == nil {
			rejections = append(rejections, fmt.Sprintf("%s：%s %s", taskLabel(task), strings.Join(tags, "、"), note))
		}
	}
	frows.Close()
	// DEV-A102：作者大幅修改过的输出（edit_ratio ≥ 0.3）也是最强的偏好信号之一。
	erows, err := s.db.Query(ctx, `SELECT c.task_type, f.edit_ratio, f.reason_tags, f.note FROM ai_feedback f JOIN ai_call c ON c.id=f.ai_call_id
		WHERE c.account_id=$1 AND f.outcome='edited' AND f.edit_ratio >= 0.3 AND f.updated_at > $2 ORDER BY f.updated_at DESC LIMIT 20`, accountID, since)
	if err != nil {
		return nil, nil, nil, err
	}
	var edited []string
	for erows.Next() {
		var task string
		var ratio float64
		var tags []string
		var note string
		if erows.Scan(&task, &ratio, &tags, &note) == nil {
			line := fmt.Sprintf("%s：作者修改了 %.0f%%", taskLabel(task), ratio*100)
			if len(tags) > 0 {
				line += "（" + strings.Join(tags, "、") + "）"
			}
			if note != "" {
				line += "：" + note
			}
			edited = append(edited, line)
		}
	}
	erows.Close()
	return pairs, rejections, edited, nil
}

// distillMemories runs memory_distill for one account; returns how many suggestions were added.
// aggregateRejectionTags turns repeatedly-rejected reason tags into memory candidates
// (DEV-A102)：同一任务类型的同一被拒原因出现 ≥3 次，就值得让作者确认一条避免性偏好。
func (s *Server) aggregateRejectionTags(ctx context.Context, a *Account, since time.Time) (int, error) {
	rows, err := s.db.Query(ctx, `SELECT c.task_type, tag, count(*) FROM ai_feedback f JOIN ai_call c ON c.id=f.ai_call_id,
		unnest(f.reason_tags) AS tag WHERE c.account_id=$1 AND f.outcome='rejected' AND f.updated_at > $2
		GROUP BY c.task_type, tag HAVING count(*) >= 3 ORDER BY count(*) DESC LIMIT 3`, a.ID, since)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	added := 0
	for rows.Next() {
		var task, tag string
		var n int
		if err := rows.Scan(&task, &tag, &n); err != nil {
			return added, err
		}
		scope := taskMemoryScope(task)
		if scope == "" {
			scope = "all"
		}
		text := fmt.Sprintf("「%s」类输出常因「%s」被拒（出现 %d 次），生成时避免同类问题", taskLabel(task), tag, n)
		ok, err := s.suggestMemory(ctx, a.ID, "avoid", scope, text, "rejection", map[string]any{"count": n, "note": fmt.Sprintf("最近 60 天被拒 %d 次的相同原因", n)})
		if err != nil {
			return added, err
		}
		if ok {
			added++
		}
	}
	return added, rows.Err()
}

func (s *Server) distillMemories(ctx context.Context, a *Account, since time.Time) (int, *uuid.UUID, error) {
	pairs, rejections, edited, err := s.distillInputs(ctx, a.ID, since)
	if err != nil {
		return 0, nil, err
	}
	// DEV-A102：被拒原因聚合不依赖提炼阈值，独立产出候选。
	tagAdded, err := s.aggregateRejectionTags(ctx, a, since)
	if err != nil {
		return 0, nil, err
	}
	if len(pairs) < 5 && len(rejections) < 5 {
		return tagAdded, nil, nil
	}
	existing, _ := s.activeMemories(ctx, a.ID, "", false)
	var b strings.Builder
	if len(pairs) >= 5 {
		b.WriteString("## AI 原稿与作者终稿对比\n")
		for i, p := range pairs {
			if i >= 8 {
				break
			}
			fmt.Fprintf(&b, "### 第 %d 组\nAI 原稿：%s\n作者终稿：%s\n\n", i+1, truncate(p.AI, 400), truncate(p.Final, 400))
		}
	}
	if len(rejections) >= 5 {
		b.WriteString("## 作者放弃或点踩的 AI 建议（原因）\n")
		for _, x := range rejections {
			b.WriteString("- " + x + "\n")
		}
	}
	if len(edited) > 0 {
		b.WriteString("## 作者大幅修改过的 AI 输出（改动模式）\n")
		for _, x := range edited {
			b.WriteString("- " + x + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("\n## 已有记忆（不要重复）\n")
	for _, m := range existing {
		b.WriteString("- " + m.Text + "\n")
	}
	user := b.String() + `
## 任务说明
总结作者修改 AI 输出的规律，提炼最多 3 条可执行的写作偏好规则（如"句子控制在 25 字以内"，而不是"写得更好"）。不推断作者隐私，不与已有记忆重复。

## 输出格式
只输出 JSON：{"memories":[{"kind":"tone|structure|wording|avoid","scope":"all|draft|title|topic","text":"一句话规则","evidence":"依据"}]}`
	var out struct {
		Memories []struct {
			Kind     string `json:"kind"`
			Scope    string `json:"scope"`
			Text     string `json:"text"`
			Evidence string `json:"evidence"`
		} `json:"memories"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "memory_distill", Account: a, User: user, SkipStyle: true}, &out, nil)
	if err != nil {
		return 0, nil, err
	}
	added := 0
	source := "edit_diff"
	if len(pairs) < 5 {
		source = "rejection"
	}
	for i, m := range out.Memories {
		if i >= 3 {
			break
		}
		ok, err := s.suggestMemory(ctx, a.ID, m.Kind, m.Scope, m.Text, source, map[string]any{"note": m.Evidence, "pairs": len(pairs), "rejections": len(rejections)})
		if err == nil && ok {
			added++
		}
	}
	return added + tagAdded, &res.CallID, nil
}

func (s *Server) startDistill(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	id, err := s.startBackgroundJob(r.Context(), jobSpec{TaskType: "memory_distill", Label: "记忆提炼 · " + a.Name, AccountID: &a.ID,
		Link: "/a/" + a.ID.String() + "/profile?tab=memory"}, func(ctx context.Context) (any, error) {
		n, callID, err := s.distillMemories(ctx, a, s.now().AddDate(0, 0, -60))
		if err != nil {
			return nil, err
		}
		res := map[string]any{"added": n}
		if callID != nil {
			res["ai_call_id"] = *callID
		}
		return res, nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"job_id": id})
}

// distillDaily runs at most once a day per active account and only when there is new data.
func (s *Server) distillDaily(ctx context.Context) {
	day := s.today().Format("2006-01-02")
	rows, err := s.db.Query(ctx, `SELECT DISTINCT a.id, a.workspace_id FROM platform_account a JOIN work w ON w.account_id=a.id
		WHERE a.status='active' AND w.updated_at > now() - interval '1 day'`)
	if err != nil {
		return
	}
	type acc struct{ id, ws uuid.UUID }
	var list []acc
	for rows.Next() {
		var x acc
		if rows.Scan(&x.id, &x.ws) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, x := range list {
		if !s.markOnce(ctx, "distill:"+x.id.String()+":"+day) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
		a, err := s.account(jctx, x.id)
		if err != nil {
			continue
		}
		n, _, err := s.distillMemories(jctx, a, s.now().AddDate(0, 0, -1))
		if err != nil {
			slog.Warn("每日记忆提炼失败", "account", x.id, "err", err)
			continue
		}
		if n > 0 {
			s.notifyWorkspace(jctx, x.ws, []string{"owner", "editor"}, "memory", fmt.Sprintf("AI 学到了 %d 条新偏好，去确认", n),
				a.Name, "/a/"+a.ID.String()+"/profile?tab=memory", "distill:"+x.id.String()+":"+day)
		}
	}
}

// markOnce returns true the first time key is seen (idempotent scheduled work).
func (s *Server) markOnce(ctx context.Context, key string) bool {
	tag, err := s.db.Exec(ctx, `INSERT INTO job_marker (key) VALUES ($1) ON CONFLICT DO NOTHING`, key)
	return err == nil && tag.RowsAffected() == 1
}

func prefixCols(cols, prefix string) string {
	parts := strings.Split(cols, ",")
	for i, p := range parts {
		parts[i] = prefix + strings.TrimSpace(p)
	}
	return strings.Join(parts, ", ")
}
