package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// DEV-PS56 定向测试：观测列表按作品去重，待确认优先。
//
// 缺陷背景：`listObservations` 原本按 `observed_at DESC` 直接取前 200 条。
// 同一批作品每天被采集一次，每条都是新观测（`as_of_at` 不同 → `payload_hash` 不同），
// 于是第二天再采一轮，前端「最近观测」的前 8 条会全部是同一批作品的第二次采集，
// 用户看到的是"没有新东西"，而其它作品的待确认观测被挤出了视野。
//
// 实测数据：7 篇作品、每篇 8 条观测共 56 条，按时间倒序就会出现这类遮蔽。
//
// 修法：每个作品只列最新一条，并把 `needs_confirmation` 排在最前——
// 那是唯一需要用户动手的状态。

// listObservationsCall 走真实 handler 取列表。
func listObservationsCall(t *testing.T, f *platformRunFixture, accountID uuid.UUID) []map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/accounts/"+accountID.String()+"/metrics/observations", nil)
	ctx := context.WithValue(req.Context(), ctxMember, &identity{
		UserID: f.UserID, WorkspaceID: f.Workspace, Role: "owner",
	})
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("accountId", accountID.String())
	req = req.WithContext(context.WithValue(ctx, chi.RouteCtxKey, routeCtx))
	rec := httptest.NewRecorder()
	if err := env.srv.listObservations(rec, req); err != nil {
		t.Fatalf("取观测列表失败：%v", err)
	}
	var out struct {
		Observations []map[string]any `json:"observations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是合法 JSON：%s", rec.Body.String())
	}
	return out.Observations
}

// seedObservationAt 造一条指定外部编号与时间的观测。
func seedObservationAt(t *testing.T, f *platformRunFixture, externalID string, observedAt string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `INSERT INTO platform_metric_observation
		(workspace_id, account_id, external_account_key, external_id, scope, source, observed_at, as_of_at,
		 temporal_kind, values, field_paths, adapter_version, mapping_version, payload_hash,
		 quality_state, match_state)
		VALUES ($1,$2,$3,$4,'work','wechat_browser',$5::timestamptz,$5::timestamptz,'cumulative',
		        '{"like_count":{"value":1,"precision":"exact","unit":"count"}}'::jsonb,
		        '{"like_count":"fixture.like"}'::jsonb,'wechat-mp-1',1,
		        encode(sha256(random()::text::bytea),'hex'),'needs_confirmation','bound')
		RETURNING id`,
		f.Workspace, f.Account.ID, f.externalKey(), externalID, observedAt).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_metric_observation WHERE id=$1`, id)
	})
	return id
}

func TestListObservationsDedupesByWork(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_list_"+uuid.New().String()[:8])

	// 同一篇作品采 3 次（时间递增），另一篇采 2 次。
	seedObservationAt(t, f, "2247480080_1", "2026-10-20T01:00:00Z")
	seedObservationAt(t, f, "2247480080_1", "2026-10-20T02:00:00Z")
	latestFirst := seedObservationAt(t, f, "2247480080_1", "2026-10-20T03:00:00Z")
	seedObservationAt(t, f, "2247480081_1", "2026-10-20T01:30:00Z")
	seedObservationAt(t, f, "2247480081_1", "2026-10-20T02:30:00Z")

	items := listObservationsCall(t, f, f.Account.ID)
	// 只应看到 2 条（每篇作品一条），而不是 5 条。
	if len(items) != 2 {
		t.Fatalf("应按作品去重为 2 条，实际 %d 条", len(items))
	}
	// 两篇作品都要出现——这正是修复的目的：不让一篇的重复采集挤掉别人。
	seen := map[string]bool{}
	for _, it := range items {
		if v, ok := it["external_id"].(string); ok {
			seen[v] = true
		}
	}
	if !seen["2247480080_1"] || !seen["2247480081_1"] {
		t.Fatalf("两篇作品都应出现，实际 %v", seen)
	}
	// 每篇留下的必须是最新一条。
	for _, it := range items {
		if it["external_id"] == "2247480080_1" {
			if id, ok := it["id"].(string); !ok || id != latestFirst.String() {
				t.Fatalf("应保留最新一条 %s，实际 %v", latestFirst, it["id"])
			}
		}
	}
}

func TestListObservationsPutsNeedsConfirmationFirst(t *testing.T) {
	f := newPlatformRunFixture(t, "wechat_mp", "wechat_biz:fixture_order_"+uuid.New().String()[:8])

	// 一条较新的 valid，一条较旧的 needs_confirmation：待确认必须排在前面，
	// 否则用户会先看到一堆不需要动手的记录，真正要处理的被压在后面。
	confirmed := seedObservationAt(t, f, "2247480082_1", "2026-10-20T05:00:00Z")
	if _, err := env.srv.db.Exec(context.Background(),
		`UPDATE platform_metric_observation SET quality_state='valid' WHERE id=$1`, confirmed); err != nil {
		t.Fatal(err)
	}
	pending := seedObservationAt(t, f, "2247480083_1", "2026-10-20T01:00:00Z")

	items := listObservationsCall(t, f, f.Account.ID)
	if len(items) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(items))
	}
	firstID, _ := items[0]["id"].(string)
	if firstID != pending.String() {
		t.Fatalf("待确认的观测应排在第一位（%s），实际 %s", pending, firstID)
	}
}
