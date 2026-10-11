package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

type WechatDefaults struct {
	Author          string `json:"author"`
	OpenComment     bool   `json:"open_comment"`
	FansOnlyComment bool   `json:"fans_only_comment"`
	SourceURL       string `json:"source_url"`
}

type Profile struct {
	AccountID       uuid.UUID      `json:"account_id"`
	PositioningTags []string       `json:"positioning_tags"`
	TargetAudience  string         `json:"target_audience"`
	PersonaTone     string         `json:"persona_tone"`
	BannedWords     []string       `json:"banned_words"`
	StyleSummary    string         `json:"style_summary"`
	DefaultTheme    string         `json:"default_theme"`
	WechatDefaults  WechatDefaults `json:"wechat_defaults"`
}

func (s *Server) loadProfile(ctx context.Context, accountID uuid.UUID) (*Profile, error) {
	p := Profile{AccountID: accountID}
	var wd []byte
	err := s.db.QueryRow(ctx, `SELECT positioning_tags, target_audience, persona_tone, banned_words, style_summary, default_theme, wechat_defaults
		FROM account_profile WHERE account_id=$1`, accountID).Scan(&p.PositioningTags, &p.TargetAudience, &p.PersonaTone,
		&p.BannedWords, &p.StyleSummary, &p.DefaultTheme, &wd)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(wd, &p.WechatDefaults)
	return &p, nil
}

func cleanList(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v != "" && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	p, err := s.loadProfile(r.Context(), a.ID)
	if err != nil {
		return err
	}
	return ok(w, p)
}

func (s *Server) putProfile(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in Profile
	if err := decode(r, &in); err != nil {
		return err
	}
	if runeLen(in.WechatDefaults.Author) > 16 {
		return validation("作者不能超过 16 个字")
	}
	if len(in.WechatDefaults.SourceURL) > 1024 {
		return validation("阅读原文链接不能超过 1KB")
	}
	if in.DefaultTheme == "" {
		in.DefaultTheme = "ink"
	}
	wd, _ := json.Marshal(in.WechatDefaults)
	if _, err := s.db.Exec(r.Context(), `UPDATE account_profile SET positioning_tags=$2, target_audience=$3, persona_tone=$4,
		banned_words=$5, style_summary=$6, default_theme=$7, wechat_defaults=$8, updated_at=now() WHERE account_id=$1`,
		a.ID, cleanList(in.PositioningTags), strings.TrimSpace(in.TargetAudience), strings.TrimSpace(in.PersonaTone),
		cleanList(in.BannedWords), strings.TrimSpace(in.StyleSummary), in.DefaultTheme, wd); err != nil {
		return err
	}
	p, err := s.loadProfile(r.Context(), a.ID)
	if err != nil {
		return err
	}
	return ok(w, p)
}

type StyleSample struct {
	ID        uuid.UUID `json:"id"`
	AccountID uuid.UUID `json:"account_id"`
	Title     string    `json:"title"`
	ContentMD string    `json:"content_md"`
	CharCount int       `json:"char_count"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) listStyleSamples(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, account_id, title, content_md, char_count, created_at FROM style_sample
		WHERE account_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []StyleSample{}
	for rows.Next() {
		var x StyleSample
		if err := rows.Scan(&x.ID, &x.AccountID, &x.Title, &x.ContentMD, &x.CharCount, &x.CreatedAt); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) createStyleSample(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Title     string `json:"title"`
		ContentMD string `json:"content_md"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Title, in.ContentMD = strings.TrimSpace(in.Title), strings.TrimSpace(in.ContentMD)
	if in.Title == "" || in.ContentMD == "" {
		return validation("请填写标题和正文")
	}
	var x StyleSample
	if err := s.db.QueryRow(r.Context(), `INSERT INTO style_sample (account_id, title, content_md, char_count) VALUES ($1,$2,$3,$4)
		RETURNING id, account_id, title, content_md, char_count, created_at`, a.ID, in.Title, in.ContentMD, runeLen(in.ContentMD)).
		Scan(&x.ID, &x.AccountID, &x.Title, &x.ContentMD, &x.CharCount, &x.CreatedAt); err != nil {
		return err
	}
	return ok(w, x)
}

// ownedRow checks that a row of an account-scoped table belongs to the caller's workspace.
func (s *Server) ownedAccountRow(ctx context.Context, table string, id uuid.UUID) (uuid.UUID, error) {
	var accountID uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT t.account_id FROM `+table+` t JOIN platform_account a ON a.id=t.account_id
		WHERE t.id=$1 AND a.workspace_id=$2 AND t.deleted_at IS NULL`, id, ident(ctx).WorkspaceID).Scan(&accountID)
	return accountID, err
}

func (s *Server) updateStyleSample(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "style_sample", id); err != nil {
		return err
	}
	var in struct {
		Title     string `json:"title"`
		ContentMD string `json:"content_md"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE style_sample SET title=$2, content_md=$3, char_count=$4, updated_at=now() WHERE id=$1`,
		id, strings.TrimSpace(in.Title), strings.TrimSpace(in.ContentMD), runeLen(strings.TrimSpace(in.ContentMD))); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) deleteStyleSample(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "style_sample", id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE style_sample SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

type Material struct {
	ID         uuid.UUID  `json:"id"`
	AccountID  *uuid.UUID `json:"account_id"`
	Kind       string     `json:"kind"`
	Content    string     `json:"content"`
	Source     string     `json:"source"`
	Tags       []string   `json:"tags"`
	ValidUntil *string    `json:"valid_until"`
	UsageCount int        `json:"usage_count"`
	LastUsedAt *time.Time `json:"last_used_at"`
	Expired    bool       `json:"expired"`
	CreatedAt  time.Time  `json:"created_at"`
}

const materialCols = `m.id, m.account_id, m.kind, m.content, m.source, m.tags, to_char(m.valid_until, 'YYYY-MM-DD'),
	(SELECT count(*) FROM work_material wm JOIN work w ON w.id=wm.work_id AND w.deleted_at IS NULL WHERE wm.material_id=m.id),
	(SELECT max(w.updated_at) FROM work_material wm JOIN work w ON w.id=wm.work_id AND w.deleted_at IS NULL WHERE wm.material_id=m.id),
	coalesce(m.valid_until < $2::date, false), m.created_at`

func scanMaterial(row interface{ Scan(...any) error }) (Material, error) {
	var m Material
	err := row.Scan(&m.ID, &m.AccountID, &m.Kind, &m.Content, &m.Source, &m.Tags, &m.ValidUntil, &m.UsageCount, &m.LastUsedAt, &m.Expired, &m.CreatedAt)
	return m, err
}

var materialKinds = map[string]bool{"experience": true, "opinion": true, "case": true, "data": true}

func (s *Server) listMaterials(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	q := r.URL.Query()
	accountID, err := uuid.Parse(q.Get("account_id"))
	if err != nil {
		return validation("缺少 account_id")
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	sql := `SELECT ` + materialCols + ` FROM material m
		WHERE m.workspace_id=$1 AND m.deleted_at IS NULL AND `
	switch q.Get("scope") {
	case "account":
		sql += `m.account_id=$3`
	case "shared":
		sql += `m.account_id IS NULL AND $3::uuid IS NOT NULL`
	default:
		sql += `(m.account_id=$3 OR m.account_id IS NULL)`
	}
	args := []any{ident(ctx).WorkspaceID, s.today(), accountID}
	if kw := strings.TrimSpace(q.Get("q")); kw != "" {
		sql += ` AND (m.content ILIKE $4 OR m.source ILIKE $4 OR array_to_string(m.tags, ' ') ILIKE $4)`
		args = append(args, "%"+kw+"%")
	}
	switch q.Get("usage") {
	case "unused":
		sql += ` AND NOT EXISTS (SELECT 1 FROM work_material wm WHERE wm.material_id=m.id)`
	case "used":
		sql += ` AND EXISTS (SELECT 1 FROM work_material wm WHERE wm.material_id=m.id)`
	case "expired":
		sql += ` AND m.valid_until < $2::date`
	}
	rows, err := s.db.Query(ctx, sql+` ORDER BY m.created_at DESC LIMIT 500`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Material{}
	for rows.Next() {
		m, err := scanMaterial(rows)
		if err != nil {
			return err
		}
		list = append(list, m)
	}
	return ok(w, list)
}

// materialUsage lists the works that used one material (EX-D-04).
func (s *Server) materialUsage(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.ownedMaterial(ctx, id); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT w.id, w.account_id, w.title, w.status, w.updated_at FROM work_material wm
		JOIN work w ON w.id=wm.work_id AND w.deleted_at IS NULL WHERE wm.material_id=$1 ORDER BY w.updated_at DESC LIMIT 50`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	type use struct {
		WorkID    uuid.UUID `json:"work_id"`
		AccountID uuid.UUID `json:"account_id"`
		Title     string    `json:"title"`
		Status    string    `json:"status"`
		At        time.Time `json:"at"`
	}
	list := []use{}
	for rows.Next() {
		var u use
		if err := rows.Scan(&u.WorkID, &u.AccountID, &u.Title, &u.Status, &u.At); err != nil {
			return err
		}
		list = append(list, u)
	}
	return ok(w, list)
}

type materialInput struct {
	AccountID  *uuid.UUID `json:"account_id"`
	Kind       string     `json:"kind"`
	Content    string     `json:"content"`
	Source     string     `json:"source"`
	Tags       []string   `json:"tags"`
	ValidUntil *string    `json:"valid_until"`
	ReadPage   bool       `json:"read_page"`
}

func (s *Server) validMaterial(ctx context.Context, in *materialInput) error {
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		return validation("请填写素材内容")
	}
	if !materialKinds[in.Kind] {
		return validation("素材类型只能是经历、观点、案例或数据")
	}
	if in.ValidUntil != nil {
		v := strings.TrimSpace(*in.ValidUntil)
		if v == "" {
			in.ValidUntil = nil
		} else if _, err := time.Parse("2006-01-02", v); err != nil {
			return validation("有效期格式应为 YYYY-MM-DD")
		} else {
			in.ValidUntil = &v
		}
	}
	if in.AccountID != nil {
		if _, err := s.account(ctx, *in.AccountID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) createMaterial(w http.ResponseWriter, r *http.Request) error {
	var in materialInput
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.validMaterial(ctx, &in); err != nil {
		return err
	}
	var id uuid.UUID
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if in.ReadPage {
		links := referenceLinks(in.Content + "\n" + in.Source)
		if in.AccountID == nil || len(links) == 0 {
			return validation("读取页面需要选择账号并填写小红书或公众号单篇链接")
		}
		if _, err = s.queueReferences(ctx, tx, *in.AccountID, links); err != nil {
			return err
		}
	}
	if err := tx.QueryRow(ctx, `INSERT INTO material (workspace_id, account_id, kind, content, source, tags, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7::date)
		RETURNING id`, ident(ctx).WorkspaceID, in.AccountID, in.Kind, in.Content,
		strings.TrimSpace(in.Source), cleanList(in.Tags), in.ValidUntil).Scan(&id); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	m, err := scanMaterial(s.db.QueryRow(ctx, `SELECT `+materialCols+` FROM material m WHERE m.id=$1`, id, s.today()))
	if err != nil {
		return err
	}
	s.markEmbeddingStale(ctx, "material", id)
	return ok(w, m)
}

func (s *Server) ownedMaterial(ctx context.Context, id uuid.UUID) error {
	var x uuid.UUID
	return s.db.QueryRow(ctx, `SELECT id FROM material WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, id, ident(ctx).WorkspaceID).Scan(&x)
}

func (s *Server) updateMaterial(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.ownedMaterial(ctx, id); err != nil {
		return err
	}
	var in materialInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := s.validMaterial(ctx, &in); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE material SET account_id=$2, kind=$3, content=$4, source=$5, tags=$6, valid_until=$7::date, updated_at=now() WHERE id=$1`,
		id, in.AccountID, in.Kind, in.Content, strings.TrimSpace(in.Source), cleanList(in.Tags), in.ValidUntil); err != nil {
		return err
	}
	s.markEmbeddingStale(ctx, "material", id)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) deleteMaterial(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if err := s.ownedMaterial(r.Context(), id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE material SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}
