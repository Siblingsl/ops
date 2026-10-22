package app

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type platformMetricsRefreshRequest struct {
	TargetScope                string   `json:"target_scope"`
	PlatformWorkIDs            []string `json:"platform_work_ids"`
	WorkIDs                    []string `json:"work_ids"`
	ExpectedConnectionRevision int64    `json:"expected_connection_revision"`
}

type platformMetricTarget struct {
	PlatformWorkID string   `json:"platform_work_id,omitempty"`
	WorkIDs        []string `json:"work_ids,omitempty"`
	ExternalID     string   `json:"external_id"`
}

func (s *Server) requestPlatformMetricsRefresh(w http.ResponseWriter, r *http.Request) error {
	accountID, err := pathID(r, "accountId")
	if err != nil {
		return err
	}
	if platformProofMissing(r) {
		return apiErr(http.StatusForbidden, "desktop_required", "请在保存该平台登录的本机客户端发起指标刷新")
	}
	body, proof, err := s.desktopReadAndVerifyProof(r, "platform.metrics.refresh.request")
	if err != nil {
		return err
	}
	var in platformMetricsRefreshRequest
	if err := decodeStrictPlatformJSON(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.ExpectedConnectionRevision <= 0 {
		return validation("缺少连接版本")
	}
	if in.TargetScope != "due_and_recent" && in.TargetScope != "explicit" {
		return validation("指标目标只能是 due_and_recent 或 explicit")
	}
	if in.TargetScope == "due_and_recent" && (len(in.PlatformWorkIDs) != 0 || len(in.WorkIDs) != 0) {
		return validation("due_and_recent 不接受作品 ID")
	}
	if in.TargetScope == "explicit" && (len(in.PlatformWorkIDs)+len(in.WorkIDs) == 0 || len(in.PlatformWorkIDs)+len(in.WorkIDs) > 20) {
		return validation("explicit 必须指定 1～20 个作品")
	}
	key, err := platformIdempotencyKey(r)
	if err != nil {
		return err
	}
	hash, err := platformRequestHash(in)
	if err != nil {
		return err
	}
	if err := s.requireAccountInWorkspace(r.Context(), accountID); err != nil {
		return err
	}
	id := ident(r.Context())
	connection, err := s.platformConnectionForAccount(r.Context(), id.WorkspaceID, accountID)
	if err != nil {
		return err
	}
	if connection.UserID != id.UserID || connection.DeviceID != proof.DeviceID {
		return apiErr(http.StatusForbidden, "platform_not_holder", "只有连接保管人的主设备可以发起平台读取")
	}
	if connection.AuthorizationRevision != in.ExpectedConnectionRevision {
		return apiErr(http.StatusConflict, "connection_revision_conflict", "平台连接版本已变化，请刷新后重试")
	}
	if !s.platformSyncFeatureEnabled(r.Context(), "metrics_refresh", connection.Platform) {
		return apiErr(http.StatusForbidden, "platform_metrics_refresh_disabled", "该平台的指标刷新能力尚未通过验收并启用")
	}
	targets, targetCount, err := s.resolvePlatformMetricTargets(r.Context(), accountID, connection, in)
	if err != nil {
		return err
	}
	frozenScope := map[string]any{
		"target_scope":  in.TargetScope,
		"target_count":  targetCount,
		"targets_as_of": s.now().UTC().Format(time.RFC3339Nano),
	}
	if in.TargetScope == "explicit" {
		frozenScope["targets"] = targets
		if nextAllowed, err := s.platformMetricTargetCooldown(r.Context(), connection, targets, s.now()); err != nil {
			return err
		} else if nextAllowed != nil {
			return apiErr(http.StatusTooManyRequests, "platform_target_cooldown", "同一作品的手动指标刷新至少间隔 15 分钟").With(map[string]any{
				"next_allowed_at": nextAllowed,
			})
		}
	}
	response, status, err := s.createPlatformSyncOperation(r.Context(), accountID, proof,
		platformSyncOperationSpec{
			Kind: "metrics_refresh", RequestedMode: in.TargetScope, EffectiveMode: in.TargetScope,
			ExpectedConnectionRevision: in.ExpectedConnectionRevision,
			IdempotencyKey:             key, RequestHash: hash, FrozenScope: frozenScope,
			NoTargets:          targetCount == 0,
			RequiredCapability: map[bool]string{true: "metrics", false: ""}[targetCount > 0],
		},
	)
	if err != nil {
		return err
	}
	if response["status"] == "queued" {
		response["target_count"] = targetCount
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, response)
	return nil
}

func (s *Server) platformMetricTargetCooldown(ctx context.Context, connection platformConnection, targets []platformMetricTarget, now time.Time) (*time.Time, error) {
	ids := make([]string, 0, len(targets))
	for _, target := range targets {
		ids = append(ids, target.ExternalID)
	}
	var nextAllowed *time.Time
	err := s.db.QueryRow(ctx, `SELECT max(created_at+interval '15 minutes') FROM platform_metric_observation
		WHERE workspace_id=$1 AND account_id=$2 AND external_account_key=$3 AND scope='work'
		AND source=$4 AND external_id=ANY($5::text[]) AND created_at>($6::timestamptz-interval '15 minutes')`,
		connection.WorkspaceID, connection.AccountID, connection.ExternalAccountKey, platformMetricSource(connection.Platform), ids, now).Scan(&nextAllowed)
	return nextAllowed, err
}

func platformMetricSource(platform string) string {
	switch platform {
	case "xhs":
		return "xhs_browser"
	case "wechat_mp":
		return "wechat_browser"
	default:
		return ""
	}
}

func (s *Server) resolvePlatformMetricTargets(ctx context.Context, accountID uuid.UUID, connection platformConnection, in platformMetricsRefreshRequest) ([]platformMetricTarget, int, error) {
	if in.TargetScope == "due_and_recent" {
		count, err := s.countDueAndRecentMetricTargets(ctx, accountID, connection)
		return nil, count, err
	}
	platformWorkIDs, workIDs, err := parseMetricTargetIDs(in)
	if err != nil {
		return nil, 0, err
	}
	column := platformExternalIDColumn(connection.Platform)
	if column == "" {
		return nil, 0, apiErr(http.StatusForbidden, "platform_metrics_refresh_disabled", "该平台暂不支持指标刷新")
	}
	byExternalID := map[string]*platformMetricTarget{}
	for _, rawID := range platformWorkIDs {
		mirrorID, _ := uuid.Parse(rawID)
		var externalID string
		if err := s.db.QueryRow(ctx, `SELECT external_id FROM platform_work_mirror
			WHERE id=$1 AND workspace_id=$2 AND account_id=$3 AND platform=$4 AND external_account_key=$5`,
			mirrorID, connection.WorkspaceID, accountID, connection.Platform, connection.ExternalAccountKey).Scan(&externalID); err != nil {
			if err == pgx.ErrNoRows {
				return nil, 0, validation("所选平台作品不属于当前账号")
			}
			return nil, 0, err
		}
		target := byExternalID[externalID]
		if target == nil {
			target = &platformMetricTarget{ExternalID: externalID}
			byExternalID[externalID] = target
		}
		target.PlatformWorkID = mirrorID.String()
	}
	for _, rawID := range workIDs {
		workID, _ := uuid.Parse(rawID)
		var externalID string
		if err := s.db.QueryRow(ctx, `SELECT `+column+` FROM work WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL
			AND status='published' AND published_at IS NOT NULL AND `+column+` IS NOT NULL
			AND platform_binding_source IN ('user_link','user_confirm','official_exact')`, workID, accountID).Scan(&externalID); err != nil {
			if err == pgx.ErrNoRows {
				return nil, 0, validation("所选本地作品没有当前账号下已核验的平台绑定")
			}
			return nil, 0, err
		}
		target := byExternalID[externalID]
		if target == nil {
			target = &platformMetricTarget{ExternalID: externalID}
			byExternalID[externalID] = target
		}
		target.WorkIDs = append(target.WorkIDs, workID.String())
	}
	targets := make([]platformMetricTarget, 0, len(byExternalID))
	for _, target := range byExternalID {
		sort.Strings(target.WorkIDs)
		targets = append(targets, *target)
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].ExternalID < targets[j].ExternalID })
	return targets, len(targets), nil
}

func parseMetricTargetIDs(in platformMetricsRefreshRequest) ([]string, []string, error) {
	parse := func(values []string) ([]string, error) {
		out := make([]string, 0, len(values))
		seen := map[string]bool{}
		for _, value := range values {
			id, err := uuid.Parse(value)
			if err != nil || id == uuid.Nil {
				return nil, validation("作品 ID 格式不正确")
			}
			canonical := id.String()
			if !seen[canonical] {
				seen[canonical] = true
				out = append(out, canonical)
			}
		}
		return out, nil
	}
	platformWorkIDs, err := parse(in.PlatformWorkIDs)
	if err != nil {
		return nil, nil, err
	}
	workIDs, err := parse(in.WorkIDs)
	return platformWorkIDs, workIDs, err
}

func platformExternalIDColumn(platform string) string {
	switch platform {
	case "xhs":
		return "xhs_note_id"
	case "wechat_mp":
		return "wechat_msgid"
	default:
		return ""
	}
}

func (s *Server) countDueAndRecentMetricTargets(ctx context.Context, accountID uuid.UUID, connection platformConnection) (int, error) {
	column := platformExternalIDColumn(connection.Platform)
	if column == "" {
		return 0, nil
	}
	var count int
	err := s.db.QueryRow(ctx, `WITH eligible AS (
		SELECT w.`+column+` AS external_id
		FROM work w
		WHERE w.account_id=$1 AND w.deleted_at IS NULL AND w.status='published' AND w.published_at IS NOT NULL
		  AND w.`+column+` IS NOT NULL
		  AND w.platform_binding_source IN ('user_link','user_confirm','official_exact')
		  AND NOT EXISTS(SELECT 1 FROM platform_metric_observation o WHERE o.workspace_id=$4 AND o.account_id=$1
			AND o.external_account_key=$5 AND o.external_id=w.`+column+` AND o.scope='work' AND o.source=$6
			AND o.created_at>=($2::timestamptz-interval '6 hours'))
		  AND EXISTS (
			SELECT 1 FROM generate_series(1,14) d(day_offset)
			WHERE d.day_offset IN (1,3,7,14)
			  AND w.published_at::date + d.day_offset <= $2::date
			  AND NOT EXISTS (SELECT 1 FROM metric_node_public(w.id,d.day_offset) m WHERE m.node_exact)
		  )
		UNION
		SELECT m.external_id FROM platform_work_mirror m
		WHERE m.account_id=$1 AND m.platform=$3 AND m.remote_status='published' AND m.published_at >= ($2::timestamptz - interval '30 days')
		  AND m.published_at <= $2 AND m.workspace_id=$4 AND m.external_account_key=$5
		  AND NOT EXISTS(SELECT 1 FROM platform_metric_observation o WHERE o.workspace_id=$4 AND o.account_id=$1
			AND o.external_account_key=$5 AND o.external_id=m.external_id AND o.scope='work' AND o.source=$6
			AND o.created_at>=($2::timestamptz-interval '6 hours'))
	)
	SELECT count(DISTINCT external_id) FROM eligible`, accountID, s.now(), connection.Platform, connection.WorkspaceID,
		connection.ExternalAccountKey, platformMetricSource(connection.Platform)).Scan(&count)
	return count, err
}
