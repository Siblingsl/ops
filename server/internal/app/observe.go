package app

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
)

// BE-07（docs/33 §11.8）：结构化错误/审计字段补齐。
// 只服务 BE-02 已标为「必须可观测」的点——不新建审计体系，沿用 s.audit*。
// Error 级：slog + audit，字段齐全，永不采样丢弃。
// Warn 级：仅 slog，按 error_code 限流（约 1 次/秒），避免中间态噪音放大。
// 禁止把正文 / 密钥 / 个人技能正文写入日志或 audit detail。

type observeFields struct {
	Action     string // audit action；Error 级必填
	TargetType string
	TargetID   string
	ErrorCode  string
	Route      string // HTTP 路由模板或稳定内部路由
	Started    time.Time
	// Extras 仅允许安全键（见 observeSafeExtra）；敏感键会被剥掉。
	Extras map[string]any
}

var observeWarnLast sync.Map // error_code → last unix nano

func observeAllowWarn(code string) bool {
	now := time.Now().UnixNano()
	if v, ok := observeWarnLast.Load(code); ok {
		if now-v.(int64) < int64(time.Second) {
			return false
		}
	}
	observeWarnLast.Store(code, now)
	return true
}

func observeSafeExtra(k string) bool {
	switch k {
	case "text", "content", "body", "html", "password", "secret", "token",
		"authorization", "cookie", "skill", "skill_body", "prompt", "message":
		return false
	default:
		return true
	}
}

func (s *Server) observeFailure(ctx context.Context, level slog.Level, msg string, f observeFields) {
	if level < slog.LevelError && !observeAllowWarn(f.ErrorCode) {
		return
	}
	workspaceID := ""
	if id := ident(ctx); id != nil && id.WorkspaceID != uuid.Nil {
		workspaceID = id.WorkspaceID.String()
	}
	route := f.Route
	if route == "" {
		route = requestRoute(ctx)
	}
	var durationMs float64
	if !f.Started.IsZero() {
		durationMs = float64(time.Since(f.Started)) / float64(time.Millisecond)
	}
	attrs := []any{
		"error_code", f.ErrorCode,
		"route", route,
		"workspace_id", workspaceID,
		"duration_ms", durationMs,
	}
	detail := map[string]any{
		"error_code":   f.ErrorCode,
		"route":        route,
		"workspace_id": workspaceID,
		"duration_ms":  durationMs,
	}
	for k, v := range f.Extras {
		if !observeSafeExtra(k) {
			continue
		}
		attrs = append(attrs, k, v)
		detail[k] = v
	}
	slog.Log(ctx, level, msg, attrs...)
	if level >= slog.LevelError && f.Action != "" {
		targetType, targetID := f.TargetType, f.TargetID
		if targetType == "" {
			targetType = "system"
		}
		s.audit(ctx, f.Action, targetType, targetID, "error", detail)
	}
}
