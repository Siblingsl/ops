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
	ID        uuid.UUID  `json:"id"`
	AccountID *uuid.UUID `json:"account_id"`
	Kind      string     `json:"kind"`
	Content   string     `json:"content"`
	Source    string     `json:"source"`
	Tags      []string   `json:"tags"`
	CreatedAt time.Time  `json:"created_at"`
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
	sql := `SELECT id, account_id, kind, content, source, tags, created_at FROM material
		WHERE workspace_id=$1 AND deleted_at IS NULL AND `
	switch q.Get("scope") {
	case "account":
		sql += `account_id=$2`
	case "shared":
		sql += `account_id IS NULL AND $2::uuid IS NOT NULL`
	default:
		sql += `(account_id=$2 OR account_id IS NULL)`
	}
	args := []any{ident(ctx).WorkspaceID, accountID}
	if kw := strings.TrimSpace(q.Get("q")); kw != "" {
		sql += ` AND (content ILIKE $3 OR source ILIKE $3 OR array_to_string(tags, ' ') ILIKE $3)`
		args = append(args, "%"+kw+"%")
	}
	rows, err := s.db.Query(ctx, sql+` ORDER BY created_at DESC LIMIT 500`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Material{}
	for rows.Next() {
		var m Material
		if err := rows.Scan(&m.ID, &m.AccountID, &m.Kind, &m.Content, &m.Source, &m.Tags, &m.CreatedAt); err != nil {
			return err
		}
		list = append(list, m)
	}
	return ok(w, list)
}

type materialInput struct {
	AccountID *uuid.UUID `json:"account_id"`
	Kind      string     `json:"kind"`
	Content   string     `json:"content"`
	Source    string     `json:"source"`
	Tags      []string   `json:"tags"`
}

func (s *Server) validMaterial(ctx context.Context, in *materialInput) error {
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" {
		return validation("请填写素材内容")
	}
	if !materialKinds[in.Kind] {
		return validation("素材类型只能是经历、观点、案例或数据")
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
	var m Material
	if err := s.db.QueryRow(ctx, `INSERT INTO material (workspace_id, account_id, kind, content, source, tags) VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING id, account_id, kind, content, source, tags, created_at`, ident(ctx).WorkspaceID, in.AccountID, in.Kind, in.Content,
		strings.TrimSpace(in.Source), cleanList(in.Tags)).Scan(&m.ID, &m.AccountID, &m.Kind, &m.Content, &m.Source, &m.Tags, &m.CreatedAt); err != nil {
		return err
	}
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
	if _, err := s.db.Exec(ctx, `UPDATE material SET account_id=$2, kind=$3, content=$4, source=$5, tags=$6, updated_at=now() WHERE id=$1`,
		id, in.AccountID, in.Kind, in.Content, strings.TrimSpace(in.Source), cleanList(in.Tags)); err != nil {
		return err
	}
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
