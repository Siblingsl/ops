package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	errDesktopModelTransport = errors.New("desktop model transport failed")
	errDesktopModelStream    = errors.New("desktop model stream failed")
)

type desktopModelStreamFailure struct{}

func (desktopModelStreamFailure) Error() string {
	return "客户端模型响应被安全过滤或意外中止"
}

func (desktopModelStreamFailure) Unwrap() error { return errDesktopModelStream }

type desktopExecutionContextKey struct{}

func withDesktopExecution(ctx context.Context, execution desktopExecution) context.Context {
	return context.WithValue(ctx, desktopExecutionContextKey{}, execution)
}

type desktopRoundTripper struct {
	server *Server
	scope  *desktopRequestScope
}

type desktopRequestScope struct {
	mu            sync.Mutex
	imageParentID uuid.UUID
}

func (s *desktopRequestScope) setImageParentID(id uuid.UUID) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.imageParentID = id
	s.mu.Unlock()
}

func (s *desktopRequestScope) takeImageParentID() uuid.UUID {
	if s == nil {
		return uuid.Nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.imageParentID
	s.imageParentID = uuid.Nil
	return id
}

func (s *Server) aiClientForRoute(ctx context.Context, rt *route) (context.Context, *http.Client) {
	if rt == nil || rt.Desktop == nil {
		return ctx, s.aiHTTP
	}
	execution := *rt.Desktop
	deadline := s.now().Add(5 * time.Minute)
	if parentDeadline, ok := ctx.Deadline(); ok && parentDeadline.Before(deadline) {
		deadline = parentDeadline
	}
	if request, ok := desktopRequestOf(ctx); ok && !request.ModelDeadline.IsZero() && request.ModelDeadline.Before(deadline) {
		deadline = request.ModelDeadline
	}
	if execution.Deadline.IsZero() || deadline.Before(execution.Deadline) {
		execution.Deadline = deadline
	}
	ctx = withDesktopExecution(ctx, execution)
	return ctx, &http.Client{Timeout: time.Until(execution.Deadline), Transport: desktopRoundTripper{server: s, scope: &desktopRequestScope{}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func (t desktopRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	execution, ok := req.Context().Value(desktopExecutionContextKey{}).(desktopExecution)
	if !ok {
		return nil, fmt.Errorf("%w: desktop execution context is missing", errDesktopModelTransport)
	}
	operation, err := desktopOperationForRequest(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDesktopModelTransport, err)
	}
	if execution.Purpose != "business" && execution.Purpose != "self_test" {
		return nil, fmt.Errorf("%w: desktop execution purpose is invalid", errDesktopModelTransport)
	}
	if execution.Deadline.IsZero() || time.Until(execution.Deadline) <= 0 {
		return nil, fmt.Errorf("%w: desktop model deadline expired", errDesktopModelTransport)
	}
	if operation == "generated_image_fetch" {
		execution.ParentRequestID = t.scope.takeImageParentID()
		if execution.ParentRequestID == uuid.Nil {
			return nil, fmt.Errorf("%w: desktop generated-image fetch has no active parent request", errDesktopModelTransport)
		}
	}
	c, err := t.server.desktopExecutionConnection(execution)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDesktopModelTransport, err)
	}
	p, err := t.server.desktopOpenRequest(req.Context(), c, execution, operation, req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errDesktopModelTransport, err)
	}
	start, err := t.server.desktopUploadAndWait(req.Context(), c, p, req)
	if err != nil {
		t.server.desktopRemovePending(c, p)
		return nil, fmt.Errorf("%w: %v", errDesktopModelTransport, err)
	}
	if operation == "image_generations" && start.statusCode == http.StatusOK {
		t.scope.setImageParentID(p.id)
	}
	reader, writer := io.Pipe()
	p.response = writer
	go t.server.desktopPumpResponse(c, p, writer)
	return &http.Response{
		Status:        fmt.Sprintf("%d %s", start.statusCode, http.StatusText(start.statusCode)),
		StatusCode:    start.statusCode,
		Header:        start.header,
		Body:          reader,
		ContentLength: -1,
		Request:       req,
	}, nil
}

func desktopOperationForRequest(req *http.Request) (string, error) {
	if req.Method != http.MethodPost || req.URL == nil || req.URL.Scheme != "ops-desktop" || req.URL.Host != "local" || req.URL.RawQuery != "" {
		return "", fmt.Errorf("desktop AI transport rejected an unsupported request")
	}
	switch req.URL.EscapedPath() {
	case "/chat/completions":
		return "chat_completions", nil
	case "/images/generations":
		return "image_generations", nil
	case "/generated_image_fetch":
		return "generated_image_fetch", nil
	default:
		return "", fmt.Errorf("desktop AI transport rejected an unsupported operation")
	}
}

func (s *Server) desktopExecutionConnection(execution desktopExecution) (*desktopConnection, error) {
	s.desktop.mu.Lock()
	c := s.desktop.connections[execution.ConnectionID]
	s.desktop.mu.Unlock()
	if c == nil || c.userID != execution.UserID || c.sessionID != execution.SessionID ||
		c.workspaceID != execution.WorkspaceID || c.deviceID != execution.DeviceID || c.generation != execution.Generation ||
		c.authorizationRev != execution.AuthorizationRev {
		return nil, fmt.Errorf("desktop AI connection is unavailable")
	}
	select {
	case <-c.ready:
	case <-c.done:
		return nil, fmt.Errorf("desktop AI connection closed before ready")
	case <-time.After(10 * time.Second):
		return nil, fmt.Errorf("desktop AI connection was not ready")
	}
	c.mu.Lock()
	configRevision := c.configs[execution.ProviderID]
	c.mu.Unlock()
	if configRevision == 0 || configRevision != execution.ConfigRevision {
		return nil, fmt.Errorf("desktop AI provider configuration is not synchronized")
	}
	if err := s.desktopValidateConnection(c); err != nil {
		return nil, err
	}
	var liveRevision int64
	err := s.db.QueryRow(context.Background(), `SELECT desktop_config_revision FROM model_provider
		WHERE id=$1 AND workspace_id=$2 AND desktop_user_id=$3 AND desktop_device_id=$4
		AND execution_location='desktop' AND status='active'`, execution.ProviderID,
		execution.WorkspaceID, execution.UserID, execution.DeviceID).Scan(&liveRevision)
	if err != nil || liveRevision != execution.ConfigRevision {
		return nil, fmt.Errorf("desktop AI provider configuration is stale")
	}
	return c, nil
}

func (s *Server) desktopOpenRequest(ctx context.Context, c *desktopConnection, execution desktopExecution, operation string, req *http.Request) (*desktopPending, error) {
	if operation == "generated_image_fetch" && execution.ParentRequestID == uuid.Nil {
		return nil, fmt.Errorf("desktop generated-image fetch parent is missing")
	}
	length := req.ContentLength
	if length < 0 {
		return nil, fmt.Errorf("desktop AI request length must be known")
	}
	maxBytes := int64(desktopMaxModelRequest)
	if operation == "image_generations" {
		maxBytes = 32 << 20
	}
	if length > maxBytes {
		return nil, fmt.Errorf("desktop AI request exceeds the allowed size")
	}
	c.mu.Lock()
	if len(c.pending) >= 2 {
		c.mu.Unlock()
		return nil, fmt.Errorf("desktop AI connection reached its concurrent request limit")
	}
	p := &desktopPending{
		id: uuid.New(), execution: execution,
		started:       make(chan desktopResponseStart, 1),
		responseQueue: make(chan []byte, desktopInflightChunks),
		responseDone:  make(chan struct{}),
		credits:       make(chan struct{}, desktopInflightChunks),
		requestDone:   make(chan struct{}),
	}
	p.responseLimit = int64(desktopMaxModelResponse)
	if operation == "image_generations" {
		p.responseLimit = 18 << 20
	} else if operation == "generated_image_fetch" {
		p.responseLimit = 12 << 20
	}
	c.pending[p.id] = p
	c.mu.Unlock()
	deadlineMS := time.Until(execution.Deadline).Milliseconds()
	if deadlineMS <= 0 {
		s.desktopRemovePending(c, p)
		return nil, fmt.Errorf("desktop model deadline expired")
	}
	err := s.desktopSendJSON(c, desktopWireMessage{
		Type: "request.open", RequestID: p.id, ParentRequestID: execution.ParentRequestID, ProviderID: execution.ProviderID,
		Model: execution.Model, Operation: operation, Purpose: execution.Purpose,
		ConfigRevision: execution.ConfigRevision, Generation: execution.Generation, DeadlineMS: deadlineMS, BodyLength: length,
	})
	if err != nil {
		s.desktopRemovePending(c, p)
		return nil, err
	}
	return p, nil
}

func (s *Server) desktopUploadAndWait(ctx context.Context, c *desktopConnection, p *desktopPending, req *http.Request) (desktopResponseStart, error) {
	defer req.Body.Close()
	var seq uint32
	var sent int64
	buf := make([]byte, desktopChunkBytes)
	for {
		if err := ctx.Err(); err != nil {
			s.desktopCancelRequest(c, p, "cancelled")
			return desktopResponseStart{}, err
		}
		n, readErr := io.ReadFull(req.Body, buf)
		if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
			s.desktopCancelRequest(c, p, "request_read_failed")
			return desktopResponseStart{}, readErr
		}
		if n > 0 {
			sent += int64(n)
			if sent > req.ContentLength || sent > 32<<20 {
				s.desktopCancelRequest(c, p, "request_too_large")
				return desktopResponseStart{}, fmt.Errorf("desktop AI request exceeded declared size")
			}
			select {
			case <-p.credits:
			case <-ctx.Done():
				s.desktopCancelRequest(c, p, "cancelled")
				return desktopResponseStart{}, ctx.Err()
			case <-c.done:
				return desktopResponseStart{}, fmt.Errorf("desktop AI connection closed")
			case <-p.requestDone:
				return desktopResponseStart{}, fmt.Errorf("desktop AI request was cancelled")
			}
			if err := s.desktopSendData(ctx, c, desktopResponseChunk(p.id, seq, buf[:n])); err != nil {
				return desktopResponseStart{}, err
			}
			seq++
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
	}
	if sent != req.ContentLength {
		s.desktopCancelRequest(c, p, "request_length_mismatch")
		return desktopResponseStart{}, fmt.Errorf("desktop AI request body length mismatch")
	}
	if err := s.desktopSendJSON(c, desktopWireMessage{Type: "request.end", RequestID: p.id, Sequence: seq}); err != nil {
		return desktopResponseStart{}, err
	}
	select {
	case start := <-p.started:
		return start, nil
	case <-ctx.Done():
		s.desktopCancelRequest(c, p, "cancelled")
		return desktopResponseStart{}, ctx.Err()
	case <-c.done:
		return desktopResponseStart{}, fmt.Errorf("desktop AI connection closed")
	case <-p.requestDone:
		return desktopResponseStart{}, fmt.Errorf("desktop AI request was cancelled")
	}
}

func (s *Server) desktopCancelRequest(c *desktopConnection, p *desktopPending, reason string) {
	_ = s.desktopSendJSON(c, desktopWireMessage{Type: "request.cancel", RequestID: p.id, ErrorCode: reason})
	p.close(fmt.Errorf("desktop AI request cancelled"))
	s.desktopRemovePending(c, p)
}

func (s *Server) desktopPumpResponse(c *desktopConnection, p *desktopPending, writer *io.PipeWriter) {
	defer s.desktopRemovePending(c, p)
	var total int64
	for {
		select {
		case body := <-p.responseQueue:
			total += int64(len(body))
			if total > p.responseLimit {
				_ = writer.CloseWithError(fmt.Errorf("desktop AI response exceeds size limit"))
				s.desktopCancelRequest(c, p, "response_too_large")
				return
			}
			if _, err := writer.Write(body); err != nil {
				s.desktopCancelRequest(c, p, "response_consumer_closed")
				return
			}
			p.responseMu.Lock()
			p.responseCredit += int64(len(body))
			p.responseMu.Unlock()
			_ = s.desktopSendJSON(c, desktopWireMessage{Type: "response.credit", RequestID: p.id,
				Direction: "response", Count: len(body)})
		case <-p.responseDone:
			for {
				select {
				case body := <-p.responseQueue:
					total += int64(len(body))
					if total > p.responseLimit {
						_ = writer.CloseWithError(fmt.Errorf("desktop AI response exceeds size limit"))
						return
					}
					if _, err := writer.Write(body); err != nil {
						return
					}
				default:
					p.responseMu.Lock()
					responseErr := p.responseErr
					p.responseMu.Unlock()
					if responseErr != nil {
						_ = writer.CloseWithError(responseErr)
					} else {
						_ = writer.Close()
					}
					p.close(io.EOF)
					return
				}
			}
		case <-p.requestDone:
			_ = writer.CloseWithError(io.ErrClosedPipe)
			return
		case <-c.done:
			_ = writer.CloseWithError(io.ErrClosedPipe)
			return
		}
	}
}

func (s *Server) desktopRemovePending(c *desktopConnection, p *desktopPending) {
	c.mu.Lock()
	if c.pending[p.id] == p {
		delete(c.pending, p.id)
	}
	c.mu.Unlock()
	p.close(io.ErrClosedPipe)
}

func desktopExecutionSnapshot(id *identity, deviceID uuid.UUID, c *desktopConnection,
	providerID uuid.UUID, model string, configRevision int64, purpose string, deadline time.Time) desktopExecution {
	return desktopExecution{UserID: id.UserID, SessionID: id.SessionID, WorkspaceID: id.WorkspaceID,
		DeviceID: deviceID, ConnectionID: c.id, Generation: c.generation, ProviderID: providerID,
		Model: model, ConfigRevision: configRevision, RouteRevision: c.routeRevision,
		AuthorizationRev: c.authorizationRev, Purpose: purpose, Deadline: deadline}
}

func desktopResponseHeaders(start desktopResponseStart) http.Header {
	h := make(http.Header)
	if start.contentType != "" {
		h.Set("Content-Type", start.contentType)
	}
	if desktopRetryAfterAllowed(start.retryAfter) {
		h.Set("Retry-After", start.retryAfter)
	}
	return h
}

func desktopRetryAfterAllowed(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return false
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		return seconds >= 0 && seconds <= 86400
	}
	_, err := http.ParseTime(value)
	return err == nil
}

var _ http.RoundTripper = desktopRoundTripper{}
