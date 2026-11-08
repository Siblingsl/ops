package app

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-04（W04）：浏览器配对、绑定与授权租约（27 文档 §13 提案契约的本机实现批）。
// 归属全部由真实身份派生（本人+工作区+设备+扩展实例）；viewer 与超管代访问一律拒绝
// （27 §14.1：viewer 默认关闭，owner 开放只读研究属后续裁决；代访问不能使用智能体）。
// 撤销类路由（解绑/撤 grant/handoff）采用"只减权"检查（27 §13.4）：仍要求登录与真实
// 资源归属，但不要求智能体/浏览器功能开关仍开启，保证 agentGate 关闭时仍可清理。

const (
	browserPairingTTL    = 5 * time.Minute
	browserGrantTTL      = 30 * time.Second // 27 §15.1：短期租约 30 秒
	browserGrantMaxRun   = 5                // 27 §15.1：每 run 获准标签上限（本批按 grant 计数收紧点在 W06）
	browserGrantMaxConc  = 1                // 27 §15.1：每 run 绑定实例 1 个、每标签控制者 1 个的 P0 子集
)

type browserCapabilities struct {
	ChromeConnect    bool   `json:"chrome_connect"`
	BrowserWorkspace bool   `json:"browser_workspace"`
	DeviceState      string `json:"device_state"`
	ProtocolRange    string `json:"protocol_range"`
	UnavailableRel   string `json:"unavailable_reason,omitempty"`
}

func (s *Server) browserCapabilitiesOf(ctx context.Context) browserCapabilities {
	feats := s.agentWorkbenchFeatures(ctx)
	caps := browserCapabilities{
		ChromeConnect:    feats["chrome_connect"],
		BrowserWorkspace: feats["browser_workspace"],
		DeviceState:      "unknown",
		ProtocolRange:    "1",
	}
	if !caps.ChromeConnect {
		caps.UnavailableRel = "chrome_connect disabled by runtime gate"
	}
	return caps
}

// GET /agent/browser/capabilities（agentGate + chrome_connect 开关由 bootstrap/features 表达）
func (s *Server) agentBrowserCapabilities(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireAgentFeature(r.Context(), "chrome_connect"); err != nil {
		return err
	}
	caps := s.browserCapabilitiesOf(r.Context())
	return ok(w, caps)
}

type browserBindingView struct {
	ID                  string `json:"id"`
	DeviceID            string `json:"device_id"`
	ExtensionInstanceID string `json:"extension_instance_id"`
	ConnectionName      string `json:"connection_name"`
	BrowserKind         string `json:"browser_kind"`
	ProtocolRange       string `json:"protocol_range"`
	State               string `json:"state"`
	Revision            int64  `json:"revision"`
	LastSeenAt          string `json:"last_seen_at,omitempty"`
	CreatedAt           string `json:"created_at"`
}

// GET /agent/browser/bindings：本人当前工作区连接摘要（不含配对密钥/profile 路径）。
func (s *Server) listAgentBrowserBindings(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "chrome_connect"); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT id::text, device_id::text, extension_instance_id::text, connection_name,
		       browser_kind, protocol_range, state, revision,
		       COALESCE(to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
		       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM agent_browser_binding
		WHERE workspace_id = $1 AND user_id = $2 AND state <> 'revoked'
		ORDER BY created_at DESC`, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	bindings := []browserBindingView{}
	for rows.Next() {
		var v browserBindingView
		if err := rows.Scan(&v.ID, &v.DeviceID, &v.ExtensionInstanceID, &v.ConnectionName,
			&v.BrowserKind, &v.ProtocolRange, &v.State, &v.Revision, &v.LastSeenAt, &v.CreatedAt); err != nil {
			return err
		}
		bindings = append(bindings, v)
	}
	return ok(w, map[string]any{"bindings": bindings})
}

type browserPairingView struct {
	ID               string `json:"id"`
	Code             string `json:"code"`
	State            string `json:"state"`
	Revision         int64  `json:"revision"`
	ExpiresAt        string `json:"expires_at"`
}

// POST /agent/browser/pairings：创建配对事务（27 §13.4：短时、限速、request_id 幂等、只绑当前身份）。
func (s *Server) createAgentBrowserPairing(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "chrome_connect"); err != nil {
		return err
	}
	var body struct {
		RequestID string `json:"request_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	requestID, err := uuid.Parse(body.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	// 复用既有 24h 资源回执实现幂等（27 §13.1 沿用项目现有机制）。
	var pairingID *uuid.UUID
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		res, err := claimAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, "browser_pairing", requestID, map[string]any{})
		if err != nil {
			return err
		}
		pairingID = res
		if pairingID != nil {
			return nil
		}
		code, err := browserPairingCode()
		if err != nil {
			return err
		}
		row := tx.QueryRow(r.Context(), `
			INSERT INTO agent_browser_pairing (id, workspace_id, user_id, code, expires_at)
			VALUES ($1,$2,$3,$4, now()+interval '5 minutes')
			RETURNING id::text`, uuid.New(), id.WorkspaceID, id.UserID, code)
		var created string
		if err := row.Scan(&created); err != nil {
			return err
		}
		uid := uuid.MustParse(created)
		pairingID = &uid
		return completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, "browser_pairing", requestID, uuid.MustParse(created))
	}); err != nil {
		return err
	}
	var view browserPairingView
	var expires time.Time
	if err := s.db.QueryRow(r.Context(), `
		SELECT id::text, code, state, expected_revision, expires_at
		FROM agent_browser_pairing WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
		*pairingID, id.WorkspaceID, id.UserID).Scan(&view.ID, &view.Code, &view.State, &view.Revision, &expires); err != nil {
		return err
	}
	view.ExpiresAt = expires.UTC().Format(time.RFC3339)
	return ok(w, view)
}

// POST /agent/browser/pairings/{id}/confirm：expected_revision CAS 确认并落绑定。
// 双端确认语义：本机扩展与 OPS 各持短码核对一致后由用户在 OPS 侧确认（27 §7.1 第 4 步）。
func (s *Server) confirmAgentBrowserPairing(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "chrome_connect"); err != nil {
		return err
	}
	pairingID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		ExpectedRevision    int64  `json:"expected_revision"`
		ExtensionInstanceID string `json:"extension_instance_id"`
		DeviceID            string `json:"device_id"`
		ConnectionName      string `json:"connection_name"`
		BrowserKind         string `json:"browser_kind"`
		ProtocolRange       string `json:"protocol_range"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	instanceID, err := uuid.Parse(body.ExtensionInstanceID)
	if err != nil {
		return apiErr(400, "bad_request", "extension_instance_id 必须是 UUID")
	}
	deviceID, err := uuid.Parse(body.DeviceID)
	if err != nil {
		return apiErr(400, "bad_request", "device_id 必须是 UUID")
	}
	if body.BrowserKind == "" {
		body.BrowserKind = "chrome"
	}
	bindingID := uuid.New()
	var result struct {
		BindingID string `json:"binding_id"`
		State     string `json:"state"`
	}
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `
			UPDATE agent_browser_pairing SET state = 'confirmed', binding_id = $2, expected_revision = expected_revision + 1
			WHERE id = $1 AND workspace_id = $3 AND user_id = $4 AND state = 'pending'
			  AND expected_revision = $5 AND expires_at > now()`,
			pairingID, bindingID, id.WorkspaceID, id.UserID, body.ExpectedRevision)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return apiErr(409, "browser_pairing_conflict", "配对不存在、已确认或已过期")
		}
		// 同一扩展实例同一时刻只归属一个本人绑定（27 §13.2）；冲突时要求先撤销旧绑定。
		var exists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM agent_browser_binding WHERE extension_instance_id = $1 AND state <> 'revoked')`,
			instanceID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return apiErr(409, "browser_binding_conflict", "该扩展实例已绑定；请先在旧工作区解绑")
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO agent_browser_binding (id, workspace_id, user_id, device_id, extension_instance_id,
				connection_name, browser_kind, protocol_range, state)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready')`,
			bindingID, id.WorkspaceID, id.UserID, deviceID, instanceID,
			body.ConnectionName, body.BrowserKind, body.ProtocolRange); err != nil {
			return err
		}
		result.BindingID = bindingID.String()
		result.State = "ready"
		return nil
	}); err != nil {
		return err
	}
	return ok(w, result)
}

// DELETE /agent/browser/bindings/{id}：只减权清理（不挂 agentGate；登录+归属即达，27 §13.4）。
func (s *Server) revokeAgentBrowserBinding(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	bindingID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_binding SET state = 'revoked', revision = revision + 1, updated_at = now()
		WHERE id = $1 AND workspace_id = $2 AND user_id = $3 AND state <> 'revoked'`,
		bindingID, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	// 撤销绑定级联收回其全部租约（只减权）。
	if _, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_grant SET state = 'revoked', revoked_at = now(), generation = generation + 1
		WHERE binding_id = $1 AND state = 'active'`, bindingID); err != nil {
		return err
	}
	return ok(w, map[string]any{"revoked": true})
}

type browserGrantView struct {
	ID             string   `json:"id"`
	BindingID      string   `json:"binding_id"`
	RunID          string   `json:"run_id,omitempty"`
	TabHandle      string   `json:"tab_handle"`
	Origins        []string `json:"origins"`
	Actions        []string `json:"actions"`
	PolicyVersion  string   `json:"policy_version"`
	Generation     int64    `json:"generation"`
	State          string   `json:"state"`
	ExpiresAt      string   `json:"expires_at"`
}

// POST /agent/conversations/{id}/browser-grants：为当前活动 run 签发短期标签租约。
func (s *Server) createAgentBrowserGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "browser_workspace"); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	var body struct {
		BindingID      string   `json:"binding_id"`
		RunID          string   `json:"run_id"`
		TabHandle      string   `json:"tab_handle"`
		Origins        []string `json:"origins"`
		Actions        []string `json:"actions"`
		PolicyVersion  string   `json:"policy_version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	bindingID, err := uuid.Parse(body.BindingID)
	if err != nil {
		return apiErr(400, "bad_request", "binding_id 必须是 UUID")
	}
	runID, err := uuid.Parse(body.RunID)
	if err != nil {
		return apiErr(400, "bad_request", "run_id 必须是 UUID")
	}
	if body.TabHandle == "" || len(body.Origins) == 0 {
		return apiErr(422, "browser_scope_invalid", "tab_handle 与 origins 必填")
	}
	if len(body.Origins) > browserGrantMaxRun {
		return apiErr(422, "browser_scope_invalid", "标签/来源数量超出租约上限")
	}
	if body.Actions == nil {
		body.Actions = []string{"observe"}
	}
	grantID := uuid.New()
	var view browserGrantView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 绑定归属当前身份且未撤销。
		var okBinding bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM agent_browser_binding
				WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND state='ready')`,
			bindingID, id.WorkspaceID, id.UserID).Scan(&okBinding); err != nil {
			return err
		}
		if !okBinding {
			return apiErr(404, "browser_binding_not_found", "绑定不存在或已撤销")
		}
		// S05 前台互斥（27 §11.5.2）：电脑控制（活动 computer grant）与浏览器操作共用前台——
		// 有活动电脑租约时浏览器 grant 拒绝。
		var activeComputer bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_computer_grant
			WHERE user_id=$1 AND workspace_id=$2 AND state='active' AND (expires_at IS NULL OR expires_at > now()))`,
			id.UserID, id.WorkspaceID).Scan(&activeComputer); err != nil {
			return err
		}
		if activeComputer {
			return apiErr(409, "browser_lease_conflict", "电脑控制正在操作前台；请先撤销电脑控制租约")
		}
		// run 必须属于本人当前工作区的该会话，且处于可派发状态（27 §13.4 发送时序）。
		var okRun bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS(SELECT 1 FROM agent_run ru
				JOIN agent_conversation c ON c.id = ru.conversation_id
				WHERE ru.id=$1 AND ru.conversation_id=$2 AND ru.workspace_id=$3 AND ru.user_id=$4
				  AND ru.status IN ('queued','running','awaiting_confirmation'))`,
			runID, conversationID, id.WorkspaceID, id.UserID).Scan(&okRun); err != nil {
			return err
		}
		if !okRun {
			return apiErr(409, "browser_run_not_active", "run 不存在、已结束或不属于该会话")
		}
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO agent_browser_grant (id, binding_id, workspace_id, user_id, conversation_id, run_id,
				tab_handle, origins, actions, policy_version, state, expires_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active', now()+interval '30 seconds')`,
			grantID, bindingID, id.WorkspaceID, id.UserID, conversationID, runID,
			body.TabHandle, body.Origins, body.Actions, body.PolicyVersion); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return err
	}
	row := s.db.QueryRow(r.Context(), `
		SELECT id::text, binding_id::text, COALESCE(run_id::text,''), tab_handle, origins, actions,
		       policy_version, generation, state, to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM agent_browser_grant WHERE id=$1`, grantID)
	if err := row.Scan(&view.ID, &view.BindingID, &view.RunID, &view.TabHandle, &view.Origins,
		&view.Actions, &view.PolicyVersion, &view.Generation, &view.State, &view.ExpiresAt); err != nil {
		return err
	}
	return ok(w, view)
}

// DELETE /agent/browser/grants/{id}：只减权撤销（触发本机停控）。
func (s *Server) revokeAgentBrowserGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	grantID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_grant SET state='revoked', revoked_at=now(), generation=generation+1
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND state='active'`,
		grantID, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"revoked": true})
}

// POST /agent/browser/grants/{id}/handoff：收回控制权（本机先停控；服务端只记录，27 §13.4）。
func (s *Server) handoffAgentBrowserGrant(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	grantID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return errNotFound
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_grant SET state='revoked', revoked_at=now(), generation=generation+1
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND state IN ('active')`,
		grantID, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound
	}
	return ok(w, map[string]any{"state": "revoked", "device_ack_pending": true})
}

// browserRoleGuard：viewer 与超管代访问一律拒绝（27 §14.1 P0 边界）。
func (s *Server) browserRoleGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	if id.AdminOverride {
		return apiErr(403, "browser_policy_denied", "代访问期间不能使用浏览器协作")
	}
	if id.Role == "viewer" {
		return apiErr(403, "browser_policy_denied", "观察者角色未开放浏览器协作")
	}
	return nil
}

func browserPairingCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}
