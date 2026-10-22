package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"ops/internal/secure"
)

// platformAccount 是一组合成的“本人设备 + 工作区”行，用来在不共享 env 工作区的情况下
// 复现平台采集的设备证明与策略分派。所有名字与标识均为虚构测试数据。
type platformAccount struct {
	t           *testing.T
	userID      uuid.UUID
	workspaceID uuid.UUID
	sessionID   uuid.UUID
	deviceID    uuid.UUID
	publicKey   ed25519.PublicKey
	privateKey  ed25519.PrivateKey
}

func newPlatformAccount(t *testing.T, label string) *platformAccount {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := &platformAccount{
		t: t, userID: uuid.New(), workspaceID: uuid.New(), sessionID: uuid.New(), deviceID: uuid.New(),
		publicKey: pub, privateKey: priv,
	}
	ctx := context.Background()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id,username,password_hash) VALUES ($1,$2,'test')`,
		p.userID, "platform_proof_"+label+"_"+p.userID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES ($1,$2,$3)`,
		p.workspaceID, "平台采集证明测试 "+label, p.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`,
		p.workspaceID, p.userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device (id,user_id,public_key,name,platform,version)
		VALUES ($1,$2,$3,'平台采集测试设备','windows-x64','1.0.0')`, p.deviceID, p.userID, []byte(pub)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = env.srv.db.Exec(bg, `DELETE FROM workspace WHERE id=$1`, p.workspaceID)
		_, _ = env.srv.db.Exec(bg, `DELETE FROM app_user WHERE id=$1`, p.userID)
		env.srv.desktop.mu.Lock()
		for id, c := range env.srv.desktop.challenges {
			if c.DeviceID == p.deviceID {
				delete(env.srv.desktop.challenges, id)
			}
		}
		delete(env.srv.desktop.platformChallengeRate, p.deviceID)
		env.srv.desktop.mu.Unlock()
	})
	return p
}

func (p *platformAccount) identity(role string) *identity {
	return &identity{UserID: p.userID, SessionID: p.sessionID, WorkspaceID: p.workspaceID, Role: role, ReauthOK: true}
}

// setPolicy 直接写工作区平台采集策略；测试只关心服务端据此做的判断，不重复走 HTTP 表单。
func (p *platformAccount) setPolicy(enabled, allowMembers bool) {
	p.t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_collection_policy
		(workspace_id, enabled, allow_member_connections) VALUES ($1,$2,$3)
		ON CONFLICT (workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,
		allow_member_connections=EXCLUDED.allow_member_connections`,
		p.workspaceID, enabled, allowMembers); err != nil {
		p.t.Fatal(err)
	}
}

func (p *platformAccount) setAIEnabled(enabled bool) {
	p.t.Helper()
	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO desktop_ai_policy (workspace_id, enabled, allow_member_endpoints)
		VALUES ($1,$2,$2) ON CONFLICT (workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,
		allow_member_endpoints=EXCLUDED.allow_member_endpoints`, p.workspaceID, enabled); err != nil {
		p.t.Fatal(err)
	}
}

func withDesktopPlatformEnabled(t *testing.T, enabled bool) {
	t.Helper()
	old := env.srv.cfg.DesktopPlatformEnabled
	env.srv.cfg.DesktopPlatformEnabled = enabled
	t.Cleanup(func() { env.srv.cfg.DesktopPlatformEnabled = old })
}

func withDesktopAIEnabled(t *testing.T, enabled bool) {
	t.Helper()
	old := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = enabled
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = old })
}

// challengeRequest 以合成身份调用真实的挑战处理器，等价于一次 /desktop/challenges 请求。
func (p *platformAccount) challengeRequest(role, operation, method, path string, body []byte, purpose string) (int, map[string]any, apiError) {
	p.t.Helper()
	sum := sha256.Sum256(body)
	in := desktopChallengeInput{
		DeviceID: p.deviceID, Operation: operation, Method: method, Path: path,
		BodySHA256: fmt.Sprintf("%x", sum[:]), Purpose: purpose,
	}
	if strings.HasSuffix(operation, "register") {
		in.PublicKey = base64.StdEncoding.EncodeToString(p.publicKey)
	}
	raw, err := json.Marshal(in)
	if err != nil {
		p.t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/desktop/challenges", bytes.NewReader(raw))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity(role)))
	rec := httptest.NewRecorder()
	handlerErr := env.srv.desktopCreateChallenge(rec, req)
	if handlerErr != nil {
		ae, ok := platformAPIError(handlerErr)
		if !ok {
			p.t.Fatalf("challenge: unexpected error %v", handlerErr)
		}
		var rendered apiError
		rendered.Error.Code = ae.Code
		rendered.Error.Message = ae.Message
		return ae.Status, nil, rendered
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		p.t.Fatalf("challenge decode: %v (%s)", err, rec.Body.String())
	}
	return rec.Code, out, apiError{}
}

// challengeCode 返回挑战签发被拒时的错误码（签发成功时为空）。
func (p *platformAccount) challengeCode(role, operation, method, path string, body []byte) string {
	p.t.Helper()
	st, _, ae := p.challengeRequest(role, operation, method, path, body, purposeFor(operation))
	if st == http.StatusOK {
		return ""
	}
	if ae.Error.Code == "" {
		p.t.Fatalf("challenge %s %s: %d without error code", operation, path, st)
	}
	return ae.Error.Code
}

// challenge 要求挑战签发成功，返回可直接用于验签的挑战对象。
func (p *platformAccount) challenge(operation, method, path string, body []byte, purpose string) desktopChallenge {
	p.t.Helper()
	st, out, ae := p.challengeRequest("owner", operation, method, path, body, purpose)
	if st != http.StatusOK {
		p.t.Fatalf("challenge %s %s: %d %s", operation, path, st, ae.Error.Message)
	}
	raw, ok := out["challenge_id"].(string)
	if !ok {
		p.t.Fatalf("challenge response lacks challenge_id: %v", out)
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		p.t.Fatal(err)
	}
	env.srv.desktop.mu.Lock()
	c, exists := env.srv.desktop.challenges[id]
	env.srv.desktop.mu.Unlock()
	if !exists {
		p.t.Fatalf("challenge %s was not stored", id)
	}
	return c
}

// verify 用已签名的挑战调用共享校验入口，返回其错误码（成功时为空）。
func (p *platformAccount) verify(role, operation, method, path string, body []byte, sign func(desktopChallenge) []byte) (string, error) {
	p.t.Helper()
	c := p.challenge(operation, method, path, body, purposeFor(operation))
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity(role)))
	req.Header.Set("X-OPS-Desktop-Challenge", c.ID.String())
	req.Header.Set("X-OPS-Desktop-Signature", base64.StdEncoding.EncodeToString(sign(c)))
	_, _, err := env.srv.desktopReadAndVerifyProof(req, operation)
	if err == nil {
		return "", nil
	}
	ae, ok := platformAPIError(err)
	if !ok {
		return "", err
	}
	return ae.Code, err
}

func purposeFor(operation string) string {
	if op, ok := desktopOperationOf(operation); ok && op.Register {
		return desktopPlatformRegisterPurpose
	}
	return ""
}

func platformAPIError(err error) (*APIError, bool) {
	var ae *APIError
	if errors.As(err, &ae) {
		return ae, true
	}
	return nil, false
}

// TestPlatformProofScopeIsIndependentOfDesktopAI 对应 PS-T07：桌面 AI 与平台采集是两条独立授权，
// 任一侧的全局开关或工作区策略都不能替另一侧放行或拦截。
func TestPlatformProofScopeIsIndependentOfDesktopAI(t *testing.T) {
	p := newPlatformAccount(t, "scope")
	presencePath := "/api/v1/desktop/platform/presence"
	presenceBody := []byte(`{"connection_id":null}`)
	aiPath := "/api/v1/desktop/routes"
	aiBody := []byte(`[]`)

	platformAllowed := func() (string, error) {
		return p.verify("owner", "platform.presence", http.MethodPost, presencePath, presenceBody,
			func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) })
	}
	aiAllowed := func() (string, error) {
		return p.verify("owner", "routes.update", http.MethodPut, aiPath, aiBody,
			func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) })
	}

	t.Run("AI 全关时平台采集仍然可用", func(t *testing.T) {
		withDesktopAIEnabled(t, false)
		withDesktopPlatformEnabled(t, true)
		p.setAIEnabled(false)
		p.setPolicy(true, false)
		if code, err := platformAllowed(); err != nil {
			t.Fatalf("平台采集应可用，实际被拒：%s %v", code, err)
		}
		withDesktopAIEnabled(t, true)
		p.setAIEnabled(false)
		if code := p.challengeCode("owner", "routes.update", http.MethodPut, aiPath, aiBody); code != "desktop_ai_forbidden" {
			t.Fatalf("工作区未启用桌面 AI 时仍签发了 AI 挑战：%s", code)
		}
		withDesktopAIEnabled(t, false)
		p.setAIEnabled(true)
		if code := p.challengeCode("owner", "routes.update", http.MethodPut, aiPath, aiBody); code != "desktop_ai_forbidden" {
			t.Fatalf("全局关闭桌面 AI 时仍签发了 AI 挑战：%s", code)
		}
	})

	t.Run("平台全关时桌面 AI 不受影响", func(t *testing.T) {
		withDesktopAIEnabled(t, true)
		withDesktopPlatformEnabled(t, false)
		p.setAIEnabled(true)
		p.setPolicy(true, false)
		if code, err := aiAllowed(); err != nil {
			t.Fatalf("桌面 AI 应可用，实际被拒：%s %v", code, err)
		}
		withDesktopPlatformEnabled(t, true)
		p.setPolicy(false, false)
		if code := p.challengeCode("owner", "platform.presence", http.MethodPost, presencePath, presenceBody); code != "platform_collection_disabled" {
			t.Fatalf("工作区未启用平台采集时仍签发了平台挑战：%s", code)
		}
		withDesktopPlatformEnabled(t, false)
		p.setPolicy(true, false)
		if code := p.challengeCode("owner", "platform.presence", http.MethodPost, presencePath, presenceBody); code != "platform_collection_disabled" {
			t.Fatalf("全局关闭平台采集时仍签发了平台挑战：%s", code)
		}
	})

	t.Run("策略行互不覆盖", func(t *testing.T) {
		p.setPolicy(true, false)
		p.setAIEnabled(false)
		withDesktopPlatformEnabled(t, true)
		withDesktopAIEnabled(t, true)
		if code, err := platformAllowed(); err != nil {
			t.Fatalf("写桌面 AI 策略不应影响平台采集：%s %v", code, err)
		}
		var aiEnabled bool
		if err := env.srv.db.QueryRow(context.Background(), `SELECT enabled FROM desktop_ai_policy WHERE workspace_id=$1`,
			p.workspaceID).Scan(&aiEnabled); err != nil {
			t.Fatal(err)
		}
		if aiEnabled {
			t.Fatal("平台请求不应改动桌面 AI 策略行")
		}
	})
}

// TestPlatformProofRoleAndOverride 对应 PS-T06 的平台采集部分：owner 放行，editor 仅在
// owner 允许成员连接时放行，viewer 与超管代访问一律拒绝。
func TestPlatformProofRoleAndOverride(t *testing.T) {
	p := newPlatformAccount(t, "roles")
	withDesktopPlatformEnabled(t, true)
	sign := func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) }
	path := "/api/v1/desktop/platform/presence"
	body := []byte(`{}`)

	p.setPolicy(true, false)
	if code, _ := p.verify("editor", "platform.presence", http.MethodPost, path, body, sign); code != "forbidden" {
		t.Fatalf("未允许成员连接时 editor 应被拒绝，实际 %q", code)
	}
	if code, err := p.verify("owner", "platform.presence", http.MethodPost, path, body, sign); err != nil {
		t.Fatalf("owner 应被放行：%s %v", code, err)
	}
	p.setPolicy(true, true)
	if code, err := p.verify("editor", "platform.presence", http.MethodPost, path, body, sign); err != nil {
		t.Fatalf("允许成员连接后 editor 应被放行：%s %v", code, err)
	}
	for _, role := range []string{"viewer", "owner"} {
		if code, _ := p.verify(role, "platform.presence", http.MethodPost, path, body, sign); role == "viewer" && code != "forbidden" {
			t.Fatalf("viewer 应被拒绝，实际 %q", code)
		}
	}

	adminReq := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	override := &identity{UserID: p.userID, SessionID: uuid.New(), WorkspaceID: p.workspaceID, Role: "owner",
		AdminOverride: true, SystemAdmin: true}
	adminReq = adminReq.WithContext(context.WithValue(adminReq.Context(), ctxMember, override))
	if err := env.srv.desktopRequirePlatformCollectionAccess(adminReq.Context(), p.deviceID); err == nil {
		t.Fatal("超管代访问不能使用平台采集")
	}
}

// TestPlatformProofWhitelistRejectsWildcards 对应 20 文档 §11.1：平台操作必须逐条绑定方法与
// 规范路径，不能借 `/desktop/platform/*` 通配授权任意请求。
func TestPlatformProofWhitelistRejectsWildcards(t *testing.T) {
	runID := uuid.New().String()
	accepted := map[string][2]string{
		"platform.device.register":         {http.MethodPost, "/api/v1/desktop/platform/devices"},
		"platform.connection.create":       {http.MethodPost, "/api/v1/desktop/platform/connections"},
		"platform.connection.verify":       {http.MethodPost, "/api/v1/desktop/platform/connections/" + runID + "/verify"},
		"platform.connection.mine.list":    {http.MethodGet, "/api/v1/desktop/platform/connections/mine"},
		"platform.connection.mine.revoke":  {http.MethodDelete, "/api/v1/desktop/platform/connections/" + runID},
		"platform.presence":                {http.MethodPost, "/api/v1/desktop/platform/presence"},
		"platform.run.claim":               {http.MethodPost, "/api/v1/desktop/platform/runs/claim"},
		"platform.run.heartbeat":           {http.MethodPost, "/api/v1/desktop/platform/runs/" + runID + "/heartbeat"},
		"platform.run.result":              {http.MethodPost, "/api/v1/desktop/platform/runs/" + runID + "/results"},
		"platform.run.receipt":             {http.MethodGet, "/api/v1/desktop/platform/runs/" + runID + "/receipts/0"},
		"platform.account.sync.request":    {http.MethodPost, "/api/v1/accounts/" + runID + "/platform-account-sync"},
		"platform.metrics.refresh.request": {http.MethodPost, "/api/v1/accounts/" + runID + "/platform-metrics-refresh"},
		"platform.sync.operation.resume":   {http.MethodPost, "/api/v1/accounts/" + runID + "/platform-sync-operations/" + runID + "/actions"},
	}
	for op, mp := range accepted {
		if !desktopOperationPathAllowed(op, mp[0], mp[1]) {
			t.Errorf("%s 应接受 %s %s", op, mp[0], mp[1])
		}
	}
	if len(accepted) != len(platformOperations) {
		t.Errorf("能力接口公布 %d 个平台操作，白名单测试覆盖 %d 个；新增操作必须同步覆盖",
			len(platformOperations), len(accepted))
	}
	for op, opDef := range desktopOperations {
		if opDef.Scope == desktopProofAIScope {
			continue
		}
		if !strings.HasPrefix(opDef.Path, "/api/v1/desktop/platform/") &&
			opDef.Path != "/api/v1/accounts/{uuid}/platform-account-sync" &&
			opDef.Path != "/api/v1/accounts/{uuid}/platform-metrics-refresh" &&
			opDef.Path != "/api/v1/accounts/{uuid}/platform-sync-operations/{uuid}/actions" {
			t.Errorf("平台操作 %s 的路径 %s 不在 /desktop/platform/ 下", op, opDef.Path)
		}
	}

	rejected := []struct{ op, method, path string }{
		// 通配与任意路径
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform/anything"},
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform/runs/" + runID + "/results"},
		{"platform.run.claim", http.MethodPost, "/api/v1/desktop/platform/runs/claim/extra"},
		// 方法与路径错配
		{"platform.run.claim", http.MethodGet, "/api/v1/desktop/platform/runs/claim"},
		{"platform.presence", http.MethodGet, "/api/v1/desktop/platform/presence"},
		// 平台操作不能借用 AI 路径，反之亦然
		{"platform.connection.create", http.MethodPost, "/api/v1/desktop/connections"},
		{"connection.create", http.MethodPost, "/api/v1/desktop/platform/connections"},
		{"connection.create", http.MethodPost, "/api/v1/desktop/platform/devices"},
		// 占位符必须是 UUID / 非负整数
		{"platform.connection.verify", http.MethodPost, "/api/v1/desktop/platform/connections/not-a-uuid/verify"},
		{"platform.run.receipt", http.MethodGet, "/api/v1/desktop/platform/runs/" + runID + "/receipts/-1"},
		{"platform.run.receipt", http.MethodGet, "/api/v1/desktop/platform/runs/" + runID + "/receipts/0/extra"},
		// 查询串、片段、反斜杠、路径穿越
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform/presence?debug=1"},
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform/presence#x"},
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform\\presence"},
		{"platform.presence", http.MethodPost, "/api/v1/desktop/platform/../devices"},
		// 未知操作
		{"platform.nothing", http.MethodPost, "/api/v1/desktop/platform/presence"},
	}
	for _, r := range rejected {
		if desktopOperationPathAllowed(r.op, r.method, r.path) {
			t.Errorf("%s 不应接受 %s %s", r.op, r.method, r.path)
		}
	}

	p := newPlatformAccount(t, "wildcard")
	withDesktopPlatformEnabled(t, true)
	p.setPolicy(true, false)
	st, _, ae := p.challengeRequest("owner", "platform.presence", http.MethodPost, "/api/v1/desktop/platform/admin", nil, "")
	if st != http.StatusUnprocessableEntity || ae.Error.Code == "" {
		t.Fatalf("通配路径应被挑战接口拒绝，实际 %d", st)
	}
	st, _, _ = p.challengeRequest("owner", "platform.whatever", http.MethodPost, "/api/v1/desktop/platform/presence", nil, "")
	if st != http.StatusUnprocessableEntity {
		t.Fatalf("未知操作应被拒绝，实际 %d", st)
	}
}

// TestPlatformDeviceRegistrationPurpose 对应 §11.1：平台设备登记必须带 purpose=platform_collection，
// 写入同一 desktop_device，且不因登记了平台设备而获得桌面 AI 权限。
func TestPlatformDeviceRegistrationPurpose(t *testing.T) {
	withDesktopPlatformEnabled(t, true)
	withDesktopAIEnabled(t, false)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	deviceID := uuid.New()
	body, _ := json.Marshal(map[string]any{
		"id": deviceID, "public_key": base64.StdEncoding.EncodeToString(pub),
		"name": "平台采集测试设备", "platform": "windows-x64", "version": "1.0.0",
		"purpose": desktopPlatformRegisterPurpose,
	})

	register := func(purpose string, withPurpose bool) (int, []byte, apiError) {
		t.Helper()
		in := desktopChallengeInput{
			DeviceID: deviceID, Operation: "platform.device.register", Method: http.MethodPost,
			Path: "/api/v1/desktop/platform/devices", BodySHA256: fmt.Sprintf("%x", sha256.Sum256(body)),
			PublicKey: base64.StdEncoding.EncodeToString(pub), Purpose: purpose,
		}
		if !withPurpose {
			in.Purpose = ""
		}
		raw, _ := json.Marshal(in)
		st, resp := env.do("POST", "/api/v1/desktop/challenges", json.RawMessage(raw))
		if st != http.StatusOK {
			return st, resp, apiError{}
		}
		var out struct {
			ChallengeID string `json:"challenge_id"`
			Payload     string `json:"signature_payload"`
		}
		if err := json.Unmarshal(resp, &out); err != nil {
			t.Fatalf("challenge decode: %v (%s)", err, resp)
		}
		payload, err := base64.StdEncoding.DecodeString(out.Payload)
		if err != nil {
			t.Fatal(err)
		}
		status, resp := xpDoRaw(t, env.client, env.csrf, http.MethodPost, "/api/v1/desktop/platform/devices", body, map[string]string{
			"X-OPS-Desktop-Device":    deviceID.String(),
			"X-OPS-Desktop-Challenge": out.ChallengeID,
			"X-OPS-Desktop-Signature": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload)),
		})
		var ae apiError
		_ = json.Unmarshal(resp, &ae)
		return status, resp, ae
	}

	env.reauth(t)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM desktop_device WHERE id=$1`, deviceID)
	})

	// 工作区默认关闭：先关策略，确认登记被拒而不是静默写入。
	env.mustJSON(t, "GET", "/api/v1/desktop/policy", nil, nil)
	var me struct {
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	wsID, err := uuid.Parse(me.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_collection_policy WHERE workspace_id=$1`, wsID)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_collection_policy WHERE workspace_id=$1`, wsID)
	})

	if st, resp, ae := register(desktopPlatformRegisterPurpose, true); st != http.StatusForbidden || ae.Error.Code != "platform_collection_disabled" {
		t.Fatalf("工作区未启用平台采集时不得登记设备，实际 %d %s", st, resp)
	}

	if _, err := env.srv.db.Exec(context.Background(), `INSERT INTO platform_collection_policy (workspace_id, enabled)
		VALUES ($1,true)`, wsID); err != nil {
		t.Fatal(err)
	}

	if st, resp, _ := register("", false); st != http.StatusUnprocessableEntity {
		t.Fatalf("缺少 purpose 的登记必须拒绝，实际 %d %s", st, resp)
	}
	if st, resp, _ := register("desktop_ai", true); st != http.StatusUnprocessableEntity {
		t.Fatalf("错误的 purpose 必须拒绝，实际 %d %s", st, resp)
	}
	if st, resp, _ := register(desktopPlatformRegisterPurpose, true); st != http.StatusOK {
		t.Fatalf("合规的平台设备登记应成功，实际 %d %s", st, resp)
	}

	var owner uuid.UUID
	if err := env.srv.db.QueryRow(context.Background(), `SELECT user_id FROM desktop_device WHERE id=$1`, deviceID).Scan(&owner); err != nil {
		t.Fatalf("平台设备未写入同一 desktop_device：%v", err)
	}
	var aiForUser bool
	_ = env.srv.db.QueryRow(context.Background(), `SELECT true FROM desktop_ai_policy WHERE workspace_id=$1 AND enabled`, wsID).Scan(&aiForUser)
	if aiForUser {
		t.Fatal("平台设备登记不应顺带开启桌面 AI 策略")
	}

	// 同一设备 ID 再按 AI 语义登记必须冲突，不能借两种 operation 绕过已登记约束。
	aiIn := desktopChallengeInput{DeviceID: deviceID, Operation: "device.register", Method: http.MethodPost,
		Path: "/api/v1/desktop/devices", BodySHA256: fmt.Sprintf("%x", sha256.Sum256(body)),
		PublicKey: base64.StdEncoding.EncodeToString(pub)}
	raw, _ := json.Marshal(aiIn)
	if st, resp := env.do("POST", "/api/v1/desktop/challenges", json.RawMessage(raw)); st != http.StatusConflict {
		t.Fatalf("已登记设备再次申请登记挑战应 409，实际 %d %s", st, resp)
	}

	// 平台设备可以用于平台操作，但桌面 AI 关闭时不能用于 AI 操作。
	var payload struct {
		ChallengeID string `json:"challenge_id"`
		Payload     string `json:"signature_payload"`
	}
	heartbeatBody := []byte(`{"lease_generation":1}`)
	hbIn := desktopChallengeInput{DeviceID: deviceID, Operation: "platform.run.heartbeat", Method: http.MethodPost,
		Path:       "/api/v1/desktop/platform/runs/" + uuid.New().String() + "/heartbeat",
		BodySHA256: fmt.Sprintf("%x", sha256.Sum256(heartbeatBody))}
	raw, _ = json.Marshal(hbIn)
	st, resp := env.do("POST", "/api/v1/desktop/challenges", json.RawMessage(raw))
	if st != http.StatusOK {
		t.Fatalf("平台设备申请心跳挑战应成功，实际 %d %s", st, resp)
	}
	_ = json.Unmarshal(resp, &payload)
	if payload.ChallengeID == "" {
		t.Fatalf("心跳挑战响应缺少 challenge_id：%s", resp)
	}
}

// TestPlatformProofBindingIsSingleUse 对应 PS-T08：挑战只能消费一次，改 body、改路径、
// 换会话、过期与错误签名都必须拒绝，且失败尝试同样不能重放。
func TestPlatformProofBindingIsSingleUse(t *testing.T) {
	p := newPlatformAccount(t, "binding")
	withDesktopPlatformEnabled(t, true)
	p.setPolicy(true, false)
	path := "/api/v1/desktop/platform/presence"
	body := []byte(`{"connection_id":null,"capability_revision":1}`)
	sign := func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) }

	if code, err := p.verify("owner", "platform.presence", http.MethodPost, path, body, sign); err != nil {
		t.Fatalf("基线请求应成功：%s %v", code, err)
	}

	// 重放：同一个挑战第二次提交，任何内容都不行。
	c := p.challenge("platform.presence", http.MethodPost, path, body, "")
	sig := sign(c)
	do := func(c desktopChallenge, sig []byte, method, reqPath string, reqBody []byte, id *identity) string {
		t.Helper()
		req := httptest.NewRequest(method, reqPath, bytes.NewReader(reqBody))
		who := p.identity("owner")
		if id != nil {
			who = id
		}
		req = req.WithContext(context.WithValue(req.Context(), ctxMember, who))
		req.Header.Set("X-OPS-Desktop-Challenge", c.ID.String())
		req.Header.Set("X-OPS-Desktop-Signature", base64.StdEncoding.EncodeToString(sig))
		_, _, err := env.srv.desktopReadAndVerifyProof(req, "platform.presence")
		if err == nil {
			return ""
		}
		ae, ok := platformAPIError(err)
		if !ok {
			t.Fatalf("unexpected error: %v", err)
		}
		return ae.Code
	}
	if code := do(c, sig, http.MethodPost, path, body, nil); code != "" {
		t.Fatalf("首次使用挑战应成功，实际 %q", code)
	}
	if code := do(c, sig, http.MethodPost, path, body, nil); code != "desktop_device_proof_invalid" {
		t.Fatalf("挑战重放必须被拒绝，实际 %q", code)
	}

	tamperedBody := []byte(`{"connection_id":null,"capability_revision":2}`)
	if code := do(p.challenge("platform.presence", http.MethodPost, path, body, ""), sig, http.MethodPost, path, tamperedBody, nil); code != "desktop_device_proof_invalid" {
		t.Fatalf("改 body 必须被拒绝，实际 %q", code)
	}
	if code := do(p.challenge("platform.presence", http.MethodPost, path, body, ""), sig, http.MethodPost, path+"/x", body, nil); code != "desktop_device_proof_invalid" {
		t.Fatalf("改路径必须被拒绝，实际 %q", code)
	}
	other := &identity{UserID: p.userID, SessionID: uuid.New(), WorkspaceID: p.workspaceID, Role: "owner", ReauthOK: true}
	if code := do(p.challenge("platform.presence", http.MethodPost, path, body, ""), sig, http.MethodPost, path, body, other); code != "desktop_device_proof_invalid" {
		t.Fatalf("换会话必须被拒绝，实际 %q", code)
	}
	otherWS := &identity{UserID: p.userID, SessionID: p.sessionID, WorkspaceID: uuid.New(), Role: "owner", ReauthOK: true}
	if code := do(p.challenge("platform.presence", http.MethodPost, path, body, ""), sig, http.MethodPost, path, body, otherWS); code != "desktop_device_proof_invalid" {
		t.Fatalf("换工作区必须被拒绝，实际 %q", code)
	}

	expired := p.challenge("platform.presence", http.MethodPost, path, body, "")
	env.srv.desktop.mu.Lock()
	expiredCopy := expired
	expiredCopy.ExpiresAt = time.Now().Add(-time.Second)
	env.srv.desktop.challenges[expired.ID] = expiredCopy
	env.srv.desktop.mu.Unlock()
	if code := do(expired, sig, http.MethodPost, path, body, nil); code != "desktop_device_proof_invalid" {
		t.Fatalf("过期挑战必须被拒绝，实际 %q", code)
	}

	badSign := p.challenge("platform.presence", http.MethodPost, path, body, "")
	_, wrongPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if code := do(badSign, ed25519.Sign(wrongPriv, desktopSignaturePayload(badSign)), http.MethodPost, path, body, nil); code != "desktop_device_proof_invalid" {
		t.Fatalf("错误签名必须被拒绝，实际 %q", code)
	}
}

// TestPlatformProofRechecksRevocationAndPolicy 对应 §13.1 与 §10.2：验签通过后仍要复核
// 设备撤销与策略版本，撤销之后不能再用旧挑战提交任何平台结果。
func TestPlatformProofRechecksRevocationAndPolicy(t *testing.T) {
	p := newPlatformAccount(t, "recheck")
	withDesktopPlatformEnabled(t, true)
	p.setPolicy(true, false)
	sign := func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) }
	path := "/api/v1/desktop/platform/presence"
	body := []byte(`{}`)

	if _, err := env.srv.db.Exec(context.Background(), `UPDATE desktop_device SET revoked_at=now() WHERE id=$1`, p.deviceID); err != nil {
		t.Fatal(err)
	}
	if code := p.challengeCode("owner", "platform.presence", http.MethodPost, path, body); code != "platform_device_revoked" {
		t.Fatalf("已撤销设备必须被拒绝，实际 %q", code)
	}
	// 账户级回收操作也必须拒绝已撤销设备，不能借“只减权”绕过设备校验。
	revokePath := "/api/v1/desktop/platform/connections/" + uuid.New().String()
	if code := p.challengeCode("owner", "platform.connection.mine.revoke", http.MethodDelete, revokePath, nil); code != "platform_device_revoked" {
		t.Fatalf("已撤销设备申请回收必须被拒绝，实际 %q", code)
	}

	// 撤销发生在挑战签发之后：验签通过仍要复核撤销状态，旧挑战不能再用。
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE desktop_device SET revoked_at=NULL WHERE id=$1`, p.deviceID); err != nil {
		t.Fatal(err)
	}
	stale := p.challenge("platform.presence", http.MethodPost, path, body, "")
	if _, err := env.srv.db.Exec(context.Background(), `UPDATE desktop_device SET revoked_at=now() WHERE id=$1`, p.deviceID); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity("owner")))
	req.Header.Set("X-OPS-Desktop-Challenge", stale.ID.String())
	req.Header.Set("X-OPS-Desktop-Signature", base64.StdEncoding.EncodeToString(sign(stale)))
	if _, _, err := env.srv.desktopReadAndVerifyProof(req, "platform.presence"); err == nil {
		t.Fatal("设备撤销后旧挑战仍然通过验签后的复核")
	} else if ae, ok := platformAPIError(err); !ok || ae.Code != "platform_device_revoked" {
		t.Fatalf("撤销后应返回 platform_device_revoked，实际 %v", err)
	}

	if _, err := env.srv.db.Exec(context.Background(), `UPDATE desktop_device SET revoked_at=NULL WHERE id=$1`, p.deviceID); err != nil {
		t.Fatal(err)
	}
	p.setPolicy(false, false)
	if code := p.challengeCode("owner", "platform.presence", http.MethodPost, path, body); code != "platform_collection_disabled" {
		t.Fatalf("策略关闭后平台操作必须被拒绝，实际 %q", code)
	}
	// 回收本人连接只减权：策略关闭时仍应放行，否则用户无法在自己的设备上回收。
	if code, err := p.verify("owner", "platform.connection.mine.revoke", http.MethodDelete, revokePath, nil, sign); err != nil {
		t.Fatalf("策略关闭时仍应允许回收本人连接，实际 %q %v", code, err)
	}
}

// TestPlatformProofBodyLimits 对应 §11.1：平台端点不复用 AI 的 32 MiB 上限，
// claim/heartbeat/presence/receipt 在验签前按 64 KiB 拒绝，results 按协议总上限 2 MiB 拒绝；v1 handler 另限 512 KiB。
func TestPlatformProofBodyLimits(t *testing.T) {
	p := newPlatformAccount(t, "limits")
	withDesktopPlatformEnabled(t, true)
	p.setPolicy(true, false)
	sign := func(c desktopChallenge) []byte { return ed25519.Sign(p.privateKey, desktopSignaturePayload(c)) }

	near := bytes.Repeat([]byte("a"), 64<<10+1)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/desktop/platform/presence", bytes.NewReader(near))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity("owner")))
	_, _, err := env.srv.desktopReadAndVerifyProof(req, "platform.presence")
	if ae, ok := platformAPIError(err); !ok || ae.Status != http.StatusRequestEntityTooLarge || ae.Code != "platform_request_too_large" {
		t.Fatalf("超过 64 KiB 的平台请求必须按 413 platform_request_too_large 拒绝，实际 %v", err)
	}

	big := bytes.Repeat([]byte("a"), desktopPlatformResultsBytes+1)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/desktop/platform/runs/"+uuid.New().String()+"/results", bytes.NewReader(big))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity("owner")))
	_, _, err = env.srv.desktopReadAndVerifyProof(req, "platform.run.result")
	if ae, ok := platformAPIError(err); !ok || ae.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("超过协议结果 body 上限的批次必须被拒绝，实际 %v", err)
	}

	// 同样大小的 body 对 AI 操作不应触发 413：AI 上限仍是 32 MiB，且错误码不变。
	req = httptest.NewRequest(http.MethodPut, "/api/v1/desktop/routes", bytes.NewReader(near))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, p.identity("owner")))
	_, _, err = env.srv.desktopReadAndVerifyProof(req, "routes.update")
	if ae, ok := platformAPIError(err); ok && ae.Status == http.StatusRequestEntityTooLarge {
		t.Fatal("AI 操作不应套用平台采集的 64 KiB 上限")
	}

	// 边界之内照常通过。
	if code, err := p.verify("owner", "platform.presence", http.MethodPost, "/api/v1/desktop/platform/presence", []byte(`{}`), sign); err != nil {
		t.Fatalf("64 KiB 以内的请求应通过，实际 %q %v", code, err)
	}
}

// TestPlatformChallengeQuota 对应 §11.1：平台采集每设备每分钟 60 次、按操作分桶，
// 不复用 AI 的 12 次/分钟，也不能靠更宽松的平台配额去刷 AI 端点。
func TestPlatformChallengeQuota(t *testing.T) {
	rt := newDesktopRuntime()
	now := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	deviceID := uuid.New()
	// 60 是 20 文档 §11.1 规定的值，这里写死而不是引用常量：常量被改成别的数字时测试必须失败。
	const documentedPerMinute = 60
	for i := 0; i < documentedPerMinute; i++ {
		if !rt.allowPlatformChallenge(deviceID, "platform.presence", now) {
			t.Fatalf("第 %d 次平台挑战不应被限流", i+1)
		}
	}
	if rt.allowPlatformChallenge(deviceID, "platform.presence", now) {
		t.Fatal("超过每分钟 60 次后必须限流")
	}
	if !rt.allowPlatformChallenge(deviceID, "platform.run.result", now) {
		t.Fatal("配额应按操作分桶，其他操作不应被 drain 的 presence 桶拖累")
	}
	if !rt.allowPlatformChallenge(deviceID, "platform.presence", now.Add(time.Minute+time.Second)) {
		t.Fatal("配额应按分钟窗口恢复")
	}
	other := uuid.New()
	if !rt.allowPlatformChallenge(other, "platform.presence", now) {
		t.Fatal("配额按设备隔离，另一台设备不应受影响")
	}

	// AI 侧仍是 12 次/分钟，平台配额不能放大它。
	sessionID := uuid.New()
	for i := 0; i < 12; i++ {
		if !rt.allowChallenge(sessionID, now) {
			t.Fatalf("第 %d 次 AI 挑战不应被限流", i+1)
		}
	}
	if rt.allowChallenge(sessionID, now) {
		t.Fatal("AI 挑战仍应保持每分钟 12 次上限")
	}
}

// TestPlatformCollectionPolicyEndpoints 对应 §4.3 与 §11.2：策略只读对成员开放，
// 修改必须 owner + 重新认证 + 版本比较，超管代访问禁止。
func TestPlatformCollectionPolicyEndpoints(t *testing.T) {
	env.accounts(t)
	withDesktopPlatformEnabled(t, true)
	var me struct {
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	wsID, err := uuid.Parse(me.Workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	jar := env.client.Jar
	var sessionToken string
	for _, c := range jar.Cookies(&url.URL{Scheme: "http", Host: strings.TrimPrefix(env.http.URL, "http://")}) {
		if c.Name == sessionCookie {
			sessionToken = c.Value
		}
	}
	if sessionToken == "" {
		t.Fatal("测试会话缺少 Cookie")
	}
	_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_collection_policy WHERE workspace_id=$1`, wsID)
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM platform_collection_policy WHERE workspace_id=$1`, wsID)
	})

	var got struct {
		GlobalEnabled bool                     `json:"global_enabled"`
		Policy        platformCollectionPolicy `json:"policy"`
	}
	env.mustJSON(t, "GET", "/api/v1/platform-collection/policy", nil, &got)
	if got.Policy.Enabled || !got.GlobalEnabled {
		t.Fatalf("默认策略必须关闭且如实回报全局开关：%+v", got)
	}
	if got.Policy.DailyRunLimit != platformDefaultDailyRunLimit || got.Policy.DailyWorkLimit != platformDefaultDailyWorkLimit {
		t.Fatalf("默认预算不符合首版初值：%+v", got.Policy)
	}
	revision := got.Policy.AuthorizationRevision

	// 其他用例可能刚重新认证过；按当前 Cookie 的会话精确重置重认证窗口，才能验证“必须重新认证”。
	setReauth := func(ok bool) {
		t.Helper()
		var until any
		if ok {
			until = time.Now().Add(reauthWindow)
		}
		if _, err := env.srv.db.Exec(context.Background(), `UPDATE session SET reauth_until=$1
			WHERE token_hash=$2`, until, secure.SHA256([]byte(sessionToken))); err != nil {
			t.Fatal(err)
		}
	}
	setReauth(false)

	// 未重新认证不得修改。
	env.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": true, "authorization_revision": revision}, "reauth_required")
	setReauth(true)

	env.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": false, "allow_member_connections": true, "authorization_revision": revision}, "validation_failed")
	env.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": true, "authorization_revision": revision, "daily_work_limit": 120}, "validation_failed")
	env.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": true, "authorization_revision": revision + 99}, "platform_authorization_changed")

	var updated platformCollectionPolicy
	env.mustJSON(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": true, "allow_member_connections": true, "authorization_revision": revision,
		"daily_run_limit": 2, "daily_work_limit": 40}, &updated)
	if !updated.Enabled || !updated.AllowMemberConnections || updated.DailyRunLimit != 2 || updated.DailyWorkLimit != 40 {
		t.Fatalf("策略未按提交值保存：%+v", updated)
	}
	if updated.AuthorizationRevision <= revision {
		t.Fatalf("修改策略必须递增授权版本：%d → %d", revision, updated.AuthorizationRevision)
	}
	// 旧版本再提交必须 409，避免策略关闭再开启后旧任务借旧版本复活。
	env.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
		"enabled": false, "authorization_revision": revision}, "platform_authorization_changed")

	// editor / viewer 不能修改；viewer 连读都会被既有写保护之外的规则放过，读是允许的。
	var inv struct {
		Code string `json:"code"`
	}
	for _, role := range []string{"editor", "viewer"} {
		env.mustJSON(t, "POST", "/api/v1/workspaces/current/invites", map[string]any{"role": role, "max_uses": 1, "days": 1}, &inv)
		member := env.registerClient(t, "platform-"+role+"-"+uuid.New().String()[:8], testPassword)
		if st, body := member.do("POST", "/api/v1/workspaces/join", map[string]any{"code": inv.Code, "switch": true}); st != 200 {
			member.restore(env)
			t.Fatalf("%s join: %d %s", role, st, body)
		}
		var res struct {
			CSRF string `json:"csrf_token"`
		}
		member.mustJSON(t, "GET", "/api/v1/auth/me", nil, &res)
		member.csrf = res.CSRF
		member.expectErr(t, "PUT", "/api/v1/platform-collection/policy", map[string]any{
			"enabled": false, "authorization_revision": updated.AuthorizationRevision}, "forbidden")
		member.mustJSON(t, "GET", "/api/v1/platform-collection/policy", nil, nil)
		member.restore(env)
	}
}

// TestPlatformCapabilitiesAdvertiseIndependentCollection 对应 §11.1：能力接口公布独立的
// platform_collection 段，AI 段保持原样，旧客户端据此判断“不支持”而不调用未知端点。
func TestPlatformCapabilitiesAdvertiseIndependentCollection(t *testing.T) {
	withDesktopPlatformEnabled(t, false)
	var caps struct {
		ProtocolVersion    int            `json:"protocol_version"`
		Limits             map[string]int `json:"limits"`
		PlatformCollection *struct {
			ProtocolVersion int            `json:"protocol_version"`
			Enabled         bool           `json:"enabled"`
			Platforms       []string       `json:"platforms"`
			Purpose         string         `json:"purpose"`
			Operations      []string       `json:"operations"`
			Limits          map[string]int `json:"limits"`
		} `json:"platform_collection"`
	}
	env.mustJSON(t, "GET", "/api/v1/desktop/capabilities", nil, &caps)
	if caps.ProtocolVersion != desktopProtocolVersion || caps.Limits["max_request_bytes"] != desktopMaxModelRequest {
		t.Fatalf("AI 能力段不应被改动：%+v", caps)
	}
	if caps.PlatformCollection == nil {
		t.Fatal("能力接口必须公布 platform_collection")
	}
	pc := caps.PlatformCollection
	if pc.Enabled {
		t.Fatal("全局开关默认关闭，能力接口必须如实回报")
	}
	if pc.ProtocolVersion != desktopPlatformProtocolVersion || pc.Purpose != desktopPlatformRegisterPurpose {
		t.Fatalf("协议版本或用途标识不符：%+v", pc)
	}
	if strings.Join(pc.Platforms, ",") != "wechat_mp,xhs" {
		t.Fatalf("首版只支持 wechat_mp 与 xhs：%v", pc.Platforms)
	}
	if strings.Join(pc.Operations, ",") != strings.Join(platformOperations, ",") {
		t.Fatalf("公布的操作必须与白名单一致：%v", pc.Operations)
	}
	if pc.Limits["challenge_per_minute"] != 60 ||
		pc.Limits["request_bytes"] != 64<<10 ||
		pc.Limits["results_bytes"] != 2<<20 ||
		pc.Limits["v1_results_bytes"] != 512<<10 {
		t.Fatalf("平台限额必须与文档一致（60/分钟、64 KiB、v2 结果 2 MiB、v1 结果 512 KiB）：%v", pc.Limits)
	}
}
