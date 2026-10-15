package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"ops/internal/crawl"
	"regexp"
	"strings"
	"time"
)

type ReferenceAnalysis struct {
	TitlePattern string   `json:"title_pattern"`
	HookType     string   `json:"hook_type"`
	Structure    []string `json:"structure"`
	Angle        string   `json:"angle"`
	Tags         []string `json:"tags"`
	Takeaways    []string `json:"takeaways"`
}
type Reference struct {
	ID          uuid.UUID          `json:"id"`
	AccountID   uuid.UUID          `json:"account_id"`
	Platform    string             `json:"platform"`
	URL         string             `json:"url"`
	Status      string             `json:"status"`
	Title       string             `json:"title"`
	Author      string             `json:"author"`
	PublishedAt string             `json:"published_at"`
	Metrics     map[string]int     `json:"metrics"`
	Analysis    *ReferenceAnalysis `json:"analysis"`
	Error       string             `json:"error"`
	QueuedAt    time.Time          `json:"queued_at"`
	FetchedAt   *time.Time         `json:"fetched_at"`
	Position    int                `json:"position"`
	ExpectedAt  *time.Time         `json:"expected_at"`
}

func (s *Server) getReferences(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	ctx := r.Context()
	rows, e := s.db.Query(ctx, `SELECT id,platform,url,status,title,author,published_at,metrics,analysis,error,queued_at,fetched_at FROM reference_item r WHERE (account_id=$1 OR EXISTS(SELECT 1 FROM account_reference ar WHERE ar.reference_id=r.id AND ar.account_id=$1)) AND workspace_id=$2 AND deleted_at IS NULL ORDER BY queued_at DESC LIMIT 200`, a.ID, ident(ctx).WorkspaceID)
	if e != nil {
		return e
	}
	defer rows.Close()
	list := []Reference{}
	platforms, _ := s.crawlPlatforms(ctx)
	for rows.Next() {
		x := Reference{AccountID: a.ID}
		var metrics, analysis []byte
		if e = rows.Scan(&x.ID, &x.Platform, &x.URL, &x.Status, &x.Title, &x.Author, &x.PublishedAt, &metrics, &analysis, &x.Error, &x.QueuedAt, &x.FetchedAt); e != nil {
			return e
		}
		_ = json.Unmarshal(metrics, &x.Metrics)
		_ = json.Unmarshal(analysis, &x.Analysis)
		if x.Status == "queued" {
			kind := "xhs_page"
			if x.Platform == "wechat_mp" {
				kind = "wechat_page"
			}
			_ = s.db.QueryRow(ctx, `SELECT count(*) FROM reference_item WHERE platform=$1 AND status='queued' AND deleted_at IS NULL AND (queued_at,id)<=($2,$3)`, x.Platform, x.QueuedAt, x.ID).Scan(&x.Position)
			for _, p := range platforms {
				if p.Platform == kind && p.Enabled && s.loadCrawl(ctx).Limits.Enabled {
					next := s.now()
					if p.Next != nil && p.Next.After(next) {
						next = *p.Next
					}
					if p.Paused != nil && p.Paused.After(next) {
						next = *p.Paused
					}
					remaining := p.DailyMax - p.Requests
					next = next.In(s.loc)
					for i := 0; i < x.Position; i++ {
						if remaining <= 0 || next.In(s.loc).Hour() >= 23 {
							next = time.Date(next.Year(), next.Month(), next.Day()+1, 8, 0, 0, 0, s.loc)
							remaining = p.DailyMax
						}
						if next.In(s.loc).Hour() < 8 {
							next = time.Date(next.Year(), next.Month(), next.Day(), 8, 0, 0, 0, s.loc)
						}
						next = next.Add(time.Duration(p.IntervalMin+p.JitterMin) * time.Minute)
						remaining--
					}
					x.ExpectedAt = &next
				}
			}
		}
		list = append(list, x)
	}
	return ok(w, list)
}
func (s *Server) addReferences(w http.ResponseWriter, r *http.Request) error {
	a, e := s.accountFromPath(r)
	if e != nil {
		return e
	}
	var in struct {
		Links []string `json:"links"`
	}
	if e = decode(r, &in); e != nil {
		return e
	}
	if len(in.Links) < 1 || len(in.Links) > 20 {
		return validation("每次添加 1–20 个单篇链接")
	}
	ctx := r.Context()
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	ids, e := s.queueReferences(ctx, tx, a.ID, in.Links)
	if e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	return ok(w, map[string]any{"ids": ids})
}

var referenceURLPattern = regexp.MustCompile(`https://[^\s<>"\x{3002}\x{FF0C}\x{FF1B}]+`)

func referenceLinks(text string) []string {
	links := []string{}
	for _, raw := range referenceURLPattern.FindAllString(text, -1) {
		u, err := url.Parse(raw)
		if err == nil && crawl.Sensitive(u.Hostname()) != "" {
			links = append(links, raw)
		}
	}
	return cleanList(links)
}

// A canonical workspace reference can be linked to multiple accounts without rereading the page.
func (s *Server) queueReferences(ctx context.Context, tx pgx.Tx, account uuid.UUID, links []string) ([]uuid.UUID, error) {
	if len(links) > 20 {
		return nil, validation("每次最多读取 20 个单篇链接")
	}
	ids := []uuid.UUID{}
	for _, raw := range cleanList(links) {
		u, e := url.Parse(strings.TrimSpace(raw))
		if e != nil || u.User != nil || u.Scheme != "https" || len(raw) > 2000 {
			return nil, validation("请输入 HTTPS 单篇公开链接")
		}
		kind := crawl.Sensitive(u.Hostname())
		platform := "xhs"
		if kind == "wechat_page" {
			platform = "wechat_mp"
		}
		if kind == "" || u.Path == "/" || u.Path == "" || strings.Contains(u.Path, "/user/") || strings.Contains(u.Path, "/search") {
			return nil, validation("仅接受小红书或公众号单篇链接，不读取主页或搜索列表")
		}
		u.Fragment = ""
		status, msg := "queued", ""
		if !s.cfg.Dev {
			status, msg = "blocked", "robots 不允许，请手动粘贴正文"
		}
		var id uuid.UUID
		e = tx.QueryRow(ctx, `INSERT INTO reference_item(workspace_id,account_id,platform,url,status,error,queued_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,url) DO UPDATE SET deleted_at=NULL RETURNING id`, ident(ctx).WorkspaceID, account, platform, u.String(), status, msg, s.now()).Scan(&id)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO account_reference(account_id,reference_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, account, id); e != nil {
			return nil, e
		}
		ids = append(ids, id)
	}
	return ids, nil
}
func (s *Server) referenceAccount(ctx context.Context, id uuid.UUID) (*Account, error) {
	var aid uuid.UUID
	e := s.db.QueryRow(ctx, `SELECT account_id FROM reference_item WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, id, ident(ctx).WorkspaceID).Scan(&aid)
	if e != nil {
		return nil, e
	}
	return s.account(ctx, aid)
}
func overlapLong(source, output string) bool {
	r := []rune(source)
	if len(r) < 16 {
		return false
	}
	for i := 0; i+16 <= len(r); i++ {
		if strings.Contains(output, string(r[i:i+16])) {
			return true
		}
	}
	return false
}
func (s *Server) analyzeReference(ctx context.Context, a *Account, id uuid.UUID, body, platform string) error {
	var result ReferenceAnalysis
	ai, e := s.runAIJSON(ctx, aiTask{Type: "reference_analyze", Account: a, Tier: "economy", SkipStyle: true, User: "只总结写作方法，不复述原句；输出 title_pattern, hook_type, structure[], angle, tags[], takeaways[]。\n平台：" + platform + "\n## 原文\n" + externalBlock("对标原文", id.String(), truncateRunes(body, 4000)), Refs: map[string]any{"reference_id": id}}, &result, func() error {
		b, _ := json.Marshal(result)
		if result.TitlePattern == "" || len(result.Takeaways) == 0 || overlapLong(body, string(b)) {
			return validation("提炼必须包含方法，不能连续复述原文超过 15 字")
		}
		return nil
	})
	if e != nil {
		return e
	}
	b, _ := json.Marshal(result)
	_, e = s.db.Exec(ctx, `UPDATE reference_item SET status='done',body_text=$2,analysis=$3,error='',fetched_at=$4,ai_call_id=$5 WHERE id=$1 AND deleted_at IS NULL`, id, truncateRunes(body, 20000), b, s.now(), ai.CallID)
	return e
}
func (s *Server) pasteReference(w http.ResponseWriter, r *http.Request) error {
	id, e := pathID(r, "id")
	if e != nil {
		return e
	}
	a, e := s.referenceAccount(r.Context(), id)
	if e != nil {
		return e
	}
	var in struct {
		Body  string `json:"body"`
		Title string `json:"title"`
	}
	if e = decode(r, &in); e != nil {
		return e
	}
	if runeLen(in.Body) < 20 || runeLen(in.Body) > 20000 {
		return validation("正文为 20–20000 字")
	}
	var platform string
	if e = s.db.QueryRow(r.Context(), `SELECT platform FROM reference_item WHERE id=$1`, id).Scan(&platform); e != nil {
		return e
	}
	if e = s.analyzeReference(r.Context(), a, id, in.Body, platform); e != nil {
		return e
	}
	_, e = s.db.Exec(r.Context(), `UPDATE reference_item SET title=$2 WHERE id=$1`, id, truncateRunes(in.Title, 200))
	if e != nil {
		return e
	}
	return ok(w, map[string]any{"ok": true})
}
func (s *Server) deleteReference(w http.ResponseWriter, r *http.Request) error {
	id, e := pathID(r, "id")
	if e != nil {
		return e
	}
	if _, e = s.referenceAccount(r.Context(), id); e != nil {
		return e
	}
	_, e = s.db.Exec(r.Context(), `UPDATE reference_item SET deleted_at=$2 WHERE id=$1`, id, s.now())
	if e != nil {
		return e
	}
	return ok(w, map[string]any{"ok": true})
}
func (s *Server) collectReferences(ctx context.Context) {
	_, _ = s.db.Exec(ctx, `UPDATE reference_item SET body_text='' WHERE body_text<>'' AND fetched_at<$1`, s.now().AddDate(0, 0, -7))
	if !s.loadCrawl(ctx).Limits.Enabled {
		return
	}
	rows, e := s.db.Query(ctx, `SELECT r.id,r.account_id,r.workspace_id,r.platform,r.url FROM reference_item r WHERE r.status='queued' AND r.deleted_at IS NULL ORDER BY r.queued_at LIMIT 200`)
	if e != nil {
		return
	}
	type item struct {
		id, aid, ws   uuid.UUID
		platform, url string
	}
	list := []item{}
	for rows.Next() {
		var x item
		if rows.Scan(&x.id, &x.aid, &x.ws, &x.platform, &x.url) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, x := range list {
		kind := "xhs_page"
		if x.platform == "wechat_mp" {
			kind = "wechat_page"
		}
		endpoint := x.url
		if s.cfg.Dev {
			u, _ := url.Parse(x.url)
			endpoint = "http://" + s.cfg.MockListen + "/mock/page/" + strings.TrimPrefix(u.Path, "/")
		}
		page, out, e := (crawl.Adapter{Client: s.crawlClient(), Source: crawl.Source{Key: kind, Kind: kind, URL: endpoint}}).FetchPage(ctx, s.loadCrawl(ctx).Limits)
		if errors.Is(e, crawl.ErrLimited) || errors.Is(e, crawl.ErrDisabled) {
			continue
		}
		status, msg := "failed", ""
		if e != nil {
			msg = e.Error()
			if out.Paused || errors.Is(e, crawl.ErrRobots) {
				status = "blocked"
			}
		} else {
			jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws, Role: "owner"})
			a, err := s.account(jctx, x.aid)
			if err == nil {
				err = s.analyzeReference(jctx, a, x.id, cleanExternalText(page.Body), x.platform)
			}
			if err == nil {
				b, _ := json.Marshal(page.Metrics)
				_, _ = s.db.Exec(ctx, `UPDATE reference_item SET title=$2,author=$3,published_at=$4,metrics=$5 WHERE id=$1`, x.id, cleanExternalText(page.Title), cleanExternalText(page.Author), page.PublishedAt, b)
				continue
			}
			msg = err.Error()
		}
		_, _ = s.db.Exec(ctx, `UPDATE reference_item SET status=$2,error=$3 WHERE id=$1 AND deleted_at IS NULL`, x.id, status, msg)
	}
}
func (s *Server) referenceMethods(ctx context.Context, account uuid.UUID) (string, []SlotItem) {
	rows, e := s.db.Query(ctx, `SELECT id,title,analysis FROM reference_item r WHERE (account_id=$1 OR EXISTS(SELECT 1 FROM account_reference ar WHERE ar.reference_id=r.id AND ar.account_id=$1)) AND workspace_id=$2 AND status='done' AND deleted_at IS NULL ORDER BY fetched_at DESC LIMIT 3`, account, ident(ctx).WorkspaceID)
	if e != nil {
		return "", nil
	}
	defer rows.Close()
	text := ""
	items := []SlotItem{}
	for rows.Next() {
		var id uuid.UUID
		var title string
		var b []byte
		if rows.Scan(&id, &title, &b) == nil {
			line := fmt.Sprintf("方法参考《%s》：%s\n", title, string(b))
			if runeLen(text+line) > 1200 {
				break
			}
			text += line
			items = append(items, SlotItem{ID: id.String(), Label: title, Chars: runeLen(line), Used: true})
		}
	}
	return text, items
}
