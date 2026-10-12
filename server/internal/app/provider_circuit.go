package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type providerCircuit struct {
	failures  []time.Time
	openUntil time.Time
	probing   bool
}

type providerAttempt struct {
	circuit *providerCircuit
	probe   bool
}

func providerRetrySeconds(until, now time.Time) int {
	if !until.After(now) {
		return 1
	}
	return int((until.Sub(now) + time.Second - 1) / time.Second)
}

func (s *Server) beginProviderCall(id uuid.UUID) (providerAttempt, error) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	now := s.now()
	c := s.providerCircuits[id]
	if c == nil {
		c = &providerCircuit{}
		s.providerCircuits[id] = c
	}
	if c.openUntil.After(now) || c.probing {
		return providerAttempt{}, apiErr(http.StatusServiceUnavailable, "ai_provider_unavailable",
			fmt.Sprintf("供应商暂不可用，约 %d 秒后恢复", providerRetrySeconds(c.openUntil, now)))
	}
	probe := !c.openUntil.IsZero()
	if probe {
		c.probing = true
	}
	return providerAttempt{circuit: c, probe: probe}, nil
}

func (s *Server) finishProviderCall(id uuid.UUID, attempt providerAttempt, ctx context.Context, err error) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	c := s.providerCircuits[id]
	if c != attempt.circuit || (!attempt.probe && !c.openUntil.IsZero()) {
		return
	}
	if attempt.probe {
		c.probing = false
	}
	if ctx.Err() != nil {
		return
	}
	if err == nil {
		if attempt.probe {
			delete(s.providerCircuits, id)
		} else {
			c.failures = nil
		}
		return
	}
	if !retryable(err) || authFailure(err) {
		return
	}
	now := s.now()
	valid := c.failures[:0]
	for _, at := range c.failures {
		if now.Sub(at) < time.Minute {
			valid = append(valid, at)
		}
	}
	c.failures = append(valid, now)
	if attempt.probe || len(c.failures) >= 3 {
		c.openUntil = now.Add(time.Minute)
		c.failures = nil
	}
}

func (s *Server) providerCircuitStatus(id uuid.UUID) (string, int) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	c := s.providerCircuits[id]
	if c == nil || c.openUntil.IsZero() {
		return "closed", 0
	}
	now := s.now()
	if c.openUntil.After(now) {
		return "open", providerRetrySeconds(c.openUntil, now)
	}
	return "half_open", 0
}
