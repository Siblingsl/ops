package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// 通知中心（10 文档第 4.4 节）与个人偏好（EX-K-02、EX-K-03）。

type Notification struct {
	ID        uuid.UUID  `json:"id"`
	Kind      string     `json:"kind"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Link      string     `json:"link"`
	ReadAt    *time.Time `json:"read_at"`
	CreatedAt time.Time  `json:"created_at"`
}

// notify stores one notification; a non-empty dedupeKey makes repeated reminders idempotent.
func (s *Server) notify(ctx context.Context, ws, userID uuid.UUID, kind, title, body, link, dedupeKey string) {
	var key *string
	if dedupeKey != "" {
		key = &dedupeKey
	}
	if _, err := s.db.Exec(context.WithoutCancel(ctx), `INSERT INTO notification (workspace_id, user_id, kind, title, body, link, dedupe_key)
		VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, ws, userID, kind, truncate(title, 120), truncate(body, 500), link, key); err != nil {
		slog.Error("写通知失败", "err", err)
	}
	s.pokeNotifications(userID)
}

// notifyWorkspace sends the same notification to every active member (owners first by role filter when set).
func (s *Server) notifyWorkspace(ctx context.Context, ws uuid.UUID, roles []string, kind, title, body, link, dedupeKey string) {
	rows, err := s.db.Query(ctx, `SELECT user_id FROM workspace_member WHERE workspace_id=$1 AND status='active' AND role = ANY($2)`, ws, roles)
	if err != nil {
		return
	}
	var users []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if rows.Scan(&u) == nil {
			users = append(users, u)
		}
	}
	rows.Close()
	for _, u := range users {
		key := ""
		if dedupeKey != "" {
			key = dedupeKey
		}
		s.notify(ctx, ws, u, kind, title, body, link, key)
	}
}

func (s *Server) notifyBudget(ctx context.Context, used, limit int) {
	id := ident(ctx)
	if id == nil {
		return
	}
	day := s.today().Format("2006-01-02")
	s.notifyWorkspace(ctx, id.WorkspaceID, []string{"owner"}, "budget", "今日 AI 用量已超过上限的 80%",
		fmt.Sprintf("已用 %d / %d token。达到上限后 AI 功能暂停，编辑、检查和推送不受影响。", used, limit), "/settings/usage", "budget:"+id.WorkspaceID.String()+":"+day)
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	args := []any{id.UserID, id.WorkspaceID}
	sql := `SELECT id, kind, title, body, link, read_at, created_at FROM notification WHERE user_id=$1 AND workspace_id=$2`
	if since := r.URL.Query().Get("since"); since != "" {
		if t, err := time.Parse(time.RFC3339Nano, since); err == nil {
			args = append(args, t)
			sql += ` AND created_at > $3`
		}
	}
	rows, err := s.db.Query(ctx, sql+` ORDER BY created_at DESC LIMIT 50`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Notification{}
	for rows.Next() {
		var n Notification
		if err := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.Link, &n.ReadAt, &n.CreatedAt); err != nil {
			return err
		}
		list = append(list, n)
	}
	var unread int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM notification WHERE user_id=$1 AND workspace_id=$2 AND read_at IS NULL`, id.UserID, id.WorkspaceID).Scan(&unread)
	var active int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM ai_job WHERE workspace_id=$1 AND created_by=$2 AND status IN ('queued','running')`, id.WorkspaceID, id.UserID).Scan(&active)
	return ok(w, map[string]any{"items": list, "unread": unread, "active_jobs": active})
}

func (s *Server) readNotification(w http.ResponseWriter, r *http.Request) error {
	nid, err := pathID(r, "id")
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if _, err := s.db.Exec(r.Context(), `UPDATE notification SET read_at=coalesce(read_at, now()) WHERE id=$1 AND user_id=$2`, nid, id.UserID); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// readAllNotifications only flips read state; it confirms no business step (UX-02 不适用).
func (s *Server) readAllNotifications(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if _, err := s.db.Exec(r.Context(), `UPDATE notification SET read_at=now() WHERE user_id=$1 AND workspace_id=$2 AND read_at IS NULL`, id.UserID, id.WorkspaceID); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// streamNotifications pushes a "changed" event whenever the user gets a notification (S3：通知改 SSE).
func (s *Server) streamNotifications(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	ch := s.subscribeNotifications(id.UserID)
	defer s.unsubscribeNotifications(id.UserID, ch)
	sse := newSSE(w)
	sse.send("ready", map[string]any{})
	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case <-ch:
			sse.send("changed", map[string]any{})
		case <-tick.C:
			sse.send("ping", map[string]any{})
		}
	}
}

func (s *Server) subscribeNotifications(user uuid.UUID) chan struct{} {
	ch := make(chan struct{}, 1)
	s.jobMu.Lock()
	s.notifySubs[user] = append(s.notifySubs[user], ch)
	s.jobMu.Unlock()
	return ch
}

func (s *Server) unsubscribeNotifications(user uuid.UUID, ch chan struct{}) {
	s.jobMu.Lock()
	defer s.jobMu.Unlock()
	list := s.notifySubs[user]
	for i, c := range list {
		if c == ch {
			s.notifySubs[user] = append(list[:i], list[i+1:]...)
			break
		}
	}
}

func (s *Server) pokeNotifications(user uuid.UUID) {
	s.jobMu.Lock()
	defer s.jobMu.Unlock()
	for _, c := range s.notifySubs[user] {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}

// ---------- 个人偏好 ----------

type UserPrefs struct {
	DefaultVariants   int    `json:"default_variants"`
	UseHistory        bool   `json:"use_history"`
	LiveLint          bool   `json:"live_lint"`
	GhostText         bool   `json:"ghost_text"`
	GhostKey          string `json:"ghost_key"`
	AutoJumpNextEmpty bool   `json:"auto_jump_next_empty"`
	FocusDefault      bool   `json:"focus_default"`
	WriteEndingFirst  bool   `json:"write_ending_first"`
	UXEvents          bool   `json:"ux_events"`
	CostTier          string `json:"cost_tier"`
	SavedViews        []any  `json:"saved_views"`
}

func defaultPrefs() UserPrefs {
	return UserPrefs{DefaultVariants: 1, UseHistory: true, LiveLint: true, GhostText: true, GhostKey: "Alt+/", AutoJumpNextEmpty: true, CostTier: "standard", SavedViews: []any{}}
}

func (s *Server) userPrefs(ctx context.Context) UserPrefs {
	p := defaultPrefs()
	id := ident(ctx)
	if id == nil {
		return p
	}
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT preferences FROM app_user WHERE id=$1`, id.UserID).Scan(&raw); err == nil && len(raw) > 2 {
		_ = json.Unmarshal(raw, &p)
	}
	if p.DefaultVariants != 3 {
		p.DefaultVariants = 1
	}
	if p.SavedViews == nil {
		p.SavedViews = []any{}
	}
	p.GhostKey = normGhostKey(p.GhostKey)
	return p
}

func normGhostKey(k string) string {
	switch k {
	case "Alt+.", "Ctrl+.":
		return k
	}
	return "Alt+/"
}

func (s *Server) getPrefs(w http.ResponseWriter, r *http.Request) error {
	return ok(w, s.userPrefs(r.Context()))
}

func (s *Server) putPrefs(w http.ResponseWriter, r *http.Request) error {
	cur := s.userPrefs(r.Context())
	if err := decode(r, &cur); err != nil {
		return err
	}
	if cur.DefaultVariants != 3 {
		cur.DefaultVariants = 1
	}
	if cur.CostTier != "economy" && cur.CostTier != "quality" {
		cur.CostTier = "standard"
	}
	cur.GhostKey = normGhostKey(cur.GhostKey)
	if len(cur.SavedViews) > 30 {
		return validation("保存的视图最多 30 个")
	}
	b, _ := json.Marshal(cur)
	if _, err := s.db.Exec(r.Context(), `UPDATE app_user SET preferences=$2, updated_at=now() WHERE id=$1`, ident(r.Context()).UserID, b); err != nil {
		return err
	}
	return ok(w, cur)
}
