package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-04 第二批：命令账本 API（27 §13.2/§13.3）与 browser.* 事件投影（§13.6）。
// 命令由当前 agent run 的受控工具生成（W06 接线）；本批提供服务端账本与回执：
// 状态单向 queued→dispatched→succeeded/failed/unknown_outcome；cancelled 仅 queued；
// 派发后无回执由 sweep 转入 unknown_outcome，不重放。租约撤销/过期后的回执拒绝（迟到结果只核对）。

type browserCommandView struct {
	ID           string `json:"id"`
	GrantID      string `json:"grant_id"`
	RunID        string `json:"run_id,omitempty"`
	RequestID    string `json:"request_id"`
	ActionKind   string `json:"action_kind"`
	InputHash    string `json:"input_hash"`
	State        string `json:"state"`
	DeadlineAt   string `json:"deadline_at,omitempty"`
	DispatchedAt string `json:"dispatched_at,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	CreatedAt    string `json:"created_at"`
}

var browserCommandActions = map[string]bool{
	"tabs_list": true, "observe": true, "observe_frames": true, "navigate": true,
	"click": true, "type": true, "extract": true, "screenshot": true,
}

const browserCommandColumns = `c.id::text, c.grant_id::text, COALESCE(c.run_id::text,''), c.request_id::text,
	c.action_kind, c.input_hash, c.state, COALESCE(to_char(c.deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
	COALESCE(to_char(c.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''), COALESCE(c.error_code,''),
	to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func scanBrowserCommand(row pgx.Row) (browserCommandView, error) {
	var v browserCommandView
	err := row.Scan(&v.ID, &v.GrantID, &v.RunID, &v.RequestID, &v.ActionKind, &v.InputHash,
		&v.State, &v.DeadlineAt, &v.DispatchedAt, &v.ErrorCode, &v.CreatedAt)
	return v, err
}

// POST /agent/browser/commands：登记 queued 命令。同 (grant, request_id) 同载荷幂等返回；异载荷 409。
func (s *Server) createAgentBrowserCommand(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "browser_workspace"); err != nil {
		return err
	}
	var body struct {
		GrantID    string         `json:"grant_id"`
		RunID      string         `json:"run_id"`
		RequestID  string         `json:"request_id"`
		Action     string         `json:"action"`
		Payload    map[string]any `json:"payload"`
		DeadlineAt string         `json:"deadline_at"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	grantID, err := uuid.Parse(body.GrantID)
	if err != nil {
		return apiErr(400, "bad_request", "grant_id 必须是 UUID")
	}
	runID, err := uuid.Parse(body.RunID)
	if err != nil {
		return apiErr(400, "bad_request", "run_id 必须是 UUID")
	}
	requestID, err := uuid.Parse(body.RequestID)
	if err != nil {
		return apiErr(400, "bad_request", "request_id 必须是 UUID")
	}
	if !browserCommandActions[body.Action] {
		return apiErr(422, "browser_action_unsupported", "动作未登记")
	}
	// A7（27 §14.3 表格行 2）：frame 级动作只允许 observe/click/type，且必须先声明 frame 的 origin。
	frameOrigin, frameScoped, err := browserFrameTarget(body.Action, body.Payload)
	if err != nil {
		return err
	}
	payloadJSON, _ := json.Marshal(body.Payload)
	inputHash := fmt.Sprintf("%x", sha256.Sum256(append([]byte(body.Action+"."), payloadJSON...)))
	deadline := time.Now().Add(30 * time.Second)
	if body.DeadlineAt != "" {
		if deadline, err = time.Parse(time.RFC3339, body.DeadlineAt); err != nil {
			return apiErr(422, "validation_failed", "deadline_at 需 RFC3339")
		}
	}
	commandID := uuid.New()
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		// 租约必须 active、属于本人当前工作区、且签给该 run（27 §13.2 归属派生）。
		var grantOrigins []string
		err := tx.QueryRow(r.Context(), `
			SELECT origins FROM agent_browser_grant
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND run_id=$4
			  AND state='active' AND expires_at > now()`,
			grantID, id.WorkspaceID, id.UserID, runID).Scan(&grantOrigins)
		if err == pgx.ErrNoRows {
			return apiErr(409, "browser_lease_conflict", "租约不存在、已过期或已撤销")
		}
		if err != nil {
			return err
		}
		// 逐 frame 核验 origin：未授权的第三方 iframe 不提取、不操作（27 §14.3 表格行 2）。
		if frameScoped && !browserOriginGranted(frameOrigin, grantOrigins) {
			return apiErr(422, "browser_origin_not_granted", "该 frame 的 origin 未在租约授权范围内")
		}
		var existingID uuid.UUID
		var existingHash string
		err = tx.QueryRow(r.Context(), `
			SELECT id, input_hash FROM agent_browser_command WHERE grant_id=$1 AND request_id=$2`,
			grantID, requestID).Scan(&existingID, &existingHash)
		switch {
		case err == nil:
			if existingHash != inputHash {
				return apiErr(409, "browser_request_conflict", "同编号命令载荷不同")
			}
			commandID = existingID
			return nil
		case err == pgx.ErrNoRows:
			_, err = tx.Exec(r.Context(), `
				INSERT INTO agent_browser_command (id, run_id, grant_id, request_id, action_kind, input_hash, state, deadline_at)
				VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
				commandID, runID, grantID, requestID, body.Action, inputHash, deadline)
			return err
		default:
			return err
		}
	}); err != nil {
		return err
	}
	return s.renderBrowserCommand(r.Context(), w, commandID)
}

// POST /agent/browser/commands/{id}/dispatch：queued→dispatched（本机派发前登记；幂等）。
func (s *Server) dispatchAgentBrowserCommand(w http.ResponseWriter, r *http.Request) error {
	commandID, conversationID, err := s.ownBrowserCommand(r)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_command SET state='dispatched', dispatched_at=now()
		WHERE id=$1 AND state='queued'`, commandID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.emitBrowserCommandEvent(r.Context(), conversationID, "browser.command_started", map[string]any{
			"command_id": commandID.String(),
		})
	}
	return s.renderBrowserCommand(r.Context(), w, commandID)
}

// POST /agent/browser/commands/{id}/receipt：回执。撤销/过期租约上的回执拒绝（迟到结果按 27 §13.6 只核对）。
func (s *Server) receiptAgentBrowserCommand(w http.ResponseWriter, r *http.Request) error {
	commandID, conversationID, err := s.ownBrowserCommand(r)
	if err != nil {
		return err
	}
	var body struct {
		State       string `json:"state"`
		ErrorCode   string `json:"error_code"`
		ReceiptHash string `json:"receipt_hash"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	if body.State != "succeeded" && body.State != "failed" && body.State != "unknown_outcome" {
		return apiErr(422, "validation_failed", "回执状态只能是 succeeded/failed/unknown_outcome")
	}
	var revoked bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM agent_browser_command c JOIN agent_browser_grant g ON g.id=c.grant_id
			WHERE c.id=$1 AND (g.state<>'active' OR g.expires_at <= now()))`, commandID).Scan(&revoked); err != nil {
		return err
	}
	if revoked {
		return apiErr(409, "browser_lease_conflict", "租约已撤销或过期；回执按迟到结果核对，不改变最终状态")
	}
	// 终态：同结果幂等重放返回原回执；不同结果视为冲突（先核对不重放，27 §13.8）。
	var currentState string
	if err := s.db.QueryRow(r.Context(), `SELECT state FROM agent_browser_command WHERE id=$1`, commandID).Scan(&currentState); err != nil {
		return err
	}
	if currentState == "succeeded" || currentState == "failed" || currentState == "unknown_outcome" {
		if currentState == body.State {
			return s.renderBrowserCommand(r.Context(), w, commandID)
		}
		return apiErr(409, "browser_receipt_conflict", "命令已有不同最终结果，迟到回执仅入账核对")
	}
	if _, err := s.db.Exec(r.Context(), `
		UPDATE agent_browser_command SET state=$2, receipt_hash=COALESCE(NULLIF($3,''), receipt_hash), error_code=NULLIF($4,'')
		WHERE id=$1 AND state IN ('queued','dispatched')`,
		commandID, body.State, body.ReceiptHash, body.ErrorCode); err != nil {
		return err
	}
	s.emitBrowserCommandEvent(r.Context(), conversationID, "browser.command_finished", map[string]any{
		"command_id": commandID.String(), "state": body.State, "error_code": body.ErrorCode,
	})
	return s.renderBrowserCommand(r.Context(), w, commandID)
}

// GET /agent/browser/commands?run_id=：本人账本查询。
func (s *Server) listAgentBrowserCommands(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	runID, err := uuid.Parse(r.URL.Query().Get("run_id"))
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT `+browserCommandColumns+`
		FROM agent_browser_command c JOIN agent_browser_grant g ON g.id=c.grant_id
		WHERE c.run_id=$1 AND g.workspace_id=$2 AND g.user_id=$3
		ORDER BY c.created_at DESC LIMIT 200`, runID, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	commands := []browserCommandView{}
	for rows.Next() {
		v, err := scanBrowserCommand(rows)
		if err != nil {
			return err
		}
		commands = append(commands, v)
	}
	return ok(w, map[string]any{"commands": commands})
}

// sweepAgentBrowserCommands：把 dispatched 超过 deadline（+2s 时钟误差）的命令转 unknown_outcome（不重放）。
func (s *Server) sweepAgentBrowserCommands(ctx context.Context) {
	tag, err := s.db.Exec(ctx, `
		UPDATE agent_browser_command SET state='unknown_outcome'
		WHERE state='dispatched' AND deadline_at IS NOT NULL AND deadline_at + interval '2 seconds' < now()`)
	if err != nil {
		return
	}
	if tag.RowsAffected() > 0 {
		slog.Info("浏览器命令超时转 unknown_outcome", "count", tag.RowsAffected())
	}
}

// ownBrowserCommand 校验本人归属并返回 (commandID, conversationID)。
func (s *Server) ownBrowserCommand(r *http.Request) (uuid.UUID, uuid.UUID, error) {
	id := ident(r.Context())
	commandID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		return uuid.Nil, uuid.Nil, errNotFound
	}
	var conversationID uuid.UUID
	if err := s.db.QueryRow(r.Context(), `
		SELECT g.conversation_id FROM agent_browser_command c JOIN agent_browser_grant g ON g.id=c.grant_id
		WHERE c.id=$1 AND g.workspace_id=$2 AND g.user_id=$3`,
		commandID, id.WorkspaceID, id.UserID).Scan(&conversationID); err != nil {
		if err == pgx.ErrNoRows {
			return uuid.Nil, uuid.Nil, errNotFound
		}
		return uuid.Nil, uuid.Nil, err
	}
	return commandID, conversationID, nil
}

func (s *Server) renderBrowserCommand(ctx context.Context, w http.ResponseWriter, commandID uuid.UUID) error {
	v, err := scanBrowserCommand(s.db.QueryRow(ctx, `SELECT `+browserCommandColumns+` FROM agent_browser_command c WHERE c.id=$1`, commandID))
	if err != nil {
		return err
	}
	return ok(w, v)
}

// emitBrowserCommandEvent：有归属会话时投影 browser.* 事件（27 §13.6；无 run 不制造空事件，runID 传 nil）。
func (s *Server) emitBrowserCommandEvent(ctx context.Context, conversationID uuid.UUID, eventType string, payload map[string]any) {
	if conversationID == uuid.Nil {
		return
	}
	_, _ = s.appendAgentEvent(ctx, conversationID, nil, eventType, payload)
}

// browserFrameTarget 解析并校验 payload 的 frame_id / frame_origin（A7，27 §14.3 表格行 2）。
// 返回规范化后的 frame origin 与"是否 frame 级"：
//   - 两者都不出现：顶层动作，保持旧行为（payload 内容不变，input_hash 与旧命令一致）；
//   - 只给 frame_origin：参数错误（origin 必须依附于 frame）；
//   - 只给 frame_id：必须补 frame_origin，否则无法核验 origin 授权；
//   - 动作不在 observe/click/type：拒绝，避免 navigate/extract 等借 frame 参数绕过范围。
func browserFrameTarget(action string, payload map[string]any) (string, bool, error) {
	rawFrame, hasFrame := payload["frame_id"]
	rawOrigin, hasOrigin := payload["frame_origin"]
	if !hasFrame && !hasOrigin {
		return "", false, nil
	}
	switch action {
	case "observe", "click", "type":
	default:
		return "", false, apiErr(422, "browser_frame_unsupported", "该动作不支持 frame 级目标")
	}
	if !hasFrame {
		return "", false, apiErr(422, "browser_frame_invalid", "frame_origin 必须与 frame_id 同时提供")
	}
	f, ok := rawFrame.(float64)
	if !ok || f != math.Trunc(f) || f < 1 || f > 4096 {
		return "", false, apiErr(422, "browser_frame_invalid", "frame_id 必须是 1..4096 的整数")
	}
	if !hasOrigin {
		return "", false, apiErr(422, "browser_frame_invalid", "frame 级动作必须提供 frame_origin")
	}
	origin, ok := rawOrigin.(string)
	if !ok {
		return "", false, apiErr(422, "browser_frame_invalid", "frame_origin 必须是字符串")
	}
	norm, ok := normalizeBrowserOrigin(origin)
	if !ok {
		return "", false, apiErr(422, "browser_frame_invalid", "frame_origin 必须是 http/https 源")
	}
	return norm, true, nil
}

// normalizeBrowserOrigin 把 frame_origin 收敛成 origin（scheme://host[:port]），丢弃路径与查询；
// 拒绝带用户信息或非 http/https 的值。
func normalizeBrowserOrigin(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.Host == "" {
		return "", false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", false
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host), true
}

// browserOriginGranted 判断 origin 是否在租约 origins 内（两侧都按 origin 归一化后比较）。
func browserOriginGranted(origin string, granted []string) bool {
	for _, candidate := range granted {
		if norm, ok := normalizeBrowserOrigin(candidate); ok && norm == origin {
			return true
		}
	}
	return false
}
