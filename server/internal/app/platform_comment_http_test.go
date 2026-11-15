package app

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// P0-4（CF-P2-CXEF-06 桌面消费接线）：评论单条上报端点定向测试。
// 设备证明驱动（复用 platformRunFixture 的 signedPlatform），全部真实路由 + 真实账本；
// 不扩 v2 白名单的边界由「端点不接受 run/result_type」这一事实保证。

func p04CommentResult(platform, externalKey, commentID, body string) map[string]any {
	author := "虚构昵称"
	published := "2026-11-16T08:00:00Z"
	return map[string]any{
		"schema":               "cxef06-comment-facts-v1",
		"platform":             platform,
		"external_account_key": externalKey,
		"items": []map[string]any{{
			"comment_id": commentID, "note_id": "6f00000000000000000000ff",
			"author": &author, "body": body, "published_at": &published,
			"present": map[string]any{"comment_id": true, "note_id": true, "author": true, "body": true, "published_at": true, "parent_comment_id": false},
		}},
	}
}

// TestP04CommentIngestEndpoint：证明驱动 → 归属校验 → 单条幂等入库 → 重复上报幂等。
func TestP04CommentIngestEndpoint(t *testing.T) {
	f := newPlatformRunFixture(t, "xhs", "xhs_user_id:p04fixture")
	// 夹具连接的 device_id 即本设备：AccountScope 证明要求设备未撤销且归属当前用户。
	st, resp := f.signedPlatform(t, "platform.comment.ingest", http.MethodPost,
		"/api/v1/desktop/platform/comments", mustJSONBytes(t, p04CommentResult("xhs", "xhs_user_id:p04fixture", "cmt-0001", "虚构评论内容：写得真好。")))
	if st != http.StatusOK {
		t.Fatalf("首次上报应成功：%d %s", st, resp)
	}
	var first struct {
		ID       string `json:"id"`
		Inserted bool   `json:"inserted"`
	}
	if err := json.Unmarshal(resp, &first); err != nil {
		t.Fatal(err)
	}
	if !first.Inserted || first.ID == "" {
		t.Fatalf("首次上报应插入：%+v", first)
	}

	// 幂等：同评论 ID 重复上报 inserted=false，不报错、不重复建行。
	st, resp = f.signedPlatform(t, "platform.comment.ingest", http.MethodPost,
		"/api/v1/desktop/platform/comments", mustJSONBytes(t, p04CommentResult("xhs", "xhs_user_id:p04fixture", "cmt-0001", "虚构评论内容：写得真好。")))
	if st != http.StatusOK {
		t.Fatalf("重复上报应 200：%d %s", st, resp)
	}
	var second struct {
		Inserted bool `json:"inserted"`
	}
	if err := json.Unmarshal(resp, &second); err != nil {
		t.Fatal(err)
	}
	if second.Inserted {
		t.Fatal("重复上报不得重复插入")
	}
	var count int
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT count(*) FROM comment_inbox WHERE id=$1::uuid`, first.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("去重主键应只落一行：count=%d", count)
	}

	// 隐私：author_alias 恒空、平台昵称不落库。
	var alias string
	if err := env.srv.db.QueryRow(context.Background(),
		`SELECT author_alias FROM comment_inbox WHERE id=$1::uuid`, first.ID).Scan(&alias); err != nil {
		t.Fatal(err)
	}
	if alias != "" {
		t.Fatalf("author_alias 必须恒空（00082）：got %q", alias)
	}

	// 账号键不一致：409，不落库。
	st, resp = f.signedPlatform(t, "platform.comment.ingest", http.MethodPost,
		"/api/v1/desktop/platform/comments", mustJSONBytes(t, p04CommentResult("xhs", "xhs_user_id:someone-else", "cmt-0002", "别人的评论")))
	if st != http.StatusConflict {
		t.Fatalf("账号键不一致应 409：%d %s", st, resp)
	}

	// 批量数组拒绝（D-117）：单条语义在 HTTP 层同样成立。
	batch := p04CommentResult("xhs", "xhs_user_id:p04fixture", "cmt-0003", "x")
	batch["items"] = []map[string]any{
		{"comment_id": "c1", "note_id": "n1", "body": "a", "present": map[string]any{"comment_id": true, "note_id": true, "body": true}},
		{"comment_id": "c2", "note_id": "n1", "body": "b", "present": map[string]any{"comment_id": true, "note_id": true, "body": true}},
	}
	st, _ = f.signedPlatform(t, "platform.comment.ingest", http.MethodPost,
		"/api/v1/desktop/platform/comments", mustJSONBytes(t, batch))
	if st != http.StatusUnprocessableEntity {
		t.Fatalf("批量数组应 422：%d", st)
	}

	// 无设备证明拒绝：普通会话调用 403。
	st, _ = env.do("POST", "/api/v1/desktop/platform/comments", p04CommentResult("xhs", "xhs_user_id:p04fixture", "cmt-0004", "无证明"))
	if st != http.StatusForbidden {
		t.Fatalf("缺设备证明应 403：%d", st)
	}
}
