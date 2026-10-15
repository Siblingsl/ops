package app

import (
	"encoding/json"
	"strings"
)

// 16 文档第 3.6 节：结果投影。
const (
	// agentProjectionChars 是交给模型的投影结果上限（按 Unicode 字符计）。
	agentProjectionChars = 6000
	// agentToolResultBytes 是完整脱敏原始结果在 agent_message.content 中的上限。
	agentToolResultBytes = 64 * 1024
	agentTruncateHint    = "结果已截断，可用分页或更具体的读取工具获取更多"
)

// agentDefaultProject 是不做字段裁剪的默认投影。
func agentDefaultProject(_ int, body []byte) any {
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return string(body)
	}
	return v
}

// agentProjectForModel 依次执行投影 → 脱敏 → 截断，得到交给模型的 JSON 文本。
func agentProjectForModel(t *AgentTool, args map[string]any, status int, body []byte, secrets []string) []byte {
	var projected any
	switch {
	case t != nil && t.ProjectArgs != nil:
		projected = t.ProjectArgs(args, status, body)
	case t != nil && t.Project != nil:
		projected = t.Project(status, body)
	default:
		projected = agentDefaultProject(status, body)
	}
	projected = agentRedactValue(projected, secrets)
	b, err := json.Marshal(agentTruncateProjection(projected))
	if err != nil {
		return []byte(`{"truncated":true,"hint":"` + agentTruncateHint + `","data":""}`)
	}
	return b
}

// agentTruncateProjection 把超过上限的投影结果截断，并附上截断标记与提示。
func agentTruncateProjection(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		return v
	}
	s := string(b)
	if runeLen(s) <= agentProjectionChars {
		return v
	}
	cut := string([]rune(s)[:agentProjectionChars])
	return map[string]any{"truncated": true, "hint": agentTruncateHint, "data": cut}
}

// agentRawResultForStorage 返回用于落库的脱敏原始结果（上限 64 KB）。
func agentRawResultForStorage(status int, body []byte, secrets []string) []byte {
	out := agentRedactJSONBytes(body, secrets)
	if len(out) > agentToolResultBytes {
		out = out[:agentToolResultBytes]
	}
	return out
}

// agentErrorEnvelope 把接口的错误响应包装成统一的工具错误结果（第 3.6 节第 4 项）。
// 接口的 message 原样保留，便于模型向用户解释。
func agentErrorEnvelope(status int, body []byte) []byte {
	var raw struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Detail  any    `json:"detail"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &raw); err != nil || raw.Error.Code == "" {
		out, _ := json.Marshal(map[string]any{
			"ok": false, "status": status,
			"error": map[string]any{"code": "internal", "message": strings.TrimSpace(string(body))},
		})
		return out
	}
	out, _ := json.Marshal(map[string]any{
		"ok": false, "status": status,
		"error": map[string]any{"code": raw.Error.Code, "message": raw.Error.Message, "detail": raw.Error.Detail},
	})
	return out
}

// ---- 作品类投影（第 3.6 节第 1 项） ----

// agentProjectWork 只给出作品的属性与段落的概要，不含完整正文。
func agentProjectWork(status int, body []byte) any {
	w := agentDecodeObject(body)
	if w == nil {
		return agentDefaultProject(status, body)
	}
	out := map[string]any{
		"id":                w["id"],
		"account_id":        w["account_id"],
		"platform":          w["platform"],
		"content_format":    w["content_format"],
		"status":            w["status"],
		"title":             w["title"],
		"summary":           w["summary"],
		"revision":          w["revision"],
		"locked":            w["locked"],
		"viewpoint_empty":   agentStrBlank(w["viewpoint"]),
		"outline_confirmed": w["outline_confirmed_at"] != nil,
		"tags":              w["tags"],
		"topics":            w["topics"],
		"planned_date":      w["planned_date"],
		"target_chars":      w["target_chars"],
		"published_url":     w["published_url"],
		"published_at":      w["published_at"],
		"asset_count":       agentLenOf(w["assets"]),
		"material_ids":      w["material_ids"],
	}
	out["sections"] = agentSectionDigests(w["sections"])
	out["panels"] = agentPanelDigests(w["panels"])
	return out
}

// agentProjectWorkSections 按 section_ids 给出指定段落的完整正文。
// 未提供 section_ids 时退回概要投影。
func agentProjectWorkSections(args map[string]any, status int, body []byte) any {
	w := agentDecodeObject(body)
	if w == nil {
		return agentDefaultProject(status, body)
	}
	want := map[string]bool{}
	if list, ok := args["section_ids"].([]any); ok {
		for _, x := range list {
			if s, ok := x.(string); ok {
				want[s] = true
			}
		}
	}
	if len(want) == 0 {
		return agentProjectWork(status, body)
	}
	secs, _ := w["sections"].([]any)
	out := make([]any, 0, len(want))
	for _, s := range secs {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		id, _ := m["id"].(string)
		if !want[id] {
			continue
		}
		out = append(out, map[string]any{
			"id":         m["id"],
			"heading":    m["heading"],
			"content_md": m["content_md"],
		})
	}
	return map[string]any{
		"work_id":  w["id"],
		"title":    w["title"],
		"revision": w["revision"],
		"sections": out,
	}
}

func agentSectionDigests(v any) []any {
	secs, _ := v.([]any)
	out := make([]any, 0, len(secs))
	for _, s := range secs {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		content, _ := m["content_md"].(string)
		out = append(out, map[string]any{
			"id":      m["id"],
			"heading": m["heading"],
			"chars":   runeLen(content),
			"excerpt": truncateRunes(content, 200),
		})
	}
	return out
}

func agentPanelDigests(v any) []any {
	panels, _ := v.([]any)
	out := make([]any, 0, len(panels))
	for _, p := range panels {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, map[string]any{
			"id":      m["id"],
			"index":   m["index"],
			"text":    truncateRunes(agentStr(m["text"]), 200),
			"asset":   m["asset_id"],
			"caption": truncateRunes(agentStr(m["caption"]), 200),
		})
	}
	return out
}

func agentDecodeObject(body []byte) map[string]any {
	var w map[string]any
	if err := json.Unmarshal(body, &w); err != nil {
		return nil
	}
	return w
}

func agentStr(v any) string {
	s, _ := v.(string)
	return s
}

func agentStrBlank(v any) bool { return strings.TrimSpace(agentStr(v)) == "" }

func agentLenOf(v any) int {
	list, _ := v.([]any)
	return len(list)
}
