package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// DEV-A106（13 文档）：今日智能简报。AI 把昨日表现、今日推荐与待办解读成 3–5 条
// "今天值得关注"；每账号每天至多一条（markOnce 幂等 + 主键约束）。数字只能来自输入；
// 没有可说的内容（无方案、无数据）就不生成，界面显示空态而非编造。

type DailyBrief struct {
	Items []string `json:"items"`
}

func (s *Server) dailyBriefJob(ctx context.Context) {
	s.dailyBriefJobForDay(ctx, s.today())
}

func (s *Server) dailyBriefJobForDay(ctx context.Context, day time.Time) {
	day = time.Date(day.In(s.loc).Year(), day.In(s.loc).Month(), day.In(s.loc).Day(), 0, 0, 0, 0, s.loc)
	rows, err := s.db.Query(ctx, `SELECT id, workspace_id FROM platform_account WHERE status='active' AND NOT is_demo`)
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
		if !s.markOnce(ctx, "brief:"+x.id.String()+":"+day.Format("2006-01-02")) {
			continue
		}
		jctx := context.WithValue(ctx, ctxMember, &identity{WorkspaceID: x.ws})
		if err := s.generateBriefForDay(jctx, x.id, day); err != nil {
			slog.Warn("生成每日简报失败", "account", x.id, "date", day.Format("2006-01-02"), "err", err)
		}
	}
}

// getBrief returns today's brief; if none exists it queues generation once.
func (s *Server) getBrief(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	today := s.today()
	var raw []byte
	err = s.db.QueryRow(ctx, `SELECT content FROM account_daily_brief WHERE account_id=$1 AND date=$2`, a.ID, today).Scan(&raw)
	if err == nil {
		var b DailyBrief
		_ = json.Unmarshal(raw, &b)
		return ok(w, map[string]any{"brief": b})
	}
	jobQueued := false
	// prepare=false 为只读模式：不登记任务标记，也不创建 daily_brief 任务（16 文档第 14.2 节第 2 项）。
	if r.URL.Query().Get("prepare") != "false" && s.markOnce(ctx, "brief:"+a.ID.String()+":"+today.Format("2006-01-02")) {
		if _, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "daily_brief", Label: "今日智能简报", AccountID: &a.ID},
			func(jctx context.Context) (any, error) {
				if err := s.generateBrief(jctx, a.ID); err != nil {
					return nil, err
				}
				return map[string]any{"ok": true}, nil
			}); err == nil {
			jobQueued = true
		}
	}
	return ok(w, map[string]any{"brief": nil, "preparing": jobQueued})
}

func (s *Server) generateBrief(ctx context.Context, accountID uuid.UUID) error {
	return s.generateBriefForDay(ctx, accountID, s.today())
}

func (s *Server) generateBriefForDay(ctx context.Context, accountID uuid.UUID, day time.Time) error {
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	today := time.Date(day.In(s.loc).Year(), day.In(s.loc).Month(), day.In(s.loc).Day(), 0, 0, 0, 0, s.loc)
	end := today.AddDate(0, 0, 1)
	var published int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL AND published_at >= $2 AND published_at < $3`,
		a.ID, today.AddDate(0, 0, -1), today).Scan(&published)
	var reads int
	// 走统一入口 metric_node_d7_public（§8.4）：保留 d7 兜底语义与 approved 过滤。
	_ = s.db.QueryRow(ctx, `SELECT coalesce(sum(d.reads),0) FROM work w
		JOIN LATERAL metric_node_d7_public(w.id) d ON true
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.published_at >= $2 AND w.published_at < $3`, a.ID, today.AddDate(0, 0, -7), end).Scan(&reads)
	var adopted int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM topic t WHERE t.account_id=$1 AND t.status='adopted' AND t.deleted_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM work w WHERE w.topic_id=t.id AND w.deleted_at IS NULL)`, a.ID).Scan(&adopted)
	var pendingMetrics int
	asOf := s.now()
	if !today.Equal(s.today()) {
		asOf = end.Add(-time.Nanosecond)
	}
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND `+nodeDueExpr(2, 3)+` IS NOT NULL`,
		a.ID, asOf, datacubeCovers(a)).Scan(&pendingMetrics)
	recTitles := []string{}
	recRows, err := s.db.Query(ctx, `SELECT it->>'title' FROM daily_recommendation d, jsonb_array_elements(d.items) it
		WHERE d.account_id=$1 AND d.date=$2 ORDER BY d.version DESC LIMIT 5`, a.ID, today)
	if err == nil {
		for recRows.Next() {
			var t string
			if recRows.Scan(&t) == nil && strings.TrimSpace(t) != "" {
				recTitles = append(recTitles, t)
			}
		}
		recRows.Close()
	}
	if published == 0 && len(recTitles) == 0 && adopted == 0 && pendingMetrics == 0 {
		return nil // 没有可说的内容，不生成也不编造。
	}

	data := fmt.Sprintf("昨日发布：%d\n近 7 天发布作品的阅读合计：%d\n今日推荐 %d 条：%s\n待采用未开写的选题：%d\n待回填数据的已发布作品：%d",
		published, reads, len(recTitles), strings.Join(recTitles, "、"), adopted, pendingMetrics)
	user := "## 今日数据\n" + data + `
## 任务说明
用 3–5 条短句告诉作者今天值得关注什么：把上面的数字翻译成具体行动（先写哪条、先回填哪些数据、今天优先做什么）。每条不超过 60 字，所有数字只能来自上面的数据，没有依据的事不要说。

## 输出格式
只输出 JSON：{"items":["一条关注点"]}`
	var out struct {
		Items []string `json:"items"`
	}
	var callID *uuid.UUID
	if res, err := s.runAIJSON(ctx, aiTask{Type: "daily_brief", Account: a, User: user, SkipStyle: true, Tier: "economy"}, &out, func() error {
		if len(out.Items) == 0 || len(out.Items) > 5 {
			return fmt.Errorf("简报应为 1–5 条")
		}
		all := strings.Join(out.Items, " ")
		if bad := numbersNotIn(all, data); len(bad) > 0 {
			return fmt.Errorf("简报里出现了输入数据中没有的数字：%s", strings.Join(bad, "、"))
		}
		for _, it := range out.Items {
			if strings.TrimSpace(it) == "" || runeLen(it) > 100 {
				return fmt.Errorf("简报条目为空或超过 100 字")
			}
		}
		return nil
	}); err == nil {
		callID = &res.CallID
	} else {
		// AI 不可用时的保底：只复述确定的数据，不编造。
		items := []string{}
		if len(recTitles) > 0 {
			items = append(items, fmt.Sprintf("今日有 %d 条推荐：先挑一条「%s」看看要不要写。", len(recTitles), truncate(recTitles[0], 20)))
		}
		if adopted > 0 {
			items = append(items, fmt.Sprintf("有 %d 个已采用的选题还没开写。", adopted))
		}
		if pendingMetrics > 0 {
			items = append(items, fmt.Sprintf("有 %d 篇已发布的作品还差数据回填。", pendingMetrics))
		}
		if len(items) == 0 {
			return nil
		}
		out.Items = items
	}
	content, _ := json.Marshal(DailyBrief{Items: out.Items})
	if _, err := s.db.Exec(ctx, `INSERT INTO account_daily_brief (account_id, date, content, ai_call_id) VALUES ($1,$2,$3,$4)
		ON CONFLICT (account_id, date) DO NOTHING`, a.ID, today, content, callID); err != nil {
		return err
	}
	return nil
}
