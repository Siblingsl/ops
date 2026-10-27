package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var errAgentArtifactLimit = errors.New("agent artifact limit reached")

type agentArtifactCursor struct {
	Version   int       `json:"v"`
	UpdatedAt time.Time `json:"t"`
	ID        uuid.UUID `json:"i"`
}

type agentArtifactSummary struct {
	ID             uuid.UUID  `json:"id"`
	Kind           string     `json:"kind"`
	Title          string     `json:"title"`
	CurrentVersion int        `json:"current_version"`
	CurrentSource  string     `json:"source_kind,omitempty"`
	SourceRunID    *uuid.UUID `json:"source_run_id,omitempty"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type agentArtifactListResponse struct {
	Items      []agentArtifactSummary `json:"items"`
	NextCursor *string                `json:"next_cursor"`
}

type agentArtifactView struct {
	ID               uuid.UUID  `json:"id"`
	ConversationID   uuid.UUID  `json:"conversation_id"`
	Kind             string     `json:"kind"`
	Title            string     `json:"title"`
	CurrentVersionID *uuid.UUID `json:"current_version_id"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type agentArtifactVersionView struct {
	ID             uuid.UUID       `json:"id"`
	Version        int             `json:"version"`
	SourceRunID    *uuid.UUID      `json:"source_run_id,omitempty"`
	SourceMessage  *uuid.UUID      `json:"source_message_id,omitempty"`
	SourceAICallID *uuid.UUID      `json:"source_ai_call_id,omitempty"`
	SourceKind     string          `json:"source_kind"`
	Content        json.RawMessage `json:"content"`
	Hash           string          `json:"hash"`
	ContextRefs    json.RawMessage `json:"context_refs"`
	Status         string          `json:"status"`
	CreatedAt      time.Time       `json:"created_at"`
	Available      bool            `json:"available"`
	OpenURL        string          `json:"open_url,omitempty"`
	ImageURL       string          `json:"image_url,omitempty"`
	ObjectRevision string          `json:"object_revision,omitempty"`
}

type agentArtifactDetailResponse struct {
	Artifact       agentArtifactView          `json:"artifact"`
	CurrentVersion *agentArtifactVersionView  `json:"current_version"`
	Versions       []agentArtifactVersionView `json:"versions"`
	NextCursor     *string                    `json:"next_cursor"`
}

func (s *Server) listAgentArtifacts(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("artifacts"); err != nil {
		return err
	}
	conversationID, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	if _, err := s.agentConversationFor(r.Context(), conversationID); err != nil {
		return err
	}
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 30 {
		return validation("每页产物最多 30 项")
	}
	var cursor *agentArtifactCursor
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil {
			return validation("产物分页游标无效")
		}
		var parsed agentArtifactCursor
		if err := json.Unmarshal(data, &parsed); err != nil || parsed.Version != 1 || parsed.ID == uuid.Nil || parsed.UpdatedAt.IsZero() {
			return validation("产物分页游标无效")
		}
		cursor = &parsed
	}
	query := `SELECT a.id,a.kind,a.title,coalesce(v.version,0),coalesce(v.source_kind,''),v.source_run_id,a.updated_at
		FROM agent_artifact a
		JOIN agent_conversation c ON c.id=a.conversation_id
		LEFT JOIN agent_artifact_version v ON v.id=a.current_version_id AND v.artifact_id=a.id
		WHERE a.conversation_id=$1 AND c.workspace_id=$2 AND c.user_id=$3`
	args := []any{conversationID, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID}
	if cursor != nil {
		query += ` AND (a.updated_at,a.id)<($4,$5)`
		args = append(args, cursor.UpdatedAt, cursor.ID)
	}
	args = append(args, limit+1)
	query += ` ORDER BY a.updated_at DESC,a.id DESC LIMIT $` + strconv.Itoa(len(args))
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := make([]agentArtifactSummary, 0, limit+1)
	for rows.Next() {
		var item agentArtifactSummary
		if err := rows.Scan(&item.ID, &item.Kind, &item.Title, &item.CurrentVersion, &item.CurrentSource, &item.SourceRunID, &item.UpdatedAt); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		data, err := json.Marshal(agentArtifactCursor{Version: 1, UpdatedAt: last.UpdatedAt, ID: last.ID})
		if err != nil {
			return err
		}
		token := base64.RawURLEncoding.EncodeToString(data)
		next = &token
	}
	return ok(w, agentArtifactListResponse{Items: items, NextCursor: next})
}

func (s *Server) getAgentArtifact(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("artifacts"); err != nil {
		return err
	}
	artifactID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var response agentArtifactDetailResponse
	var currentID *uuid.UUID
	if err := s.db.QueryRow(r.Context(), `SELECT a.id,a.conversation_id,a.kind,a.title,a.current_version_id,a.created_at,a.updated_at
		FROM agent_artifact a JOIN agent_conversation c ON c.id=a.conversation_id
		WHERE a.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`,
		artifactID, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID).
		Scan(&response.Artifact.ID, &response.Artifact.ConversationID, &response.Artifact.Kind, &response.Artifact.Title,
			&currentID, &response.Artifact.CreatedAt, &response.Artifact.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	response.Artifact.CurrentVersionID = currentID
	response.Versions = []agentArtifactVersionView{}
	requestedVersion := strings.TrimSpace(r.URL.Query().Get("version"))
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 20 {
		return validation("每页产物版本最多 20 项")
	}
	beforeVersion := 0
	if cursor := strings.TrimSpace(r.URL.Query().Get("cursor")); cursor != "" {
		beforeVersion, err = strconv.Atoi(cursor)
		if err != nil || beforeVersion < 2 {
			return validation("产物版本游标无效")
		}
	}
	var versionsRows pgx.Rows
	if beforeVersion > 0 {
		versionsRows, err = s.db.Query(r.Context(), `SELECT id,version,source_run_id,source_message_id,source_ai_call_id,
			source_kind,hash,status,created_at FROM agent_artifact_version
			WHERE artifact_id=$1 AND version<$2 ORDER BY version DESC LIMIT $3`, artifactID, beforeVersion, limit+1)
	} else {
		versionsRows, err = s.db.Query(r.Context(), `SELECT id,version,source_run_id,source_message_id,source_ai_call_id,
			source_kind,hash,status,created_at FROM agent_artifact_version
			WHERE artifact_id=$1 ORDER BY version DESC LIMIT $2`, artifactID, limit+1)
	}
	if err != nil {
		return err
	}
	for versionsRows.Next() {
		var meta agentArtifactVersionView
		if err := versionsRows.Scan(&meta.ID, &meta.Version, &meta.SourceRunID, &meta.SourceMessage,
			&meta.SourceAICallID, &meta.SourceKind, &meta.Hash, &meta.Status, &meta.CreatedAt); err != nil {
			versionsRows.Close()
			return err
		}
		meta.Content = json.RawMessage(`{}`)
		meta.Available = true
		response.Versions = append(response.Versions, meta)
	}
	if err := versionsRows.Err(); err != nil {
		versionsRows.Close()
		return err
	}
	versionsRows.Close()
	if len(response.Versions) > limit {
		response.Versions = response.Versions[:limit]
		token := strconv.Itoa(response.Versions[len(response.Versions)-1].Version)
		response.NextCursor = &token
	}
	if requestedVersion == "" && currentID == nil {
		return ok(w, response)
	}
	var version agentArtifactVersionView
	var contentRef []byte
	var versionQuery string
	var versionArgs []any
	if requestedVersion != "" {
		n, err := strconv.Atoi(requestedVersion)
		if err != nil || n < 1 {
			return validation("产物版本无效")
		}
		versionQuery = `SELECT id,version,source_run_id,source_message_id,source_ai_call_id,source_kind,content_ref,hash,context_refs,status,created_at
			FROM agent_artifact_version WHERE artifact_id=$1 AND version=$2`
		versionArgs = []any{artifactID, n}
	} else {
		versionQuery = `SELECT id,version,source_run_id,source_message_id,source_ai_call_id,source_kind,content_ref,hash,context_refs,status,created_at
			FROM agent_artifact_version WHERE artifact_id=$1 AND id=$2`
		versionArgs = []any{artifactID, *currentID}
	}
	if err := s.db.QueryRow(r.Context(), versionQuery, versionArgs...).Scan(&version.ID, &version.Version,
		&version.SourceRunID, &version.SourceMessage, &version.SourceAICallID, &version.SourceKind,
		&contentRef, &version.Hash, &version.ContextRefs, &version.Status, &version.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	version.Content = append(json.RawMessage(nil), contentRef...)
	version.Available = true
	if !json.Valid(version.ContextRefs) {
		version.ContextRefs = json.RawMessage(`[]`)
	}
	var source struct {
		AttachmentID string `json:"attachment_id"`
		ObjectRef    struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"object_ref"`
	}
	_ = json.Unmarshal(contentRef, &source)
	if version.SourceKind == "attachment" {
		attachmentID, err := uuid.Parse(source.AttachmentID)
		if err != nil {
			version.Available = false
		} else {
			var storagePath string
			if err := s.db.QueryRow(r.Context(), `SELECT storage_path FROM agent_attachment
				WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND kind='image' AND referenced=true
				AND EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=agent_attachment.id
					AND r.conversation_id=$4 AND (r.artifact_version_id=$5 OR r.message_id=$6))`,
				attachmentID, ident(r.Context()).WorkspaceID, ident(r.Context()).UserID, response.Artifact.ConversationID,
				version.ID, version.SourceMessage).Scan(&storagePath); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					version.Available = false
				} else {
					return err
				}
			} else if _, err := os.Stat(s.agentAttachmentFile(agentAttachmentVariantPath(storagePath, "thumb"))); err != nil {
				version.Available = false
			} else {
				version.ImageURL = "/api/v1/agent/attachments/" + attachmentID.String() + "/file?variant=thumb&conversation_id=" + response.Artifact.ConversationID.String()
			}
		}
	}
	if source.ObjectRef.Type == "work" {
		workID, err := uuid.Parse(source.ObjectRef.ID)
		if err == nil {
			var revision int
			err := s.db.QueryRow(r.Context(), `SELECT w.revision FROM work w JOIN platform_account a ON a.id=w.account_id
				WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, ident(r.Context()).WorkspaceID).Scan(&revision)
			if err == nil {
				version.ObjectRevision = strconv.Itoa(revision)
				version.OpenURL, _ = agentBuildLink("work", "", workID.String(), "", "", "")
			} else if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
	}
	if !version.Available {
		version.Status = "source_unavailable"
	}
	response.CurrentVersion = &version
	return ok(w, response)
}

func (s *Server) postAgentArtifactVersion(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("artifacts"); err != nil {
		return err
	}
	artifactID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var req struct {
		RequestID       string `json:"request_id"`
		ExpectedVersion int    `json:"expected_version"`
		Content         string `json:"content"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.RequestID))
	if err != nil || requestID == uuid.Nil || req.ExpectedVersion < 1 {
		return validation("保存版本需要有效的 request_id 和 expected_version")
	}
	text := strings.TrimSpace(req.Content)
	if text == "" || runeLen(text) > 20000 {
		return validation("产物内容必须为1～20000字")
	}
	if agentContainsSecret(text, s.agentSecretValues(r.Context(), ident(r.Context()).WorkspaceID)) {
		return validation("产物疑似包含密钥或密码，不能保存")
	}
	identity := ident(r.Context())
	operation := "artifact.version:" + artifactID.String()
	payload := map[string]any{"expected_version": req.ExpectedVersion, "content": text}
	content, err := json.Marshal(map[string]any{"format": "text", "text": text})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(content)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, identity.UserID); err != nil {
		return err
	}
	var conversationID, locked uuid.UUID
	if err := tx.QueryRow(r.Context(), `SELECT c.id FROM agent_artifact a JOIN agent_conversation c ON c.id=a.conversation_id
		WHERE a.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, artifactID, identity.WorkspaceID, identity.UserID).Scan(&conversationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if err := tx.QueryRow(r.Context(), `SELECT id FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		conversationID, identity.WorkspaceID, identity.UserID).Scan(&locked); err != nil {
		return err
	}
	var currentVersionID *uuid.UUID
	var kind string
	if err := tx.QueryRow(r.Context(), `SELECT current_version_id,kind FROM agent_artifact WHERE id=$1 AND conversation_id=$2 FOR UPDATE`,
		artifactID, conversationID).Scan(&currentVersionID, &kind); err != nil {
		return errNotFound
	}
	resource, err := claimAgentRequest(r.Context(), tx, identity.WorkspaceID, identity.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if resource != nil {
		var version int
		if err := tx.QueryRow(r.Context(), `SELECT version FROM agent_artifact_version WHERE id=$1 AND artifact_id=$2`, *resource, artifactID).Scan(&version); err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		return ok(w, map[string]any{"artifact_id": artifactID, "version_id": *resource, "version": version, "replayed": true})
	}
	currentNumber := 0
	if currentVersionID != nil {
		if err := tx.QueryRow(r.Context(), `SELECT version FROM agent_artifact_version WHERE id=$1 AND artifact_id=$2`, *currentVersionID, artifactID).Scan(&currentNumber); err != nil {
			return err
		}
	}
	if currentNumber != req.ExpectedVersion {
		return apiErr(409, "agent_revision_conflict", "产物版本已变化，请刷新后再保存")
	}
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_artifact_version v JOIN agent_artifact a ON a.id=v.artifact_id WHERE a.conversation_id=$1`, conversationID).Scan(&count); err != nil {
		return err
	}
	if count >= 100 {
		return apiErr(429, "agent_input_limit_reached", "本对话产物版本已达100项上限")
	}
	version := currentNumber + 1
	var versionID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_artifact_version(artifact_id,version,source_kind,content_ref,hash,status)
		VALUES($1,$2,'chat',$3,$4,'draft') RETURNING id`, artifactID, version, content, hex.EncodeToString(hash[:])).Scan(&versionID); err != nil {
		return err
	}
	var tag pgconn.CommandTag
	if currentVersionID == nil {
		tag, err = tx.Exec(r.Context(), `UPDATE agent_artifact SET current_version_id=$2,updated_at=now() WHERE id=$1 AND current_version_id IS NULL`, artifactID, versionID)
	} else {
		tag, err = tx.Exec(r.Context(), `UPDATE agent_artifact SET current_version_id=$2,updated_at=now() WHERE id=$1 AND current_version_id=$3`, artifactID, versionID, *currentVersionID)
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return apiErr(409, "agent_revision_conflict", "产物版本已变化，请刷新后再保存")
	}
	if _, err := appendAgentEventTx(r.Context(), tx, conversationID, nil, "artifact.created", map[string]any{
		"artifact_id": artifactID, "version_id": versionID, "version": version, "source_kind": "chat",
	}, nil); err != nil {
		return err
	}
	if err := completeAgentRequest(r.Context(), tx, identity.WorkspaceID, identity.UserID, operation, requestID, versionID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]any{"artifact_id": artifactID, "version_id": versionID, "version": version, "kind": kind})
}

func (s *Server) agentInsertArtifactTx(ctx context.Context, tx pgx.Tx, conversationID uuid.UUID, kind, title, sourceKind string,
	content json.RawMessage, hash string, sourceRunID, sourceMessageID, sourceAICallID *uuid.UUID) (uuid.UUID, error) {
	if _, err := tx.Exec(ctx, `SELECT id FROM agent_conversation WHERE id=$1 FOR UPDATE`, conversationID); err != nil {
		return uuid.Nil, err
	}
	var conversationVersions int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_artifact_version v JOIN agent_artifact a ON a.id=v.artifact_id WHERE a.conversation_id=$1`, conversationID).Scan(&conversationVersions); err != nil {
		return uuid.Nil, err
	}
	if conversationVersions >= 100 || len(content) > 1<<20 {
		return uuid.Nil, errAgentArtifactLimit
	}
	if sourceRunID != nil {
		var runArtifacts int
		if err := tx.QueryRow(ctx, `SELECT count(DISTINCT a.id) FROM agent_artifact a JOIN agent_artifact_version v ON v.artifact_id=a.id
			WHERE a.conversation_id=$1 AND v.source_run_id=$2`, conversationID, *sourceRunID).Scan(&runArtifacts); err != nil {
			return uuid.Nil, err
		}
		if runArtifacts >= 10 {
			return uuid.Nil, errAgentArtifactLimit
		}
	}
	title = truncate(strings.TrimSpace(title), 200)
	if title == "" {
		title = "对话产物"
	}
	if !json.Valid(content) {
		return uuid.Nil, errors.New("invalid artifact content")
	}
	var artifactID, versionID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO agent_artifact(conversation_id,kind,title)
		VALUES ($1,$2,$3) RETURNING id`, conversationID, kind, title).Scan(&artifactID); err != nil {
		return uuid.Nil, err
	}
	if err := tx.QueryRow(ctx, `INSERT INTO agent_artifact_version
		(artifact_id,version,source_run_id,source_message_id,source_ai_call_id,source_kind,content_ref,hash,status)
		VALUES ($1,1,$2,$3,$4,$5,$6,$7,'draft') RETURNING id`, artifactID, sourceRunID, sourceMessageID,
		sourceAICallID, sourceKind, content, hash).Scan(&versionID); err != nil {
		return uuid.Nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_artifact SET current_version_id=$2 WHERE id=$1`, artifactID, versionID); err != nil {
		return uuid.Nil, err
	}
	return artifactID, nil
}

func (s *Server) agentMetaPresentArtifact(ctx context.Context, st *agentRunState, args map[string]any) ([]byte, string, error) {
	if !agentWorkbenchFeatures()["artifacts"] || (st.ExecutionOrigin != "interactive" && st.ExecutionOrigin != "goal") || st.Trigger == "routine" {
		return nil, "", apiErr(403, "forbidden", "当前运行不能创建对话产物")
	}
	title, _ := args["title"].(string)
	title = strings.TrimSpace(title)
	kind, _ := args["kind"].(string)
	chatContent, hasChat := args["chat_content"].(string)
	_, hasSource := args["source_ref"]
	if title == "" || runeLen(title) > 200 || (kind != "markdown" && kind != "title" && kind != "table") || hasChat == hasSource {
		return nil, "", apiErr(422, "invalid_arguments", "请提供标题、有效类型，并在资料引用或聊天草稿中选择一项来源")
	}
	chatContent = strings.TrimSpace(chatContent)
	if hasChat && (chatContent == "" || runeLen(chatContent) > 20000) {
		return nil, "", apiErr(422, "invalid_arguments", "聊天草稿必须为1～20000字")
	}
	if hasChat && agentContainsSecret(chatContent, s.agentSecretValues(ctx, st.WorkspaceID)) {
		return nil, "", validation("草稿疑似包含密钥或密码，不能保存到产物")
	}
	contextRefs := []agentContextReference{}
	if hasSource {
		if err := requireAgentFeature("context_refs"); err != nil {
			return nil, "", err
		}
		var ref agentContextReference
		if err := agentDecodeToolArgument(args, "source_ref", &ref); err != nil {
			return nil, "", err
		}
		ref.Scope = "turn"
		var err error
		contextRefs, err = s.agentValidateContextReferences(ctx, []agentContextReference{ref}, st.AccountID, st.ConversationID)
		if err != nil {
			return nil, "", err
		}
		resolved, err := s.agentResolveContextReferenceInConversation(ctx, contextRefs[0], st.AccountID, &st.ConversationID)
		if err != nil {
			return nil, "", err
		}
		chatContent = strings.TrimSpace(resolved.Name + "\n\n" + resolved.Content)
		if runeLen(chatContent) > 20000 {
			chatContent = truncate(chatContent, 20000)
		}
		if agentContainsSecret(chatContent, s.agentSecretValues(ctx, st.WorkspaceID)) {
			return nil, "", validation("引用内容疑似包含密钥或密码，不能保存到产物")
		}
	}
	content, err := json.Marshal(map[string]any{"format": "text", "text": chatContent})
	if err != nil {
		return nil, "", err
	}
	hash := sha256.Sum256(content)
	refsJSON, err := json.Marshal(contextRefs)
	if err != nil {
		return nil, "", err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)
	artifactID, err := s.agentInsertArtifactTx(ctx, tx, st.ConversationID, kind, title, "chat", content,
		hex.EncodeToString(hash[:]), &st.RunID, nil, nil)
	if err != nil {
		if errors.Is(err, errAgentArtifactLimit) {
			return nil, "", apiErr(429, "agent_input_limit_reached", "本次运行或对话的产物版本已达上限")
		}
		return nil, "", err
	}
	var versionID uuid.UUID
	var version int
	if err := tx.QueryRow(ctx, `SELECT current_version_id FROM agent_artifact WHERE id=$1`, artifactID).Scan(&versionID); err != nil {
		return nil, "", err
	}
	if err := tx.QueryRow(ctx, `SELECT version FROM agent_artifact_version WHERE id=$1`, versionID).Scan(&version); err != nil {
		return nil, "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_artifact_version SET context_refs=$2 WHERE id=$1`, versionID, refsJSON); err != nil {
		return nil, "", err
	}
	if _, err := appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "artifact.created", map[string]any{
		"artifact_id": artifactID, "version_id": versionID, "version": version, "source_kind": "chat",
	}, nil); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	payload, err := json.Marshal(map[string]any{"ok": true, "artifact_id": artifactID, "version_id": versionID, "version": version})
	return payload, "已保存对话草稿产物：" + title, err
}

func (s *Server) agentProjectUploadedImagesTx(ctx context.Context, tx pgx.Tx, conversationID, messageID uuid.UUID,
	attachmentIDs []uuid.UUID) error {
	if !agentWorkbenchFeatures()["artifacts"] || len(attachmentIDs) == 0 {
		return nil
	}
	for _, attachmentID := range attachmentIDs {
		var name, mime, sha string
		var bytes int
		var width, height *int
		err := tx.QueryRow(ctx, `SELECT name,mime,bytes,width,height,sha256 FROM agent_attachment
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND kind='image' AND referenced=true
			AND EXISTS(SELECT 1 FROM agent_attachment_ref r WHERE r.attachment_id=agent_attachment.id
				AND r.conversation_id=$4 AND r.message_id=$5)`,
			attachmentID, ident(ctx).WorkspaceID, ident(ctx).UserID, conversationID, messageID).Scan(&name, &mime, &bytes, &width, &height, &sha)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		content, err := json.Marshal(map[string]any{"format": "image", "attachment_id": attachmentID.String(), "name": name,
			"mime": mime, "bytes": bytes, "width": width, "height": height})
		if err != nil {
			return err
		}
		artifactID, err := s.agentInsertArtifactTx(ctx, tx, conversationID, "image", name, "attachment", content, sha,
			nil, &messageID, nil)
		if errors.Is(err, errAgentArtifactLimit) {
			continue
		}
		if err != nil {
			return err
		}
		var versionID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT current_version_id FROM agent_artifact WHERE id=$1`, artifactID).Scan(&versionID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_attachment_ref(attachment_id,conversation_id,workspace_id,user_id,artifact_version_id)
			VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, attachmentID, conversationID, ident(ctx).WorkspaceID,
			ident(ctx).UserID, versionID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) agentProjectGArtifact(ctx context.Context, st *agentRunState, toolName, callID string,
	args map[string]any, raw []byte) error {
	if !agentWorkbenchFeatures()["artifacts"] || !json.Valid(raw) {
		return nil
	}
	var content struct {
		Titles []struct {
			Text string `json:"text"`
		} `json:"titles"`
		Summary string `json:"summary"`
	}
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil
	}
	kind, title := "business_ref", "工具结果 · "+toolName
	if toolName == "works__titles" {
		if len(content.Titles) == 0 || strings.TrimSpace(content.Titles[0].Text) == "" {
			return nil
		}
		kind, title = "title", "标题候选"
	} else if toolName == "works__summary" && strings.TrimSpace(content.Summary) != "" {
		kind, title = "markdown", "作品摘要"
	}
	workID, _ := uuid.Parse(strings.TrimSpace(anyString(args["id"])))
	var workTitle string
	var revision int
	validWork := false
	if workID != uuid.Nil {
		validWork = s.db.QueryRow(ctx, `SELECT w.title,w.revision FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL`, workID, st.WorkspaceID).
			Scan(&workTitle, &revision) == nil
	}
	objectRef := map[string]any{}
	if validWork {
		objectRef = map[string]any{"type": "work", "id": workID.String(), "revision": revision, "title": workTitle}
	}
	data, err := json.Marshal(map[string]any{"format": "json", "tool_name": toolName, "data": json.RawMessage(raw), "object_ref": objectRef})
	if err != nil || len(data) > 1<<20 {
		return nil
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM agent_conversation WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`,
		st.ConversationID, st.WorkspaceID, st.UserID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	var messageID uuid.UUID
	var sourceAICallID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id,ai_call_id FROM agent_message
		WHERE conversation_id=$1 AND run_id=$2 AND tool_call_id=$3 AND role='tool'`,
		st.ConversationID, st.RunID, callID).Scan(&messageID, &sourceAICallID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_artifact_version WHERE source_message_id=$1 AND source_kind='g_tool')`, messageID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	hash := sha256.Sum256(raw)
	_, err = s.agentInsertArtifactTx(ctx, tx, st.ConversationID, kind, title, "g_tool", data,
		hex.EncodeToString(hash[:]), &st.RunID, &messageID, sourceAICallID)
	if err != nil {
		if errors.Is(err, errAgentArtifactLimit) {
			return nil
		}
		return err
	}
	return tx.Commit(ctx)
}

func anyString(v any) string {
	s, _ := v.(string)
	return s
}
