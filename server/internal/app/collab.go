package app

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 协作（10 文档模块 L）：批注与 @提及、在线状态、作品动态。批注不改正文，观察者也可以批注。

type Comment struct {
	ID         uuid.UUID   `json:"id"`
	WorkID     uuid.UUID   `json:"work_id"`
	SectionID  *uuid.UUID  `json:"section_id"`
	AnchorText string      `json:"anchor_text"`
	Body       string      `json:"body"`
	AuthorID   uuid.UUID   `json:"author_id"`
	AuthorName string      `json:"author_name"`
	Mentions   []uuid.UUID `json:"mentions"`
	ResolvedAt *time.Time  `json:"resolved_at"`
	CreatedAt  time.Time   `json:"created_at"`
}

const commentCols = `c.id, c.work_id, c.section_id, c.anchor_text, c.body, c.author_id, coalesce(u.username,''), c.mentions, c.resolved_at, c.created_at`

func scanComment(row interface{ Scan(...any) error }) (Comment, error) {
	var c Comment
	err := row.Scan(&c.ID, &c.WorkID, &c.SectionID, &c.AnchorText, &c.Body, &c.AuthorID, &c.AuthorName, &c.Mentions, &c.ResolvedAt, &c.CreatedAt)
	return c, err
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+commentCols+` FROM comment c LEFT JOIN app_user u ON u.id=c.author_id
		WHERE c.work_id=$1 ORDER BY c.created_at`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Comment{}
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return err
		}
		list = append(list, c)
	}
	return ok(w, list)
}

var mentionRe = regexp.MustCompile(`@([\p{L}\p{N}_.-]{1,32})`)

// resolveMentions maps @username tokens and explicit ids to active members of the current workspace.
func (s *Server) resolveMentions(ctx context.Context, body string, ids []uuid.UUID) []uuid.UUID {
	names := []string{}
	for _, m := range mentionRe.FindAllStringSubmatch(body, -1) {
		names = append(names, m[1])
	}
	out := []uuid.UUID{}
	rows, err := s.db.Query(ctx, `SELECT u.id FROM workspace_member wm JOIN app_user u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 AND wm.status='active' AND (u.username = ANY($2) OR u.id = ANY($3))`, ident(ctx).WorkspaceID, names, ids)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		SectionID  *uuid.UUID  `json:"section_id"`
		AnchorText string      `json:"anchor_text"`
		Body       string      `json:"body"`
		Mentions   []uuid.UUID `json:"mentions"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" {
		return validation("请填写批注内容")
	}
	if runeLen(in.Body) > 2000 {
		return validation("批注最多 2000 字")
	}
	if in.SectionID != nil {
		var x uuid.UUID
		if err := s.db.QueryRow(ctx, `SELECT id FROM work_section WHERE id=$1 AND work_id=$2`, *in.SectionID, m.ID).Scan(&x); err != nil {
			return validation("段落不存在")
		}
	}
	me := ident(ctx)
	mentions := s.resolveMentions(ctx, in.Body, in.Mentions)
	var id uuid.UUID
	if err := s.db.QueryRow(ctx, `INSERT INTO comment (work_id, section_id, anchor_text, body, author_id, mentions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		m.ID, in.SectionID, truncate(strings.TrimSpace(in.AnchorText), 200), in.Body, me.UserID, mentions).Scan(&id); err != nil {
		return err
	}
	link := "/works/" + m.ID.String() + "?comment=" + id.String()
	for _, u := range mentions {
		if u != me.UserID {
			s.notify(ctx, me.WorkspaceID, u, "mention", me.Username+" 在《"+m.Title+"》中提到了你", truncate(in.Body, 80), link, "")
		}
	}
	c, err := scanComment(s.db.QueryRow(ctx, `SELECT `+commentCols+` FROM comment c LEFT JOIN app_user u ON u.id=c.author_id WHERE c.id=$1`, id))
	if err != nil {
		return err
	}
	return ok(w, c)
}

func (s *Server) patchComment(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var workID, author uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT c.work_id, c.author_id FROM comment c JOIN work w ON w.id=c.work_id JOIN platform_account a ON a.id=w.account_id
		WHERE c.id=$1 AND a.workspace_id=$2`, id, ident(ctx).WorkspaceID).Scan(&workID, &author); err != nil {
		return err
	}
	var in struct {
		Resolved *bool   `json:"resolved"`
		Body     *string `json:"body"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	me := ident(ctx)
	if in.Body != nil {
		if author != me.UserID {
			return apiErr(403, "forbidden", "只能修改自己的批注")
		}
		b := strings.TrimSpace(*in.Body)
		if b == "" {
			return validation("请填写批注内容")
		}
		if _, err := s.db.Exec(ctx, `UPDATE comment SET body=$2 WHERE id=$1`, id, b); err != nil {
			return err
		}
	}
	if in.Resolved != nil {
		if *in.Resolved {
			_, err = s.db.Exec(ctx, `UPDATE comment SET resolved_at=now(), resolved_by=$2 WHERE id=$1`, id, me.UserID)
		} else {
			_, err = s.db.Exec(ctx, `UPDATE comment SET resolved_at=NULL, resolved_by=NULL WHERE id=$1`, id)
		}
		if err != nil {
			return err
		}
	}
	return ok(w, map[string]any{"ok": true})
}

// ---------- 在线状态（进程内，30 秒过期） ----------

type presenceEntry struct {
	UserID    uuid.UUID  `json:"user_id"`
	Username  string     `json:"username"`
	SectionID *uuid.UUID `json:"section_id"`
	Editing   bool       `json:"editing"`
	At        time.Time  `json:"at"`
	editedAt  time.Time
}

const (
	presenceTTL = 30 * time.Second
	editingTTL  = 15 * time.Second
)

func (s *Server) presenceList(workID, exclude uuid.UUID) []presenceEntry {
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	now := s.now()
	list := []presenceEntry{}
	for uid, e := range s.presence[workID] {
		if now.Sub(e.At) > presenceTTL {
			delete(s.presence[workID], uid)
			continue
		}
		if uid != exclude {
			e.Editing = e.SectionID != nil && now.Sub(e.editedAt) < editingTTL
			list = append(list, e)
		}
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Username < list[j].Username })
	return list
}

func (s *Server) postPresence(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		SectionID *uuid.UUID `json:"section_id"`
		Editing   bool       `json:"editing"`
		Leave     bool       `json:"leave"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	me := ident(r.Context())
	s.presenceMu.Lock()
	if s.presence[m.ID] == nil {
		s.presence[m.ID] = map[uuid.UUID]presenceEntry{}
	}
	if in.Leave {
		delete(s.presence[m.ID], me.UserID)
	} else {
		prev := s.presence[m.ID][me.UserID]
		e := presenceEntry{UserID: me.UserID, Username: me.Username, SectionID: in.SectionID, At: s.now()}
		if in.Editing {
			e.editedAt = s.now()
		} else if prev.SectionID != nil && in.SectionID != nil && *prev.SectionID == *in.SectionID {
			e.editedAt = prev.editedAt
		}
		s.presence[m.ID][me.UserID] = e
	}
	s.presenceMu.Unlock()
	return ok(w, s.presenceList(m.ID, me.UserID))
}

func (s *Server) getPresence(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	return ok(w, s.presenceList(m.ID, ident(r.Context()).UserID))
}

// ---------- 作品动态 ----------

type ActivityItem struct {
	Kind   string    `json:"kind"`
	Actor  string    `json:"actor"`
	Text   string    `json:"text"`
	Target string    `json:"target"`
	At     time.Time `json:"at"`
}

var activityActions = map[string]string{
	"work_create": "创建了作品", "outline_confirm": "确认了大纲", "check_complete": "完成了发布前检查", "wechat_push": "写入了草稿箱",
	"xhs_pack": "生成了发布包", "mark_published": "标记为已发布", "work_unlock": "解锁了作品", "version_restore": "恢复了历史版本",
	"review_approve": "审阅通过", "work_assign": "调整了负责人", "work_reviewer": "指定了审阅人", "work_derive": "从源作品派生出这篇",
	"storyboard_confirm": "确认了分镜", "work_delete": "删除了作品", "organize_notes_apply": "把笔记整理成了段落", "trash_restore": "从回收站恢复了作品",
}

var revisionOrigins = map[string]string{"ai": "AI 起草", "manual": "手动编辑", "edit": "AI 修改", "restore": "恢复版本", "continue": "AI 续写"}

func (s *Server) workActivity(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	list := []ActivityItem{}
	rows, err := s.db.Query(ctx, `SELECT l.action, coalesce(u.username,'系统'), l.created_at FROM audit_log l LEFT JOIN app_user u ON u.id=l.actor_id
		WHERE l.target_id=$1 ORDER BY l.created_at DESC LIMIT 100`, m.ID.String())
	if err != nil {
		return err
	}
	for rows.Next() {
		var action, actor string
		var at time.Time
		if rows.Scan(&action, &actor, &at) == nil {
			text, known := activityActions[action]
			if !known {
				text = action
			}
			list = append(list, ActivityItem{Kind: "action", Actor: actor, Text: text, At: at})
		}
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `SELECT r.origin, coalesce(u.username,''), coalesce(nullif(ws.heading,''), '第 '||(ws.position+1)||' 段'), r.created_at
		FROM section_revision r JOIN work_section ws ON ws.id=r.section_id LEFT JOIN app_user u ON u.id=r.created_by
		WHERE ws.work_id=$1 ORDER BY r.created_at DESC LIMIT 100`, m.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var origin, actor, target string
		var at time.Time
		if rows.Scan(&origin, &actor, &target, &at) == nil {
			list = append(list, ActivityItem{Kind: "section", Actor: nz(actor, "成员"), Text: nz(revisionOrigins[origin], origin), Target: target, At: at})
		}
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `SELECT coalesce(u.username,''), c.body, c.created_at FROM comment c LEFT JOIN app_user u ON u.id=c.author_id
		WHERE c.work_id=$1 ORDER BY c.created_at DESC LIMIT 50`, m.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var actor, body string
		var at time.Time
		if rows.Scan(&actor, &body, &at) == nil {
			list = append(list, ActivityItem{Kind: "comment", Actor: actor, Text: "添加了批注", Target: truncate(body, 40), At: at})
		}
	}
	rows.Close()
	sort.Slice(list, func(i, j int) bool { return list[i].At.After(list[j].At) })
	if len(list) > 100 {
		list = list[:100]
	}
	return ok(w, list)
}
