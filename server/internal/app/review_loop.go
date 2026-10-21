package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// ---------- 分析闭环（DEV-DR08，14 文档 4.6） ----------

const minWeeklyDraftWorks = 3

// day7PrefsJob refreshes deterministic reader preferences for every dirty account, without calling a model.
func (s *Server) day7PrefsJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT id FROM platform_account
		WHERE status='active' AND pref_input_revision IS DISTINCT FROM pref_processed_revision ORDER BY id`)
	if err != nil {
		return
	}
	var list []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			list = append(list, id)
		}
	}
	rows.Close()
	for _, id := range list {
		if _, err := s.refreshDataPreferences(ctx, id); err != nil {
			slog.Warn("刷新读者数据偏好失败", "account", id, "err", err)
		}
	}
}

// refreshDataPreferences recomputes preferences for the observed input revision. Below the sample
// floor it preserves existing rows but marks them inapplicable; a concurrent newer input wins.
func (s *Server) refreshDataPreferences(ctx context.Context, accountID uuid.UUID) (bool, error) {
	revision, err := s.preferenceInputRevision(ctx, accountID)
	if err != nil {
		return false, err
	}
	samples, err := s.perfSamples(ctx, accountID)
	if err != nil {
		return false, err
	}
	var platform string
	if err := s.db.QueryRow(ctx, `SELECT platform FROM platform_account WHERE id=$1`, accountID).Scan(&platform); err != nil {
		return false, err
	}
	if platform == "toutiao" {
		articleN, microN := 0, 0
		for _, sample := range samples {
			switch sample.ContentFormat {
			case "long_article":
				articleN++
			case "micro_post":
				microN++
			}
		}
		applied, err := s.persistToutiaoDataPreferences(ctx, accountID, revision, samples, true)
		return applied && (articleN >= minAttributionSamples || microN >= minAttributionSamples), err
	}
	applicable := len(samples) >= minAttributionSamples
	var prefs []DataPreference
	if applicable {
		prefs = deriveDataPreferences(attributionStats(samples, s.loc))
	}
	applied, err := s.persistDataPreferences(ctx, accountID, revision, samples, prefs, applicable, true)
	return applicable && applied, err
}

// weeklyReviewDraftJob: with review.weekly_draft on, every Monday each account gets one review draft
// on the economy tier from its day-7 data of the last 30 days. Suggestions still need adopting one by one.
func (s *Server) weeklyReviewDraftJob(ctx context.Context) {
	s.weeklyReviewDraftJobForDay(ctx, s.today())
}

func (s *Server) weeklyReviewDraftJobForDay(ctx context.Context, day time.Time) {
	day = time.Date(day.In(s.loc).Year(), day.In(s.loc).Month(), day.In(s.loc).Day(), 0, 0, 0, 0, s.loc)
	if day.Weekday() != time.Monday {
		return
	}
	week := weekStart(day).Format("2006-01-02")
	rows, err := s.db.Query(ctx, `SELECT a.id, a.workspace_id FROM platform_account a
		JOIN app_setting st ON st.workspace_id=a.workspace_id AND st.key='review_weekly_draft' AND st.value #>> '{}' = 'on'
		WHERE a.status='active' AND NOT a.is_demo`)
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
		if !s.markOnce(ctx, "review-draft:"+x.id.String()+":"+week) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
		now := s.now().In(s.loc)
		asOf := time.Date(day.Year(), day.Month(), day.Day(), now.Hour(), now.Minute(), now.Second(), now.Nanosecond(), s.loc)
		if err := s.weeklyReviewDraftAt(jctx, x.id, week, asOf); err != nil {
			slog.Warn("生成每周复盘草稿失败", "account", x.id, "err", err)
		}
	}
}

func (s *Server) weeklyReviewDraft(ctx context.Context, accountID uuid.UUID, week string) error {
	return s.weeklyReviewDraftAt(ctx, accountID, week, s.now())
}

func (s *Server) weeklyReviewDraftAt(ctx context.Context, accountID uuid.UUID, week string, asOf time.Time) error {
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	since := asOf.AddDate(0, 0, -30)
	link := "/a/" + a.ID.String() + "/review"
	if a.Platform == "toutiao" {
		created := 0
		for _, format := range []string{"long_article", "micro_post"} {
			rows, err := s.db.Query(ctx, `SELECT w.id FROM work w
				JOIN LATERAL metric_node_d7_public(w.id) d ON true
				WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.content_format=$4 AND d.reads IS NOT NULL
				AND w.published_at > $2 AND w.published_at < $3 ORDER BY w.published_at DESC LIMIT 10`, a.ID, since, asOf, format)
			if err != nil {
				return err
			}
			var ids []uuid.UUID
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					ids = append(ids, id)
				}
			}
			rows.Close()
			if len(ids) < minWeeklyDraftWorks {
				continue
			}
			if _, err := s.buildReviewAsFormat(ctx, a, ids, 0, format, "weekly_draft", "economy"); err != nil {
				return err
			}
			created++
		}
		if created > 0 {
			s.notifyWorkspace(ctx, ident(ctx).WorkspaceID, []string{"owner", "editor"}, "review", "上周复盘草稿已生成",
				fmt.Sprintf("%s：按文章与微头条分别生成 %d 份第 7 天复盘草稿，建议需要你逐条采纳。", a.Name, created), link, "review-draft:"+a.ID.String()+":"+week)
		}
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT w.id FROM work w
		JOIN LATERAL metric_node_d7_public(w.id) d ON true
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND d.reads IS NOT NULL AND w.published_at > $2 AND w.published_at < $3
		ORDER BY w.published_at DESC LIMIT 10`, a.ID, since, asOf)
	if err != nil {
		return err
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	ws := ident(ctx).WorkspaceID
	if len(ids) < minWeeklyDraftWorks {
		var published int
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND published_at > $2 AND published_at < $3`, a.ID, since, asOf).Scan(&published)
		if published > 0 {
			s.notifyWorkspace(ctx, ws, []string{"owner", "editor"}, "review", "本周复盘草稿没有生成：先补数据",
				fmt.Sprintf("%s近 30 天只有 %d 篇作品有第 7 天数据，至少 %d 篇才生成复盘草稿。", a.Name, len(ids), minWeeklyDraftWorks),
				link, "review-draft-skip:"+a.ID.String()+":"+week)
		}
		return nil
	}
	rep, err := s.buildReviewAs(ctx, a, ids, 0, "weekly_draft", "economy")
	if err != nil {
		return err
	}
	s.notifyWorkspace(ctx, ws, []string{"owner", "editor"}, "review", "上周复盘草稿已生成",
		fmt.Sprintf("%s：基于 %d 篇作品的第 7 天数据，建议需要你逐条采纳。", a.Name, len(rep.WorkIDs)), link, "review-draft:"+a.ID.String()+":"+week)
	return nil
}
