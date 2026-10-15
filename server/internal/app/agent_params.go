package app

import (
	"encoding/json"
	"strings"

	"github.com/google/uuid"
)

// 16 文档第 2.3 节「允许的请求」：路径参数必须匹配条目的 JSON Schema（UUID、整数、枚举），
// 不接受模型提供的任意路径或查询串。

type agentParamSchema struct {
	Type      string          `json:"type"`
	Format    string          `json:"format"`
	Enum      []string        `json:"enum"`
	Minimum   *float64        `json:"minimum"`
	Maximum   *float64        `json:"maximum"`
	MinLength *int            `json:"minLength"`
	MaxLength *int            `json:"maxLength"`
	MinItems  *int            `json:"minItems"`
	MaxItems  *int            `json:"maxItems"`
	Items     json.RawMessage `json:"items"`
}

func agentBadParam(name, why string) *APIError {
	return apiErr(422, "validation_failed", "工具参数不正确："+name+why)
}

// agentValidateParam 按条目声明的 Schema 校验模型提供的参数。
func agentValidateParam(p ToolParam, raw any) (any, error) {
	v, err := agentValidateSchema(p.Schema, raw, p.Name)
	if err != nil {
		return nil, err
	}
	if p.In == "path" {
		// 路径参数只允许 UUID、整数与枚举；额外拒绝任何路径分隔与相对跳转。
		if s, ok := v.(string); ok && (strings.ContainsAny(s, "/\\") || strings.Contains(s, "..")) {
			return nil, agentBadParam(p.Name, "含有非法字符")
		}
	}
	return v, nil
}

// agentValidateSchema 按一段 JSON Schema 校验一个值，返回规范化后的值。
func agentValidateSchema(schema json.RawMessage, raw any, name string) (any, error) {
	var s agentParamSchema
	if len(schema) == 0 || json.Unmarshal(schema, &s) != nil {
		return raw, nil
	}
	if len(s.Enum) > 0 {
		sv, ok := raw.(string)
		if !ok {
			return nil, agentBadParam(name, "取值不正确")
		}
		for _, e := range s.Enum {
			if e == sv {
				return sv, nil
			}
		}
		return nil, agentBadParam(name, "取值不在允许范围内")
	}
	switch s.Type {
	case "string":
		sv, ok := raw.(string)
		if !ok {
			return nil, agentBadParam(name, "必须是文字")
		}
		if s.Format == "uuid" {
			if _, err := uuid.Parse(sv); err != nil {
				return nil, agentBadParam(name, "必须是有效的 ID")
			}
		}
		n := runeLen(sv)
		if s.MinLength != nil && n < *s.MinLength {
			return nil, agentBadParam(name, "长度不足")
		}
		if s.MaxLength != nil && n > *s.MaxLength {
			return nil, agentBadParam(name, "长度超出上限")
		}
		return sv, nil
	case "integer":
		f, ok := agentNumber(raw)
		if !ok || f != float64(int64(f)) {
			return nil, agentBadParam(name, "必须是整数")
		}
		if s.Minimum != nil && f < *s.Minimum {
			return nil, agentBadParam(name, "小于允许的最小值")
		}
		if s.Maximum != nil && f > *s.Maximum {
			return nil, agentBadParam(name, "大于允许的最大值")
		}
		return int64(f), nil
	case "number":
		f, ok := agentNumber(raw)
		if !ok {
			return nil, agentBadParam(name, "必须是数字")
		}
		if s.Minimum != nil && f < *s.Minimum {
			return nil, agentBadParam(name, "小于允许的最小值")
		}
		if s.Maximum != nil && f > *s.Maximum {
			return nil, agentBadParam(name, "大于允许的最大值")
		}
		return f, nil
	case "boolean":
		b, ok := raw.(bool)
		if !ok {
			return nil, agentBadParam(name, "必须是开关值")
		}
		return b, nil
	case "array":
		list, ok := raw.([]any)
		if !ok {
			return nil, agentBadParam(name, "必须是数组")
		}
		if s.MinItems != nil && len(list) < *s.MinItems {
			return nil, agentBadParam(name, "数量不足")
		}
		if s.MaxItems != nil && len(list) > *s.MaxItems {
			return nil, agentBadParam(name, "数量超出上限")
		}
		if len(s.Items) > 0 {
			out := make([]any, 0, len(list))
			for _, item := range list {
				v, err := agentValidateSchema(s.Items, item, name)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			return out, nil
		}
		return list, nil
	case "object":
		obj, ok := raw.(map[string]any)
		if !ok {
			return nil, agentBadParam(name, "必须是对象")
		}
		return obj, nil
	default:
		return raw, nil
	}
}

func agentNumber(raw any) (float64, bool) {
	switch x := raw.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}
