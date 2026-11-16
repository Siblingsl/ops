package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CF-P2-CXEF-06｜本人作品评论授权读取的 mock 适配器集成（续 CF-P2-CXEF-02）。
//
// 边界（docs/24 FR-CX-22、docs/27 C09/W17c、docs/34 §14.2）：
//   - 这里定义的是**本地** comment 结果类型，不是 platform_sync v2 协议里的 result_type。
//     v2 的结果类型白名单位于票据/派单/阶段矩阵（desktop_auth.go、platform_sync.go、
//     platformV2StageAllowed），涉及尚未定稿的产品授权文案；本项不扩大该契约、不改票据、
//     不改阶段矩阵、不新增任何 HTTP 端点或发送路径。
//   - 只接受**单条**结果（逐条入库）；不提供批量入库 / 全部采集 / 全部执行入口（D-117）。
//   - comment_inbox 无外部评论 ID 列。去重靠确定性 UUID 作为主键：
//     sha256("CF-P2-CXEF-06" <US> platform <US> externalAccountKey <US> commentID) 的前 16 字节，
//     按 8-4-4-4-12 排成 uuid 文本。同一条平台评论重复上报时 ON CONFLICT (id) DO NOTHING，
//     不需要迁移、不需要新列，也不依赖调用方记住上次写到哪里。
//   - 隐私：author / published_at / parent_comment_id 只留在事实层，不写 comment_inbox。
//     author_alias 恒为空串——迁移 00082 明确「无 author_raw，默认不持久化真实昵称」；
//     平台昵称属于非必要内容，不得借适配器读取链路绕过该约束。
//   - 事实缺失一律 present:false + 原因码，绝不把「没有」写成空串；不可读的事实拒绝入库。
//
// 本文件目前只被定向测试调用：宿主真实授权读取链路（CDP 会话 → 服务端）尚未接线，
// 因此不声称评论采集已可达、不抬交%、不标 done。

const platformCommentFactSchema = "cxef06-comment-facts-v1"

var platformCommentReasons = map[string]bool{
	"comment_source_missing": true,
	"permission_denied":      true,
	"read_failed":            true,
	"parse_failed":           true,
	"comment_absent":         true,
	"body_absent":            true,
	"empty_body":             true,
}

// platformCommentPresence 给六个字段逐个打 present 标记，缺字段与空值严格区分。
type platformCommentPresence struct {
	CommentID       bool `json:"comment_id"`
	NoteID          bool `json:"note_id"`
	Author          bool `json:"author"`
	Body            bool `json:"body"`
	PublishedAt     bool `json:"published_at"`
	ParentCommentID bool `json:"parent_comment_id"`
}

// platformCommentFact 是桌面适配器产出、服务端消费的规范化评论事实。
// 指针字段为 nil 表示「没有这个事实」，不是空串。
type platformCommentFact struct {
	CommentID       string                  `json:"comment_id"`
	NoteID          string                  `json:"note_id"`
	Author          *string                 `json:"author"`
	Body            *string                 `json:"body"`
	PublishedAt     *string                 `json:"published_at"`
	ParentCommentID *string                 `json:"parent_comment_id"`
	Present         platformCommentPresence `json:"present"`
	Reason          *string                 `json:"reason"`
}

// platformCommentResult 是本项的 comment 结果类型。Items 长度必须为 1：
// 逐条入库是产品红线，不做成批量接收器。
type platformCommentResult struct {
	Schema             string                `json:"schema"`
	Platform           string                `json:"platform"`
	ExternalAccountKey string                `json:"external_account_key"`
	Items              []platformCommentFact `json:"items"`
}

// decodePlatformCommentResult 严格解码：未知字段、多个 JSON 值、schema 不符、
// 非单条一律拒绝。放在入口是为了让「多塞一个字段就能绕过 present 校验」不成立。
func decodePlatformCommentResult(raw []byte) (platformCommentResult, error) {
	var result platformCommentResult
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return result, validation("comment 结果不能为空")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&result); err != nil {
		return result, validation("comment 结果 schema 无效")
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return result, validation("comment 结果只能包含一个 JSON 值")
	}
	if err := validatePlatformCommentResult(result); err != nil {
		return platformCommentResult{}, err
	}
	return result, nil
}

func validatePlatformCommentResult(result platformCommentResult) error {
	if result.Schema != platformCommentFactSchema {
		return validation("comment 结果 schema 版本不受支持")
	}
	if result.Platform != "xhs" && result.Platform != "wechat_mp" {
		return validation("comment 结果平台不受支持")
	}
	if !validPlatformExternalID(result.ExternalAccountKey) {
		return validation("comment 结果缺少已核验的平台账号标识")
	}
	if len(result.Items) != 1 {
		// 批量数组（含空数组）直接拒绝：不新增「全部入库」能力（D-117）。
		return validation("comment 结果只接受单条，逐条入库")
	}
	return nil
}

// platformCommentDedupeID 与桌面适配器 commentDedupeId 使用同一算法，
// 共享 fixture 里的 dedupe_id 同时钉住两端实现。
func platformCommentDedupeID(platform, externalAccountKey, commentID string) string {
	key := strings.Join([]string{"CF-P2-CXEF-06", platform, externalAccountKey, commentID}, "\x1f")
	digest := sha256.Sum256([]byte(key))
	hexDigest := hex.EncodeToString(digest[:])
	return strings.Join([]string{
		hexDigest[0:8], hexDigest[8:12], hexDigest[12:16], hexDigest[16:20], hexDigest[20:32],
	}, "-")
}

func validatePlatformCommentFact(fact platformCommentFact) error {
	if fact.Reason != nil {
		if *fact.Reason == "" || !platformCommentReasons[*fact.Reason] {
			return validation("comment 事实原因码无效")
		}
		return validation("comment 事实不可读，原因码 " + *fact.Reason)
	}
	if !fact.Present.CommentID || !fact.Present.NoteID {
		return validation("comment 事实缺少评论或笔记标识的 present 标记")
	}
	if !validPlatformExternalID(fact.CommentID) || !validPlatformExternalID(fact.NoteID) {
		return validation("comment 事实的评论或笔记标识无效")
	}
	if err := checkCommentPresentField("author", fact.Present.Author, fact.Author); err != nil {
		return err
	}
	if err := checkCommentPresentField("body", fact.Present.Body, fact.Body); err != nil {
		return err
	}
	if err := checkCommentPresentField("published_at", fact.Present.PublishedAt, fact.PublishedAt); err != nil {
		return err
	}
	if err := checkCommentPresentField("parent_comment_id", fact.Present.ParentCommentID, fact.ParentCommentID); err != nil {
		return err
	}
	if fact.Body == nil || len([]rune(strings.TrimSpace(*fact.Body))) < 1 ||
		len([]rune(strings.TrimSpace(*fact.Body))) > commentContentMax {
		return validation("评论正文须为 1..5000 码点")
	}
	if fact.Present.PublishedAt && fact.PublishedAt != nil {
		if _, err := time.Parse(time.RFC3339, *fact.PublishedAt); err != nil {
			return validation("comment 事实的发布时间不是 RFC3339")
		}
	}
	return nil
}

func checkCommentPresentField(name string, present bool, value *string) error {
	if present && (value == nil || strings.TrimSpace(*value) == "") {
		return validation("comment 事实声明 " + name + " present 但缺少字段值")
	}
	if !present && value != nil {
		return validation("comment 事实未声明 " + name + " present 却携带字段值")
	}
	return nil
}

// ingestPlatformCommentResultTx 把**一条**评论事实写入 comment_inbox。
// 返回确定性主键与是否真的插入（重复上报时 inserted=false，不报错、不重复建行）。
// 调用方持有事务；本函数不开事务、不发 HTTP、不做任何发送动作。
func ingestPlatformCommentResultTx(ctx context.Context, tx pgx.Tx, result platformCommentResult,
	workspaceID, accountID uuid.UUID, capturedAt time.Time) (string, bool, error) {
	if err := validatePlatformCommentResult(result); err != nil {
		return "", false, err
	}
	fact := result.Items[0]
	if err := validatePlatformCommentFact(fact); err != nil {
		return "", false, err
	}
	id := platformCommentDedupeID(result.Platform, result.ExternalAccountKey, fact.CommentID)
	parsedID, err := uuid.Parse(id)
	if err != nil {
		return "", false, err
	}
	if workspaceID == uuid.Nil || accountID == uuid.Nil {
		return "", false, validation("comment 入库缺少工作区或账号范围")
	}
	if capturedAt.IsZero() {
		capturedAt = time.Now()
	}
	// author_alias 留空、work_id 留空、created_by 留空：本地链路不冒充用户手工录入，
	// 不持久化平台昵称，也不猜测外部笔记与本地 work 的绑定关系。
	tag, err := tx.Exec(ctx, `INSERT INTO comment_inbox
		(id,workspace_id,account_id,work_id,author_alias,content,captured_at,created_by)
		VALUES ($1,$2,$3,NULL,'',$4,$5,NULL)
		ON CONFLICT (id) DO NOTHING`, parsedID, workspaceID, accountID,
		strings.TrimSpace(*fact.Body), capturedAt)
	if err != nil {
		return "", false, err
	}
	return parsedID.String(), tag.RowsAffected() == 1, nil
}
