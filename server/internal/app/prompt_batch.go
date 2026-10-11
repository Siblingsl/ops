package app

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"ops/internal/ai"
)

type batchCase struct {
	ID   uuid.UUID
	Name string
	Snap evalSnapshot
}

// DEV-U107（12 文档）：提示词模板包真实模型批量重放。把选中任务类型的测试用例在后台逐条
// 以当前任务路由与当前模板重放（runSnapshot，is_eval 用量），汇总 JSON 解析成功率、失败
// 原因与输出长度；只提供证据，不自动改写提示词（模板修改仍由人进行）。

const (
	promptBatchPerTask  = 10
	promptBatchTotalMax = 30
)

func (s *Server) runPromptEvalReplay(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	ws := ident(ctx).WorkspaceID
	var in struct {
		TaskTypes []string `json:"task_types"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	counts := map[string]int{}
	rows, err := s.db.Query(ctx, `SELECT task_type, count(*) FROM prompt_eval_case WHERE workspace_id=$1 GROUP BY task_type`, ws)
	if err != nil {
		return err
	}
	for rows.Next() {
		var t string
		var n int
		if err := rows.Scan(&t, &n); err == nil {
			counts[t] = n
		}
	}
	rows.Close()

	selected := []string{}
	seen := map[string]bool{}
	for _, t := range in.TaskTypes {
		t = strings.TrimSpace(t)
		if t == "" || seen[t] {
			continue
		}
		if _, ok := editableTask(t); !ok {
			return validation("不支持的任务类型：" + t)
		}
		seen[t] = true
		selected = append(selected, t)
	}
	if len(selected) == 0 {
		for t := range counts {
			if _, ok := editableTask(t); ok {
				selected = append(selected, t)
			}
		}
		sort.Strings(selected)
	}
	plan := map[string][]batchCase{}
	total := 0
	for _, t := range selected {
		crows, err := s.db.Query(ctx, `SELECT id, name, context_snapshot FROM prompt_eval_case
			WHERE workspace_id=$1 AND task_type=$2 ORDER BY created_at DESC LIMIT $3`, ws, t, promptBatchPerTask)
		if err != nil {
			return err
		}
		for crows.Next() {
			var c batchCase
			var raw []byte
			if err := crows.Scan(&c.ID, &c.Name, &raw); err != nil {
				crows.Close()
				return err
			}
			if err := json.Unmarshal(raw, &c.Snap); err != nil {
				crows.Close()
				return err
			}
			plan[t] = append(plan[t], c)
			total++
		}
		crows.Close()
		if total >= promptBatchTotalMax {
			break
		}
	}
	if total == 0 {
		return validation("还没有可重放的用例：先在编辑器里运行一次该任务，再保存为测试用例")
	}
	jobID, err := s.startBackgroundJob(ctx, jobSpec{TaskType: "prompt_eval_batch", Label: "提示词批量重放"},
		func(jctx context.Context) (any, error) {
			return s.runPromptBatchJob(jctx, plan)
		})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"job_id": jobID, "total": total})
}

func (s *Server) runPromptBatchJob(ctx context.Context, plan map[string][]batchCase) (any, error) {
	tasks := make([]string, 0, len(plan))
	for t := range plan {
		tasks = append(tasks, t)
	}
	sort.Strings(tasks)
	type taskSummary struct {
		TaskType string `json:"task_type"`
		Cases    int    `json:"cases"`
		JSONOK   int    `json:"json_ok"`
		Failed   int    `json:"failed"`
		AvgChars int    `json:"avg_chars"`
	}
	type caseRow struct {
		CaseID    uuid.UUID `json:"case_id"`
		Name      string    `json:"name"`
		TaskType  string    `json:"task_type"`
		OK        bool      `json:"ok"`
		JSONOK    *bool     `json:"json_ok"`
		Chars     int       `json:"chars"`
		LatencyMS int64     `json:"latency_ms"`
		Error     string    `json:"error"`
		Output    string    `json:"output"`
	}
	summaries := []taskSummary{}
	outRows := []caseRow{}
	for _, t := range tasks {
		cases := plan[t]
		tpl, ver := s.loadTaskInstruction(ctx, t)
		if tpl == "" {
			tpl, _ = editableTask(t)
			ver = 0
		}
		_ = ver
		sum := taskSummary{TaskType: t, Cases: len(cases)}
		totalChars := 0
		for _, c := range cases {
			row := caseRow{CaseID: c.ID, Name: c.Name, TaskType: t}
			start := time.Now()
			text, err := s.runSnapshot(ctx, t, c.Snap, tpl)
			row.LatencyMS = time.Since(start).Milliseconds()
			if err != nil {
				row.Error = errText(err)
				sum.Failed++
				row.Output = truncate(text, 600)
				outRows = append(outRows, row)
				continue
			}
			row.OK = true
			row.Chars = runeLen(text)
			row.Output = truncate(text, 600)
			totalChars += row.Chars
			if c.Snap.JSON {
				var v any
				if e := json.Unmarshal([]byte(ai.ExtractJSON(text)), &v); e != nil {
					f := false
					row.JSONOK = &f
					row.Error = "输出不是可解析的 JSON"
				} else {
					tr := true
					row.JSONOK = &tr
					sum.JSONOK++
				}
			}
			outRows = append(outRows, row)
		}
		if sum.Cases-sum.Failed > 0 {
			sum.AvgChars = totalChars / (sum.Cases - sum.Failed)
		}
		summaries = append(summaries, sum)
	}
	return map[string]any{"tasks": summaries, "rows": outRows}, nil
}
