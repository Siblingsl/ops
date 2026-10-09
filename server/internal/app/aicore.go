package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

// systemRules are shared by every task and cannot be edited (06 文档第 5.8 节).
const systemRules = `你是一位帮助内容创作者写作的助手。你只辅助，不替代作者表达。必须遵守：
1. 不编造数据、案例、引语、人物和机构；需要具体数据而素材中没有时，写成"【待核实：需要的内容】"占位，由作者补充。
2. 只使用作者提供的素材作为事实来源，不虚构作者的亲身经历。
3. 不模仿可识别的他人作品或作者风格；只模仿本账号的风格样本。
4. 不使用账号禁用词；不使用"最、第一、绝对"等绝对化表达，除非素材中有依据。
5. 按指定的输出格式输出，不加额外说明。`

var platformNames = map[string]string{"wechat_mp": "公众号", "xhs": "小红书"}
var formatNames = map[string]string{"long_article": "长图文", "image_note": "图文笔记", "comic": "漫画"}

type aiTask struct {
	Type      string
	Account   *Account
	WorkID    *uuid.UUID
	User      string
	JSON      bool
	Refs      map[string]any
	SkipStyle bool
}

type aiResult struct {
	Text   string
	Usage  ai.Usage
	CallID uuid.UUID
	Refs   map[string]any
}

type route struct {
	ProviderName string
	BaseURL      string
	APIKey       string
	Model        string
}

func (s *Server) resolveRoute(ctx context.Context, taskType string) (*route, error) {
	var rt route
	var enc []byte
	ws := ident(ctx).WorkspaceID
	err := s.db.QueryRow(ctx, `SELECT p.name, p.base_url, p.api_key_enc, r.model FROM model_route r
		JOIN model_provider p ON p.id=r.provider_id
		WHERE r.workspace_id=$1 AND p.workspace_id=$1 AND r.task_type = ANY($2) AND p.status='active'
		ORDER BY (r.task_type='default') LIMIT 1`, ws, []string{taskType, "default"}).Scan(&rt.ProviderName, &rt.BaseURL, &enc, &rt.Model)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiErr(503, "ai_not_configured", "还没有配置模型，请先到「设置 → 模型配置」添加模型并指定默认模型")
	}
	if err != nil {
		return nil, err
	}
	rt.APIKey, err = s.box.Decrypt(enc)
	if err != nil {
		return nil, err
	}
	return &rt, nil
}

type aiLimit struct {
	Enabled     bool `json:"enabled"`
	DailyTokens int  `json:"daily_tokens"`
}

func (s *Server) loadLimit(ctx context.Context) aiLimit {
	l := aiLimit{Enabled: false, DailyTokens: 2000000}
	var raw []byte
	if id := ident(ctx); id != nil {
		if err := s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='ai_limit'`, id.WorkspaceID).Scan(&raw); err == nil {
			_ = json.Unmarshal(raw, &l)
		}
	}
	return l
}

func (s *Server) checkLimit(ctx context.Context) error {
	l := s.loadLimit(ctx)
	if !l.Enabled {
		return nil
	}
	var used int
	if err := s.db.QueryRow(ctx, `SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM ai_call WHERE created_at >= $1`, s.today()).Scan(&used); err != nil {
		return err
	}
	if used >= l.DailyTokens {
		return apiErr(429, "ai_quota_exceeded", fmt.Sprintf("今天的 AI 用量已达到你设置的上限（%d token）。编辑、检查和推送不受影响，可在设置中调整上限。", l.DailyTokens))
	}
	return nil
}

func (s *Server) styleContext(ctx context.Context, accountID uuid.UUID, summary string) (string, int, error) {
	if strings.TrimSpace(summary) != "" {
		return "风格摘要：\n" + summary, 0, nil
	}
	rows, err := s.db.Query(ctx, `SELECT title, content_md FROM style_sample WHERE account_id=$1 AND deleted_at IS NULL
		ORDER BY created_at DESC LIMIT 10`, accountID)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	var b strings.Builder
	n, budget := 0, 4000
	for rows.Next() {
		var title, content string
		if err := rows.Scan(&title, &content); err != nil {
			return "", 0, err
		}
		excerpt := []rune(content)
		if len(excerpt) > 800 {
			excerpt = excerpt[:800]
		}
		if budget-len(excerpt) < 0 {
			break
		}
		budget -= len(excerpt)
		n++
		fmt.Fprintf(&b, "《%s》片段：\n%s\n\n", title, string(excerpt))
	}
	if n == 0 {
		return "", 0, nil
	}
	return "风格样本（只模仿语气、句式和结构，不复用其中的事实）：\n" + b.String(), n, nil
}

func (s *Server) systemPrompt(ctx context.Context, a *Account, skipStyle bool) (string, map[string]any, error) {
	p, err := s.loadProfile(ctx, a.ID)
	if err != nil {
		return "", nil, err
	}
	refs := map[string]any{"profile": true}
	var b strings.Builder
	b.WriteString(systemRules)
	fmt.Fprintf(&b, "\n\n## 账号定位档案\n平台：%s；内容形态：%s；账号名：%s\n", platformNames[a.Platform], formatNames[a.ContentFormat], a.Name)
	if len(p.PositioningTags) > 0 {
		fmt.Fprintf(&b, "定位标签：%s\n", strings.Join(p.PositioningTags, "、"))
	}
	if p.TargetAudience != "" {
		fmt.Fprintf(&b, "目标读者：%s\n", p.TargetAudience)
	}
	if p.PersonaTone != "" {
		fmt.Fprintf(&b, "人设与语气：%s\n", p.PersonaTone)
	}
	if len(p.BannedWords) > 0 {
		fmt.Fprintf(&b, "禁用词（不得出现）：%s\n", strings.Join(p.BannedWords, "、"))
	}
	if !skipStyle {
		style, n, err := s.styleContext(ctx, a.ID, p.StyleSummary)
		if err != nil {
			return "", nil, err
		}
		if style != "" {
			b.WriteString("\n## 风格参考\n" + style)
		}
		refs["style_samples"] = n
		refs["style_summary"] = p.StyleSummary != ""
	}
	return b.String(), refs, nil
}

// runAI executes one task, records ai_call, and streams deltas when onDelta is set.
func (s *Server) runAI(ctx context.Context, t aiTask, onDelta func(string)) (*aiResult, error) {
	if err := s.checkLimit(ctx); err != nil {
		return nil, err
	}
	rt, err := s.resolveRoute(ctx, t.Type)
	if err != nil {
		return nil, err
	}
	sys, refs, err := s.systemPrompt(ctx, t.Account, t.SkipStyle)
	if err != nil {
		return nil, err
	}
	for k, v := range t.Refs {
		refs[k] = v
	}
	user := t.User + "\n\n任务：" + t.Type
	start := time.Now()
	text, usage, callErr := ai.Stream(ctx, s.aiHTTP, ai.Request{
		BaseURL: rt.BaseURL, APIKey: rt.APIKey, Model: rt.Model, JSON: t.JSON,
		Messages: []ai.Message{{Role: "system", Content: sys}, {Role: "user", Content: user}},
	}, onDelta)
	status, errText := "ok", ""
	if callErr != nil {
		status, errText = "failed", callErr.Error()
		if ctx.Err() != nil {
			status = "cancelled"
		}
	}
	refsJSON, _ := json.Marshal(refs)
	var callID uuid.UUID
	var accountID *uuid.UUID
	if t.Account != nil {
		accountID = &t.Account.ID
	}
	if err := s.db.QueryRow(context.WithoutCancel(ctx), `INSERT INTO ai_call (account_id, work_id, task_type, provider, model, context_refs,
		prompt_tokens, completion_tokens, latency_ms, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
		accountID, t.WorkID, t.Type, rt.ProviderName, rt.Model, refsJSON, usage.PromptTokens, usage.CompletionTokens,
		time.Since(start).Milliseconds(), status, truncate(errText, 500)).Scan(&callID); err != nil {
		return nil, err
	}
	if callErr != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, apiErr(502, "ai_upstream_error", "模型服务调用失败："+truncate(callErr.Error(), 300)+"。原有内容没有被覆盖，可以重试。")
	}
	return &aiResult{Text: text, Usage: usage, CallID: callID, Refs: refs}, nil
}

// runAIJSON runs a structured task, validating the JSON and retrying once (06 文档第 5.8 节).
func (s *Server) runAIJSON(ctx context.Context, t aiTask, out any, validate func() error) (*aiResult, error) {
	t.JSON = true
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		res, err := s.runAI(ctx, t, nil)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(ai.ExtractJSON(res.Text)), out); err != nil {
			last = err
			continue
		}
		if validate != nil {
			if err := validate(); err != nil {
				last = err
				continue
			}
		}
		return res, nil
	}
	return nil, apiErr(502, "ai_output_invalid", "模型返回的内容格式不正确（已重试一次），请再试一次或更换模型。").With(truncate(fmt.Sprint(last), 200))
}

// streamAI runs a text task over SSE: delta events, then done with refs.
func (s *Server) streamAI(w http.ResponseWriter, r *http.Request, t aiTask, onDone func(text string, res *aiResult) (any, error)) error {
	if err := s.checkLimit(r.Context()); err != nil {
		return err
	}
	if _, err := s.resolveRoute(r.Context(), t.Type); err != nil {
		return err
	}
	sse := newSSE(w)
	res, err := s.runAI(r.Context(), t, func(d string) { sse.send("delta", map[string]string{"text": d}) })
	if err != nil {
		if r.Context().Err() == nil {
			sse.fail(err)
		}
		return nil
	}
	var extra any
	if onDone != nil {
		extra, err = onDone(res.Text, res)
		if err != nil {
			sse.fail(err)
			return nil
		}
	}
	sse.send("done", map[string]any{"text": res.Text, "ai_call_id": res.CallID, "usage": res.Usage, "refs": res.Refs, "result": extra})
	return nil
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// materialsBlock lists selected materials so the model can cite only them (D-014).
func (s *Server) materialsBlock(ctx context.Context, ids []uuid.UUID) (string, []string, error) {
	if len(ids) == 0 {
		return "", nil, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, kind, content, source FROM material WHERE id = ANY($1) AND workspace_id=$2 AND deleted_at IS NULL`,
		ids, ident(ctx).WorkspaceID)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	var b strings.Builder
	var names []string
	kinds := map[string]string{"experience": "经历", "opinion": "观点", "case": "案例", "data": "数据"}
	for rows.Next() {
		var id uuid.UUID
		var kind, content, source string
		if err := rows.Scan(&id, &kind, &content, &source); err != nil {
			return "", nil, err
		}
		fmt.Fprintf(&b, "- [素材 id=%s][%s] %s", id, kinds[kind], content)
		if source != "" {
			fmt.Fprintf(&b, "（来源：%s）", source)
		}
		b.WriteString("\n")
		names = append(names, truncate(content, 16))
	}
	if b.Len() == 0 {
		return "", nil, nil
	}
	return "## 作者提供的素材（唯一的事实来源）\n" + b.String(), names, nil
}
