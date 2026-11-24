package app

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCXPublishStateXhsManualPublishedWithoutPack(t *testing.T) {
	ctx := context.Background()
	workspaceID := ownerWS(t)
	account := drAccount(t, "xhs", "小红书手动发布无包号")
	work := drWork(t, account, "小红书手动发布无包作品", "drafting", nil)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET created_at=now()-interval '10 minutes' WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	var taskID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO publish_task(workspace_id,account_id,work_id,platform,state,mode,state_version,evidence)
		VALUES($1,$2,$3,'xhs','filled','desktop',2,'{"draft_saved":true}'::jsonb) RETURNING id`, workspaceID, account.ID, work.ID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	publishedAt := env.srv.now().Add(-3 * time.Minute).UTC()
	const noteID = "6b05138a000000002b010011"
	publicURL := "https://www.xiaohongshu.com/explore/" + noteID + "?xsec_token=test-token&xsec_source=pc_creatormng"
	path := cxPublishStatePath(work.ID)
	first := map[string]any{"base_version": 0, "idempotency_key": uuid.NewString(), "to": "submitted",
		"submitted_ref": map[string]any{
			"handoff_note": "用户已在小红书草稿箱人工发布，平台回读确认",
			"manual_published": map[string]any{
				"note_id":      noteID,
				"url":          publicURL,
				"published_at": publishedAt.Format(time.RFC3339),
			},
		}}
	var submitted cxPublishStateView
	env.mustJSON(t, "POST", path+"/transition", first, &submitted)
	if submitted.State == nil || *submitted.State != "submitted" || submitted.Version != 1 ||
		submitted.SubmittedRef.Kind != "xhs_manual_published" || submitted.SubmittedRef.NoteID != noteID ||
		submitted.SubmittedRef.URL != publicURL || submitted.SubmittedRef.PublishedAt == nil {
		t.Fatalf("小红书人工发布必须写入真实回读凭证，而不是补发布包：%+v", submitted)
	}

	var workStatus string
	if err := env.srv.db.QueryRow(ctx, `SELECT status FROM work WHERE id=$1`, work.ID).Scan(&workStatus); err != nil {
		t.Fatal(err)
	}
	if workStatus != "drafting" {
		t.Fatalf("人工发布回读不能先改作品状态，实际=%s", workStatus)
	}

	var markResp struct {
		Task PublishTask `json:"task"`
	}
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+taskID.String()+"/mark", map[string]any{
		"to": "submitted", "url": publicURL, "note": "用户已人工发布，登记任务为已提交",
	}, &markResp, map[string]string{"Idempotency-Key": uuid.NewString()})
	if markResp.Task.State != "submitted" {
		t.Fatalf("人工发布任务未进入 submitted：%+v", markResp.Task)
	}

	body := map[string]any{"url": publicURL, "published_at": publishedAt.Format(time.RFC3339)}
	var published Work
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/published", body, &published)
	if published.Status != "published" || published.PublishedURL == nil || *published.PublishedURL != publicURL {
		t.Fatalf("人工发布作品未按真实链接回填：%+v", published)
	}
	var after cxPublishStateView
	env.mustJSON(t, "GET", path, nil, &after)
	if after.State == nil || *after.State != "public" || after.Version != 2 {
		t.Fatalf("人工发布后发布进度必须进入 public：%+v", after)
	}
	var taskState string
	if err := env.srv.db.QueryRow(ctx, `SELECT state FROM publish_task WHERE work_id=$1 AND platform='xhs'`, work.ID).Scan(&taskState); err != nil {
		t.Fatal(err)
	}
	if taskState != "published" {
		t.Fatalf("公开回填必须把任务投影为 published，实际=%s", taskState)
	}
}

func TestPXPublishTaskAdoptXhsManualWithoutPack(t *testing.T) {
	ctx := context.Background()
	workspaceID := ownerWS(t)
	account := drAccount(t, "xhs", "小红书登记发布无包号")
	work := drWork(t, account, "小红书登记发布无包作品", "drafting", nil)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET created_at=now()-interval '10 minutes' WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	var taskID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `INSERT INTO publish_task(workspace_id,account_id,work_id,platform,state,mode,state_version,evidence)
		VALUES($1,$2,$3,'xhs','filled','desktop',2,'{"draft_saved":true}'::jsonb) RETURNING id`, workspaceID, account.ID, work.ID).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	publishedAt := env.srv.now().Add(-time.Minute).UTC()
	publicURL := "https://www.xiaohongshu.com/explore/6b05138a000000002b010011"
	var adopted struct {
		Task    PublishTask `json:"task"`
		Adopted bool        `json:"adopted"`
	}
	env.mustJSONHeader(t, "POST", "/api/v1/publish-tasks/"+taskID.String()+"/adopt", map[string]any{
		"url": publicURL, "published_at": publishedAt.Format(time.RFC3339), "note": "用户已人工发布，登记不重发",
	}, &adopted, map[string]string{"Idempotency-Key": uuid.NewString()})
	if !adopted.Adopted || adopted.Task.State != "submitted" || adopted.Task.FilledAt != nil {
		t.Fatalf("登记已发布必须走无包 manual milestone：%+v", adopted)
	}
	var state cxPublishStateView
	env.mustJSON(t, "GET", cxPublishStatePath(work.ID), nil, &state)
	if state.State == nil || *state.State != "submitted" || state.SubmittedRef.Kind != "xhs_manual_published" {
		t.Fatalf("登记已发布必须建立 xhs_manual_published 里程碑：%+v", state)
	}
	var published Work
	env.mustJSON(t, "POST", "/api/v1/works/"+work.ID.String()+"/published", map[string]any{
		"url": publicURL, "published_at": publishedAt.Format(time.RFC3339),
	}, &published)
	if published.Status != "published" {
		t.Fatalf("无包登记后回填失败：%+v", published)
	}
	var taskState string
	if err := env.srv.db.QueryRow(ctx, `SELECT state FROM publish_task WHERE id=$1`, taskID).Scan(&taskState); err != nil {
		t.Fatal(err)
	}
	if taskState != "published" {
		t.Fatalf("登记已发布后任务应投影为 published，实际=%s", taskState)
	}
}

func TestCXPublishStateXhsManualPublishedRejectsUnfilledOrMismatched(t *testing.T) {
	ctx := context.Background()
	workspaceID := ownerWS(t)
	account := drAccount(t, "xhs", "小红书手动发布反例号")
	work := drWork(t, account, "小红书手动发布反例作品", "drafting", nil)
	if _, err := env.srv.db.Exec(ctx, `UPDATE work SET created_at=now()-interval '10 minutes' WHERE id=$1`, work.ID); err != nil {
		t.Fatal(err)
	}
	publishedAt := env.srv.now().Add(-time.Minute).UTC()
	path := cxPublishStatePath(work.ID) + "/transition"
	body := map[string]any{"base_version": 0, "idempotency_key": uuid.NewString(), "to": "submitted",
		"submitted_ref": map[string]any{
			"handoff_note": "不应通过",
			"manual_published": map[string]any{
				"note_id":      "6b05138a000000002b010011",
				"url":          "https://www.xiaohongshu.com/explore/6b05138a000000002b010011",
				"published_at": publishedAt.Format(time.RFC3339),
			},
		}}
	env.expectErr(t, "POST", path, body, "state_invalid")
	env.expectErr(t, "POST", "/api/v1/works/"+work.ID.String()+"/published", map[string]any{
		"url":          "https://www.xiaohongshu.com/explore/6b05138a000000002b010011",
		"published_at": publishedAt.Format(time.RFC3339),
	}, "state_invalid")

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO publish_task(workspace_id,account_id,work_id,platform,state,mode,state_version,evidence)
		VALUES($1,$2,$3,'xhs','filled','desktop',2,'{"draft_saved":true}'::jsonb)`, workspaceID, account.ID, work.ID); err != nil {
		t.Fatal(err)
	}
	body["submitted_ref"].(map[string]any)["manual_published"].(map[string]any)["note_id"] = "000000000000000000000000"
	env.expectErr(t, "POST", path, body, "validation_failed")
}
