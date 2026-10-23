package app

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"
)

func TestAuthRenewSessionExtendsExpiryAndCookie(t *testing.T) {
	var before struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &before)

	resp := env.request("POST", "/api/v1/auth/renew", strings.NewReader(`{"password":"`+testPassword+`"}`), "application/json")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /api/v1/auth/renew => %d %s", resp.StatusCode, body)
	}
	var result struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !result.SessionExpiresAt.After(before.SessionExpiresAt) || time.Until(result.SessionExpiresAt) < 6*24*time.Hour {
		t.Fatalf("renewed expiry = %s, before = %s; want a fresh seven-day session", result.SessionExpiresAt, before.SessionExpiresAt)
	}
	var cookieExpiry time.Time
	for _, cookie := range resp.Cookies() {
		if cookie.Name == sessionCookie {
			cookieExpiry = cookie.Expires
		}
	}
	if cookieExpiry.IsZero() || cookieExpiry.Unix() != result.SessionExpiresAt.Unix() {
		t.Fatalf("renewed cookie expiry = %s, response expiry = %s", cookieExpiry, result.SessionExpiresAt)
	}

	// Reauthentication remains limited to the five-minute sensitive-operation window.
	var reauthBefore struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &reauthBefore)
	env.mustJSON(t, "POST", "/api/v1/auth/reauth", map[string]string{"password": testPassword}, nil)
	var reauthAfter struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &reauthAfter)
	if !reauthAfter.SessionExpiresAt.Equal(reauthBefore.SessionExpiresAt) {
		t.Fatalf("/auth/reauth changed session expiry: before %s, after %s", reauthBefore.SessionExpiresAt, reauthAfter.SessionExpiresAt)
	}

	if !viewerMutateAllowed("/api/v1/auth/renew") {
		t.Fatal("viewer session renewal should be allowlisted")
	}
}

func TestAuthRenewSessionRejectsWrongPassword(t *testing.T) {
	var before struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &before)
	env.expectErr(t, "POST", "/api/v1/auth/renew", map[string]string{"password": "incorrect-password"}, "validation_failed")
	var after struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &after)
	if !after.SessionExpiresAt.Equal(before.SessionExpiresAt) {
		t.Fatalf("failed renewal changed session expiry: before %s, after %s", before.SessionExpiresAt, after.SessionExpiresAt)
	}
}
