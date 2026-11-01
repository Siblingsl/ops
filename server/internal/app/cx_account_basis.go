package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type cxPlatformWorkRef struct {
	ID       uuid.UUID `json:"id"`
	Revision int64     `json:"revision"`
}

type cxBasisQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type cxBasisSource struct {
	Ref        string     `json:"ref"`
	Kind       string     `json:"kind"`
	ID         string     `json:"id"`
	Revision   *int64     `json:"revision"`
	AsOfAt     *time.Time `json:"as_of_at"`
	AsOfDate   string     `json:"as_of_date,omitempty"`
	UpdatedAt  *time.Time `json:"updated_at,omitempty"`
	CapturedAt *time.Time `json:"captured_at,omitempty"`
	State      string     `json:"state"`
	Purpose    string     `json:"purpose"`
}

type cxBasisOmission struct {
	Ref    string `json:"ref"`
	Reason string `json:"reason"`
}

type cxBasisReceipt struct {
	SchemaVersion int               `json:"schema_version"`
	AccountID     uuid.UUID         `json:"account_id"`
	WorkRevision  *int64            `json:"work_revision"`
	ProfileHash   string            `json:"profile_hash"`
	StrategyRef   *string           `json:"strategy_ref"`
	StandardRef   *string           `json:"standard_ref"`
	DNARef        *string           `json:"dna_ref"`
	Sources       []cxBasisSource   `json:"sources"`
	Omitted       []cxBasisOmission `json:"omitted"`
	Coverage      string            `json:"coverage"`
	AssembledAt   time.Time         `json:"assembled_at"`
	InputHash     string            `json:"input_hash"`
}

type cxAccountPositioning struct {
	Tags     []string `json:"positioning_tags"`
	Audience string   `json:"target_audience"`
	Tone     string   `json:"persona_tone"`
	Style    string   `json:"style_summary"`
}

type cxAccountStrategyInput struct {
	ID              uuid.UUID       `json:"id"`
	Version         int64           `json:"version"`
	Niche           string          `json:"niche"`
	Audience        string          `json:"audience"`
	Differentiation string          `json:"differentiation"`
	Persona         string          `json:"persona"`
	Pillars         json.RawMessage `json:"pillars"`
	CreatedAt       time.Time       `json:"created_at"`
}

type cxAccountMetricInput struct {
	MirrorID        uuid.UUID  `json:"platform_work_id"`
	WorkID          uuid.UUID  `json:"work_id"`
	PublishRevision int        `json:"publish_revision"`
	BindingRevision int        `json:"binding_revision"`
	MetricID        uuid.UUID  `json:"metric_id"`
	Revision        int64      `json:"revision"`
	Source          string     `json:"source"`
	QualityState    string     `json:"quality_state"`
	CapturedAt      time.Time  `json:"captured_at"`
	AsOfAt          *time.Time `json:"as_of_at"`
	Reads           *int       `json:"reads"`
	ReadUnit        string     `json:"read_unit"`
	Likes           *int       `json:"likes"`
	Favorites       *int       `json:"favorites"`
	Comments        *int       `json:"comments"`
	Shares          *int       `json:"shares"`
	ShareUnit       string     `json:"share_unit"`
	FollowsGained   *int       `json:"follows_gained"`
	Impressions     *int64     `json:"impressions"`
}

type cxAccountBasis struct {
	Receipt  cxBasisReceipt
	Profile  cxAccountPositioning
	Platform *cxAccountPlatformProfile
	Follower *cxAccountFollowerInput
	Works    []cxAccountWorkInput
	Strategy *cxAccountStrategyInput
	Metrics  []cxAccountMetricInput
}

type cxAccountBasisOptions struct {
	PlatformSnapshotRevision *int64
	IncludeMetrics           *bool
	IncludeFollowers         *bool
}

func cxJSONHash(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}

// cxAssembleAccountBasis creates only a partial basis. The caller must verify
// membership and account permissions before use and revalidate the basis after
// any model call. These metrics are individual retained snapshots, not
// normalized comparison windows or a ranking.
func (s *Server) cxAssembleAccountBasis(ctx context.Context, workspaceID, accountID uuid.UUID, refs []cxPlatformWorkRef, through time.Time) (*cxAccountBasis, error) {
	return s.cxAssembleAccountBasisWithOptions(ctx, workspaceID, accountID, refs, through, cxAccountBasisOptions{})
}

func (s *Server) cxAssembleAccountBasisWithOptions(ctx context.Context, workspaceID, accountID uuid.UUID, refs []cxPlatformWorkRef, through time.Time, options cxAccountBasisOptions) (*cxAccountBasis, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	basis, err := s.cxAssembleAccountBasisIn(ctx, tx, workspaceID, accountID, refs, through, options)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return basis, nil
}

func (s *Server) cxAssembleAccountBasisIn(ctx context.Context, q cxBasisQueryer, workspaceID, accountID uuid.UUID, refs []cxPlatformWorkRef, through time.Time, options cxAccountBasisOptions) (*cxAccountBasis, error) {
	includeMetrics := options.IncludeMetrics == nil || *options.IncludeMetrics
	includeFollowers := options.IncludeFollowers == nil || *options.IncludeFollowers
	if err := cxRequireScopedAccount(ctx, q, workspaceID, accountID); err != nil {
		return nil, err
	}
	basis := &cxAccountBasis{}
	if err := q.QueryRow(ctx, `SELECT positioning_tags,target_audience,persona_tone,style_summary FROM account_profile WHERE account_id=$1`, accountID).Scan(&basis.Profile.Tags, &basis.Profile.Audience, &basis.Profile.Tone, &basis.Profile.Style); err != nil {
		return nil, err
	}
	var strategy cxAccountStrategyInput
	err := q.QueryRow(ctx, `SELECT id,version,niche,audience,differentiation,persona,pillars,created_at FROM account_strategy WHERE account_id=$1 AND status='active'`, accountID).Scan(
		&strategy.ID, &strategy.Version, &strategy.Niche, &strategy.Audience, &strategy.Differentiation, &strategy.Persona, &strategy.Pillars, &strategy.CreatedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		basis.Strategy = &strategy
	}
	basis.Platform, err = cxReadPlatformProfile(ctx, q, workspaceID, accountID, options.PlatformSnapshotRevision)
	if err != nil {
		return nil, err
	}
	if includeFollowers {
		basis.Follower, err = cxReadFollower(ctx, q, workspaceID, accountID, through)
		if err != nil {
			return nil, err
		}
	}
	var more bool
	basis.Works, more, err = cxReadWorks(ctx, q, workspaceID, accountID, refs)
	if err != nil {
		return nil, err
	}
	if includeMetrics {
		basis.Metrics, err = cxAccountFormalMetrics(ctx, q, workspaceID, accountID, basis.Works)
		if err != nil {
			return nil, err
		}
	}
	profileHash, err := cxJSONHash(basis.Profile)
	if err != nil {
		return nil, err
	}
	receipt := cxBasisReceipt{SchemaVersion: 1, AccountID: accountID, ProfileHash: profileHash, Sources: []cxBasisSource{}, Omitted: []cxBasisOmission{}, AssembledAt: time.Now().UTC()}
	receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: "profile:" + accountID.String(), Kind: "profile", ID: accountID.String(), State: "unconfirmed", Purpose: "定位"})
	if basis.Strategy == nil {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "strategy", Reason: "没有启用的运营方案"})
	} else {
		ref := "strategy:" + basis.Strategy.ID.String()
		receipt.StrategyRef = &ref
		receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: ref, Kind: "strategy", ID: basis.Strategy.ID.String(), Revision: &basis.Strategy.Version, AsOfAt: &basis.Strategy.CreatedAt, State: "unconfirmed", Purpose: "运营方案"})
	}
	if basis.Platform == nil {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_profile", Reason: "尚无同步资料"})
	} else {
		receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: "platform_profile:" + accountID.String(), Kind: "platform_profile", ID: accountID.String(), Revision: &basis.Platform.Revision, AsOfAt: &basis.Platform.ObservedAt, State: "observed", Purpose: "展示资料"})
		var states map[string]string
		if err := json.Unmarshal(basis.Platform.FieldStates, &states); err != nil {
			return nil, err
		}
		for _, field := range []struct {
			name  string
			value *string
		}{{"display_name", basis.Platform.DisplayName}, {"public_account_id", basis.Platform.PublicID}, {"bio", basis.Platform.Bio}} {
			if states[field.name] != "present" || field.value == nil {
				state := states[field.name]
				if state == "" {
					state = "unknown"
				}
				if state == "present" {
					state = "value_missing"
				}
				receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_profile:" + field.name, Reason: "平台资料字段不可用：" + state})
			}
		}
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_profile:field_times", Reason: "资料快照未记录每个字段的独立采集时间"})
	}
	if !includeFollowers {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "followers", Reason: "本次未选择粉丝数据"})
	} else if basis.Follower == nil {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "followers", Reason: "未找到粉丝总数"})
	} else {
		state := "observed"
		if basis.Follower.Source == "manual" {
			state = "unconfirmed"
		}
		receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: "followers:" + basis.Follower.Date + ":" + basis.Follower.Source, Kind: "followers", ID: accountID.String(), AsOfDate: basis.Follower.Date, UpdatedAt: &basis.Follower.UpdatedAt, State: state, Purpose: "粉丝总数"})
	}
	if len(basis.Works) == 0 {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_work", Reason: "没有已选平台作品"})
	}
	if more {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_work", Reason: "只选择最近 20 篇"})
	}
	type hashWork struct {
		Input cxAccountWorkInput `json:"input"`
		Body  string             `json:"body"`
	}
	hashWorks := make([]hashWork, 0, len(basis.Works))
	for i := range basis.Works {
		work := &basis.Works[i]
		ref := "platform_work:" + work.ID.String()
		receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: ref, Kind: "platform_work", ID: work.ID.String(), Revision: &work.Revision, AsOfAt: work.ObservedAt, State: "observed", Purpose: "内容分析"})
		if work.BodyTruncated {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: ref, Reason: "正文超出分析字数上限"})
		}
		if work.BodyUnavailableReason != "" {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: ref, Reason: work.BodyUnavailableReason})
		}
		if work.ContentState != "complete" {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: ref, Reason: "平台正文未完整取得：" + work.ContentState})
		}
		hashWorks = append(hashWorks, hashWork{Input: *work, Body: work.Body})
	}
	metricByMirror := make(map[uuid.UUID]bool, len(basis.Metrics))
	for i := range basis.Metrics {
		metric := &basis.Metrics[i]
		metricByMirror[metric.MirrorID] = true
		state := "observed"
		if metric.Source == "manual" {
			state = "unconfirmed"
		}
		receipt.Sources = append(receipt.Sources, cxBasisSource{Ref: "metric:" + metric.MetricID.String(), Kind: "metric", ID: metric.MetricID.String(), Revision: &metric.Revision, AsOfAt: metric.AsOfAt, CapturedAt: &metric.CapturedAt, State: state, Purpose: "已保留的正式指标快照"})
		if metric.ReadUnit == "unknown" {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "metric:" + metric.MetricID.String(), Reason: "阅读单位未知，不能用于同口径比较"})
		}
		if metric.Shares != nil && metric.ShareUnit == "unknown" {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "metric:" + metric.MetricID.String(), Reason: "分享单位未知，不能用于同口径比较"})
		}
		if metric.AsOfAt == nil {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "metric:" + metric.MetricID.String(), Reason: "平台统计时点未知，仅可确认采集时间"})
		}
	}
	if !includeMetrics {
		receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "metric", Reason: "本次未选择指标"})
	}
	for _, work := range basis.Works {
		if includeMetrics && !metricByMirror[work.ID] {
			receipt.Omitted = append(receipt.Omitted, cxBasisOmission{Ref: "platform_work:" + work.ID.String(), Reason: "没有可用的已确认绑定与正式指标"})
		}
	}
	receipt.Coverage = cxAccountBasisCoverage(basis, receipt.Omitted)
	receipt.InputHash, err = cxJSONHash(struct {
		AccountID        uuid.UUID                 `json:"account_id"`
		Profile          cxAccountPositioning      `json:"profile"`
		Platform         *cxAccountPlatformProfile `json:"platform"`
		Strategy         *cxAccountStrategyInput   `json:"strategy"`
		Follower         *cxAccountFollowerInput   `json:"follower"`
		Metrics          []cxAccountMetricInput    `json:"metrics"`
		Works            []hashWork                `json:"works"`
		More             bool                      `json:"more"`
		IncludeMetrics   bool                      `json:"include_metrics"`
		IncludeFollowers bool                      `json:"include_followers"`
		ThroughDate      string                    `json:"through_date"`
	}{accountID, basis.Profile, basis.Platform, basis.Strategy, basis.Follower, basis.Metrics, hashWorks, more, includeMetrics, includeFollowers, through.Format("2006-01-02")})
	if err != nil {
		return nil, err
	}
	basis.Receipt = receipt
	return basis, nil
}

func cxAccountBasisCoverage(basis *cxAccountBasis, omitted []cxBasisOmission) string {
	hasProfile := len(basis.Profile.Tags) > 0 || strings.TrimSpace(basis.Profile.Audience) != "" ||
		strings.TrimSpace(basis.Profile.Tone) != "" || strings.TrimSpace(basis.Profile.Style) != ""
	hasData := hasProfile || basis.Strategy != nil ||
		basis.Platform != nil && (basis.Platform.DisplayName != nil || basis.Platform.PublicID != nil || basis.Platform.Bio != nil) ||
		basis.Follower != nil || len(basis.Works) > 0 || len(basis.Metrics) > 0
	if !hasData {
		return "unavailable"
	}
	if !hasProfile || len(basis.Works) == 0 {
		return "partial"
	}
	for _, item := range omitted {
		if item.Ref == "followers" && item.Reason == "本次未选择粉丝数据" || item.Ref == "metric" && item.Reason == "本次未选择指标" {
			continue
		}
		return "partial"
	}
	return "ready"
}

type cxAccountPlatformProfile struct {
	DisplayName    *string         `json:"display_name"`
	PublicID       *string         `json:"public_account_id"`
	Bio            *string         `json:"bio"`
	FieldStates    json.RawMessage `json:"field_states"`
	Revision       int64           `json:"revision"`
	ObservedAt     time.Time       `json:"observed_at"`
	AdapterVersion string          `json:"adapter_version"`
	MappingVersion int             `json:"mapping_version"`
}

// The profile snapshot remains separate from the user's editable positioning.
// A nil snapshot means that no profile has been collected, not an empty profile.
func (s *Server) cxAccountAnalysisPlatformProfile(ctx context.Context, workspaceID, accountID uuid.UUID, revision *int64) (*cxAccountPlatformProfile, error) {
	return cxReadPlatformProfile(ctx, s.db, workspaceID, accountID, revision)
}

func cxReadPlatformProfile(ctx context.Context, q cxBasisQueryer, workspaceID, accountID uuid.UUID, revision *int64) (*cxAccountPlatformProfile, error) {
	if err := cxRequireScopedAccount(ctx, q, workspaceID, accountID); err != nil {
		return nil, err
	}
	var profile cxAccountPlatformProfile
	err := q.QueryRow(ctx, `SELECT display_name,public_account_id,bio,field_states,revision,observed_at,adapter_version,mapping_version
		FROM platform_account_snapshot WHERE account_id=$1 AND workspace_id=$2`, accountID, workspaceID).Scan(
		&profile.DisplayName, &profile.PublicID, &profile.Bio, &profile.FieldStates, &profile.Revision, &profile.ObservedAt, &profile.AdapterVersion, &profile.MappingVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		if revision != nil {
			return nil, apiErr(http.StatusConflict, "version_conflict", "平台资料已变化，请刷新后重试")
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if revision != nil && *revision != profile.Revision {
		return nil, apiErr(http.StatusConflict, "version_conflict", "平台资料已变化，请刷新后重试")
	}
	var states map[string]string
	if err := json.Unmarshal(profile.FieldStates, &states); err != nil {
		return nil, err
	}
	// The snapshot writer retains old values when a newer observation marks a
	// field unavailable. Such retained values must not become current AI facts.
	if states["display_name"] != "present" {
		profile.DisplayName = nil
	}
	if states["public_account_id"] != "present" {
		profile.PublicID = nil
	}
	if states["bio"] != "present" {
		profile.Bio = nil
	}
	return &profile, nil
}

func cxRequireScopedAccount(ctx context.Context, q cxBasisQueryer, workspaceID, accountID uuid.UUID) error {
	var exists bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_account WHERE id=$1 AND workspace_id=$2)`, accountID, workspaceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	return nil
}

type cxAccountFollowerInput struct {
	Date      string    `json:"date"`
	Source    string    `json:"source"`
	Cumulate  int       `json:"cumulate"`
	UpdatedAt time.Time `json:"updated_at"`
}

// cxAccountAnalysisFollower reads the latest available total through the
// requested date. A nil result is unknown; an actual zero remains a value.
// As with work selection, the caller must authorize the actor and account.
func (s *Server) cxAccountAnalysisFollower(ctx context.Context, workspaceID, accountID uuid.UUID, through time.Time) (*cxAccountFollowerInput, error) {
	return cxReadFollower(ctx, s.db, workspaceID, accountID, through)
}

func cxReadFollower(ctx context.Context, q cxBasisQueryer, workspaceID, accountID uuid.UUID, through time.Time) (*cxAccountFollowerInput, error) {
	if err := cxRequireScopedAccount(ctx, q, workspaceID, accountID); err != nil {
		return nil, err
	}
	var follower cxAccountFollowerInput
	err := q.QueryRow(ctx, `SELECT to_char(date,'YYYY-MM-DD'),source,cumulate,updated_at FROM account_metric_daily
		WHERE account_id=$1 AND date<=$2::date AND cumulate IS NOT NULL
		ORDER BY date DESC,(source='wechat_api') DESC LIMIT 1`, accountID, through.Format("2006-01-02")).Scan(&follower.Date, &follower.Source, &follower.Cumulate, &follower.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &follower, nil
}

// Body is a bounded model input, never part of the source receipt.
type cxAccountWorkInput struct {
	ID                    uuid.UUID       `json:"id"`
	Revision              int64           `json:"revision"`
	Title                 string          `json:"title"`
	Body                  string          `json:"-"`
	BodyRunes             *int            `json:"body_runes"`
	IncludedBodyRunes     int             `json:"included_body_runes"`
	BodyTruncated         bool            `json:"body_truncated"`
	BodyUnavailableReason string          `json:"body_unavailable_reason,omitempty"`
	ContentState          string          `json:"content_state"`
	FieldCoverage         json.RawMessage `json:"field_coverage"`
	ObservedAt            *time.Time      `json:"observed_at"`
	PublishedAt           *time.Time      `json:"published_at"`
}

// cxAccountAnalysisWorks only reads already collected mirrors. The caller must
// authenticate the actor and authorize this account before supplying workspaceID.
func (s *Server) cxAccountAnalysisWorks(ctx context.Context, workspaceID, accountID uuid.UUID, refs []cxPlatformWorkRef) ([]cxAccountWorkInput, bool, error) {
	return cxReadWorks(ctx, s.db, workspaceID, accountID, refs)
}

func cxReadWorks(ctx context.Context, q cxBasisQueryer, workspaceID, accountID uuid.UUID, refs []cxPlatformWorkRef) ([]cxAccountWorkInput, bool, error) {
	if err := cxRequireScopedAccount(ctx, q, workspaceID, accountID); err != nil {
		return nil, false, err
	}
	if len(refs) > 20 {
		return nil, false, validation("最多选择 20 篇平台作品")
	}
	ids := make([]uuid.UUID, 0, len(refs))
	expected := make(map[uuid.UUID]int64, len(refs))
	for _, ref := range refs {
		if ref.ID == uuid.Nil || ref.Revision < 1 {
			return nil, false, validation("作品引用及版本无效")
		}
		if _, duplicate := expected[ref.ID]; duplicate {
			return nil, false, validation("不能重复选择同一篇作品")
		}
		expected[ref.ID] = ref.Revision
		ids = append(ids, ref.ID)
	}
	query := `SELECT id,revision,title,left(body_text,2000),char_length(body_text),content_state,field_coverage,content_observed_at,published_at
		FROM platform_work_mirror WHERE workspace_id=$1 AND account_id=$2`
	args := []any{workspaceID, accountID}
	if len(refs) == 0 {
		query += ` ORDER BY published_at DESC NULLS LAST,id ASC LIMIT 21`
	} else {
		query += ` AND id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],id)`
		args = append(args, ids)
	}
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	works := make([]cxAccountWorkInput, 0, 20)
	more := false
	remaining := 20000
	for rows.Next() {
		var work cxAccountWorkInput
		var storedBodyRunes int
		if err := rows.Scan(&work.ID, &work.Revision, &work.Title, &work.Body, &storedBodyRunes, &work.ContentState, &work.FieldCoverage, &work.ObservedAt, &work.PublishedAt); err != nil {
			return nil, false, err
		}
		if len(works) == 20 {
			more = true
			continue
		}
		if len(refs) > 0 && expected[work.ID] != work.Revision {
			return nil, false, apiErr(http.StatusConflict, "version_conflict", "平台作品已更新，请刷新后重新选择")
		}
		var coverage map[string]string
		if err := json.Unmarshal(work.FieldCoverage, &coverage); err != nil {
			return nil, false, err
		}
		if work.ContentState != "complete" || coverage["body_text"] != "present" || work.ObservedAt == nil {
			work.Body = ""
			work.BodyUnavailableReason = "正文未获得当前完整观测"
			works = append(works, work)
			continue
		}
		work.BodyRunes = &storedBodyRunes
		body := []rune(work.Body)
		if len(body) > remaining {
			body = body[:remaining]
		}
		work.Body = string(body)
		work.IncludedBodyRunes = len(body)
		work.BodyTruncated = storedBodyRunes > len(body)
		remaining -= len(body)
		works = append(works, work)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(refs) > 0 && len(works) != len(refs) {
		return nil, false, errNotFound
	}
	return works, more, nil
}
