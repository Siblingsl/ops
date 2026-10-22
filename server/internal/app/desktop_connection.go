package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type desktopConnectionInput struct {
	DeviceID      uuid.UUID `json:"device_id"`
	RouteRevision int64     `json:"route_revision"`
}

type desktopWireMessage struct {
	Type            string                    `json:"type"`
	RequestID       uuid.UUID                 `json:"request_id,omitempty"`
	ParentRequestID uuid.UUID                 `json:"parent_request_id,omitempty"`
	ProviderID      uuid.UUID                 `json:"provider_id,omitempty"`
	Model           string                    `json:"model,omitempty"`
	Operation       string                    `json:"operation,omitempty"`
	Purpose         string                    `json:"purpose,omitempty"`
	ConfigRevision  int64                     `json:"config_revision,omitempty"`
	RouteRevision   int64                     `json:"route_revision,omitempty"`
	Generation      int64                     `json:"generation,omitempty"`
	ProtocolVersion int                       `json:"protocol_version,omitempty"`
	DeadlineMS      int64                     `json:"deadline_ms,omitempty"`
	BodyLength      int64                     `json:"body_length,omitempty"`
	Configs         []desktopProviderRevision `json:"configs,omitempty"`
	Direction       string                    `json:"direction,omitempty"`
	Sequence        uint32                    `json:"sequence,omitempty"`
	Status          int                       `json:"status,omitempty"`
	ContentType     string                    `json:"content_type,omitempty"`
	Count           int                       `json:"count,omitempty"`
	RetryAfter      string                    `json:"retry_after,omitempty"`
	ErrorCode       string                    `json:"error_code,omitempty"`
}

type desktopProviderRevision struct {
	ProviderID     uuid.UUID `json:"provider_id"`
	ConfigRevision int64     `json:"config_revision"`
}

func (s *Server) desktopRequestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deviceHeader := strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Device"))
		connectionHeader := strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Connection"))
		revisionHeader := strings.TrimSpace(r.Header.Get("X-OPS-Desktop-Policy"))
		if deviceHeader == "" && connectionHeader == "" && revisionHeader == "" {
			next.ServeHTTP(w, r)
			return
		}
		request := desktopRequest{RouteSnapshot: &desktopRouteSnapshot{}}
		request.DeviceID, request.Err = uuid.Parse(deviceHeader)
		if request.Err == nil && request.DeviceID == uuid.Nil {
			request.Err = fmt.Errorf("empty desktop device")
		}
		if request.Err == nil && connectionHeader != "" {
			parts := strings.Split(connectionHeader, ":")
			if len(parts) != 2 {
				request.Err = fmt.Errorf("invalid desktop connection header")
			} else {
				request.ConnectionID, request.Err = uuid.Parse(parts[0])
				if request.Err == nil {
					request.Generation, request.Err = strconv.ParseInt(parts[1], 10, 64)
				}
				if request.Err == nil && (request.ConnectionID == uuid.Nil || request.Generation < 1) {
					request.Err = fmt.Errorf("invalid desktop connection generation")
				}
			}
		}
		if request.Err == nil {
			request.RouteRevision, request.Err = strconv.ParseInt(revisionHeader, 10, 64)
			if request.Err == nil && request.RouteRevision < 1 {
				request.Err = fmt.Errorf("invalid desktop route revision")
			}
		}
		ctx := r.Context()
		if budget, ok := httpRequestBudgetOf(ctx); ok {
			request.ModelDeadline = budget.modelDeadline
		}
		next.ServeHTTP(w, r.WithContext(withDesktopRequest(ctx, request)))
	})
}

func (s *Server) desktopCreateConnectionTicket(w http.ResponseWriter, r *http.Request) error {
	body, challenge, err := s.desktopReadAndVerifyProof(r, "connection.create")
	if err != nil {
		return err
	}
	var in desktopConnectionInput
	if err := json.Unmarshal(body, &in); err != nil {
		return requestFormatError(r.Context(), err)
	}
	if in.DeviceID == uuid.Nil || in.DeviceID != challenge.DeviceID {
		return validation("设备与连接挑战不匹配")
	}
	if err := s.desktopRequireWorkspaceAccess(r.Context(), in.DeviceID); err != nil {
		return err
	}
	policy, err := s.desktopPolicy(r.Context(), ident(r.Context()).WorkspaceID)
	if err != nil {
		return err
	}
	routeRevision, err := s.desktopRouteRevision(r.Context(), ident(r.Context()).WorkspaceID, ident(r.Context()).UserID, in.DeviceID)
	if err != nil {
		return err
	}
	if in.RouteRevision != routeRevision {
		return apiErr(409, "desktop_ai_config_stale", "桌面任务路由已变化，请重新应用设置后连接")
	}
	ticket := make([]byte, 32)
	if _, err := rand.Read(ticket); err != nil {
		return err
	}
	ticketText := base64URL(ticket)
	digest := sha256.Sum256([]byte(ticketText))
	connectionID := uuid.New()
	id := ident(r.Context())
	key := desktopGenerationKey(id.UserID, id.WorkspaceID, in.DeviceID)
	s.desktopCloseConnections(func(c *desktopConnection) bool {
		return c.userID == id.UserID && c.workspaceID == id.WorkspaceID && c.deviceID == in.DeviceID
	})
	s.desktop.mu.Lock()
	s.desktop.generations[key]++
	generation := s.desktop.generations[key]
	s.desktop.purgeExpiredLocked(s.now())
	s.desktop.tickets[hex.EncodeToString(digest[:])] = desktopTicket{
		UserID: id.UserID, SessionID: id.SessionID, WorkspaceID: id.WorkspaceID,
		DeviceID: in.DeviceID, ConnectionID: connectionID, Generation: generation,
		RouteRevision: routeRevision, AuthorizationRev: policy.AuthorizationRevision,
		ExpiresAt: s.now().Add(desktopTicketTTL),
	}
	s.desktop.mu.Unlock()
	w.Header().Set("Cache-Control", "no-store")
	return ok(w, map[string]any{
		"ticket":                 ticketText,
		"connection_id":          connectionID,
		"generation":             generation,
		"route_revision":         routeRevision,
		"authorization_revision": policy.AuthorizationRevision,
		"expires_at":             s.now().Add(desktopTicketTTL),
	})
}

func (s *Server) desktopChannel(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.DesktopAIEnabled || r.URL.RawQuery != "" || r.Header.Get("Origin") != "" {
		writeError(w, r, apiErr(403, "desktop_ai_forbidden", "桌面通道请求无效或服务未启用"))
		return
	}
	maintenance, err := s.systemBool(r.Context(), "maintenance_mode", false)
	if err != nil || maintenance {
		writeError(w, r, apiErr(http.StatusServiceUnavailable, "maintenance", "系统维护中，桌面 AI 通道暂不可用"))
		return
	}
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Bearer ") {
		writeError(w, r, apiErr(401, "desktop_ticket_invalid", "桌面连接票据无效或已过期"))
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if token == "" || len(token) > 128 {
		writeError(w, r, apiErr(401, "desktop_ticket_invalid", "桌面连接票据无效或已过期"))
		return
	}
	digest := sha256.Sum256([]byte(token))
	ticketKey := hex.EncodeToString(digest[:])
	s.desktop.mu.Lock()
	ticket, ok := s.desktop.tickets[ticketKey]
	delete(s.desktop.tickets, ticketKey)
	s.desktop.mu.Unlock()
	if !ok || !ticket.ExpiresAt.After(s.now()) {
		writeError(w, r, apiErr(401, "desktop_ticket_invalid", "桌面连接票据无效或已过期"))
		return
	}
	id, err := s.loadIdentityBySession(r.Context(), ticket.SessionID)
	if err != nil || id.UserID != ticket.UserID || id.WorkspaceID != ticket.WorkspaceID || id.AdminOverride {
		writeError(w, r, apiErr(403, "desktop_ai_forbidden", "桌面连接所属会话或工作区已变化"))
		return
	}
	ctx := context.WithValue(r.Context(), ctxMember, id)
	if err := s.desktopRequireWorkspaceAccess(ctx, ticket.DeviceID); err != nil {
		writeError(w, r, err)
		return
	}
	policy, err := s.desktopPolicy(ctx, ticket.WorkspaceID)
	if err != nil || policy.AuthorizationRevision != ticket.AuthorizationRev {
		writeError(w, r, apiErr(409, "desktop_ai_config_stale", "工作区桌面 AI 授权已变化，请重新连接"))
		return
	}
	routeRevision, err := s.desktopRouteRevision(ctx, ticket.WorkspaceID, ticket.UserID, ticket.DeviceID)
	if err != nil || routeRevision != ticket.RouteRevision {
		writeError(w, r, apiErr(409, "desktop_ai_config_stale", "桌面任务路由已变化，请重新连接"))
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	conn.SetReadLimit(desktopChunkBytes + 20)
	c := &desktopConnection{
		id: ticket.ConnectionID, generation: ticket.Generation, userID: ticket.UserID,
		sessionID: ticket.SessionID, workspaceID: ticket.WorkspaceID, deviceID: ticket.DeviceID,
		routeRevision: ticket.RouteRevision, authorizationRev: ticket.AuthorizationRev,
		conn: conn, control: make(chan desktopFrame, 64), data: make(chan desktopFrame, desktopInflightChunks),
		done: make(chan struct{}), ready: make(chan struct{}), pending: map[uuid.UUID]*desktopPending{},
		configs: map[uuid.UUID]int64{}, lastHeartbeat: s.now(),
	}
	key := desktopGenerationKey(c.userID, c.workspaceID, c.deviceID)
	s.desktop.mu.Lock()
	if s.desktop.generations[key] != c.generation {
		s.desktop.mu.Unlock()
		_ = conn.Close(websocket.StatusPolicyViolation, "connection generation is stale")
		return
	}
	s.desktop.connections[c.id] = c
	s.desktop.mu.Unlock()
	_, _ = s.db.Exec(r.Context(), `UPDATE desktop_device SET last_seen_at=now() WHERE id=$1 AND user_id=$2`, c.deviceID, c.userID)
	s.desktopRunConnection(c)
}

func (s *Server) desktopRunConnection(c *desktopConnection) {
	writerErr := make(chan error, 1)
	go func() { writerErr <- s.desktopWriteLoop(c) }()
	go s.desktopWatchConnection(c)
	if err := s.desktopSendJSON(c, desktopWireMessage{
		Type: "channel.hello", RouteRevision: c.routeRevision,
		Generation: c.generation, ProtocolVersion: desktopProtocolVersion,
	}); err != nil {
		_ = c.conn.Close(websocket.StatusInternalError, "unable to initialize channel")
	} else {
		err := s.desktopReadLoop(c)
		if err != nil && websocket.CloseStatus(err) == -1 {
			_ = c.conn.Close(websocket.StatusInternalError, "channel ended")
		}
	}
	select {
	case <-writerErr:
	case <-time.After(2 * time.Second):
	}
	s.desktop.mu.Lock()
	delete(s.desktop.connections, c.id)
	s.desktop.mu.Unlock()
	c.closeOnce.Do(func() { close(c.done) })
	c.mu.Lock()
	for id, p := range c.pending {
		delete(c.pending, id)
		p.close(apiErr(502, "desktop_ai_offline", "桌面 AI 连接已断开"))
	}
	c.mu.Unlock()
	_ = c.conn.Close(websocket.StatusNormalClosure, "channel closed")
}

func (s *Server) desktopWriteLoop(c *desktopConnection) error {
	for {
		select {
		case <-c.done:
			return nil
		default:
		}
		var frame desktopFrame
		select {
		case frame = <-c.control:
		default:
			select {
			case frame = <-c.control:
			case frame = <-c.data:
			case <-c.done:
				return nil
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err := c.conn.Write(ctx, frame.kind, frame.data)
		cancel()
		if err != nil {
			return err
		}
	}
}

func (s *Server) desktopReadLoop(c *desktopConnection) error {
	for {
		kind, data, err := c.conn.Read(context.Background())
		if err != nil {
			return err
		}
		switch kind {
		case websocket.MessageText:
			if err := s.desktopHandleMessage(c, data); err != nil {
				return err
			}
		case websocket.MessageBinary:
			if err := s.desktopHandleResponseChunk(c, data); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unsupported websocket frame type")
		}
	}
}

func (s *Server) desktopWatchConnection(c *desktopConnection) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			stale := s.now().Sub(c.lastHeartbeat) > time.Minute
			c.mu.Unlock()
			if stale || s.desktopValidateConnection(c) != nil {
				_ = c.conn.Close(websocket.StatusPolicyViolation, "desktop authorization expired")
				return
			}
		}
	}
}

func (s *Server) desktopHandleMessage(c *desktopConnection, raw []byte) error {
	if len(raw) > desktopMaxControlBytes {
		return fmt.Errorf("oversized desktop channel control frame")
	}
	if !c.allowControlFrame(false, time.Now()) {
		return fmt.Errorf("desktop channel control rate exceeded")
	}
	var in desktopWireMessage
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("invalid desktop channel control frame")
	}
	switch in.Type {
	case "channel.ready":
		if err := s.desktopSetConnectionReady(c, in.Configs); err != nil {
			return err
		}
		return s.desktopSendJSON(c, desktopWireMessage{Type: "channel.ready_ack", Generation: c.generation})
	case "channel.heartbeat":
		c.mu.Lock()
		c.lastHeartbeat = s.now()
		c.mu.Unlock()
		return s.desktopSendJSON(c, desktopWireMessage{Type: "channel.heartbeat_ack"})
	case "channel.pong":
		c.mu.Lock()
		c.lastHeartbeat = s.now()
		c.mu.Unlock()
		return nil
	case "credit":
		p := s.desktopPendingOf(c, in.RequestID)
		if p == nil || in.Direction != "request" || in.Count < desktopChunkBytes || in.Count > desktopInflightChunks*desktopChunkBytes || in.Count%desktopChunkBytes != 0 {
			return fmt.Errorf("invalid request flow credit")
		}
		for i := 0; i < in.Count/desktopChunkBytes; i++ {
			select {
			case p.credits <- struct{}{}:
			default:
				return fmt.Errorf("request flow credit exceeded window")
			}
		}
		return nil
	case "upstream.headers":
		p := s.desktopPendingOf(c, in.RequestID)
		if p == nil || in.Status < 100 || in.Status > 599 || !desktopContentTypeAllowed(in.ContentType) {
			return fmt.Errorf("invalid desktop model response header")
		}
		p.responseMu.Lock()
		if p.responseStarted {
			p.responseMu.Unlock()
			return fmt.Errorf("duplicate desktop model response header")
		}
		p.responseStarted = true
		p.responseCredit = desktopInflightChunks * desktopChunkBytes
		p.responseMu.Unlock()
		select {
		case p.started <- desktopResponseStart{statusCode: in.Status, contentType: in.ContentType,
			retryAfter: in.RetryAfter, header: desktopResponseHeaders(desktopResponseStart{contentType: in.ContentType, retryAfter: in.RetryAfter})}:
		default:
			return fmt.Errorf("duplicate desktop model response header")
		}
		return s.desktopSendJSON(c, desktopWireMessage{Type: "response.credit", RequestID: in.RequestID,
			Direction: "response", Count: desktopInflightChunks * desktopChunkBytes})
	case "request.error":
		p := s.desktopPendingOf(c, in.RequestID)
		if p == nil {
			return fmt.Errorf("unknown desktop request")
		}
		p.responseMu.Lock()
		if p.responseStarted {
			p.responseMu.Unlock()
			return fmt.Errorf("duplicate desktop request error")
		}
		p.responseStarted = true
		p.responseMu.Unlock()
		msg := desktopSafeUpstreamError(in.ErrorCode)
		errorCode := desktopUpstreamErrorCode(in.ErrorCode)
		select {
		case p.started <- desktopResponseStart{statusCode: http.StatusBadGateway, contentType: "application/json",
			header: desktopResponseHeaders(desktopResponseStart{contentType: "application/json"}), err: fmt.Errorf("%s", msg)}:
		default:
			return fmt.Errorf("duplicate desktop request error")
		}
		select {
		case p.responseQueue <- []byte(fmt.Sprintf(`{"error":{"code":%q,"message":%q}}`, errorCode, msg)):
		case <-p.responseDone:
			return fmt.Errorf("desktop response already ended")
		case <-p.requestDone:
			return nil
		}
		p.endResponse()
		return nil
	case "upstream.end":
		p := s.desktopPendingOf(c, in.RequestID)
		if p == nil {
			return fmt.Errorf("unknown desktop response")
		}
		select {
		case <-p.responseDone:
			return fmt.Errorf("duplicate desktop response end")
		default:
		}
		p.responseMu.Lock()
		started := p.responseStarted
		p.responseMu.Unlock()
		if !started {
			return fmt.Errorf("desktop response ended before headers")
		}
		p.endResponse()
		return nil
	case "upstream.error":
		p := s.desktopPendingOf(c, in.RequestID)
		if p == nil {
			return fmt.Errorf("unknown desktop response")
		}
		p.responseMu.Lock()
		started := p.responseStarted
		p.responseMu.Unlock()
		if !started {
			return fmt.Errorf("desktop upstream error sent before headers")
		}
		select {
		case <-p.responseDone:
			return fmt.Errorf("duplicate desktop response end")
		default:
		}
		if in.ErrorCode != "credential_echo" && in.ErrorCode != "upstream_stream_failed" {
			return fmt.Errorf("invalid desktop upstream error code")
		}
		p.endResponseWithError(desktopModelStreamFailure{})
		return nil
	default:
		return fmt.Errorf("unsupported desktop channel message")
	}
}

func (s *Server) desktopHandleResponseChunk(c *desktopConnection, frame []byte) error {
	if len(frame) <= 20 || len(frame)-20 > desktopChunkBytes {
		return fmt.Errorf("invalid desktop response chunk")
	}
	id, err := uuid.FromBytes(frame[:16])
	if err != nil {
		return fmt.Errorf("invalid desktop request id")
	}
	p := s.desktopPendingOf(c, id)
	if p == nil {
		return fmt.Errorf("unknown desktop response request")
	}
	seq := binary.BigEndian.Uint32(frame[16:20])
	p.responseMu.Lock()
	defer p.responseMu.Unlock()
	select {
	case <-p.responseDone:
		return fmt.Errorf("desktop response has already ended")
	default:
	}
	if !p.responseStarted || seq != p.responseSeq || int64(len(frame)-20) > p.responseCredit {
		return fmt.Errorf("desktop response chunk is out of order or exceeds credit")
	}
	q := p.responseQueue
	if q == nil {
		return fmt.Errorf("desktop response body was not initialized")
	}
	select {
	case q <- append([]byte(nil), frame[20:]...):
		p.responseSeq++
		p.responseCredit -= int64(len(frame) - 20)
		return nil
	case <-p.responseDone:
		return fmt.Errorf("desktop response already ended")
	case <-p.requestDone:
		return nil
	default:
		return fmt.Errorf("desktop response exceeded granted flow window")
	}
}

func (s *Server) desktopPendingOf(c *desktopConnection, id uuid.UUID) *desktopPending {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pending[id]
}

func (s *Server) desktopSendJSON(c *desktopConnection, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > desktopMaxControlBytes {
		return fmt.Errorf("desktop channel control frame exceeds size limit")
	}
	if !c.allowControlFrame(true, time.Now()) {
		return fmt.Errorf("desktop channel control rate exceeded")
	}
	select {
	case c.control <- desktopFrame{kind: websocket.MessageText, data: b}:
		return nil
	case <-c.done:
		return fmt.Errorf("desktop channel is closed")
	default:
		return fmt.Errorf("desktop channel control queue is full")
	}
}

func (c *desktopConnection) allowControlFrame(outbound bool, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	bucket := &c.inControlBudget
	if outbound {
		bucket = &c.outControlBudget
	}
	if bucket.updatedAt.IsZero() {
		bucket.tokens = desktopControlBurst
		bucket.updatedAt = now
	}
	if elapsed := now.Sub(bucket.updatedAt).Seconds(); elapsed > 0 {
		bucket.tokens += elapsed * desktopControlRate
		if bucket.tokens > desktopControlBurst {
			bucket.tokens = desktopControlBurst
		}
		bucket.updatedAt = now
	}
	if bucket.tokens < 1 {
		return false
	}
	bucket.tokens--
	return true
}

func (s *Server) desktopSendData(ctx context.Context, c *desktopConnection, payload []byte) error {
	select {
	case c.data <- desktopFrame{kind: websocket.MessageBinary, data: payload}:
		return nil
	case <-c.done:
		return apiErr(503, "desktop_ai_offline", "桌面 AI 连接已断开")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) desktopValidateConnection(c *desktopConnection) error {
	id, err := s.loadIdentityBySession(context.Background(), c.sessionID)
	if err != nil || id.UserID != c.userID || id.WorkspaceID != c.workspaceID || id.AdminOverride {
		return apiErr(403, "desktop_ai_forbidden", "登录会话或工作区权限已变化")
	}
	ctx := context.WithValue(context.Background(), ctxMember, id)
	if err := s.desktopRequireWorkspaceAccess(ctx, c.deviceID); err != nil {
		return err
	}
	policy, err := s.desktopPolicy(ctx, c.workspaceID)
	if err != nil || policy.AuthorizationRevision != c.authorizationRev {
		return apiErr(403, "desktop_ai_forbidden", "工作区桌面 AI 授权已变化")
	}
	s.desktop.mu.Lock()
	generation := s.desktop.generations[desktopGenerationKey(c.userID, c.workspaceID, c.deviceID)]
	s.desktop.mu.Unlock()
	if generation != c.generation {
		return apiErr(403, "desktop_ai_forbidden", "桌面连接已被新会话替换")
	}
	return nil
}

func (s *Server) desktopSetConnectionReady(c *desktopConnection, configs []desktopProviderRevision) error {
	if len(configs) > 100 {
		return fmt.Errorf("too many desktop model configurations")
	}
	seen := map[uuid.UUID]bool{}
	verified := map[uuid.UUID]int64{}
	for _, cfg := range configs {
		if cfg.ProviderID == uuid.Nil || cfg.ConfigRevision < 1 || seen[cfg.ProviderID] {
			return fmt.Errorf("invalid desktop model configuration manifest")
		}
		seen[cfg.ProviderID] = true
		var revision int64
		err := s.db.QueryRow(context.Background(), `SELECT desktop_config_revision FROM model_provider
			WHERE id=$1 AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4
			AND execution_location='desktop' AND status='active'`, cfg.ProviderID, c.workspaceID,
			c.userID, c.deviceID).Scan(&revision)
		if err != nil || revision != cfg.ConfigRevision {
			return fmt.Errorf("desktop model configuration revision is not synchronized")
		}
		verified[cfg.ProviderID] = revision
	}
	c.mu.Lock()
	c.configs = verified
	c.readyOnce.Do(func() { close(c.ready) })
	c.mu.Unlock()
	return nil
}

func (s *Server) desktopRouteRevision(ctx context.Context, ws, user, device uuid.UUID) (int64, error) {
	var revision int64
	err := s.db.QueryRow(ctx, `SELECT revision FROM desktop_route_state
		WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`, ws, user, device).Scan(&revision)
	if err == pgx.ErrNoRows {
		return 1, nil
	}
	return revision, err
}

func desktopGenerationKey(user, workspace, device uuid.UUID) string {
	return user.String() + "/" + workspace.String() + "/" + device.String()
}

func base64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func desktopContentTypeAllowed(v string) bool {
	v = strings.ToLower(strings.TrimSpace(strings.SplitN(v, ";", 2)[0]))
	return v == "application/json" || v == "text/event-stream" || strings.HasPrefix(v, "image/") || v == "application/octet-stream"
}

func desktopSafeUpstreamError(code string) string {
	switch code {
	case "offline":
		return "客户端模型服务不可达"
	case "unauthorized":
		return "客户端模型鉴权失败，请检查本地密钥"
	case "timeout":
		return "客户端模型请求超时"
	case "redirect":
		return "客户端模型服务返回了重定向，请检查配置地址"
	case "protocol":
		return "客户端模型服务响应格式不受支持"
	default:
		return "客户端模型请求失败"
	}
}

func desktopUpstreamErrorCode(code string) string {
	switch code {
	case "offline":
		return "desktop_ai_offline"
	case "timeout":
		return "desktop_ai_timeout"
	case "unauthorized":
		return "desktop_ai_unauthorized"
	case "redirect":
		return "desktop_ai_redirect"
	case "protocol":
		return "desktop_ai_protocol"
	default:
		return "desktop_ai_upstream_unreachable"
	}
}

func desktopResponseChunk(id uuid.UUID, seq uint32, body []byte) []byte {
	frame := make([]byte, 20+len(body))
	copy(frame[:16], id[:])
	binary.BigEndian.PutUint32(frame[16:20], seq)
	copy(frame[20:], body)
	return frame
}
