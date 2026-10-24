package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// DEV-SK1 / docs/23 第 5.2.1 节：规范编码 C(v) 与指纹 H(v)。
// 规则：UTF-8 紧凑 JSON；对象键按 UTF-8 字节序递归升序；数组保持给定顺序；
// 整数十进制、不接受浮点数；字符串只转义双引号、反斜杠与 U+0000–001F（小写四位 \u00xx），
// 不转义中文、/、<>&、U+2028/2029。前后端共用同一口径，不允许一端用默认 JSON 序列化直接比较。

func canonJSON(v any) (string, error) {
	var b strings.Builder
	if err := canonValue(&b, v); err != nil {
		return "", err
	}
	return b.String(), nil
}

func canonValue(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		return canonString(b, x)
	case int:
		fmt.Fprintf(b, "%d", x)
	case int32:
		fmt.Fprintf(b, "%d", x)
	case int64:
		fmt.Fprintf(b, "%d", x)
	case uint:
		fmt.Fprintf(b, "%d", x)
	case uint64:
		fmt.Fprintf(b, "%d", x)
	case float64:
		if x != float64(int64(x)) {
			return fmt.Errorf("规范编码不接受浮点数")
		}
		fmt.Fprintf(b, "%d", int64(x))
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonValue(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonString(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		// Go 字符串比较即 UTF-8 字节序比较。
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonString(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := canonValue(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("规范编码不支持类型 %T", v)
	}
	return nil
}

func canonString(b *strings.Builder, s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("规范编码要求有效 UTF-8")
	}
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString("\\\"")
		case r == '\\':
			b.WriteString("\\\\")
		case r < 0x20:
			fmt.Fprintf(b, "\\u%04x", r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return nil
}

// canonHash 返回 H(v)：C(v) 的 SHA-256 小写十六进制。
func canonHash(v any) (string, error) {
	c, err := canonJSON(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(c))
	return hex.EncodeToString(sum[:]), nil
}

// canonRFC3339 固定 UTC RFC3339 六位小数（5.2.1 节指纹时间口径）。
func canonRFC3339(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000Z")
}

// canonUUID 输出小写标准形式；nil 输出 JSON null。
func canonUUID(u *uuid.UUID) any {
	if u == nil {
		return nil
	}
	return u.String()
}

// ---------- 指纹构造（5.2.1 节四个标识） ----------

// skillContentHash：content_hash = "sk1:" + H(DefinitionFields)。
// 字段为 name/summary/triggers/instructions、三个规范化数组、两开关、status；
// 不含 ID、归属、revision、来源或时间。
func skillContentHash(f SkillFields) string {
	h, err := canonHash(skillDefinitionCanon(f))
	if err != nil {
		return ""
	}
	return "sk1:" + h
}

func skillDefinitionCanon(f SkillFields) map[string]any {
	return map[string]any{
		"name":            f.Name,
		"summary":         f.Summary,
		"triggers":        f.Triggers,
		"instructions":    f.Instructions,
		"platforms":       f.Platforms,
		"content_formats": f.ContentFormats,
		"task_types":      f.TaskTypes,
		"task_enabled":    f.TaskEnabled,
		"agent_enabled":   f.AgentEnabled,
		"status":          f.Status,
	}
}

type skillBindingFinger struct {
	BindingID uuid.UUID
	SkillID   uuid.UUID // 内置解析成确定性 UUID
	Priority  int
	CreatedAt time.Time
}

// skillPartitionFingerprint：分区 base_revision = "sb1:" + H({account_id,audience_user_id,bindings})。
// bindings 按 skill UUID 升序；不含定义正文 / 修订，不含另一分区。
func skillPartitionFingerprint(accountID uuid.UUID, audience *uuid.UUID, items []skillBindingFinger) (string, error) {
	sorted := make([]skillBindingFinger, len(items))
	copy(sorted, items)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].SkillID.String() < sorted[j].SkillID.String() })
	bindings := make([]any, 0, len(sorted))
	for _, it := range sorted {
		bindings = append(bindings, map[string]any{
			"binding_id": it.BindingID.String(),
			"skill_id":   it.SkillID.String(),
			"priority":   it.Priority,
			"created_at": canonRFC3339(it.CreatedAt),
		})
	}
	h, err := canonHash(map[string]any{
		"account_id":      accountID.String(),
		"audience_user_id": canonUUID(audience),
		"bindings":        bindings,
	})
	if err != nil {
		return "", err
	}
	return "sb1:" + h, nil
}

type skillImpactBinding struct {
	BindingID   uuid.UUID
	AccountID   uuid.UUID
	AudienceUID *uuid.UUID
	Priority    int
	CreatedAt   time.Time
}

// skillImpactToken："si1:" + H({skill_id,revision,action,bindings})。
// bindings 按 account_id、binding_id 升序；action 仅 update / delete。
func skillImpactToken(skillID uuid.UUID, revision int64, action string, items []skillImpactBinding) (string, error) {
	sorted := make([]skillImpactBinding, len(items))
	copy(sorted, items)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].AccountID != sorted[j].AccountID {
			return sorted[i].AccountID.String() < sorted[j].AccountID.String()
		}
		return sorted[i].BindingID.String() < sorted[j].BindingID.String()
	})
	bindings := make([]any, 0, len(sorted))
	for _, it := range sorted {
		bindings = append(bindings, map[string]any{
			"binding_id":      it.BindingID.String(),
			"account_id":      it.AccountID.String(),
			"audience_user_id": canonUUID(it.AudienceUID),
			"priority":        it.Priority,
			"created_at":      canonRFC3339(it.CreatedAt),
		})
	}
	h, err := canonHash(map[string]any{
		"skill_id":  skillID.String(),
		"revision":  revision,
		"action":    action,
		"bindings":  bindings,
	})
	if err != nil {
		return "", err
	}
	return "si1:" + h, nil
}

// skillPublishDigest：公开确认摘要 "sp1:" + H({operation,skill_id,scope,account_id,fields})。
// 创建 skill_id=null；非账号层 account_id=null；fields 为最终 DefinitionFields。
func skillPublishDigest(operation string, skillID *uuid.UUID, scope string, accountID *uuid.UUID, f SkillFields) (string, error) {
	h, err := canonHash(map[string]any{
		"operation": operation,
		"skill_id":  canonUUID(skillID),
		"scope":     scope,
		"account_id": canonUUID(accountID),
		"fields":    skillDefinitionCanon(f),
	})
	if err != nil {
		return "", err
	}
	return "sp1:" + h, nil
}
