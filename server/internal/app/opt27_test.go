package app

import (
	"testing"
	"time"
)

func TestOPT27AuthMeIncludesSevenDaySessionExpiry(t *testing.T) {
	var me struct {
		SessionExpiresAt time.Time `json:"session_expires_at"`
	}
	env.mustJSON(t, "GET", "/api/v1/auth/me", nil, &me)
	remaining := time.Until(me.SessionExpiresAt)
	if remaining < 6*24*time.Hour || remaining > 7*24*time.Hour {
		t.Fatalf("session expiry remaining = %s, want about seven days", remaining)
	}
}
