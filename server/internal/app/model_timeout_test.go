package app

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDesktopFirstContentTimeoutConfiguration(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		t.Setenv("OPS_DESKTOP_FIRST_CONTENT_TIMEOUT", "")
		got, err := desktopFirstContentTimeoutFromEnv()
		if err != nil || got != time.Minute {
			t.Fatalf("default first-content timeout=%s, err=%v", got, err)
		}
	})
	t.Run("configured range", func(t *testing.T) {
		for _, testCase := range []struct {
			value string
			want  time.Duration
		}{{"15s", 15 * time.Second}, {"90s", 90 * time.Second}, {"120s", 120 * time.Second}} {
			t.Setenv("OPS_DESKTOP_FIRST_CONTENT_TIMEOUT", testCase.value)
			got, err := desktopFirstContentTimeoutFromEnv()
			if err != nil || got != testCase.want {
				t.Fatalf("timeout %q parsed as %s, err=%v", testCase.value, got, err)
			}
		}
	})
	t.Run("rejects out-of-range and invalid values", func(t *testing.T) {
		for _, value := range []string{"14s", "121s", "invalid"} {
			t.Setenv("OPS_DESKTOP_FIRST_CONTENT_TIMEOUT", value)
			if _, err := desktopFirstContentTimeoutFromEnv(); err == nil {
				t.Fatalf("timeout %q should be rejected", value)
			}
		}
	})
}

func TestDesktopModelTimeoutWaitsForFirstActivityThenTracksIdle(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timeout := newDesktopModelTimeout(500*time.Millisecond, 80*time.Millisecond, cancel)
	defer timeout.Stop()
	timeout.Activity()
	time.Sleep(45 * time.Millisecond)
	timeout.Activity()
	select {
	case <-ctx.Done():
		t.Fatal("activity reset the idle timeout but the model was cancelled")
	case <-time.After(50 * time.Millisecond):
	}
	if err := timeout.Error(); err != nil {
		t.Fatalf("timeout expired while activity was recent: %v", err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("model was not cancelled after 80ms of test idle budget")
	}
	if err := timeout.Error(); !errors.Is(err, errDesktopIdle) {
		t.Fatalf("timeout error=%v, want idle timeout", err)
	}
}

func TestDesktopModelTimeoutCancelsBeforeFirstActivity(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timeout := newDesktopModelTimeout(35*time.Millisecond, time.Second, cancel)
	defer timeout.Stop()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("model was not cancelled when first-content budget expired")
	}
	if err := timeout.Error(); !errors.Is(err, errDesktopFirstToken) {
		t.Fatalf("timeout error=%v, want first-content timeout", err)
	}
}
