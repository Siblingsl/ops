package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// CF-P2-CXEF-06：与桌面端共用同一份 fixture（desktop/test/fixtures/cxef06-comment-facts.json），
// 两端各自验证「事实层 present 标记」与「确定性去重 ID」，避免只在一侧成立。
type cxef06Expected struct {
	platformCommentFact
	DedupeID string `json:"dedupe_id"`
}

type cxef06Fixture struct {
	Schema             string           `json:"schema"`
	Platform           string           `json:"platform"`
	ExternalAccountKey string           `json:"external_account_key"`
	NoteID             string           `json:"note_id"`
	Expected           []cxef06Expected `json:"expected"`
}

func loadCXEF06Fixture(t *testing.T) cxef06Fixture {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	var path string
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "desktop", "test", "fixtures", "cxef06-comment-facts.json")
		if _, statErr := os.Stat(candidate); statErr == nil {
			path = candidate
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if path == "" {
		t.Fatal("找不到跨语言共享 fixture：desktop/test/fixtures/cxef06-comment-facts.json")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fx cxef06Fixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if fx.Schema != platformCommentFactSchema || len(fx.Expected) != 3 {
		t.Fatalf("fixture schema/条目数不符：schema=%q items=%d", fx.Schema, len(fx.Expected))
	}
	return fx
}

func cxef06Result(fx cxef06Fixture, facts ...platformCommentFact) platformCommentResult {
	return platformCommentResult{
		Schema:             platformCommentFactSchema,
		Platform:           fx.Platform,
		ExternalAccountKey: fx.ExternalAccountKey,
		Items:              facts,
	}
}

// 去重键：同一条平台评论恒等，换平台 / 换账号 / 换评论 id 必须不同；共享 fixture 钉住两端算法。
func TestPlatformSyncCommentDedupeIDIsStableAndScoped(t *testing.T) {
	fx := loadCXEF06Fixture(t)
	for _, want := range fx.Expected {
		got := platformCommentDedupeID(fx.Platform, fx.ExternalAccountKey, want.CommentID)
		if got != want.DedupeID {
			t.Fatalf("去重 ID 与共享 fixture 不一致：comment=%s got=%s want=%s", want.CommentID, got, want.DedupeID)
		}
		if _, err := uuid.Parse(got); err != nil {
			t.Fatalf("去重 ID 不是合法 uuid：%s", got)
		}
		if again := platformCommentDedupeID(fx.Platform, fx.ExternalAccountKey, want.CommentID); again != got {
			t.Fatalf("去重 ID 不稳定：%s != %s", again, got)
		}
	}
	base := platformCommentDedupeID(fx.Platform, fx.ExternalAccountKey, fx.Expected[0].CommentID)
	for name, other := range map[string]string{
		"换平台": platformCommentDedupeID("wechat_mp", fx.ExternalAccountKey, fx.Expected[0].CommentID),
		"换账号": platformCommentDedupeID(fx.Platform, "another-account", fx.Expected[0].CommentID),
		"换评论": platformCommentDedupeID(fx.Platform, fx.ExternalAccountKey, "another-comment"),
	} {
		if other == base {
			t.Fatalf("%s 后去重 ID 不应相同：%s", name, other)
		}
	}
}

// 单条入库 + 重放幂等 + 隐私（不落真实昵称）+ 不冒充手工录入。
func TestPlatformSyncCommentFactIngestIsSingleItemAndIdempotent(t *testing.T) {
	fx := loadCXEF06Fixture(t)
	ctx := context.Background()
	account := env.accounts(t).xhs // 只读使用共享夹具，不改其状态；写入全部在本事务内回滚
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	fact := fx.Expected[0].platformCommentFact
	result := cxef06Result(fx, fact)
	captured := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

	id, inserted, err := ingestPlatformCommentResultTx(ctx, tx, result, workspaceID, account.ID, captured)
	if err != nil {
		t.Fatalf("单条入库失败：%v", err)
	}
	if !inserted || id != fx.Expected[0].DedupeID {
		t.Fatalf("首次入库应插入且返回确定性 ID：inserted=%v id=%s", inserted, id)
	}
	// 同一条评论重放：ON CONFLICT (id) DO NOTHING，不重复建行、不报错。
	replayID, replayInserted, err := ingestPlatformCommentResultTx(ctx, tx, result, workspaceID, account.ID, captured)
	if err != nil {
		t.Fatalf("重放不应报错：%v", err)
	}
	if replayInserted || replayID != id {
		t.Fatalf("重放必须幂等：inserted=%v id=%s", replayInserted, replayID)
	}
	var rows int
	var content, alias string
	var workID, createdBy *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM comment_inbox WHERE id=$1`, id).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("重放后应仍只有一行：%d", rows)
	}
	if err := tx.QueryRow(ctx, `SELECT content,author_alias,work_id,created_by FROM comment_inbox WHERE id=$1`, id).
		Scan(&content, &alias, &workID, &createdBy); err != nil {
		t.Fatal(err)
	}
	if content != strings.TrimSpace(*fact.Body) {
		t.Fatalf("入库正文与事实不一致：%q", content)
	}
	// 隐私：平台昵称只留在事实层，comment_inbox 不持久化真实昵称。
	if alias != "" || strings.Contains(alias, "读者甲") {
		t.Fatalf("author_alias 必须为空，不得落平台昵称：%q", alias)
	}
	if workID != nil || createdBy != nil {
		t.Fatalf("本地链路不得冒充手工绑定作品或用户：work_id=%v created_by=%v", workID, createdBy)
	}
	// 一次只准一条：两条同时提交直接拒绝，且不产生额外行。
	batch := cxef06Result(fx, fact, fx.Expected[1].platformCommentFact)
	if _, _, err := ingestPlatformCommentResultTx(ctx, tx, batch, workspaceID, account.ID, captured); err == nil {
		t.Fatal("批量 comment 结果必须被拒绝（D-117 不新增全部入库能力）")
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM comment_inbox WHERE account_id=$1 AND id IN ($2,$3)`,
		account.ID, id, fx.Expected[1].DedupeID).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("批量被拒后不得写入第二条：%d", total)
	}
}

// 事实层：present:false / 原因码 / 字段矛盾一律拒绝，不把「没有」写成空串。
func TestPlatformSyncCommentFactsRejectAbsentFields(t *testing.T) {
	fx := loadCXEF06Fixture(t)
	ctx := context.Background()
	account := env.accounts(t).xhs
	var workspaceID uuid.UUID
	if err := env.srv.db.QueryRow(ctx, `SELECT workspace_id FROM platform_account WHERE id=$1`, account.ID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	tx, err := env.srv.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	captured := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

	// fixture 第三条：正文字段给了空白串 → present.body=false + reason=empty_body。
	emptyBody := fx.Expected[2].platformCommentFact
	if emptyBody.Present.Body || emptyBody.Reason == nil || *emptyBody.Reason != "empty_body" {
		t.Fatalf("fixture 第三条应是不可读事实：%+v", emptyBody)
	}
	if _, _, err := ingestPlatformCommentResultTx(ctx, tx, cxef06Result(fx, emptyBody), workspaceID, account.ID, captured); err == nil {
		t.Fatal("empty_body 事实不得入库")
	}
	var rows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM comment_inbox WHERE id=$1`, fx.Expected[2].DedupeID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("不可读事实不得产生行：%d", rows)
	}

	// present 标记与字段值矛盾：声明 present 但缺值、未声明 present 却带值，都拒绝。
	missing := fx.Expected[0].platformCommentFact
	missing.Present.Author = true
	missing.Author = nil
	if err := validatePlatformCommentFact(missing); err == nil {
		t.Fatal("声明 author present 却缺值必须拒绝")
	}
	extra := fx.Expected[1].platformCommentFact
	nickname := "读者乙"
	extra.Author = &nickname
	if err := validatePlatformCommentFact(extra); err == nil {
		t.Fatal("未声明 author present 却携带昵称必须拒绝")
	}
	noID := fx.Expected[0].platformCommentFact
	noID.Present.CommentID = false
	if err := validatePlatformCommentFact(noID); err == nil {
		t.Fatal("评论 id 缺 present 标记必须拒绝")
	}
}

// 入口严格解码：单条约束、未知字段、schema、多 JSON 值。
func TestPlatformSyncCommentResultRejectsBatchAndUnknownFields(t *testing.T) {
	fx := loadCXEF06Fixture(t)
	valid := cxef06Result(fx, fx.Expected[0].platformCommentFact)
	raw, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodePlatformCommentResult(raw); err != nil {
		t.Fatalf("共享 fixture 驱动的单条结果应可解码：%v", err)
	}

	twoItems, _ := json.Marshal(cxef06Result(fx, fx.Expected[0].platformCommentFact, fx.Expected[1].platformCommentFact))
	noItems, _ := json.Marshal(cxef06Result(fx))
	withExtra := strings.Replace(string(raw), "{", `{"unexpected":1,`, 1)
	badSchema := strings.Replace(string(raw), platformCommentFactSchema, "unknown-schema", 1)
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"批量两条", string(twoItems), "只接受单条"},
		{"空数组", string(noItems), "只接受单条"},
		{"未知字段", withExtra, "schema 无效"},
		{"schema 不符", badSchema, "schema 版本不受支持"},
		{"多个 JSON 值", string(raw) + string(raw), "只能包含一个 JSON 值"},
		{"空输入", "null", "不能为空"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodePlatformCommentResult([]byte(tc.raw))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("期望拒绝并含 %q，实际 err=%v", tc.want, err)
			}
		})
	}
}
