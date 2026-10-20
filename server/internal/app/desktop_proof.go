package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type desktopChallengeInput struct {
	DeviceID   uuid.UUID `json:"device_id"`
	Operation  string    `json:"operation"`
	Method     string    `json:"method"`
	Path       string    `json:"path"`
	BodySHA256 string    `json:"body_sha256"`
	PublicKey  string    `json:"public_key,omitempty"`
	// Purpose 只属于登记类操作（platform.device.register → platform_collection），
	// 让同一个 desktop_device 表能区分“为平台采集而登记”，不因此获得 AI 权限。
	Purpose string `json:"purpose,omitempty"`
}

type desktopDeviceInput struct {
	ID        uuid.UUID `json:"id"`
	PublicKey string    `json:"public_key"`
	Name      string    `json:"name"`
	Platform  string    `json:"platform"`
	Version   string    `json:"version"`
}

func (s *Server) desktopCreateChallenge(w http.ResponseWriter, r *http.Request) error {
	id := ident(r.Context())
	var in desktopChallengeInput
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Method = strings.ToUpper(strings.TrimSpace(in.Method))
	in.Operation = strings.TrimSpace(in.Operation)
	in.Path = strings.TrimSpace(in.Path)
	in.Purpose = strings.TrimSpace(in.Purpose)
	op, known := desktopOperationOf(in.Operation)
	if in.DeviceID == uuid.Nil || !known || !op.matches(in.Method, in.Path) {
		return validation("设备证明操作不受支持")
	}
	if err := op.checkPurpose(in.Purpose); err != nil {
		return err
	}
	bodyDigest, err := hex.DecodeString(in.BodySHA256)
	if err != nil || len(bodyDigest) != sha256.Size || in.BodySHA256 != strings.ToLower(in.BodySHA256) {
		return validation("请求摘要格式不正确")
	}
	var publicKey []byte
	if op.Register {
		publicKey, err = base64.StdEncoding.DecodeString(in.PublicKey)
		if err != nil || len(publicKey) != ed25519.PublicKeySize {
			return validation("设备公钥格式不正确")
		}
		var exists bool
		if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM desktop_device WHERE id=$1)`, in.DeviceID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return apiErr(409, "desktop_device_conflict", "设备 ID 已登记，请选择已有设备或重新注册设备")
		}
		if !id.ReauthOK {
			return errReauth
		}
	} else {
		if err := s.desktopRequireProofScope(r.Context(), op, in.DeviceID); err != nil {
			return err
		}
		err := s.db.QueryRow(r.Context(), `SELECT public_key FROM desktop_device
			WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, in.DeviceID, id.UserID).Scan(&publicKey)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// 账户级回收操作不要求工作区策略，因此设备撤销要在这里给出平台语义的错误码，
				// 否则用户只会看到“内容不存在”，不知道是设备被撤销。
				if op.Scope == desktopProofPlatformAccountScope {
					return apiErr(403, "platform_device_revoked", "该设备已撤销或不可用")
				}
				return errNotFound
			}
			return err
		}
	}
	if s.desktop == nil || !s.desktop.allowChallengeFor(op, in.DeviceID, id.SessionID, s.now()) {
		if op.Scope == desktopProofAIScope {
			return apiErr(429, "desktop_challenge_rate_limited", "设备验证请求过于频繁，请稍后重试")
		}
		return apiErr(429, "platform_challenge_rate_limited", "平台采集证明请求过于频繁，请稍后重试")
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	challenge := desktopChallenge{
		ID: uuid.New(), Nonce: nonce, UserID: id.UserID, SessionID: id.SessionID,
		WorkspaceID: id.WorkspaceID, DeviceID: in.DeviceID, Operation: in.Operation,
		Method: in.Method, Path: in.Path, PublicKey: append([]byte(nil), publicKey...),
		ExpiresAt: s.now().Add(desktopChallengeTTL),
	}
	copy(challenge.BodyHash[:], bodyDigest)
	s.desktop.mu.Lock()
	s.desktop.purgeExpiredLocked(s.now())
	s.desktop.challenges[challenge.ID] = challenge
	s.desktop.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"challenge_id":      challenge.ID,
		"expires_at":        challenge.ExpiresAt,
		"signature_payload": base64.StdEncoding.EncodeToString(desktopSignaturePayload(challenge)),
	})
}

func (op desktopOperation) checkPurpose(purpose string) error {
	if op.Register {
		if purpose != op.Purpose {
			return validation("设备登记缺少用途标识")
		}
		return nil
	}
	if purpose != "" {
		return validation("该操作不接受用途标识")
	}
	return nil
}

func (d *desktopRuntime) allowChallengeFor(op desktopOperation, deviceID, sessionID uuid.UUID, now time.Time) bool {
	if op.Scope == desktopProofAIScope {
		return d.allowChallenge(sessionID, now)
	}
	return d.allowPlatformChallenge(deviceID, op.Name, now)
}

// desktopProofScope 决定一次持证请求在签名通过后还要过哪一道策略。
// AI 与平台采集共用设备与挑战签名，但授权来源互不相干（D-129 / 20 文档 §11.1）。
type desktopProofScope int

const (
	// desktopProofAIScope：旧桌面 AI 操作，仍受全局开关、工作区策略与成员端点条件约束。
	desktopProofAIScope desktopProofScope = iota
	// desktopProofPlatformScope：平台采集操作，要求全局开关、工作区采集策略与角色。
	desktopProofPlatformScope
	// desktopProofPlatformAccountScope：账户级回收操作，只校验本人会话与设备归属，
	// 失去工作区成员资格后仍能回收本机连接。
	desktopProofPlatformAccountScope
	// desktopProofPlatformWorkspaceScope：要求当前工作区有效，但不因策略关闭而拒绝，
	// 用于任务已提交后的回执查询，不延长租约。
	desktopProofPlatformWorkspaceScope
)

// desktopOperation 是一个固定的持有证明操作。路径与方法是逐条写死的规范路径，
// 不接受 `/desktop/platform/*` 之类的通配授权；请求体上限也按操作固定。
type desktopOperation struct {
	Name     string
	Scope    desktopProofScope
	Method   string
	Path     string
	Limit    int64
	Register bool
	// Purpose 是登记类操作必须随请求体提交的用途串，非登记操作必须留空。
	Purpose string
}

const desktopPlatformRegisterPurpose = "platform_collection"

var desktopOperations = map[string]desktopOperation{
	// 旧桌面 AI 操作，语义与白名单不因新增平台能力扩大。
	"device.register":   {Name: "device.register", Scope: desktopProofAIScope, Method: http.MethodPost, Path: "/api/v1/desktop/devices", Limit: desktopMaxModelRequest, Register: true},
	"model.create":      {Name: "model.create", Scope: desktopProofAIScope, Method: http.MethodPost, Path: "/api/v1/desktop/models", Limit: desktopMaxModelRequest},
	"model.update":      {Name: "model.update", Scope: desktopProofAIScope, Method: http.MethodPut, Path: "/api/v1/desktop/models/{uuid}", Limit: desktopMaxModelRequest},
	"model.delete":      {Name: "model.delete", Scope: desktopProofAIScope, Method: http.MethodDelete, Path: "/api/v1/desktop/models/{uuid}", Limit: desktopMaxModelRequest},
	"model.test":        {Name: "model.test", Scope: desktopProofAIScope, Method: http.MethodPost, Path: "/api/v1/desktop/models/{uuid}/test", Limit: desktopMaxModelRequest},
	"routes.update":     {Name: "routes.update", Scope: desktopProofAIScope, Method: http.MethodPut, Path: "/api/v1/desktop/routes", Limit: desktopMaxModelRequest},
	"connection.create": {Name: "connection.create", Scope: desktopProofAIScope, Method: http.MethodPost, Path: "/api/v1/desktop/connections", Limit: desktopMaxModelRequest},

	// 平台采集操作。`connection.create` 是 AI 模型连接，平台连接一律 `platform.connection.*`。
	"platform.device.register":        {Name: "platform.device.register", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/devices", Limit: desktopPlatformRequestBytes, Register: true, Purpose: desktopPlatformRegisterPurpose},
	"platform.connection.create":      {Name: "platform.connection.create", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/connections", Limit: desktopPlatformRequestBytes},
	"platform.connection.verify":      {Name: "platform.connection.verify", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/connections/{uuid}/verify", Limit: desktopPlatformRequestBytes},
	"platform.connection.mine.list":   {Name: "platform.connection.mine.list", Scope: desktopProofPlatformAccountScope, Method: http.MethodGet, Path: "/api/v1/desktop/platform/connections/mine", Limit: desktopPlatformRequestBytes},
	"platform.connection.mine.revoke": {Name: "platform.connection.mine.revoke", Scope: desktopProofPlatformAccountScope, Method: http.MethodDelete, Path: "/api/v1/desktop/platform/connections/{uuid}", Limit: desktopPlatformRequestBytes},
	"platform.presence":               {Name: "platform.presence", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/presence", Limit: desktopPlatformRequestBytes},
	"platform.run.claim":              {Name: "platform.run.claim", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/runs/claim", Limit: desktopPlatformRequestBytes},
	"platform.run.heartbeat":          {Name: "platform.run.heartbeat", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/runs/{uuid}/heartbeat", Limit: desktopPlatformRequestBytes},
	"platform.run.result":             {Name: "platform.run.result", Scope: desktopProofPlatformScope, Method: http.MethodPost, Path: "/api/v1/desktop/platform/runs/{uuid}/results", Limit: desktopPlatformResultsBytes},
	"platform.run.receipt":            {Name: "platform.run.receipt", Scope: desktopProofPlatformWorkspaceScope, Method: http.MethodGet, Path: "/api/v1/desktop/platform/runs/{uuid}/receipts/{int}", Limit: desktopPlatformRequestBytes},
}

func desktopOperationOf(operation string) (desktopOperation, bool) {
	op, ok := desktopOperations[operation]
	return op, ok
}

func desktopOperationPathAllowed(operation, method, path string) bool {
	op, ok := desktopOperations[operation]
	return ok && op.matches(method, path)
}

func (op desktopOperation) matches(method, path string) bool {
	if path == "" || !strings.HasPrefix(path, "/api/v1/desktop/") || strings.Contains(path, "?") ||
		strings.Contains(path, "#") || strings.Contains(path, "\\") || strings.Contains(path, "..") {
		return false
	}
	if method != op.Method {
		return false
	}
	want := strings.Split(op.Path, "/")
	got := strings.Split(path, "/")
	if len(want) != len(got) {
		return false
	}
	for i, seg := range want {
		switch seg {
		case "{uuid}":
			if _, err := uuid.Parse(got[i]); err != nil {
				return false
			}
		case "{int}":
			if n, err := strconv.Atoi(got[i]); err != nil || n < 0 {
				return false
			}
		default:
			if seg != got[i] {
				return false
			}
		}
	}
	return true
}

// platformOperations 返回能力接口公布的平台操作名，顺序固定便于客户端稳定比较。
var platformOperations = []string{
	"platform.device.register",
	"platform.connection.create",
	"platform.connection.verify",
	"platform.connection.mine.list",
	"platform.connection.mine.revoke",
	"platform.presence",
	"platform.run.claim",
	"platform.run.heartbeat",
	"platform.run.result",
	"platform.run.receipt",
}

func desktopSignaturePayload(c desktopChallenge) []byte {
	return []byte(fmt.Sprintf("OPS-DESKTOP-CHALLENGE\n%d\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%d",
		desktopProtocolVersion, c.ID, base64.StdEncoding.EncodeToString(c.Nonce), c.UserID,
		c.SessionID, c.WorkspaceID, c.DeviceID, c.Operation, c.Method, c.Path,
		hex.EncodeToString(c.BodyHash[:]), c.ExpiresAt.Unix()))
}

// desktopReadAndVerifyProof 是所有持证请求的共享入口：先按操作固定的请求体上限读入，
// 再按一次消费挑战、签名、设备撤销校验，最后才分派到 AI 或平台采集策略。
// 平台端点不得复用 AI 的 32 MiB 上限，超限在验签前就按 413 拒绝，且不把 body 写入日志。
func (s *Server) desktopReadAndVerifyProof(r *http.Request, operation string) ([]byte, desktopChallenge, error) {
	op, known := desktopOperationOf(operation)
	if !known {
		return nil, desktopChallenge{}, validation("设备证明操作不受支持")
	}
	tooLarge := apiErr(413, "desktop_ai_response_too_large", "桌面设置请求超过允许大小")
	if op.Scope != desktopProofAIScope {
		tooLarge = apiErr(413, "platform_request_too_large", "平台采集请求超过允许大小")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, op.Limit+1))
	if err != nil {
		return nil, desktopChallenge{}, requestFormatError(r.Context(), err)
	}
	if int64(len(body)) > op.Limit {
		return nil, desktopChallenge{}, tooLarge
	}
	challengeID, err := uuid.Parse(r.Header.Get("X-OPS-Desktop-Challenge"))
	if err != nil {
		return nil, desktopChallenge{}, apiErr(403, "desktop_device_proof_invalid", "设备证明缺失或已过期，请重试")
	}
	sig, err := base64.StdEncoding.DecodeString(r.Header.Get("X-OPS-Desktop-Signature"))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, desktopChallenge{}, apiErr(403, "desktop_device_proof_invalid", "设备证明格式不正确")
	}
	s.desktop.mu.Lock()
	c, exists := s.desktop.challenges[challengeID]
	delete(s.desktop.challenges, challengeID) // consume before checking so a failed attempt cannot be replayed.
	s.desktop.mu.Unlock()
	id := ident(r.Context())
	if !exists || !c.ExpiresAt.After(s.now()) || c.Operation != operation || c.UserID != id.UserID ||
		c.SessionID != id.SessionID || c.WorkspaceID != id.WorkspaceID ||
		c.Method != r.Method || c.Path != r.URL.Path || !desktopHashMatches(c.BodyHash, body) {
		return nil, desktopChallenge{}, apiErr(403, "desktop_device_proof_invalid", "设备证明与当前请求不匹配，请重试")
	}
	if !ed25519.Verify(ed25519.PublicKey(c.PublicKey), desktopSignaturePayload(c), sig) {
		return nil, desktopChallenge{}, apiErr(403, "desktop_device_proof_invalid", "设备签名验证失败，请重新连接设备")
	}
	if !op.Register {
		var liveKey []byte
		if err := s.db.QueryRow(r.Context(), `SELECT public_key FROM desktop_device
			WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, c.DeviceID, id.UserID).Scan(&liveKey); err != nil || !bytes.Equal(liveKey, c.PublicKey) {
			code, msg := "desktop_device_revoked", "该设备已撤销或不可用"
			if op.Scope != desktopProofAIScope {
				code, msg = "platform_device_revoked", "该设备已撤销或不可用"
			}
			return nil, desktopChallenge{}, apiErr(403, code, msg)
		}
		if err := s.desktopRequireProofScope(r.Context(), op, c.DeviceID); err != nil {
			return nil, desktopChallenge{}, err
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, c, nil
}

// desktopRequireProofScope 在签名通过后按操作分派策略。AI 与平台两条链路互不代为授权：
// 平台开关关闭不影响 AI，AI 关闭也不阻止平台采集。
func (s *Server) desktopRequireProofScope(ctx context.Context, op desktopOperation, deviceID uuid.UUID) error {
	switch op.Scope {
	case desktopProofAIScope:
		return s.desktopRequireWorkspaceAccess(ctx, deviceID)
	case desktopProofPlatformScope:
		return s.desktopRequirePlatformCollectionAccess(ctx, deviceID)
	case desktopProofPlatformAccountScope:
		// 只减权的账户级回收：有效会话已经在中间件校验，这里只确认设备属于本人。
		id := ident(ctx)
		if id == nil || id.AdminOverride {
			return apiErr(403, "forbidden", "当前身份不能管理平台连接")
		}
		return nil
	case desktopProofPlatformWorkspaceScope:
		id := ident(ctx)
		if id == nil || id.AdminOverride {
			return apiErr(403, "forbidden", "当前身份不能读取平台采集状态")
		}
		if deviceID != uuid.Nil {
			return s.desktopRequireOwnedDevice(ctx, deviceID)
		}
		return nil
	default:
		return apiErr(403, "forbidden", "设备证明操作不受支持")
	}
}

func (s *Server) desktopRequireOwnedDevice(ctx context.Context, deviceID uuid.UUID) error {
	id := ident(ctx)
	if id == nil {
		return errUnauthorized
	}
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM desktop_device
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL)`, deviceID, id.UserID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return apiErr(403, "platform_device_revoked", "该设备已撤销或不可用")
	}
	return nil
}

func desktopHashMatches(want [32]byte, body []byte) bool {
	got := sha256.Sum256(body)
	return bytes.Equal(want[:], got[:])
}

func (s *Server) desktopRequireWorkspaceAccess(ctx context.Context, deviceID uuid.UUID) error {
	id := ident(ctx)
	if id == nil || id.AdminOverride {
		return apiErr(403, "desktop_ai_forbidden", "当前身份不能使用桌面 AI")
	}
	if !s.cfg.DesktopAIEnabled {
		return apiErr(503, "desktop_ai_forbidden", "服务端尚未启用桌面 AI")
	}
	policy, err := s.desktopPolicy(ctx, id.WorkspaceID)
	if err != nil {
		return err
	}
	if !policy.Enabled {
		return apiErr(403, "desktop_ai_forbidden", "当前工作区尚未启用桌面 AI")
	}
	switch id.Role {
	case "owner":
	case "editor":
		if !policy.AllowMemberEndpoints {
			return apiErr(403, "desktop_ai_forbidden", "工作区所有者未允许成员使用各自的桌面 AI 端点")
		}
	default:
		return apiErr(403, "desktop_ai_forbidden", "当前角色不能使用桌面 AI")
	}
	if deviceID != uuid.Nil {
		var exists bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM desktop_device
			WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL)`, deviceID, id.UserID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return apiErr(403, "desktop_device_revoked", "该设备已撤销或不可用")
		}
	}
	return nil
}

func (s *Server) desktopRegisterDevice(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "device.register")
	if err != nil {
		return err
	}
	in, publicKey, err := s.desktopDeviceFromProof(r, body, challenge)
	if err != nil {
		return err
	}
	id := ident(r.Context())
	if !id.ReauthOK {
		return errReauth
	}
	if err := s.desktopRequireWorkspaceAccess(r.Context(), uuid.Nil); err != nil {
		return err
	}
	return s.desktopInsertDevice(w, r, in, publicKey, "desktop_device_register")
}

// desktopPlatformRegisterDevice 是平台采集的首次设备登记。它写入同一张 desktop_device，
// 只按平台采集策略授权；登记平台设备不会因此获得桌面 AI 权限。
func (s *Server) desktopPlatformRegisterDevice(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "platform.device.register")
	if err != nil {
		return err
	}
	in, publicKey, err := s.desktopDeviceFromProof(r, body, challenge)
	if err != nil {
		return err
	}
	var purpose struct {
		Purpose string `json:"purpose"`
	}
	if err := json.Unmarshal(body, &purpose); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if strings.TrimSpace(purpose.Purpose) != desktopPlatformRegisterPurpose {
		return validation("平台设备登记缺少用途标识")
	}
	id := ident(r.Context())
	if !id.ReauthOK {
		return errReauth
	}
	if err := s.desktopRequirePlatformCollectionAccess(r.Context(), uuid.Nil); err != nil {
		return err
	}
	return s.desktopInsertDevice(w, r, in, publicKey, "platform_device_register")
}

func (s *Server) desktopDeviceFromProof(r *http.Request, body []byte, challenge desktopChallenge) (desktopDeviceInput, []byte, error) {
	var in desktopDeviceInput
	if err := json.Unmarshal(body, &in); err != nil {
		return in, nil, requestFormatError(r.Context(), err)
	}
	publicKey, err := base64.StdEncoding.DecodeString(in.PublicKey)
	if err != nil || in.ID != challenge.DeviceID || !bytes.Equal(publicKey, challenge.PublicKey) {
		return in, nil, validation("设备 ID 或公钥与挑战不匹配")
	}
	if in.ID == uuid.Nil || in.Platform != "windows-x64" || len(in.Name) > 80 || len(in.Version) > 40 {
		return in, nil, validation("设备信息不符合当前客户端支持范围")
	}
	return in, publicKey, nil
}

func (s *Server) desktopInsertDevice(w http.ResponseWriter, r *http.Request, in desktopDeviceInput, publicKey []byte, auditAction string) error {
	id := ident(r.Context())
	_, err := s.db.Exec(r.Context(), `INSERT INTO desktop_device (id, user_id, public_key, name, platform, version)
		VALUES ($1,$2,$3,$4,$5,$6)`, in.ID, id.UserID, publicKey, strings.TrimSpace(in.Name), in.Platform, strings.TrimSpace(in.Version))
	if err != nil {
		if isUniqueViolation(err) {
			return apiErr(409, "desktop_device_conflict", "该设备或公钥已登记")
		}
		return err
	}
	s.audit(r.Context(), auditAction, "desktop_device", in.ID.String(), "ok", nil)
	return ok(w, map[string]any{"id": in.ID, "registered": true})
}

func (d *desktopRuntime) allowChallenge(sessionID uuid.UUID, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	kept := trimChallengeStamps(d.challengeRate[sessionID], now.Add(-time.Minute))
	if len(kept) >= 12 {
		d.challengeRate[sessionID] = kept
		return false
	}
	d.challengeRate[sessionID] = append(kept, now)
	return true
}

// allowPlatformChallenge 是平台采集的独立配额：每设备每分钟 60 次，并按操作分桶，
// 忙的连接不能挤占同一设备上其他操作的额度。
func (d *desktopRuntime) allowPlatformChallenge(deviceID uuid.UUID, operation string, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	buckets := d.platformChallengeRate[deviceID]
	if buckets == nil {
		buckets = map[string][]time.Time{}
		d.platformChallengeRate[deviceID] = buckets
	}
	kept := trimChallengeStamps(buckets[operation], now.Add(-time.Minute))
	if len(kept) >= desktopPlatformChallengePerMin {
		buckets[operation] = kept
		return false
	}
	buckets[operation] = append(kept, now)
	return true
}

func (d *desktopRuntime) purgeExpiredLocked(now time.Time) {
	for id, c := range d.challenges {
		if !c.ExpiresAt.After(now) {
			delete(d.challenges, id)
		}
	}
	for token, ticket := range d.tickets {
		if !ticket.ExpiresAt.After(now) {
			delete(d.tickets, token)
		}
	}
	cutoff := now.Add(-time.Minute)
	for deviceID, buckets := range d.platformChallengeRate {
		for operation, stamps := range buckets {
			kept := trimChallengeStamps(stamps, cutoff)
			if len(kept) == 0 {
				delete(buckets, operation)
				continue
			}
			buckets[operation] = kept
		}
		if len(buckets) == 0 {
			delete(d.platformChallengeRate, deviceID)
		}
	}
}

func trimChallengeStamps(stamps []time.Time, cutoff time.Time) []time.Time {
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	return kept
}
