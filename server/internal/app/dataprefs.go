package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-A102（13 文档）：账号级"读者数据偏好"。归因分析的分组统计是确定性数据，把其中
// 样本量达标（对比双方各 ≥3 篇）且差异明显（平均阅读高 ≥20%）的结论沉淀下来，供生成
// 提示词动态注入（DEV-A103）。AI 归因结论仍照旧展示给人，不进入本表。

type DataPreference struct {
	ID         uuid.UUID `json:"id"`
	Feature    string    `json:"feature"`
	Conclusion string    `json:"conclusion"`
	Basis      string    `json:"basis"`
	SampleSize int       `json:"sample_size"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type dataPreferenceBasis struct {
	Version       int       `json:"version"`
	ContentFormat string    `json:"content_format,omitempty"`
	InputRevision int64     `json:"input_revision"`
	SampleCount   int       `json:"sample_count"`
	SampleSHA256  string    `json:"sample_sha256"`
	ComputedAt    time.Time `json:"computed_at"`
	Applicable    bool      `json:"applicable"`
	Reason        string    `json:"reason,omitempty"`
}

type DataPreferenceView struct {
	DataPreference
	Applicable       bool       `json:"applicable"`
	Applicability    string     `json:"applicability"`
	BasisSampleCount int        `json:"basis_sample_count"`
	ComputedAt       *time.Time `json:"computed_at"`
}

type dataPreferenceSampleBasis struct {
	WorkID       uuid.UUID `json:"work_id"`
	Title        string    `json:"title"`
	PublishedAt  time.Time `json:"published_at"`
	Reads        int       `json:"reads"`
	Interactions int       `json:"interactions"`
	Chars        int       `json:"chars"`
	Topics       []string  `json:"topics"`
}

// deriveDataPreferences extracts rule-based reader preferences from attribution group stats.
func deriveDataPreferences(feats []AttrFeature) []DataPreference {
	prefs := []DataPreference{}
	for _, f := range feats {
		if len(f.Groups) < 2 {
			continue
		}
		top, low := f.Groups[0], f.Groups[len(f.Groups)-1] // Groups 已按平均阅读降序
		if top.N < 3 || low.N < 3 || low.AvgReads <= 0 {
			continue
		}
		if top.AvgReads < low.AvgReads*1.2 {
			continue
		}
		prefs = append(prefs, DataPreference{
			Feature:    f.Feature,
			Conclusion: fmt.Sprintf("%s的作品平均阅读更高（%d 篇，平均 %.0f）", top.Value, top.N, top.AvgReads),
			Basis:      fmt.Sprintf("对比「%s」（%d 篇，平均 %.0f）", low.Value, low.N, low.AvgReads),
			SampleSize: top.N + low.N,
		})
	}
	return prefs
}

func dataPreferenceBasisJSON(revision int64, samples []perfSample, computedAt time.Time, applicable bool) ([]byte, error) {
	return dataPreferenceBasisJSONForFormat(revision, samples, computedAt, applicable, "")
}

func dataPreferenceBasisJSONForFormat(revision int64, samples []perfSample, computedAt time.Time, applicable bool, contentFormat string) ([]byte, error) {
	canonical := make([]dataPreferenceSampleBasis, 0, len(samples))
	for _, sample := range samples {
		canonical = append(canonical, dataPreferenceSampleBasis{
			WorkID: sample.WorkID, Title: sample.Title, PublishedAt: sample.PublishedAt.UTC(),
			Reads: sample.Reads, Interactions: sample.Interactions, Chars: sample.Chars,
			Topics: append([]string(nil), sample.Topics...),
		})
	}
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].WorkID.String() < canonical[j].WorkID.String() })
	input, err := json.Marshal(canonical)
	if err != nil {
		return nil, err
	}
	sampleHash := sha256.Sum256(input)
	basis := dataPreferenceBasis{
		Version: 1, InputRevision: revision, SampleCount: len(samples),
		SampleSHA256: hex.EncodeToString(sampleHash[:]),
		ComputedAt:   computedAt.UTC(), Applicable: applicable, ContentFormat: contentFormat,
	}
	if !applicable {
		basis.Reason = "insufficient_samples"
	}
	return json.Marshal(basis)
}

// persistToutiaoDataPreferences evaluates both Toutiao shapes from the same bounded 500-work
// input and commits both namespaces before advancing the account input revision.
func (s *Server) persistToutiaoDataPreferences(ctx context.Context, accountID uuid.UUID, revision int64, allSamples []perfSample, onlyIfDirty bool) (bool, error) {
	type shapeResult struct {
		format     string
		samples    []perfSample
		prefs      []DataPreference
		basis      []byte
		applicable bool
	}
	results := make([]shapeResult, 0, 2)
	for _, format := range []string{"long_article", "micro_post"} {
		result := shapeResult{format: format, samples: []perfSample{}}
		for _, sample := range allSamples {
			if sample.ContentFormat == format {
				result.samples = append(result.samples, sample)
			}
		}
		result.applicable = len(result.samples) >= minAttributionSamples
		if result.applicable {
			result.prefs = deriveDataPreferences(attributionStats(result.samples, s.loc))
			for i := range result.prefs {
				result.prefs[i].Feature = format + ":" + result.prefs[i].Feature
			}
		}
		var err error
		result.basis, err = dataPreferenceBasisJSONForFormat(revision, result.samples, s.now(), result.applicable, format)
		if err != nil {
			return false, err
		}
		results = append(results, result)
	}
	applied := false
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var current int64
		var processed *int64
		if err := tx.QueryRow(ctx, `SELECT pref_input_revision,pref_processed_revision FROM platform_account WHERE id=$1 FOR UPDATE`, accountID).Scan(&current, &processed); err != nil {
			return err
		}
		if current != revision || (onlyIfDirty && processed != nil && *processed == revision) {
			return nil
		}
		for _, result := range results {
			prefix := result.format + ":%"
			if _, err := tx.Exec(ctx, `DELETE FROM account_data_preference WHERE account_id=$1 AND feature LIKE $2`, accountID, prefix); err != nil {
				return err
			}
			for _, pref := range result.prefs {
				if _, err := tx.Exec(ctx, `INSERT INTO account_data_preference(account_id,feature,conclusion,basis,sample_size,basis_meta)
					VALUES($1,$2,$3,$4,$5,$6)`, accountID, pref.Feature, pref.Conclusion, pref.Basis, pref.SampleSize, result.basis); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_account SET pref_processed_revision=$2 WHERE id=$1`, accountID, revision); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied, err
}

func (s *Server) preferenceInputRevision(ctx context.Context, accountID uuid.UUID) (int64, error) {
	var revision int64
	err := s.db.QueryRow(ctx, `SELECT pref_input_revision FROM platform_account WHERE id=$1`, accountID).Scan(&revision)
	return revision, err
}

// persistDataPreferences commits a result only if it still describes the account's current inputs.
// A background pass skips an account another worker has already processed at this revision.
func (s *Server) persistDataPreferences(ctx context.Context, accountID uuid.UUID, revision int64, samples []perfSample,
	prefs []DataPreference, applicable, onlyIfDirty bool) (bool, error) {
	basis, err := dataPreferenceBasisJSON(revision, samples, s.now(), applicable)
	if err != nil {
		return false, err
	}
	applied := false
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var current int64
		var processed *int64
		if err := tx.QueryRow(ctx, `SELECT pref_input_revision, pref_processed_revision FROM platform_account WHERE id=$1 FOR UPDATE`, accountID).
			Scan(&current, &processed); err != nil {
			return err
		}
		if current != revision || (onlyIfDirty && processed != nil && *processed == revision) {
			return nil
		}
		if applicable {
			for _, p := range prefs {
				if _, err := tx.Exec(ctx, `INSERT INTO account_data_preference (account_id, feature, conclusion, basis, sample_size, basis_meta)
					VALUES ($1,$2,$3,$4,$5,$6)
					ON CONFLICT (account_id, feature) DO UPDATE SET conclusion=excluded.conclusion, basis=excluded.basis,
					sample_size=excluded.sample_size, basis_meta=excluded.basis_meta, updated_at=now()`,
					accountID, p.Feature, p.Conclusion, p.Basis, p.SampleSize, basis); err != nil {
					return err
				}
			}
			kept := make([]string, len(prefs))
			for i, p := range prefs {
				kept[i] = p.Feature
			}
			if len(kept) == 0 {
				if _, err := tx.Exec(ctx, `DELETE FROM account_data_preference WHERE account_id=$1`, accountID); err != nil {
					return err
				}
			} else if _, err := tx.Exec(ctx, `DELETE FROM account_data_preference WHERE account_id=$1 AND feature <> ALL($2)`, accountID, kept); err != nil {
				return err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE account_data_preference SET basis_meta=$2 WHERE account_id=$1`, accountID, basis); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE platform_account SET pref_processed_revision=$2 WHERE id=$1`, accountID, revision); err != nil {
			return err
		}
		applied = true
		return nil
	})
	return applied, err
}

// loadDataPreferences returns the latest preferences for generation prompts (top 5).
func (s *Server) loadDataPreferences(ctx context.Context, accountID uuid.UUID, contentFormats ...string) ([]DataPreference, error) {
	format := ""
	if len(contentFormats) > 0 {
		format = contentFormats[0]
	}
	rows, err := s.db.Query(ctx, `SELECT p.id, p.feature, p.conclusion, p.basis, p.sample_size, p.created_at, p.updated_at
		FROM account_data_preference p JOIN platform_account a ON a.id=p.account_id
		WHERE p.account_id=$1 AND a.pref_processed_revision=a.pref_input_revision
			AND p.basis_meta->>'applicable'='true' AND p.basis_meta->>'input_revision'=a.pref_input_revision::text
			AND ($2='' OR (p.feature LIKE $2||':%' AND p.basis_meta->>'content_format'=$2))
		ORDER BY p.updated_at DESC LIMIT 5`, accountID, format)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DataPreference{}
	for rows.Next() {
		var p DataPreference
		if err := rows.Scan(&p.ID, &p.Feature, &p.Conclusion, &p.Basis, &p.SampleSize, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) listDataPreferences(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	format := r.URL.Query().Get("content_format")
	if a.Platform == "toutiao" && format != "" && format != "long_article" && format != "micro_post" {
		return validation("偏好内容形态无效")
	}
	rows, err := s.db.Query(r.Context(), `SELECT p.id, p.feature, p.conclusion, p.basis, p.sample_size, p.created_at, p.updated_at,
		p.basis_meta, a.pref_input_revision, a.pref_processed_revision
		FROM account_data_preference p JOIN platform_account a ON a.id=p.account_id
		WHERE a.id=$1 AND ($2='' OR p.basis_meta->>'content_format'=$2) ORDER BY p.updated_at DESC, p.feature`, a.ID, format)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []DataPreferenceView{}
	for rows.Next() {
		var p DataPreferenceView
		var raw []byte
		var inputRevision int64
		var processedRevision *int64
		if err := rows.Scan(&p.ID, &p.Feature, &p.Conclusion, &p.Basis, &p.SampleSize, &p.CreatedAt, &p.UpdatedAt,
			&raw, &inputRevision, &processedRevision); err != nil {
			return err
		}
		var basis dataPreferenceBasis
		if len(raw) == 0 || json.Unmarshal(raw, &basis) != nil || basis.Version != 1 {
			p.Applicability = "unverified"
		} else {
			p.BasisSampleCount = basis.SampleCount
			p.ComputedAt = &basis.ComputedAt
			switch {
			case processedRevision == nil || *processedRevision != inputRevision || basis.InputRevision != inputRevision:
				p.Applicability = "stale"
			case !basis.Applicable:
				p.Applicability = "insufficient_samples"
			default:
				p.Applicable = true
				p.Applicability = "current"
			}
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, out)
}

// dataPrefTasks lists the generation tasks that receive reader-data preferences (DEV-A103).
var dataPrefTasks = map[string]bool{
	"title": true, "outline": true, "section_draft": true, "daily_recommend": true, "strategy_outline": true,
}
