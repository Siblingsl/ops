package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// REF41 F4（docs/41 §F4）：采集自学习（分阶段）。首版"记录 + 建议"：
// 桌面采集失败上报结构化 parser_event（设备证明 + 10 分钟窗口去重 + 批量 ≤20）；
// 同 platform+field 7 天失败 ≥3 生成规则模板 parser_recipe 草稿；人工 verify/activate；
// 配方不自动改 desktop/src/platform 适配器（F4-A5）。

// parserEventInput 是单条失败样本。
type parserEventInput struct {
	Platform       string          `json:"platform"`
	AdapterVersion string          `json:"adapter_version"`
	PageURL        string          `json:"page_url"`
	PageHash       string          `json:"page_hash"`
	Field          string          `json:"field"`
	ErrorCode      string          `json:"error_code"`
	SampleAssetID  *uuid.UUID      `json:"sample_asset_id"`
	Detail         json.RawMessage `json:"detail"`
}

// parserEventsIngest POST /desktop/parser-events（设备证明 operation=platform.parser.events）。
// 批量 ≤20；同 workspace+platform+field+error_code+page_hash 10 分钟内去重。
func (s *Server) parserEventsIngest(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuardlessDesktopGuard(id); err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "platform.parser.events")
	if err != nil {
		return err
	}
	var in struct {
		Events []parserEventInput `json:"events"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return apiErr(http.StatusUnprocessableEntity, "invalid_body", "请求体不是合法 JSON")
	}
	if len(in.Events) < 1 || len(in.Events) > 20 {
		return apiErr(http.StatusUnprocessableEntity, "parser_events_limit", "批量上报需要 1–20 条")
	}
	ctx := r.Context()
	// 归属：当前会话的活动平台连接（与评论上报同口径）；无连接时事件仍可上报为
	// 系统级（account_id NULL），workspace 取会话工作区。
	var accountID *uuid.UUID
	var connPlatform string
	err = s.db.QueryRow(ctx, `SELECT account_id, platform FROM platform_connection
		WHERE user_id=$1 AND workspace_id=$2 AND state='active' LIMIT 1`,
		id.UserID, id.WorkspaceID).Scan(&accountID, &connPlatform)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	inserted := 0
	for i := range in.Events {
		ev := &in.Events[i]
		ev.Platform = strings.TrimSpace(ev.Platform)
		ev.ErrorCode = strings.TrimSpace(ev.ErrorCode)
		if ev.Platform == "" || runeLen(ev.ErrorCode) < 1 || runeLen(ev.ErrorCode) > 80 {
			return validationFields("每条事件需要 platform 与 1–80 字 error_code", map[string]string{"events": "invalid"})
		}
		if runeLen(ev.Field) > 80 || runeLen(ev.PageURL) > 500 || runeLen(ev.PageHash) > 128 || runeLen(ev.AdapterVersion) > 60 {
			return validationFields("field/page_url/page_hash/adapter_version 超长", map[string]string{"events": "invalid"})
		}
		// 样本必须属于当前工作区；跨区引用直接拒绝，避免把其他租户的图片写进诊断。
		if ev.SampleAssetID != nil {
			var ok bool
			if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM asset WHERE id=$1 AND workspace_id=$2)`,
				*ev.SampleAssetID, id.WorkspaceID).Scan(&ok); err != nil {
				return err
			}
			if !ok {
				return validationFields("sample_asset_id 不属于当前工作区", map[string]string{"events": "sample_asset_invalid"})
			}
		}
		// 去重：同五元组 10 分钟内只记一条。
		var dup bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM parser_event
			WHERE workspace_id=$1 AND platform=$2 AND field=$3 AND error_code=$4 AND page_hash=$5
			AND created_at > now() - interval '10 minutes')`,
			id.WorkspaceID, ev.Platform, ev.Field, ev.ErrorCode, ev.PageHash).Scan(&dup); err != nil {
			return err
		}
		if dup {
			continue
		}
		var detail any
		if len(ev.Detail) > 0 {
			redacted, err := redactParserDetail(ev.Detail)
			if err != nil {
				return validationFields("detail 不是合法 JSON", map[string]string{"events": "invalid_detail"})
			}
			detail = redacted
		} else {
			detail = json.RawMessage("{}")
		}
		if _, err := s.db.Exec(ctx, `INSERT INTO parser_event
			(workspace_id, account_id, platform, adapter_version, page_url, page_hash, field, error_code, sample_asset_id, detail)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			id.WorkspaceID, accountID, ev.Platform, truncate(ev.AdapterVersion, 60),
			truncate(ev.PageURL, 500), truncate(ev.PageHash, 128), truncate(ev.Field, 80),
			ev.ErrorCode, ev.SampleAssetID, detail); err != nil {
			return err
		}
		inserted++
	}
	s.audit(ctx, "parser_events_ingest", "parser_event", id.WorkspaceID.String(), "ok", map[string]any{
		"received": len(in.Events), "inserted": inserted,
	})
	return ok(w, map[string]any{"received": len(in.Events), "inserted": inserted})
}

// parserDetailSensitive 命中键名即整体替换，避免客户端把 Cookie/令牌/联系方式写进诊断。
var parserDetailSensitive = regexp.MustCompile(`(?i)(cookie|token|secret|password|authorization|session|credential|phone|mobile|email|contact|id_card|idcard)`)
var parserDetailEmail = regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`)
var parserDetailPhone = regexp.MustCompile(`\b1[3-9]\d{9}\b`)

// redactParserDetail 对客户端自控的 detail 做服务端字段级脱敏：敏感键名整值替换、
// 邮箱/手机号按值替换、深度 >6 与超长字符串截断；解析失败即拒绝，不原样入库。
func redactParserDetail(raw json.RawMessage) (json.RawMessage, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	v = scrubParserDetail(v, 0)
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}

func scrubParserDetail(v any, depth int) any {
	if depth > 6 {
		return "[depth_limited]"
	}
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if parserDetailSensitive.MatchString(k) {
				out[k] = "[redacted]"
				continue
			}
			out[k] = scrubParserDetail(val, depth+1)
		}
		return out
	case []any:
		if len(x) > 50 {
			x = x[:50]
		}
		out := make([]any, 0, len(x))
		for _, val := range x {
			out = append(out, scrubParserDetail(val, depth+1))
		}
		return out
	case string:
		s := x
		if parserDetailEmail.MatchString(s) {
			s = parserDetailEmail.ReplaceAllString(s, "[redacted_email]")
		}
		if parserDetailPhone.MatchString(s) {
			s = parserDetailPhone.ReplaceAllString(s, "[redacted_phone]")
		}
		if runeLen(s) > 500 {
			s = truncate(s, 500)
		}
		return s
	default:
		return v
	}
}

// parserDiagnostics GET /parser-events/diagnostics：失败 Top 10（平台/字段/7 天次数/最近样本）。
func (s *Server) parserDiagnostics(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT platform, field, count(*), max(created_at),
		(SELECT error_code FROM parser_event pe2
		  WHERE pe2.workspace_id=pe.workspace_id AND pe2.platform=pe.platform AND pe2.field=pe.field
		  ORDER BY created_at DESC LIMIT 1) AS last_error
		FROM parser_event pe
		WHERE workspace_id=$1 AND created_at > now() - interval '7 days'
		GROUP BY workspace_id, platform, field
		ORDER BY count(*) DESC LIMIT 10`, idv.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type diag struct {
		Platform  string    `json:"platform"`
		Field     string    `json:"field"`
		Count     int       `json:"count"`
		LastSeen  time.Time `json:"last_seen"`
		Lasterror string    `json:"last_error"`
	}
	items := []diag{}
	for rows.Next() {
		var d diag
		if err := rows.Scan(&d.Platform, &d.Field, &d.Count, &d.LastSeen, &d.Lasterror); err != nil {
			return err
		}
		items = append(items, d)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// 配方草稿列表。
	recipeRows, err := s.db.Query(r.Context(), `SELECT id, platform, field, recipe, status, verified_at
		FROM parser_recipe WHERE workspace_id=$1 ORDER BY created_at DESC`, idv.WorkspaceID)
	if err != nil {
		return err
	}
	defer recipeRows.Close()
	recipes := []map[string]any{}
	for recipeRows.Next() {
		var id uuid.UUID
		var platform, field, status string
		var recipe []byte
		var verifiedAt *time.Time
		if err := recipeRows.Scan(&id, &platform, &field, &recipe, &status, &verifiedAt); err != nil {
			return err
		}
		recipes = append(recipes, map[string]any{
			"id": id, "platform": platform, "field": field, "recipe": json.RawMessage(recipe),
			"status": status, "verified_at": verifiedAt,
		})
	}
	if err := recipeRows.Err(); err != nil {
		return err
	}
	return ok(w, map[string]any{"top_fields": items, "recipes": recipes})
}

// parserRecipeJob 每日：platform+field 7 天失败 ≥3 → 生成规则模板 draft recipe；
// 同 platform+field 已有行（任意状态）不重复生成。
func (s *Server) parserRecipeJob(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT workspace_id, platform, field, count(*)
		FROM parser_event WHERE created_at > now() - interval '7 days'
		GROUP BY workspace_id, platform, field HAVING count(*) >= 3`)
	if err != nil {
		slog.Error("parser recipe 统计失败", "err", err)
		return
	}
	type agg struct {
		ws      uuid.UUID
		platform string
		field   string
		count   int
	}
	var aggs []agg
	for rows.Next() {
		var a agg
		if err := rows.Scan(&a.ws, &a.platform, &a.field, &a.count); err == nil {
			aggs = append(aggs, a)
		}
	}
	rows.Close()
	for _, a := range aggs {
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM parser_recipe
			WHERE workspace_id=$1 AND platform=$2 AND field=$3)`, a.ws, a.platform, a.field).Scan(&exists); err != nil || exists {
			continue
		}
		// 规则模板（F4 首版不调用大模型）：常见选择器/正则候选 + 样本计数备注。
		recipe := map[string]any{
			"selector_candidates": []string{
				fmt.Sprintf("[data-field='%s']", a.field),
				fmt.Sprintf("#%s", a.field),
				fmt.Sprintf(".%s", strings.ReplaceAll(a.field, "_", "-")),
			},
			"regex_candidates": []string{},
			"notes":            fmt.Sprintf("近 7 天失败 %d 次；基于规则模板生成，需人工验证后再启用。", a.count),
		}
		encoded, _ := json.Marshal(recipe)
		if _, err := s.db.Exec(ctx, `INSERT INTO parser_recipe (workspace_id, platform, field, recipe)
			VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, platform, field) DO NOTHING`,
			a.ws, a.platform, a.field, encoded); err != nil {
			slog.Error("parser recipe 生成失败", "platform", a.platform, "field", a.field, "err", err)
		}
	}
}

// verifyParserRecipe POST /parser-recipes/{id}/verify：人工验证通过 → verified。
func (s *Server) verifyParserRecipe(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	recipeID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	var in struct {
		Notes string `json:"notes"`
	}
	_ = decodeStrict(r, &in)
	ctx := r.Context()
	tag, err := s.db.Exec(ctx, `UPDATE parser_recipe SET status='verified', verified_by=$2, verified_at=now()
		WHERE id=$1 AND workspace_id=$3 AND status='draft'`, recipeID, idv.UserID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// 非本工作区或非 draft（已 verified/active/disabled）。
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM parser_recipe WHERE id=$1 AND workspace_id=$2)`,
			recipeID, idv.WorkspaceID).Scan(&exists); err != nil || !exists {
			return errNotFound
		}
		return apiErr(http.StatusConflict, "recipe_state_invalid", "配方不是草稿状态，不能重复验证")
	}
	s.audit(ctx, "parser_recipe_verify", "parser_recipe", recipeID.String(), "ok", map[string]any{"notes": truncate(in.Notes, 200)})
	return ok(w, map[string]any{"ok": true})
}

// activateParserRecipe POST /parser-recipes/{id}/activate：verified → active（人工触发）。
// 配方不自动改适配器；启用仅表示"已人工确认可作为参考"。
func (s *Server) activateParserRecipe(w http.ResponseWriter, r *http.Request) error {
	idv := ident(r.Context())
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	recipeID, err := pathID(r, "id")
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE parser_recipe SET status='active'
		WHERE id=$1 AND workspace_id=$2 AND status='verified'`, recipeID, idv.WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists, verified bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM parser_recipe WHERE id=$1 AND workspace_id=$2),
			EXISTS (SELECT 1 FROM parser_recipe WHERE id=$1 AND workspace_id=$2 AND status='verified')`,
			recipeID, idv.WorkspaceID).Scan(&exists, &verified); err != nil || !exists {
			return errNotFound
		}
		if !verified {
			return apiErr(http.StatusConflict, "recipe_not_verified", "配方必须先人工验证通过才能启用（需在测试账号跑通一次）")
		}
		return apiErr(http.StatusConflict, "recipe_state_invalid", "配方已启用")
	}
	s.audit(r.Context(), "parser_recipe_activate", "parser_recipe", recipeID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true, "note": "配方仅作人工参考，不会自动修改桌面适配器。"})
}

// SeedParserEventsHandler E2E 专用：种 3 条同字段失败样本（7 天内），仅测试服务注册。
func SeedParserEventsHandler(s *Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		ctx := r.Context()
		rows, err := s.db.Query(ctx, `SELECT id FROM workspace`)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		var wsIDs []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if rows.Scan(&id) == nil {
				wsIDs = append(wsIDs, id)
			}
		}
		rows.Close()
		for _, ws := range wsIDs {
			for i := 0; i < 3; i++ {
				if _, err := s.db.Exec(ctx, `INSERT INTO parser_event (workspace_id, platform, field, error_code, page_hash)
					VALUES ($1,'xhs','title','selector_missing',$2)`,
					ws, "f4-seed-"+uuid.New().String()[:8]); err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
			}
		}
		// 触发配方生成（逐工作区已由 UNIQUE 覆盖）。
		s.parserRecipeJob(ctx)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}
