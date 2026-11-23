package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestF2MergeValidationAndCrossPlatform(t *testing.T) {
	// F2-A3：同工作区同平台才可合并；跨平台 422；同账号 422；确认词必须。
	src := drAccount(t, "xhs", "F2 源小红书")
	tgt := drAccount(t, "xhs", "F2 目标小红书")
	other := drAccount(t, "wechat_mp", "F2 公众号")
	env.ensureToolModel(t)
	// 跨平台 422 merge_platform_mismatch。
	var ae struct {
		Error struct{ Code string `json:"code"` } `json:"error"`
	}
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+other.ID.String()+"/merge",
		map[string]any{"source_account_id": src.ID.String(), "confirm": "合并"}, &ae, http.StatusUnprocessableEntity)
	if ae.Error.Code != "merge_platform_mismatch" {
		t.Fatalf("code = %s", ae.Error.Code)
	}
	// 同账号 422。
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+tgt.ID.String()+"/merge",
		map[string]any{"source_account_id": tgt.ID.String(), "confirm": "合并"}, nil, http.StatusUnprocessableEntity)
	// 确认词错误 422。
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+tgt.ID.String()+"/merge",
		map[string]any{"source_account_id": src.ID.String(), "confirm": "删除"}, nil, http.StatusUnprocessableEntity)
	// 跨工作区 404（另一用户以该 ID 为 source）。
	g := env.registerClient(t, "f2_cross_"+uuid.NewString()[:8], testPassword)
	defer g.restore(env)
	env.mustJSONStatus(t, "POST", "/api/v1/accounts/"+tgt.ID.String()+"/merge",
		map[string]any{"source_account_id": src.ID.String(), "confirm": "合并"}, nil, http.StatusNotFound)
}

func TestF2PreviewCountsMatchTables(t *testing.T) {
	// F2-A2：preview 计数与实际表一致。
	a := drAccount(t, "xhs", "F2 清单小红书")
	env.ensureToolModel(t)
	wk := publishTestWork(t, a, "F2 清单作品", 900, 1200, []string{"测试"})
	_ = wk
	var p accountDeactivationPreview
	env.mustJSON(t, "GET", "/api/v1/accounts/"+a.ID.String()+"/deactivation-preview", nil, &p)
	// 作品计数与表对照。
	var works int64
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL`, a.ID).Scan(&works); err != nil {
		t.Fatal(err)
	}
	if p.Works != works || p.Works < 1 {
		t.Fatalf("preview works=%d table=%d", p.Works, works)
	}
	if p.Platform != "xhs" || p.Status != "active" {
		t.Fatalf("preview meta wrong: %s/%s", p.Platform, p.Status)
	}
}

func TestF2MergeMovesDataAndDisablesSource(t *testing.T) {
	// F2-A1/A4/A5：合并迁移各表、冲突不覆盖、源停用不删除、幂等、审计、回滚。
	src := drAccount(t, "xhs", "F2 迁移源小红书")
	tgt := drAccount(t, "xhs", "F2 迁移目标小红书")
	env.ensureToolModel(t)
	srcWork := publishTestWork(t, src, "F2 源作品", 900, 1200, []string{"测试"})
	tgtWork := publishTestWork(t, tgt, "F2 目标作品", 900, 1200, []string{"测试"})
	// 源账号加一条 failed 发布任务（指向源作品）。
	_, err := env.srv.db.Exec(context.Background(),
		`INSERT INTO publish_task (workspace_id, account_id, work_id, platform, state, mode, state_version)
		 SELECT pa.workspace_id, pa.id, w.id, pa.platform, 'failed', 'manual', 1
		 FROM platform_account pa JOIN work w ON w.account_id=pa.id AND w.deleted_at IS NULL
		 WHERE pa.id=$1 LIMIT 1`, src.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 合并（目标账号为路径，源为 body）。
	var out struct {
		MergeID   string         `json:"merge_id"`
		Moved     map[string]int64 `json:"moved"`
		Conflicts []map[string]any `json:"conflicts"`
		Status    string         `json:"status"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+tgt.ID.String()+"/merge",
		map[string]any{"source_account_id": src.ID.String(), "confirm": "合并"}, &out)
	if out.Status != "completed" {
		t.Fatalf("status = %s", out.Status)
	}
	if out.Moved["work"] < 1 || out.Moved["publish_task"] < 1 {
		t.Fatalf("moved wrong: %+v", out.Moved)
	}
	// 数据迁移到位：源作品现在归属目标账号。
	var ownerID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT account_id FROM work WHERE id=$1`, srcWork.ID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID != tgt.ID {
		t.Fatalf("work not moved: owner=%s want %s", ownerID, tgt.ID)
	}
	var taskOwner uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT account_id FROM publish_task WHERE work_id=$1`, srcWork.ID).Scan(&taskOwner); err != nil {
		t.Fatal(err)
	}
	if taskOwner != tgt.ID {
		t.Fatalf("task not moved")
	}
	// 源账号 disabled 不删除。
	var srcStatus string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT status FROM platform_account WHERE id=$1`, src.ID).Scan(&srcStatus); err != nil {
		t.Fatal(err)
	}
	if srcStatus != "disabled" {
		t.Fatalf("source status = %s, want disabled (not deleted)", srcStatus)
	}
	// 幂等：重复请求返回最近 completed 记录。
	var out2 struct {
		Status     string `json:"status"`
		Idempotent bool   `json:"idempotent"`
		MergeID    string `json:"merge_id"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+tgt.ID.String()+"/merge",
		map[string]any{"source_account_id": src.ID.String(), "confirm": "合并"}, &out2)
	if out2.Status != "completed" || !out2.Idempotent || out2.MergeID != out.MergeID {
		t.Fatalf("idempotent broken: %+v", out2)
	}
	// 审计存在。
	var audits int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_log WHERE action='account_merge'`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits < 1 {
		t.Fatal("audit missing")
	}
	// 目标作品归属未受影响。
	var tgtOwner uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT account_id FROM work WHERE id=$1`, tgtWork.ID).Scan(&tgtOwner); err != nil {
		t.Fatal(err)
	}
	if tgtOwner != tgt.ID {
		t.Fatal("target work owner changed")
	}
}
