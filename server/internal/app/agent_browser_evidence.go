package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-AI27-09（W09）：浏览器证据与页面批注（27 文档 §13.2/§10.1/§8.4）。
// 证据来源：本机观察命令回执后上报（未读页面不得生成"已核实"——本 API 只接受
// 真实派发过的 command_id 关联上报）；密钥命中隔离（redaction_state=quarantined）。
// 批注：用户选区/备注 → 引用筹码（发送后进入消息引用，不自动修改页面/业务对象）。

type browserEvidenceView struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversation_id"`
	RunID          string `json:"run_id,omitempty"`
	CommandID      string `json:"command_id,omitempty"`
	Origin         string `json:"origin"`
	RedactedURL    string `json:"redacted_url"`
	Title          string `json:"title"`
	Snippet        string `json:"snippet,omitempty"`
	DocRevision    string `json:"doc_revision,omitempty"`
	Kind           string `json:"kind"`
	RedactionState string `json:"redaction_state"`
	CreatedAt      string `json:"created_at"`
}

const browserEvidenceColumnsPlain = `id::text, conversation_id::text, COALESCE(run_id::text,''),
	COALESCE(command_id::text,''), origin, redacted_url, title, snippet,
	doc_revision, kind, redaction_state,
	to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

const browserEvidenceColumns = `e.id::text, e.conversation_id::text, COALESCE(e.run_id::text,''),
	COALESCE(e.command_id::text,''), e.origin, e.redacted_url, e.title, e.snippet,
	e.doc_revision, e.kind, e.redaction_state,
	to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func scanBrowserEvidence(row pgx.Row) (browserEvidenceView, error) {
	var v browserEvidenceView
	err := row.Scan(&v.ID, &v.ConversationID, &v.RunID, &v.CommandID, &v.Origin,
		&v.RedactedURL, &v.Title, &v.Snippet, &v.DocRevision, &v.Kind, &v.RedactionState, &v.CreatedAt)
	return v, err
}

// 敏感内容检测（27 §8.4/14.6：命中隔离，禁止进入模型/普通预览）。
func browserEvidenceRedactionState(text string) string {
	lower := strings.ToLower(text)
	for _, marker := range []string{"sk-", "ghp_", "bearer ", "authorization:", "password=", "token="} {
		if strings.Contains(lower, marker) {
			return "quarantined"
		}
	}
	return "clean"
}

// POST /agent/browser/evidence：本机上报证据（关联真实命令与本人会话）。
func (s *Server) createBrowserEvidence(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "browser_workspace"); err != nil {
		return err
	}
	var body struct {
		ConversationID string `json:"conversation_id"`
		RunID          string `json:"run_id"`
		CommandID      string `json:"command_id"`
		Origin         string `json:"origin"`
		RedactedURL    string `json:"redacted_url"`
		Title          string `json:"title"`
		Snippet        string `json:"snippet"`
		DocRevision    string `json:"doc_revision"`
		Kind           string `json:"kind"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	conversationID, err := uuid.Parse(body.ConversationID)
	if err != nil {
		return apiErr(400, "bad_request", "conversation_id 必须是 UUID")
	}
	if body.CommandID != "" {
		if _, err := uuid.Parse(body.CommandID); err != nil {
			return apiErr(400, "bad_request", "command_id 必须是 UUID")
		}
	}
	if body.Origin == "" {
		return apiErr(422, "validation_failed", "origin 必填")
	}
	if body.Kind != "text" && body.Kind != "screenshot" && body.Kind != "annotation" {
		return apiErr(422, "validation_failed", "kind 只能是 text/screenshot/annotation")
	}
	// 会话归属。
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_conversation
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`,
		conversationID, id.WorkspaceID, id.UserID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	// 关联命令必须真实存在且属于本人（未读页面不得生成"已核实"的防线：证据必须挂真实命令）。
	var commandID *uuid.UUID
	if body.CommandID != "" {
		parsed := uuid.MustParse(body.CommandID)
		var okCommand bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_browser_command c
			JOIN agent_browser_grant g ON g.id=c.grant_id
			WHERE c.id=$1 AND g.user_id=$2 AND g.workspace_id=$3)`,
			parsed, id.UserID, id.WorkspaceID).Scan(&okCommand); err != nil {
			return err
		}
		if !okCommand {
			return apiErr(409, "browser_command_unknown", "证据关联的命令不存在或不属于本人")
		}
		commandID = &parsed
	}
	redaction := browserEvidenceRedactionState(body.Snippet + body.Title)
	hash := sha256.Sum256([]byte(body.Origin + "\x00" + body.Snippet))
	evidenceID := uuid.New()
	var runID *uuid.UUID
	if strings.TrimSpace(body.RunID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(body.RunID))
		if err != nil {
			return apiErr(400, "bad_request", "run_id 必须是 UUID")
		}
		runID = &parsed
	}
	var view browserEvidenceView
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		row := tx.QueryRow(r.Context(), "INSERT INTO agent_browser_evidence"+
			" (id, workspace_id, user_id, conversation_id, run_id, command_id, origin, redacted_url, title, snippet, doc_revision, kind, content_hash, redaction_state)"+
			" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING "+browserEvidenceColumnsPlain,
			evidenceID, id.WorkspaceID, id.UserID, conversationID, runID, commandID,
			body.Origin, body.RedactedURL, body.Title, body.Snippet, body.DocRevision, body.Kind,
			hex.EncodeToString(hash[:]), redaction)
		var scanErr error
		view, scanErr = scanBrowserEvidence(row)
		return scanErr
	}); err != nil {
		return err
	}
	// 事件投影（27 §13.6 browser.evidence_created）。
	_, _ = s.appendAgentEvent(r.Context(), conversationID, runID, "browser.evidence_created", map[string]any{
		"evidence_id": evidenceID.String(), "origin": body.Origin, "redaction_state": redaction,
	})
	return ok(w, view)
}

// GET /agent/browser/evidence?conversation_id=&run_id=：本人证据查询。
func (s *Server) listBrowserEvidence(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		return errNotFound
	}
	args := []any{conversationID, id.UserID, id.WorkspaceID}
	query := "SELECT " + browserEvidenceColumns + " FROM agent_browser_evidence e" +
		" WHERE e.conversation_id=$1 AND e.user_id=$2 AND e.workspace_id=$3"
	if raw := r.URL.Query().Get("run_id"); raw != "" {
		runID, err := uuid.Parse(raw)
		if err != nil {
			return errNotFound
		}
		query += " AND e.run_id=$4"
		args = append(args, runID)
	}
	query += " ORDER BY e.created_at DESC LIMIT 200"
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	evidence := []browserEvidenceView{}
	for rows.Next() {
		v, err := scanBrowserEvidence(rows)
		if err != nil {
			return err
		}
		evidence = append(evidence, v)
	}
	return ok(w, map[string]any{"evidence": evidence})
}

// POST /agent/browser/annotations：页面批注（引用筹码；不自动发送/修改）。
func (s *Server) createBrowserAnnotation(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	if err := s.requireAgentFeature(r.Context(), "browser_workspace"); err != nil {
		return err
	}
	var body struct {
		ConversationID string `json:"conversation_id"`
		EvidenceID     string `json:"evidence_id"`
		Origin         string `json:"origin"`
		DocRevision    string `json:"doc_revision"`
		SelectionText  string `json:"selection_text"`
		Note           string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128*1024)).Decode(&body); err != nil {
		return apiErr(400, "bad_request", "请求体无法解析")
	}
	conversationID, err := uuid.Parse(body.ConversationID)
	if err != nil {
		return apiErr(400, "bad_request", "conversation_id 必须是 UUID")
	}
	if body.SelectionText == "" && body.Note == "" {
		return apiErr(422, "validation_failed", "选区文本与备注至少一项")
	}
	var evidenceID *uuid.UUID
	if strings.TrimSpace(body.EvidenceID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(body.EvidenceID))
		if err != nil {
			return apiErr(400, "bad_request", "evidence_id 必须是 UUID")
		}
		// 证据必须属于本人（27 §10.1：页面失效不误绑）。
		var okEvidence bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_browser_evidence
			WHERE id=$1 AND user_id=$2 AND workspace_id=$3)`,
			parsed, id.UserID, id.WorkspaceID).Scan(&okEvidence); err != nil {
			return err
		}
		if !okEvidence {
			return errNotFound
		}
		evidenceID = &parsed
	}
	annotationID := uuid.New()
	if _, err := s.db.Exec(r.Context(), "INSERT INTO agent_browser_annotation"+
		" (id, workspace_id, user_id, conversation_id, evidence_id, origin, doc_revision, selection_text, note)"+
		" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
		annotationID, id.WorkspaceID, id.UserID, conversationID, evidenceID,
		body.Origin, body.DocRevision, body.SelectionText, body.Note); err != nil {
		return err
	}
	return ok(w, map[string]any{"id": annotationID.String()})
}

// GET /agent/browser/annotations?conversation_id=：本人批注查询。
func (s *Server) listBrowserAnnotations(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.browserRoleGuard(id); err != nil {
		return err
	}
	conversationID, err := uuid.Parse(r.URL.Query().Get("conversation_id"))
	if err != nil {
		return errNotFound
	}
	rows, err := s.db.Query(r.Context(), `SELECT a.id::text,
		COALESCE(a.evidence_id::text,''), a.origin, a.doc_revision, a.selection_text, a.note,
		to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
		FROM agent_browser_annotation a
		WHERE a.conversation_id=$1 AND a.user_id=$2 AND a.workspace_id=$3
		ORDER BY a.created_at DESC LIMIT 200`, conversationID, id.UserID, id.WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type annotationView struct {
		ID            string `json:"id"`
		EvidenceID    string `json:"evidence_id,omitempty"`
		Origin        string `json:"origin"`
		DocRevision   string `json:"doc_revision,omitempty"`
		SelectionText string `json:"selection_text"`
		Note          string `json:"note,omitempty"`
		CreatedAt     string `json:"created_at"`
	}
	annotations := []annotationView{}
	for rows.Next() {
		var v annotationView
		if err := rows.Scan(&v.ID, &v.EvidenceID, &v.Origin, &v.DocRevision, &v.SelectionText, &v.Note, &v.CreatedAt); err != nil {
			return err
		}
		annotations = append(annotations, v)
	}
	return ok(w, map[string]any{"annotations": annotations})
}

// CleanupStaleBrowserEvidence 清理未被批注引用且创建超 24h 的浏览器证据（27 §14.6）。
// 被批注引用的保留（引用计数）；命令账本不动（去重窗 ≥24h 独立保留）。
// 返回删除行数。
func (s *Server) CleanupStaleBrowserEvidence(ctx context.Context) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM agent_browser_evidence e
		WHERE e.created_at < now() - interval '24 hours'
		  AND NOT EXISTS(SELECT 1 FROM agent_browser_annotation a WHERE a.evidence_id = e.id)`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
