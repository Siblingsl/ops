package app

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// FN-11 必检 2：唯一只读聚合入口的六块数据、工作区/账号/用户/角色隔离。
func TestFN11TodayOpsAggregateAndIsolation(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,context_refs,event_resume,run_control,plans,goals,routines,artifacts,today_ops")
	pid := env.ensureToolModel(t)
	me := env.me(t)
	workspaceID, err := uuid.Parse(me.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	userID, err := uuid.Parse(me.UserID)
	if err != nil {
		t.Fatal(err)
	}
	accounts := env.accounts(t)
	account := accounts.xhs

	workReady := createTodayOpsWork(t, account.ID.String(), "FN11 待发布作品")
	workRisk := createTodayOpsWork(t, account.ID.String(), "FN11 失败作品")
	ownerID, err := uuid.Parse(me.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO publish_task
		(workspace_id,account_id,work_id,platform,state,mode,idempotency_key,created_by)
		VALUES($1,$2,$3,'xhs','ready','api',$4,$5)`,
		workspaceID, account.ID, workReady.ID, uuid.NewString(), ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO publish_task
		(workspace_id,account_id,work_id,platform,state,mode,idempotency_key,last_error_code,last_error_message,created_by)
		VALUES($1,$2,$3,'xhs','failed','api',$4,'fn11_error','FN11 失败原因',$5)`,
		workspaceID, account.ID, workRisk.ID, uuid.NewString(), ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO metric_snapshot
		(work_id,captured_at,reads,likes,comments,favorites,source,quality_state)
		VALUES($1,now(),120,9,4,7,'manual','approved')`, workReady.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO comment_inbox
		(workspace_id,account_id,work_id,author_alias,content,captured_at,category,reply_status,created_by)
		VALUES($1,$2,$3,'小读者','这篇什么时候更新？',now(),'question','none',$4)`,
		workspaceID, account.ID, workReady.ID, ownerID); err != nil {
		t.Fatal(err)
	}
	providerID, err := uuid.Parse(pid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_routine
		(workspace_id,user_id,account_id,name,prompt,cadence,time_of_day,timezone,destination,model_provider_id,model,status,next_due_at)
		VALUES($1,$2,$3,'FN11 每日选题','整理今天可写的选题。','daily','09:00','Asia/Shanghai','new',$4,'mock-writer','enabled',now()+interval '10 minutes')`,
		workspaceID, userID, account.ID, providerID); err != nil {
		t.Fatal(err)
	}
	conv := env.createConversation(t, map[string]any{"account_id": account.ID})
	t.Cleanup(func() { deleteConversations(t, conv.ID) })
	runID := uuid.New()
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_run
		(id,conversation_id,workspace_id,user_id,session_id,trigger,status)
		VALUES($1,$2,$3,$4,$5,'message','completed')`, runID, conv.ID, workspaceID, userID, uuid.New()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(t.Context(), `INSERT INTO agent_action
		(conversation_id,run_id,batch_id,workspace_id,user_id,tool_call_id,tool_name,kind,target_type,target_id,target_key,status,params,expires_at)
		VALUES($1,$2,$3,$4,$5,'fn11-call','works__update','W','work',$6,$7,'pending','{}',now()+interval '1 hour')`,
		conv.ID, runID, uuid.New(), workspaceID, userID, workReady.ID.String(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}

	var view agentTodayOpsView
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String(), nil, &view)
	if view.Account.ID != account.ID || view.Account.Name != account.Name || view.Account.Platform != "xhs" {
		t.Fatalf("账号信息错误：%+v", view.Account)
	}
	wantOrder := []string{"pending", "publishing", "today", "comments", "routines", "risks"}
	if len(view.Blocks) != len(wantOrder) {
		t.Fatalf("六块数量错误：%+v", view.Blocks)
	}
	byKey := map[string]agentTodayOpsBlock{}
	for i, block := range view.Blocks {
		if block.Key != wantOrder[i] {
			t.Fatalf("区块顺序错误：want %s got %s", wantOrder[i], block.Key)
		}
		if len(block.Items) > 3 {
			t.Fatalf("%s 超过 3 条：%d", block.Key, len(block.Items))
		}
		byKey[block.Key] = block
	}
	if byKey["pending"].Count != 1 || len(byKey["pending"].Items) != 1 || byKey["pending"].Items[0].To != "/agent/c/"+conv.ID.String() {
		t.Fatalf("待处理块错误：%+v", byKey["pending"])
	}
	if byKey["publishing"].Count != 1 || len(byKey["publishing"].Items) != 1 || !strings.Contains(byKey["publishing"].Items[0].To, workReady.ID.String()) {
		t.Fatalf("待发布块错误：%+v", byKey["publishing"])
	}
	if byKey["today"].Count != 1 || !strings.Contains(byKey["today"].Items[0].Detail, "阅读 120") {
		t.Fatalf("今日数据块错误：%+v", byKey["today"])
	}
	if byKey["comments"].Count != 1 || !strings.Contains(byKey["comments"].Items[0].Detail, "什么时候更新") {
		t.Fatalf("评论块错误：%+v", byKey["comments"])
	}
	if byKey["routines"].Count != 1 || byKey["routines"].Items[0].Title != "FN11 每日选题" || !strings.Contains(byKey["routines"].Items[0].To, "panel=routine") {
		t.Fatalf("例行块错误：%+v", byKey["routines"])
	}
	if byKey["risks"].Count != 1 || byKey["risks"].Items[0].Detail != "FN11 失败原因" {
		t.Fatalf("风险块错误：%+v", byKey["risks"])
	}
	for _, block := range view.Blocks {
		if block.More == nil || block.More.To == "" || !strings.HasPrefix(block.More.To, "/") {
			t.Fatalf("%s 缺少明确的更多入口：%+v", block.Key, block.More)
		}
	}

	var single agentTodayOpsView
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String()+"&block=comments", nil, &single)
	if len(single.Blocks) != 1 || single.Blocks[0].Key != "comments" || single.Summary.Comments != 1 {
		t.Fatalf("单块重试应只返回 comments：%+v", single)
	}
	if single.Blocks[0].More == nil || single.Blocks[0].More.To != "/a/"+account.ID.String()+"/profile?tab=comments" {
		t.Fatalf("单块重试丢失更多入口：%+v", single.Blocks[0])
	}
	env.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String()+"&block=nope", nil, "block_invalid")

	// 角色隔离：观察者读取聚合驾驶舱返回 403，且不返回任何块正文。
	var inv inviteDTO
	env.mustJSON(t, http.MethodPost, "/api/v1/workspaces/current/invites", map[string]any{"role": "viewer", "max_uses": 1, "days": 1}, &inv)
	viewer := env.registerClient(t, "fn11-viewer-"+uuid.NewString()[:8], testPassword)
	viewer.mustJSON(t, http.MethodPost, "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}, nil)
	viewer.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String(), nil, "forbidden")
	viewer.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String()+"&block=comments", nil, "forbidden")
	viewer.restore(env)

	// 跨工作区：另一个工作区的账号 ID 必须按不存在处理，不能返回他人账号的名字或六块数据。
	other := env.registerClient(t, "fn11-other-"+uuid.NewString()[:8], testPassword)
	var otherAccount Account
	other.mustJSON(t, http.MethodPost, "/api/v1/accounts", map[string]string{
		"platform": "xhs", "name": "另一个工作区的账号", "content_format": "image_note",
	}, &otherAccount)
	other.restore(env)
	env.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+otherAccount.ID.String(), nil, "not_found")
	env.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+otherAccount.ID.String()+"&block=comments", nil, "not_found")

	// 依赖门：today_ops 不能绕过 workbench_ui。
	t.Setenv(agentWorkbenchFeatureEnv, "today_ops")
	env.expectErr(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+account.ID.String(), nil, "agent_feature_unavailable")
}

func createTodayOpsWork(t *testing.T, accountID, title string) Work {
	t.Helper()
	var work Work
	env.mustJSON(t, http.MethodPost, "/api/v1/accounts/"+accountID+"/works", map[string]string{"title": title}, &work)
	return work
}

// 只读聚合不得提供任何写入路径；方法不允许由 chi 统一返回 405。
func TestFN11TodayOpsIsReadOnly(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,today_ops")
	accounts := env.accounts(t)
	status, body := env.do(http.MethodPost, "/api/v1/agent/today-ops?account_id="+accounts.xhs.ID.String(), map[string]any{})
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("POST 必须 405，got %d %s", status, body)
	}
}

// 只在今天范围内的可信数据进入今日数据块；held/旧数据不得混入。
func TestFN11TodayOpsTodayDataFiltersApprovedAndDay(t *testing.T) {
	t.Setenv(agentWorkbenchFeatureEnv, "workbench_ui,today_ops")
	accounts := env.accounts(t)
	work := createTodayOpsWork(t, accounts.wechat.ID.String(), "FN11 今日数据边界")
	workspaceID, err := uuid.Parse(env.me(t).Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id,captured_at,reads,source,quality_state) VALUES($1,$2,31,'manual','held')`, work.ID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id,captured_at,reads,likes,comments,favorites,source,quality_state)
		VALUES($1,$2,55,6,2,3,'wechat_api','approved')`, work.ID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO metric_snapshot
		(work_id,captured_at,reads,source,quality_state,day_offset) VALUES($1,$2,77,'manual','approved',1)`,
		work.ID, now.Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var view agentTodayOpsView
	env.mustJSON(t, http.MethodGet, "/api/v1/agent/today-ops?account_id="+accounts.wechat.ID.String(), nil, &view)
	found := false
	for _, block := range view.Blocks {
		if block.Key != "today" {
			continue
		}
		found = true
		if block.Error != "" {
			t.Fatalf("今日数据块不得带错误：%q", block.Error)
		}
		if block.Count != 1 || len(block.Items) != 1 {
			t.Fatalf("只允许今天 approved 的一条数据：%+v", block)
		}
		if !strings.Contains(block.Items[0].Detail, "阅读 55") {
			t.Fatalf("今天 approved 数据未进入今日数据：%+v", block.Items[0])
		}
	}
	if !found {
		t.Fatal("响应缺少今日数据块")
	}
	_ = workspaceID
}
