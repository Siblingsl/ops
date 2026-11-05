package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAW10RoutineFeatureRequiresCompletedRunDependencies(t *testing.T) {
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "routines")
	if agentWorkbenchFeatures()["routines"] {
		t.Fatal("routines must stay unavailable without the persistent run dependencies")
	}
	t.Setenv(agentWorkbenchFeatureEnv, "routines,event_resume,run_control,plans,goals,artifacts")
	if !agentWorkbenchFeatures()["routines"] {
		t.Fatal("routines should be available once all prerequisites are enabled")
	}
}

func TestAW10RoutinePausesWhenCreatorIsDemotedToViewer(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).xhs
	owner := env.me(t)
	ownerID, workspaceID := uuid.MustParse(owner.UserID), uuid.MustParse(owner.Workspace.ID)
	memberUsername := "qa26-routine-demotion-" + uuid.NewString()[:8]
	memberID := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO app_user (id,username,password_hash)
		SELECT $1,$2,password_hash FROM app_user WHERE id=$3`, memberID, memberUsername, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO workspace_member (workspace_id,user_id,role,status)
		VALUES ($1,$2,'editor','active')`, workspaceID, memberID); err != nil {
		t.Fatal(err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	member := &guestClient{
		parent: env, client: &http.Client{Jar: jar, Timeout: time.Minute}, savedC: env.client, savedX: env.csrf,
	}
	t.Cleanup(func() {
		member.restore(env)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM session WHERE user_id=$1`, memberID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM app_user WHERE id=$1`, memberID)
	})
	status, body := member.do(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": memberUsername, "password": testPassword,
	})
	if status != http.StatusOK {
		t.Fatalf("登录隔离编辑成员失败：status=%d body=%s", status, body)
	}
	var registered struct {
		UserID    uuid.UUID `json:"user_id"`
		CSRF      string    `json:"csrf_token"`
		Role      string    `json:"role"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &registered)
	member.csrf = registered.CSRF
	if registered.UserID != memberID || registered.Workspace.ID != owner.Workspace.ID || registered.Role != "editor" {
		t.Fatalf("隔离编辑成员身份不正确：owner=%+v member=%+v", owner, registered)
	}
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	member.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "成员降权暂停验收", "prompt": "只读核对",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("编辑者例行任务创建失败：%+v", created)
	}
	member.restore(env)
	env.mustJSON(t, http.MethodPatch, "/api/v1/workspaces/current/members/"+memberID.String(), map[string]string{"role": "viewer"}, nil)
	var paused struct {
		Items []agentRoutineView `json:"items"`
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	if len(paused.Items) != 1 || paused.Items[0].ID != created.Routine.ID || paused.Items[0].Status != "paused" || paused.Items[0].ErrorCode != "member_role_revoked" || paused.Items[0].NextDueAt != nil {
		t.Fatalf("创建者降为观察者后必须持久化暂停例行任务：%+v", paused.Items)
	}
	var eventCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='paused'
		AND payload->>'reason'='member_role_revoked'`, created.Routine.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("成员权限撤销必须持久化暂停事件：count=%d err=%v", eventCount, err)
	}
	var notices struct {
		Items []Notification `json:"items"`
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/notifications", nil, &notices)
	foundNotice := false
	for _, item := range notices.Items {
		if item.Kind == "agent_routine" && item.Title == "例行任务已暂停" && strings.Contains(item.Body, "恢复编辑权限后") {
			foundNotice = true
		}
	}
	if !foundNotice {
		t.Fatalf("成员降权后必须向任务创建者发送通知：%+v", notices.Items)
	}
	member.restore(env)
	env.mustJSON(t, http.MethodPatch, "/api/v1/workspaces/current/members/"+memberID.String(), map[string]string{"role": "editor"}, nil)
	member.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	if paused.Items[0].Status != "paused" {
		t.Fatal("恢复编辑权限不得自动重新启用例行任务")
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	member.mustJSON(t, http.MethodPost, "/api/v1/agent/routines/"+created.Routine.ID.String()+"/control", map[string]any{
		"expected_revision": paused.Items[0].Revision, "request_id": uuid.NewString(), "action": "enable",
	}, &enabled)
	if enabled.Routine.Status != "enabled" {
		t.Fatalf("创建者逐项启用例行任务失败：%+v", enabled.Routine)
	}
	member.restore(env)
	env.mustJSON(t, http.MethodPatch, "/api/v1/workspaces/current/members/"+memberID.String(), map[string]bool{"remove": true}, nil)
	var removedStatus, removedReason string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code FROM agent_routine WHERE id=$1`, created.Routine.ID).
		Scan(&removedStatus, &removedReason); err != nil {
		t.Fatal(err)
	}
	if removedStatus != "paused" || removedReason != "member_removed" {
		t.Fatalf("移出创建者后例行任务必须持久化暂停：status=%s error_code=%s", removedStatus, removedReason)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='paused'
		AND payload->>'reason'='member_removed'`, created.Routine.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("移出创建者后必须持久化暂停事件：count=%d err=%v", eventCount, err)
	}
	var notificationCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM notification WHERE workspace_id=$1 AND user_id=$2
		AND kind='agent_routine' AND title='例行任务已暂停' AND body LIKE '%已移出此工作区%'`, workspaceID, memberID).Scan(&notificationCount); err != nil || notificationCount != 1 {
		t.Fatalf("移出创建者后必须持久化暂停通知：count=%d err=%v", notificationCount, err)
	}
}

func TestAW10RoutinePausesWhenModelProviderBecomesUnavailable(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).xhs
	owner := env.me(t)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "模型失效暂停验收", "prompt": "只读核对",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("例行任务创建失败：%+v", created)
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/model-providers/"+providerID, map[string]string{"status": "disabled"}, nil)
	var status, reason string
	var noNextDue bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code,next_due_at IS NULL FROM agent_routine WHERE id=$1`, created.Routine.ID).
		Scan(&status, &reason, &noNextDue); err != nil {
		t.Fatal(err)
	}
	if status != "paused" || reason != "model_unavailable" || !noNextDue {
		t.Fatalf("模型停用后必须立即持久化暂停：status=%s reason=%s next_due_at_null=%v", status, reason, noNextDue)
	}
	var eventCount, notificationCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='paused'
		AND payload->>'reason'='model_unavailable'`, created.Routine.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("模型停用后必须持久化暂停事件：count=%d err=%v", eventCount, err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM notification WHERE workspace_id=$1 AND user_id=$2
		AND kind='agent_routine' AND title='例行任务已暂停' AND body LIKE '%任务模型不可用%'`,
		uuid.MustParse(owner.Workspace.ID), uuid.MustParse(owner.UserID)).Scan(&notificationCount); err != nil || notificationCount != 1 {
		t.Fatalf("模型停用后必须持久化暂停通知：count=%d err=%v", notificationCount, err)
	}
	var paused struct {
		Items []agentRoutineView `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	statusCode, raw := env.do(http.MethodPost, "/api/v1/agent/routines/"+created.Routine.ID.String()+"/control", map[string]any{
		"expected_revision": paused.Items[0].Revision, "request_id": uuid.NewString(), "action": "enable",
	})
	var rejected apiError
	if err := json.Unmarshal(raw, &rejected); err != nil {
		t.Fatalf("解析模型不可用时的恢复拒绝响应失败：%v body=%s", err, raw)
	}
	if statusCode != http.StatusConflict || rejected.Error.Code != "agent_routine_unavailable" || !strings.Contains(rejected.Error.Message, "服务器模型不可用") {
		t.Fatalf("模型不可用时必须拒绝恢复任务：status=%d err=%+v", statusCode, rejected)
	}
	var occurrenceCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1`, created.Routine.ID).Scan(&occurrenceCount); err != nil || occurrenceCount != 0 {
		t.Fatalf("模型不可用时拒绝恢复不得创建执行记录：count=%d err=%v", occurrenceCount, err)
	}
	env.mustJSON(t, http.MethodPatch, "/api/v1/model-providers/"+providerID, map[string]string{"status": "active"}, nil)
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	if len(paused.Items) != 1 || paused.Items[0].ID != created.Routine.ID || paused.Items[0].Status != "paused" {
		t.Fatalf("恢复模型不得自动重新启用例行任务：%+v", paused.Items)
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines/"+created.Routine.ID.String()+"/control", map[string]any{
		"expected_revision": paused.Items[0].Revision, "request_id": uuid.NewString(), "action": "enable",
	}, &enabled)
	if enabled.Routine.Status != "enabled" || enabled.Routine.ErrorCode != "" {
		t.Fatalf("用户逐项启用模型恢复后的例行任务失败：%+v", enabled.Routine)
	}
}

func TestAW10RoutinePausesWhenWorkspaceAgentIsDisabled(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).xhs
	owner := env.me(t)
	workspaceID := uuid.MustParse(owner.Workspace.ID)
	agentSettingsReset(t, workspaceID)
	t.Cleanup(func() { agentSettingsReset(t, workspaceID) })
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "关闭工作区智能体暂停验收", "prompt": "只读核对",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("例行任务创建失败：%+v", created)
	}
	notificationLink := "/agent?panel=task&item=" + created.Routine.ID.String()
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM notification WHERE link=$1`, notificationLink)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
	})
	env.mustJSON(t, http.MethodPut, "/api/v1/agent/settings", map[string]bool{"enabled": false}, nil)
	if _, body := env.do(http.MethodGet, "/api/v1/agent/routines", nil); !strings.Contains(string(body), `"code":"agent_disabled"`) {
		t.Fatalf("工作区关闭智能体后应阻止访问例行任务接口：%s", body)
	}
	var status, reason string
	var noNextDue bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code,next_due_at IS NULL FROM agent_routine WHERE id=$1`, created.Routine.ID).
		Scan(&status, &reason, &noNextDue); err != nil {
		t.Fatal(err)
	}
	if status != "paused" || reason != "agent_disabled" || !noNextDue {
		t.Fatalf("关闭工作区智能体后必须立即持久化暂停：status=%s reason=%s next_due_at_null=%v", status, reason, noNextDue)
	}
	var eventCount, notificationCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='paused'
		AND payload->>'reason'='agent_disabled'`, created.Routine.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("关闭智能体后必须持久化暂停事件：count=%d err=%v", eventCount, err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM notification WHERE workspace_id=$1 AND user_id=$2
		AND kind='agent_routine' AND title='例行任务已暂停' AND body LIKE '%工作区已关闭智能体%' AND link=$3`,
		workspaceID, uuid.MustParse(owner.UserID), notificationLink).Scan(&notificationCount); err != nil || notificationCount != 1 {
		t.Fatalf("关闭智能体后必须持久化暂停通知：count=%d err=%v", notificationCount, err)
	}
	env.mustJSON(t, http.MethodPut, "/api/v1/agent/settings", map[string]bool{"enabled": true}, nil)
	var paused struct {
		Items []agentRoutineView `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	var pausedRoutine *agentRoutineView
	for index := range paused.Items {
		if paused.Items[index].ID == created.Routine.ID {
			pausedRoutine = &paused.Items[index]
			break
		}
	}
	if pausedRoutine == nil || pausedRoutine.Status != "paused" || pausedRoutine.ErrorCode != "agent_disabled" {
		t.Fatalf("重新开启智能体不得自动启用例行任务：%+v", paused.Items)
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines/"+created.Routine.ID.String()+"/control", map[string]any{
		"expected_revision": pausedRoutine.Revision, "request_id": uuid.NewString(), "action": "enable",
	}, &enabled)
	if enabled.Routine.Status != "enabled" || enabled.Routine.ErrorCode != "" {
		t.Fatalf("创建者逐项重新启用任务失败：%+v", enabled.Routine)
	}
}

func TestAW10RoutinePausesWhenSystemUserIsDisabled(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).xhs
	owner := env.me(t)
	ownerID, workspaceID := uuid.MustParse(owner.UserID), uuid.MustParse(owner.Workspace.ID)
	memberUsername := "qa26-routine-user-disable-" + uuid.NewString()[:8]
	memberID := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO app_user (id,username,password_hash)
		SELECT $1,$2,password_hash FROM app_user WHERE id=$3`, memberID, memberUsername, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO workspace_member (workspace_id,user_id,role,status)
		VALUES ($1,$2,'editor','active')`, workspaceID, memberID); err != nil {
		t.Fatal(err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	member := &guestClient{
		parent: env, client: &http.Client{Jar: jar, Timeout: time.Minute}, savedC: env.client, savedX: env.csrf,
	}
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	notificationLink := ""
	t.Cleanup(func() {
		member.restore(env)
		if notificationLink != "" {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM notification WHERE link=$1`, notificationLink)
		}
		if created.Routine.ID != uuid.Nil {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
		}
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM session WHERE user_id=$1`, memberID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM app_user WHERE id=$1`, memberID)
		if status, body := env.do(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword}); status != http.StatusOK {
			t.Errorf("恢复 owner 会话失败：%d %s", status, body)
		}
		env.csrf = env.me(t).CSRF
	})
	status, body := member.do(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": memberUsername, "password": testPassword,
	})
	if status != http.StatusOK {
		t.Fatalf("登录隔离工作区成员失败：status=%d body=%s", status, body)
	}
	var memberMe struct {
		CSRF string `json:"csrf_token"`
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &memberMe)
	member.csrf = memberMe.CSRF
	member.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "系统用户停用暂停验收", "prompt": "只读核对",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("成员例行任务创建失败：%+v", created.Routine)
	}
	notificationLink = "/agent?panel=task&item=" + created.Routine.ID.String()
	member.restore(env)
	status, body = env.do(http.MethodPost, "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if status != http.StatusOK {
		t.Fatalf("登录系统管理员失败：%d %s", status, body)
	}
	var adminMe struct {
		CSRF string `json:"csrf_token"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &adminMe)
	env.csrf = adminMe.CSRF
	env.mustJSON(t, http.MethodPatch, "/api/v1/admin/users/"+memberID.String(), map[string]bool{"disabled": true}, nil)
	var routineStatus, reason string
	var nextDueNull bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT status,error_code,next_due_at IS NULL FROM agent_routine WHERE id=$1`, created.Routine.ID).
		Scan(&routineStatus, &reason, &nextDueNull); err != nil {
		t.Fatal(err)
	}
	if routineStatus != "paused" || reason != "system_user_disabled" || !nextDueNull {
		t.Fatalf("系统用户停用后必须立即暂停其例行任务：status=%s error_code=%s next_due_at_null=%v", routineStatus, reason, nextDueNull)
	}
	var eventCount, notificationCount int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1
		AND type='paused' AND payload->>'reason'='system_user_disabled'`, created.Routine.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("系统用户停用后必须写入暂停事件：count=%d err=%v", eventCount, err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM notification WHERE workspace_id=$1 AND user_id=$2
		AND kind='agent_routine' AND title='例行任务已暂停' AND link=$3 AND body LIKE '%系统用户已停用%'`,
		workspaceID, memberID, notificationLink).Scan(&notificationCount); err != nil || notificationCount != 1 {
		t.Fatalf("系统用户停用后必须通知任务创建者：count=%d err=%v", notificationCount, err)
	}
	if status, body := member.do(http.MethodGet, "/api/v1/auth/me", nil); status != http.StatusUnauthorized {
		t.Fatalf("停用系统用户后必须使其会话失效：status=%d body=%s", status, body)
	}
	member.restore(env)
	env.csrf = adminMe.CSRF
	env.mustJSON(t, http.MethodPatch, "/api/v1/admin/users/"+memberID.String(), map[string]bool{"disabled": false}, nil)
	status, body = member.do(http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": memberUsername, "password": testPassword,
	})
	if status != http.StatusOK {
		t.Fatalf("管理员重新启用用户后用户登录失败：status=%d body=%s", status, body)
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &memberMe)
	member.csrf = memberMe.CSRF
	var paused struct {
		Items []agentRoutineView `json:"items"`
	}
	member.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &paused)
	if len(paused.Items) != 1 || paused.Items[0].ID != created.Routine.ID || paused.Items[0].Status != "paused" || paused.Items[0].ErrorCode != "system_user_disabled" {
		t.Fatalf("重新启用用户不得自动恢复例行任务：%+v", paused.Items)
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	member.mustJSON(t, http.MethodPost, "/api/v1/agent/routines/"+created.Routine.ID.String()+"/control", map[string]any{
		"expected_revision": paused.Items[0].Revision, "request_id": uuid.NewString(), "action": "enable",
	}, &enabled)
	if enabled.Routine.Status != "enabled" || enabled.Routine.ErrorCode != "" {
		t.Fatalf("用户重新启用任务后状态错误：%+v", enabled.Routine)
	}
}

func TestAW10RoutineToolAllowlistCannotReachBusinessWrites(t *testing.T) {
	allowed := []string{
		"works__list", "works__get", "works__read_sections", "review__dashboard", "review__top_works",
		"review__digests", "metrics__list", "metrics__unmatched", "followers__list", "reviews__list",
		"checks__latest", "checks__report",
	}
	for _, name := range allowed {
		if !agentRoutineToolAllowed(agentTool(name), nil) {
			t.Errorf("documented routine read tool %q was rejected", name)
		}
	}
	for _, name := range []string{"reviews__create", "works__create", "checks__fix_suggest", "present_plan"} {
		if agentRoutineToolAllowed(agentTool(name), nil) {
			t.Errorf("routine must not call %q", name)
		}
	}
}

func TestAW10RoutineSkillsMustUsePublicEffectiveView(t *testing.T) {
	if !agentRoutineArgsAllowed("skills__list", map[string]any{"view": "effective"}) {
		t.Fatal("public effective skills should be available")
	}
	for _, args := range []map[string]any{
		{"view": "library"},
		{"view": "effective", "scope": "personal"},
		{"view": "effective", "scope": "unknown"},
	} {
		if agentRoutineArgsAllowed("skills__list", args) {
			t.Errorf("private or non-effective skill request was allowed: %#v", args)
		}
	}
}

func TestAW10RoutinePrincipalRechecksServerModelBeforeEveryTool(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var me struct {
		UserID    string `json:"user_id"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "模型权限边界", "prompt": "仅生成只读报告",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	conv := env.agentRunConversation(t, providerID)
	var occurrenceID, runID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,lease_token,lease_until,started_at)
		VALUES($1,now(),$2,'manual','running',$3,now()+interval '5 minutes',now()) RETURNING id`,
		created.Routine.ID, uuid.New(), uuid.New()).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_run
		(conversation_id,workspace_id,user_id,trigger,status,stage,model_provider_id,model,mode,execution_origin,config_snapshot,routine_occurrence_id)
		VALUES($1,$2,$3,'routine','running','tool',$4,'mock-writer','execute','routine','{}',$5) RETURNING id`,
		conv.ID, workspaceID, userID, providerID, occurrenceID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine_occurrence SET run_id=$2 WHERE id=$1`, occurrenceID, runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=$1`, conv.ID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
		_, _ = env.srv.db.Exec(t.Context(), `UPDATE model_capability SET tools_ok=true WHERE provider_id=$1 AND model='mock-writer'`, providerID)
	})
	principal := &agentPrincipal{UserID: userID, WorkspaceID: workspaceID, ConversationID: conv.ID, RunID: runID,
		RoutineID: created.Routine.ID, RoutineOccurrenceID: occurrenceID}
	if _, err := env.srv.loadAgentRoutinePrincipal(t.Context(), principal); err != nil {
		t.Fatalf("valid running routine principal must pass: %v", err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE model_capability SET tools_ok=false WHERE provider_id=$1 AND model='mock-writer'`, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.loadAgentRoutinePrincipal(t.Context(), principal); err == nil {
		t.Fatal("revoked server-model tool capability must block the next internal tool request")
	}
}

func TestAW10ExpiredRoutineRunIsMarkedUnknownAndNeverReplayed(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var me struct {
		UserID    string `json:"user_id"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "未知结果不重跑", "prompt": "只读检查",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	conv := env.agentRunConversation(t, providerID)
	var occurrenceID, runID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_routine_occurrence(routine_id,due_at,request_id,kind,status,lease_token,lease_until,started_at)
		VALUES($1,now()-interval '1 minute',$2,'scheduled','running',$3,now()-interval '1 minute',now()-interval '2 minutes') RETURNING id`,
		created.Routine.ID, uuid.New(), uuid.New()).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_run
		(conversation_id,workspace_id,user_id,trigger,status,stage,model_provider_id,model,mode,execution_origin,config_snapshot,routine_occurrence_id)
		VALUES($1,$2,$3,'routine','running','tool',$4,'mock-writer','execute','routine','{}',$5) RETURNING id`,
		conv.ID, workspaceID, userID, providerID, occurrenceID).Scan(&runID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine_occurrence SET run_id=$2 WHERE id=$1`, occurrenceID, runID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=$1`, conv.ID)
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, created.Routine.ID)
	})
	env.srv.recoverAgentRoutineLeases(t.Context())
	env.srv.runAgentRoutines(t.Context())
	var runStatus, runError, occurrenceStatus, occurrenceError string
	if err := env.srv.db.QueryRow(t.Context(), `SELECT run.status,run.error_code,o.status,o.error_code
		FROM agent_routine_occurrence o JOIN agent_run run ON run.id=o.run_id WHERE o.id=$1`, occurrenceID).
		Scan(&runStatus, &runError, &occurrenceStatus, &occurrenceError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || runError != "interrupted" || occurrenceStatus != "interrupted" || occurrenceError != "interrupted" {
		t.Fatalf("expired in-flight result must remain unknown: run=%s/%s occurrence=%s/%s", runStatus, runError, occurrenceStatus, occurrenceError)
	}
	var unknown, runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_event WHERE routine_id=$1 AND type='interrupted'
		AND payload->>'result_unknown'='true'`, created.Routine.ID).Scan(&unknown); err != nil || unknown != 1 {
		t.Fatalf("recovery must persist one result-unknown event: count=%d err=%v", unknown, err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id=$1`, occurrenceID).Scan(&runs); err != nil || runs != 1 {
		t.Fatalf("unknown occurrence must not be retried: runs=%d err=%v", runs, err)
	}
}

func TestAW10RoutineSchedulerTickRecoversAbandonedLease(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	account := env.accounts(t).wechat
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "未启动租约恢复", "prompt": "#text 生成一段简短的恢复报告",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" {
		t.Fatalf("创建租约恢复验收例行任务失败：%+v", created.Routine)
	}
	routineID := created.Routine.ID
	notificationLink := "/agent?panel=task&item=" + routineID.String()
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM notification WHERE link=$1`, notificationLink)
		rows, err := env.srv.db.Query(cleanupCtx, `SELECT conversation_id FROM agent_run WHERE routine_occurrence_id IN (
			SELECT id FROM agent_routine_occurrence WHERE routine_id=$1)`, routineID)
		var conversations []uuid.UUID
		if err == nil {
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					conversations = append(conversations, id)
				}
			}
			rows.Close()
		}
		_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_routine WHERE id=$1`, routineID)
		if len(conversations) > 0 {
			_, _ = env.srv.db.Exec(cleanupCtx, `DELETE FROM agent_conversation WHERE id=ANY($1)`, conversations)
		}
	})

	var occurrenceID uuid.UUID
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=NULL WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}
	if err := env.srv.db.QueryRow(t.Context(), `INSERT INTO agent_routine_occurrence
		(routine_id,due_at,request_id,kind,status,lease_token,lease_until)
		VALUES($1,now()-interval '2 minutes',$2,'scheduled','leased',$3,now()-interval '1 minute') RETURNING id`,
		routineID, uuid.New(), uuid.New()).Scan(&occurrenceID); err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	env.srv.runAgentRoutines(t.Context())
	deadline := time.Now().Add(25 * time.Second)
	var occurrenceStatus, runStatus string
	for time.Now().Before(deadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT o.status,COALESCE(run.status,'') FROM agent_routine_occurrence o
			LEFT JOIN agent_run run ON run.routine_occurrence_id=o.id WHERE o.id=$1`, occurrenceID).Scan(&occurrenceStatus, &runStatus)
		if err == nil && occurrenceStatus == "completed" && runStatus == "completed" {
			break
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if occurrenceStatus != "completed" || runStatus != "completed" {
		t.Fatalf("过期的未启动 lease 应由 scheduler tick 恢复并完成：occurrence=%s run=%s", occurrenceStatus, runStatus)
	}
	var runs int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_run WHERE routine_occurrence_id=$1`, occurrenceID).Scan(&runs); err != nil || runs != 1 {
		t.Fatalf("恢复同一 occurrence 只应启动一个 run：runs=%d err=%v", runs, err)
	}
	t.Logf("DEV-QA26_METRIC_ROUTINE_LEASE_RECOVERY %s", fmt.Sprintf(`{"occurrence":"%s","occurrence_status":"%s","run_status":"%s","runs":%d,"journey_ms":%.2f}`, occurrenceID, occurrenceStatus, runStatus, runs, float64(time.Since(started).Microseconds())/1000))
}

func TestAW10RoutineCreateControlAndReadOnlyRun(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,conversation_organize,context_refs,skill_requests,artifacts,run_control,event_resume,plans,goals,routines")
	providerID := env.ensureToolModel(t)
	var account Account
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts", map[string]any{
		"platform": "xhs", "name": "例行撤权集成测试账号", "content_format": "image_note",
	}, &account)
	if account.ID == uuid.Nil {
		t.Fatal("创建例行撤权集成测试账号失败")
	}
	var me struct {
		UserID    string `json:"user_id"`
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/auth/me", nil, &me)
	userID, workspaceID := uuid.MustParse(me.UserID), uuid.MustParse(me.Workspace.ID)
	var created struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/routines", map[string]any{
		"request_id": uuid.NewString(), "name": "只读摘要", "prompt": "#text 本次例行报告内容",
		"public_context_refs": []any{}, "account_id": account.ID.String(), "cadence": "daily", "time_of_day": "09:00",
		"timezone": "Asia/Shanghai", "destination": "new",
		"model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
	}, &created)
	if created.Routine.ID == uuid.Nil || created.Routine.Status != "enabled" || created.Routine.Revision != 1 {
		t.Fatalf("例行任务创建回执不正确：%+v", created)
	}
	routineID := created.Routine.ID
	var list struct {
		ServerModels []agentModelOption `json:"server_models"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &list)
	foundServerModel := false
	for _, model := range list.ServerModels {
		if model.ProviderID.String() == providerID && model.Model == "mock-writer" && model.ExecutionLocation == "server" {
			foundServerModel = true
		}
	}
	if !foundServerModel {
		t.Fatalf("例行任务模型列表应提供已自检服务器模型，got=%+v", list.ServerModels)
	}
	t.Cleanup(func() {
		rows, err := env.srv.db.Query(t.Context(), `SELECT r.conversation_id FROM agent_run r
			JOIN agent_routine_occurrence o ON o.id=r.routine_occurrence_id WHERE o.routine_id=$1`, routineID)
		var conversations []uuid.UUID
		if err == nil {
			for rows.Next() {
				var id uuid.UUID
				if rows.Scan(&id) == nil {
					conversations = append(conversations, id)
				}
			}
			rows.Close()
		}
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_routine WHERE id=$1`, routineID)
		if len(conversations) > 0 {
			_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM agent_conversation WHERE id=ANY($1)`, conversations)
		}
		_, _ = env.srv.db.Exec(t.Context(), `DELETE FROM platform_account WHERE id=$1`, account.ID)
	})
	control := "/api/v1/agent/routines/" + routineID.String() + "/control"
	var paused struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 1, "request_id": uuid.NewString(), "action": "pause"}, &paused)
	if paused.Routine.Status != "paused" || paused.Routine.Revision != 2 {
		t.Fatalf("暂停应CAS并停止新调度：%+v", paused.Routine)
	}
	var enabled struct {
		Routine agentRoutineView `json:"routine"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 2, "request_id": uuid.NewString(), "action": "enable"}, &enabled)
	if enabled.Routine.Status != "enabled" || enabled.Routine.Revision != 3 || enabled.Routine.NextDueAt == nil {
		t.Fatalf("启用应重算下一次计划时间：%+v", enabled.Routine)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE agent_routine SET next_due_at=now()-interval '1 minute' WHERE id=$1`, routineID); err != nil {
		t.Fatal(err)
	}
	env.srv.runAgentRoutines(t.Context())
	env.srv.runAgentRoutines(t.Context())
	var scheduledID uuid.UUID
	if err := env.srv.db.QueryRow(t.Context(), `SELECT id FROM agent_routine_occurrence WHERE routine_id=$1 AND kind='scheduled'`, routineID).Scan(&scheduledID); err != nil {
		t.Fatalf("调度器应创建固定时刻occurrence：%v", err)
	}
	deadline := time.Now().Add(8 * time.Second)
	var scheduledStatus string
	for time.Now().Before(deadline) {
		_ = env.srv.db.QueryRow(t.Context(), `SELECT status FROM agent_routine_occurrence WHERE id=$1`, scheduledID).Scan(&scheduledStatus)
		if scheduledStatus == "completed" || scheduledStatus == "failed" || scheduledStatus == "interrupted" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if scheduledStatus != "completed" {
		t.Fatalf("计划触发应经租约执行完成：occurrence=%s status=%s", scheduledID, scheduledStatus)
	}
	var completed struct {
		Routine      agentRoutineView `json:"routine"`
		OccurrenceID uuid.UUID        `json:"occurrence_id"`
		Status       string           `json:"status"`
	}
	runOnceRequestID := uuid.NewString()
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 3, "request_id": runOnceRequestID, "action": "run_once"}, &completed)
	if completed.Status != "accepted" || completed.OccurrenceID == uuid.Nil {
		t.Fatalf("立即运行回执不正确：%+v", completed)
	}
	var replayed struct {
		OccurrenceID uuid.UUID `json:"occurrence_id"`
		Status       string    `json:"status"`
		Replayed     bool      `json:"replayed"`
	}
	env.mustJSON(t, http.MethodPost, control, map[string]any{"expected_revision": 3, "request_id": runOnceRequestID, "action": "run_once"}, &replayed)
	if !replayed.Replayed || replayed.OccurrenceID != completed.OccurrenceID {
		t.Fatalf("重复立即运行必须回放同一 occurrence：first=%+v replay=%+v", completed, replayed)
	}
	deadline = time.Now().Add(8 * time.Second)
	var runStatus, occurrenceStatus string
	for time.Now().Before(deadline) {
		err := env.srv.db.QueryRow(t.Context(), `SELECT r.status,o.status FROM agent_routine_occurrence o
			JOIN agent_run r ON r.id=o.run_id WHERE o.id=$1`, completed.OccurrenceID).Scan(&runStatus, &occurrenceStatus)
		if err == nil && (runStatus == "completed" || runStatus == "failed" || runStatus == "stopped") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if runStatus != "completed" || occurrenceStatus != "completed" {
		t.Fatalf("例行任务应走真实 agent_chat 主循环完成：run=%s occurrence=%s", runStatus, occurrenceStatus)
	}
	var sessionNull bool
	if err := env.srv.db.QueryRow(t.Context(), `SELECT session_id IS NULL FROM agent_run WHERE routine_occurrence_id=$1`, completed.OccurrenceID).Scan(&sessionNull); err != nil || !sessionNull {
		t.Fatalf("例行运行不得保存用户session：null=%t err=%v", sessionNull, err)
	}
	var reports int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_artifact_version WHERE source_run_id=(
		SELECT run_id FROM agent_routine_occurrence WHERE id=$1)`, completed.OccurrenceID).Scan(&reports); err != nil || reports != 1 {
		t.Fatalf("完成后必须形成一份私有报告产物：count=%d err=%v", reports, err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := sRoutineIdentityForTest(t, routineID); err == nil {
		t.Fatal("创建者降为 viewer 后，例行任务权限必须失效")
	}
	if _, err := env.srv.db.Exec(t.Context(), `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatalf("恢复集成测试共享成员角色失败：%v", err)
	}
	status, _ := env.do(http.MethodPost, "/api/v1/accounts/"+account.ID.String()+"/disable", map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("停用绑定账号失败：status=%d", status)
	}
	var afterDisable struct {
		Items []agentRoutineView `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/routines", nil, &afterDisable)
	var disabledRoutine *agentRoutineView
	for i := range afterDisable.Items {
		if afterDisable.Items[i].ID == routineID {
			disabledRoutine = &afterDisable.Items[i]
			break
		}
	}
	if disabledRoutine == nil || disabledRoutine.Status != "paused" || disabledRoutine.ErrorCode != "account_disabled" || disabledRoutine.NextDueAt != nil {
		t.Fatalf("停用绑定账号必须事务性暂停例行任务并清除计划时间：%+v", disabledRoutine)
	}
	var notifications struct {
		Items []Notification `json:"items"`
	}
	env.mustJSON(t, http.MethodGet, "/api/v1/notifications", nil, &notifications)
	foundPauseNotice := false
	for _, item := range notifications.Items {
		if item.Kind == "agent_routine" && item.Title == "例行任务已暂停" && strings.Contains(item.Body, "绑定账号已停用") {
			foundPauseNotice = true
		}
	}
	if !foundPauseNotice {
		t.Fatalf("停用账号后必须通知任务所有者：%+v", notifications.Items)
	}
	var occurrenceCountBefore int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1`, routineID).Scan(&occurrenceCountBefore); err != nil {
		t.Fatal(err)
	}
	status, raw := env.do(http.MethodPost, control, map[string]any{
		"expected_revision": disabledRoutine.Revision, "request_id": uuid.NewString(), "action": "enable",
	})
	var rejected apiError
	if err := json.Unmarshal(raw, &rejected); err != nil {
		t.Fatalf("解析停用账号下的恢复拒绝响应失败：%v body=%s", err, raw)
	}
	if status != http.StatusConflict || rejected.Error.Code != "agent_routine_unavailable" || !strings.Contains(rejected.Error.Message, "绑定账号已停用") {
		t.Fatalf("绑定账号停用时必须拒绝恢复任务：status=%d err=%+v", status, rejected)
	}
	var occurrenceCountAfter int
	if err := env.srv.db.QueryRow(t.Context(), `SELECT count(*) FROM agent_routine_occurrence WHERE routine_id=$1`, routineID).Scan(&occurrenceCountAfter); err != nil {
		t.Fatal(err)
	}
	if occurrenceCountAfter != occurrenceCountBefore {
		t.Fatalf("拒绝恢复不得创建执行记录：before=%d after=%d", occurrenceCountBefore, occurrenceCountAfter)
	}
}

func sRoutineIdentityForTest(t *testing.T, routineID uuid.UUID) (*identity, error) {
	t.Helper()
	return env.srv.agentRoutineCurrentIdentity(t.Context(), routineID, false)
}
