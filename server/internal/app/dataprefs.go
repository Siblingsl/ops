package app

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
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

// saveDataPreferences upserts this round's preferences and removes features that no longer qualify.
func (s *Server) saveDataPreferences(ctx context.Context, accountID uuid.UUID, prefs []DataPreference) error {
	for _, p := range prefs {
		if _, err := s.db.Exec(ctx, `INSERT INTO account_data_preference (account_id, feature, conclusion, basis, sample_size)
			VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (account_id, feature) DO UPDATE SET conclusion=excluded.conclusion, basis=excluded.basis,
			sample_size=excluded.sample_size, updated_at=now()`, accountID, p.Feature, p.Conclusion, p.Basis, p.SampleSize); err != nil {
			return err
		}
	}
	kept := make([]string, len(prefs))
	for i, p := range prefs {
		kept[i] = p.Feature
	}
	if len(kept) == 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM account_data_preference WHERE account_id=$1`, accountID)
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM account_data_preference WHERE account_id=$1 AND feature <> ALL($2)`, accountID, kept)
	return err
}

// loadDataPreferences returns the latest preferences for generation prompts (top 5).
func (s *Server) loadDataPreferences(ctx context.Context, accountID uuid.UUID) ([]DataPreference, error) {
	rows, err := s.db.Query(ctx, `SELECT id, feature, conclusion, basis, sample_size, created_at, updated_at
		FROM account_data_preference WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 5`, accountID)
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

// dataPrefTasks lists the generation tasks that receive reader-data preferences (DEV-A103).
var dataPrefTasks = map[string]bool{
	"title": true, "outline": true, "section_draft": true, "daily_recommend": true, "strategy_outline": true,
}
