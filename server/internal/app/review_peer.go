package app

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// REF41 I5：单期同龄对比卡。
//
// 只读：不新建表、不改作品状态、不生成指标。对比范围固定为同一账号、同一平台、
// 同一内容形态、发布时间更早且同一 metric_node 节点有 approved 数据的最近 5 篇。
// 缺失指标保持 null，不用 0 补。

var peerCompareNodes = []int{1, 3, 7, 30}

type peerCompareMetricRow struct {
	Key              string   `json:"key"`
	Label            string   `json:"label"`
	Unit             string   `json:"unit"` // count | percent
	Current          *float64 `json:"current"`
	Median           *float64 `json:"median"`
	Delta            *float64 `json:"delta"`
	DeltaPct         *float64 `json:"delta_pct"`
	CompareLabel     string   `json:"compare_label"`
	SampleSize       int      `json:"sample_size"`
	SampleSufficient bool     `json:"sample_sufficient"`
}

type peerComparePeer struct {
	WorkID      uuid.UUID           `json:"work_id"`
	Title       string              `json:"title"`
	PublishedAt time.Time           `json:"published_at"`
	ActualDay   *int                `json:"actual_day"`
	NodeExact   bool                `json:"node_exact"`
	Values      map[string]*float64 `json:"values"`
}

type peerCompareCard struct {
	WorkID           uuid.UUID              `json:"work_id"`
	AccountID        uuid.UUID              `json:"account_id"`
	Title            string                 `json:"title"`
	AccountName      string                 `json:"account_name"`
	Platform         string                 `json:"platform"`
	Node             int                    `json:"node"`
	NodeExact        bool                   `json:"node_exact"`
	PublishedAt      *time.Time             `json:"published_at"`
	SampleSize       int                    `json:"sample_size"`
	SampleSufficient bool                   `json:"sample_sufficient"`
	Metrics          []peerCompareMetricRow `json:"metrics"`
	Peers            []peerComparePeer      `json:"peers"`
	Notice           string                 `json:"notice"`
	Limitations      []string               `json:"limitations"`
}

type peerCompareAll struct {
	WorkID uuid.UUID         `json:"work_id"`
	Nodes  []peerCompareCard `json:"nodes"`
}

var peerCompareMetricSpecs = []struct {
	key, label, unit string
}{
	{"reads", "阅读", "count"},
	{"impressions", "曝光", "count"},
	{"interaction_rate", "互动率", "percent"},
	{"follows_gained", "涨粉", "count"},
}

var peerCompareLimitations = []string{
	"只对比同一账号、同一平台、同一内容形态、发布时间更早且该节点有 approved 数据的最近 5 篇。",
	"互动率 =（点赞 + 在看 + 收藏 + 评论 + 分享）/ 阅读 × 100%；阅读缺失或为 0 时为空。",
	"中位数按同批作品逐项去除 NULL 后计算；缺失指标不补 0，也不参与中位数。",
	"当前指标结构没有完读/观看完成率字段，该维度不展示，不用 0 冒充。",
}

// peerWorkScope 是卡片需要的作品/账号元信息；API 从 workMeta 组装，job 从候选查询组装。
type peerWorkScope struct {
	WorkID        uuid.UUID
	AccountID     uuid.UUID
	WorkspaceID   uuid.UUID
	Title         string
	AccountName   string
	Platform      string
	ContentFormat string
	PublishedAt   *time.Time
}

// metricNodeForDay 与 SQL metric_node 保持一致：1/3/7/30 是累计节点，不是精确日。
func metricNodeForDay(day int) int {
	switch {
	case day < 1:
		return 0
	case day < 3:
		return 1
	case day < 6:
		return 3
	case day < 30:
		return 7
	default:
		return 30
	}
}

func metricNodeMatches(day *int, node int) bool {
	return day != nil && metricNodeForDay(*day) == node
}

func peerMetricValues(m *Metric) map[string]*float64 {
	out := map[string]*float64{}
	if m == nil {
		return out
	}
	if m.Reads != nil {
		v := float64(*m.Reads)
		out["reads"] = &v
	}
	if m.Impressions != nil {
		v := float64(*m.Impressions)
		out["impressions"] = &v
	}
	if m.FollowsGained != nil {
		v := float64(*m.FollowsGained)
		out["follows_gained"] = &v
	}
	if m.Reads != nil && *m.Reads > 0 {
		interactions := 0
		has := false
		for _, p := range []*int{m.Likes, m.Wows, m.Favorites, m.Comments, m.Shares} {
			if p != nil {
				interactions += *p
				has = true
			}
		}
		if has {
			v := float64(interactions) / float64(*m.Reads) * 100
			out["interaction_rate"] = &v
		}
	}
	return out
}

func metricHasAnyValue(m *Metric) bool {
	return m != nil && (m.Reads != nil || m.Impressions != nil || m.Likes != nil || m.Wows != nil ||
		m.Favorites != nil || m.Comments != nil || m.Shares != nil || m.FollowsGained != nil)
}

func medianOf(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	mid := len(values) / 2
	var v float64
	if len(values)%2 == 0 {
		v = (values[mid-1] + values[mid]) / 2
	} else {
		v = values[mid]
	}
	return &v
}

func peerCompareLabel(current, median *float64, unit string, sample int) string {
	if current == nil {
		return "该节点未采集"
	}
	if sample < 3 {
		return "样本不足，仅供参考"
	}
	if median == nil {
		return "无同节点样本"
	}
	d := *current - *median
	if unit == "percent" {
		if math.Abs(d) < 0.05 {
			return "与中位数持平"
		}
		if d > 0 {
			return fmt.Sprintf("高 %.1f 个百分点", d)
		}
		return fmt.Sprintf("低 %.1f 个百分点", -d)
	}
	if math.Abs(*median) < 1e-9 {
		if math.Abs(d) < 1e-9 {
			return "与中位数持平"
		}
		return "中位数为 0"
	}
	pct := d / math.Abs(*median) * 100
	if math.Abs(pct) < 0.05 {
		return "与中位数持平"
	}
	if pct > 0 {
		return fmt.Sprintf("高于中位数 %.1f%%", pct)
	}
	return fmt.Sprintf("低于中位数 %.1f%%", -pct)
}

// metricAtNode 选取该 work 在目标节点最高优先级的 approved 记录。
// 节点映射按 metric_node(day_offset)，因此第 6 天可以进入第 7 天节点并标 node_exact=false。
func (s *Server) metricAtNode(ctx context.Context, workID uuid.UUID, node int) (*Metric, error) {
	row := s.db.QueryRow(ctx, `SELECT `+prefixCols(metricCols, "m.")+`
		FROM metric_snapshot m
		WHERE m.work_id=$1 AND m.quality_state='approved' AND metric_source_supported(m.source)
		  AND metric_node(m.day_offset)=$2
		ORDER BY CASE WHEN m.day_offset=$2 THEN 0 ELSE 1 END, abs(m.day_offset-$2),
		  metric_source_rank(m.source), m.captured_at DESC
		LIMIT 1`, workID, node)
	m, err := scanMetric(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Server) peerWorks(ctx context.Context, scope peerWorkScope, node int) ([]peerComparePeer, error) {
	if scope.PublishedAt == nil {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.published_at
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE w.account_id=$1 AND a.platform=$2 AND w.content_format=$3
		  AND w.deleted_at IS NULL AND w.published_at IS NOT NULL
		  AND w.published_at < $4 AND w.id <> $5
		  AND EXISTS (
		    SELECT 1 FROM metric_snapshot m
		    WHERE m.work_id=w.id AND m.quality_state='approved' AND metric_source_supported(m.source)
		      AND metric_node(m.day_offset)=$6
		      AND (m.reads IS NOT NULL OR m.impressions IS NOT NULL OR m.likes IS NOT NULL
		        OR m.wows IS NOT NULL OR m.favorites IS NOT NULL OR m.comments IS NOT NULL
		        OR m.shares IS NOT NULL OR m.follows_gained IS NOT NULL)
		  )
		ORDER BY w.published_at DESC, w.id DESC
		LIMIT 5`, scope.AccountID, scope.Platform, scope.ContentFormat, *scope.PublishedAt, scope.WorkID, node)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []peerComparePeer{}
	for rows.Next() {
		var p peerComparePeer
		if err := rows.Scan(&p.WorkID, &p.Title, &p.PublishedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		m, err := s.metricAtNode(ctx, out[i].WorkID, node)
		if err != nil {
			return nil, err
		}
		out[i].Values = peerMetricValues(m)
		if m != nil && m.DayOffset != nil {
			day := *m.DayOffset
			out[i].ActualDay = &day
			out[i].NodeExact = day == node
		}
	}
	return out, nil
}

func (s *Server) buildPeerCompare(ctx context.Context, scope peerWorkScope, node int) (peerCompareCard, error) {
	card := peerCompareCard{
		WorkID: scope.WorkID, AccountID: scope.AccountID, Title: scope.Title, AccountName: scope.AccountName,
		Platform: scope.Platform, Node: node, PublishedAt: scope.PublishedAt,
		Metrics: []peerCompareMetricRow{}, Peers: []peerComparePeer{},
		Limitations: append([]string(nil), peerCompareLimitations...),
	}
	peers, err := s.peerWorks(ctx, scope, node)
	if err != nil {
		return card, err
	}
	card.Peers = peers
	card.SampleSize = len(peers)
	card.SampleSufficient = len(peers) >= 3

	var current *Metric
	if scope.PublishedAt != nil {
		current, err = s.metricAtNode(ctx, scope.WorkID, node)
		if err != nil {
			return card, err
		}
	}
	if current != nil && current.DayOffset != nil {
		card.NodeExact = *current.DayOffset == node
	}
	currentValues := peerMetricValues(current)

	for _, spec := range peerCompareMetricSpecs {
		row := peerCompareMetricRow{Key: spec.key, Label: spec.label, Unit: spec.unit, Current: currentValues[spec.key]}
		var vals []float64
		for _, p := range peers {
			if v := p.Values[spec.key]; v != nil {
				vals = append(vals, *v)
			}
		}
		row.SampleSize = len(vals)
		row.SampleSufficient = len(vals) >= 3
		row.Median = medianOf(vals)
		if row.Current != nil && row.Median != nil {
			d := *row.Current - *row.Median
			row.Delta = &d
			if math.Abs(*row.Median) > 1e-9 {
				p := d / math.Abs(*row.Median) * 100
				row.DeltaPct = &p
			}
		}
		row.CompareLabel = peerCompareLabel(row.Current, row.Median, row.Unit, row.SampleSize)
		card.Metrics = append(card.Metrics, row)
	}

	switch {
	case scope.PublishedAt == nil:
		card.Notice = "发布时间缺失，无法做同龄对比；不会猜日龄或排期。"
	case current == nil:
		card.Notice = fmt.Sprintf("第 %d 天节点未采集，不用 0 补；可以先录入这一天的数据。", node)
	case current.DayOffset != nil && *current.DayOffset != node:
		card.Notice = fmt.Sprintf("非精确节点：本篇取第 %d 天记录进入第 %d 天节点。", *current.DayOffset, node)
	case len(peers) == 0:
		card.Notice = "同账号同平台同形态没有更早的同节点作品，先积累样本。"
	case len(peers) < 3:
		card.Notice = "样本不足 3 篇，中位数仅供横向参考，不作为结论。"
	}
	return card, nil
}

func (s *Server) peerCompare(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var publishedAt *time.Time
	if err := s.db.QueryRow(r.Context(), `SELECT published_at FROM work WHERE id=$1`, m.ID).Scan(&publishedAt); err != nil {
		return err
	}
	scope := peerWorkScope{
		WorkID: m.ID, AccountID: m.Account.ID,
		Title: m.Title, AccountName: m.Account.Name, Platform: m.Account.Platform,
		ContentFormat: m.ContentFormat, PublishedAt: publishedAt,
	}
	rawNode := strings.TrimSpace(r.URL.Query().Get("node"))
	if rawNode == "" {
		cards := make([]peerCompareCard, 0, len(peerCompareNodes))
		for _, node := range peerCompareNodes {
			card, err := s.buildPeerCompare(r.Context(), scope, node)
			if err != nil {
				return err
			}
			cards = append(cards, card)
		}
		return ok(w, peerCompareAll{WorkID: m.ID, Nodes: cards})
	}
	node, err := strconv.Atoi(rawNode)
	if err != nil || !containsInt(peerCompareNodes, node) {
		return validation("node 只能是 1、3、7、30")
	}
	card, err := s.buildPeerCompare(r.Context(), scope, node)
	if err != nil {
		return err
	}
	return ok(w, card)
}

func containsInt(items []int, want int) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func formatPeerValue(unit string, v float64) string {
	if unit == "percent" {
		return fmt.Sprintf("%.1f%%", v)
	}
	return fmt.Sprintf("%.0f", v)
}

func peerCompareNotificationBody(card peerCompareCard) string {
	parts := []string{}
	for _, m := range card.Metrics {
		if m.Current == nil {
			continue
		}
		median := "未采集"
		if m.Median != nil {
			median = formatPeerValue(m.Unit, *m.Median)
		}
		parts = append(parts, fmt.Sprintf("%s %s（同批中位数 %s，%s）", m.Label,
			formatPeerValue(m.Unit, *m.Current), median, m.CompareLabel))
	}
	if len(parts) == 0 {
		parts = append(parts, "当前节点指标未采集")
	}
	if card.SampleSize < 3 {
		parts = append(parts, fmt.Sprintf("样本 %d 篇，样本不足，仅供参考", card.SampleSize))
	} else {
		parts = append(parts, fmt.Sprintf("样本 %d 篇", card.SampleSize))
	}
	return strings.Join(parts, "；")
}

// reviewPeerJob 每日 9 点后按 1/3/7/30 天节点生成提醒；job_marker 与通知 dedupe_key 双幂等。
// 卡片本身是实时计算，不落表；job 只负责在节点到达且数据存在时发一次通知。
func (s *Server) reviewPeerJob(ctx context.Context) {
	if s.now().In(s.loc).Hour() < 9 {
		return
	}
	today := s.today()
	rows, err := s.db.Query(ctx, `SELECT w.id, w.title, w.account_id, a.workspace_id, a.name, a.platform,
		w.content_format, w.published_at
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE a.status='active' AND w.deleted_at IS NULL AND w.published_at IS NOT NULL
		  AND w.published_at < $1 AND w.published_at >= $1::timestamptz - interval '31 days'
		  AND EXISTS (
		    SELECT 1 FROM metric_snapshot m
		    WHERE m.work_id=w.id AND m.quality_state='approved' AND metric_source_supported(m.source)
		      AND metric_node(m.day_offset) IN (1,3,7,30)
		      AND (m.reads IS NOT NULL OR m.impressions IS NOT NULL OR m.likes IS NOT NULL
		        OR m.wows IS NOT NULL OR m.favorites IS NOT NULL OR m.comments IS NOT NULL
		        OR m.shares IS NOT NULL OR m.follows_gained IS NOT NULL)
		  )
		ORDER BY w.published_at DESC`, s.now())
	if err != nil {
		return
	}
	type candidate struct {
		scope peerWorkScope
	}
	var list []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.scope.WorkID, &c.scope.Title, &c.scope.AccountID,
			&c.scope.WorkspaceID, &c.scope.AccountName, &c.scope.Platform, &c.scope.ContentFormat,
			&c.scope.PublishedAt); err == nil {
			list = append(list, c)
		}
	}
	rows.Close()
	for _, c := range list {
		if c.scope.PublishedAt == nil {
			continue
		}
		pub := c.scope.PublishedAt.In(s.loc)
		pubDay := time.Date(pub.Year(), pub.Month(), pub.Day(), 0, 0, 0, 0, s.loc)
		age := int(today.Sub(pubDay).Hours() / 24)
		if !containsInt(peerCompareNodes, age) {
			continue
		}
		marker := fmt.Sprintf("peer:%s:%d", c.scope.WorkID, age)
		var done bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM job_marker WHERE key=$1)`, marker).Scan(&done); err != nil || done {
			continue
		}
		// 只有到达节点且该节点有 approved 数据才生成，不用其他节点的数据冒充。
		atNode, err := s.metricAtNode(ctx, c.scope.WorkID, age)
		if err != nil || atNode == nil {
			continue
		}
		card, err := s.buildPeerCompare(ctx, c.scope, age)
		if err != nil {
			continue
		}
		link := fmt.Sprintf("/a/%s/review?work=%s&node=%d", c.scope.AccountID, c.scope.WorkID, age)
		s.notifyWorkspace(ctx, c.scope.WorkspaceID, []string{"owner", "editor"}, "review_peer",
			fmt.Sprintf("《%s》第 %d 天同龄对比", c.scope.Title, age), peerCompareNotificationBody(card), link, marker)
		s.markOnce(ctx, marker)
	}
}
