package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDesktopModelProviderStoresNoServerCredentials(t *testing.T) {
	ctx := context.Background()
	userID, workspaceID, sessionID, deviceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	username := "desktop_model_null_" + userID.String()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id,username,password_hash) VALUES ($1,$2,'test')`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES ($1,'desktop model null test',$2)`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device (id,user_id,public_key,name,platform) VALUES ($1,$2,$3,'test','windows-x64')`, deviceID, userID, []byte(publicKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_ai_policy (workspace_id,enabled) VALUES ($1,true)`, workspaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM model_provider WHERE workspace_id=$1 AND desktop_user_id=$2 AND desktop_device_id=$3 AND execution_location='desktop'`, workspaceID, userID, deviceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id=$1`, workspaceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM app_user WHERE id=$1`, userID)
	})

	oldEnabled := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = true
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = oldEnabled })

	body, err := json.Marshal(desktopModelInput{
		Name: "本机模型", Models: []string{"local-chat"}, EndpointKind: "loopback", Status: "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	challenge := desktopChallenge{
		ID: uuid.New(), Nonce: []byte("test nonce"), UserID: userID, SessionID: sessionID,
		WorkspaceID: workspaceID, DeviceID: deviceID, Operation: "model.create",
		Method: http.MethodPost, Path: "/api/v1/desktop/models", BodyHash: sha256.Sum256(body),
		PublicKey: []byte(publicKey), ExpiresAt: now.Add(time.Minute),
	}
	env.srv.desktop.mu.Lock()
	env.srv.desktop.challenges[challenge.ID] = challenge
	env.srv.desktop.mu.Unlock()
	t.Cleanup(func() {
		env.srv.desktop.mu.Lock()
		delete(env.srv.desktop.challenges, challenge.ID)
		env.srv.desktop.mu.Unlock()
	})

	req := httptest.NewRequest(http.MethodPost, challenge.Path, bytes.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), ctxMember, &identity{
		UserID: userID, SessionID: sessionID, WorkspaceID: workspaceID, Role: "owner",
	}))
	req.Header.Set("X-OPS-Desktop-Device", deviceID.String())
	req.Header.Set("X-OPS-Desktop-Challenge", challenge.ID.String())
	req.Header.Set("X-OPS-Desktop-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, desktopSignaturePayload(challenge))))
	response := httptest.NewRecorder()
	if err := env.srv.desktopCreateModel(response, req); err != nil {
		t.Fatalf("create desktop model: %v", err)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("create desktop model status = %d, want %d: %s", response.Code, http.StatusOK, response.Body.String())
	}

	var baseURLIsNull, apiKeyIsNull bool
	if err := env.srv.db.QueryRow(ctx, `SELECT base_url IS NULL, api_key_enc IS NULL FROM model_provider
		WHERE workspace_id=$1 AND desktop_user_id=$2 AND desktop_device_id=$3 AND name='本机模型' AND execution_location='desktop'`,
		workspaceID, userID, deviceID).Scan(&baseURLIsNull, &apiKeyIsNull); err != nil {
		t.Fatal(err)
	}
	if !baseURLIsNull || !apiKeyIsNull {
		t.Fatalf("desktop model must not store server credentials: base_url NULL=%t, api_key_enc NULL=%t", baseURLIsNull, apiKeyIsNull)
	}

	if _, err := env.srv.db.Exec(ctx, `INSERT INTO model_provider (workspace_id,name,base_url,api_key_enc,models,execution_location)
		VALUES ($1,'invalid server model',NULL,NULL,'{}','server')`, workspaceID); err == nil {
		t.Fatal("server model must retain non-NULL URL and encrypted key requirements")
	}
}

func TestDesktopConnectionRechecksCurrentAuthorizationScope(t *testing.T) {
	ctx := context.Background()
	userID, otherUserID := uuid.New(), uuid.New()
	workspaceID, otherWorkspaceID := uuid.New(), uuid.New()
	sessionID, deviceID := uuid.New(), uuid.New()
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO app_user (id,username,password_hash) VALUES ($1,$2,'test'),($3,$4,'test')`,
		userID, "desktop_scope_"+userID.String(), otherUserID, "desktop_scope_"+otherUserID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace (id,name,created_by_user_id) VALUES
		($1,'desktop scope test',$3),($2,'desktop scope other',$3)`, workspaceID, otherWorkspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES
		($1,$3,'owner','active'),($2,$3,'owner','active'),($1,$4,'editor','active')`,
		workspaceID, otherWorkspaceID, userID, otherUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO session (id,user_id,current_workspace_id,token_hash,expires_at)
		VALUES ($1,$2,$3,$4,$5)`, sessionID, userID, workspaceID, make([]byte, 32), time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_device (id,user_id,public_key,name,platform)
		VALUES ($1,$2,$3,'test','windows-x64')`, deviceID, userID, make([]byte, ed25519.PublicKeySize)); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO desktop_ai_policy (workspace_id,enabled,authorization_revision)
		VALUES ($1,true,1)`, workspaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM workspace WHERE id IN ($1,$2)`, workspaceID, otherWorkspaceID)
		_, _ = env.srv.db.Exec(context.Background(), `DELETE FROM app_user WHERE id IN ($1,$2)`, userID, otherUserID)
	})

	oldEnabled := env.srv.cfg.DesktopAIEnabled
	env.srv.cfg.DesktopAIEnabled = true
	t.Cleanup(func() { env.srv.cfg.DesktopAIEnabled = oldEnabled })
	runtimeKey := desktopGenerationKey(userID, workspaceID, deviceID)
	env.srv.desktop.mu.Lock()
	env.srv.desktop.generations[runtimeKey] = 1
	env.srv.desktop.mu.Unlock()
	t.Cleanup(func() {
		env.srv.desktop.mu.Lock()
		delete(env.srv.desktop.generations, runtimeKey)
		env.srv.desktop.mu.Unlock()
	})
	connection := &desktopConnection{
		userID: userID, sessionID: sessionID, workspaceID: workspaceID, deviceID: deviceID,
		generation: 1, authorizationRev: 1,
	}
	check := func(name string, wantAllowed bool) {
		t.Helper()
		err := env.srv.desktopValidateConnection(connection)
		if wantAllowed && err != nil {
			t.Errorf("%s: expected authorization, got %v", name, err)
		} else if !wantAllowed && err == nil {
			t.Errorf("%s: stale or unauthorized connection was accepted", name)
		}
	}

	check("owner", true)
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='editor' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	check("editor without endpoint permission", false)
	if _, err := env.srv.db.Exec(ctx, `UPDATE desktop_ai_policy SET allow_member_endpoints=true WHERE workspace_id=$1`, workspaceID); err != nil {
		t.Fatal(err)
	}
	check("editor with endpoint permission", true)
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	check("viewer", false)
	if _, err := env.srv.db.Exec(ctx, `UPDATE workspace_member SET role='owner' WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}

	otherIdentity := &identity{UserID: otherUserID, SessionID: uuid.New(), WorkspaceID: workspaceID, Role: "editor"}
	if err := env.srv.desktopRequireWorkspaceAccess(context.WithValue(ctx, ctxMember, otherIdentity), deviceID); err == nil {
		t.Error("another workspace member must not use this user's device")
	}

	if _, err := env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, sessionID, otherWorkspaceID); err != nil {
		t.Fatal(err)
	}
	check("workspace switch", false)
	if _, err := env.srv.db.Exec(ctx, `UPDATE session SET current_workspace_id=$2 WHERE id=$1`, sessionID, workspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `DELETE FROM workspace_member WHERE workspace_id=$1 AND user_id=$2`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	check("membership revoked", false)
	if _, err := env.srv.db.Exec(ctx, `INSERT INTO workspace_member (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE desktop_device SET revoked_at=now() WHERE id=$1`, deviceID); err != nil {
		t.Fatal(err)
	}
	check("device revoked", false)

	if _, err := env.srv.db.Exec(ctx, `UPDATE app_user SET is_system_admin=true WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.srv.db.Exec(ctx, `UPDATE session SET admin_override=true WHERE id=$1`, sessionID); err != nil {
		t.Fatal(err)
	}
	check("system administrator override", false)
}

func TestDesktopRouteTypesIncludeTierOverrides(t *testing.T) {
	types := desktopRouteTypes()
	for _, taskType := range []string{"tier_economy", "tier_quality"} {
		if !types[taskType] {
			t.Fatalf("desktop route types must include %q so desktop mode can preserve tier routing", taskType)
		}
	}
}
