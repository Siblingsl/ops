package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type desktopModelInput struct {
	Name         string   `json:"name"`
	Models       []string `json:"models"`
	EndpointKind string   `json:"endpoint_kind"`
	Status       string   `json:"status"`
	ConfigRev    int64    `json:"config_revision,omitempty"`
}

type desktopModelView struct {
	ID             uuid.UUID       `json:"id"`
	Name           string          `json:"name"`
	Models         []string        `json:"models"`
	EndpointKind   string          `json:"endpoint_kind"`
	Status         string          `json:"status"`
	ConfigRevision int64           `json:"config_revision"`
	Capabilities   json.RawMessage `json:"capabilities"`
}

func desktopDeviceFromHeader(r *http.Request) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Device")))
	if err != nil || id == uuid.Nil {
		return uuid.Nil, apiErr(400, "desktop_device_required", "缺少有效的桌面设备标识")
	}
	return id, nil
}

func desktopStrictDecode(r *http.Request, target any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return requestFormatError(r.Context(), err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return validation("请求只能包含一个 JSON 对象")
	}
	return nil
}

func (s *Server) desktopListModels(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil {
		return err
	}
	if err := s.desktopRequireWorkspaceAccess(r.Context(), deviceID); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT p.id, p.name, p.models, p.desktop_endpoint_kind,
		p.status, p.desktop_config_revision, coalesce(c.detail, '{}'::jsonb)
		FROM model_provider p LEFT JOIN model_capability c ON c.provider_id=p.id AND c.workspace_id=p.workspace_id
			AND c.config_revision=p.desktop_config_revision
		WHERE p.workspace_id=$1 AND p.desktop_user_id=$2 AND p.desktop_device_id=$3
			AND p.execution_location='desktop' ORDER BY p.created_at, p.id`, id.WorkspaceID, id.UserID, deviceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	models := []desktopModelView{}
	for rows.Next() {
		var model desktopModelView
		if err := rows.Scan(&model.ID, &model.Name, &model.Models, &model.EndpointKind,
			&model.Status, &model.ConfigRevision, &model.Capabilities); err != nil {
			return err
		}
		if model.Capabilities == nil {
			model.Capabilities = json.RawMessage(`{}`)
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	revision, err := s.desktopRouteRevision(r.Context(), id.WorkspaceID, id.UserID, deviceID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"models": models, "policy_revision": revision})
}

func (s *Server) desktopCreateModel(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "model.create")
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var in desktopModelInput
	if err := desktopStrictDecode(r, &in); err != nil {
		return err
	}
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil || challenge.DeviceID != deviceID {
		return apiErr(403, "desktop_device_proof_invalid", "设备证明与当前设备不匹配")
	}
	if err := in.validate(true); err != nil {
		return err
	}
	id := ident(r.Context())
	providerID := uuid.New()
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `INSERT INTO model_provider
			(id, workspace_id, name, base_url, api_key_enc, models, status, execution_location,
			 desktop_user_id, desktop_device_id, desktop_endpoint_kind, desktop_config_revision)
			VALUES ($1,$2,$3,NULL,NULL,$4,$5,'desktop',$6,$7,$8,1)`,
			providerID, id.WorkspaceID, in.Name, in.Models, in.Status, id.UserID, deviceID, in.EndpointKind)
		if err != nil {
			return err
		}
		return desktopBumpRouteRevision(r.Context(), tx, id.WorkspaceID, id.UserID, deviceID)
	})
	if err != nil {
		return err
	}
	s.desktopCloseConnections(func(c *desktopConnection) bool { return c.userID == id.UserID && c.deviceID == deviceID })
	s.audit(r.Context(), "desktop_model_create", "model_provider", providerID.String(), "ok", map[string]any{"endpoint_kind": in.EndpointKind})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, desktopModelView{ID: providerID, Name: in.Name, Models: in.Models,
		EndpointKind: in.EndpointKind, Status: in.Status, ConfigRevision: 1,
		Capabilities: json.RawMessage(`{}`)})
}

func (s *Server) desktopUpdateModel(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "model.update")
	if err != nil {
		return err
	}
	providerID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var in desktopModelInput
	if err := desktopStrictDecode(r, &in); err != nil {
		return err
	}
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil || challenge.DeviceID != deviceID {
		return apiErr(403, "desktop_device_proof_invalid", "设备证明与当前设备不匹配")
	}
	if in.ConfigRev < 1 {
		return validation("模型配置版本无效")
	}
	if err := in.validate(false); err != nil {
		return err
	}
	id := ident(r.Context())
	var revision int64
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		err := tx.QueryRow(r.Context(), `UPDATE model_provider SET name=$1, models=$2, status=$3,
			desktop_endpoint_kind=$4, desktop_config_revision=desktop_config_revision+1, updated_at=now()
			WHERE id=$5 AND workspace_id=$6 AND desktop_user_id=$7 AND desktop_device_id=$8
			AND execution_location='desktop' AND desktop_config_revision=$9
			RETURNING desktop_config_revision`, in.Name, in.Models, in.Status, in.EndpointKind,
			providerID, id.WorkspaceID, id.UserID, deviceID, in.ConfigRev).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if e := tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM model_provider WHERE id=$1 AND workspace_id=$2
				AND desktop_user_id=$3 AND desktop_device_id=$4 AND execution_location='desktop')`,
				providerID, id.WorkspaceID, id.UserID, deviceID).Scan(&exists); e != nil {
				return e
			}
			if exists {
				return apiErr(409, "desktop_config_stale", "模型配置已在其他位置更新，请重新载入后再保存")
			}
			return errNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM model_capability WHERE provider_id=$1`, providerID); err != nil {
			return err
		}
		return desktopBumpRouteRevision(r.Context(), tx, id.WorkspaceID, id.UserID, deviceID)
	})
	if err != nil {
		return err
	}
	s.desktopCloseConnections(func(c *desktopConnection) bool { return c.userID == id.UserID && c.deviceID == deviceID })
	s.audit(r.Context(), "desktop_model_update", "model_provider", providerID.String(), "ok", map[string]any{"config_revision": revision})
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, desktopModelView{ID: providerID, Name: in.Name, Models: in.Models,
		EndpointKind: in.EndpointKind, Status: in.Status, ConfigRevision: revision,
		Capabilities: json.RawMessage(`{}`)})
}

func (s *Server) desktopDeleteModel(w http.ResponseWriter, r *http.Request) error {
	_, challenge, err := s.desktopReadAndVerifyProof(r, "model.delete")
	if err != nil {
		return err
	}
	providerID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil || challenge.DeviceID != deviceID {
		return apiErr(403, "desktop_device_proof_invalid", "设备证明与当前设备不匹配")
	}
	id := ident(r.Context())
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `UPDATE model_provider SET status='disabled', desktop_config_revision=desktop_config_revision+1,
			updated_at=now() WHERE id=$1 AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4
			AND execution_location='desktop'`, providerID, id.WorkspaceID, id.UserID, deviceID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return errNotFound
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM desktop_route WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3
			AND (provider_id=$4 OR fallback_provider_id=$4)`, id.WorkspaceID, id.UserID, deviceID, providerID); err != nil {
			return err
		}
		return desktopBumpRouteRevision(r.Context(), tx, id.WorkspaceID, id.UserID, deviceID)
	})
	if err != nil {
		return err
	}
	s.desktopCloseConnections(func(c *desktopConnection) bool { return c.userID == id.UserID && c.deviceID == deviceID })
	s.audit(r.Context(), "desktop_model_delete", "model_provider", providerID.String(), "ok", nil)
	return ok(w, map[string]any{"ok": true})
}

func (in *desktopModelInput) validate(create bool) error {
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len([]rune(in.Name)) > 80 {
		return validation("模型名称不能为空且不能超过 80 个字符")
	}
	if in.EndpointKind != "loopback" && in.EndpointKind != "public" {
		return validation("模型端点类型必须是 loopback 或 public")
	}
	if in.Status == "" && create {
		in.Status = "active"
	}
	if in.Status != "active" && in.Status != "disabled" {
		return validation("模型状态无效")
	}
	models := make([]string, 0, len(in.Models))
	seen := map[string]bool{}
	for _, model := range in.Models {
		model = strings.TrimSpace(model)
		if model == "" || len(model) > 120 || seen[model] {
			return validation("模型列表包含空值、重复项或超长名称")
		}
		seen[model] = true
		models = append(models, model)
	}
	if len(models) == 0 || len(models) > 100 {
		return validation("至少需要一个模型，最多允许 100 个")
	}
	sort.Strings(models)
	in.Models = models
	return nil
}

func desktopBumpRouteRevision(ctx context.Context, tx pgx.Tx, ws, user, device uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO desktop_route_state (workspace_id, user_id, device_id, revision)
		VALUES ($1,$2,$3,2) ON CONFLICT (workspace_id,user_id,device_id)
		DO UPDATE SET revision=desktop_route_state.revision+1, updated_at=now()`, ws, user, device)
	return err
}

type desktopRouteInput struct {
	TaskType           string     `json:"task_type"`
	ExecutionLocation  string     `json:"execution_location"`
	ProviderID         *uuid.UUID `json:"provider_id"`
	Model              string     `json:"model"`
	FallbackProviderID *uuid.UUID `json:"fallback_provider_id"`
	FallbackModel      string     `json:"fallback_model"`
}

func desktopRouteTypes() map[string]bool {
	valid := map[string]bool{}
	for _, task := range taskTypes {
		valid[task.Type] = true
	}
	return valid
}

func (s *Server) desktopGetRoutes(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil {
		return err
	}
	if err := s.desktopRequireWorkspaceAccess(r.Context(), deviceID); err != nil {
		return err
	}
	rows, err := s.db.Query(r.Context(), `SELECT task_type, execution_location, provider_id, model, fallback_provider_id, fallback_model
		FROM desktop_route WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3 ORDER BY task_type`,
		id.WorkspaceID, id.UserID, deviceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	routes := []desktopRouteInput{}
	for rows.Next() {
		var route desktopRouteInput
		if err := rows.Scan(&route.TaskType, &route.ExecutionLocation, &route.ProviderID, &route.Model,
			&route.FallbackProviderID, &route.FallbackModel); err != nil {
			return err
		}
		routes = append(routes, route)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	revision, err := s.desktopRouteRevision(r.Context(), id.WorkspaceID, id.UserID, deviceID)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"routes": routes, "policy_revision": revision})
}

func (s *Server) desktopPutRoutes(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "routes.update")
	if err != nil {
		return err
	}
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil || challenge.DeviceID != deviceID {
		return apiErr(403, "desktop_device_proof_invalid", "设备证明与当前设备不匹配")
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var routes []desktopRouteInput
	if err := desktopStrictDecode(r, &routes); err != nil {
		return err
	}
	if len(routes) > len(desktopRouteTypes()) {
		return validation("任务路由数量无效")
	}
	expected, err := strconv.ParseInt(strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Policy")), 10, 64)
	if err != nil || expected < 1 {
		return validation("缺少有效的任务映射版本")
	}
	id := ident(r.Context())
	if err := s.desktopRequireWorkspaceAccess(r.Context(), deviceID); err != nil {
		return err
	}
	seen := map[string]bool{}
	valid := desktopRouteTypes()
	for i := range routes {
		rt := &routes[i]
		rt.Model, rt.FallbackModel = strings.TrimSpace(rt.Model), strings.TrimSpace(rt.FallbackModel)
		if !valid[rt.TaskType] || seen[rt.TaskType] {
			return validation("任务类型未知或重复：" + rt.TaskType)
		}
		seen[rt.TaskType] = true
		if rt.ExecutionLocation != "desktop" && rt.ExecutionLocation != "server" && rt.ExecutionLocation != "disabled" {
			return validation("任务执行位置无效")
		}
		if rt.ExecutionLocation == "disabled" {
			if rt.ProviderID != nil || rt.Model != "" || rt.FallbackProviderID != nil || rt.FallbackModel != "" {
				return validation("禁用的任务不能包含模型或备用模型")
			}
			continue
		}
		if rt.TaskType == "embedding" && rt.ExecutionLocation == "desktop" {
			return validation("首版不支持本机向量模型，请选择服务器模型或停用向量检索")
		}
		if rt.ProviderID == nil || rt.Model == "" {
			return validation("启用的任务必须选择主模型")
		}
		if (rt.FallbackProviderID == nil) != (rt.FallbackModel == "") {
			return validation("备用供应商与备用模型必须同时填写")
		}
	}
	if !seen["default"] {
		return validation("完整任务映射必须明确设置默认任务")
	}
	err = s.withTx(r.Context(), func(tx pgx.Tx) error {
		current, err := desktopRouteRevisionTx(r.Context(), tx, id.WorkspaceID, id.UserID, deviceID)
		if err != nil {
			return err
		}
		if current != expected {
			return apiErr(409, "desktop_route_stale", "任务映射已变化，请重新载入后再应用")
		}
		if _, err := tx.Exec(r.Context(), `DELETE FROM desktop_route WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`, id.WorkspaceID, id.UserID, deviceID); err != nil {
			return err
		}
		for _, rt := range routes {
			if rt.ExecutionLocation == "disabled" {
				if _, err := tx.Exec(r.Context(), `INSERT INTO desktop_route
					(workspace_id,user_id,device_id,task_type,execution_location,provider_id,model,fallback_provider_id,fallback_model)
					VALUES ($1,$2,$3,$4,'disabled',NULL,'',NULL,'')`, id.WorkspaceID, id.UserID, deviceID, rt.TaskType); err != nil {
					return err
				}
				continue
			}
			if err := desktopValidateRouteProvider(r.Context(), tx, rt, id.WorkspaceID, id.UserID, deviceID); err != nil {
				return err
			}
			if rt.FallbackProviderID != nil {
				fb := desktopRouteInput{TaskType: rt.TaskType, ExecutionLocation: rt.ExecutionLocation,
					ProviderID: rt.FallbackProviderID, Model: rt.FallbackModel}
				if err := desktopValidateRouteProvider(r.Context(), tx, fb, id.WorkspaceID, id.UserID, deviceID); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(r.Context(), `INSERT INTO desktop_route
				(workspace_id,user_id,device_id,task_type,execution_location,provider_id,model,fallback_provider_id,fallback_model)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id.WorkspaceID, id.UserID, deviceID, rt.TaskType,
				rt.ExecutionLocation, *rt.ProviderID, rt.Model, rt.FallbackProviderID, rt.FallbackModel); err != nil {
				return err
			}
		}
		return desktopBumpRouteRevision(r.Context(), tx, id.WorkspaceID, id.UserID, deviceID)
	})
	if err != nil {
		return err
	}
	s.audit(r.Context(), "desktop_routes_update", "desktop_route", deviceID.String(), "ok", map[string]any{"count": len(routes)})
	w.Header().Set("Cache-Control", "no-store")
	return s.desktopGetRoutes(w, r)
}

func (s *Server) resolveDesktopRouteTier(ctx context.Context, taskType, tier string, request desktopRequest) (*route, error) {
	if request.Err != nil || request.DeviceID == uuid.Nil || request.RouteRevision < 1 {
		return nil, apiErr(400, "desktop_ai_context_invalid", "客户端 AI 执行上下文无效，请重新连接并应用设置")
	}
	id := ident(ctx)
	var deviceActive bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM desktop_device WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL)`,
		request.DeviceID, id.UserID).Scan(&deviceActive); err != nil {
		return nil, err
	}
	if !deviceActive {
		return nil, apiErr(403, "desktop_device_revoked", "此客户端设备已撤销或不可用")
	}
	snapshot, err := s.desktopRouteSnapshotFor(ctx, request, id.WorkspaceID, id.UserID)
	if err != nil {
		return nil, err
	}
	keys := []string{taskType, "default"}
	if taskType == "image_alt" {
		keys = []string{"metric_screenshot"}
	} else if taskType == "image_gen" || taskType == "embedding" {
		keys = []string{taskType}
	} else if costTiers[tier] && taskType != "agent_chat" {
		keys = []string{"tier_" + tier, taskType, "default"}
	}
	var selected desktopRouteInput
	var found bool
	for _, key := range keys {
		if selected, found = snapshot.routes[key]; found {
			break
		}
	}
	if !found {
		return nil, apiErr(409, "desktop_ai_route_unconfigured", "此客户端 AI 尚未为该任务明确选择执行位置")
	}
	if selected.ExecutionLocation == "disabled" {
		return nil, apiErr(403, "desktop_ai_route_disabled", "此任务已在客户端 AI 路由中停用")
	}
	var connection *desktopConnection
	var policy desktopPolicy
	if selected.ExecutionLocation == "desktop" {
		if err := s.desktopRequireWorkspaceAccess(ctx, request.DeviceID); err != nil {
			return nil, err
		}
		policy, err = s.desktopPolicy(ctx, id.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if policy.AuthorizationRevision != snapshot.authorizationRevision {
			return nil, apiErr(403, "desktop_ai_forbidden", "工作区桌面 AI 授权已变化，请重新连接")
		}
		if request.ConnectionID == uuid.Nil || request.Generation < 1 {
			return nil, apiErr(503, "desktop_ai_offline", "本机模型通道尚未连接，请在客户端设置中连接后重试")
		}
		s.desktop.mu.Lock()
		connection = s.desktop.connections[request.ConnectionID]
		s.desktop.mu.Unlock()
		if connection == nil || connection.userID != id.UserID || connection.sessionID != id.SessionID ||
			connection.workspaceID != id.WorkspaceID || connection.deviceID != request.DeviceID ||
			connection.generation != request.Generation ||
			connection.authorizationRev != policy.AuthorizationRevision {
			return nil, apiErr(503, "desktop_ai_offline", "本机模型通道已断开或设置已过期，请重新连接")
		}
		if err := s.desktopValidateConnection(connection); err != nil {
			return nil, apiErr(403, "desktop_ai_forbidden", "本机模型通道授权已变化，请重新连接")
		}
		select {
		case <-connection.ready:
		case <-connection.done:
			return nil, apiErr(503, "desktop_ai_offline", "本机模型通道已断开，请重新连接")
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Second):
			return nil, apiErr(503, "desktop_ai_offline", "本机模型通道尚未完成配置同步")
		}
	}
	selected.TaskType = taskType
	primary, err := s.desktopMappedProviderRoute(ctx, selected, id, request.DeviceID, connection, policy, snapshot.routeRevision)
	if err != nil {
		return nil, err
	}
	if selected.FallbackProviderID != nil {
		fallback := desktopRouteInput{TaskType: selected.TaskType, ExecutionLocation: selected.ExecutionLocation,
			ProviderID: selected.FallbackProviderID, Model: selected.FallbackModel}
		primary.Fallback, err = s.desktopMappedProviderRoute(ctx, fallback, id, request.DeviceID, connection, policy, snapshot.routeRevision)
		if err != nil {
			return nil, err
		}
	}
	return primary, nil
}

func (s *Server) desktopRouteSnapshotFor(ctx context.Context, request desktopRequest, ws, user uuid.UUID) (*desktopRouteSnapshot, error) {
	snapshot := request.RouteSnapshot
	if snapshot == nil {
		snapshot = &desktopRouteSnapshot{}
	}
	snapshot.mu.Lock()
	defer snapshot.mu.Unlock()
	if snapshot.loaded {
		if snapshot.err != nil {
			return nil, snapshot.err
		}
		if snapshot.routeRevision != request.RouteRevision {
			return nil, apiErr(409, "desktop_ai_config_stale", "客户端 AI 执行快照与请求版本不匹配")
		}
		return snapshot, nil
	}
	snapshot.loaded = true
	snapshot.routes = map[string]desktopRouteInput{}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		snapshot.err = err
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT revision FROM desktop_route_state WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`,
		ws, user, request.DeviceID).Scan(&snapshot.routeRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			snapshot.routeRevision = 1
		} else {
			snapshot.err = err
			return nil, err
		}
	}
	if snapshot.routeRevision != request.RouteRevision {
		snapshot.err = apiErr(409, "desktop_ai_config_stale", "客户端 AI 任务映射已变化，请重新应用设置")
		return nil, snapshot.err
	}
	var policy desktopPolicy
	policy.WorkspaceID = ws
	policy.AuthorizationRevision = 1
	err = tx.QueryRow(ctx, `SELECT authorization_revision FROM desktop_ai_policy WHERE workspace_id=$1`, ws).
		Scan(&policy.AuthorizationRevision)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		snapshot.err = err
		return nil, err
	}
	snapshot.authorizationRevision = policy.AuthorizationRevision
	rows, err := tx.Query(ctx, `SELECT task_type, execution_location, provider_id, model, fallback_provider_id, fallback_model
		FROM desktop_route WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`, ws, user, request.DeviceID)
	if err != nil {
		snapshot.err = err
		return nil, err
	}
	for rows.Next() {
		var route desktopRouteInput
		if err := rows.Scan(&route.TaskType, &route.ExecutionLocation, &route.ProviderID, &route.Model,
			&route.FallbackProviderID, &route.FallbackModel); err != nil {
			rows.Close()
			snapshot.err = err
			return nil, err
		}
		snapshot.routes[route.TaskType] = route
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		snapshot.err = err
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		snapshot.err = err
		return nil, err
	}
	return snapshot, nil
}

func (s *Server) desktopRouteReady(ctx context.Context, taskType string, request desktopRequest) (bool, error) {
	_, err := s.resolveDesktopRouteTier(ctx, taskType, "", request)
	if err == nil {
		return true, nil
	}
	var apiError *APIError
	if errors.As(err, &apiError) {
		return false, nil
	}
	return false, err
}

func (s *Server) desktopMappedProviderRoute(ctx context.Context, mapping desktopRouteInput, id *identity,
	deviceID uuid.UUID, connection *desktopConnection, policy desktopPolicy, routeRevision int64) (*route, error) {
	if mapping.ProviderID == nil || mapping.Model == "" {
		return nil, apiErr(409, "desktop_ai_config_stale", "客户端 AI 路由缺少有效模型")
	}
	var provider route
	provider.ProviderID, provider.Model = *mapping.ProviderID, mapping.Model
	if mapping.ExecutionLocation == "server" {
		var encrypted []byte
		err := s.db.QueryRow(ctx, `SELECT p.name, p.base_url, p.api_key_enc,
			coalesce(c.tools_ok,false), coalesce(c.vision_ok,false) FROM model_provider p
		LEFT JOIN model_capability c ON c.provider_id=p.id AND c.workspace_id=p.workspace_id
			AND c.model=$3 AND c.config_revision=p.desktop_config_revision
		WHERE p.id=$1 AND p.workspace_id=$2 AND p.execution_location='server' AND p.status='active' AND $3=ANY(p.models)`,
			provider.ProviderID, id.WorkspaceID, provider.Model).Scan(&provider.ProviderName, &provider.BaseURL, &encrypted,
			&provider.ToolsOK, &provider.VisionOK)
		if err != nil {
			return nil, apiErr(409, "desktop_ai_config_stale", "已选择的服务器模型已不可用，请重新应用任务映射")
		}
		key, err := s.box.Decrypt(encrypted)
		if err != nil {
			return nil, err
		}
		provider.APIKey = key
		return &provider, nil
	}
	if mapping.ExecutionLocation != "desktop" || connection == nil {
		return nil, apiErr(403, "desktop_ai_forbidden", "客户端 AI 执行位置无效")
	}
	var configRevision int64
	var detail []byte
	err := s.db.QueryRow(ctx, `SELECT p.name, p.desktop_config_revision, coalesce(c.detail,'{}'::jsonb)
		FROM model_provider p LEFT JOIN model_capability c ON c.provider_id=p.id AND c.workspace_id=p.workspace_id
			AND c.model=$5 AND c.config_revision=p.desktop_config_revision
		WHERE p.id=$1 AND p.workspace_id=$2 AND p.desktop_user_id=$3 AND p.desktop_device_id=$4
		AND p.execution_location='desktop' AND p.status='active' AND $5=ANY(p.models)`,
		provider.ProviderID, id.WorkspaceID, id.UserID, deviceID, provider.Model).
		Scan(&provider.ProviderName, &configRevision, &detail)
	if err != nil {
		return nil, apiErr(409, "desktop_ai_config_stale", "已选择的本机模型配置已不可用，请重新测试并应用")
	}
	var capabilities map[string]bool
	if err := json.Unmarshal(detail, &capabilities); err != nil {
		return nil, err
	}
	if !capabilities["text_ok"] {
		return nil, apiErr(409, "desktop_ai_capability_unsupported", "本机模型尚未通过文本能力自检")
	}
	if mapping.TaskType == "agent_chat" && !capabilities["tools_ok"] {
		return nil, apiErr(409, "desktop_ai_capability_unsupported", "本机模型尚未通过工具调用自检")
	}
	if (mapping.TaskType == "metric_screenshot" || mapping.TaskType == "image_alt") && !capabilities["vision_ok"] {
		return nil, apiErr(409, "desktop_ai_capability_unsupported", "本机模型尚未通过图片识别自检")
	}
	if mapping.TaskType == "image_gen" && !capabilities["image_gen_ok"] {
		return nil, apiErr(409, "desktop_ai_capability_unsupported", "本机模型尚未通过图片生成自检")
	}
	connection.mu.Lock()
	syncedRevision := connection.configs[provider.ProviderID]
	connection.mu.Unlock()
	if syncedRevision != configRevision {
		return nil, apiErr(409, "desktop_ai_config_stale", "本机模型配置尚未同步，请重新连接")
	}
	execution := desktopExecution{UserID: id.UserID, SessionID: id.SessionID, WorkspaceID: id.WorkspaceID,
		DeviceID: deviceID, ConnectionID: connection.id, Generation: connection.generation, ProviderID: provider.ProviderID,
		Model: provider.Model, ConfigRevision: configRevision, RouteRevision: routeRevision,
		AuthorizationRev: policy.AuthorizationRevision, Purpose: "business"}
	provider.ProviderName = "此客户端 · " + provider.ProviderName
	provider.BaseURL = "ops-desktop://local"
	provider.Desktop = &execution
	provider.JSONOK = capabilities["json_ok"]
	provider.ToolsOK = capabilities["tools_ok"]
	provider.VisionOK = capabilities["vision_ok"]
	provider.ImageGenOK = capabilities["image_gen_ok"]
	return &provider, nil
}

func desktopRouteRevisionTx(ctx context.Context, tx pgx.Tx, ws, user, device uuid.UUID) (int64, error) {
	var revision int64
	err := tx.QueryRow(ctx, `SELECT revision FROM desktop_route_state WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3 FOR UPDATE`,
		ws, user, device).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 1, nil
	}
	return revision, err
}

func desktopValidateRouteProvider(ctx context.Context, tx pgx.Tx, route desktopRouteInput, ws, user, device uuid.UUID) error {
	var exists bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM model_provider p LEFT JOIN model_capability c ON c.provider_id=p.id AND c.model=$2
			AND c.config_revision=p.desktop_config_revision
		WHERE p.id=$1 AND p.workspace_id=$3 AND p.execution_location=$4 AND p.status='active'
		AND $2=ANY(p.models) AND (($4='desktop' AND p.desktop_user_id=$5 AND p.desktop_device_id=$6)
			OR $4='server'))`, *route.ProviderID, route.Model, ws, route.ExecutionLocation, user, device).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return validation("主备模型必须属于当前执行位置、设备且处于可用状态")
	}
	if route.ExecutionLocation == "desktop" {
		var detail []byte
		err := tx.QueryRow(ctx, `SELECT c.detail FROM model_provider p JOIN model_capability c
			ON c.provider_id=p.id AND c.model=$2 AND c.workspace_id=p.workspace_id
			AND c.config_revision=p.desktop_config_revision
			WHERE p.id=$1 AND p.workspace_id=$3 AND p.desktop_user_id=$4 AND p.desktop_device_id=$5`,
			*route.ProviderID, route.Model, ws, user, device).Scan(&detail)
		if errors.Is(err, pgx.ErrNoRows) {
			return validation("桌面模型尚未完成当前配置版本的自检")
		}
		if err != nil {
			return err
		}
		var capabilities map[string]bool
		if err := json.Unmarshal(detail, &capabilities); err != nil {
			return err
		}
		if !capabilities["text_ok"] {
			return validation("桌面模型必须先通过文本能力自检")
		}
		if route.TaskType == "agent_chat" && !capabilities["tools_ok"] {
			return validation("智能体对话模型必须通过原生工具调用自检")
		}
		if route.TaskType == "metric_screenshot" && !capabilities["vision_ok"] {
			return validation("图片识别模型必须通过识图自检")
		}
		if route.TaskType == "image_gen" && !capabilities["image_gen_ok"] {
			return validation("出图路由必须通过图片生成自检")
		}
	}
	return nil
}
