package app

// REF41 P8 生产 runner：只处理 queued + api 的发布任务，走
// Preflight → Fill → Readback 后落 filled。公众号 API 在 filled 事务内按
// 方案 A 写入作品草稿回执与 submitted 里程碑，随后把任务推进到 submitted；
// 仍不调用执行器 Submit，也不发布/群发。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	publishAPIRunnerBatch = 4
	publishRunnerLease    = 10 * time.Minute
)

// publishAPIRunnerJob 每分钟处理有限条 queued api 任务；单条失败只落 failed，
// 不阻断其他任务，也不把异常吞成成功。
func (s *Server) publishAPIRunnerJob(ctx context.Context) {
	for i := 0; i < publishAPIRunnerBatch; i++ {
		done, err := s.runOnePublishAPITask(ctx)
		if err != nil {
			slog.Error("发布 API runner 失败", "err", err)
			return
		}
		if !done {
			return
		}
	}
}

func (s *Server) runOnePublishAPITask(ctx context.Context) (bool, error) {
	task, err := s.findQueuedAPIPublishTask(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	registry := s.publishExecutors
	if registry == nil {
		return true, nil
	}
	runnerCtx := publishRunnerContext(ctx, task)
	claimed, err := s.transitionPublishTask(runnerCtx, task, publishTaskTransitionInput{
		To:             "filling",
		IdempotencyKey: "api-runner:claim:" + task.ID.String() + ":" + fmt.Sprint(task.StateVersion),
		Evidence: map[string]any{
			"runner":           "server-api",
			"lease_expires_at": s.now().Add(publishRunnerLease).UTC().Format(time.RFC3339Nano),
		},
	}, true)
	if err != nil {
		// 另一实例或用户已推进版本：跳过本轮，不覆盖当前状态。
		return true, nil
	}
	exec, ok := registry.Lookup(claimed.Platform, "api")
	if !ok {
		return s.failPublishRunnerTask(runnerCtx, claimed, "executor_not_registered", "发布执行器未注册")
	}

	req, err := s.publishRunnerFillRequest(runnerCtx, claimed, exec)
	if err != nil {
		return s.failPublishRunnerTask(runnerCtx, claimed, PublishExecutorErrorCode(err), publishRunnerErrorText(err))
	}
	result, err := RunPublishExecutorFillOnly(ctx, exec, req, DefaultPublishExecutorTimeouts())
	if err != nil {
		return s.failPublishRunnerTask(runnerCtx, claimed, PublishExecutorErrorCode(err), publishRunnerErrorText(err))
	}
	if result.State != "filled" {
		code := result.ErrorCode
		if code == "" {
			code = "executor_failed"
		}
		message := result.ErrorMessage
		if message == "" {
			message = "发布执行器未返回 filled"
		}
		return s.failPublishRunnerTask(runnerCtx, claimed, code, message)
	}
	if result.Readback != nil {
		if ok, _ := result.Readback["ok"].(bool); !ok {
			return s.failPublishRunnerTask(runnerCtx, claimed, "readback_mismatch", "回读不一致，禁止提交")
		}
	}
	evidence := map[string]any{
		"runner":          "server-api",
		"executor":        exec.Name(),
		"adapter_version": exec.Version(),
		"readback":        result.Readback,
		"readback_ok":     true,
	}
	for key, value := range result.Evidence {
		evidence[key] = value
	}
	if claimed.Platform == "wechat_mp" && claimed.Mode == "api" &&
		strings.TrimSpace(stringEvidence(evidence, "draft_media_id")) == "" {
		return s.failPublishRunnerTask(runnerCtx, claimed, "wechat_draft_missing", "公众号 API 已填入但缺少草稿编号")
	}
	filledTask, err := s.transitionPublishTask(runnerCtx, claimed, publishTaskTransitionInput{
		To:             "filled",
		IdempotencyKey: "api-runner:filled:" + claimed.ID.String() + ":" + fmt.Sprint(claimed.StateVersion),
		Evidence:       evidence,
	}, false)
	if err != nil {
		return true, err
	}
	if filledTask.Platform == "wechat_mp" && filledTask.Mode == "api" {
		// 方案 A：draft/add + 回读一致即视为已提交草稿箱，不调用执行器 Submit；
		// filled 事务已写入作品回执和 submitted 里程碑，这里只推进任务状态。
		if _, err := s.transitionPublishTask(runnerCtx, filledTask, publishTaskTransitionInput{
			To:             "submitted",
			IdempotencyKey: "api-runner:submitted:" + filledTask.ID.String() + ":" + fmt.Sprint(filledTask.StateVersion),
			Evidence:       filledTask.Evidence,
		}, false); err != nil {
			return true, err
		}
	}
	return true, nil
}

func (s *Server) findQueuedAPIPublishTask(ctx context.Context) (*PublishTask, error) {
	return scanPublishTask(s.db.QueryRow(ctx, `SELECT `+publishTaskCols+` FROM publish_task t
		WHERE t.state='queued' AND t.mode='api'
		  AND (t.next_retry_at IS NULL OR t.next_retry_at <= now())
		  AND (t.plan_at IS NULL OR t.plan_at <= now())
		ORDER BY t.created_at ASC LIMIT 1`))
}

func publishRunnerContext(ctx context.Context, task *PublishTask) context.Context {
	createdBy := uuid.Nil
	if task.CreatedBy != nil {
		createdBy = *task.CreatedBy
	}
	return context.WithValue(ctx, ctxMember, &identity{
		UserID: createdBy, WorkspaceID: task.WorkspaceID,
		Username: "publish-api-runner", Role: "owner",
	})
}

func (s *Server) publishRunnerFillRequest(ctx context.Context, task *PublishTask, exec PublishExecutor) (PublishFillRequest, error) {
	manifest, err := s.loadPublishManifest(ctx, task.WorkID, task.Platform)
	if err != nil {
		return PublishFillRequest{}, err
	}
	raw, err := json.Marshal(manifest.Payload)
	if err != nil {
		return PublishFillRequest{}, err
	}
	req := PublishFillRequest{
		TaskID: task.ID, WorkspaceID: task.WorkspaceID, AccountID: task.AccountID,
		WorkID: task.WorkID, Platform: task.Platform, Manifest: raw, Mode: "api",
	}
	if _, ok := exec.(*wechatMPAPIExecutor); ok {
		token, err := s.publishRunnerWechatToken(ctx, task.AccountID)
		if err != nil {
			return req, err
		}
		cover, name, err := s.publishRunnerCover(ctx, task, manifest.Payload.Assets)
		if err != nil {
			return req, err
		}
		req.WechatToken, req.WechatCover, req.WechatCoverName = token, cover, name
	}
	return req, nil
}

func (s *Server) publishRunnerWechatToken(ctx context.Context, accountID uuid.UUID) (string, error) {
	var enc []byte
	var expiresAt time.Time
	err := s.db.QueryRow(ctx, `SELECT access_token_enc, expires_at FROM wechat_token WHERE account_id=$1`, accountID).
		Scan(&enc, &expiresAt)
	if err == nil && expiresAt.After(s.now().Add(30*time.Second)) {
		token, err := s.box.Decrypt(enc)
		if err != nil {
			return "", NewPublishExecutorError("wechat_credential_invalid", "公众号 token 无法解密")
		}
		return token, nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	var appID string
	var secretEnc []byte
	if err := s.db.QueryRow(ctx, `SELECT app_id, app_secret_enc FROM wechat_credential WHERE account_id=$1`, accountID).
		Scan(&appID, &secretEnc); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", NewPublishExecutorError("wechat_credential_missing", "公众号未配置 AppID/AppSecret")
		}
		return "", err
	}
	secret, err := s.box.Decrypt(secretEnc)
	if err != nil {
		return "", NewPublishExecutorError("wechat_credential_invalid", "公众号密钥无法解密")
	}
	if s.wx == nil {
		return "", NewPublishExecutorError("executor_not_configured", "公众号客户端未配置")
	}
	tok, err := s.wx.GetToken(ctx, appID, secret)
	if err != nil {
		return "", NewPublishExecutorError("wechat_token_failed", err.Error())
	}
	if strings.TrimSpace(tok.AccessToken) == "" {
		return "", NewPublishExecutorError("wechat_token_missing", "公众号 access_token 为空")
	}
	encToken, err := s.box.Encrypt(tok.AccessToken)
	if err != nil {
		return "", err
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO wechat_token (account_id, access_token_enc, key_version, expires_at)
		VALUES ($1,$2,$3,$4) ON CONFLICT (account_id) DO UPDATE SET access_token_enc=$2, key_version=$3, expires_at=$4`,
		accountID, encToken, s.box.Version, s.now().Add(time.Duration(tok.ExpiresIn)*time.Second)); err != nil {
		return "", err
	}
	return tok.AccessToken, nil
}

func (s *Server) publishRunnerCover(ctx context.Context, task *PublishTask, assets []PublishManifestAsset) ([]byte, string, error) {
	items, err := s.publishTaskClaimAssets(ctx, task, assets)
	if err != nil {
		return nil, "", err
	}
	chosen := map[string]any(nil)
	for _, item := range items {
		if item["role"] == "cover" {
			chosen = item
			break
		}
	}
	if chosen == nil && len(items) > 0 {
		chosen = items[0]
	}
	if chosen == nil {
		return nil, "", NewPublishExecutorError("wechat_cover_missing", "公众号草稿必须有封面图")
	}
	raw, _ := chosen["data"].(string)
	cover, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(cover) == 0 {
		return nil, "", NewPublishExecutorError("wechat_cover_invalid", "公众号封面图数据无法读取")
	}
	name := "cover.png"
	if id, _ := chosen["asset_id"].(string); len(id) >= 8 {
		name = "cover-" + id[:8] + ".png"
	}
	return cover, name, nil
}

func (s *Server) failPublishRunnerTask(ctx context.Context, task *PublishTask, code, message string) (bool, error) {
	if task == nil {
		return true, nil
	}
	code = truncatePublishRunnerText(code, 80)
	message = truncatePublishRunnerText(message, 500)
	if code == "" {
		code = "executor_failed"
	}
	if message == "" {
		message = "发布执行器失败"
	}
	_, err := s.transitionPublishTask(ctx, task, publishTaskTransitionInput{
		To:             "failed",
		IdempotencyKey: "api-runner:failed:" + task.ID.String() + ":" + fmt.Sprint(task.StateVersion),
		ErrorCode:      code,
		ErrorMessage:   message,
		Evidence:       map[string]any{"runner": "server-api"},
	}, false)
	if err != nil {
		return true, err
	}
	return true, nil
}

func publishRunnerErrorText(err error) string {
	if err == nil {
		return "发布执行器失败"
	}
	var pe *PublishExecutorError
	if errors.As(err, &pe) {
		if strings.TrimSpace(pe.Message) != "" {
			return pe.Message
		}
		return pe.Code
	}
	return err.Error()
}

func truncatePublishRunnerText(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
