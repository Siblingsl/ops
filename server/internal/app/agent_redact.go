package app

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// 16 文档第 9.5 节：密钥与敏感值的脱敏。
// 脱敏发生在三个位置：工具结果写入 agent_message 前、发送给模型前、卡片 preview 与 result 落库前。

// agentHidden 是命中的值被替换后的占位。
const agentHidden = "[已隐藏]"

// agentRedactKeys 是按 JSON 键名的脱敏名单（大小写不敏感）。
var agentRedactKeys = map[string]bool{
	"api_key":            true,
	"apikey":             true,
	"app_secret":         true,
	"secret":             true,
	"password":           true,
	"temporary_password": true,
	"token":              true,
	"access_token":       true,
	"csrf_token":         true,
	"key_mask":           true,
	"secret_mask":        true,
	"smtp":               true, // 整个对象
	"code":               true, // 邀请码（错误信封中的 error.code 例外，见 agentKeyRedactedAt）
}

// agentKeyRedactedAt 判断某个键在当前路径上是否应当整体脱敏。
func agentKeyRedactedAt(key string, path []string) bool {
	lk := strings.ToLower(key)
	if lk == "code" && len(path) > 0 && strings.EqualFold(path[len(path)-1], "error") {
		// 错误信封的 error.code 是错误码，模型需要它区分失败原因。
		return false
	}
	if agentRedactKeys[lk] {
		return true
	}
	return strings.HasSuffix(lk, "_enc")
}

// agentRedactValue 递归脱敏一个已解析的 JSON 值。
func agentRedactValue(v any, secrets []string) any {
	return agentRedactAt(v, secrets, nil)
}

func agentRedactAt(v any, secrets []string, path []string) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if agentKeyRedactedAt(k, path) {
				out[k] = agentHidden
				continue
			}
			out[k] = agentRedactAt(val, secrets, append(path, k))
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = agentRedactAt(val, secrets, path)
		}
		return out
	case string:
		return agentRedactText(x, secrets)
	default:
		return v
	}
}

// agentRedactText 按值匹配替换本工作区已保存的密钥原文。
func agentRedactText(s string, secrets []string) string {
	for _, sec := range secrets {
		if len(sec) >= 8 && strings.Contains(s, sec) {
			s = strings.ReplaceAll(s, sec, agentHidden)
		}
	}
	return s
}

// agentRedactJSONBytes 脱敏一段 JSON 文本；解析失败时按纯文本处理。
func agentRedactJSONBytes(raw []byte, secrets []string) []byte {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return []byte(agentRedactText(string(raw), secrets))
	}
	b, err := json.Marshal(agentRedactValue(v, secrets))
	if err != nil {
		return []byte(agentRedactText(string(raw), secrets))
	}
	return b
}

// agentSecretValues 收集本工作区所有供应商密钥与公众号 AppSecret 的明文，供按值脱敏使用。
// 这些值只在进程内使用，绝不进入模型请求、对话消息、工具结果与日志。
func (s *Server) agentSecretValues(ctx context.Context, wsID uuid.UUID) []string {
	if wsID == uuid.Nil {
		return nil
	}
	var out []string
	rows, err := s.db.Query(ctx, `SELECT api_key_enc FROM model_provider WHERE workspace_id=$1`, wsID)
	if err == nil {
		for rows.Next() {
			var enc []byte
			if rows.Scan(&enc) != nil {
				continue
			}
			if plain, err := s.box.Decrypt(enc); err == nil && strings.TrimSpace(plain) != "" {
				out = append(out, strings.TrimSpace(plain))
			}
		}
		rows.Close()
	}
	rows2, err := s.db.Query(ctx, `SELECT c.app_secret_enc FROM wechat_credential c
		JOIN platform_account a ON a.id = c.account_id WHERE a.workspace_id=$1`, wsID)
	if err == nil {
		for rows2.Next() {
			var enc []byte
			if rows2.Scan(&enc) != nil {
				continue
			}
			if plain, err := s.box.Decrypt(enc); err == nil && strings.TrimSpace(plain) != "" {
				out = append(out, strings.TrimSpace(plain))
			}
		}
		rows2.Close()
	}
	return out
}

// agentContainsSecret 判断文本中是否出现疑似密钥或密码（第 9.5 节第 5 项）。
// 用户消息在接收时检查，命中时服务端返回 422 且不保存消息。
func agentContainsSecret(text string, secrets []string) bool {
	for _, sec := range secrets {
		if len(sec) >= 8 && strings.Contains(text, sec) {
			return true
		}
	}
	return agentSecretLikePattern(text)
}

// agentSecretKeywordRe 命中「关键词后 20 个字符内出现长度 ≥ 16 的连续字母数字串」。
var agentSecretKeywordRe = regexp.MustCompile(
	`(?i)(secret|appsecret|apikey|api\s*key|token|password|密码|密钥)[\s\S]{0,20}?[A-Za-z0-9]{16,}`)

// agentSecretSkRe 命中「sk- 开头、后接 20 个以上字母数字的串」。
var agentSecretSkRe = regexp.MustCompile(`sk-[A-Za-z0-9]{20,}`)

func agentSecretLikePattern(text string) bool {
	return agentSecretKeywordRe.MatchString(text) || agentSecretSkRe.MatchString(text)
}
