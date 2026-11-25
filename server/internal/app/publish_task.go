package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/cxcanonicaljson"
)

const publishTaskLease = 60 * time.Second

type PublishTask struct {
	ID                 uuid.UUID      `json:"id"`
	WorkspaceID        uuid.UUID      `json:"workspace_id"`
	AccountID          uuid.UUID      `json:"account_id"`
	WorkID             uuid.UUID      `json:"work_id"`
	Platform           string         `json:"platform"`
	State              string         `json:"state"`
	StateVersion       int            `json:"state_version"`
	Mode               string         `json:"mode"`
	BatchID            *uuid.UUID     `json:"batch_id,omitempty"`
	Attempt            int            `json:"attempt"`
	MaxAttempts        int            `json:"max_attempts"`
	NextRetryAt        *time.Time     `json:"next_retry_at,omitempty"`
	PlanAt             *time.Time     `json:"plan_at,omitempty"`
	PlatformScheduleAt *time.Time     `json:"platform_schedule_at,omitempty"`
	FilledAt           *time.Time     `json:"filled_at,omitempty"`
	SubmittedAt        *time.Time     `json:"submitted_at,omitempty"`
	PublishedAt        *time.Time     `json:"published_at,omitempty"`
	LastErrorCode      string         `json:"last_error_code"`
	LastErrorMessage   string         `json:"last_error_message"`
	Evidence           map[string]any `json:"evidence"`
	IdempotencyKey     string         `json:"idempotency_key"`
	CreatedBy          *uuid.UUID     `json:"created_by,omitempty"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
	LastEventKind      string         `json:"last_event_kind,omitempty"`
	LastEventAt        *time.Time     `json:"last_event_at,omitempty"`
}

type PublishTaskEvent struct {
	ID             uuid.UUID       `json:"id"`
	TaskID         uuid.UUID       `json:"task_id"`
	FromState      *string         `json:"from_state"`
	ToState        string          `json:"to_state"`
	StateVersion   int             `json:"state_version"`
	EventKind      string          `json:"event_kind"`
	Evidence       json.RawMessage `json:"evidence"`
	Note           string          `json:"note"`
	IdempotencyKey string          `json:"idempotency_key"`
	RequestHash    string          `json:"request_hash"`
	Actor          *uuid.UUID      `json:"actor,omitempty"`
	At             time.Time       `json:"at"`
}

type PublishBatch struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	AccountID   uuid.UUID  `json:"account_id"`
	Label       string     `json:"label"`
	State       string     `json:"state"`
	Total       int        `json:"total"`
	Done        int        `json:"done"`
	CreatedBy   *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

const publishTaskCols = `t.id, t.workspace_id, t.account_id, t.work_id, t.platform, t.state,
	t.state_version, t.mode, t.batch_id, t.attempt, t.max_attempts, t.next_retry_at,
	t.plan_at, t.platform_schedule_at, t.filled_at, t.submitted_at, t.published_at,
	t.last_error_code, t.last_error_message, t.evidence, t.idempotency_key,
	t.created_by, t.created_at, t.updated_at`

const publishBatchCols = `b.id, b.workspace_id, b.account_id, b.label, b.state, b.total, b.done,
	b.created_by, b.created_at, b.updated_at`

func scanPublishTask(row pgx.Row) (*PublishTask, error) {
	var t PublishTask
	var evidence []byte
	if err := row.Scan(&t.ID, &t.WorkspaceID, &t.AccountID, &t.WorkID, &t.Platform, &t.State,
		&t.StateVersion, &t.Mode, &t.BatchID, &t.Attempt, &t.MaxAttempts, &t.NextRetryAt,
		&t.PlanAt, &t.PlatformScheduleAt, &t.FilledAt, &t.SubmittedAt, &t.PublishedAt,
		&t.LastErrorCode, &t.LastErrorMessage, &evidence, &t.IdempotencyKey,
		&t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	t.Evidence = map[string]any{}
	if len(evidence) > 0 {
		_ = json.Unmarshal(evidence, &t.Evidence)
	}
	return &t, nil
}

func scanPublishTaskRows(rows pgx.Rows) ([]PublishTask, error) {
	defer rows.Close()
	out := make([]PublishTask, 0)
	for rows.Next() {
		var t PublishTask
		var evidence []byte
		if err := rows.Scan(&t.ID, &t.WorkspaceID, &t.AccountID, &t.WorkID, &t.Platform, &t.State,
			&t.StateVersion, &t.Mode, &t.BatchID, &t.Attempt, &t.MaxAttempts, &t.NextRetryAt,
			&t.PlanAt, &t.PlatformScheduleAt, &t.FilledAt, &t.SubmittedAt, &t.PublishedAt,
			&t.LastErrorCode, &t.LastErrorMessage, &evidence, &t.IdempotencyKey,
			&t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		t.Evidence = map[string]any{}
		if len(evidence) > 0 {
			_ = json.Unmarshal(evidence, &t.Evidence)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Server) loadPublishTask(ctx context.Context, workID uuid.UUID, platform string) (*PublishTask, error) {
	row := s.db.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.work_id=$1 AND t.platform=$2 AND t.workspace_id=$3
		  AND a.workspace_id=$3 AND w.account_id=t.account_id AND w.deleted_at IS NULL`,
		workID, platform, ident(ctx).WorkspaceID)
	return scanPublishTask(row)
}

func (s *Server) loadPublishTaskByID(ctx context.Context, id uuid.UUID) (*PublishTask, error) {
	row := s.db.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.id=$1 AND t.workspace_id=$2 AND a.workspace_id=$2
		  AND w.account_id=t.account_id AND w.deleted_at IS NULL`, id, ident(ctx).WorkspaceID)
	return scanPublishTask(row)
}

func (s *Server) listPublishTasks(ctx context.Context, workID uuid.UUID) ([]PublishTask, error) {
	rows, err := s.db.Query(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.work_id=$1 AND t.workspace_id=$2
		  AND a.workspace_id=$2 AND w.account_id=t.account_id AND w.deleted_at IS NULL
		ORDER BY t.platform`, workID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	items, err := scanPublishTaskRows(rows)
	if err != nil {
		return nil, err
	}
	return items, s.attachPublishTaskLastEvents(ctx, items)
}

func (s *Server) attachPublishTaskLastEvents(ctx context.Context, items []PublishTask) error {
	for i := range items {
		var kind string
		var at time.Time
		err := s.db.QueryRow(ctx, `SELECT event_kind,at FROM publish_task_event
			WHERE task_id=$1 ORDER BY at DESC,id DESC LIMIT 1`, items[i].ID).Scan(&kind, &at)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		items[i].LastEventKind = kind
		items[i].LastEventAt = &at
	}
	return nil
}

func (s *Server) listPublishTaskEvents(ctx context.Context, taskID uuid.UUID) ([]PublishTaskEvent, error) {
	rows, err := s.db.Query(ctx, `SELECT e.id,e.task_id,e.from_state,e.to_state,e.state_version,e.event_kind,
		e.evidence,e.note,e.idempotency_key,e.request_hash,e.actor,e.at
		FROM publish_task_event e JOIN publish_task t ON t.id=e.task_id
		WHERE e.task_id=$1 AND t.workspace_id=$2 ORDER BY e.at,e.id`, taskID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PublishTaskEvent, 0)
	for rows.Next() {
		var e PublishTaskEvent
		var evidence []byte
		if err := rows.Scan(&e.ID, &e.TaskID, &e.FromState, &e.ToState, &e.StateVersion, &e.EventKind,
			&evidence, &e.Note, &e.IdempotencyKey, &e.RequestHash, &e.Actor, &e.At); err != nil {
			return nil, err
		}
		e.Evidence = evidence
		items = append(items, e)
	}
	return items, rows.Err()
}

type createPublishTasksInput struct {
	Platforms []string   `json:"platforms"`
	Mode      string     `json:"mode"`
	PlanAt    *time.Time `json:"plan_at"`
	BatchID   *uuid.UUID `json:"batch_id"`
}

type createPublishTasksResult struct {
	Tasks   []PublishTask `json:"tasks"`
	Created []uuid.UUID   `json:"created"`
	Skipped []uuid.UUID   `json:"skipped"`
}

func (s *Server) createPublishTasks(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	wk, err := s.loadWork(r.Context(), workID)
	if err != nil {
		return err
	}
	// 示例账号不能创建发布任务（服务端硬闸门，不能只靠前端隐藏入口）。
	if demo, err := s.accountIsDemo(r.Context(), wk.AccountID); err != nil {
		return err
	} else if demo {
		return demoAccountWriteError()
	}
	var in createPublishTasksInput
	if err := decode(r, &in); err != nil {
		return err
	}
	mode := strings.TrimSpace(in.Mode)
	if mode == "" {
		mode = "desktop"
	}
	switch mode {
	case "api", "desktop", "manual":
	default:
		return validation("mode 必须是 api/desktop/manual")
	}
	if in.PlanAt != nil && in.PlanAt.Before(s.now()) {
		return validation("plan_at 不能早于当前时间")
	}
	platforms, err := normalizePublishPlatforms(in.Platforms)
	if err != nil {
		return err
	}
	if in.BatchID != nil {
		var batchAccount uuid.UUID
		var batchState string
		err := s.db.QueryRow(r.Context(), `SELECT account_id,state FROM publish_batch WHERE id=$1 AND workspace_id=$2`,
			*in.BatchID, ident(r.Context()).WorkspaceID).Scan(&batchAccount, &batchState)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusNotFound, "not_found", "发布批次不存在")
		}
		if err != nil {
			return err
		}
		if batchAccount != wk.AccountID {
			return apiErr(http.StatusUnprocessableEntity, "publish_batch_limit", "批次与作品不属于同一账号")
		}
		if batchState == "stopped" || batchState == "failed" || batchState == "completed" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "该批次已结束，不能继续创建任务")
		}
	}

	// 先校验全部 manifest，再在同一事务里创建任务；任一平台不通过则不落任何任务。
	manifests := make(map[string]*PublishManifest, len(platforms))
	for _, platform := range platforms {
		m, err := s.loadPublishManifest(r.Context(), wk.ID, platform)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusUnprocessableEntity, "publish_validation_failed", "发布 manifest 不存在，请先生成并校验").With(map[string]any{
				"platform": platform, "reason": "missing",
			})
		}
		if err != nil {
			return err
		}
		state, err := s.effectivePublishManifestState(r.Context(), m)
		if err != nil {
			return err
		}
		if state == "stale" {
			return apiErr(http.StatusConflict, "publish_manifest_stale", "作品已改稿或发布版本已变化，请先重新生成 manifest").With(map[string]any{
				"platform": platform,
			})
		}
		if state != "valid" {
			return apiErr(http.StatusUnprocessableEntity, "publish_validation_failed", "发布 manifest 校验未通过").With(map[string]any{
				"platform": platform, "validation_state": state, "checks": m.Validation.Checks,
			})
		}
		manifests[platform] = m
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	result := createPublishTasksResult{Tasks: []PublishTask{}, Created: []uuid.UUID{}, Skipped: []uuid.UUID{}}
	for _, platform := range platforms {
		m := manifests[platform]
		var taskID uuid.UUID
		err = tx.QueryRow(ctx, `INSERT INTO publish_task
			(workspace_id, account_id, work_id, platform, state, state_version, mode, batch_id,
			 plan_at, idempotency_key, created_by)
			VALUES ($1,$2,$3,$4,'ready',1,$5,$6,$7,$8,$9)
			ON CONFLICT (work_id, platform) DO NOTHING RETURNING id`,
			ident(ctx).WorkspaceID, wk.AccountID, wk.ID, platform, mode, in.BatchID,
			in.PlanAt, uuid.NewString(), ident(ctx).UserID).Scan(&taskID)
		if errors.Is(err, pgx.ErrNoRows) {
			existing, err := scanPublishTask(tx.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
				WHERE t.work_id=$1 AND t.platform=$2 AND t.workspace_id=$3`, wk.ID, platform, ident(ctx).WorkspaceID))
			if err != nil {
				return err
			}
			result.Skipped = append(result.Skipped, existing.ID)
			continue
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO publish_task_event
			(task_id, from_state, to_state, state_version, event_kind, evidence, idempotency_key, request_hash, actor)
			VALUES ($1,NULL,'ready',1,'transition','{}'::jsonb,$2,$3,$4)`,
			taskID, uuid.NewString(), m.ContentHash, ident(ctx).UserID)
		if err != nil {
			return err
		}
		result.Created = append(result.Created, taskID)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, platform := range platforms {
		task, err := s.loadPublishTask(ctx, wk.ID, platform)
		if err != nil {
			return err
		}
		result.Tasks = append(result.Tasks, *task)
	}
	return ok(w, result)
}

func normalizePublishPlatforms(raw []string) ([]string, error) {
	platforms := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, platform := range raw {
		platform = strings.TrimSpace(platform)
		if platform == "" {
			continue
		}
		if seen[platform] {
			continue
		}
		if !publishPlatformSupported(platform) {
			return nil, apiErr(http.StatusUnprocessableEntity, "publish_platform_invalid", "暂不支持该发布平台")
		}
		seen[platform] = true
		platforms = append(platforms, platform)
	}
	if len(platforms) == 0 {
		return nil, validation("platforms 不能为空")
	}
	if len(platforms) > 3 {
		return nil, apiErr(http.StatusUnprocessableEntity, "publish_batch_limit", "一条作品最多选择 3 个平台")
	}
	return platforms, nil
}

func (s *Server) listPublishTasksHandler(w http.ResponseWriter, r *http.Request) error {
	workID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.loadWork(r.Context(), workID); err != nil {
		return err
	}
	items, err := s.listPublishTasks(r.Context(), workID)
	if err != nil {
		return err
	}
	return ok(w, items)
}

func (s *Server) listPublishTaskBoard(w http.ResponseWriter, r *http.Request) error {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state != "" && !publishTaskStateKnown(state) {
		return validation("state 不是有效的发布任务状态")
	}
	query := `SELECT ` + publishTaskCols + ` FROM publish_task t
		JOIN work w ON w.id=t.work_id JOIN platform_account a ON a.id=t.account_id
		WHERE t.workspace_id=$1 AND a.workspace_id=$1 AND w.account_id=t.account_id AND w.deleted_at IS NULL`
	args := []any{ident(r.Context()).WorkspaceID}
	if state != "" {
		query += ` AND t.state=$2`
		args = append(args, state)
	}
	query += ` ORDER BY t.updated_at DESC,t.id LIMIT 200`
	rows, err := s.db.Query(r.Context(), query, args...)
	if err != nil {
		return err
	}
	items, err := scanPublishTaskRows(rows)
	if err != nil {
		return err
	}
	if err := s.attachPublishTaskLastEvents(r.Context(), items); err != nil {
		return err
	}
	return ok(w, items)
}

func (s *Server) getPublishTaskEventsHandler(w http.ResponseWriter, r *http.Request) error {
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	if _, err := s.loadPublishTaskByID(r.Context(), taskID); err != nil {
		return err
	}
	items, err := s.listPublishTaskEvents(r.Context(), taskID)
	if err != nil {
		return err
	}
	return ok(w, items)
}

type publishTaskTransitionInput struct {
	To                 string         `json:"to"`
	ExpectedVersion    int            `json:"expected_version"`
	IdempotencyKey     string         `json:"idempotency_key"`
	Evidence           map[string]any `json:"evidence"`
	Note               string         `json:"note"`
	Reason             string         `json:"reason"`
	Confirm            bool           `json:"confirm"`
	PlatformScheduleAt *time.Time     `json:"platform_schedule_at"`
	ErrorCode          string         `json:"error_code"`
	ErrorMessage       string         `json:"error_message"`
}

type publishTaskHashPayload struct {
	To                 string         `json:"to"`
	ExpectedVersion    int            `json:"expected_version"`
	Evidence           map[string]any `json:"evidence"`
	Note               string         `json:"note"`
	Reason             string         `json:"reason"`
	Confirm            bool           `json:"confirm"`
	PlatformScheduleAt *time.Time     `json:"platform_schedule_at"`
	ErrorCode          string         `json:"error_code"`
	ErrorMessage       string         `json:"error_message"`
}

func (s *Server) publishTaskTransitionHandler(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	var in publishTaskTransitionInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if key := strings.TrimSpace(r.Header.Get("Idempotency-Key")); key != "" && strings.TrimSpace(in.IdempotencyKey) == "" {
		in.IdempotencyKey = key
	}
	out, err := s.transitionPublishTask(r.Context(), task, in, false)
	if err != nil {
		return err
	}
	return ok(w, out)
}

func (s *Server) publishTaskSetManual(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	if publishTaskTerminal(task.State) {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "终态任务不能改为手动")
	}
	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	newVersion := task.StateVersion + 1
	if _, err := tx.Exec(ctx, `UPDATE publish_task SET mode='manual',state_version=$2,updated_at=now()
		WHERE id=$1 AND workspace_id=$3 AND state_version=$4`, task.ID, newVersion, task.WorkspaceID, task.StateVersion); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO publish_task_event
		(task_id,from_state,to_state,state_version,event_kind,evidence,note,idempotency_key,request_hash,actor)
		VALUES($1,$2,$2,$3,'correction','{}'::jsonb,'改为手动',$4,$5,$6)`,
		task.ID, task.State, newVersion, uuid.NewString(), sha256Hex([]byte("manual:"+task.ID.String()+":"+strconv.Itoa(newVersion))), ident(ctx).UserID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	updated, err := s.loadPublishTaskByID(ctx, task.ID)
	if err != nil {
		return err
	}
	return ok(w, updated)
}

func (s *Server) publishTaskActionHandler(w http.ResponseWriter, r *http.Request, to string) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	// queue / retry（同为 queued）不得为示例账号任务排队；其余状态（stop/skip/manual）保持可用。
	if to == "queued" {
		if demo, err := s.accountIsDemo(r.Context(), task.AccountID); err != nil {
			return err
		} else if demo {
			return demoAccountWriteError()
		}
	}
	var in struct {
		ExpectedVersion int            `json:"expected_version"`
		IdempotencyKey  string         `json:"idempotency_key"`
		Evidence        map[string]any `json:"evidence"`
		Note            string         `json:"note"`
		Reason          string         `json:"reason"`
		Confirm         bool           `json:"confirm"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if key := strings.TrimSpace(r.Header.Get("Idempotency-Key")); key != "" && strings.TrimSpace(in.IdempotencyKey) == "" {
		in.IdempotencyKey = key
	}
	out, err := s.transitionPublishTask(r.Context(), task, publishTaskTransitionInput{
		To: to, ExpectedVersion: in.ExpectedVersion, IdempotencyKey: in.IdempotencyKey,
		Evidence: in.Evidence, Note: in.Note, Reason: in.Reason, Confirm: in.Confirm,
	}, false)
	if err != nil {
		return err
	}
	return ok(w, out)
}

func (s *Server) transitionPublishTask(ctx context.Context, task *PublishTask, in publishTaskTransitionInput, claiming bool) (*PublishTask, error) {
	if task == nil {
		return nil, apiErr(http.StatusNotFound, "not_found", "发布任务不存在")
	}
	in.To = strings.TrimSpace(in.To)
	in.IdempotencyKey = strings.TrimSpace(in.IdempotencyKey)
	in.Note = strings.TrimSpace(in.Note)
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Evidence == nil {
		in.Evidence = map[string]any{}
	}
	if !publishTaskStateKnown(in.To) || in.To == "ready" || in.To == "published" {
		if in.To == "published" {
			return nil, apiErr(http.StatusConflict, "publish_task_state_invalid", "published 只能由既有发布回填入口同步，不能由任务转换直接写入")
		}
		return nil, apiErr(http.StatusConflict, "publish_task_state_invalid", "发布任务目标状态不合法")
	}
	if in.IdempotencyKey == "" || len([]rune(in.IdempotencyKey)) > 128 {
		return nil, validation("需要 1 到 128 字的 idempotency_key")
	}
	if runeLen(in.Note) > 500 || runeLen(in.Reason) > 500 {
		return nil, validation("note/reason 不能超过 500 字")
	}
	if in.ExpectedVersion < 0 {
		return nil, validation("expected_version 不能为负数")
	}
	hash, err := cxcanonicaljson.Hash(publishTaskHashPayload{
		To: in.To, ExpectedVersion: in.ExpectedVersion, Evidence: in.Evidence,
		Note: in.Note, Reason: in.Reason, Confirm: in.Confirm,
		PlatformScheduleAt: in.PlatformScheduleAt, ErrorCode: in.ErrorCode, ErrorMessage: in.ErrorMessage,
	})
	if err != nil {
		return nil, err
	}
	actor := ident(ctx)
	if actor == nil {
		return nil, errUnauthorized
	}

	var out *PublishTask
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var current PublishTask
		var evidence []byte
		err := tx.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
			WHERE t.id=$1 AND t.workspace_id=$2 FOR UPDATE`, task.ID, actor.WorkspaceID).Scan(
			&current.ID, &current.WorkspaceID, &current.AccountID, &current.WorkID, &current.Platform, &current.State,
			&current.StateVersion, &current.Mode, &current.BatchID, &current.Attempt, &current.MaxAttempts, &current.NextRetryAt,
			&current.PlanAt, &current.PlatformScheduleAt, &current.FilledAt, &current.SubmittedAt, &current.PublishedAt,
			&current.LastErrorCode, &current.LastErrorMessage, &evidence, &current.IdempotencyKey,
			&current.CreatedBy, &current.CreatedAt, &current.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return apiErr(http.StatusNotFound, "not_found", "发布任务不存在")
		}
		if err != nil {
			return err
		}
		current.Evidence = map[string]any{}
		if len(evidence) > 0 {
			_ = json.Unmarshal(evidence, &current.Evidence)
		}

		// 幂等键先于版本检查：重复请求必须返回原结果，不能因为状态已推进而报冲突。
		var oldHash string
		err = tx.QueryRow(ctx, `SELECT request_hash FROM publish_task_event
			WHERE task_id=$1 AND idempotency_key=$2`, task.ID, in.IdempotencyKey).Scan(&oldHash)
		if err == nil {
			if oldHash != hash {
				return apiErr(http.StatusConflict, "idempotency_conflict", "该幂等键已用于不同的发布任务请求")
			}
			loaded, err := scanPublishTask(tx.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, task.ID))
			if err != nil {
				return err
			}
			out = loaded
			return nil
		}
		if err != pgx.ErrNoRows {
			return err
		}

		if in.ExpectedVersion > 0 && current.StateVersion != in.ExpectedVersion {
			return apiErr(http.StatusConflict, "publish_task_version_conflict", "发布任务已变化，请重新读取后重试").With(map[string]any{
				"server_version": current.StateVersion,
			})
		}
		if !publishTaskTransitionAllowed(current.State, in.To) {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "当前发布任务不能转换到目标状态").With(map[string]any{
				"state": current.State, "to": in.To,
			})
		}
		if err := s.guardPublishTaskTransition(ctx, tx, &current, &in, claiming); err != nil {
			return err
		}

		nextVersion := current.StateVersion + 1
		nextAttempt := current.Attempt
		nextRetry := current.NextRetryAt
		nextFilled, nextSubmitted := current.FilledAt, current.SubmittedAt
		nextPlatformSchedule := current.PlatformScheduleAt
		lastCode, lastMessage := current.LastErrorCode, current.LastErrorMessage
		evidenceJSON, err := json.Marshal(in.Evidence)
		if err != nil {
			return err
		}
		switch in.To {
		case "queued":
			nextRetry = nil
			lastCode, lastMessage = "", ""
		case "filling":
			nextAttempt++
			lastCode, lastMessage = "", ""
		case "filled":
			now := s.now()
			nextFilled = &now
		case "failed", "not_logged_in":
			lastCode, lastMessage = in.ErrorCode, in.ErrorMessage
		case "submitted":
			now := s.now()
			nextSubmitted = &now
		case "scheduled":
			if in.PlatformScheduleAt != nil {
				nextPlatformSchedule = in.PlatformScheduleAt
			}
		case "stopped", "skipped":
			nextRetry = nil
		}
		eventKind := "transition"
		switch in.To {
		case "filling":
			eventKind = "fill"
		case "filled":
			eventKind = "readback"
		case "queued":
			if current.State == "failed" || current.State == "not_logged_in" {
				eventKind = "retry"
			}
		case "submitted":
			if current.State == "ready" || current.State == "failed" || current.State == "not_logged_in" {
				eventKind = "adopt"
			}
		}
		_, err = tx.Exec(ctx, `UPDATE publish_task SET state=$2,state_version=$3,attempt=$4,
			next_retry_at=$5,platform_schedule_at=$6,filled_at=$7,submitted_at=$8,
			last_error_code=$9,last_error_message=$10,evidence=$11,updated_at=now()
			WHERE id=$1`, current.ID, in.To, nextVersion, nextAttempt, nextRetry,
			nextPlatformSchedule, nextFilled, nextSubmitted, lastCode, lastMessage, evidenceJSON)
		if err != nil {
			return err
		}
		var from *string
		if current.State != "" {
			from = &current.State
		}
		_, err = tx.Exec(ctx, `INSERT INTO publish_task_event
			(task_id,from_state,to_state,state_version,event_kind,evidence,note,idempotency_key,request_hash,actor)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, current.ID, from, in.To, nextVersion,
			eventKind, evidenceJSON, in.Note, in.IdempotencyKey, hash, actor.UserID)
		if err != nil {
			return err
		}
		switch in.To {
		case "filled":
			if err := s.recordWechatAPIDraftReceipt(ctx, tx, &current, in.Evidence); err != nil {
				return err
			}
			if err := s.recordWechatAPIDraftSubmittedMilestone(ctx, tx, &current, in.Evidence); err != nil {
				return err
			}
			if err := s.recordPublishChannelSuccess(ctx, tx, &current, in.Evidence, actor.UserID); err != nil {
				return err
			}
		case "failed", "not_logged_in":
			if err := s.recordPublishChannelFailure(ctx, tx, &current, lastCode, lastMessage); err != nil {
				return err
			}
		}
		out, err = scanPublishTask(tx.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, current.ID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Server) guardPublishTaskTransition(ctx context.Context, tx pgx.Tx, task *PublishTask, in *publishTaskTransitionInput, claiming bool) error {
	switch in.To {
	case "queued":
		if task.State != "ready" && task.State != "failed" && task.State != "not_logged_in" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 ready/failed/not_logged_in 任务可以排队")
		}
		if task.State == "failed" || task.State == "not_logged_in" {
			if task.Attempt >= task.MaxAttempts {
				return apiErr(http.StatusConflict, "publish_task_busy", "发布任务已达到最大尝试次数")
			}
		}
		if err := s.requireValidPublishManifest(ctx, task); err != nil {
			return err
		}
	case "awaiting_user":
		if task.State != "ready" && task.State != "filled" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "当前状态不能转人工")
		}
		if task.State == "ready" {
			if task.Mode != "manual" {
				return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 manual 模式可以直接转人工")
			}
			if err := s.requireValidPublishManifest(ctx, task); err != nil {
				return err
			}
		} else if !publishTaskHasScreenshot(in.Evidence) {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "转人工前必须保存证据截图")
		}
	case "filling":
		if task.State != "queued" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 queued 任务可以领取")
		}
		if task.Attempt >= task.MaxAttempts {
			return apiErr(http.StatusConflict, "publish_task_busy", "发布任务已达到最大尝试次数")
		}
		var filling int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM publish_task
			WHERE workspace_id=$1 AND account_id=$2 AND state='filling'`, task.WorkspaceID, task.AccountID).Scan(&filling); err != nil {
			return err
		}
		if filling >= 2 {
			return apiErr(http.StatusConflict, "publish_task_busy", "同一账号同时最多 2 个填写任务")
		}
		if task.Mode == "desktop" {
			var available int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM platform_connection
				WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND state='active'
				  AND availability='ready' AND last_seen_at > now()-interval '5 minutes'`,
				task.WorkspaceID, task.AccountID, task.Platform).Scan(&available); err != nil {
				return err
			}
			if available == 0 && task.Platform != "toutiao" {
				return apiErr(http.StatusConflict, "publish_task_busy", "平台连接不可用，不能领取任务")
			}
		}
	case "filled":
		if task.State != "filling" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 filling 任务可以回读完成")
		}
		if !publishTaskReadbackOK(in.Evidence) {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "回读未全部一致，不能标记已填入")
		}
	case "failed", "not_logged_in":
		if task.State != "filling" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 filling 任务可以记录失败/掉线")
		}
		if strings.TrimSpace(in.ErrorCode) == "" || runeLen(in.ErrorCode) > 80 || runeLen(in.ErrorMessage) > 500 {
			return validation("失败/掉线必须记录 1 到 80 字错误码和不超过 500 字说明")
		}
	case "submitted":
		if !publishTaskSubmittedEdge(task.State) {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "当前状态不能登记为已提交")
		}
		if err := s.requirePublishMilestone(ctx, tx, task.WorkID, "submitted"); err != nil {
			return err
		}
	case "scheduled":
		if task.State != "submitted" && task.State != "ready" && task.State != "failed" && task.State != "not_logged_in" {
			return apiErr(http.StatusConflict, "publish_task_state_invalid", "当前状态不能登记为已预约")
		}
		if err := s.requirePublishMilestone(ctx, tx, task.WorkID, "scheduled"); err != nil {
			return err
		}
		at := task.PlatformScheduleAt
		if in.PlatformScheduleAt != nil {
			at = in.PlatformScheduleAt
		}
		if at == nil || !at.After(s.now()) {
			return apiErr(http.StatusUnprocessableEntity, "publish_task_state_invalid", "已预约任务必须有未来的 platform_schedule_at")
		}
		if len(in.Evidence) == 0 {
			return validation("已预约任务必须提供平台预约证据")
		}
	case "stopped":
		if !in.Confirm {
			return validation("停止发布任务需要二次确认")
		}
	case "skipped":
		if in.Reason == "" {
			return validation("跳过发布任务必须填写原因")
		}
	}
	return nil
}

func (s *Server) requireValidPublishManifest(ctx context.Context, task *PublishTask) error {
	m, err := s.loadPublishManifest(ctx, task.WorkID, task.Platform)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(http.StatusUnprocessableEntity, "publish_manifest_invalid", "发布 manifest 不存在")
	}
	if err != nil {
		return err
	}
	state, err := s.effectivePublishManifestState(ctx, m)
	if err != nil {
		return err
	}
	if state != "valid" {
		return apiErr(http.StatusUnprocessableEntity, "publish_manifest_invalid", "发布 manifest 未通过校验").With(map[string]any{
			"validation_state": state, "checks": m.Validation.Checks,
		})
	}
	return nil
}

func (s *Server) requirePublishMilestone(ctx context.Context, tx pgx.Tx, workID uuid.UUID, want string) error {
	var state string
	err := tx.QueryRow(ctx, `SELECT state FROM work_publish_state WHERE work_id=$1`, workID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "请先通过既有发布里程碑服务登记"+want)
	}
	if err != nil {
		return err
	}
	if state != want {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "发布里程碑不是 "+want+"，不能投影任务状态").With(map[string]any{
			"milestone_state": state,
		})
	}
	return nil
}

func publishTaskTerminal(state string) bool {
	return state == "published" || state == "stopped" || state == "skipped"
}

func publishTaskTransitionAllowed(from, to string) bool {
	if from == "published" || from == "stopped" || from == "skipped" {
		return false
	}
	switch from {
	case "ready":
		return to == "queued" || to == "awaiting_user" || to == "submitted" || to == "scheduled" || to == "stopped" || to == "skipped"
	case "queued":
		return to == "filling" || to == "stopped" || to == "skipped"
	case "filling":
		return to == "filled" || to == "failed" || to == "not_logged_in" || to == "stopped" || to == "skipped"
	case "filled":
		return to == "awaiting_user" || to == "submitted" || to == "stopped" || to == "skipped"
	case "awaiting_user":
		return to == "submitted" || to == "stopped" || to == "skipped"
	case "failed", "not_logged_in":
		return to == "queued" || to == "submitted" || to == "scheduled" || to == "stopped" || to == "skipped"
	case "submitted":
		return to == "scheduled" || to == "published" || to == "stopped" || to == "skipped"
	case "scheduled":
		return to == "published" || to == "stopped" || to == "skipped"
	default:
		return false
	}
}

func publishTaskSubmittedEdge(state string) bool {
	switch state {
	case "ready", "filled", "awaiting_user", "failed", "not_logged_in":
		return true
	default:
		return false
	}
}

func publishTaskHasScreenshot(evidence map[string]any) bool {
	for _, key := range []string{"screenshot_asset_id", "screenshot_url", "screenshot"} {
		if value, ok := evidence[key]; ok {
			switch v := value.(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					return true
				}
			case uuid.UUID:
				if v != uuid.Nil {
					return true
				}
			}
		}
	}
	return false
}

func publishTaskReadbackOK(evidence map[string]any) bool {
	if value, ok := evidence["readback_ok"].(bool); ok {
		return value
	}
	if readback, ok := evidence["readback"].(map[string]any); ok {
		if value, ok := readback["ok"].(bool); ok {
			return value
		}
	}
	return false
}

func publishTaskStateKnown(state string) bool {
	switch state {
	case "ready", "queued", "filling", "filled", "awaiting_user", "submitted", "scheduled",
		"published", "failed", "not_logged_in", "skipped", "stopped":
		return true
	default:
		return false
	}
}

func (s *Server) publishTaskClaim(w http.ResponseWriter, r *http.Request) error {
	body, _, err := s.desktopReadAndVerifyProof(r, "publish.task.claim")
	if err != nil {
		return err
	}
	var in struct {
		TaskID          *uuid.UUID `json:"task_id,omitempty"`
		IdempotencyKey  string     `json:"idempotency_key"`
		ExpectedVersion int        `json:"expected_version"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &in); err != nil {
			return requestFormatError(r.Context(), err)
		}
	}
	if in.IdempotencyKey == "" {
		in.IdempotencyKey = "claim:" + uuid.NewString()
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	var task *PublishTask
	if in.TaskID != nil {
		task, err = s.loadPublishTaskByID(r.Context(), *in.TaskID)
	} else {
		task, err = s.findClaimablePublishTask(r.Context(), deviceID)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, map[string]any{"task": nil})
	}
	if err != nil {
		return err
	}
	if task.State == "filled" {
		out, err := s.claimPublishSubmitIntent(r.Context(), task, deviceID, in.IdempotencyKey)
		if err != nil {
			return err
		}
		view, err := s.publishTaskClaimView(r.Context(), out, s.now().Add(publishTaskLease))
		if err != nil {
			return err
		}
		view["intent"] = "submit"
		w.Header().Set("Cache-Control", "no-store")
		return ok(w, view)
	}
	evidence := map[string]any{
		"device_id":        deviceID,
		"lease_expires_at": s.now().Add(publishTaskLease).UTC().Format(time.RFC3339Nano),
	}
	out, err := s.transitionPublishTask(r.Context(), task, publishTaskTransitionInput{
		To: "filling", ExpectedVersion: in.ExpectedVersion, IdempotencyKey: in.IdempotencyKey,
		Evidence: evidence,
	}, true)
	if err != nil {
		return err
	}
	// P2 桌面执行器不能只拿到任务壳：它需要冻结的 manifest 才能填写，
	// 也需要账号名做 preflight 的当前账号核对。两者都必须从服务端事实源取，
	// 不能由客户端自报。manifest 在 queue 时已校验为 valid，这里只重读同一行。
	view, err := s.publishTaskClaimView(r.Context(), out, s.now().Add(publishTaskLease))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, view)
}

// publishTaskClaimView 组装桌面执行器领取任务所需的全部事实：任务壳、租约、
// 冻结 manifest 与账号名。只由 publishTaskClaim 在状态已切到 filling 后调用。
func (s *Server) publishTaskClaimView(ctx context.Context, task *PublishTask, lease time.Time) (map[string]any, error) {
	manifest, err := s.loadPublishManifest(ctx, task.WorkID, task.Platform)
	if err != nil {
		return nil, err
	}
	accountName, err := s.publishTaskAccountName(ctx, task.AccountID)
	if err != nil {
		return nil, err
	}
	externalAccountKey, err := s.publishTaskExternalAccountKey(ctx, task.AccountID, task.Platform)
	if err != nil {
		return nil, err
	}
	view := map[string]any{
		"task":                  task,
		"lease_expires_at":      lease,
		"manifest":              manifest.Payload,
		"manifest_revision":     manifest.Revision,
		"manifest_content_hash": manifest.ContentHash,
		"account_name":          accountName,
		"external_account_key":  externalAccountKey,
	}
	// P8-N2：真实页面填写需要图片字节。manifest 只有 asset_id，桌面拿不到
	// 服务器数据目录；这里把本轮 manifest 用到的图片随 claim 下发（base64）。
	// 只在 desktop 通道附带，API/manual 不传，避免无谓放大响应。
	if task.Mode == "desktop" && len(manifest.Payload.Assets) > 0 {
		assets, err := s.publishTaskClaimAssets(ctx, task, manifest.Payload.Assets)
		if err != nil {
			return nil, err
		}
		view["assets"] = assets
	}
	return view, nil
}

// publishTaskClaimAssets 只读 manifest 已冻结的资产，按 role/宽高/字节下发。
// 单张上限沿用上传链的 20MB；总量超过 24MB 直接失败，避免把 claim 变成大文件下载。
func (s *Server) publishTaskClaimAssets(ctx context.Context, task *PublishTask, manifestAssets []PublishManifestAsset) ([]map[string]any, error) {
	roleOf := make(map[uuid.UUID]PublishManifestAsset, len(manifestAssets))
	for _, item := range manifestAssets {
		roleOf[item.AssetID] = item
	}
	rows, err := s.db.Query(ctx, `SELECT id, storage_path, mime FROM asset
		WHERE workspace_id=$1 AND work_id=$2 ORDER BY position, created_at`, task.WorkspaceID, task.WorkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]map[string]any, 0, len(manifestAssets))
	total := 0
	for rows.Next() {
		var id uuid.UUID
		var storagePath, mime string
		if err := rows.Scan(&id, &storagePath, &mime); err != nil {
			return nil, err
		}
		meta, ok := roleOf[id]
		if !ok {
			continue
		}
		data, err := s.readStoredAsset(storagePath)
		if err != nil {
			return nil, err
		}
		total += len(data)
		if total > 24<<20 {
			return nil, apiErr(http.StatusConflict, "publish_asset_too_large", "发布图片总量超过 24MB，无法交给桌面端填写")
		}
		out = append(out, map[string]any{
			"asset_id": id.String(),
			"role":     meta.Role,
			"mime":     mime,
			"width":    meta.Width,
			"height":   meta.Height,
			"sha256":   meta.SHA256,
			"data":     base64.StdEncoding.EncodeToString(data),
		})
	}
	return out, rows.Err()
}

func (s *Server) publishTaskAccountName(ctx context.Context, accountID uuid.UUID) (string, error) {
	var name string
	err := s.db.QueryRow(ctx, `SELECT name FROM platform_account WHERE id=$1 AND workspace_id=$2`,
		accountID, ident(ctx).WorkspaceID).Scan(&name)
	return name, err
}

// publishTaskExternalAccountKey 取该账号当前活跃平台连接的稳定外部标识。
// 桌面端用它在真实页面上核对登录身份；OPS 账号名可被用户改名，不能作为身份依据。
// 平台没有连接（如 toutiao）时返回空字符串，由桌面端按平台能力决定是否可执行。
func (s *Server) publishTaskExternalAccountKey(ctx context.Context, accountID uuid.UUID, platform string) (string, error) {
	var key string
	err := s.db.QueryRow(ctx, `SELECT external_account_key FROM platform_connection
		WHERE workspace_id=$1 AND account_id=$2 AND platform=$3 AND state='active'
		ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
		ident(ctx).WorkspaceID, accountID, platform).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return key, err
}

func (s *Server) findClaimablePublishTask(ctx context.Context, deviceID uuid.UUID) (*PublishTask, error) {
	rows, err := s.db.Query(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN platform_connection c ON c.account_id=t.account_id AND c.workspace_id=t.workspace_id
		WHERE t.workspace_id=$1 AND t.state='queued' AND c.device_id=$2 AND c.state='active'
		  AND c.availability='ready' AND c.last_seen_at > now()-interval '5 minutes'
		  AND c.platform=t.platform
		ORDER BY t.created_at,t.id LIMIT 1`, ident(ctx).WorkspaceID, deviceID)
	if err != nil {
		return nil, err
	}
	items, err := scanPublishTaskRows(rows)
	if err != nil {
		return nil, err
	}
	if len(items) > 0 {
		return &items[0], nil
	}
	// P6-A3：submit-now 不新排队，而是在 filled 任务上写一次性 submit_intent。
	// 领取这类任务不把状态改回 filling（状态机不允许 filled→filling），
	// 只把意图标成 claimed 并递增 state_version；桌面据 intent=submit 走提交分支。
	rows, err = s.db.Query(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN platform_connection c ON c.account_id=t.account_id AND c.workspace_id=t.workspace_id
		WHERE t.workspace_id=$1 AND t.state='filled'
		  AND t.platform <> 'xhs'
		  AND t.evidence->'submit_intent'->>'state' IN ('queued','claimed')
		  AND c.device_id=$2 AND c.state='active'
		  AND c.availability='ready' AND c.last_seen_at > now()-interval '5 minutes'
		  AND c.platform=t.platform
		ORDER BY t.updated_at,t.id LIMIT 20`, ident(ctx).WorkspaceID, deviceID)
	if err != nil {
		return nil, err
	}
	items, err = scanPublishTaskRows(rows)
	if err != nil {
		return nil, err
	}
	now := s.now()
	for i := range items {
		intent, ok := publishTaskSubmitIntent(items[i].Evidence)
		if ok && publishSubmitIntentClaimable(intent, now) {
			return &items[i], nil
		}
	}
	return nil, pgx.ErrNoRows
}

func publishTaskSubmitIntent(evidence map[string]any) (map[string]any, bool) {
	if evidence == nil {
		return nil, false
	}
	intent, ok := evidence["submit_intent"].(map[string]any)
	if !ok || intent == nil {
		return nil, false
	}
	return intent, true
}

// publishSubmitIntentClaimable：queued 且未超 10 分钟窗口；claimed 但领取方
// 超过 60 秒没有推进时允许重新领取，避免桌面崩溃后意图永久卡住。
func publishSubmitIntentClaimable(intent map[string]any, now time.Time) bool {
	state, _ := intent["state"].(string)
	requested, err := time.Parse(time.RFC3339Nano, stringOrEmpty(intent["requested_at"]))
	if err != nil || now.Sub(requested) >= publishSubmitIntentWindow {
		return false
	}
	switch state {
	case "queued":
		return true
	case "claimed":
		claimed, err := time.Parse(time.RFC3339Nano, stringOrEmpty(intent["claimed_at"]))
		return err != nil || now.Sub(claimed) > 60*time.Second
	default:
		return false
	}
}

// claimPublishSubmitIntent 只改 evidence 与 state_version，不改任务状态；
// 事件仍记 transition（from=to=filled），保证审计链不出现第二条发布写入口。
func (s *Server) claimPublishSubmitIntent(ctx context.Context, task *PublishTask, deviceID uuid.UUID, idempotencyKey string) (*PublishTask, error) {
	intent, ok := publishTaskSubmitIntent(task.Evidence)
	if !ok || !publishSubmitIntentClaimable(intent, s.now()) {
		return nil, apiErr(http.StatusConflict, "publish_task_state_invalid", "没有可领取的立即提交意图")
	}
	now := s.now()
	evidence := clonePublishEvidence(task.Evidence)
	claimed := clonePublishEvidence(intent)
	claimed["state"] = "claimed"
	claimed["claimed_at"] = now.UTC().Format(time.RFC3339Nano)
	claimed["claimed_by"] = deviceID.String()
	evidence["submit_intent"] = claimed
	evidence["device_id"] = deviceID
	raw, err := json.Marshal(evidence)
	if err != nil {
		return nil, err
	}
	var out *PublishTask
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE publish_task SET evidence=$2,state_version=state_version+1,updated_at=now()
			WHERE id=$1 AND state='filled' AND state_version=$3`, task.ID, raw, task.StateVersion)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return apiErr(http.StatusConflict, "publish_task_version_conflict", "发布任务已变化，请重新领取")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO publish_task_event
			(task_id,from_state,to_state,state_version,event_kind,evidence,note,idempotency_key,request_hash,actor)
			VALUES($1,'filled','filled',$2,'transition',$3,'submit intent claimed',$4,$5,NULL)
			ON CONFLICT (task_id,idempotency_key) DO NOTHING`,
			task.ID, task.StateVersion+1, raw, idempotencyKey, "submit:"+task.ID.String()); err != nil {
			return err
		}
		out, err = scanPublishTask(tx.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t WHERE t.id=$1`, task.ID))
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func clonePublishEvidence(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+2)
	for k, v := range in {
		out[k] = v
	}
	return out
}

// publishSubmitResultEvidence 只处理 desktop submit-now 的落账证据：
// 只接受本设备领取、仍处于 filled 的任务；合并而不是覆盖原 evidence，
// 保留 submit_intent 的请求/领取链路，并把意图置为 completed。
func (s *Server) publishSubmitResultEvidence(task *PublishTask, deviceID uuid.UUID, resultEvidence map[string]any) (map[string]any, error) {
	if task.Mode != "desktop" {
		return nil, apiErr(http.StatusConflict, "publish_submit_channel_invalid", "桌面提交结果只适用于 desktop 通道")
	}
	if task.State != "filled" {
		return nil, apiErr(http.StatusConflict, "publish_task_state_invalid", "只有 filled 任务可以回写提交结果")
	}
	intent, ok := publishTaskSubmitIntent(task.Evidence)
	if !ok {
		return nil, apiErr(http.StatusConflict, "publish_submit_intent_missing", "任务没有可用的立即提交意图")
	}
	if state, _ := intent["state"].(string); state != "claimed" {
		return nil, apiErr(http.StatusConflict, "publish_submit_intent_missing", "立即提交意图尚未被领取")
	}
	if claimedBy, _ := intent["claimed_by"].(string); claimedBy != deviceID.String() {
		return nil, apiErr(http.StatusConflict, "publish_task_busy", "立即提交意图由其他设备领取")
	}
	merged := clonePublishEvidence(task.Evidence)
	for k, v := range resultEvidence {
		merged[k] = v
	}
	completed := clonePublishEvidence(intent)
	completed["state"] = "completed"
	completed["completed_at"] = s.now().UTC().Format(time.RFC3339Nano)
	merged["submit_intent"] = completed
	merged["submit_verified"] = true
	return merged, nil
}

func (s *Server) publishTaskHeartbeat(w http.ResponseWriter, r *http.Request) error {
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "publish.task.heartbeat")
	if err != nil {
		return err
	}
	var in struct {
		StateVersion   int    `json:"state_version"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	if task.State != "filling" || (in.StateVersion > 0 && task.StateVersion != in.StateVersion) {
		return apiErr(http.StatusConflict, "publish_task_state_invalid", "任务已不在填写中")
	}
	if fmtDevice, _ := task.Evidence["device_id"].(string); fmtDevice != "" && fmtDevice != deviceID.String() {
		return apiErr(http.StatusConflict, "publish_task_busy", "任务由其他设备领取")
	}
	if in.IdempotencyKey == "" {
		in.IdempotencyKey = "heartbeat:" + uuid.NewString()
	}
	lease := s.now().Add(publishTaskLease)
	if _, err := s.db.Exec(r.Context(), `UPDATE publish_task SET evidence=jsonb_set(evidence,'{lease_expires_at}',to_jsonb($2::text),true),updated_at=now()
		WHERE id=$1`, task.ID, lease.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"task_id": task.ID, "lease_expires_at": lease})
}

func (s *Server) publishTaskResult(w http.ResponseWriter, r *http.Request) error {
	taskID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "publish.task.result")
	if err != nil {
		return err
	}
	var in struct {
		To             string         `json:"to"`
		StateVersion   int            `json:"state_version"`
		IdempotencyKey string         `json:"idempotency_key"`
		Evidence       map[string]any `json:"evidence"`
		ErrorCode      string         `json:"error_code"`
		ErrorMessage   string         `json:"error_message"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.To != "filled" && in.To != "failed" && in.To != "not_logged_in" && in.To != "submitted" {
		return validation("to 只能是 filled/failed/not_logged_in/submitted")
	}
	if in.IdempotencyKey == "" {
		return validation("需要 idempotency_key")
	}
	deviceID, err := s.desktopDeviceOfProof(r)
	if err != nil {
		return err
	}
	task, err := s.loadPublishTaskByID(r.Context(), taskID)
	if err != nil {
		return err
	}
	if fmtDevice, _ := task.Evidence["device_id"].(string); fmtDevice != "" && fmtDevice != deviceID.String() {
		return apiErr(http.StatusConflict, "publish_task_busy", "任务由其他设备领取")
	}
	if in.Evidence == nil {
		in.Evidence = map[string]any{}
	}
	if encoded, ok := in.Evidence["screenshot_base64"].(string); ok {
		// P3-A6：截图字节只在传输中出现一次，落账前转存 asset，证据里只留 id。
		id, err := s.storePublishScreenshot(r.Context(), task, encoded)
		if err != nil {
			return validation("回读截图保存失败：" + err.Error())
		}
		delete(in.Evidence, "screenshot_base64")
		in.Evidence["screenshot_asset_id"] = id.String()
		if readback, ok := in.Evidence["readback"].(map[string]any); ok {
			readback["screenshot_asset_id"] = id.String()
		}
	}
	if in.To == "submitted" {
		merged, err := s.publishSubmitResultEvidence(task, deviceID, in.Evidence)
		if err != nil {
			return err
		}
		in.Evidence = merged
	}
	out, err := s.transitionPublishTask(r.Context(), task, publishTaskTransitionInput{
		To: in.To, ExpectedVersion: in.StateVersion, IdempotencyKey: in.IdempotencyKey,
		Evidence: in.Evidence, ErrorCode: in.ErrorCode, ErrorMessage: in.ErrorMessage,
	}, false)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, out)
}

type publishBatchInput struct {
	Label     string      `json:"label"`
	WorkIDs   []uuid.UUID `json:"work_ids"`
	Platforms []string    `json:"platforms"`
	Mode      string      `json:"mode"`
	PlanAt    *time.Time  `json:"plan_at"`
}

type publishBatchResult struct {
	Batch   PublishBatch  `json:"batch"`
	Tasks   []PublishTask `json:"tasks"`
	Created []uuid.UUID   `json:"created"`
	Skipped []uuid.UUID   `json:"skipped"`
}

func (s *Server) createPublishBatch(w http.ResponseWriter, r *http.Request) error {
	if err := s.requireEditor(r.Context()); err != nil {
		return err
	}
	var in publishBatchInput
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Label = strings.TrimSpace(in.Label)
	if runeLen(in.Label) < 1 || runeLen(in.Label) > 100 {
		return validation("批次名称需要 1 到 100 字")
	}
	if len(in.WorkIDs) == 0 || len(in.WorkIDs) > 20 {
		return apiErr(http.StatusUnprocessableEntity, "publish_batch_limit", "一个批次最多 20 个作品")
	}
	platforms, err := normalizePublishPlatforms(in.Platforms)
	if err != nil {
		return err
	}
	mode := strings.TrimSpace(in.Mode)
	if mode == "" {
		mode = "desktop"
	}
	switch mode {
	case "api", "desktop", "manual":
	default:
		return validation("mode 必须是 api/desktop/manual")
	}
	if in.PlanAt != nil && in.PlanAt.Before(s.now()) {
		return validation("plan_at 不能早于当前时间")
	}
	seenWorks := map[uuid.UUID]bool{}
	workIDs := make([]uuid.UUID, 0, len(in.WorkIDs))
	var accountID uuid.UUID
	for _, id := range in.WorkIDs {
		if seenWorks[id] {
			continue
		}
		wk, err := s.loadWork(r.Context(), id)
		if err != nil {
			return err
		}
		if demo, err := s.accountIsDemo(r.Context(), wk.AccountID); err != nil {
			return err
		} else if demo {
			return demoAccountWriteError()
		}
		if accountID == uuid.Nil {
			accountID = wk.AccountID
		} else if accountID != wk.AccountID {
			return apiErr(http.StatusUnprocessableEntity, "publish_batch_limit", "一个批次只能包含同一账号的作品")
		}
		seenWorks[id] = true
		workIDs = append(workIDs, id)
	}
	if len(workIDs) == 0 {
		return apiErr(http.StatusUnprocessableEntity, "publish_batch_limit", "批次没有有效作品")
	}

	ctx := r.Context()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var batch PublishBatch
	err = tx.QueryRow(ctx, `INSERT INTO publish_batch(workspace_id,account_id,label,state,total,created_by)
		VALUES($1,$2,$3,'queued',0,$4) RETURNING id`, ident(ctx).WorkspaceID, accountID, in.Label, ident(ctx).UserID).Scan(&batch.ID)
	if err != nil {
		return err
	}
	created := make([]uuid.UUID, 0, len(workIDs)*len(platforms))
	skipped := make([]uuid.UUID, 0)
	for _, workID := range workIDs {
		wk, err := s.loadWork(ctx, workID)
		if err != nil {
			return err
		}
		manifests := make(map[string]*PublishManifest, len(platforms))
		for _, platform := range platforms {
			m, err := s.loadPublishManifest(ctx, wk.ID, platform)
			if err != nil {
				return apiErr(http.StatusUnprocessableEntity, "publish_manifest_invalid", "批次中的发布 manifest 不存在").With(map[string]any{
					"work_id": wk.ID, "platform": platform,
				})
			}
			state, err := s.effectivePublishManifestState(ctx, m)
			if err != nil {
				return err
			}
			if state != "valid" {
				return apiErr(http.StatusUnprocessableEntity, "publish_manifest_invalid", "批次中的发布 manifest 未通过校验").With(map[string]any{
					"work_id": wk.ID, "platform": platform, "validation_state": state, "checks": m.Validation.Checks,
				})
			}
			manifests[platform] = m
		}
		for _, platform := range platforms {
			m := manifests[platform]
			var taskID uuid.UUID
			err := tx.QueryRow(ctx, `INSERT INTO publish_task
				(workspace_id,account_id,work_id,platform,state,state_version,mode,batch_id,plan_at,
				 idempotency_key,created_by)
				VALUES($1,$2,$3,$4,'ready',1,$5,$6,$7,$8,$9)
				ON CONFLICT (work_id,platform) DO NOTHING RETURNING id`,
				ident(ctx).WorkspaceID, accountID, wk.ID, platform, mode, batch.ID, in.PlanAt,
				uuid.NewString(), ident(ctx).UserID).Scan(&taskID)
			if errors.Is(err, pgx.ErrNoRows) {
				var existing uuid.UUID
				if err := tx.QueryRow(ctx, `SELECT id FROM publish_task WHERE work_id=$1 AND platform=$2`, wk.ID, platform).Scan(&existing); err != nil {
					return err
				}
				skipped = append(skipped, existing)
				continue
			}
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO publish_task_event
				(task_id,from_state,to_state,state_version,event_kind,evidence,idempotency_key,request_hash,actor)
				VALUES($1,NULL,'ready',1,'transition','{}'::jsonb,$2,$3,$4)`,
				taskID, uuid.NewString(), m.ContentHash, ident(ctx).UserID)
			if err != nil {
				return err
			}
			created = append(created, taskID)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE publish_batch SET total=$2,updated_at=now() WHERE id=$1`, batch.ID, len(created)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	loaded, err := s.loadPublishBatch(ctx, batch.ID)
	if err != nil {
		return err
	}
	items, err := s.listPublishTasksForBatch(ctx, batch.ID)
	if err != nil {
		return err
	}
	return ok(w, publishBatchResult{Batch: *loaded, Tasks: items, Created: created, Skipped: skipped})
}

func (s *Server) loadPublishBatch(ctx context.Context, id uuid.UUID) (*PublishBatch, error) {
	var b PublishBatch
	err := s.db.QueryRow(ctx, `SELECT `+publishBatchCols+` FROM publish_batch b
		WHERE b.id=$1 AND b.workspace_id=$2`, id, ident(ctx).WorkspaceID).Scan(
		&b.ID, &b.WorkspaceID, &b.AccountID, &b.Label, &b.State, &b.Total, &b.Done,
		&b.CreatedBy, &b.CreatedAt, &b.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *Server) listPublishBatches(w http.ResponseWriter, r *http.Request) error {
	rows, err := s.db.Query(r.Context(), `SELECT `+publishBatchCols+` FROM publish_batch b
		WHERE b.workspace_id=$1 ORDER BY b.created_at DESC,b.id LIMIT 200`, ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := make([]PublishBatch, 0)
	for rows.Next() {
		var b PublishBatch
		if err := rows.Scan(&b.ID, &b.WorkspaceID, &b.AccountID, &b.Label, &b.State, &b.Total, &b.Done,
			&b.CreatedBy, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return err
		}
		items = append(items, b)
	}
	return ok(w, items)
}

func (s *Server) getPublishBatch(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r, "id")
	if err != nil {
		return err
	}
	b, err := s.loadPublishBatch(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apiErr(http.StatusNotFound, "not_found", "发布批次不存在")
	}
	if err != nil {
		return err
	}
	items, err := s.listPublishTasksForBatch(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"batch": b, "tasks": items})
}

func (s *Server) listPublishTasksForBatch(ctx context.Context, batchID uuid.UUID) ([]PublishTask, error) {
	rows, err := s.db.Query(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		JOIN work w ON w.id=t.work_id
		WHERE t.batch_id=$1 AND t.workspace_id=$2 AND w.deleted_at IS NULL
		ORDER BY t.created_at,t.id`, batchID, ident(ctx).WorkspaceID)
	if err != nil {
		return nil, err
	}
	return scanPublishTaskRows(rows)
}

// syncPublishTaskPublished is called inside the same transaction as syncPublishStatePublic.
// It is the only task-side path that writes published; task transitions reject `published`.
// 平台归属过滤：公开发布事实只属于作品自身平台（work → account.platform），
// 其他平台的 submitted/scheduled 任务保持原态，不得被跨平台翻成 published。
func (s *Server) syncPublishTaskPublished(ctx context.Context, tx pgx.Tx, workID uuid.UUID, publishRevision int, actor *uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT t.id,t.state,t.state_version FROM publish_task t
		JOIN work w ON w.id=t.work_id
		JOIN platform_account a ON a.id=w.account_id
		WHERE t.work_id=$1 AND t.workspace_id=$2 AND t.platform=a.platform
		  AND t.state IN ('submitted','scheduled') FOR UPDATE`,
		workID, ident(ctx).WorkspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type row struct {
		id      uuid.UUID
		state   string
		version int
	}
	var items []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.state, &r.version); err != nil {
			return err
		}
		items = append(items, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, item := range items {
		key := "publication:" + item.id.String() + ":" + strconv.Itoa(publishRevision)
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM publish_task_event WHERE task_id=$1 AND idempotency_key=$2)`,
			item.id, key).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		next := item.version + 1
		now := s.now()
		evidence, _ := json.Marshal(map[string]any{"source": "published_endpoint", "publish_revision": publishRevision})
		if _, err := tx.Exec(ctx, `UPDATE publish_task SET state='published',state_version=$2,published_at=$3,updated_at=now()
			WHERE id=$1`, item.id, next, now); err != nil {
			return err
		}
		hash, _ := cxcanonicaljson.Hash(map[string]any{"work_id": workID, "publish_revision": publishRevision, "task_id": item.id})
		if _, err := tx.Exec(ctx, `INSERT INTO publish_task_event
			(task_id,from_state,to_state,state_version,event_kind,evidence,note,idempotency_key,request_hash,actor)
			VALUES($1,$2,'published',$3,'transition',$4,'由既有发布回填入口同步',$5,$6,$7)`,
			item.id, item.state, next, evidence, key, hash, actor); err != nil {
			return err
		}
	}
	return nil
}
