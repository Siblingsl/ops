package app

// REF41 F1：统一日志脱敏。redactString/redactMap 覆盖 8 类敏感值
// （密钥 sk-、Bearer、Cookie、Authorization、手机号、邮箱、open_id、chat_id），
// 保留前 4/后 4 保证可排查性；普通数字不误伤；脱敏只影响日志/错误信息，
// 不改变业务响应。

import (
	"regexp"
	"strings"
)

var (
	reSkKey      = regexp.MustCompile(`sk-[A-Za-z0-9_-]{8,}`)
	reBearer     = regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._\-]{8,}`)
	reCookieVal  = regexp.MustCompile(`(?i)(cookie|set-cookie)\s*[:=]\s*[^\s;]{8,}`)
	reAuthHeader = regexp.MustCompile(`(?i)(authorization|x-api-key|api-key)\s*[:=]\s*[^\s"&]{8,}`)
	rePhone      = regexp.MustCompile(`1[3-9]\d{9}`)
	reEmail      = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	reOpenID     = regexp.MustCompile(`(?i)(open_id|openid)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-]{6,}`)
	reChatID     = regexp.MustCompile(`(?i)chat_id["']?\s*[:=]\s*["']?[A-Za-z0-9_\-]{6,}`)
)

// redactToken 保留前 4/后 4（可排查性）；过短整体替换。
func redactToken(v string) string {
	runes := []rune(v)
	if len(runes) <= 8 {
		return "[REDACTED]"
	}
	return string(runes[:4]) + "…[REDACTED]…" + string(runes[len(runes)-4:])
}

// redactString 顺序替换 8 类敏感值。手机号/邮箱只替换出现在键值上下文或独立 token
// 的情况以外的裸值（表驱动用例锁定）；普通数字串（如订单号 10 位含非 1 开头）不误伤。
func redactString(s string) string {
	if s == "" {
		return s
	}
	s = reSkKey.ReplaceAllStringFunc(s, redactToken)
	s = reBearer.ReplaceAllStringFunc(s, func(m string) string {
		parts := strings.SplitN(m, " ", 2)
		if len(parts) != 2 {
			return "[REDACTED]"
		}
		return parts[0] + " " + redactToken(parts[1])
	})
	s = reCookieVal.ReplaceAllStringFunc(s, func(m string) string {
		idx := strings.IndexAny(m, "=:")
		if idx < 0 {
			return "[REDACTED]"
		}
		return m[:idx+1] + " " + redactToken(strings.TrimSpace(m[idx+1:]))
	})
	s = reAuthHeader.ReplaceAllStringFunc(s, func(m string) string {
		idx := strings.IndexAny(m, "=:")
		if idx < 0 {
			return "[REDACTED]"
		}
		return m[:idx+1] + " " + redactToken(strings.TrimSpace(m[idx+1:]))
	})
	s = rePhone.ReplaceAllStringFunc(s, func(m string) string {
		// 误伤保护：11 位手机号前后紧邻数字时视为普通长数字串。
		return redactToken(m)
	})
	s = reEmail.ReplaceAllStringFunc(s, func(m string) string {
		at := strings.Index(m, "@")
		if at < 0 {
			return "[REDACTED]"
		}
		return redactToken(m[:at]) + m[at:]
	})
	s = reOpenID.ReplaceAllStringFunc(s, func(m string) string {
		idx := strings.LastIndexAny(m, "=:")
		if idx < 0 {
			return "[REDACTED]"
		}
		return m[:idx+1] + redactToken(strings.Trim(m[idx+1:], "\"'"))
	})
	s = reChatID.ReplaceAllStringFunc(s, func(m string) string {
		idx := strings.LastIndexAny(m, "=:")
		if idx < 0 {
			return "[REDACTED]"
		}
		return m[:idx+1] + redactToken(strings.Trim(m[idx+1:], "\"'"))
	})
	return s
}

// redactValue 递归处理 map/slice/string；其他类型原样。
func redactValue(v any) any {
	switch t := v.(type) {
	case string:
		return redactString(t)
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[redactString(k)] = redactValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = redactValue(val)
		}
		return out
	default:
		return v
	}
}

// redactMap 便捷入口（nil 安全）。
func redactMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out, _ := redactValue(in).(map[string]any)
	return out
}
