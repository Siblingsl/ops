package app

// REF41 P4：发布四态与平台能力矩阵。能力表是静态代码常量；账号凭证、
// 桌面在线、连接就绪与通道校准状态在请求时读取，不写库、不触发发布。
// 公开事实仍只由 work.status/markPublished 决定，能力矩阵不产生“已发布”。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type publishCapabilitySpec struct {
	Platform  string
	Channel   string
	Requires  []string
	Why       string
	DefaultOn bool
	Supported bool
}

// publishCapabilitySpecs 固定覆盖三平台 × 三通道，顺序用于 API 稳定输出。
var publishCapabilitySpecs = []publishCapabilitySpec{
	{Platform: "wechat_mp", Channel: "api", Requires: []string{"app_id_secret"},
		Why: "仅加草稿，不群发", DefaultOn: true, Supported: true},
	{Platform: "wechat_mp", Channel: "desktop", Requires: []string{},
		Why: "公众号桌面通道尚未开放", DefaultOn: false, Supported: false},
	{Platform: "wechat_mp", Channel: "manual", Requires: []string{},
		Why: "人工复制发布包", DefaultOn: true, Supported: true},

	{Platform: "xhs", Channel: "api", Requires: []string{},
		Why: "网页无官方发布接口，仅桌面填写", DefaultOn: false, Supported: false},
	{Platform: "xhs", Channel: "desktop", Requires: []string{"desktop_online", "account_login", "adapter_calibrated"},
		Why: "网页无官方发布接口，只填不点", DefaultOn: true, Supported: true},
	{Platform: "xhs", Channel: "manual", Requires: []string{},
		Why: "人工复制发布包", DefaultOn: true, Supported: true},

	{Platform: "toutiao", Channel: "api", Requires: []string{},
		Why: "网页无官方发布接口，仅桌面填写", DefaultOn: false, Supported: false},
	{Platform: "toutiao", Channel: "desktop", Requires: []string{"desktop_online", "account_login", "adapter_calibrated"},
		Why: "网页无官方发布接口，只填不点", DefaultOn: true, Supported: true},
	{Platform: "toutiao", Channel: "manual", Requires: []string{},
		Why: "人工复制发布包", DefaultOn: true, Supported: true},
}

const (
	publishCapabilityPlatforms = "wechat_mp,xhs,toutiao"
	publishCapabilityChannels  = "api,desktop,manual"
)

// PublishStateLabels 是四态文案唯一来源；前端不得自行拼“已发布”。
var PublishStateLabels = map[string]string{
	"packed":              "素材已备好",
	"filled":              "已填入后台",
	"awaiting_user":       "已填入后台（待你点发布）",
	"submitted":           "已交接",
	"submitted_wechat_mp": "已提交草稿箱",
	"published":           "已发布",
}

type PublishCapabilityChannel struct {
	Platform              string   `json:"platform"`
	Channel               string   `json:"channel"`
	Requires              []string `json:"requires"`
	Why                   string   `json:"why"`
	DefaultOn             bool     `json:"default_on"`
	Calibrated            bool     `json:"calibrated"`
	Available             bool     `json:"available"`
	DisabledReason        string   `json:"disabled_reason,omitempty"`
	Missing               []string `json:"missing,omitempty"`
	AdapterVersion        string   `json:"adapter_version,omitempty"`
	CurrentAdapterVersion string   `json:"current_adapter_version,omitempty"`
}

type PublishCapabilityPlatform struct {
	Platform string                     `json:"platform"`
	Channels []PublishCapabilityChannel `json:"channels"`
}

type publishCapabilitySignals struct {
	CredentialConfigured bool
	DesktopOnline        bool
	AccountLogin         bool
	CalibrationOK        bool
	CalibrationReason    string
	AdapterVersion       string
	CurrentVersion       string
}

func publishCapabilitySpecFor(platform, channel string) (publishCapabilitySpec, bool) {
	for _, spec := range publishCapabilitySpecs {
		if spec.Platform == platform && spec.Channel == channel {
			return spec, true
		}
	}
	return publishCapabilitySpec{}, false
}

func publishCurrentAdapterVersion(platform, channel string) string {
	switch platform + "/" + channel {
	case "wechat_mp/api":
		return "wechat-mp-api-v1"
	case "xhs/desktop":
		return "xhs-fill-v1"
	case "toutiao/desktop":
		return "toutiao-fill-v1"
	case "wechat_mp/manual", "xhs/manual", "toutiao/manual":
		return "manual-v1"
	default:
		return ""
	}
}

// PublishChannelCalibrated 是纯函数：只有成功过且版本仍与当前适配器一致才算校准。
// 首次未成功返回 calibration_missing；版本变化返回 adapter_version_changed。
func PublishChannelCalibrated(lastSuccess *time.Time, storedVersion, currentVersion string) (bool, string) {
	if lastSuccess == nil {
		return false, "calibration_missing"
	}
	if strings.TrimSpace(currentVersion) != "" && strings.TrimSpace(storedVersion) != strings.TrimSpace(currentVersion) {
		return false, "adapter_version_changed"
	}
	return true, ""
}

func publishCapabilityMissing(spec publishCapabilitySpec, signals publishCapabilitySignals) []string {
	missing := []string{}
	for _, require := range spec.Requires {
		switch require {
		case "app_id_secret":
			if !signals.CredentialConfigured {
				missing = append(missing, require)
			}
		case "desktop_online":
			if !signals.DesktopOnline {
				missing = append(missing, require)
			}
		case "account_login":
			if !signals.AccountLogin {
				missing = append(missing, require)
			}
		case "adapter_calibrated":
			if !signals.CalibrationOK {
				missing = append(missing, require)
			}
		}
	}
	return missing
}

func publishCapabilityDisabledReason(missing []string, signals publishCapabilitySignals) string {
	reasons := []string{}
	for _, item := range missing {
		switch item {
		case "app_id_secret":
			reasons = append(reasons, "缺少公众号 AppID/Secret")
		case "desktop_online":
			reasons = append(reasons, "桌面客户端未连接")
		case "account_login":
			reasons = append(reasons, "账号未登录或连接未就绪")
		case "adapter_calibrated":
			if signals.CalibrationReason == "adapter_version_changed" {
				reasons = append(reasons, "适配器版本已变化，需要重新校准")
			} else {
				reasons = append(reasons, "该账号尚未完成一次成功填写")
			}
		}
	}
	return strings.Join(reasons, "；")
}

func buildPublishCapability(spec publishCapabilitySpec, signals publishCapabilitySignals) PublishCapabilityChannel {
	out := PublishCapabilityChannel{
		Platform:              spec.Platform,
		Channel:               spec.Channel,
		Requires:              append([]string{}, spec.Requires...),
		Why:                   spec.Why,
		DefaultOn:             spec.DefaultOn,
		AdapterVersion:        signals.AdapterVersion,
		CurrentAdapterVersion: signals.CurrentVersion,
	}
	if !spec.Supported {
		out.Calibrated = false
		out.Available = false
		out.DisabledReason = spec.Why
		return out
	}
	if spec.Channel == "manual" {
		out.Calibrated = true
		out.Available = true
		return out
	}
	missing := publishCapabilityMissing(spec, signals)
	out.Missing = missing
	out.Calibrated = signals.CalibrationOK
	out.Available = len(missing) == 0
	if spec.Channel == "api" {
		// API 通道没有桌面适配器版本；凭证配置即视为可用/已校准。
		out.Calibrated = signals.CredentialConfigured
	}
	if !out.Available {
		out.DisabledReason = publishCapabilityDisabledReason(missing, signals)
	}
	return out
}

// PublishStateLabel 把任务/作品事实映射为唯一用户可见文案。
// 只有 work 已发布（published）且任务平台等于作品自身平台时才允许出现“已发布”；
// 其他平台的任务即使 work 已发布也按任务态显示（已交接/已提交草稿箱等），避免跨平台假发布。
func PublishStateLabel(platform, taskState string, workPublished bool, workPlatform string) string {
	if workPublished && (workPlatform == "" || workPlatform == platform) {
		return PublishStateLabels["published"]
	}
	switch taskState {
	case "", "ready", "queued", "filling", "packed", "failed", "not_logged_in", "stopped", "skipped":
		return PublishStateLabels["packed"]
	case "filled":
		return PublishStateLabels["filled"]
	case "awaiting_user":
		return PublishStateLabels["awaiting_user"]
	case "submitted", "scheduled":
		if platform == "wechat_mp" {
			return PublishStateLabels["submitted_wechat_mp"]
		}
		return PublishStateLabels["submitted"]
	case "published":
		return PublishStateLabels["submitted"]
	default:
		return PublishStateLabels["packed"]
	}
}

type publishChannelStateRow struct {
	lastSuccess    *time.Time
	adapterVersion string
}

func (s *Server) publishCapabilityChannelRows(ctx context.Context, accountID uuid.UUID) (map[string]publishChannelStateRow, error) {
	rows, err := s.db.Query(ctx, `SELECT platform,channel,last_success_at,adapter_version
		FROM publish_channel_state WHERE account_id=$1`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]publishChannelStateRow{}
	for rows.Next() {
		var platform, channel, version string
		var lastSuccess *time.Time
		if err := rows.Scan(&platform, &channel, &lastSuccess, &version); err != nil {
			return nil, err
		}
		out[platform+"|"+channel] = publishChannelStateRow{lastSuccess: lastSuccess, adapterVersion: version}
	}
	return out, rows.Err()
}

type publishConnectionRow struct {
	availability string
	lastSeen     *time.Time
}

func (s *Server) publishCapabilityConnectionRows(ctx context.Context, workspaceID, accountID uuid.UUID) (map[string]publishConnectionRow, error) {
	rows, err := s.db.Query(ctx, `SELECT platform,availability,last_seen_at
		FROM platform_connection
		WHERE workspace_id=$1 AND account_id=$2 AND state='active'
		ORDER BY last_seen_at DESC NULLS LAST`, workspaceID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]publishConnectionRow{}
	for rows.Next() {
		var platform string
		var row publishConnectionRow
		if err := rows.Scan(&platform, &row.availability, &row.lastSeen); err != nil {
			return nil, err
		}
		if _, exists := out[platform]; !exists {
			out[platform] = row
		}
	}
	return out, rows.Err()
}

func (s *Server) publishCredentialConfigured(ctx context.Context, accountID uuid.UUID) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM wechat_credential
		WHERE account_id=$1 AND app_id<>'')`, accountID).Scan(&exists)
	return exists, err
}

func (s *Server) publishCapabilities(w http.ResponseWriter, r *http.Request) error {
	accountID, err := uuid.Parse(strings.TrimSpace(r.URL.Query().Get("account_id")))
	if err != nil {
		return validation("account_id 必须是 UUID")
	}
	account, err := s.account(r.Context(), accountID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound
		}
		return err
	}
	states, err := s.publishCapabilityChannelRows(r.Context(), accountID)
	if err != nil {
		return err
	}
	connections, err := s.publishCapabilityConnectionRows(r.Context(), ident(r.Context()).WorkspaceID, accountID)
	if err != nil {
		return err
	}
	credentialConfigured := false
	if account.Platform == "wechat_mp" {
		credentialConfigured, err = s.publishCredentialConfigured(r.Context(), accountID)
		if err != nil {
			return err
		}
	}

	platforms := []string{"wechat_mp", "xhs", "toutiao"}
	out := make([]PublishCapabilityPlatform, 0, len(platforms))
	for _, platform := range platforms {
		channels := make([]PublishCapabilityChannel, 0, 3)
		for _, channel := range []string{"api", "desktop", "manual"} {
			spec, ok := publishCapabilitySpecFor(platform, channel)
			if !ok {
				continue
			}
			signals := publishCapabilitySignals{
				CredentialConfigured: credentialConfigured,
				AdapterVersion:       "",
				CurrentVersion:       publishCurrentAdapterVersion(platform, channel),
			}
			if connection, ok := connections[platform]; ok {
				signals.AccountLogin = connection.availability == "ready"
				signals.DesktopOnline = connection.lastSeen != nil && s.now().Sub(*connection.lastSeen) <= platformPresenceTTL
			}
			if state, ok := states[platform+"|"+channel]; ok {
				signals.AdapterVersion = state.adapterVersion
				signals.CalibrationOK, signals.CalibrationReason = PublishChannelCalibrated(
					state.lastSuccess, state.adapterVersion, signals.CurrentVersion)
			} else if channel == "desktop" {
				signals.CalibrationReason = "calibration_missing"
			}
			channels = append(channels, buildPublishCapability(spec, signals))
		}
		out = append(out, PublishCapabilityPlatform{Platform: platform, Channels: channels})
	}
	return ok(w, out)
}

func (s *Server) publishLabels(w http.ResponseWriter, _ *http.Request) error {
	return ok(w, map[string]any{"labels": PublishStateLabels})
}

// publishEvidenceReadbackMeta 只读取回读的 ok 与 adapter_version；不把
// 缺字段的 evidence 当成成功校准。
func publishEvidenceReadbackMeta(evidence map[string]any) (bool, string) {
	if evidence == nil {
		return false, ""
	}
	raw, ok := evidence["readback"].(map[string]any)
	if !ok {
		return false, ""
	}
	ok, _ = raw["ok"].(bool)
	version, _ := raw["adapter_version"].(string)
	return ok, strings.TrimSpace(version)
}

// recordPublishChannelSuccess 在 filling→filled 成功事务内写通道校准。
// 只有回读 ok=true 且带 adapter_version 才写 last_success_at，避免把
// 缺字段的旧调用当成已校准。
func (s *Server) recordPublishChannelSuccess(ctx context.Context, tx pgx.Tx, task *PublishTask, evidence map[string]any, actor uuid.UUID) error {
	ok, version := publishEvidenceReadbackMeta(evidence)
	if !ok || version == "" {
		return nil
	}
	channel := task.Mode
	if channel != "api" && channel != "desktop" {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO publish_channel_state
		(account_id,platform,channel,calibrated_at,calibrated_by,adapter_version,last_success_at,detail,updated_at)
		VALUES($1,$2,$3,now(),$4,$5,now(),'{}'::jsonb,now())
		ON CONFLICT (account_id,platform,channel) DO UPDATE SET
			calibrated_at=now(), calibrated_by=EXCLUDED.calibrated_by,
			adapter_version=EXCLUDED.adapter_version,
			last_success_at=EXCLUDED.last_success_at, updated_at=now()`,
		task.AccountID, task.Platform, channel, actor, version)
	return err
}

// recordPublishChannelFailure 在 filling→failed/not_logged_in 事务内记录失败；
// 不改变 last_success_at，也不把版本改成“已校准”。
func (s *Server) recordPublishChannelFailure(ctx context.Context, tx pgx.Tx, task *PublishTask, errorCode, errorMessage string) error {
	channel := task.Mode
	if channel != "api" && channel != "desktop" {
		return nil
	}
	detail, err := json.Marshal(map[string]any{
		"error_code": errorCode, "error_message": errorMessage,
	})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO publish_channel_state
		(account_id,platform,channel,adapter_version,last_failure_at,detail,updated_at)
		VALUES($1,$2,$3,'',$4,$5,now())
		ON CONFLICT (account_id,platform,channel) DO UPDATE SET
			last_failure_at=EXCLUDED.last_failure_at, detail=EXCLUDED.detail, updated_at=now()`,
		task.AccountID, task.Platform, channel, s.now(), detail)
	return err
}
