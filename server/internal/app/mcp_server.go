package app

// REF41 E2：MCP Server（只读）。
// - token 按工作区签发：明文只在创建响应出现一次，库存 sha256 哈希；撤销立即生效。
// - 五个只读工具：list_topics/get_work/get_review/get_metrics/list_benchmark_targets；
//   全部强制工作区隔离（跨租户 ID → 404 语义 error），scope 逐一校验。
// - 不提供写/发布/确认工具，不绕过 D-117；审计只记元数据（token/工具/耗时/结果码），
//   不含返回正文与敏感字段。
// - 限流 100 次/分钟/token，超限 429 mcp_rate_limited。

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	mcpScopeTopics     = "read:topics"
	mcpScopeWorks      = "read:works"
	mcpScopeReviews    = "read:reviews"
	mcpScopeMetrics    = "read:metrics"
	mcpScopeBenchmark  = "read:benchmark"
	mcpRatePerMin      = 100
	mcpTokenMaxPerBody = 4096
)

// mcpTokenScopes 工具 → scope 的固定映射（E2-A2 只读面）。
var mcpTokenScopes = map[string]string{
	"list_topics":           mcpScopeTopics,
	"get_work":              mcpScopeWorks,
	"get_review":            mcpScopeReviews,
	"get_metrics":           mcpScopeMetrics,
	"list_benchmark_targets": mcpScopeBenchmark,
}

type mcpToken struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Scopes     []string  `json:"scopes"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
}

// createMCPtoken POST /mcp/tokens：签发 token，明文只在响应出现一次。
func (s *Server) createMCPtoken(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	var in struct {
		Name   string   `json:"name"`
		Scopes []string `json:"scopes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if len([]rune(name)) < 1 || len([]rune(name)) > 60 {
		return validation("token 名称长度需在 1–60 字之间")
	}
	valid := map[string]bool{mcpScopeTopics: true, mcpScopeWorks: true, mcpScopeReviews: true, mcpScopeMetrics: true, mcpScopeBenchmark: true}
	scopes := []string{}
	seen := map[string]bool{}
	for _, sc := range in.Scopes {
		sc = strings.TrimSpace(sc)
		if sc == "" {
			continue
		}
		if !valid[sc] {
			return validation("未知 scope：" + sc)
		}
		if seen[sc] {
			return validation("scope 重复：" + sc)
		}
		seen[sc] = true
		scopes = append(scopes, sc)
	}
	if len(scopes) == 0 {
		return validation("至少选择一个 scope")
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	plain := "ops_mcp_" + hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(plain))
	hash := hex.EncodeToString(sum[:])
	var id uuid.UUID
	err := s.db.QueryRow(r.Context(), `INSERT INTO mcp_token (workspace_id, name, token_hash, scopes, created_by)
		VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		ident(r.Context()).WorkspaceID, name, hash, scopes, ident(r.Context()).UserID).Scan(&id)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "name": name, "scopes": scopes, "token": plain,
		"note": "明文仅在创建时显示一次，服务端只保存哈希。",
	})
	return nil
}

// listMCPTokens GET /mcp/tokens：列表（无哈希/明文）。
func (s *Server) listMCPTokens(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, name, scopes, status, created_at, last_used_at
		FROM mcp_token WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []mcpToken{}
	for rows.Next() {
		var t mcpToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Scopes, &t.Status, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return err
		}
		list = append(list, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": list})
	return nil
}

// revokeMCPtoken DELETE /mcp/tokens/{tokenID}：撤销立即生效（认证侧只查 active）。
func (s *Server) revokeMCPtoken(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	tokenID, err := pathID(r, "tokenID")
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE mcp_token SET status='revoked'
		WHERE id=$1 AND workspace_id=$2`, tokenID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// mcpAuth Bearer 认证：sha256 比对 + active 校验 + 工作区绑定；返回 token 行。
type mcpAuthedToken struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Scopes      []string
}

func (s *Server) mcpAuth(ctx context.Context, bearer string) (*mcpAuthedToken, error) {
	bearer = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(bearer), "Bearer "))
	if bearer == "" {
		return nil, apiErr(http.StatusUnauthorized, "mcp_unauthorized", "缺少 MCP token")
	}
	sum := sha256.Sum256([]byte(bearer))
	var t mcpAuthedToken
	var status string
	err := s.db.QueryRow(ctx, `SELECT id, workspace_id, scopes, status FROM mcp_token
		WHERE token_hash=$1`, hex.EncodeToString(sum[:])).
		Scan(&t.ID, &t.WorkspaceID, &t.Scopes, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apiErr(http.StatusUnauthorized, "mcp_unauthorized", "token 无效")
	}
	if err != nil {
		return nil, err
	}
	if status != "active" {
		return nil, apiErr(http.StatusUnauthorized, "mcp_token_revoked", "token 已撤销")
	}
	return &t, nil
}

// mcpRate 限流：100 次/分钟/token（内存滑窗；多副本部署按实例计，首版口径）。
type mcpRateLimiter struct {
	mu      sync.Mutex
	window  map[uuid.UUID][]time.Time
}

func (l *mcpRateLimiter) allow(tokenID uuid.UUID) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.window == nil {
		l.window = map[uuid.UUID][]time.Time{}
	}
	now := time.Now()
	keep := l.window[tokenID][:0]
	for _, at := range l.window[tokenID] {
		if now.Sub(at) < time.Minute {
			keep = append(keep, at)
		}
	}
	if len(keep) >= mcpRatePerMin {
		l.window[tokenID] = keep
		return false
	}
	l.window[tokenID] = append(keep, now)
	return true
}

var mcpLimiter = &mcpRateLimiter{}

// mcpCall 统一入口：认证 → scope → 限流 → 执行 → 审计（只存元数据）。
func (s *Server) mcpCall(w http.ResponseWriter, r *http.Request) error {
	token, err := s.mcpAuth(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		return err
	}
	var in struct {
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	scope, known := mcpTokenScopes[in.Tool]
	if !known {
		return apiErr(http.StatusUnprocessableEntity, "mcp_tool_unknown", "未知或未提供的工具（只读面仅五个）").With(
			map[string]any{"tools": []string{"list_topics", "get_work", "get_review", "get_metrics", "list_benchmark_targets"}})
	}
	if !mcpHasScope(token.Scopes, scope) {
		return apiErr(http.StatusForbidden, "mcp_scope_denied", "token 缺少所需 scope："+scope)
	}
	if !mcpLimiter.allow(token.ID) {
		return apiErr(http.StatusTooManyRequests, "mcp_rate_limited", "超过 100 次/分钟/token 限流")
	}
	started := time.Now()
	resultCode := "ok"
	result, toolErr := s.mcpDispatch(r.Context(), token, in.Tool, in.Arguments)
	if toolErr != nil {
		var ae *APIError
		if errors.As(toolErr, &ae) {
			resultCode = ae.Code
		} else {
			resultCode = "internal"
		}
	}
	duration := int(time.Since(started).Milliseconds())
	_, _ = s.db.Exec(context.WithoutCancel(r.Context()), `INSERT INTO mcp_call_log
		(workspace_id, token_id, tool, result_code, duration_ms) VALUES ($1,$2,$3,$4,$5)`,
		token.WorkspaceID, token.ID, in.Tool, resultCode, duration)
	_, _ = s.db.Exec(context.WithoutCancel(r.Context()),
		`UPDATE mcp_token SET last_used_at=now() WHERE id=$1`, token.ID)
	if toolErr != nil {
		return toolErr
	}
	writeJSON(w, http.StatusOK, result)
	return nil
}

func mcpHasScope(scopes []string, need string) bool {
	for _, sc := range scopes {
		if sc == need {
			return true
		}
	}
	return false
}

// mcpDispatch 五个只读工具；workspace_id 全部取 token 绑定值（不信任请求参数）。
func (s *Server) mcpDispatch(ctx context.Context, token *mcpAuthedToken, tool string, args json.RawMessage) (map[string]any, error) {
	var in struct {
		AccountID string `json:"account_id"`
		WorkID    string `json:"work_id"`
		Status    string `json:"status"`
		Limit     int    `json:"limit"`
		From      string `json:"from"`
		To        string `json:"to"`
	}
	if len(args) > mcpTokenMaxPerBody {
		return nil, validation("参数过大")
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, validation("参数必须是 JSON 对象")
		}
	}
	switch tool {
	case "list_topics":
		limit := in.Limit
		if limit <= 0 || limit > 50 {
			limit = 20
		}
		accountID, err := uuid.Parse(in.AccountID)
		if err != nil {
			return nil, validation("account_id 必须是 UUID")
		}
		if err := s.mcpCheckAccount(ctx, token, accountID); err != nil {
			return nil, err
		}
		rows, err := s.db.Query(ctx, `SELECT id, title, angle, status, to_char(planned_date,'YYYY-MM-DD'), created_at
			FROM topic WHERE account_id=$1 AND deleted_at IS NULL AND ($2='' OR status=$2)
			ORDER BY created_at DESC LIMIT $3`, accountID, in.Status, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		topics := []map[string]any{}
		for rows.Next() {
			var id uuid.UUID
			var title, angle, status string
			var planned *string
			var createdAt time.Time
			if err := rows.Scan(&id, &title, &angle, &status, &planned, &createdAt); err != nil {
				return nil, err
			}
			topics = append(topics, map[string]any{"id": id, "title": title, "angle": angle,
				"status": status, "planned_date": planned, "created_at": createdAt})
		}
		return map[string]any{"topics": topics, "read_only": true}, nil

	case "get_work":
		workID, err := uuid.Parse(in.WorkID)
		if err != nil {
			return nil, validation("work_id 必须是 UUID")
		}
		var title, status, platform, contentFormat string
		var revision int
		err = s.db.QueryRow(ctx, `SELECT w.title, w.status, a.platform, w.content_format, w.revision
			FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, token.WorkspaceID).
			Scan(&title, &status, &platform, &contentFormat, &revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apiErr(http.StatusNotFound, "mcp_not_found", "作品不存在或不属于本工作区")
		}
		if err != nil {
			return nil, err
		}
		sections := []map[string]any{}
		srows, err := s.db.Query(ctx, `SELECT heading, content_md FROM work_section
			WHERE work_id=$1 ORDER BY position`, workID)
		if err == nil {
			defer srows.Close()
			for srows.Next() {
				var heading, body string
				if err := srows.Scan(&heading, &body); err == nil {
					sections = append(sections, map[string]any{"heading": heading, "body": body})
				}
			}
		}
		return map[string]any{"work": map[string]any{"id": workID, "title": title, "status": status,
			"platform": platform, "content_format": contentFormat, "revision": revision, "sections": sections}, "read_only": true}, nil

	case "get_review":
		workID, err := uuid.Parse(in.WorkID)
		if err != nil {
			return nil, validation("work_id 必须是 UUID")
		}
		// 仅已生成复盘：work_ids 包含该作品且账号属于本工作区。
		var content json.RawMessage
		var createdAt time.Time
		err = s.db.QueryRow(ctx, `SELECT rr.content, rr.created_at FROM review_report rr
			JOIN platform_account a ON a.id=rr.account_id
			WHERE a.workspace_id=$1 AND rr.work_ids @> ARRAY[$2]::uuid[]
			ORDER BY rr.created_at DESC LIMIT 1`, token.WorkspaceID, workID).
			Scan(&content, &createdAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apiErr(http.StatusNotFound, "mcp_not_found", "该作品尚无复盘报告")
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"review": json.RawMessage(content), "created_at": createdAt, "read_only": true}, nil

	case "get_metrics":
		accountID, err := uuid.Parse(in.AccountID)
		if err != nil {
			return nil, validation("account_id 必须是 UUID")
		}
		if err := s.mcpCheckAccount(ctx, token, accountID); err != nil {
			return nil, err
		}
		if in.From == "" || in.To == "" {
			return nil, validation("from/to 必填（YYYY-MM-DD）")
		}
		rows, err := s.db.Query(ctx, `SELECT date, coalesce(new_follow,0), coalesce(cancel_follow,0), coalesce(net_follow,0), coalesce(cumulate,0)
			FROM account_metric_daily WHERE account_id=$1 AND date BETWEEN $2::date AND $3::date
			ORDER BY date`, accountID, in.From, in.To)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		days := []map[string]any{}
		for rows.Next() {
			var date time.Time
			var newF, cancelF, netF, cum int
			if err := rows.Scan(&date, &newF, &cancelF, &netF, &cum); err != nil {
				return nil, err
			}
			days = append(days, map[string]any{"date": date.Format("2006-01-02"),
				"new_follow": newF, "cancel_follow": cancelF, "net_follow": netF, "cumulate": cum})
		}
		return map[string]any{"metrics": days, "read_only": true}, nil

	case "list_benchmark_targets":
		query := `SELECT id, platform, name, url, status, fit_score, created_at FROM benchmark_target
			WHERE workspace_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR account_id=$2::uuid)
			ORDER BY created_at DESC LIMIT 100`
		var accountFilter *uuid.UUID
		if in.AccountID != "" {
			parsed, err := uuid.Parse(in.AccountID)
			if err != nil {
				return nil, validation("account_id 必须是 UUID")
			}
			if err := s.mcpCheckAccount(ctx, token, parsed); err != nil {
				return nil, err
			}
			accountFilter = &parsed
		}
		rows, err := s.db.Query(ctx, query, token.WorkspaceID, accountFilter)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		targets := []map[string]any{}
		for rows.Next() {
			var id uuid.UUID
			var platform, name, url, status string
			var fitScore int
			var createdAt time.Time
			if err := rows.Scan(&id, &platform, &name, &url, &status, &fitScore, &createdAt); err != nil {
				return nil, err
			}
			targets = append(targets, map[string]any{"id": id, "platform": platform, "name": name,
				"url": url, "status": status, "fit_score": fitScore, "created_at": createdAt})
		}
		return map[string]any{"targets": targets, "read_only": true}, nil
	}
	return nil, apiErr(http.StatusUnprocessableEntity, "mcp_tool_unknown", "未知工具")
}

// mcpCheckAccount 账号必须属于 token 工作区（跨租户 → 404 语义）。
func (s *Server) mcpCheckAccount(ctx context.Context, token *mcpAuthedToken, accountID uuid.UUID) error {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_account
		WHERE id=$1 AND workspace_id=$2)`, accountID, token.WorkspaceID).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return apiErr(http.StatusNotFound, "mcp_not_found", "账号不存在或不属于本工作区")
	}
	return nil
}
