package crawl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type testStore struct {
	last     time.Time
	requests int
	date     string
	pause    time.Time
	failures int
}

func (s *testStore) Claim(_ context.Context, _ Source, now time.Time, l Limits) error {
	if now.Before(s.pause) || !s.last.IsZero() && now.Sub(s.last) < time.Duration(l.IntervalMin)*time.Minute {
		return ErrLimited
	}
	s.last = now
	return nil
}
func (s *testStore) Reserve(_ context.Context, _ Source, now time.Time, n int) error {
	date := now.Format("2006-01-02")
	if date != s.date {
		s.date = date
		s.requests = 0
	}
	if s.requests >= n {
		return ErrLimited
	}
	s.requests++
	return nil
}
func (s *testStore) Finish(_ context.Context, _ Source, now time.Time, l Limits, out Outcome) {
	if out.Error != "" {
		s.failures++
	} else {
		s.failures = 0
	}
	if out.Paused {
		s.pause = now.Add(24 * time.Hour)
	} else if s.failures >= l.FailLimit {
		s.pause = now.Add(time.Duration(l.PauseHours) * time.Hour)
	}
}
func TestClientBoundaries(t *testing.T) {
	now := time.Date(2026, 10, 10, 10, 0, 0, 0, time.UTC)
	calls := 0
	robots := "User-agent: *\nDisallow: /private"
	status := 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("User-Agent") != UserAgent {
			t.Error("unexpected identity")
		}
		if r.URL.Path == "/robots.txt" {
			_, _ = w.Write([]byte(robots))
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte("public"))
	}))
	defer srv.Close()
	enabled := false
	st := &testStore{}
	c := New(Options{Mode: func() bool { return enabled }, Now: func() time.Time { return now }, Store: st, LocalHost: strings.TrimPrefix(srv.URL, "http://")})
	l := Limits{Enabled: true, IntervalMin: 10, MaxItems: 50, DailyRequests: 10, FailLimit: 3, PauseHours: 6}
	source := Source{"test", "hotlist", srv.URL + "/private"}
	for range 144 {
		_, _, err := c.Read(context.Background(), source, l)
		if err != ErrDisabled {
			t.Fatal(err)
		}
		now = now.Add(10 * time.Minute)
	}
	if calls != 0 {
		t.Fatal("off made requests")
	}
	enabled = true
	_, _, err := c.Read(context.Background(), source, l)
	if err != ErrRobots || calls != 1 {
		t.Fatalf("robots: %v calls=%d", err, calls)
	}
	now = now.Add(10 * time.Minute)
	source.URL = srv.URL + "/public"
	_, out, err := c.Read(context.Background(), source, l)
	if err != nil || out.Requests != 1 {
		t.Fatalf("read %v %+v", err, out)
	}
	_, _, err = c.Read(context.Background(), source, l)
	if err != ErrLimited {
		t.Fatal("missing interval gate")
	}
	now = now.Add(10 * time.Minute)
	status = 429
	_, out, err = c.Read(context.Background(), source, l)
	if err == nil || !out.Paused {
		t.Fatal("missing circuit breaker")
	}
	before := calls
	now = now.Add(time.Hour)
	_, _, err = c.Read(context.Background(), source, l)
	if err != ErrLimited || calls != before {
		t.Fatal("paused source made request")
	}
}
func TestRobotsRules(t *testing.T) {
	for _, tc := range []struct {
		text, path string
		allow      bool
	}{{"User-agent: *\nDisallow: /", "/a", false}, {"User-agent: *\nDisallow: /x*\nAllow: /xyz$", "/xyz", true}, {"User-agent: *\nDisallow: /x\nAllow: /x", "/x", true}, {"User-agent: Other\nDisallow: /", "/a", true}} {
		if got := RobotsAllowed(tc.text, tc.path); got != tc.allow {
			t.Fatalf("%q %s: %v", tc.text, tc.path, got)
		}
	}
}
func TestURLBoundaries(t *testing.T) {
	c := New(Options{})
	for _, raw := range []string{"file:///etc/passwd", "http://u:p@example.com/a", "http://127.0.0.1/a", "http://169.254.169.254/", "https://mp.weixin.qq.com/a"} {
		if _, err := c.validURL(raw, Source{Kind: "rss"}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, ip := range []string{"::1", "10.0.0.1", "100.64.1.2", "192.0.2.1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Fatal(ip)
		}
	}
}
func TestDailyBudget(t *testing.T) {
	s := &testStore{}
	now := time.Now()
	for range 2 {
		if err := s.Reserve(context.Background(), Source{}, now, 2); err != nil {
			t.Fatal(err)
		}
	}
	if s.Reserve(context.Background(), Source{}, now, 2) != ErrLimited {
		t.Fatal("budget exceeded")
	}
	if s.Reserve(context.Background(), Source{}, now.Add(24*time.Hour), 2) != nil {
		t.Fatal("budget did not reset")
	}
}
