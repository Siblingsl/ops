package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 系列选题（EX-C-04）：系列有总纲；AI 只建议缺失的选题，逐条入库；起草时带上上一篇 / 下一篇的核心观点。

type Series struct {
	ID        uuid.UUID `json:"id"`
	AccountID uuid.UUID `json:"account_id"`
	Name      string    `json:"name"`
	Outline   string    `json:"outline"`
	Topics    int       `json:"topics"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) listSeries(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT s.id, s.account_id, s.name, s.outline,
		(SELECT count(*) FROM topic t WHERE t.series_id=s.id AND t.deleted_at IS NULL), s.created_at
		FROM topic_series s WHERE s.account_id=$1 ORDER BY s.created_at DESC`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Series{}
	for rows.Next() {
		var x Series
		if err := rows.Scan(&x.ID, &x.AccountID, &x.Name, &x.Outline, &x.Topics, &x.CreatedAt); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) createSeries(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Name    string `json:"name"`
		Outline string `json:"outline"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return validation("请填写系列名称")
	}
	var x Series
	if err := s.db.QueryRow(r.Context(), `INSERT INTO topic_series (account_id, name, outline) VALUES ($1,$2,$3) RETURNING id, account_id, name, outline, created_at`,
		a.ID, truncateRunes(in.Name, 40), strings.TrimSpace(in.Outline)).Scan(&x.ID, &x.AccountID, &x.Name, &x.Outline, &x.CreatedAt); err != nil {
		return err
	}
	return ok(w, x)
}

func (s *Server) ownedSeries(ctx context.Context, id uuid.UUID) (*Series, error) {
	var x Series
	err := s.db.QueryRow(ctx, `SELECT s.id, s.account_id, s.name, s.outline, s.created_at FROM topic_series s JOIN platform_account a ON a.id=s.account_id
		WHERE s.id=$1 AND a.workspace_id=$2`, id, ident(ctx).WorkspaceID).Scan(&x.ID, &x.AccountID, &x.Name, &x.Outline, &x.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func (s *Server) updateSeries(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.ownedSeries(ctx, id); err != nil {
		return err
	}
	var in struct {
		Name    *string `json:"name"`
		Outline *string `json:"outline"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return validation("请填写系列名称")
	}
	if _, err := s.db.Exec(ctx, `UPDATE topic_series SET name=coalesce($2,name), outline=coalesce($3,outline), updated_at=now() WHERE id=$1`,
		id, in.Name, in.Outline); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) deleteSeries(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := s.ownedSeries(ctx, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM topic_series WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

// suggestSeriesTopics proposes missing topics for a series; nothing is written until the user adds one.
func (s *Server) suggestSeriesTopics(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	sr, err := s.ownedSeries(ctx, id)
	if err != nil {
		return err
	}
	a, err := s.account(ctx, sr.AccountID)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT title FROM topic WHERE series_id=$1 AND deleted_at IS NULL ORDER BY created_at`, id)
	if err != nil {
		return err
	}
	var existing []string
	for rows.Next() {
		var t string
		if rows.Scan(&t) == nil {
			existing = append(existing, "- "+t)
		}
	}
	rows.Close()
	user := fmt.Sprintf(`## 系列
名称：%s
总纲：%s

## 系列中已有的选题
%s

## 任务说明
根据总纲找出系列中还缺的选题，给出 3–5 个，不与已有选题重复。

## 输出格式
只输出 JSON：{"topics":[{"title":"选题标题","angle":"切入角度","reason":"为什么系列需要它"}]}`, sr.Name, nz(sr.Outline, "（未填写）"), nz(strings.Join(existing, "\n"), "（暂无）"))
	var out struct {
		Topics []struct {
			Title  string `json:"title"`
			Angle  string `json:"angle"`
			Reason string `json:"reason"`
		} `json:"topics"`
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "topic_suggest", Account: a, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Topics) == 0 {
			return fmt.Errorf("没有选题")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"topics": out.Topics, "ai_call_id": res.CallID})
}

type SeriesNeighbour struct {
	TopicID   uuid.UUID  `json:"topic_id"`
	Title     string     `json:"title"`
	Viewpoint string     `json:"viewpoint"`
	WorkID    *uuid.UUID `json:"work_id"`
}

type SeriesContext struct {
	ID       uuid.UUID        `json:"id"`
	Name     string           `json:"name"`
	Outline  string           `json:"outline"`
	Position int              `json:"position"`
	Total    int              `json:"total"`
	Prev     *SeriesNeighbour `json:"prev"`
	Next     *SeriesNeighbour `json:"next"`
}

// loadSeriesContext orders the series by planned date, then creation, and finds the topic's neighbours.
func (s *Server) loadSeriesContext(ctx context.Context, seriesID uuid.UUID, topicID *uuid.UUID) (*SeriesContext, error) {
	sc := SeriesContext{ID: seriesID}
	if err := s.db.QueryRow(ctx, `SELECT name, outline FROM topic_series WHERE id=$1`, seriesID).Scan(&sc.Name, &sc.Outline); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT t.id, t.title, coalesce(nullif((SELECT w.viewpoint FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL
		ORDER BY w.updated_at DESC LIMIT 1),''), t.angle),
		(SELECT w.id FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL ORDER BY w.updated_at DESC LIMIT 1)
		FROM topic t WHERE t.series_id=$1 AND t.deleted_at IS NULL
		ORDER BY coalesce(t.planned_date, t.created_at::date), t.created_at`, seriesID)
	if err != nil {
		return nil, err
	}
	var list []SeriesNeighbour
	idx := -1
	for rows.Next() {
		var x SeriesNeighbour
		if rows.Scan(&x.TopicID, &x.Title, &x.Viewpoint, &x.WorkID) == nil {
			if topicID != nil && x.TopicID == *topicID {
				idx = len(list)
			}
			list = append(list, x)
		}
	}
	rows.Close()
	sc.Total, sc.Position = len(list), idx+1
	if idx > 0 {
		sc.Prev = &list[idx-1]
	}
	if idx >= 0 && idx+1 < len(list) {
		sc.Next = &list[idx+1]
	}
	return &sc, nil
}

// seriesNeighbours returns the previous / next topics' viewpoints in the series as drafting context.
func (s *Server) seriesNeighbours(ctx context.Context, seriesID uuid.UUID, topicID *uuid.UUID) string {
	sc, err := s.loadSeriesContext(ctx, seriesID, topicID)
	if err != nil {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "\n## 系列上下文\n系列：%s\n", sc.Name)
	if sc.Outline != "" {
		b.WriteString("总纲：" + truncate(sc.Outline, 300) + "\n")
	}
	if p := sc.Prev; p != nil {
		fmt.Fprintf(&b, "上一篇：《%s》核心观点：%s\n", p.Title, truncate(p.Viewpoint, 120))
	}
	if n := sc.Next; n != nil {
		fmt.Fprintf(&b, "下一篇：《%s》核心观点：%s\n", n.Title, truncate(n.Viewpoint, 120))
	}
	b.WriteString("（与上下篇保持衔接，不重复它们的内容）\n")
	return b.String()
}

// workSeriesContext shows the editor where this work sits in its series (EX-C-04); null when the work has no series.
func (s *Server) workSeriesContext(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var seriesID, topicID *uuid.UUID
	_ = s.db.QueryRow(ctx, `SELECT t.series_id, t.id FROM work w JOIN topic t ON t.id=w.topic_id WHERE w.id=$1`, m.ID).Scan(&seriesID, &topicID)
	if seriesID == nil {
		return ok(w, nil)
	}
	sc, err := s.loadSeriesContext(ctx, *seriesID, topicID)
	if err != nil {
		return ok(w, nil)
	}
	return ok(w, sc)
}
