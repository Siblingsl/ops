package app

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const (
	desktopProtocolVersion  = 1
	desktopChallengeTTL     = time.Minute
	desktopTicketTTL        = time.Minute
	desktopMaxControlBytes  = 16 << 10
	desktopControlRate      = 2048
	desktopControlBurst     = 4096
	desktopChunkBytes       = 64 << 10
	desktopMaxModelRequest  = 32 << 20
	desktopMaxModelResponse = 16 << 20
	desktopInflightChunks   = 4

	// 平台采集（D-129 / 20 文档 §11.1）：独立挑战配额与请求体上限，不沿用 AI 的 12 次/分钟与 32 MiB。
	desktopPlatformProtocolVersion = 1
	desktopPlatformChallengePerMin = 60
	desktopPlatformRequestBytes    = 64 << 10
	desktopPlatformResultsBytes    = 2 << 20
	desktopPlatformV1ResultsBytes  = 512 << 10
	desktopPlatformProtocolV2      = 2
)

type desktopRuntime struct {
	mu            sync.Mutex
	challenges    map[uuid.UUID]desktopChallenge
	challengeRate map[uuid.UUID][]time.Time
	// platformChallengeRate 按“设备 + 操作”分桶，设备 ID 在登记前即已由客户端生成，
	// 因此首次 platform.device.register 也能按设备限流。
	platformChallengeRate map[uuid.UUID]map[string][]time.Time
	tickets               map[string]desktopTicket
	connections           map[uuid.UUID]*desktopConnection
	generations           map[string]int64
	modelTests            map[uuid.UUID]desktopModelTest
}

func newDesktopRuntime() *desktopRuntime {
	return &desktopRuntime{
		challenges:            map[uuid.UUID]desktopChallenge{},
		challengeRate:         map[uuid.UUID][]time.Time{},
		platformChallengeRate: map[uuid.UUID]map[string][]time.Time{},
		tickets:               map[string]desktopTicket{},
		connections:           map[uuid.UUID]*desktopConnection{},
		generations:           map[string]int64{},
		modelTests:            map[uuid.UUID]desktopModelTest{},
	}
}

type desktopChallenge struct {
	ID          uuid.UUID
	Nonce       []byte
	UserID      uuid.UUID
	SessionID   uuid.UUID
	WorkspaceID uuid.UUID
	DeviceID    uuid.UUID
	Operation   string
	Method      string
	Path        string
	BodyHash    [32]byte
	PublicKey   []byte
	ExpiresAt   time.Time
}

type desktopTicket struct {
	UserID           uuid.UUID
	SessionID        uuid.UUID
	WorkspaceID      uuid.UUID
	DeviceID         uuid.UUID
	ConnectionID     uuid.UUID
	Generation       int64
	RouteRevision    int64
	AuthorizationRev int64
	ExpiresAt        time.Time
}

type desktopExecution struct {
	UserID           uuid.UUID
	SessionID        uuid.UUID
	WorkspaceID      uuid.UUID
	DeviceID         uuid.UUID
	ConnectionID     uuid.UUID
	ParentRequestID  uuid.UUID
	Generation       int64
	ProviderID       uuid.UUID
	Model            string
	ConfigRevision   int64
	RouteRevision    int64
	AuthorizationRev int64
	Purpose          string
	Deadline         time.Time
}

type desktopRequest struct {
	DeviceID      uuid.UUID
	ConnectionID  uuid.UUID
	Generation    int64
	RouteRevision int64
	ModelDeadline time.Time
	RouteSnapshot *desktopRouteSnapshot
	Err           error
}

type desktopRouteSnapshot struct {
	mu                    sync.Mutex
	loaded                bool
	routes                map[string]desktopRouteInput
	routeRevision         int64
	authorizationRevision int64
	err                   error
}

type desktopRequestContextKey struct{}

func withDesktopRequest(ctx context.Context, request desktopRequest) context.Context {
	return context.WithValue(ctx, desktopRequestContextKey{}, request)
}

func desktopRequestOf(ctx context.Context) (desktopRequest, bool) {
	request, ok := ctx.Value(desktopRequestContextKey{}).(desktopRequest)
	return request, ok
}

func inheritDesktopRequest(source, target context.Context) context.Context {
	if request, ok := desktopRequestOf(source); ok {
		return withDesktopRequest(target, request)
	}
	return target
}

func inheritDesktopRequestForBackground(source, target context.Context) context.Context {
	request, ok := desktopRequestOf(source)
	if !ok {
		return target
	}
	request.ModelDeadline = time.Time{}
	return withDesktopRequest(target, request)
}

type desktopConnection struct {
	id               uuid.UUID
	generation       int64
	userID           uuid.UUID
	sessionID        uuid.UUID
	workspaceID      uuid.UUID
	deviceID         uuid.UUID
	routeRevision    int64
	authorizationRev int64
	conn             *websocket.Conn
	control          chan desktopFrame
	data             chan desktopFrame
	done             chan struct{}
	closeOnce        sync.Once
	ready            chan struct{}
	readyOnce        sync.Once
	mu               sync.Mutex
	pending          map[uuid.UUID]*desktopPending
	configs          map[uuid.UUID]int64
	lastHeartbeat    time.Time
	inControlBudget  desktopControlBudget
	outControlBudget desktopControlBudget
}

type desktopControlBudget struct {
	tokens    float64
	updatedAt time.Time
}

type desktopFrame struct {
	kind websocket.MessageType
	data []byte
}

type desktopPending struct {
	id              uuid.UUID
	execution       desktopExecution
	started         chan desktopResponseStart
	response        *io.PipeWriter
	responseQueue   chan []byte
	responseDone    chan struct{}
	responseSeq     uint32
	responseLimit   int64
	responseCredit  int64
	responseStarted bool
	responseErr     error
	responseMu      sync.Mutex
	credits         chan struct{}
	requestDone     chan struct{}
	closeOnce       sync.Once
	responseOnce    sync.Once
}

type desktopResponseStart struct {
	statusCode  int
	contentType string
	retryAfter  string
	header      http.Header
	err         error
}

type desktopModelTest struct {
	ID               uuid.UUID
	UserID           uuid.UUID
	SessionID        uuid.UUID
	WorkspaceID      uuid.UUID
	DeviceID         uuid.UUID
	ConnectionID     uuid.UUID
	Generation       int64
	RouteRevision    int64
	AuthorizationRev int64
	ProviderID       uuid.UUID
	Model            string
	ConfigRevision   int64
	Status           string
	Stage            string
	Summary          string
	OK               bool
	Results          []desktopModelTestResult
	ExpiresAt        time.Time
}

type desktopModelTestResult struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	OK        bool   `json:"ok"`
	Skipped   bool   `json:"skipped,omitempty"`
	Detail    string `json:"detail"`
	LatencyMS int64  `json:"latency_ms"`
}

func (s *Server) desktopCancelWorkspace(workspaceID uuid.UUID) {
	s.desktopCloseConnections(func(c *desktopConnection) bool { return c.workspaceID == workspaceID })
}

func (s *Server) desktopRevokeDevice(userID, deviceID uuid.UUID) {
	s.desktopCloseConnections(func(c *desktopConnection) bool {
		return c.userID == userID && c.deviceID == deviceID
	})
}

func (s *Server) desktopCloseConnections(match func(*desktopConnection) bool) {
	var closing []*desktopConnection
	s.desktop.mu.Lock()
	for id, c := range s.desktop.connections {
		if match(c) {
			delete(s.desktop.connections, id)
			closing = append(closing, c)
		}
	}
	s.desktop.mu.Unlock()
	for _, c := range closing {
		c.closeOnce.Do(func() { close(c.done) })
		_ = c.conn.Close(websocket.StatusPolicyViolation, "desktop AI authorization changed")
		c.mu.Lock()
		for _, p := range c.pending {
			p.close(io.ErrClosedPipe)
		}
		c.mu.Unlock()
	}
}

func (p *desktopPending) close(err error) {
	p.closeOnce.Do(func() {
		if p.response != nil {
			_ = p.response.CloseWithError(err)
		}
		p.endResponse()
		close(p.requestDone)
	})
}

func (p *desktopPending) endResponse() {
	p.endResponseWithError(nil)
}

func (p *desktopPending) endResponseWithError(err error) {
	p.responseOnce.Do(func() {
		p.responseMu.Lock()
		p.responseErr = err
		close(p.responseDone)
		p.responseMu.Unlock()
	})
}
