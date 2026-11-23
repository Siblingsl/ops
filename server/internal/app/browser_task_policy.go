package app

// REF41 F5：浏览器任务三道闸。
// checkBrowserPolicy(ctx, workspaceID, accountID, purpose, url, tabCount)：
//  1. 策略闸——purpose 存在 active 且未过期策略（expires_at 判定，过期即失效）；
//  2. 白名单闸——url 匹配任一 url_patterns（域名+路径前缀；'*' 全站模式禁止，建档/入参双侧拒绝）；
//  3. 账号闸——策略 account_id 匹配当前账号（NULL=任意本工作区账号）+ 标签页闸 tabCount==1。
// 任一失败 → {ok:false, reason}；桌面执行器 Preflight 调用，失败 policy_denied 不执行；
// 拒绝写审计不静默。策略只能 owner 创建/续期；不自动续期。

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const browserPolicyMaxTTL = 48 * time.Hour

var browserPolicyPurposes = []string{"publish_fill", "publish_health", "publish_patrol", "benchmark_observe", "followers"}

type browserTaskPolicy struct {
	ID             uuid.UUID  `json:"id"`
	AccountID      *uuid.UUID `json:"account_id,omitempty"`
	Purpose        string     `json:"purpose"`
	URLPatterns    []string   `json:"url_patterns"`
	AllowedActions []string   `json:"allowed_actions"`
	ExpiresAt      time.Time  `json:"expires_at"`
	Status         string     `json:"status"`
	CreatedAt      time.Time  `json:"created_at"`
}

// browserPolicyValidatePattern 拒绝全站模式：'*'、'https://*'、'https://*.example.com' 等；
// 必须含具体域名前缀（scheme://host 开头）。
func browserPolicyValidatePattern(pattern string) bool {
	p := strings.TrimSpace(pattern)
	if p == "" {
		return false
	}
	if p == "*" || strings.Contains(p, "://*") || strings.HasPrefix(p, "*") {
		return false
	}
	parsed, err := url.Parse(p)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Hostname() == "" {
		return false
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return false
	}
	// host 必须是具体域名或 IP，不允许通配与空 host。
	if strings.HasPrefix(parsed.Hostname(), "*") || strings.HasPrefix(parsed.Hostname(), ".") {
		return false
	}
	return true
}

// browserPolicyURLMatch url 是否命中模式：scheme/host 必须一致，路径按段前缀匹配。
// 不能直接做字符串前缀比较："https://creator.xiaohongshu.com@evil.com/..." 会通过
// 字符串比较但真实 host 是 evil.com。
func browserPolicyURLMatch(pattern, rawURL string) bool {
	p := strings.TrimSpace(pattern)
	raw := strings.TrimSpace(rawURL)
	if !browserPolicyValidatePattern(p) {
		return false
	}
	pu, err := url.Parse(p)
	if err != nil {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Hostname() == "" {
		return false
	}
	if !strings.EqualFold(pu.Scheme, u.Scheme) || !strings.EqualFold(pu.Host, u.Host) {
		return false
	}
	wantPath := pu.EscapedPath()
	if wantPath == "" {
		wantPath = "/"
	}
	gotPath := u.EscapedPath()
	if gotPath == "" {
		gotPath = "/"
	}
	if !strings.HasPrefix(gotPath, wantPath) {
		return false
	}
	// 路径必须按段匹配：/publish 不能命中 /publisher。
	if wantPath != "/" && len(gotPath) > len(wantPath) && gotPath[len(wantPath)] != '/' {
		return false
	}
	return true
}

// checkBrowserPolicy 三道闸统一入口；失败 reason 可读并交调用方审计。
func (s *Server) checkBrowserPolicy(ctx context.Context, workspaceID, accountID uuid.UUID,
	purpose, url string, tabCount int, action string) (bool, string) {
	// 标签页闸（先于查表，最廉价）。
	if tabCount != 1 {
		return false, "single_tab_required"
	}
	rows, err := s.db.Query(ctx, `SELECT id, account_id, url_patterns, allowed_actions, expires_at
		FROM browser_task_policy
		WHERE workspace_id=$1 AND purpose=$2 AND status='active' AND expires_at > now()
		ORDER BY expires_at DESC`, workspaceID, purpose)
	if err != nil {
		return false, "policy_query_failed"
	}
	defer rows.Close()
	type policyRow struct {
		id        uuid.UUID
		accountID *uuid.UUID
		patterns  []string
		actions   []string
		expiresAt time.Time
	}
	var policies []policyRow
	for rows.Next() {
		var p policyRow
		if err := rows.Scan(&p.id, &p.accountID, &p.patterns, &p.actions, &p.expiresAt); err != nil {
			return false, "policy_query_failed"
		}
		policies = append(policies, p)
	}
	rows.Close()
	if len(policies) == 0 {
		return false, "policy_missing_or_expired"
	}
	// 账号闸：策略 account_id 为 NULL=任意本工作区账号；否则必须等于当前账号。
	matched := false
	for _, p := range policies {
		if p.accountID != nil && *p.accountID != accountID {
			continue
		}
		matched = true
		// 白名单闸。
		hit := false
		for _, pattern := range p.patterns {
			if browserPolicyURLMatch(pattern, url) {
				hit = true
				break
			}
		}
		if !hit {
			return false, "policy_url_not_allowed"
		}
		// 动作闸：声明了 allowed_actions 时执行动作必须在列。
		if len(p.actions) > 0 && action != "" {
			ok := false
			for _, a := range p.actions {
				if a == action {
					ok = true
					break
				}
			}
			if !ok {
				return false, "policy_action_not_allowed"
			}
		}
		return true, ""
	}
	return matched, "policy_account_mismatch"
}

// browserPolicyCheckHTTP 是桌面发布/采集执行器 Preflight 的签名检查端点：
// POST /desktop/platform/browser-policy/check。设备证明确认设备与工作区；
// 拒绝必须写 browser_policy_denied 审计，不能只在客户端弹错。
func (s *Server) browserPolicyCheckHTTP(w http.ResponseWriter, r *http.Request) error {
	body, _, err := s.desktopReadAndVerifyProof(r, "browser.policy.check")
	if err != nil {
		return err
	}
	var in struct {
		AccountID uuid.UUID `json:"account_id"`
		Purpose   string    `json:"purpose"`
		URL       string    `json:"url"`
		TabCount  int       `json:"tab_count"`
		Action    string    `json:"action,omitempty"`
	}
	if err := decodeStrictPlatformJSON(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	validPurpose := false
	for _, purpose := range browserPolicyPurposes {
		if in.Purpose == purpose {
			validPurpose = true
			break
		}
	}
	if !validPurpose {
		return validation("purpose 不在浏览器任务目的枚举内")
	}
	parsed, parseErr := url.Parse(strings.TrimSpace(in.URL))
	if parseErr != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "https" && parsed.Scheme != "http") {
		return validation("url 必须是 http(s) 且包含有效 host，不能带用户信息")
	}
	if in.AccountID == uuid.Nil {
		return validation("account_id 必填")
	}
	ws := ident(r.Context()).WorkspaceID
	var accountBelongs bool
	if err := s.db.QueryRow(r.Context(),
		`SELECT EXISTS(SELECT 1 FROM platform_account WHERE id=$1 AND workspace_id=$2)`,
		in.AccountID, ws).Scan(&accountBelongs); err != nil {
		return err
	}
	if !accountBelongs {
		return apiErr(http.StatusNotFound, "account_not_found", "账号不存在或不属于当前工作区")
	}
	allowed, reason := s.checkBrowserPolicy(r.Context(), ws, in.AccountID, in.Purpose, in.URL, in.TabCount, in.Action)
	if !allowed {
		host := parsed.Hostname()
		s.audit(r.Context(), "browser_policy_denied", "browser_task_policy", in.Purpose, "denied",
			map[string]any{
				"reason": reason, "purpose": in.Purpose, "account_id": in.AccountID.String(),
				"tab_count": in.TabCount, "action": in.Action, "url_host": host,
			})
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"ok": allowed, "reason": reason})
}

// listBrowserPolicies GET /browser-task-policies。
func (s *Server) listBrowserPolicies(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id, account_id, purpose, url_patterns, allowed_actions, expires_at, status, created_at
		FROM browser_task_policy WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []browserTaskPolicy{}
	for rows.Next() {
		var p browserTaskPolicy
		if err := rows.Scan(&p.ID, &p.AccountID, &p.Purpose, &p.URLPatterns, &p.AllowedActions, &p.ExpiresAt, &p.Status, &p.CreatedAt); err != nil {
			return err
		}
		list = append(list, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": list})
	return nil
}

// createBrowserPolicy POST /browser-task-policies：owner 创建，48h 上限，全站模式拒绝。
func (s *Server) createBrowserPolicy(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	var in struct {
		AccountID        string   `json:"account_id"`
		Purpose          string   `json:"purpose"`
		URLPatterns      []string `json:"url_patterns"`
		AllowedActions   []string `json:"allowed_actions"`
		ExpiresInMinutes int      `json:"expires_in_minutes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	validPurpose := false
	for _, p := range browserPolicyPurposes {
		if p == in.Purpose {
			validPurpose = true
			break
		}
	}
	if !validPurpose {
		return validation("未知任务目的：" + in.Purpose)
	}
	if len(in.URLPatterns) < 1 || len(in.URLPatterns) > 20 {
		return validation("URL 模式需 1–20 条")
	}
	for _, pattern := range in.URLPatterns {
		if !browserPolicyValidatePattern(pattern) {
			return apiErr(http.StatusUnprocessableEntity, "policy_pattern_too_broad",
				"URL 模式必须限定域名+路径前缀，不允许全站通配："+pattern)
		}
	}
	ttl := time.Duration(in.ExpiresInMinutes) * time.Minute
	if ttl <= 0 || ttl > browserPolicyMaxTTL {
		return validation("有效期需在 1 分钟–48 小时之间")
	}
	if in.AllowedActions == nil {
		in.AllowedActions = []string{}
	}
	var accountID *uuid.UUID
	if in.AccountID != "" {
		parsed, err := uuid.Parse(in.AccountID)
		if err != nil {
			return validation("account_id 必须是 UUID")
		}
		if err := s.mcpCheckAccount(r.Context(), &mcpAuthedToken{WorkspaceID: ident(r.Context()).WorkspaceID}, parsed); err != nil {
			return errNotFound
		}
		accountID = &parsed
	}
	var id uuid.UUID
	err := s.db.QueryRow(r.Context(), `INSERT INTO browser_task_policy
		(workspace_id, account_id, purpose, url_patterns, allowed_actions, expires_at, created_by)
		VALUES ($1,$2,$3,$4,$5, now()+make_interval(mins => $6), $7) RETURNING id`,
		ident(r.Context()).WorkspaceID, accountID, in.Purpose, in.URLPatterns, in.AllowedActions,
		int(in.ExpiresInMinutes), ident(r.Context()).UserID).Scan(&id)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "browser_policy_create", "browser_task_policy", id.String(), "ok",
		map[string]any{"purpose": in.Purpose, "patterns": len(in.URLPatterns), "ttl_minutes": in.ExpiresInMinutes})
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
	return nil
}

// patchBrowserPolicy PATCH /browser-task-policies/{policyID}：owner 停用/启用。
func (s *Server) patchBrowserPolicy(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	policyID, err := pathID(r, "policyID")
	if err != nil {
		return err
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.Status != "active" && in.Status != "disabled" {
		return validation("status 只能是 active 或 disabled")
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE browser_task_policy SET status=$2
		WHERE id=$1 AND workspace_id=$3`, policyID, in.Status, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "browser_policy_update", "browser_task_policy", policyID.String(), "ok",
		map[string]any{"status": in.Status})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// renewBrowserPolicy POST /browser-task-policies/{policyID}/renew：owner 续期 ≤48h。
func (s *Server) renewBrowserPolicy(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireOwner(r.Context()); err != nil {
		return err
	}
	policyID, err := pathID(r, "policyID")
	if err != nil {
		return err
	}
	var in struct {
		ExpiresInMinutes int `json:"expires_in_minutes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	ttl := time.Duration(in.ExpiresInMinutes) * time.Minute
	if ttl <= 0 || ttl > browserPolicyMaxTTL {
		return validation("续期时长需在 1 分钟–48 小时之间")
	}
	tag, err := s.db.Exec(r.Context(), `UPDATE browser_task_policy
		SET expires_at = now() + make_interval(mins => $2),
		    status = CASE WHEN status='disabled' THEN status ELSE 'active' END
		WHERE id=$1 AND workspace_id=$3`, policyID, int(in.ExpiresInMinutes), ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	s.audit(r.Context(), "browser_policy_renew", "browser_task_policy", policyID.String(), "ok",
		map[string]any{"ttl_minutes": in.ExpiresInMinutes})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	return nil
}

// browserPolicyExpireJob 每分钟：过期策略归档为 expired（审计不逐条发，仅状态推进）。
func (s *Server) browserPolicyExpireJob(ctx context.Context) {
	_, _ = s.db.Exec(ctx, `UPDATE browser_task_policy SET status='expired'
		WHERE status='active' AND expires_at <= now()`)
}

// browserPolicyOfErr 便捷：pgx.ErrNoRows 判定（保留未来扩展）。
func browserPolicyOfErr(err error) bool { return err == pgx.ErrNoRows }
