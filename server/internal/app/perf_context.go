package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// 高表现样本注入：把本号已回填数据里阅读最好的几篇作品的标题与开头，作为「抄自己作业」的
// 样本注入起草提示词。这里只给具体样本，不做统计推断——统计结论走 account_data_preference
// （DEV-A102/A103），两者互补：一个说「故事类更好」，一个说「你表现最好的三篇是这样开头的」。
const (
	perfTopLimit     = 3
	perfOpeningRunes = 120
	perfSlotBudget   = 700
)

// perfTopSample 是一篇高表现作品在提示词里需要的全部信息。
type perfTopSample struct {
	WorkID       uuid.UUID
	Title        string
	Opening      string
	Reads        int
	Interactions int
}

// perfTasks 限定只给「决定怎么写」的任务注入样本；事实核查、摘要这类任务不需要。
var perfTasks = map[string]bool{
	"outline": true, "section_draft": true, "title": true,
}

// loadTopPerformance 取本号第 7 天阅读最高的 limit 篇（排除当前作品，只算有数据的）。
func (s *Server) loadTopPerformance(ctx context.Context, accountID uuid.UUID, exclude *uuid.UUID, limit int, contentFormats ...string) ([]perfTopSample, error) {
	contentFormat := ""
	if len(contentFormats) > 0 {
		contentFormat = contentFormats[0]
	}
	rows, err := s.db.Query(ctx, `
		SELECT w.id, w.title, coalesce(d.reads,0), coalesce(d.interactions,0),
		       coalesce((SELECT ws.content_md FROM work_section ws
		                 WHERE ws.work_id=w.id AND ws.deleted_at IS NULL
		                 ORDER BY ws.position LIMIT 1), '')
		FROM work w JOIN LATERAL metric_node_d7_public(w.id) d ON true
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND btrim(w.title) <> ''
		  AND ($4='' OR w.content_format=$4)
		  AND ($2::uuid IS NULL OR w.id <> $2)
		  AND coalesce(d.reads,0) > 0
		ORDER BY d.reads DESC, coalesce(d.interactions,0) DESC
		LIMIT $3`, accountID, exclude, limit, contentFormat)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []perfTopSample{}
	for rows.Next() {
		var p perfTopSample
		if err := rows.Scan(&p.WorkID, &p.Title, &p.Reads, &p.Interactions, &p.Opening); err != nil {
			return nil, err
		}
		p.Opening = openingExcerpt(p.Opening, perfOpeningRunes)
		out = append(out, p)
	}
	return out, rows.Err()
}

// openingExcerpt 去掉 markdown 标记和多余空白，只留开头一小段，避免样本块吃掉预算。
func openingExcerpt(md string, limit int) string {
	cleaned := strings.TrimSpace(md)
	cleaned = strings.TrimLeft(cleaned, "#>-*+ \t\n")
	cleaned = strings.ReplaceAll(cleaned, "\n", " ")
	cleaned = strings.ReplaceAll(cleaned, "**", "")
	for strings.Contains(cleaned, "  ") {
		cleaned = strings.ReplaceAll(cleaned, "  ", " ")
	}
	return truncateRunes(cleaned, limit)
}

func performanceText(samples []perfTopSample) string {
	var b strings.Builder
	for _, p := range samples {
		fmt.Fprintf(&b, "《%s》（阅读 %d，互动 %d）\n开头：%s\n", p.Title, p.Reads, p.Interactions, p.Opening)
	}
	return b.String()
}
