package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSessionDatabaseFailureIsNotAuthenticationFailure(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), env.srv.cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	srv := &Server{db: pool, now: time.Now}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "not-a-real-session"})
	response := httptest.NewRecorder()
	srv.requireSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("database failure must not grant access")
	})).ServeHTTP(response, req)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("database failure returned %d, want 500 instead of a false 401", response.Code)
	}
}

func TestDesktopSessionDatabaseFailureIsNotAuthenticationFailure(t *testing.T) {
	pool, err := pgxpool.New(context.Background(), env.srv.cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	srv := &Server{db: pool, now: time.Now}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/desktop/devices", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "not-a-real-session"})
	response := httptest.NewRecorder()
	srv.requireDesktopAccountSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("database failure must not grant access")
	})).ServeHTTP(response, req)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("database failure returned %d, want 500 instead of a false 401", response.Code)
	}
}

func TestUnknownSessionRemainsUnauthenticated(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "unknown-session"})
	response := httptest.NewRecorder()
	env.srv.requireSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("unknown session must not grant access")
	})).ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unknown session returned %d, want 401", response.Code)
	}
}

func TestUnknownDesktopSessionRemainsUnauthenticated(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/desktop/devices", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "unknown-session"})
	response := httptest.NewRecorder()
	env.srv.requireDesktopAccountSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("unknown session must not grant access")
	})).ServeHTTP(response, req)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unknown desktop session returned %d, want 401", response.Code)
	}
}

func TestCanceledSessionLookupIsNotAuthenticationFailure(t *testing.T) {
	serverURL, err := url.Parse(env.http.URL)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil).WithContext(ctx)
	for _, cookie := range env.client.Jar.Cookies(serverURL) {
		req.AddCookie(cookie)
	}
	if _, err := req.Cookie(sessionCookie); err != nil {
		t.Fatal("expected the valid setup session cookie")
	}
	response := httptest.NewRecorder()
	env.srv.requireSession(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("canceled session lookup must not grant access")
	})).ServeHTTP(response, req)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("canceled lookup returned %d, want 500 instead of a false 401", response.Code)
	}
}
