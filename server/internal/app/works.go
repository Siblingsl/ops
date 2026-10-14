package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type OutlineItem struct {
	Heading     string   `json:"heading"`
	KeyPoint    string   `json:"key_point"`
	MaterialIDs []string `json:"material_ids"`
	SectionID   string   `json:"section_id,omitempty"`
}

type Section struct {
	ID               uuid.UUID       `json:"id"`
	Position         int             `json:"position"`
	Heading          string          `json:"heading"`
	KeyPoint         string          `json:"key_point"`
	ContentMD        string          `json:"content_md"`
	AIRawMD          string          `json:"-"`
	Origin           string          `json:"origin"`
	SourceSectionIDs []uuid.UUID     `json:"source_section_ids"`
	MaterialIDs      []uuid.UUID     `json:"material_ids"`
	Revision         int             `json:"revision"`
	UpdatedAt        time.Time       `json:"updated_at"`
	AICallID         *uuid.UUID      `json:"ai_call_id"`
	SourceRevisions  json.RawMessage `json:"source_revisions"`
}

const sectionCols = `id, position, heading, key_point, content_md, ai_raw_md, origin, source_section_ids, material_ids, revision, updated_at, ai_call_id, source_revisions`

func scanSection(row interface{ Scan(...any) error }) (Section, error) {
	var x Section
	err := row.Scan(&x.ID, &x.Position, &x.Heading, &x.KeyPoint, &x.ContentMD, &x.AIRawMD, &x.Origin, &x.SourceSectionIDs, &x.MaterialIDs,
		&x.Revision, &x.UpdatedAt, &x.AICallID, &x.SourceRevisions)
	if len(x.SourceRevisions) == 0 {
		x.SourceRevisions = json.RawMessage("{}")
	}
	return x, err
}

type WorkRef struct {
	ID          uuid.UUID `json:"id"`
	Title       string    `json:"title"`
	AccountName string    `json:"account_name"`
	Platform    string    `json:"platform"`
	Deleted     bool      `json:"deleted"`
}

type Work struct {
	ID                  uuid.UUID       `json:"id"`
	AccountID           uuid.UUID       `json:"account_id"`
	Platform            string          `json:"platform"`
	AccountName         string          `json:"account_name"`
	TopicID             *uuid.UUID      `json:"topic_id"`
	TopicAngle          string          `json:"topic_angle"`
	Source              *WorkRef        `json:"source"`
	SourceUpdated       bool            `json:"source_updated"`
	Derived             []WorkRef       `json:"derived"`
	ContentFormat       string          `json:"content_format"`
	Status              string          `json:"status"`
	Title               string          `json:"title"`
	Summary             string          `json:"summary"`
	Viewpoint           string          `json:"viewpoint"`
	Outline             []OutlineItem   `json:"outline"`
	OutlineConfirmedAt  *time.Time      `json:"outline_confirmed_at"`
	Theme               string          `json:"theme"`
	CoverAssetID        *uuid.UUID      `json:"cover_asset_id"`
	CoverCrops          json.RawMessage `json:"cover_crops"`
	WechatFields        WechatDefaults  `json:"wechat_fields"`
	Topics              []string        `json:"topics"`
	Tags                []string        `json:"tags"`
	WechatDraftMediaID  *string         `json:"wechat_draft_media_id"`
	PublishedURL        *string         `json:"published_url"`
	PublishedAt         *time.Time      `json:"published_at"`
	Locked              bool            `json:"locked"`
	Revision            int             `json:"revision"`
	Sections            []Section       `json:"sections"`
	Panels              []ComicPanel    `json:"panels"`
	Cards               []WorkCard      `json:"cards"`
	MaterialIDs         []uuid.UUID     `json:"material_ids"`
	Assets              []Asset         `json:"assets"`
	HumanEditRatio      *float64        `json:"human_edit_ratio"`
	DraftMaybePublished bool            `json:"draft_maybe_published"`
	TopicAudience       string          `json:"topic_audience"`
	TopicHook           string          `json:"topic_hook"`
	PlannedDate         *string         `json:"planned_date"`
	TargetChars         *int            `json:"target_chars"`
	PostPushTodos       json.RawMessage `json:"post_push_todos"`
	TitleFavorites      json.RawMessage `json:"title_favorites"`
	AssigneeID          *uuid.UUID      `json:"assignee_id"`
	ReviewerID          *uuid.UUID      `json:"reviewer_id"`
	ReviewRequired      bool            `json:"review_required"`
	ReviewedBy          *uuid.UUID      `json:"reviewed_by"`
	ReviewedAt          *time.Time      `json:"reviewed_at"`
	CreatedAt           time.Time       `json:"created_at"`
	UpdatedAt           time.Time       `json:"updated_at"`
	sourceRevision      int
}

// workMeta is the minimal row used for permission and state checks.
type workMeta struct {
	ID                 uuid.UUID
	Account            *Account
	ContentFormat      string
	Status             string
	Locked             bool
	Revision           int
	Viewpoint          string
	OutlineConfirmedAt *time.Time
	SourceWorkID       *uuid.UUID
	Title              string
}

func (s *Server) workMeta(ctx context.Context, id uuid.UUID) (*workMeta, error) {
	var m workMeta
	var accountID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT w.id, w.account_id, w.content_format, w.status, w.locked, w.revision, w.viewpoint, w.outline_confirmed_at, w.source_work_id, w.title
		FROM work w JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`,
		id, ident(ctx).WorkspaceID).Scan(&m.ID, &accountID, &m.ContentFormat, &m.Status, &m.Locked, &m.Revision, &m.Viewpoint, &m.OutlineConfirmedAt, &m.SourceWorkID, &m.Title)
	if err != nil {
		return nil, err
	}
	m.Account, err = s.account(ctx, accountID)
	return &m, err
}

func (s *Server) workMetaFromPath(r *http.Request) (*workMeta, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, err
	}
	return s.workMeta(r.Context(), id)
}

func (m *workMeta) editable() error {
	if m.Locked {
		return stateInvalid("已发布的作品默认只读。如需修改，请先「解锁编辑」。修改不会同步到平台。")
	}
	return nil
}

// touchContent bumps the revision and invalidates checks (05 文档第 4 节规则 1).
func (s *Server) touchContent(ctx context.Context, tx pgx.Tx, workID uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE work SET revision=revision+1, updated_at=now(),
		status = CASE WHEN status IN ('ready','pushed','packed','reviewing') THEN 'drafting' ELSE status END,
		reviewed_by = NULL, reviewed_at = NULL WHERE id=$1`, workID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE work SET first_draft_at=now() WHERE id=$1 AND first_draft_at IS NULL
		AND EXISTS (SELECT 1 FROM work_section WHERE work_id=$1 AND deleted_at IS NULL)
		AND NOT EXISTS (SELECT 1 FROM work_section WHERE work_id=$1 AND deleted_at IS NULL AND btrim(content_md)='')`, workID)
	return err
}

func (s *Server) loadSections(ctx context.Context, q pgx.Tx, workID uuid.UUID) ([]Section, error) {
	var rows pgx.Rows
	var err error
	sql := `SELECT ` + sectionCols + ` FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position, created_at`
	if q != nil {
		rows, err = q.Query(ctx, sql, workID)
	} else {
		rows, err = s.db.Query(ctx, sql, workID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Section{}
	for rows.Next() {
		x, err := scanSection(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, x)
	}
	return list, rows.Err()
}

func (s *Server) loadWork(ctx context.Context, id uuid.UUID) (*Work, error) {
	var w Work
	var outline, wf []byte
	var sourceRevision *int
	var sourceID *uuid.UUID
	var topicAngle *string
	err := s.db.QueryRow(ctx, `SELECT w.id, w.account_id, a.platform, a.name, w.topic_id, t.angle, w.source_work_id, w.source_revision,
		w.content_format, w.status, w.title, w.summary, w.viewpoint, w.outline, w.outline_confirmed_at, w.theme, w.cover_asset_id,
		w.cover_crops, w.wechat_fields, w.topics, w.tags, w.wechat_draft_media_id, w.published_url, w.published_at, w.locked, w.revision,
		coalesce(w.draft_maybe_published,false), coalesce(t.audience,''), coalesce(t.hook,''), to_char(w.planned_date,'YYYY-MM-DD'), w.target_chars,
		w.post_push_todos, w.title_favorites, w.assignee_id, w.reviewer_id, w.review_required, w.reviewed_by, w.reviewed_at, w.created_at, w.updated_at
		FROM work w JOIN platform_account a ON a.id=w.account_id LEFT JOIN topic t ON t.id=w.topic_id
		WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, id, ident(ctx).WorkspaceID).Scan(
		&w.ID, &w.AccountID, &w.Platform, &w.AccountName, &w.TopicID, &topicAngle, &sourceID, &sourceRevision,
		&w.ContentFormat, &w.Status, &w.Title, &w.Summary, &w.Viewpoint, &outline, &w.OutlineConfirmedAt, &w.Theme, &w.CoverAssetID,
		&w.CoverCrops, &wf, &w.Topics, &w.Tags, &w.WechatDraftMediaID, &w.PublishedURL, &w.PublishedAt, &w.Locked, &w.Revision,
		&w.DraftMaybePublished, &w.TopicAudience, &w.TopicHook, &w.PlannedDate, &w.TargetChars,
		&w.PostPushTodos, &w.TitleFavorites, &w.AssigneeID, &w.ReviewerID, &w.ReviewRequired, &w.ReviewedBy, &w.ReviewedAt, &w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if topicAngle != nil {
		w.TopicAngle = *topicAngle
	}
	if sourceID != nil {
		w.Source = &WorkRef{ID: *sourceID}
		if sourceRevision != nil {
			w.sourceRevision = *sourceRevision
		}
	}
	_ = json.Unmarshal(outline, &w.Outline)
	if w.Outline == nil {
		w.Outline = []OutlineItem{}
	}
	_ = json.Unmarshal(wf, &w.WechatFields)
	if w.Sections, err = s.loadSections(ctx, nil, id); err != nil {
		return nil, err
	}
	if w.Panels, err = s.loadPanels(ctx, id); err != nil {
		return nil, err
	}
	if w.Panels == nil {
		w.Panels = []ComicPanel{}
	}
	if w.ContentFormat == "card_post" {
		if w.Cards, err = s.loadCards(ctx, nil, id); err != nil {
			return nil, err
		}
	}
	w.HumanEditRatio = humanEditRatio(w.Sections)
	if w.Assets, err = s.loadAssets(ctx, id); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT material_id FROM work_material WHERE work_id=$1`, id)
	if err != nil {
		return nil, err
	}
	w.MaterialIDs = []uuid.UUID{}
	for rows.Next() {
		var m uuid.UUID
		if err := rows.Scan(&m); err == nil {
			w.MaterialIDs = append(w.MaterialIDs, m)
		}
	}
	rows.Close()
	w.Derived = []WorkRef{}
	drows, err := s.db.Query(ctx, `SELECT w.id, w.title, a.name, a.platform FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.source_work_id=$1 AND w.deleted_at IS NULL ORDER BY w.created_at`, id)
	if err != nil {
		return nil, err
	}
	for drows.Next() {
		var ref WorkRef
		if err := drows.Scan(&ref.ID, &ref.Title, &ref.AccountName, &ref.Platform); err == nil {
			w.Derived = append(w.Derived, ref)
		}
	}
	drows.Close()
	return &w, nil
}

func (s *Server) writeWork(w http.ResponseWriter, r *http.Request, id uuid.UUID) error {
	wk, err := s.loadWork(r.Context(), id)
	if err != nil {
		return err
	}
	if wk.Source != nil {
		var revision int
		var deleted *time.Time
		err := s.db.QueryRow(r.Context(), `SELECT w.title, a.name, a.platform, w.revision, w.deleted_at FROM work w
			JOIN platform_account a ON a.id=w.account_id WHERE w.id=$1`, wk.Source.ID).Scan(&wk.Source.Title, &wk.Source.AccountName, &wk.Source.Platform, &revision, &deleted)
		if err != nil {
			return err
		}
		wk.Source.Deleted = deleted != nil
		wk.SourceUpdated = !wk.Source.Deleted && wk.sourceRevision > 0 && revision > wk.sourceRevision
	}
	return ok(w, wk)
}

func (s *Server) insertWork(ctx context.Context, a *Account, topicID *uuid.UUID, title, _ string) (uuid.UUID, error) {
	if a.Status != "active" {
		return uuid.Nil, stateInvalid("账号已停用，不能新建作品")
	}
	p, err := s.loadProfile(ctx, a.ID)
	if err != nil {
		return uuid.Nil, err
	}
	wf, _ := json.Marshal(p.WechatDefaults)
	var id uuid.UUID
	err = s.db.QueryRow(ctx, `INSERT INTO work (account_id, topic_id, content_format, title, theme, wechat_fields) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
		a.ID, topicID, a.ContentFormat, truncateRunes(strings.TrimSpace(title), 64), p.DefaultTheme, wf).Scan(&id)
	if err == nil {
		s.audit(ctx, "work_create", "work", id.String(), "ok", nil)
	}
	return id, err
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func (s *Server) createWork(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Title string `json:"title"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	id, err := s.insertWork(r.Context(), a, nil, in.Title, "")
	if err != nil {
		return err
	}
	return s.writeWork(w, r, id)
}

type WorkListItem struct {
	ID            uuid.UUID  `json:"id"`
	Title         string     `json:"title"`
	Tags          []string   `json:"tags"`
	Status        string     `json:"status"`
	ContentFormat string     `json:"content_format"`
	SourceWorkID  *uuid.UUID `json:"source_work_id"`
	SourceTitle   *string    `json:"source_title"`
	DerivedCount  int        `json:"derived_count"`
	CoverAssetID  *uuid.UUID `json:"cover_asset_id"`
	FirstAssetID  *uuid.UUID `json:"first_asset_id"`
	CharCount     int        `json:"char_count"`
	SectionCount  int        `json:"section_count"`
	PublishedAt   *time.Time `json:"published_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	PlannedDate   *string    `json:"planned_date"`
	AssigneeID    *uuid.UUID `json:"assignee_id"`
	TargetChars   *int       `json:"target_chars"`
	TodosDone     int        `json:"todos_done"`
	TodosTotal    int        `json:"todos_total"`
}

func (s *Server) listWorks(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	sql := `SELECT w.id, w.title, w.tags, w.status, w.content_format, w.source_work_id, sw.title,
		(SELECT count(*) FROM work d WHERE d.source_work_id=w.id AND d.deleted_at IS NULL),
		w.cover_asset_id, (SELECT id FROM asset WHERE work_id=w.id ORDER BY position LIMIT 1),
		(SELECT coalesce(sum(char_length(content_md)),0) FROM work_section WHERE work_id=w.id AND deleted_at IS NULL),
		(SELECT count(*) FROM work_section WHERE work_id=w.id AND deleted_at IS NULL),
		w.published_at, w.updated_at, to_char(w.planned_date,'YYYY-MM-DD'), w.assignee_id, w.target_chars,
		(SELECT count(*) FROM jsonb_array_elements(w.post_push_todos) e WHERE coalesce((e->>'done')::boolean,false)), jsonb_array_length(w.post_push_todos)
		FROM work w LEFT JOIN work sw ON sw.id=w.source_work_id WHERE w.account_id=$1 AND w.deleted_at IS NULL`
	args := []any{a.ID}
	if st := r.URL.Query().Get("status"); st != "" {
		args = append(args, strings.Split(st, ","))
		sql += fmt.Sprintf(` AND w.status = ANY($%d)`, len(args))
	}
	if as := r.URL.Query().Get("assignee"); as == "me" {
		args = append(args, ident(r.Context()).UserID)
		sql += fmt.Sprintf(` AND w.assignee_id = $%d`, len(args))
	}
	if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
		args = append(args, "%"+q+"%")
		sql += fmt.Sprintf(` AND w.title ILIKE $%d`, len(args))
	}
	rows, err := s.db.Query(r.Context(), sql+` ORDER BY w.updated_at DESC LIMIT 300`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []WorkListItem{}
	for rows.Next() {
		var x WorkListItem
		if err := rows.Scan(&x.ID, &x.Title, &x.Tags, &x.Status, &x.ContentFormat, &x.SourceWorkID, &x.SourceTitle, &x.DerivedCount,
			&x.CoverAssetID, &x.FirstAssetID, &x.CharCount, &x.SectionCount, &x.PublishedAt, &x.UpdatedAt, &x.PlannedDate, &x.AssigneeID, &x.TargetChars, &x.TodosDone, &x.TodosTotal); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) getWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

type cropBox struct {
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
	X2 float64 `json:"x2"`
	Y2 float64 `json:"y2"`
}

func (s *Server) updateWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	var in struct {
		Title        *string            `json:"title"`
		BaseRevision *int               `json:"base_revision"`
		Summary      *string            `json:"summary"`
		Viewpoint    *string            `json:"viewpoint"`
		Theme        *string            `json:"theme"`
		CoverAssetID *uuid.UUID         `json:"cover_asset_id"`
		ClearCover   bool               `json:"clear_cover"`
		CoverCrops   map[string]cropBox `json:"cover_crops"`
		WechatFields *WechatDefaults    `json:"wechat_fields"`
		Topics       []string           `json:"topics"`
		Tags         []string           `json:"tags"`
		MaterialIDs  []uuid.UUID        `json:"material_ids"`

		PlannedDate    *string         `json:"planned_date"`
		TargetChars    *int            `json:"target_chars"`
		ReviewRequired *bool           `json:"review_required"`
		AssigneeID     *string         `json:"assignee_id"`
		ReviewerID     *string         `json:"reviewer_id"`
		PostPushTodos  json.RawMessage `json:"post_push_todos"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.applyWorkPlanning(ctx, m, workPlanning{in.PlannedDate, in.TargetChars, in.ReviewRequired, in.AssigneeID, in.ReviewerID, in.PostPushTodos}); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if in.Title != nil || in.Summary != nil {
		if err := s.checkWorkRevision(ctx, tx, m, in.BaseRevision); err != nil {
			return err
		}
	}
	content := false
	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if runeLen(t) > 64 {
			return validation("标题过长")
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET title=$2 WHERE id=$1`, m.ID, t); err != nil {
			return err
		}
		content = true
	}
	if in.Summary != nil {
		sum := strings.TrimSpace(*in.Summary)
		if m.Account.Platform == "wechat_mp" && runeLen(sum) > 120 {
			return validation("摘要不能超过 120 字")
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET summary=$2 WHERE id=$1`, m.ID, sum); err != nil {
			return err
		}
		content = true
	}
	if in.Viewpoint != nil {
		if _, err := tx.Exec(ctx, `UPDATE work SET viewpoint=$2, updated_at=now() WHERE id=$1`, m.ID, strings.TrimSpace(*in.Viewpoint)); err != nil {
			return err
		}
	}
	if in.Theme != nil {
		if _, err := tx.Exec(ctx, `UPDATE work SET theme=$2 WHERE id=$1`, m.ID, *in.Theme); err != nil {
			return err
		}
		content = true
	}
	if in.ClearCover {
		if _, err := tx.Exec(ctx, `UPDATE work SET cover_asset_id=NULL, cover_crops=NULL WHERE id=$1`, m.ID); err != nil {
			return err
		}
		content = true
	}
	if in.CoverAssetID != nil {
		var x uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM asset WHERE id=$1 AND work_id=$2`, *in.CoverAssetID, m.ID).Scan(&x); err != nil {
			return validation("封面必须是本作品中的图片")
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET cover_asset_id=$2 WHERE id=$1`, m.ID, *in.CoverAssetID); err != nil {
			return err
		}
		content = true
	}
	if in.CoverCrops != nil {
		for _, ratio := range []string{"2.35_1", "1_1"} {
			c, ok := in.CoverCrops[ratio]
			if !ok || c.X1 < 0 || c.Y1 < 0 || c.X2 > 1.0001 || c.Y2 > 1.0001 || c.X2 <= c.X1 || c.Y2 <= c.Y1 {
				return validation("封面裁剪区域不正确，需要 2.35:1 和 1:1 两个区域")
			}
		}
		b, _ := json.Marshal(in.CoverCrops)
		if _, err := tx.Exec(ctx, `UPDATE work SET cover_crops=$2 WHERE id=$1`, m.ID, b); err != nil {
			return err
		}
		content = true
	}
	if in.WechatFields != nil {
		if runeLen(in.WechatFields.Author) > 16 {
			return validation("作者不能超过 16 个字")
		}
		if len(in.WechatFields.SourceURL) > 1024 {
			return validation("阅读原文链接不能超过 1KB")
		}
		b, _ := json.Marshal(in.WechatFields)
		if _, err := tx.Exec(ctx, `UPDATE work SET wechat_fields=$2 WHERE id=$1`, m.ID, b); err != nil {
			return err
		}
		content = true
	}
	if in.Topics != nil {
		topics := []string{}
		for _, t := range cleanList(in.Topics) {
			topics = append(topics, strings.TrimPrefix(t, "#"))
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET topics=$2 WHERE id=$1`, m.ID, topics); err != nil {
			return err
		}
		content = true
	}
	if in.Tags != nil {
		if _, err := tx.Exec(ctx, `UPDATE work SET tags=$2 WHERE id=$1`, m.ID, cleanList(in.Tags)); err != nil {
			return err
		}
	}
	if in.MaterialIDs != nil {
		if _, err := tx.Exec(ctx, `DELETE FROM work_material WHERE work_id=$1`, m.ID); err != nil {
			return err
		}
		for _, mid := range in.MaterialIDs {
			// Only materials of this account or shared ones are allowed (D-008).
			if _, err := tx.Exec(ctx, `INSERT INTO work_material (work_id, material_id) SELECT $1, id FROM material
				WHERE id=$2 AND workspace_id=$3 AND deleted_at IS NULL AND (account_id IS NULL OR account_id=$4) ON CONFLICT DO NOTHING`,
				m.ID, mid, ident(ctx).WorkspaceID, m.Account.ID); err != nil {
				return err
			}
		}
	}
	if content {
		if err := s.touchContent(ctx, tx, m.ID); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.writeWork(w, r, m.ID)
}

func (s *Server) deleteWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var derived int
	var draft *string
	if err := s.db.QueryRow(r.Context(), `SELECT (SELECT count(*) FROM work WHERE source_work_id=$1 AND deleted_at IS NULL), wechat_draft_media_id FROM work WHERE id=$1`,
		m.ID).Scan(&derived, &draft); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET deleted_at=now() WHERE id=$1`, m.ID); err != nil {
		return err
	}
	s.audit(r.Context(), "work_delete", "work", m.ID.String(), "ok", map[string]any{"title": m.Title})
	return ok(w, map[string]any{"ok": true, "derived_count": derived, "had_wechat_draft": draft != nil})
}

func (s *Server) unlockWork(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct{ Confirm bool }
	_ = decode(r, &in)
	if !in.Confirm {
		return apiErr(409, "confirm_required", "解锁后可以修改已发布作品，修改不会同步到平台。请确认。")
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE work SET locked=false, updated_at=now() WHERE id=$1`, m.ID); err != nil {
		return err
	}
	s.audit(r.Context(), "work_unlock", "work", m.ID.String(), "ok", nil)
	return s.writeWork(w, r, m.ID)
}

// ---------- 版本 ----------

func (s *Server) snapshot(ctx context.Context, tx pgx.Tx, workID uuid.UUID) ([]byte, error) {
	var title, summary, viewpoint string
	var outline []byte
	if err := tx.QueryRow(ctx, `SELECT title, summary, viewpoint, outline FROM work WHERE id=$1`, workID).Scan(&title, &summary, &viewpoint, &outline); err != nil {
		return nil, err
	}
	secs, err := s.loadSections(ctx, tx, workID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"title": title, "summary": summary, "viewpoint": viewpoint, "outline": json.RawMessage(outline), "sections": secs})
}

func (s *Server) addVersion(ctx context.Context, tx pgx.Tx, workID uuid.UUID, reason string) error {
	if reason == "auto" {
		var recent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM work_version WHERE work_id=$1 AND created_at > now() - interval '10 minutes')`, workID).Scan(&recent); err != nil {
			return err
		}
		if recent {
			return nil
		}
	}
	snap, err := s.snapshot(ctx, tx, workID)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO work_version (work_id, version_no, snapshot, reason)
		VALUES ($1, coalesce((SELECT max(version_no) FROM work_version WHERE work_id=$1),0)+1, $2, $3)`, workID, snap, reason)
	return err
}

func (s *Server) withTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Server) listVersions(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT version_no, reason, snapshot->>'title', created_at FROM work_version WHERE work_id=$1 ORDER BY version_no DESC LIMIT 200`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type V struct {
		VersionNo int       `json:"version_no"`
		Reason    string    `json:"reason"`
		Title     *string   `json:"title"`
		CreatedAt time.Time `json:"created_at"`
	}
	list := []V{}
	for rows.Next() {
		var v V
		if err := rows.Scan(&v.VersionNo, &v.Reason, &v.Title, &v.CreatedAt); err != nil {
			return err
		}
		list = append(list, v)
	}
	return ok(w, list)
}

func (s *Server) getVersion(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var snap json.RawMessage
	if err := s.db.QueryRow(r.Context(), `SELECT snapshot FROM work_version WHERE work_id=$1 AND version_no=$2`, m.ID, queryIntParam(r, "no")).Scan(&snap); err != nil {
		return err
	}
	return ok(w, map[string]any{"snapshot": snap})
}

func (s *Server) createManualVersion(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error { return s.addVersion(r.Context(), tx, m.ID, "manual") }); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) restoreVersion(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if err := m.editable(); err != nil {
		return err
	}
	ctx := r.Context()
	var snap struct {
		Title     string          `json:"title"`
		Summary   string          `json:"summary"`
		Viewpoint string          `json:"viewpoint"`
		Outline   json.RawMessage `json:"outline"`
		Sections  []Section       `json:"sections"`
	}
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT snapshot FROM work_version WHERE work_id=$1 AND version_no=$2`, m.ID, queryIntParam(r, "no")).Scan(&raw); err != nil {
		return err
	}
	if err := json.Unmarshal(raw, &snap); err != nil {
		return err
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		if err := s.addVersion(ctx, tx, m.ID, "manual"); err != nil {
			return err
		}
		if len(snap.Outline) == 0 {
			snap.Outline = json.RawMessage("[]")
		}
		if _, err := tx.Exec(ctx, `UPDATE work SET title=$2, summary=$3, viewpoint=$4, outline=$5 WHERE id=$1`, m.ID, snap.Title, snap.Summary, snap.Viewpoint, []byte(snap.Outline)); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM work_section WHERE work_id=$1`, m.ID); err != nil {
			return err
		}
		for i, sec := range snap.Sections {
			if sec.SourceSectionIDs == nil {
				sec.SourceSectionIDs = []uuid.UUID{}
			}
			if sec.MaterialIDs == nil {
				sec.MaterialIDs = []uuid.UUID{}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO work_section (id, work_id, position, heading, key_point, content_md, origin, source_section_ids, material_ids)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, sec.ID, m.ID, i, sec.Heading, sec.KeyPoint, sec.ContentMD, nz(sec.Origin, "human"), sec.SourceSectionIDs, sec.MaterialIDs); err != nil {
				return err
			}
		}
		if err := s.touchContent(ctx, tx, m.ID); err != nil {
			return err
		}
		return s.addVersion(ctx, tx, m.ID, "restore")
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "version_restore", "work", m.ID.String(), "ok", map[string]any{"version": queryIntParam(r, "no")})
	return s.writeWork(w, r, m.ID)
}

func nz(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func queryIntParam(r *http.Request, name string) int {
	var n int
	_, _ = fmt.Sscanf(chiParam(r, name), "%d", &n)
	return n
}
