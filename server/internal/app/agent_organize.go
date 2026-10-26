package app

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type agentConversationGroup struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	CreatedAt string    `json:"created_at"`
}

func agentCheckConversationWritable(conversation *agentConversation) error {
	if conversation.ArchivedAt != nil {
		return apiErr(409, "agent_conversation_archived", "对话已归档，请先恢复后再开始运行")
	}
	return nil
}

func (s *Server) listAgentConversationGroups(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	id := ident(r.Context())
	rows, err := s.db.Query(r.Context(), `SELECT id,name,created_at::text FROM agent_conversation_group
		WHERE workspace_id=$1 AND user_id=$2 ORDER BY lower(btrim(name)), id`, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	groups := []agentConversationGroup{}
	for rows.Next() {
		var group agentConversationGroup
		if err := rows.Scan(&group.ID, &group.Name, &group.CreatedAt); err != nil {
			return err
		}
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, groups)
}

func (s *Server) createAgentConversationGroup(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	id := ident(r.Context())
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || runeLen(name) > 30 {
		return validation("分组名称须为1～30字")
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	lockKey := id.WorkspaceID.String() + ":" + id.UserID.String()
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_conversation_group WHERE workspace_id=$1 AND user_id=$2`,
		id.WorkspaceID, id.UserID).Scan(&count); err != nil {
		return err
	}
	if count >= 20 {
		return apiErr(409, "agent_group_limit_reached", "每个工作区最多创建20个私有分组")
	}
	var group agentConversationGroup
	err = tx.QueryRow(r.Context(), `INSERT INTO agent_conversation_group (workspace_id,user_id,name)
		VALUES ($1,$2,$3) RETURNING id,name,created_at::text`, id.WorkspaceID, id.UserID, name).
		Scan(&group.ID, &group.Name, &group.CreatedAt)
	if err != nil {
		return agentConversationGroupWriteError(err)
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, group)
}

func (s *Server) patchAgentConversationGroup(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	id := ident(r.Context())
	groupID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || runeLen(name) > 30 {
		return validation("分组名称须为1～30字")
	}
	var group agentConversationGroup
	err = s.db.QueryRow(r.Context(), `UPDATE agent_conversation_group SET name=$4
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 RETURNING id,name,created_at::text`,
		groupID, id.WorkspaceID, id.UserID, name).Scan(&group.ID, &group.Name, &group.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return agentConversationGroupWriteError(err)
	}
	return ok(w, group)
}

func (s *Server) deleteAgentConversationGroup(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	id := ident(r.Context())
	groupID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var exists bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM agent_conversation_group
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3)`, groupID, id.WorkspaceID, id.UserID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return errNotFound
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_conversation SET group_id=NULL,revision=revision+1,updated_at=now()
		WHERE group_id=$1 AND workspace_id=$2 AND user_id=$3`, groupID, id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `DELETE FROM agent_conversation_group WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
		groupID, id.WorkspaceID, id.UserID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]bool{"ok": true})
}

func agentConversationGroupWriteError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apiErr(409, "agent_group_name_conflict", "已有同名分组")
	}
	return err
}

func (s *Server) markAgentConversationRead(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	id := ident(r.Context())
	var in struct {
		UptoMessageSeq *int64 `json:"upto_message_seq"`
		Unread         *bool  `json:"unread"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if (in.UptoMessageSeq == nil) == (in.Unread == nil) || (in.Unread != nil && !*in.Unread) {
		return validation("标读需提供 upto_message_seq 或 unread:true")
	}
	if in.UptoMessageSeq != nil && *in.UptoMessageSeq < 0 {
		return validation("消息序号无效")
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var owner uuid.UUID
	if err := tx.QueryRow(r.Context(), `SELECT user_id FROM agent_conversation
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE`, cid, id.WorkspaceID, id.UserID).Scan(&owner); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	if in.UptoMessageSeq != nil {
		var maximum int64
		if err := tx.QueryRow(r.Context(), `SELECT coalesce(max(seq),0) FROM agent_message WHERE conversation_id=$1`, cid).Scan(&maximum); err != nil {
			return err
		}
		if *in.UptoMessageSeq > maximum {
			return validation("不能标读尚未保存的消息")
		}
		_, err = tx.Exec(r.Context(), `UPDATE agent_conversation SET read_upto_message_seq=greatest(read_upto_message_seq,$4),
			force_unread=false,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND user_id=$3`,
			cid, id.WorkspaceID, id.UserID, *in.UptoMessageSeq)
	} else {
		_, err = tx.Exec(r.Context(), `UPDATE agent_conversation SET force_unread=true,revision=revision+1,updated_at=now()
			WHERE id=$1 AND workspace_id=$2 AND user_id=$3`, cid, id.WorkspaceID, id.UserID)
	}
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	c, err := s.agentConversationFor(r.Context(), cid)
	if err != nil {
		return err
	}
	var unread bool
	if err := s.db.QueryRow(r.Context(), `SELECT c.force_unread OR EXISTS (SELECT 1 FROM agent_message m
		WHERE m.conversation_id=c.id AND m.role IN ('assistant','action_result','system_note') AND m.seq>c.read_upto_message_seq)
		FROM agent_conversation c WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3`, cid, id.WorkspaceID, id.UserID).Scan(&unread); err != nil {
		return err
	}
	return ok(w, map[string]any{"conversation_id": cid, "read_upto_message_seq": c.ReadUptoMessageSeq,
		"force_unread": c.ForceUnread, "has_unread": unread, "revision": c.Revision})
}

type agentMessageSearchCursor struct {
	Seq int64
	ID  uuid.UUID
}

func parseAgentMessageSearchCursor(raw string) (*agentMessageSearchCursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, validation("搜索游标无效")
	}
	parts := strings.Split(string(b), "|")
	if len(parts) != 2 {
		return nil, validation("搜索游标无效")
	}
	var cursor agentMessageSearchCursor
	if _, err := fmt.Sscan(parts[0], &cursor.Seq); err != nil || cursor.Seq < 1 {
		return nil, validation("搜索游标无效")
	}
	if cursor.ID, err = uuid.Parse(parts[1]); err != nil {
		return nil, validation("搜索游标无效")
	}
	return &cursor, nil
}

func (s *Server) searchAgentConversationMessages(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("conversation_organize"); err != nil {
		return err
	}
	cid, err := s.agentConversationPathID(r)
	if err != nil {
		return err
	}
	if _, err := s.agentConversationFor(r.Context(), cid); err != nil {
		return err
	}
	q := truncateRunes(queryText(r, "q"), 100)
	if q == "" {
		return validation("请输入要查找的内容")
	}
	cursor, err := parseAgentMessageSearchCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		return err
	}
	limit := queryInt(r, "limit", 30)
	if limit < 1 || limit > 30 {
		return validation("搜索每页最多30条")
	}
	args := []any{cid, q}
	where := ""
	if cursor != nil {
		args = append(args, cursor.Seq, cursor.ID)
		where = ` AND (m.seq,m.id)<($3,$4)`
	}
	args = append(args, limit+1)
	limitPosition := len(args)
	rows, err := s.db.Query(r.Context(), `SELECT m.id,m.seq,
		substring(m.content FROM greatest(1,strpos(lower(m.content),lower($2))-60) FOR 140)
		FROM agent_message m WHERE m.conversation_id=$1 AND m.role IN ('user','assistant','action_result','system_note')
		AND m.content ILIKE '%%'||$2||'%%'`+where+fmt.Sprintf(` ORDER BY m.seq DESC,m.id DESC LIMIT $%d`, limitPosition), args...)
	if err != nil {
		return err
	}
	type item struct {
		MessageID uuid.UUID `json:"message_id"`
		Seq       int64     `json:"seq"`
		Snippet   string    `json:"snippet"`
	}
	items := []item{}
	for rows.Next() {
		var hit item
		if err := rows.Scan(&hit.MessageID, &hit.Seq, &hit.Snippet); err != nil {
			rows.Close()
			return err
		}
		items = append(items, hit)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	var nextCursor *string
	if hasMore {
		last := items[len(items)-1]
		raw := fmt.Sprintf("%d|%s", last.Seq, last.MessageID)
		encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
		nextCursor = &encoded
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

func groupIDFromJSON(raw []byte) (*uuid.UUID, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || strings.TrimSpace(value) == "" {
		return nil, validation("分组ID无效")
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, validation("分组ID无效")
	}
	return &id, nil
}
