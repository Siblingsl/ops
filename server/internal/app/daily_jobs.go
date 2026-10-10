package app

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"net/http"
)

type DailySettings struct {
	Generate       string `json:"generate"`
	Hour           int    `json:"hour"`
	PrimaryCount   int    `json:"primary_count"`
	AlternateCount int    `json:"alternate_count"`
}

func (s *Server) workspaceDaily(ctx context.Context) DailySettings {
	d := DailySettings{Generate: "on_open", Hour: 7}
	var b []byte
	if s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='daily.settings'`, ident(ctx).WorkspaceID).Scan(&b) == nil {
		_ = json.Unmarshal(b, &d)
	}
	return d
}
func (s *Server) effectiveDaily(ctx context.Context, st *Strategy) DailySettings {
	d := s.workspaceDaily(ctx)
	if st != nil {
		b, _ := json.Marshal(st.DailySettings)
		_ = json.Unmarshal(b, &d)
	}
	return d
}
func validateDaily(d DailySettings) error {
	if d.Generate != "off" && d.Generate != "on_open" && d.Generate != "background" {
		return validation("生成方式为关闭、打开时或后台")
	}
	if d.Hour < 0 || d.Hour > 23 || d.PrimaryCount < 0 || d.PrimaryCount > 5 || d.AlternateCount < 0 || d.AlternateCount > 5 {
		return validation("生成小时为 0–23，主推与备选为 1–5（0 表示按发布日默认）")
	}
	return nil
}
func (s *Server) getDailySettings(w http.ResponseWriter, r *http.Request) error {
	return ok(w, s.workspaceDaily(r.Context()))
}
func (s *Server) putDailySettings(w http.ResponseWriter, r *http.Request) error {
	if e := s.requireOwner(r.Context()); e != nil {
		return e
	}
	var d DailySettings
	if e := decode(r, &d); e != nil {
		return e
	}
	if e := validateDaily(d); e != nil {
		return e
	}
	b, _ := json.Marshal(d)
	_, e := s.db.Exec(r.Context(), `INSERT INTO app_setting(workspace_id,key,value) VALUES($1,'daily.settings',$2) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value`, ident(r.Context()).WorkspaceID, b)
	if e != nil {
		return e
	}
	s.audit(r.Context(), "daily_settings", "app_setting", "daily.settings", "ok", nil)
	return ok(w, d)
}
func (s *Server) prepareOps(ctx context.Context, a *Account, trigger string) (*uuid.UUID, bool, error) {
	st, e := s.activeStrategy(ctx, a.ID)
	if e != nil || st == nil {
		return nil, false, e
	}
	d := s.effectiveDaily(ctx, st)
	if trigger == "on_open" && d.Generate != "on_open" || trigger == "background" && d.Generate != "background" {
		return nil, false, nil
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return nil, false, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,424))`, a.ID.String()+s.today().Format("2006-01-02")); e != nil {
		return nil, false, e
	}
	var id uuid.UUID
	var status string
	e = tx.QueryRow(ctx, `SELECT id,status FROM ai_job WHERE account_id=$1 AND task_type='ops_daily' AND input->>'date'=$2 ORDER BY created_at DESC LIMIT 1`, a.ID, s.today().Format("2006-01-02")).Scan(&id, &status)
	if e == nil {
		return &id, status == "queued" || status == "running", nil
	}
	if e != pgx.ErrNoRows {
		return nil, false, e
	}
	current, e := s.latestDaily(ctx, a, s.today().Format("2006-01-02"))
	if e != nil {
		return nil, false, e
	}
	var hotReady bool
	_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_hot_refresh WHERE account_id=$1 AND refreshed_at>=$2)`, a.ID, s.today()).Scan(&hotReady)
	hotEnabled := s.loadCrawl(ctx).Limits.Enabled && st.HotEnabled != nil && *st.HotEnabled
	if current != nil && (hotReady || !hotEnabled) {
		return nil, false, nil
	}
	id, e = s.startBackgroundJob(ctx, jobSpec{TaskType: "ops_daily", Label: "准备今日热点与推荐", AccountID: &a.ID, Link: "/a/" + a.ID.String() + "/ops", Input: map[string]any{"date": s.today().Format("2006-01-02"), "trigger": trigger}}, func(jctx context.Context) (any, error) {
		if e := s.checkLimit(jctx); e != nil {
			return nil, e
		}
		if hotEnabled && !hotReady {
			if e := s.matchHot(jctx, a, false); e != nil {
				return nil, e
			}
		}
		rec, e := s.generateDaily(jctx, a, trigger, false)
		if e != nil {
			return nil, e
		}
		return map[string]any{"recommendation_id": rec.ID, "ai_call_id": rec.AICallID}, nil
	})
	if e != nil {
		return nil, false, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, false, e
	}
	return &id, true, nil
}
func (s *Server) opsOpened(ctx context.Context, a *Account) {
	_, _ = s.db.Exec(ctx, `INSERT INTO account_ops_activity(account_id,last_opened_at,user_id) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET last_opened_at=excluded.last_opened_at,user_id=excluded.user_id`, a.ID, s.now(), ident(ctx).UserID)
}
func (s *Server) dailyBackground(ctx context.Context) {
	rows, e := s.db.Query(ctx, `SELECT a.id,a.workspace_id,x.user_id FROM account_ops_activity x JOIN platform_account a ON a.id=x.account_id JOIN workspace_member m ON m.workspace_id=a.workspace_id AND m.user_id=x.user_id AND m.status='active' WHERE a.status='active' AND x.last_opened_at>$1`, s.now().AddDate(0, 0, -7))
	if e != nil {
		return
	}
	type candidate struct{ a, ws, user uuid.UUID }
	list := []candidate{}
	for rows.Next() {
		var x candidate
		if rows.Scan(&x.a, &x.ws, &x.user) == nil {
			list = append(list, x)
		}
	}
	rows.Close()
	for _, x := range list {
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws, UserID: x.user, Role: "editor"})
		a, e := s.account(jctx, x.a)
		if e != nil {
			continue
		}
		st, e := s.activeStrategy(jctx, a.ID)
		if e != nil || st == nil {
			continue
		}
		d := s.effectiveDaily(jctx, st)
		if d.Generate == "background" && s.now().In(s.loc).Hour() >= d.Hour {
			_, _, _ = s.prepareOps(jctx, a, "background")
		}
	}
}
func (s *Server) newDailyHot(ctx context.Context, a *Account, d *Daily) bool {
	if d == nil || !s.loadCrawl(ctx).Limits.Enabled {
		return false
	}
	var yes bool
	_ = s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM account_hot_match m JOIN hot_item h ON h.id=m.hot_item_id WHERE m.account_id=$1 AND m.relevance>=85 AND m.status='new' AND cardinality(m.risk)=0 AND m.created_at>$2)`, a.ID, d.GeneratedAt).Scan(&yes)
	return yes
}
