package app

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// P0-4（CF-P2-CXEF-06 桌面消费接线）：评论单条上报 HTTP 入口。
//
// 边界（与 platform_comment_facts.go 的本地链路一致）：
//   - 设备证明操作 platform.comment.ingest（连接保管人本机，desktopProofPlatformAccountScope）；
//   - 复用本地 comment 结果类型与 ingestPlatformCommentResultTx：严格单条、确定性去重 UUID、
//     ON CONFLICT DO NOTHING 幂等；
//   - author / published_at / parent_comment_id 只留事实层，comment_inbox 不落昵称（00082）；
//   - 不扩 v2 结果类型白名单 / 阶段矩阵（产品授权文案未定，docs/37 §5 拍板项 4）；
//     本端点是本地链路的 HTTP 化，语义仍是「授权采集 run 中逐条读取、逐条上报」；
//   - 审计只记「上报了 1 条评论」事实与去重主键，不记内容、不记作者。

func (s *Server) desktopIngestPlatformComment(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	if err := s.pluginGuardlessDesktopGuard(id); err != nil {
		return err
	}
	body, _, err := s.desktopReadAndVerifyProof(r, "platform.comment.ingest")
	if err != nil {
		return err
	}
	result, err := decodePlatformCommentResult(body)
	if err != nil {
		return err
	}
	var accountID, workspaceID uuid.UUID
	var accountPlatform, externalKey string
	// 同一工作区可能同时存在同平台多个连接（例如巡检号与验收号）。优先选择与
	// 上报 external_account_key 精确匹配的活动连接；若没有匹配连接，仍取一条活动
	// 连接交给下面的身份核对返回 409，而不是把“账号不一致”误报成 404。
	if err := s.db.QueryRow(r.Context(), `
		SELECT c.account_id::text, c.workspace_id::text, c.platform, c.external_account_key
		FROM platform_connection c
		WHERE c.user_id=$1 AND c.workspace_id=$2 AND c.platform=$3 AND c.state='active'
		ORDER BY (c.external_account_key=$4) DESC, c.created_at
		LIMIT 1`, id.UserID, id.WorkspaceID, result.Platform, result.ExternalAccountKey).Scan(
		&accountID, &workspaceID, &accountPlatform, &externalKey); err != nil {
		if err == pgx.ErrNoRows {
			return apiErr(404, "not_found", "当前会话没有该平台的活动连接，评论上报缺少账号归属")
		}
		return err
	}
	// 上报的外部账号键必须与连接一致：采到别人的评论比采不到更糟（20 文档 §6.2 同款核对）。
	if result.ExternalAccountKey != externalKey {
		return apiErr(409, "platform_identity_mismatch", "评论归属账号与当前连接不一致")
	}
	capturedAt := time.Now()
	var insertedID string
	var inserted bool
	if err := s.withTx(r.Context(), func(tx pgx.Tx) error {
		var err error
		insertedID, inserted, err = ingestPlatformCommentResultTx(r.Context(), tx, result, workspaceID, accountID, capturedAt)
		return err
	}); err != nil {
		return err
	}
	s.audit(r.Context(), "platform_comment_ingest", "comment_inbox", insertedID, "ok",
		map[string]any{"platform": result.Platform, "account_id": accountID.String(), "inserted": inserted})
	writeJSON(w, http.StatusOK, map[string]any{
		"id": insertedID, "inserted": inserted,
		"note": "评论授权文案待产品拍板（docs/37 §5 拍板项 4）；本接口为设备保管人本机逐条上报，不批量、不自动采集。",
	})
	return nil
}

// pluginGuardlessDesktopGuard：评论上报与平台采集同源（保管人本机），这里只要求
// 已登录会话；viewer 角色无本机采集设备，设备证明本身已经把访问者限定到保管人。
func (s *Server) pluginGuardlessDesktopGuard(id *identity) error {
	if id == nil {
		return errUnauthenticated
	}
	return nil
}
