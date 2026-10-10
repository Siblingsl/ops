package app

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Topic struct {
	ID        uuid.UUID  `json:"id"`
	AccountID uuid.UUID  `json:"account_id"`
	Title     string     `json:"title"`
	Angle     string     `json:"angle"`
	Source    string     `json:"source"`
	Status    string     `json:"status"`
	WorkID    *uuid.UUID `json:"work_id"`
	CreatedAt time.Time  `json:"created_at"`
}

func (s *Server) listTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT t.id, t.account_id, t.title, t.angle, t.source, t.status,
		(SELECT id FROM work WHERE topic_id=t.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1), t.created_at
		FROM topic t WHERE t.account_id=$1 AND t.deleted_at IS NULL ORDER BY t.created_at DESC`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Topic{}
	for rows.Next() {
		var t Topic
		if err := rows.Scan(&t.ID, &t.AccountID, &t.Title, &t.Angle, &t.Source, &t.Status, &t.WorkID, &t.CreatedAt); err != nil {
			return err
		}
		list = append(list, t)
	}
	return ok(w, list)
}

// similarTitles returns earlier topics or works of the account whose titles look alike (FR-M3-04 提示，不阻止).
func (s *Server) similarTitles(r *http.Request, accountID uuid.UUID, title string) ([]string, error) {
	rows, err := s.db.Query(r.Context(), `SELECT title FROM (
		SELECT title FROM topic WHERE account_id=$1 AND deleted_at IS NULL
		UNION SELECT title FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'') x
		WHERE similarity(title, $2) > 0.35 ORDER BY similarity(title, $2) DESC LIMIT 3`, accountID, title)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// createTopic is the only way a topic enters the pool: one item per request (H-01).
func (s *Server) createTopic(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Title  string `json:"title"`
		Angle  string `json:"angle"`
		Source string `json:"source"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return validation("请填写选题标题")
	}
	switch in.Source {
	case "ai", "review", "hot":
	default:
		in.Source = "manual"
	}
	similar, err := s.similarTitles(r, a.ID, in.Title)
	if err != nil {
		return err
	}
	var t Topic
	if err := s.db.QueryRow(r.Context(), `INSERT INTO topic (account_id, title, angle, source) VALUES ($1,$2,$3,$4)
		RETURNING id, account_id, title, angle, source, status, created_at`, a.ID, in.Title, strings.TrimSpace(in.Angle), in.Source).
		Scan(&t.ID, &t.AccountID, &t.Title, &t.Angle, &t.Source, &t.Status, &t.CreatedAt); err != nil {
		return err
	}
	return ok(w, map[string]any{"topic": t, "similar": similar})
}

// suggestTopics only returns suggestions; nothing is written to the pool (H-01, HC-01).
func (s *Server) suggestTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Direction string `json:"direction"`
	}
	_ = decode(r, &in)
	rows, err := s.db.Query(r.Context(), `SELECT title FROM (SELECT title, created_at FROM topic WHERE account_id=$1 AND deleted_at IS NULL
		UNION ALL SELECT title, created_at FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'') x ORDER BY created_at DESC LIMIT 20`, a.ID)
	if err != nil {
		return err
	}
	var recent []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			recent = append(recent, t)
		}
	}
	rows.Close()
	user := fmt.Sprintf(`## 选题需求
方向关键词：%s
最近的选题和作品标题（避免重复）：
%s

## 任务说明
为这个账号提出不少于 6 个选题建议。每个选题给出标题、切入角度和推荐理由。选题要贴合账号定位和目标读者，与最近的选题不重复；不要追逐无法核实的热点。

## 输出格式
只输出 JSON：{"topics":[{"title":"选题标题","angle":"切入角度","reason":"推荐理由"}]}`,
		strings.TrimSpace(in.Direction), "- "+strings.Join(recent, "\n- "))
	var out struct {
		Topics []struct {
			Title  string `json:"title"`
			Angle  string `json:"angle"`
			Reason string `json:"reason"`
		} `json:"topics"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "topic_suggest", Account: a, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Topics) < 5 {
			return fmt.Errorf("选题少于 5 条")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"suggestions": out.Topics, "refs": res.Refs, "ai_call_id": res.CallID})
}

// suggestHotTopics returns timely topic ideas from compliant sources only (FR-M3-05 / D-016).
// Does not scrape platform hotlists; optional user-pasted public excerpts may ground suggestions.
// Nothing is written to the pool (H-01).
func (s *Server) suggestHotTopics(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Direction string `json:"direction"`
		Context   string `json:"context"` // 用户粘贴的公开资讯摘要，可选
	}
	_ = decode(r, &in)
	rows, err := s.db.Query(r.Context(), `SELECT title FROM (SELECT title, created_at FROM topic WHERE account_id=$1 AND deleted_at IS NULL
		UNION ALL SELECT title, created_at FROM work WHERE account_id=$1 AND deleted_at IS NULL AND title<>'') x ORDER BY created_at DESC LIMIT 20`, a.ID)
	if err != nil {
		return err
	}
	var recent []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err == nil {
			recent = append(recent, t)
		}
	}
	rows.Close()
	ctxText := strings.TrimSpace(in.Context)
	if ctxText == "" {
		ctxText = "（用户未粘贴资讯摘要；仅基于账号定位与公开常识给出时效性选题角度，不要编造具体新闻链接或未核实的事件细节。）"
	} else if len([]rune(ctxText)) > 4000 {
		ctxText = string([]rune(ctxText)[:4000])
	}
	user := fmt.Sprintf(`## 热点选题需求（合规来源）
方向关键词：%s
用户粘贴的公开资讯摘要（可为空）：
%s

最近的选题和作品标题（避免重复）：
%s

## 任务说明
结合账号定位，提出不少于 6 个「有时效感」的选题建议。合规约束：
1. 禁止使用或模仿任何平台热榜爬取结果（微信、小红书等）；不得建议去爬取热榜。
2. 若用户粘贴了资讯摘要，优先据此提炼角度；未粘贴时用公开常识与季节性话题，并在理由中说明「待用户核实时效」。
3. 不要编造具体报道链接、媒体名下的假新闻或无法核实的数据。
4. 每个选题给出标题、切入角度、推荐理由，以及可选的时效提示（如「本周热点」「常青但当下有讨论」）。

## 输出格式
只输出 JSON：{"topics":[{"title":"选题标题","angle":"切入角度","reason":"推荐理由","timeliness":"时效提示"}]}`,
		strings.TrimSpace(in.Direction), ctxText, "- "+strings.Join(recent, "\n- "))
	var out struct {
		Topics []struct {
			Title      string `json:"title"`
			Angle      string `json:"angle"`
			Reason     string `json:"reason"`
			Timeliness string `json:"timeliness"`
		} `json:"topics"`
	}
	res, err := s.runAIJSON(r.Context(), aiTask{Type: "topic_hot_suggest", Account: a, User: user, SkipStyle: true}, &out, func() error {
		if len(out.Topics) < 5 {
			return fmt.Errorf("热点选题少于 5 条")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"suggestions": out.Topics, "refs": res.Refs, "ai_call_id": res.CallID})
}

func (s *Server) updateTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "topic", id); err != nil {
		return err
	}
	var in struct {
		Title  *string `json:"title"`
		Angle  *string `json:"angle"`
		Status *string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Status != nil && *in.Status != "pending" && *in.Status != "adopted" && *in.Status != "dropped" {
		return validation("状态只能是待定、已采用或已放弃")
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE topic SET title=coalesce($2,title), angle=coalesce($3,angle), status=coalesce($4,status), updated_at=now() WHERE id=$1`,
		id, in.Title, in.Angle, in.Status); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) deleteTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.ownedAccountRow(r.Context(), "topic", id); err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE topic SET deleted_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) startWorkFromTopic(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	accountID, err := s.ownedAccountRow(ctx, "topic", id)
	if err != nil {
		return err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	var title, angle string
	if err := s.db.QueryRow(ctx, `UPDATE topic SET status='adopted', updated_at=now() WHERE id=$1 RETURNING title, angle`, id).Scan(&title, &angle); err != nil {
		return err
	}
	workID, err := s.insertWork(ctx, a, &id, title, angle)
	if err != nil {
		return err
	}
	return s.writeWork(w, r, workID)
}
