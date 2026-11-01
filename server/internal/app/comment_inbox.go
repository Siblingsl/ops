package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DEV-CX13-E / FR-CX-22：评论处理台账。
// POST /comments 只接受单条（批量数组拒绝），用户逐条入库；无 author_raw；
// 删除清空正文与草稿（日志只留 ID）；回复发送由用户在平台完成，本台账不提供任何发送路径。
const (
	commentContentMax = 5000
	commentAliasMax   = 100
	commentReplyMax   = 80
	commentListPage   = 20
)

var commentCategories = map[string]bool{"question": true, "objection": true, "praise": true, "negative": true, "spam": true}

type commentInbox struct {
	ID           uuid.UUID  `json:"id"`
	AccountID    uuid.UUID  `json:"account_id"`
	WorkID       *uuid.UUID `json:"work_id"`
	AuthorAlias  string     `json:"author_alias"`
	Content      string     `json:"content"`
	CapturedAt   time.Time  `json:"captured_at"`
	Category     *string    `json:"category"`
	ReplyDraft   string     `json:"reply_draft"`
	ReplyStatus  string     `json:"reply_status"`
	Revision     int        `json:"revision"`
	ReplyRevision int       `json:"reply_revision"`
	AICallID     *uuid.UUID `json:"ai_call_id,omitempty"`
	CopiedAt     *time.Time `json:"copied_at,omitempty"`
	SentManualAt *time.Time `json:"sent_manual_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	Deleted      bool       `json:"deleted"`
}

const commentInboxCols = `id,account_id,work_id,author_alias,content,captured_at,category,reply_draft,reply_status,revision,reply_revision,ai_call_id,copied_at,sent_manual_at,created_at,updated_at`

func scanCommentInbox(row pgx.Row) (commentInbox, error) {
	var item commentInbox
	var category *string
	if err := row.Scan(&item.ID, &item.AccountID, &item.WorkID, &item.AuthorAlias, &item.Content, &item.CapturedAt,
		&category, &item.ReplyDraft, &item.ReplyStatus, &item.Revision, &item.ReplyRevision, &item.AICallID,
		&item.CopiedAt, &item.SentManualAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return item, err
	}
	item.Category = category
	return item, nil
}

func (s *Server) loadCommentInbox(ctx context.Context, id uuid.UUID) (commentInbox, error) {
	row := s.db.QueryRow(ctx, `SELECT `+commentInboxCols+` FROM comment_inbox
		WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, id, ident(ctx).WorkspaceID)
	item, err := scanCommentInbox(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return commentInbox{}, errNotFound
	}
	return item, err
}

// listCommentInbox：账号范围分页，category/reply_status 过滤（9.8）。
func (s *Server) listCommentInbox(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	category := strings.TrimSpace(r.URL.Query().Get("category"))
	if category != "" && !commentCategories[category] {
		return validation("category 枚举不正确")
	}
	status := strings.TrimSpace(r.URL.Query().Get("reply_status"))
	if status != "" && status != "none" && status != "drafted" && status != "copied" && status != "sent_manual" {
		return validation("reply_status 枚举不正确")
	}
	cursor := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		cursor, err = strconv.Atoi(raw)
		if err != nil || cursor < 0 {
			return validation("分页 cursor 格式不正确")
		}
	}
	args := []any{account.ID, commentListPage + 1}
	query := `SELECT ` + commentInboxCols + ` FROM comment_inbox WHERE account_id=$1 AND deleted_at IS NULL`
	if category != "" {
		args = append(args, category)
		query += ` AND category=$` + strconv.Itoa(len(args))
	}
	if status != "" {
		args = append(args, status)
		query += ` AND reply_status=$` + strconv.Itoa(len(args))
	}
	query += ` ORDER BY captured_at DESC, id DESC LIMIT $2`
	if cursor > 0 {
		query += ` OFFSET ` + strconv.Itoa(cursor)
	}
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []commentInbox{}
	for rows.Next() {
		item, scanErr := scanCommentInbox(rows)
		if scanErr != nil {
			return scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	nextCursor := 0
	if len(items) > commentListPage {
		items = items[:commentListPage]
		nextCursor = cursor + commentListPage
	}
	return ok(w, map[string]any{"items": items, "next_cursor": nextCursor})
}

// createCommentInbox：只接受单条；批量数组直接 422。
func (s *Server) createCommentInbox(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	var in struct {
		AccountID   *uuid.UUID `json:"account_id"`
		WorkID      *uuid.UUID `json:"work_id"`
		AuthorAlias string     `json:"author_alias"`
		Content     string     `json:"content"`
		CapturedAt  time.Time  `json:"captured_at"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	// POST /comments 无路由账号；按 body.account_id 解析并校验工作区（9.8 契约）。
	if in.AccountID == nil {
		return validation("需要 account_id")
	}
	account, err := s.account(r.Context(), *in.AccountID)
	if err != nil {
		return err
	}
	content := strings.TrimSpace(in.Content)
	if n := len([]rune(content)); n < 1 || n > commentContentMax {
		return validation("评论正文须为 1..5000 码点")
	}
	alias := strings.TrimSpace(in.AuthorAlias)
	if len([]rune(alias)) > commentAliasMax {
		return validation("作者别名最多 100 码点")
	}
	capturedAt := in.CapturedAt
	if capturedAt.IsZero() {
		capturedAt = s.now()
	}
	// 关联作品必须同账号同工作区。
	if in.WorkID != nil {
		var okRow bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND w.account_id=$2 AND w.deleted_at IS NULL AND a.workspace_id=$3)`,
			*in.WorkID, account.ID, ident(r.Context()).WorkspaceID).Scan(&okRow); err != nil {
			return err
		}
		if !okRow {
			return validation("关联作品不在当前账号范围内")
		}
	}
	item := commentInbox{}
	err = s.db.QueryRow(r.Context(), `INSERT INTO comment_inbox (workspace_id,account_id,work_id,author_alias,content,captured_at,created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING `+commentInboxCols,
		ident(r.Context()).WorkspaceID, account.ID, in.WorkID, alias, content, capturedAt, ident(r.Context()).UserID).
		Scan(&item.ID, &item.AccountID, &item.WorkID, &item.AuthorAlias, &item.Content, &item.CapturedAt,
			&item.Category, &item.ReplyDraft, &item.ReplyStatus, &item.Revision, &item.ReplyRevision, &item.AICallID,
			&item.CopiedAt, &item.SentManualAt, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return err
	}
	s.audit(r.Context(), "comment_inbox_create", "comment_inbox", item.ID.String(), "ok", map[string]any{"account_id": account.ID})
	writeJSON(w, http.StatusCreated, item)
	return nil
}

func (s *Server) getCommentInbox(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, item)
}

// patchCommentInbox：CAS；客户端不能任意设置 reply_status——copied/sent_manual 由专用动作产生。
func (s *Server) patchCommentInbox(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision int     `json:"base_revision"`
		Category     *string `json:"category"`
		Content      *string `json:"content"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision < 1 || in.BaseRevision != item.Revision {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	category := item.Category
	if in.Category != nil {
		if !commentCategories[*in.Category] {
			return validation("category 枚举不正确")
		}
		category = in.Category
	}
	content := item.Content
	if in.Content != nil {
		content = strings.TrimSpace(*in.Content)
		if n := len([]rune(content)); n < 1 || n > commentContentMax {
			return validation("评论正文须为 1..5000 码点")
		}
	}
	updated, err := scanCommentInbox(s.db.QueryRow(ctx, `UPDATE comment_inbox SET category=$3,content=$4,revision=revision+1,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$5 AND deleted_at IS NULL
		RETURNING `+commentInboxCols,
		item.ID, ident(ctx).WorkspaceID, category, content, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "comment_inbox_update", "comment_inbox", item.ID.String(), "ok", nil)
	return ok(w, updated)
}

// draftCommentReply：cx_comment_reply 只分类并拟 ≤80 码点草稿；一次纠错由 runAIJSON 内建；
// 重拟创建新草稿 revision 并清除旧 copied/sent 证明。
func (s *Server) draftCommentReply(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision int `json:"base_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision < 1 || in.BaseRevision != item.Revision {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	account, err := s.account(r.Context(), item.AccountID)
	if err != nil {
		return err
	}
	output := struct {
		Category string `json:"category"`
		Reply    string `json:"reply"`
	}{}
	userPrompt := "给以下读者评论分类并拟一条回复草稿。只输出 JSON：{\"category\":\"question|objection|praise|negative|spam\",\"reply\":\"≤80字的回复草稿\"}。" +
		"reply 要具体、可由作者直接使用；不得包含链接、承诺或敏感数据；不得复述评论中的个人信息。\n\n评论内容：\n" + item.Content
	aiResult, aiErr := s.runAIJSON(ctx, aiTask{Type: "cx_comment_reply", Account: account, User: userPrompt, Bare: true, SkipStyle: true},
		&output, func() error {
			if !commentCategories[output.Category] {
				return validation("category 枚举不正确")
			}
			reply := strings.TrimSpace(output.Reply)
			if n := len([]rune(reply)); n < 1 || n > commentReplyMax {
				return validation("回复草稿须为 1..80 码点")
			}
			return nil
		})
	if aiErr != nil {
		return aiErr
	}
	reply := strings.TrimSpace(output.Reply)
	updated, err := scanCommentInbox(s.db.QueryRow(ctx, `UPDATE comment_inbox SET category=$3,reply_draft=$4,reply_status='drafted',
		reply_revision=reply_revision+1,ai_call_id=$5,copied_at=NULL,sent_manual_at=NULL,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$6 AND deleted_at IS NULL
		RETURNING `+commentInboxCols,
		item.ID, ident(ctx).WorkspaceID, output.Category, reply, aiResult.CallID, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "comment_reply_draft", "comment_inbox", item.ID.String(), "ok", map[string]any{"reply_revision": updated.ReplyRevision})
	return ok(w, updated)
}

// copyCommentReply：copied 必须剪贴板真正成功——由客户端在复制成功后显式调用；
// 服务端只做状态机（drafted→copied）与 CAS。
func (s *Server) copyCommentReply(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision int `json:"base_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision != item.Revision {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if item.ReplyStatus != "drafted" && item.ReplyStatus != "copied" {
		return validation("只有已拟稿的评论才能记录复制")
	}
	now := s.now()
	updated, err := scanCommentInbox(s.db.QueryRow(ctx, `UPDATE comment_inbox SET reply_status='copied',copied_at=$3,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$4 AND reply_status IN ('drafted','copied') AND deleted_at IS NULL
		RETURNING `+commentInboxCols,
		item.ID, ident(ctx).WorkspaceID, now, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "comment_reply_copy", "comment_inbox", item.ID.String(), "ok", nil)
	return ok(w, updated)
}

// confirmSentComment：sent_manual 必须显式用户确认。
func (s *Server) confirmSentComment(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	var in struct {
		BaseRevision int `json:"base_revision"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if in.BaseRevision != item.Revision {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if item.ReplyStatus != "copied" {
		return validation("只有已复制到剪贴板的草稿才能确认已发送")
	}
	now := s.now()
	updated, err := scanCommentInbox(s.db.QueryRow(ctx, `UPDATE comment_inbox SET reply_status='sent_manual',sent_manual_at=$3,updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND revision=$4 AND reply_status='copied' AND deleted_at IS NULL
		RETURNING `+commentInboxCols,
		item.ID, ident(ctx).WorkspaceID, now, in.BaseRevision))
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(409, "version_conflict", "评论已被他人修改，请刷新后重试")
	}
	if err != nil {
		return err
	}
	s.audit(ctx, "comment_reply_sent_manual", "comment_inbox", item.ID.String(), "ok", nil)
	return ok(w, updated)
}

// deleteCommentInbox：软删除并清空正文/草稿/别名；日志只留 ID；已采用的选题保持独立。
func (s *Server) deleteCommentInbox(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE comment_inbox SET deleted_at=now(),content='',reply_draft='',author_alias='',updated_at=now()
		WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, item.ID, ident(ctx).WorkspaceID); err != nil {
		return err
	}
	s.audit(ctx, "comment_inbox_delete", "comment_inbox", item.ID.String(), "ok", nil)
	return ok(w, map[string]any{"deleted": true})
}

// convertCommentToTopic：仅用户点"转为选题"时预览脱敏摘要，确认后走既有单题创建；
// idempotency_key 防重复建题；不自动核验、不批量采用。
func (s *Server) commentTopicPreview(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(r.Context(), id)
	if err != nil {
		return err
	}
	// 脱敏摘要：正文前 120 码点 + 别名遮蔽；不写库。
	summary := item.Content
	if runes := []rune(summary); len(runes) > 120 {
		summary = string(runes[:120]) + "…"
	}
	return ok(w, map[string]any{"summary": summary, "category": item.Category})
}

func (s *Server) convertCommentToTopic(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	ctx := r.Context()
	id, err := pathID(r, "commentId")
	if err != nil {
		return err
	}
	item, err := s.loadCommentInbox(ctx, id)
	if err != nil {
		return err
	}
	var in struct {
		Title          string  `json:"title"`
		Angle          string  `json:"angle"`
		IdempotencyKey *string `json:"idempotency_key"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return validation("请填写选题标题")
	}
	// 幂等：同 key 同 payload 重放返回既有题；同 key 异 payload 409 idempotency_conflict（8.9）。
	var requestKey, requestHash string
	if in.IdempotencyKey != nil {
		requestKey = strings.TrimSpace(*in.IdempotencyKey)
	}
	if requestKey != "" {
		if n := len([]rune(requestKey)); n < 1 || n > 128 {
			return validation("idempotency_key 须为 1..128 字符")
		}
		requestHash = cxSHA256([]byte("convert-topic|" + item.ID.String() + "|" + title))
		var existing uuid.UUID
		var existingHash *string
		err := s.db.QueryRow(ctx, `SELECT id,origin_request_hash FROM topic WHERE account_id=$1 AND origin_request_key=$2 AND deleted_at IS NULL`,
			item.AccountID, requestKey).Scan(&existing, &existingHash)
		if err == nil {
			if existingHash == nil || *existingHash != requestHash {
				return apiErr(409, "idempotency_conflict", "同一幂等键已被不同的转换请求使用")
			}
			t, tErr := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, existing))
			if tErr != nil {
				return tErr
			}
			return ok(w, map[string]any{"topic": t, "reused": true})
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	}
	// 脱敏摘要作为 angle 来源；source=manual（不扩枚举）。
	summary := item.Content
	if runes := []rune(summary); len(runes) > 120 {
		summary = string(runes[:120]) + "…"
	}
	angle := strings.TrimSpace(in.Angle)
	if angle == "" {
		angle = "来自读者评论：" + summary
	}
	var topicID uuid.UUID
	insertArgs := []any{item.AccountID, title, angle, item.ID}
	insertSQL := `INSERT INTO topic (account_id,title,angle,source,source_comment_id`
	if requestKey != "" {
		insertSQL += `,origin_request_key,origin_request_hash`
		insertArgs = append(insertArgs, requestKey, requestHash)
	}
	insertSQL += `) VALUES ($1,$2,$3,'manual',$4`
	if requestKey != "" {
		insertSQL += `,$5,$6`
	}
	insertSQL += `) RETURNING id`
	if err := s.db.QueryRow(ctx, insertSQL, insertArgs...).Scan(&topicID); err != nil {
		return err
	}
	s.audit(ctx, "comment_convert_topic", "comment_inbox", item.ID.String(), "ok", map[string]any{"topic_id": topicID})
	t, err := scanTopic(s.db.QueryRow(ctx, `SELECT `+topicCols+` FROM topic t WHERE t.id=$1`, topicID))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"topic": t, "reused": false})
	return nil
}

type skeletonNoteRef struct {
	ID        string `json:"id"`
	Target    string `json:"target"`
	Title     string `json:"title"`
	HookType  string `json:"hook_type"`
	Roles     []string `json:"roles"`
	Paragraphs int   `json:"paragraphs"`
	AvgChars  int    `json:"avg_chars"`
	UpdatedAt time.Time `json:"updated_at"`
}

// listSkeletonNotes：当前账号可引用的拆解骨架（大纲生成勾选来源）。
func (s *Server) listSkeletonNotes(w http.ResponseWriter, r *http.Request) error {
	account, err := s.accountFromPath(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT bn.id, bt.name, bn.title, bn.structure, bn.updated_at
		FROM benchmark_note bn JOIN benchmark_target bt ON bt.id=bn.target_id
		WHERE bt.account_id=$1 AND bt.workspace_id=$2 AND bn.archived_at IS NULL
		ORDER BY bn.updated_at DESC LIMIT 50`, account.ID, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []skeletonNoteRef{}
	for rows.Next() {
		var id uuid.UUID
		var targetName, title string
		var structure []byte
		var updatedAt time.Time
		if err := rows.Scan(&id, &targetName, &title, &structure, &updatedAt); err != nil {
			return err
		}
		var skel struct {
			HookType string `json:"hook_type"`
			Sections []struct {
				Role string `json:"role"`
			} `json:"sections"`
			Rhythm struct {
				Paragraphs int `json:"paragraphs"`
				AvgChars   int `json:"avg_chars"`
			} `json:"rhythm"`
		}
		if json.Unmarshal(structure, &skel) != nil {
			continue
		}
		roles := []string{}
		for _, section := range skel.Sections {
			roles = append(roles, section.Role)
		}
		items = append(items, skeletonNoteRef{ID: id.String(), Target: targetName,
			Title: title, HookType: skel.HookType, Roles: roles,
			Paragraphs: skel.Rhythm.Paragraphs, AvgChars: skel.Rhythm.AvgChars, UpdatedAt: updatedAt})
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return ok(w, items)
}
