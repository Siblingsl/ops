package app

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestAG12AuditLogsAreWorkspaceScoped(t *testing.T) {
	owner := env.me(t)
	ownerWorkspace := uuid.MustParse(owner.Workspace.ID)
	other := env.registerClient(t, "ag12-audit-"+uuid.NewString()[:8], testPassword)
	var otherMe meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &otherMe)
	otherWorkspace := uuid.MustParse(otherMe.Workspace.ID)
	if ownerWorkspace == otherWorkspace {
		t.Fatal("测试工作区应相互独立")
	}
	other.restore(env)

	marker := "ag12_audit_" + uuid.NewString()
	ownAction, otherAction, unknownAction := marker+"_own", marker+"_other", marker+"_unknown"
	ctx := context.Background()
	for _, row := range []struct {
		workspace *uuid.UUID
		action    string
	}{{&ownerWorkspace, ownAction}, {&otherWorkspace, otherAction}, {nil, unknownAction}} {
		if _, err := env.srv.db.Exec(ctx, `INSERT INTO audit_log (workspace_id, action, target_type, target_id)
			VALUES ($1,$2,'test','')`, row.workspace, row.action); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(ctx, `DELETE FROM audit_log WHERE action LIKE $1`, marker+"%")
	})

	type auditRow struct {
		Action string `json:"action"`
	}
	var ownerRows []auditRow
	env.mustJSON(t, "GET", "/api/v1/audit-logs?action="+marker, nil, &ownerRows)
	if len(ownerRows) != 1 || ownerRows[0].Action != ownAction {
		t.Fatalf("工作区日志只能返回本工作区记录：%+v", ownerRows)
	}

	var otherRows []auditRow
	other.mustJSON(t, "GET", "/api/v1/audit-logs?action="+marker, nil, &otherRows)
	if len(otherRows) != 1 || otherRows[0].Action != otherAction {
		t.Fatalf("另一个工作区只能看到自己的记录：%+v", otherRows)
	}
	other.restore(env)

	status, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "skyeder", "password": testAdminPassword})
	if status != 200 {
		t.Fatalf("登录系统管理员失败：%d %s", status, body)
	}
	defer func() {
		status, body := env.do("POST", "/api/v1/auth/login", map[string]string{"username": "owner", "password": testPassword})
		if status != 200 {
			t.Errorf("恢复 owner 会话失败：%d %s", status, body)
			return
		}
		env.csrf = env.me(t).CSRF
	}()
	env.csrf = env.me(t).CSRF
	var adminRows []auditRow
	env.mustJSON(t, "GET", "/api/v1/admin/audit-logs?action="+marker, nil, &adminRows)
	if len(adminRows) != 3 {
		t.Fatalf("系统管理员应能查看各工作区与未归属历史记录：%+v", adminRows)
	}
}
