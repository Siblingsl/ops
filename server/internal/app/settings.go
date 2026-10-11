package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
	"ops/internal/secure"
)

// ---------- 模型配置（P-22） ----------

type Provider struct {
	ID             uuid.UUID  `json:"id"`
	Name           string     `json:"name"`
	BaseURL        string     `json:"base_url"`
	KeyMask        string     `json:"key_mask"`
	Models         []string   `json:"models"`
	Status         string     `json:"status"`
	LastTestAt     *time.Time `json:"last_test_at"`
	LastTestOK     *bool      `json:"last_test_ok"`
	LastTestResult string     `json:"last_test_result"`
	PricePrompt    *float64   `json:"price_per_1k_prompt"`
	PriceComplete  *float64   `json:"price_per_1k_completion"`
}

const providerCols = `id, name, base_url, api_key_enc, models, status, last_test_at, last_test_ok, last_test_result,
	price_per_1k_prompt::float8, price_per_1k_completion::float8`

func (s *Server) scanProvider(row pgx.Row) (*Provider, error) {
	var p Provider
	var enc []byte
	if err := row.Scan(&p.ID, &p.Name, &p.BaseURL, &enc, &p.Models, &p.Status, &p.LastTestAt, &p.LastTestOK, &p.LastTestResult,
		&p.PricePrompt, &p.PriceComplete); err != nil {
		return nil, err
	}
	if key, err := s.box.Decrypt(enc); err == nil {
		p.KeyMask = secure.Mask(key)
	}
	return &p, nil
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Query(r.Context(), `SELECT `+providerCols+` FROM model_provider WHERE workspace_id=$1 ORDER BY created_at`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []*Provider{}
	for rows.Next() {
		p, err := s.scanProvider(rows)
		if err != nil {
			return err
		}
		list = append(list, p)
	}
	return ok(w, list)
}

type providerInput struct {
	Name    *string  `json:"name"`
	BaseURL *string  `json:"base_url"`
	APIKey  *string  `json:"api_key"`
	Models  []string `json:"models"`
	Status  *string  `json:"status"`
	// Prices are optional; a negative value clears the price.
	PricePrompt   *float64 `json:"price_per_1k_prompt"`
	PriceComplete *float64 `json:"price_per_1k_completion"`
}

func priceArg(p *float64) any {
	if p == nil || *p < 0 {
		return nil
	}
	return *p
}

func (in *providerInput) validate(create bool) error {
	if create && (in.Name == nil || in.BaseURL == nil || in.APIKey == nil || len(cleanList(in.Models)) == 0) {
		return validation("请填写名称、接口地址、API 密钥和至少一个模型名")
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		return validation("名称不能为空")
	}
	if in.BaseURL != nil {
		u := strings.TrimRight(strings.TrimSpace(*in.BaseURL), "/")
		if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			return validation("接口地址需要以 http:// 或 https:// 开头，例如 https://api.example.com/v1")
		}
		*in.BaseURL = u
	}
	if in.APIKey != nil && strings.TrimSpace(*in.APIKey) == "" {
		return validation("API 密钥不能为空")
	}
	if in.Status != nil && *in.Status != "active" && *in.Status != "disabled" {
		return validation("状态不正确")
	}
	return nil
}

func (s *Server) createProvider(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	if err := s.requireReauth(ctx); err != nil {
		return err
	}
	var in providerInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.validate(true); err != nil {
		return err
	}
	enc, err := s.box.Encrypt(strings.TrimSpace(*in.APIKey))
	if err != nil {
		return err
	}
	p, err := s.scanProvider(s.db.QueryRow(ctx, `INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models,
		price_per_1k_prompt, price_per_1k_completion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+providerCols,
		ident(ctx).WorkspaceID, strings.TrimSpace(*in.Name), *in.BaseURL, enc, s.box.Version, cleanList(in.Models), priceArg(in.PricePrompt), priceArg(in.PriceComplete)))
	if err != nil {
		return err
	}
	s.audit(ctx, "model_provider_create", "model_provider", p.ID.String(), "ok", map[string]any{"name": p.Name, "base_url": p.BaseURL})
	return ok(w, p)
}

func (s *Server) updateProvider(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	ws := ident(ctx).WorkspaceID
	var in providerInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.validate(false); err != nil {
		return err
	}
	if in.APIKey != nil || in.BaseURL != nil {
		if err := s.requireReauth(ctx); err != nil {
			return err
		}
	}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM model_provider WHERE id=$1 AND workspace_id=$2`, id, ws).Scan(&n); err != nil || n == 0 {
			if err != nil {
				return err
			}
			return errNotFound
		}
		if in.Name != nil {
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET name=$2 WHERE id=$1 AND workspace_id=$3`, id, strings.TrimSpace(*in.Name), ws); err != nil {
				return err
			}
		}
		if in.BaseURL != nil {
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET base_url=$2 WHERE id=$1 AND workspace_id=$3`, id, *in.BaseURL, ws); err != nil {
				return err
			}
		}
		if in.APIKey != nil {
			enc, err := s.box.Encrypt(strings.TrimSpace(*in.APIKey))
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET api_key_enc=$2, key_version=$3, last_test_ok=NULL, last_test_result='' WHERE id=$1 AND workspace_id=$4`, id, enc, s.box.Version, ws); err != nil {
				return err
			}
		}
		if in.Models != nil {
			models := cleanList(in.Models)
			if len(models) == 0 {
				return validation("至少保留一个模型名")
			}
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET models=$2 WHERE id=$1 AND workspace_id=$3`, id, models, ws); err != nil {
				return err
			}
		}
		if in.Status != nil {
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET status=$2 WHERE id=$1 AND workspace_id=$3`, id, *in.Status, ws); err != nil {
				return err
			}
		}
		if in.PricePrompt != nil {
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET price_per_1k_prompt=$2 WHERE id=$1 AND workspace_id=$3`, id, priceArg(in.PricePrompt), ws); err != nil {
				return err
			}
		}
		if in.PriceComplete != nil {
			if _, err := tx.Exec(ctx, `UPDATE model_provider SET price_per_1k_completion=$2 WHERE id=$1 AND workspace_id=$3`, id, priceArg(in.PriceComplete), ws); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE model_provider SET updated_at=now() WHERE id=$1 AND workspace_id=$2`, id, ws)
		return err
	})
	if err != nil {
		return err
	}
	p, err := s.scanProvider(s.db.QueryRow(ctx, `SELECT `+providerCols+` FROM model_provider WHERE id=$1 AND workspace_id=$2`, id, ws))
	if err != nil {
		return err
	}
	s.audit(ctx, "model_provider_update", "model_provider", id.String(), "ok", map[string]any{"key_changed": in.APIKey != nil})
	return ok(w, p)
}

func (s *Server) deleteProvider(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	ws := ident(ctx).WorkspaceID
	var routes int
	_ = s.db.QueryRow(ctx, `SELECT count(*) FROM model_route WHERE provider_id=$1 AND workspace_id=$2`, id, ws).Scan(&routes)
	var in struct{ Confirm bool }
	_ = decode(r, &in)
	if routes > 0 && !in.Confirm {
		return apiErr(409, "confirm_required", fmt.Sprintf("有 %d 个任务正在使用这个供应商，删除后这些任务会改用默认模型（如果默认模型也是它，AI 功能将不可用）。", routes))
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM model_provider WHERE id=$1 AND workspace_id=$2`, id, ws)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(ctx, "model_provider_delete", "model_provider", id.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) testProvider(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	ctx := r.Context()
	if err := s.requireOwner(ctx); err != nil {
		return err
	}
	ws := ident(ctx).WorkspaceID
	var in struct {
		Model string `json:"model"`
	}
	_ = decode(r, &in)
	var base string
	var enc []byte
	var models []string
	if err := s.db.QueryRow(ctx, `SELECT base_url, api_key_enc, models FROM model_provider WHERE id=$1 AND workspace_id=$2`, id, ws).Scan(&base, &enc, &models); err != nil {
		return err
	}
	key, err := s.box.Decrypt(enc)
	if err != nil {
		return err
	}
	model := in.Model
	if model == "" && len(models) > 0 {
		model = models[0]
	}
	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	start := time.Now()
	text, _, callErr := ai.Stream(tctx, s.aiHTTP, ai.Request{BaseURL: base, APIKey: key, Model: model,
		Messages: []ai.Message{{Role: "user", Content: "请只回复：连接正常\n\n任务：connectivity_test"}}}, nil)
	elapsed := time.Since(start).Milliseconds()
	okFlag := callErr == nil
	result := fmt.Sprintf("模型 %s 连接正常，耗时 %d 毫秒", model, elapsed)
	if !okFlag {
		result = strings.ReplaceAll(callErr.Error(), key, "****")
		result = truncate(result, 300)
	}
	if _, err := s.db.Exec(ctx, `UPDATE model_provider SET last_test_at=now(), last_test_ok=$2, last_test_result=$3 WHERE id=$1 AND workspace_id=$4`, id, okFlag, result, ws); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": okFlag, "result": result, "latency_ms": elapsed, "reply": truncate(text, 50)})
}

var taskTypes = []struct{ Type, Label string }{
	{"default", "默认模型"},
	{"topic_suggest", "选题建议"},
	{"topic_hot_suggest", "热点选题"},
	{"outline", "大纲生成"},
	{"section_draft", "分段起稿"},
	{"section_edit", "改写 / 扩写 / 缩写"},
	{"title", "标题候选"},
	{"summary", "摘要生成"},
	{"fact_flag", "事实核查标注"},
	{"rewrite_plan", "改写规划"},
	{"section_rewrite", "分段改写"},
	{"review_analysis", "AI 复盘"},
	{"style_summary", "风格摘要"},
	{"comic_storyboard", "漫画分镜"},
	{"comic_panel_text", "漫画逐格文案"},
	{"comic_rewrite", "漫画派生改写"},
	{"image_suggest", "配图建议"},
	{"image_gen", "AI 出图"},
	{"organize_notes", "要点整理"},
	{"section_continue", "行内续写"},
	{"hook_suggest", "开头钩子"},
	{"outline_review", "大纲体检"},
	{"copilot_chat", "副驾驶对话"},
	{"read_through", "整篇通读"},
	{"polish_check", "表达体检"},
	{"fix_suggest", "检查项改法建议"},
	{"topic_score", "选题评分"},
	{"profile_bootstrap", "智能建档"},
	{"account_positioning", "账号运营方案"},
	{"strategy_revise", "运营方案调整"},
	{"strategy_outline", "内容大纲建议"},
	{"hot_relevance", "热点相关度"},
	{"daily_recommend", "每日推荐"},
	{"reference_analyze", "参考方法提炼"},
	{"material_extract", "素材提炼"},
	{"material_tag", "素材标签"},
	{"inbox_triage", "收件箱整理"},
	{"memory_distill", "记忆提炼"},
	{"tag_suggest", "话题推荐"},
	{"review_attribution", "归因解读"},
	{"work_breakdown", "作品拆解"},
	{"weekly_digest", "周报"},
	{"metric_screenshot", "数据截图识别（需选支持图片输入的模型）"},
	{"layout_suggest", "排版建议"},
	{"embedding", "向量检索（embedding）"},
	{"tier_economy", "经济档（覆盖各任务）"},
	{"tier_quality", "质量档（覆盖各任务）"},
}

func taskLabel(taskType string) string {
	if taskType == "hot_search" {
		return "原生联网搜索" // 服务商与模型由热点来源配置。
	}
	for _, t := range taskTypes {
		if t.Type == taskType {
			return t.Label
		}
	}
	return taskType
}

func (s *Server) getRoutes(w http.ResponseWriter, r *http.Request) error {
	type Route struct {
		TaskType           string     `json:"task_type"`
		Label              string     `json:"label"`
		ProviderID         *uuid.UUID `json:"provider_id"`
		Model              string     `json:"model"`
		FallbackProviderID *uuid.UUID `json:"fallback_provider_id"`
		FallbackModel      string     `json:"fallback_model"`
	}
	routes := map[string]Route{}
	rows, err := s.db.Query(r.Context(), `SELECT task_type, provider_id, model, fallback_provider_id, fallback_model FROM model_route WHERE workspace_id=$1`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var rt Route
		var pid uuid.UUID
		if err := rows.Scan(&rt.TaskType, &pid, &rt.Model, &rt.FallbackProviderID, &rt.FallbackModel); err == nil {
			rt.ProviderID = &pid
			routes[rt.TaskType] = rt
		}
	}
	rows.Close()
	list := []Route{}
	for _, t := range taskTypes {
		rt := routes[t.Type]
		rt.TaskType, rt.Label = t.Type, t.Label
		list = append(list, rt)
	}
	return ok(w, list)
}

func (s *Server) putRoutes(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in []struct {
		TaskType           string     `json:"task_type"`
		ProviderID         *uuid.UUID `json:"provider_id"`
		Model              string     `json:"model"`
		FallbackProviderID *uuid.UUID `json:"fallback_provider_id"`
		FallbackModel      string     `json:"fallback_model"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	valid := map[string]bool{}
	for _, t := range taskTypes {
		valid[t.Type] = true
	}
	ctx := r.Context()
	ws := ident(ctx).WorkspaceID
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		for _, rt := range in {
			if !valid[rt.TaskType] {
				return validation("未知的任务类型：" + rt.TaskType)
			}
			if rt.ProviderID == nil || strings.TrimSpace(rt.Model) == "" {
				if _, err := tx.Exec(ctx, `DELETE FROM model_route WHERE workspace_id=$1 AND task_type=$2`, ws, rt.TaskType); err != nil {
					return err
				}
				continue
			}
			var models []string
			if err := tx.QueryRow(ctx, `SELECT models FROM model_provider WHERE id=$1 AND workspace_id=$2`, *rt.ProviderID, ws).Scan(&models); err != nil {
				return validation("供应商不存在")
			}
			fbModel := strings.TrimSpace(rt.FallbackModel)
			fbProvider := rt.FallbackProviderID
			if fbProvider == nil || fbModel == "" {
				fbProvider, fbModel = nil, ""
			} else {
				var n int
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM model_provider WHERE id=$1 AND workspace_id=$2`, *fbProvider, ws).Scan(&n); err != nil || n == 0 {
					return validation("备用模型的供应商不存在")
				}
			}
			if _, err := tx.Exec(ctx, `INSERT INTO model_route (workspace_id, task_type, provider_id, model, fallback_provider_id, fallback_model) VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (workspace_id, task_type) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
				fallback_provider_id=excluded.fallback_provider_id, fallback_model=excluded.fallback_model`,
				ws, rt.TaskType, *rt.ProviderID, strings.TrimSpace(rt.Model), fbProvider, fbModel); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "model_routes_update", "model_route", "", "ok", nil)
	return s.getRoutes(w, r)
}

// ---------- AI 用量（P-18） ----------

// adoptedExpr is the "首次采纳" definition: accepted as-is, or kept after a small (< 30%) edit.
const adoptedExpr = `f.outcome='accepted' OR (f.outcome='edited' AND coalesce(f.edit_ratio, 1) < 0.3)`

func (s *Server) usage(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	to := s.today().AddDate(0, 0, 1)
	from := to.AddDate(0, 0, -30)
	if v, err := time.ParseInLocation("2006-01-02", q.Get("from"), s.loc); err == nil {
		from = v
	}
	if v, err := time.ParseInLocation("2006-01-02", q.Get("to"), s.loc); err == nil {
		to = v.AddDate(0, 0, 1)
	}
	groups := map[string]string{
		"day": `to_char(c.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`,
		"task": `CASE WHEN c.is_eval THEN 'prompt_eval'
			WHEN c.task_type='section_edit' AND c.context_refs->>'variants'='3' THEN 'section_edit_variants' ELSE c.task_type END`,
		"model":   `c.provider || ' / ' || c.model`,
		"account": `coalesce(a.name, '（无账号）')`,
	}
	g := q.Get("group_by")
	expr, okG := groups[g]
	if !okG {
		g, expr = "day", groups["day"]
	}
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `SELECT `+expr+` AS k, count(*), coalesce(sum(c.prompt_tokens),0), coalesce(sum(c.completion_tokens),0),
		count(*) FILTER (WHERE c.status<>'ok'),
		sum(c.prompt_tokens/1000.0*p.price_per_1k_prompt + c.completion_tokens/1000.0*coalesce(p.price_per_1k_completion, p.price_per_1k_prompt))::float8,
		count(f.id) FILTER (WHERE `+adoptedExpr+`), count(f.id) FILTER (WHERE f.outcome IS NOT NULL)
		FROM ai_call c LEFT JOIN platform_account a ON a.id=c.account_id
		LEFT JOIN model_provider p ON p.workspace_id=c.workspace_id AND p.name=c.provider
		LEFT JOIN ai_feedback f ON f.ai_call_id=c.id
		WHERE c.workspace_id=$3 AND c.created_at >= $1 AND c.created_at < $2 GROUP BY k ORDER BY k`, from, to, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	type Row struct {
		Key              string   `json:"key"`
		Calls            int      `json:"calls"`
		PromptTokens     int      `json:"prompt_tokens"`
		CompletionTokens int      `json:"completion_tokens"`
		Failed           int      `json:"failed"`
		Cost             *float64 `json:"cost"`
		Accepted         int      `json:"accepted"`
		WithFeedback     int      `json:"with_feedback"`
		AdoptionRate     *float64 `json:"adoption_rate"`
	}
	list := []Row{}
	total := Row{Key: "合计"}
	labels := map[string]string{}
	for _, t := range taskTypes {
		labels[t.Type] = t.Label
	}
	labels["connectivity_test"] = "连通测试"
	labels["hot_search"] = "原生联网搜索"
	labels["prompt_eval"] = "提示词对比测试（不计入质量统计）"
	labels["section_edit_variants"] = "段落改写（三个候选）"
	for rows.Next() {
		var x Row
		if err := rows.Scan(&x.Key, &x.Calls, &x.PromptTokens, &x.CompletionTokens, &x.Failed, &x.Cost, &x.Accepted, &x.WithFeedback); err != nil {
			return err
		}
		if g == "task" && labels[x.Key] != "" {
			x.Key = labels[x.Key]
		}
		if x.WithFeedback > 0 {
			rate := float64(x.Accepted) / float64(x.WithFeedback)
			x.AdoptionRate = &rate
		}
		total.Calls += x.Calls
		total.PromptTokens += x.PromptTokens
		total.CompletionTokens += x.CompletionTokens
		total.Failed += x.Failed
		total.Accepted += x.Accepted
		total.WithFeedback += x.WithFeedback
		if x.Cost != nil {
			c := *x.Cost
			if total.Cost != nil {
				c += *total.Cost
			}
			total.Cost = &c
		}
		list = append(list, x)
	}
	if total.WithFeedback > 0 {
		rate := float64(total.Accepted) / float64(total.WithFeedback)
		total.AdoptionRate = &rate
	}
	today := s.tokensToday(r.Context())
	return ok(w, map[string]any{"group_by": g, "from": from.Format("2006-01-02"), "to": to.AddDate(0, 0, -1).Format("2006-01-02"),
		"rows": list, "total": total, "today_tokens": today, "limit": s.loadLimit(r.Context())})
}

// ---------- 全局设置 ----------

const trashDays = 30

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) error {
	smtp, err := s.loadSMTPPublic(r.Context())
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"ai_limit": s.loadLimit(r.Context()), "trash_days": trashDays, "version": Version,
		"smtp": smtp, "review_weekly_draft": s.weeklyDraftSetting(r.Context(), ident(r.Context()).WorkspaceID),
	})
}

// weeklyDraftSetting is review.weekly_draft (14 文档 4.6 第 2 条): "off" unless the owner turned it on.
func (s *Server) weeklyDraftSetting(ctx context.Context, ws uuid.UUID) string {
	var v string
	if err := s.db.QueryRow(ctx, `SELECT value #>> '{}' FROM app_setting WHERE workspace_id=$1 AND key='review_weekly_draft'`, ws).Scan(&v); err != nil || v != "on" {
		return "off"
	}
	return "on"
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		AILimit     *aiLimit    `json:"ai_limit"`
		SMTP        *smtpConfig `json:"smtp"`
		WeeklyDraft *string     `json:"review_weekly_draft"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ws := ident(r.Context()).WorkspaceID
	if in.WeeklyDraft != nil {
		v := *in.WeeklyDraft
		if v != "on" && v != "off" {
			return validation("每周复盘草稿只能是 on 或 off")
		}
		b, _ := json.Marshal(v)
		if _, err := s.db.Exec(r.Context(), `INSERT INTO app_setting (workspace_id, key, value) VALUES ($1,'review_weekly_draft',$2)
			ON CONFLICT (workspace_id, key) DO UPDATE SET value=excluded.value`, ws, b); err != nil {
			return err
		}
		s.audit(r.Context(), "settings_update", "app_setting", "review_weekly_draft", "ok", map[string]any{"value": v})
	}
	if in.AILimit != nil {
		if in.AILimit.DailyTokens < 1000 {
			return validation("每日上限至少 1000 token")
		}
		b, _ := json.Marshal(in.AILimit)
		if _, err := s.db.Exec(r.Context(), `INSERT INTO app_setting (workspace_id, key, value) VALUES ($1,'ai_limit',$2)
			ON CONFLICT (workspace_id, key) DO UPDATE SET value=excluded.value`, ws, b); err != nil {
			return err
		}
		s.audit(r.Context(), "settings_update", "app_setting", "ai_limit", "ok", map[string]any{"enabled": in.AILimit.Enabled, "daily_tokens": in.AILimit.DailyTokens})
	}
	if in.SMTP != nil {
		cur, _ := s.loadSMTP(r.Context())
		port := in.SMTP.Port
		if port <= 0 {
			port = 587
		}
		passEnc := cur.passEnc
		if p := strings.TrimSpace(in.SMTP.Password); p != "" {
			enc, err := s.box.Encrypt(p)
			if err != nil {
				return err
			}
			passEnc = base64.StdEncoding.EncodeToString(enc)
		}
		stored := map[string]any{
			"host": strings.TrimSpace(in.SMTP.Host), "port": port,
			"username": strings.TrimSpace(in.SMTP.Username), "from": strings.TrimSpace(in.SMTP.From),
			"password_enc": passEnc,
		}
		b, _ := json.Marshal(stored)
		if _, err := s.db.Exec(r.Context(), `INSERT INTO app_setting (workspace_id, key, value) VALUES ($1,'smtp',$2)
			ON CONFLICT (workspace_id, key) DO UPDATE SET value=excluded.value`, ws, b); err != nil {
			return err
		}
		s.audit(r.Context(), "settings_update", "app_setting", "smtp", "ok", map[string]any{"host": stored["host"], "from": stored["from"]})
	}
	return s.getSettings(w, r)
}

func (s *Server) loadSMTP(ctx context.Context) (smtpConfig, error) {
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT value FROM app_setting WHERE workspace_id=$1 AND key='smtp'`, ident(ctx).WorkspaceID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return smtpConfig{}, nil
	}
	if err != nil {
		return smtpConfig{}, err
	}
	var stored struct {
		Host        string `json:"host"`
		Port        int    `json:"port"`
		Username    string `json:"username"`
		From        string `json:"from"`
		PasswordEnc string `json:"password_enc"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		return smtpConfig{}, err
	}
	cfg := smtpConfig{Host: stored.Host, Port: stored.Port, Username: stored.Username, From: stored.From, passEnc: stored.PasswordEnc}
	if stored.PasswordEnc != "" {
		enc, err := base64.StdEncoding.DecodeString(stored.PasswordEnc)
		if err == nil {
			if plain, err := s.box.Decrypt(enc); err == nil {
				cfg.Password = plain
				cfg.HasPass = true
			}
		}
	}
	return cfg, nil
}

func (s *Server) loadSMTPPublic(ctx context.Context) (smtpConfig, error) {
	cfg, err := s.loadSMTP(ctx)
	if err != nil {
		return smtpConfig{}, err
	}
	cfg.Password = ""
	return cfg, nil
}

// ---------- 敏感词库（P-17） ----------

func (s *Server) listWords(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Query(r.Context(), `SELECT id, word, category, source, created_at FROM sensitive_word WHERE workspace_id=$1 ORDER BY source, created_at DESC`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type Word struct {
		ID        uuid.UUID `json:"id"`
		Word      string    `json:"word"`
		Category  string    `json:"category"`
		Source    string    `json:"source"`
		CreatedAt time.Time `json:"created_at"`
	}
	list := []Word{}
	for rows.Next() {
		var x Word
		if err := rows.Scan(&x.ID, &x.Word, &x.Category, &x.Source, &x.CreatedAt); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

func (s *Server) createWord(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		Words    []string `json:"words"`
		Category string   `json:"category"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	words := cleanList(in.Words)
	if len(words) == 0 {
		return validation("请输入敏感词")
	}
	added := 0
	for _, wd := range words {
		if runeLen(wd) > 50 {
			return validation("单个敏感词不超过 50 字")
		}
		tag, err := s.db.Exec(r.Context(), `INSERT INTO sensitive_word (workspace_id, word, category, source) VALUES ($1,$2,$3,'custom') ON CONFLICT DO NOTHING`,
			ident(r.Context()).WorkspaceID, wd, strings.TrimSpace(in.Category))
		if err != nil {
			return err
		}
		added += int(tag.RowsAffected())
	}
	return ok(w, map[string]int{"added": added, "skipped": len(words) - added})
}

func (s *Server) deleteWord(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `DELETE FROM sensitive_word WHERE id=$1 AND workspace_id=$2 AND source='custom'`, id, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return validation("基础词库只读，不能删除")
	}
	return ok(w, map[string]any{"ok": true})
}

// ---------- 操作日志（P-19） ----------

func (s *Server) auditLogs(w http.ResponseWriter, r *http.Request) error {
	q := r.URL.Query()
	args := []any{}
	where := "1=1"
	if a := q.Get("action"); a != "" {
		args = append(args, a+"%")
		where += fmt.Sprintf(" AND l.action LIKE $%d", len(args))
	}
	if b := q.Get("before"); b != "" {
		if t, err := time.Parse(time.RFC3339Nano, b); err == nil {
			args = append(args, t)
			where += fmt.Sprintf(" AND l.created_at < $%d", len(args))
		}
	}
	limit := queryInt(r, "limit", 50)
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.Query(r.Context(), `SELECT l.id, l.action, l.target_type, l.target_id, l.result, l.detail, l.created_at, m.username
		FROM audit_log l LEFT JOIN app_user m ON m.id=l.actor_id WHERE `+where+fmt.Sprintf(` ORDER BY l.created_at DESC LIMIT %d`, limit), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	type Log struct {
		ID         uuid.UUID       `json:"id"`
		Action     string          `json:"action"`
		TargetType string          `json:"target_type"`
		TargetID   string          `json:"target_id"`
		Result     string          `json:"result"`
		Detail     json.RawMessage `json:"detail"`
		CreatedAt  time.Time       `json:"created_at"`
		Actor      *string         `json:"actor"`
	}
	list := []Log{}
	for rows.Next() {
		var x Log
		if err := rows.Scan(&x.ID, &x.Action, &x.TargetType, &x.TargetID, &x.Result, &x.Detail, &x.CreatedAt, &x.Actor); err != nil {
			return err
		}
		list = append(list, x)
	}
	return ok(w, list)
}

// ---------- 回收站（P-23） ----------

var trashTables = map[string]struct{ table, title, account string }{
	"work":           {"work", "nullif(t.title,'')", "t.account_id"},
	"topic":          {"topic", "t.title", "t.account_id"},
	"material":       {"material", "left(t.content, 40)", "t.account_id"},
	"style_sample":   {"style_sample", "t.title", "t.account_id"},
	"character_card": {"character_card", "t.name", "t.account_id"},
	"reference":      {"reference_item", "t.title", "t.account_id"},
}

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) error {
	type Item struct {
		Type        string    `json:"type"`
		ID          uuid.UUID `json:"id"`
		Title       string    `json:"title"`
		AccountName *string   `json:"account_name"`
		DeletedAt   time.Time `json:"deleted_at"`
		DaysLeft    int       `json:"days_left"`
	}
	list := []Item{}
	ws := ident(r.Context()).WorkspaceID
	types := []string{"work", "topic", "material", "style_sample", "character_card", "reference"}
	if t := r.URL.Query().Get("type"); t != "" {
		if _, okT := trashTables[t]; !okT {
			return validation("未知的类型")
		}
		types = []string{t}
	}
	for _, typ := range types {
		def := trashTables[typ]
		scope := `a.workspace_id=$1`
		if typ == "material" {
			scope = `t.workspace_id=$1`
		}
		rows, err := s.db.Query(r.Context(), `SELECT t.id, coalesce(`+def.title+`, '（无标题）'), a.name, t.deleted_at FROM `+def.table+` t
			LEFT JOIN platform_account a ON a.id=`+def.account+` WHERE t.deleted_at IS NOT NULL AND `+scope+` ORDER BY t.deleted_at DESC`, ws)
		if err != nil {
			return err
		}
		for rows.Next() {
			it := Item{Type: typ}
			if err := rows.Scan(&it.ID, &it.Title, &it.AccountName, &it.DeletedAt); err != nil {
				rows.Close()
				return err
			}
			it.DaysLeft = max(0, trashDays-int(s.now().Sub(it.DeletedAt).Hours()/24))
			list = append(list, it)
		}
		rows.Close()
	}
	return ok(w, list)
}

func (s *Server) trashTarget(r *http.Request) (string, uuid.UUID, error) {
	typ := chiParam(r, "type")
	def, okT := trashTables[typ]
	if !okT {
		return "", uuid.Nil, validation("未知的类型")
	}
	id, err := pathID(r, "id")
	if err != nil {
		return "", uuid.Nil, err
	}
	var x uuid.UUID
	q := `SELECT t.id FROM ` + def.table + ` t JOIN platform_account a ON a.id=t.account_id WHERE t.id=$1 AND a.workspace_id=$2 AND t.deleted_at IS NOT NULL`
	if typ == "material" {
		q = `SELECT id FROM material t WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NOT NULL`
	}
	if err := s.db.QueryRow(r.Context(), q, id, ident(r.Context()).WorkspaceID).Scan(&x); err != nil {
		return "", uuid.Nil, err
	}
	return typ, id, nil
}

func (s *Server) restoreTrash(w http.ResponseWriter, r *http.Request) error {
	typ, id, err := s.trashTarget(r)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE `+trashTables[typ].table+` SET deleted_at=NULL WHERE id=$1`, id); err != nil {
		return err
	}
	s.audit(r.Context(), "trash_restore", typ, id.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (s *Server) purgeTrash(w http.ResponseWriter, r *http.Request) error {
	typ, id, err := s.trashTarget(r)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("confirm") != "true" {
		return apiErr(409, "confirm_required", "彻底删除后无法恢复，请确认。")
	}
	if err := s.purge(r.Context(), typ, id); err != nil {
		return err
	}
	s.audit(r.Context(), "trash_purge", typ, id.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

// purge removes a soft-deleted row and, for works, its image files.
func (s *Server) purge(ctx context.Context, typ string, id uuid.UUID) error {
	var dir string
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		switch typ {
		case "work":
			if _, err := tx.Exec(ctx, `UPDATE work SET source_work_id=NULL WHERE source_work_id=$1`, id); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE work SET cover_asset_id=NULL WHERE id=$1`, id); err != nil {
				return err
			}
			dir = filepath.Join(s.cfg.DataDir, "assets", id.String())
		case "topic":
			if _, err := tx.Exec(ctx, `UPDATE work SET topic_id=NULL WHERE topic_id=$1`, id); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `DELETE FROM `+trashTables[typ].table+` WHERE id=$1 AND deleted_at IS NOT NULL`, id)
		return err
	})
	if err != nil {
		return err
	}
	if dir != "" {
		_ = os.RemoveAll(dir)
	}
	return nil
}
