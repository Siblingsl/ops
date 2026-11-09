package app

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// DEV-AI27-21A 第二步（T-AI27-21A，27 §8.6）：goal 续跑浏览器 grant 派生租约。
// 四场景：①正例——resume 后按上一活动 grant 派生新租约（新 token、同 binding/tab/origins）；
// ②越权——他人工作区/用户的 grant 不派生；③过期——源租约过期不派生并留事件；
// ④失效绑定——源租约的 binding 已撤销时不派生（deriveBrowserGrantForRun 返回原因）。

// w21aSetup 建绑定 + 会话（含 goal 模型路由），返回 binding ID。
func w21aSetup(t *testing.T) (bindingID string, conv agentConversation, providerID string) {
	t.Helper()
	clearAgentFeatureSettings(t)
	t.Setenv(agentWorkbenchFeatureEnv, "goals,event_resume,run_control,plans,chrome_connect,browser_workspace")
	providerID = env.ensureToolModel(t)
	conv = env.agentRunConversation(t, providerID)
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	var pairing browserPairingView
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings", map[string]any{"request_id": uuid.NewString()}, &pairing)
	var confirmed struct {
		BindingID string `json:"binding_id"`
	}
	env.mustJSON(t, http.MethodPost, "/api/v1/agent/browser/pairings/"+pairing.ID+"/confirm", w04ConfirmBody(t, pairing.Revision), &confirmed)
	return confirmed.BindingID, conv, providerID
}

// w21aGoalRun 走真实 goal 旅程：创建 goal → 发消息启动 goal run → 等待结束，返回 goal ID。
func w21aGoalRun(t *testing.T, conv agentConversation, providerID string) uuid.UUID {
	t.Helper()
	var created struct {
		Goal agentGoalView `json:"goal"`
	}
	env.mustJSON(t, http.MethodPost, agentRunPath(conv, "goal"), map[string]any{
		"request_id": uuid.NewString(), "objective": "研究一个公开网页并给出摘要",
		"criteria":   []map[string]any{{"text": "给出一段带来源的摘要"}},
		"account_id": conv.AccountID.String(), "model": map[string]any{"provider_id": providerID, "model": "mock-writer"},
		"run_budget": 5, "seconds_budget": 1800,
	}, &created)
	status, body := env.do(http.MethodPost, agentRunPath(conv, "messages"), map[string]any{
		"text": "开始研究", "request_id": uuid.NewString(), "protocol_version": 2,
	})
	if status != http.StatusAccepted {
		t.Fatalf("goal run rejected: %d %s", status, body)
	}
	aw06WaitRun(t, body)
	return created.Goal.ID
}

// w21aActiveGrant 给指定 run 直接插入一条 active 租约（模拟上一轮 AI 已获授权）。
func w21aActiveGrant(t *testing.T, bindingID string, conv agentConversation, runID uuid.UUID) uuid.UUID {
	t.Helper()
	me := env.me(t)
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `
		INSERT INTO agent_browser_grant (id, binding_id, workspace_id, user_id, conversation_id, run_id,
			tab_handle, origins, actions, policy_version, state, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,'tab-1',$7,$8,'v1','active', now()+interval '30 seconds') RETURNING id`,
		uuid.New(), uuid.MustParse(bindingID), uuid.MustParse(me.Workspace.ID), uuid.MustParse(me.UserID), conv.ID, runID,
		[]string{"https://example.com"}, []string{"observe"}).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// 场景①正例：goal run 结束后仍留有 active grant（30s 时效内），resume 派生新租约给新 run。
func TestW06GrantDerivationDerivedOnResume(t *testing.T) {
	bindingID, conv, providerID := w21aSetup(t)
	me := env.me(t)
	wsID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)

	// 上一轮 goal run（completed：同会话唯一活动 run 约束下，源 run 已终态）。
	previousRun := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "completed", "goal")
	sourceGrant := w21aActiveGrant(t, bindingID, conv, previousRun)

	// 直接调派生函数（resume 事务路径的单元覆盖）：新 run 拿到新租约。
	newRunID := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "queued", "goal")
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	derivation, err := env.srv.deriveBrowserGrantForRun(context.Background(), tx, conv.ID, wsID, userID, newRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if derivation.GrantID == nil {
		t.Fatalf("正例应派生新租约，got %+v", derivation)
	}
	if derivation.GrantID.String() == sourceGrant.String() {
		t.Fatal("派生租约必须是新 token，不得复用旧 grant id")
	}
	var tabHandle string
	var runID uuid.UUID
	var origins []string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT tab_handle, run_id, origins FROM agent_browser_grant WHERE id=$1`,
		*derivation.GrantID).Scan(&tabHandle, &runID, &origins); err != nil {
		t.Fatal(err)
	}
	if tabHandle != "tab-1" || runID != newRunID || len(origins) != 1 || origins[0] != "https://example.com" {
		t.Fatalf("派生租约字段不符：tab=%s run=%s origins=%v", tabHandle, runID, origins)
	}
}

// 场景②越权：他人工作区同会话 ID 不存在 grant（归属由 workspace/user 过滤）→ 不派生。
func TestW06GrantDerivationRejectsCrossWorkspace(t *testing.T) {
	_, conv, providerID := w21aSetup(t)
	// registerClient 会把 env.client 切到新用户会话；不 restore 会污染同包后续测试
	// （TestW14PluginCallLedgerAndGuards 曾因此全量红，见 docs/08 测试隔离修复）。
	other := env.registerClient(t, "w21a-other-"+uuid.NewString()[:8], testPassword)
	defer other.restore(env)
	var ome meInfo
	other.mustJSON(t, "GET", "/api/v1/auth/me", nil, &ome)
	otherConv := conv
	newRunID := agentInsertRun(t, otherConv.ID, uuid.MustParse(ome.Workspace.ID), uuid.MustParse(ome.UserID), uuid.MustParse(providerID), "queued", "goal")
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	derivation, err := env.srv.deriveBrowserGrantForRun(context.Background(), tx,
		otherConv.ID, uuid.MustParse(ome.Workspace.ID), uuid.MustParse(ome.UserID), newRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	// 他人工作区无该会话（conversation_id 属于原工作区），查不到源 grant。
	if derivation.GrantID != nil || derivation.Reason != "browser_grant_no_source" {
		t.Fatalf("跨工作区不得派生：%+v", derivation)
	}
}

// 场景③过期：源租约 expires_at 已过 → 不派生（no_source），旧 run 也不受影响。
func TestW06GrantDerivationExpiredSourceNotDerived(t *testing.T) {
	bindingID, conv, providerID := w21aSetup(t)
	me := env.me(t)
	wsID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	previousRun := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "completed", "goal")
	// 插入一条已过期租约。
	if _, err := env.srv.db.Exec(context.Background(), `
		INSERT INTO agent_browser_grant (id, binding_id, workspace_id, user_id, conversation_id, run_id,
			tab_handle, origins, actions, policy_version, state, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,'tab-1',$7,'{observe}','v1','active', now()-interval '1 minute')`,
		uuid.New(), uuid.MustParse(bindingID), wsID, userID, conv.ID, previousRun,
		[]string{"https://example.com"}); err != nil {
		t.Fatal(err)
	}
	newRunID := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "queued", "goal")
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	derivation, err := env.srv.deriveBrowserGrantForRun(context.Background(), tx, conv.ID, wsID, userID, newRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if derivation.GrantID != nil || derivation.Reason != "browser_grant_no_source" {
		t.Fatalf("过期源不得派生：%+v", derivation)
	}
	var active int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_browser_grant WHERE run_id=$1 AND state='active'`, newRunID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatalf("过期源派生后新 run 不得有租约：%d", active)
	}
}

// 场景④失效绑定：撤销绑定会级联把源租约置 revoked（agent_browser.go 撤销级联），
// 因此派生查不到 active 源 → 不派生（browser_grant_no_source）。
// deriveBrowserGrantForRun 内的 binding ready 校验仍保留，防 binding 被直接置
// disconnected（未级联撤租约）的数据形态。
func TestW06GrantDerivationRevokedBindingNotDerived(t *testing.T) {
	bindingID, conv, providerID := w21aSetup(t)
	me := env.me(t)
	wsID := uuid.MustParse(me.Workspace.ID)
	userID := uuid.MustParse(me.UserID)
	previousRun := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "completed", "goal")
	w21aActiveGrant(t, bindingID, conv, previousRun)
	// 撤销绑定（级联撤源租约）。
	env.mustJSON(t, http.MethodDelete, "/api/v1/agent/browser/bindings/"+bindingID, map[string]any{}, nil)
	newRunID := agentInsertRun(t, conv.ID, wsID, userID, uuid.MustParse(providerID), "queued", "goal")
	tx, err := env.srv.db.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	derivation, err := env.srv.deriveBrowserGrantForRun(context.Background(), tx, conv.ID, wsID, userID, newRunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if derivation.GrantID != nil || derivation.Reason != "browser_grant_no_source" {
		t.Fatalf("失效绑定（级联撤租约）不得派生：%+v", derivation)
	}
	var activeOnNew int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_browser_grant WHERE run_id=$1 AND state='active'`, newRunID).Scan(&activeOnNew); err != nil {
		t.Fatal(err)
	}
	if activeOnNew != 0 {
		t.Fatalf("失效绑定派生后新 run 不得有租约：%d", activeOnNew)
	}
}

// 集成：goal resume 走完整 API 路径时派生生效（新 run 有自己的 active 租约）。
func TestW06GrantDerivationOnGoalResumeAPI(t *testing.T) {
	bindingID, conv, providerID := w21aSetup(t)
	goalID := w21aGoalRun(t, conv, providerID)

	// 查 goal 最近一次 run，给它插 active grant（模拟上一轮已获授权且未过期）。
	var lastRunID uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT id FROM agent_run WHERE conversation_id=$1 AND goal_id=$2 ORDER BY started_at DESC LIMIT 1`,
		conv.ID, goalID).Scan(&lastRunID); err != nil {
		t.Fatal(err)
	}
	w21aActiveGrant(t, bindingID, conv, lastRunID)

	// goal 置 paused 后 resume（走 control API）。revision 在 run 结束后读取，
	// 避免与 run 生命周期内的 revision+1 竞争；置 paused 本身不再改 revision
	// （直接 UPDATE，绕过 control API 的 pause 分支，因为那也会 revision+1）。
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE agent_goal SET status='paused' WHERE id=$1`, goalID); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := env.srv.db.QueryRow(context.Background(), `SELECT revision FROM agent_goal WHERE id=$1`, goalID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	status, body := env.do(http.MethodPost, "/api/v1/agent/goals/"+goalID.String()+"/control", map[string]any{
		"expected_revision": revision, "request_id": uuid.NewString(), "action": "resume",
	})
	if status != http.StatusOK {
		t.Fatalf("goal resume rejected: %d %s", status, body)
	}
	aw06WaitRun(t, body)

	// resume 产生的新 run 应有自己的 active 租约（不是复用上一 run 的那一条）。
	var newRunGrants int
	if err := env.srv.db.QueryRow(context.Background(), `
		SELECT count(*) FROM agent_browser_grant g
		WHERE g.run_id IN (SELECT id FROM agent_run WHERE conversation_id=$1 AND goal_id=$2
			AND id <> $3 AND started_at > (SELECT started_at FROM agent_run WHERE id=$3))
		  AND g.state='active'`, conv.ID, goalID, lastRunID).Scan(&newRunGrants); err != nil {
		t.Fatal(err)
	}
	if newRunGrants != 1 {
		t.Fatalf("resume 后新 run 应派生 1 条租约，got %d", newRunGrants)
	}
	var sameAsSource bool
	if err := env.srv.db.QueryRow(context.Background(), `
		SELECT EXISTS(
			SELECT 1 FROM agent_browser_grant src
			WHERE src.run_id=$2 AND src.conversation_id=$1
			  AND EXISTS(SELECT 1 FROM agent_browser_grant g
				WHERE g.id=src.id AND g.run_id <> src.run_id))`, conv.ID, lastRunID).Scan(&sameAsSource); err != nil {
		t.Fatal(err)
	}
	if sameAsSource {
		t.Fatal("派生租约不得复用源 grant id")
	}
}
