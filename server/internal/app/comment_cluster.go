package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// REF41 I3：读者提问归并与关注点。
// 归一化只做确定性字符处理（全半角、标点、URL、@、前缀、同义词），不调用模型；
// 同一 canonical_key 的提问评论 >=2 条才成簇；样例只输出正文/平台/时间，不输出评论者身份。
const (
	commentClusterMinRunes   = 6
	commentClusterTextMax    = 200
	commentClusterTitleMax   = 100
	commentClusterSampleMax  = 5
	commentClusterListLimit  = 100
	readerTermMinRunes       = 2
	readerTermMaxRunes       = 4
	readerTermTop            = 50
	readerTermSampleMax      = 5
	readerTermWindowMaxDays  = 31
	commentClusterRecalcDays = 90
)

var (
	commentURLRe = regexp.MustCompile(`(?i)(?:https?://|www\.)[^\s]+`)
	commentAtRe  = regexp.MustCompile(`@[^\s]+`)
)

var commentPrefixes = []string{
	"请问一下", "请问", "想问一下", "想问下", "想问", "想请教一下", "想请教", "请教一下", "请教",
	"能不能", "能否", "可以吗", "有没有", "是否可以", "是否",
}

var commentSynonyms = strings.NewReplacer(
	"怎么", "如何",
	"为啥", "为什么",
	"多少钱", "价格",
	"在哪里", "哪里",
	"在哪儿", "哪里",
	"在哪", "哪里",
	"哪儿", "哪里",
)

var commentTrailingParticles = []string{"呢", "吗", "呀", "啊", "吧", "嘛"}

type commentClusterSample struct {
	Content    string    `json:"content"`
	Platform   string    `json:"platform"`
	CapturedAt time.Time `json:"captured_at"`
}

type commentQuestionCluster struct {
	ID             uuid.UUID              `json:"id"`
	QuestionText   string                 `json:"question_text"`
	MentionCount   int                    `json:"mention_count"`
	FirstSeenAt    *time.Time             `json:"first_seen_at"`
	LastSeenAt     *time.Time             `json:"last_seen_at"`
	Status         string                 `json:"status"`
	TopicID        *uuid.UUID             `json:"topic_id"`
	TopicTitle     string                 `json:"topic_title,omitempty"`
	Revision       int                    `json:"revision"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
	SampleComments []commentClusterSample `json:"samples"`
}

type readerTerm struct {
	Term        string `json:"term"`
	DocFreq     int    `json:"doc_freq"`
	WindowStart string `json:"window_start"`
	WindowEnd   string `json:"window_end"`
}

type commentClusterMember struct {
	ID           uuid.UUID
	Content      string
	CapturedAt   time.Time
	CanonicalKey string
}

type readerTermStat struct {
	DocFreq       int
	SampleComment []uuid.UUID
}

// normalizeCommentQuestion 是 I3 的可解释归一化入口：不做语义改写，只把同义写法收敛到同一字符串。
func normalizeCommentQuestion(raw string) string {
	text := strings.ToLower(strings.TrimSpace(raw))
	text = commentURLRe.ReplaceAllString(text, "")
	text = commentAtRe.ReplaceAllString(text, "")
	var b strings.Builder
	for _, r := range text {
		// 全角 ASCII 先折半角，再由下面的字母/数字过滤器统一去标点与 emoji。
		if r >= 0xFF01 && r <= 0xFF5E {
			r -= 0xFEE0
		} else if r == 0x3000 {
			r = ' '
		}
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
		}
	}
	text = b.String()
	for {
		trimmed := false
		for _, prefix := range commentPrefixes {
			if strings.HasPrefix(text, prefix) {
				text = strings.TrimPrefix(text, prefix)
				trimmed = true
			}
		}
		if !trimmed {
			break
		}
	}
	text = commentSynonyms.Replace(text)
	for {
		trimmed := false
		for _, suffix := range commentTrailingParticles {
			if strings.HasSuffix(text, suffix) {
				text = strings.TrimSuffix(text, suffix)
				trimmed = true
			}
		}
		if !trimmed {
			break
		}
	}
	return text
}

func commentCanonicalKey(raw string) string {
	text := normalizeCommentQuestion(raw)
	if len([]rune(text)) < commentClusterMinRunes {
		return ""
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func commentClusterQuestionText(text string) string {
	text = strings.TrimSpace(text)
	if len([]rune(text)) > commentClusterTextMax {
		return truncateRunes(text, commentClusterTextMax)
	}
	return text
}

// commentClusterTopicTitle 复用问题簇正文清理，但按选题标题上限 100 字截断。
func commentClusterTopicTitle(text string) string {
	text = commentClusterQuestionText(text)
	if len([]rune(text)) > commentClusterTitleMax {
		return truncateRunes(text, commentClusterTitleMax)
	}
	return text
}

func (s *Server) commentClusterJob(ctx context.Context) {
	// 每小时一次；启动时先跑一遍，避免新部署等一小时。
	key := "comment-cluster:" + s.now().In(s.loc).Format("2006-01-02T15")
	if !s.markOnce(ctx, key) {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT workspace_id, account_id FROM comment_inbox
		WHERE deleted_at IS NULL AND category='question' AND captured_at > now() - interval '90 days'
		UNION
		SELECT workspace_id, account_id FROM comment_question_cluster`)
	if err != nil {
		slog.Error("读取待归并账号失败", "err", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var workspaceID, accountID uuid.UUID
		if err := rows.Scan(&workspaceID, &accountID); err != nil {
			slog.Error("读取待归并账号失败", "err", err)
			return
		}
		if err := s.rebuildCommentClustersForAccount(ctx, workspaceID, accountID); err != nil {
			slog.Error("问题簇归并失败", "workspace", workspaceID, "account", accountID, "err", err)
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("读取待归并账号失败", "err", err)
	}
}

// rebuildCommentClustersForAccount 重算一个账号的 canonical key 与问题簇计数。
// 软删评论不参与计数；已转选题/已忽略的簇只更新计数，不自动改状态。
// RebuildCommentClustersForAccountID 供定时任务与 ops-e2e 测试服务复用；
// 不是 HTTP 契约，生产入口仍只通过 commentClusterJob 触发。
func (s *Server) RebuildCommentClustersForAccountID(ctx context.Context, accountID uuid.UUID) error {
	var workspaceID uuid.UUID
	if err := s.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, accountID).Scan(&workspaceID); err != nil {
		return err
	}
	return s.rebuildCommentClustersForAccount(ctx, workspaceID, accountID)
}

func (s *Server) rebuildCommentClustersForAccount(ctx context.Context, workspaceID, accountID uuid.UUID) error {
	rows, err := s.db.Query(ctx, `SELECT id, content, captured_at, canonical_key FROM comment_inbox
		WHERE workspace_id=$1 AND account_id=$2 AND deleted_at IS NULL AND category='question'
		AND captured_at > now() - interval '90 days'
		ORDER BY captured_at ASC, id ASC`, workspaceID, accountID)
	if err != nil {
		return err
	}
	members := make(map[string][]commentClusterMember)
	for rows.Next() {
		var m commentClusterMember
		if err := rows.Scan(&m.ID, &m.Content, &m.CapturedAt, &m.CanonicalKey); err != nil {
			rows.Close()
			return err
		}
		key := commentCanonicalKey(m.Content)
		if key != m.CanonicalKey {
			if _, err := s.db.Exec(ctx, `UPDATE comment_inbox SET canonical_key=$3 WHERE id=$1 AND workspace_id=$2`,
				m.ID, workspaceID, key); err != nil {
				rows.Close()
				return err
			}
			m.CanonicalKey = key
		}
		if key != "" {
			members[key] = append(members[key], m)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	// 先清掉不再属于问题评论的簇引用；计数统一从 0 开始，下一段按本次快照回填。
	if _, err := s.db.Exec(ctx, `UPDATE comment_inbox SET cluster_id=NULL
		WHERE workspace_id=$1 AND account_id=$2 AND (category IS DISTINCT FROM 'question' OR deleted_at IS NOT NULL)`,
		workspaceID, accountID); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE comment_question_cluster SET mention_count=0, sample_comment_ids='{}', updated_at=now()
		WHERE workspace_id=$1 AND account_id=$2`, workspaceID, accountID); err != nil {
		return err
	}

	for key, group := range members {
		sort.Slice(group, func(i, j int) bool {
			if group[i].CapturedAt.Equal(group[j].CapturedAt) {
				return group[i].ID.String() < group[j].ID.String()
			}
			return group[i].CapturedAt.Before(group[j].CapturedAt)
		})
		first := group[0].CapturedAt
		last := group[len(group)-1].CapturedAt
		latest := group[len(group)-1]
		samples := make([]uuid.UUID, 0, commentClusterSampleMax)
		for i := len(group) - 1; i >= 0 && len(samples) < commentClusterSampleMax; i-- {
			samples = append(samples, group[i].ID)
		}
		question := commentClusterQuestionText(latest.Content)
		if len(group) < 2 {
			// 已有簇因删除掉到 1 条：保留簇，计数下降；不创建新簇。
			if _, err := s.db.Exec(ctx, `UPDATE comment_question_cluster
				SET mention_count=1, sample_comment_ids=$4, last_seen_at=$5, updated_at=now()
				WHERE workspace_id=$1 AND account_id=$2 AND canonical_key=$3`,
				workspaceID, accountID, key, samples, last); err != nil {
				return err
			}
			continue
		}
		var clusterID uuid.UUID
		if err := s.db.QueryRow(ctx, `INSERT INTO comment_question_cluster
			(workspace_id, account_id, canonical_key, question_text, mention_count, sample_comment_ids, first_seen_at, last_seen_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (account_id, canonical_key) DO UPDATE SET
				question_text=EXCLUDED.question_text,
				mention_count=EXCLUDED.mention_count,
				sample_comment_ids=EXCLUDED.sample_comment_ids,
				first_seen_at=LEAST(comment_question_cluster.first_seen_at, EXCLUDED.first_seen_at),
				last_seen_at=GREATEST(comment_question_cluster.last_seen_at, EXCLUDED.last_seen_at),
				updated_at=now()
			RETURNING id`,
			workspaceID, accountID, key, question, len(group), samples, first, last).Scan(&clusterID); err != nil {
			return err
		}
		if _, err := s.db.Exec(ctx, `UPDATE comment_inbox SET cluster_id=$1
			WHERE workspace_id=$2 AND account_id=$3 AND id = ANY($4::uuid[])`,
			clusterID, workspaceID, accountID, samples); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) readerTermsJob(ctx context.Context) {
	key := "reader-terms:" + s.today().In(s.loc).Format("2006-01-02")
	if !s.markOnce(ctx, key) {
		return
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT workspace_id, account_id FROM comment_inbox
		WHERE deleted_at IS NULL AND category IN ('question','objection')
		AND captured_at > now() - interval '28 days'`)
	if err != nil {
		slog.Error("读取待统计关注点账号失败", "err", err)
		return
	}
	defer rows.Close()
	weekStart := readerWeekStart(s.today().In(s.loc))
	windows := [][2]time.Time{{weekStart.AddDate(0, 0, -7), weekStart.AddDate(0, 0, -1)}, {weekStart, weekStart.AddDate(0, 0, 6)}}
	for rows.Next() {
		var workspaceID, accountID uuid.UUID
		if err := rows.Scan(&workspaceID, &accountID); err != nil {
			slog.Error("读取待统计关注点账号失败", "err", err)
			return
		}
		for _, window := range windows {
			if _, err := s.recomputeReaderTerms(ctx, workspaceID, accountID, window[0], window[1]); err != nil {
				slog.Error("读者关注点统计失败", "workspace", workspaceID, "account", accountID, "err", err)
			}
		}
	}
	if err := rows.Err(); err != nil {
		slog.Error("读取待统计关注点账号失败", "err", err)
	}
}

func readerWeekStart(day time.Time) time.Time {
	day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, day.Location())
	offset := (int(day.Weekday()) + 6) % 7 // Monday=0
	return day.AddDate(0, 0, -offset)
}

func (s *Server) readerWindow(r *http.Request) (time.Time, time.Time, error) {
	fromRaw := strings.TrimSpace(r.URL.Query().Get("from"))
	toRaw := strings.TrimSpace(r.URL.Query().Get("to"))
	if fromRaw == "" && toRaw == "" {
		start := readerWeekStart(s.today().In(s.loc))
		return start, start.AddDate(0, 0, 6), nil
	}
	if fromRaw == "" || toRaw == "" {
		return time.Time{}, time.Time{}, validation("from/to 必须同时提供")
	}
	from, err := time.ParseInLocation("2006-01-02", fromRaw, s.loc)
	if err != nil {
		return time.Time{}, time.Time{}, validation("from 须为 YYYY-MM-DD")
	}
	to, err := time.ParseInLocation("2006-01-02", toRaw, s.loc)
	if err != nil {
		return time.Time{}, time.Time{}, validation("to 须为 YYYY-MM-DD")
	}
	if to.Before(from) {
		return time.Time{}, time.Time{}, validation("to 不能早于 from")
	}
	if to.Sub(from) > readerTermWindowMaxDays*24*time.Hour {
		return time.Time{}, time.Time{}, validation("统计窗口最长 31 天")
	}
	return from, to, nil
}

func (s *Server) recomputeReaderTerms(ctx context.Context, workspaceID, accountID uuid.UUID, from, to time.Time) ([]readerTerm, error) {
	rows, err := s.db.Query(ctx, `SELECT id, content FROM comment_inbox
		WHERE workspace_id=$1 AND account_id=$2 AND deleted_at IS NULL
		AND category IN ('question','objection')
		AND captured_at >= $3 AND captured_at < $4
		ORDER BY captured_at DESC, id DESC`, workspaceID, accountID, from, to.AddDate(0, 0, 1))
	if err != nil {
		return nil, err
	}
	stats := make(map[string]*readerTermStat)
	for rows.Next() {
		var id uuid.UUID
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			rows.Close()
			return nil, err
		}
		seen := make(map[string]bool)
		for _, term := range readerTermNGrams(normalizeCommentQuestion(content)) {
			if seen[term] {
				continue
			}
			seen[term] = true
			stat := stats[term]
			if stat == nil {
				stat = &readerTermStat{}
				stats[term] = stat
			}
			stat.DocFreq++
			if len(stat.SampleComment) < readerTermSampleMax {
				stat.SampleComment = append(stat.SampleComment, id)
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	type ranked struct {
		Term  string
		Stat  *readerTermStat
		Order int
	}
	rankedTerms := make([]ranked, 0, len(stats))
	for term, stat := range stats {
		if stat.DocFreq >= 2 {
			rankedTerms = append(rankedTerms, ranked{Term: term, Stat: stat})
		}
	}
	sort.Slice(rankedTerms, func(i, j int) bool {
		if rankedTerms[i].Stat.DocFreq == rankedTerms[j].Stat.DocFreq {
			return rankedTerms[i].Term < rankedTerms[j].Term
		}
		return rankedTerms[i].Stat.DocFreq > rankedTerms[j].Stat.DocFreq
	})
	if len(rankedTerms) > readerTermTop {
		rankedTerms = rankedTerms[:readerTermTop]
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM reader_term WHERE account_id=$1 AND window_start=$2 AND window_end=$3`,
		accountID, from.Format("2006-01-02"), to.Format("2006-01-02")); err != nil {
		return nil, err
	}
	out := make([]readerTerm, 0, len(rankedTerms))
	for _, item := range rankedTerms {
		if _, err := tx.Exec(ctx, `INSERT INTO reader_term
			(workspace_id, account_id, window_start, window_end, term, doc_freq, sample_comment_ids)
			VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			workspaceID, accountID, from.Format("2006-01-02"), to.Format("2006-01-02"), item.Term, item.Stat.DocFreq, item.Stat.SampleComment); err != nil {
			return nil, err
		}
		out = append(out, readerTerm{Term: item.Term, DocFreq: item.Stat.DocFreq,
			WindowStart: from.Format("2006-01-02"), WindowEnd: to.Format("2006-01-02")})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

var readerStopwords = map[string]bool{
	"什么": true, "为什么": true, "怎么": true, "如何": true, "哪里": true, "这个": true, "那个": true,
	"我们": true, "你们": true, "他们": true, "一下": true, "现在": true, "还是": true, "就是": true,
	"因为": true, "所以": true, "但是": true, "如果": true, "没有": true, "不是": true, "一个": true,
	"这样": true, "然后": true, "以及": true, "进行": true, "需要": true, "觉得": true, "知道": true,
	"问题": true, "请问": true, "想问": true, "可以": true, "能否": true, "是否": true, "有没有": true,
	"多少": true, "时间": true, "时候": true, "老师": true, "朋友": true, "请问一下": true,
}

func readerTermNGrams(text string) []string {
	runes := []rune(text)
	if len(runes) < readerTermMinRunes {
		return nil
	}
	terms := make([]string, 0, len(runes)*3)
	for n := readerTermMinRunes; n <= readerTermMaxRunes; n++ {
		for i := 0; i+n <= len(runes); i++ {
			term := string(runes[i : i+n])
			if readerStopwords[term] || allDigits(term) {
				continue
			}
			terms = append(terms, term)
		}
	}
	return terms
}

func allDigits(text string) bool {
	for _, r := range text {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return text != ""
}

func (s *Server) listReaderTerms(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	from, to, err := s.readerWindow(r)
	if err != nil {
		return err
	}
	items, err := s.recomputeReaderTerms(r.Context(), ident(r.Context()).WorkspaceID, account.ID, from, to)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"items": items, "window_start": from.Format("2006-01-02"), "window_end": to.Format("2006-01-02"),
	})
}

func (s *Server) listCommentClusters(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && status != "open" && status != "converted" && status != "ignored" {
		return validation("status 枚举不正确")
	}
	query := `SELECT c.id, c.question_text, c.mention_count, c.first_seen_at, c.last_seen_at,
		c.status, c.topic_id, COALESCE(t.title,''), c.revision, c.created_at, c.updated_at
		FROM comment_question_cluster c
		LEFT JOIN topic t ON t.id=c.topic_id AND t.deleted_at IS NULL
		WHERE c.account_id=$1 AND c.workspace_id=$2`
	args := []any{account.ID, ident(r.Context()).WorkspaceID}
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(` AND c.status=$%d`, len(args))
	}
	query += ` ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'ignored' THEN 1 ELSE 2 END,
		c.mention_count DESC, c.last_seen_at DESC NULLS LAST, c.id DESC LIMIT ` + fmt.Sprint(commentClusterListLimit)
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	items := []commentQuestionCluster{}
	ids := []uuid.UUID{}
	for rows.Next() {
		var item commentQuestionCluster
		var topicTitle string
		if err := rows.Scan(&item.ID, &item.QuestionText, &item.MentionCount, &item.FirstSeenAt, &item.LastSeenAt,
			&item.Status, &item.TopicID, &topicTitle, &item.Revision, &item.CreatedAt, &item.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		if topicTitle != "" {
			item.TopicTitle = topicTitle
		}
		items = append(items, item)
		ids = append(ids, item.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	byID, err := s.commentClusterSamples(r.Context(), ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].SampleComments = byID[items[i].ID]
		if items[i].SampleComments == nil {
			items[i].SampleComments = []commentClusterSample{}
		}
	}
	return ok(w, map[string]any{"items": items})
}

func (s *Server) commentClusterSamples(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID][]commentClusterSample, error) {
	out := make(map[uuid.UUID][]commentClusterSample)
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT ci.cluster_id, ci.content, p.platform, ci.captured_at
		FROM comment_inbox ci JOIN platform_account p ON p.id=ci.account_id
		WHERE ci.cluster_id = ANY($1::uuid[]) AND ci.deleted_at IS NULL
		ORDER BY ci.cluster_id, ci.captured_at DESC, ci.id DESC`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var clusterID uuid.UUID
		var sample commentClusterSample
		if err := rows.Scan(&clusterID, &sample.Content, &sample.Platform, &sample.CapturedAt); err != nil {
			return nil, err
		}
		if len(out[clusterID]) < commentClusterSampleMax {
			out[clusterID] = append(out[clusterID], sample)
		}
	}
	return out, rows.Err()
}

func (s *Server) loadCommentCluster(ctx context.Context, id uuid.UUID) (commentQuestionCluster, error) {
	var item commentQuestionCluster
	var topicTitle string
	err := s.db.QueryRow(ctx, `SELECT c.id, c.question_text, c.mention_count, c.first_seen_at, c.last_seen_at,
		c.status, c.topic_id, COALESCE(t.title,''), c.revision, c.created_at, c.updated_at
		FROM comment_question_cluster c LEFT JOIN topic t ON t.id=c.topic_id AND t.deleted_at IS NULL
		WHERE c.id=$1 AND c.workspace_id=$2`, id, ident(ctx).WorkspaceID).
		Scan(&item.ID, &item.QuestionText, &item.MentionCount, &item.FirstSeenAt, &item.LastSeenAt,
			&item.Status, &item.TopicID, &topicTitle, &item.Revision, &item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, errNotFound
	}
	if err != nil {
		return item, err
	}
	item.TopicTitle = topicTitle
	byID, err := s.commentClusterSamples(ctx, []uuid.UUID{item.ID})
	if err != nil {
		return item, err
	}
	item.SampleComments = byID[item.ID]
	if item.SampleComments == nil {
		item.SampleComments = []commentClusterSample{}
	}
	return item, nil
}

func (s *Server) ignoreCommentCluster(w http.ResponseWriter, r *http.Request) error {
	return s.setCommentClusterStatus(w, r, "ignored")
}

func (s *Server) reopenCommentCluster(w http.ResponseWriter, r *http.Request) error {
	return s.setCommentClusterStatus(w, r, "open")
}

func (s *Server) setCommentClusterStatus(w http.ResponseWriter, r *http.Request, status string) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	id, err := pathID(r, "clusterId")
	if err != nil {
		return err
	}
	var current string
	err = s.db.QueryRow(r.Context(), `SELECT status FROM comment_question_cluster WHERE id=$1 AND workspace_id=$2`,
		id, ident(r.Context()).WorkspaceID).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if current == "converted" {
		return apiErr(409, "cluster_converted", "该问题簇已转为选题，不能改回原状态")
	}
	if status == "ignored" && current == "ignored" {
		item, err := s.loadCommentCluster(r.Context(), id)
		if err != nil {
			return err
		}
		return ok(w, item)
	}
	if status == "open" && current == "open" {
		item, err := s.loadCommentCluster(r.Context(), id)
		if err != nil {
			return err
		}
		return ok(w, item)
	}
	updated, err := s.db.Exec(r.Context(), `UPDATE comment_question_cluster SET status=$3, revision=revision+1, updated_at=now()
		WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID, status)
	if err != nil {
		return err
	}
	if updated.RowsAffected() == 0 {
		return errNotFound
	}
	item, err := s.loadCommentCluster(r.Context(), id)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "comment_cluster_"+status, "comment_question_cluster", id.String(), "ok", nil)
	return ok(w, item)
}

func (s *Server) convertCommentCluster(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "clusterId")
	if err != nil {
		return err
	}
	var in struct {
		Title string `json:"title"`
		Angle string `json:"angle"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var item commentQuestionCluster
	var topicID *uuid.UUID
	var sampleIDs []uuid.UUID
	var accountID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id, account_id, question_text, mention_count, status, topic_id, sample_comment_ids
		FROM comment_question_cluster WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
		id, ident(ctx).WorkspaceID).Scan(&item.ID, &accountID, &item.QuestionText, &item.MentionCount, &item.Status, &topicID, &sampleIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if item.Status == "converted" {
		if topicID == nil {
			return apiErr(409, "cluster_topic_missing", "问题簇标记已转选题但找不到原选题")
		}
		existing, err := scanTopic(tx.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1 AND t.deleted_at IS NULL`, *topicID))
		if err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		full, err := s.loadCommentCluster(ctx, item.ID)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"topic": existing, "cluster": full, "reused": true})
	}
	if item.Status == "ignored" {
		return apiErr(409, "cluster_ignored", "问题簇已被忽略，请先重新打开")
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = item.QuestionText
	}
	title = commentClusterTopicTitle(title)
	if title == "" {
		return validation("请填写选题标题")
	}
	angle := strings.TrimSpace(in.Angle)
	if angle == "" {
		angle = fmt.Sprintf("来自 %d 条读者提问的共性问题", item.MentionCount)
	}
	var sourceCommentID *uuid.UUID
	if len(sampleIDs) > 0 {
		sourceCommentID = &sampleIDs[0]
	}
	requestKey := "comment-cluster:" + item.ID.String()
	requestHash := cxSHA256([]byte("comment-cluster|" + item.ID.String()))
	var newTopicID uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO topic
		(account_id,title,angle,source,source_comment_id,origin_request_key,origin_request_hash)
		VALUES ($1,$2,$3,'comment',$4,$5,$6) RETURNING id`,
		accountID, title, angle, sourceCommentID, requestKey, requestHash).Scan(&newTopicID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE comment_question_cluster
		SET status='converted', topic_id=$3, revision=revision+1, updated_at=now()
		WHERE id=$1 AND workspace_id=$2`, item.ID, ident(ctx).WorkspaceID, newTopicID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	t, err := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, newTopicID))
	if err != nil {
		return err
	}
	full, err := s.loadCommentCluster(ctx, item.ID)
	if err != nil {
		return err
	}
	s.audit(ctx, "comment_cluster_convert_topic", "comment_question_cluster", item.ID.String(), "ok", map[string]any{"topic_id": newTopicID})
	writeJSON(w, http.StatusCreated, map[string]any{"topic": t, "cluster": full, "reused": false})
	return nil
}
