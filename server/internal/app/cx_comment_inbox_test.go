package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// DEV-CX13-E / FR-CX-22 / T-CX22：评论台账 API——
// 批量拒绝、逐条入库、CAS、状态机（copied 必须显式回执、sent_manual 必须确认）、
// 删除清正文、转选题幂等、无 author_raw。
type commentInboxItem struct {
	ID            string     `json:"id"`
	AuthorAlias   string     `json:"author_alias"`
	Content       string     `json:"content"`
	Category      *string    `json:"category"`
	ReplyDraft    string     `json:"reply_draft"`
	ReplyStatus   string     `json:"reply_status"`
	Revision      int        `json:"revision"`
	ReplyRevision int        `json:"reply_revision"`
	CopiedAt      *time.Time `json:"copied_at"`
	SentManualAt  *time.Time `json:"sent_manual_at"`
}

func ensureCommentReplyRoute(t *testing.T) {
	t.Helper()
	var provider struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "评论拟稿模拟模型", "base_url": env.mock.URL + "/v1", "api_key": "opt52-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "cx_comment_reply", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
}

func TestCXCommentInboxSinglePostStateMachinesAndDeletion(t *testing.T) {
	ensureCommentReplyRoute(t)
	account := env.accounts(t).xhs

	// 批量数组拒绝。
	status, body := env.do("POST", "/api/v1/comments", []map[string]any{{"content": "第一条"}, {"content": "第二条"}})
	if status != 422 {
		t.Fatalf("batch POST must be rejected: status=%d body=%s", status, body)
	}

	// 逐条入库：无 author_raw 字段于请求侧；正文 1..5000。
	var created commentInboxItem
	status, body = env.do("POST", "/api/v1/comments", map[string]any{
		"account_id": account.ID, "author_alias": "读者甲", "content": "这篇的步骤写得很清楚，但第二步的依据是什么？",
	})
	if status != 201 || json.Unmarshal(body, &created) != nil {
		t.Fatalf("create: status=%d body=%s", status, body)
	}
	// 空正文/超长拒绝。
	status, _ = env.do("POST", "/api/v1/comments", map[string]any{"account_id": account.ID, "content": "  "})
	if status != 422 {
		t.Fatalf("blank content must 422: %d", status)
	}
	status, _ = env.do("POST", "/api/v1/comments", map[string]any{"account_id": account.ID, "content": strings.Repeat("长", 5001)})
	if status != 422 {
		t.Fatalf("overlong content must 422: %d", status)
	}

	// 无参考直接 AI 拟稿：分类 + ≤80 草稿；reply_status none→drafted。
	status, body = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/reply-suggest", map[string]any{"base_revision": created.Revision})
	if status != 200 {
		t.Fatalf("draft reply: status=%d body=%s", status, body)
	}
	var drafted commentInboxItem
	_ = json.Unmarshal(body, &drafted)
	if drafted.ReplyStatus != "drafted" || drafted.ReplyDraft == "" || len([]rune(drafted.ReplyDraft)) > 80 {
		t.Fatalf("draft state: %+v", drafted)
	}
	if drafted.Category == nil || *drafted.Category != "question" {
		t.Fatalf("mock must classify question: %+v", drafted.Category)
	}

	// 客户端复制成功回执：copied；sent_manual 必须显式确认。
	status, body = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/copy-reply", map[string]any{"base_revision": drafted.Revision})
	if status != 200 {
		t.Fatalf("copy receipt: status=%d body=%s", status, body)
	}
	var copied commentInboxItem
	_ = json.Unmarshal(body, &copied)
	if copied.ReplyStatus != "copied" || copied.CopiedAt == nil {
		t.Fatalf("copied state: %+v", copied)
	}
	// 未复制前确认已发必须拒绝。
	status, _ = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/confirm-sent", map[string]any{"base_revision": copied.Revision})
	if status != 200 {
		t.Fatalf("copied → confirm path: %d", status)
	}
	var sent commentInboxItem
	env.mustJSON(t, "GET", "/api/v1/comment-inbox/"+created.ID, nil, &sent)
	if sent.ReplyStatus != "sent_manual" || sent.SentManualAt == nil {
		t.Fatalf("sent_manual state: %+v", sent)
	}

	// 重拟创建新草稿 revision 并清除 sent 证明（按 9.8：重拟不表示撤回旧平台回复）。
	status, body = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/reply-suggest", map[string]any{"base_revision": sent.Revision})
	if status != 200 {
		t.Fatalf("re-draft: status=%d body=%s", status, body)
	}
	var redrafted commentInboxItem
	_ = json.Unmarshal(body, &redrafted)
	if redrafted.ReplyRevision != sent.ReplyRevision+1 || redrafted.ReplyStatus != "drafted" || redrafted.SentManualAt != nil {
		t.Fatalf("re-draft must bump reply_revision and clear sent proof: %+v", redrafted)
	}

	// CAS：陈旧 revision 拒绝（行版本只随分类/正文编辑推进；草稿走 reply_revision）。
	status, body = env.do("PATCH", "/api/v1/comment-inbox/"+created.ID, map[string]any{"base_revision": redrafted.Revision + 5, "category": "praise"})
	if status != 409 || !strings.Contains(string(body), "version_conflict") {
		t.Fatalf("stale CAS must 409: status=%d body=%s", status, body)
	}
	// 编辑分类/正文正常，并推进行版本。
	status, body = env.do("PATCH", "/api/v1/comment-inbox/"+created.ID, map[string]any{"base_revision": redrafted.Revision, "category": "question"})
	if status != 200 {
		t.Fatalf("patch: %d %s", status, body)
	}
	var edited commentInboxItem
	_ = json.Unmarshal(body, &edited)
	if edited.Revision != redrafted.Revision+1 {
		t.Fatalf("content patch must bump row revision: %+v", edited)
	}

	// 删除清正文/草稿：库中 content/reply_draft/alias 全空，读取 404。
	status, _ = env.do("DELETE", "/api/v1/comment-inbox/"+created.ID, nil)
	if status != 200 {
		t.Fatalf("delete: %d", status)
	}
	status, _ = env.do("GET", "/api/v1/comment-inbox/"+created.ID, nil)
	if status != 404 {
		t.Fatalf("deleted detail must 404: %d", status)
	}
	var content, draft, alias string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT content,reply_draft,author_alias FROM comment_inbox WHERE id=$1`, created.ID).
		Scan(&content, &draft, &alias); err != nil {
		t.Fatal(err)
	}
	if content != "" || draft != "" || alias != "" {
		t.Fatalf("deleted row must be scrubbed: content=%q draft=%q alias=%q", content, draft, alias)
	}
}

func TestCXCommentInboxTopicConversionIdempotentAndListFilter(t *testing.T) {
	account := env.accounts(t).xhs
	listPath := "/api/v1/accounts/" + account.ID.String() + "/comments"
	var created commentInboxItem
	status, body := env.do("POST", "/api/v1/comments", map[string]any{
		"account_id": account.ID, "author_alias": "读者乙", "content": "能不能写一篇讲怎么坚持记录的？我总是三天就放弃。",
	})
	if status != 201 {
		t.Fatalf("create: %d %s", status, body)
	}
	_ = json.Unmarshal(body, &created)

	// 预览脱敏摘要（不写库）。
	status, body = env.do("GET", "/api/v1/comment-inbox/"+created.ID+"/topic-preview", nil)
	if status != 200 {
		t.Fatalf("preview: %d", status)
	}

	// 转为选题：source=manual；同 key 重放不重复建题。
	var firstConvert struct {
		Topic  struct{ ID string `json:"id"` } `json:"topic"`
		Reused bool                            `json:"reused"`
	}
	status, body = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/convert-topic", map[string]any{
		"title": "为什么坚持记录这么难", "idempotency_key": "cx22-topic-key-1",
	})
	if status != 201 || json.Unmarshal(body, &firstConvert) != nil {
		t.Fatalf("convert: status=%d body=%s", status, body)
	}
	var again struct {
		Topic  struct{ ID string `json:"id"` } `json:"topic"`
		Reused bool                            `json:"reused"`
	}
	status, body = env.do("POST", "/api/v1/comment-inbox/"+created.ID+"/convert-topic", map[string]any{
		"title": "为什么坚持记录这么难", "idempotency_key": "cx22-topic-key-1",
	})
	if status != 200 || json.Unmarshal(body, &again) != nil {
		t.Fatalf("replay: status=%d body=%s", status, body)
	}
	if !again.Reused || again.Topic.ID != firstConvert.Topic.ID {
		t.Fatalf("idempotent replay must return the same topic: %+v vs %+v", again, firstConvert)
	}
	var topicSource string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT source FROM topic WHERE id=$1`, firstConvert.Topic.ID).Scan(&topicSource); err != nil {
		t.Fatal(err)
	}
	if topicSource != "manual" {
		t.Fatalf("converted topic source must stay manual: %s", topicSource)
	}

	// 列表 category 过滤。
	status, body = env.do("GET", listPath+"?category=question", nil)
	var page struct {
		Items []commentInboxItem `json:"items"`
	}
	if status != 200 || json.Unmarshal(body, &page) != nil {
		t.Fatalf("list: %d %s", status, body)
	}
	for _, item := range page.Items {
		if item.Category == nil || *item.Category != "question" {
			t.Fatalf("filter leaked other categories: %+v", item.Category)
		}
	}
	// 默认无真实昵称：库里无 author_raw 列（迁移已保证），接口响应也不应出现。
	if strings.Contains(string(body), "author_raw") {
		t.Fatal("response must not expose an author_raw field")
	}
}
