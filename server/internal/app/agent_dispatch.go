package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	neturl "net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 16 文档第 2.3 节：进程内分发器。
// 分发器把一个工具调用变成一个进程内 HTTP 请求，交给与真实请求相同的根路由处理，
// 既有的会话、工作区隔离、角色、观察者拦截、维护模式、门槛、修订号、审计全部原样生效。

// agentPrincipalKey 是未导出的上下文键；HTTP 请求无法伪造这个键。
type agentPrincipalKey struct{}

// agentPrincipal 标识一次工具调用来自哪条会话、哪个工作区、哪次运行、哪张卡片。
type agentPrincipal struct {
	SessionID      uuid.UUID
	WorkspaceID    uuid.UUID
	ConversationID uuid.UUID
	RunID          uuid.UUID
	ActionID       uuid.UUID
}

func withAgentPrincipal(ctx context.Context, p agentPrincipal) context.Context {
	return context.WithValue(ctx, agentPrincipalKey{}, &p)
}

func agentPrincipalOf(ctx context.Context) *agentPrincipal {
	p, _ := ctx.Value(agentPrincipalKey{}).(*agentPrincipal)
	return p
}

// agentUploadFile 是 multipart 分发的文件来源（第 8.4 节，由 DEV-AG07 提供）。
type agentUploadFile struct {
	Field    string
	Filename string
	Content  []byte
}

// agentDispatchRequest 是一次工具调用的输入。
type agentDispatchRequest struct {
	Principal     agentPrincipal
	Tool          *AgentTool
	Args          map[string]any // 模型提供的参数
	Human         map[string]any // 执行请求填入的人工字段（第 3.5 节）
	ClientPayload map[string]any // 前端载荷（第 5.4 节）
	Files         []agentUploadFile
	Timeout       time.Duration
	// OnEvent 在执行卡片时把 step、delta 事件实时转发到外层执行 SSE。
	OnEvent func(event string, data []byte) error
}

type agentSSEEvent struct {
	Event string
	Data  []byte
}

// agentDispatchResult 是一次工具调用的结果。
type agentDispatchResult struct {
	Status  int
	Raw     []byte // 脱敏后的完整响应体（落库用，第 3.6 节第 3 项）
	Model   []byte // 交给模型的投影结果（第 3.6 节第 1、2 项）
	Events  []agentSSEEvent
	Done    json.RawMessage
	Secrets map[string]string // 只给用户看一次的值（第 9.5 节第 4 项），不落库、不进模型
}

var errAgentToolLocal = errors.New("本地元工具不经过分发器")

// dispatchAgentTool 执行一次工具调用。
func (s *Server) dispatchAgentTool(ctx context.Context, req agentDispatchRequest) (*agentDispatchResult, error) {
	t := req.Tool
	if t == nil {
		return nil, errors.New("未知工具")
	}
	if t.Path == "" {
		return nil, errAgentToolLocal
	}
	if req.Timeout <= 0 {
		req.Timeout = t.ExecTimeout
	}
	if req.Timeout <= 0 {
		req.Timeout = agentExecTimeout
	}

	httpReq, err := s.buildAgentRequest(t, req)
	if err != nil {
		return nil, err
	}

	// 内层请求必须使用“干净”的上下文：只带上内层中间件需要的值（智能体身份、
	// 备用模型偏好）。外层上下文里的 chi 路由上下文等值不能带进去，否则内层路由
	// 会沿用它，把请求路由到外层的路径上（第 2.3 节「请求构造」）。
	// 外层请求断开不取消已开始的分发（第 2.3 节「响应处理」第 4 项）：取消只来自
	// 调用方 ctx（运行取消）或本次调用的超时。
	base, baseCancel := context.WithCancel(context.Background())
	defer baseCancel()
	inner := withAgentPrincipal(base, req.Principal)
	if desktopRequest, ok := desktopRequestOf(ctx); ok {
		inner = withDesktopRequest(inner, desktopRequest)
	}
	if v, ok := ctx.Value(ctxPreferFallback).(bool); ok {
		inner = context.WithValue(inner, ctxPreferFallback, v)
	}
	stop := context.AfterFunc(ctx, baseCancel)
	defer stop()
	dctx, cancel := context.WithTimeout(inner, req.Timeout)
	defer cancel()
	httpReq = httpReq.WithContext(dctx)

	var rec agentRecorder
	if t.SSE {
		rec = newAgentSSERecorder(req.OnEvent)
	} else {
		rec = newAgentJSONRecorder()
	}

	s.handler.ServeHTTP(rec, httpReq)

	res := &agentDispatchResult{Status: rec.Status(), Events: rec.Events()}
	secrets := s.agentSecretValues(dctx, req.Principal.WorkspaceID)

	// SSE 的失败以 error 事件表达；普通接口以状态码表达。
	if errEvent := agentSSEError(rec.Events()); errEvent != nil {
		res.Raw = agentErrorEnvelope(http.StatusBadGateway, errEvent)
		res.Model = res.Raw
		return res, nil
	}
	body := rec.Body()
	if res.Status >= 400 {
		res.Raw = agentErrorEnvelope(res.Status, body)
		res.Model = res.Raw
		return res, nil
	}
	res.Done = agentSSEDone(rec.Events())
	if t.SSE && res.Done != nil {
		body = res.Done
	}
	body, once := agentExtractSecrets(t, body)
	res.Secrets = once
	res.Raw = agentRawResultForStorage(res.Status, body, secrets)
	res.Model = agentProjectForModel(t, req.Args, res.Status, body, secrets)
	return res, nil
}

// buildAgentRequest 按条目的参数声明拼出内部 HTTP 请求（第 2.3 节「请求构造」）。
func (s *Server) buildAgentRequest(t *AgentTool, req agentDispatchRequest) (*http.Request, error) {
	pathParams, query, body, err := agentSplitParams(t, req)
	if err != nil {
		return nil, err
	}

	// 路径：把模板中的 {name} 换成校验过的值。
	path := t.Path
	for _, name := range agentPathPlaceholders(t.Path) {
		v, ok := pathParams[name]
		if !ok {
			return nil, apiErr(422, "validation_failed", "工具参数不正确：缺少路径参数 "+name)
		}
		path = strings.ReplaceAll(path, "{"+name+"}", agentPathEscape(v))
	}
	if strings.ContainsAny(path, "{}") {
		return nil, apiErr(422, "validation_failed", "工具参数不正确：路径模板未完全替换")
	}

	u := "/api/v1" + path
	if len(query) > 0 {
		u += "?" + agentEncodeQuery(query)
	}

	var (
		payload []byte
		ctype   string
	)
	if files := agentMultipartFiles(t, req); len(files) > 0 {
		payload, ctype, err = agentBuildMultipart(body, files)
		if err != nil {
			return nil, err
		}
	} else if len(body) > 0 {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
		ctype = "application/json"
	}
	if len(payload) > 1<<20 {
		return nil, apiErr(422, "validation_failed", "工具参数不正确：请求体超过 1 MB")
	}

	var rdr io.Reader = http.NoBody
	if payload != nil {
		rdr = bytes.NewReader(payload)
	} else if t.Method != "" && t.Method != "GET" {
		// 非 GET 请求始终带 JSON 空对象：r.Body 为 nil 时 handler 解码会崩溃（曾导致 500）。
		rdr = bytes.NewReader([]byte("{}"))
		ctype = "application/json"
	}
	httpReq, err := http.NewRequest(t.Method, u, rdr)
	if err != nil {
		return nil, err
	}
	if ctype != "" {
		httpReq.Header.Set("Content-Type", ctype)
	}
	httpReq.Header.Set("X-Request-Id", uuid.NewString())
	httpReq.RemoteAddr = "agent"
	return httpReq, nil
}

// agentSplitParams 把参数按位置分成 path、query、body 三组并做 Schema 校验。
func agentSplitParams(t *AgentTool, req agentDispatchRequest) (map[string]any, map[string]any, map[string]any, error) {
	pathParams := map[string]any{}
	query := map[string]any{}
	body := map[string]any{}

	placeholders := map[string]bool{}
	for _, name := range agentPathPlaceholders(t.Path) {
		placeholders[name] = true
	}

	// 1) 模型提供的参数：必须出现在条目声明中，且位置与声明一致。
	declared := map[string]*ToolParam{}
	for i := range t.Params {
		p := &t.Params[i]
		declared[p.Name] = p
	}
	for name, raw := range req.Args {
		p, ok := declared[name]
		if !ok {
			return nil, nil, nil, apiErr(422, "validation_failed", "工具参数不正确：未声明的参数 "+name)
		}
		v, err := agentValidateParam(*p, raw)
		if err != nil {
			return nil, nil, nil, err
		}
		switch p.In {
		case "path":
			pathParams[name] = v
		case "query":
			query[name] = v
		case "body":
			body[name] = v
		case "multipart":
			// 第 8.4 节：multipart 参数的值是附件 ID，由执行层读取文件后构造请求，不进入请求体。
		}
	}
	for i := range t.Params {
		p := &t.Params[i]
		if !p.Required {
			continue
		}
		if _, ok := req.Args[p.Name]; !ok {
			return nil, nil, nil, apiErr(422, "validation_failed", "工具参数不正确：缺少必填参数 "+p.Name)
		}
	}

	// 2) 人工字段：只来自执行请求（第 3.5 节），位置由条目声明。
	for _, h := range t.Human {
		v, ok := req.Human[h.Name]
		if !ok {
			continue
		}
		checked, err := agentValidateSchema(h.Schema, v, h.Name)
		if err != nil {
			return nil, nil, nil, err
		}
		if h.In == "query" {
			query[h.Name] = checked
		} else {
			body[h.Name] = checked
		}
	}

	// 3) 固定注入：模型不可见，也不能覆盖。
	for name, v := range t.Fixed {
		pos := agentFixedPosition(t, name, placeholders)
		switch pos {
		case "path":
			pathParams[name] = v
		case "query":
			query[name] = v
		default:
			body[name] = v
		}
	}

	// 4) 前端载荷：公众号 HTML 及其字符数、字节数（第 5.4 节）。
	if t.ClientPayload != "" {
		for k, v := range req.ClientPayload {
			body[k] = v
		}
	}
	return pathParams, query, body, nil
}

// agentFixedPosition 判断固定值注入到哪个位置。
func agentFixedPosition(t *AgentTool, name string, placeholders map[string]bool) string {
	if placeholders[name] {
		return "path"
	}
	if t.Method == http.MethodGet || t.Method == http.MethodDelete {
		return "query"
	}
	for _, h := range t.Human {
		if h.Name == name {
			return h.In
		}
	}
	return "body"
}

// agentMultipartFiles 只保留条目声明过的 multipart 字段。
func agentMultipartFiles(t *AgentTool, req agentDispatchRequest) []agentUploadFile {
	allowed := map[string]bool{}
	for _, p := range t.Params {
		if p.In == "multipart" && p.Field != "" {
			allowed[p.Field] = true
		}
	}
	if len(allowed) == 0 {
		return nil
	}
	out := make([]agentUploadFile, 0, len(req.Files))
	for _, f := range req.Files {
		if allowed[f.Field] {
			out = append(out, f)
		}
	}
	return out
}

func agentBuildMultipart(body map[string]any, files []agentUploadFile) ([]byte, string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range body {
		s, ok := v.(string)
		if !ok {
			b, err := json.Marshal(v)
			if err != nil {
				return nil, "", err
			}
			s = string(b)
		}
		if err := mw.WriteField(k, s); err != nil {
			return nil, "", err
		}
	}
	for _, f := range files {
		h := make(textproto.MIMEHeader)
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, f.Field, f.Filename))
		h.Set("Content-Type", "application/octet-stream")
		part, err := mw.CreatePart(h)
		if err != nil {
			return nil, "", err
		}
		if _, err := part.Write(f.Content); err != nil {
			return nil, "", err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), mw.FormDataContentType(), nil
}

func agentPathPlaceholders(path string) []string {
	var out []string
	for i := 0; i < len(path); i++ {
		if path[i] != '{' {
			continue
		}
		j := strings.IndexByte(path[i:], '}')
		if j < 0 {
			break
		}
		out = append(out, path[i+1:i+j])
		i += j
	}
	return out
}

func agentPathEscape(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return agentItoa(int(x))
		}
		return fmt.Sprintf("%v", x)
	default:
		return fmt.Sprintf("%v", x)
	}
}

func agentEncodeQuery(q map[string]any) string {
	parts := make([]string, 0, len(q))
	for k, v := range q {
		parts = append(parts, neturl.QueryEscape(k)+"="+neturl.QueryEscape(agentPathEscape(v)))
	}
	return strings.Join(parts, "&")
}

// agentExtractSecrets 取出只给用户看一次的值，并从落库与模型可见的结果中移除（第 9.5 节第 4 项）。
func agentExtractSecrets(t *AgentTool, body []byte) ([]byte, map[string]string) {
	if len(t.Secrets) == 0 || len(body) == 0 {
		return body, nil
	}
	var obj map[string]any
	if err := json.Unmarshal(body, &obj); err != nil {
		return body, nil
	}
	out := map[string]string{}
	for _, name := range t.Secrets {
		v, ok := obj[name]
		if !ok {
			continue
		}
		if s, ok := v.(string); ok {
			out[name] = s
			delete(obj, name)
		}
	}
	if len(out) == 0 {
		return body, nil
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return body, out
	}
	return b, out
}

func agentSSEError(events []agentSSEEvent) []byte {
	for _, e := range events {
		if e.Event == "error" {
			return e.Data
		}
	}
	return nil
}

func agentSSEDone(events []agentSSEEvent) json.RawMessage {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Event == "done" {
			return events[i].Data
		}
	}
	return nil
}
