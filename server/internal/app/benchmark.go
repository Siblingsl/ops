package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-CX12 / FR-CX-18：对标账号库与笔记拆解库。
// 库归我方 account_id；platform 是对标对象的来源平台，不代表我方账号身份。
// 四问 fit_score 是投影：每问 yes=25/no=0、必须理由、unknown 不算 no；
// answered_count<4 时 fit_score 必须为 NULL，不得伪精确。
// 删除本期用 archive 替代；额度 50 targets / 每 target 30 notes，超限 409 benchmark_limit。
const (
	benchmarkTargetLimit = 50
	benchmarkNoteLimit   = 30
)

var benchmarkPlatforms = map[string]bool{"wechat_mp": true, "xhs": true, "toutiao": true}

var benchmarkAnswerKeys = []string{"sustainable", "beyond_single", "audience_match", "material_support"}

type benchmarkAnswer struct {
	Answer string `json:"answer"`
	Reason string `json:"reason"`
}

type benchmarkAnswers map[string]benchmarkAnswer

type benchmarkTarget struct {
	ID                 uuid.UUID  `json:"id"`
	AccountID          uuid.UUID  `json:"account_id"`
	Platform           string     `json:"platform"`
	Name               string     `json:"name"`
	URL                string     `json:"url"`
	NormalizedURL      string     `json:"normalized_url"`
	Positioning        string     `json:"positioning"`
	FollowerBand       string     `json:"follower_band"`
	Entry              *string    `json:"entry"`
	Answers            benchmarkAnswers `json:"answers"`
	FitScore           *int       `json:"fit_score"`
	AnsweredCount      int        `json:"answered_count"`
	WeakFit            bool       `json:"weak_fit"`
	Status             string     `json:"status"`
	Revision           int        `json:"revision"`
	MigrationSourceKey *string    `json:"migration_source_key,omitempty"`
	ArchivedAt         *time.Time `json:"archived_at"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

type benchmarkNote struct {
	ID              uuid.UUID      `json:"id"`
	TargetID        uuid.UUID      `json:"target_id"`
	URL             string         `json:"url"`
	NormalizedURL   string         `json:"normalized_url"`
	Title           string         `json:"title"`
	Structure       map[string]any `json:"structure"`
	StructureHash   string         `json:"structure_hash"`
	MetricsSnapshot map[string]any `json:"metrics_snapshot"`
	Takeaways       []string       `json:"takeaways"`
	NotBorrowable   []string       `json:"not_borrowable"`
	CapturedAt      *time.Time     `json:"captured_at"`
	Revision        int            `json:"revision"`
	AICallID        *uuid.UUID     `json:"ai_call_id,omitempty"`
	ArchivedAt      *time.Time     `json:"archived_at"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
}

// normalizeBenchmarkURL 按 FR-CX-18：仅去 fragment、标准 scheme/host、去默认端口；
// 不去掉可能识别内容的查询参数，不访问 URL。非 http/https 或无 host 返回空串。
func normalizeBenchmarkURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	// scheme/host 不区分大小写；统一小写后端口判断与查重才稳定。
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	if (parsed.Scheme == "http" && parsed.Port() == "80") || (parsed.Scheme == "https" && parsed.Port() == "443") {
		parsed.Host = parsed.Hostname()
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String()
}

// decodeBenchmarkAnswers 校验四问：yes/no 必须带 1..500 码点理由；unknown 不算 no。
// answered_count<4 时 fit_score 为 NULL（不伪精确），>=4 时 yes=25/no=0 求和。
func decodeBenchmarkAnswers(raw benchmarkAnswers) (benchmarkAnswers, *int, error) {
	if len(raw) == 0 {
		return benchmarkAnswers{}, nil, nil
	}
	clean := benchmarkAnswers{}
	for _, key := range benchmarkAnswerKeys {
		answer, present := raw[key]
		if !present {
			continue
		}
		if answer.Answer != "yes" && answer.Answer != "no" && answer.Answer != "unknown" {
			return nil, nil, validation("四问答案只能是 yes/no/unknown")
		}
		if answer.Answer == "unknown" {
			clean[key] = benchmarkAnswer{Answer: "unknown", Reason: answer.Reason}
			continue
		}
		reason := strings.TrimSpace(answer.Reason)
		if len([]rune(reason)) < 1 || len([]rune(reason)) > 500 {
			return nil, nil, validation("四问每项 yes/no 都必须给出 1..500 码点的理由；unknown 不算 no")
		}
		clean[key] = benchmarkAnswer{Answer: answer.Answer, Reason: reason}
	}
	if len(clean) == 0 {
		return benchmarkAnswers{}, nil, nil
	}
	answered, score := 0, 0
	for _, key := range benchmarkAnswerKeys {
		answer, present := clean[key]
		if !present || answer.Answer == "unknown" {
			continue
		}
		answered++
		if answer.Answer == "yes" {
			score += 25
		}
	}
	if answered < 4 {
		return clean, nil, nil
	}
	return clean, &score, nil
}

func benchmarkAnsweredCount(answers benchmarkAnswers) int {
	count := 0
	for _, key := range benchmarkAnswerKeys {
		if answer, present := answers[key]; present && answer.Answer != "unknown" {
			count++
		}
	}
	return count
}

const benchmarkTargetCols = `id,account_id,platform,name,url,normalized_url,positioning,follower_band,entry,answers,fit_score,status,revision,migration_source_key,archived_at,created_at,updated_at`

func scanBenchmarkTarget(row pgx.Row) (benchmarkTarget, error) {
	var item benchmarkTarget
	var answers []byte
	var entry *string
	var migrationKey *string
	if err := row.Scan(&item.ID, &item.AccountID, &item.Platform, &item.Name, &item.URL, &item.NormalizedURL,
		&item.Positioning, &item.FollowerBand, &entry, &answers, &item.FitScore, &item.Status, &item.Revision,
		&migrationKey, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.Entry = entry
	item.MigrationSourceKey = migrationKey
	if len(answers) > 0 {
		if err := json.Unmarshal(answers, &item.Answers); err != nil {
			return item, err
		}
	}
	if item.Answers == nil {
		item.Answers = benchmarkAnswers{}
	}
	item.AnsweredCount = benchmarkAnsweredCount(item.Answers)
	if item.FitScore != nil && item.AnsweredCount == 4 {
		item.WeakFit = *item.FitScore <= 50
	}
	return item, nil
}

// lockBenchmarkAccount 锁定账号行串行化额度与 URL 查重（24 文档 8.3：不以查询后插入代替串行保护）。
func lockBenchmarkAccount(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	var workspaceID uuid.UUID
	return tx.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1 FOR UPDATE`, accountID).Scan(&workspaceID)
}

func (s *Server) listBenchmarks(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	status := strings.TrimSpace(r.URL.Query().Get("status"))
	if status != "" && status != "candidate" && status != "active" && status != "dropped" {
		return validation("status 过滤只接受 candidate/active/dropped")
	}
	cursor := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		cursor, err = strconv.Atoi(raw)
		if err != nil || cursor < 1 {
			return validation("分页 cursor 格式不正确")
		}
	}
	args := []any{account.ID, benchmarkTargetLimit + 1}
	query := `SELECT ` + benchmarkTargetCols + ` FROM benchmark_target WHERE account_id=$1 AND archived_at IS NULL`
	if status != "" {
		query += ` AND status=$3`
		args = append(args, status)
	}
	query += ` ORDER BY fit_score DESC NULLS LAST, id LIMIT $2`
	if cursor > 0 {
		query += ` OFFSET ` + strconv.Itoa(cursor)
	}
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []benchmarkTarget{}
	for rows.Next() {
		item, scanErr := scanBenchmarkTarget(rows)
		if scanErr != nil {
			return scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	nextCursor := 0
	if len(items) > benchmarkTargetLimit {
		items = items[:benchmarkTargetLimit]
		nextCursor = cursor + benchmarkTargetLimit
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func (s *Server) createBenchmark(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Platform     string  `json:"platform"`
		Name         string  `json:"name"`
		URL          string  `json:"url"`
		Positioning  string  `json:"positioning"`
		FollowerBand string  `json:"follower_band"`
		Entry        *string `json:"entry"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if !benchmarkPlatforms[in.Platform] {
		return validation("platform 只接受 wechat_mp/xhs/toutiao")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len([]rune(name)) > 100 {
		return validation("名称须为 1..100 码点")
	}
	rawURL := strings.TrimSpace(in.URL)
	normalized := normalizeBenchmarkURL(rawURL)
	if rawURL != "" && normalized == "" {
		return validation("URL 需要带 http/https 的有效地址；仅记录来源，不访问 URL")
	}
	if err := validateBenchmarkBandAndEntry(in.FollowerBand, in.Entry); err != nil {
		return err
	}
	if len([]rune(in.Positioning)) > 500 {
		return validation("positioning 最多 500 码点")
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockBenchmarkAccount(ctx, tx, account.ID); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM benchmark_target WHERE account_id=$1 AND archived_at IS NULL`, account.ID).Scan(&count); err != nil {
		return err
	}
	if count >= benchmarkTargetLimit {
		return apiErr(409, "benchmark_limit", "未归档对标账号已达 50 个上限，请先逐项归档")
	}
	if normalized != "" {
		var duplicate bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM benchmark_target WHERE account_id=$1 AND platform=$2 AND normalized_url=$3)`,
			account.ID, in.Platform, normalized).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return apiErr(409, "benchmark_exists", "同账号同平台已存在该 URL 的对标账号")
		}
	}
	followerBand := in.FollowerBand
	if followerBand == "" {
		followerBand = "unknown"
	}
	var entry *string
	if in.Entry != nil && *in.Entry != "" {
		entry = in.Entry
	}
	item := benchmarkTarget{
		Platform: in.Platform, Name: name, URL: rawURL, NormalizedURL: normalized, Positioning: in.Positioning,
		FollowerBand: followerBand, Entry: entry, Answers: benchmarkAnswers{}, Status: "candidate", Revision: 1,
	}
	err = tx.QueryRow(ctx, `INSERT INTO benchmark_target(workspace_id,account_id,platform,name,url,normalized_url,positioning,follower_band,entry,answers,fit_score,status,revision)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,NULL,'candidate',1)
		RETURNING `+benchmarkTargetCols,
		ident(ctx).WorkspaceID, account.ID, item.Platform, item.Name, item.URL, item.NormalizedURL,
		item.Positioning, item.FollowerBand, item.Entry).Scan(&item.ID, &item.AccountID, &item.Platform, &item.Name,
		&item.URL, &item.NormalizedURL, &item.Positioning, &item.FollowerBand, &item.Entry, &dummyBytes,
		&item.FitScore, &item.Status, &item.Revision, &item.MigrationSourceKey, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "benchmark_target_create", "benchmark_target", item.ID.String(), "ok", map[string]any{"account_id": account.ID})
	writeJSON(w, http.StatusCreated, item)
	return nil
}

var dummyBytes []byte

func validateBenchmarkBandAndEntry(band string, entry *string) error {
	if band != "" && band != "unknown" && band != "<1k" && band != "1k-1w" && band != "1w-10w" && band != "10w+" {
		return validation("follower_band 枚举不正确")
	}
	if entry != nil && *entry != "" && *entry != "search" && *entry != "recommend" && *entry != "topic" && *entry != "tool" {
		return validation("entry 枚举不正确")
	}
	return nil
}

func (s *Server) getBenchmark(w http.ResponseWriter, r *http.Request) error {
	target, err := s.benchmarkTargetFromPath(r)
	if err != nil {
		return err
	}
	return ok(w, target)
}

func (s *Server) benchmarkTargetFromPath(r *http.Request) (benchmarkTarget, error) {
	id, err := pathID(r, "benchmarkId")
	if err != nil {
		return benchmarkTarget{}, err
	}
	row := s.db.QueryRow(r.Context(), `SELECT `+benchmarkTargetCols+` FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID)
	item, err := scanBenchmarkTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return benchmarkTarget{}, errNotFound
	}
	return item, err
}

func (s *Server) updateBenchmark(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	existing, err := s.benchmarkTargetFromPath(r)
	if err != nil {
		return err
	}
	if existing.ArchivedAt != nil {
		return apiErr(409, "benchmark_archived", "已归档的对标账号只能先恢复再编辑")
	}
	var in struct {
		BaseRevision int               `json:"base_revision"`
		Name         *string           `json:"name"`
		URL          *string           `json:"url"`
		Positioning  *string           `json:"positioning"`
		FollowerBand *string           `json:"follower_band"`
		Entry        *string           `json:"entry"`
		Answers      *benchmarkAnswers `json:"answers"`
		Status       *string           `json:"status"`
		Archived     *bool             `json:"archived"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision < 1 || in.BaseRevision != existing.Revision {
		return apiErr(409, "version_conflict", "对标账号已被他人修改，请刷新后重试")
	}
	name := existing.Name
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
		if name == "" || len([]rune(name)) > 100 {
			return validation("名称须为 1..100 码点")
		}
	}
	url := existing.URL
	normalized := existing.NormalizedURL
	if in.URL != nil {
		url = strings.TrimSpace(*in.URL)
		normalized = normalizeBenchmarkURL(url)
		if url != "" && normalized == "" {
			return validation("URL 需要带 http/https 的有效地址")
		}
	}
	positioning := existing.Positioning
	if in.Positioning != nil {
		positioning = strings.TrimSpace(*in.Positioning)
		if len([]rune(positioning)) > 500 {
			return validation("positioning 最多 500 码点")
		}
	}
	followerBand := existing.FollowerBand
	if in.FollowerBand != nil {
		followerBand = *in.FollowerBand
	}
	entry := existing.Entry
	if in.Entry != nil {
		if *in.Entry == "" {
			entry = nil
		} else {
			entry = in.Entry
		}
	}
	if err := validateBenchmarkBandAndEntry(followerBand, entry); err != nil {
		return err
	}
	answers, fitScore := existing.Answers, existing.FitScore
	if in.Answers != nil {
		merged := benchmarkAnswers{}
		for _, key := range benchmarkAnswerKeys {
			if answer, present := existing.Answers[key]; present {
				merged[key] = answer
			}
		}
		for key, answer := range *in.Answers {
			known := false
			for _, candidate := range benchmarkAnswerKeys {
				if key == candidate {
					known = true
					break
				}
			}
			if !known {
				return validation("四问键名只能是 sustainable/beyond_single/audience_match/material_support")
			}
			merged[key] = answer
		}
		clean, score, err := decodeBenchmarkAnswers(merged)
		if err != nil {
			return err
		}
		answers, fitScore = clean, score
	}
	status := existing.Status
	if in.Status != nil {
		if *in.Status != "candidate" && *in.Status != "active" && *in.Status != "dropped" {
			return validation("status 只接受 candidate/active/dropped")
		}
		status = *in.Status
	}
	archived := existing.ArchivedAt != nil
	if in.Archived != nil {
		archived = *in.Archived
	}
	var archivedAt *time.Time
	if archived {
		now := time.Now()
		archivedAt = &now
	}
	answersJSON, err := json.Marshal(answers)
	if err != nil {
		return err
	}
	// URL 修改后重新查重（排除自身）。
	if in.URL != nil && normalized != "" {
		var duplicate bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM benchmark_target WHERE account_id=$1 AND platform=$2 AND normalized_url=$3 AND id<>$4)`,
			existing.AccountID, existing.Platform, normalized, existing.ID).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return apiErr(409, "benchmark_exists", "同账号同平台已存在该 URL 的对标账号")
		}
	}
	updated, err := scanBenchmarkTarget(s.db.QueryRow(ctx, `UPDATE benchmark_target SET name=$3,url=$4,normalized_url=$5,positioning=$6,follower_band=$7,entry=$8,answers=$9::jsonb,fit_score=$10,status=$11,archived_at=$12,
		revision=revision+1,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$13
		RETURNING `+benchmarkTargetCols,
		existing.ID, ident(ctx).WorkspaceID, name, url, normalized, positioning, followerBand, entry, string(answersJSON), fitScore, status, archivedAt, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "对标账号已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "benchmark_target_update", "benchmark_target", existing.ID.String(), "ok", nil)
	return ok(w, updated)
}

const benchmarkNoteCols = `id,target_id,url,normalized_url,title,structure,structure_hash,metrics_snapshot,takeaways,not_borrowable,captured_at,revision,ai_call_id,archived_at,created_at,updated_at`

func scanBenchmarkNote(row pgx.Row) (benchmarkNote, error) {
	var item benchmarkNote
	var structure, metrics, takeaways, notBorrowable []byte
	if err := row.Scan(&item.ID, &item.TargetID, &item.URL, &item.NormalizedURL, &item.Title, &structure,
		&item.StructureHash, &metrics, &takeaways, &notBorrowable, &item.CapturedAt, &item.Revision,
		&item.AICallID, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	for _, pair := range []struct{ raw any; dest *map[string]any }{
		{structure, &item.Structure}, {metrics, &item.MetricsSnapshot},
	} {
		if len(pair.raw.([]byte)) > 0 {
			if err := json.Unmarshal(pair.raw.([]byte), pair.dest); err != nil {
				return item, err
			}
		}
	}
	if len(takeaways) > 0 {
		if err := json.Unmarshal(takeaways, &item.Takeaways); err != nil {
			return item, err
		}
	}
	if len(notBorrowable) > 0 {
		if err := json.Unmarshal(notBorrowable, &item.NotBorrowable); err != nil {
			return item, err
		}
	}
	return item, nil
}

func (s *Server) loadBenchmarkTarget(ctx context.Context, targetID uuid.UUID) (benchmarkTarget, error) {
	row := s.db.QueryRow(ctx, `SELECT `+benchmarkTargetCols+` FROM benchmark_target
		WHERE id=$1 AND workspace_id=$2`, targetID, ident(ctx).WorkspaceID)
	item, err := scanBenchmarkTarget(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return benchmarkTarget{}, errNotFound
	}
	return item, err
}

func (s *Server) listBenchmarkNotes(w http.ResponseWriter, r *http.Request) error {
	target, err := s.benchmarkTargetFromPath(r)
	if err != nil {
		return err
	}
	cursor := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		cursor, err = strconv.Atoi(raw)
		if err != nil || cursor < 1 {
			return validation("分页 cursor 格式不正确")
		}
	}
	rows, err := s.db.Query(r.Context(), `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE target_id=$1 AND archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
		target.ID, benchmarkNoteLimit+1, cursor)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []benchmarkNote{}
	for rows.Next() {
		item, scanErr := scanBenchmarkNote(rows)
		if scanErr != nil {
			return scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	nextCursor := 0
	if len(items) > benchmarkNoteLimit {
		items = items[:benchmarkNoteLimit]
		nextCursor = cursor + benchmarkNoteLimit
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func (s *Server) createBenchmarkNote(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	target, err := s.benchmarkTargetFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		URL             string         `json:"url"`
		Title           string         `json:"title"`
		Structure       map[string]any `json:"structure"`
		StructureHash   string         `json:"structure_hash"`
		MetricsSnapshot map[string]any `json:"metrics_snapshot"`
		Takeaways       []string       `json:"takeaways"`
		NotBorrowable   []string       `json:"not_borrowable"`
		CapturedAt      *time.Time     `json:"captured_at"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Structure) == 0 {
		return validation("需要合格的拆解 structure；本期先支持手工登记，结构化拆解由 DEV-CX14 提供")
	}
	structureJSON, err := json.Marshal(in.Structure)
	if err != nil {
		return validation("structure 必须是 JSON 对象")
	}
	title := strings.TrimSpace(in.Title)
	if len([]rune(title)) > 200 {
		return validation("标题最多 200 码点")
	}
	rawURL := strings.TrimSpace(in.URL)
	normalized := normalizeBenchmarkURL(rawURL)
	if rawURL != "" && normalized == "" {
		return validation("URL 需要带 http/https 的有效地址")
	}
	if len(in.Takeaways) > 20 || len(in.NotBorrowable) > 20 {
		return validation("takeaways/not_borrowable 各最多 20 条")
	}
	for _, group := range [][]string{in.Takeaways, in.NotBorrowable} {
		for _, item := range group {
			if len([]rune(item)) > 200 || strings.TrimSpace(item) == "" {
				return validation("takeaways/not_borrowable 每条须为 1..200 码点")
			}
		}
	}
	if in.MetricsSnapshot == nil {
		in.MetricsSnapshot = map[string]any{}
	}
	metricsJSON, err := json.Marshal(in.MetricsSnapshot)
	if err != nil {
		return validation("metrics_snapshot 必须是 JSON 对象")
	}
	takeawaysJSON, err := json.Marshal(in.Takeaways)
	if err != nil {
		return err
	}
	notBorrowableJSON, err := json.Marshal(in.NotBorrowable)
	if err != nil {
		return err
	}
	structureHash := benchmarkContentHash(structureJSON)
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockBenchmarkAccount(ctx, tx, target.AccountID); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM benchmark_note WHERE target_id=$1 AND archived_at IS NULL`, target.ID).Scan(&count); err != nil {
		return err
	}
	if count >= benchmarkNoteLimit {
		return apiErr(409, "benchmark_limit", "该对标账号未归档笔记已达 30 篇上限，请先逐项归档")
	}
	if normalized != "" {
		var duplicate bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM benchmark_note WHERE target_id=$1 AND normalized_url=$2)`,
			target.ID, normalized).Scan(&duplicate); err != nil {
			return err
		}
		if duplicate {
			return apiErr(409, "benchmark_exists", "该对标账号下已存在同 URL 的笔记")
		}
	}
	item := benchmarkNote{TargetID: target.ID, URL: rawURL, NormalizedURL: normalized, Title: title,
		StructureHash: structureHash, Revision: 1}
	var structureBytes, metricsBytes, takeawaysBytes, notBorrowableBytes []byte
	err = tx.QueryRow(ctx, `INSERT INTO benchmark_note(workspace_id,target_id,url,normalized_url,title,structure,structure_hash,metrics_snapshot,takeaways,not_borrowable,captured_at,revision)
		VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,1)
		RETURNING `+benchmarkNoteCols,
		ident(ctx).WorkspaceID, target.ID, item.URL, item.NormalizedURL, item.Title, string(structureJSON),
		structureHash, string(metricsJSON), string(takeawaysJSON), string(notBorrowableJSON), in.CapturedAt).
		Scan(&item.ID, &item.TargetID, &item.URL, &item.NormalizedURL, &item.Title, &structureBytes,
			&item.StructureHash, &metricsBytes, &takeawaysBytes, &notBorrowableBytes, &item.CapturedAt, &item.Revision,
			&item.AICallID, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(structureBytes, &item.Structure); err != nil {
		return err
	}
	if err := json.Unmarshal(metricsBytes, &item.MetricsSnapshot); err != nil {
		return err
	}
	if err := json.Unmarshal(takeawaysBytes, &item.Takeaways); err != nil {
		return err
	}
	if err := json.Unmarshal(notBorrowableBytes, &item.NotBorrowable); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.audit(ctx, "benchmark_note_create", "benchmark_note", item.ID.String(), "ok", map[string]any{"target_id": target.ID})
	writeJSON(w, http.StatusCreated, item)
	return nil
}

func (s *Server) getBenchmarkNote(w http.ResponseWriter, r *http.Request) error {
	note, err := s.benchmarkNoteFromPath(r)
	if err != nil {
		return err
	}
	return ok(w, note)
}

func (s *Server) benchmarkNoteFromPath(r *http.Request) (benchmarkNote, error) {
	id, err := pathID(r, "noteId")
	if err != nil {
		return benchmarkNote{}, err
	}
	row := s.db.QueryRow(r.Context(), `SELECT `+benchmarkNoteCols+` FROM benchmark_note
		WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID)
	item, err := scanBenchmarkNote(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return benchmarkNote{}, errNotFound
	}
	return item, err
}

func (s *Server) updateBenchmarkNote(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	existing, err := s.benchmarkNoteFromPath(r)
	if err != nil {
		return err
	}
	if existing.ArchivedAt != nil {
		return apiErr(409, "benchmark_archived", "已归档笔记只能先恢复再编辑")
	}
	var in struct {
		BaseRevision    int            `json:"base_revision"`
		Title           *string        `json:"title"`
		MetricsSnapshot *map[string]any `json:"metrics_snapshot"`
		Takeaways       *[]string      `json:"takeaways"`
		NotBorrowable   *[]string      `json:"not_borrowable"`
		Archived        *bool          `json:"archived"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision < 1 || in.BaseRevision != existing.Revision {
		return apiErr(409, "version_conflict", "笔记已被他人修改，请刷新后重试")
	}
	title := existing.Title
	if in.Title != nil {
		title = strings.TrimSpace(*in.Title)
		if len([]rune(title)) > 200 {
			return validation("标题最多 200 码点")
		}
	}
	metrics := existing.MetricsSnapshot
	if in.MetricsSnapshot != nil {
		metrics = *in.MetricsSnapshot
	}
	takeaways := existing.Takeaways
	if in.Takeaways != nil {
		takeaways = *in.Takeaways
	}
	notBorrowable := existing.NotBorrowable
	if in.NotBorrowable != nil {
		notBorrowable = *in.NotBorrowable
	}
	for _, group := range [][]string{takeaways, notBorrowable} {
		if len(group) > 20 {
			return validation("takeaways/not_borrowable 各最多 20 条")
		}
		for _, item := range group {
			if len([]rune(item)) > 200 || strings.TrimSpace(item) == "" {
				return validation("takeaways/not_borrowable 每条须为 1..200 码点")
			}
		}
	}
	// structure/structure_hash 只随重新拆解变化；本接口只改手填快照与学习点（9.5 契约）。
	metricsJSON, err := json.Marshal(metrics)
	if err != nil {
		return validation("metrics_snapshot 必须是 JSON 对象")
	}
	takeawaysJSON, err := json.Marshal(takeaways)
	if err != nil {
		return err
	}
	notBorrowableJSON, err := json.Marshal(notBorrowable)
	if err != nil {
		return err
	}
	archived := existing.ArchivedAt != nil
	if in.Archived != nil {
		archived = *in.Archived
	}
	var archivedAt *time.Time
	if archived {
		now := time.Now()
		archivedAt = &now
	}
	updated, err := scanBenchmarkNote(s.db.QueryRow(ctx, `UPDATE benchmark_note SET title=$3,metrics_snapshot=$4::jsonb,takeaways=$5::jsonb,not_borrowable=$6::jsonb,archived_at=$7,
		revision=revision+1,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$8
		RETURNING `+benchmarkNoteCols,
		existing.ID, ident(ctx).WorkspaceID, title, string(metricsJSON), string(takeawaysJSON), string(notBorrowableJSON), archivedAt, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "笔记已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "benchmark_note_update", "benchmark_note", existing.ID.String(), "ok", nil)
	return ok(w, updated)
}

// benchmarkContentHash 是 structure 内容的稳定哈希，供引用侧校验快照未漂移。
func benchmarkContentHash(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
