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
	// 乱序隔离（A22）：建供应商属敏感操作，会话 reauth 窗口可能已被其它用例用过或清空，
	// 本用例显式重新确认一次（不依赖执行顺序）。
	env.reauth(t)
	var provider struct {
		ID string `json:"id"`
	}
	env.mustJSON(t, "POST", "/api/v1/model-providers", map[string]any{
		"name": "评论拟稿模拟模型", "base_url": env.mock.URL + "/v1", "api_key": "opt52-local-mock-key", "models": []string{"mock-writer"},
	}, &provider)
	env.mustJSON(t, "PUT", "/api/v1/model-routes", []map[string]any{{"task_type": "cx_comment_reply", "provider_id": provider.ID, "model": "mock-writer"}}, nil)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_route WHERE task_type='cx_comment_reply' AND provider_id=$1`, provider.ID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE id=$1`, provider.ID)
	})
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

// DEV-CX13-F / FR-CX-23 软提示联动：拟稿时读取账号当前生效的回复标准——
// 有标准时 audit 记 standard_version；无标准照常拟稿（version 0）。标准不阻断、不进评论数据。
func TestCXCommentReplySuggestReadsEffectiveStandard(t *testing.T) {
	ensureCommentReplyRoute(t)
	// 独立账号：本用例会创建生效标准，不得污染共享 fixture（同 D-160 批次对
	// TestCXStandardChangedFlag 的处理），否则 TestCXOpsStandardVersionsAndEffectiveQuery
	// 的 v1 创建会撞 409 version_conflict。
	var fresh Account
	env.mustJSON(t, "POST", "/api/v1/accounts", map[string]string{"platform": "xhs", "name": "拟稿标准联动专用号", "content_format": "image_note"}, &fresh)
	account := fresh

	post := func(content string) commentInboxItem {
		var item commentInboxItem
		status, body := env.do("POST", "/api/v1/comments", map[string]any{"account_id": account.ID, "content": content})
		if status != 201 {
			t.Fatalf("create comment: %d %s", status, body)
		}
		_ = json.Unmarshal(body, &item)
		return item
	}
	draft := func(item commentInboxItem) {
		t.Helper()
		status, body := env.do("POST", "/api/v1/comment-inbox/"+item.ID+"/reply-suggest", map[string]any{"base_revision": item.Revision})
		if status != 200 {
			t.Fatalf("reply-suggest: %d %s", status, body)
		}
	}
	lastAuditVersion := func(itemID string) int {
		t.Helper()
		var detail []byte
		if err := env.srv.db.QueryRow(context.Background(), `SELECT detail FROM audit_log WHERE action='comment_reply_draft' AND target_id=$1 ORDER BY created_at DESC LIMIT 1`, itemID).Scan(&detail); err != nil {
			t.Fatal(err)
		}
		var d struct {
			StandardVersion int `json:"standard_version"`
		}
		if err := json.Unmarshal(detail, &d); err != nil {
			t.Fatal(err)
		}
		return d.StandardVersion
	}

	// 无标准：拟稿照常，audit standard_version=0。
	noStd := post("这篇的排版思路对我很有帮助，请问图片模板可以分享吗？")
	draft(noStd)
	if v := lastAuditVersion(noStd.ID); v != 0 {
		t.Fatalf("no standard must record version 0: %d", v)
	}

	// 建当前生效标准（owner；effective_from=今天，账号时区）。
	today := time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
	status, body := env.do("POST", "/api/v1/accounts/"+account.ID.String()+"/standards", map[string]any{
		"base_version": 0, "positioning": "面向个人记录型作者的陪伴式分享，语气平实、直接",
		"text_rules":   []map[string]any{{"text": "回复不超过三句话，先回应问题再给一步行动"}}, 
		"effective_from": today,
	})
	if status != 201 {
		t.Fatalf("create standard: %d %s", status, body)
	}

	// 有标准：拟稿照常成功，audit standard_version=1；标准文本不进评论数据。
	withStd := post("评论区总问我用什么工具，能列一个清单吗？")
	draft(withStd)
	if v := lastAuditVersion(withStd.ID); v != 1 {
		t.Fatalf("effective standard must be recorded: %d", v)
	}
	var stored string
	if err := env.srv.db.QueryRow(context.Background(), `SELECT content FROM comment_inbox WHERE id=$1`, withStd.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "陪伴式分享") {
		t.Fatal("standard text must not leak into comment_inbox")
	}
}
