package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
)

// AI 任务中心（10 文档第 3.5 节）：耗时任务持久化到 ai_job，可离开页面、可取消、完成后通知。

type jobSpec struct {
	TaskType  string
	Label     string
	Link      string
	AccountID *uuid.UUID
	WorkID    *uuid.UUID
	SectionID *uuid.UUID
	Input     any
}

type AIJob struct {
	ID         uuid.UUID       `json:"id"`
	AccountID  *uuid.UUID      `json:"account_id"`
	WorkID     *uuid.UUID      `json:"work_id"`
	SectionID  *uuid.UUID      `json:"section_id"`
	TaskType   string          `json:"task_type"`
	Label      string          `json:"label"`
	Status     string          `json:"status"`
	Result     json.RawMessage `json:"result"`
	Error      string          `json:"error"`
	AICallID   *uuid.UUID      `json:"ai_call_id"`
	Link       string          `json:"link"`
	CreatedAt  time.Time       `json:"created_at"`
	StartedAt  *time.Time      `json:"started_at"`
	FinishedAt *time.Time      `json:"finished_at"`
}

const jobCols = `id, account_id, work_id, section_id, task_type, label, status, result, error, ai_call_id, link, created_at, started_at, finished_at`

func scanJob(row interface{ Scan(...any) error }) (AIJob, error) {
	var j AIJob
	var res []byte
	err := row.Scan(&j.ID, &j.AccountID, &j.WorkID, &j.SectionID, &j.TaskType, &j.Label, &j.Status, &res, &j.Error, &j.AICallID, &j.Link,
		&j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	if len(res) > 0 {
		j.Result = res
	}
	return j, err
}

func (s *Server) createJob(ctx context.Context, spec jobSpec, status string) (uuid.UUID, error) {
	id := ident(ctx)
	in, _ := json.Marshal(spec.Input)
	if spec.Input == nil {
		in = []byte("{}")
	}
	var started *time.Time
	if status == "running" {
		now := s.now()
		started = &now
	}
	var jobID uuid.UUID
	err := s.db.QueryRow(ctx, `INSERT INTO ai_job (workspace_id, account_id, work_id, section_id, task_type, label, status, input, link, created_by, started_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, id.WorkspaceID, spec.AccountID, spec.WorkID, spec.SectionID, spec.TaskType,
		truncate(spec.Label, 80), status, in, spec.Link, id.UserID, started).Scan(&jobID)
	return jobID, err
}

func (s *Server) finishJob(id uuid.UUID, status string, result any, errMsg string, callID *uuid.UUID) {
	var res []byte
	if result != nil {
		res, _ = json.Marshal(result)
	}
	if _, err := s.db.Exec(context.Background(), `UPDATE ai_job SET status=$2, result=$3, error=$4, ai_call_id=coalesce($5, ai_call_id), finished_at=now()
		WHERE id=$1 AND status IN ('queued','running')`, id, status, res, truncate(errMsg, 500), callID); err != nil {
		slog.Error("更新 AI 任务状态失败", "err", err)
	}
}

func (s *Server) registerJobCancel(id uuid.UUID, cancel context.CancelFunc) {
	s.jobMu.Lock()
	s.jobCancels[id] = cancel
	s.jobMu.Unlock()
}

func (s *Server) unregisterJobCancel(id uuid.UUID) {
	s.jobMu.Lock()
	delete(s.jobCancels, id)
	s.jobMu.Unlock()
}

func (s *Server) workspaceSem(ws uuid.UUID) chan struct{} {
	s.jobMu.Lock()
	defer s.jobMu.Unlock()
	sem, ok := s.jobSems[ws]
	if !ok {
		sem = make(chan struct{}, max(1, s.cfg.AIWorkers))
		s.jobSems[ws] = sem
	}
	return sem
}

func (s *Server) waitAIWorker(ctx context.Context, queued func()) (func(), error) {
	sem := s.workspaceSem(ident(ctx).WorkspaceID)
	release := func() { <-sem }
	select {
	case sem <- struct{}{}:
		return release, nil
	default:
	}
	queued()
	timer := time.NewTimer(s.aiQueueTimeout)
	defer timer.Stop()
	select {
	case sem <- struct{}{}:
		return release, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, apiErr(503, "ai_queue_timeout", "AI 任务排队超过 60 秒，请稍后重试")
	}
}

func (s *Server) runningSectionJob(ctx context.Context, sectionID uuid.UUID) (uuid.UUID, bool) {
	var id uuid.UUID
	err := s.db.QueryRow(ctx, `SELECT id FROM ai_job WHERE section_id=$1 AND status IN ('queued','running') AND created_at > now() - interval '10 minutes'
		ORDER BY created_at DESC LIMIT 1`, sectionID).Scan(&id)
	if err != nil {
		return uuid.Nil, false
	}
	s.jobMu.Lock()
	_, live := s.jobCancels[id]
	s.jobMu.Unlock()
	return id, live
}

// startBackgroundJob queues fn in the workspace pool; it keeps running after the request returns.
func (s *Server) startBackgroundJob(ctx context.Context, spec jobSpec, fn func(ctx context.Context) (any, error)) (uuid.UUID, error) {
	jobID, err := s.createJob(ctx, spec, "queued")
	if err != nil {
		return uuid.Nil, err
	}
	who := ident(ctx)
	bg := context.WithValue(context.Background(), ctxMember, who)
	jctx, cancel := context.WithCancel(bg)
	s.registerJobCancel(jobID, cancel)
	go func() {
		defer cancel()
		defer s.unregisterJobCancel(jobID)
		sem := s.workspaceSem(who.WorkspaceID)
		select {
		case sem <- struct{}{}:
		case <-jctx.Done():
			s.finishJob(jobID, "cancelled", nil, "", nil)
			return
		}
		defer func() { <-sem }()
		_, _ = s.db.Exec(context.Background(), `UPDATE ai_job SET status='running', started_at=now() WHERE id=$1 AND status='queued'`, jobID)
		res, err := fn(jctx)
		switch {
		case jctx.Err() != nil:
			s.finishJob(jobID, "cancelled", nil, "", nil)
		case err != nil:
			s.finishJob(jobID, "failed", nil, errText(err), nil)
			s.notifyJobDone(bg, spec, false, errText(err))
		default:
			var callID *uuid.UUID
			if m, ok := res.(map[string]any); ok {
				if c, ok := m["ai_call_id"].(uuid.UUID); ok {
					callID = &c
				}
			}
			s.finishJob(jobID, "done", res, "", callID)
			s.notifyJobDone(bg, spec, true, "")
		}
	}()
	return jobID, nil
}

func (s *Server) notifyJobDone(ctx context.Context, spec jobSpec, success bool, msg string) {
	id := ident(ctx)
	if id == nil {
		return
	}
	title := spec.Label + " 已完成"
	kind := "job_done"
	if !success {
		title, kind = spec.Label+" 失败", "job_failed"
	}
	s.notify(ctx, id.WorkspaceID, id.UserID, kind, title, msg, spec.Link, "")
}

// interruptJobs marks jobs orphaned by a restart; their partial work was never written.
func (s *Server) interruptJobs(ctx context.Context) {
	if _, err := s.db.Exec(ctx, `UPDATE ai_job SET status='failed', error='服务重启，任务中断，请重新发起', finished_at=now()
		WHERE status IN ('queued','running')`); err != nil {
		slog.Error("清理中断的 AI 任务失败", "err", err)
	}
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := ident(ctx)
	sql := `SELECT ` + jobCols + ` FROM ai_job WHERE workspace_id=$1 AND created_by=$2`
	args := []any{id.WorkspaceID, id.UserID}
	switch r.URL.Query().Get("status") {
	case "active":
		sql += ` AND status IN ('queued','running')`
	case "":
	default:
		args = append(args, r.URL.Query().Get("status"))
		sql += ` AND status=$3`
	}
	if wid := r.URL.Query().Get("work_id"); wid != "" {
		if u, err := uuid.Parse(wid); err == nil {
			args = append(args, u)
			sql += ` AND work_id=$` + itoa(len(args))
		}
	}
	rows, err := s.db.Query(ctx, sql+` ORDER BY created_at DESC LIMIT 50`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	list := []AIJob{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return err
		}
		list = append(list, j)
	}
	return ok(w, list)
}

func (s *Server) ownedJob(r *http.Request) (*AIJob, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, err
	}
	j, err := scanJob(s.db.QueryRow(r.Context(), `SELECT `+jobCols+` FROM ai_job WHERE id=$1 AND workspace_id=$2`, id, ident(r.Context()).WorkspaceID))
	if err != nil {
		return nil, err
	}
	return &j, nil
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) error {
	j, err := s.ownedJob(r)
	if err != nil {
		return err
	}
	return ok(w, j)
}

// cancelJob stops a running job; a cancelled generation never writes into the work.
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) error {
	j, err := s.ownedJob(r)
	if err != nil {
		return err
	}
	if j.Status != "queued" && j.Status != "running" {
		return ok(w, j)
	}
	s.jobMu.Lock()
	cancel := s.jobCancels[j.ID]
	s.jobMu.Unlock()
	if cancel != nil {
		cancel()
	}
	s.finishJob(j.ID, "cancelled", nil, "", nil)
	j2, err := s.ownedJob(r)
	if err != nil {
		return err
	}
	return ok(w, j2)
}

func itoa(n int) string { return strconv.Itoa(n) }
