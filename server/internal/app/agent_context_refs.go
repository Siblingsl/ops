package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"
)

type agentContextCandidate struct {
	ID        uuid.UUID  `json:"id"`
	Type      string     `json:"type"`
	Name      string     `json:"name"`
	Summary   string     `json:"summary"`
	Scope     string     `json:"scope"`
	AccountID *uuid.UUID `json:"account_id"`
	WorkID    *uuid.UUID `json:"work_id,omitempty"`
	Revision  string     `json:"revision"`
	UpdatedAt string     `json:"updated_at"`
	URL       string     `json:"url,omitempty"`
}

type agentContextReference struct {
	Type     string               `json:"type"`
	ID       uuid.UUID            `json:"id"`
	Revision string               `json:"revision,omitempty"`
	Scope    string               `json:"scope"`
	Name     string               `json:"name,omitempty"`
	Anchor   *agentArtifactAnchor `json:"anchor,omitempty"`
}

func agentValidateArtifactAnchor(content string, anchor *agentArtifactAnchor) error {
	if anchor == nil || anchor.Start < 0 || anchor.End <= anchor.Start || runeLen(anchor.Quote) == 0 || runeLen(anchor.Quote) > 2000 {
		return apiErr(422, "agent_context_unavailable", "选段已变化，请重新选择")
	}
	normalized := []rune(norm.NFC.String(content))
	quote := []rune(norm.NFC.String(anchor.Quote))
	if anchor.End > len(normalized) || anchor.End-anchor.Start != len(quote) || string(normalized[anchor.Start:anchor.End]) != string(quote) {
		return apiErr(422, "agent_context_unavailable", "选段已变化，请重新选择")
	}
	hash := sha256.Sum256([]byte(string(quote)))
	if !strings.EqualFold(anchor.QuoteHash, hex.EncodeToString(hash[:])) {
		return apiErr(422, "agent_context_unavailable", "选段校验已失效，请重新选择")
	}
	return nil
}

type agentArtifactAnchor struct {
	Start     int    `json:"start"`
	End       int    `json:"end"`
	QuoteHash string `json:"quote_hash"`
	Quote     string `json:"quote"`
}

type agentResolvedContext struct {
	agentContextCandidate
	Status  string               `json:"status"`
	Content string               `json:"content"`
	Anchor  *agentArtifactAnchor `json:"anchor,omitempty"`
}

type agentSkillRequest struct {
	SkillID uuid.UUID  `json:"skill_id"`
	WorkID  *uuid.UUID `json:"work_id,omitempty"`
	Name    string     `json:"name,omitempty"`
}

type agentContextPreviewRequest struct {
	ConversationID string                  `json:"conversation_id,omitempty"`
	AccountID      string                  `json:"account_id,omitempty"`
	ContextRefs    []agentContextReference `json:"context_refs"`
	SkillRequests  []agentSkillRequest     `json:"skill_requests"`
	AttachmentIDs  []string                `json:"attachment_ids"`
}

type agentContextCursor struct {
	Version int    `json:"v"`
	Query   string `json:"q"`
	Offset  int    `json:"o"`
}

func (s *Server) getAgentContextCandidates(w http.ResponseWriter, r *http.Request) error {
	if err := requireAgentFeature("context_refs"); err != nil {
		return err
	}
	q := r.URL.Query()
	kind := strings.TrimSpace(q.Get("type"))
	if kind != "work" && kind != "material" && kind != "topic" && kind != "image" && kind != "report" {
		return validation("引用类型无效")
	}
	search := strings.TrimSpace(q.Get("q"))
	if runeLen(search) > 100 {
		return validation("搜索词最多 100 字")
	}
	limit := queryInt(r, "limit", 20)
	if limit < 1 || limit > 20 {
		return validation("每页最多返回 20 条")
	}
	var accountID *uuid.UUID
	if raw := strings.TrimSpace(q.Get("account_id")); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return errNotFound
		}
		if _, err := s.visibleAccount(r.Context(), id); err != nil {
			return err
		}
		accountID = &id
	}
	if (kind == "work" || kind == "topic" || kind == "image" || kind == "report") && accountID == nil {
		return validationFields("此类引用需要选择操作账号", map[string]string{"account_id": "required"})
	}
	queryHash, err := agentRequestPayloadHash(map[string]any{"type": kind, "account_id": canonUUID(accountID), "q": search, "limit": limit})
	if err != nil {
		return err
	}
	offset := 0
	if token := strings.TrimSpace(q.Get("cursor")); token != "" {
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil {
			return validation("上下文分页游标无效")
		}
		var cursor agentContextCursor
		if err := json.Unmarshal(raw, &cursor); err != nil || cursor.Version != 1 || cursor.Offset < 0 {
			return validation("上下文分页游标无效")
		}
		if cursor.Query != queryHash {
			return apiErr(409, "cursor_stale", "搜索条件已变化，请重新搜索")
		}
		offset = cursor.Offset
	}
	var query string
	args := []any{ident(r.Context()).WorkspaceID, accountID, search, limit + 1, offset}
	switch kind {
	case "work":
		query = `SELECT w.id, w.title, w.content_format||' · '||w.status, w.account_id,
			w.revision::text||':'||to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), NULL::uuid,
			to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE a.workspace_id=$1 AND w.account_id=$2 AND w.deleted_at IS NULL
			AND ($3='' OR w.title ILIKE '%'||$3||'%' OR w.summary ILIKE '%'||$3||'%')
			ORDER BY w.updated_at DESC,w.id DESC LIMIT $4 OFFSET $5`
	case "material":
		query = `SELECT m.id,left(m.content,120),m.kind||' · '||coalesce(nullif(m.source,''),'工作区素材'),m.account_id,
			to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),NULL::uuid,
			to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM material m WHERE m.workspace_id=$1 AND m.deleted_at IS NULL
			AND (($2::uuid IS NULL AND m.account_id IS NULL) OR m.account_id IS NULL OR m.account_id=$2)
			AND ($3='' OR m.content ILIKE '%'||$3||'%' OR m.source ILIKE '%'||$3||'%' OR m.kind ILIKE '%'||$3||'%')
			ORDER BY m.updated_at DESC,m.id DESC LIMIT $4 OFFSET $5`
	case "topic":
		query = `SELECT t.id,t.title,left(t.angle,180),t.account_id,
			to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),NULL::uuid,
			to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM topic t JOIN platform_account a ON a.id=t.account_id
			WHERE a.workspace_id=$1 AND t.account_id=$2 AND t.deleted_at IS NULL
			AND ($3='' OR t.title ILIKE '%'||$3||'%' OR t.angle ILIKE '%'||$3||'%')
			ORDER BY t.updated_at DESC,t.id DESC LIMIT $4 OFFSET $5`
	case "image":
		query = `SELECT x.id,coalesce(nullif(w.title,''),'作品图片'),x.mime||' · '||x.width||'×'||x.height,x.account_id,
			to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),x.work_id,
			to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM asset x JOIN platform_account a ON a.id=x.account_id LEFT JOIN work w ON w.id=x.work_id
			WHERE x.workspace_id=$1 AND x.account_id=$2 AND a.workspace_id=$1
			AND ($3='' OR coalesce(w.title,'') ILIKE '%'||$3||'%' OR x.mime ILIKE '%'||$3||'%')
			ORDER BY x.created_at DESC,x.id DESC LIMIT $4 OFFSET $5`
	case "report":
		query = `SELECT r.id,'复盘报告 · '||to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),
			'包含 '||cardinality(r.work_ids)||' 篇作品',r.account_id,
			to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),NULL::uuid,
			to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
			FROM review_report r JOIN platform_account a ON a.id=r.account_id
			WHERE a.workspace_id=$1 AND r.account_id=$2
			AND ($3='' OR r.content::text ILIKE '%'||$3||'%')
			ORDER BY r.created_at DESC,r.id DESC LIMIT $4 OFFSET $5`
	}
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []agentContextCandidate{}
	for rows.Next() {
		var item agentContextCandidate
		item.Type = kind
		if err := rows.Scan(&item.ID, &item.Name, &item.Summary, &item.AccountID, &item.Revision, &item.WorkID, &item.UpdatedAt); err != nil {
			return err
		}
		if kind == "image" {
			item.URL = "/api/v1/assets/" + item.ID.String() + "/file?variant=512"
		}
		item.Scope = "workspace"
		if item.AccountID != nil {
			item.Scope = "account"
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var next any
	if len(items) > limit {
		items = items[:limit]
		encoded, _ := json.Marshal(agentContextCursor{Version: 1, Query: queryHash, Offset: offset + limit})
		next = base64.RawURLEncoding.EncodeToString(encoded)
	}
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) agentResolveContextReference(ctx context.Context, ref agentContextReference, accountID *uuid.UUID) (*agentResolvedContext, error) {
	return s.agentResolveContextReferenceInConversation(ctx, ref, accountID, nil)
}

func (s *Server) agentResolveContextReferenceInConversation(ctx context.Context, ref agentContextReference,
	accountID *uuid.UUID, conversationID *uuid.UUID) (*agentResolvedContext, error) {
	var item agentResolvedContext
	item.ID, item.Type = ref.ID, ref.Type
	item.Anchor = ref.Anchor
	var err error
	switch ref.Type {
	case "work":
		var sections string
		err = s.db.QueryRow(ctx, `SELECT w.title,w.content_format||' · '||w.status,w.account_id,
			w.revision::text||':'||to_char(w.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
			coalesce((SELECT string_agg(concat_ws(E'\n',s.heading,s.content_md),E'\n' ORDER BY s.position)
			FROM work_section s WHERE s.work_id=w.id),'')
			FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND a.workspace_id=$2 AND w.deleted_at IS NULL AND w.account_id=$3`,
			ref.ID, ident(ctx).WorkspaceID, accountID).Scan(&item.Name, &item.Summary, &item.AccountID, &item.Revision, &sections)
		item.Content = "作品：" + item.Name + "\n" + sections
		item.Scope = "account"
	case "material":
		err = s.db.QueryRow(ctx, `SELECT left(m.content,120),m.kind||' · '||coalesce(nullif(m.source,''),'工作区素材'),m.account_id,
			to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),m.content
			FROM material m WHERE m.id=$1 AND m.workspace_id=$2 AND m.deleted_at IS NULL
			AND (m.account_id IS NULL OR m.account_id=$3)`, ref.ID, ident(ctx).WorkspaceID, accountID).
			Scan(&item.Name, &item.Summary, &item.AccountID, &item.Revision, &item.Content)
		item.Scope = "workspace"
		if item.AccountID != nil {
			item.Scope = "account"
		}
	case "topic":
		err = s.db.QueryRow(ctx, `SELECT t.title,'选题 · '||t.status,t.account_id,
			to_char(t.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),t.title||E'\n'||t.angle
			FROM topic t JOIN platform_account a ON a.id=t.account_id
			WHERE t.id=$1 AND a.workspace_id=$2 AND t.account_id=$3 AND t.deleted_at IS NULL`,
			ref.ID, ident(ctx).WorkspaceID, accountID).Scan(&item.Name, &item.Summary, &item.AccountID, &item.Revision, &item.Content)
		item.Scope = "account"
	case "image":
		err = s.db.QueryRow(ctx, `SELECT coalesce(nullif(w.title,''),'作品图片'),x.mime||' · '||x.width||'×'||x.height,x.account_id,x.work_id,
			to_char(x.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
			FROM asset x JOIN platform_account a ON a.id=x.account_id LEFT JOIN work w ON w.id=x.work_id
			WHERE x.id=$1 AND x.workspace_id=$2 AND a.workspace_id=$2 AND x.account_id=$3`,
			ref.ID, ident(ctx).WorkspaceID, accountID).Scan(&item.Name, &item.Summary, &item.AccountID, &item.WorkID, &item.Revision)
		item.Scope = "account"
		item.URL = "/api/v1/assets/" + ref.ID.String() + "/file?variant=512"
	case "report":
		var content []byte
		err = s.db.QueryRow(ctx, `SELECT '复盘报告 · '||to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI'),
			'包含 '||cardinality(r.work_ids)||' 篇作品',r.account_id,
			to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),r.content
			FROM review_report r JOIN platform_account a ON a.id=r.account_id
			WHERE r.id=$1 AND a.workspace_id=$2 AND r.account_id=$3`, ref.ID, ident(ctx).WorkspaceID, accountID).
			Scan(&item.Name, &item.Summary, &item.AccountID, &item.Revision, &content)
		item.Content = string(content)
		item.Scope = "account"
	case "artifact_version":
		if conversationID == nil {
			return nil, apiErr(422, "agent_context_unavailable", "产物版本引用必须绑定到当前对话")
		}
		var content []byte
		err = s.db.QueryRow(ctx, `SELECT a.title||' · v'||v.version,'对话产物版本',NULL::uuid,
			v.hash,v.content_ref
			FROM agent_artifact_version v JOIN agent_artifact a ON a.id=v.artifact_id
			JOIN agent_conversation c ON c.id=a.conversation_id
			WHERE v.id=$1 AND c.id=$2 AND c.workspace_id=$3 AND c.user_id=$4`,
			ref.ID, *conversationID, ident(ctx).WorkspaceID, ident(ctx).UserID).
			Scan(&item.Name, &item.Summary, &item.AccountID, &item.Revision, &content)
		if err == nil {
			var body struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(content, &body)
			item.Content = body.Text
			item.Scope = "turn"
			if ref.Anchor != nil {
				if err := agentValidateArtifactAnchor(body.Text, ref.Anchor); err != nil {
					return nil, err
				}
				item.Content = "选段引用：\n" + ref.Anchor.Quote
			}
		}
	default:
		return nil, apiErr(422, "agent_context_unavailable", "所选资料类型不可用")
	}
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, apiErr(422, "agent_context_unavailable", "所选资料已删除、变更或无权访问，请重新选择")
		}
		return nil, err
	}
	if ref.Revision != "" && ref.Revision != item.Revision {
		return nil, apiErr(422, "agent_context_unavailable", "所选资料版本已变化，请重新选择")
	}
	item.agentContextCandidate.Scope = item.Scope
	return &item, nil
}

func (s *Server) agentValidateContextReferences(ctx context.Context, refs []agentContextReference,
	accountID *uuid.UUID, conversationIDs ...uuid.UUID) ([]agentContextReference, error) {
	if len(refs) > 12 {
		return nil, validation("每轮最多引用 12 项资料")
	}
	seen := map[string]bool{}
	out := make([]agentContextReference, 0, len(refs))
	for _, ref := range refs {
		if ref.ID == uuid.Nil {
			return nil, validation("引用ID无效")
		}
		if ref.Scope == "" {
			ref.Scope = "turn"
		}
		if ref.Scope != "turn" && ref.Scope != "conversation" {
			return nil, validation("引用范围无效")
		}
		key := ref.Type + ":" + ref.ID.String()
		if seen[key] {
			return nil, validation("同一资料不能重复引用")
		}
		seen[key] = true
		var conversationID *uuid.UUID
		if len(conversationIDs) > 0 {
			conversationID = &conversationIDs[0]
		}
		resolved, err := s.agentResolveContextReferenceInConversation(ctx, ref, accountID, conversationID)
		if err != nil {
			return nil, err
		}
		ref.Revision = resolved.Revision
		ref.Name = resolved.Name
		out = append(out, ref)
	}
	return out, nil
}

func (s *Server) agentValidateSkillRequests(ctx context.Context, accountID *uuid.UUID,
	requests []agentSkillRequest) error {
	if len(requests) > 3 {
		return validation("每次最多请求 3 项技能")
	}
	if len(requests) == 0 {
		return nil
	}
	if accountID == nil {
		return apiErr(422, "agent_skill_unavailable", "技能请求需要先选择操作账号")
	}
	account, err := s.visibleAccount(ctx, *accountID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	resolved := map[string]map[uuid.UUID]string{}
	for i, request := range requests {
		if request.SkillID == uuid.Nil {
			return validation("技能编号无效")
		}
		key := request.SkillID.String() + ":"
		format := account.ContentFormat
		if request.WorkID != nil {
			key += request.WorkID.String()
			if err := s.db.QueryRow(ctx, `SELECT content_format FROM work
				WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, *request.WorkID, account.ID).Scan(&format); err != nil {
				if err == pgx.ErrNoRows {
					return apiErr(422, "agent_skill_unavailable", "技能请求对应的作品已失效")
				}
				return err
			}
		}
		if seen[key] {
			return validation("同一上下文不能重复请求技能")
		}
		seen[key] = true
		contextKey := ""
		if request.WorkID != nil {
			contextKey = request.WorkID.String()
		}
		selected, ok := resolved[contextKey]
		if !ok {
			in := SkillResolveInput{WorkspaceID: ident(ctx).WorkspaceID, Account: account,
				ActorKind: "user", ActorUserID: &ident(ctx).UserID, WorkID: request.WorkID,
				TargetFormat: format, Surface: "agent"}
			result, err := s.resolveSkillSet(ctx, in)
			if err != nil {
				return err
			}
			selected = map[uuid.UUID]string{}
			for _, item := range result.Selected {
				selected[item.Def.ID] = item.Def.Fields.Name
			}
			resolved[contextKey] = selected
		}
		name, ok := selected[request.SkillID]
		if !ok {
			return apiErr(422, "agent_skill_unavailable", "所选技能当前不在此账号与作品的有效技能集中，请重新选择")
		}
		requests[i].Name = name
	}
	return nil
}

func (s *Server) postAgentContextPreview(w http.ResponseWriter, r *http.Request) error {
	var in agentContextPreviewRequest
	if err := decodeStrict(r, &in); err != nil {
		return err
	}
	if len(in.ContextRefs) > 12 || len(in.AttachmentIDs) > agentAttachmentsPerMessage || len(in.SkillRequests) > 3 {
		return validation("引用最多 12 项、附件最多 6 个、技能请求最多 3 项")
	}
	if len(in.ContextRefs) > 0 {
		if err := requireAgentFeature("context_refs"); err != nil {
			return err
		}
	}
	if len(in.SkillRequests) > 0 {
		if err := requireAgentFeature("skill_requests"); err != nil {
			return err
		}
	}
	var accountID *uuid.UUID
	var convID *uuid.UUID
	if strings.TrimSpace(in.AccountID) != "" {
		id, err := uuid.Parse(strings.TrimSpace(in.AccountID))
		if err != nil {
			return errNotFound
		}
		if _, err := s.visibleAccount(r.Context(), id); err != nil {
			return err
		}
		accountID = &id
	}
	if in.ConversationID != "" {
		cid, err := uuid.Parse(in.ConversationID)
		if err != nil {
			return errNotFound
		}
		conv, err := s.agentConversationFor(r.Context(), cid)
		if err != nil {
			return err
		}
		if in.AccountID == "" {
			accountID = conv.AccountID
		} else if conv.AccountID != nil && *conv.AccountID != *accountID {
			return apiErr(422, "agent_context_unavailable", "预览账号与对话账号不一致")
		}
		convID = &cid
	}
	if len(in.SkillRequests) > 0 {
		if err := s.agentValidateSkillRequests(r.Context(), accountID, in.SkillRequests); err != nil {
			return err
		}
	}
	if len(in.ContextRefs) == 0 && len(in.AttachmentIDs) == 0 && len(in.SkillRequests) == 0 {
		return validation("请选择要预览的资料或技能")
	}
	seen := map[string]bool{}
	items := []any{}
	chars := 0
	for _, ref := range in.ContextRefs {
		if ref.ID == uuid.Nil {
			return validation("引用ID无效")
		}
		if ref.Scope == "" {
			ref.Scope = "turn"
		}
		if ref.Scope != "turn" && ref.Scope != "conversation" {
			return validation("引用范围无效")
		}
		key := ref.Type + ":" + ref.ID.String()
		if seen[key] {
			return validation("同一资料不能重复引用")
		}
		seen[key] = true
		item, err := s.agentResolveContextReferenceInConversation(r.Context(), ref, accountID, convID)
		if err != nil {
			return err
		}
		item.Scope = ref.Scope
		item.Status = "available"
		items = append(items, *item)
		chars += runeLen(item.Content)
	}
	refs := make([]agentContextReference, 0, len(items))
	canonicalRefs := make([]agentContextReference, 0, len(in.ContextRefs))
	for _, rawRef := range in.ContextRefs {
		ref := rawRef
		if ref.Scope == "" {
			ref.Scope = "turn"
		}
		resolved, err := s.agentResolveContextReferenceInConversation(r.Context(), ref, accountID, convID)
		if err != nil {
			return err
		}
		ref.Revision = resolved.Revision
		canonicalRefs = append(canonicalRefs, ref)
	}
	refs = canonicalRefs
	attachments, attachmentIDs, attachmentChars, err := s.agentPreviewAttachments(r.Context(), convID, in.AttachmentIDs)
	if err != nil {
		return err
	}
	chars += attachmentChars
	for i := range attachments {
		items = append(items, attachments[i])
	}
	skillItems, err := s.agentPreviewSkillRequests(r.Context(), accountID, in.SkillRequests)
	if err != nil {
		return err
	}
	for i := range skillItems {
		items = append(items, skillItems[i])
	}
	if chars > agentWindowChars {
		return apiErr(422, "agent_context_unavailable", "所选资料超过本轮上下文容量，请减少引用后重试")
	}
	fingerprint, err := agentRequestPayloadHash(map[string]any{"account_id": canonUUID(accountID), "refs": refs,
		"attachment_ids": attachmentIDs, "skill_requests": in.SkillRequests})
	if err != nil {
		return err
	}
	return ok(w, map[string]any{
		"items": items, "omitted": []any{},
		"budget":               map[string]any{"context_chars": chars, "limit": agentWindowChars},
		"revision_fingerprint": fingerprint,
	})
}

func (s *Server) agentPreviewAttachments(ctx context.Context, convID *uuid.UUID, rawIDs []string) ([]agentResolvedContext,
	[]uuid.UUID, int, error) {
	if len(rawIDs) == 0 {
		return []agentResolvedContext{}, []uuid.UUID{}, 0, nil
	}
	ids := make([]uuid.UUID, 0, len(rawIDs))
	seen := map[uuid.UUID]bool{}
	for _, raw := range rawIDs {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil || id == uuid.Nil {
			return nil, nil, 0, apiErr(422, "agent_attachment_invalid", "附件不存在或已被删除")
		}
		if seen[id] {
			return nil, nil, 0, apiErr(422, "agent_attachment_invalid", "附件不能重复添加")
		}
		seen[id] = true
		ids = append(ids, id)
	}
	rows, err := s.db.Query(ctx, `SELECT id,kind,name,mime,bytes,coalesce(text_content,''),sha256
		FROM agent_attachment WHERE id=ANY($1) AND user_id=$2 AND referenced=false AND parse_status='ready'
		AND (conversation_id IS NULL OR conversation_id=$3) AND workspace_id=$4`, ids, ident(ctx).UserID, convID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, nil, 0, err
	}
	type attachment struct {
		id                             uuid.UUID
		kind, name, mime, content, sha string
		bytes                          int
	}
	byID := map[uuid.UUID]attachment{}
	for rows.Next() {
		var item attachment
		if err := rows.Scan(&item.id, &item.kind, &item.name, &item.mime, &item.bytes, &item.content, &item.sha); err != nil {
			rows.Close()
			return nil, nil, 0, err
		}
		byID[item.id] = item
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, 0, err
	}
	if len(byID) != len(ids) {
		return nil, nil, 0, apiErr(422, "agent_attachment_invalid", "附件已失效、已发送或不属于本人")
	}
	items := make([]agentResolvedContext, 0, len(ids))
	chars := 0
	for _, id := range ids {
		a := byID[id]
		if a.kind == "document" && agentContainsSecret(a.content, s.agentSecretValues(ctx, ident(ctx).WorkspaceID)) {
			if err := s.agentQuarantineDocument(ctx, a.id); err != nil {
				return nil, nil, 0, err
			}
			return nil, nil, 0, apiErr(422, "agent_attachment_parse_failed", "文档疑似含敏感凭据，已隔离，请删除并重新上传已清理的文件")
		}
		item := agentResolvedContext{agentContextCandidate: agentContextCandidate{
			ID: a.id, Type: "attachment", Name: a.name, Summary: a.mime, Scope: "turn", Revision: a.sha,
		}, Status: "available", Content: a.content}
		if a.kind == "image" {
			item.Summary = a.mime + " · 图片"
		}
		chars += runeLen(item.Content)
		items = append(items, item)
	}
	return items, ids, chars, nil
}

func (s *Server) agentPreviewSkillRequests(ctx context.Context, accountID *uuid.UUID,
	requests []agentSkillRequest) ([]agentResolvedContext, error) {
	if len(requests) == 0 {
		return []agentResolvedContext{}, nil
	}
	if accountID == nil {
		return nil, apiErr(422, "agent_skill_unavailable", "技能请求需要先选择操作账号")
	}
	account, err := s.visibleAccount(ctx, *accountID)
	if err != nil {
		return nil, err
	}
	items := make([]agentResolvedContext, 0, len(requests))
	for _, request := range requests {
		format := account.ContentFormat
		if request.WorkID != nil {
			if err := s.db.QueryRow(ctx, `SELECT content_format FROM work
				WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL`, *request.WorkID, account.ID).Scan(&format); err != nil {
				return nil, apiErr(422, "agent_skill_unavailable", "技能请求对应的作品已失效")
			}
		}
		result, err := s.resolveSkillSet(ctx, SkillResolveInput{
			WorkspaceID: ident(ctx).WorkspaceID, Account: account, ActorKind: "user", ActorUserID: &ident(ctx).UserID,
			WorkID: request.WorkID, TargetFormat: format, Surface: "agent",
		})
		if err != nil {
			return nil, err
		}
		var selected *skillDef
		for _, item := range result.Selected {
			if item.Def.ID == request.SkillID {
				selected = item.Def
				break
			}
		}
		if selected == nil {
			return nil, apiErr(422, "agent_skill_unavailable", "所选技能当前不在此账号与作品的有效技能集中，请重新选择")
		}
		var workID *uuid.UUID
		if request.WorkID != nil {
			workID = request.WorkID
		}
		items = append(items, agentResolvedContext{agentContextCandidate: agentContextCandidate{
			ID: selected.ID, Type: "skill", Name: selected.Fields.Name, Summary: skillCatalogHint(selected.Fields),
			Scope: selected.Scope, AccountID: accountID, WorkID: workID, Revision: strconv.FormatInt(selected.Revision, 10),
		}, Status: "requested"})
	}
	return items, nil
}
