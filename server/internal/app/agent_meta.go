package app

import (
	"context"
	"encoding/json"
	"errors"

	"ops/internal/ai"
)

// errAgentUnknownTool 是本地元工具无法识别时的兜底错误。
var errAgentUnknownTool = errors.New("未知元工具")

// 本地元工具（16 文档第 3.3 节第 3 项）。Path 为空的条目在运行循环里本地执行，
// 不经分发器发 HTTP 请求，也不计入读取上限。

// agentMetaTool 在本地处理一个元工具调用。
func (s *Server) agentMetaTool(ctx context.Context, st *agentRunState, t *AgentTool, call ai.ToolCall,
	args map[string]any, send func(string, any)) error {
	var payload []byte
	var err error
	var summary string
	switch t.Name {
	case "get_context":
		var block string
		if block, err = s.agentEnvBlock(ctx, st); err == nil {
			payload, err = json.Marshal(map[string]any{"ok": true, "env": block})
			summary = "环境块"
		}
	case "load_tool_domain":
		payload, summary, err = s.agentMetaLoadDomain(ctx, st, args)
	case "make_link":
		payload, summary, err = s.agentMetaMakeLink(args)
	default:
		err = errAgentUnknownTool
	}
	if err != nil {
		var ae *APIError
		if errors.As(err, &ae) {
			return s.agentToolError(ctx, st, call, ae.Code, ae.Message, send)
		}
		return s.agentToolError(ctx, st, call, "internal", truncate(err.Error(), 200), send)
	}
	return s.agentToolOutcome(ctx, st, call, agentToolRecord{Model: payload, Raw: payload, Summary: summary}, true, send)
}

// agentMetaLoadDomain 加载一个领域（第 3.3 节第 2 项）：已满 3 个时移除最早加载的一个。
func (s *Server) agentMetaLoadDomain(ctx context.Context, st *agentRunState, args map[string]any) ([]byte, string, error) {
	name, _ := args["domain"].(string)
	desc := ""
	known := false
	for _, d := range agentDomains {
		if d.Name == name {
			known, desc = true, d.Desc
		}
	}
	if !known {
		return nil, "", apiErr(422, "invalid_arguments", "未知领域："+name)
	}
	loaded := false
	for _, d := range st.Domains {
		if d == name {
			loaded = true
		}
	}
	if !loaded {
		if len(st.Domains) >= agentMaxDomains {
			// 移除最早加载的一个，保持最多 3 个。
			st.Domains = append(st.Domains[len(st.Domains)-agentMaxDomains+1:], name)
		} else {
			st.Domains = append(st.Domains, name)
		}
	}
	id := ident(ctx)
	catalog := agentCatalog()
	tools := []map[string]string{}
	for i := range catalog {
		e := &catalog[i]
		if e.Domain != name || !agentToolVisible(e, id) {
			continue
		}
		tools = append(tools, map[string]string{"name": e.Name, "description": e.Description})
	}
	out := map[string]any{
		"ok": true, "domain": name, "desc": desc, "tools": tools, "loaded_domains": st.Domains,
	}
	payload, err := json.Marshal(out)
	return payload, "已加载领域 " + name, err
}

// agentMetaMakeLink 按附录 B.3 的页面表生成站内链接。
func (s *Server) agentMetaMakeLink(args map[string]any) ([]byte, string, error) {
	link, err := agentBuildLink(
		agentArgStr(args, "page"),
		agentArgStr(args, "account_id"),
		agentArgStr(args, "work_id"),
		agentArgStr(args, "conversation_id"),
		agentArgStr(args, "q"),
		agentArgStr(args, "id"),
	)
	if err != nil {
		return nil, "", apiErr(422, "invalid_arguments", "该页面不在页面表中，或缺少必要参数")
	}
	payload, err := json.Marshal(map[string]any{"ok": true, "link": link})
	return payload, link, err
}

// agentArgStr 读取一个字符串参数，非字符串或空值返回空串。
func agentArgStr(args map[string]any, name string) string {
	v, _ := args[name].(string)
	return v
}
