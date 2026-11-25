package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---------- EX-P-02 质量看板 ----------

func (s *Server) qualityBoard(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	days := queryInt(r, "days", 30)
	if days < 7 || days > 180 {
		days = 30
	}
	from := s.today().AddDate(0, 0, -days)
	type taskRow struct {
		TaskType      string         `json:"task_type"`
		Label         string         `json:"label"`
		Calls         int            `json:"calls"`
		WithFeedback  int            `json:"with_feedback"`
		Adopted       int            `json:"adopted"`
		Regenerated   int            `json:"regenerated"`
		ThumbsDown    int            `json:"thumbs_down"`
		AvgEditRatio  *float64       `json:"avg_edit_ratio"`
		AdoptionRate  *float64       `json:"adoption_rate"`
		RetryRate     *float64       `json:"retry_rate"`
		DownReasons   map[string]int `json:"down_reasons"`
		FallbackCalls int            `json:"fallback_calls"`
	}
	rows, err := s.db.Query(ctx, `SELECT c.task_type, count(*), count(f.id) FILTER (WHERE f.outcome IS NOT NULL),
		count(f.id) FILTER (WHERE `+adoptedExpr+`), count(f.id) FILTER (WHERE f.outcome='regenerated'),
		count(f.id) FILTER (WHERE f.rating=-1), avg(f.edit_ratio) FILTER (WHERE f.outcome='edited')::float8,
		count(*) FILTER (WHERE (c.context_refs->>'fallback_used')::boolean)
		FROM ai_call c LEFT JOIN ai_feedback f ON f.ai_call_id=c.id
		WHERE c.workspace_id=$1 AND c.created_at >= $2 AND c.status='ok' AND NOT c.is_eval GROUP BY c.task_type ORDER BY count(*) DESC`, ws, from)
	if err != nil {
		return err
	}
	list := []*taskRow{}
	byType := map[string]*taskRow{}
	for rows.Next() {
		x := &taskRow{DownReasons: map[string]int{}}
		if err := rows.Scan(&x.TaskType, &x.Calls, &x.WithFeedback, &x.Adopted, &x.Regenerated, &x.ThumbsDown, &x.AvgEditRatio, &x.FallbackCalls); err != nil {
			rows.Close()
			return err
		}
		x.Label = taskLabel(x.TaskType)
		if x.WithFeedback > 0 {
			a, rr := float64(x.Adopted)/float64(x.WithFeedback), float64(x.Regenerated)/float64(x.WithFeedback)
			x.AdoptionRate, x.RetryRate = &a, &rr
		}
		list = append(list, x)
		byType[x.TaskType] = x
	}
	rows.Close()
	rrows, err := s.db.Query(ctx, `SELECT f.task_type, t, count(*) FROM ai_feedback f, unnest(f.reason_tags) t
		WHERE f.workspace_id=$1 AND f.created_at >= $2 AND f.rating=-1 GROUP BY 1, 2`, ws, from)
	if err != nil {
		return err
	}
	for rrows.Next() {
		var tt, tag string
		var n int
		if rrows.Scan(&tt, &tag, &n) == nil && byType[tt] != nil {
			byType[tt].DownReasons[tag] = n
		}
	}
	rrows.Close()
	type weekRow struct {
		Week         string   `json:"week"`
		Calls        int      `json:"calls"`
		AdoptionRate *float64 `json:"adoption_rate"`
	}
	trend := []weekRow{}
	wrows, err := s.db.Query(ctx, `SELECT to_char(date_trunc('week', c.created_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD'), count(*),
		count(f.id) FILTER (WHERE `+adoptedExpr+`), count(f.id) FILTER (WHERE f.outcome IS NOT NULL)
		FROM ai_call c LEFT JOIN ai_feedback f ON f.ai_call_id=c.id
		WHERE c.workspace_id=$1 AND c.created_at >= $2 AND c.status='ok' AND NOT c.is_eval AND ($3='' OR c.task_type=$3) GROUP BY 1 ORDER BY 1`,
		ws, from, r.URL.Query().Get("task_type"))
	if err != nil {
		return err
	}
	for wrows.Next() {
		var x weekRow
		var adopted, fb int
		if wrows.Scan(&x.Week, &x.Calls, &adopted, &fb) == nil {
			if fb > 0 {
				a := float64(adopted) / float64(fb)
				x.AdoptionRate = &a
			}
			trend = append(trend, x)
		}
	}
	wrows.Close()
	var pending float64
	_ = s.db.QueryRow(ctx, `SELECT coalesce(avg(n),0)::float8 FROM (SELECT w.id, (SELECT count(*) FROM work_section ws, regexp_matches(ws.content_md, '【待核实', 'g') m
		WHERE ws.work_id=w.id AND ws.deleted_at IS NULL) n FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE a.workspace_id=$1 AND w.deleted_at IS NULL AND w.updated_at >= $2) t`, ws, from).Scan(&pending)
	ux := map[string]int{}
	urows, err := s.db.Query(ctx, `SELECT event, count(*) FROM ux_event WHERE workspace_id=$1 AND created_at >= $2 GROUP BY event`, ws, from)
	if err == nil {
		for urows.Next() {
			var e string
			var n int
			if urows.Scan(&e, &n) == nil {
				ux[e] = n
			}
		}
		urows.Close()
	}
	return ok(w, map[string]any{"days": days, "tasks": list, "trend": trend, "avg_pending_per_work": pending, "ux_events": ux,
		"metrics": s.qualityMetrics(ctx, ws, from)})
}

// qualityMetrics computes the 10 文档第 10 节 indicators exactly as defined there; nil means not enough data.
type qualityMetricSet struct {
	FirstAcceptRate *float64 `json:"first_accept_rate"`
	RetryRate       *float64 `json:"retry_rate"`
	AvgEditRatio    *float64 `json:"avg_edit_ratio"`
	FirstDraftHours *float64 `json:"first_draft_hours"`
	FirstDraftWorks int      `json:"first_draft_works"`
	SectionAICalls  int      `json:"section_ai_calls"`
	FeedbackSamples int      `json:"feedback_samples"`
}

func (s *Server) qualityMetrics(ctx context.Context, ws uuid.UUID, from time.Time) qualityMetricSet {
	var m qualityMetricSet
	var accepted int
	_ = s.db.QueryRow(ctx, `SELECT count(f.id) FILTER (WHERE f.outcome IS NOT NULL), count(f.id) FILTER (WHERE f.outcome='accepted'),
		avg(f.edit_ratio) FILTER (WHERE f.outcome='edited')::float8
		FROM ai_call c JOIN ai_feedback f ON f.ai_call_id=c.id
		WHERE c.workspace_id=$1 AND c.created_at >= $2 AND NOT c.is_eval`, ws, from).Scan(&m.FeedbackSamples, &accepted, &m.AvgEditRatio)
	if m.FeedbackSamples > 0 {
		r := float64(accepted) / float64(m.FeedbackSamples)
		m.FirstAcceptRate = &r
	}
	var repeated int
	_ = s.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE EXISTS (
			SELECT 1 FROM ai_call p WHERE p.workspace_id=c.workspace_id AND p.task_type=c.task_type
			AND p.context_refs->>'section_id' = c.context_refs->>'section_id'
			AND p.created_at < c.created_at AND p.created_at >= c.created_at - interval '5 minutes'))
		FROM ai_call c WHERE c.workspace_id=$1 AND c.created_at >= $2 AND NOT c.is_eval
		AND c.task_type IN ('section_draft','section_edit','section_rewrite') AND c.context_refs ? 'section_id'`, ws, from).Scan(&m.SectionAICalls, &repeated)
	if m.SectionAICalls > 0 {
		r := float64(repeated) / float64(m.SectionAICalls)
		m.RetryRate = &r
	}
	_ = s.db.QueryRow(ctx, `SELECT count(*), (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM w.first_draft_at - w.created_at) / 3600))::float8
		FROM work w JOIN platform_account a ON a.id=w.account_id
		WHERE a.workspace_id=$1 AND w.deleted_at IS NULL AND w.first_draft_at IS NOT NULL AND w.created_at >= $2`, ws, from).Scan(&m.FirstDraftWorks, &m.FirstDraftHours)
	return m
}

// qualityCalls lists recent calls of one task type for drill-down; feedback never stores body text.
func (s *Server) qualityCalls(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	task := r.URL.Query().Get("task_type")
	outcome := r.URL.Query().Get("outcome")
	rows, err := s.db.Query(ctx, `SELECT c.id, c.created_at, c.provider || ' / ' || c.model, c.latency_ms, c.prompt_tokens+c.completion_tokens,
		coalesce(f.outcome,''), f.rating, coalesce(f.reason_tags,'{}'), coalesce(f.note,''), f.edit_ratio::float8, coalesce(a.name,''), c.work_id
		FROM ai_call c LEFT JOIN ai_feedback f ON f.ai_call_id=c.id LEFT JOIN platform_account a ON a.id=c.account_id
		WHERE c.workspace_id=$1 AND NOT c.is_eval AND ($2='' OR c.task_type=$2) AND ($3='' OR f.outcome=$3 OR ($3='down' AND f.rating=-1))
		ORDER BY c.created_at DESC LIMIT 100`, ident(ctx).WorkspaceID, task, outcome)
	if err != nil {
		return err
	}
	defer rows.Close()
	type call struct {
		ID        uuid.UUID  `json:"id"`
		At        time.Time  `json:"at"`
		Model     string     `json:"model"`
		LatencyMS int        `json:"latency_ms"`
		Tokens    int        `json:"tokens"`
		Outcome   string     `json:"outcome"`
		Rating    *int       `json:"rating"`
		Reasons   []string   `json:"reasons"`
		Note      string     `json:"note"`
		EditRatio *float64   `json:"edit_ratio"`
		Account   string     `json:"account"`
		WorkID    *uuid.UUID `json:"work_id"`
	}
	list := []call{}
	for rows.Next() {
		var c call
		if err := rows.Scan(&c.ID, &c.At, &c.Model, &c.LatencyMS, &c.Tokens, &c.Outcome, &c.Rating, &c.Reasons, &c.Note, &c.EditRatio, &c.Account, &c.WorkID); err != nil {
			return err
		}
		list = append(list, c)
	}
	return ok(w, list)
}

// ---------- EX-P-01 提示词回归集 ----------

type evalSnapshot struct {
	Temperature *float64 `json:"temperature,omitempty"`
	System      string   `json:"system"`
	UserRest    string   `json:"user_rest"`
	JSON        bool     `json:"json"`
	// Private 标记最近一次调用含个人技能上下文：该记录不可共享，
	// 不保存提示词文本，保存为回归用例返回 private_context_not_shareable（7.2 节）。
	Private bool `json:"private,omitempty"`
}

type EvalCase struct {
	ID        uuid.UUID `json:"id"`
	TaskType  string    `json:"task_type"`
	Name      string    `json:"name"`
	Chars     int       `json:"chars"`
	CreatedAt time.Time `json:"created_at"`
}

func editableTask(task string) (string, bool) {
	for _, t := range editablePromptTasks {
		if t.Type == task {
			return t.Default, true
		}
	}
	return "", false
}

func (s *Server) listEvalCases(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT id, task_type, name, char_length(context_snapshot::text), created_at FROM prompt_eval_case
		WHERE workspace_id=$1 AND ($2='' OR task_type=$2) ORDER BY created_at DESC LIMIT 200`, ident(ctx).WorkspaceID, r.URL.Query().Get("task_type"))
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []EvalCase{}
	for rows.Next() {
		var c EvalCase
		if err := rows.Scan(&c.ID, &c.TaskType, &c.Name, &c.Chars, &c.CreatedAt); err != nil {
			return err
		}
		list = append(list, c)
	}
	return ok(w, list)
}

// createEvalCase snapshots the latest context the workspace used for this task type.
func (s *Server) createEvalCase(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	var in struct {
		TaskType string `json:"task_type"`
		Name     string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if _, okT := editableTask(in.TaskType); !okT {
		return validation("这个任务类型没有可编辑的提示词")
	}
	v, found := s.lastPacks.Load(ident(ctx).WorkspaceID.String() + "/" + in.TaskType)
	if !found {
		return validation("还没有这个任务最近一次的调用记录：先在编辑器里运行一次该任务，再保存为测试用例")
	}
	es := v.(evalSnapshot)
	if es.Private {
		return apiErr(409, "private_context_not_shareable", "最近一次调用包含你的个人技能，不能保存为共享回归用例")
	}
	snap, _ := json.Marshal(es)
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = taskLabel(in.TaskType) + " " + s.now().In(s.loc).Format("01-02 15:04")
	}
	var c EvalCase
	if err := s.db.QueryRow(ctx, `INSERT INTO prompt_eval_case (workspace_id, task_type, name, context_snapshot, created_by) VALUES ($1,$2,$3,$4,$5)
		RETURNING id, task_type, name, char_length(context_snapshot::text), created_at`, ident(ctx).WorkspaceID, in.TaskType, truncate(name, 60), snap, ident(ctx).UserID).
		Scan(&c.ID, &c.TaskType, &c.Name, &c.Chars, &c.CreatedAt); err != nil {
		return err
	}
	return ok(w, c)
}

func (s *Server) deleteEvalCase(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM prompt_eval_case WHERE id=$1 AND workspace_id=$2`, id, ident(ctx).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) runSnapshot(ctx context.Context, task string, snap evalSnapshot, template string) (string, error) {
	if err := s.checkLimit(ctx); err != nil {
		return "", err
	}
	rt, err := s.resolveRoute(ctx, task)
	if err != nil {
		return "", err
	}
	p := &ContextPack{System: snap.System, User: instructionBlock(template) + snap.UserRest, Temperature: snap.Temperature}
	streamed := false
	start := s.now()
	text, usage, callErr := s.callModel(ctx, rt, p, snap.JSON, nil, &streamed)
	status, errText := "ok", ""
	if callErr != nil {
		status, errText = "failed", callErr.Error()
	}
	refs, _ := json.Marshal(map[string]any{"prompt_eval": true}) // C-class：固定字面 map
	// BE-02：评测用量落库失败必须可观测；不改 callErr 上抛语义（WithoutCancel 保取消后仍记账）。
	if _, err := s.db.Exec(context.WithoutCancel(ctx), `INSERT INTO ai_call (workspace_id, task_type, provider, model, template_version, context_refs,
		prompt_tokens, completion_tokens, latency_ms, status, error, is_eval) VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,true)`,
		ident(ctx).WorkspaceID, task, rt.ProviderName, rt.Model, refs, usage.PromptTokens, usage.CompletionTokens, s.now().Sub(start).Milliseconds(), status, truncate(errText, 500)); err != nil {
		s.observeFailure(context.WithoutCancel(ctx), slog.LevelError, "提示词评测用量落库失败", observeFields{
			Action: "prompt_eval_ai_call", TargetType: "ai_call", TargetID: task,
			ErrorCode: "prompt_eval_ai_call_failed", Route: "internal/quality/run_snapshot",
			Started: start, Extras: map[string]any{"err": err.Error()},
		})
	}
	if callErr != nil {
		return "", apiErr(502, "ai_upstream_error", "模型服务调用失败："+truncate(callErr.Error(), 200))
	}
	return text, nil
}

type EvalRun struct {
	ID       uuid.UUID `json:"id"`
	CaseID   uuid.UUID `json:"case_id"`
	VersionA int       `json:"template_version_a"`
	VersionB int       `json:"template_version_b"`
	TplA     string    `json:"template_a"`
	TplB     string    `json:"template_b"`
	OutputA  string    `json:"output_a"`
	OutputB  string    `json:"output_b"`
	Verdict  *string   `json:"verdict"`
	At       time.Time `json:"created_at"`
}

const evalRunCols = `id, case_id, template_version_a, template_version_b, template_a, template_b, output_a, output_b, verdict, created_at`

func scanEvalRun(row pgx.Row) (EvalRun, error) {
	var x EvalRun
	err := row.Scan(&x.ID, &x.CaseID, &x.VersionA, &x.VersionB, &x.TplA, &x.TplB, &x.OutputA, &x.OutputB, &x.Verdict, &x.At)
	return x, err
}

// createEvalRun runs the same snapshot with the current template (A) and a candidate template (B).
func (s *Server) createEvalRun(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	var in struct {
		CaseID    uuid.UUID `json:"case_id"`
		TemplateB string    `json:"template_b"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	in.TemplateB = strings.TrimSpace(in.TemplateB)
	if in.TemplateB == "" {
		return validation("请填写要对比的新提示词")
	}
	var task string
	var raw []byte
	if err := s.db.QueryRow(ctx, `SELECT task_type, context_snapshot FROM prompt_eval_case WHERE id=$1 AND workspace_id=$2`, in.CaseID, ident(ctx).WorkspaceID).
		Scan(&task, &raw); err != nil {
		return err
	}
	var snap evalSnapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return err
	}
	tplA, verA := s.loadTaskInstruction(ctx, task)
	if tplA == "" {
		tplA, _ = editableTask(task)
		verA = 0
	}
	outA, err := s.runSnapshot(ctx, task, snap, tplA)
	if err != nil {
		return err
	}
	outB, err := s.runSnapshot(ctx, task, snap, in.TemplateB)
	if err != nil {
		return err
	}
	run, err := scanEvalRun(s.db.QueryRow(ctx, `INSERT INTO prompt_eval_run (case_id, template_version_a, template_version_b, template_a, template_b, output_a, output_b, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+evalRunCols, in.CaseID, verA, verA+1, tplA, in.TemplateB, outA, outB, ident(ctx).UserID))
	if err != nil {
		return err
	}
	return ok(w, run)
}

func (s *Server) listEvalRuns(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	rows, err := s.db.Query(ctx, `SELECT `+prefixCols(evalRunCols, "r.")+` FROM prompt_eval_run r JOIN prompt_eval_case c ON c.id=r.case_id
		WHERE r.case_id=$1 AND c.workspace_id=$2 ORDER BY r.created_at DESC LIMIT 50`, id, ident(ctx).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []EvalRun{}
	for rows.Next() {
		x, err := scanEvalRun(rows)
		if err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) patchEvalRun(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	var in struct {
		Verdict string `json:"verdict"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	switch in.Verdict {
	case "b_better", "a_better", "same":
	default:
		return validation("请选择：新的更好 / 旧的更好 / 差不多")
	}
	tag, err := s.db.Exec(ctx, `UPDATE prompt_eval_run r SET verdict=$2 FROM prompt_eval_case c WHERE r.id=$1 AND c.id=r.case_id AND c.workspace_id=$3`,
		id, in.Verdict, ident(ctx).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"ok": true})
}

// ---------- EX-N-03 前端错误上报（只进服务端日志，不含正文） ----------

var (
	uuidInPath   = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	quotedInText = regexp.MustCompile(`["'“”‘’「」][^"'“”‘’「」]*["'“”‘’「」]`)
)

// clientErrorLine strips query strings, ids and quoted fragments so a log line never carries body text.
func clientErrorLine(path, msg string) (string, string) {
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	path = truncateRunes(uuidInPath.ReplaceAllString(strings.TrimSpace(path), ":id"), 120)
	msg = truncateRunes(quotedInText.ReplaceAllString(strings.TrimSpace(msg), `"…"`), 200)
	return path, msg
}

func (s *Server) postClientError(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Message string `json:"message"`
		Path    string `json:"path"`
		Where   string `json:"where"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	path, msg := clientErrorLine(in.Path, in.Message)
	slog.Warn("前端页面出错", "user_id", ident(r.Context()).UserID, "path", path, "where", truncateRunes(in.Where, 40), "message", msg)
	return ok(w, map[string]any{"logged": true})
}

// ---------- ux_event（默认关闭，只记录事件名，不含内容） ----------

var uxEventName = regexp.MustCompile(`^[a-z0-9_.:-]{1,48}$`)

func (s *Server) postUXEvents(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	var in struct {
		Events []struct {
			Event      string `json:"event"`
			TargetType string `json:"target_type"`
		} `json:"events"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if !s.userPrefs(ctx).UXEvents {
		return ok(w, map[string]any{"recorded": 0})
	}
	id := ident(ctx)
	n := 0
	for _, e := range in.Events {
		if n >= 50 || !uxEventName.MatchString(e.Event) {
			continue
		}
		tt := e.TargetType
		if !uxEventName.MatchString(tt) {
			tt = ""
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO ux_event (user_id, workspace_id, event, target_type) VALUES ($1,$2,$3,$4)`, id.UserID, id.WorkspaceID, e.Event, tt); err == nil {
			n++
		}
	}
	return ok(w, map[string]any{"recorded": n})
}

// ---------- EX-A-03 示例账号 ----------

// 演示工作区的服务端硬闸门：示例账号只允许体验写作、检查与预览。
// 写真实平台草稿/建发布任务、录粉丝数据一律 409，不依赖前端隐藏按钮。
func demoAccountWriteError() *APIError {
	return apiErr(http.StatusConflict, "demo_account_readonly", "示例账号仅供体验写作与预览，不能写入真实平台草稿，请先绑定真实账号")
}

func demoAccountMetricError() *APIError {
	return apiErr(http.StatusConflict, "demo_account_readonly", "示例账号不记录真实账号统计数据，请先绑定真实账号")
}

// accountIsDemo 只查当前工作区，避免跨租户探测；账号不存在按 not_found 处理。
func (s *Server) accountIsDemo(ctx context.Context, accountID uuid.UUID) (bool, error) {
	var demo bool
	err := s.db.QueryRow(ctx, `SELECT is_demo FROM platform_account WHERE id=$1 AND workspace_id=$2`,
		accountID, ident(ctx).WorkspaceID).Scan(&demo)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, errNotFound
	}
	return demo, err
}

func (s *Server) importDemo(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	ws := ident(ctx).WorkspaceID
	var exists bool
	_ = s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM platform_account WHERE workspace_id=$1 AND is_demo)`, ws).Scan(&exists)
	if exists {
		return stateInvalid("示例账号已经导入过了")
	}
	type demoSample struct{ title, content string }
	type demoMaterial struct{ kind, content, source string }
	type demoTopic struct{ title, angle string }
	type demoSection struct{ heading, content string }
	var wechatAccountID, xhsAccountID uuid.UUID
	err := s.withTx(ctx, func(q pgx.Tx) error {
		insertProfile := func(accountID uuid.UUID, tags []string, audience, tone string, banned []string, style string) error {
			_, err := q.Exec(ctx, `INSERT INTO account_profile (account_id, positioning_tags, target_audience, persona_tone, banned_words, style_summary)
				VALUES ($1, $2, $3, $4, $5, $6)`, accountID, tags, audience, tone, banned, style)
			return err
		}
		insertSamples := func(accountID uuid.UUID, list []demoSample) error {
			for _, x := range list {
				if _, err := q.Exec(ctx, `INSERT INTO style_sample (account_id, title, content_md, char_count) VALUES ($1,$2,$3,$4)`,
					accountID, x.title, x.content, runeLen(x.content)); err != nil {
					return err
				}
			}
			return nil
		}
		insertMaterials := func(accountID uuid.UUID, list []demoMaterial) error {
			for _, m := range list {
				if _, err := q.Exec(ctx, `INSERT INTO material (workspace_id, account_id, kind, content, source, tags) VALUES ($1,$2,$3,$4,$5,$6)`,
					ws, accountID, m.kind, m.content, m.source, []string{"示例"}); err != nil {
					return err
				}
			}
			return nil
		}
		insertTopics := func(accountID uuid.UUID, list []demoTopic) error {
			for _, t := range list {
				if _, err := q.Exec(ctx, `INSERT INTO topic (account_id, title, angle, source) VALUES ($1,$2,$3,'manual')`,
					accountID, t.title, t.angle); err != nil {
					return err
				}
			}
			return nil
		}
		insertSections := func(workID uuid.UUID, list []demoSection) error {
			for i, x := range list {
				if _, err := q.Exec(ctx, `INSERT INTO work_section (work_id, position, heading, key_point, content_md) VALUES ($1,$2,$3,$4,$5)`,
					workID, i, x.heading, x.heading, x.content); err != nil {
					return err
				}
			}
			return nil
		}

		// 示例账号 1：个人公众号（长图文）——原有体验数据，选题补到 2 条。
		if err := q.QueryRow(ctx, `INSERT INTO platform_account (workspace_id, platform, name, content_format, is_demo) VALUES ($1,'wechat_mp','示例 · 职场成长笔记','long_article',true) RETURNING id`,
			ws).Scan(&wechatAccountID); err != nil {
			return err
		}
		if err := insertProfile(wechatAccountID, []string{"职场成长", "效率方法", "沟通"},
			"工作 1–5 年、想提升效率和沟通能力的职场人", "像一位有经验的同事，真诚、具体、不说教",
			[]string{"颠覆", "躺赚"}, "短段落，多用具体场景开头，结尾给一个可执行的小建议。"); err != nil {
			return err
		}
		if err := insertSamples(wechatAccountID, []demoSample{
			{"我用一张表管住了一周的会议", "上周三下午，我连开了四个会。回到工位时，才发现上午答应同事的方案还没动。\n\n后来我做了一张很简单的表：会议名、我要带走的结论、下一步谁负责。只写这三列。\n\n一周下来，我推掉了两个和我关系不大的会，剩下的会平均缩短了十分钟。"},
			{"写周报之前，先问自己三个问题", "很多人写周报像记流水账。其实读周报的人只关心三件事：做成了什么、卡在哪里、需要谁帮忙。\n\n先把这三个问题的答案写在最前面，再补细节。你会发现，周报从半小时缩短到了十分钟。"},
		}); err != nil {
			return err
		}
		if err := insertMaterials(wechatAccountID, []demoMaterial{
			{"experience", "第一次带项目时，我每天晚上十点还在回消息，后来把沟通集中到上午十点和下午四点两个时段，加班明显少了。", "作者经历"},
			{"opinion", "会议的价值不在于开了多久，而在于散会时每个人是否清楚自己的下一步。", "作者观点"},
			{"case", "某团队把周会从 60 分钟改为 25 分钟站会，只同步阻塞事项，其余内容改为文档异步更新。", "示例案例（演示数据）"},
			{"data", "【演示数据】一项内部问卷中，有 6 成受访者认为自己每周至少有 3 个会议可以不参加。", "示例数据（演示用，非真实统计）"},
			{"opinion", "写给别人看的文字，先写结论，再写理由。", "作者观点"},
		}); err != nil {
			return err
		}
		if err := insertTopics(wechatAccountID, []demoTopic{
			{"写给新人的第一份周报模板", "用三个问题替代流水账"},
			{"开会前，先想清楚这三件事", "从会前准备切入，减少无效会议"},
		}); err != nil {
			return err
		}
		wechatOutline, _ := json.Marshal([]map[string]string{
			{"heading": "为什么会议越开越多", "key_point": "会议是默认选项，取消它需要理由"},
			{"heading": "一张表的三列", "key_point": "结论、下一步、负责人"},
			{"heading": "从今天开始的小动作", "key_point": "散会前 2 分钟确认下一步"},
		})
		var wechatWorkID uuid.UUID
		if err := q.QueryRow(ctx, `INSERT INTO work (account_id, content_format, title, viewpoint, outline, outline_confirmed_at, theme, status)
			VALUES ($1,'long_article','开会前，先想好散会时要带走什么','会议的价值在于散会后每个人都知道自己的下一步',$2,now(),'ink','drafting') RETURNING id`,
			wechatAccountID, wechatOutline).Scan(&wechatWorkID); err != nil {
			return err
		}
		if err := insertSections(wechatWorkID, []demoSection{
			{"为什么会议越开越多", "你有没有算过，自己一周有多少时间花在会议上？\n\n会议之所以越开越多，是因为\"开个会吧\"是最省事的默认选项，而取消一个会需要理由。"},
			{"一张表的三列", "我现在每个会只记三列：结论、下一步、负责人。\n\n没有结论的会，下次就可以考虑改成文档沟通。"},
			{"从今天开始的小动作", "下次开会，试试在散会前留 2 分钟，让每个人说一句自己的下一步。\n\n你会发现，会议真正开始有用了。"},
		}); err != nil {
			return err
		}

		// 示例账号 2：小红书（图文短笔记）——用于体验快写、检查与预览，带标题、观点、短正文与话题。
		if err := q.QueryRow(ctx, `INSERT INTO platform_account (workspace_id, platform, name, content_format, is_demo) VALUES ($1,'xhs','示例 · 效率工具手账','image_note',true) RETURNING id`,
			ws).Scan(&xhsAccountID); err != nil {
			return err
		}
		if err := insertProfile(xhsAccountID, []string{"效率工具", "时间管理", "自我提升"},
			"想把日子过得更顺手的职场新人和学生", "像朋友分享刚试过的小工具，口语化、不夸张",
			[]string{"最牛", "绝对"}, "开头一句话给结论，中间写具体用法，结尾一句踩坑提醒；每段不超过 4 行。"); err != nil {
			return err
		}
		if err := insertSamples(xhsAccountID, []demoSample{
			{"我的桌面只留三样东西", "先说结论：桌面只放今天要用的东西，其他都收进抽屉。\n\n我试了两周，找东西的时间明显少了。具体做法是：左手边只放水杯和便签，右手边只放正在用的本子。\n\n如果你也总是找不到笔，先从一个抽屉开始收拾。"},
			{"通勤 20 分钟能做完的三件小事", "把通勤时间固定成三件事：回一条该回的消息、列今天的三个重点、听一段有用的内容。\n\n不用全部做完，能做到一件，这一天就没白开始。"},
		}); err != nil {
			return err
		}
		if err := insertMaterials(xhsAccountID, []demoMaterial{
			{"experience", "我常用的待办模板只有三列：今天必须做、今天可以推、今天不做。", "作者经验"},
			{"experience", "早上最容易浪费时间的是找东西，把钥匙、工卡、耳机固定在门口一个小盘子里，出门速度快很多。", "作者经历"},
			{"opinion", "工具不是越多越好，能坚持用两周的才值得留下。", "作者观点"},
		}); err != nil {
			return err
		}
		if err := insertTopics(xhsAccountID, []demoTopic{
			{"3 个让早晨更顺手的桌面小习惯", "从每天都会碰到的小动作切入，给可立即照做的三步"},
			{"我用了两周的待办清单模板", "只保留三列，减少选择成本"},
		}); err != nil {
			return err
		}
		xhsOutline, _ := json.Marshal([]map[string]string{
			{"heading": "先把桌面清出一条直线", "key_point": "正前方只留今天要用的东西"},
			{"heading": "常用的三样东西固定位置", "key_point": "钥匙、工卡、耳机各有一个家"},
			{"heading": "给明天留一张便签", "key_point": "便签只写明天第一件事"},
		})
		var xhsWorkID uuid.UUID
		if err := q.QueryRow(ctx, `INSERT INTO work (account_id, content_format, title, viewpoint, outline, outline_confirmed_at, topics, theme, status)
			VALUES ($1,'image_note','3 个让早晨更顺手的桌面小习惯','把常用的东西固定放在同一个位置，比买新的收纳工具更有效。',$2,now(),$3,'ink','drafting') RETURNING id`,
			xhsAccountID, xhsOutline, []string{"效率工具", "桌面整理", "打工人日常"}).Scan(&xhsWorkID); err != nil {
			return err
		}
		return insertSections(xhsWorkID, []demoSection{
			{"先把桌面清出一条直线", "早上坐下来，先把正前方清出一条能放下电脑和本子的空位。\n\n其他东西先推到一边，等晚上再收。"},
			{"常用的三样东西固定位置", "钥匙、工卡、耳机，各给一个固定的位置。\n\n刚开始可以贴一张小标签，一周后就不用看了。"},
			{"给明天留一张便签", "下班前写一句明天第一件事，早上坐下就知道从哪开始。\n\n便签只写一件，不要写清单。"},
		})
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "demo_import", "platform_account", wechatAccountID.String(), "ok", map[string]any{"xhs_account_id": xhsAccountID.String()})
	return ok(w, map[string]any{
		"account_id":     wechatAccountID,
		"xhs_account_id": xhsAccountID,
		"account_ids":    []uuid.UUID{wechatAccountID, xhsAccountID},
	})
}

func (s *Server) clearDemo(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT id FROM platform_account WHERE workspace_id=$1 AND is_demo`, ident(ctx).WorkspaceID)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(ctx, `DELETE FROM material WHERE account_id=$1`, id); err != nil {
			return err
		}
		if err := s.hardDeleteAccount(ctx, id); err != nil {
			return err
		}
	}
	s.audit(ctx, "demo_clear", "platform_account", "", "ok", map[string]any{"count": len(ids)})
	return ok(w, map[string]any{"cleared": len(ids)})
}

// ---------- EX-G-01 账号自定义主题（只含 SP-02 允许的内联基础样式） ----------

type CustomTheme struct {
	Base         string  `json:"base"`
	PrimaryColor string  `json:"primary_color"`
	FontSize     int     `json:"font_size"`
	LineHeight   float64 `json:"line_height"`
	ParagraphGap int     `json:"paragraph_gap"`
	HeadingStyle string  `json:"heading_style"`
	QuoteStyle   string  `json:"quote_style"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func customThemePrimaryContrastRatio(color string) float64 {
	channels := [3]float64{}
	for i, offset := range []int{1, 3, 5} {
		value, _ := strconv.ParseUint(color[offset:offset+2], 16, 8)
		channel := float64(value) / 255
		if channel <= 0.04045 {
			channels[i] = channel / 12.92
		} else {
			channels[i] = math.Pow((channel+0.055)/1.055, 2.4)
		}
	}
	luminance := channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722
	return 1.05 / (luminance + 0.05)
}

func (t *CustomTheme) validate() error {
	if t.Base == "" {
		t.Base = "ink"
	}
	if !hexColor.MatchString(t.PrimaryColor) {
		return validation("主色需要是 #RRGGBB 格式")
	}
	if customThemePrimaryContrastRatio(t.PrimaryColor) < 4.5 {
		return validation("主色与白色背景的文字对比度不足 4.5:1")
	}
	if t.FontSize < 14 || t.FontSize > 17 {
		return validation("正文字号需在 14–17px 之间")
	}
	if t.LineHeight < 1.4 || t.LineHeight > 2.2 {
		return validation("行距需在 1.4–2.2 之间")
	}
	if t.ParagraphGap < 8 || t.ParagraphGap > 32 {
		return validation("段间距需在 8–32px 之间")
	}
	switch t.HeadingStyle {
	case "plain", "underline", "bar", "block":
	default:
		return validation("标题样式无效")
	}
	switch t.QuoteStyle {
	case "bar", "box", "italic":
	default:
		return validation("引用样式无效")
	}
	return nil
}

func (s *Server) getCustomTheme(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var raw []byte
	if err := s.db.QueryRow(r.Context(), `SELECT custom_theme FROM account_profile WHERE account_id=$1`, a.ID).Scan(&raw); err != nil {
		return err
	}
	if len(raw) == 0 {
		return ok(w, nil)
	}
	var t CustomTheme
	_ = json.Unmarshal(raw, &t)
	return ok(w, t)
}

func (s *Server) putCustomTheme(w http.ResponseWriter, r *http.Request) error {
	a, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	var t *CustomTheme
	if err := decode(r, &t); err != nil {
		return err
	}
	var raw []byte
	if t != nil {
		if err := t.validate(); err != nil {
			return err
		}
		raw, _ = json.Marshal(t)
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE account_profile SET custom_theme=$2, updated_at=now() WHERE account_id=$1`, a.ID, raw); err != nil {
		return err
	}
	s.invalidateContextPackCache(r.Context(), a.ID)
	return ok(w, t)
}

// ---------- EX-G-02 排版建议（规则优先，逐条应用） ----------

type LayoutSuggestion struct {
	SectionID uuid.UUID `json:"section_id"`
	Kind      string    `json:"kind"`
	Text      string    `json:"text"`
	Reason    string    `json:"reason"`
}

var (
	keySentence = regexp.MustCompile(`[^。！？\n]*(关键是|本质上|核心是|说到底|记住|真正重要的是)[^。！？\n]*[。！？]?`)
	enumMarker  = regexp.MustCompile(`(第[一二三四五六七八九十]|首先|其次|最后|[1-9][.、])`)
)

func layoutRules(sectionID uuid.UUID, content string, golden []string) []LayoutSuggestion {
	out := []LayoutSuggestion{}
	for _, g := range golden {
		g = strings.TrimSpace(g)
		if g == "" || !strings.Contains(content, g) || strings.Contains(content, "**"+g) {
			continue
		}
		out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "bold", Text: g, Reason: "这是你收藏的金句，加粗后更醒目"})
	}
	for _, m := range keySentence.FindAllString(content, 3) {
		m = strings.TrimSpace(m)
		if m == "" || strings.Contains(content, "**"+m) || runeLen(m) > 60 {
			continue
		}
		out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "bold", Text: m, Reason: "这是观点句，加粗便于读者抓重点"})
	}
	for _, para := range strings.Split(content, "\n\n") {
		if strings.HasPrefix(strings.TrimSpace(para), "-") {
			continue
		}
		if len(enumMarker.FindAllString(para, -1)) >= 3 {
			out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "list", Text: strings.TrimSpace(para), Reason: "这段有 3 个以上的并列要点，改成列表更清楚"})
		}
	}
	if runeLen(content) > 800 && !strings.Contains(content, "\n---\n") {
		paras := strings.Split(content, "\n\n")
		if len(paras) >= 4 {
			out = append(out, LayoutSuggestion{SectionID: sectionID, Kind: "divider", Text: strings.TrimSpace(paras[len(paras)/2]), Reason: "这段较长，在中间加分割线可以让阅读喘口气"})
		}
	}
	return out
}

// layoutSuggest: rules first; with {"ai":true} the model adds ideas, each quoting a sentence that exists verbatim.
func (s *Server) layoutSuggest(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		AI bool `json:"ai"`
	}
	if err := decodeOptional(r, &in); err != nil {
		return err
	}
	ctx := r.Context()
	var golden []string
	_ = s.db.QueryRow(ctx, `SELECT golden_sentences FROM work WHERE id=$1`, m.ID).Scan(&golden)
	rows, err := s.db.Query(ctx, `SELECT id, content_md FROM work_section WHERE work_id=$1 AND deleted_at IS NULL ORDER BY position`, m.ID)
	if err != nil {
		return err
	}
	type sec struct {
		id      uuid.UUID
		content string
	}
	var secs []sec
	list := []LayoutSuggestion{}
	for rows.Next() {
		var x sec
		if rows.Scan(&x.id, &x.content) == nil {
			secs = append(secs, x)
			list = append(list, layoutRules(x.id, x.content, golden)...)
		}
	}
	rows.Close()
	resp := map[string]any{}
	if in.AI && len(secs) > 0 {
		var b strings.Builder
		for i, x := range secs {
			fmt.Fprintf(&b, "### 第 %d 段\n%s\n\n", i+1, truncate(x.content, 1200))
		}
		user := b.String() + `## 任务说明
找出最多 5 处排版可以改进的地方：适合加粗的句子（bold）、适合改成列表的并列要点（list）、适合加分割线的位置（divider）。
text 必须原样摘自上面的正文，不改写、不新增内容；只给排版建议，不改文字。

## 输出格式
只输出 JSON：{"suggestions":[{"section":1,"kind":"bold","text":"原文句子","reason":"理由"}]}`
		var out struct {
			Suggestions []struct {
				Section int    `json:"section"`
				Kind    string `json:"kind"`
				Text    string `json:"text"`
				Reason  string `json:"reason"`
			} `json:"suggestions"`
		}
		res, err := s.runAIJSON(ctx, aiTask{Type: "layout_suggest", Account: m.Account, WorkID: &m.ID, User: user, SkipStyle: true, Tier: "economy"}, &out, nil)
		if err != nil {
			resp["ai_error"] = errText(err)
		} else {
			resp["ai_call_id"] = res.CallID
			seen := map[string]bool{}
			for _, x := range list {
				seen[x.Kind+x.Text] = true
			}
			for _, sg := range out.Suggestions {
				if sg.Section < 1 || sg.Section > len(secs) || (sg.Kind != "bold" && sg.Kind != "list" && sg.Kind != "divider") {
					continue
				}
				text := strings.TrimSpace(sg.Text)
				target := secs[sg.Section-1]
				if text == "" || !strings.Contains(target.content, text) || seen[sg.Kind+text] {
					continue
				}
				seen[sg.Kind+text] = true
				list = append(list, LayoutSuggestion{SectionID: target.id, Kind: sg.Kind, Text: text, Reason: nz(strings.TrimSpace(sg.Reason), "AI 建议") + "（AI）"})
			}
		}
	}
	if len(list) > 20 {
		list = list[:20]
	}
	resp["suggestions"] = list
	return ok(w, resp)
}

// saveGoldenSentence keeps one picked quote candidate so layout suggestions can propose bolding it (EX-E-08 / EX-G-02).
func (s *Server) saveGoldenSentence(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	var in struct {
		Text   string `json:"text"`
		Remove bool   `json:"remove"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	text := strings.TrimSpace(in.Text)
	if text == "" || runeLen(text) > 80 {
		return validation("金句不能为空，也不要超过 80 字")
	}
	sql := `UPDATE work SET golden_sentences = array_append(array_remove(golden_sentences, $2), $2) WHERE id=$1 RETURNING golden_sentences`
	if in.Remove {
		sql = `UPDATE work SET golden_sentences = array_remove(golden_sentences, $2) WHERE id=$1 RETURNING golden_sentences`
	}
	var list []string
	if err := s.db.QueryRow(r.Context(), sql, m.ID, text).Scan(&list); err != nil {
		return err
	}
	if len(list) > 30 {
		list = list[len(list)-30:]
		if err := s.writeGoldenSentences(r.Context(), m.ID, list); err != nil {
			return err
		}
	}
	return ok(w, map[string]any{"golden_sentences": list})
}

// writeGoldenSentences：金句裁剪落库。失败 Error 可观测并上抛（BE-02）。
func (s *Server) writeGoldenSentences(ctx context.Context, workID uuid.UUID, list []string) error {
	if _, err := s.db.Exec(ctx, `UPDATE work SET golden_sentences=$2 WHERE id=$1`, workID, list); err != nil {
		s.observeFailure(ctx, slog.LevelError, "金句列表裁剪落库失败", observeFields{
			Action: "golden_sentences_trim", TargetType: "work", TargetID: workID.String(),
			ErrorCode: "golden_sentences_trim_failed", Route: "/works/{id}/golden-sentences",
			Extras: map[string]any{"err": err.Error()},
		})
		return err
	}
	return nil
}

// ---------- EX-H-04 检查报告 ----------

func (s *Server) checkReport(w http.ResponseWriter, r *http.Request) error {
	m, err := s.workMetaFromPath(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	var runID uuid.UUID
	var revision int
	var platform string
	var at time.Time
	// 与 loadLatestCheck 同口径：修订号优先，避免数据库时钟回拨时取到旧运行。
	if err := s.db.QueryRow(ctx, `SELECT id, revision, target_platform, created_at FROM check_run WHERE work_id=$1 ORDER BY revision DESC, created_at DESC LIMIT 1`, m.ID).
		Scan(&runID, &revision, &platform, &at); err != nil {
		return validation("这篇作品还没有做过发布前检查")
	}
	rows, err := s.db.Query(ctx, `SELECT ci.category, ci.passed, ci.message, ci.matched_text, coalesce(ci.resolution,''), ci.resolved_at, coalesce(u.username,'')
		FROM check_item ci LEFT JOIN app_user u ON u.id=ci.resolved_by WHERE ci.check_run_id=$1 ORDER BY ci.passed, ci.category, ci.created_at`, runID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type item struct {
		Category   string     `json:"category"`
		Passed     bool       `json:"passed"`
		Message    string     `json:"message"`
		Matched    string     `json:"matched_text"`
		Resolution string     `json:"resolution"`
		ResolvedAt *time.Time `json:"resolved_at"`
		ResolvedBy string     `json:"resolved_by"`
	}
	items := []item{}
	for rows.Next() {
		var x item
		if err := rows.Scan(&x.Category, &x.Passed, &x.Message, &x.Matched, &x.Resolution, &x.ResolvedAt, &x.ResolvedBy); err != nil {
			return err
		}
		items = append(items, x)
	}
	var reviewer string
	var reviewedAt *time.Time
	_ = s.db.QueryRow(ctx, `SELECT coalesce(u.username,''), w.reviewed_at FROM work w LEFT JOIN app_user u ON u.id=w.reviewed_by WHERE w.id=$1`, m.ID).Scan(&reviewer, &reviewedAt)
	return ok(w, map[string]any{
		"work":  map[string]any{"id": m.ID, "title": m.Title, "account": m.Account.Name, "status": m.Status},
		"run":   map[string]any{"id": runID, "revision": revision, "platform": platform, "content_format": m.ContentFormat, "at": at},
		"items": items, "reviewer": reviewer, "reviewed_at": reviewedAt,
		"generated_at": s.now(), "generated_by": ident(ctx).Username,
		"summary": fmt.Sprintf("共 %d 项", len(items)),
	})
}
