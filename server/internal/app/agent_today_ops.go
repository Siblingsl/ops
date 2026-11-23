package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// FN-11 今日运营：六块只读运营摘要的唯一聚合入口。
// 只读：本文件不包含任何 UPDATE/INSERT/DELETE，也不暴露写入动作。
type agentTodayOpsView struct {
	Account     agentTodayOpsAccount `json:"account"`
	GeneratedAt time.Time            `json:"generated_at"`
	Summary     agentTodayOpsSummary `json:"summary"`
	Blocks      []agentTodayOpsBlock `json:"blocks"`
}

type agentTodayOpsAccount struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	Platform string    `json:"platform"`
}

type agentTodayOpsSummary struct {
	Pending    int `json:"pending"`
	Publishing int `json:"publishing"`
	TodayData  int `json:"today_data"`
	Comments   int `json:"comments"`
	Routines   int `json:"routines"`
	Risks      int `json:"risks"`
}

type agentTodayOpsBlock struct {
	Key        string              `json:"key"`
	Label      string              `json:"label"`
	Count      int                 `json:"count"`
	CountLabel string              `json:"count_label"`
	Items      []agentTodayOpsItem `json:"items"`
	More       *agentTodayOpsMore  `json:"more,omitempty"`
	Error      string              `json:"error,omitempty"`
}

type agentTodayOpsItem struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Meta   string `json:"meta"`
	Tone   string `json:"tone"`
	To     string `json:"to"`
}

type agentTodayOpsMore struct {
	Label string `json:"label"`
	To    string `json:"to"`
}

type agentTodayOpsBlockSpec struct {
	key        string
	label      string
	countLabel string
	load       func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error)
}

func (s *Server) agentTodayOps(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireAgentFeature(r.Context(), "today_ops"); err != nil {
		return err
	}
	actor := ident(r.Context())
	if actor == nil {
		return errUnauthorized
	}
	// 今日运营是操作者的只读驾驶舱；观察者仍可浏览原页面，但不开放此聚合视图。
	if actor.Role == "viewer" {
		return apiErr(http.StatusForbidden, "forbidden", "观察者仅可浏览，今日运营需要编辑权限")
	}
	rawAccount := strings.TrimSpace(r.URL.Query().Get("account_id"))
	if rawAccount == "" {
		return apiErr(http.StatusUnprocessableEntity, "account_required", "请先选择要查看的账号")
	}
	accountID, err := uuid.Parse(rawAccount)
	if err != nil {
		return apiErr(http.StatusUnprocessableEntity, "account_required", "账号标识无效，请重新选择账号")
	}
	if err := s.checkAgentAccount(r.Context(), accountID); err != nil {
		return err
	}
	blockFilter := strings.TrimSpace(r.URL.Query().Get("block"))

	workspaceID := actor.WorkspaceID
	userID := actor.UserID
	now := s.now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	end := start.AddDate(0, 0, 1)

	var account agentTodayOpsAccount
	if err := s.db.QueryRow(r.Context(), `SELECT id,name,platform FROM platform_account WHERE id=$1 AND workspace_id=$2`,
		accountID, workspaceID).Scan(&account.ID, &account.Name, &account.Platform); err != nil {
		return err
	}

	specs := []agentTodayOpsBlockSpec{
		{key: "pending", label: "待处理", countLabel: "项", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsPending(r.Context(), workspaceID, userID, accountID)
		}},
		{key: "publishing", label: "待发布", countLabel: "条", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsPublishing(r.Context(), workspaceID, accountID)
		}},
		{key: "today", label: "今日数据", countLabel: "篇", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsTodayData(r.Context(), workspaceID, accountID, start, end)
		}},
		{key: "comments", label: "评论", countLabel: "条", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsComments(r.Context(), workspaceID, accountID)
		}},
		{key: "routines", label: "例行", countLabel: "项", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsRoutines(r.Context(), workspaceID, userID, accountID, now, end)
		}},
		{key: "risks", label: "风险", countLabel: "项", load: func() (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
			return s.todayOpsRisks(r.Context(), workspaceID, accountID)
		}},
	}

	blocks := make([]agentTodayOpsBlock, 0, len(specs))
	filtered := specs
	if blockFilter != "" {
		found := false
		for _, spec := range specs {
			if spec.key == blockFilter {
				filtered = []agentTodayOpsBlockSpec{spec}
				found = true
				break
			}
		}
		if !found {
			return apiErr(http.StatusUnprocessableEntity, "block_invalid", "未知的今日运营区块")
		}
	}
	summary := agentTodayOpsSummary{}
	failed := 0
	for _, spec := range filtered {
		count, items, more, err := spec.load()
		block := agentTodayOpsBlock{Key: spec.key, Label: spec.label, CountLabel: spec.countLabel, Items: []agentTodayOpsItem{}, More: more}
		if err != nil {
			failed++
			slog.Error("今日运营区块读取失败", "block", spec.key, "account_id", accountID, "err", err)
			block.Error = "该区块暂时不可用，其他区块仍可查看"
		} else {
			if items == nil {
				items = []agentTodayOpsItem{}
			}
			block.Count = count
			block.Items = items
		}
		blocks = append(blocks, block)
		switch spec.key {
		case "pending":
			summary.Pending = count
		case "publishing":
			summary.Publishing = count
		case "today":
			summary.TodayData = count
		case "comments":
			summary.Comments = count
		case "routines":
			summary.Routines = count
		case "risks":
			summary.Risks = count
		}
	}
	if blockFilter == "" && failed == len(blocks) {
		return apiErr(http.StatusInternalServerError, "today_ops_unavailable", "今日运营暂时不可用，请稍后重试")
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, agentTodayOpsView{
		Account: account, GeneratedAt: now, Summary: summary, Blocks: blocks,
	})
}

func todayOpsClip(value string, limit int) string {
	value = strings.TrimSpace(strings.Join(strings.Fields(value), " "))
	if limit <= 0 || utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit])) + "…"
}

func todayOpsMeta(parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			out = append(out, value)
		}
	}
	return strings.Join(out, " · ")
}

func (s *Server) todayOpsPending(ctx context.Context, workspaceID, userID, accountID uuid.UUID) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	var count int
	if err := s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM agent_action a
			 JOIN agent_conversation c ON c.id=a.conversation_id
			 WHERE a.workspace_id=$1 AND a.user_id=$2 AND c.workspace_id=$1 AND c.user_id=$2
			   AND c.account_id=$3 AND c.archived_at IS NULL
			   AND a.status IN ('pending','needs_input') AND a.expires_at>now())
			+
			(SELECT count(*) FROM agent_question q
			 JOIN agent_conversation c ON c.id=q.conversation_id
			 WHERE c.workspace_id=$1 AND c.user_id=$2 AND c.account_id=$3 AND c.archived_at IS NULL
			   AND q.status='pending' AND q.expires_at>now())`,
		workspaceID, userID, accountID).Scan(&count); err != nil {
		return 0, nil, nil, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT id,kind,conversation_id,conversation_title,meta,created_at FROM (
			SELECT a.id::text AS id,'action'::text AS kind,c.id::text AS conversation_id,c.title AS conversation_title,a.created_at,
			       CASE a.status WHEN 'needs_input' THEN '需要补充信息' ELSE '等待逐张确认' END AS meta
			FROM agent_action a JOIN agent_conversation c ON c.id=a.conversation_id
			WHERE a.workspace_id=$1 AND a.user_id=$2 AND c.workspace_id=$1 AND c.user_id=$2
			  AND c.account_id=$3 AND c.archived_at IS NULL
			  AND a.status IN ('pending','needs_input') AND a.expires_at>now()
			UNION ALL
			SELECT q.id::text,'question',c.id::text,c.title,q.created_at,'等待你的回答'
			FROM agent_question q JOIN agent_conversation c ON c.id=q.conversation_id
			WHERE c.workspace_id=$1 AND c.user_id=$2 AND c.account_id=$3 AND c.archived_at IS NULL
			  AND q.status='pending' AND q.expires_at>now()
		) pending ORDER BY created_at DESC,id LIMIT 3`, workspaceID, userID, accountID)
	if err != nil {
		return 0, nil, nil, err
	}
	defer rows.Close()
	items := []agentTodayOpsItem{}
	for rows.Next() {
		var id, kind, conversationID, title, meta string
		var createdAt time.Time
		if err := rows.Scan(&id, &kind, &conversationID, &title, &meta, &createdAt); err != nil {
			return 0, nil, nil, err
		}
		itemTitle := "待确认操作"
		if kind == "question" {
			itemTitle = "待回答问题"
		}
		items = append(items, agentTodayOpsItem{
			ID: "pending:" + id, Kind: kind, Title: itemTitle,
			Detail: todayOpsClip(title, 64), Meta: todayOpsMeta(meta, todayOpsWhen(createdAt)),
			Tone: "attention", To: "/agent/c/" + conversationID,
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开 AI 对话", To: "/agent"}, rows.Err()
}

func todayOpsWhen(at time.Time) string {
	now := time.Now()
	sameDay := func(a, b time.Time) bool {
		ay, am, ad := a.Date()
		by, bm, bd := b.Date()
		return ay == by && am == bm && ad == bd
	}
	if sameDay(at, now) {
		return at.Format("15:04")
	}
	return at.Format("01-02 15:04")
}

func (s *Server) todayOpsPublishing(ctx context.Context, workspaceID, accountID uuid.UUID) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	const activeStates = `('ready','queued','filling','filled','awaiting_user','submitted','scheduled')`
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.workspace_id=$1 AND t.account_id=$2 AND a.workspace_id=$1
		  AND w.account_id=$2 AND w.deleted_at IS NULL AND t.state IN `+activeStates,
		workspaceID, accountID).Scan(&count); err != nil {
		return 0, nil, nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT t.id,t.work_id,w.title,t.platform,t.state,t.updated_at
		FROM publish_task t JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.workspace_id=$1 AND t.account_id=$2 AND a.workspace_id=$1
		  AND w.account_id=$2 AND w.deleted_at IS NULL AND t.state IN `+activeStates+`
		ORDER BY t.updated_at DESC,t.id LIMIT 3`, workspaceID, accountID)
	if err != nil {
		return 0, nil, nil, err
	}
	defer rows.Close()
	items := []agentTodayOpsItem{}
	for rows.Next() {
		var id, workID uuid.UUID
		var title, platform, state string
		var updatedAt time.Time
		if err := rows.Scan(&id, &workID, &title, &platform, &state, &updatedAt); err != nil {
			return 0, nil, nil, err
		}
		items = append(items, agentTodayOpsItem{
			ID: "publishing:" + id.String(), Kind: "publish", Title: todayOpsClip(title, 64),
			Detail: todayOpsMeta(todayOpsPlatform(platform), todayOpsPublishState(state)),
			Meta:   todayOpsWhen(updatedAt), Tone: todayOpsPublishTone(state), To: "/works/" + workID.String(),
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开发布看板", To: "/a/" + accountID.String() + "/ops"}, rows.Err()
}

func (s *Server) todayOpsTodayData(ctx context.Context, workspaceID, accountID uuid.UUID, start, end time.Time) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	count, rows, err := s.metricTodayWorkRows(ctx, workspaceID, accountID, start, end)
	if err != nil {
		return 0, nil, nil, err
	}
	items := []agentTodayOpsItem{}
	for _, row := range rows {
		metrics := make([]string, 0, 4)
		if row.Reads != nil {
			metrics = append(metrics, fmt.Sprintf("阅读 %d", *row.Reads))
		}
		if row.Likes != nil {
			metrics = append(metrics, fmt.Sprintf("赞 %d", *row.Likes))
		}
		if row.Comments != nil {
			metrics = append(metrics, fmt.Sprintf("评 %d", *row.Comments))
		}
		if row.Favorites != nil {
			metrics = append(metrics, fmt.Sprintf("藏 %d", *row.Favorites))
		}
		detail := "今日已采数"
		if len(metrics) > 0 {
			detail = strings.Join(metrics, " · ")
		}
		items = append(items, agentTodayOpsItem{
			ID: "metric:" + row.WorkID.String(), Kind: "metric", Title: todayOpsClip(row.Title, 64),
			Detail: detail, Meta: row.CapturedAt.Format("15:04") + " 更新", Tone: "success",
			To: "/a/" + accountID.String() + "/review?work=" + row.WorkID.String(),
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开数据复盘", To: "/a/" + accountID.String() + "/review"}, nil
}

func (s *Server) todayOpsComments(ctx context.Context, workspaceID, accountID uuid.UUID) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM comment_inbox
		WHERE workspace_id=$1 AND account_id=$2 AND deleted_at IS NULL AND reply_status IN ('none','drafted')`,
		workspaceID, accountID).Scan(&count); err != nil {
		return 0, nil, nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT id,author_alias,content,category,captured_at
		FROM comment_inbox
		WHERE workspace_id=$1 AND account_id=$2 AND deleted_at IS NULL AND reply_status IN ('none','drafted')
		ORDER BY captured_at DESC,id DESC LIMIT 3`, workspaceID, accountID)
	if err != nil {
		return 0, nil, nil, err
	}
	defer rows.Close()
	items := []agentTodayOpsItem{}
	for rows.Next() {
		var id uuid.UUID
		var alias, content string
		var category *string
		var capturedAt time.Time
		if err := rows.Scan(&id, &alias, &content, &category, &capturedAt); err != nil {
			return 0, nil, nil, err
		}
		if strings.TrimSpace(alias) == "" {
			alias = "未具名读者"
		}
		items = append(items, agentTodayOpsItem{
			ID: "comment:" + id.String(), Kind: "comment", Title: todayOpsClip(alias, 34),
			Detail: todayOpsClip(content, 72), Meta: todayOpsMeta(todayOpsCommentCategory(category), todayOpsWhen(capturedAt)),
			Tone: todayOpsCommentTone(category), To: "/a/" + accountID.String() + "/profile?tab=comments",
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开评论台账", To: "/a/" + accountID.String() + "/profile?tab=comments"}, rows.Err()
}

func (s *Server) todayOpsRoutines(ctx context.Context, workspaceID, userID, accountID uuid.UUID, now, end time.Time) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM agent_routine
		WHERE workspace_id=$1 AND user_id=$2 AND account_id=$3 AND status='enabled'
		  AND next_due_at IS NOT NULL AND next_due_at<$4`, workspaceID, userID, accountID, end).Scan(&count); err != nil {
		return 0, nil, nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT id,name,cadence,next_due_at,failure_count,error_code,conversation_id
		FROM agent_routine
		WHERE workspace_id=$1 AND user_id=$2 AND account_id=$3 AND status='enabled'
		  AND next_due_at IS NOT NULL AND next_due_at<$4
		ORDER BY next_due_at,id LIMIT 3`, workspaceID, userID, accountID, end)
	if err != nil {
		return 0, nil, nil, err
	}
	defer rows.Close()
	items := []agentTodayOpsItem{}
	for rows.Next() {
		var id uuid.UUID
		var name, cadence, errorCode string
		var nextDue time.Time
		var failureCount int
		var conversationID *uuid.UUID
		if err := rows.Scan(&id, &name, &cadence, &nextDue, &failureCount, &errorCode, &conversationID); err != nil {
			return 0, nil, nil, err
		}
		detail := todayOpsCadence(cadence)
		if nextDue.Before(now) {
			detail += " · 已到点"
		} else {
			detail += " · " + nextDue.Format("15:04")
		}
		tone := "neutral"
		meta := "等待执行"
		if failureCount > 0 || strings.TrimSpace(errorCode) != "" {
			tone = "danger"
			meta = "上次执行失败"
		}
		to := "/agent?panel=routine"
		if conversationID != nil {
			to = "/agent/c/" + conversationID.String()
		}
		items = append(items, agentTodayOpsItem{
			ID: "routine:" + id.String(), Kind: "routine", Title: todayOpsClip(name, 64),
			Detail: detail, Meta: meta, Tone: tone, To: to,
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开例行任务", To: "/agent?panel=routine"}, rows.Err()
}

func (s *Server) todayOpsRisks(ctx context.Context, workspaceID, accountID uuid.UUID) (int, []agentTodayOpsItem, *agentTodayOpsMore, error) {
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.workspace_id=$1 AND t.account_id=$2 AND a.workspace_id=$1
		  AND w.account_id=$2 AND w.deleted_at IS NULL AND t.state IN ('failed','not_logged_in')`,
		workspaceID, accountID).Scan(&count); err != nil {
		return 0, nil, nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT t.id,t.work_id,w.title,t.platform,t.state,t.last_error_code,t.last_error_message,t.updated_at
		FROM publish_task t JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.workspace_id=$1 AND t.account_id=$2 AND a.workspace_id=$1
		  AND w.account_id=$2 AND w.deleted_at IS NULL AND t.state IN ('failed','not_logged_in')
		ORDER BY t.updated_at DESC,t.id LIMIT 3`, workspaceID, accountID)
	if err != nil {
		return 0, nil, nil, err
	}
	defer rows.Close()
	items := []agentTodayOpsItem{}
	for rows.Next() {
		var id, workID uuid.UUID
		var title, platform, state, code, message string
		var updatedAt time.Time
		if err := rows.Scan(&id, &workID, &title, &platform, &state, &code, &message, &updatedAt); err != nil {
			return 0, nil, nil, err
		}
		detail := todayOpsClip(message, 70)
		if detail == "" {
			detail = "该平台任务未完成，请查看发布详情"
		}
		items = append(items, agentTodayOpsItem{
			ID: "risk:" + id.String(), Kind: "risk", Title: todayOpsClip(title, 64),
			Detail: detail, Meta: todayOpsMeta(todayOpsPlatform(platform), todayOpsPublishState(state), todayOpsWhen(updatedAt)),
			Tone: "danger", To: "/works/" + workID.String(),
		})
	}
	return count, items, &agentTodayOpsMore{Label: "打开发布看板", To: "/a/" + accountID.String() + "/ops"}, rows.Err()
}

func todayOpsPlatform(platform string) string {
	switch platform {
	case "wechat_mp":
		return "公众号"
	case "xhs":
		return "小红书"
	case "toutiao":
		return "今日头条"
	default:
		return platform
	}
}

func todayOpsPublishState(state string) string {
	switch state {
	case "ready":
		return "待处理"
	case "queued":
		return "已排队"
	case "filling":
		return "填写中"
	case "filled":
		return "已填入"
	case "awaiting_user":
		return "待人工确认"
	case "submitted":
		return "已提交"
	case "scheduled":
		return "已预约"
	case "failed":
		return "失败"
	case "not_logged_in":
		return "平台未登录"
	default:
		return state
	}
}

func todayOpsPublishTone(state string) string {
	switch state {
	case "failed", "not_logged_in":
		return "danger"
	case "awaiting_user", "ready":
		return "attention"
	case "submitted", "scheduled":
		return "success"
	default:
		return "neutral"
	}
}

func todayOpsCommentCategory(category *string) string {
	if category == nil {
		return "未分类"
	}
	switch *category {
	case "question":
		return "提问"
	case "objection":
		return "异议"
	case "praise":
		return "好评"
	case "negative":
		return "负评"
	case "spam":
		return "垃圾"
	default:
		return *category
	}
}

func todayOpsCommentTone(category *string) string {
	if category != nil && *category == "negative" {
		return "danger"
	}
	return "attention"
}

func todayOpsCadence(cadence string) string {
	switch cadence {
	case "once":
		return "单次"
	case "daily":
		return "每日"
	case "weekly":
		return "每周"
	default:
		return cadence
	}
}
