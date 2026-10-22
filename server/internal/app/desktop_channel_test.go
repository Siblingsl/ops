package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"ops/internal/secure"
)

func TestDesktopChannelWithRealElectron(t *testing.T) {
	if os.Getenv("OPS_DESKTOP_REAL_ELECTRON_E2E") != "1" {
		t.Skip("set OPS_DESKTOP_REAL_ELECTRON_E2E=1 to run the local Electron integration")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	coldContentStarted := make(chan time.Time, 1)
	coldContentFinished := make(chan time.Time, 1)
	localModel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/images/generations" {
			http.Error(w, "image generation is outside this text integration", http.StatusNotImplemented)
			return
		}
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer local-test-key" {
			http.Error(w, "unexpected local model request", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "unable to read request", http.StatusBadRequest)
			return
		}
		var request struct {
			ResponseFormat json.RawMessage   `json:"response_format"`
			Tools          []json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(body, &request); err != nil {
			http.Error(w, "invalid model request", http.StatusBadRequest)
			return
		}
		coldStart := strings.Contains(string(body), "cold-start-e2e")
		content := "ok"
		if len(request.Tools) > 0 {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_probe\",\"type\":\"function\",\"function\":{\"name\":\"ops_probe_echo\",\"arguments\":\"{\\\"value\\\":\\\"ok\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		if len(request.ResponseFormat) > 0 {
			content = `{"ok":true}`
		} else if strings.Contains(string(body), "连接正常") {
			content = "连接正常"
		} else if strings.Contains(string(body), "图片中的圆形") {
			content = "红色"
		} else if coldStart {
			content = "cold-start-ready"
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if coldStart {
			coldContentStarted <- time.Now()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(30 * time.Second):
			}
		}
		frame, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{
			"index": 0, "delta": map[string]string{"content": content}, "finish_reason": "stop",
		}}})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		if coldStart {
			coldContentFinished <- time.Now()
		}
	}))
	defer localModel.Close()
	userID, workspaceID, sessionID := uuid.New(), uuid.New(), uuid.New()
	username := "desktop_electron_" + userID.String()
	token := uuid.NewString()

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id,username,password_hash) VALUES ($1,$2,'test')`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES ($1,'desktop Electron channel test',$2)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO session (id,user_id,current_workspace_id,token_hash,expires_at,reauth_until)
		VALUES ($1,$2,$3,$4,$5,$5)`, sessionID, userID, workspaceID, secure.SHA256([]byte(token)), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_ai_policy (workspace_id,enabled) VALUES ($1,true)`, workspaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, workspaceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM app_user WHERE id=$1`, userID)
	})

	oldEnabled := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = true
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = oldEnabled })

	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("unable to locate integration test source")
	}
	helper := filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", "desktop", "test", "desktop-channel-backend-e2e.cjs")
	command := exec.CommandContext(ctx, "node", helper)
	command.Env = append(os.Environ(),
		"OPS_DESKTOP_CHANNEL_TEST_ORIGIN="+env.http.URL,
		"OPS_DESKTOP_CHANNEL_TEST_SESSION="+token,
		"OPS_DESKTOP_CHANNEL_TEST_LOCAL_MODEL_URL="+localModel.URL+"/v1",
		"OPS_DESKTOP_REAL_ELECTRON_E2E=1",
	)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start Electron integration helper: %v", err)
	}
	commandDone := make(chan error, 1)
	go func() { commandDone <- command.Wait() }()

	var connected *desktopConnection
	var initialHeartbeat time.Time
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for connected == nil {
		select {
		case <-ctx.Done():
			t.Fatalf("Electron did not establish an authenticated WSS connection: %v", ctx.Err())
		case err := <-commandDone:
			if err != nil {
				t.Fatalf("Electron integration helper exited before connecting: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
			}
			t.Fatalf("Electron integration helper exited without an active connection; stdout=%s; stderr=%s", stdout.String(), stderr.String())
		case <-ticker.C:
			env.srv.desktop.mu.Lock()
			for _, candidate := range env.srv.desktop.connections {
				if candidate.userID == userID && candidate.workspaceID == workspaceID {
					connected = candidate
					break
				}
			}
			env.srv.desktop.mu.Unlock()
			if connected != nil {
				connected.mu.Lock()
				initialHeartbeat = connected.lastHeartbeat
				connected.mu.Unlock()
			}
		}
	}

heartbeatLoop:
	for {
		select {
		case <-ctx.Done():
			t.Fatalf("Electron WSS connection did not send a heartbeat: %v", ctx.Err())
		case err := <-commandDone:
			if err != nil {
				t.Fatalf("Electron integration helper failed: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
			}
			t.Fatalf("Electron disconnected before the Go server observed a heartbeat; stdout=%s; stderr=%s", stdout.String(), stderr.String())
		case <-ticker.C:
			connected.mu.Lock()
			heartbeatReceived := connected.lastHeartbeat.After(initialHeartbeat)
			connected.mu.Unlock()
			if heartbeatReceived {
				break heartbeatLoop
			}
		}
	}

	// The local model response sends SSE headers immediately but withholds its
	// first text delta for 30 seconds. This exercises the real route, WSS relay,
	// Electron utility process, and first-content budget as one integration.
	var providerID uuid.UUID
	var configRevision, routeRevision int64
	providerReady := false
	for !providerReady {
		select {
		case <-ctx.Done():
			t.Fatalf("Electron did not apply the local cold-start model route: %v; stdout=%s; stderr=%s", ctx.Err(), stdout.String(), stderr.String())
		case err := <-commandDone:
			if err != nil {
				t.Fatalf("Electron failed while preparing the local cold-start model: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
			}
			t.Fatalf("Electron exited before applying the local cold-start model route; stdout=%s; stderr=%s", stdout.String(), stderr.String())
		case <-ticker.C:
			var err error
			err = env.srv.db.QueryRow(ctx, `SELECT p.id, p.desktop_config_revision
				FROM model_provider p JOIN desktop_route r ON r.provider_id=p.id AND r.workspace_id=p.workspace_id
				AND r.user_id=p.desktop_user_id AND r.device_id=p.desktop_device_id AND r.task_type='default'
				WHERE p.workspace_id=$1 AND p.desktop_user_id=$2 AND p.desktop_device_id=$3
				AND p.name='Cold start integration' AND r.execution_location='desktop'`,
				workspaceID, userID, connected.deviceID).Scan(&providerID, &configRevision)
			if err != nil {
				continue
			}
			err = env.srv.db.QueryRow(ctx, `SELECT revision FROM desktop_route_state
				WHERE workspace_id=$1 AND user_id=$2 AND device_id=$3`, workspaceID, userID, connected.deviceID).Scan(&routeRevision)
			if err != nil {
				continue
			}
			connected.mu.Lock()
			providerReady = connected.configs[providerID] == configRevision
			connected.mu.Unlock()
		}
	}

	callCtx := context.WithValue(ctx, ctxMember, &identity{
		UserID: userID, SessionID: sessionID, WorkspaceID: workspaceID, Role: "owner",
	})
	desktopCall := desktopRequest{
		DeviceID: connected.deviceID, ConnectionID: connected.id, Generation: connected.generation,
		RouteRevision: routeRevision,
	}
	callCtx = withDesktopRequest(callCtx, desktopCall)
	callCtx, callCancel := context.WithTimeout(callCtx, 70*time.Second)
	defer callCancel()
	rt, err := env.srv.resolveDesktopRouteTier(callCtx, "cold_start_e2e", "", desktopCall)
	if err != nil {
		t.Fatalf("resolve the applied local model route: %v", err)
	}
	if rt.Desktop == nil || rt.ProviderID != providerID {
		t.Fatalf("resolved route did not use the local Electron model: %#v", rt)
	}
	var coldOutput strings.Builder
	streamed := false
	callStartedAt := time.Now()
	text, _, err := env.srv.callModel(callCtx, rt, &ContextPack{
		System: "Return the requested status.", User: "cold-start-e2e: wait for the configured model response.",
	}, false, func(delta string) { _, _ = coldOutput.WriteString(delta) }, &streamed)
	if err != nil {
		t.Fatalf("30-second local model cold start failed: %v", err)
	}
	if !streamed || text != "cold-start-ready" || coldOutput.String() != text {
		t.Fatalf("cold-start response = %q, streamed=%t, deltas=%q", text, streamed, coldOutput.String())
	}
	var coldStartedAt, coldFinishedAt time.Time
	select {
	case coldStartedAt = <-coldContentStarted:
	case <-ctx.Done():
		t.Fatalf("local mock did not receive the cold-start request: %v", ctx.Err())
	}
	select {
	case coldFinishedAt = <-coldContentFinished:
	case <-ctx.Done():
		t.Fatalf("local mock did not send cold-start content: %v", ctx.Err())
	}
	if coldFinishedAt.Sub(coldStartedAt) < 30*time.Second || time.Since(callStartedAt) < 29*time.Second {
		t.Fatalf("cold-start response arrived too early: mock delay=%s, total=%s", coldFinishedAt.Sub(coldStartedAt), time.Since(callStartedAt))
	}

	// Both endpoints hold an in-flight request when the channel drops. Neither
	// side may transfer it to the next connection generation.
	requestID := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	pending := &desktopPending{id: requestID, responseDone: make(chan struct{}), requestDone: make(chan struct{})}
	connected.mu.Lock()
	connected.pending[requestID] = pending
	connected.mu.Unlock()
	if err := connected.conn.Close(websocket.StatusGoingAway, "verify reconnect does not replay"); err != nil {
		t.Fatalf("close Electron WSS connection: %v", err)
	}

	oldConnectionClosed := false
	for !oldConnectionClosed {
		select {
		case <-ctx.Done():
			t.Fatalf("old channel did not discard its pending request: %v", ctx.Err())
		case err := <-commandDone:
			if err != nil {
				t.Fatalf("Electron integration helper failed after channel close: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
			}
			t.Fatalf("Electron exited before it manually reconnected; stdout=%s; stderr=%s", stdout.String(), stderr.String())
		case <-ticker.C:
			connected.mu.Lock()
			requestClosed := false
			select {
			case <-pending.requestDone:
				requestClosed = true
			default:
			}
			connected.mu.Unlock()
			env.srv.desktop.mu.Lock()
			oldConnectionActive := env.srv.desktop.connections[connected.id] == connected
			generation := env.srv.desktop.generations[desktopGenerationKey(userID, workspaceID, connected.deviceID)]
			env.srv.desktop.mu.Unlock()
			if requestClosed && !oldConnectionActive {
				if generation != connected.generation {
					t.Fatalf("client reconnected without the explicit retry; generation=%d want=%d", generation, connected.generation)
				}
				oldConnectionClosed = true
			}
		}
	}

	var reconnected *desktopConnection
	for reconnected == nil {
		select {
		case <-ctx.Done():
			t.Fatalf("Electron did not manually establish a new WSS connection: %v; stdout=%s; stderr=%s", ctx.Err(), stdout.String(), stderr.String())
		case err := <-commandDone:
			if err != nil {
				t.Fatalf("Electron integration helper failed during reconnect: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
			}
			t.Fatalf("Electron exited before the new connection was registered; stdout=%s; stderr=%s", stdout.String(), stderr.String())
		case <-ticker.C:
			env.srv.desktop.mu.Lock()
			for _, candidate := range env.srv.desktop.connections {
				if candidate.userID == userID && candidate.workspaceID == workspaceID && candidate.generation > connected.generation {
					reconnected = candidate
					break
				}
			}
			env.srv.desktop.mu.Unlock()
		}
	}
	reconnected.mu.Lock()
	newPendingCount := len(reconnected.pending)
	reconnected.mu.Unlock()
	if newPendingCount != 0 {
		t.Fatalf("new channel inherited %d old pending requests", newPendingCount)
	}
	if err := <-commandDone; err != nil {
		t.Fatalf("Electron integration helper failed after reconnect: %v; stdout=%s; stderr=%s", err, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), `"type":"reconnected"`) ||
		!strings.Contains(stdout.String(), `"pendingCount":0`) ||
		!strings.Contains(stdout.String(), `"cancelObserved":true`) ||
		!strings.Contains(stdout.String(), "Electron completed the authenticated Go WSS integration.") {
		t.Fatalf("Electron did not confirm old-request cancellation and a clean manual reconnect; stdout=%s; stderr=%s", stdout.String(), stderr.String())
	}
}

func TestDesktopChannelAuthenticatesTicketAndRunsControlHandshake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	userID, workspaceID, sessionID := uuid.New(), uuid.New(), uuid.New()
	deviceID, connectionID := uuid.New(), uuid.New()
	username := "desktop_channel_" + userID.String()
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	token := uuid.NewString()
	policyRevision, routeRevision, generation := int64(2), int64(7), int64(3)

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id,username,password_hash) VALUES ($1,$2,'test')`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES ($1,'desktop channel test',$2)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO session (id,user_id,current_workspace_id,token_hash,expires_at,reauth_until)
		VALUES ($1,$2,$3,$4,$5,$5)`, sessionID, userID, workspaceID, secure.SHA256([]byte(token)), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device (id,user_id,public_key,name,platform,version)
		VALUES ($1,$2,$3,'test client','windows-x64','0.1.0')`, deviceID, userID, []byte(publicKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_ai_policy (workspace_id,enabled,authorization_revision) VALUES ($1,true,$2)`, workspaceID, policyRevision); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_route_state (workspace_id,user_id,device_id,revision) VALUES ($1,$2,$3,$4)`, workspaceID, userID, deviceID, routeRevision); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, workspaceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM app_user WHERE id=$1`, userID)
	})

	oldEnabled := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = true
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = oldEnabled })

	rawTicket := make([]byte, 32)
	if _, err := rand.Read(rawTicket); err != nil {
		t.Fatal(err)
	}
	ticketText := base64URL(rawTicket)
	ticketDigest := sha256.Sum256([]byte(ticketText))
	runtimeKey := desktopGenerationKey(userID, workspaceID, deviceID)
	env.srv.desktop.mu.Lock()
	env.srv.desktop.generations[runtimeKey] = generation
	env.srv.desktop.tickets[hex.EncodeToString(ticketDigest[:])] = desktopTicket{
		UserID: userID, SessionID: sessionID, WorkspaceID: workspaceID, DeviceID: deviceID,
		ConnectionID: connectionID, Generation: generation, RouteRevision: routeRevision,
		AuthorizationRev: policyRevision, ExpiresAt: time.Now().Add(time.Minute),
	}
	env.srv.desktop.mu.Unlock()
	t.Cleanup(func() {
		env.srv.desktop.mu.Lock()
		delete(env.srv.desktop.generations, runtimeKey)
		delete(env.srv.desktop.tickets, hex.EncodeToString(ticketDigest[:]))
		for id, connection := range env.srv.desktop.connections {
			if connection.deviceID == deviceID {
				delete(env.srv.desktop.connections, id)
			}
		}
		env.srv.desktop.mu.Unlock()
	})

	endpoint := "ws" + strings.TrimPrefix(env.http.URL, "http") + "/api/v1/desktop/channel"
	header := http.Header{"Authorization": []string{"Bearer " + ticketText}}
	conn, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("desktop channel handshake: status=%d err=%v", response.StatusCode, err)
		}
		t.Fatalf("desktop channel handshake: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "test complete")

	_, raw, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	var hello desktopWireMessage
	if err := json.Unmarshal(raw, &hello); err != nil {
		t.Fatal(err)
	}
	if hello.Type != "channel.hello" || hello.Generation != generation || hello.RouteRevision != routeRevision || hello.ProtocolVersion != desktopProtocolVersion {
		t.Fatalf("unexpected channel hello: %+v", hello)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"channel.ready","configs":[]}`)); err != nil {
		t.Fatalf("send ready: %v", err)
	}
	_, raw, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("read ready acknowledgement: %v", err)
	}
	var ready desktopWireMessage
	if err := json.Unmarshal(raw, &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "channel.ready_ack" || ready.Generation != generation {
		t.Fatalf("unexpected ready acknowledgement: %+v", ready)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"channel.heartbeat"}`)); err != nil {
		t.Fatalf("send heartbeat: %v", err)
	}
	_, raw, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("read heartbeat acknowledgement: %v", err)
	}
	var heartbeat desktopWireMessage
	if err := json.Unmarshal(raw, &heartbeat); err != nil {
		t.Fatal(err)
	}
	if heartbeat.Type != "channel.heartbeat_ack" {
		t.Fatalf("unexpected heartbeat acknowledgement: %+v", heartbeat)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test complete")

	replayConn, replayResponse, replayErr := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: header})
	if replayConn != nil {
		_ = replayConn.Close(websocket.StatusNormalClosure, "unexpected replay")
		t.Fatal("one-use desktop ticket was accepted more than once")
	}
	if replayErr == nil || replayResponse == nil || replayResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed ticket should return 401; response=%v err=%v", replayResponse, replayErr)
	}
}
