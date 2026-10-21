package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type Metric struct {
	ID               uuid.UUID `json:"id"`
	WorkID           uuid.UUID `json:"work_id"`
	CapturedAt       time.Time `json:"captured_at"`
	Reads            *int      `json:"reads"`
	Impressions      *int64    `json:"impressions"`
	ImpressionsExact *string   `json:"impressions_exact"`
	CTR              *float64  `json:"ctr"`
	Likes            *int      `json:"likes"`
	Wows             *int      `json:"wows"`
	Favorites        *int      `json:"favorites"`
	Comments         *int      `json:"comments"`
	Shares           *int      `json:"shares"`
	FollowsGained    *int      `json:"follows_gained"`
	Note             string    `json:"note"`
	Source           string    `json:"source"`
	DayOffset        *int      `json:"day_offset"`
	ExternalID       *string   `json:"external_id"`
	Revision         int       `json:"revision"`
	// 口径与质量（20 文档 §9.1、§8.5）：单位未知时不得与人数/次数聚合。
	ReadUnit       string          `json:"read_unit"`
	ShareUnit      string          `json:"share_unit"`
	QualityState   string          `json:"quality_state"`
	ObservationID  *uuid.UUID      `json:"observation_id"`
	ObservedAt     *time.Time      `json:"observed_at"`
	AsOfAt         *time.Time      `json:"as_of_at"`
	MetricMeta     json.RawMessage `json:"metric_meta"`
	CTRUnavailable string          `json:"ctr_unavailable,omitempty"`
}

const metricCols = `id, work_id, captured_at, reads, impressions, likes, wows, favorites, comments, shares, follows_gained, note, source, day_offset, external_id, revision,
	read_unit, share_unit, quality_state, observation_id, observed_at, as_of_at, metric_meta`

func metricDest(m *Metric) []any {
	return []any{&m.ID, &m.WorkID, &m.CapturedAt, &m.Reads, &m.Impressions, &m.Likes, &m.Wows, &m.Favorites, &m.Comments, &m.Shares, &m.FollowsGained, &m.Note, &m.Source, &m.DayOffset, &m.ExternalID, &m.Revision,
		&m.ReadUnit, &m.ShareUnit, &m.QualityState, &m.ObservationID, &m.ObservedAt, &m.AsOfAt, &m.MetricMeta}
}

// metricCTR 按 §9.1 派生点击率。规则按来源区分：
//   - 浏览器新来源（wechat_browser/xhs_browser）：只有同一快照、两者均有值、impressions>0
//     且 read_unit='times' 时才计算；users 或 unknown 返回 NULL 并标“口径不可比”。
//   - 旧来源（含头条、官方同步、人工）保持原行为：19 文档已按同快照 reads/impressions 派生，
//     本轮不改既有报表口径。
func metricCTR(m *Metric) (*float64, string) {
	if m.Reads == nil || m.Impressions == nil || *m.Impressions <= 0 {
		return nil, ""
	}
	if isBrowserMetricSource(m.Source) && m.ReadUnit != "times" {
		return nil, "read_unit_not_times"
	}
	ctr := float64(*m.Reads) / float64(*m.Impressions)
	return &ctr, ""
}

// isBrowserMetricSource 判断是否为网页后台读取的新来源。
func isBrowserMetricSource(source string) bool {
	return source == "wechat_browser" || source == "xhs_browser"
}

func scanMetric(row interface{ Scan(...any) error }) (Metric, error) {
	var m Metric
	err := row.Scan(metricDest(&m)...)
	if err == nil {
		m.CTR, m.CTRUnavailable = metricCTR(&m)
	}
	if err == nil && m.Impressions != nil {
		exact := strconv.FormatInt(*m.Impressions, 10)
		m.ImpressionsExact = &exact
	}
	return m, err
}

type BoardRow struct {
	ID            uuid.UUID  `json:"id"`
	Title         string     `json:"title"`
	ContentFormat string     `json:"content_format"`
	Status        string     `json:"status"`
	PublishedAt   *time.Time `json:"published_at"`
	D7            *Metric    `json:"d7"`
	Nodes         []int32    `json:"nodes"`
	Points        int        `json:"points"`
}

func (s *Server) board(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	format := strings.TrimSpace(r.URL.Query().Get("content_format"))
	if a.Platform == "toutiao" && format != "" && format != "long_article" && format != "micro_post" {
		return validation("头条数据看板形态无效")
	}
	if a.Platform != "toutiao" && format != "" && format != a.ContentFormat {
		return validation("该账号不支持所选数据形态")
	}
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.content_format, w.status, w.published_at, (SELECT count(*) FROM metric_snapshot WHERE work_id=w.id),
		ARRAY(SELECT DISTINCT metric_node(day_offset) FROM metric_snapshot WHERE work_id=w.id AND metric_node(day_offset) IS NOT NULL ORDER BY 1)
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.status IN ('pushed','packed','published') AND ($2='' OR w.content_format=$2)
		ORDER BY coalesce(w.published_at, w.updated_at) DESC LIMIT 200`, a.ID, format)
	if err != nil {
		return err
	}
	list := []BoardRow{}
	for rows.Next() {
		var b BoardRow
		if err := rows.Scan(&b.ID, &b.Title, &b.ContentFormat, &b.Status, &b.PublishedAt, &b.Points, &b.Nodes); err != nil {
			rows.Close()
			return err
		}
		list = append(list, b)
	}
	rows.Close()
	for i := range list {
		if list[i].Points == 0 {
			continue
		}
		m, err := scanMetric(s.db.QueryRow(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE id=(SELECT metric_id FROM work_metric_d7 WHERE work_id=$1)`, list[i].ID))
		if err == nil {
			list[i].D7 = &m
		}
	}
	return ok(w, list)
}

func (s *Server) listMetrics(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("view") == "nodes" {
		var publishedAt *time.Time
		if err := s.db.QueryRow(r.Context(), `SELECT published_at FROM work WHERE id=$1`, m.ID).Scan(&publishedAt); err != nil {
			return err
		}
		out, err := s.metricNodesView(r.Context(), m.ID, publishedAt)
		if err != nil {
			return err
		}
		return ok(w, out)
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+metricCols+` FROM metric_snapshot WHERE work_id=$1 ORDER BY day_offset NULLS LAST, captured_at`, m.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []Metric{}
	for rows.Next() {
		x, err := scanMetric(rows)
		if err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

type metricInput struct {
	CapturedAt    *time.Time `json:"captured_at"`
	BaseRevision  *int       `json:"base_revision"`
	Reads         *int       `json:"reads"`
	Impressions   *int64     `json:"impressions"`
	Likes         *int       `json:"likes"`
	Wows          *int       `json:"wows"`
	Favorites     *int       `json:"favorites"`
	Comments      *int       `json:"comments"`
	Shares        *int       `json:"shares"`
	FollowsGained *int       `json:"follows_gained"`
	Note          string     `json:"note"`
}

func (in *metricInput) validate(platform string) error {
	if in.BaseRevision != nil && *in.BaseRevision < 1 {
		return validation("数据修订号无效")
	}
	for _, v := range []*int{in.Reads, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained} {
		if v != nil && *v < 0 {
			return validation("数据不能为负数")
		}
	}
	if in.Impressions != nil && *in.Impressions < 0 {
		return validation("展现量不能为负数")
	}
	if platform != "toutiao" && in.Impressions != nil {
		return validation("展现量仅适用于今日头条作品")
	}
	if in.Reads == nil && in.Impressions == nil && in.Likes == nil && in.Wows == nil && in.Favorites == nil && in.Comments == nil && in.Shares == nil && in.FollowsGained == nil {
		return validation("至少填写一项数据")
	}
	return nil
}

func (s *Server) createMetric(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in metricInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.validate(m.Account.Platform); err != nil {
		return err
	}
	at := s.now()
	if in.CapturedAt != nil {
		at = *in.CapturedAt
	}
	var x Metric
	var merged bool
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		var status string
		if err := tx.QueryRow(r.Context(), `SELECT status FROM work WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, m.ID).Scan(&status); err != nil {
			return err
		}
		if status != "pushed" && status != "packed" && status != "published" {
			return stateInvalid("作品发布后才能录入数据")
		}
		var err error
		x, merged, err = s.upsertMetricWithAudit(r.Context(), tx, metricWrite{WorkID: m.ID, CapturedAt: at, Source: "manual",
			Reads: in.Reads, Impressions: in.Impressions, Likes: in.Likes, Wows: in.Wows, Favorites: in.Favorites, Comments: in.Comments, Shares: in.Shares,
			FollowsGained: in.FollowsGained, Note: strings.TrimSpace(in.Note)})
		return err
	})
	if err != nil {
		return err
	}
	return ok(w, struct {
		Metric
		Merged bool `json:"merged"`
	}{x, merged})
}

// isAutoMetricSource 判断该来源是否由平台自动采集写入（不可原地改写）。
func isAutoMetricSource(source string) bool {
	return source == "wechat_browser" || source == "xhs_browser" || source == "wechat_api" || source == "toutiao_api"
}

// holdAutoAndWriteManual 是"人工更正自动来源数据"的正确路径（§9.3）。
//
// 三步，缺一不可：
//  1. 原自动行标 `held`（保留原值，不删不改）——它是平台原始读数，用于对账与追溯；
//  2. 同节点写/更新 `manual` 快照承载人工值，并记 `corrects_observation_id`
//     指向被更正的观测（注意不是 `observation_id`：后者表示"这条指标来自该观测"）；
//  3. 审计记录，便于回答"这个数字是谁改的、原值多少"。
//
// 为什么不原地改：原地改会让平台原值永久丢失，且下次采集按
// `(work, source, day_offset)` 覆盖回来，用户的更正等于白做。
func (s *Server) holdAutoAndWriteManual(ctx context.Context, tx pgx.Tx, workID uuid.UUID, before Metric, in metricInput) (Metric, error) {
	// 1) 原自动行标 held（幂等：已经是 held 就不动）。
	if _, err := tx.Exec(ctx, `UPDATE metric_snapshot SET quality_state='held'
		WHERE id=$1 AND quality_state<>'held'`, before.ID); err != nil {
		return Metric{}, err
	}
	// 2) 同节点写 manual。captured_at 沿用原行，确保落在同一 day_offset。
	dayOffset := before.DayOffset
	manual, _, err := s.upsertMetricWithAudit(ctx, tx, metricWrite{
		WorkID: workID, CapturedAt: before.CapturedAt, Source: "manual", DayOffset: dayOffset,
		Reads: in.Reads, Impressions: in.Impressions, Likes: in.Likes, Wows: in.Wows,
		Favorites: in.Favorites, Comments: in.Comments, Shares: in.Shares,
		FollowsGained: in.FollowsGained, Note: strings.TrimSpace(in.Note),
	})
	if err != nil {
		return Metric{}, err
	}
	// 3) 记 corrects_observation_id：说明"这条人工值是在纠正哪条自动观测"。
	//    与 observation_id 区分开——后者会让人误以为人工值来自平台。
	if before.ObservationID != nil {
		if _, err := tx.Exec(ctx, `UPDATE metric_snapshot SET corrects_observation_id=$2 WHERE id=$1`,
			manual.ID, *before.ObservationID); err != nil {
			return Metric{}, err
		}
	}
	return manual, nil
}

func (s *Server) metricOwned(r *http.Request) (uuid.UUID, uuid.UUID, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	var workID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT work_id FROM metric_snapshot WHERE id=$1`, id).Scan(&workID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	if _, err := s.workMeta(r.Context(), workID); err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	return id, workID, nil
}

func (s *Server) updateMetric(w http.ResponseWriter, r *http.Request) error {
	id, workID, err := s.metricOwned(r)
	if err != nil {
		return err
	}
	var in metricInput
	if err := decode(r, &in); err != nil {
		return err
	}
	work, err := s.workMeta(r.Context(), workID)
	if err != nil {
		return err
	}
	if err := in.validate(work.Account.Platform); err != nil {
		return err
	}
	if in.BaseRevision == nil {
		return validation("请刷新数据后再修改")
	}
	var x Metric
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := lockMetricWork(r.Context(), tx, workID); err != nil {
			return err
		}
		before, err := scanMetric(tx.QueryRow(r.Context(), `SELECT `+metricCols+` FROM metric_snapshot WHERE id=$1 AND work_id=$2 FOR UPDATE`, id, workID))
		if err == pgx.ErrNoRows {
			return stateInvalid("这条数据已被删除，请刷新后重试")
		}
		if err != nil {
			return err
		}
		if before.Revision != *in.BaseRevision {
			return stateInvalid("这条数据已被其他成员修改，请刷新后重试")
		}
		// 自动来源（浏览器/官方接口）的快照**不能在原地改成另一组"平台原值"**（§9.3）：
		//   - 原地改会让平台原始读数永久丢失，再也无法与平台对账；
		//   - 且下次采集会按 (work, source, day_offset) 覆盖回来，用户的更正白做。
		// 正确做法：新建/更新同节点的 manual 快照承载人工值，把原自动行标 `held` 保留下来。
		if isAutoMetricSource(before.Source) {
			x, err = s.holdAutoAndWriteManual(r.Context(), tx, workID, before, in)
			if err != nil {
				return err
			}
			return s.auditMetricMutation(r.Context(), tx, "metric_update", &before, &x, false)
		}
		x, err = scanMetric(tx.QueryRow(r.Context(), `UPDATE metric_snapshot SET captured_at=coalesce($2, captured_at), reads=$3, impressions=$4, likes=$5, wows=$6, favorites=$7,
			comments=$8, shares=$9, follows_gained=$10, note=$11 WHERE id=$1 RETURNING `+metricCols,
			id, in.CapturedAt, in.Reads, in.Impressions, in.Likes, in.Wows, in.Favorites, in.Comments, in.Shares, in.FollowsGained, strings.TrimSpace(in.Note)))
		if isUniqueViolation(err) {
			return validation("这篇作品在该发布天数已经有一条同来源的数据，请直接编辑那一条")
		}
		if err != nil {
			return err
		}
		return s.auditMetricMutation(r.Context(), tx, "metric_update", &before, &x, false)
	})
	if err != nil {
		return err
	}
	return ok(w, x)
}

func (s *Server) deleteMetric(w http.ResponseWriter, r *http.Request) error {
	id, workID, err := s.metricOwned(r)
	if err != nil {
		return err
	}
	raw := r.URL.Query().Get("base_revision")
	if raw == "" {
		return validation("请刷新数据后再删除")
	}
	baseRevision, err := strconv.Atoi(raw)
	if err != nil || baseRevision < 1 {
		return validation("数据修订号无效")
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		if _, err := lockMetricWork(r.Context(), tx, workID); err != nil {
			return err
		}
		before, err := scanMetric(tx.QueryRow(r.Context(), `SELECT `+metricCols+` FROM metric_snapshot WHERE id=$1 AND work_id=$2 FOR UPDATE`, id, workID))
		if err == pgx.ErrNoRows {
			return stateInvalid("这条数据已被删除，请刷新后重试")
		}
		if err != nil {
			return err
		}
		if before.Revision != baseRevision {
			return stateInvalid("这条数据已被其他成员修改，请刷新后重试")
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM metric_snapshot WHERE id=$1`, id); err != nil {
			return err
		}
		return s.auditMetricMutation(r.Context(), tx, "metric_delete", &before, nil, false)
	})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true})
}

type ReviewContent struct {
	ContentFormat    string   `json:"content_format,omitempty"`
	Conclusions      []string `json:"conclusions"`
	TopicSuggestions []struct {
		Title  string `json:"title"`
		Angle  string `json:"angle"`
		Reason string `json:"reason"`
	} `json:"topic_suggestions"`
	WritingInsights []string `json:"writing_insights"`
}

type ReviewReport struct {
	ID         uuid.UUID     `json:"id"`
	WorkIDs    []uuid.UUID   `json:"work_ids"`
	Content    ReviewContent `json:"content"`
	Adopted    []int32       `json:"adopted"`
	Remembered []int32       `json:"remembered"`
	Ignored    []int32       `json:"ignored"`
	Origin     string        `json:"origin"` // manual | weekly_draft
	CreatedAt  time.Time     `json:"created_at"`
}

// createReview only produces suggestions; nothing is written to the topic pool (H-08, HC-08).
func (s *Server) createReview(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		WorkIDs       []uuid.UUID `json:"work_ids"`
		Recent        int         `json:"recent"`
		ContentFormat string      `json:"content_format"`
		Background    bool        `json:"background"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	if a.Platform == "toutiao" && in.ContentFormat != "long_article" && in.ContentFormat != "micro_post" {
		return validation("请选择文章或微头条后再生成复盘")
	}
	if a.Platform != "toutiao" && in.ContentFormat != "" && in.ContentFormat != a.ContentFormat {
		return validation("该账号不支持所选复盘形态")
	}
	if in.Background {
		jobID, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "review_analysis", Label: "AI 复盘 · " + a.Name, AccountID: &a.ID,
			Link: "/a/" + a.ID.String() + "/review"}, func(jctx context.Context) (any, error) {
			rep, err := s.buildReviewAsFormat(jctx, a, in.WorkIDs, in.Recent, in.ContentFormat, "manual", "")
			if err != nil {
				return nil, err
			}
			return map[string]any{"report_id": rep.ID}, nil
		})
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"job_id": jobID})
	}
	rep, err := s.buildReviewAsFormat(ctx, a, in.WorkIDs, in.Recent, in.ContentFormat, "manual", "")
	if err != nil {
		return err
	}
	return ok(w, rep)
}

func (s *Server) buildReview(ctx context.Context, a *Account, workIDs []uuid.UUID, recent int) (*ReviewReport, error) {
	return s.buildReviewAs(ctx, a, workIDs, recent, "manual", "")
}

// buildReviewAs records who started the review (origin) and may force a cost tier (weekly drafts run on economy).
func (s *Server) buildReviewAs(ctx context.Context, a *Account, workIDs []uuid.UUID, recent int, origin, tier string) (*ReviewReport, error) {
	return s.buildReviewAsFormat(ctx, a, workIDs, recent, "", origin, tier)
}

func (s *Server) buildReviewAsFormat(ctx context.Context, a *Account, workIDs []uuid.UUID, recent int, contentFormat, origin, tier string) (*ReviewReport, error) {
	if a.Platform == "toutiao" {
		if contentFormat == "" {
			contentFormat = a.ContentFormat
		}
		if contentFormat != "long_article" && contentFormat != "micro_post" {
			return nil, validation("请选择文章或微头条后再生成复盘")
		}
	} else if contentFormat != "" && contentFormat != a.ContentFormat {
		return nil, validation("该账号不支持所选复盘形态")
	}
	ids := workIDs
	if len(ids) == 0 {
		n := recent
		if n <= 0 || n > 30 {
			n = 10
		}
		rows, err := s.db.Query(ctx, `SELECT w.id FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL
			AND ($3='' OR w.content_format=$3) AND EXISTS (SELECT 1 FROM metric_snapshot m WHERE m.work_id=w.id)
			ORDER BY coalesce(w.published_at, w.updated_at) DESC LIMIT $2`, a.ID, n, contentFormat)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id uuid.UUID
			_ = rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}
	if len(ids) == 0 {
		return nil, validation("还没有录入过数据的作品，请先在看板中录入数据")
	}
	var b strings.Builder
	var used []uuid.UUID
	for _, id := range ids {
		var title, status, format string
		var publishedAt *time.Time
		if err := s.db.QueryRow(ctx, `SELECT title, status, published_at, content_format FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, id, a.ID).
			Scan(&title, &status, &publishedAt, &format); err != nil {
			continue
		}
		if contentFormat != "" && format != contentFormat {
			return nil, validation("所选作品中包含其他形态，请按文章或微头条分开复盘")
		}
		used = append(used, id)
		fmt.Fprintf(&b, "### 《%s》", title)
		if a.Platform == "toutiao" {
			fmt.Fprintf(&b, "（%s）", map[string]string{"long_article": "文章", "micro_post": "微头条"}[format])
		}
		if publishedAt != nil {
			fmt.Fprintf(&b, "（发布于 %s）", publishedAt.In(s.loc).Format("2006-01-02 15:04"))
		}
		b.WriteString("\n")
		rows, err := s.db.Query(ctx, `SELECT `+metricCols+` FROM metric_snapshot WHERE work_id=$1 ORDER BY day_offset NULLS LAST, captured_at`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			m, err := scanMetric(rows)
			if err != nil {
				break
			}
			fmt.Fprintf(&b, "- %s（%s 采集，来源 %s）：%s\n", dayOffsetLabel(m.DayOffset), m.CapturedAt.In(s.loc).Format("2006-01-02"), m.Source, metricLine(m))
		}
		rows.Close()
	}
	if len(used) == 0 {
		return nil, validation("所选作品不存在")
	}
	user := "## 作品及数据\n" + b.String() + `
## 任务说明
根据以上作品数据做复盘：作品之间比较时以"第 7 天数据"为准（没有第 7 天的按最接近的天数，并说明），不要拿不同天数的数字直接比较。展现与阅读是不同指标；不得根据缺失展现推算推荐量，不得比较不同形态，也不得把累计指标解释为观察时点以外的区间值。总结哪些做法有效、哪些无效（结论要基于数据，不要编造），并给出不少于 3 条下一步的选题建议。另外给出写作层面的结论（如标题、开头、结构上的规律），每条一句可执行的规则，没有依据时可以为空。

## 输出格式
只输出 JSON：{"conclusions":["结论"],"topic_suggestions":[{"title":"选题标题","angle":"切入角度","reason":"依据"}],"writing_insights":["写作层面的规律"]}`
	var out ReviewContent
	account := *a
	if a.Platform == "toutiao" {
		account.ContentFormat = contentFormat
		out.ContentFormat = contentFormat
	}
	res, err := s.runAIJSON(ctx, aiTask{Type: "review_analysis", Account: &account, User: user, SkipStyle: true, Tier: tier, Refs: map[string]any{"works": len(used), "origin": origin, "content_format": contentFormat}}, &out, func() error {
		if len(out.TopicSuggestions) < 3 {
			return fmt.Errorf("建议少于 3 条")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	content, _ := json.Marshal(out)
	var rep ReviewReport
	if err := s.db.QueryRow(ctx, `INSERT INTO review_report (account_id, work_ids, content, ai_call_id, origin) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
		a.ID, used, content, res.CallID, origin).Scan(&rep.ID, &rep.CreatedAt); err != nil {
		return nil, err
	}
	rep.Origin = origin
	if out.WritingInsights == nil {
		out.WritingInsights = []string{}
	}
	rep.WorkIDs, rep.Content, rep.Adopted, rep.Remembered, rep.Ignored = used, out, []int32{}, []int32{}, []int32{}
	return &rep, nil
}

// rememberInsight turns one writing insight into an active memory (EX-J-03); the click is the human confirmation.
func (s *Server) rememberInsight(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var remembered []int32
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, remembered FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &remembered); err != nil {
		return err
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.WritingInsights) {
		return validation("结论不存在")
	}
	for _, x := range remembered {
		if int(x) == idx {
			return stateInvalid("这条结论已经记住了")
		}
	}
	text := truncate(strings.TrimSpace(rc.WritingInsights[idx]), 200)
	uid := ident(ctx).UserID
	var memID uuid.UUID
	err = s.withTx(ctx, func(q pgx.Tx) error {
		ev, _ := json.Marshal(map[string]any{"review_report_id": id, "index": idx})
		if err := q.QueryRow(ctx, `INSERT INTO account_memory (account_id, kind, scope, text, status, source, evidence, created_by, confirmed_by, confirmed_at)
			VALUES ($1,$2,'all',$3,'active','review',$4,$5,$5,now()) RETURNING id`, accountID, guessMemoryKind(text), text, ev, uid).Scan(&memID); err != nil {
			return err
		}
		_, err := q.Exec(ctx, `UPDATE review_report SET remembered = array_append(remembered, $2) WHERE id=$1`, id, idx)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "memory_confirm", "account_memory", memID.String(), "ok", map[string]any{"source": "review"})
	return ok(w, map[string]any{"memory_id": memID})
}

// ignoreInsight hides one writing insight for good and counts it as a rejected AI output.
func (s *Server) ignoreInsight(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var callID *uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, ai_call_id FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &callID); err != nil {
		return err
	}
	if _, err := s.account(ctx, accountID); err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.WritingInsights) {
		return validation("结论不存在")
	}
	if _, err := s.db.Exec(ctx, `UPDATE review_report SET ignored = array_append(ignored, $2) WHERE id=$1 AND NOT ($2 = ANY(ignored)) AND NOT ($2 = ANY(remembered))`, id, idx); err != nil {
		return err
	}
	if callID != nil {
		reason := "其他"
		note := "忽略写作结论：" + truncate(rc.WritingInsights[idx], 80)
		o := "rejected"
		if err := s.recordFeedback(ctx, *callID, feedbackInput{Outcome: &o, ReasonTags: []string{reason}, Note: &note}); err != nil {
			slog.Warn("记录 AI 反馈失败", "err", err)
		}
	}
	return ok(w, map[string]any{"ok": true})
}

func metricLine(m Metric) string {
	var parts []string
	add := func(label string, v *int) {
		if v != nil {
			parts = append(parts, fmt.Sprintf("%s %d", label, *v))
		}
	}
	if m.Impressions != nil {
		parts = append(parts, fmt.Sprintf("展现 %d", *m.Impressions))
	}
	add("阅读", m.Reads)
	add("点赞", m.Likes)
	add("在看", m.Wows)
	add("收藏", m.Favorites)
	add("评论", m.Comments)
	add("分享", m.Shares)
	add("涨粉", m.FollowsGained)
	if m.CTR != nil {
		parts = append(parts, fmt.Sprintf("CTR %.2f%%", *m.CTR*100))
	}
	if m.Note != "" {
		parts = append(parts, "备注："+m.Note)
	}
	return strings.Join(parts, "，")
}

func (s *Server) listReviews(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, work_ids, content, adopted, remembered, ignored, origin, created_at FROM review_report WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`, a.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []ReviewReport{}
	for rows.Next() {
		var rep ReviewReport
		var content []byte
		if err := rows.Scan(&rep.ID, &rep.WorkIDs, &content, &rep.Adopted, &rep.Remembered, &rep.Ignored, &rep.Origin, &rep.CreatedAt); err != nil {
			return err
		}
		_ = json.Unmarshal(content, &rep.Content)
		if rep.Content.WritingInsights == nil {
			rep.Content.WritingInsights = []string{}
		}
		list = append(list, rep)
	}
	return ok(w, list)
}

// adoptSuggestion moves exactly one suggestion into the topic pool (H-08).
func (s *Server) adoptSuggestion(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	idx := queryIntParam(r, "index")
	ctx := r.Context()
	var accountID uuid.UUID
	var content []byte
	var adopted []int32
	if err := s.db.QueryRow(ctx, `SELECT account_id, content, adopted FROM review_report WHERE id=$1`, id).Scan(&accountID, &content, &adopted); err != nil {
		return err
	}
	a, err := s.account(ctx, accountID)
	if err != nil {
		return err
	}
	var rc ReviewContent
	_ = json.Unmarshal(content, &rc)
	if idx < 0 || idx >= len(rc.TopicSuggestions) {
		return validation("建议不存在")
	}
	for _, x := range adopted {
		if int(x) == idx {
			return stateInvalid("这条建议已经采纳过了")
		}
	}
	sug := rc.TopicSuggestions[idx]
	var topicID uuid.UUID
	err = s.withTx(ctx, func(q pgx.Tx) error {
		if err := q.QueryRow(ctx, `INSERT INTO topic (account_id, title, angle, source, review_report_id) VALUES ($1,$2,$3,'review',$4) RETURNING id`,
			a.ID, truncateRunes(sug.Title, 64), sug.Angle, id).Scan(&topicID); err != nil {
			return err
		}
		_, err := q.Exec(ctx, `UPDATE review_report SET adopted = array_append(adopted, $2) WHERE id=$1`, id, idx)
		return err
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "review_adopt", "topic", topicID.String(), "ok", map[string]any{"report": id.String(), "index": idx})
	var callID *uuid.UUID
	if s.db.QueryRow(ctx, `SELECT ai_call_id FROM review_report WHERE id=$1`, id).Scan(&callID) == nil && callID != nil {
		s.implicitFeedback(ctx, *callID, "accepted", &idx, nil)
	}
	return ok(w, map[string]any{"topic_id": topicID})
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	counts := map[string]int{}
	var countsRaw, limitRaw []byte
	var pendingTopics, todayPush, tokensToday, samples int
	var aiReady, profileReady bool
	err = s.db.QueryRow(ctx, `WITH status_counts AS (
		SELECT status, count(*) AS n FROM work WHERE account_id=$1 AND deleted_at IS NULL GROUP BY status
	) SELECT
		coalesce((SELECT jsonb_object_agg(status,n) FROM status_counts),'{}'::jsonb),
		(SELECT count(*) FROM topic WHERE account_id=$1 AND status='pending' AND deleted_at IS NULL),
		(SELECT count(*) FROM push_record WHERE account_id=$1 AND status='ok' AND created_at >= $3),
		(SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM ai_call WHERE workspace_id=$2 AND created_at >= $3),
		EXISTS(SELECT 1 FROM model_route r JOIN model_provider p ON p.id=r.provider_id
			WHERE r.workspace_id=$2 AND p.workspace_id=$2 AND r.task_type='default' AND p.status='active'),
		(SELECT count(*) FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL),
		EXISTS(SELECT 1 FROM account_profile WHERE account_id=$1 AND
			(cardinality(positioning_tags)>0 OR target_audience<>'' OR persona_tone<>'')),
		coalesce((SELECT value FROM app_setting WHERE workspace_id=$2 AND key='ai_limit'),
			'{"enabled":false,"daily_tokens":2000000}'::jsonb)`, a.ID, ident(ctx).WorkspaceID, s.today()).Scan(
		&countsRaw, &pendingTopics, &todayPush, &tokensToday, &aiReady, &samples, &profileReady, &limitRaw)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(countsRaw, &counts); err != nil {
		return err
	}
	limit := aiLimit{DailyTokens: 2000000}
	_ = json.Unmarshal(limitRaw, &limit)
	type todo struct {
		WorkID uuid.UUID `json:"work_id"`
		Title  string    `json:"title"`
		Status string    `json:"status"`
		Kind   string    `json:"kind"`
		Hint   string    `json:"hint"`
		At     time.Time `json:"at"`
		// D-123：账号类型可迁移，账号下作品类型可能混杂；看板行带作品级类型，前端据此标注（§2.7）。
		Format string `json:"content_format"`
		Node   *int   `json:"node,omitempty"`
	}
	todos := []todo{}
	due := nodeDueExpr(2, 3)
	trows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.status, w.updated_at, w.content_format, `+due+`
		FROM work w WHERE w.account_id=$1 AND w.deleted_at IS NULL AND (w.status <> 'published' OR `+due+` IS NOT NULL)
		ORDER BY w.updated_at DESC LIMIT 30`, a.ID, s.now(), datacubeCovers(a))
	if err != nil {
		return err
	}
	for trows.Next() {
		var t todo
		if err := trows.Scan(&t.WorkID, &t.Title, &t.Status, &t.At, &t.Format, &t.Node); err != nil {
			trows.Close()
			return err
		}
		switch t.Status {
		case "drafting":
			t.Kind, t.Hint = "write", "继续写作"
		case "checking":
			t.Kind, t.Hint = "check", "发布前检查待确认"
		case "ready":
			if a.Platform == "wechat_mp" {
				t.Kind, t.Hint = "push", "已通过检查，可写入草稿箱"
			} else {
				t.Kind, t.Hint = "pack", "已通过检查，可生成发布包"
			}
		case "pushed", "packed":
			t.Kind, t.Hint = "publish", "在平台发布后回来标记已发布"
		case "published":
			if t.Node == nil {
				continue
			}
			t.Kind, t.Hint = "metric", fmt.Sprintf("录入第 %d 天数据", *t.Node)
		}
		todos = append(todos, t)
	}
	trows.Close()
	if err := trows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{
		"account":        a,
		"counts":         counts,
		"todos":          todos,
		"pending_topics": pendingTopics,
		"today_push":     todayPush,
		"daily_limit":    a.DailyPushLimit,
		"tokens_today":   tokensToday,
		"ai_limit":       limit,
		"setup": map[string]bool{
			"ai":         aiReady,
			"profile":    profileReady,
			"samples":    samples > 0,
			"credential": a.Platform != "wechat_mp" || (a.Credential != nil && a.Credential.State == "ok"),
		},
	})
}
