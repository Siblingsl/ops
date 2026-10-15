package app

// 卡片预览、指纹与整体替换合并（16 文档第 3.4 节第 6 条、第 5.2 节第 5 项、第 5.3 节第 6 项）。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

// agentPreviewTool 由写入条目派生出一个只读条目，用于按同路径 GET 读取“修改前”的值。
// 只保留路径参数：其余参数在 GET 上会被拼进查询串，预览读取不应带上它们。
func agentPreviewTool(t *AgentTool) AgentTool {
	out := *t
	out.Method = http.MethodGet
	out.Params = nil
	out.Fixed = nil
	out.Human = nil
	out.ClientPayload = ""
	out.SSE = false
	out.Fingerprint = false
	out.Preview = PreviewRule{}
	out.Secrets = nil
	out.Notes = ""
	for _, p := range t.Params {
		if p.In == "path" {
			out.Params = append(out.Params, p)
		}
	}
	return out
}

// agentPreviewRead 按第 5.2 节第 5 项读取目标当前值。
// 用户裁决口径：同一路径改用 GET 再分发一次。同一路径没有注册 GET 时（已核对
// `PUT /admin/crawl/sources/{key}` 与 `PUT /admin/crawl/platforms/{platform}` 两条），
// 逐级回退到父路径，再用最后一段路径参数在数组 / 映射中定位子对象——父接口
// `GET /admin/crawl` 返回的 sources / platforms 元素都带有与路径参数同名的 key 字段。
func (s *Server) agentPreviewRead(ctx context.Context, st *agentRunState, t *AgentTool,
	args map[string]any) map[string]any {
	before, ok := s.agentPreviewAt(ctx, st, t, args, t.Path)
	if ok {
		return before
	}
	segments := strings.Split(strings.Trim(t.Path, "/"), "/")
	for i := len(segments) - 1; i >= 1; i-- {
		last := segments[i]
		if !strings.HasPrefix(last, "{") || !strings.HasSuffix(last, "}") {
			continue
		}
		param := strings.TrimSuffix(strings.TrimPrefix(last, "{"), "}")
		key, _ := args[param].(string)
		if key == "" {
			continue
		}
		parent := strings.Join(segments[:i], "/")
		body, ok := s.agentPreviewAt(ctx, st, t, args, "/"+parent)
		if !ok {
			continue
		}
		if found := agentLocateChild(body, param, key); found != nil {
			return found
		}
	}
	return nil
}

// agentPreviewAt 分发一次 GET 并解出对象体；路由不存在或响应非对象时返回 false。
func (s *Server) agentPreviewAt(ctx context.Context, st *agentRunState, t *AgentTool,
	args map[string]any, path string) (map[string]any, bool) {
	gt := agentPreviewTool(t)
	gt.Path = path
	// 只带路径参数：预览读取是只读 GET，其余参数会被当作未声明参数拒绝。
	pathArgs := map[string]any{}
	for _, p := range gt.Params {
		if v, ok := args[p.Name]; ok {
			pathArgs[p.Name] = v
		}
	}
	res, err := s.dispatchAgentTool(ctx, agentDispatchRequest{
		Principal: agentPrincipal{SessionID: st.SessionID, WorkspaceID: st.WorkspaceID,
			ConversationID: st.ConversationID, RunID: st.RunID},
		Tool:    &gt,
		Args:    pathArgs,
		Timeout: agentReadTimeout,
	})
	if err != nil || res == nil || res.Status >= 400 {
		return nil, false
	}
	var v any
	if err := json.Unmarshal(res.Raw, &v); err != nil {
		return nil, false
	}
	switch t := v.(type) {
	case map[string]any:
		return t, true
	case []any:
		// 顶层数组（如 `GET /outline-templates`）统一包成 {items:[…]}，
		// 与整体替换条目的请求体字段名对齐。
		return map[string]any{"items": t}, true
	}
	return nil, false
}

// agentLocateChild 在父级响应里按路径参数名定位子对象：数组元素带同名字段，
// 或映射以该值为键（`/prompt-templates/{taskType}` 一类路径同样适用）。
func agentLocateChild(body map[string]any, param, key string) map[string]any {
	if v, ok := body[param]; ok {
		if obj, isObj := v.(map[string]any); isObj {
			return obj
		}
		if s, isStr := v.(string); isStr && s == key {
			return body
		}
	}
	for _, v := range body {
		switch t := v.(type) {
		case []any:
			for _, e := range t {
				obj, ok := e.(map[string]any)
				if !ok {
					continue
				}
				if got, _ := obj[param].(string); got == key {
					return obj
				}
			}
		case map[string]any:
			if obj, ok := t[key].(map[string]any); ok {
				return obj
			}
			for _, e := range t {
				if arr, ok := e.([]any); ok {
					if found := agentLocateChild(map[string]any{"": arr}, param, key); found != nil {
						return found
					}
				}
			}
		}
	}
	return nil
}

// agentCardChanges 生成逐字段差异（第 3.4 节第 6 条、第 5.2 节第 5 项）。
func agentCardChanges(t *AgentTool, args, before map[string]any, blanked []string) []agentChange {
	blank := map[string]bool{}
	for _, f := range blanked {
		blank[f] = true
	}
	out := []agentChange{}
	for _, p := range t.Params {
		if p.In == "path" || !editableFor(p.Source) {
			continue
		}
		after, _ := args[p.Name]
		ch := agentChange{
			Field:    p.Name,
			Label:    agentFieldLabel(p.Name),
			After:    agentChangeText(after),
			Editable: p.Editable,
			Blank:    blank[p.Name],
		}
		if before != nil {
			ch.Before = agentChangeText(before[p.Name])
		}
		if ch.Before == ch.After && !ch.Blank {
			continue
		}
		out = append(out, ch)
	}
	return out
}

// agentChangeText 把一个字段值渲染成卡片上的短文本。
func agentChangeText(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "开启"
		}
		return "关闭"
	case float64:
		return agentNumberValueText(t)
	case []any, map[string]any:
		b, err := json.Marshal(t)
		if err != nil {
			return ""
		}
		return string(b)
	}
	return ""
}

// agentFieldLabel 是卡片差异的中文字段名。附录 A 没有提供标签表，这里集中登记；
// 未登记的字段回退为字段名。
var agentFieldLabels = map[string]string{
	"level": "采集强度", "limits": "限额", "retention_days": "原文保留天数",
	"summary_fetch": "抓取原文摘要", "enabled": "启用", "interval_min": "采集间隔（分钟）",
	"max_items": "每次条数", "daily_max": "每日上限", "repeat_hours": "重复间隔（小时）",
	"jitter_min": "随机抖动（分钟）", "generate": "自动生成", "hour": "生成时间",
	"primary_count": "主选条数", "alternate_count": "备选条数",
	"sources": "来源", "rss": "RSS 源",
	"positioning_tags": "定位标签", "target_audience": "目标读者", "persona_tone": "人设语气",
	"banned_words": "禁用词", "style_summary": "风格摘要", "default_theme": "默认主题",
	"base": "基准主题", "primary_color": "主色", "font_size": "字号", "line_height": "行距",
	"paragraph_gap": "段距", "heading_style": "标题样式", "quote_style": "引用样式",
	"items": "模板", "registration_open": "开放注册", "maintenance_mode": "维护模式",
	"viewpoint": "核心观点", "content": "内容", "content_md": "正文", "heading": "小标题",
	"title": "标题", "summary": "摘要", "angle": "切入点", "items_outline": "大纲条目",
	"text": "文字", "alt_text": "替代文字", "email": "邮箱",
}

// agentFieldLabel 取字段的中文标签。
func agentFieldLabel(name string) string {
	if v, ok := agentFieldLabels[name]; ok {
		return v
	}
	return name
}

// agentFingerprint 对预览涉及的字段计算 SHA-256（第 5.3 节第 6 项）。
// 键排序后序列化，保证同一份值得到同一个指纹。
func agentFingerprint(fields []string, obj map[string]any) string {
	if len(fields) == 0 || obj == nil {
		return ""
	}
	picked := map[string]any{}
	for _, f := range fields {
		if v, ok := obj[f]; ok {
			picked[f] = v
		}
	}
	keys := make([]string, 0, len(picked))
	for k := range picked {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, k := range keys {
		b, err := json.Marshal(picked[k])
		if err != nil {
			continue
		}
		h.Write([]byte(k))
		h.Write([]byte("="))
		h.Write(b)
		h.Write([]byte("\n"))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// agentFingerprintFields 返回用于指纹计算的字段（第 5.3 节第 6 项整体替换类必须开启）。
func agentFingerprintFields(t *AgentTool) []string {
	if len(t.Preview.Fields) > 0 {
		return t.Preview.Fields
	}
	out := []string{}
	for _, p := range t.Params {
		if p.In != "path" {
			out = append(out, p.Name)
		}
	}
	return out
}

// ---------- 整体替换合并（第 3.4 节第 6 条） ----------

// agentIsWholeReplace 判断条目是否为整体替换类。
// 已核对（第 3.4 节第 6 条）：`PUT /accounts/{id}/profile`、`PUT /accounts/{id}/custom-theme`、
// `PUT /outline-templates`；它们只接受“要修改的字段 / 要保留的模板”，
// 提出卡片时必须读取当前完整值作为底稿合并后再冻结。
func agentIsWholeReplace(t *AgentTool) bool {
	switch t.Name {
	case "profile__update", "custom_theme__update", "outline__templates_update":
		return true
	}
	return false
}

// agentMergeWholeReplace 把模型提交的部分字段合并到当前完整值上，得到完整请求体。
// 数组（`items`）按 id 覆盖：同 id 的模板替换，未提及的保留（避免误删未提及的内容）。
func agentMergeWholeReplace(args, before map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range before {
		out[k] = v
	}
	for k, v := range args {
		if arr, ok := v.([]any); ok {
			cur, _ := out[k].([]any)
			out[k] = agentMergeIDList(cur, arr)
			continue
		}
		out[k] = v
	}
	return out
}

// agentWholeReplaceMerge 按条目类型做整体替换合并。
// `outline__templates_update` 的读接口同时返回内置模板，而内置模板在保存时会被重新分配 id
// （`putOutlineTemplates`），必须从底稿里剔除，否则每次保存都会把内置模板复制成自定义模板。
func agentWholeReplaceMerge(t *AgentTool, args, before map[string]any) map[string]any {
	out := agentMergeWholeReplace(args, before)
	if t.Name == "outline__templates_update" {
		out["items"] = agentCustomTemplates(out["items"])
	}
	return out
}

// agentCustomTemplates 过滤内置模板，只保留自定义模板。
func agentCustomTemplates(v any) []any {
	arr, _ := v.([]any)
	out := []any{}
	for _, e := range arr {
		obj, ok := e.(map[string]any)
		if !ok {
			continue
		}
		if id, _ := obj["id"].(string); strings.HasPrefix(id, "builtin") {
			continue
		}
		out = append(out, obj)
	}
	return out
}

// agentMergeIDList 按 id 合并两个数组：新元素覆盖同 id 的旧元素，其余旧元素保留。
func agentMergeIDList(cur, next []any) []any {
	byID := map[string]map[string]any{}
	order := []string{}
	for _, e := range cur {
		obj, ok := e.(map[string]any)
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		if id == "" {
			continue
		}
		byID[id] = obj
		order = append(order, id)
	}
	for _, e := range next {
		obj, ok := e.(map[string]any)
		if !ok {
			continue
		}
		id, _ := obj["id"].(string)
		if id == "" {
			// 没有 id 的新元素直接追加（保存时由接口分配 id）。
			order = append(order, "")
			byID[""] = obj
			continue
		}
		if _, exists := byID[id]; !exists {
			order = append(order, id)
		}
		byID[id] = obj
	}
	out := []any{}
	for _, id := range order {
		if id == "" {
			out = append(out, byID[""])
			byID[""] = nil
			continue
		}
		out = append(out, byID[id])
	}
	return out
}
