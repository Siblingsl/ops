package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
	"ops/internal/secure"
)

// ---------- 模型配置（P-22） ----------

// Capability is one saved self-test result (16 文档第 7.2 节), keyed by provider + model.
type Capability struct {
	Model    string     `json:"model"`
	ToolsOK  *bool      `json:"tools_ok"`
	VisionOK *bool      `json:"vision_ok"`
	TestedAt *time.Time `json:"tested_at"`
}

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
	CircuitState   string     `json:"circuit_state"`
	RetryAfter     int        `json:"retry_after_seconds"`
	// Capabilities lists the per-model tool-calling / vision self-test results.
	Capabilities []Capability `json:"capabilities"`
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
	p.CircuitState, p.RetryAfter = s.providerCircuitStatus(p.ID)
	p.Capabilities = []Capability{}
	return &p, nil
}

func (s *Server) listProviders(w http.ResponseWriter, r *http.Request) error {
	ws := ident(r.Context()).WorkspaceID
	rows, err := s.db.Query(r.Context(), `SELECT `+providerCols+` FROM model_provider WHERE workspace_id=$1 ORDER BY created_at`, ws)
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
	if err := rows.Err(); err != nil {
		return err
	}
	if err := s.attachCapabilities(r.Context(), ws, list); err != nil {
		return err
	}
	return ok(w, list)
}

// attachCapabilities fills each provider's capabilities from model_capability (16 文档第 7.2 节第 3 项).
func (s *Server) attachCapabilities(ctx context.Context, ws uuid.UUID, list []*Provider) error {
	if len(list) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT provider_id, model, tools_ok, vision_ok, tested_at FROM model_capability WHERE workspace_id=$1 ORDER BY model`, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	byProvider := map[uuid.UUID][]Capability{}
	for rows.Next() {
		var pid uuid.UUID
		var c Capability
		if err := rows.Scan(&pid, &c.Model, &c.ToolsOK, &c.VisionOK, &c.TestedAt); err != nil {
			return err
		}
		byProvider[pid] = append(byProvider[pid], c)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range list {
		if caps := byProvider[p.ID]; caps != nil {
			p.Capabilities = caps
		}
	}
	return nil
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
	// Assign maps a quick-setup role (route task type) to one of Models; only empty routes are written (DEV-UX01).
	Assign map[string]string `json:"assign"`
}

// quickRoles are the routes the quick setup may fill: main model, the two cost tiers and screenshot recognition.
var quickRoles = map[string]string{"default": "主力模型", "tier_economy": "经济档", "tier_quality": "质量档", "metric_screenshot": "图片识别"}

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
	if len(in.Assign) > 0 && !create {
		return validation("只能在添加供应商时一并指定用途")
	}
	models := cleanList(in.Models)
	for role, m := range in.Assign {
		if _, ok := quickRoles[role]; !ok {
			return validation("未知的模型用途：" + role)
		}
		if m = strings.TrimSpace(m); m != "" && !containsStr(models, m) {
			return validation(fmt.Sprintf("%s「%s」不在可用模型里", quickRoles[role], m))
		}
	}
	return nil
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
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
	ws := ident(ctx).WorkspaceID
	var p *Provider
	assigned, kept := []string{}, []string{}
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var err error
		p, err = s.scanProvider(tx.QueryRow(ctx, `INSERT INTO model_provider (workspace_id, name, base_url, api_key_enc, key_version, models,
			price_per_1k_prompt, price_per_1k_completion) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+providerCols,
			ws, strings.TrimSpace(*in.Name), *in.BaseURL, enc, s.box.Version, cleanList(in.Models), priceArg(in.PricePrompt), priceArg(in.PriceComplete)))
		if err != nil {
			return err
		}
		for _, role := range []string{"default", "tier_economy", "tier_quality", "metric_screenshot"} {
			m := strings.TrimSpace(in.Assign[role])
			if m == "" {
				continue
			}
			tag, err := tx.Exec(ctx, `INSERT INTO model_route (workspace_id, task_type, provider_id, model) VALUES ($1,$2,$3,$4)
				ON CONFLICT (workspace_id, task_type) DO NOTHING`, ws, role, p.ID, m)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 1 {
				assigned = append(assigned, role)
			} else {
				kept = append(kept, role)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.audit(ctx, "model_provider_create", "model_provider", p.ID.String(), "ok", map[string]any{"name": p.Name, "base_url": p.BaseURL, "assigned": assigned})
	return ok(w, struct {
		*Provider
		Assigned []string `json:"assigned"`
		Kept     []string `json:"kept"`
	}{p, assigned, kept})
}

// aiStatus tells any member whether AI is usable and which optional routes exist, so the UI can warn before a call fails.
func (s *Server) aiStatus(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	var routes []string
	var tokens int
	err := s.db.QueryRow(ctx, `SELECT ARRAY(SELECT r.task_type FROM model_route r JOIN model_provider p ON p.id=r.provider_id
		WHERE r.workspace_id=$1 AND p.workspace_id=$1 AND p.status='active' AND r.task_type = ANY($2)),
		(SELECT coalesce(sum(prompt_tokens+completion_tokens),0) FROM ai_call WHERE workspace_id=$1 AND created_at >= $3)`,
		ident(ctx).WorkspaceID, []string{"default", "metric_screenshot", "image_gen"}, s.today()).Scan(&routes, &tokens)
	if err != nil {
		return err
	}
	set := map[string]bool{}
	for _, task := range routes {
		set[task] = true
	}
	return ok(w, map[string]any{"ready": set["default"], "vision_route": set["metric_screenshot"], "image_route": set["image_gen"], "tokens_today": tokens})
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
		// D-117（16 文档第 7.2 节第 2 项）：改地址或密钥时能力记录清空为未测试；删除模型时删除对应记录。
		if in.BaseURL != nil || in.APIKey != nil {
			if _, err := tx.Exec(ctx, `DELETE FROM model_capability WHERE provider_id=$1 AND workspace_id=$2`, id, ws); err != nil {
				return err
			}
		} else if in.Models != nil {
			if _, err := tx.Exec(ctx, `DELETE FROM model_capability WHERE provider_id=$1 AND workspace_id=$2 AND NOT (model = ANY($3))`, id, ws, cleanList(in.Models)); err != nil {
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
	s.providerMu.Lock()
	delete(s.providerCircuits, id)
	s.providerMu.Unlock()
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
	text, _, _, _, callErr := ai.Stream(tctx, s.aiHTTP, ai.Request{BaseURL: base, APIKey: key, Model: model,
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
	{"agent_chat", "智能体对话"},
	{"agent_summary", "智能体摘要"},
	{"embedding", "向量检索（embedding）"},
	{"tier_economy", "经济档（覆盖各任务）"},
	{"tier_quality", "质量档（覆盖各任务）"},
}

func taskLabel(taskType string) string {
	if taskType == "hot_search" {
		return "原生联网搜索" // 服务商与模型由热点来源配置。
	}
	if taskType == "image_alt" {
		return "图片替代文字建议"
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
