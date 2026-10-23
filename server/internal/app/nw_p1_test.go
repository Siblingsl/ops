package app

// NW-A7 / NW-A8 / NW-A9 / NW-E2：创建契约（选题事务、负责人、来源审计、智能体标题可空）。

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNWA7_CreateWorkFromTopicIsTransactional(t *testing.T) {
	f := env.accounts(t)
	accountID := f.wechat.ID.String()
	var created struct {
		Topic Topic `json:"topic"`
	}
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accountID+"/topics", map[string]string{"title": "选题创建验收", "angle": "从选题直接开始"}, &created)
	topic := created.Topic

	// 第一次：采纳选题并建作品。
	var first Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accountID+"/works", map[string]any{"topic_id": topic.ID.String()}, &first)
	if first.TopicID == nil || first.TopicID.String() != topic.ID.String() {
		t.Fatalf("work should link to topic %s, got %v", topic.ID, first.TopicID)
	}
	var status string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT status FROM topic WHERE id=$1`, topic.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "adopted" {
		t.Fatalf("topic status = %s, want adopted", status)
	}

	// 第二次：同一选题不重复建作品，返回同一篇。
	var second Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+accountID+"/works", map[string]any{"topic_id": topic.ID.String()}, &second)
	if second.ID != first.ID {
		t.Fatalf("starting the same topic twice created two works: %s vs %s", first.ID, second.ID)
	}
	var n int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work WHERE topic_id=$1 AND deleted_at IS NULL`, topic.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 work for topic, got %d", n)
	}
}

func TestNWA8_CreateAssignsCurrentUser(t *testing.T) {
	f := env.accounts(t)
	var me struct {
		UserID string `json:"user_id"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": ""}, &wk)
	if wk.AssigneeID == nil || wk.AssigneeID.String() != me.UserID {
		t.Fatalf("new work assignee = %v, want current user %s", wk.AssigneeID, me.UserID)
	}
	if wk.CreatedBy == nil || wk.CreatedBy.String() != me.UserID {
		t.Fatalf("new work created_by = %v, want current user %s", wk.CreatedBy, me.UserID)
	}
}

func TestNWE2_CreateAuditRecordsSource(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": "审计来源"}, &wk)
	var meta []byte
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT detail FROM audit_log WHERE action='work_create' AND target_id=$1 ORDER BY created_at DESC LIMIT 1`, wk.ID.String()).Scan(&meta); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"source": "blank"`, `"content_format"`, `"title_len"`} {
		if !strings.Contains(string(meta), want) {
			t.Fatalf("audit meta %s missing %s", meta, want)
		}
	}
}

func TestNWE2_LongTitleRejectedInsteadOfTruncated(t *testing.T) {
	f := env.accounts(t)
	accountID := f.wechat.ID.String()
	var before int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL`, f.wechat.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	ae := env.expectErr(t, "POST", "/api/v1/accounts/"+accountID+"/works", map[string]string{"title": strings.Repeat("界", 65)}, "validation_failed")
	if !strings.Contains(ae.Error.Message, "作品标题最多64字") {
		t.Fatalf("long title error = %q", ae.Error.Message)
	}
	var after int
	if err := env.srv.db.QueryRow(context.Background(), `SELECT count(*) FROM work WHERE account_id=$1 AND deleted_at IS NULL`, f.wechat.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("overlong title created a work: count %d -> %d", before, after)
	}
}

func TestNWA9_AgentCreateAllowsEmptyTitle(t *testing.T) {
	f := env.accounts(t)
	// 智能体与 HTTP 使用同一个契约：空标题也能创建。
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": ""}, &wk)
	if wk.ID == uuid.Nil {
		t.Fatal("empty title create should succeed")
	}
}

func TestNWD3_BlankWorkCheckHasSectionsDeepLink(t *testing.T) {
	f := env.accounts(t)
	var wk Work
	env.mustJSON(t, "POST", "/api/v1/accounts/"+f.wechat.ID.String()+"/works", map[string]string{"title": ""}, &wk)
	// 空白作品允许显式发起检查；格式项必须给出可点的 sections 深链。
	var run struct {
		Run struct {
			Items []struct {
				Category string         `json:"category"`
				Passed   bool           `json:"passed"`
				Message  string         `json:"message"`
				Location map[string]any `json:"location"`
			} `json:"items"`
		} `json:"run"`
	}
	env.mustJSON(t, "POST", "/api/v1/works/"+wk.ID.String()+"/checks", map[string]any{}, &run)
	var found bool
	for _, it := range run.Run.Items {
		if it.Category != "format" || it.Passed {
			continue
		}
		if msg, _ := it.Message, true; msg == "还没有正文，先确认大纲并起草" {
			found = true
			if it.Location["field"] != "sections" {
				t.Fatalf("blank work item should carry field=sections, got %+v", it.Location)
			}
		}
	}
	if !found {
		t.Fatalf("blank work check should include a dedicated empty-body item, got %+v", run.Run.Items)
	}
}
