package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ops/internal/ai"
)

func (s *Server) desktopStartModelTest(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "model.test")
	if err != nil {
		return err
	}
	r.Body = ioNopCloserBytes(body)
	var in struct {
		Model string `json:"model"`
	}
	if err := desktopStrictDecode(r, &in); err != nil {
		return err
	}
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil || challenge.DeviceID != deviceID {
		return apiErr(403, "desktop_device_proof_invalid", "设备证明与当前设备不匹配")
	}
	providerID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	in.Model = strings.TrimSpace(in.Model)
	if in.Model == "" || len(in.Model) > 120 {
		return validation("请选择有效模型")
	}
	id := ident(r.Context())
	var revision int64
	var models []string
	err = s.db.QueryRow(r.Context(), `SELECT desktop_config_revision, models FROM model_provider
		WHERE id=$1 AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4
		AND execution_location='desktop' AND status='active'`, providerID, id.WorkspaceID, id.UserID, deviceID).
		Scan(&revision, &models)
	if err != nil {
		if err == pgx.ErrNoRows {
			return errNotFound
		}
		return err
	}
	if !containsStr(models, in.Model) {
		return validation("模型不属于当前供应商")
	}
	c, err := s.desktopReadyConnection(id, deviceID, providerID, revision)
	if err != nil {
		return err
	}
	s.desktop.mu.Lock()
	active := 0
	for _, test := range s.desktop.modelTests {
		if test.UserID == id.UserID && test.WorkspaceID == id.WorkspaceID && test.DeviceID == deviceID && test.Status == "running" {
			active++
		}
	}
	if active >= 2 {
		s.desktop.mu.Unlock()
		return apiErr(429, "desktop_test_limit", "该设备已有两个模型自检正在运行")
	}
	test := desktopModelTest{
		ID: uuid.New(), UserID: id.UserID, SessionID: id.SessionID, WorkspaceID: id.WorkspaceID,
		DeviceID: deviceID, ConnectionID: c.id, Generation: c.generation,
		RouteRevision: c.routeRevision, AuthorizationRev: c.authorizationRev,
		ProviderID: providerID, Model: in.Model, ConfigRevision: revision,
		Status: "running", Stage: "text", ExpiresAt: s.now().Add(15 * time.Minute),
	}
	s.desktop.modelTests[test.ID] = test
	s.desktop.mu.Unlock()
	go s.runDesktopModelTest(test)
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"test_id": test.ID, "status": test.Status, "stage": test.Stage,
		"config_revision": revision, "expires_at": test.ExpiresAt})
}

func (s *Server) desktopGetModelTest(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	deviceID, err := desktopDeviceFromHeader(r)
	if err != nil {
		return err
	}
	if err := s.desktopRequireWorkspaceAccess(r.Context(), deviceID); err != nil {
		return err
	}
	testID, err := pathID(r, "id")
	if err != nil {
		return err
	}
	s.desktop.mu.Lock()
	test, found := s.desktop.modelTests[testID]
	s.desktop.mu.Unlock()
	if !found || test.UserID != id.UserID || test.WorkspaceID != id.WorkspaceID || test.DeviceID != deviceID || !test.ExpiresAt.After(s.now()) {
		return errNotFound
	}
	var revision int64
	err = s.db.QueryRow(r.Context(), `SELECT desktop_config_revision FROM model_provider WHERE id=$1
		AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4 AND execution_location='desktop'`,
		test.ProviderID, test.WorkspaceID, test.UserID, test.DeviceID).Scan(&revision)
	if err != nil || revision != test.ConfigRevision {
		test.Status = "stale"
		test.Stage = "config_changed"
	}
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{"test_id": test.ID, "status": test.Status, "stage": test.Stage,
		"summary": test.Summary, "ok": test.OK, "results": test.Results,
		"config_revision": test.ConfigRevision, "expires_at": test.ExpiresAt})
}

func (s *Server) desktopReadyConnection(id *identity, deviceID, providerID uuid.UUID, configRevision int64) (*desktopConnection, error) {
	s.desktop.mu.Lock()
	var c *desktopConnection
	for _, candidate := range s.desktop.connections {
		if candidate.userID == id.UserID && candidate.sessionID == id.SessionID && candidate.workspaceID == id.WorkspaceID && candidate.deviceID == deviceID {
			c = candidate
			break
		}
	}
	s.desktop.mu.Unlock()
	if c == nil {
		return nil, apiErr(503, "desktop_ai_offline", "请先连接此设备的 AI 服务")
	}
	select {
	case <-c.ready:
	case <-c.done:
		return nil, apiErr(503, "desktop_ai_offline", "桌面 AI 连接已断开")
	case <-time.After(10 * time.Second):
		return nil, apiErr(503, "desktop_ai_offline", "桌面 AI 通道尚未完成配置同步")
	}
	c.mu.Lock()
	gotRevision := c.configs[providerID]
	c.mu.Unlock()
	if gotRevision != configRevision {
		return nil, apiErr(409, "desktop_config_stale", "客户端模型配置尚未与服务端版本同步")
	}
	return c, nil
}

func (s *Server) runDesktopModelTest(test desktopModelTest) {
	results := []desktopModelTestResult{}
	probe := func(key, label string, fn func(context.Context, *http.Client) (string, error)) bool {
		s.updateDesktopTest(test.ID, func(current *desktopModelTest) { current.Stage = key })
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		execution := desktopExecution{
			UserID: test.UserID, SessionID: test.SessionID, WorkspaceID: test.WorkspaceID,
			DeviceID: test.DeviceID, ConnectionID: test.ConnectionID, Generation: test.Generation,
			ProviderID: test.ProviderID, Model: test.Model, ConfigRevision: test.ConfigRevision,
			RouteRevision: test.RouteRevision, AuthorizationRev: test.AuthorizationRev,
			Purpose: "self_test", Deadline: s.now().Add(25 * time.Second),
		}
		ctx = withDesktopExecution(ctx, execution)
		client := &http.Client{Transport: desktopRoundTripper{server: s, scope: &desktopRequestScope{}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		start := time.Now()
		detail, err := fn(ctx, client)
		result := desktopModelTestResult{Key: key, Label: label, OK: err == nil, LatencyMS: time.Since(start).Milliseconds()}
		if err != nil {
			result.Detail = truncate(err.Error(), 220)
		} else {
			result.Detail = truncate(detail, 220)
		}
		results = append(results, result)
		return err == nil
	}
	base := "ops-desktop://local"
	model := test.Model
	textOK := probe("text", "文本与流式输出", func(ctx context.Context, client *http.Client) (string, error) {
		text, _, _, _, err := ai.Stream(ctx, client, ai.Request{BaseURL: base, Model: model,
			Messages: []ai.Message{{Role: "user", Content: "请只回复：连接正常"}}}, nil)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) == "" {
			return "", fmt.Errorf("模型没有返回文本")
		}
		return "收到有效文本响应", nil
	})
	jsonOK := probe("json", "JSON 输出", func(ctx context.Context, client *http.Client) (string, error) {
		text, _, _, _, err := ai.Stream(ctx, client, ai.Request{BaseURL: base, Model: model, JSON: true,
			Messages: []ai.Message{{Role: "user", Content: `只输出 JSON 对象 {"ok":true}`}}}, nil)
		if err != nil {
			return "", err
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(ai.ExtractJSON(text)), &value); err != nil {
			return "", fmt.Errorf("模型响应不是有效 JSON")
		}
		return "JSON 可解析", nil
	})
	toolsOK := probe("tools", "原生工具调用", func(ctx context.Context, client *http.Client) (string, error) {
		tool := ai.Tool{Type: "function", Function: ai.ToolFunction{Name: "ops_probe_echo", Description: "用于自检的虚拟回显工具",
			Parameters: json.RawMessage(`{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}`)}}
		_, _, calls, _, err := ai.Stream(ctx, client, ai.Request{BaseURL: base, Model: model, Tools: []ai.Tool{tool}, ToolChoice: "required",
			Messages: []ai.Message{{Role: "user", Content: "调用 ops_probe_echo 并将 value 设置为 ok"}}}, nil)
		if err != nil {
			return "", err
		}
		for _, call := range calls {
			if call.Function.Name != "ops_probe_echo" {
				continue
			}
			var args struct {
				Value string `json:"value"`
			}
			if json.Unmarshal([]byte(call.Function.Arguments), &args) == nil && args.Value == "ok" {
				return "收到预期的虚拟工具调用", nil
			}
		}
		return "", fmt.Errorf("模型没有返回预期的虚拟工具调用")
	})
	visionOK := probe("vision", "图片识别", func(ctx context.Context, client *http.Client) (string, error) {
		text, _, _, _, err := ai.Stream(ctx, client, ai.Request{BaseURL: base, Model: model,
			Messages: []ai.Message{{Role: "user", Content: "图片中的圆形是什么颜色？只回答颜色", Images: []string{probeRedPNG}}}}, nil)
		if err != nil {
			return "", err
		}
		if !strings.Contains(text, "红") {
			return "", fmt.Errorf("模型没有识别出红色")
		}
		return "识别到红色", nil
	})
	imageOK := probe("image_gen", "图片生成", func(ctx context.Context, client *http.Client) (string, error) {
		result, err := ai.GenerateImage(ctx, client, ai.ImageRequest{BaseURL: base, Model: model,
			Prompt: "自检图：浅蓝背景上的一个红色圆形", Size: "256x256",
			FetchURL: func(fetchCtx context.Context, imageURL string) (ai.ImageResult, error) {
				return fetchDesktopGeneratedImage(fetchCtx, client, imageURL)
			}})
		if err != nil {
			return "", err
		}
		if len(result.Bytes) == 0 || len(result.Bytes) > 12<<20 || !strings.HasPrefix(result.MIME, "image/") {
			return "", fmt.Errorf("模型返回图片格式或尺寸不符合限制")
		}
		return fmt.Sprintf("收到 %s 图片，共 %d 字节", result.MIME, len(result.Bytes)), nil
	})
	allOK := textOK && jsonOK
	summary := fmt.Sprintf("模型自检完成：%d/%d 项通过", countDesktopTestOK(results), len(results))
	if err := s.saveDesktopModelCapabilities(test, results, textOK, jsonOK, toolsOK, visionOK, imageOK, allOK, summary); err != nil {
		results = append(results, desktopModelTestResult{Key: "save", Label: "保存自检结果", Detail: truncate(err.Error(), 180)})
		allOK = false
		summary = "自检完成，但配置版本或权限发生变化，结果未生效"
	}
	s.updateDesktopTest(test.ID, func(current *desktopModelTest) {
		current.Status = "completed"
		if !allOK {
			current.Status = "failed"
		}
		current.Stage = "completed"
		current.Summary = summary
		current.OK = allOK
		current.Results = append([]desktopModelTestResult(nil), results...)
	})
}

func countDesktopTestOK(results []desktopModelTestResult) int {
	count := 0
	for _, result := range results {
		if result.OK {
			count++
		}
	}
	return count
}

func (s *Server) updateDesktopTest(id uuid.UUID, update func(*desktopModelTest)) {
	s.desktop.mu.Lock()
	defer s.desktop.mu.Unlock()
	if test, ok := s.desktop.modelTests[id]; ok {
		update(&test)
		s.desktop.modelTests[id] = test
	}
}

func (s *Server) saveDesktopModelCapabilities(test desktopModelTest, results []desktopModelTestResult,
	textOK, jsonOK, toolsOK, visionOK, imageOK, allOK bool, summary string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	id, err := s.loadIdentityBySession(ctx, test.SessionID)
	if err != nil || id.UserID != test.UserID || id.WorkspaceID != test.WorkspaceID || id.AdminOverride {
		return fmt.Errorf("登录会话已失效")
	}
	ctx = context.WithValue(ctx, ctxMember, id)
	if err := s.desktopRequireWorkspaceAccess(ctx, test.DeviceID); err != nil {
		return err
	}
	c, err := s.desktopExecutionConnection(desktopExecution{
		UserID: test.UserID, SessionID: test.SessionID, WorkspaceID: test.WorkspaceID,
		DeviceID: test.DeviceID, ConnectionID: test.ConnectionID, Generation: test.Generation,
		ProviderID: test.ProviderID, ConfigRevision: test.ConfigRevision,
		RouteRevision: test.RouteRevision, AuthorizationRev: test.AuthorizationRev,
	})
	if err != nil || c == nil {
		return fmt.Errorf("桌面连接或授权已失效")
	}
	var currentRevision int64
	if err := s.db.QueryRow(ctx, `SELECT desktop_config_revision FROM model_provider
		WHERE id=$1 AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4
		AND execution_location='desktop' AND status='active'`, test.ProviderID, test.WorkspaceID,
		test.UserID, test.DeviceID).Scan(&currentRevision); err != nil || currentRevision != test.ConfigRevision {
		return fmt.Errorf("客户端模型配置版本已变化")
	}
	detail := map[string]bool{"text_ok": textOK, "json_ok": jsonOK, "tools_ok": toolsOK,
		"vision_ok": visionOK, "image_gen_ok": imageOK}
	encoded, _ := json.Marshal(detail)
	toolsValue := toolsOK
	visionValue := visionOK
	if _, err := s.db.Exec(ctx, `INSERT INTO model_capability (provider_id, model, workspace_id, tools_ok, vision_ok, detail, tested_at, config_revision)
		VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
		ON CONFLICT (provider_id,model) DO UPDATE SET tools_ok=excluded.tools_ok, vision_ok=excluded.vision_ok,
		 detail=excluded.detail, tested_at=excluded.tested_at, config_revision=excluded.config_revision`,
		test.ProviderID, test.Model, test.WorkspaceID, toolsValue, visionValue, encoded, test.ConfigRevision); err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `UPDATE model_provider SET last_test_at=now(), last_test_ok=$2, last_test_result=$3
		WHERE id=$1 AND workspace_id=$4 AND desktop_user_id=$5 AND desktop_device_id=$6
		AND desktop_config_revision=$7`, test.ProviderID, allOK, summary, test.WorkspaceID,
		test.UserID, test.DeviceID, test.ConfigRevision)
	return err
}

func ioNopCloserBytes(body []byte) io.ReadCloser { return io.NopCloser(bytes.NewReader(body)) }
