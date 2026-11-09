package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

const (
	defaultDesktopFirstContentTimeout = time.Minute
	minDesktopFirstContentTimeout     = 15 * time.Second
	maxDesktopFirstContentTimeout     = 2 * time.Minute
	desktopModelIdleTimeout           = time.Minute
)

var errDesktopIdle = errors.New("本机模型在输出过程中超过 60 秒没有返回有效内容")

func desktopFirstContentTimeoutFromEnv() (time.Duration, error) {
	value := os.Getenv("OPS_DESKTOP_FIRST_CONTENT_TIMEOUT")
	if value == "" {
		return defaultDesktopFirstContentTimeout, nil
	}
	timeout, err := time.ParseDuration(value)
	if err != nil || timeout < minDesktopFirstContentTimeout || timeout > maxDesktopFirstContentTimeout {
		return 0, fmt.Errorf("OPS_DESKTOP_FIRST_CONTENT_TIMEOUT 必须是 15s 到 120s 之间的时长")
	}
	return timeout, nil
}

// serverFirstTokenTimeoutFromEnv 读取服务端模型首 token 超时（2026-11-10，R 系列真实
// 供应商接入时发现：部分网关（reasoning 模型）首 token 常超默认 15s，硬编码导致
// ai_call 报「模型超过 15 秒没有返回内容」而整轮空输出）。默认不变 15s；仅当环境
// 变量显式设置时覆盖，clamp 15s~5min。
func serverFirstTokenTimeoutFromEnv() (time.Duration, error) {
	value := os.Getenv("OPS_FIRST_TOKEN_TIMEOUT")
	if value == "" {
		return 15 * time.Second, nil
	}
	timeout, err := time.ParseDuration(value)
	if err != nil || timeout < 15*time.Second || timeout > 5*time.Minute {
		return 0, fmt.Errorf("OPS_FIRST_TOKEN_TIMEOUT 必须是 15s 到 5m 之间的时长")
	}
	return timeout, nil
}

func (s *Server) desktopFirstContentBudget() time.Duration {
	if s.desktopFirstContentTimeout >= minDesktopFirstContentTimeout && s.desktopFirstContentTimeout <= maxDesktopFirstContentTimeout {
		return s.desktopFirstContentTimeout
	}
	return defaultDesktopFirstContentTimeout
}

type desktopModelTimeout struct {
	mu           sync.Mutex
	first        time.Duration
	idle         time.Duration
	phase        uint8
	expiredPhase uint8
	lastActivity time.Time
	timer        *time.Timer
	cancel       context.CancelFunc
}

func newDesktopModelTimeout(first, idle time.Duration, cancel context.CancelFunc) *desktopModelTimeout {
	t := &desktopModelTimeout{first: first, idle: idle, lastActivity: time.Now(), cancel: cancel}
	t.timer = time.AfterFunc(first, t.expire)
	return t
}

func (t *desktopModelTimeout) Activity() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.expiredPhase != 0 {
		return
	}
	t.phase = 1
	t.lastActivity = time.Now()
	t.timer.Reset(t.idle)
}

func (t *desktopModelTimeout) Error() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.expiredPhase {
	case 1:
		return errDesktopFirstToken
	case 2:
		return errDesktopIdle
	default:
		return nil
	}
}

func (t *desktopModelTimeout) Stop() {
	t.timer.Stop()
}

func (t *desktopModelTimeout) expire() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.expiredPhase != 0 {
		return
	}
	timeout := t.first
	phase := uint8(1)
	if t.phase != 0 {
		timeout = t.idle
		phase = 2
	}
	if remaining := timeout - time.Since(t.lastActivity); remaining > 0 {
		t.timer.Reset(remaining)
		return
	}
	t.expiredPhase = phase
	t.cancel()
}
