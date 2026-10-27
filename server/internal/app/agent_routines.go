package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type agentRoutineExecutionKey struct{}

type agentRoutineExecution struct {
	RoutineID    uuid.UUID
	OccurrenceID uuid.UUID
	LeaseToken   uuid.UUID
}

func withAgentRoutineExecution(ctx context.Context, routineID, occurrenceID, leaseToken uuid.UUID) context.Context {
	return context.WithValue(ctx, agentRoutineExecutionKey{}, agentRoutineExecution{RoutineID: routineID, OccurrenceID: occurrenceID, LeaseToken: leaseToken})
}

func agentRoutineExecutionOf(ctx context.Context) *agentRoutineExecution {
	v, ok := ctx.Value(agentRoutineExecutionKey{}).(agentRoutineExecution)
	if !ok || v.RoutineID == uuid.Nil || v.OccurrenceID == uuid.Nil {
		return nil
	}
	return &v
}

func agentRoutineFeature() error {
	if err := requireAgentFeature("routines"); err != nil {
		return err
	}
	return nil
}

func agentRoutineCanManage(ctx context.Context) error {
	if err := agentRoutineFeature(); err != nil {
		return err
	}
	id := ident(ctx)
	if id == nil || id.AdminOverride || (id.Role != string(roleOwner) && id.Role != string(roleEditor)) {
		return errNotFound
	}
	return nil
}

func agentRunRoutineID(st *agentRunState) uuid.UUID {
	if st != nil && st.RoutineID != nil {
		return *st.RoutineID
	}
	return uuid.Nil
}

func agentRunRoutineOccurrenceID(st *agentRunState) uuid.UUID {
	if st != nil && st.RoutineOccurrenceID != nil {
		return *st.RoutineOccurrenceID
	}
	return uuid.Nil
}

type agentRoutineView struct {
	WorkspaceID       uuid.UUID               `json:"-"`
	UserID            uuid.UUID               `json:"-"`
	ID                uuid.UUID               `json:"id"`
	Revision          int64                   `json:"revision"`
	Name              string                  `json:"name"`
	Prompt            string                  `json:"prompt"`
	PublicContextRefs []agentContextReference `json:"public_context_refs"`
	AccountID         uuid.UUID               `json:"account_id"`
	Cadence           string                  `json:"cadence"`
	Weekday           *int                    `json:"weekday,omitempty"`
	TimeOfDay         string                  `json:"time_of_day"`
	OnceAt            *time.Time              `json:"once_at,omitempty"`
	Timezone          string                  `json:"timezone"`
	Destination       string                  `json:"destination"`
	ConversationID    *uuid.UUID              `json:"conversation_id,omitempty"`
	Model             agentModelRef           `json:"model"`
	Status            string                  `json:"status"`
	NextDueAt         *time.Time              `json:"next_due_at,omitempty"`
	FailureCount      int                     `json:"failure_count"`
	ErrorCode         string                  `json:"error_code,omitempty"`
	LastRunAt         *time.Time              `json:"last_run_at,omitempty"`
	CreatedAt         time.Time               `json:"created_at"`
	UpdatedAt         time.Time               `json:"updated_at"`
}

const agentRoutineSelect = `id,revision,name,prompt,public_context_refs,account_id,cadence,weekday,
	time_of_day::text,once_at,timezone,destination,conversation_id,model_provider_id,model,status,next_due_at,
	failure_count,error_code,last_run_at,created_at,updated_at,workspace_id,user_id`

func scanAgentRoutine(row pgx.Row) (agentRoutineView, error) {
	var v agentRoutineView
	var refs []byte
	var weekday *int
	var providerID uuid.UUID
	if err := row.Scan(&v.ID, &v.Revision, &v.Name, &v.Prompt, &refs, &v.AccountID, &v.Cadence, &weekday,
		&v.TimeOfDay, &v.OnceAt, &v.Timezone, &v.Destination, &v.ConversationID, &providerID, &v.Model.Model,
		&v.Status, &v.NextDueAt, &v.FailureCount, &v.ErrorCode, &v.LastRunAt, &v.CreatedAt, &v.UpdatedAt,
		&v.WorkspaceID, &v.UserID); err != nil {
		return v, err
	}
	v.Model.ProviderID = providerID
	v.Weekday = weekday
	v.PublicContextRefs = []agentContextReference{}
	if err := json.Unmarshal(refs, &v.PublicContextRefs); err != nil {
		return v, err
	}
	return v, nil
}

func (s *Server) agentRoutineByID(ctx context.Context, routineID uuid.UUID) (agentRoutineView, error) {
	id := ident(ctx)
	v, err := scanAgentRoutine(s.db.QueryRow(ctx, `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status<>'deleted'`, routineID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return v, errNotFound
	}
	return v, err
}

type agentRoutineMutationRequest struct {
	RequestID         string                  `json:"request_id"`
	ExpectedRevision  int64                   `json:"expected_revision"`
	Name              string                  `json:"name"`
	Prompt            string                  `json:"prompt"`
	PublicContextRefs []agentContextReference `json:"public_context_refs"`
	AccountID         string                  `json:"account_id"`
	Cadence           string                  `json:"cadence"`
	Weekday           *int                    `json:"weekday"`
	TimeOfDay         string                  `json:"time_of_day"`
	OnceAt            *time.Time              `json:"once_at"`
	Timezone          string                  `json:"timezone"`
	Destination       string                  `json:"destination"`
	ConversationID    string                  `json:"conversation_id"`
	Model             agentModelRef           `json:"model"`
}

func agentRoutineRequestID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, validation("request_id 必须是有效UUID")
	}
	return id, nil
}

func agentRoutineTime(raw string) (string, error) {
	t, err := time.Parse("15:04", strings.TrimSpace(raw))
	if err != nil {
		return "", validation("time_of_day 必须使用 HH:MM")
	}
	return t.Format("15:04:05"), nil
}

func nextAgentRoutineDue(cadence string, weekday *int, timeOfDay string, onceAt *time.Time, now time.Time, loc *time.Location) (*time.Time, error) {
	if cadence == "once" {
		if onceAt == nil || !onceAt.After(now) {
			return nil, validation("一次性任务时间必须晚于当前时间")
		}
		v := onceAt.In(loc)
		return &v, nil
	}
	parsed, err := time.Parse("15:04:05", timeOfDay)
	if err != nil {
		return nil, validation("time_of_day 必须使用 HH:MM")
	}
	local := now.In(loc)
	for offset := 0; offset <= 7; offset++ {
		day := time.Date(local.Year(), local.Month(), local.Day()+offset, parsed.Hour(), parsed.Minute(), 0, 0, loc)
		if cadence == "weekly" {
			if weekday == nil || int(day.Weekday()+6)%7+1 != *weekday {
				continue
			}
		} else if cadence != "daily" {
			return nil, validation("cadence 只支持 once、daily、weekly")
		}
		if day.After(local) {
			return &day, nil
		}
	}
	return nil, validation("无法计算下一次运行时间")
}

func (s *Server) validateAgentRoutine(ctx context.Context, req *agentRoutineMutationRequest) (uuid.UUID, agentModelRef, []agentContextReference, *uuid.UUID, *time.Time, string, error) {
	name, prompt := strings.TrimSpace(req.Name), strings.TrimSpace(req.Prompt)
	if runeLen(name) < 1 || runeLen(name) > 100 || runeLen(prompt) < 1 || runeLen(prompt) > 4000 {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(422, "invalid_arguments", "名称为1～100字，任务提示为1～4000字")
	}
	if req.Timezone != "Asia/Shanghai" {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("时区固定为 Asia/Shanghai")
	}
	timeOfDay, err := agentRoutineTime(req.TimeOfDay)
	if err != nil {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", err
	}
	if req.Cadence == "once" {
		if req.Weekday != nil || req.OnceAt == nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("一次性任务必须提供 once_at，不能提供 weekday")
		}
	} else if req.Cadence == "daily" {
		if req.Weekday != nil || req.OnceAt != nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("每日任务不能提供 weekday 或 once_at")
		}
	} else if req.Cadence == "weekly" {
		if req.Weekday == nil || *req.Weekday < 1 || *req.Weekday > 7 || req.OnceAt != nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("每周任务必须提供1～7的weekday，不能提供once_at")
		}
	} else {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("cadence 只支持 once、daily、weekly")
	}
	accountID, err := uuid.Parse(strings.TrimSpace(req.AccountID))
	if err != nil || accountID == uuid.Nil {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(422, "agent_routine_unavailable", "例行任务需要选择一个账号")
	}
	var accountActive bool
	if err := s.db.QueryRow(ctx, `SELECT status='active' FROM platform_account WHERE id=$1 AND workspace_id=$2`,
		accountID, ident(ctx).WorkspaceID).Scan(&accountActive); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", errNotFound
		}
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", err
	}
	if !accountActive {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(409, "agent_routine_unavailable", "所选账号已停用，不能启用例行任务")
	}
	if req.Model.ProviderID == uuid.Nil || strings.TrimSpace(req.Model.Model) == "" {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(422, "agent_routine_unavailable", "请选择已通过工具自检的服务器模型")
	}
	model, err := s.resolveAgentModel(ctx, req.Model)
	if err != nil {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", err
	}
	var serverModel bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM model_provider WHERE id=$1 AND workspace_id=$2
		AND execution_location='server' AND status='active')`, model.ProviderID, ident(ctx).WorkspaceID).Scan(&serverModel); err != nil {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", err
	}
	if !serverModel {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(422, "agent_routine_unavailable", "例行任务仅支持当前工作区可用的服务器模型")
	}
	var conversationID *uuid.UUID
	if req.Destination == "current" {
		parsed, parseErr := uuid.Parse(strings.TrimSpace(req.ConversationID))
		if parseErr != nil || parsed == uuid.Nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("继续当前对话时必须选择本人对话")
		}
		conversation, convErr := s.agentConversationFor(ctx, parsed)
		if convErr != nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", convErr
		}
		if conversation.ArchivedAt != nil || conversation.AccountID == nil || *conversation.AccountID != accountID {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", apiErr(409, "agent_routine_unavailable", "目标对话必须未归档且绑定同一账号")
		}
		conversationID = &parsed
	} else if req.Destination != "new" {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("destination 只支持 current 或 new")
	}
	refs := append([]agentContextReference{}, req.PublicContextRefs...)
	for i := range refs {
		refs[i].Scope = "turn"
		if refs[i].Type != "work" && refs[i].Type != "material" && refs[i].Type != "topic" && refs[i].Type != "image" && refs[i].Type != "report" {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("例行任务只支持公开业务资料引用，不能引用私人对话产物")
		}
		if refs[i].Anchor != nil {
			return uuid.Nil, agentModelRef{}, nil, nil, nil, "", validation("例行任务不能引用私人产物选段")
		}
	}
	refs, err = s.agentValidateContextReferences(ctx, refs, &accountID)
	if err != nil {
		return uuid.Nil, agentModelRef{}, nil, nil, nil, "", err
	}
	loc := s.loc
	if req.Cadence == "once" {
		due, err := nextAgentRoutineDue(req.Cadence, req.Weekday, timeOfDay, req.OnceAt, s.now(), loc)
		return accountID, model, refs, conversationID, due, timeOfDay, err
	}
	due, err := nextAgentRoutineDue(req.Cadence, req.Weekday, timeOfDay, nil, s.now(), loc)
	return accountID, model, refs, conversationID, due, timeOfDay, err
}

func (s *Server) validateAgentRoutineToolArgs(ctx context.Context, st *agentRunState, tool *AgentTool, args map[string]any) error {
	if st.AccountID == nil {
		return agentRoutineUnavailable("例行任务缺少绑定账号")
	}
	for _, key := range []string{"accountId", "account_id"} {
		if value, exists := args[key]; exists {
			raw, ok := value.(string)
			if !ok || strings.TrimSpace(raw) == "" {
				return agentRoutineUnavailable("例行任务账号参数无效")
			}
			id, err := uuid.Parse(raw)
			if err != nil || id != *st.AccountID {
				return agentRoutineUnavailable("例行任务只能查询绑定账号的数据")
			}
		}
	}
	if tool.Target.Type == "account" {
		targetID, err := uuid.Parse(strings.TrimSpace(agentArgStr(args, tool.Target.Param)))
		if err != nil || targetID != *st.AccountID {
			return agentRoutineUnavailable("例行任务只能查询绑定账号的数据")
		}
	}
	if tool.Target.Type == "work" {
		workID, err := uuid.Parse(strings.TrimSpace(agentArgStr(args, "id")))
		if err != nil || workID == uuid.Nil {
			return agentRoutineUnavailable("例行任务只能查询绑定账号内的作品")
		}
		var belongs bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM work w JOIN platform_account a ON a.id=w.account_id
			WHERE w.id=$1 AND w.account_id=$2 AND a.workspace_id=$3)`, workID, *st.AccountID, st.WorkspaceID).Scan(&belongs); err != nil {
			return err
		}
		if !belongs {
			return agentRoutineUnavailable("例行任务只能查询绑定账号内的作品")
		}
	}
	return nil
}

func (s *Server) getAgentRoutineList(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineFeature(); err != nil {
		return err
	}
	id := ident(r.Context())
	rows, err := s.db.Query(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE workspace_id=$1 AND user_id=$2 AND status<>'deleted'
		ORDER BY (status='enabled') DESC,updated_at DESC,id DESC`, id.WorkspaceID, id.UserID)
	if err != nil {
		return err
	}
	defer rows.Close()
	items := []agentRoutineView{}
	for rows.Next() {
		item, err := scanAgentRoutine(rows)
		if err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	models, err := s.agentRoutineServerModels(r.Context())
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"items": items, "server_models": models})
}

func (s *Server) agentRoutineServerModels(ctx context.Context) ([]agentModelOption, error) {
	ws := ident(ctx).WorkspaceID
	rows, err := s.db.Query(ctx, `SELECT p.id,p.name,m.model,coalesce(m.vision_ok,false),
		EXISTS(SELECT 1 FROM model_route r WHERE r.workspace_id=p.workspace_id AND r.task_type='agent_chat'
			AND r.provider_id=p.id AND r.model=m.model)
		FROM model_capability m JOIN model_provider p ON p.id=m.provider_id
		WHERE m.workspace_id=$1 AND p.workspace_id=$1 AND p.execution_location='server' AND p.status='active'
			AND m.config_revision=p.desktop_config_revision AND m.tools_ok
		ORDER BY p.created_at,m.model`, ws)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	models := []agentModelOption{}
	for rows.Next() {
		var model agentModelOption
		if err := rows.Scan(&model.ProviderID, &model.ProviderName, &model.Model, &model.Vision, &model.IsDefault); err != nil {
			return nil, err
		}
		model.ExecutionLocation = "server"
		models = append(models, model)
	}
	return models, rows.Err()
}

func (s *Server) postAgentRoutine(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineCanManage(r.Context()); err != nil {
		return err
	}
	var req agentRoutineMutationRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := agentRoutineRequestID(req.RequestID)
	if err != nil {
		return err
	}
	accountID, model, refs, conversationID, due, timeOfDay, err := s.validateAgentRoutine(r.Context(), &req)
	if err != nil {
		return err
	}
	refsJSON, _ := json.Marshal(refs)
	payload := map[string]any{"request": req, "account_id": accountID, "model": model, "refs": refs,
		"conversation_id": conversationID, "next_due_at": due}
	id := ident(r.Context())
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	var locked uuid.UUID
	if err := tx.QueryRow(r.Context(), `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID).Scan(&locked); err != nil {
		return err
	}
	var total, enabled int
	if err := tx.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE status='enabled') FROM agent_routine
		WHERE workspace_id=$1 AND user_id=$2 AND status<>'deleted'`, id.WorkspaceID, id.UserID).Scan(&total, &enabled); err != nil {
		return err
	}
	if total >= 10 || enabled >= 5 {
		return apiErr(429, "agent_routine_unavailable", "例行任务最多保留10个，其中最多启用5个")
	}
	operation := "routine.create"
	replayID, err := claimAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1 AND status<>'deleted'`, *replayID))
		if err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		return ok(w, map[string]any{"routine": item, "replayed": true})
	}
	var routineID uuid.UUID
	if err := tx.QueryRow(r.Context(), `INSERT INTO agent_routine
		(workspace_id,user_id,account_id,name,prompt,public_context_refs,cadence,weekday,time_of_day,once_at,timezone,
		 destination,conversation_id,model_provider_id,model,status,next_due_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Asia/Shanghai',$11,$12,$13,$14,'enabled',$15) RETURNING id`,
		id.WorkspaceID, id.UserID, accountID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Prompt), refsJSON,
		req.Cadence, req.Weekday, timeOfDay, req.OnceAt, req.Destination, conversationID, model.ProviderID, model.Model, due).Scan(&routineID); err != nil {
		return err
	}
	if err := s.agentRoutineEventTx(r.Context(), tx, routineID, "created", map[string]any{"revision": 1, "status": "enabled"}); err != nil {
		return err
	}
	if err := completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, routineID); err != nil {
		return err
	}
	item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1`, routineID))
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	s.audit(r.Context(), "agent_routine_create", "agent_routine", routineID.String(), "ok", map[string]any{"cadence": req.Cadence, "destination": req.Destination})
	return ok(w, map[string]any{"routine": item, "replayed": false})
}

func (s *Server) getAgentRoutine(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineFeature(); err != nil {
		return err
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || id == uuid.Nil {
		return errNotFound
	}
	item, err := s.agentRoutineByID(r.Context(), id)
	if err != nil {
		return err
	}
	return ok(w, map[string]any{"routine": item})
}

func (s *Server) patchAgentRoutine(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineCanManage(r.Context()); err != nil {
		return err
	}
	routineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || routineID == uuid.Nil {
		return errNotFound
	}
	var req agentRoutineMutationRequest
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ExpectedRevision < 1 {
		return validation("expected_revision 无效")
	}
	requestID, err := agentRoutineRequestID(req.RequestID)
	if err != nil {
		return err
	}
	accountID, model, refs, conversationID, due, timeOfDay, err := s.validateAgentRoutine(r.Context(), &req)
	if err != nil {
		return err
	}
	refsJSON, _ := json.Marshal(refs)
	id := ident(r.Context())
	payload := map[string]any{"routine_id": routineID, "request": req, "account_id": accountID, "model": model,
		"refs": refs, "conversation_id": conversationID, "next_due_at": due}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status<>'deleted' FOR UPDATE`, routineID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	operation := "routine.update:" + routineID.String()
	replayID, err := claimAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		if item.ID != *replayID {
			return apiErr(409, "agent_request_conflict", "该请求编号已用于其他例行任务")
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		return ok(w, map[string]any{"routine": item, "replayed": true})
	}
	if item.Revision != req.ExpectedRevision {
		return apiErr(409, "agent_revision_conflict", "例行任务已变化，请刷新后重试")
	}
	if item.Status != "enabled" && item.Status != "paused" {
		return apiErr(409, "agent_routine_unavailable", "已结束或删除的例行任务不能修改")
	}
	var total, enabled int
	if err := tx.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER(WHERE status='enabled') FROM agent_routine
		WHERE workspace_id=$1 AND user_id=$2 AND status<>'deleted'`, id.WorkspaceID, id.UserID).Scan(&total, &enabled); err != nil {
		return err
	}
	wasEnabled := item.Status == "enabled"
	if !wasEnabled && enabled >= 5 {
		return apiErr(429, "agent_routine_unavailable", "每人每工作区最多启用5个例行任务")
	}
	newStatus := item.Status
	if wasEnabled {
		newStatus = "enabled"
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_routine SET revision=revision+1,name=$2,prompt=$3,public_context_refs=$4,
		account_id=$5,cadence=$6,weekday=$7,time_of_day=$8,once_at=$9,destination=$10,conversation_id=$11,
		model_provider_id=$12,model=$13,next_due_at=$14,status=$15,error_code='',updated_at=now() WHERE id=$1`,
		routineID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Prompt), refsJSON, accountID, req.Cadence, req.Weekday,
		timeOfDay, req.OnceAt, req.Destination, conversationID, model.ProviderID, model.Model, due, newStatus); err != nil {
		return err
	}
	if err := s.agentRoutineEventTx(r.Context(), tx, routineID, "updated", map[string]any{"revision": item.Revision + 1, "status": newStatus}); err != nil {
		return err
	}
	if err := completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, routineID); err != nil {
		return err
	}
	item, err = scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1`, routineID))
	if err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]any{"routine": item, "replayed": false})
}

func (s *Server) deleteAgentRoutine(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineCanManage(r.Context()); err != nil {
		return err
	}
	routineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || routineID == uuid.Nil {
		return errNotFound
	}
	var req struct {
		ExpectedRevision int64  `json:"expected_revision"`
		RequestID        string `json:"request_id"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	requestID, err := agentRoutineRequestID(req.RequestID)
	if err != nil {
		return err
	}
	id := ident(r.Context())
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status<>'deleted' FOR UPDATE`, routineID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if req.ExpectedRevision < 1 || req.ExpectedRevision != item.Revision {
		return apiErr(409, "agent_revision_conflict", "例行任务已变化，请刷新后重试")
	}
	var active bool
	if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_routine_occurrence WHERE routine_id=$1
		AND status IN ('pending','leased','running'))`, routineID).Scan(&active); err != nil {
		return err
	}
	if active {
		return apiErr(409, "agent_routine_unavailable", "例行任务仍在运行，请先暂停并等待停止回执")
	}
	operation := "routine.delete:" + routineID.String()
	payload := map[string]any{"routine_id": routineID, "expected_revision": req.ExpectedRevision}
	replayID, err := claimAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		return ok(w, map[string]any{"ok": true, "replayed": true})
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_routine_occurrence SET status='interrupted',error_code='deleted',finished_at=now()
		WHERE routine_id=$1 AND status='pending'`, routineID); err != nil {
		return err
	}
	if _, err := tx.Exec(r.Context(), `UPDATE agent_routine SET status='deleted',next_due_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, routineID); err != nil {
		return err
	}
	if err := s.agentRoutineEventTx(r.Context(), tx, routineID, "deleted", map[string]any{"revision": item.Revision + 1}); err != nil {
		return err
	}
	if err := completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, routineID); err != nil {
		return err
	}
	if err := tx.Commit(r.Context()); err != nil {
		return err
	}
	return ok(w, map[string]any{"ok": true, "replayed": false})
}

func (s *Server) postAgentRoutineControl(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineCanManage(r.Context()); err != nil {
		return err
	}
	routineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || routineID == uuid.Nil {
		return errNotFound
	}
	var req struct {
		ExpectedRevision int64  `json:"expected_revision"`
		RequestID        string `json:"request_id"`
		Action           string `json:"action"`
	}
	if err := agentDecodeBody(r, &req); err != nil {
		return err
	}
	if req.ExpectedRevision < 1 || (req.Action != "pause" && req.Action != "enable" && req.Action != "run_once") {
		return validation("expected_revision 或 action 无效")
	}
	requestID, err := agentRoutineRequestID(req.RequestID)
	if err != nil {
		return err
	}
	id := ident(r.Context())
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT id FROM app_user WHERE id=$1 FOR NO KEY UPDATE`, id.UserID); err != nil {
		return err
	}
	routine, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status<>'deleted' FOR UPDATE`, routineID, id.WorkspaceID, id.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	operation := "routine.control:" + routineID.String()
	payload := map[string]any{"routine_id": routineID, "revision": req.ExpectedRevision, "action": req.Action}
	replayID, err := claimAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, payload)
	if err != nil {
		return err
	}
	if replayID != nil {
		item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1`, routineID))
		if err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		if req.Action == "run_once" {
			var occurrenceID uuid.UUID
			if err := s.db.QueryRow(r.Context(), `SELECT id FROM agent_routine_occurrence WHERE id=$1 AND routine_id=$2`, *replayID, routineID).Scan(&occurrenceID); err != nil {
				return agentRoutineUnavailable("原立即运行记录已不可用，请刷新执行记录后再操作")
			}
			return ok(w, map[string]any{"routine": item, "occurrence_id": occurrenceID, "status": "accepted", "replayed": true})
		}
		return ok(w, map[string]any{"routine": item, "replayed": true})
	}
	if routine.Revision != req.ExpectedRevision {
		return apiErr(409, "agent_revision_conflict", "例行任务已变化，请刷新后重试")
	}
	var occurrenceID *uuid.UUID
	var conversationID *uuid.UUID
	var occurrenceStatus string
	switch req.Action {
	case "pause":
		if routine.Status != "enabled" && routine.Status != "paused" {
			return agentRoutineUnavailable("已结束的例行任务不能暂停")
		}
		var activeRun, activeOccurrence *uuid.UUID
		err = tx.QueryRow(r.Context(), `SELECT o.run_id,o.id,run.conversation_id FROM agent_routine_occurrence o
			LEFT JOIN agent_run run ON run.id=o.run_id
			WHERE o.routine_id=$1 AND o.status IN ('leased','running') FOR UPDATE OF o`, routineID).Scan(&activeRun, &activeOccurrence, &conversationID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if activeRun != nil {
			if _, err := tx.Exec(r.Context(), `UPDATE agent_run SET stage='stopping' WHERE id=$1 AND status IN ('queued','running')`, *activeRun); err != nil {
				return err
			}
			if conversationID != nil {
				if _, err := appendAgentEventTx(r.Context(), tx, *conversationID, activeRun, "run.stage", map[string]any{"stage": "stopping"}, nil); err != nil {
					return err
				}
			}
			// 进程内会尽快中断模型流；若运行位于另一执行器，持久化的 stopping 阶段会在下个循环边界生效。
			s.agentCancelRun(*activeRun)
			occurrenceID, occurrenceStatus = activeOccurrence, "stopping"
		} else if activeOccurrence != nil {
			if _, err := tx.Exec(r.Context(), `UPDATE agent_routine_occurrence SET status='interrupted',lease_token=NULL,
				lease_until=NULL,error_code='paused',finished_at=now() WHERE id=$1 AND status='leased'`, *activeOccurrence); err != nil {
				return err
			}
			occurrenceID, occurrenceStatus = activeOccurrence, "interrupted"
		}
		if _, err := tx.Exec(r.Context(), `UPDATE agent_routine SET status='paused',next_due_at=NULL,revision=revision+1,
			error_code='',updated_at=now() WHERE id=$1`, routineID); err != nil {
			return err
		}
	case "enable":
		if routine.Status != "paused" {
			return agentRoutineUnavailable("只有暂停中的例行任务可以重新启用")
		}
		if _, err := s.agentRoutineCurrentIdentity(r.Context(), routineID, true); err != nil {
			return err
		}
		var enabled int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM agent_routine WHERE workspace_id=$1 AND user_id=$2 AND status='enabled'`,
			id.WorkspaceID, id.UserID).Scan(&enabled); err != nil {
			return err
		}
		if enabled >= 5 {
			return apiErr(429, "agent_routine_unavailable", "每人每工作区最多启用5个例行任务")
		}
		loc, _ := time.LoadLocation("Asia/Shanghai")
		due, err := nextAgentRoutineDue(routine.Cadence, routine.Weekday, routine.TimeOfDay, routine.OnceAt, s.now(), loc)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `UPDATE agent_routine SET status='enabled',next_due_at=$2,failure_count=0,error_code='',
			revision=revision+1,updated_at=now() WHERE id=$1`, routineID, due); err != nil {
			return err
		}
	case "run_once":
		if routine.Status != "enabled" {
			return agentRoutineUnavailable("请先启用例行任务，再立即运行")
		}
		identity, err := s.agentRoutineCurrentIdentity(r.Context(), routineID, false)
		if err != nil {
			return err
		}
		var active bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM agent_routine_occurrence WHERE routine_id=$1
			AND status IN ('pending','leased','running'))`, routineID).Scan(&active); err != nil {
			return err
		}
		if active {
			return apiErr(409, "agent_run_busy", "该例行任务已有待处理或正在运行的执行")
		}
		token, occurrence := uuid.New(), uuid.New()
		if err := tx.QueryRow(r.Context(), `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,lease_token,lease_until)
			VALUES($1,clock_timestamp(),$2,'manual','leased',$3,now()+interval '1 minute') RETURNING id`,
			routineID, requestID, token).Scan(&occurrence); err != nil {
			return err
		}
		if err := s.agentRoutineEventTx(r.Context(), tx, routineID, "run_once", map[string]any{"occurrence_id": occurrence}); err != nil {
			return err
		}
		if err := completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, occurrence); err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		if err := s.agentStartRoutineOccurrence(r.Context(), identity, routineID, occurrence, token); err != nil {
			slog.WarnContext(r.Context(), "立即启动例行任务失败", "routine_id", routineID.String(), "err", err)
		}
		item, err := s.agentRoutineByID(r.Context(), routineID)
		if err != nil {
			return err
		}
		return ok(w, map[string]any{"routine": item, "occurrence_id": occurrence, "status": "accepted", "replayed": false})
	}
	if req.Action != "run_once" {
		if err := s.agentRoutineEventTx(r.Context(), tx, routineID, req.Action, map[string]any{
			"revision": routine.Revision + 1, "occurrence_id": occurrenceID, "occurrence_status": occurrenceStatus,
		}); err != nil {
			return err
		}
		if err := completeAgentRequest(r.Context(), tx, id.WorkspaceID, id.UserID, operation, requestID, routineID); err != nil {
			return err
		}
		item, err := scanAgentRoutine(tx.QueryRow(r.Context(), `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1`, routineID))
		if err != nil {
			return err
		}
		if err := tx.Commit(r.Context()); err != nil {
			return err
		}
		if req.Action == "pause" {
			s.notify(r.Context(), id.WorkspaceID, id.UserID, "agent_routine", "例行任务已暂停", "已停止后续调度；在途读取将按原超时结束", "/agent?panel=task&item="+routineID.String(), "agent_routine:paused:"+routineID.String()+":"+strconv.FormatInt(item.Revision, 10))
		}
		return ok(w, map[string]any{"routine": item, "replayed": false})
	}
	return nil
}

func (s *Server) agentRoutineCurrentIdentity(ctx context.Context, routineID uuid.UUID, allowPaused bool) (*identity, error) {
	var id identity
	var disabledAt *time.Time
	var accountStatus, providerStatus, executionLocation, routineStatus string
	var modelReady bool
	err := s.db.QueryRow(ctx, `SELECT r.user_id,r.workspace_id,u.username,u.disabled_at,coalesce(wm.role,''),a.status,
		p.status,p.execution_location,r.status,EXISTS(SELECT 1 FROM model_capability mc
			WHERE mc.workspace_id=r.workspace_id AND mc.provider_id=p.id AND mc.model=r.model
			AND mc.config_revision=p.desktop_config_revision AND mc.tools_ok)
		FROM agent_routine r JOIN app_user u ON u.id=r.user_id
		LEFT JOIN workspace_member wm ON wm.workspace_id=r.workspace_id AND wm.user_id=r.user_id AND wm.status='active'
		JOIN platform_account a ON a.id=r.account_id AND a.workspace_id=r.workspace_id
		JOIN model_provider p ON p.id=r.model_provider_id AND p.workspace_id=r.workspace_id
		WHERE r.id=$1`, routineID).Scan(&id.UserID, &id.WorkspaceID, &id.Username, &disabledAt, &id.Role,
		&accountStatus, &providerStatus, &executionLocation, &routineStatus, &modelReady)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if disabledAt != nil || (id.Role != "owner" && id.Role != "editor") {
		return nil, agentRoutineUnavailable("创建者当前不再具备例行任务权限")
	}
	if accountStatus != "active" {
		return nil, agentRoutineUnavailable("绑定账号已停用")
	}
	if providerStatus != "active" || executionLocation != "server" || !modelReady {
		return nil, agentRoutineUnavailable("服务器模型不可用或未通过工具能力自检")
	}
	if routineStatus != "enabled" && !(allowPaused && routineStatus == "paused") {
		return nil, agentRoutineUnavailable("例行任务当前未启用")
	}
	if !agentWorkbenchFeatures()["routines"] {
		return nil, apiErr(409, "agent_feature_unavailable", "例行任务功能当前未启用")
	}
	settings, err := s.agentSettingsOf(ctx, id.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if !settings.Enabled {
		return nil, agentRoutineUnavailable("工作区已关闭智能体")
	}
	id.ReauthOK = false
	return &id, nil
}

func (s *Server) agentRoutineCreateConversationTx(ctx context.Context, tx pgx.Tx, routine agentRoutineView) (*agentConversation, error) {
	id := ident(ctx)
	if id == nil {
		return nil, errUnauthenticated
	}
	if routine.Destination == "current" {
		if routine.ConversationID == nil {
			return nil, agentRoutineUnavailable("绑定对话已删除")
		}
		conv, err := scanAgentConversation(tx.QueryRow(ctx, `SELECT `+agentConversationCols+` FROM agent_conversation c
			WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3 FOR UPDATE`, *routine.ConversationID,
			id.WorkspaceID, id.UserID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNotFound
		}
		return conv, err
	}
	conv, err := scanAgentConversation(tx.QueryRow(ctx, `INSERT INTO agent_conversation
		(workspace_id,user_id,title,title_source,account_id,model_provider_id,model,mode)
		VALUES($1,$2,$3,'auto',$4,$5,$6,'discuss')
		RETURNING id,title,title_source,pinned_at,model_provider_id,model,account_id,last_message_at,created_at,updated_at,
		revision,archived_at,group_id,read_upto_message_seq,force_unread,mode,reasoning_effort,parent_id,fork_upto_seq`,
		id.WorkspaceID, id.UserID, truncate("例行任务："+routine.Name, 60), routine.AccountID,
		routine.Model.ProviderID, routine.Model.Model))
	if err != nil {
		return nil, err
	}
	seq, err := appendAgentEventTx(ctx, tx, conv.ID, nil, "conversation.updated", map[string]any{"snapshot_baseline": true}, nil)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_conversation SET read_upto_event_seq=$2 WHERE id=$1`, conv.ID, seq); err != nil {
		return nil, err
	}
	return conv, nil
}

func (s *Server) agentStartRoutineOccurrence(ctx context.Context, owner *identity, routineID, occurrenceID, leaseToken uuid.UUID) error {
	if owner == nil || owner.UserID == uuid.Nil || owner.WorkspaceID == uuid.Nil || leaseToken == uuid.Nil {
		return errUnauthenticated
	}
	ctx = context.WithValue(ctx, ctxMember, owner)
	ctx = withAgentRoutineExecution(ctx, routineID, occurrenceID, leaseToken)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	routine, err := scanAgentRoutine(tx.QueryRow(ctx, `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND status='enabled' FOR UPDATE`, routineID, owner.WorkspaceID, owner.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var occurrenceStatus string
	var leaseUntil time.Time
	if err := tx.QueryRow(ctx, `SELECT status,lease_until FROM agent_routine_occurrence
		WHERE id=$1 AND routine_id=$2 FOR UPDATE`, occurrenceID, routineID).Scan(&occurrenceStatus, &leaseUntil); err != nil {
		return err
	}
	if occurrenceStatus != "leased" || !leaseUntil.After(s.now()) {
		return agentRoutineUnavailable("例行任务租约已失效")
	}
	if _, err := s.agentRoutineCurrentIdentity(ctx, routineID, false); err != nil {
		return err
	}
	refs, err := s.agentValidateContextReferences(ctx, routine.PublicContextRefs, &routine.AccountID)
	if err != nil {
		return err
	}
	conv, err := s.agentRoutineCreateConversationTx(ctx, tx, routine)
	if err != nil {
		return err
	}
	if err := agentCheckConversationWritable(conv); err != nil {
		return err
	}
	if err := agentCheckRunLimitsWith(ctx, tx, conv.ID, owner.UserID); err != nil {
		return err
	}
	message, _, err := s.agentInsertUserMessageWithContextTx(ctx, tx, conv.ID, routine.Prompt, nil, refs, nil, uuid.Nil, nil)
	if err != nil {
		return err
	}
	st, err := s.agentStartRunTx(ctx, tx, "routine", conv, routine.Model, uuid.Nil, nil, &message.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.startAgentRunBackground(ctx, st)
}

func (s *Server) releaseAgentRoutineLease(ctx context.Context, routineID, occurrenceID, leaseToken uuid.UUID, err error) {
	var ae *APIError
	transient := errors.As(err, &ae) && (ae.Code == "agent_run_busy" || ae.Code == "agent_limit_reached")
	status, code := "failed", "start_failed"
	if transient {
		status, code = "pending", ""
	}
	_, dbErr := s.db.Exec(context.WithoutCancel(ctx), `UPDATE agent_routine_occurrence SET status=$4,lease_token=NULL,lease_until=NULL,
		error_code=$5,finished_at=CASE WHEN $4='pending' THEN NULL ELSE now() END
		WHERE id=$1 AND routine_id=$2 AND lease_token=$3 AND status='leased'`,
		routineID, occurrenceID, leaseToken, status, code)
	if dbErr != nil {
		slog.ErrorContext(ctx, "释放例行任务租约失败", "occurrence_id", occurrenceID.String(), "err", dbErr)
	}
}

func (s *Server) pauseAgentRoutineForRevocation(ctx context.Context, st *agentRunState) {
	if st.RoutineID == nil || st.RoutineOccurrenceID == nil {
		return
	}
	tx, err := s.db.Begin(context.WithoutCancel(ctx))
	if err != nil {
		return
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	_, err = tx.Exec(context.WithoutCancel(ctx), `UPDATE agent_routine SET status='paused',next_due_at=NULL,
		revision=revision+1,error_code='authorization_revoked',updated_at=now() WHERE id=$1 AND status='enabled'`, *st.RoutineID)
	if err != nil {
		return
	}
	if err := s.agentRoutineEventTx(context.WithoutCancel(ctx), tx, *st.RoutineID, "paused", map[string]any{
		"reason": "authorization_revoked", "occurrence_id": *st.RoutineOccurrenceID,
	}); err != nil {
		return
	}
	if _, err := tx.Exec(context.WithoutCancel(ctx), `UPDATE agent_run SET stage='stopping' WHERE id=$1 AND status IN ('queued','running')`, st.RunID); err != nil {
		return
	}
	if _, err := appendAgentEventTx(context.WithoutCancel(ctx), tx, st.ConversationID, &st.RunID, "run.stage", map[string]any{"stage": "stopping"}, nil); err != nil {
		return
	}
	if err := tx.Commit(context.WithoutCancel(ctx)); err != nil {
		return
	}
	s.agentCancelRun(st.RunID)
	s.notify(context.WithoutCancel(ctx), st.WorkspaceID, st.UserID, "agent_routine", "例行任务已暂停",
		"当前权限已变化；本次在途读取将完成并保存结果，后续工具调用已停止",
		"/agent?panel=task&item="+st.RoutineID.String(), "agent_routine:authorization_revoked:"+st.RoutineID.String()+":"+st.RoutineOccurrenceID.String())
}

func (s *Server) runAgentRoutines(ctx context.Context) {
	if !agentWorkbenchFeatures()["routines"] {
		return
	}
	s.recoverAgentRoutineLeases(ctx)
	rows, err := s.db.Query(ctx, `SELECT id FROM agent_routine WHERE status='enabled' AND next_due_at<=now()
		ORDER BY next_due_at,id LIMIT 50`)
	if err != nil {
		slog.ErrorContext(ctx, "读取到期例行任务失败", "err", err)
		return
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			slog.ErrorContext(ctx, "读取到期例行任务编号失败", "err", err)
			return
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		slog.ErrorContext(ctx, "读取到期例行任务失败", "err", err)
		return
	}
	rows.Close()
	for _, id := range ids {
		s.claimAgentRoutineDue(ctx, id)
	}
	s.claimPendingAgentRoutineOccurrences(ctx)
}

func (s *Server) claimAgentRoutineDue(ctx context.Context, routineID uuid.UUID) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	routine, err := scanAgentRoutine(tx.QueryRow(ctx, `SELECT `+agentRoutineSelect+` FROM agent_routine
		WHERE id=$1 AND status='enabled' AND next_due_at<=now() FOR UPDATE SKIP LOCKED`, routineID))
	if errors.Is(err, pgx.ErrNoRows) {
		return
	}
	if err != nil {
		slog.ErrorContext(ctx, "锁定到期例行任务失败", "routine_id", routineID.String(), "err", err)
		return
	}
	owner, authErr := s.agentRoutineCurrentIdentity(ctx, routineID, false)
	if authErr != nil {
		s.pauseAgentRoutineTx(ctx, tx, routineID, routine.Revision, authErr)
		if err := tx.Commit(ctx); err != nil {
			slog.ErrorContext(ctx, "暂停失效例行任务失败", "routine_id", routineID.String(), "err", err)
			return
		}
		s.notify(ctx, routineWorkspaceFrom(routine, ctx), routineUserFrom(routine, ctx), "agent_routine", "例行任务已暂停", authErr.Error(), "/agent?panel=task&item="+routineID.String(), "agent_routine:blocked:"+routineID.String()+":"+strconv.FormatInt(routine.Revision+1, 10))
		return
	}
	due := *routine.NextDueAt
	if due.Add(30 * time.Minute).Before(s.now()) {
		requestID := uuid.New()
		_, err := tx.Exec(ctx, `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,error_code,finished_at)
			VALUES($1,$2,$3,'scheduled','missed','missed_window',now()) ON CONFLICT(routine_id,due_at) DO NOTHING`, routineID, due, requestID)
		if err != nil {
			slog.ErrorContext(ctx, "记录错过的例行任务失败", "routine_id", routineID.String(), "err", err)
			return
		}
		s.advanceAgentRoutineTx(ctx, tx, routine)
		_ = s.agentRoutineEventTx(ctx, tx, routineID, "missed", map[string]any{"due_at": due, "reason": "missed_window"})
		if err := tx.Commit(ctx); err != nil {
			return
		}
		s.notify(ctx, routineWorkspaceFrom(routine, ctx), routineUserFrom(routine, ctx), "agent_routine", "例行任务错过计划时间", "服务器或对话繁忙，已超过30分钟窗口；不会补跑历史任务", "/agent?panel=task&item="+routineID.String(), "agent_routine:missed:"+routineID.String()+":"+due.UTC().Format(time.RFC3339Nano))
		return
	}
	token, occurrenceID := uuid.New(), uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO agent_routine_occurrence(id,routine_id,due_at,request_id,kind,status,lease_token,lease_until)
		VALUES($1,$2,$3,$4,'scheduled','leased',$5,now()+interval '1 minute')`, occurrenceID, routineID, due, uuid.New(), token)
	if err != nil {
		if !isUniqueViolation(err) {
			slog.ErrorContext(ctx, "租赁到期例行任务失败", "routine_id", routineID.String(), "err", err)
		}
		return
	}
	s.advanceAgentRoutineTx(ctx, tx, routine)
	if err := s.agentRoutineEventTx(ctx, tx, routineID, "occurrence.leased", map[string]any{"occurrence_id": occurrenceID, "due_at": due}); err != nil {
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if err := s.agentStartRoutineOccurrence(ctx, owner, routineID, occurrenceID, token); err != nil {
		s.releaseAgentRoutineLease(ctx, routineID, occurrenceID, token, err)
	}
}

func (s *Server) advanceAgentRoutineTx(ctx context.Context, tx pgx.Tx, routine agentRoutineView) {
	var next *time.Time
	if routine.Cadence != "once" {
		loc, _ := time.LoadLocation("Asia/Shanghai")
		next, _ = nextAgentRoutineDue(routine.Cadence, routine.Weekday, routine.TimeOfDay, nil, *routine.NextDueAt, loc)
	}
	_, _ = tx.Exec(ctx, `UPDATE agent_routine SET next_due_at=$2,updated_at=now() WHERE id=$1`, routine.ID, next)
}

func (s *Server) pauseAgentRoutineTx(ctx context.Context, tx pgx.Tx, routineID uuid.UUID, revision int64, cause error) {
	code := "authorization_revoked"
	var ae *APIError
	if errors.As(cause, &ae) {
		code = ae.Code
	}
	_, _ = tx.Exec(ctx, `UPDATE agent_routine SET status='paused',next_due_at=NULL,revision=revision+1,error_code=$2,updated_at=now()
		WHERE id=$1 AND revision=$3 AND status='enabled'`, routineID, truncate(code, 80), revision)
	_ = s.agentRoutineEventTx(ctx, tx, routineID, "paused", map[string]any{"reason": code})
}

func (s *Server) claimPendingAgentRoutineOccurrences(ctx context.Context) {
	rows, err := s.db.Query(ctx, `SELECT id FROM agent_routine_occurrence
		WHERE status='pending' AND due_at<=now() AND due_at>now()-interval '30 minutes'
		ORDER BY due_at,id LIMIT 50`)
	if err != nil {
		return
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		s.claimPendingAgentRoutineOccurrence(ctx, id)
	}
}

func (s *Server) claimPendingAgentRoutineOccurrence(ctx context.Context, occurrenceID uuid.UUID) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	var routineID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT routine_id FROM agent_routine_occurrence WHERE id=$1 AND status='pending' FOR UPDATE SKIP LOCKED`, occurrenceID).Scan(&routineID); err != nil {
		return
	}
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM agent_routine WHERE id=$1 FOR UPDATE`, routineID).Scan(&status); err != nil || status != "enabled" {
		return
	}
	owner, err := s.agentRoutineCurrentIdentity(ctx, routineID, false)
	if err != nil {
		_, _ = tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status='interrupted',error_code='authorization_revoked',finished_at=now()
			WHERE id=$1 AND status='pending'`, occurrenceID)
		var revision int64
		_ = tx.QueryRow(ctx, `SELECT revision FROM agent_routine WHERE id=$1`, routineID).Scan(&revision)
		s.pauseAgentRoutineTx(ctx, tx, routineID, revision, err)
		_ = tx.Commit(ctx)
		return
	}
	token := uuid.New()
	if _, err := tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status='leased',lease_token=$2,lease_until=now()+interval '1 minute'
		WHERE id=$1 AND status='pending'`, occurrenceID, token); err != nil {
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	if err := s.agentStartRoutineOccurrence(ctx, owner, routineID, occurrenceID, token); err != nil {
		s.releaseAgentRoutineLease(ctx, routineID, occurrenceID, token, err)
	}
}

func (s *Server) recoverAgentRoutineLeases(ctx context.Context) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "开始恢复例行任务租约失败", "err", err)
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status='pending',lease_token=NULL,lease_until=NULL
		WHERE status='leased' AND lease_until<=now() AND due_at>now()-interval '30 minutes'`); err != nil {
		slog.ErrorContext(ctx, "恢复例行任务租约失败", "err", err)
		return
	}
	notices := []agentRoutineNotice{}
	missed, err := tx.Query(ctx, `SELECT o.id,o.routine_id,o.due_at,r.workspace_id,r.user_id
		FROM agent_routine_occurrence o JOIN agent_routine r ON r.id=o.routine_id
		WHERE o.status='leased' AND o.lease_until<=now() AND o.due_at<=now()-interval '30 minutes'
		FOR UPDATE OF o SKIP LOCKED`)
	if err != nil {
		return
	}
	type missedItem struct {
		id, routineID, workspaceID, userID uuid.UUID
		due                                time.Time
	}
	missedItems := []missedItem{}
	for missed.Next() {
		var item missedItem
		if err := missed.Scan(&item.id, &item.routineID, &item.due, &item.workspaceID, &item.userID); err != nil {
			missed.Close()
			return
		}
		missedItems = append(missedItems, item)
	}
	missed.Close()
	for _, item := range missedItems {
		if _, err := tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status='missed',lease_token=NULL,lease_until=NULL,
			error_code='missed_window',finished_at=now() WHERE id=$1`, item.id); err != nil {
			return
		}
		if err := s.agentRoutineEventTx(ctx, tx, item.routineID, "missed", map[string]any{"occurrence_id": item.id, "reason": "missed_window"}); err != nil {
			return
		}
		notices = append(notices, agentRoutineNotice{WorkspaceID: item.workspaceID, UserID: item.userID,
			Title: "例行任务错过计划时间", Body: "租约未能在30分钟窗口内恢复；不会补跑历史任务",
			Key: "agent_routine:missed:" + item.id.String()})
	}
	stale, err := tx.Query(ctx, `SELECT o.id,o.routine_id,o.run_id,run.conversation_id,r.workspace_id,r.user_id
		FROM agent_routine_occurrence o JOIN agent_routine r ON r.id=o.routine_id
		JOIN agent_run run ON run.id=o.run_id
		WHERE o.status='running' AND (o.lease_until<=now() OR run.status NOT IN ('queued','running'))
		FOR UPDATE OF o SKIP LOCKED`)
	if err != nil {
		return
	}
	type staleItem struct{ id, routineID, runID, conversationID, workspaceID, userID uuid.UUID }
	staleItems := []staleItem{}
	for stale.Next() {
		var item staleItem
		if err := stale.Scan(&item.id, &item.routineID, &item.runID, &item.conversationID, &item.workspaceID, &item.userID); err != nil {
			stale.Close()
			return
		}
		staleItems = append(staleItems, item)
	}
	stale.Close()
	for _, item := range staleItems {
		if _, err := tx.Exec(ctx, `UPDATE agent_run SET status='failed',stage='failed',error_code='interrupted',
			error_message='例行任务租约失效，本次结果未知，不会自动重跑',finished_at=now()
			WHERE id=$1 AND status IN ('queued','running')`, item.runID); err != nil {
			return
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status='interrupted',error_code='interrupted',
			finished_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running'`, item.id); err != nil {
			return
		}
		if _, err := appendAgentEventTx(ctx, tx, item.conversationID, &item.runID, "run.ended", map[string]any{
			"status": "failed", "reason": "interrupted", "error_code": "interrupted",
		}, nil); err != nil {
			return
		}
		if err := s.agentRoutineEventTx(ctx, tx, item.routineID, "interrupted", map[string]any{"occurrence_id": item.id, "run_id": item.runID,
			"reason": "lease_expired", "result_unknown": true}); err != nil {
			return
		}
		notices = append(notices, agentRoutineNotice{WorkspaceID: item.workspaceID, UserID: item.userID,
			Title: "例行任务中断", Body: "租约失效后已标记本次结果未知；不会自动重跑",
			Key: "agent_routine:interrupted:" + item.id.String()})
	}
	if err := tx.Commit(ctx); err != nil {
		slog.ErrorContext(ctx, "提交例行任务恢复结果失败", "err", err)
		return
	}
	for _, notice := range notices {
		s.notify(ctx, notice.WorkspaceID, notice.UserID, "agent_routine", notice.Title, notice.Body,
			"/agent?panel=task", notice.Key)
	}
}

type agentRoutineNotice struct {
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	Title       string
	Body        string
	Key         string
}

func (s *Server) finishAgentRoutineTx(ctx context.Context, tx pgx.Tx, st *agentRunState, runStatus, reason string) (*agentRoutineNotice, error) {
	if st.RoutineID == nil || st.RoutineOccurrenceID == nil {
		return nil, nil
	}
	routine, err := scanAgentRoutine(tx.QueryRow(ctx, `SELECT `+agentRoutineSelect+` FROM agent_routine WHERE id=$1 FOR UPDATE`, *st.RoutineID))
	if err != nil {
		return nil, err
	}
	authorizationRevoked := reason == "routine_authorization_revoked"
	occurrenceStatus, errorCode := "completed", ""
	if authorizationRevoked {
		occurrenceStatus, errorCode = "interrupted", "authorization_revoked"
	} else if runStatus == "failed" {
		occurrenceStatus, errorCode = "failed", st.ErrCode
		if errorCode == "" {
			errorCode = "run_failed"
		}
	} else if runStatus == "stopped" || runStatus == "interrupted" {
		occurrenceStatus, errorCode = "interrupted", "stopped"
	} else if runStatus != "completed" {
		occurrenceStatus, errorCode = "failed", "unexpected_run_status"
	}
	result, err := tx.Exec(ctx, `UPDATE agent_routine_occurrence SET status=$3,error_code=$4,finished_at=now(),lease_until=NULL,lease_token=NULL
		WHERE id=$1 AND routine_id=$2 AND run_id=$5 AND status='running'`,
		*st.RoutineOccurrenceID, *st.RoutineID, occurrenceStatus, truncate(errorCode, 80), st.RunID)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, agentRoutineUnavailable("例行任务执行记录状态已变化")
	}
	newFailureCount := routine.FailureCount
	newRoutineStatus := routine.Status
	newErrorCode := errorCode
	if authorizationRevoked {
		newRoutineStatus = "paused"
		newFailureCount = routine.FailureCount
		newErrorCode = "authorization_revoked"
	} else if occurrenceStatus == "failed" {
		newFailureCount++
		if newFailureCount >= 3 {
			newRoutineStatus = "paused"
			newErrorCode = "three_consecutive_failures"
		}
	} else if occurrenceStatus == "completed" {
		newFailureCount = 0
		newErrorCode = ""
		if routine.Cadence == "once" && routine.Status == "enabled" {
			newRoutineStatus = "completed"
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_routine SET status=$2,failure_count=$3,error_code=$4,last_run_at=now(),
		next_due_at=CASE WHEN $2='completed' OR $2='paused' THEN NULL ELSE next_due_at END,updated_at=now() WHERE id=$1`,
		*st.RoutineID, newRoutineStatus, newFailureCount, truncate(newErrorCode, 80)); err != nil {
		return nil, err
	}
	if err := s.agentRoutineEventTx(ctx, tx, *st.RoutineID, occurrenceStatus, map[string]any{
		"occurrence_id": *st.RoutineOccurrenceID, "run_id": st.RunID, "reason": reason, "error_code": errorCode,
		"routine_status": newRoutineStatus, "failure_count": newFailureCount,
	}); err != nil {
		return nil, err
	}
	reportSaved := true
	if occurrenceStatus == "completed" {
		if err := s.agentEnsureRoutineReportTx(ctx, tx, st, routine.Name); err != nil {
			reportSaved = false
			slog.WarnContext(ctx, "保存例行任务报告产物失败", "routine_id", routine.ID.String(), "run_id", st.RunID.String(), "err", err)
		}
	}
	title, body := "例行任务已完成", "已生成本次只读报告"
	if occurrenceStatus == "completed" && !reportSaved {
		body = "本次查询已完成，但报告保存失败；请打开执行对话查看结果"
	} else if authorizationRevoked {
		title, body = "例行任务已暂停", "创建者、工作区设置、账号或服务器模型权限已变化；重新授权后需手动启用"
	} else if occurrenceStatus == "failed" {
		title, body = "例行任务执行失败", "本次执行未完成；连续失败三次后任务会自动暂停"
		if newRoutineStatus == "paused" {
			body = "任务已连续失败三次并暂停，请检查模型、账号和公开资料后重新启用"
		}
	} else if occurrenceStatus == "interrupted" {
		title, body = "例行任务已停止", "在途读取已结束；未知结果不会自动重跑"
	}
	return &agentRoutineNotice{WorkspaceID: routine.WorkspaceID, UserID: routine.UserID,
		Title: title, Body: body, Key: "agent_routine:occurrence:" + st.RoutineOccurrenceID.String() + ":" + occurrenceStatus}, nil
}

func (s *Server) agentEnsureRoutineReportTx(ctx context.Context, tx pgx.Tx, st *agentRunState, name string) error {
	var existing int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_artifact_version WHERE source_run_id=$1`, st.RunID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var contentText string
	err := tx.QueryRow(ctx, `SELECT content FROM agent_message WHERE conversation_id=$1 AND run_id=$2 AND role='assistant'
		ORDER BY seq DESC LIMIT 1`, st.ConversationID, st.RunID).Scan(&contentText)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	contentText = strings.TrimSpace(contentText)
	if contentText == "" {
		return nil
	}
	if agentContainsSecret(contentText, s.agentSecretValues(ctx, st.WorkspaceID)) {
		return validation("例行任务报告疑似包含密钥或密码")
	}
	content, err := json.Marshal(map[string]any{"format": "text", "text": contentText})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(content)
	if _, err := tx.Exec(ctx, "SAVEPOINT routine_report"); err != nil {
		return err
	}
	artifactID, err := s.agentInsertArtifactTx(ctx, tx, st.ConversationID, "markdown", truncate("例行报告："+name, 200),
		"chat", content, hex.EncodeToString(hash[:]), &st.RunID, nil, nil)
	if err != nil {
		_, _ = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT routine_report")
		_, _ = tx.Exec(ctx, "RELEASE SAVEPOINT routine_report")
		return err
	}
	if _, err := tx.Exec(ctx, "RELEASE SAVEPOINT routine_report"); err != nil {
		return err
	}
	_, err = appendAgentEventTx(ctx, tx, st.ConversationID, &st.RunID, "artifact.created", map[string]any{
		"artifact_id": artifactID, "source_kind": "chat", "routine": true,
	}, nil)
	if err != nil {
		return err
	}
	return nil
}

func routineWorkspaceFrom(r agentRoutineView, _ context.Context) uuid.UUID { return r.WorkspaceID }
func routineUserFrom(r agentRoutineView, _ context.Context) uuid.UUID      { return r.UserID }

func (s *Server) agentRoutineEventTx(ctx context.Context, tx pgx.Tx, routineID uuid.UUID, event string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_routine_event(routine_id,type,payload) VALUES($1,$2,$3)`, routineID, event, payload)
	return err
}

func agentRoutineOccurrenceCursor(raw string) (*time.Time, *uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, nil, validation("例行任务游标无效")
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return nil, nil, validation("例行任务游标无效")
	}
	t, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, validation("例行任务游标无效")
	}
	id, err := uuid.Parse(parts[1])
	if err != nil || id == uuid.Nil {
		return nil, nil, validation("例行任务游标无效")
	}
	return &t, &id, nil
}

func (s *Server) getAgentRoutineOccurrences(w http.ResponseWriter, r *http.Request) error {
	if err := agentRoutineFeature(); err != nil {
		return err
	}
	routineID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil || routineID == uuid.Nil {
		return errNotFound
	}
	if _, err := s.agentRoutineByID(r.Context(), routineID); err != nil {
		return err
	}
	limit := queryInt(r, "limit", 30)
	if limit < 1 || limit > 30 {
		return validation("每页最多返回30条")
	}
	before, beforeID, err := agentRoutineOccurrenceCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT id,due_at,request_id,kind,status,run_id,error_code,started_at,finished_at
		FROM agent_routine_occurrence WHERE routine_id=$1 AND ($2::timestamptz IS NULL OR (due_at,id)<($2,$3))
		ORDER BY due_at DESC,id DESC LIMIT $4`, routineID, before, beforeID, limit+1)
	if err != nil {
		return err
	}
	defer rows.Close()
	type occurrence struct {
		ID         uuid.UUID  `json:"id"`
		DueAt      time.Time  `json:"due_at"`
		RequestID  uuid.UUID  `json:"request_id"`
		Kind       string     `json:"kind"`
		Status     string     `json:"status"`
		RunID      *uuid.UUID `json:"run_id,omitempty"`
		ErrorCode  string     `json:"error_code,omitempty"`
		StartedAt  *time.Time `json:"started_at,omitempty"`
		FinishedAt *time.Time `json:"finished_at,omitempty"`
	}
	items := []occurrence{}
	for rows.Next() {
		var item occurrence
		if err := rows.Scan(&item.ID, &item.DueAt, &item.RequestID, &item.Kind, &item.Status, &item.RunID, &item.ErrorCode,
			&item.StartedAt, &item.FinishedAt); err != nil {
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
		token := base64.RawURLEncoding.EncodeToString([]byte(last.DueAt.Format(time.RFC3339Nano) + "|" + last.ID.String()))
		next = &token
	}
	return ok(w, map[string]any{"items": items, "next_cursor": next})
}

func (s *Server) loadAgentRoutinePrincipal(ctx context.Context, p *agentPrincipal) (*identity, error) {
	var id identity
	var disabledAt *time.Time
	var accountActive, modelReady bool
	var providerStatus, executionLocation string
	var routineStatus string
	err := s.db.QueryRow(ctx, `SELECT r.user_id,r.workspace_id,u.username,u.disabled_at,wm.role,
		(a.status='active'),r.status,p.status,p.execution_location,EXISTS(SELECT 1 FROM model_capability mc
			WHERE mc.workspace_id=r.workspace_id AND mc.provider_id=p.id AND mc.model=r.model
			AND mc.config_revision=p.desktop_config_revision AND mc.tools_ok)
		FROM agent_routine r
		JOIN app_user u ON u.id=r.user_id
		JOIN workspace_member wm ON wm.workspace_id=r.workspace_id AND wm.user_id=r.user_id AND wm.status='active'
		JOIN platform_account a ON a.id=r.account_id AND a.workspace_id=r.workspace_id
		JOIN model_provider p ON p.id=r.model_provider_id AND p.workspace_id=r.workspace_id
		JOIN agent_routine_occurrence o ON o.id=$4 AND o.routine_id=r.id AND o.status='running'
		JOIN agent_run run ON run.id=o.run_id AND run.id=$5 AND run.execution_origin='routine'
		WHERE r.id=$1 AND r.workspace_id=$2 AND r.user_id=$3`,
		p.RoutineID, p.WorkspaceID, p.UserID, p.RoutineOccurrenceID, p.RunID).Scan(
		&id.UserID, &id.WorkspaceID, &id.Username, &disabledAt, &id.Role, &accountActive, &routineStatus,
		&providerStatus, &executionLocation, &modelReady)
	if err != nil || id.UserID != p.UserID || id.WorkspaceID != p.WorkspaceID || disabledAt != nil ||
		(id.Role != "owner" && id.Role != "editor") || !accountActive || routineStatus != "enabled" ||
		providerStatus != "active" || executionLocation != "server" || !modelReady || !agentWorkbenchFeatures()["routines"] {
		return nil, errUnauthenticated
	}
	settings, err := s.agentSettingsOf(ctx, p.WorkspaceID)
	if err != nil || !settings.Enabled {
		return nil, errUnauthenticated
	}
	id.ReauthOK = false
	return &id, nil
}

func agentRoutineCursorInt(raw string) int {
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

func agentRoutineUnavailable(message string) error {
	return apiErr(409, "agent_routine_unavailable", message)
}
